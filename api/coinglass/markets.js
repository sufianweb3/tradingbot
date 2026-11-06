import { cgFetch } from "../../src/coinglass.js";

export const config = { maxDuration: 10 };

/**
 * Same-origin CoinGlass page proxy for the browser worker.
 *
 * Browsers can block direct requests to capi.coinglass.com (ad blockers,
 * third-party tracking protection, corporate proxies, regional restrictions).
 * This function fetches and decrypts the same page server-side so the browser
 * only talks to its own origin.
 *
 * GET /api/coinglass/markets?page=1
 */
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "GET") {
    res.status(405).json({ ok: false, error: "method-not-allowed" });
    return;
  }

  const page = Math.max(1, Math.min(40, Number(req.query?.page) || 1));
  const target =
    `https://capi.coinglass.com/api/home/v2/coinMarkets?sort=openInterest` +
    `&order=desc&keyword=&pageNum=${page}&pageSize=100&ex=all&tags=crypto`;

  try {
    const data = await cgFetch(target, { retries: 1, timeoutMs: 8000 });
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ ok: false, error: err?.message || "coinglass-proxy-failed" });
  }
}
