
const SYMBOLS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE"];

function ema(values, period) {
  if (values.length < period) return null;

  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    result = values[i] * multiplier + result * (1 - multiplier);
  }

  return result;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * 13 + Math.max(change, 0)) / 14;
    avgLoss = (avgLoss * 13 + Math.max(-change, 0)) / 14;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function analyze(rows, symbol) {
  const closed = rows.slice(0, -1);
  if (closed.length < 51) throw new Error("کندل کافی نیست");

  const closes = closed.map(c => c.close);
  const price = closes[closes.length - 1];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const currentRsi = rsi(closes);

  let signal = "WAIT";
  let reason = "شرایط ورود کامل نیست";

  if (price > ema20 && ema20 > ema50 && currentRsi >= 52 && currentRsi < 68) {
    signal = "BUY";
    reason = "روند صعودی و تأیید RSI";
  } else if (price < ema20 && ema20 < ema50 && currentRsi >= 32 && currentRsi < 48) {
    signal = "SELL";
    reason = "روند نزولی و تأیید RSI";
  }

  return {
    symbol: symbol + "USDT",
    market: "binance_spot",
    price,
    ema20,
    ema50,
    rsi: currentRsi,
    signal,
    reason,
    candleTime: new Date(closed[closed.length - 1].time).toISOString()
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

async function getSpot(symbol) {
  const url =
    "https://api.binance.com/api/v3/klines" +
    "?symbol=" + symbol + "USDT&interval=15m&limit=100";

  const rows = await fetchJson(url);

  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("داده Binance Spot موجود نیست");
  }

  return rows.map(c => ({
    time: Number(c[0]),
    close: Number(c[4])
  }));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "فقط GET مجاز است"
    });
  }

  const results = await Promise.all(
    SYMBOLS.map(async symbol => {
      try {
        return analyze(await getSpot(symbol), symbol);
      } catch (error) {
        return {
          symbol: symbol + "USDT",
          market: "binance_spot",
          signal: "ERROR",
          reason: error.message
        };
      }
    })
  );

  const errors = results.filter(x => x.signal === "ERROR");

  return res.status(200).json({
    ok: errors.length < results.length,
    app: "Crypto Radar AI",
    market: "Binance Spot",
    timeframe: "15m",
    mode: "PAPER_TRADING",
    updatedAt: new Date().toISOString(),
    data: results,
    errors
  });
}
