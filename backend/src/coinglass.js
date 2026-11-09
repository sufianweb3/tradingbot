/**
 * CoinGlass scraper.
 *
 * The public website calls capi.coinglass.com and encrypts responses:
 *   Layer 1: AES-128-ECB(user_header, key0) -> gzip(actual_key)
 *   Layer 2: AES-128-ECB(data_field, actual_key) -> gzip(JSON)
 * key0 = base64(url_path)[:16] when the response `v` header is "1".
 *
 * This module decrypts those payloads in Node (no browser, no API key) and
 * normalises the fields used by the strategy.
 */

let crypto = null;
let zlib = null;
if (typeof process !== "undefined" && process?.versions?.node) {
  try {
    const cryptoMod = await import("node:crypto");
    crypto = cryptoMod.default || cryptoMod;
    const zlibMod = await import("node:zlib");
    zlib = zlibMod.default || zlibMod;
  } catch {
    /* browser environment */
  }
}
import { OI_FIELD, VOL_FIELD } from "./trading.js";
import { sleep, toNum } from "./util.js";
import { CoinGlassKeyCache } from "./core/speed.js";

export const cgKeyCache = new CoinGlassKeyCache(128);

const CAP = "https://capi.coinglass.com";
const PAGE_SIZE = 100;
// CoinGlass exposes an "All / Crypto / TradFi / Spot / Categories" ribbon on the
// website. The website passes the selected tab as `tags`, so `tags=crypto`
// returns crypto-only rows (TradFi stocks, indices and commodities excluded).
const ASSET_TAG = "crypto";

const marketUrl = (page) =>
  `${CAP}/api/home/v2/coinMarkets?sort=openInterest&order=desc&keyword=&pageNum=${page}&pageSize=${PAGE_SIZE}&ex=all&tags=${ASSET_TAG}`;

const moversUrl = (sortField = "m5OiChangePercent", order = "desc", pageSize = 50) =>
  `${CAP}/api/home/v2/coinMarkets?sort=${encodeURIComponent(sortField)}&order=${encodeURIComponent(order)}&keyword=&pageNum=1&pageSize=${pageSize}&ex=all&tags=${ASSET_TAG}`;

const BASE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  encryption: "true",
  language: "en",
  origin: "https://www.coinglass.com",
  referer: "https://www.coinglass.com/",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-site",
};

const LEGACY_KEYS = {
  55: "170b070da9654622",
  66: "d6537d845a964081",
  77: "863f08689c97435b",
};

