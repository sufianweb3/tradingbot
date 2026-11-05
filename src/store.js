/**
 * JSON persistence + settings schema/normalisation.
 */

// Guard Node filesystem imports for browser Web Worker compatibility
let fs = null;
let path = null;
if (typeof process !== "undefined" && process?.versions?.node) {
  try {
    const fsMod = await import("node:fs");
    fs = fsMod.default || fsMod;
    const pathMod = await import("node:path");
    path = pathMod.default || pathMod;
  } catch {
    /* browser environment */
  }
}
import { DEFAULT_VENUES } from "./exchanges.js";
import { OI_TIMEFRAMES, VOL_TIMEFRAMES, PRICE_TIMEFRAMES } from "./trading.js";
import { clamp, deepMerge, now, toNum } from "./util.js";

function filterDefaults(timeframes, group, defaultOp = ">=") {
  return timeframes.map((key) => ({
    key,
    enabled: false,
    op: defaultOp,
    threshold: null,
    group,
  }));
}

export function defaultProfile(side = "long") {
  const isShort = side === "short";
  return {
    enabled: side === "long",
    // Filters
    oiFilters: filterDefaults(OI_TIMEFRAMES, "oi", isShort ? "<=" : ">="),
    volFilters: filterDefaults(VOL_TIMEFRAMES, "vol", ">="),
    priceFilters: filterDefaults(PRICE_TIMEFRAMES, "price", isShort ? "<=" : ">="),
    // Sizing
    sizingMode: "allocation", // allocation | fixedMargin | fixedQty
    allocationPercent: 50,
    allocationBase: "initial", // initial | equity
    fixedMargin: 250,
    fixedQty: 1,
    leverage: 50,
    // Exit plan
    slPercent: 20,
    tp1Percent: 50,
    tp1ClosePercent: 50,
    tpMaxPercent: 1000,
    trailingEnabled: true,
    trailingStart: "tp1", // tp1 | immediate
    trailingDistancePercent: 20,
    // Caps
    maxTrades: 0,
    maxOpenPositions: 0,
    maxPositionsPerCoin: 1,
  };
}

export const DEFAULT_SETTINGS = {
  // Capital and sizing (global / shared)
  totalFund: 500,
  sizingMode: "allocation",
  allocationPercent: 50,
  allocationBase: "initial",
  fixedMargin: 250,
  fixedQty: 1,
  leverage: 50,

  // Exit plan (shared defaults)
  riskMode: "roe", // roe | price
  slPercent: 20,
  tp1Percent: 50,
  tp1ClosePercent: 50,
  tpMaxPercent: 1000,
  trailingEnabled: true,
  trailingStart: "tp1",
  trailingDistancePercent: 20,

  // Legacy signal fields (kept for migration & backwards compatibility)
  direction: "auto",
  oiFilters: filterDefaults(OI_TIMEFRAMES, "oi"),
  volFilters: filterDefaults(VOL_TIMEFRAMES, "vol"),
  priceFilters: filterDefaults(PRICE_TIMEFRAMES, "price"),
  minOiUsd: 0,
  minVolUsd24h: 0,
  excludeSymbols:
    "USDT,USDC,USDE,DAI,FDUSD,TUSD,USDP,PYUSD,BUSD,USDD,USTC,WBTC,WETH",
  allowCoinglassPrice: false,
  coinglassApiKey: "",

  // Execution
  maxTrades: 0,
  maxOpenPositions: 0,
  maxPositionsPerCoin: 1,
  scanIntervalSec: 30,
  priceRefreshMs: 3000,
  reenterEnabled: false,
  reenterDelayMin: 30,
  cooldownSec: 0,
  feePercent: 0.05,
  slippagePercent: 0.02,
  venues: [...DEFAULT_VENUES],
  autoStart: false,

  // Dual profiles (PRD 5.4 M2)
  profiles: {
    long: defaultProfile("long"),
    short: defaultProfile("short"),
  },
};

