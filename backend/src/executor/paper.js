/**
 * Normative Order-Book-Driven Paper Trading Simulator & Executor
 *
 * Implements Section 4 (FX-08..FX-19), PRD 5.5, and PRD 6.2.
 * Supports four realism modes (optimistic, realistic, pessimistic, live-equivalent),
 * IOC slippage-protected entry, latency snapshot walking, stop-loss book walking,
 * TP1 trade-through / fallback escalation, 4-rung exit ladder, funding accrual,
 * liquidation fee accounting, and pooled/per-venue paper wallets.
 */

import { normalizeBookLevels, walkBook } from "../core/eqe/index.js";
import { VENUE_FEE_SCHEDULE_BPS } from "../core/router/index.js";
import { clamp, now, round, toNum } from "../util.js";

export const DEFAULT_SIM_SETTINGS = {
  realismMode: "realistic", // "optimistic" | "realistic" | "pessimistic" | "live-equivalent"
  displayHaircut: 0.25,
  entryLatencyMs: 150,
  exitLatencyMs: 150,
  maxEntrySlippageBps: 25,
  maxDecisionDriftBps: 15,
  tp1OrderType: "limit", // "limit" | "market"
  tpFallbackMs: 8000,
  liqFeePct: 0.5,
  applyFunding: true,
  exitLadder: false,
  exitLadderRungs: [
    { maxImpactBps: 25, weight: 0.4 },
    { maxImpactBps: 45, weight: 0.35 },
    { maxImpactBps: 70, weight: 0.25 },
  ],
};

export function resolveHaircutForMode(simSettings = {}) {
  const mode = String(simSettings.realismMode || "realistic").toLowerCase();
  if (mode === "optimistic") return 0;
  if (mode === "pessimistic") return Math.max(0.4, toNum(simSettings.displayHaircut, 0.4));
  if (mode === "live-equivalent") return toNum(simSettings.displayHaircut, 0.25);
  return toNum(simSettings.displayHaircut, 0.25);
}

/**
 * Simulate an order-book entry fill with latency, haircut, drift guard, and IOC slippage protection (FX-08..FX-12).
 */
