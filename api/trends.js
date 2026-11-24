
const BASE = "https://www.okx.com";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=30");

  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "GET only" });
  }

  try {
    const [ir, tr] = await Promise.all([
      fetch(BASE + "/api/v5/public/instruments?instType=SWAP"),
      fetch(BASE + "/api/v5/market/tickers?instType=SWAP")
    ]);

    if (!ir.ok || !tr.ok) throw new Error("OKX market request failed");

    const [ib, tb] = await Promise.all([ir.json(), tr.json()]);

    if (ib.code !== "0" || tb.code !== "0") {
      throw new Error("OKX returned an API error");
    }

    const live = new Set(
      ib.data
        .filter(x => x.state === "live" &&
          x.settleCcy === "USDT" &&
          x.instId.endsWith("-USDT-SWAP"))
        .map(x => x.instId)
    );

    const coins = tb.data
      .filter(x => live.has(x.instId))
      .map(x => {
        const price = Number(x.last);
        const open = Number(x.open24h);
        const change = open > 0 ? ((price - open) / open) * 100 : 0;

        return {
          symbol: x.instId.replaceAll("-", "").replace("SWAP", ""),
          price,
          change24h: Number(change.toFixed(2)),
          direction: change > 0.15 ? "UP" :
                     change < -0.15 ? "DOWN" : "SIDEWAYS",
          volume24h: Number(x.volCcy24h || 0)
        };
      })
      .sort((a, b) => b.change24h - a.change24h);

    return res.status(200).json({
      ok: true,
      exchange: "OKX",
      timeframe: "24h",
      count: coins.length,
      coins
    });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e.message
    });
  }
}
