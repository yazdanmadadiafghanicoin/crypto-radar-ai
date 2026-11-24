async function getFutures(symbol) {
  const url =
    "https://fapi.binance.com/fapi/v1/klines" +
    "?symbol=" + symbol + "USDT" +
    "&interval=15m&limit=100";

  const rows = await fetchJson(url);

  if (!Array.isArray(rows) || !rows.length) {
    throw new Error("داده Binance Futures موجود نیست");
  }

  return rows.map(c => ({
    time: Number(c[0]),
    close: Number(c[4])
  }));
}