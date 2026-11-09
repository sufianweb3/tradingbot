/**
 * Same-coin re-entry guard.
 *
 * The bot must not open a second trade on a coin during the configured lock
 * window after the coin was last traded. The window is derived from both
 * sources of truth:
 *
 *   1. `state.trades`    - closed trade history (entry, partials, exit)
 *   2. `state.positions` - trades that are still live/open
 *
 * `state.meta.reentryBlocks` is only a persistence fallback for symbols that
 * are no longer present in either list. Building the index from the actual
 * state keeps the rule correct across restarts, imports and manual opens.
 *
 * Pure functions only: no engine, network or filesystem access.
 */

import { toNum } from "../util.js";

/** Default lock window: 12 hours. */
export const DEFAULT_REENTRY_WINDOW_MIN = 12 * 60;

const upper = (symbol) => String(symbol || "").trim().toUpperCase();

/** Latest valid timestamp from a list, or 0 when none exist. */
function latestAt(values) {
  let at = 0;
  for (const value of values) {
    const n = toNum(value, 0) ?? 0;
    if (n > at) at = n;
  }
  return at;
}

function partialTimes(record) {
  return (Array.isArray(record?.partials) ? record.partials : []).map((p) => p?.t);
}

/**
 * Resolve the configured lock window.
 *
 * Explicit `reenterEnabled` / `reenterDelayMin` win. Raw/legacy states that
 * only carry `cooldownSec` are still honoured, which keeps older API clients
 * and saved states working.
 */
export function resolveReentryWindow(settings = {}) {
  const input = settings && typeof settings === "object" ? settings : {};
  const hasExplicit =
    Object.prototype.hasOwnProperty.call(input, "reenterEnabled") ||
    Object.prototype.hasOwnProperty.call(input, "reenterDelayMin");

  let enabled;
  let minutes;
  if (hasExplicit) {
    enabled = Boolean(input.reenterEnabled);
    minutes = Math.max(0, toNum(input.reenterDelayMin, DEFAULT_REENTRY_WINDOW_MIN) ?? 0);
  } else {
    const legacySec = Math.max(0, toNum(input.cooldownSec, 0) ?? 0);
    enabled = legacySec > 0;
    minutes = legacySec / 60;
  }

  const windowSec = enabled && minutes > 0 ? Math.round(minutes * 60) : 0;
  return {
    enabled: windowSec > 0,
    windowSec,
    windowMs: windowSec * 1000,
    minutes,
  };
}

/** Latest time a closed trade touched the market. */
export function tradeActivityAt(trade) {
  if (!trade || typeof trade !== "object") return 0;
  return latestAt([trade.entryTime, trade.exitTime, ...partialTimes(trade)]);
}

/** Latest time an open position touched the market. */
export function positionActivityAt(position) {
  if (!position || typeof position !== "object") return 0;
  return latestAt([position.entryTime, ...partialTimes(position)]);
}

/**
 * Build a symbol -> activity index from closed trades, live positions and the
 * persisted fallback map. Later activity wins; an open position is marked so
 * callers can explain why a coin is locked.
 *
 * @returns {Map<string, {symbol:string, at:number, source:string, open:boolean}>}
 */
export function buildReentryIndex({ trades, positions, blocks } = {}) {
  const index = new Map();

  const record = (symbol, at, source, open = false) => {
    const key = upper(symbol);
    if (!key || !(at > 0)) return;
    const previous = index.get(key);
    if (!previous || at >= previous.at) {
      index.set(key, { symbol: key, at, source, open });
    }
  };

  // Persisted timestamps are the weakest source; add them first so real state
  // always overrides them.
  if (blocks && typeof blocks === "object") {
    for (const [symbol, value] of Object.entries(blocks)) {
      const at = toNum(value && typeof value === "object" ? value.at : value, 0) ?? 0;
      record(symbol, at, "stored");
    }
  }

  for (const trade of Array.isArray(trades) ? trades : []) {
    record(trade?.symbol, tradeActivityAt(trade), "trade-history");
  }

  for (const position of Array.isArray(positions) ? positions : []) {
    if (position?.status && position.status !== "open") continue;
    record(position?.symbol, positionActivityAt(position), "open-position", true);
  }

  return index;
}

/**
 * Status of one symbol.
 *
 * A coin is locked while `now < lastActivityAt + window`. The remaining time is
 * capped at one full window so a bad clock or future timestamp cannot extend
 * the lock beyond the configured duration.
 */
export function getReentryStatus(symbol, index, settings = {}, nowMs = Date.now()) {
  const cfg = resolveReentryWindow(settings);
  const key = upper(symbol);
  const entry = index instanceof Map ? index.get(key) : null;
  const lastTradeAt = entry?.at ?? null;
  const source = entry?.source ?? null;
  const open = Boolean(entry?.open);

  if (!cfg.enabled || !lastTradeAt) {
    return {
      symbol: key,
      enabled: cfg.enabled,
      blocked: false,
      remainingSec: 0,
      remainingMs: 0,
      unlockAt: null,
      lastTradeAt,
      source,
      open,
      windowSec: cfg.windowSec,
    };
  }

  const unlockAt = lastTradeAt + cfg.windowMs;
  const remainingMs = Math.min(cfg.windowMs, Math.max(0, unlockAt - nowMs));
  return {
    symbol: key,
    enabled: true,
    blocked: remainingMs > 0,
    remainingSec: remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0,
    remainingMs,
    unlockAt,
    lastTradeAt,
    source,
    open,
    windowSec: cfg.windowSec,
  };
}
