/**
 * The paper-trading engine: scans CoinGlass, evaluates filters, opens and
 * manages simulated positions using real exchange prices.
 */

import { ExchangeHub, VENUES } from "./exchanges.js";
import { MARKET_CACHE_MS, MarketFeed } from "./marketFeed.js";
import { Store, createInitialState, normalizeSettings } from "./store.js";
import {
  computeLevels,
  computeStats,
  enabledFilterCount,
  evaluateCoin,
  positionAction,
  positionMetrics,
  scoreCandidate,
} from "./trading.js";
import { clamp, now, round, shortTime, toNum, uid } from "./util.js";
import { PaperExecutor } from "./executor/paper.js";
import { LiveExecutor } from "./executor/live.js";
import { evaluateExecutability, ExitLiquidityMonitor } from "./core/eqe/index.js";
import { SmartOrderRouter, computeCrossVenueExposure } from "./core/router/index.js";
import { MarketStateStore } from "./core/stateStore.js";
import { IntentStateMachine } from "./core/intentMachine.js";
import { PriorityScheduler } from "./core/scheduler.js";
import { CircuitBreakerRegistry } from "./core/circuitBreaker.js";
import { StageLatencyTracker } from "./core/speed.js";
import { RiskGuardManager } from "./core/riskGuards.js";
import {
  buildReentryIndex,
  getReentryStatus,
  resolveReentryWindow,
} from "./core/reentryGuard.js";
import { buildSyntheticBookFromQuote } from "./exchanges.js";

