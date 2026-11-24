
import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : undefined,
  max: 2
});

const INTERVAL = "15m";
const RISK = 0.01;
const INITIAL_BALANCE = 1000;
const FEE_RATE = 0.001;
const MAX_OPEN_TRADES = 5;

const PAIRS = [
  { symbol: "BTCUSDT", pair: "XBTUSDT" },
  { symbol: "ETHUSDT", pair: "ETHUSDT" },
  { symbol: "SOLUSDT", pair: "SOLUSDT" },
  { symbol: "XRPUSDT", pair: "XRPUSDT" },
  { symbol: "DOGEUSDT", pair: "DOGEUSDT" }
];

async function kraken(path) {
  const response = await fetch(
    "https://api.kraken.com/0/public/" + path,
    { signal: AbortSignal.timeout(15000) }
  );

  if (!response.ok) {
    throw new Error("Kraken HTTP " + response.status);
  }

  const data = await response.json();

  if (data.error && data.error.length) {
    throw new Error(data.error.join(", "));
  }

  return data.result;
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

async function candles(pair) {
  const result = await kraken(
    "OHLC?pair=" + encodeURIComponent(pair) + "&interval=15"
  );

  const key = Object.keys(result).find(k => k !== "last");

  if (!key || !Array.isArray(result[key])) {
    throw new Error("Kraken candle data missing: " + pair);
  }

  const now = Date.now();

  return result[key]
    .filter(c => Number(c[0]) * 1000 + 15 * 60 * 1000 <= now)
    .map(c => ({
      time: Number(c[0]) * 1000,
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4])
    }));
}

async function getPrice(pair) {
  const result = await kraken(
    "Ticker?pair=" + encodeURIComponent(pair)
  );

  const key = Object.keys(result)[0];

  if (!key || !result[key].c) {
    throw new Error("Kraken ticker missing: " + pair);
  }

  return Number(result[key].c[0]);
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

  for (let i = values.length - period; i < values.length; i++) {
    const change = values[i] - values[i - 1];

    if (change > 0) gains += change;
    else losses -= change;
  }

  const averageGain = gains / period;
  const averageLoss = losses / period;

  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }

  return 100 - 100 / (1 + averageGain / averageLoss);
}

function signal(values) {
  const fast = ema(values, 20);
  const slow = ema(values, 50);
  const strength = rsi(values);

  if (fast === null || slow === null || strength === null) {
    return null;
  }

  if (
    fast > slow &&
    strength >= 50 &&
    strength <= 68
  ) {
    return "LONG";
  }

  return null;
}

async function closeTrade(client, trade, price) {
  const entry = Number(trade.entry);
  const quantity = Number(trade.quantity);

  const gross = (price - entry) * quantity;
  const entryFee = entry * quantity * FEE_RATE;
  const exitFee = price * quantity * FEE_RATE;

  const pnl = gross - entryFee - exitFee;
  const returnedCapital = entry * quantity + gross - exitFee;

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

  return returnedCapital;
}

