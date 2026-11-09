/**
 * Persisted Table-Driven Trade Intent State Machine & Atomic Margin Reservation
 *
 * Implements Section 9.3 (FX-62) and Section 8.4 (EC-35, EC-39).
 *
 * Lifecycle:
 * CREATED -> GATED -> ROUTED -> SUBMITTED -> PARTIAL / FILLED -> PROTECTING -> ACTIVE -> EXITING -> CLOSED
 * Error / Recovery states: REJECTED, FAILED, UNKNOWN, PROTECTION_FAILED, ORPHANED
 */

import { toNum, uid } from "../util.js";

export const INTENT_STATES = Object.freeze({
  CREATED: "CREATED",
  GATED: "GATED",
  ROUTED: "ROUTED",
  SUBMITTED: "SUBMITTED",
  PARTIAL: "PARTIAL",
  FILLED: "FILLED",
  PROTECTING: "PROTECTING",
  ACTIVE: "ACTIVE",
  EXITING: "EXITING",
  CLOSED: "CLOSED",
  REJECTED: "REJECTED",
  FAILED: "FAILED",
  UNKNOWN: "UNKNOWN",
  PROTECTION_FAILED: "PROTECTION_FAILED",
  ORPHANED: "ORPHANED",
});

export const ALLOWED_TRANSITIONS = Object.freeze({
  CREATED: ["GATED", "ROUTED", "REJECTED", "FAILED"],
  GATED: ["ROUTED", "SUBMITTED", "REJECTED", "FAILED"],
  ROUTED: ["SUBMITTED", "REJECTED", "FAILED"],
  SUBMITTED: ["PARTIAL", "FILLED", "PROTECTING", "REJECTED", "FAILED", "UNKNOWN"],
  PARTIAL: ["FILLED", "PROTECTING", "ACTIVE", "EXITING", "CLOSED", "PROTECTION_FAILED", "UNKNOWN"],
  FILLED: ["PROTECTING", "ACTIVE", "EXITING", "CLOSED", "PROTECTION_FAILED"],
  PROTECTING: ["ACTIVE", "EXITING", "CLOSED", "PROTECTION_FAILED", "ORPHANED"],
  ACTIVE: ["EXITING", "CLOSED", "PROTECTION_FAILED", "ORPHANED"],
  EXITING: ["CLOSED", "FAILED", "UNKNOWN", "ORPHANED"],
  UNKNOWN: ["FILLED", "PARTIAL", "REJECTED", "FAILED", "CLOSED", "ORPHANED"],
  PROTECTION_FAILED: ["EXITING", "CLOSED", "ORPHANED"],
  ORPHANED: ["ACTIVE", "EXITING", "CLOSED"],
  REJECTED: [],
  FAILED: [],
  CLOSED: [],
});

export class IntentStateMachine {
  constructor({ onPersist = null } = {}) {
    this.intents = new Map(); // intentId -> intent object
    this.symbolLocks = new Map(); // symbol -> intentId (locked while UNKNOWN or in-flight)
    this.marginReservations = new Map(); // intentId -> { venue, amount, ts }
    this.onPersist = onPersist;
  }