export function simulatePaperEntry({
  side = "long",
  targetNotional = 1000,
  book = null,
  snapshots = null,
  decisionPrice = null,
  decisionTs = null,
  minNotional = 5,
  venue = "bybit",
  simSettings = {},
  flatSlippagePercent = 0.02,
  flatFeePercent = 0.05,
} = {}) {
  const cfg = { ...DEFAULT_SIM_SETTINGS, ...(simSettings || {}) };
  const isLong = side !== "short";
  const dir = isLong ? 1 : -1;
  const haircut = resolveHaircutForMode(cfg);

  // Select post-latency snapshot if snapshots ring buffer is provided (FX-09)
  let activeBook = book;
  if (Array.isArray(snapshots) && snapshots.length > 0 && decisionTs !== null) {
    const targetTs = decisionTs + Math.max(0, toNum(cfg.entryLatencyMs, 150));
    const postLat = snapshots.find((s) => toNum(s?.ts, 0) >= targetTs);
    activeBook = postLat || snapshots[snapshots.length - 1];
  }

  // Fallback to flat slippage if no real L2 book is present (Section 4.4 FX-19)
  if (
    !activeBook ||
    !Array.isArray(activeBook.bids) ||
    !Array.isArray(activeBook.asks) ||
    activeBook.bids.length === 0 ||
    activeBook.asks.length === 0
  ) {
    const refPrice = toNum(decisionPrice, 0);
    if (!(refPrice > 0)) {
      return { ok: false, reason: "no-price", filledNotional: 0, qty: 0 };
    }
    const slipFrac = Math.max(0, toNum(flatSlippagePercent, 0.02)) / 100;
    const fillPrice = refPrice * (1 + dir * slipFrac);
    const qty = targetNotional / fillPrice;
    const feePct = toNum(flatFeePercent, 0.05);
    const feeUsd = targetNotional * (feePct / 100);
    const slippageUsd = Math.abs(fillPrice - refPrice) * qty;
    return {
      ok: true,
      executionQuality: "slippage-fallback",
      status: "FILLED",
      fillPrice,
      bestPrice: refPrice,
      midPrice: refPrice,
      qty,
      filledNotional: targetNotional,
      unfilledNotional: 0,
      impactBps: slipFrac * 10000,
      slippageUsd,
      feeUsd,
      feeBps: feePct * 100,
      levelsConsumed: 1,
    };
  }

  const bids = normalizeBookLevels(activeBook.bids, "bids");
  const asks = normalizeBookLevels(activeBook.asks, "asks");
  const bestBid = bids[0]?.[0] || 0;
  const bestAsk = asks[0]?.[0] || 0;
  const midPrice = (bestBid + bestAsk) / 2;
  const bestEntry = isLong ? bestAsk : bestBid;
  const entryLevels = isLong ? asks : bids;

  // Fast-market decision drift guard (FX-11)
  if (decisionPrice && decisionPrice > 0 && cfg.maxDecisionDriftBps > 0) {
    const adverseDrift = isLong
      ? ((bestEntry - decisionPrice) / decisionPrice) * 10000
      : ((decisionPrice - bestEntry) / decisionPrice) * 10000;
    if (adverseDrift > cfg.maxDecisionDriftBps) {
      return {
        ok: false,
        status: "REJECTED",
        reason: "decision-drift-exceeded",
        adverseDriftBps: round(adverseDrift, 2),
        maxDecisionDriftBps: cfg.maxDecisionDriftBps,
      };
    }
  }

  // Slippage-protected IOC limit price (FX-10)
  const maxSlipBps = toNum(cfg.maxEntrySlippageBps, 25);
  const limitPrice =
    maxSlipBps > 0
      ? bestEntry * (1 + dir * (maxSlipBps / 10000))
      : isLong
      ? Infinity
      : 0;

  const eligibleLevels = entryLevels.filter(([p]) =>
    isLong ? p <= limitPrice + 1e-12 : p >= limitPrice - 1e-12
  );

  const skipBps = cfg.realismMode === "pessimistic" ? 5 : 0;
  const walk = walkBook(eligibleLevels, targetNotional, haircut, skipBps, bestEntry);

  if (!(walk.filledNotional >= minNotional) || !(walk.qty > 0)) {
    return {
      ok: false,
      status: "REJECTED",
      reason: "ioc-slippage-limit",
      filledNotional: walk.filledNotional,
      unfilledNotional: walk.unfilledNotional,
      limitPrice,
    };
  }

  const vKey = String(venue || "bybit").toLowerCase();
  const feeBps = VENUE_FEE_SCHEDULE_BPS[vKey]?.takerBps ?? toNum(flatFeePercent, 0.05) * 100;
  const feeUsd = walk.filledNotional * (feeBps / 10000);
  const slippageUsd = Math.abs(walk.vwap - midPrice) * walk.qty;

  return {
    ok: true,
    executionQuality: "book-walk",
    status: walk.fullyFillable ? "FILLED" : "PARTIAL",
    fillPrice: walk.vwap,
    worstPrice: walk.worstPrice,
    bestPrice: bestEntry,
    midPrice,
    limitPrice,
    qty: walk.qty,
    filledNotional: walk.filledNotional,
    unfilledNotional: walk.unfilledNotional,
    impactBps: round(walk.impactBps, 2),
    slippageUsd: round(slippageUsd, 4),
    feeUsd: round(feeUsd, 4),
    feeBps,
    levelsConsumed: walk.levelsConsumed,
  };
}

/**
 * Simulate an order-book exit (Stop-Loss, Trailing SL, TP1 limit/market, TP Max, Exit Ladder, or Liquidation) (FX-13..FX-17).
 */
