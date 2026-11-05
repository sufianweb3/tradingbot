/**
 * The paper-trading engine: scans CoinGlass, evaluates filters, opens and
 * manages simulated positions using real exchange prices.
 */

import { fetchCoinMarkets, fetchCoinMarketsViaApi } from "./coinglass.js";
import { ExchangeHub, VENUES } from "./exchanges.js";
import { Store, createInitialState, normalizeSettings } from "./store.js";
import {
  OI_FIELD,
  VOL_FIELD,
  computeLevels,
  computeStats,
  enabledFilterCount,
  evaluateCoin,
  positionAction,
  positionMetrics,
  scoreCandidate,
} from "./trading.js";
import { clamp, iso, now, round, shortTime, toNum, uid } from "./util.js";
import { PaperExecutor } from "./executor/paper.js";
import { LiveExecutor } from "./executor/live.js";

const MAX_LOG_LINES = 300;
// Minimum gap between two CoinGlass scrapes. The dashboard polls once a second
// and this guard prevents two clients (or a scan tick) from doubling the load.
const MARKET_CACHE_MS = 900;
// A browser tab can push its own scrape (device feed). Rows that arrive this
// recently are preferred over a server-side scrape. Background tabs throttle
// timers to about once a minute, so the window must cover a throttled push.
const DEVICE_FEED_TTL_MS = 90000;
// After a failed scrape, back off instead of retrying on every poll.
const FAILURE_BACKOFF_MS = 20000;
const MAX_SCAN_COINS = 60;

/** Console output stays ASCII on Windows terminals with legacy code pages. */
function ascii(s) {
  return String(s)
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2192/g, "->")
    .replace(/\u00b7/g, ".")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, "...");
}