const RANGES = {
  totalFund: [1, 1e9],
  allocationPercent: [0.1, 100],
  fixedMargin: [0.1, 1e9],
  fixedQty: [1e-8, 1e12],
  leverage: [1, 200],
  slPercent: [0.01, 100000],
  tp1Percent: [0.01, 100000],
  tp1ClosePercent: [1, 100],
  tpMaxPercent: [0.01, 1000000],
  trailingDistancePercent: [0.01, 100000],
  maxTrades: [0, 1e7],
  maxOpenPositions: [0, 1000],
  maxPositionsPerCoin: [1, 50],
  scanIntervalSec: [10, 3600],
  priceRefreshMs: [500, 60000],
  reenterDelayMin: [0, 10080],
  cooldownSec: [0, 86400],
  feePercent: [0, 2],
  slippagePercent: [0, 5],
  minOiUsd: [0, 1e12],
  minVolUsd24h: [0, 1e12],
};

const PROFILE_RANGES = {
  allocationPercent: [0.1, 100],
  fixedMargin: [0.1, 1e9],
  fixedQty: [1e-8, 1e12],
  leverage: [1, 200],
  slPercent: [0.01, 100000],
  tp1Percent: [0.01, 100000],
  tp1ClosePercent: [1, 100],
  tpMaxPercent: [0.01, 1000000],
  trailingDistancePercent: [0.01, 100000],
  maxTrades: [0, 1e7],
  maxOpenPositions: [0, 1000],
  maxPositionsPerCoin: [1, 50],
};

function normalizeFilterList(input, defaults, allowedKeys) {
  const byKey = new Map();
  for (const f of Array.isArray(input) ? input : []) {
    if (f && allowedKeys.includes(f.key)) byKey.set(f.key, f);
  }
  return defaults.map((d) => {
    const raw = byKey.get(d.key) || {};
    const threshold = toNum(raw.threshold);
    return {
      key: d.key,
      enabled: Boolean(raw.enabled),
      op: raw.op === "<=" ? "<=" : ">=",
      threshold: threshold === null ? null : clamp(threshold, -1e9, 1e9),
      group: d.group,
    };
  });
}

export function normalizeProfile(input = {}, side = "long") {
  const def = defaultProfile(side);
  const p = deepMerge(def, input && typeof input === "object" ? input : {});

  p.enabled = Boolean(p.enabled);
  for (const [key, [min, max]] of Object.entries(PROFILE_RANGES)) {
    const n = toNum(p[key]);
    p[key] = clamp(n === null ? def[key] : n, min, max);
  }
  p.fixedMargin = Math.round(p.fixedMargin * 100) / 100;
  p.leverage = Math.round(p.leverage);
  p.maxPositionsPerCoin = Math.max(1, Math.round(p.maxPositionsPerCoin));
  p.slPercent = Math.round(p.slPercent * 100) / 100;
  p.tp1Percent = Math.round(p.tp1Percent * 100) / 100;
  p.tp1ClosePercent = Math.round(p.tp1ClosePercent * 100) / 100;
  p.tpMaxPercent = Math.round(p.tpMaxPercent * 100) / 100;
  p.trailingDistancePercent = Math.round(p.trailingDistancePercent * 100) / 100;

  p.sizingMode = ["allocation", "fixedMargin", "fixedQty"].includes(p.sizingMode)
    ? p.sizingMode
    : "allocation";
  p.allocationBase = p.allocationBase === "equity" ? "equity" : "initial";
  p.trailingStart = p.trailingStart === "immediate" ? "immediate" : "tp1";
  p.trailingEnabled = Boolean(p.trailingEnabled);

  p.oiFilters = normalizeFilterList(
    p.oiFilters,
    filterDefaults(OI_TIMEFRAMES, "oi", side === "short" ? "<=" : ">="),
    OI_TIMEFRAMES
  );
  p.volFilters = normalizeFilterList(
    p.volFilters,
    filterDefaults(VOL_TIMEFRAMES, "vol", ">="),
    VOL_TIMEFRAMES
  );
  p.priceFilters = normalizeFilterList(
    p.priceFilters,
    filterDefaults(PRICE_TIMEFRAMES, "price", side === "short" ? "<=" : ">="),
    PRICE_TIMEFRAMES
  );

  return p;
}