  /**
   * Load persisted intents (e.g. on crash recovery / startup, EC-39).
   */
  loadPersistedIntents(list = []) {
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || !item.id) continue;
      this.intents.set(item.id, item);
      if (item.state === INTENT_STATES.UNKNOWN && item.symbol) {
        this.symbolLocks.set(String(item.symbol).toUpperCase(), item.id);
      }
    }
  }

  /**
   * Return all non-terminal intents requiring startup recovery or reconciliation (EC-39).
   */
  getPendingIntents() {
    const terminal = new Set([
      INTENT_STATES.CLOSED,
      INTENT_STATES.REJECTED,
      INTENT_STATES.FAILED,
    ]);
    return [...this.intents.values()].filter((i) => !terminal.has(i.state));
  }

  /**
   * Check if a symbol is currently locked by an UNKNOWN or in-flight intent (FX-23, FX-62).
   */
  isSymbolLocked(symbol) {
    const sym = String(symbol || "").toUpperCase();
    const lockId = this.symbolLocks.get(sym);
    if (!lockId) return false;
    const intent = this.intents.get(lockId);
    if (!intent) {
      this.symbolLocks.delete(sym);
      return false;
    }
    return [
      INTENT_STATES.SUBMITTED,
      INTENT_STATES.UNKNOWN,
      INTENT_STATES.PROTECTING,
      INTENT_STATES.PROTECTION_FAILED,
    ].includes(intent.state);
  }

  /**
   * Atomic Margin Reservation (EC-35):
   * Reserves required margin before async order submission so concurrent signals cannot overspend.
   */
  reserveMargin(intentId, venue, amountUsd, availableUsdt) {
    const reqAmount = Math.max(0, toNum(amountUsd, 0));
    const vKey = String(venue || "pooled").toLowerCase();
    let currentlyReserved = 0;
    for (const [id, res] of this.marginReservations.entries()) {
      if (id !== intentId && (res.venue === vKey || vKey === "pooled" || res.venue === "pooled")) {
        currentlyReserved += res.amount;
      }
    }

    const freeAfterReserved = toNum(availableUsdt, 0) - currentlyReserved;
    if (reqAmount > freeAfterReserved + 1e-6) {
      return {
        ok: false,
        reason: "insufficient-unreserved-margin",
        requested: reqAmount,
        reserved: currentlyReserved,
        available: freeAfterReserved,
      };
    }

    this.marginReservations.set(intentId, {
      venue: vKey,
      amount: reqAmount,
      ts: Date.now(),
    });

    return {
      ok: true,
      reserved: currentlyReserved + reqAmount,
      remainingAvailable: freeAfterReserved - reqAmount,
    };
  }

  releaseMargin(intentId) {
    return this.marginReservations.delete(intentId);
  }

  getReservedMargin(venue = null) {
    let sum = 0;
    const vKey = venue ? String(venue).toLowerCase() : null;
    for (const res of this.marginReservations.values()) {
      if (!vKey || res.venue === vKey || res.venue === "pooled") {
        sum += res.amount;
      }
    }
    return sum;
  }

  /**
   * Create a new trade intent in CREATED state.
   */
  createIntent({
    id = null,
    symbol,
    side,
    venue = null,
    mode = "paper",
    plannedNotional = 0,
    clientOrderId = null,
    meta = {},
  }) {
    const sym = String(symbol || "").toUpperCase();
    if (this.isSymbolLocked(sym)) {
      throw new Error(`symbol-locked:${sym}`);
    }

    const intentId = id || uid("intent_");
    const ts = Date.now();
    const intent = {
      id: intentId,
      symbol: sym,
      side,
      venue,
      mode,
      plannedNotional: toNum(plannedNotional, 0),
      approvedNotional: toNum(plannedNotional, 0),
      clientOrderId: clientOrderId || `ord_${intentId}_${ts}`,
      state: INTENT_STATES.CREATED,
      createdAt: ts,
      updatedAt: ts,
      history: [{ state: INTENT_STATES.CREATED, ts, note: "created" }],
      meta: { ...meta },
    };

    this.intents.set(intentId, intent);
    this._persistSync(intent);
    return intent;
  }

  /**
   * Transition an intent to a new state with write-ahead persistence before side effects (FX-62).
   */
  transition(intentId, nextState, patch = {}) {
    const intent = this.intents.get(intentId);
    if (!intent) {
      throw new Error(`Intent not found: ${intentId}`);
    }

    const current = intent.state;
    if (current === nextState) {
      Object.assign(intent, patch, { updatedAt: Date.now() });
      this._persistSync(intent);
      return intent;
    }

    const allowed = ALLOWED_TRANSITIONS[current] || [];
    if (!allowed.includes(nextState)) {
      throw new Error(`Invalid intent state transition: ${current} -> ${nextState}`);
    }

    const ts = Date.now();
    intent.state = nextState;
    intent.updatedAt = ts;
    if (patch && typeof patch === "object") {
      const { note, ...rest } = patch;
      Object.assign(intent, rest);
      intent.history.push({ state: nextState, ts, note: note || null });
    } else {
      intent.history.push({ state: nextState, ts, note: null });
    }

    // Manage symbol locks and margin reservation release
    const sym = intent.symbol;
    if (
      [
        INTENT_STATES.SUBMITTED,
        INTENT_STATES.UNKNOWN,
        INTENT_STATES.PROTECTING,
        INTENT_STATES.PROTECTION_FAILED,
      ].includes(nextState)
    ) {
      this.symbolLocks.set(sym, intentId);
    } else if (this.symbolLocks.get(sym) === intentId) {
      this.symbolLocks.delete(sym);
    }

    if (
      [
        INTENT_STATES.ACTIVE,
        INTENT_STATES.CLOSED,
        INTENT_STATES.REJECTED,
        INTENT_STATES.FAILED,
      ].includes(nextState)
    ) {
      this.releaseMargin(intentId);
    }

    this._persistSync(intent);
    return intent;
  }

  getIntent(intentId) {
    return this.intents.get(intentId) || null;
  }

  _persistSync(intent) {
    if (typeof this.onPersist === "function") {
      try {
        this.onPersist(intent, this.serialize());
      } catch {
        /* persistence hook errors must not crash state transition */
      }
    }
  }

  serialize() {
    const list = [...this.intents.values()].slice(-200);
    return list;
  }
}
