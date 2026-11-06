/**
 * Multi-exchange public price hub.
 * No API keys: every venue below exposes free public tickers.
 *
 * Discovery downloads all 24h tickers once (cached), picks the deepest venue
 * for each coin, and per-position quotes are fetched symbol-by-symbol.
 */

import { iso, now, sleep, toNum } from "./util.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

async function httpJson(url, { timeoutMs = 15000, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "user-agent": UA, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(250 + Math.random() * 350);
    }
  }
  throw lastError;
}

export const VENUES = {
  mexc: {
    name: "MEXC",
    async fetchAll() {
      const j = await httpJson("https://contract.mexc.com/api/v1/contract/ticker");
      return (j.data || [])
        .filter((x) => typeof x.symbol === "string" && x.symbol.endsWith("_USDT"))
        .map((x) => ({
          base: x.symbol.slice(0, -5),
          symbol: x.symbol,
          price: toNum(x.lastPrice, 0),
          volUsd: toNum(x.amount24, 0) ?? 0,
        }));
    },
    async fetchOne(symbol) {
      const j = await httpJson(
        `https://contract.mexc.com/api/v1/contract/ticker?symbol=${encodeURIComponent(symbol)}`,
        { timeoutMs: 8000 }
      );
      return toNum(j?.data?.lastPrice);
    },
  },

  gate: {
    name: "Gate.io",
    async fetchAll() {
      const j = await httpJson("https://api.gateio.ws/api/v4/futures/usdt/tickers");
      return (Array.isArray(j) ? j : [])
        .filter((x) => typeof x.contract === "string" && x.contract.endsWith("_USDT"))
        .map((x) => ({
          base: x.contract.slice(0, -5),
          symbol: x.contract,
          price: toNum(x.last, 0),
          volUsd: toNum(x.volume_24h_quote, 0) ?? 0,
        }));
    },
    async fetchOne(symbol) {
      const j = await httpJson(
        `https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${encodeURIComponent(symbol)}`,
        { timeoutMs: 8000 }
      );
      return toNum(Array.isArray(j) ? j[0]?.last : null);
    },
  },

  kucoin: {
    name: "KuCoin",
    async fetchAll() {
      const [contracts, tickers] = await Promise.all([
        httpJson("https://api-futures.kucoin.com/api/v1/contracts/active"),
        httpJson("https://api-futures.kucoin.com/api/v1/allTickers"),
      ]);
      const prices = new Map((tickers?.data || []).map((x) => [x.symbol, toNum(x.price)]));
      return (contracts?.data || [])
        .filter((x) => x.quoteCurrency === "USDT" && x.status === "Open")
        .map((x) => ({
          base: x.baseCurrency,
          symbol: x.symbol,
          price: prices.get(x.symbol) ?? toNum(x.markPrice, 0),
          volUsd: toNum(x.turnoverOf24h, 0) ?? 0,
        }));
    },
    async fetchOne(symbol) {
      const j = await httpJson(
        `https://api-futures.kucoin.com/api/v1/ticker?symbol=${encodeURIComponent(symbol)}`,
        { timeoutMs: 8000 }
      );
      return toNum(j?.data?.price);
    },
  },

  binance: {
    name: "Binance",
    async fetchAll() {
      const j = await httpJson("https://fapi.binance.com/fapi/v1/ticker/24hr");
      return (Array.isArray(j) ? j : [])
        .filter(
          (x) =>
            typeof x.symbol === "string" &&
            x.symbol.endsWith("USDT") &&
            !x.symbol.includes("_") &&
            x.symbol.length > 4
        )
        .map((x) => ({
          base: x.symbol.slice(0, -4),
          symbol: x.symbol,
          price: toNum(x.lastPrice, 0),
          volUsd: toNum(x.quoteVolume, 0) ?? 0,
        }));
    },
    async fetchOne(symbol) {
      const j = await httpJson(
        `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${encodeURIComponent(symbol)}`,
        { timeoutMs: 8000 }
      );
      return toNum(j?.price);
    },
  },

  bybit: {
    name: "Bybit",
    async fetchAll() {
      const j = await httpJson("https://api.bybit.com/v5/market/tickers?category=linear");
      return (j?.result?.list || [])
        .filter((x) => typeof x.symbol === "string" && x.symbol.endsWith("USDT"))
        .map((x) => ({
          base: x.symbol.slice(0, -4),
          symbol: x.symbol,
          price: toNum(x.lastPrice, 0),
          volUsd: toNum(x.turnover24h, 0) ?? 0,
        }));
    },
    async fetchOne(symbol) {
      const j = await httpJson(
        `https://api.bybit.com/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`,
        { timeoutMs: 8000 }
      );
      return toNum(j?.result?.list?.[0]?.lastPrice);
    },
  },

  bitget: {
    name: "Bitget",
    async fetchAll() {
      const j = await httpJson(
        "https://api.bitget.com/api/v2/mix/market/tickers?productType=USDT-FUTURES"
      );
      return (j?.data || [])
        .filter((x) => typeof x.symbol === "string" && x.symbol.endsWith("USDT"))
        .map((x) => ({
          base: x.symbol.slice(0, -4),
          symbol: x.symbol,
          price: toNum(x.lastPr, 0),
          volUsd: toNum(x.usdtVolume, 0) ?? toNum(x.quoteVolume, 0) ?? 0,
        }));
    },
    async fetchOne(symbol) {
      const j = await httpJson(
        `https://api.bitget.com/api/v2/mix/market/ticker?symbol=${encodeURIComponent(
          symbol
        )}&productType=USDT-FUTURES`,
        { timeoutMs: 8000 }
      );
      const row = Array.isArray(j?.data) ? j.data[0] : j?.data;
      return toNum(row?.lastPr);
    },
  },

  okx: {
    name: "OKX",
    async fetchAll() {
      const j = await httpJson("https://www.okx.com/api/v5/market/tickers?instType=SWAP");
      return (j?.data || [])
        .filter((x) => typeof x.instId === "string" && x.instId.endsWith("-USDT-SWAP"))
        .map((x) => {
          const base = x.instId.split("-")[0];
          const last = toNum(x.last, 0) ?? 0;
          const baseVol = toNum(x.volCcy24h, 0) ?? 0;
          return {
            base,
            symbol: x.instId,
            price: last,
            volUsd: baseVol * last,
          };
        });
    },
    async fetchOne(symbol) {
      const j = await httpJson(
        `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(symbol)}`,
        { timeoutMs: 8000 }
      );
      return toNum(j?.data?.[0]?.last);
    },
  },
};

