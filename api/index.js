
import { getStatus } from "./engine.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "GET") {
    return res.status(405).json({ error: "GET only" });
  }

  try {
    const result = await getStatus();
    return res.status(200).json(result);
  } catch (error) {
    console.error(error.message);
    return res.status(500).json({
      ok: false,
      error: "Database or server error"
    });
  }
}
