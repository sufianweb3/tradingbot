/**
 * CoinGlass Worker Scraper & Security
 *
 * Runs inside the Web Worker runtime. Implements browser AES-128-ECB
 * decryption via WebCrypto AES-CBC unpadded block decryption and native DecompressionStream.
 * Enforces the 20s stale gate (D4) and scrape failure stop-new-entries safety gate (D5).
 */

import { fetchCoinMarketsViaApi } from "../src/coinglass.js";

const CAP = "https://capi.coinglass.com";
const PROXY_PATH = "/api/coinglass/markets";
const PAGE_SIZE = 100;
const ASSET_TAG = "crypto";
const ZERO_IV = new Uint8Array(16);
const STALE_THRESHOLD_MS = 20000; // 20s stale gate per PRD D4

const LEGACY_KEYS = {
  55: "170b070da9654622",
  66: "d6537d845a964081",
  77: "863f08689c97435b",
};

const OI_FIELDS = {
  "5m": "m5OiChangePercent",
  "15m": "m15OiChangePercent",
  "30m": "m30OiChangePercent",
  "1h": "h1OiChangePercent",
  "4h": "h4OiChangePercent",
};
const VOL_FIELDS = {
  "1h": "h1VolChangePercent",
  "4h": "h4VolChangePercent",
};

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export function unpad(bytes) {
  if (!bytes.length) return bytes;
  const pad = bytes[bytes.length - 1];
  if (pad < 1 || pad > 16 || pad > bytes.length) return bytes;
  for (let i = bytes.length - pad; i < bytes.length; i++) {
    if (bytes[i] !== pad) return bytes;
  }
  return bytes.subarray(0, bytes.length - pad);
}

export async function importAesKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function aesEcbDecrypt(cipher, key) {
  if (!cipher.length || cipher.length % 16 !== 0) {
    throw new Error("CoinGlass returned an invalid encrypted payload");
  }

  const lastPrev = cipher.subarray(cipher.length - 16);
  const padBlock = new Uint8Array(16).fill(16);
  const needD = new Uint8Array(16);
  for (let i = 0; i < 16; i++) needD[i] = padBlock[i] ^ lastPrev[i];

  const enc = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-CBC", iv: ZERO_IV }, key, needD)
  );
  const extra = enc.subarray(0, 16);

  const padded = concatBytes(cipher, extra);
  const cbcPlain = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-CBC", iv: ZERO_IV }, key, padded)
  );

  const plain = new Uint8Array(cbcPlain.length);
  for (let off = 0; off < cbcPlain.length; off += 16) {
    const prev = off === 0 ? ZERO_IV : cipher.subarray(off - 16, off);
    for (let i = 0; i < 16; i++) plain[off + i] = cbcPlain[off + i] ^ prev[i];
  }
  return unpad(plain);
}

export async function gunzip(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress CoinGlass data");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export async function key0For(v, pathname, cacheTs, timeHeader) {
  let constant;
  if (v === "1") constant = pathname;
  else if (v === "0") constant = cacheTs;
  else if (v === "2") constant = timeHeader;
  else constant = LEGACY_KEYS[v];
  if (!constant) throw new Error(`Unsupported CoinGlass encryption version v=${v}`);
  const encoded = utf8ToB64(constant).slice(0, 16);
  const bytes = new Uint8Array(encoded.length);
  for (let i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i);
  return bytes;
}

export async function decryptBody(encryptedB64, userB64, v, ctx) {
  const key0 = await key0For(v, ctx.pathname, ctx.cacheTs, ctx.timeHeader);
  const key0Handle = await importAesKey(key0);

  const userPlain = await aesEcbDecrypt(b64ToBytes(userB64), key0Handle);
  const actualKey = new TextDecoder().decode(await gunzip(userPlain));
  const dataKey = new Uint8Array(actualKey.length);
  for (let i = 0; i < actualKey.length; i++) dataKey[i] = actualKey.charCodeAt(i);
  const dataHandle = await importAesKey(dataKey);

  const bodyPlain = await aesEcbDecrypt(b64ToBytes(encryptedB64), dataHandle);
  const json = await gunzip(bodyPlain);
  return JSON.parse(new TextDecoder().decode(json));
}