export const DEFAULT_VENUES = ["mexc", "gate", "kucoin", "binance", "bybit", "bitget", "okx"];

function normalizeBase(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 24);
}

function aliasKeys(base) {
  const out = [base];
  if (base === "XBT") out.push("BTC");
  if (base === "BTC") out.push("XBT");
  return out;
}

function baseFromVenueSymbol(symbol, venue) {
  const s = String(symbol || "").toUpperCase();
  if (venue === "okx") return normalizeBase(s.split("-")[0]);
  if (venue === "mexc" || venue === "gate") return normalizeBase(s.split("_")[0]);
  if (venue === "kucoin") {
    const b = normalizeBase(s.replace(/USDTM$/, ""));
    return b === "XBT" ? "BTC" : b;
  }
  return normalizeBase(s.replace(/USDT$/, ""));
}

export class ExchangeHub {
  constructor({ venueKeys = DEFAULT_VENUES, discoverTtlMs = 10 * 60 * 1000 } = {}) {
    this.venueKeys = [...new Set(venueKeys.filter((k) => VENUES[k]))];
    this.discoverTtlMs = discoverTtlMs;
    this.maps = new Map(); // venueKey -> Map(base -> entry)
    this.best = new Map(); // alias -> entry (deepest venue)
    this.status = new Map();
    this.quotes = new Map();
    this.lastDiscover = 0;
    this._discovering = null;
    this.quoteErrors = 0;
    this.quotesServed = 0;
    this.lastError = null;
  }

  async discover(force = false) {
    if (this._discovering) return this._discovering;
    if (!force && this.lastDiscover && now() - this.lastDiscover < this.discoverTtlMs) {
      return this.maps;
    }
    this._discovering = this._doDiscover().finally(() => {
      this._discovering = null;
    });
    return this._discovering;
  }

  async _doDiscover() {
    const started = now();
    const results = await Promise.allSettled(
      this.venueKeys.map(async (key) => ({ key, rows: await VENUES[key].fetchAll() }))
    );

    const wasReady = this.maps.size > 0;
    for (let i = 0; i < results.length; i++) {
      const key = this.venueKeys[i];
      const res = results[i];
      const prev = this.status.get(key) || {};
      if (res.status === "fulfilled") {
        const map = new Map();
        for (const raw of res.value.rows || []) {
          const base = normalizeBase(raw.base);
          const price = toNum(raw.price, 0);
          if (!base || !raw.symbol || !(price > 0)) continue;
          const entry = {
            venue: key,
            venueName: VENUES[key].name,
            base,
            symbol: raw.symbol,
            venueSymbol: raw.symbol,
            price,
            volUsd: toNum(raw.volUsd, 0) ?? 0,
            discoveredAt: now(),
          };
          const existing = map.get(base);
          if (!existing || entry.volUsd > existing.volUsd) map.set(base, entry);
        }
        this.maps.set(key, map);
        this.status.set(key, {
          key,
          name: VENUES[key].name,
          ok: true,
          count: map.size,
          error: null,
          updatedAt: now(),
          ms: now() - started,
        });
      } else {
        const message = String(res.reason?.message || res.reason || "unavailable");
        this.status.set(key, {
          key,
          name: VENUES[key].name,
          ok: false,
          // keep last known count when a refresh fails
          count: this.maps.get(key)?.size ?? 0,
          error: message,
          updatedAt: prev.updatedAt || null,
          ms: now() - started,
        });
        this.lastError = `${VENUES[key].name}: ${message}`;
      }
    }

    const best = new Map();
    for (const map of this.maps.values()) {
      for (const entry of map.values()) {
        for (const key of aliasKeys(entry.base)) {
          const prev = best.get(key);
          if (!prev || entry.volUsd > prev.volUsd) best.set(key, entry);
        }
      }
    }
    this.best = best;
    this.lastDiscover = now();
    if (!wasReady) this.lastError = null;
    return this.maps;
  }