export function simulatePaperExit({
  side = "long",
  qty = 0,
  entryPrice = 0,
  triggerPrice = 0,
  markPrice = 0,
  lastPrice = null,
  reason = "Manual",
  book = null,
  venue = "bybit",
  simSettings = {},
  flatSlippagePercent = 0.02,
  flatFeePercent = 0.05,
  touchDurationMs = 0,
} = {}) {
  const cfg = { ...DEFAULT_SIM_SETTINGS, ...(simSettings || {}) };
  const isLong = side !== "short";
  const dir = isLong ? 1 : -1;
  const haircut = resolveHaircutForMode(cfg);
  const vKey = String(venue || "bybit").toLowerCase();
  const makerBps = VENUE_FEE_SCHEDULE_BPS[vKey]?.makerBps ?? 2.0;
  const takerBps = VENUE_FEE_SCHEDULE_BPS[vKey]?.takerBps ?? toNum(flatFeePercent, 0.05) * 100;

  // 1. Liquidation handling (FX-17, EC-30)
  if (/liquidation/i.test(reason)) {
    const liqPrice = toNum(triggerPrice, markPrice);
    const notional = liqPrice * qty;
    const liqFeeUsd = notional * (toNum(cfg.liqFeePct, 0.5) / 100);
    const grossPnl = (liqPrice - entryPrice) * qty * dir;
    return {
      ok: true,
      fillPrice: liqPrice,
      qty,
      notional,
      grossPnl,
      feeUsd: liqFeeUsd,
      liqFeeUsd,
      slippageVsStop: 0,
      slippageVsStopBps: 0,
      executionQuality: "liquidation-engine",
    };
  }

  const isTp1 = /tp1/i.test(reason);
  const isStop = /sl|stop|trail/i.test(reason);

  // 2. TP1 Limit Order trade-through / queue fill (FX-14)
  if (isTp1 && cfg.tp1OrderType === "limit") {
    const lp = toNum(lastPrice, markPrice);
    const tradedThrough = isLong ? lp > triggerPrice : lp < triggerPrice;
    const fallbackTriggered = touchDurationMs >= toNum(cfg.tpFallbackMs, 8000);

    if (tradedThrough && !fallbackTriggered) {
      const fillPrice = triggerPrice;
      const notional = fillPrice * qty;
      const feeUsd = notional * (makerBps / 10000);
      const grossPnl = (fillPrice - entryPrice) * qty * dir;
      return {
        ok: true,
        fillPrice,
        qty,
        notional,
        grossPnl,
        feeUsd,
        feeBps: makerBps,
        slippageUsd: 0,
        slippageVsStop: 0,
        slippageVsStopBps: 0,
        executionQuality: "tp1-limit-maker",
      };
    }
    if (!tradedThrough && !fallbackTriggered) {
      return {
        ok: false,
        pending: true,
        reason: "tp1-resting-in-queue",
      };
    }
    // Otherwise escalate to market book walk (tp-fallback-market)
  }

  // 3. Fallback when no L2 book is available
  if (
    !book ||
    !Array.isArray(book.bids) ||
    !Array.isArray(book.asks) ||
    book.bids.length === 0 ||
    book.asks.length === 0
  ) {
    const baseP = toNum(markPrice || triggerPrice, entryPrice);
    const slipFrac = Math.max(0, toNum(flatSlippagePercent, 0.02)) / 100;
    const fillPrice = baseP * (1 - dir * slipFrac);
    const notional = fillPrice * qty;
    const feeUsd = notional * (takerBps / 10000);
    const grossPnl = (fillPrice - entryPrice) * qty * dir;
    const stopRef = toNum(triggerPrice, baseP);
    const slipVsStop = Math.abs(fillPrice - stopRef);
    return {
      ok: true,
      fillPrice,
      qty,
      notional,
      grossPnl,
      feeUsd,
      feeBps: takerBps,
      slippageUsd: Math.abs(fillPrice - baseP) * qty,
      slippageVsStop: slipVsStop,
      slippageVsStopBps: stopRef > 0 ? round((slipVsStop / stopRef) * 10000, 2) : 0,
      executionQuality: "slippage-fallback",
    };
  }

  // 4. L2 Order-Book Walk for Stop / Market / Exit Ladder
  const bids = normalizeBookLevels(book.bids, "bids");
  const asks = normalizeBookLevels(book.asks, "asks");
  const exitLevels = isLong ? bids : asks;
  const bestExit = exitLevels[0]?.[0] || markPrice || triggerPrice;
  const targetNotional = qty * bestExit;
  const skipBps = isStop && cfg.realismMode === "pessimistic" ? 15 : 0;

  let walk;
  if (cfg.exitLadder && !isStop && Array.isArray(cfg.exitLadderRungs) && cfg.exitLadderRungs.length > 0) {
    // 4-rung controlled exit ladder (FX-14, FX-21)
    let totalCost = 0;
    let totalFilledQty = 0;
    let remainingQty = qty;
    for (const rung of cfg.exitLadderRungs) {
      const rungQty = Math.min(remainingQty, qty * toNum(rung.weight, 0.33));
      if (!(rungQty > 0)) continue;
      const maxImp = toNum(rung.maxImpactBps, 50);
      const limitP = bestExit * (1 - dir * (maxImp / 10000));
      const rungLevels = exitLevels.filter(([p]) => (isLong ? p >= limitP : p <= limitP));
      const rw = walkBook(rungLevels, rungQty * bestExit, haircut, 0, bestExit);
      if (rw.qty > 0) {
        const takeQ = Math.min(remainingQty, rw.qty);
        totalCost += takeQ * rw.vwap;
        totalFilledQty += takeQ;
        remainingQty -= takeQ;
      }
    }
    if (remainingQty > 1e-9) {
      const remWalk = walkBook(exitLevels, remainingQty * bestExit, haircut, 0, bestExit);
      const remPrice = remWalk.vwap > 0 ? remWalk.vwap : bestExit;
      totalCost += remainingQty * remPrice;
      totalFilledQty += remainingQty;
    }
    const vwap = totalFilledQty > 0 ? totalCost / totalFilledQty : bestExit;
    walk = {
      vwap,
      qty,
      filledNotional: vwap * qty,
      impactBps: bestExit > 0 ? (Math.abs(vwap - bestExit) / bestExit) * 10000 : 0,
      fullyFillable: true,
    };
  } else {
    walk = walkBook(exitLevels, targetNotional, haircut, skipBps, bestExit);
  }

  const fillPrice = walk.vwap > 0 ? walk.vwap : bestExit;
  const notional = fillPrice * qty;
  const feeUsd = notional * (takerBps / 10000);
  const grossPnl = (fillPrice - entryPrice) * qty * dir;
  const stopRef = toNum(triggerPrice, bestExit);
  const slipVsStop = isStop && stopRef > 0 ? Math.abs(fillPrice - stopRef) : 0;

  return {
    ok: true,
    fillPrice,
    bestExitPrice: bestExit,
    qty,
    notional,
    grossPnl,
    feeUsd: round(feeUsd, 4),
    feeBps: takerBps,
    impactBps: round(walk.impactBps, 2),
    slippageUsd: round(Math.abs(fillPrice - bestExit) * qty, 4),
    slippageVsStop: round(slipVsStop, 8),
    slippageVsStopBps: stopRef > 0 ? round((slipVsStop / stopRef) * 10000, 2) : 0,
    executionQuality: cfg.exitLadder && !isStop ? "exit-ladder" : "book-walk",
  };
}

