
const PAIRS = [
  { symbol: "BTCUSDT", pair: "XBTUSDT" },
  { symbol: "ETHUSDT", pair: "ETHUSDT" },
  { symbol: "SOLUSDT", pair: "SOLUSDT" },
  { symbol: "XRPUSDT", pair: "XRPUSDT" },
  { symbol: "DOGEUSDT", pair: "DOGEUSDT" }
];

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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) throw new Error("HTTP " + response.status);

  const data = await response.json();

  if (data.error && data.error.length) {
    throw new Error(data.error.join(", "));
  }

  return data.result;
}

async function getCandles(pair) {
  const result = await fetchJson(
    "https://api.kraken.com/0/public/OHLC?pair=" +
    encodeURIComponent(pair) + "&interval=15"
  );

  const key = Object.keys(result).find(k => k !== "last");

  if (!key || !Array.isArray(result[key])) {
    throw new Error("داده کندل پیدا نشد");
  }

  return result[key].map(c => ({
    time: Number(c[0]) * 1000,
    close: Number(c[4])
  }));
}

function analyze(rows, symbol) {
  const closed = rows.slice(0, -1);

  if (closed.length < 51) {
    throw new Error("کندل کافی نیست");
  }

  const closes = closed.map(c => c.close);
  const price = closes[closes.length - 1];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const currentRsi = rsi(closes);

  let signal = "WAIT";
  let reason = "شرایط ورود کامل نیست";

  if (price > ema20 && ema20 > ema50 &&
      currentRsi >= 52 && currentRsi < 68) {
    signal = "BUY";
    reason = "روند صعودی و تأیید RSI";
  } else if (price < ema20 && ema20 < ema50 &&
             currentRsi >= 32 && currentRsi < 48) {
    signal = "SELL";
    reason = "روند نزولی و تأیید RSI";
  }

  return {
    symbol,
    market: "kraken_spot",
    price,
    ema20,
    ema50,
    rsi: currentRsi,
    signal,
    reason,
    candleTime: new Date(closed[closed.length - 1].time).toISOString()
  };
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

  const data = await Promise.all(
    PAIRS.map(async item => {
      try {
        const candles = await getCandles(item.pair);
        return analyze(candles, item.symbol);
      } catch (error) {
        return {
          symbol: item.symbol,
          market: "kraken_spot",
          signal: "ERROR",
          reason: error.message
        };
      }
    })
  );

  const errors = data.filter(x => x.signal === "ERROR");

  return res.status(200).json({
    ok: errors.length < data.length,
    app: "Crypto Radar AI",
    exchange: "Kraken",
    market: "Spot",
    timeframe: "15m",
    mode: "PAPER_TRADING",
    updatedAt: new Date().toISOString(),
    data,
    errors
  });
}