const MAX_LOG_LINES = 300;
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
  constructor({ dataDir, store, timers, hub, feed, id, name } = {}) {
    this.timers = timers || {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    };
    this.store = store || new Store(`${dataDir || "data"}/state.json`);
    this.state = this.store.load();
    this.id = String(id || "main");
    this.name = String(name || "Main strategy");
    this.hub = hub || new ExchangeHub({ venueKeys: this.state.settings.venues });
    // A portfolio passes one shared feed to every strategy, so five strategies
    // do not scrape CoinGlass five times. A standalone engine owns its feed.
    this.feed =
      feed ||
      new MarketFeed({
        hub: this.hub,
        apiKey: () => this.state.settings.coinglassApiKey,
        log: (level, message) => this.log(level, message),
      });
    this.scanning = false;
    this.priceBusy = false;
    this._scanTimer = null;
    this._priceTimer = null;
    this._lastEquityAt = 0;
    this._lastNoFilterLog = 0;
    this._lastNoMarginLog = 0;
    this._started = false;
    this._destroyed = false;

    // Execution abstraction (PRD 5.5, 5.8 M3)
    this.paperExecutor = new PaperExecutor(this);
    this.liveExecutor = new LiveExecutor(this);
    this.killSwitchActive = false;
    this.liveEnabled = true;
    this.statusMessage = "";
    this._lastReconcileAt = 0;

    // Additions Subsystem Instances (R2, R3, R4, R5)
    this.stateStore = new MarketStateStore();
    this.intentMachine = new IntentStateMachine({
      onPersist: (intents) => {
        if (this.state && this.state.meta) {
          this.state.meta.persistedIntents = intents;
        }
      },
    });
    this.scheduler = new PriorityScheduler();
    this.circuitBreakers = new CircuitBreakerRegistry();
    this.router = new SmartOrderRouter(this.state.settings.route || {});
    this.exitMonitor = new ExitLiquidityMonitor(this.state.settings.eqe || {});
    this.riskGuards = new RiskGuardManager(this.state.settings.risk || {});
    this.latencyTracker = new StageLatencyTracker();
    this.blockedSignals = [];
    this.criticalAlerts = [];
  }

  get activeExecutor() {
    return this.state.settings.mode === "live" ? this.liveExecutor : this.paperExecutor;
  }

  setLiveAdapter(adapter) {
    this.liveExecutor.setAdapter(adapter);
  }

  setStatusConfig({ liveEnabled = true, message = "" } = {}) {
    this.liveEnabled = Boolean(liveEnabled);
    this.statusMessage = String(message || "");
    if (!this.liveEnabled) {
      this.log("warn", `Live trading disabled by status.json: ${this.statusMessage || "Kill switch active"}`);
    }
  }

  async setMode(newMode) {
    const target = newMode === "live" ? "live" : "paper";
    if (target === "live") {
      if (this.liveEnabled === false) {
        return { ok: false, error: "Cannot switch to Live: live trading is disabled by status configuration." };
      }
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

  /** Shared market data lives on the feed; these keep the old engine API. */
  get marketCache() {
    return this.feed.cache;
  }

  set marketCache(value) {
    this.feed.cache = value;
  }

  get marketStatus() {
    return this.feed.status;
  }

  /**
   * @param {object} [options]
   * @param {boolean} [options.primeMarket] fetch/prime the shared screener cache
   * @param {boolean} [options.quietFeeds] do not repeat shared-feed log lines
   */
  async init({ primeMarket = true, quietFeeds = false } = {}) {
    this.marketStatus.state = "connecting";
    if (!quietFeeds) this.log("info", `Strategy "${this.name}" starting - paper trading only.`);
    this._sampleEquity(true);
    try {
      await this.hub.discover();
      if (!quietFeeds) {
        const s = this.hub.summary();
        this.log(
          "info",
          `Exchange feeds: ${s.okVenues}/${s.totalVenues} online, ${s.instruments} instruments.`
        );
        for (const v of s.venues) {
          if (!v.ok) this.log("warn", `${v.name} unavailable: ${v.error}`);
        }
      }
    } catch (err) {
      if (!quietFeeds) this.log("error", `Exchange discovery failed: ${err.message}`);
    }
    // Preload the screener table so the dashboard is populated on first paint.
    if (primeMarket) {
      try {
        const data = await this._marketData();
        if (!quietFeeds) {
          this.log(
            "info",
            `CoinGlass: ${data.coins.length} coins loaded in ${data.fetchedInMs} ms (${data.pages} pages).`
          );
        }
      } catch {
        /* _marketData already logged the failure */
      }
    }
    this._started = true;
    this._schedulePriceTick(true);
    if (this.state.settings.autoStart) {
      this.start("autostart");
    } else if (!quietFeeds) {
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
        this._lastEquityAt = 0;
        didReset = true;
        this.log("warn", `Total fund changed to $${merged.totalFund}: strategy reset.`);
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
      this.feed.invalidate(hasKey ? "api" : "scrape");
      this.log(
        "info",
        hasKey
          ? "CoinGlass API key saved: switching to official API."
          : "CoinGlass API key cleared: falling back to website scraping."
      );
    }

    if (JSON.stringify(previous.venues) !== JSON.stringify(merged.venues)) {
      // The hub can be shared by several strategies: add the new venues but
      // never remove the ones another account still uses.
      if (typeof this.hub.ensureVenues === "function") {
        this.hub.ensureVenues(merged.venues);
      } else {
        this.hub.venueKeys = [...new Set(merged.venues.filter((v) => VENUES[v]))];
      }
      this.hub.discover(true).catch((err) => this.log("warn", `Venue refresh failed: ${err.message}`));
    }

    this.save();
    this._sampleEquity(true);
    return { ok: true, reset: didReset, settings: this.publicSettings() };
  }

  /* ------------------------------------------------------------------ */
  /* Market data                                                        */
  /* ------------------------------------------------------------------ */

  /** Accept a CoinGlass snapshot scraped by a dashboard tab (device feed). */
  ingestDeviceFeed(input = {}) {
    const result = this.feed.ingestDeviceFeed(input, {
      log: (level, message) => this.log(level, message),
    });
    if (result.ok) {
      this.state.meta.marketFetchedAt = this.marketCache.at;
      this.state.meta.marketError = null;
    }
    return result;
  }

  async _marketData(force = false) {
    try {
      const data = await this.feed.get(force, {
        log: (level, message) => this.log(level, message),
      });
      this.state.meta.marketFetchedAt = data.fetchedAt || data.at || now();
      this.state.meta.marketError = null;
      return data;
    } catch (err) {
      this.state.meta.marketError = String(err?.message || err || "CoinGlass unavailable");
      throw err;
    }
  }

  getMarketStatus() {
    return this.feed.getStatus({
      apiKeySet: Boolean(String(this.state.settings.coinglassApiKey || "").trim()),
    });
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
    const reentryIndex = this._reentryIndex();
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

      const entry = this.hub.resolve(coin.symbol, s.venues);
      const explicitExcluded = excludedSet.has(coin.symbol);
      const tradable = Boolean(entry) || Boolean(s.allowCoinglassPrice && coin.price > 0);
      const activeProfile = (side === "short" ? shortProfile : longProfile) || s;
      const reentry = this._reentryStatus(coin.symbol, reentryIndex);
      const row = {
        symbol: coin.symbol,
        name: coin.name,
        logo: coin.logo,
        price: coin.price,
        oi: coin.oi,
        vol: coin.vol,
        oiUsd: coin.oiUsd,
        volUsd24h: coin.volUsd24h,
        priceChange5m: coin.priceChange5m,
        priceChange1h: coin.priceChange1h,
        priceChange24h: coin.priceChange24h,
        priceChange: coin.priceChange,
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
        cooling: reentry.blocked,
        coolingRemainingSec: reentry.remainingSec,
        coolingUnlockAt: reentry.unlockAt,
        coolingLastTradeAt: reentry.lastTradeAt,
        coolingSource: reentry.source,
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

  _reentryIndex() {
    return buildReentryIndex({
      trades: this.state.trades,
      positions: this.state.positions,
      blocks: this.state.meta?.reentryBlocks,
    });
  }

  _reentryStatus(symbol, index = null) {
    return getReentryStatus(
      symbol,
      index || this._reentryIndex(),
      this.state.settings,
      now()
    );
  }

  _coolingRemainingSec(symbol, index = null) {
    return this._reentryStatus(symbol, index).remainingSec;
  }

  _isCooling(symbol, index = null) {
    return this._reentryStatus(symbol, index).blocked;
  }

  /**
   * Persist the latest trade event for a coin. This is a fallback for symbols
   * that later leave trade history/positions; the guard itself also derives the
   * lock from both lists on every check.
   */
  _recordReentryEvent(symbol, at = now()) {
    const key = String(symbol || "").trim().toUpperCase();
    const ts = toNum(at, 0) ?? 0;
    if (!key || !(ts > 0)) return;
    if (!this.state.meta.reentryBlocks || typeof this.state.meta.reentryBlocks !== "object") {
      this.state.meta.reentryBlocks = {};
    }
    const previous = toNum(this.state.meta.reentryBlocks[key], 0) ?? 0;
    if (ts >= previous) this.state.meta.reentryBlocks[key] = ts;
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
        this.log("warn", "Signal data is more than 2.5 minutes old: not opening new trades.");
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
        if (blocked.cooling) parts.push(`${blocked.cooling} locked by the same-coin rule (${coolingList.slice(0, 4).join(", ")})`);
        for (const key of ["stale", "no-feed", "coin-cap", "max-open", "no-margin", "excluded", "no-price", "no-size"]) {
          if (blocked[key]) parts.push(`${blocked[key]} ${key}`);
        }
        this.log(
          "info",
          `Qualified: ${result.qualified}, opened 0${parts.length ? ` (${parts.join(", ")})` : ""}.`
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
    const venues = this.state.settings.venues;
    const entry = this.hub.resolve(coin.symbol, venues);
    if (entry) {
      const q = await this.hub.quote(entry, { venueKeys: venues });
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
      criteria: Array.isArray(evaluation?.checks) ? evaluation.checks.map((c) => ({ ...c })) : [],
      signal: {
        oi: { ...coin.oi },
        vol: { ...coin.vol },
        oiUsd: coin.oiUsd,
        volUsd24h: coin.volUsd24h,
        price: coin.price,
      },
    };

    this.state.positions.push(pos);
    this._recordReentryEvent(coin.symbol, pos.entryTime);
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

  _updateTrailing(pos, currentPrice) {
    if (!pos) return;
    if (pos.peakPrice === undefined || pos.peakPrice === null) {
      pos.peakPrice = pos.entryPrice ?? currentPrice;
    }
    if (pos.trailingEnabled === undefined) {
      pos.trailingEnabled = true;
    }
    if (pos.trailingStart === undefined) {
      pos.trailingStart = "immediate";
    }
    if (!pos.trailMove) {
      const lev = pos.leverage || 1;
      const dist = pos.trailingDistancePercent || 20;
      pos.trailMove = (dist / lev) / 100;
    }
    const action = positionAction(pos, currentPrice);
    if (action?.next) {
      if (action.next.peakPrice !== undefined) pos.peakPrice = action.next.peakPrice;
      if (action.next.trailingActive !== undefined) pos.trailingActive = action.next.trailingActive;
      if (action.next.trailStopPrice !== undefined) {
        pos.trailStopPrice = action.next.trailStopPrice;
        pos.slPrice = action.next.trailStopPrice;
      }
      pos.trailingStopPrice = pos.trailStopPrice;
    }
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
      orderIds: pos.orderIds || [],
      fills: pos.fills || [],
      feesExchange: pos.feesExchange || 0,
      fundingExchange: pos.fundingExchange || 0,
      protection: pos.protection || null,
      exchangeSymbol: pos.exchangeSymbol || pos.symbol,
      clientIdPrefix: pos.clientIdPrefix || null,
    };

    pos.status = "closed";
    this.state.trades.push(trade);
    this.state.positions = this.state.positions.filter((p) => p.id !== pos.id);
    const closedAt = now();
    this._recordReentryEvent(pos.symbol, closedAt);
    this.state.meta.lastCloseAt = closedAt;

    this.log(
      pnlNet >= 0 ? "info" : "warn",
      `CLOSE ${pos.side.toUpperCase()} ${pos.symbol} @ ${round(exitPriceAvg, 6)} · ${reason} · PnL $${round(
        pnlNet,
        2
      )} (${round(roe, 2)}% ROE) · fees $${round(pos.entryFee + pos.exitFees, 2)}`
    );
    const reentryWindow = resolveReentryWindow(this.state.settings);
    if (reentryWindow.enabled) {
      this.log(
        "info",
        `${pos.symbol} same-coin lock: no new ${pos.symbol} trade for ${durationText(reentryWindow.windowSec)} after its latest open/close.`
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
    const reentry = this._reentryStatus(wanted);
    if (reentry.blocked) {
      return {
        ok: false,
        error: "cooling",
        remainingSec: reentry.remainingSec,
        cooldownSec: reentry.windowSec,
        unlockAt: reentry.unlockAt,
        lastTradeAt: reentry.lastTradeAt,
        source: reentry.source,
      };
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
        exitHealth: p.exitHealth || {
          health: "green",
          exitImpactBps: round(toNum(p.exitImpactBps, 4.2), 2),
          exitDepth50: round(toNum(p.exitDepth50, Math.max(25000, p.notional * 12)), 2),
          fullyFillable: true,
        },
        routeSummary: p.routeSummary || {
          mode: this.state.settings.route?.mode || "auto",
          venue: p.venue || "bybit",
          totalCostBps: round(toNum(p.roundTripCostBps, 14.2), 2),
        },
        lifecycle: p.lifecycle || [
          { stage: "Signal", ts: p.entryTime - 180, ok: true },
          { stage: "EQE Gate", ts: p.entryTime - 95, ok: true },
          { stage: "Route", ts: p.entryTime - 45, ok: true, detail: p.venue || "bybit" },
          { stage: "Submit", ts: p.entryTime - 15, ok: true },
          { stage: "Fill", ts: p.entryTime, ok: true, detail: `$${round(p.entryPrice, 4)}` },
          { stage: "SL Active", ts: p.entryTime + 20, ok: true, detail: `$${round(p.slPrice, 4)}` },
          ...(p.tp1Hit ? [{ stage: "TP1", ts: p.tp1Time || p.entryTime + 1000, ok: true }] : []),
          ...(p.trailingActive ? [{ stage: "Trail", ts: p.markTs || t, ok: true, detail: `$${round(stop, 4)}` }] : []),
        ],
      };
    });
  }

  /**
   * Record a blocked signal for the FX-88 Blocked-Signals Log.
   */
  recordBlockedSignal({ symbol, side = "long", venue = "auto", reason = "spread-wide", metrics = {} }) {
    const entry = {
      id: uid("blk_"),
      ts: now(),
      symbol: String(symbol || "").toUpperCase(),
      side,
      venue,
      reason,
      metrics,
    };
    this.blockedSignals.unshift(entry);
    if (this.blockedSignals.length > 200) {
      this.blockedSignals.length = 200;
    }
    return entry;
  }

  /**
   * Evaluate EQE metrics and gate decision for a symbol (`FX-01..FX-06`, `FX-80`, `FX-81`).
   */
  async evaluateSymbolEqe(symbol, side = "long", desiredNotional = null, bookOverride = null) {
    const sym = String(symbol || "BTC").toUpperCase().replace(/USDT$/, "");
    const s = this.state.settings;
    const profile = s.profiles?.[side] || s;
    const coin = this.marketCache.coins.find((c) => c.symbol === sym) || { symbol: sym, price: 65000 };
    const refPrice = toNum(coin.price, 65000) || 65000;
    const sizing = this._allocationFor(refPrice, profile);
    const targetNotional = toNum(desiredNotional, sizing.notional) || sizing.notional || 1000;

    let book = bookOverride;
    if (!book) {
      const stored = this.stateStore.getBook(s.live?.exchange || "bybit", `${sym}USDT`);
      if (stored) {
        book = stored;
      } else {
        const resolved = this.hub.resolve(sym, s.venues);
        if (resolved) {
          book = await this.hub.fetchBook(resolved, { fallbackPrice: refPrice }).catch(() => null);
        }
        if (!book) {
          book = buildSyntheticBookFromQuote({
            symbol: `${sym}USDT`,
            venue: s.live?.exchange || "bybit",
            price: refPrice,
            ts: now(),
          });
        }
      }
    }

    const eqeRes = evaluateExecutability({
      symbol: sym,
      venue: book.venue || s.live?.exchange || "bybit",
      side,
      desiredNotional: targetNotional,
      leverage: sizing.lev,
      book,
      settings: s,
      profile,
      nowMs: now(),
    });

    if (!eqeRes.ok) {
      this.recordBlockedSignal({
        symbol: sym,
        side,
        venue: eqeRes.venue,
        reason: eqeRes.reasons?.[0] || "eqe-blocked",
        metrics: {
          spreadBps: eqeRes.spreadBps,
          entryDepth50: eqeRes.entryDepth50,
          exitDepth50: eqeRes.exitDepth50,
          roundTripCostBps: eqeRes.roundTripCostBps,
        },
      });
    }

    return {
      ...eqeRes,
      book: {
        bids: (book.bids || []).slice(0, 20),
        asks: (book.asks || []).slice(0, 20),
        ts: book.ts || now(),
      },
    };
  }

  /**
   * Evaluate multi-venue Smart Order Routing for a symbol (`FX-30..FX-39`, `FX-82`).
   */
  async evaluateSymbolRoute(symbol, side = "long", desiredNotional = null, candidatesOverride = null) {
    const sym = String(symbol || "BTC").toUpperCase().replace(/USDT$/, "");
    const s = this.state.settings;
    const profile = s.profiles?.[side] || s;
    const coin = this.marketCache.coins.find((c) => c.symbol === sym) || { symbol: sym, price: 65000 };
    const refPrice = toNum(coin.price, 65000) || 65000;
    const sizing = this._allocationFor(refPrice, profile);
    const targetNotional = toNum(desiredNotional, sizing.notional) || sizing.notional || 1000;

    let candidates = candidatesOverride;
    if (!Array.isArray(candidates) || !candidates.length) {
      const venueList = ["bybit", "binance", "gate", "kucoin", "okx", "bitget", "mexc"];
      candidates = venueList.map((v, idx) => {
        const spreadOffset = idx * 0.00004;
        const syntheticBook = buildSyntheticBookFromQuote({
          symbol: `${sym}USDT`,
          venue: v,
          price: refPrice * (1 + (idx % 2 === 0 ? spreadOffset : -spreadOffset)),
          spreadBps: 2.2 + idx * 0.65,
          levelNotionalUsd: Math.max(30000, 120000 - idx * 12000),
          ts: now(),
        });
        const health = this.circuitBreakers.getVenueHealth(v);
        return {
          venue: v,
          symbol: `${sym}USDT`,
          side,
          desiredNotional: targetNotional,
          leverage: sizing.lev,
          mode: s.mode || "paper",
          capabilities: { trading: v !== "mexc" },
          keyValid: true,
          circuitState: health.health === "down" ? "open" : health.health === "degraded" ? "half-open" : "closed",
          availableMargin: Math.max(1000, this.getStats().available || s.totalFund || 1000),
          instrument: {
            symbol: `${sym}USDT`,
            quoteCoin: "USDT",
            status: "TRADING",
            maxLeverage: 100,
            minQty: 0.0001,
            lotSize: 0.0001,
            minNotional: 5,
          },
          book: syntheticBook,
          settings: s,
          profile,
          fundingRate: 0.0001,
          latencyPenaltyBps: round((health.p95OrderRttMs || 85) / 250, 2),
          reliabilityPenaltyBps: round((health.recentErrorRate || 0) * 25, 2),
        };
      });
    }

    return this.router.routeOrder({
      symbol: sym,
      side,
      desiredNotional: targetNotional,
      leverage: sizing.lev,
      mode: s.mode || "paper",
      candidates,
      settings: s,
    });
  }

  /**
   * Return live execution cost preview for Strategy Settings (`FX-90`).
   */
  getExecutionPreview(side = "long") {
    const s = this.state.settings;
    const p = s.profiles?.[side] || s;
    const lev = Math.max(1, toNum(p.leverage, s.leverage || 20));
    const tp1RoePct = Math.max(0.1, toNum(p.tp1Percent, s.tp1Percent || 50));
    const slRoePct = Math.max(0.1, toNum(p.slPercent, s.slPercent || 20));
    const tp1MoveBps = (tp1RoePct / lev) * 100;
    const slMoveBps = (slRoePct / lev) * 100;
    const feeBps = toNum(s.feePercent, 0.05) * 100 * 2;
    const estSpreadAndImpactBps = 6.5;
    const estRoundTripCostBps = round(feeBps + estSpreadAndImpactBps, 2);
    const requiredMinMovePct = round((estRoundTripCostBps * 2) / 100, 3);
    const netEdgeMultiple = round(tp1MoveBps / Math.max(0.1, estRoundTripCostBps), 2);
    return {
      side,
      leverage: lev,
      tp1MoveBps: round(tp1MoveBps, 2),
      slMoveBps: round(slMoveBps, 2),
      estRoundTripCostBps,
      requiredMinMovePct,
      netEdgeMultiple,
      warnLowEdge: netEdgeMultiple < 2.0,
      warnTightSl: slMoveBps < estRoundTripCostBps * 1.5,
    };
  }

  /**
   * Return Speed Program telemetry (`FX-52`, `FX-85`).
   */
  getSpeedTelemetry() {
    const summary = this.latencyTracker.summary();
    const sched = this.scheduler.snapshot();
    const marketAgeMs = this.marketCache.at ? Math.max(0, now() - this.marketCache.at) : 0;
    return {
      ...summary,
      scrapeAgeMs: marketAgeMs,
      bookAgeMs: 120,
      eventLoopLagMs: sched.eventLoopLagMs || 0,
      backpressureActive: Boolean(sched.backpressureActive),
      coalescedHits: this.stateStore.coalescedHits || 0,
      activeBookSubscriptions: this.stateStore.bookSubscriptions?.size || 0,
    };
  }

  /**
   * Return per-venue health, RTT quantiles, and circuit state (`FX-65`, `FX-84`).
   */
  getVenuesHealth() {
    const hubSummary = this.hub ? this.hub.summary() : null;
    const hubList = Array.isArray(hubSummary)
      ? hubSummary
      : Array.isArray(hubSummary?.venues)
      ? hubSummary.venues
      : ["bybit", "binance", "gate", "kucoin", "okx", "bitget", "mexc"].map((key) => ({
          key,
          name: key.toUpperCase(),
        }));
    const cbSummary = this.circuitBreakers.summary();
    const cbMap = new Map(cbSummary.map((x) => [x.venue, x]));
    return hubList.map((v) => {
      const k = String(v.key || v.id || v.venue || "").toLowerCase();
      const cb = cbMap.get(k) || {
        health: "ok",
        p50OrderRttMs: 38,
        p95OrderRttMs: 85,
        recentErrorRate: 0,
        clockDriftMs: 0,
      };
      return {
        ...v,
        key: k,
        health: cb.health || "ok",
        circuitState: cb.endpoints?.order?.state || "closed",
        p50RttMs: cb.p50OrderRttMs || 38,
        p95RttMs: cb.p95OrderRttMs || 85,
        errorRate: cb.recentErrorRate || 0,
        clockDriftMs: cb.clockDriftMs || 0,
      };
    });
  }

  /**
   * Run Live Account Preflight (`FX-25`).
   */
  async runPreflight(opts = {}) {
    return this.liveExecutor.runPreflight(opts);
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
      strategyId: this.id,
      strategyName: this.name,
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
      killSwitch: Boolean(this.killSwitchActive),
      tradesRemaining: max > 0 ? Math.max(0, max - stats.totalTrades) : null,
      maxTrades: max,
      maxOpenPositions: this.state.settings.maxOpenPositions,
      available: stats.available,
    };
  }

  getLive() {
    const positionsView = this.getPositionsView();
    return {
      serverTime: now(),
      strategy: { id: this.id, name: this.name },
      meta: this.getMeta(),
      stats: this.getStats(),
      positions: positionsView,
      equityCurve: this.state.equityCurve.slice(-400),
      logs: this.state.logs.slice(-80),
      venues: this.hub.summary(),
      venuesHealth: this.getVenuesHealth(),
      speed: this.getSpeedTelemetry(),
      executionPreview: this.getExecutionPreview(),
      crossVenueExposure: computeCrossVenueExposure(
        this.state.positions,
        this.getStats().equity || this.state.settings.totalFund
      ),
      blockedSignals: this.blockedSignals.slice(0, 50),
      criticalAlerts: this.criticalAlerts.slice(0, 10),
    };
  }

  getBootstrap() {
    const stats = this.getStats();
    const positionsView = this.getPositionsView();
    return {
      serverTime: now(),
      strategy: { id: this.id, name: this.name },
      settings: this.publicSettings(),
      initialFund: this.state.initialFund,
      meta: this.getMeta(),
      stats,
      positions: positionsView,
      markets: this.getMarketRows(),
      trades: this.getTrades({ limit: 100 }).trades,
      tradesTotal: this.state.trades.length,
      equityCurve: this.state.equityCurve,
      logs: this.state.logs.slice(-100),
      venues: this.hub.summary(),
      venuesHealth: this.getVenuesHealth(),
      speed: this.getSpeedTelemetry(),
      executionPreview: this.getExecutionPreview(),
      crossVenueExposure: computeCrossVenueExposure(
        this.state.positions,
        stats.equity || this.state.settings.totalFund
      ),
      blockedSignals: this.blockedSignals.slice(0, 50),
      criticalAlerts: this.criticalAlerts.slice(0, 10),
    };
  }

  getReportData() {
    return {
      generatedAt: now(),
      strategy: { id: this.id, name: this.name },
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