function num(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function normaliseCoin(c) {
  const oi = {};
  for (const [tf, field] of Object.entries(OI_FIELDS)) oi[tf] = num(c[field]);
  const vol = {};
  for (const [tf, field] of Object.entries(VOL_FIELDS)) vol[tf] = num(c[field]);

  return {
    symbol: String(c.symbol || "").toUpperCase().trim(),
    name: c.name || c.symbol || "",
    price: num(c.price),
    oi,
    vol,
    oiUsd: num(c.openInterest) ?? 0,
    volUsd24h: num(c.volUsd) ?? 0,
    oiChange24h: num(c.h24OiChangePercent),
    volChange24h: num(c.h24VolChangePercent),
    priceChange5m: num(c.m5PriceChangePercent),
    priceChange1h: num(c.h1PriceChangePercent),
    priceChange24h: num(c.h24PriceChangePercent),
    priceChange: {
      "5m": num(c.m5PriceChangePercent),
      "1h": num(c.h1PriceChangePercent),
    },
    funding: num(c.avgFundingRateBySymbol),
    logo: c.symbolLogo || null,
  };
}

async function fetchDirectPage(page) {
  const cacheTs = String(Date.now());
  const url =
    `${CAP}/api/home/v2/coinMarkets?sort=openInterest&order=desc&keyword=` +
    `&pageNum=${page}&pageSize=${PAGE_SIZE}&ex=all&tags=${ASSET_TAG}`;

  const res = await fetch(url, {
    cache: "no-store",
    credentials: "omit",
    headers: {
      accept: "application/json, text/plain, */*",
      encryption: "true",
      language: "en",
      "cache-ts-v2": cacheTs,
    },
  });
  if (!res.ok) throw new Error(`CoinGlass HTTP ${res.status}`);

  const outer = await res.json();
  if (outer && outer.success === false) {
    throw new Error(outer.msg || `CoinGlass error ${outer.code}`);
  }

  const user = res.headers.get("user");
  const v = res.headers.get("v");
  if (user && v && typeof outer?.data === "string") {
    return decryptBody(outer.data, user, v, {
      pathname: new URL(url).pathname,
      cacheTs,
      timeHeader: res.headers.get("time") || "",
    });
  }
  return outer?.data !== undefined ? outer.data : outer;
}

/**
 * Same-origin fallback for browsers that block capi.coinglass.com
 * (ad blockers, strict tracking protection, regional DNS blocks).
 * The local Node server and the Vercel function at api/coinglass/markets.js
 * decrypt the page server-side and return the same shape as fetchDirectPage().
 */
async function fetchProxyPage(page) {
  const res = await fetch(`${PROXY_PATH}?page=${page}`, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`CoinGlass proxy HTTP ${res.status}`);
  const outer = await res.json();
  if (outer && outer.ok === false) {
    throw new Error(outer.error || "CoinGlass proxy error");
  }
  return outer?.data !== undefined ? outer.data : outer;
}

async function fetchPage(page) {
  try {
    return await fetchDirectPage(page);
  } catch (directError) {
    try {
      return await fetchProxyPage(page);
    } catch (proxyError) {
      throw new Error(
        `CoinGlass direct: ${directError?.message || directError}; proxy: ${
          proxyError?.message || proxyError
        }`
      );
    }
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export class CoinGlassWorkerClient {
  constructor() {
    this.status = {
      state: "idle",
      connected: false,
      stale: false,
      stopNewEntries: false,
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      lastError: null,
      apiError: null,
      lastLatencyMs: 0,
      consecutiveFailures: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      coins: 0,
      pages: 0,
      source: "scrape",
      apiKeySet: false,
    };
    this.cache = { at: 0, coins: [], total: 0, error: null, fetchedInMs: 0, pages: 0 };
    this._apiKey = null;
  }

  setApiKey(key) {
    this._apiKey = key ? String(key).trim() : null;
    this.status.apiKeySet = Boolean(this._apiKey);
    this.status.apiError = null;
    this.status.source = this._apiKey ? "api" : "scrape";
  }

  isStale() {
    if (!this.status.lastSuccessAt) return true;
    return (Date.now() - this.status.lastSuccessAt) > STALE_THRESHOLD_MS;
  }

  async fetchMarkets() {
    const started = Date.now();
    this.status.lastAttemptAt = started;

    try {
      let result;
      let source = this._apiKey ? "api" : "scrape";
      if (this._apiKey) {
        try {
          result = await this._fetchViaOfficialApi();
        } catch (apiError) {
          // A revoked/expired key (or a plan without Futures access) must not
          // freeze the feed forever: fall back to the public table instead.
          this.status.apiError = String(apiError?.message || apiError);
          source = "scrape";
          result = await this._fetchScrape();
        }
      } else {
        result = await this._fetchScrape();
      }

      this.cache = {
        at: Date.now(),
        coins: result.coins,
        total: result.total,
        pages: result.pages,
        fetchedInMs: Date.now() - started,
        error: null,
      };

      if (source === "api") this.status.apiError = null;
      this.status.source = source;
      this.status.state = "connected";
      this.status.connected = true;
      this.status.stale = false;
      this.status.stopNewEntries = false;
      this.status.lastSuccessAt = Date.now();
      this.status.lastLatencyMs = Date.now() - started;
      this.status.consecutiveFailures = 0;
      this.status.totalSuccesses++;
      this.status.coins = result.coins.length;
      this.status.pages = result.pages;

      return result;
    } catch (err) {
      this.status.consecutiveFailures++;
      this.status.totalFailures++;
      this.status.lastError = err.message || "scrape-failed";
      this.status.stale = true;

      // PRD D5: 2 consecutive failures -> stop new entries
      if (this.status.consecutiveFailures >= 2) {
        this.status.connected = false;
        this.status.state = "disconnected";
        this.status.stopNewEntries = true;
      }

      throw err;
    }
  }

  async _fetchScrape() {
    const first = await fetchPage(1);
    const total = num(first?.total) ?? 0;
    const list = Array.isArray(first?.list) ? [...first.list] : [];
    const pageCount = Math.min(40, Math.max(1, Math.ceil(total / PAGE_SIZE)));

    if (pageCount > 1) {
      const pages = await mapLimit(
        Array.from({ length: pageCount - 1 }, (_, i) => i + 2),
        4,
        fetchPage
      );
      for (const p of pages) {
        if (Array.isArray(p?.list)) list.push(...p.list);
      }
    }

    const seen = new Set();
    const coins = [];
    for (const raw of list) {
      if (raw?.stockSymbol) continue;
      if (/tokeni[sz]ed stock/i.test(String(raw?.name || ""))) continue;
      const coin = normaliseCoin(raw);
      if (!coin.symbol || !/^[A-Z0-9]{1,24}$/.test(coin.symbol)) continue;
      if (seen.has(coin.symbol)) continue;
      seen.add(coin.symbol);
      coins.push(coin);
    }

    return { coins, total: Math.max(total, coins.length), pages: pageCount };
  }

  async _fetchViaOfficialApi() {
    // Use the same official-API client as the Node engine: /api/futures/coins-markets
    // with the CG-API-KEY header and snake_case field mapping. The previous
    // implementation called a non-existent /api/futures/openInterest/ohlc
    // endpoint with a `coinglassSecret` header, so every API-key user was
    // permanently stuck behind the stop-new-entries gate.
    const result = await fetchCoinMarketsViaApi(this._apiKey);
    return {
      coins: result.coins,
      total: result.total,
      pages: result.pages,
      fetchedInMs: result.fetchedInMs,
      source: "api",
    };
  }
}
