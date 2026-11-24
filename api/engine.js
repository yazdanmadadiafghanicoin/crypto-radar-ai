
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

  if (data.error?.length) {
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
    .filter(c => Number(c[0]) * 1000 + 900000 <= now)
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

  let result = values.slice(0, period)
    .reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * multiplier +
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

  if (fast > slow && strength >= 50 && strength <= 68) {
    return "LONG";
  }

  if (fast < slow && strength >= 32 && strength <= 50) {
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

  return { returnedCapital, pnl };
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

    let openCount = openResult.rowCount;
    let closed = 0;
    let opened = 0;
    let scanned = 0;

    const diagnostics = [];
    const cursor = Number(account.scan_cursor || 0);

    // بررسی معاملات باز و بستن در حد سود یا حد ضرر
    for (const trade of openResult.rows) {
      const item = PAIRS.find(p => p.symbol === trade.symbol);
      if (!item) continue;

      try {
        const price = await getPrice(item.pair);

        if (!Number.isFinite(price) || price <= 0) continue;

        const isShort = trade.side === "SHORT";

        const hitStop = isShort
          ? price >= Number(trade.stop_loss)
          : price <= Number(trade.stop_loss);

        const hitTarget = isShort
          ? price <= Number(trade.take_profit)
          : price >= Number(trade.take_profit);

        if (hitStop || hitTarget) {
          const result = await closeTrade(client, trade, price);

          balance += result.returnedCapital;
          openCount--;
          closed++;

          diagnostics.push({
            symbol: trade.symbol,
            status: "CLOSED",
            side: trade.side,
            price,
            pnl: Number(result.pnl.toFixed(4)),
            reason: hitStop ? "حد ضرر فعال شد" : "حد سود فعال شد"
          });
        }
      } catch (error) {
        diagnostics.push({
          symbol: trade.symbol,
          status: "ERROR",
          reason: "خطا در بررسی معامله: " + error.message
        });
      }
    }

    // بررسی ارزها برای ورود جدید
    for (let i = 0; i < PAIRS.length; i++) {
      if (openCount >= MAX_OPEN_TRADES) {
        diagnostics.push({
          status: "LIMIT",
          reason: "حداکثر تعداد معاملات همزمان تکمیل شده است"
        });
        break;
      }

      if (balance <= 10) {
        diagnostics.push({
          status: "NO_BALANCE",
          reason: "موجودی مجازی کافی نیست"
        });
        break;
      }

      const item = PAIRS[(cursor + i) % PAIRS.length];

      const existing = await client.query(`
        SELECT id FROM radar_trades
        WHERE symbol = $1 AND status = 'OPEN'
        LIMIT 1
      `, [item.symbol]);

      if (existing.rowCount) {
        diagnostics.push({
          symbol: item.symbol,
          status: "SKIPPED",
          reason: "برای این ارز از قبل معامله باز وجود دارد"
        });

        scanned++;
        continue;
      }

      let data;

      try {
        data = await candles(item.pair);
      } catch (error) {
        diagnostics.push({
          symbol: item.symbol,
          status: "ERROR",
          reason: "خطای دریافت کندل: " + error.message
        });

        scanned++;
        continue;
      }

      if (data.length < 55) {
        diagnostics.push({
          symbol: item.symbol,
          status: "WAIT",
          candles: data.length,
          reason: "حداقل ۵۵ کندل برای تحلیل لازم است"
        });

        scanned++;
        continue;
      }

      const latest = data[data.length - 1];
      const closes = data.map(c => c.close);

      const previous = await client.query(`
        SELECT last_candle FROM radar_symbol_state
        WHERE symbol = $1
      `, [item.symbol]);

      const previousTime = previous.rowCount
        ? Number(previous.rows[0].last_candle)
        : 0;

      if (latest.time <= previousTime) {
        diagnostics.push({
          symbol: item.symbol,
          status: "WAIT",
          candleTime: new Date(latest.time).toISOString(),
          reason: "این کندل قبلاً بررسی شده؛ منتظر کندل جدید هستیم"
        });

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

      const fast = ema(closes, 20);
      const slow = ema(closes, 50);
      const strength = rsi(closes);
      const direction = signal(closes);

      const diagnostic = {
        symbol: item.symbol,
        candleTime: new Date(latest.time).toISOString(),
        price: latest.close,
        ema20: fast,
        ema50: slow,
        rsi: strength
      };

      if (!direction) {
        let reason = "شرایط ورود کامل نیست";

        if (fast === null || slow === null || strength === null) {
          reason = "اطلاعات کافی برای محاسبه اندیکاتورها وجود ندارد";
        } else if (fast > slow && !(strength >= 50 && strength <= 68)) {
          reason = "روند صعودی است، اما RSI باید بین ۵۰ تا ۶۸ باشد";
        } else if (fast < slow && !(strength >= 32 && strength <= 50)) {
          reason = "روند نزولی است، اما RSI باید بین ۳۲ تا ۵۰ باشد";
        } else if (fast === slow) {
          reason = "EMA20 و EMA50 برابر هستند";
        }

        diagnostics.push({
          ...diagnostic,
          status: "NO_ENTRY",
          reason
        });

        continue;
      }

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

      if (totalCost > balance) {
        diagnostics.push({
          ...diagnostic,
          status: "NO_BALANCE",
          side: direction,
          reason: "موجودی برای ورود به معامله کافی نیست"
        });

        continue;
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        diagnostics.push({
          ...diagnostic,
          status: "ERROR",
          reason: "محاسبه مقدار معامله نامعتبر است"
        });

        continue;
      }

      const stop = direction === "SHORT"
        ? entry + stopDistance
        : entry - stopDistance;

      const target = direction === "SHORT"
        ? entry - stopDistance * 2
        : entry + stopDistance * 2;

      try {
        await client.query(`
          INSERT INTO radar_trades (
            symbol, side, entry, quantity,
            stop_loss, take_profit, leverage, status
          )
          VALUES ($1, $2, $3, $4, $5, $6, 1, 'OPEN')
        `, [
          item.symbol,
          direction,
          entry,
          quantity,
          stop,
          target
        ]);
      } catch (error) {
        if (error.code === "23505") {
          diagnostics.push({
            ...diagnostic,
            status: "SKIPPED",
            reason: "برای این ارز معامله باز دیگری ثبت شده است"
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
        ...diagnostic,
        status: "OPENED",
        side: direction,
        quantity: Number(quantity.toFixed(8)),
        stopLoss: Number(stop.toFixed(8)),
        takeProfit: Number(target.toFixed(8)),
        reason: direction === "SHORT"
          ? "معامله آزمایشی فروش باز شد"
          : "معامله آزمایشی خرید باز شد"
      });
    }

    const nextCursor =
      (cursor + Math.max(1, scanned)) % PAIRS.length;

    await client.query(`
      UPDATE radar_account
      SET scan_cursor = $1,
          diagnostics = $2::jsonb
      WHERE id = 1
    `, [
      nextCursor,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
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
      exchange: "Kraken Spot - simulated LONG/SHORT",
      interval: INTERVAL,
      scanned,
      opened,
      closed,
      openTrades: openCount,
      availableBalance: Number(balance.toFixed(4)),
      diagnostics,
      trading: "LONG and SHORT - simulated only",
      message: "Paper trading diagnostic cycle completed"
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
    exchange: "Kraken Spot - simulated LONG/SHORT",
    availableBalance: Number(account.rows[0].balance),
    openTrades: counts.rows[0].open,
    closedTrades: counts.rows[0].closed,
    trades: trades.rows,
    diagnostics: account.rows[0].diagnostics || []
  };
}