export function normalizeSettings(input = {}) {
  const inputObj = input && typeof input === "object" ? input : {};
  const s = deepMerge(DEFAULT_SETTINGS, inputObj);

  // Backward compatibility: versions before the explicit re-entry switch only
  // stored `cooldownSec`. Translate it once when the new fields are absent.
  const hasReenterFields =
    Object.prototype.hasOwnProperty.call(inputObj, "reenterEnabled") ||
    Object.prototype.hasOwnProperty.call(inputObj, "reenterDelayMin");
  if (!hasReenterFields && Object.prototype.hasOwnProperty.call(inputObj, "cooldownSec")) {
    const legacySec = clamp(toNum(inputObj.cooldownSec, 0) ?? 0, 0, 86400);
    s.reenterEnabled = legacySec > 0;
    s.reenterDelayMin = legacySec > 0 ? legacySec / 60 : DEFAULT_SETTINGS.reenterDelayMin;
  }

  for (const [key, [min, max]] of Object.entries(RANGES)) {
    const n = toNum(s[key]);
    s[key] = clamp(n === null ? DEFAULT_SETTINGS[key] : n, min, max);
  }
  s.totalFund = Math.round(s.totalFund * 100) / 100;
  s.fixedMargin = Math.round(s.fixedMargin * 100) / 100;
  s.leverage = Math.round(s.leverage);
  s.maxPositionsPerCoin = Math.max(1, Math.round(s.maxPositionsPerCoin));
  s.slPercent = Math.round(s.slPercent * 100) / 100;
  s.tp1Percent = Math.round(s.tp1Percent * 100) / 100;
  s.tp1ClosePercent = Math.round(s.tp1ClosePercent * 100) / 100;
  s.tpMaxPercent = Math.round(s.tpMaxPercent * 100) / 100;
  s.trailingDistancePercent = Math.round(s.trailingDistancePercent * 100) / 100;
  s.feePercent = Math.round(s.feePercent * 1000) / 1000;
  s.slippagePercent = Math.round(s.slippagePercent * 1000) / 1000;
  s.reenterDelayMin = Math.round(s.reenterDelayMin * 100) / 100;
  s.reenterEnabled = Boolean(s.reenterEnabled);
  s.cooldownSec =
    s.reenterEnabled && s.reenterDelayMin > 0 ? Math.round(s.reenterDelayMin * 60) : 0;

  s.sizingMode = ["allocation", "fixedMargin", "fixedQty"].includes(s.sizingMode)
    ? s.sizingMode
    : "allocation";
  s.allocationBase = s.allocationBase === "equity" ? "equity" : "initial";
  s.riskMode = s.riskMode === "price" ? "price" : "roe";
  s.direction = ["auto", "long", "short"].includes(s.direction) ? s.direction : "auto";
  s.trailingStart = s.trailingStart === "immediate" ? "immediate" : "tp1";
  s.trailingEnabled = Boolean(s.trailingEnabled);
  s.allowCoinglassPrice = Boolean(s.allowCoinglassPrice);
  s.autoStart = Boolean(s.autoStart);

  // Secrets are stored as plain strings in the state snapshot but never sent
  // back to a client; see Engine.publicSettings().
  s.coinglassApiKey = String(s.coinglassApiKey || "")
    .replace(/[\r\n\t]/g, "")
    .trim()
    .slice(0, 200);

  // S10 Migration: migrate flat settings into profiles.long & profiles.short
  const profileKeys = [
    "sizingMode",
    "allocationPercent",
    "allocationBase",
    "fixedMargin",
    "fixedQty",
    "leverage",
    "slPercent",
    "tp1Percent",
    "tp1ClosePercent",
    "tpMaxPercent",
    "trailingEnabled",
    "trailingStart",
    "trailingDistancePercent",
    "maxTrades",
    "maxOpenPositions",
    "maxPositionsPerCoin",
    "oiFilters",
    "volFilters",
    "priceFilters",
  ];

  const hasProfiles = Boolean(inputObj.profiles && typeof inputObj.profiles === "object");
  const rawLongObj = (hasProfiles ? inputObj.profiles.long : null) || {};
  const rawShortObj = (hasProfiles ? inputObj.profiles.short : null) || {};

  const rawLong = { ...rawLongObj };
  for (const k of profileKeys) {
    if (Object.prototype.hasOwnProperty.call(inputObj, k)) {
      // If top-level was explicitly provided (e.g. overrides, legacy settings, updateSettings)
      rawLong[k] = inputObj[k];
    } else if (!Object.prototype.hasOwnProperty.call(rawLong, k)) {
      rawLong[k] = s[k];
    }
  }

  const rawShort = { ...rawShortObj };
  for (const k of profileKeys) {
    if (!Object.prototype.hasOwnProperty.call(rawShort, k)) {
      rawShort[k] = rawShortObj[k] ?? s[k];
    }
  }

  if (rawLong.enabled === undefined) {
    rawLong.enabled = inputObj.direction !== "short";
  }
  if (rawShort.enabled === undefined) {
    rawShort.enabled = inputObj.direction === "short";
  }

  s.profiles = {
    long: normalizeProfile(rawLong, "long"),
    short: normalizeProfile(rawShort, "short"),
  };

  // Sync profiles.long to top-level for backward compatibility with legacy code/tests
  s.sizingMode = s.profiles.long.sizingMode;
  s.allocationPercent = s.profiles.long.allocationPercent;
  s.allocationBase = s.profiles.long.allocationBase;
  s.fixedMargin = s.profiles.long.fixedMargin;
  s.fixedQty = s.profiles.long.fixedQty;
  s.leverage = s.profiles.long.leverage;
  s.slPercent = s.profiles.long.slPercent;
  s.tp1Percent = s.profiles.long.tp1Percent;
  s.tp1ClosePercent = s.profiles.long.tp1ClosePercent;
  s.tpMaxPercent = s.profiles.long.tpMaxPercent;
  s.trailingEnabled = s.profiles.long.trailingEnabled;
  s.trailingStart = s.profiles.long.trailingStart;
  s.trailingDistancePercent = s.profiles.long.trailingDistancePercent;
  s.maxTrades = s.profiles.long.maxTrades;
  s.maxOpenPositions = s.profiles.long.maxOpenPositions;
  s.maxPositionsPerCoin = s.profiles.long.maxPositionsPerCoin;
  s.oiFilters = s.profiles.long.oiFilters;
  s.volFilters = s.profiles.long.volFilters;
  s.priceFilters = s.profiles.long.priceFilters;

  const venues = Array.isArray(s.venues) ? s.venues : [];
  s.venues = [...new Set(venues.filter((v) => DEFAULT_VENUES.includes(v)))];
  if (!s.venues.length) s.venues = [...DEFAULT_VENUES];

  s.excludeSymbols = String(s.excludeSymbols || "")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .join(",");

  return s;
}

