/**
 * Smart Order Router (SOR) & Multi-Venue Cost Engine
 *
 * Implements Section 6 (FX-30..FX-39), Section 8.3 (EC-25), and Section 10.4.
 */

import { clamp, round, toNum } from "../../util.js";
import { evaluateExecutability } from "../eqe/index.js";
import {
  checkListingAge,
  clampToLeverageBracket,
  isTradableContractStatus,
  isUsdtLinearPerp,
} from "../units.js";

export const DEFAULT_ROUTE_SETTINGS = {
  mode: "auto", // "auto" | "pinned" | "priority"
  pinnedVenue: "bybit",
  priority: ["bybit", "binance", "gate", "kucoin", "mexc"],
  paperScope: "all", // "all" | "connectedOnly" | "pinned" | "custom"
  paperCustomVenues: ["bybit", "binance", "gate", "kucoin", "mexc"],
  walletMode: "pooled", // "pooled" | "perVenue"
  failoverOnReject: true,
  bookFetchLimit: 3,
  calibrateSlippage: true,
  splitOrders: false,
  expectedHoldHours: 2,
};

export const VENUE_FEE_SCHEDULE_BPS = {
  binance: { makerBps: 2.0, takerBps: 5.0 },
  bybit: { makerBps: 2.0, takerBps: 5.5 },
  gate: { makerBps: 1.5, takerBps: 5.0 },
  kucoin: { makerBps: 2.0, takerBps: 6.0 },
  mexc: { makerBps: 0.0, takerBps: 2.0 },
  bitget: { makerBps: 2.0, takerBps: 6.0 },
  okx: { makerBps: 2.0, takerBps: 5.0 },
};