/** Human-readable duration for logs, e.g. 40000 -> "11h 6m". */
function durationText(sec) {
  const s = Math.max(0, Math.round(toNum(sec, 0)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function applySlippage(price, side, kind, slipPercent) {
  const slip = Math.max(0, toNum(slipPercent, 0)) / 100;
  const dir = side === "long" ? 1 : -1;
  const sign = kind === "entry" ? dir : -dir;
  return price * (1 + sign * slip);
}

export class Engine {
  constructor({ dataDir, store, timers } = {}) {
    this.timers = timers || {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    };
    this.store = store || new Store(`${dataDir || "data"}/state.json`);
    this.state = this.store.load();
    this.hub = new ExchangeHub({ venueKeys: this.state.settings.venues });
    this.marketCache = { at: 0, coins: [], total: 0, error: null, fetchedInMs: 0, pages: 0 };
    this.marketStatus = {
      state: "idle", // idle | connecting | connected | disconnected
      connected: false,
      refreshing: false,
      source: this.state.settings.coinglassApiKey ? "api" : "scrape",
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
    this._marketPromise = null;
    this._deviceFeedAt = 0;
    this._nextRetryAt = 0;
    this.scanning = false;
    this.priceBusy = false;
    this._scanTimer = null;
    this._priceTimer = null;
    this._cooldowns = new Map();
    this._lastEquityAt = 0;
    this._lastNoFilterLog = 0;
    this._lastNoMarginLog = 0;
    this._started = false;
    this._destroyed = false;

    // Execution abstraction (PRD 5.5, 5.8 M3)
    this.paperExecutor = new PaperExecutor(this);
    this.liveExecutor = new LiveExecutor(this);
    this.killSwitchActive = false;
    this._lastReconcileAt = 0;
  }

  get activeExecutor() {
    return this.state.settings.mode === "live" ? this.liveExecutor : this.paperExecutor;
  }

  setLiveAdapter(adapter) {
    this.liveExecutor.setAdapter(adapter);
  }

  async setMode(newMode) {
    const target = newMode === "live" ? "live" : "paper";
    if (target === "live") {
      if (!this.liveExecutor.adapter) {
        return { ok: false, error: "Cannot switch to Live: no exchange connected." };
      }
      await this.liveExecutor.init();
    }
    this.state.settings.mode = target;
    this.log("info", `Mode switched to ${target.toUpperCase()}`);
    this.save();
    return { ok: true, mode: target };
  }

  async init() {
    this.marketStatus.state = "connecting";
    this.log("info", "Engine starting — paper trading only.");
    this._sampleEquity(true);
    try {
      await this.hub.discover(true);
      const s = this.hub.summary();
      this.log(
        "info",
        `Exchange feeds: ${s.okVenues}/${s.totalVenues} online, ${s.instruments} instruments.`
      );
      for (const v of s.venues) {
        if (!v.ok) this.log("warn", `${v.name} unavailable: ${v.error}`);
      }
    } catch (err) {
      this.log("error", `Exchange discovery failed: ${err.message}`);
    }
    // Preload the screener table so the dashboard is populated on first paint.
    try {
      const data = await this._marketData(true);
      this.log(
        "info",
        `CoinGlass: ${data.coins.length} coins loaded in ${data.fetchedInMs} ms (${data.pages} pages).`
      );
    } catch {
      /* _marketData already logged the failure */
    }
    this._started = true;
    this._schedulePriceTick(true);
    if (this.state.settings.autoStart) {
      this.start("autostart");
    } else {
      this.log("info", "Bot is paused. Configure filters, then press Start.");
    }
    this.save();
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Logging / persistence                                              */
  /* ------------------------------------------------------------------ */

  log(level, msg, data) {
    const entry = { t: now(), level, msg: String(msg) };
    if (data !== undefined) entry.data = data;
    this.state.logs.push(entry);
    if (this.state.logs.length > MAX_LOG_LINES) {
      this.state.logs = this.state.logs.slice(-MAX_LOG_LINES);
    }
    if (level !== "debug") {
      const line = ascii(
        `[${shortTime(entry.t)}] ${level.toUpperCase()} ${msg}`
      );
      if (level === "error" || level === "warn") console.warn(line);
      else console.log(line);
    }
    this.store.save(this.state);
    this.emit("log", entry);
  }

  emit(event, payload) {
    for (const fn of this._listeners?.get(event) || []) {
      try {
        fn(payload);
      } catch {
        /* ignore listener errors */
      }
    }
  }

  on(event, fn) {
    if (!this._listeners) this._listeners = new Map();
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  save() {
    this.store.save(this.state);
  }

  flush() {
    this.store.flush();
  }

  /* ------------------------------------------------------------------ */
  /* Controls                                                           */
  /* ------------------------------------------------------------------ */

  start(reason = "manual") {
    if (this._maxTradesReached()) {
      this.log("warn", `Max trades (${this.state.settings.maxTrades}) already reached. Reset to continue.`);
      return { ok: false, error: "max-trades-reached" };
    }
    if (enabledFilterCount(this.state.settings) === 0) {
      this.log(
        "warn",
        "No filter is enabled with a threshold. The bot will not open trades until you configure at least one."
      );
    }
    this.state.meta.running = true;
    this.state.meta.startedAt = this.state.meta.startedAt || now();
    this.state.meta.stopReason = null;
    this.log("info", `Bot started (${reason}).`);
    this.save();
    this._scheduleScan(0);
    return { ok: true };
  }

  pause(reason = "manual") {
    this.state.meta.running = false;
    this.state.meta.stopReason = reason;
    if (this._scanTimer) {
      this.timers.clearTimeout(this._scanTimer);
      this._scanTimer = null;
    }
    this.state.meta.nextScanAt = null;
    this.log("info", `Bot paused (${reason}).`);
    this.save();
    return { ok: true };
  }

  toggle() {
    return this.state.meta.running ? this.pause("manual") : this.start("manual");
  }

  reset() {
    const settings = this.state.settings;
    this.state = createInitialState(settings);
    this._cooldowns.clear();
    this._lastEquityAt = 0;
    if (this._scanTimer) {
      this.timers.clearTimeout(this._scanTimer);
      this._scanTimer = null;
    }
    this.log("info", "Strategy reset. Trades, PnL and equity curve cleared.");
    this.save();
    this.store.flush();
    return { ok: true };
  }

  /**
   * Settings safe to send to a browser: the API key is write-only.
   */
  publicSettings() {
    const { coinglassApiKey, ...rest } = this.state.settings;
    return {
      ...rest,
      coinglassApiKey: "",
      coinglassKeySet: Boolean(String(coinglassApiKey || "").trim()),
    };
  }

  /**
   * Store or clear (`null`) the official CoinGlass API key. A normal settings
   * save with an empty key leaves the stored key untouched.
   */
  setCoinglassApiKey(key) {
    return this.updateSettings({ coinglassApiKey: key ? String(key) : null });
  }

  updateSettings(patch = {}) {
    const previous = this.state.settings;
    const clean = { ...patch };
    // Older clients only know `cooldownSec`; translate it into the explicit
    // re-entry switch so the dashboard and engine always agree.
    if (
      Object.prototype.hasOwnProperty.call(clean, "cooldownSec") &&
      !Object.prototype.hasOwnProperty.call(clean, "reenterEnabled") &&
      !Object.prototype.hasOwnProperty.call(clean, "reenterDelayMin")
    ) {
      const sec = Math.max(0, toNum(clean.cooldownSec, 0) ?? 0);
      clean.reenterEnabled = sec > 0;
      clean.reenterDelayMin = sec / 60;
    }
    delete clean.cooldownSec;
    let keyChange = null;
    if (Object.prototype.hasOwnProperty.call(clean, "coinglassApiKey")) {
      const raw = clean.coinglassApiKey;
      delete clean.coinglassApiKey;
      if (raw === null) {
        keyChange = "";
      } else {
        const key = String(raw).trim();
        if (key) keyChange = key;
      }
    }
    const merged = normalizeSettings({ ...previous, ...clean });
    if (keyChange !== null) merged.coinglassApiKey = keyChange;
    const fundChanged = Number(merged.totalFund) !== Number(previous.totalFund);
    const hasHistory = this.state.trades.length > 0 || this.state.positions.length > 0;
    let didReset = false;

    if (fundChanged) {
      if (hasHistory) {
        // The fund defines the run. Changing it mid-run resets the paper account.
        this.state = createInitialState(merged);
        if (this._scanTimer) {
          this.timers.clearTimeout(this._scanTimer);
          this._scanTimer = null;
        }
        this._cooldowns.clear();
        this._lastEquityAt = 0;
        didReset = true;
        this.log("warn", `Total fund changed to $${merged.totalFund} — strategy reset.`);
      } else {
        // No history yet: just re-base the curve so the chart has no fake jump.
        this.state.settings = merged;
        this.state.initialFund = merged.totalFund;
        this.state.equityCurve = [
          { t: now(), equity: merged.totalFund, balance: merged.totalFund, unrealized: 0 },
        ];
        this._lastEquityAt = 0;
      }
    } else {
      this.state.settings = merged;
    }

    const keyChanged = previous.coinglassApiKey !== this.state.settings.coinglassApiKey;
    if (keyChanged) {
      const hasKey = Boolean(this.state.settings.coinglassApiKey);
      this.marketStatus.source = hasKey ? "api" : "scrape";
      this.marketStatus.state = "idle";
      this.marketCache = { at: 0, coins: [], total: 0, error: null, fetchedInMs: 0, pages: 0 };
      this.log(
        "info",
        hasKey
          ? "CoinGlass API key saved — switching to the official API."
          : "CoinGlass API key cleared — falling back to website scraping."
      );
    }

    if (JSON.stringify(previous.venues) !== JSON.stringify(merged.venues)) {
      this.hub.venueKeys = [...new Set(merged.venues.filter((v) => VENUES[v]))];
      this.hub.discover(true).catch((err) => this.log("warn", `Venue refresh failed: ${err.message}`));
    }

    this.save();
    this._sampleEquity(true);
    return { ok: true, reset: didReset, settings: this.publicSettings() };
  }

  /* ------------------------------------------------------------------ */
  /* Market data                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Accept a CoinGlass snapshot scraped by a dashboard tab (device feed).
   *
   * The browser uses the same encrypted endpoint as the Node scraper, so the
   * rows are already normalised. This makes the cloud deployment usable with
   * no API key while the tab is open: it is the lowest-latency path because it
   * skips the Worker → scrape round trip.
   */
  ingestDeviceFeed(input = {}) {
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
    if (merge && this.marketCache.coins.length) {
      const bySymbol = new Map(this.marketCache.coins.map((c) => [c.symbol, c]));
      for (const coin of coins) bySymbol.set(coin.symbol, coin);
      finalCoins = [...bySymbol.values()];
      finalTotal = Math.max(finalTotal, finalCoins.length);
    }

    const at = now();
    this._deviceFeedAt = at;
    this._nextRetryAt = 0;
    this.marketCache = {
      at,
      coins: finalCoins,
      total: finalTotal,
      pages: toNum(input.pages, 1) ?? 1,
      fetchedInMs: toNum(input.fetchedInMs, null),
      error: null,
      source: "device",
      partial: Boolean(input.partial),
    };
    this.state.meta.marketFetchedAt = at;
    this.state.meta.marketError = null;
    Object.assign(this.marketStatus, {
      state: "connected",
      connected: true,
      refreshing: false,
      source: "device",
      lastSuccessAt: at,
      lastError: null,
      coins: finalCoins.length,
      pages: this.marketCache.pages,
      consecutiveFailures: 0,
      totalSuccesses: this.marketStatus.totalSuccesses + 1,
    });
    if (!this._deviceFeedLogged) {
      this._deviceFeedLogged = true;
      this.log("info", `CoinGlass device feed connected — ${finalCoins.length} coins from this browser.`);
    }
    // Deliberately no save(): a feed push happens every couple of seconds and
    // the rows are not persisted, so writing the whole snapshot here would
    // burn Durable Object write quota for nothing.
    return { ok: true, coins: finalCoins.length, source: "device" };
  }

  _deviceFeedFresh() {
    return this._deviceFeedAt > 0 && now() - this._deviceFeedAt < DEVICE_FEED_TTL_MS;
  }

  async _marketData(force = false) {
    // A live browser feed wins over anything the server can fetch itself.
    if (this._deviceFeedFresh() && this.marketCache.coins.length) {
      this.marketStatus.state = "connected";
      this.marketStatus.connected = true;
      this.marketStatus.source = "device";
      return this.marketCache;
    }
    if (now() < this._nextRetryAt) {
      if (this.marketCache.coins.length) return this.marketCache;
      throw new Error(this.marketStatus.lastError || "CoinGlass unavailable");
    }
    const age = now() - this.marketCache.at;
    if (!force && this.marketCache.coins.length && age < MARKET_CACHE_MS) return this.marketCache;
    if (this._marketPromise) return this._marketPromise;

    this._marketPromise = (async () => {
      const attemptStarted = now();
      const apiKey = String(this.state.settings.coinglassApiKey || "").trim();
      const source = apiKey ? "api" : "scrape";
      this.marketStatus.source = source;
      this.marketStatus.lastAttemptAt = attemptStarted;
      this.marketStatus.refreshing = true;
      if (!this.marketStatus.connected) this.marketStatus.state = "connecting";
      try {
        await this.hub.discover().catch(() => null);
        const onPartial =
          source === "scrape"
            ? (partial, total) => {
                // Paint the top-100 immediately; the full table follows.
                if (!this.marketCache.coins.length || this.marketCache.partial) {
                  this.marketCache = {
                    ...this.marketCache,
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
          !this.marketStatus.connected ||
          this.marketStatus.consecutiveFailures > 0 ||
          this.marketStatus.state === "disconnected";
        this.marketCache = { ...data, at: data.fetchedAt || now(), error: null };
        this.state.meta.marketFetchedAt = data.fetchedAt;
        this.state.meta.marketError = null;
        Object.assign(this.marketStatus, {
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
          totalSuccesses: this.marketStatus.totalSuccesses + 1,
        });
        if (wasDown) {
          const how = data.source === "api" ? "via official API" : "scraped";
          this.log("info", `CoinGlass connected — ${data.coins.length} coins ${how}.`);
        }
        return this.marketCache;
      } catch (err) {
        const message = String(err?.message || err || "CoinGlass unavailable");
        const firstFailure = this.marketStatus.consecutiveFailures === 0;
        this.marketCache.error = message;
        this.state.meta.marketError = message;
        this._nextRetryAt = now() + FAILURE_BACKOFF_MS;
        Object.assign(this.marketStatus, {
          state: "disconnected",
          connected: false,
          refreshing: false,
          source,
          lastError: message,
          lastLatencyMs: now() - attemptStarted,
          consecutiveFailures: this.marketStatus.consecutiveFailures + 1,
          totalFailures: this.marketStatus.totalFailures + 1,
        });
        // Log on the transition only; a 1s poll would otherwise flood the log.
        if (firstFailure) {
          this.log(
            "error",
            `CoinGlass ${source === "api" ? "API" : "scrape"} failed: ${message}`
          );
        }
        if (this.marketCache.coins.length && now() - this.marketCache.at < 5 * 60 * 1000) {
          return this.marketCache;
        }
        throw err;
      } finally {
        this._marketPromise = null;
      }
    })();
    return this._marketPromise;
  }

  getMarketStatus() {
    const s = this.marketStatus;
    return {
      ...s,
      source: s.source || (this.state.settings.coinglassApiKey ? "api" : "scrape"),
      apiKeySet: Boolean(String(this.state.settings.coinglassApiKey || "").trim()),
      ageMs: s.lastSuccessAt ? now() - s.lastSuccessAt : null,
      cacheAgeMs: this.marketCache.at ? now() - this.marketCache.at : null,
      coins: this.marketCache.coins.length || s.coins,
      pages: this.marketCache.pages || s.pages,
      lastSuccessText: s.lastSuccessAt ? iso(s.lastSuccessAt) : null,
    };
  }

  getMarketRows() {
    const s = this.state.settings;
    const marketStale = !this.marketCache.at || now() - this.marketCache.at > 150000;
    const excludedSet = new Set(
      String(s.excludeSymbols || "")
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean)
    );
    const openCounts = new Map();
    for (const p of this.state.positions) {
      openCounts.set(p.symbol, (openCounts.get(p.symbol) || 0) + 1);
    }
    const openSymbols = new Set(openCounts.keys());
    const available = this._equitySnapshot().available;
    const rows = [];

    const longProfile = s.profiles?.long;
    const shortProfile = s.profiles?.short;
    const longActive = Boolean(longProfile?.enabled);
    const shortActive = Boolean(shortProfile?.enabled);

    for (const coin of this.marketCache.coins) {
      const longEv = longActive
        ? evaluateCoin(coin, longProfile, "long")
        : { qualified: false, configured: false };
      const shortEv = shortActive
        ? evaluateCoin(coin, shortProfile, "short")
        : { qualified: false, configured: false };

      let isConflict = false;
      let qualified = false;
      let side = null;
      let ev = longEv.configured ? longEv : shortEv.configured ? shortEv : longEv;

      if (longEv.qualified && shortEv.qualified) {
        // S5: A coin passing both profiles is skipped and logged as conflict
        isConflict = true;
        qualified = false;
        side = "conflict";
        ev = longEv;
      } else if (longEv.qualified) {
        qualified = true;
        side = "long";
        ev = longEv;
      } else if (shortEv.qualified) {
        qualified = true;
        side = "short";
        ev = shortEv;
      } else if (longActive && longEv.configured) {
        side = "long";
        ev = longEv;
      } else if (shortActive && shortEv.configured) {
        side = "short";
        ev = shortEv;
      } else {
        ev = evaluateCoin(coin, s);
        side = ev.side;
        qualified = ev.qualified;
      }

      const entry = this.hub.resolve(coin.symbol);
      const explicitExcluded = excludedSet.has(coin.symbol);
      const tradable = Boolean(entry) || Boolean(s.allowCoinglassPrice && coin.price > 0);
      const activeProfile = (side === "short" ? shortProfile : longProfile) || s;
      const row = {
        symbol: coin.symbol,
        name: coin.name,
        logo: coin.logo,
        price: coin.price,
        oi: coin.oi,
        vol: coin.vol,
        oiUsd: coin.oiUsd,
        volUsd24h: coin.volUsd24h,
        priceChange1h: coin.priceChange1h,
        priceChange24h: coin.priceChange24h,
        funding: coin.funding,
        venue: entry?.venueName || null,
        venueKey: entry?.venue || null,
        venueSymbol: entry?.venueSymbol || null,
        tradable,
        stale: marketStale,
        excluded: explicitExcluded,
        open: openSymbols.has(coin.symbol),
        openCount: openCounts.get(coin.symbol) || 0,
        maxPerCoin: Math.max(1, toNum(activeProfile.maxPositionsPerCoin, 1) ?? 1),
        cooling: this._isCooling(coin.symbol),
        coolingRemainingSec: this._coolingRemainingSec(coin.symbol),
        isConflict,
        configured: Boolean(ev.configured),
        qualified,
        side,
        passCount: ev.passCount || 0,
        total: ev.total || 0,
        score: ev.configured ? round(scoreCandidate(coin, ev), 4) : 0,
      };
      if (row.oiUsd < s.minOiUsd || coin.volUsd24h < s.minVolUsd24h) row.tradable = false;
      row.blockReason = isConflict || qualified ? this._blockReason(row, s, available) : null;
      rows.push(row);
    }

    rows.sort((a, b) => {
      if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
      if (a.isConflict !== b.isConflict) return a.isConflict ? 1 : -1;
      if (a.passCount !== b.passCount) return b.passCount - a.passCount;
      if (a.score !== b.score) return b.score - a.score;
      return b.oiUsd - a.oiUsd;
    });
    return rows;
  }

  _coolingRemainingSec(symbol) {
    const s = this.state.settings;
    // Derive the delay from the explicit re-entry settings. Older states only
    // have `cooldownSec`, so fall back to it when the new fields are absent.
    // Deriving here also protects against a stale `cooldownSec: 0` written by
    // an older build while `reenterEnabled`/`reenterDelayMin` were already set.
    const hasReenterFields = s.reenterEnabled !== undefined || s.reenterDelayMin !== undefined;
    const cooldownSec = hasReenterFields
      ? s.reenterEnabled
        ? Math.max(0, toNum(s.reenterDelayMin, 0) * 60)
        : 0
      : Math.max(0, toNum(s.cooldownSec, 0));
    if (!(cooldownSec > 0)) return 0;
    const stored = toNum(this.state.meta?.reentryBlocks?.[symbol], 0) ?? 0;
    const last = Math.max(this._cooldowns.get(symbol) || 0, stored);
    if (!last) return 0;
    const left = last + cooldownSec * 1000 - now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  _isCooling(symbol) {
    return this._coolingRemainingSec(symbol) > 0;
  }

  /**
   * Why a qualified row would not open a trade right now, or null if it can.
   * The dashboard shows this so "qualified but nothing happened" is never a
   * mystery: cooling, no price feed, stale data, coin cap, margin, etc.
   */
  _blockReason(row, s = this.state.settings, availableOverride = null) {
    if (row.isConflict) return "conflict";
    if (row.excluded) return "excluded";
    if (row.stale) return "stale";
    if (!row.tradable) return "no-feed";
    if (row.cooling) return "cooling";
    const side = row.side === "short" ? "short" : "long";
    const oppositeSide = side === "long" ? "short" : "long";
    if (this.state.positions.some((p) => p.symbol === row.symbol && p.side === oppositeSide)) {
      return "opposite-position";
    }
    if (!this._canOpenMore(row.symbol, side)) return "coin-cap";
    if (this._maxOpenReached(side)) return "max-open";
    if (this._maxTradesReached(side)) return "max-trades";
    if (!(toNum(row.price, 0) > 0)) return "no-price";
    const profile = s.profiles?.[side] || s;
    const sizing = this._allocationFor(toNum(row.price, 0), profile);
    if (!(sizing.margin > 0) || !(sizing.qty > 0)) return "no-size";
    const entryFee = sizing.notional * (toNum(s.feePercent, 0) / 100);
    const available = availableOverride === null ? this._equitySnapshot().available : availableOverride;
    if (sizing.margin > available + entryFee + 1e-6) return "no-margin";
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* Equity / stats                                                     */
  /* ------------------------------------------------------------------ */

  _equitySnapshot() {
    const initialFund = toNum(this.state.initialFund, 0);
    let closedPnl = 0;
    let openEntryFees = 0;
    let openPartialNet = 0;
    let openNet = 0;
    let lockedMargin = 0;
    for (const t of this.state.trades) closedPnl += toNum(t.pnlNet, 0);
    for (const p of this.state.positions) {
      const price = toNum(p.markPrice, p.entryPrice);
      const m = positionMetrics(p, price);
      openNet += m.net;
      openEntryFees += toNum(p.entryFee, 0);
      lockedMargin += toNum(p.margin, 0);
      for (const part of p.partials || []) openPartialNet += toNum(part.net, 0);
    }
    const balance = initialFund + closedPnl + openPartialNet - openEntryFees;
    const equity = balance + openNet;
    return {
      initialFund,
      balance,
      equity,
      lockedMargin,
      available: balance - lockedMargin,
      unrealized: openNet,
    };
  }

  _sampleEquity(force = false) {
    const t = now();
    if (!force && t - this._lastEquityAt < 15000) return;
    this._lastEquityAt = t;
    const snap = this._equitySnapshot();
    const curve = this.state.equityCurve;
    const point = {
      t,
      equity: round(snap.equity, 4),
      balance: round(snap.balance, 4),
      unrealized: round(snap.unrealized, 4),
    };
    const last = curve[curve.length - 1];
    if (last && t - last.t < 8000) curve[curve.length - 1] = point;
    else curve.push(point);

    if (curve.length > 6000) {
      const step = Math.ceil(curve.length / 6000);
      this.state.equityCurve = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
    }
    if (force || t - (this._lastEquitySave || 0) > 30000) {
      this._lastEquitySave = t;
      this.save();
    }
  }

  getStats(filterMode = null) {
    const targetMode = filterMode !== null ? filterMode : (this.state.settings?.mode || "paper");
    const filteredTrades = this.state.trades.filter((t) => !targetMode || (t.mode || "paper") === targetMode);
    const filteredPositions = this.state.positions.filter((p) => !targetMode || (p.mode || "paper") === targetMode);
    const marks = new Map(filteredPositions.map((p) => [p.id, toNum(p.markPrice, p.entryPrice)]));
    return computeStats({
      trades: filteredTrades,
      positions: filteredPositions,
      marks,
      initialFund: this.state.initialFund,
      equityCurve: this.state.equityCurve,
      feePercent: this.state.settings?.feePercent,
    });
  }

  _maxTradesReached(side = null) {
    const s = this.state.settings;
    const globalMax = toNum(s.maxTrades, 0) ?? 0;
    if (globalMax > 0 && this.state.trades.length >= globalMax) return true;
    if (side) {
      const profile = s.profiles?.[side];
      const pMax = toNum(profile?.maxTrades, 0) ?? 0;
      if (pMax > 0) {
        const sideTrades = this.state.trades.filter((t) => t.side === side).length;
        if (sideTrades >= pMax) return true;
      }
    }
    return false;
  }

  _maxOpenReached(side = null) {
    const s = this.state.settings;
    const globalMax = toNum(s.maxOpenPositions, 0) ?? 0;
    if (globalMax > 0 && this.state.positions.length >= globalMax) return true;
    if (side) {
      const profile = s.profiles?.[side];
      const pMax = toNum(profile?.maxOpenPositions, 0) ?? 0;
      if (pMax > 0) {
        const sideOpen = this.state.positions.filter((p) => p.side === side).length;
        if (sideOpen >= pMax) return true;
      }
    }
    return false;
  }

  /** Positions currently open on one coin. */
  _openCount(symbol, side = null) {
    return this.state.positions.filter(
      (p) => p.symbol === symbol && (!side || p.side === side)
    ).length;
  }

  /** True when another position may be opened on this coin. Enforces PRD S6 one-way mode. */
  _canOpenMore(symbol, side = "long") {
    const s = this.state.settings;
    const profile = s.profiles?.[side] || s;
    const oppositeSide = side === "long" ? "short" : "long";
    const hasOpposite = this.state.positions.some(
      (p) => p.symbol === symbol && p.side === oppositeSide
    );
    if (hasOpposite) return false;

    const max = Math.max(1, toNum(profile.maxPositionsPerCoin, 1) ?? 1);
    return this._openCount(symbol, side) < max;
  }

  _allocationFor(price, profile = null) {
    const p = profile || this.state.settings.profiles?.long || this.state.settings;
    const lev = Math.max(1, toNum(p.leverage, 1));
    if (p.sizingMode === "fixedQty") {
      const qty = toNum(p.fixedQty, 0);
      const notional = qty * price;
      return { margin: notional / lev, qty, notional, lev };
    }
    let margin;
    if (p.sizingMode === "fixedMargin") {
      margin = toNum(p.fixedMargin, 0) ?? 0;
    } else {
      const base =
        p.allocationBase === "equity"
          ? this._equitySnapshot().equity
          : toNum(this.state.settings.totalFund, 0);
      margin = (base * toNum(p.allocationPercent, 50)) / 100;
    }
    const notional = margin * lev;
    return { margin, qty: notional / price, notional, lev };
  }

  /* ------------------------------------------------------------------ */
  /* Scanning                                                           */
  /* ------------------------------------------------------------------ */

  _scheduleScan(delayMs) {
    if (this._scanTimer) this.timers.clearTimeout(this._scanTimer);
    this._scanTimer = null;
    if (!this.state.meta.running || this._destroyed) {
      this.state.meta.nextScanAt = null;
      return;
    }
    const delay = Math.max(0, delayMs);
    this.state.meta.nextScanAt = now() + delay;
    this._scanTimer = this.timers.setTimeout(() => {
      this._scanTimer = null;
      this.scan().catch((err) => this.log("error", `Scan crashed: ${err.message}`));
    }, delay);
  }

  async scan({ manual = false } = {}) {
    if (this.scanning) return { ok: false, error: "already-scanning" };
    const wasRunning = this.state.meta.running;
    if (!wasRunning && !manual) return { ok: false, error: "paused" };
    if (this._maxTradesReached()) {
      this.pause("max-trades");
      return { ok: false, error: "max-trades-reached" };
    }

    this.scanning = true;
    const started = now();
    const s = this.state.settings;
    const result = {
      at: started,
      ms: 0,
      total: 0,
      scanned: 0,
      qualified: 0,
      candidates: 0,
      opened: 0,
      dryRun: !wasRunning,
      error: null,
      stale: false,
    };

    try {
      const data = await this._marketData();
      result.total = this.marketCache.coins.length;
      result.stale = now() - this.marketCache.at > 150000;

      const filters =
        enabledFilterCount(s.profiles?.long) +
        enabledFilterCount(s.profiles?.short) +
        enabledFilterCount(s);
      if (filters === 0) {
        result.error = "no-filters";
        result.ok = false;
        if (now() - this._lastNoFilterLog > 60000) {
          this._lastNoFilterLog = now();
          this.log("warn", "Scan skipped: enable at least one OI or Volume filter with a threshold.");
        }
        return result;
      }

      const rows = this.getMarketRows();
      const coinMap = new Map((data.coins || []).map((c) => [c.symbol, c]));
      const candidates = rows.filter(
        (r) =>
          r.qualified &&
          !r.cooling &&
          !r.excluded &&
          r.tradable &&
          !r.stale &&
          !r.isConflict &&
          this._canOpenMore(r.symbol, r.side)
      );
      result.qualified = rows.filter((r) => r.qualified).length;
      result.scanned = rows.filter((r) => r.configured).length;
      result.candidates = candidates.length;

      if (!wasRunning) {
        this.log(
          "info",
          `Manual scan: ${result.scanned} coins evaluated, ${result.qualified} qualified. Bot is paused (no trades opened).`
        );
        result.ok = true;
        return result;
      }

      if (result.stale) {
        this.log("warn", "Signal data is more than 2.5 minutes old — not opening new trades.");
        result.ok = false;
        return result;
      }

      const opened = [];
      for (const row of candidates.slice(0, MAX_SCAN_COINS)) {
        if (!this.state.meta.running) break;
        if (row.isConflict || row.side === "conflict") {
          this.log("warn", `Skip conflict: ${row.symbol} qualified for both Long and Short profiles.`);
          continue;
        }
        const side = row.side === "short" ? "short" : "long";
        if (this._maxTradesReached(side)) break;
        if (this._maxOpenReached(side)) break;
        const coin = coinMap.get(row.symbol);
        if (!coin) continue;
        const profile = s.profiles?.[side] || s;
        const ev = evaluateCoin(coin, profile, side);
        if (!ev.qualified || !ev.side) continue;
        const quote = await this._resolveQuote(coin);
        if (!quote) continue;
        const pos = await this.activeExecutor.openPosition(coin, quote, ev, profile);
        if (pos) {
          opened.push(`${pos.side.toUpperCase()} ${pos.symbol}`);
          result.opened++;
        }
      }

      // Record why every qualified coin did or did not open. The dashboard shows
      // this directly, and the log explains silent non-trades.
      const blocked = {};
      const coolingList = [];
      for (const r of rows) {
        if (!r.qualified || !r.blockReason) continue;
        blocked[r.blockReason] = (blocked[r.blockReason] || 0) + 1;
        if (r.blockReason === "cooling") {
          coolingList.push(`${r.symbol} (${durationText(r.coolingRemainingSec)})`);
        }
      }
      result.blocked = blocked;

      if (result.qualified > 0 && result.opened === 0 && now() - this._lastNoMarginLog > 30000) {
        this._lastNoMarginLog = now();
        const parts = [];
        if (blocked.cooling) parts.push(`${blocked.cooling} in re-entry delay (${coolingList.slice(0, 4).join(", ")})`);
        for (const key of ["stale", "no-feed", "coin-cap", "max-open", "no-margin", "excluded", "no-price", "no-size"]) {
          if (blocked[key]) parts.push(`${blocked[key]} ${key}`);
        }
        this.log(
          "info",
          `Qualified: ${result.qualified}, opened 0${parts.length ? ` — ${parts.join(", ")}` : ""}.`
        );
      }

      if (result.opened > 0) {
        this.log(
          "info",
          `Scan: ${result.total} coins · ${result.qualified} qualified · opened ${result.opened} (${opened.join(", ")}).`
        );
      }

      this.state.meta.scanCount++;
      result.ok = true;
      result.openedSymbols = opened;
      return result;
    } catch (err) {
      result.error = err.message;
      result.ok = false;
      this.log("error", `Scan error: ${err.message}`);
      return result;
    } finally {
      result.ms = now() - started;
      this.state.meta.lastScan = result;
      this.state.meta.marketFetchedAt = this.marketCache.at || null;
      this.scanning = false;
      this._sampleEquity();
      this.save();
      if (this.state.meta.running) {
        this._scheduleScan(this.state.settings.scanIntervalSec * 1000);
      } else {
        this.state.meta.nextScanAt = null;
      }
    }
  }

  async _resolveQuote(coin) {
    const entry = this.hub.resolve(coin.symbol);
    if (entry) {
      const q = await this.hub.quote(entry);
      if (q) return q;
    }
    if (this.state.settings.allowCoinglassPrice && coin.price > 0) {
      return {
        venue: "coinglass",
        venueName: "CoinGlass",
        venueSymbol: coin.symbol,
        base: coin.symbol,
        price: coin.price,
        ts: now(),
        stale: true,
        fallback: true,
        synthetic: true,
      };
    }
    return null;
  }

  _openPosition(coin, quote, evaluation, profile = null) {
    const s = this.state.settings;
    const side = evaluation.side;
    if (side !== "long" && side !== "short") return null;
    const p = profile || s.profiles?.[side] || s;
    if (!this._canOpenMore(coin.symbol, side)) return null;
    if (this._maxOpenReached(side)) return null;
    if (this._isCooling(coin.symbol)) return null;

    const price = toNum(quote.price);
    if (!(price > 0)) return null;
    const fillPrice = applySlippage(price, side, "entry", s.slippagePercent);
    if (!(fillPrice > 0)) return null;

    const sizing = this._allocationFor(fillPrice, p);
    const margin = sizing.margin;
    const qty = sizing.qty;
    const notional = sizing.notional;
    if (!(margin > 0) || !(qty > 0)) return null;

    // Free margin excludes fees already paid. Tolerate the prospective entry fee
    // so a 50%-of-fund allocation can actually fill two positions.
    const entryFee = notional * (toNum(s.feePercent, 0) / 100);
    const available = this._equitySnapshot().available;
    if (margin > available + entryFee + 1e-6) return null;

    const levels = computeLevels({ side, entry: fillPrice, settings: { ...s, ...p } });
    const pos = {
      id: uid("pos_"),
      mode: this.state.settings?.mode === "live" ? "live" : "paper",
      status: "open",
      symbol: coin.symbol,
      side,
      profile: side,
      venue: quote.venue,
      venueName: quote.venueName,
      venueSymbol: quote.venueSymbol,
      base: quote.base || coin.symbol,
      source: quote.synthetic ? "coinglass-fallback" : quote.venueName,
      entryTime: now(),
      entryPrice: fillPrice,
      signalPrice: price,
      qty,
      originalQty: qty,
      margin: round(margin, 8),
      notional: round(notional, 8),
      leverage: sizing.lev,
      entryFee,
      grossPnl: 0,
      exitFees: 0,
      exitQty: 0,
      exitNotional: 0,
      partials: [],
      slPrice: levels.slPrice,
      initialSlPrice: levels.slPrice,
      tp1Price: levels.tp1Price,
      tpMaxPrice: levels.tpMaxPrice,
      liqPrice: levels.liqPrice,
      trailMove: levels.trailMove,
      tp1Hit: false,
      trailingEnabled: Boolean(p.trailingEnabled),
      trailingStart: p.trailingStart,
      trailingActive: false,
      trailStopPrice: null,
      peakPrice: fillPrice,
      peakRoe: 0,
      markPrice: price,
      markTs: quote.ts || now(),
      markVenue: quote.venue,
      priceStale: Boolean(quote.stale),
      quoteFailures: 0,
      fallbackStreak: 0,
      feePercent: s.feePercent,
      slippagePercent: s.slippagePercent,
      riskMode: s.riskMode,
      slPercent: p.slPercent,
      tp1Percent: p.tp1Percent,
      tpMaxPercent: p.tpMaxPercent,
      tp1ClosePercent: p.tp1ClosePercent,
      trailingDistancePercent: p.trailingDistancePercent,
      criteria: evaluation.checks.map((c) => ({ ...c })),
      signal: {
        oi: { ...coin.oi },
        vol: { ...coin.vol },
        oiUsd: coin.oiUsd,
        volUsd24h: coin.volUsd24h,
        price: coin.price,
      },
    };

    this.state.positions.push(pos);
    this.state.meta.totalOpened++;
    this.state.meta.lastOpenAt = now();
    this.log(
      "info",
      `OPEN ${side.toUpperCase()} ${coin.symbol} @ ${round(fillPrice, 6)} · margin $${round(
        margin,
        2
      )} · ${sizing.lev}x · ${quote.venueName} · SL ${round(pos.slPrice, 6)} · TP1 ${round(
        pos.tp1Price,
        6
      )}`
    );
    this.save();
    this._sampleEquity(true);
    // Start the price loop immediately; it stops itself once no position is open.
    this._schedulePriceTick(true);
    this.emit("trade", { type: "open", position: pos });
    return pos;
  }

  /* ------------------------------------------------------------------ */
  /* Position management                                                */
  /* ------------------------------------------------------------------ */

  async _tickPrices() {
    if (this.priceBusy) return;
    this.priceBusy = true;
    try {
      const positions = [...this.state.positions];
      if (!positions.length) {
        this._sampleEquity();
        return;
      }

      const quotes = await Promise.all(
        positions.map((p) =>
          this.hub
            .quote({ venue: p.venue, venueSymbol: p.venueSymbol, base: p.base })
            .catch(() => null)
        )
      );

      let changed = false;
      for (let i = 0; i < positions.length; i++) {
        const p = positions[i];
        if (!p || p.status !== "open" || !(p.qty > 0)) continue;
        const q = quotes[i];
        if (!q) {
          p.priceStale = true;
          p.quoteFailures = (p.quoteFailures || 0) + 1;
          continue;
        }
        if (now() - q.ts > 90000) {
          p.priceStale = true;
          continue;
        }

        p.priceStale = Boolean(q.stale);
        p.quoteFailures = 0;
        p.markPrice = q.price;
        p.markTs = q.ts;
        p.markVenue = q.venue;

        if (q.fallback) {
          p.fallbackStreak = (p.fallbackStreak || 0) + 1;
          if (p.fallbackStreak >= 3 && q.venue !== p.venue) {
            this.log(
              "warn",
              `${p.symbol}: primary feed unavailable, switching to ${q.venueName}.`
            );
            p.venue = q.venue;
            p.venueName = q.venueName;
            p.venueSymbol = q.venueSymbol;
            p.base = q.base || p.base;
            p.fallbackStreak = 0;
          }
        } else {
          p.fallbackStreak = 0;
        }

        const dir = p.side === "long" ? 1 : -1;
        const grossRoe = ((q.price - p.entryPrice) / p.entryPrice) * dir * p.leverage * 100;
        p.peakRoe = Math.max(toNum(p.peakRoe, 0), grossRoe);

        const action = positionAction(p, q.price);
        if (action.next) {
          p.peakPrice = action.next.peakPrice;
          p.trailingActive = action.next.trailingActive;
          p.trailStopPrice = action.next.trailStopPrice;
          if (p.mode === "live" && this.liveExecutor?.adapter) {
            this.liveExecutor.updateTrailingStop(p, q.price);
          }
        }

        if (action.type === "close") {
          this._closePosition(p, q.price, action.reason, { force: action.force });
          changed = true;
        } else if (action.type === "partial") {
          this._partialClose(p, q.price, action.pct, action.reason);
          p.tp1Hit = true;
          p.tp1Time = now();
          // Arm the trail in the same tick so a fast retrace cannot fall back
          // to the original stop after TP1.
          if (p.trailingEnabled && p.trailingStart === "tp1") {
            const trail =
              dir > 0
                ? p.peakPrice * (1 - p.trailMove)
                : p.peakPrice * (1 + p.trailMove);
            p.trailingActive = true;
            p.trailStopPrice =
              dir > 0 ? Math.max(p.slPrice, trail) : Math.min(p.slPrice, trail);
          }
          changed = true;
        }
      }

      if (changed) {
        this.state.positions = this.state.positions.filter(
          (p) => p.status === "open" && p.qty > 1e-12
        );
        this._sampleEquity(true);
        this.save();
      } else {
        this._sampleEquity();
      }

      // Periodic Live reconcile (PRD 5.8 L7)
      if (this.state.settings?.mode === "live" && this.liveExecutor?.adapter) {
        const nowMs = Date.now();
        if (nowMs - (this._lastReconcileAt || 0) >= 30000) {
          this._lastReconcileAt = nowMs;
          this.liveExecutor.reconcile().catch((err) => {
            console.warn("[engine] Live reconcile failed:", err?.message);
          });
        }
      }
    } catch (err) {
      this.log("error", `Price tick error: ${err.message}`);
    } finally {
      this.priceBusy = false;
      this._schedulePriceTick();
    }
  }

  _schedulePriceTick(immediate = false) {
    if (this._destroyed) return;
    if (this._priceTimer) {
      this.timers.clearTimeout(this._priceTimer);
      this._priceTimer = null;
    }
    // Nothing open → no price loop. On Cloudflare every tick is a billable
    // Durable Object alarm, so an idle bot must not wake up at all.
    if (!this.state.positions.length) return;
    const delay = immediate ? 250 : Math.max(500, toNum(this.state.settings.priceRefreshMs, 2000));
    this._priceTimer = this.timers.setTimeout(() => {
      this._priceTimer = null;
      this._tickPrices().catch((err) => this.log("error", `Price loop: ${err.message}`));
    }, delay);
  }

  _partialClose(pos, price, pct, reason) {
    const remaining = toNum(pos.qty, 0);
    if (!(remaining > 0)) return;
    const fraction = clamp(toNum(pct, 0), 0, 100) / 100;
    const qty = Math.min(remaining, pos.originalQty * fraction);
    if (!(qty > 0)) return;

    const exitPrice = applySlippage(price, pos.side, "exit", pos.slippagePercent);
    const dir = pos.side === "long" ? 1 : -1;
    const gross = (exitPrice - pos.entryPrice) * qty * dir;
    const fee = exitPrice * qty * (toNum(pos.feePercent, 0) / 100);

    pos.qty = remaining - qty;
    pos.grossPnl += gross;
    pos.exitFees += fee;
    pos.exitQty += qty;
    pos.exitNotional += exitPrice * qty;
    pos.partials.push({
      t: now(),
      reason,
      qty,
      price: exitPrice,
      gross,
      fee,
      net: gross - fee,
    });

    this.log(
      "info",
      `${pos.symbol} ${reason}: sold ${round((qty / pos.originalQty) * 100, 2)}% @ ${round(
        exitPrice,
        6
      )} · gross $${round(gross, 2)}`
    );
    this.save();
    this.emit("trade", { type: "partial", position: pos });

    if (pos.qty <= 1e-12) this._finalize(pos, reason);
  }

  _closePosition(pos, price, reason, { force = false } = {}) {
    if (!pos || pos.status !== "open") return null;
    const remaining = toNum(pos.qty, 0);
    if (remaining > 1e-12) {
      const exitPrice = force
        ? toNum(price, pos.markPrice)
        : applySlippage(price, pos.side, "exit", pos.slippagePercent);
      const dir = pos.side === "long" ? 1 : -1;
      const gross = (exitPrice - pos.entryPrice) * remaining * dir;
      const fee = exitPrice * remaining * (toNum(pos.feePercent, 0) / 100);
      pos.qty = 0;
      pos.grossPnl += gross;
      pos.exitFees += fee;
      pos.exitQty += remaining;
      pos.exitNotional += exitPrice * remaining;
      pos.partials.push({
        t: now(),
        reason,
        qty: remaining,
        price: exitPrice,
        gross,
        fee,
        net: gross - fee,
      });
    }
    return this._finalize(pos, reason);
  }

  _finalize(pos, reason) {
    if (pos.status !== "open") return null;
    const exitPriceAvg = pos.exitQty > 0 ? pos.exitNotional / pos.exitQty : pos.markPrice;
    const pnlNet = pos.grossPnl - pos.entryFee - pos.exitFees;
    const margin = Math.max(1e-9, pos.margin);
    const roe = (pnlNet / margin) * 100;

    const trade = {
      id: pos.id,
      mode: pos.mode || "paper",
      symbol: pos.symbol,
      side: pos.side,
      profile: pos.profile || pos.side,
      venue: pos.venue,
      venueName: pos.venueName,
      venueSymbol: pos.venueSymbol,
      source: pos.source,
      entryTime: pos.entryTime,
      exitTime: now(),
      entryPrice: pos.entryPrice,
      exitPrice: exitPriceAvg,
      exitPriceAvg,
      qty: pos.originalQty,
      originalQty: pos.originalQty,
      margin: pos.margin,
      notional: pos.notional,
      leverage: pos.leverage,
      grossPnl: pos.grossPnl,
      entryFee: pos.entryFee,
      exitFees: pos.exitFees,
      feesPaid: pos.entryFee + pos.exitFees,
      pnlNet,
      roe,
      peakRoe: pos.peakRoe,
      exitReason: reason,
      partials: pos.partials,
      durationMs: now() - pos.entryTime,
      riskMode: pos.riskMode,
      slPercent: pos.slPercent,
      tp1Percent: pos.tp1Percent,
      tpMaxPercent: pos.tpMaxPercent,
      tp1ClosePercent: pos.tp1ClosePercent,
      trailingEnabled: pos.trailingEnabled,
      trailingStart: pos.trailingStart,
      criteria: pos.criteria,
      signal: pos.signal,
    };

    pos.status = "closed";
    this.state.trades.push(trade);
    this.state.positions = this.state.positions.filter((p) => p.id !== pos.id);
    const closedAt = now();
    this._cooldowns.set(pos.symbol, closedAt);
    if (!this.state.meta.reentryBlocks) this.state.meta.reentryBlocks = {};
    this.state.meta.reentryBlocks[pos.symbol] = closedAt;
    this.state.meta.lastCloseAt = closedAt;

    this.log(
      pnlNet >= 0 ? "info" : "warn",
      `CLOSE ${pos.side.toUpperCase()} ${pos.symbol} @ ${round(exitPriceAvg, 6)} · ${reason} · PnL $${round(
        pnlNet,
        2
      )} (${round(roe, 2)}% ROE) · fees $${round(pos.entryFee + pos.exitFees, 2)}`
    );
    const reentryDelay = toNum(this.state.settings.cooldownSec, 0);
    if (reentryDelay > 0) {
      this.log(
        "info",
        `${pos.symbol} re-entry delay: no new ${pos.symbol} trade for ${durationText(reentryDelay)}.`
      );
    }

    this._sampleEquity(true);
    this.save();
    this.store.flush();
    this.emit("trade", { type: "close", trade });

    if (this._maxTradesReached() && this.state.meta.running) {
      this.pause("max-trades");
      this.log(
        "info",
        `Max trades reached (${this.state.settings.maxTrades}). Stats are ready to download.`
      );
    }
    return trade;
  }

  async closePositionById(id, reason = "Manual") {
    const pos = this.state.positions.find((p) => p.id === id);
    if (!pos) return { ok: false, error: "position-not-found" };
    const q = await this.hub
      .quote({ venue: pos.venue, venueSymbol: pos.venueSymbol, base: pos.base })
      .catch(() => null);
    const price = q?.price ?? pos.markPrice ?? pos.entryPrice;
    let trade;
    if (pos.mode === "live" && this.liveExecutor?.adapter) {
      trade = await this.liveExecutor.closePosition(pos, price, reason);
    } else {
      trade = await this.paperExecutor.closePosition(pos, price, reason);
    }
    return { ok: true, trade };
  }

  async closeAll(reason = "Manual") {
    const ids = this.state.positions.map((p) => p.id);
    const closed = [];
    for (const id of ids) {
      const r = await this.closePositionById(id, reason);
      if (r.ok) closed.push(r.trade);
    }
    return { ok: true, closed: closed.length, trades: closed };
  }

  async openManual(symbol, { force = true, side = null } = {}) {
    const s = this.state.settings;
    const wanted = String(symbol || "").toUpperCase();
    if (!wanted) return { ok: false, error: "symbol-required" };
    try {
      await this._marketData();
    } catch {
      /* use cache if available */
    }
    const coin = this.marketCache.coins.find((c) => c.symbol === wanted);
    if (!coin) return { ok: false, error: "coin-not-found" };
    const longEv = s.profiles?.long ? evaluateCoin(coin, s.profiles.long, "long") : evaluateCoin(coin, s);
    const shortEv = s.profiles?.short ? evaluateCoin(coin, s.profiles.short, "short") : null;
    const targetSide =
      side ||
      (shortEv?.qualified && !longEv?.qualified ? "short" : longEv?.qualified ? "long" : s.direction === "short" ? "short" : "long");
    const profile = s.profiles?.[targetSide] || s;

    if (!this._canOpenMore(wanted, targetSide)) {
      return {
        ok: false,
        error: "already-open",
        maxPerCoin: Math.max(1, toNum(profile.maxPositionsPerCoin, 1) ?? 1),
      };
    }
    const cooling = this._coolingRemainingSec(wanted);
    if (cooling > 0) {
      return { ok: false, error: "cooling", remainingSec: cooling, cooldownSec: s.cooldownSec };
    }
    if (this._maxOpenReached(targetSide)) return { ok: false, error: "max-open" };

    const activeEv = targetSide === "short" && shortEv ? shortEv : longEv;
    if (!force && !activeEv.qualified) return { ok: false, error: "criteria-not-met", evaluation: activeEv };
    const quote = await this._resolveQuote(coin);
    if (!quote) return { ok: false, error: "no-price-feed" };
    const pos = await this.activeExecutor.openPosition(coin, quote, { ...activeEv, side: targetSide, qualified: true }, profile);
    if (!pos) {
      const reason = this._blockReason(
        { symbol: wanted, side: targetSide, excluded: false, stale: false, tradable: true, cooling: false, price: coin.price },
        s
      );
      const sizing = this._allocationFor(toNum(coin.price, 0), profile);
      return {
        ok: false,
        error: "cannot-open",
        reason: reason || "unknown",
        available: this._equitySnapshot().available,
        requiredMargin: round(sizing.margin, 2),
      };
    }
    return { ok: true, position: pos };
  }

  /* ------------------------------------------------------------------ */
  /* Views / API payloads                                               */
  /* ------------------------------------------------------------------ */

  async refreshMarketsIfStale(maxAgeMs = MARKET_CACHE_MS) {
    if (this.marketCache.coins.length && now() - this.marketCache.at <= maxAgeMs) return this.marketCache;
    return this._marketData(true);
  }

  getPositionsView() {
    const t = now();
    return this.state.positions.map((p) => {
      const price = toNum(p.markPrice, p.entryPrice);
      const m = positionMetrics(p, price);
      const partialNet = (p.partials || []).reduce((a, x) => a + toNum(x.net, 0), 0);
      const netTotal = partialNet + m.net - toNum(p.entryFee, 0);
      const roeTotal = (netTotal / Math.max(1e-9, p.margin)) * 100;
      const stop = p.trailingActive ? p.trailStopPrice : p.slPrice;
      const dir = p.side === "long" ? 1 : -1;
      const span = Math.abs(p.tp1Percent + p.slPercent) || 1;
      const progress = clamp(((m.grossRoe + p.slPercent) / span) * 100, 0, 100);
      return {
        id: p.id,
        symbol: p.symbol,
        side: p.side,
        venue: p.venue,
        venueName: p.markVenue && p.markVenue !== p.venue ? `${p.venueName}→${p.markVenue}` : p.venueName,
        source: p.source,
        entryTime: p.entryTime,
        ageMs: t - p.entryTime,
        entryPrice: p.entryPrice,
        markPrice: price,
        markTs: p.markTs,
        priceStale: Boolean(p.priceStale),
        qty: p.qty,
        originalQty: p.originalQty,
        margin: p.margin,
        notional: p.notional,
        leverage: p.leverage,
        grossPnl: m.gross,
        exitFee: m.exitFee,
        netPnl: m.net,
        netTotal,
        roe: roeTotal,
        grossRoe: m.grossRoe,
        slPrice: p.slPrice,
        stopPrice: stop,
        tp1Price: p.tp1Price,
        tpMaxPrice: p.tpMaxPrice,
        liqPrice: p.liqPrice,
        tp1Hit: p.tp1Hit,
        trailingActive: p.trailingActive,
        trailStopPrice: p.trailStopPrice,
        peakRoe: p.peakRoe,
        progress,
        entryFee: p.entryFee,
        partials: p.partials,
        criteria: p.criteria,
        signal: p.signal,
        distanceTp1: ((p.tp1Price / price - 1) * 100) * dir,
        distanceStop: ((stop / price - 1) * 100) * dir,
      };
    });
  }

  getTrades({ limit = 200, offset = 0 } = {}) {
    const sorted = [...this.state.trades].sort((a, b) => (b.exitTime || 0) - (a.exitTime || 0));
    const total = sorted.length;
    const lim = clamp(toNum(limit, 200), 1, 5000);
    const off = Math.max(0, toNum(offset, 0));
    return { total, trades: sorted.slice(off, off + lim), offset: off, limit: lim };
  }

  getMeta() {
    const stats = this.getStats();
    const max = toNum(this.state.settings.maxTrades, 0) ?? 0;
    return {
      ...this.state.meta,
      running: Boolean(this.state.meta.running),
      scanning: this.scanning,
      serverTime: now(),
      filtersConfigured: enabledFilterCount(this.state.settings),
      marketTotal: this.marketCache.coins.length,
      marketFetchedAt: this.marketCache.at || null,
      marketError: this.marketCache.error,
      marketAgeMs: this.marketCache.at ? now() - this.marketCache.at : null,
      coinglass: this.getMarketStatus(),
      coinglassKeySet: Boolean(String(this.state.settings.coinglassApiKey || "").trim()),
      tradesRemaining: max > 0 ? Math.max(0, max - stats.totalTrades) : null,
      maxTrades: max,
      maxOpenPositions: this.state.settings.maxOpenPositions,
      available: stats.available,
    };
  }

  getLive() {
    return {
      serverTime: now(),
      meta: this.getMeta(),
      stats: this.getStats(),
      positions: this.getPositionsView(),
      equityCurve: this.state.equityCurve.slice(-400),
      logs: this.state.logs.slice(-80),
      venues: this.hub.summary(),
    };
  }

  getBootstrap() {
    const stats = this.getStats();
    return {
      serverTime: now(),
      settings: this.publicSettings(),
      initialFund: this.state.initialFund,
      meta: this.getMeta(),
      stats,
      positions: this.getPositionsView(),
      markets: this.getMarketRows(),
      trades: this.getTrades({ limit: 100 }).trades,
      tradesTotal: this.state.trades.length,
      equityCurve: this.state.equityCurve,
      logs: this.state.logs.slice(-100),
      venues: this.hub.summary(),
    };
  }

  getReportData() {
    return {
      generatedAt: now(),
      settings: this.publicSettings(),
      initialFund: this.state.initialFund,
      meta: this.getMeta(),
      stats: this.getStats(),
      positions: this.getPositionsView(),
      trades: [...this.state.trades].sort((a, b) => (a.exitTime || 0) - (b.exitTime || 0)),
      equityCurve: this.state.equityCurve,
      logs: this.state.logs.slice(-30),
      venues: this.hub.summary(),
    };
  }

  destroy() {
    this._destroyed = true;
    if (this._scanTimer) this.timers.clearTimeout(this._scanTimer);
    if (this._priceTimer) this.timers.clearTimeout(this._priceTimer);
    this.store.flush();
  }
}
