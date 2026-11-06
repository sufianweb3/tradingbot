/**
 * Speed Program: Multi-Lane Adaptive Scraping, AES Key Cache, Diff Transfer,
 * Watchlist Pre-Warm, Incremental Diff Scan, Prebuilt Templates & Stage Latency Telemetry
 *
 * Implements Section 7 (FX-40..FX-53) and Section 10.5.
 */

import { evaluateCoin } from "../trading.js";
import { round, toNum } from "../util.js";

export const DEFAULT_SPEED_SETTINGS = {
  moversLane: true,
  moversIntervalMs: 1500,
  hotIntervalMs: 700,
  top100IntervalMs: 3000,
  fullScanIntervalMs: 12000,
  eventDrivenScan: true,
  prewarmBooks: true,
  maxBookSubscriptions: 40,
  privateWs: true,
};

/**
 * AES Key Cache keyed by CoinGlass `user` header (FX-43).
 * Avoids re-decrypting Layer 1 when the response `user` header matches a cached entry.
 */
export class CoinGlassKeyCache {
  constructor(maxEntries = 128) {
    this.maxEntries = maxEntries;
    this.cache = new Map(); // `${v}:${userB64}` -> actualKeyString
    this.hits = 0;
    this.misses = 0;
  }

  get(v, userB64) {
    const key = `${v}:${userB64}`;
    if (this.cache.has(key)) {
      this.hits++;
      const val = this.cache.get(key);
      // LRU refresh
      this.cache.delete(key);
      this.cache.set(key, val);
      return val;
    }
    this.misses++;
    return null;
  }

  set(v, userB64, actualKey) {
    const key = `${v}:${userB64}`;
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, actualKey);
    if (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}

/**
 * Single In-Flight Request Guard per Lane with AbortController (FX-42).
 * Prevents overlapping HTTP requests on the same lane from piling up.
 */
export class LaneInFlightGuard {
  constructor() {
    this.lanes = new Map(); // laneName -> { promise, controller, startedAt }
  }

  async run(laneName, taskFn, { abortPrevious = false, timeoutMs = 15000 } = {}) {
    const existing = this.lanes.get(laneName);
    if (existing) {
      if (!abortPrevious) {
        return existing.promise;
      }
      try {
        existing.controller.abort();
      } catch {
        /* ignore */
      }
    }

    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

    const promise = Promise.resolve()
      .then(() => taskFn(controller.signal))
      .finally(() => {
        if (timer) clearTimeout(timer);
        const cur = this.lanes.get(laneName);
        if (cur && cur.promise === promise) {
          this.lanes.delete(laneName);
        }
      });

    this.lanes.set(laneName, { promise, controller, startedAt: Date.now() });
    return promise;
  }

  isBusy(laneName) {
    return this.lanes.has(laneName);
  }
}

/**
 * Diff-Based Row Transfer between Data Worker and Engine Worker (FX-43).
 */
export function computeMarketDiff(prevMap, nextCoins = []) {
  const updated = [];
  const nextSymbols = new Set();

  for (const coin of Array.isArray(nextCoins) ? nextCoins : []) {
    const sym = String(coin?.symbol || "").toUpperCase();
    if (!sym) continue;
    nextSymbols.add(sym);
    const prev = prevMap instanceof Map ? prevMap.get(sym) : prevMap?.[sym];
    if (
      !prev ||
      prev.price !== coin.price ||
      prev.oiUsd !== coin.oiUsd ||
      prev.volUsd24h !== coin.volUsd24h ||
      prev.oi?.["5m"] !== coin.oi?.["5m"] ||
      prev.oi?.["15m"] !== coin.oi?.["15m"] ||
      prev.oi?.["1h"] !== coin.oi?.["1h"] ||
      prev.vol?.["1h"] !== coin.vol?.["1h"] ||
      prev.priceChange5m !== coin.priceChange5m
    ) {
      updated.push(coin);
    }
  }

  const removed = [];
  if (prevMap instanceof Map) {
    for (const sym of prevMap.keys()) {
      if (!nextSymbols.has(sym)) removed.push(sym);
    }
  }

  return {
    updated,
    removed,
    totalCount: nextSymbols.size,
    changedCount: updated.length,
    ts: Date.now(),
  };
}

export function applyMarketDiff(targetMap, diff = {}) {
  const map = targetMap instanceof Map ? targetMap : new Map();
  for (const sym of diff.removed || []) {
    map.delete(String(sym).toUpperCase());
  }
  for (const coin of diff.updated || []) {
    if (coin?.symbol) {
      map.set(String(coin.symbol).toUpperCase(), coin);
    }
  }
  return map;
}

/**
 * Watchlist & Pre-Warm Identification (FX-44).
 * Returns coins that pass >= (totalChecks - 1) filters OR are within 80% of all enabled thresholds,
 * plus any coins in the Hot Set (abs(oi5m) >= 1.5% or abs(price5m) >= 1.0%).
 */
export function computeWatchlist(coins = [], settings = {}, { hotSet = new Map(), nowMs = Date.now(), maxWatchlist = 25 } = {}) {
  const watchlist = [];

  for (const coin of Array.isArray(coins) ? coins : []) {
    if (!coin || !coin.symbol) continue;
    const sym = String(coin.symbol).toUpperCase();

    // Update hotSet if 5m OI or 5m price moved sharply (FX-41)
    const oi5m = Math.abs(toNum(coin.oi?.["5m"], 0));
    const price5m = Math.abs(toNum(coin.priceChange5m ?? coin.priceChange?.["5m"], 0));
    if (oi5m >= 1.5 || price5m >= 1.0) {
      hotSet.set(sym, nowMs + 120000); // hot for 120s
    }

    const hotExpiry = hotSet.get(sym) || 0;
    const isHot = hotExpiry > nowMs;
    if (hotExpiry > 0 && !isHot) {
      hotSet.delete(sym);
    }

    const ev = evaluateCoin(coin, settings);
    const total = ev.total || 0;
    const passCount = ev.passCount || 0;

    let nearThreshold = false;
    if (total > 0 && Array.isArray(ev.checks)) {
      nearThreshold = ev.checks.every((c) => {
        if (c.pass) return true;
        if (c.value === null || c.threshold === null || c.threshold === 0) return false;
        const ratio = c.value / c.threshold;
        return ratio >= 0.8;
      });
    }

    const isCandidate =
      ev.qualified ||
      (total > 1 && passCount >= total - 1) ||
      nearThreshold;

    if (isCandidate || isHot) {
      watchlist.push({
        symbol: sym,
        side: ev.side || "long",
        qualified: Boolean(ev.qualified),
        passCount,
        total,
        nearThreshold,
        isHot,
        oiUsd: toNum(coin.oiUsd, 0),
        priorityScore: (ev.qualified ? 100 : isCandidate ? 50 : 20) + oi5m * 2,
      });
    }
  }

  watchlist.sort((a, b) => b.priorityScore - a.priorityScore || b.oiUsd - a.oiUsd);
  return watchlist.slice(0, maxWatchlist);
}

/**
 * Pre-Built Order Payload Template & HMAC Key Cache (FX-47).
 */
export class OrderPrewarmer {
  constructor() {
    this.templates = new Map(); // `${venue}:${symbol}` -> template object
    this.cryptoKeys = new Map(); // `${venue}` -> cached CryptoKey or secret buffer
  }

