
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined,
  max: 3
});

// PAPER TRADING ONLY — OKX public market data
const BASE_URL = "https://www.okx.com";
const EXCHANGE_NAME = "OKX USDT Perpetual Swaps";

const INITIAL_BALANCE = 1000;
const RISK = 0.01;
const FEE_RATE = 0.0005;

const MAX_OPEN_TRADES = 5;
const MAX_POSITION_PERCENT = 0.18;
const STOP_PERCENT = 0.05;
const TARGET_MULTIPLIER = 2;

const BATCH_SIZE = 8;
const MIN_BALANCE = 1;
const INTERVAL = "15m";

async function marketData(path) {
  const response = await fetch(BASE_URL + path, {
    signal: AbortSignal.timeout(12000),
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("OKX HTTP " + response.status);
  }

  const body = await response.json();

  if (body.code !== "0") {
    throw new Error(
      "OKX API " + body.code + ": " + (body.msg || "Unknown error")
    );
  }

  return body.data;
}

function toSymbol(instId) {
  return String(instId)
    .replaceAll("-", "")
    .replace(/SWAP$/, "");
}

function toInstId(symbol) {
  const value = String(symbol).toUpperCase();

  if (value.endsWith("-USDT-SWAP")) {
    return value;
  }

  if (!value.endsWith("USDT")) {
    throw new Error("Unsupported symbol: " + value);
  }

  return value.slice(0, -4) + "-USDT-SWAP";
}

async function setup() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS radar_account (
      id INTEGER PRIMARY KEY,
      balance DOUBLE PRECISION NOT NULL DEFAULT 1000,
      last_candle BIGINT DEFAULT 0,
      scan_cursor INTEGER NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    ALTER TABLE radar_account
    ADD COLUMN IF NOT EXISTS scan_cursor INTEGER NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE radar_account
    ADD COLUMN IF NOT EXISTS diagnostics JSONB
    NOT NULL DEFAULT '{}'::jsonb
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS radar_trades (
      id BIGSERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      side TEXT NOT NULL,
      entry DOUBLE PRECISION NOT NULL,
      quantity DOUBLE PRECISION NOT NULL,
      stop_loss DOUBLE PRECISION NOT NULL,
      take_profit DOUBLE PRECISION NOT NULL,
      leverage INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'OPEN',
      pnl DOUBLE PRECISION DEFAULT 0,
      opened_at TIMESTAMPTZ DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS radar_symbol_state (
      symbol TEXT PRIMARY KEY,
      last_candle BIGINT NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS radar_one_open_per_symbol
    ON radar_trades(symbol)
    WHERE status = 'OPEN'
  `);

  await pool.query(`
    INSERT INTO radar_account (id, balance)
    VALUES (1, $1)
    ON CONFLICT (id) DO NOTHING
  `, [INITIAL_BALANCE]);
}

async function getUniverse() {
  const data = await marketData(
    "/api/v5/public/instruments?instType=SWAP"
  );

  if (!Array.isArray(data)) {
    throw new Error("OKX instrument list is invalid");
  }

  return data
    .filter(item =>
      item.state === "live" &&
      item.settleCcy === "USDT" &&
      item.instId.endsWith("-USDT-SWAP")
    )
    .map(item => toSymbol(item.instId))
    .sort();
}

async function getAllPrices() {
  const data = await marketData(
    "/api/v5/market/tickers?instType=SWAP"
  );

  const prices = {};

  for (const item of data) {
    if (!item.instId.endsWith("-USDT-SWAP")) {
      continue;
    }

    const price = Number(item.last);

    if (Number.isFinite(price) && price > 0) {
      prices[toSymbol(item.instId)] = price;
    }
  }

  return prices;
}

async function getCandles(symbol) {
  const instId = encodeURIComponent(toInstId(symbol));

  const data = await marketData(
    "/api/v5/market/candles?instId=" +
    instId +
    "&bar=15m&limit=100"
  );

  if (!Array.isArray(data)) {
    throw new Error("Invalid candle response");
  }

  return data
    .filter(c => c[8] === "1")
    .map(c => ({
      time: Number(c[0]),
      closeTime: Number(c[0]) + 15 * 60 * 1000,
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4])
    }))
    .sort((a, b) => a.time - b.time);
}

function ema(values, period) {
  if (values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let result = values
    .slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * multiplier +
      result * (1 - multiplier);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const change = values[i] - values[i - 1];

    if (change > 0) {
      gains += change;
    } else {
      losses -= change;
    }
  }

  const averageGain = gains / period;
  const averageLoss = losses / period;

  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }

  return 100 - 100 / (
    1 + averageGain / averageLoss
  );
}

function getSignal(values) {
  const fast = ema(values, 20);
  const slow = ema(values, 50);
  const strength = rsi(values, 14);

  if (
    fast === null ||
    slow === null ||
    strength === null
  ) {
    return null;
  }

  if (
    fast > slow &&
    strength >= 50 &&
    strength <= 68
  ) {
    return "LONG";
  }

  if (
    fast < slow &&
    strength >= 32 &&
    strength <= 50
  ) {
    return "SHORT";
  }

  return null;
}

async function closeTrade(client, trade, price) {
  const entry = Number(trade.entry);
  const quantity = Number(trade.quantity);
  const isShort = trade.side === "SHORT";

  const gross = isShort
    ? (entry - price) * quantity
    : (price - entry) * quantity;

  const entryFee = entry * quantity * FEE_RATE;
  const exitFee = price * quantity * FEE_RATE;

  const pnl = gross - entryFee - exitFee;

  const returnedCapital =
    entry * quantity + gross - exitFee;

  await client.query(`
    UPDATE radar_trades
    SET status = 'CLOSED',
        pnl = $1,
        closed_at = NOW()
    WHERE id = $2 AND status = 'OPEN'
  `, [pnl, trade.id]);

  await client.query(`
    UPDATE radar_account
    SET balance = balance + $1
    WHERE id = 1
  `, [returnedCapital]);

  return {
    pnl,
    returnedCapital
  };
}

export async function runBot() {
  await setup();

  // Get public market data before opening the DB transaction.
  const universe = await getUniverse();

  if (!universe.length) {
    throw new Error("OKX returned no active USDT perpetual contracts");
  }

  const prices = await getAllPrices();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const accountResult = await client.query(`
      SELECT *
      FROM radar_account
      WHERE id = 1
      FOR UPDATE
    `);

    const account = accountResult.rows[0];

    if (!account) {
      throw new Error("Paper trading account not found");
    }

    let balance = Number(account.balance);
    let cursor = Number(account.scan_cursor || 0);

    const openResult = await client.query(`
      SELECT *
      FROM radar_trades
      WHERE status = 'OPEN'
      ORDER BY opened_at ASC
    `);

    let openCount = openResult.rowCount;
    let opened = 0;
    let closed = 0;
    let scanned = 0;

    const diagnostics = [];

    // Monitor existing paper trades.
    for (const trade of openResult.rows) {
      const price = prices[trade.symbol];

      if (!price) {
        diagnostics.push({
          symbol: trade.symbol,
          status: "PRICE_UNAVAILABLE",
          reason: "Price unavailable on OKX"
        });

        continue;
      }

      const isShort = trade.side === "SHORT";

      const hitStop = isShort
        ? price >= Number(trade.stop_loss)
        : price <= Number(trade.stop_loss);

      const hitTarget = isShort
        ? price <= Number(trade.take_profit)
        : price >= Number(trade.take_profit);

      if (hitStop || hitTarget) {
        const result = await closeTrade(
          client,
          trade,
          price
        );

        balance += result.returnedCapital;
        openCount--;
        closed++;

        diagnostics.push({
          symbol: trade.symbol,
          side: trade.side,
          status: "CLOSED",
          price,
          pnl: Number(result.pnl.toFixed(4)),
          reason: hitStop
            ? "Stop loss reached"
            : "Take profit reached"
        });
      }
    }

    // Rotate through the full active USDT perpetual list.
    const batch = [];

    for (
      let i = 0;
      i < Math.min(BATCH_SIZE, universe.length);
      i++
    ) {
      batch.push(
        universe[(cursor + i) % universe.length]
      );
    }

    // Fetch candles concurrently to reduce execution time.
    const candleResults = await Promise.all(
      batch.map(async symbol => {
        try {
          return {
            symbol,
            data: await getCandles(symbol),
            error: null
          };
        } catch (error) {
          return {
            symbol,
            data: null,
            error: error.message
          };
        }
      })
    );

    for (const item of candleResults) {
      const symbol = item.symbol;
      scanned++;

      if (openCount >= MAX_OPEN_TRADES) {
        diagnostics.push({
          symbol,
          status: "LIMIT",
          reason: "Maximum open trades reached"
        });

        continue;
      }

      if (balance <= MIN_BALANCE) {
        diagnostics.push({
          symbol,
          status: "NO_BALANCE",
          reason: "Not enough virtual balance"
        });

        continue;
      }

      const existing = await client.query(`
        SELECT id
        FROM radar_trades
        WHERE symbol = $1 AND status = 'OPEN'
        LIMIT 1
      `, [symbol]);

      if (existing.rowCount) {
        diagnostics.push({
          symbol,
          status: "SKIPPED",
          reason: "An open trade already exists"
        });

        continue;
      }

      if (item.error) {
        diagnostics.push({
          symbol,
          status: "ERROR",
          reason: "Candle error: " + item.error
        });

        continue;
      }

      const data = item.data;

      if (!Array.isArray(data) || data.length < 55) {
        diagnostics.push({
          symbol,
          status: "WAIT",
          reason: "Not enough completed candles"
        });

        continue;
      }

      const latest = data[data.length - 1];
      const closes = data.map(c => c.close);

      const previous = await client.query(`
        SELECT last_candle
        FROM radar_symbol_state
        WHERE symbol = $1
      `, [symbol]);

      const previousTime = previous.rowCount
        ? Number(previous.rows[0].last_candle)
        : 0;

      if (latest.time <= previousTime) {
        diagnostics.push({
          symbol,
          status: "WAIT",
          reason: "Candle already checked"
        });

        continue;
      }

      await client.query(`
        INSERT INTO radar_symbol_state (
          symbol,
          last_candle
        )
        VALUES ($1, $2)
        ON CONFLICT (symbol)
        DO UPDATE SET last_candle = EXCLUDED.last_candle
      `, [symbol, latest.time]);

      const fast = ema(closes, 20);
      const slow = ema(closes, 50);
      const strength = rsi(closes, 14);

      const direction = getSignal(closes);

      const info = {
        symbol,
        price: latest.close,
        ema20: fast,
        ema50: slow,
        rsi: strength,
        candleTime: new Date(latest.time).toISOString()
      };

      if (!direction) {
        diagnostics.push({
          ...info,
          status: "NO_ENTRY",
          reason: "Entry conditions not met"
        });

        continue;
      }

      const entry = latest.close;
      const stopDistance = entry * STOP_PERCENT;
      const riskAmount = balance * RISK;

      let quantity = riskAmount / stopDistance;

      const maxNotional =
        balance * MAX_POSITION_PERCENT;

      if (quantity * entry > maxNotional) {
        quantity = maxNotional / entry;
      }

      const cost = quantity * entry;
      const entryFee = cost * FEE_RATE;
      const totalCost = cost + entryFee;

      if (
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        totalCost > balance
      ) {
        diagnostics.push({
          ...info,
          status: "NO_BALANCE",
          reason: "Insufficient virtual balance"
        });

        continue;
      }

      const stop = direction === "SHORT"
        ? entry + stopDistance
        : entry - stopDistance;

      const target = direction === "SHORT"
        ? entry - stopDistance * TARGET_MULTIPLIER
        : entry + stopDistance * TARGET_MULTIPLIER;

      try {
        await client.query(`
          INSERT INTO radar_trades (
            symbol,
            side,
            entry,
            quantity,
            stop_loss,
            take_profit,
            leverage,
            status
          )
          VALUES ($1, $2, $3, $4, $5, $6, 1, 'OPEN')
        `, [
          symbol,
          direction,
          entry,
          quantity,
          stop,
          target
        ]);
      } catch (error) {
        if (error.code === "23505") {
          diagnostics.push({
            ...info,
            status: "SKIPPED",
            reason: "Another open trade exists"
          });

          continue;
        }

        throw error;
      }

      await client.query(`
        UPDATE radar_account
        SET balance = balance - $1
        WHERE id = 1
      `, [totalCost]);

      balance -= totalCost;
      openCount++;
      opened++;

      diagnostics.push({
        ...info,
        status: "OPENED",
        side: direction,
        quantity: Number(quantity.toFixed(8)),
        positionValue: Number(cost.toFixed(4)),
        stopLoss: Number(stop.toFixed(8)),
        takeProfit: Number(target.toFixed(8)),
        reason: "Simulated " + direction + " trade opened"
      });
    }

    const nextCursor =
      (cursor + batch.length) % universe.length;

    const report = {
      updatedAt: new Date().toISOString(),
      exchange: EXCHANGE_NAME,
      universeCount: universe.length,
      batchSize: batch.length,
      nextCursor,
      scanned,
      opened,
      closed,
      results: diagnostics
    };

    await client.query(`
      UPDATE radar_account
      SET scan_cursor = $1,
          diagnostics = $2::jsonb
      WHERE id = 1
    `, [
      nextCursor,
      JSON.stringify(report)
    ]);

    await client.query("COMMIT");

    return {
      ok: true,
      mode: "PAPER_TRADING",
      exchange: EXCHANGE_NAME,
      market: "USDT Perpetual",
      interval: INTERVAL,
      universeCount: universe.length,
      batchSize: batch.length,
      scanned,
      opened,
      closed,
      openTrades: openCount,
      maxOpenTrades: MAX_OPEN_TRADES,
      availableBalance: Number(balance.toFixed(4)),
      diagnostics,
      trading: "Simulated LONG and SHORT only",
      message: "Paper trading cycle completed"
    };

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function getStatus() {
  await setup();

  const [account, trades, counts] = await Promise.all([
    pool.query(`
      SELECT *
      FROM radar_account
      WHERE id = 1
    `),

    pool.query(`
      SELECT *
      FROM radar_trades
      ORDER BY opened_at DESC
      LIMIT 50
    `),

    pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE status = 'OPEN'
        )::int AS open,
        COUNT(*) FILTER (
          WHERE status = 'CLOSED'
        )::int AS closed
      FROM radar_trades
    `)
  ]);

  const row = account.rows[0];

  if (!row) {
    throw new Error("Paper trading account not found");
  }

  const diagnostics = row.diagnostics || {};

  return {
    ok: true,
    mode: "PAPER_TRADING",
    exchange: EXCHANGE_NAME,
    market: "USDT Perpetual",
    availableBalance: Number(row.balance),
    openTrades: counts.rows[0].open,
    closedTrades: counts.rows[0].closed,
    maxOpenTrades: MAX_OPEN_TRADES,
    universeCount: diagnostics.universeCount || 0,
    lastScan: diagnostics.updatedAt || null,
    scanResults: diagnostics.results || [],
    trades: trades.rows,
    diagnostics
  };
}
