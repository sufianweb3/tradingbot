/**
 * Multi-strategy portfolio.
 *
 * Each strategy is a full paper-trading account with its own fund, settings,
 * trades, positions, equity curve and log. Strategies share one exchange hub
 * and one CoinGlass feed, so running 5-7 of them does not multiply the network
 * load: signals are fetched once and quotes are coalesced per instrument.
 *
 * Local persistence:
 *   data/state.json                  legacy single-account state (migrated as "main")
 *   data/strategies/index.json       portfolio config (names, order, selected)
 *   data/strategies/<strategy>.json  one account snapshot per strategy
 *
 * Cloudflare passes a storage adapter instead of using the filesystem.
 */

import fs from "node:fs";
import path from "node:path";

import { Engine } from "./engine.js";
import { ExchangeHub } from "./exchanges.js";
import { MarketFeed } from "./marketFeed.js";
import { Store, createInitialState, normalizeSettings } from "./store.js";
import { now, toNum, uid } from "./util.js";

export const MAX_STRATEGIES = 20;

function cleanName(value, fallback = "Strategy") {
  const name = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
  return name || fallback;
}

function emptyConfig() {
  return { version: 2, selectedId: null, createdAt: now(), strategies: [] };
}

function clone(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

export class Portfolio {
  /**
   * @param {object} [options]
   * @param {string} [options.dataDir] local data directory
   * @param {object} [options.timers] engine timers (Cloudflare alarm adapter)
   * @param {object} [options.hub] shared ExchangeHub (mainly for tests)
   * @param {object} [options.feed] shared MarketFeed (mainly for tests)
   * @param {object} [options.adapter] storage adapter for non-filesystem hosts
   * @param {boolean} [options.resume] resume strategies marked as running
   */
  constructor({ dataDir = "data", timers, hub, feed, adapter, resume = false } = {}) {
    this.dataDir = path.resolve(dataDir);
    this.strategiesDir = path.join(this.dataDir, "strategies");
    this.indexFile = path.join(this.strategiesDir, "index.json");
    this.timers = timers;
    this.resume = Boolean(resume);
    this.adapter = adapter || this._localAdapter();
    this.hub = hub || new ExchangeHub();

    /** @type {Map<string, import("./engine.js").Engine>} */
    this.engines = new Map();
    /** @type {Map<string, object>} */
    this.entries = new Map();
    this.order = [];

    this.feed =
      feed ||
      new MarketFeed({
        hub: this.hub,
        apiKey: () => this.marketApiKey(),
        log: (level, message) => this._primaryEngine()?.log(level, message),
      });

    this.config = emptyConfig();
    this._saveChain = Promise.resolve();
    this._destroyed = false;
  }

  _localAdapter() {
    const dataDir = this.dataDir;
    const strategiesDir = this.strategiesDir;
    const indexFile = this.indexFile;
    const fileFor = (entry) =>
      entry?.file
        ? path.resolve(dataDir, entry.file)
        : path.join(strategiesDir, `${entry.id}.json`);

    return {
      loadConfig: () => {
        try {
          return JSON.parse(fs.readFileSync(indexFile, "utf8"));
        } catch {
          return null;
        }
      },
      saveConfig: (config) => {
        fs.mkdirSync(strategiesDir, { recursive: true });
        const tmp = `${indexFile}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
        try {
          fs.renameSync(tmp, indexFile);
        } catch {
          fs.rmSync(indexFile, { force: true });
          fs.renameSync(tmp, indexFile);
        }
      },
      loadState: () => undefined,
      createStore: (entry) => new Store(fileFor(entry)),
      deleteStore: (entry) => {
        try {
          fs.rmSync(fileFor(entry), { force: true });
        } catch {
          /* already gone */
        }
      },
      legacyEntry: () => {
        const file = path.join(dataDir, "state.json");
        try {
          const stat = fs.statSync(file);
          if (!stat.isFile() || stat.size === 0) return null;
          return {
            id: "main",
            name: "Main strategy",
            createdAt: stat.mtimeMs || now(),
            file: "state.json",
          };
        } catch {
          return null;
        }
      },
    };
  }

  async init() {
    let loaded = null;
    try {
      loaded = await this.adapter.loadConfig();
    } catch {
      loaded = null;
    }

    if (loaded && Array.isArray(loaded.strategies) && loaded.strategies.length) {
      this.config = {
        version: 2,
        createdAt: toNum(loaded.createdAt, now()),
        selectedId: loaded.selectedId || null,
        strategies: loaded.strategies
          .filter((e) => e && e.id)
          .map((e) => ({
            ...e,
            id: String(e.id),
            name: cleanName(e.name, "Strategy"),
            createdAt: toNum(e.createdAt, now()),
            desiredRunning: Boolean(e.desiredRunning),
          })),
      };
    } else {
      // First boot of the multi-strategy build: adopt the old single account
      // instead of making the user lose their history.
      let legacy = null;
      try {
        legacy = await this.adapter.legacyEntry();
      } catch {
        legacy = null;
      }
      this.config = emptyConfig();
      this.config.strategies = [
        legacy
          ? {
              id: legacy.id || "main",
              name: cleanName(legacy.name, "Main strategy"),
              createdAt: toNum(legacy.createdAt, now()),
              file: legacy.file,
              storeKey: legacy.storeKey,
              desiredRunning: false,
            }
          : {
              id: "main",
              name: "Main strategy",
              createdAt: now(),
              desiredRunning: false,
            },
      ];
      this.config.selectedId = this.config.strategies[0].id;
      await this._saveConfig();
    }

    // Remove duplicate ids defensively: a corrupt index must not shadow an
    // account or start the same strategy twice.
    const seen = new Set();
    this.config.strategies = this.config.strategies.filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
    if (!this.config.strategies.length) {
      this.config.strategies.push({
        id: "main",
        name: "Main strategy",
        createdAt: now(),
        desiredRunning: false,
      });
    }
    if (!this.config.strategies.some((e) => e.id === this.config.selectedId)) {
      this.config.selectedId = this.config.strategies[0].id;
    }

    for (let i = 0; i < this.config.strategies.length; i++) {
      const entry = this.config.strategies[i];
      const saved = await this.adapter.loadState?.(entry);
      const store = await this.adapter.createStore(entry, saved);
      const engine = new Engine({
        store,
        timers: this.timers,
        hub: this.hub,
        feed: this.feed,
        id: entry.id,
        name: entry.name,
      });
      this.engines.set(entry.id, engine);
      this.entries.set(entry.id, entry);
      this.order.push(entry.id);
      await engine.init({ primeMarket: i === 0, quietFeeds: i > 0 });
    }

    if (this.resume) {
      for (const entry of this.config.strategies) {
        if (!entry.desiredRunning) continue;
        const engine = this.engines.get(entry.id);
        if (engine && !engine.state.meta.running) engine.start("resume");
      }
    }
    return this;
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                            */
  /* ------------------------------------------------------------------ */

  _primaryEngine() {
    return (
      this.engines.get(this.config.selectedId) ||
      this.engines.get(this.order[0]) ||
      null
    );
  }

  _entry(id) {
    return this.entries.get(String(id)) || null;
  }

  resolve(id) {
    return this.engines.get(String(id || "")) || null;
  }

  selected() {
    return this._primaryEngine();
  }

  selectedId() {
    return this._primaryEngine()?.id || null;
  }

  require(id) {
    const engine = this.resolve(id);
    if (!engine) {
      const error = new Error("strategy-not-found");
      error.code = "strategy-not-found";
      throw error;
    }
    return engine;
  }

  marketApiKey() {
    for (const engine of this.engines.values()) {
      const key = String(engine.state?.settings?.coinglassApiKey || "").trim();
      if (key) return key;
    }
    return "";
  }

  _summaryFor(engine) {
    const stats = engine.getStats();
    const settings = engine.state.settings;
    return {
      id: engine.id,
      name: engine.name,
      running: Boolean(engine.state.meta.running),
      scanning: Boolean(engine.scanning),
      stopReason: engine.state.meta.stopReason || null,
      initialFund: toNum(engine.state.initialFund, 0),
      totalFund: settings.totalFund,
      equity: stats.equity,
      balance: stats.balance,
      available: stats.available,
      totalPnl: stats.totalPnl,
      returnPct: stats.returnPct,
      realizedPnl: stats.realizedPnl,
      unrealizedPnl: stats.unrealizedPnl,
      winrate: stats.winrate,
      profitFactor: stats.profitFactor,
      maxDrawdownPct: stats.maxDrawdownPct,
      totalTrades: stats.totalTrades,
      openTrades: stats.openTrades,
      ups: stats.wins,
      downs: stats.losses,
      leverage: settings.leverage,
      allocationPercent: settings.allocationPercent,
      sizingMode: settings.sizingMode,
      direction: settings.direction,
      filters: (settings.oiFilters || []).filter((f) => f.enabled && f.threshold !== null).length +
        (settings.volFilters || []).filter((f) => f.enabled && f.threshold !== null).length,
      createdAt: this._entry(engine.id)?.createdAt || engine.state.meta.createdAt || null,
      lastScanAt: engine.state.meta.lastScan?.at || null,
      positions: engine.state.positions.length,
      file: this._entry(engine.id)?.file || `strategies/${engine.id}.json`,
    };
  }

  list() {
    return this.order
      .map((id) => this.engines.get(id))
      .filter(Boolean)
      .map((engine) => this._summaryFor(engine));
  }

  summary() {
    const rows = this.list();
    const initialFund = rows.reduce((a, r) => a + toNum(r.initialFund, 0), 0);
    const equity = rows.reduce((a, r) => a + toNum(r.equity, 0), 0);
    const totalTrades = rows.reduce((a, r) => a + toNum(r.totalTrades, 0), 0);
    const wins = rows.reduce((a, r) => a + toNum(r.ups, 0), 0);
    const totalPnl = equity - initialFund;
    return {
      count: rows.length,
      running: rows.filter((r) => r.running).length,
      initialFund,
      equity,
      totalPnl,
      returnPct: initialFund > 0 ? (totalPnl / initialFund) * 100 : 0,
      openTrades: rows.reduce((a, r) => a + toNum(r.openTrades, 0), 0),
      totalTrades,
      winrate: totalTrades ? (wins / totalTrades) * 100 : 0,
      selectedId: this.selectedId(),
      maxStrategies: MAX_STRATEGIES,
    };
  }

  async _saveConfig() {
    const snapshot = clone(this.config);
    this._saveChain = this._saveChain
      .catch(() => null)
      .then(() => this.adapter.saveConfig(snapshot));
    return this._saveChain;
  }

  /* ------------------------------------------------------------------ */
  /* Strategy lifecycle                                                 */
  /* ------------------------------------------------------------------ */

  async create({ name, fund, settings, cloneFrom = null, start = false } = {}) {
    if (this.order.length >= MAX_STRATEGIES) {
      return { ok: false, error: "max-strategies", max: MAX_STRATEGIES };
    }
    const baseEngine = cloneFrom ? this.resolve(cloneFrom) : null;
    const baseSettings = baseEngine ? clone(baseEngine.state.settings) || {} : {};
    const merged = normalizeSettings({ ...baseSettings, ...(settings || {}) });
    if (fund !== undefined && fund !== null && fund !== "") {
      const n = toNum(fund);
      if (n !== null) merged.totalFund = n;
    }
    // Every strategy shares the same CoinGlass feed/key, so a new strategy can
    // use the existing feed immediately.
    merged.coinglassApiKey = this.marketApiKey();

    const id = uid("stg_");
    const entry = {
      id,
      name: cleanName(name, `Strategy ${this.order.length + 1}`),
      createdAt: now(),
      desiredRunning: false,
    };
    const store = await this.adapter.createStore(entry, null);
    const engine = new Engine({
      store,
      timers: this.timers,
      hub: this.hub,
      feed: this.feed,
      id,
      name: entry.name,
    });
    engine.state = createInitialState(merged);
    engine.state.meta.createdAt = entry.createdAt;
    engine.log(
      "info",
      `Strategy "${entry.name}" created with a $${merged.totalFund} paper fund.`
    );
    engine.save();

    this.engines.set(id, engine);
    this.entries.set(id, entry);
    this.order.push(id);
    this.config.strategies.push(entry);
    this.config.selectedId = id;

    if (start) {
      const started = engine.start("created");
      entry.desiredRunning = started.ok !== false;
    }
    await this._saveConfig();
    return { ok: true, strategy: this._summaryFor(engine), strategies: this.list() };
  }

  async update(id, { name, fund, settings, start, pause } = {}) {
    const engine = this.resolve(id);
    if (!engine) return { ok: false, error: "strategy-not-found" };
    const entry = this.entries.get(engine.id);
    let reset = false;

    if (name !== undefined) {
      engine.name = cleanName(name, engine.name);
      if (entry) entry.name = engine.name;
    }

    const patch = { ...(settings || {}) };
    if (fund !== undefined && fund !== null && fund !== "") {
      const n = toNum(fund);
      if (n !== null) patch.totalFund = n;
    }
    if (Object.keys(patch).length) {
      const result = engine.updateSettings(patch);
      reset = Boolean(result.reset);
    }

    if (start) {
      const result = engine.start("ui");
      if (entry) entry.desiredRunning = result.ok !== false;
    } else if (pause) {
      engine.pause("ui");
      if (entry) entry.desiredRunning = false;
    }

    await this._saveConfig();
    return {
      ok: true,
      reset,
      strategy: this._summaryFor(engine),
      settings: engine.publicSettings(),
      stats: engine.getStats(),
    };
  }

  async remove(id) {
    if (this.order.length <= 1) return { ok: false, error: "last-strategy" };
    const engine = this.resolve(id);
    if (!engine) return { ok: false, error: "strategy-not-found" };
    const entry = this.entries.get(engine.id) || { id: engine.id };
    engine.pause("removed");
    engine.destroy();
    this.engines.delete(engine.id);
    this.entries.delete(engine.id);
    this.order = this.order.filter((x) => x !== engine.id);
    this.config.strategies = this.config.strategies.filter((e) => e.id !== engine.id);
    if (this.config.selectedId === engine.id) {
      this.config.selectedId = this.order[0] || null;
    }
    try {
      await this.adapter.deleteStore(entry);
    } catch {
      /* the account file may already be gone */
    }
    await this._saveConfig();
    return { ok: true, removed: engine.id, selectedId: this.config.selectedId, strategies: this.list() };
  }

  async select(id) {
    const engine = this.resolve(id);
    if (!engine) return { ok: false, error: "strategy-not-found" };
    this.config.selectedId = engine.id;
    await this._saveConfig();
    return { ok: true, selectedId: engine.id };
  }

  start(id) {
    const engine = this.resolve(id);
    if (!engine) return { ok: false, error: "strategy-not-found" };
    const result = engine.start("ui");
    const entry = this.entries.get(engine.id);
    if (entry) entry.desiredRunning = result.ok !== false;
    this._saveConfig().catch(() => null);
    return result;
  }

  pause(id) {
    const engine = this.resolve(id);
    if (!engine) return { ok: false, error: "strategy-not-found" };
    const result = engine.pause("ui");
    const entry = this.entries.get(engine.id);
    if (entry) entry.desiredRunning = false;
    this._saveConfig().catch(() => null);
    return result;
  }

  toggle(id) {
    const engine = this.resolve(id);
    if (!engine) return { ok: false, error: "strategy-not-found" };
    return engine.state.meta.running ? this.pause(id) : this.start(id);
  }

  async startAll() {
    const results = [];
    for (const id of this.order) results.push({ id, ...this.start(id) });
    await this._saveConfig();
    return { ok: true, started: results.filter((r) => r.ok !== false).length, results };
  }

  async pauseAll() {
    const results = [];
    for (const id of this.order) results.push({ id, ...this.pause(id) });
    await this._saveConfig();
    return { ok: true, paused: results.filter((r) => r.ok !== false).length, results };
  }

  async reset(id) {
    const engine = this.resolve(id);
    if (!engine) return { ok: false, error: "strategy-not-found" };
    const result = engine.reset();
    const entry = this.entries.get(engine.id);
    if (entry) entry.desiredRunning = false;
    await this._saveConfig();
    return result;
  }

  async closeAll(id) {
    const engine = this.resolve(id);
    if (!engine) return { ok: false, error: "strategy-not-found" };
    return engine.closeAll("Manual close all");
  }

  async closeAllStrategies() {
    let closed = 0;
    for (const engine of this.engines.values()) {
      const result = await engine.closeAll("Manual close all");
      closed += result.closed || 0;
    }
    return { ok: true, closed };
  }

  /* ------------------------------------------------------------------ */
  /* Shared market / settings                                           */
  /* ------------------------------------------------------------------ */

  ingestDeviceFeed(input = {}) {
    return this.feed.ingestDeviceFeed(input, {
      log: (level, message) => this._primaryEngine()?.log(level, message),
    });
  }

  getMarketStatus() {
    return this.feed.getStatus({ apiKeySet: Boolean(this.marketApiKey()) });
  }

  async setCoinglassApiKey(key) {
    const value = key === null ? "" : String(key || "").trim();
    for (const engine of this.engines.values()) {
      engine.setCoinglassApiKey(value ? value : null);
    }
    await this._saveConfig();
    const selected = this.selected();
    return {
      ok: true,
      settings: selected ? selected.publicSettings() : null,
      strategies: this.list(),
    };
  }

  async updateSettings(id, patch = {}) {
    return this.update(id, { settings: patch });
  }

  /* ------------------------------------------------------------------ */
  /* API payloads                                                       */
  /* ------------------------------------------------------------------ */

  getDashboard(id = null) {
    const engine = this.resolve(id) || this.selected();
    if (!engine) return { error: "strategy-not-found" };
    return {
      ok: true,
      serverTime: now(),
      ...engine.getLive(),
      markets: engine.getMarketRows(),
      meta: engine.getMeta(),
      venues: this.hub.summary(),
      selectedId: engine.id,
      strategies: this.list(),
      portfolio: this.summary(),
    };
  }

  getBootstrap(id = null) {
    const engine = this.resolve(id) || this.selected();
    if (!engine) return { error: "strategy-not-found" };
    return {
      ...engine.getBootstrap(),
      selectedId: engine.id,
      strategies: this.list(),
      portfolio: this.summary(),
    };
  }

  getReportData(id = null) {
    const engine = this.resolve(id) || this.selected();
    return engine ? engine.getReportData() : null;
  }

  getTrades(id = null, options = {}) {
    const engine = this.resolve(id) || this.selected();
    return engine ? engine.getTrades(options) : { total: 0, trades: [], offset: 0, limit: 0 };
  }

  getStrategyConfig(id = null) {
    const engine = this.resolve(id) || this.selected();
    if (!engine) return null;
    return {
      settings: engine.publicSettings(),
      initialFund: engine.state.initialFund,
      stats: engine.getStats(),
    };
  }

  async flush() {
    for (const engine of this.engines.values()) {
      try {
        await engine.store.flush();
      } catch {
        /* best effort */
      }
    }
    try {
      await this._saveChain;
      await this.adapter.flush?.();
    } catch {
      /* best effort */
    }
  }

  destroy() {
    this._destroyed = true;
    for (const engine of this.engines.values()) {
      try {
        engine.destroy();
      } catch {
        /* keep shutting down the rest */
      }
    }
  }
}
