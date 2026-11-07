/**
 * Shared CoinGlass market feed.
 *
 * Every strategy reads the same screener snapshot: one CoinGlass request is
 * shared by all running strategies instead of N parallel scrapes. The feed also
 * accepts the browser device feed and owns the connection status, so the
 * dashboard sees one honest "CoinGlass connected" state for the whole portfolio.
 */

import { fetchCoinMarkets, fetchCoinMarketsViaApi } from "./coinglass.js";
import { OI_FIELD, VOL_FIELD } from "./trading.js";
import { iso, now, toNum } from "./util.js";

// Minimum gap between two CoinGlass scrapes. The dashboard polls once a second
// and this guard prevents two clients (or a scan tick) from doubling the load.
export const MARKET_CACHE_MS = 900;
// A browser tab can push its own scrape (device feed). Rows that arrive this
// recently are preferred over a server-side scrape. Background tabs throttle
// timers to about once a minute, so the window must cover a throttled push.
export const DEVICE_FEED_TTL_MS = 90000;
// After a failed scrape, back off instead of retrying on every poll.
const FAILURE_BACKOFF_MS = 20000;

function emptyCache() {
  return { at: 0, coins: [], total: 0, error: null, fetchedInMs: 0, pages: 0 };
}

function emptyStatus(source = "scrape") {
  return {
    state: "idle", // idle | connecting | connected | disconnected
    connected: false,
    refreshing: false,
    source,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastLatencyMs: null,
    coins: 0,
    pages: 0,
    consecutiveFailures: 0,
    totalSuccesses: 0,
    totalFailures: 0,
  };
}

export class MarketFeed {
  /**
   * @param {object} [options]
   * @param {object} [options.hub] ExchangeHub used for venue discovery
   * @param {() => string} [options.apiKey] official CoinGlass key provider
   * @param {(level: string, message: string) => void} [options.log] fallback logger
   */
  constructor({ hub = null, apiKey = () => "", log = () => {} } = {}) {
    this.hub = hub;
    this.apiKey = typeof apiKey === "function" ? apiKey : () => apiKey;
    this.log = typeof log === "function" ? log : () => {};
    this.cache = emptyCache();
    this.status = emptyStatus(this.key() ? "api" : "scrape");
    this._deviceFeedAt = 0;
    this._nextRetryAt = 0;
    this._marketPromise = null;
  }

  key() {
    return String(this.apiKey() || "").trim();
  }

  emptyCache() {
    return emptyCache();
  }

  /**
   * Accept a CoinGlass snapshot scraped by a dashboard tab (device feed).
   *
   * The browser uses the same encrypted endpoint as the Node scraper, so the
   * rows are already normalised. This makes the cloud deployment usable with
   * no API key while the tab is open: it is the lowest-latency path because it
   * skips the Worker -> scrape round trip.
   */
  ingestDeviceFeed(input = {}, { log = this.log } = {}) {
    const raw = Array.isArray(input.coins) ? input.coins : [];
    if (!raw.length) return { ok: false, error: "empty-feed" };
    if (raw.length > 5000) return { ok: false, error: "feed-too-large" };
    // `merge` is used by the fast lane: it ships only the top-100 rows, so the
    // rest of the table must be preserved instead of being replaced.
    const merge = Boolean(input.merge);

    const coins = [];
    const seen = new Set();
    for (const c of raw) {
      const symbol = String(c?.symbol || "").toUpperCase().trim();
      if (!/^[A-Z0-9]{1,24}$/.test(symbol) || seen.has(symbol)) continue;
      seen.add(symbol);
      const oi = {};
      for (const tf of Object.keys(OI_FIELD)) oi[tf] = toNum(c?.oi?.[tf]);
      const vol = {};
      for (const tf of Object.keys(VOL_FIELD)) vol[tf] = toNum(c?.vol?.[tf]);
      coins.push({
        symbol,
        name: String(c?.name || symbol),
        price: toNum(c?.price),
        oi,
        vol,
        oiUsd: toNum(c?.oiUsd, 0) ?? 0,
        volUsd24h: toNum(c?.volUsd24h, 0) ?? 0,
        oiChange24h: toNum(c?.oiChange24h),
        volChange24h: toNum(c?.volChange24h),
        priceChange1h: toNum(c?.priceChange1h),
        priceChange24h: toNum(c?.priceChange24h),
        funding: toNum(c?.funding),
        logo: typeof c?.logo === "string" ? c.logo : null,
      });
    }
    if (!coins.length) return { ok: false, error: "no-valid-coins" };

    let finalCoins = coins;
    let finalTotal = toNum(input.total, coins.length) ?? coins.length;
    if (merge && this.cache.coins.length) {
      const bySymbol = new Map(this.cache.coins.map((c) => [c.symbol, c]));
      for (const coin of coins) bySymbol.set(coin.symbol, coin);
      finalCoins = [...bySymbol.values()];
      finalTotal = Math.max(finalTotal, finalCoins.length);
    }

    const at = now();
    this._deviceFeedAt = at;
    this._nextRetryAt = 0;
    this.cache = {
      at,
      coins: finalCoins,
      total: finalTotal,
      pages: toNum(input.pages, 1) ?? 1,
      fetchedInMs: toNum(input.fetchedInMs, null),
      error: null,
      source: "device",
      partial: Boolean(input.partial),
    };
    Object.assign(this.status, {
      state: "connected",
      connected: true,
      refreshing: false,
      source: "device",
      lastSuccessAt: at,
      lastError: null,
      coins: finalCoins.length,
      pages: this.cache.pages,
      consecutiveFailures: 0,
      totalSuccesses: this.status.totalSuccesses + 1,
    });
    if (!this._deviceFeedLogged) {
      this._deviceFeedLogged = true;
      log("info", `CoinGlass device feed connected — ${finalCoins.length} coins from this browser.`);
    }
    // Deliberately no persistence: a feed push happens every couple of seconds
    // and the rows are transient.
    return { ok: true, coins: finalCoins.length, source: "device" };
  }