export function createInitialState(settingsInput = {}) {
  const settings = normalizeSettings(settingsInput);
  const t = now();
  return {
    version: 1,
    settings,
    initialFund: settings.totalFund,
    trades: [],
    positions: [],
    equityCurve: [
      { t, equity: settings.totalFund, balance: settings.totalFund, unrealized: 0 },
    ],
    logs: [],
    meta: {
      running: false,
      startedAt: null,
      createdAt: t,
      stopReason: null,
      lastScan: null,
      nextScanAt: null,
      marketFetchedAt: null,
      marketError: null,
      scanCount: 0,
      totalOpened: 0,
      lastOpenAt: null,
      // Last close time per coin, used to enforce the re-entry delay across
      // server restarts. Cleared by a strategy reset.
      reentryBlocks: {},
    },
  };
}

export function sanitizeLoadedState(input) {
  const base = createInitialState(input?.settings || {});
  const state = { ...base, ...(input || {}) };
  state.settings = normalizeSettings(input?.settings || {});
  // Migration: states written before per-coin stacking existed carry the old
  // 5-minute re-entry cooldown. Treat it as the old default and drop it, so a
  // coin can trade again as soon as the filters pass. A state that already has
  // maxPositionsPerCoin keeps whatever re-entry delay the user chose.
  if (input?.settings && input.settings.maxPositionsPerCoin === undefined) {
    const hasReenterFields =
      input.settings.reenterEnabled !== undefined || input.settings.reenterDelayMin !== undefined;
    if (!hasReenterFields && Number(input.settings.cooldownSec) === 300) {
      state.settings.reenterEnabled = false;
      state.settings.reenterDelayMin = DEFAULT_SETTINGS.reenterDelayMin;
      state.settings.cooldownSec = 0;
    }
  }
  state.initialFund = toNum(input?.initialFund);
  if (state.initialFund === null || state.initialFund <= 0) state.initialFund = state.settings.totalFund;
  state.trades = Array.isArray(input?.trades) ? input.trades.filter((t) => t && t.id) : [];
  state.positions = Array.isArray(input?.positions)
    ? input.positions.filter((p) => p && p.id && p.status === "open" && toNum(p.qty) > 0)
    : [];
  state.equityCurve = Array.isArray(input?.equityCurve)
    ? input.equityCurve.filter((p) => p && Number.isFinite(toNum(p.equity)))
    : base.equityCurve;
  if (!state.equityCurve.length) state.equityCurve = base.equityCurve;
  state.logs = Array.isArray(input?.logs) ? input.logs.slice(-250) : [];
  state.meta = { ...base.meta, ...(input?.meta || {}) };
  // Keep the last close per coin so a restart cannot bypass the delay. Rebuild
  // it from trade history when an older state has no map.
  const blocks = {};
  const storedBlocks =
    input?.meta && input.meta.reentryBlocks && typeof input.meta.reentryBlocks === "object"
      ? input.meta.reentryBlocks
      : {};
  for (const [symbol, at] of Object.entries(storedBlocks)) {
    const t = toNum(at);
    if (symbol && t !== null && t > 0) blocks[String(symbol).toUpperCase()] = t;
  }
  for (const t of state.trades) {
    const at = toNum(t.exitTime);
    if (t.symbol && at !== null && at > (blocks[String(t.symbol).toUpperCase()] || 0)) {
      blocks[String(t.symbol).toUpperCase()] = at;
    }
  }
  state.meta.reentryBlocks = blocks;
  // Never auto-resume after a restart: opening trades unexpectedly is worse.
  state.meta.running = false;
  state.meta.nextScanAt = null;
  // Repair positions that predate newer fields.
  for (const p of state.positions) {
    p.status = "open";
    p.qty = toNum(p.qty, 0);
    p.originalQty = toNum(p.originalQty, p.qty);
    p.entryFee = toNum(p.entryFee, 0);
    p.exitFees = toNum(p.exitFees, 0);
    p.grossPnl = toNum(p.grossPnl, 0);
    p.exitQty = toNum(p.exitQty, 0);
    p.exitNotional = toNum(p.exitNotional, 0);
    p.partials = Array.isArray(p.partials) ? p.partials : [];
  }
  if (state.equityCurve.length > 6000) {
    const step = Math.ceil(state.equityCurve.length / 6000);
    state.equityCurve = state.equityCurve.filter(
      (_, i) => i % step === 0 || i === state.equityCurve.length - 1
    );
  }
  return state;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.state = createInitialState();
    this._timer = null;
    this._dirty = false;
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) {
        this.state = createInitialState();
        this.flush();
        return this.state;
      }
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.state = sanitizeLoadedState(parsed);
      return this.state;
    } catch (err) {
      try {
        if (fs.existsSync(this.file)) {
          const backup = `${this.file}.corrupt-${Date.now()}`;
          fs.renameSync(this.file, backup);
        }
      } catch {
        /* ignore */
      }
      this.state = createInitialState();
      this.state.logs.push({
        t: now(),
        level: "error",
        msg: `State file could not be read (${err.message}). Started fresh.`,
      });
      this.flush();
      return this.state;
    }
  }

  replace(state) {
    this.state = state;
    this.save();
  }

  save(state) {
    if (state) this.state = state;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 500);
  }

  flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty && fs.existsSync(this.file)) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), "utf8");
      try {
        fs.renameSync(tmp, this.file);
      } catch {
        fs.rmSync(this.file, { force: true });
        fs.renameSync(tmp, this.file);
      }
      this._dirty = false;
    } catch (err) {
      console.error("[store] save failed:", err.message);
    }
  }
}