function aesEcbDecrypt(buffer, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

function key0For(v, pathname, cacheTs, timeHeader) {
  let constant;
  if (v === "1") constant = pathname;
  else if (v === "0") constant = cacheTs;
  else if (v === "2") constant = timeHeader;
  else constant = LEGACY_KEYS[v];

  if (!constant) throw new Error(`Unsupported CoinGlass encryption version v=${v}`);
  return Buffer.from(Buffer.from(constant, "utf8").toString("base64").slice(0, 16), "utf8");
}

function decryptBody(encryptedB64, userB64, v, ctx) {
  let actualKey = cgKeyCache.get(v, userB64);
  if (!actualKey) {
    const key0 = key0For(v, ctx.pathname, ctx.cacheTs, ctx.timeHeader);
    actualKey = zlib.gunzipSync(aesEcbDecrypt(Buffer.from(userB64, "base64"), key0)).toString("utf8");
    if (v === "1" || LEGACY_KEYS[v]) {
      cgKeyCache.set(v, userB64, actualKey);
    }
  }
  const inner = zlib.gunzipSync(
    aesEcbDecrypt(Buffer.from(encryptedB64, "base64"), Buffer.from(actualKey, "utf8"))
  );
  return JSON.parse(inner.toString("utf8"));
}

/**
 * Fetch a CoinGlass endpoint and return the decrypted payload.
 */
export async function cgFetch(url, { retries = 2, timeoutMs = 25000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const cacheTs = String(Date.now());
    try {
      const u = new URL(url);
      const res = await fetch(url, {
        headers: { ...BASE_HEADERS, "cache-ts-v2": cacheTs },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`CoinGlass HTTP ${res.status}`);
      const text = await res.text();
      let outer;
      try {
        outer = JSON.parse(text);
      } catch {
        throw new Error("CoinGlass returned non-JSON data");
      }
      if (outer && outer.success === false) {
        throw new Error(outer.msg || `CoinGlass error code ${outer.code}`);
      }
      const user = res.headers.get("user");
      const v = res.headers.get("v");
      if (user && v && typeof outer?.data === "string") {
        return decryptBody(outer.data, user, v, {
          pathname: u.pathname,
          cacheTs,
          timeHeader: res.headers.get("time") || "",
        });
      }
      return outer?.data !== undefined ? outer.data : outer;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(350 * (attempt + 1) + Math.random() * 200);
    }
  }
  throw lastError || new Error("CoinGlass request failed");
}

export function normaliseCoin(c) {
  const oi = {};
  for (const tf of Object.keys(OI_FIELD)) oi[tf] = toNum(c[OI_FIELD[tf]]);
  const vol = {};
  for (const tf of Object.keys(VOL_FIELD)) vol[tf] = toNum(c[VOL_FIELD[tf]]);

  return {
    symbol: String(c.symbol || "").toUpperCase().trim(),
    name: c.name || c.symbol || "",
    price: toNum(c.price),
    oi,
    vol,
    oiUsd: toNum(c.openInterest, 0) ?? 0,
    volUsd24h: toNum(c.volUsd, 0) ?? 0,
    oiChange24h: toNum(c.h24OiChangePercent),
    volChange24h: toNum(c.h24VolChangePercent),
    priceChange5m: toNum(c.m5PriceChangePercent),
    priceChange1h: toNum(c.h1PriceChangePercent),
    priceChange24h: toNum(c.h24PriceChangePercent),
    priceChange: {
      "5m": toNum(c.m5PriceChangePercent),
      "1h": toNum(c.h1PriceChangePercent),
    },
    funding: toNum(c.avgFundingRateBySymbol),
    logo: c.symbolLogo || null,
  };
}

/**
 * Official API shape (open-api-v4 `GET /api/futures/coins-markets`).
 * The field names are snake_case and differ from the website payload, so map
 * them onto the same internal coin shape used by the scraper.
 */
export function normaliseApiCoin(c) {
  const oi = {
    "5m": toNum(c.open_interest_change_percent_5m),
    "15m": toNum(c.open_interest_change_percent_15m),
    "30m": toNum(c.open_interest_change_percent_30m),
    "1h": toNum(c.open_interest_change_percent_1h),
    "4h": toNum(c.open_interest_change_percent_4h),
  };
  const vol = {
    "1h": toNum(c.volume_change_percent_1h),
    "4h": toNum(c.volume_change_percent_4h),
  };

  const oiUsd = toNum(c.open_interest_usd, 0) ?? 0;
  const ratio = toNum(c.open_interest_volume_ratio, 0) ?? 0;
  // The API omits 24h volume; OI/volume ratio lets us approximate it so the
  // optional minVolUsd24h filter still has something to work with.
  const volUsd24h = ratio > 0 && oiUsd > 0 ? Math.round(oiUsd / ratio) : 0;

  return {
    symbol: String(c.symbol || "").toUpperCase().trim(),
    name: c.symbol || "",
    price: toNum(c.current_price),
    oi,
    vol,
    oiUsd,
    volUsd24h,
    oiChange24h: toNum(c.open_interest_change_percent_24h),
    volChange24h: toNum(c.volume_change_percent_24h),
    priceChange5m: toNum(c.price_change_percent_5m),
    priceChange1h: toNum(c.price_change_percent_1h),
    priceChange24h: toNum(c.price_change_percent_24h),
    priceChange: {
      "5m": toNum(c.price_change_percent_5m),
      "1h": toNum(c.price_change_percent_1h),
    },
    funding: toNum(c.avg_funding_rate_by_oi),
    logo: null,
  };
}

const API_BASE = "https://open-api-v4.coinglass.com";
const API_EXCHANGES = "Binance,OKX,Bybit,Gate,KuCoin,MEXC,Bitget";
const API_PAGE_SIZE = 100;

async function apiFetch(apiKey, page, timeoutMs = 25000) {
  const url = new URL(`${API_BASE}/api/futures/coins-markets`);
  url.searchParams.set("exchange_list", API_EXCHANGES);
  url.searchParams.set("per_page", String(API_PAGE_SIZE));
  url.searchParams.set("page", String(page));

  const res = await fetch(url.toString(), {
    headers: {
      accept: "application/json",
      "CG-API-KEY": apiKey,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " (check API key / plan)" : "";
    throw new Error(`CoinGlass API HTTP ${res.status}${hint}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("CoinGlass API returned non-JSON data");
  }
  if (String(body?.code ?? "0") !== "0") {
    throw new Error(`CoinGlass API error ${body?.code}: ${body?.msg || "unknown"}`);
  }
  return Array.isArray(body?.data) ? body.data : [];
}

/**
 * Fast lane: fetch only page 1 (the top 100 coins by open interest).
 *
 * A single request is the smallest unit CoinGlass allows, so this is the
 * lowest-latency update available - used to keep the hottest rows fresh while
 * the full 671-coin table refreshes on a slower cadence.
 */
export async function fetchTopMarkets() {
  const started = Date.now();
  const data = await cgFetch(marketUrl(1));
  const total = toNum(data?.total, 0) ?? 0;
  const coins = [];
  const seen = new Set();
  for (const raw of Array.isArray(data?.list) ? data.list : []) {
    if (raw?.stockSymbol) continue;
    if (/tokeni[sz]ed stock/i.test(String(raw?.name || ""))) continue;
    const coin = normaliseCoin(raw);
    if (!coin.symbol || !/^[A-Z0-9]{1,24}$/.test(coin.symbol)) continue;
    if (seen.has(coin.symbol)) continue;
    seen.add(coin.symbol);
    coins.push(coin);
  }
  return {
    coins,
    total,
    pages: 1,
    source: "scrape",
    fetchedAt: Date.now(),
    fetchedInMs: Date.now() - started,
  };
}

/**
 * Movers lane (FX-40): fetch top 50 rows sorted by 5m OI change + top 50 by OI.
 * Captures sudden OI spikes outside top-100 without scraping all 28+ pages.
 */
export async function fetchMoversMarkets() {
  const started = Date.now();
  const [moversUp, moversDown, topOi] = await Promise.allSettled([
    cgFetch(moversUrl("m5OiChangePercent", "desc", 50)),
    cgFetch(moversUrl("m5OiChangePercent", "asc", 50)),
    cgFetch(moversUrl("openInterest", "desc", 50)),
  ]);

  const coins = [];
  const seen = new Set();
  let total = 0;

  for (const res of [moversUp, moversDown, topOi]) {
    if (res.status !== "fulfilled" || !res.value) continue;
    total = Math.max(total, toNum(res.value?.total, 0) ?? 0);
    for (const raw of Array.isArray(res.value?.list) ? res.value.list : []) {
      if (raw?.stockSymbol) continue;
      if (/tokeni[sz]ed stock/i.test(String(raw?.name || ""))) continue;
      const coin = normaliseCoin(raw);
      if (!coin.symbol || !/^[A-Z0-9]{1,24}$/.test(coin.symbol)) continue;
      if (seen.has(coin.symbol)) continue;
      seen.add(coin.symbol);
      coins.push(coin);
    }
  }

  return {
    coins,
    total: Math.max(total, coins.length),
    pages: 1,
    source: "scrape-movers",
    fetchedAt: Date.now(),
    fetchedInMs: Date.now() - started,
  };
}

/**
 * Fetch the same market table through CoinGlass's official API.
 *
 * Used when the user has stored an API key; otherwise the website scraper is
 * the default source. Returns the same shape as `fetchCoinMarkets()`.
 */
export async function fetchCoinMarketsViaApi(apiKey) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("CoinGlass API key is empty");

  const started = Date.now();
  const seen = new Set();
  const coins = [];
  const maxPages = 40;
  let page = 1;

  while (page <= maxPages) {
    const batch = await apiFetch(key, page);
    if (!batch.length) break;
    let added = 0;
    for (const raw of batch) {
      if (raw?.stockSymbol) continue;
      if (/tokeni[sz]ed stock/i.test(String(raw?.name || ""))) continue;
      const coin = normaliseApiCoin(raw);
      if (!coin.symbol || !/^[A-Z0-9]{1,24}$/.test(coin.symbol)) continue;
      if (seen.has(coin.symbol)) continue;
      seen.add(coin.symbol);
      coins.push(coin);
      added++;
    }
    // Stop on a short/last page, and also if a page repeated itself (some
    // plans ignore `page`), so the loop can never spin forever.
    if (added === 0 || batch.length < API_PAGE_SIZE) break;
    page++;
  }

  return {
    coins,
    total: coins.length,
    pages: page,
    source: "api",
    fetchedAt: Date.now(),
    fetchedInMs: Date.now() - started,
  };
}

/**
 * Fetch the homepage market table, restricted to crypto assets.
 *
 * CoinGlass tags its rows: `tags=crypto` excludes TradFi stocks, indices and
 * commodities. A couple of tokenised equities are still tagged as crypto, so
 * rows carrying a `stockSymbol` are dropped as well.
 *
 * The server caps `pageSize` at 100, so the full table needs one request per
 * page. All pages are fetched in parallel (with a small concurrency cap) and
 * `onPartial` is called as soon as page 1 arrives, which lets the dashboard
 * paint the top-100 by open interest after a single round trip.
 *
 * @param {{onPartial?: (coins:Array, total:number) => void}} [options]
 * @returns {Promise<{coins:Array, total:number, fetchedAt:number, pages:number}>}
 */
export async function fetchCoinMarkets({ onPartial } = {}) {
  const started = Date.now();

  const first = await cgFetch(marketUrl(1));
  const total = toNum(first?.total, 0) ?? 0;
  const list = Array.isArray(first?.list) ? [...first.list] : [];
  const pageCount = Math.min(40, Math.max(1, Math.ceil(total / PAGE_SIZE)));

  const seen = new Set();
  const coins = [];
  const collect = (rows) => {
    for (const raw of rows) {
      // Tokenised stocks (e.g. RGTI, QBTS) are sometimes filed under crypto.
      if (raw?.stockSymbol) continue;
      if (/tokeni[sz]ed stock/i.test(String(raw?.name || ""))) continue;
      const coin = normaliseCoin(raw);
      if (!coin.symbol || !/^[A-Z0-9]{1,24}$/.test(coin.symbol)) continue;
      if (seen.has(coin.symbol)) continue;
      seen.add(coin.symbol);
      coins.push(coin);
    }
  };

  // Publish the first page immediately: the top-100 by OI is what the screener
  // usually acts on, so the dashboard does not wait for the remaining pages.
  collect(list);
  if (typeof onPartial === "function" && coins.length) {
    try {
      onPartial([...coins], total);
    } catch {
      /* a display hook must never break the fetch */
    }
  }

  if (pageCount > 1) {
    const pages = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, i) => i + 2).map((page) => cgFetch(marketUrl(page)))
    );
    for (const p of pages) {
      if (Array.isArray(p?.list)) collect(p.list);
    }
  }

  return {
    coins,
    total: Math.max(total, coins.length),
    pages: pageCount,
    source: "scrape",
    fetchedAt: Date.now(),
    fetchedInMs: Date.now() - started,
  };
}