  resolve(symbol) {
    const base = normalizeBase(symbol);
    if (!base) return null;
    let entry = this.best.get(base);
    if (!entry) {
      if (base === "BTC") entry = this.best.get("XBT");
      else if (base === "XBT") entry = this.best.get("BTC");
    }
    return entry || null;
  }

  resolveExact(symbol) {
    const base = normalizeBase(symbol);
    return this.best.get(base) || null;
  }

  /**
   * Quote a venue instrument.
   * @param {{venue:string, venueSymbol?:string, symbol?:string, base?:string}} entry
   */
  async quote(entry, { maxAgeMs = 1500, allowFallback = true } = {}) {
    const venue = entry?.venue;
    const symbol = entry?.venueSymbol || entry?.symbol;
    if (!VENUES[venue] || !symbol) return null;
    const base = normalizeBase(entry.base || baseFromVenueSymbol(symbol, venue));
    const cacheKey = `${venue}:${symbol}`;
    const cached = this.quotes.get(cacheKey);
    const t = now();
    if (cached && t - cached.ts <= maxAgeMs) {
      this.quotesServed++;
      return cached;
    }

    try {
      const price = await VENUES[venue].fetchOne(symbol);
      if (!(price > 0)) throw new Error("invalid price");
      const q = {
        venue,
        venueName: VENUES[venue].name,
        venueSymbol: symbol,
        base,
        price,
        ts: now(),
        stale: false,
        fallback: false,
      };
      this.quotes.set(cacheKey, q);
      this._trimQuotes();
      this.quotesServed++;
      return q;
    } catch (err) {
      this.quoteErrors++;
      if (allowFallback) {
        const candidates = [];
        for (const [key, map] of this.maps) {
          if (key === venue) continue;
          const alt = map.get(base) || (base === "BTC" ? map.get("XBT") : null) || (base === "XBT" ? map.get("BTC") : null);
          if (alt) candidates.push(alt);
        }
        candidates.sort((a, b) => b.volUsd - a.volUsd);
        for (const alt of candidates.slice(0, 2)) {
          try {
            const price = await VENUES[alt.venue].fetchOne(alt.symbol);
            if (!(price > 0)) continue;
            const q = {
              venue: alt.venue,
              venueName: alt.venueName,
              venueSymbol: alt.symbol,
              base,
              price,
              ts: now(),
              stale: false,
              fallback: true,
            };
            this.quotes.set(`${alt.venue}:${alt.symbol}`, q);
            this._trimQuotes();
            this.quotesServed++;
            return q;
          } catch {
            /* try next */
          }
        }
      }
      if (cached && t - cached.ts < 120000) {
        this.quotesServed++;
        return { ...cached, stale: true };
      }
      return null;
    }
  }

  async quoteForSymbol(symbol, opts) {
    const entry = this.resolve(symbol);
    if (!entry) return null;
    return this.quote(entry, opts);
  }

  _trimQuotes() {
    if (this.quotes.size <= 4000) return;
    const entries = [...this.quotes.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (let i = 0; i < entries.length - 2000; i++) this.quotes.delete(entries[i][0]);
  }

  statusList() {
    return this.venueKeys.map((key) => {
      const s = this.status.get(key) || {
        key,
        name: VENUES[key].name,
        ok: false,
        count: 0,
        error: "not discovered yet",
        updatedAt: null,
      };
      return {
        ...s,
        ageMs: s.updatedAt ? now() - s.updatedAt : null,
        updatedText: s.updatedAt ? iso(s.updatedAt) : "--",
      };
    });
  }

  summary() {
    const list = this.statusList();
    return {
      venues: list,
      okVenues: list.filter((v) => v.ok).length,
      totalVenues: list.length,
      instruments: list.reduce((a, v) => a + (v.count || 0), 0),
      lastDiscover: this.lastDiscover || null,
      quoteErrors: this.quoteErrors,
      quotesServed: this.quotesServed,
    };
  }
}

export { baseFromVenueSymbol, normalizeBase };
