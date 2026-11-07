/**
 * Device-side CoinGlass scraper.
 *
 * This runs in the dashboard tab (your laptop) and uses the exact same
 * encrypted endpoint as `src/coinglass.js`:
 *
 *   https://capi.coinglass.com/api/home/v2/coinMarkets?...&tags=crypto
 *
 * CoinGlass allows cross-origin reads (`Access-Control-Allow-Origin: *`) and
 * exposes the `user` / `v` / `time` headers, so the browser can decrypt the
 * payload and forward the normalised coin table to the cloud engine.
 *
 * Decryption is the same two-layer scheme:
 *   key0        = base64(pathname)[:16]                (when v = 1)
 *   actualKey   = gunzip(AES-128-ECB(user, key0))
 *   JSON        = gunzip(AES-128-ECB(data, actualKey))
 *
 * WebCrypto has no ECB mode, so AES-CBC with a zero IV is used one block at a
 * time. The final padding block is crafted so WebCrypto always accepts it, then
 * the CBC chaining is removed to recover the ECB plaintext.
 */

const CAP = "https://capi.coinglass.com";
const PAGE_SIZE = 100;
const ASSET_TAG = "crypto";
const ZERO_IV = new Uint8Array(16);

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

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function unpad(bytes) {
  if (!bytes.length) return bytes;
  const pad = bytes[bytes.length - 1];
  if (pad < 1 || pad > 16 || pad > bytes.length) return bytes;
  for (let i = bytes.length - pad; i < bytes.length; i++) {
    if (bytes[i] !== pad) return bytes;
  }
  return bytes.subarray(0, bytes.length - pad);
}

async function importAesKey(raw) {
  return crypto.subtle.importKey("raw", raw, { name: "AES-CBC" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function aesEcbDecrypt(cipher, key) {
  if (!cipher.length || cipher.length % 16 !== 0) {
    throw new Error("CoinGlass returned an invalid encrypted payload");
  }

  // CBC-decrypt a ciphertext whose final crafted block is a full 16-byte pad,
  // so WebCrypto never rejects the padding. Then undo the CBC chaining.
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

async function gunzip(bytes) {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("This browser cannot decompress CoinGlass data");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(String(str));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function key0For(v, pathname, cacheTs, timeHeader) {
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

async function decryptBody(encryptedB64, userB64, v, ctx) {
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
    funding: num(c.avgFundingRateBySymbol),
    logo: c.symbolLogo || null,
  };
}

async function fetchPage(page) {
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

/**
 * Scrape the CoinGlass market table from this browser.
 *
 * @returns {Promise<{coins:Array, total:number, pages:number, fetchedAt:number,
 *   fetchedInMs:number, source:"device"}>}
 */
export async function fetchCoinMarkets() {
  const started = Date.now();
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

  return {
    coins,
    total: Math.max(total, coins.length),
    pages: pageCount,
    source: "device",
    fetchedAt: Date.now(),
    fetchedInMs: Date.now() - started,
  };
}

/**
 * Fast lane: one request, top 100 coins by open interest (~400-500 ms).
 *
 * Used by the dashboard to refresh the hottest rows without waiting for the
 * full 7-page table.
 */
export async function fetchTopMarkets() {
  const started = Date.now();
  const page = await fetchPage(1);
  const coins = normaliseList(Array.isArray(page?.list) ? page.list : []);
  return {
    coins,
    total: num(page?.total) ?? coins.length,
    pages: 1,
    source: "device",
    fetchedAt: Date.now(),
    fetchedInMs: Date.now() - started,
  };
}

/**
 * Merge a fresh page-1 snapshot into an existing row set, keeping coins that
 * are outside the top 100. Returns a new array; unchanged rows keep identity.
 */
export function mergeTopRows(existing, fresh) {
  const bySymbol = new Map((existing || []).map((c) => [c.symbol, c]));
  for (const coin of fresh || []) bySymbol.set(coin.symbol, coin);
  return [...bySymbol.values()];
}

function normaliseList(rows) {
  const seen = new Set();
  const coins = [];
  for (const raw of rows) {
    if (raw?.stockSymbol) continue;
    if (/tokeni[sz]ed stock/i.test(String(raw?.name || ""))) continue;
    const coin = normaliseCoin(raw);
    if (!coin.symbol || !/^[A-Z0-9]{1,24}$/.test(coin.symbol)) continue;
    if (seen.has(coin.symbol)) continue;
    seen.add(coin.symbol);
    coins.push(coin);
  }
  return coins;
}

if (typeof window !== "undefined") {
  window.CgBrowser = { fetchCoinMarkets, fetchTopMarkets, mergeTopRows };
}