export class SmartOrderRouter {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_ROUTE_SETTINGS, ...(settings?.route || settings || {}) };
    this.calibrationWindowSize = 50;
    this.calibrationByVenue = new Map(); // venue -> Array<{ predictedBps, realizedBps, driftBps, ts }>
  }

  updateSettings(patch = {}) {
    this.settings = { ...this.settings, ...(patch?.route || patch || {}) };
  }

  /**
   * Record realized vs predicted entry slippage for rolling 50-fill calibration (FX-36).
   */
  recordFillCalibration(venue, arg1 = {}, arg2 = undefined) {
    const v = String(venue || "").toLowerCase();
    if (!v) return;
    if (!this.calibrationByVenue.has(v)) {
      this.calibrationByVenue.set(v, []);
    }
    const isObj = arg1 && typeof arg1 === "object";
    const predictedImpactBps = isObj ? arg1.predictedImpactBps : arg1;
    const realizedSlippageBps = isObj ? arg1.realizedSlippageBps : arg2;
    const ts = (isObj ? arg1.ts : null) || Date.now();
    const list = this.calibrationByVenue.get(v);
    const driftBps = toNum(realizedSlippageBps, 0) - toNum(predictedImpactBps, 0);
    list.push({
      predictedBps: toNum(predictedImpactBps, 0),
      realizedBps: toNum(realizedSlippageBps, 0),
      driftBps,
      ts,
    });
    if (list.length > this.calibrationWindowSize) {
      list.splice(0, list.length - this.calibrationWindowSize);
    }
  }

  /**
   * Get rolling slippage drift penalty (bps) for a venue (FX-36).
   */
  getSlippageDriftPenaltyBps(venue) {
    if (!this.settings.calibrateSlippage) return 0;
    const list = this.calibrationByVenue.get(String(venue || "").toLowerCase());
    if (!list || list.length === 0) return 0;
    const avgDrift = list.reduce((acc, item) => acc + item.driftBps, 0) / list.length;
    return Math.max(0, round(avgDrift, 2));
  }

  /**
   * Pre-rank candidate venues so we only fetch full L2 books for the top `bookFetchLimit` venues (FX-34).
   */
  preRankVenues(venues = [], { mode = null, pinnedVenue = null, priority = null } = {}) {
    const cfg = {
      ...this.settings,
      ...(mode ? { mode } : {}),
      ...(pinnedVenue ? { pinnedVenue } : {}),
      ...(priority ? { priority } : {}),
    };

    if (cfg.mode === "pinned") {
      return venues.filter((v) => (v.venue || v.id) === cfg.pinnedVenue);
    }

    const priorityOrder = Array.isArray(cfg.priority) ? cfg.priority : DEFAULT_ROUTE_SETTINGS.priority;
    const scored = venues.map((v) => {
      const id = String(v.venue || v.id || "").toLowerCase();
      const volScore = Math.log10(Math.max(1, toNum(v.volUsd24h ?? v.volUsd, 1)));
      const feeTaker = VENUE_FEE_SCHEDULE_BPS[id]?.takerBps ?? 5.5;
      const spreadEst = toNum(v.spreadBps, 5);
      const prioIdx = priorityOrder.indexOf(id);
      const prioBonus = prioIdx >= 0 ? (priorityOrder.length - prioIdx) * 0.5 : 0;
      const preScore = volScore * 3 - feeTaker - spreadEst * 0.5 + prioBonus;
      return { ...v, venue: id, _preScore: preScore };
    });

    scored.sort((a, b) => b._preScore - a._preScore);
    const limit = Math.max(1, toNum(cfg.bookFetchLimit, 3));
    return scored.slice(0, limit);
  }

  /**
   * Compute expected funding cost in bps over expectedHoldHours.
   */
  computeExpectedFundingBps({ side, fundingRate = 0, nextFundingTs = null, nowMs = Date.now(), expectedHoldHours = 2 }) {
    const raw = toNum(fundingRate, 0);
    if (raw === 0) return 0;
    const rateBps = Math.abs(raw) <= 0.05 ? raw * 10000 : raw * 100;
    const isLong = side !== "short";
    const costPerIntervalBps = isLong ? rateBps : -rateBps;

    const holdMs = Math.max(0.25, toNum(expectedHoldHours, 2)) * 3600 * 1000;
    const eightHoursMs = 8 * 3600 * 1000;
    const nextBoundary =
      nextFundingTs && nextFundingTs > nowMs
        ? nextFundingTs
        : Math.ceil((nowMs + 1) / eightHoursMs) * eightHoursMs;

    if (nowMs + holdMs < nextBoundary) {
      return 0;
    }

    const intervalsCrossed = 1 + Math.floor((nowMs + holdMs - nextBoundary) / eightHoursMs);
    return clamp(round(costPerIntervalBps * intervalsCrossed, 2), -5, 100);
  }

  /**
   * Evaluate a single venue for eligibility (FX-30a..h) and basis-point cost (Section 6.2).
   */
  evaluateVenueCandidate({
    venueCandidate,
    symbol,
    side = "long",
    plannedNotional = 1000,
    desiredLeverage = 20,
    tp1ClosePercent = 50,
    executionMode = "paper", // "paper" | "live"
    coin = null,
    openPositions = [],
    maxPositionsPerCoin = 1,
    clampLeverage = true,
    expectedMoveBps = null,
    settings = {},
    nowMs = Date.now(),
  }) {
    const vKey = String(venueCandidate.venue || venueCandidate.id || "").toLowerCase();
    const rejectReasons = [];
    const warnings = [];
    const routeCfg = { ...this.settings, ...(settings?.route || {}) };

    // FX-30g: Circuit breaker / health check
    const healthState = String(venueCandidate.health || "ok").toLowerCase();
    if (healthState === "down" || venueCandidate.disabled === true || venueCandidate.circuitOpen === true) {
      rejectReasons.push("venue-disabled");
    }

    // FX-30a: Credential / Scope eligibility
    if (executionMode === "live") {
      const hasValidKey = Boolean(venueCandidate.connected && venueCandidate.canTrade !== false && !venueCandidate.canWithdraw);
      const tradingCapable = venueCandidate.capabilities?.trading !== false;
      if (!hasValidKey || !tradingCapable) {
        rejectReasons.push("venue-unavailable");
      }
    } else {
      const scope = routeCfg.paperScope || "all";
      if (scope === "connectedOnly" && !venueCandidate.connected) {
        rejectReasons.push("venue-unavailable");
      } else if (scope === "pinned" && vKey !== routeCfg.pinnedVenue) {
        rejectReasons.push("venue-unavailable");
      } else if (
        scope === "custom" &&
        Array.isArray(routeCfg.paperCustomVenues) &&
        !routeCfg.paperCustomVenues.includes(vKey)
      ) {
        rejectReasons.push("venue-unavailable");
      }
    }

    // FX-30b: Instrument listing, USDT linear perp, trading status, listing age
    const inst = venueCandidate.instrument || null;
    if (!inst && venueCandidate.listed === false) {
      rejectReasons.push("not-listed");
    } else if (inst) {
      if (!isTradableContractStatus(inst)) {
        rejectReasons.push("status-not-trading");
      } else if (!isUsdtLinearPerp(inst)) {
        rejectReasons.push("not-listed");
      }
      const ageCheck = checkListingAge(
        inst,
        toNum(settings?.risk?.minListingAgeHours, 24),
        nowMs
      );
      if (!ageCheck.ok) {
        rejectReasons.push("too-new");
      }
    }

    // FX-30d: Leverage support / clamping
    const levCheck = clampToLeverageBracket({
      desiredLeverage,
      notional: plannedNotional,
      instrument: inst || { maxLeverage: venueCandidate.maxLeverage || 100 },
      clampLeverage,
    });
    if (!levCheck.ok) {
      rejectReasons.push("leverage-unavailable");
    } else if (levCheck.clamped) {
      warnings.push("leverage-clamped");
    }
    const effectiveLeverage = levCheck.leverage || desiredLeverage;

    // FX-30f: Position conflict / per-coin cap on this venue
    const oppositeSide = side === "long" ? "short" : "long";
    const venuePositions = openPositions.filter(
      (p) =>
        String(p.symbol).toUpperCase() === String(symbol).toUpperCase() &&
        (!p.venue || String(p.venue).toLowerCase() === vKey)
    );
    if (venuePositions.some((p) => p.side === oppositeSide)) {
      rejectReasons.push("position-conflict");
    } else if (venuePositions.filter((p) => p.side === side).length >= maxPositionsPerCoin) {
      rejectReasons.push("position-conflict");
    }

    // Fee schedule (bps)
    const feeSchedule = {
      ...(VENUE_FEE_SCHEDULE_BPS[vKey] || { makerBps: 2.0, takerBps: 5.5 }),
      ...(venueCandidate.fees || {}),
    };
    const feeEntryBps = toNum(feeSchedule.takerBps, 5.0);
    const tp1Share = clamp(toNum(tp1ClosePercent, 50) / 100, 0, 1);
    const feeExitBps = round(
      tp1Share * toNum(feeSchedule.makerBps, 2.0) + (1 - tp1Share) * toNum(feeSchedule.takerBps, 5.0),
      2
    );

    const expectedFundingBps = this.computeExpectedFundingBps({
      side,
      fundingRate: venueCandidate.fundingRate ?? coin?.funding ?? 0,
      nextFundingTs: venueCandidate.nextFundingTs ?? null,
      nowMs,
      expectedHoldHours: routeCfg.expectedHoldHours,
    });

    // FX-30e: Run EQE order-book gate
    const eqeReport = evaluateExecutability({
      symbol,
      venue: vKey,
      side,
      plannedNotional,
      book: venueCandidate.book,
      snapshots: venueCandidate.snapshots,
      coin,
      markPrice: venueCandidate.markPrice ?? coin?.price,
      instrument: inst || {},
      settings,
      feeEntryBps,
      feeExitBps,
      fundingBps: expectedFundingBps,
      expectedMoveBps,
      nowMs,
    });

    if (!eqeReport.pass) {
      for (const r of eqeReport.reasons) {
        if (!rejectReasons.includes(r)) rejectReasons.push(r);
      }
    }

    const approvedNotional = eqeReport.pass ? eqeReport.approvedNotional : plannedNotional;
    const requiredMargin = approvedNotional / Math.max(1, effectiveLeverage);
    const estEntryFeeUsd = approvedNotional * (feeEntryBps / 10000);

    // FX-30c: Available margin check (evaluated at approvedNotional so size-to-fit can help)
    const availableUsdt = toNum(venueCandidate.availableUsdt, Infinity);
    if (requiredMargin + estEntryFeeUsd > availableUsdt + 1e-6) {
      rejectReasons.push("insufficient-margin");
    }

    // Cost components (Section 6.2)
    const entryImpactBps = toNum(eqeReport.metrics?.entryImpactBps, Infinity);
    const exitNowImpactBps = toNum(eqeReport.metrics?.exitNowImpactBps, Infinity);
    const exitStressImpactBps = toNum(eqeReport.metrics?.exitStressImpactBps, Infinity);
    const exitExpectedImpactBps =
      Number.isFinite(exitNowImpactBps) && Number.isFinite(exitStressImpactBps)
        ? round(0.5 * exitNowImpactBps + 0.5 * exitStressImpactBps, 2)
        : Infinity;

    const p95OrderRttMs = toNum(venueCandidate.p95OrderRttMs ?? venueCandidate.latencyMs, 100);
    const latencyPenaltyBps = round(Math.max(0, (p95OrderRttMs - 100) / 100) * 0.5, 2);

    const recentErrorRate = clamp(toNum(venueCandidate.recentErrorRate, 0), 0, 1);
    const degradedPenalty = healthState === "degraded" ? 5.0 : 0;
    const reliabilityPenaltyBps = round(recentErrorRate * 20 + degradedPenalty, 2);

    const slippageDriftPenaltyBps = toNum(
      venueCandidate.slippageDriftPenaltyBps ?? this.getSlippageDriftPenaltyBps(vKey),
      0
    );

    const eligible = rejectReasons.length === 0 && eqeReport.pass;
    const totalCostBps =
      eligible && Number.isFinite(entryImpactBps) && Number.isFinite(exitExpectedImpactBps)
        ? round(
            feeEntryBps +
              feeExitBps +
              entryImpactBps +
              exitExpectedImpactBps +
              expectedFundingBps +
              latencyPenaltyBps +
              reliabilityPenaltyBps +
              slippageDriftPenaltyBps,
            2
          )
        : Infinity;

    return {
      venue: vKey,
      venueName: venueCandidate.venueName || venueCandidate.name || vKey.toUpperCase(),
      eligible,
      action: eligible ? eqeReport.action : "reject",
      approvedNotional: eligible ? eqeReport.approvedNotional : 0,
      effectiveLeverage,
      leverageClamped: Boolean(levCheck.clamped),
      totalCostBps,
      exitStressDepthUsd: toNum(eqeReport.metrics?.exitDepth50, 0),
      breakdown: {
        feeEntryBps,
        feeExitBps,
        entryImpactBps: Number.isFinite(entryImpactBps) ? entryImpactBps : null,
        exitNowImpactBps: Number.isFinite(exitNowImpactBps) ? exitNowImpactBps : null,
        exitStressImpactBps: Number.isFinite(exitStressImpactBps) ? exitStressImpactBps : null,
        exitExpectedImpactBps: Number.isFinite(exitExpectedImpactBps) ? exitExpectedImpactBps : null,
        expectedFundingBps,
        latencyPenaltyBps,
        reliabilityPenaltyBps,
        slippageDriftPenaltyBps,
      },
      rejectReasons,
      warnings,
      eqe: eqeReport,
      instrument: inst,
    };
  }

  /**
   * Select the optimal venue (or split route) across candidates (FX-31, FX-32, FX-33, FX-39).
   */
  routeOrder({
    symbol,
    side = "long",
    plannedNotional = null,
    desiredNotional = null,
    desiredLeverage = 20,
    leverage = null,
    tp1ClosePercent = 50,
    executionMode = null,
    mode = null,
    candidates = [],
    coin = null,
    openPositions = [],
    maxPositionsPerCoin = 1,
    clampLeverage = true,
    expectedMoveBps = null,
    settings = {},
    nowMs = Date.now(),
  } = {}) {
    plannedNotional = toNum(plannedNotional ?? desiredNotional, 1000) || 1000;
    desiredLeverage = toNum(leverage ?? desiredLeverage, 20) || 20;
    executionMode = executionMode || mode || "paper";
    const routeCfg = { ...this.settings, ...(settings?.route || {}) };
    mode = routeCfg.mode || "auto";
    const priorityList = Array.isArray(routeCfg.priority)
      ? routeCfg.priority.map((v) => String(v).toLowerCase())
      : DEFAULT_ROUTE_SETTINGS.priority;

    // Filter candidate list if mode is pinned
    const activeCandidates =
      mode === "pinned"
        ? candidates.filter(
            (c) => String(c.venue || c.id || "").toLowerCase() === String(routeCfg.pinnedVenue).toLowerCase()
          )
        : candidates;

    const evaluated = activeCandidates.map((cand) =>
      this.evaluateVenueCandidate({
        venueCandidate: cand,
        symbol,
        side,
        plannedNotional,
        desiredLeverage,
        tp1ClosePercent,
        executionMode,
        coin,
        openPositions,
        maxPositionsPerCoin,
        clampLeverage,
        expectedMoveBps,
        settings,
        nowMs,
      })
    );

    const eligibleList = evaluated.filter((e) => e.eligible);

    // Sort eligible candidates according to routing mode (FX-31, FX-33)
    if (mode === "priority") {
      eligibleList.sort((a, b) => {
        const idxA = priorityList.indexOf(a.venue);
        const idxB = priorityList.indexOf(b.venue);
        const rankA = idxA >= 0 ? idxA : 999;
        const rankB = idxB >= 0 ? idxB : 999;
        if (rankA !== rankB) return rankA - rankB;
        return a.totalCostBps - b.totalCostBps;
      });
    } else {
      // Auto mode: sort by lowest totalCostBps; tie-break within 0.5 bps by deeper exitDepth50, then priority list
      eligibleList.sort((a, b) => {
        const diff = a.totalCostBps - b.totalCostBps;
        if (Math.abs(diff) > 0.5) return diff;
        if (Math.abs(b.exitStressDepthUsd - a.exitStressDepthUsd) > 100) {
          return b.exitStressDepthUsd - a.exitStressDepthUsd;
        }
        const idxA = priorityList.indexOf(a.venue);
        const idxB = priorityList.indexOf(b.venue);
        return (idxA >= 0 ? idxA : 999) - (idxB >= 0 ? idxB : 999);
      });
    }

    const winner = eligibleList[0] || null;
    const runnerUp = eligibleList[1] || null;

    // Optional Split Routing across top 2 venues (FX-39, P2)
    let splitLegs = null;
    if (routeCfg.splitOrders && eligibleList.length >= 2) {
      const v1 = eligibleList[0];
      const v2 = eligibleList[1];
      const d1 = Math.max(1, v1.exitStressDepthUsd);
      const d2 = Math.max(1, v2.exitStressDepthUsd);
      const share1 = clamp(d1 / (d1 + d2), 0.25, 0.75);
      const leg1Notional = round(plannedNotional * share1, 2);
      const leg2Notional = round(plannedNotional - leg1Notional, 2);
      splitLegs = [
        { venue: v1.venue, notional: leg1Notional, share: round(share1, 2), costBps: v1.totalCostBps },
        { venue: v2.venue, notional: leg2Notional, share: round(1 - share1, 2), costBps: v2.totalCostBps },
      ];
    }

    const savingsBps =
      winner && runnerUp && Number.isFinite(winner.totalCostBps) && Number.isFinite(runnerUp.totalCostBps)
        ? round(Math.max(0, runnerUp.totalCostBps - winner.totalCostBps), 2)
        : 0;

    const allRejectReasons =
      !winner && evaluated.length > 0
        ? [...new Set(evaluated.flatMap((e) => e.rejectReasons))]
        : !winner
        ? ["venue-unavailable"]
        : [];

    const routeExplain = {
      symbol,
      side,
      mode,
      executionMode,
      pass: Boolean(winner),
      selectedVenue: winner ? winner.venue : null,
      selectedVenueName: winner ? winner.venueName : null,
      action: winner ? winner.action : "reject",
      plannedNotional,
      approvedNotional: winner ? winner.approvedNotional : 0,
      effectiveLeverage: winner ? winner.effectiveLeverage : desiredLeverage,
      selectedCostBps: winner ? winner.totalCostBps : null,
      runnerUpVenue: runnerUp ? runnerUp.venue : null,
      runnerUpCostBps: runnerUp ? runnerUp.totalCostBps : null,
      savingsBps,
      splitLegs,
      reasons: winner ? (winner.action === "size-reduced" ? ["size-reduced"] : []) : allRejectReasons,
      candidates: evaluated.map((c) => ({
        venue: c.venue,
        venueName: c.venueName,
        eligible: c.eligible,
        action: c.action,
        approvedNotional: c.approvedNotional,
        effectiveLeverage: c.effectiveLeverage,
        totalCostBps: Number.isFinite(c.totalCostBps) ? c.totalCostBps : null,
        breakdown: c.breakdown,
        rejectReasons: c.rejectReasons,
        warnings: c.warnings,
        eqe: c.eqe,
      })),
      timestamp: nowMs,
    };

    const explanation = winner
      ? `${mode === "auto" ? "Auto" : mode === "pinned" ? "Pinned" : "Priority"} -> ${winner.venueName} (${winner.totalCostBps} bps)`
      : `Blocked (${allRejectReasons.join(", ") || "no-venue"})`;

    return {
      ok: Boolean(winner),
      winner,
      selected: winner,
      runnerUp,
      savingsBps,
      explanation,
      splitLegs,
      routeExplain,
      candidates: routeExplain.candidates,
    };
  }

  /**
   * Failover execution wrapper (FX-35, EC-25).
   * Never retries or fails over on ambiguous network timeout unless absence of fill is verified first.
   */
  async executeWithFailover({
    routeDecision,
    submitOrderFn,
    verifyOrderAbsentFn = null,
    signalTimestampMs = Date.now(),
    maxSignalAgeMs = 20000,
    nowFn = () => Date.now(),
  }) {
    if (!routeDecision || !routeDecision.ok || !routeDecision.winner) {
      return {
        ok: false,
        status: "REJECTED",
        reason: routeDecision?.routeExplain?.reasons?.[0] || "no-eligible-venue",
        routeExplain: routeDecision?.routeExplain || null,
      };
    }

    const primary = routeDecision.winner;
    const runnerUp = routeDecision.runnerUp;
    const allowFailover = Boolean(this.settings.failoverOnReject && runnerUp && runnerUp.eligible);

    try {
      const res = await submitOrderFn(primary);
      if (res && res.ok !== false && res.status !== "REJECTED") {
        return {
          ok: true,
          status: res.status || "FILLED",
          venue: primary.venue,
          result: res,
          routeFailoverFrom: null,
          routeExplain: routeDecision.routeExplain,
        };
      }
      // Clean rejection before fill (0 filled)
      const filledQty = toNum(res?.filledQty ?? res?.qty, 0);
      if (filledQty > 0) {
        return {
          ok: true,
          status: "PARTIAL",
          venue: primary.venue,
          result: res,
          routeFailoverFrom: null,
          routeExplain: routeDecision.routeExplain,
        };
      }
    } catch (err) {
      const isAmbiguousTimeout =
        Boolean(err?.ambiguous || err?.code === "ETIMEDOUT" || /timeout|unknown|network/i.test(String(err?.message || "")));

      if (isAmbiguousTimeout) {
        // EC-25: MUST query exchange by clientOrderId before any failover!
        if (typeof verifyOrderAbsentFn === "function") {
          const check = await verifyOrderAbsentFn(primary.venue, err.clientId).catch(() => ({ absent: false }));
          if (!check || !check.absent) {
            return {
              ok: false,
              status: "UNKNOWN",
              venue: primary.venue,
              reason: "ambiguous-order-timeout",
              error: err.message,
              routeExplain: routeDecision.routeExplain,
            };
          }
        } else {
          return {
            ok: false,
            status: "UNKNOWN",
            venue: primary.venue,
            reason: "ambiguous-order-timeout",
            error: err.message,
            routeExplain: routeDecision.routeExplain,
          };
        }
      }

      if (!allowFailover) {
        return {
          ok: false,
          status: "REJECTED",
          venue: primary.venue,
          reason: err.message || "primary-venue-rejected",
          routeExplain: routeDecision.routeExplain,
        };
      }
    }

    if (!allowFailover) {
      return {
        ok: false,
        status: "REJECTED",
        venue: primary.venue,
        reason: "primary-venue-rejected",
        routeExplain: routeDecision.routeExplain,
      };
    }

    // Check signal freshness before failing over to runnerUp (FX-35)
    if (nowFn() - signalTimestampMs > maxSignalAgeMs) {
      return {
        ok: false,
        status: "REJECTED",
        venue: primary.venue,
        reason: "signal-expired-before-failover",
        routeExplain: routeDecision.routeExplain,
      };
    }

    try {
      const fallbackRes = await submitOrderFn(runnerUp);
      if (fallbackRes && fallbackRes.ok !== false && fallbackRes.status !== "REJECTED") {
        return {
          ok: true,
          status: fallbackRes.status || "FILLED",
          venue: runnerUp.venue,
          result: fallbackRes,
          routeFailoverFrom: primary.venue,
          routeExplain: {
            ...routeDecision.routeExplain,
            selectedVenue: runnerUp.venue,
            selectedVenueName: runnerUp.venueName,
            routeFailoverFrom: primary.venue,
          },
        };
      }
      return {
        ok: false,
        status: "REJECTED",
        venue: runnerUp.venue,
        routeFailoverFrom: primary.venue,
        reason: fallbackRes?.reason || "runner-up-rejected",
        routeExplain: routeDecision.routeExplain,
      };
    } catch (err2) {
      return {
        ok: false,
        status: "REJECTED",
        venue: runnerUp.venue,
        routeFailoverFrom: primary.venue,
        reason: err2.message || "runner-up-failed",
        routeExplain: routeDecision.routeExplain,
      };
    }
  }
}