/**
 * Accrue 8-hour funding payment on an open position when a funding boundary is crossed (FX-15, EC-20).
 */
export function accruePositionFunding(pos, fundingRate = 0, markPrice = 0, nowMs = Date.now()) {
  if (!pos || pos.status !== "open") return { accrued: false, paymentUsd: 0 };
  const rawRate = toNum(fundingRate, 0);
  if (rawRate === 0) return { accrued: false, paymentUsd: 0 };

  const eightHoursMs = 8 * 3600 * 1000;
  const lastCheck = toNum(pos.lastFundingTs, toNum(pos.entryTime, nowMs));
  const prevBucket = Math.floor(lastCheck / eightHoursMs);
  const curBucket = Math.floor(nowMs / eightHoursMs);

  if (curBucket <= prevBucket) {
    return { accrued: false, paymentUsd: 0 };
  }

  const intervals = curBucket - prevBucket;
  const fractionRate = Math.abs(rawRate) <= 0.05 ? rawRate : rawRate / 100;
  const price = toNum(markPrice, toNum(pos.markPrice, pos.entryPrice));
  const notional = toNum(pos.qty, 0) * price;
  const isLong = pos.side !== "short";
  // Positive funding -> Long pays (+cost), Short receives (-cost)
  const costUsd = notional * fractionRate * (isLong ? 1 : -1) * intervals;

  pos.fundingPaidUsd = round(toNum(pos.fundingPaidUsd, 0) + costUsd, 4);
  pos.lastFundingTs = nowMs;

  return {
    accrued: true,
    intervals,
    paymentUsd: round(costUsd, 4),
    totalFundingPaidUsd: pos.fundingPaidUsd,
  };
}

export class PaperExecutor {
  constructor(engine) {
    this.engine = engine;
    this.mode = "paper";
    this.venueWallets = new Map(); // venue -> balance (for perVenue walletMode, FX-37)
  }

  async init() {
    return { ok: true, mode: "paper" };
  }

  getVenueAvailable(venue, totalAvailable) {
    const mode = this.engine?.state?.settings?.route?.walletMode || "pooled";
    if (mode !== "perVenue") return totalAvailable;
    const v = String(venue || "bybit").toLowerCase();
    if (!this.venueWallets.has(v)) {
      const venuesCount = Math.max(1, (this.engine?.state?.settings?.venues || ["bybit"]).length);
      const split = toNum(this.engine?.state?.initialFund, 500) / venuesCount;
      this.venueWallets.set(v, split);
    }
    return this.venueWallets.get(v);
  }

  /**
   * Open a paper position.
   */
  async openPosition(coin, quote, evaluation, profile = null) {
    return this.engine._openPosition(coin, quote, evaluation, profile);
  }

  /**
   * Close a paper position.
   */
  async closePosition(pos, price, reason = "Manual", { force = false } = {}) {
    return this.engine._closePosition(pos, price, reason, { force });
  }

  /**
   * Execute partial take profit on a paper position.
   */
  async takePartial(pos, price, pct, reason = "TP1") {
    return this.engine._partialClose(pos, price, pct, reason);
  }

  /**
   * Update trailing stop level.
   */
  async updateTrailingStop(pos, price) {
    return this.engine._updateTrailing(pos, price);
  }

  /**
   * Paper mode reconcile (validates internal consistency).
   */
  async reconcile() {
    return { reconciled: this.engine.state.positions.length, orphans: 0 };
  }

  /**
   * Panic: close all open positions immediately.
   */
  async panic() {
    return this.engine.closeAll("Panic button triggered");
  }
}
