
import { timingSafeEqual } from "node:crypto";
import { runBot } from "./engine.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const secret = process.env.BOT_SECRET;
  const auth = req.headers.authorization || "";
  const provided = auth.startsWith("Bearer ")
    ? auth.slice(7)
    : "";

  if (!secret || !provided) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const a = Buffer.from(secret);
  const b = Buffer.from(provided);

  if (
    a.length !== b.length ||
    !timingSafeEqual(a, b)
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await runBot();
    return res.status(200).json(result);
  } catch (error) {
    console.error(error.message);
    return res.status(500).json({
      ok: false,
      error: "Bot execution failed"
    });
  }
}