/**
 * Cross-venue exposure aggregation across open positions (FX-38).
 */
export function computeCrossVenueExposure(positions = []) {
  const byVenue = {};
  const bySymbol = {};
  let totalLongNotional = 0;
  let totalShortNotional = 0;
  let totalMargin = 0;

  for (const p of Array.isArray(positions) ? positions : []) {
    if (!p || p.status === "closed") continue;
    const venue = String(p.venue || "unknown").toLowerCase();
    const sym = String(p.symbol || "").toUpperCase();
    const notional = toNum(p.notional, toNum(p.qty, 0) * toNum(p.markPrice ?? p.entryPrice, 0));
    const margin = toNum(p.margin, 0);
    const isLong = p.side !== "short";

    if (isLong) totalLongNotional += notional;
    else totalShortNotional += notional;
    totalMargin += margin;

    if (!byVenue[venue]) {
      byVenue[venue] = { venue, count: 0, longNotional: 0, shortNotional: 0, margin: 0 };
    }
    byVenue[venue].count++;
    if (isLong) byVenue[venue].longNotional += notional;
    else byVenue[venue].shortNotional += notional;
    byVenue[venue].margin += margin;

    if (!bySymbol[sym]) {
      bySymbol[sym] = { symbol: sym, count: 0, longNotional: 0, shortNotional: 0, venues: [] };
    }
    bySymbol[sym].count++;
    if (isLong) bySymbol[sym].longNotional += notional;
    else bySymbol[sym].shortNotional += notional;
    if (!bySymbol[sym].venues.includes(venue)) bySymbol[sym].venues.push(venue);
  }

  return {
    totalLongNotional: round(totalLongNotional, 2),
    totalShortNotional: round(totalShortNotional, 2),
    netNotional: round(totalLongNotional - totalShortNotional, 2),
    totalMargin: round(totalMargin, 2),
    byVenue,
    bySymbol,
  };
}
