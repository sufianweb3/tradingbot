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
    this._cooldowns = new Map();
    this._lastEquityAt = 0;
    this._lastNoFilterLog = 0;
    this._lastNoMarginLog = 0;
    this._started = false;
    this._destroyed = false;
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
    if (!quietFeeds) this.log("info", `Strategy "${this.name}" starting — paper trading only.`);
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
      this.feed.invalidate(hasKey ? "api" : "scrape");
      this.log(
        "info",
        hasKey
          ? "CoinGlass API key saved — switching to the official API."
          : "CoinGlass API key cleared — falling back to website scraping."
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
    return this.feed.get(force, { log: (level, message) => this.log(level, message) });
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
    const rows = [];

    for (const coin of this.marketCache.coins) {
      const ev = evaluateCoin(coin, s);
      const entry = this.hub.resolve(coin.symbol, s.venues);
      const explicitExcluded = excludedSet.has(coin.symbol);
      const tradable = Boolean(entry) || Boolean(s.allowCoinglassPrice && coin.price > 0);
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
        maxPerCoin: Math.max(1, toNum(s.maxPositionsPerCoin, 1) ?? 1),
        cooling: this._isCooling(coin.symbol),
        coolingRemainingSec: this._coolingRemainingSec(coin.symbol),
        configured: ev.configured,
        qualified: ev.qualified,
        side: ev.side,
        passCount: ev.passCount,
        total: ev.total,
        score: ev.configured ? round(scoreCandidate(coin, ev), 4) : 0,
      };
      if (row.oiUsd < s.minOiUsd || coin.volUsd24h < s.minVolUsd24h) row.tradable = false;
      row.blockReason = ev.qualified ? this._blockReason(row, s, available) : null;
      rows.push(row);
    }

    rows.sort((a, b) => {
      if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
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
    if (row.excluded) return "excluded";
    if (row.stale) return "stale";
    if (!row.tradable) return "no-feed";
    if (row.cooling) return "cooling";
    if (!this._canOpenMore(row.symbol)) return "coin-cap";
    if (this._maxOpenReached()) return "max-open";
    if (!(toNum(row.price, 0) > 0)) return "no-price";
    const sizing = this._allocationFor(toNum(row.price, 0));
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

  getStats() {
    const marks = new Map(this.state.positions.map((p) => [p.id, toNum(p.markPrice, p.entryPrice)]));
    return computeStats({
      trades: this.state.trades,
      positions: this.state.positions,
      marks,
      initialFund: this.state.initialFund,
      equityCurve: this.state.equityCurve,
      feePercent: this.state.settings.feePercent,
    });
  }

  _maxTradesReached() {
    const max = toNum(this.state.settings.maxTrades, 0) ?? 0;
    return max > 0 && this.state.trades.length >= max;
  }

  _maxOpenReached() {
    const max = toNum(this.state.settings.maxOpenPositions, 0) ?? 0;
    return max > 0 && this.state.positions.length >= max;
  }

  /** Positions currently open on one coin. */
  _openCount(symbol) {
    return this.state.positions.filter((p) => p.symbol === symbol).length;
  }

  /** True when another position may be opened on this coin. */
  _canOpenMore(symbol) {
    const max = Math.max(1, toNum(this.state.settings.maxPositionsPerCoin, 1) ?? 1);
    return this._openCount(symbol) < max;
  }

  _allocationFor(price) {
    const s = this.state.settings;
    const lev = Math.max(1, toNum(s.leverage, 1));
    if (s.sizingMode === "fixedQty") {
      const qty = toNum(s.fixedQty, 0);
      const notional = qty * price;
      return { margin: notional / lev, qty, notional, lev };
    }
    let margin;
    if (s.sizingMode === "fixedMargin") {
      margin = toNum(s.fixedMargin, 0) ?? 0;
    } else {
      const base =
        s.allocationBase === "equity" ? this._equitySnapshot().equity : toNum(s.totalFund, 0);
      margin = (base * toNum(s.allocationPercent, 50)) / 100;
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

      const filters = enabledFilterCount(s);
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
          this._canOpenMore(r.symbol)
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
        if (this._maxTradesReached()) break;
        if (this._maxOpenReached()) break;
        const coin = coinMap.get(row.symbol);
        if (!coin) continue;
        const ev = evaluateCoin(coin, s);
        if (!ev.qualified || !ev.side) continue;
        const quote = await this._resolveQuote(coin);
        if (!quote) continue;
        const pos = this._openPosition(coin, quote, ev);
        if (pos) {
          opened.push(pos.symbol);
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

  _openPosition(coin, quote, evaluation) {
    const s = this.state.settings;
    const side = evaluation.side;
    if (side !== "long" && side !== "short") return null;
    if (!this._canOpenMore(coin.symbol)) return null;
    if (this._maxOpenReached()) return null;
    if (this._isCooling(coin.symbol)) return null;

    const price = toNum(quote.price);
    if (!(price > 0)) return null;
    const fillPrice = applySlippage(price, side, "entry", s.slippagePercent);
    if (!(fillPrice > 0)) return null;

    const sizing = this._allocationFor(fillPrice);
    const margin = sizing.margin;
    const qty = sizing.qty;
    const notional = sizing.notional;
    if (!(margin > 0) || !(qty > 0)) return null;

    // Free margin excludes fees already paid. Tolerate the prospective entry fee
    // so a 50%-of-fund allocation can actually fill two positions.
    const entryFee = notional * (toNum(s.feePercent, 0) / 100);
    const available = this._equitySnapshot().available;
    if (margin > available + entryFee + 1e-6) return null;

    const levels = computeLevels({ side, entry: fillPrice, settings: s });
    const pos = {
      id: uid("pos_"),
      status: "open",
      symbol: coin.symbol,
      side,
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
      trailingEnabled: Boolean(s.trailingEnabled),
      trailingStart: s.trailingStart,
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
      slPercent: s.slPercent,
      tp1Percent: s.tp1Percent,
      tpMaxPercent: s.tpMaxPercent,
      tp1ClosePercent: s.tp1ClosePercent,
      trailingDistancePercent: s.trailingDistancePercent,
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
      symbol: pos.symbol,
      side: pos.side,
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
    const trade = this._closePosition(pos, price, reason);
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

  async openManual(symbol, { force = true } = {}) {
    const s = this.state.settings;
    const wanted = String(symbol || "").toUpperCase();
    if (!wanted) return { ok: false, error: "symbol-required" };
    if (!this._canOpenMore(wanted)) {
      return {
        ok: false,
        error: "already-open",
        maxPerCoin: Math.max(1, toNum(s.maxPositionsPerCoin, 1) ?? 1),
      };
    }
    const cooling = this._coolingRemainingSec(wanted);
    if (cooling > 0) {
      return { ok: false, error: "cooling", remainingSec: cooling, cooldownSec: s.cooldownSec };
    }
    if (this._maxOpenReached()) return { ok: false, error: "max-open" };
    try {
      await this._marketData();
    } catch {
      /* use cache if available */
    }
    const coin = this.marketCache.coins.find((c) => c.symbol === wanted);
    if (!coin) return { ok: false, error: "coin-not-found" };
    const ev = evaluateCoin(coin, s);
    if (!force && !ev.qualified) return { ok: false, error: "criteria-not-met", evaluation: ev };
    const side = ev.side || (s.direction === "short" ? "short" : "long");
    const quote = await this._resolveQuote(coin);
    if (!quote) return { ok: false, error: "no-price-feed" };
    const pos = this._openPosition(coin, quote, { ...ev, side, qualified: true });
    if (!pos) {
      const reason = this._blockReason(
        { symbol: wanted, excluded: false, stale: false, tradable: true, cooling: false, price: coin.price },
        s
      );
      const sizing = this._allocationFor(toNum(coin.price, 0));
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
      tradesRemaining: max > 0 ? Math.max(0, max - stats.totalTrades) : null,
      maxTrades: max,
      maxOpenPositions: this.state.settings.maxOpenPositions,
      available: stats.available,
    };
  }

  getLive() {
    return {
      serverTime: now(),
      strategy: { id: this.id, name: this.name },
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
      strategy: { id: this.id, name: this.name },
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