  setTemplate(venue, symbol, { instrument, leverage = 20, side = "long" } = {}) {
    const key = `${String(venue).toLowerCase()}:${String(symbol).toUpperCase()}`;
    this.templates.set(key, {
      venue: String(venue).toLowerCase(),
      symbol: String(symbol).toUpperCase(),
      instrument,
      leverage,
      side,
      prewarmedAt: Date.now(),
    });
  }

  getTemplate(venue, symbol) {
    return this.templates.get(`${String(venue).toLowerCase()}:${String(symbol).toUpperCase()}`) || null;
  }
}

/**
 * Stage Latency Telemetry & Histograms (Section 7.6 FX-52).
 * Records timestamps t_scrape .. t_protect and computes p50 / p95 histograms across rolling 100 samples.
 */
export class StageLatencyTracker {
  constructor(maxSamples = 100) {
    this.maxSamples = maxSamples;
    this.stages = {
      scrapeMs: [],
      decryptMs: [],
      evalMs: [],
      eqeMs: [],
      routeMs: [],
      signMs: [],
      orderAckRttMs: [],
      fillMs: [],
      slProtectMs: [],
      signalToOrderMs: [],
    };
    this.lastTrace = null;
  }

  recordStage(stageKey, ms) {
    const val = toNum(ms, null);
    if (val === null || val < 0 || !this.stages[stageKey]) return;
    const arr = this.stages[stageKey];
    arr.push(round(val, 2));
    if (arr.length > this.maxSamples) {
      arr.splice(0, arr.length - this.maxSamples);
    }
  }

  /**
   * Record a complete or partial pipeline trace with t_scrape..t_protect timestamps.
   */
  recordTrace(trace = {}) {
    const t = trace;
    if (t.t_scrape && t.t_decrypt) this.recordStage("decryptMs", t.t_decrypt - t.t_scrape);
    if (t.t_decrypt && t.t_eval) this.recordStage("evalMs", t.t_eval - t.t_decrypt);
    if (t.t_eval && t.t_eqe) this.recordStage("eqeMs", t.t_eqe - t.t_eval);
    if (t.t_eqe && t.t_route) this.recordStage("routeMs", t.t_route - t.t_eqe);
    if (t.t_route && t.t_sign) this.recordStage("signMs", t.t_sign - t.t_route);
    if (t.t_sign && t.t_ack) this.recordStage("orderAckRttMs", t.t_ack - t.t_sign);
    if (t.t_ack && t.t_fill) this.recordStage("fillMs", t.t_fill - t.t_ack);
    if (t.t_fill && t.t_protect) this.recordStage("slProtectMs", t.t_protect - t.t_fill);
    if (t.t_scrape && t.t_ack) {
      this.recordStage("signalToOrderMs", t.t_ack - t.t_scrape);
    } else if (t.signalToOrderMs !== undefined) {
      this.recordStage("signalToOrderMs", t.signalToOrderMs);
    }
    this.lastTrace = { ...trace, recordedAt: Date.now() };
  }

  _statsFor(arr) {
    if (!arr || arr.length === 0) return { p50: 0, p95: 0, last: 0, count: 0 };
    const sorted = [...arr].sort((a, b) => a - b);
    const p50 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))];
    const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
    return {
      p50: round(p50, 1),
      p95: round(p95, 1),
      last: round(arr[arr.length - 1], 1),
      count: arr.length,
    };
  }

  summary() {
    const out = {};
    for (const [k, arr] of Object.entries(this.stages)) {
      out[k] = this._statsFor(arr);
    }
    return {
      stages: out,
      lastTrace: this.lastTrace,
      updatedAt: Date.now(),
    };
  }
}