  deviceFeedFresh() {
    return this._deviceFeedAt > 0 && now() - this._deviceFeedAt < DEVICE_FEED_TTL_MS;
  }

  async get(force = false, { log = this.log } = {}) {
    // A live browser feed wins over anything the server can fetch itself.
    if (this.deviceFeedFresh() && this.cache.coins.length) {
      this.status.state = "connected";
      this.status.connected = true;
      this.status.source = "device";
      return this.cache;
    }
    if (now() < this._nextRetryAt) {
      if (this.cache.coins.length) return this.cache;
      throw new Error(this.status.lastError || "CoinGlass unavailable");
    }
    const age = now() - this.cache.at;
    if (!force && this.cache.coins.length && age < MARKET_CACHE_MS) return this.cache;
    if (this._marketPromise) return this._marketPromise;

    this._marketPromise = (async () => {
      const attemptStarted = now();
      const apiKey = this.key();
      const source = apiKey ? "api" : "scrape";
      this.status.source = source;
      this.status.lastAttemptAt = attemptStarted;
      this.status.refreshing = true;
      if (!this.status.connected) this.status.state = "connecting";
      try {
        await this.hub?.discover().catch(() => null);
        const onPartial =
          source === "scrape"
            ? (partial, total) => {
                // Paint the top-100 immediately; the full table follows.
                if (!this.cache.coins.length || this.cache.partial) {
                  this.cache = {
                    ...this.cache,
                    coins: partial,
                    total,
                    at: now(),
                    partial: true,
                    error: null,
                    source,
                  };
                }
              }
            : undefined;
        const data = apiKey
          ? await fetchCoinMarketsViaApi(apiKey)
          : await fetchCoinMarkets({ onPartial });
        const wasDown =
          !this.status.connected ||
          this.status.consecutiveFailures > 0 ||
          this.status.state === "disconnected";
        this.cache = { ...data, at: data.fetchedAt || now(), error: null };
        Object.assign(this.status, {
          state: "connected",
          connected: true,
          refreshing: false,
          source: data.source || source,
          lastSuccessAt: data.fetchedAt || now(),
          lastError: null,
          lastLatencyMs: toNum(data.fetchedInMs, now() - attemptStarted),
          coins: data.coins.length,
          pages: data.pages,
          consecutiveFailures: 0,
          totalSuccesses: this.status.totalSuccesses + 1,
        });
        if (wasDown && !this._connectedLogged) {
          this._connectedLogged = true;
          const how = data.source === "api" ? "via official API" : "scraped";
          log("info", `CoinGlass connected — ${data.coins.length} coins ${how}.`);
        }
        return this.cache;
      } catch (err) {
        const message = String(err?.message || err || "CoinGlass unavailable");
        const firstFailure = this.status.consecutiveFailures === 0;
        this.cache.error = message;
        this._nextRetryAt = now() + FAILURE_BACKOFF_MS;
        Object.assign(this.status, {
          state: "disconnected",
          connected: false,
          refreshing: false,
          source,
          lastError: message,
          lastLatencyMs: now() - attemptStarted,
          consecutiveFailures: this.status.consecutiveFailures + 1,
          totalFailures: this.status.totalFailures + 1,
        });
        // Log on the transition only; a 1s poll would otherwise flood the log.
        if (firstFailure) {
          log("error", `CoinGlass ${source === "api" ? "API" : "scrape"} failed: ${message}`);
        }
        if (this.cache.coins.length && now() - this.cache.at < 5 * 60 * 1000) {
          return this.cache;
        }
        throw err;
      } finally {
        this._marketPromise = null;
      }
    })();
    return this._marketPromise;
  }

  /** Drop cached rows after a settings/key change so the next read is fresh. */
  invalidate(source = null) {
    this.cache = emptyCache();
    this._nextRetryAt = 0;
    this._connectedLogged = false;
    this.status.state = "idle";
    this.status.connected = false;
    this.status.refreshing = false;
    if (source) this.status.source = source;
  }

  getStatus(extra = {}) {
    const s = this.status;
    return {
      ...s,
      source: s.source || (this.key() ? "api" : "scrape"),
      apiKeySet: Boolean(this.key()),
      ageMs: s.lastSuccessAt ? now() - s.lastSuccessAt : null,
      cacheAgeMs: this.cache.at ? now() - this.cache.at : null,
      coins: this.cache.coins.length || s.coins,
      pages: this.cache.pages || s.pages,
      lastSuccessText: s.lastSuccessAt ? iso(s.lastSuccessAt) : null,
      ...extra,
    };
  }
}
