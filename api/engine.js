
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined,
  max: 2
});

// Binance USD-M Futures - PAPER TRADING ONLY
const BASE_URL = "https://fapi.binance.com";
const INTERVAL = "15m";
const INITIAL_BALANCE = 1000;
const RISK = 0.01;
const FEE_RATE = 0.0005;
const MAX_OPEN_TRADES = 5;
const MAX_POSITION_PERCENT = 0.18;
const STOP_PERCENT = 0.05;
const TARGET_MULTIPLIER = 2;
const BATCH_SIZE = 20;

async function binance(path) {
  const response = await fetch(BASE_URL + path, {
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error("Binance HTTP " + response.status);
  }

  return response.json();
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
    NOT NULL DEFAULT '[]'::jsonb
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

// دریافت تمام قراردادهای فعال USDT Perpetual
async function getUniverse() {
  const data = await binance("/fapi/v1/exchangeInfo");

  if (!Array.isArray(data.symbols)) {
    throw new Error("Binance symbol list is missing");
  }

  return data.symbols
    .filter(item =>
      item.status === "TRADING" &&
      item.contractType === "PERPETUAL" &&
      item.quoteAsset === "USDT" &&
      item.marginAsset === "USDT"
    )
    .map(item => item.symbol)
    .sort();
}

// دریافت قیمت تمام قراردادها با یک درخواست
async function getAllPrices() {
  const data = await binance("/fapi/v1/ticker/price");

  const prices = {};

  for (const item of data) {
    const price = Number(item.price);

    if (Number.isFinite(price) && price > 0) {
      prices[item.symbol] = price;
    }
  }

  return prices;
}

// دریافت کندل‌های بسته‌شده ۱۵ دقیقه‌ای
async function getCandles(symbol) {
  const data = await binance(
    "/fapi/v1/klines?symbol=" +
    encodeURIComponent(symbol) +
    "&interval=15m&limit=100"
  );

  if (!Array.isArray(data)) {
    throw new Error("Invalid Binance candle response");
  }

  const now = Date.now();

  return data
    .filter(c => Number(c[6]) < now)
    .map(c => ({
      time: Number(c[0]),
      closeTime: Number(c[6]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4])
    }));
}

function ema(values, period) {
  if (values.length < period) return null;

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
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
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
  const strength = rsi(values);

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

    let balance = Number(account.balance);
    let cursor = Number(account.scan_cursor || 0);

    // دریافت بازار بایننس
    const universe = await getUniverse();

    if (!universe.length) {
      throw new Error("No active USDT perpetual symbols found");
    }

    const prices = await getAllPrices();

    // بررسی معاملات قبلی
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

    for (const trade of openResult.rows) {
      const price = prices[trade.symbol];

      if (!price) {
        diagnostics.push({
          symbol: trade.symbol,
          status: "PRICE_UNAVAILABLE",
          reason: "قیمت در بازار بایننس پیدا نشد"
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
            ? "حد ضرر فعال شد"
            : "حد سود فعال شد"
        });
      }
    }

    // انتخاب ۲۰ ارز از فهرست کامل
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

    // اسکن نوبتی ارزها
    for (const symbol of batch) {
      scanned++;

      if (openCount >= MAX_OPEN_TRADES) {
        diagnostics.push({
          symbol,
          status: "LIMIT",
          reason: "حداکثر ۵ معامله باز است"
        });

        continue;
      }

      if (balance <= 10) {
        diagnostics.push({
          symbol,
          status: "NO_BALANCE",
          reason: "موجودی مجازی کافی نیست"
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
          reason: "برای این ارز معامله باز وجود دارد"
        });

        continue;
      }

      let data;

      try {
        data = await getCandles(symbol);
      } catch (error) {
        diagnostics.push({
          symbol,
          status: "ERROR",
          reason: "خطای کندل: " + error.message
        });

        continue;
      }

      if (data.length < 55) {
        diagnostics.push({
          symbol,
          status: "WAIT",
          reason: "تعداد کندل کافی نیست"
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
          candleTime: new Date(latest.time).toISOString(),
          reason: "این کندل قبلاً بررسی شده است"
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
      const strength = rsi(closes);

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
          reason: "شرایط ورود کامل نیست"
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
          reason: "موجودی برای ورود کافی نیست"
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
            reason: "معامله باز دیگری برای این ارز وجود دارد"
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
        reason: direction === "LONG"
          ? "معامله آزمایشی LONG باز شد"
          : "معامله آزمایشی SHORT باز شد"
      });
    }

    const nextCursor =
      (cursor + batch.length) % universe.length;

    await client.query(`
      UPDATE radar_account
      SET scan_cursor = $1,
          diagnostics = $2::jsonb
      WHERE id = 1
    `, [
      nextCursor,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        exchange: "Binance USD-M Futures",
        universeCount: universe.length,
        batchSize: batch.length,
        nextCursor,
        scanned,
        opened,
        closed,
        results: diagnostics
      })
    ]);

    await client.query("COMMIT");

    return {
      ok: true,
      mode: "PAPER_TRADING",
      exchange: "Binance USD-M Futures",
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
      message: "Binance paper trading cycle completed"
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

  const diagnostics = account.rows[0].diagnostics || {};

  return {
    ok: true,
    mode: "PAPER_TRADING",
    exchange: "Binance USD-M Futures",
    market: "USDT Perpetual",
    availableBalance: Number(account.rows[0].balance),
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
