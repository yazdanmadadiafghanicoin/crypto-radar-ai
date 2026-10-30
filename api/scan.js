
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT"];

async function getCandles(base, symbol) {
  const url = `${base}?symbol=${symbol}&interval=15m&limit=100`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Exchange returned ${response.status}`);
  }

  return response.json();
}

function ema(values, period) {
  if (values.length < period) return null;

  const multiplier = 2 / (period + 1);
  let result = values.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < values.length; i++) {
    result = values[i] * multiplier + result * (1 - multiplier);
  }

  return result;
}

function calculateRsi(values, period = 14) {
  if (values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;

  return 100 - 100 / (1 + avgGain / avgLoss);
}

function analyze(candles, market, symbol) {
  // آخرین کندل ممکن است هنوز بسته نشده باشد.
  // برای جلوگیری از سیگنال ناپایدار، آن را کنار می‌گذاریم.
  const closed = candles.slice(0, -1);

  const closes = closed.map(c => Number(c[4]));
  const last = closed[closed.length - 1];

  const price = Number(last[4]);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi = calculateRsi(closes, 14);

  let signal = "WAIT";
  let reason = "شرایط ورود کامل نیست";

  if (market === "spot") {
    if (price > ema20 && ema20 > ema50 && rsi >= 50 && rsi < 68) {
      signal = "BUY";
      reason = "روند صعودی و RSI مناسب";
    } else if (price < ema20 && ema20 < ema50 && rsi < 48) {
      signal = "SELL";
      reason = "روند نزولی؛ برای خرید اسپات مناسب نیست";
    }
  } else {
    if (price > ema20 && ema20 > ema50 && rsi >= 52 && rsi < 68) {
      signal = "LONG";
      reason = "روند صعودی و تأیید RSI";
    } else if (price < ema20 && ema20 < ema50 && rsi >= 32 && rsi < 48) {
      signal = "SHORT";
      reason = "روند نزولی و تأیید RSI";
    }
  }

  return {
    symbol,
    market,
    price,
    ema20,
    ema50,
    rsi,
    signal,
    reason,
    candleTime: new Date(Number(last[6])).toISOString()
  };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "فقط GET مجاز است" });
  }

  try {
    const results = await Promise.all(
      SYMBOLS.map(async symbol => {
        const [spot, futures] = await Promise.all([
          getCandles("https://api.binance.com/api/v3/klines", symbol),
          getCandles("https://fapi.binance.com/fapi/v1/klines", symbol)
        ]);

        return [
          analyze(spot, "spot", symbol),
          analyze(futures, "futures", symbol)
        ];
      })
    );

    return res.status(200).json({
      ok: true,
      app: "Crypto Radar AI",
      timeframe: "15m",
      updatedAt: new Date().toISOString(),
      data: results.flat()
    });
  } catch (error) {
    console.error("Market scan failed:", error.message);
    return res.status(502).json({
      ok: false,
      error: "دریافت اطلاعات بازار ناکام شد. کمی بعد دوباره امتحان کن."
    });
  }
};
