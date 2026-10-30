
const SYMBOLS = ["BTC", "ETH", "BNB", "SOL", "XRP", "DOGE"];

const KRAKEN_PAIRS = {
  BTC: "XBTUSD",
  ETH: "ETHUSD",
  BNB: "BNBUSD",
  SOL: "SOLUSD",
  XRP: "XRPUSD",
  DOGE: "DOGEUSD"
};

function ema(values, period) {
  if (values.length < period) return null;

  let result =
    values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    result =
      values[i] * multiplier + result * (1 - multiplier);
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

    avgGain =
      (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss =
      (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;

  return 100 - 100 / (1 + avgGain / avgLoss);
}

function analyze(candles, symbol, market) {
  // هر کندل به شکل {time, close} است.
  // کندل آخر را حذف می‌کنیم چون ممکن است هنوز باز باشد.
  const closed = candles.slice(0, -1);

  if (closed.length < 51) {
    throw new Error("برای محاسبه شاخص‌ها کندل کافی نیست");
  }

  const closes = closed.map(c => c.close);
  const price = closes[closes.length - 1];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const currentRsi = rsi(closes, 14);

  let signal = "WAIT";
  let reason = "شرایط ورود کامل نیست";

  if (market === "spot") {
    if (price > ema20 && ema20 > ema50 &&
        currentRsi >= 50 && currentRsi < 68) {
      signal = "BUY";
      reason = "روند صعودی و تأیید RSI";
    } else if (price < ema20 && ema20 < ema50 &&
               currentRsi < 48) {
      signal = "SELL";
      reason = "روند نزولی؛ خرید مناسب نیست";
    }
  } else {
    if (price > ema20 && ema20 > ema50 &&
        currentRsi >= 52 && currentRsi < 68) {
      signal = "LONG";
      reason = "روند صعودی و تأیید RSI";
    } else if (price < ema20 && ema20 < ema50 &&
               currentRsi >= 32 && currentRsi < 48) {
      signal = "SHORT";
      reason = "روند نزولی و تأیید RSI";
    }
  }

  return {
    symbol: symbol + "USDT",
    market,
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
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  return response.json();
}

async function getSpot(symbol) {
  const pair = KRAKEN_PAIRS[symbol];

  const url =
    "https://api.kraken.com/0/public/OHLC?pair=" +
    encodeURIComponent(pair) + "&interval=15";

  const json = await fetchJson(url);

  if (json.error && json.error.length) {
    throw new Error(json.error.join(", "));
  }

  const key = Object.keys(json.result || {})
    .find(k => k !== "last");

  if (!key) throw new Error("داده اسپات موجود نیست");

  return json.result[key].map(c => ({
    time: Number(c[0]) * 1000,
    close: Number(c[4])
  }));
}

async function getFutures(symbol) {
  const url =
    "https://api.bybit.com/v5/market/kline" +
    "?category=linear&symbol=" + symbol +
    "&interval=15&limit=100";

  const json = await fetchJson(url);

  if (json.retCode !== 0) {
    throw new Error(json.retMsg || "خطای Bybit");
  }

  const rows = json.result && json.result.list;

  if (!rows || !rows.length) {
    throw new Error("داده فیوچرز موجود نیست");
  }

  // Bybit کندل‌ها را از جدید به قدیم برمی‌گرداند.
  return rows
    .slice()
    .reverse()
    .map(c => ({
      time: Number(c[0]),
      close: Number(c[4])
    }));
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "فقط GET مجاز است"
    });
  }

  const results = await Promise.all(
    SYMBOLS.flatMap(symbol => [
      (async () => {
        try {
          const candles = await getSpot(symbol);
          return analyze(candles, symbol, "spot");
        } catch (e) {
          return {
            symbol: symbol + "USDT",
            market: "spot",
            signal: "ERROR",
            reason: e.message
          };
        }
      })(),
      (async () => {
        try {
          const candles = await getFutures(symbol);
          return analyze(candles, symbol, "futures");
        } catch (e) {
          return {
            symbol: symbol + "USDT",
            market: "futures",
            signal: "ERROR",
            reason: e.message
          };
        }
      })()
    ])
  );

  const valid = results.filter(x => x.signal !== "ERROR");
  const errors = results.filter(x => x.signal === "ERROR");

  return res.status(valid.length ? 200 : 502).json({
    ok: valid.length > 0,
    app: "Crypto Radar AI",
    timeframe: "15m",
    updatedAt: new Date().toISOString(),
    data: results,
    errors: errors.map(x => ({
      symbol: x.symbol,
      market: x.market,
      error: x.reason
    }))
  });
};