export async function runBot() {
  await setup();

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const accountResult = await client.query(`
      SELECT * FROM radar_account
      WHERE id = 1
      FOR UPDATE
    `);

    const account = accountResult.rows[0];
    let balance = Number(account.balance);

    const openResult = await client.query(`
      SELECT * FROM radar_trades
      WHERE status = 'OPEN'
      ORDER BY opened_at ASC
    `);

    const openTrades = openResult.rows;

    let closed = 0;

    for (const trade of openTrades) {
      const item = PAIRS.find(p => p.symbol === trade.symbol);

      if (!item) continue;

      try {
        const price = await getPrice(item.pair);

        if (!Number.isFinite(price) || price <= 0) continue;

        const hitStop = price <= Number(trade.stop_loss);
        const hitTarget = price >= Number(trade.take_profit);

        if (hitStop || hitTarget) {
          const returned = await closeTrade(client, trade, price);
          balance += returned;
          closed++;
        }
      } catch (error) {
        console.error("Close check failed:", trade.symbol, error.message);
      }
    }

    const stillOpen = await client.query(`
      SELECT COUNT(*)::int AS total
      FROM radar_trades
      WHERE status = 'OPEN'
    `);

    let openCount = stillOpen.rows[0].total;
    let opened = 0;
    let scanned = 0;

    const cursor = Number(account.scan_cursor || 0);

    for (let i = 0; i < PAIRS.length; i++) {
      if (openCount >= MAX_OPEN_TRADES) break;
      if (balance <= 10) break;

      const item = PAIRS[(cursor + i) % PAIRS.length];

      const existing = await client.query(`
        SELECT id FROM radar_trades
        WHERE symbol = $1 AND status = 'OPEN'
        LIMIT 1
      `, [item.symbol]);

      if (existing.rowCount) {
        scanned++;
        continue;
      }

      let data;

      try {
        data = await candles(item.pair);
      } catch (error) {
        console.error("Candle error:", item.symbol, error.message);
        scanned++;
        continue;
      }

      if (data.length < 55) {
        scanned++;
        continue;
      }

      const latest = data[data.length - 1];
      const closes = data.map(c => c.close);

      const previous = await client.query(`
        SELECT last_candle
        FROM radar_symbol_state
        WHERE symbol = $1
      `, [item.symbol]);

      const previousTime = previous.rowCount
        ? Number(previous.rows[0].last_candle)
        : 0;

      if (latest.time <= previousTime) {
        scanned++;
        continue;
      }

      await client.query(`
        INSERT INTO radar_symbol_state (symbol, last_candle)
        VALUES ($1, $2)
        ON CONFLICT (symbol)
        DO UPDATE SET last_candle = EXCLUDED.last_candle
      `, [item.symbol, latest.time]);

      scanned++;

      if (signal(closes) !== "LONG") continue;

      const entry = latest.close;
      const stopDistance = entry * 0.01;
      const riskAmount = balance * RISK;

      let quantity = riskAmount / stopDistance;

      const maxNotional = balance * 0.9;

      if (quantity * entry > maxNotional) {
        quantity = maxNotional / entry;
      }

      const cost = quantity * entry;
      const entryFee = cost * FEE_RATE;
      const totalCost = cost + entryFee;

      if (totalCost > balance) continue;
      if (!Number.isFinite(quantity) || quantity <= 0) continue;

      const stop = entry - stopDistance;
      const target = entry + stopDistance * 2;

      await client.query(`
        INSERT INTO radar_trades (
          symbol, side, entry, quantity,
          stop_loss, take_profit, leverage, status
        )
        VALUES ($1, 'LONG', $2, $3, $4, $5, 1, 'OPEN')
      `, [
        item.symbol,
        entry,
        quantity,
        stop,
        target
      ]);

      await client.query(`
        UPDATE radar_account
        SET balance = balance - $1
        WHERE id = 1
      `, [totalCost]);

      balance -= totalCost;
      openCount++;
      opened++;
    }

    const nextCursor = (cursor + Math.max(1, scanned)) % PAIRS.length;

    await client.query(`
      UPDATE radar_account
      SET scan_cursor = $1
      WHERE id = 1
    `, [nextCursor]);

    await client.query("COMMIT");

    return {
      ok: true,
      mode: "PAPER_TRADING",
      exchange: "Kraken Spot",
      interval: INTERVAL,
      eligibleSymbols: PAIRS.length,
      scanned,
      opened,
      closed,
      openTrades: openCount,
      availableBalance: Number(balance.toFixed(4)),
      riskPerTrade: "1%",
      leverage: 1,
      trading: "BUY only - simulated",
      message: "Kraken paper trading cycle completed"
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
      SELECT * FROM radar_account WHERE id = 1
    `),
    pool.query(`
      SELECT * FROM radar_trades
      ORDER BY opened_at DESC
      LIMIT 50
    `),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open,
        COUNT(*) FILTER (WHERE status = 'CLOSED')::int AS closed
      FROM radar_trades
    `)
  ]);

  return {
    ok: true,
    mode: "PAPER_TRADING",
    exchange: "Kraken Spot",
    availableBalance: Number(account.rows[0].balance),
    openTrades: counts.rows[0].open,
    closedTrades: counts.rows[0].closed,
    trades: trades.rows
  };
}
