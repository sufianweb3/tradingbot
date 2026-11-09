/**
 * Execution Quality Engine (EQE)
 *
 * Implements Section 3 (FX-01..FX-07d), Section 4.5 (walkBook),
 * Section 8.2 (EC-13..EC-18), and Section 8.6 (EC-49).
 * Pure, deterministic order-book depth, walk impact, anti-spoof, exit-stress,
 * liquidity-fitted sizing, and continuous exit liquidity monitoring.
 */

import { clamp, round, toNum } from "../../util.js";
import { roundAndValidateQty } from "../units.js";

export const DEFAULT_EQE_SETTINGS = {
  enabled: true,
  bookDepthLevels: 50,
  maxBookAgeMs: 2500,
  minBookLevels: 10,
  maxAdjacentGapBps: 25,
  maxSpreadBps: 15,
  minEntryDepthMult: 3,
  minExitDepthMult: 4,
  minOppositeDepthRatio: 0.35,
  maxEntryImpactBps: 20,
  maxExitStressImpactBps: 50,
  exitStressHaircut: 0.4,
  exitStressGapBps: 15,
  maxWallDominance: 0.6,
  wallHaircut: 0.75,
  stableSnapshots: 3,
  stableMinSpanMs: 300,
  maxDepthVolatility: 0.5,
  maxParticipation1mPct: 5,
  maxParticipation5mPct: 1.5,
  minEdgeMultiple: 2.0,
  liquiditySizing: true,
  minViableFraction: 0.25,
  onLiquidityCollapse: "tighten", // alert | tighten | reduce | close
  collapseGraceReads: 2,
  minAbsOiChangeUsd: 250000,
  minAbsVol1hUsd: 500000,
  maxBasisBps: 50,
  maxSignalAgeSec: 20,
};

function parseLevel(lvl) {
  if (!lvl) return null;
  const price = Array.isArray(lvl) ? Number(lvl[0]) : Number(lvl.price ?? lvl.p);
  const size = Array.isArray(lvl) ? Number(lvl[1]) : Number(lvl.size ?? lvl.qty ?? lvl.q);
  if (!(price > 0) || !(size >= 0)) return null;
  return [price, size];
}

export function normalizeBookLevels(rawLevels, side = "bids") {
  const out = [];
  for (const raw of Array.isArray(rawLevels) ? rawLevels : []) {
    const parsed = parseLevel(raw);
    if (parsed && parsed[1] > 0) out.push(parsed);
  }
  if (side === "bids") {
    out.sort((a, b) => b[0] - a[0]);
  } else {
    out.sort((a, b) => a[0] - b[0]);
  }
  return out;
}

/**
 * Reference Book-Walk Algorithm (Section 4.5).
 * Walks bid or ask levels to fill targetNotional (USD) with optional haircut and skipBps.
 */
export function walkBook(levels, targetNotional, haircut = 0, skipBps = 0, bestPrice = null) {
  const target = Math.max(0, toNum(targetNotional, 0));
  const h = clamp(toNum(haircut, 0), 0, 0.99);
  const skip = Math.max(0, toNum(skipBps, 0));

  const norm = Array.isArray(levels) ? levels : [];
  const firstPrice = norm.length > 0 ? (Array.isArray(norm[0]) ? Number(norm[0][0]) : Number(norm[0]?.price)) : 0;
  const best = toNum(bestPrice, firstPrice) || firstPrice;

  if (!(target > 0)) {
    return {
      fullyFillable: true,
      filledNotional: 0,
      unfilledNotional: 0,
      qty: 0,
      vwap: best,
      worstPrice: best,
      bestPrice: best,
      impactBps: 0,
      levelsConsumed: 0,
    };
  }

  let remaining = target;
  let cost = 0;
  let qty = 0;
  let levelsConsumed = 0;
  let worstPrice = best;

  for (const lvl of norm) {
    const price = Array.isArray(lvl) ? Number(lvl[0]) : Number(lvl?.price);
    const size = Array.isArray(lvl) ? Number(lvl[1]) : Number(lvl?.size ?? lvl?.qty);
    if (!(price > 0) || !(size > 0)) continue;

    const distBps = best > 0 ? (Math.abs(price - best) / best) * 10000 : 0;
    if (distBps + 1e-9 < skip) continue;

    const availSize = size * (1 - h);
    const levelNotional = price * availSize;
    if (!(levelNotional > 0)) continue;

    const takeNotional = Math.min(remaining, levelNotional);
    const takeQty = takeNotional / price;

    cost += takeNotional;
    qty += takeQty;
    remaining -= takeNotional;
    levelsConsumed++;
    worstPrice = price;

    if (remaining <= 1e-6) break;
  }

  const filledNotional = target - Math.max(0, remaining);
  const vwap = qty > 0 ? cost / qty : 0;
  const impactBps =
    best > 0 && vwap > 0 ? (Math.abs(vwap - best) / best) * 10000 : Infinity;

  return {
    fullyFillable: remaining <= 1e-6,
    filledNotional,
    unfilledNotional: Math.max(0, remaining),
    qty,
    vwap,
    worstPrice,
    bestPrice: best,
    impactBps,
    levelsConsumed,
  };
}

/**
 * Compute USD depth within a basis-point band from mid price.
 */
export function computeBandDepth(levels, midPrice, bandBps) {
  const mid = toNum(midPrice, 0);
  if (!(mid > 0)) return { depthUsd: 0, maxLevelUsd: 0, maxLevelPrice: 0, levelCount: 0, maxGapBps: 0 };

  let depthUsd = 0;
  let maxLevelUsd = 0;
  let maxLevelPrice = 0;
  let levelCount = 0;
  let prevPrice = mid;
  let maxGapBps = 0;

  for (const lvl of levels || []) {
    const price = Array.isArray(lvl) ? Number(lvl[0]) : Number(lvl?.price);
    const size = Array.isArray(lvl) ? Number(lvl[1]) : Number(lvl?.size ?? lvl?.qty);
    if (!(price > 0) || !(size > 0)) continue;

    const distBps = (Math.abs(price - mid) / mid) * 10000;
    if (distBps > bandBps + 1e-9) break;

    const gapBps = prevPrice > 0 ? (Math.abs(price - prevPrice) / prevPrice) * 10000 : 0;
    if (gapBps > maxGapBps) maxGapBps = gapBps;
    prevPrice = price;

    const notional = price * size;
    depthUsd += notional;
    levelCount++;
    if (notional > maxLevelUsd) {
      maxLevelUsd = notional;
      maxLevelPrice = price;
    }
  }

  return {
    depthUsd,
    maxLevelUsd,
    maxLevelPrice,
    levelCount,
    maxGapBps,
    concentration: depthUsd > 0 ? maxLevelUsd / depthUsd : 0,
  };
}

/**
 * Anti-spoof / Persistence Filter (Section 3.3 FX-03a, FX-03b, FX-03c).
 * Builds a conservative book from the last N snapshots where each price level's size is
 * the minimum size seen across the snapshots. Levels absent in any of the snapshots get size 0.
 * Also computes depthVolatility (CV = std/mean of 0.5% depth across snapshots).
 */
export function buildStableBook(snapshots = [], { stableSnapshots = 3, minSpanMs = 300 } = {}) {
  const valid = (Array.isArray(snapshots) ? snapshots : []).filter(
    (s) => s && Array.isArray(s.bids) && Array.isArray(s.asks)
  );
  if (valid.length === 0) {
    return { bids: [], asks: [], ts: 0, snapshotCount: 0, spanMs: 0, depthVolatility: 0 };
  }

  const recent = valid.slice(-Math.max(1, stableSnapshots));
  const latest = recent[recent.length - 1];
  const first = recent[0];
  const spanMs = Math.max(0, toNum(latest.ts, 0) - toNum(first.ts, 0));

  // Compute depthVolatility across all valid snapshots in the ring buffer (up to 10)
  const sampleBooks = valid.slice(-10);
  const depthSeries = [];
  for (const snap of sampleBooks) {
    const b = normalizeBookLevels(snap.bids, "bids");
    const a = normalizeBookLevels(snap.asks, "asks");
    if (b.length > 0 && a.length > 0 && b[0][0] < a[0][0]) {
      const mid = (b[0][0] + a[0][0]) / 2;
      const b50 = computeBandDepth(b, mid, 50).depthUsd;
      const a50 = computeBandDepth(a, mid, 50).depthUsd;
      depthSeries.push(b50 + a50);
    }
  }

  let depthVolatility = 0;
  if (depthSeries.length >= 2) {
    const mean = depthSeries.reduce((acc, v) => acc + v, 0) / depthSeries.length;
    if (mean > 0) {
      const variance =
        depthSeries.reduce((acc, v) => acc + (v - mean) * (v - mean), 0) / depthSeries.length;
      depthVolatility = Math.sqrt(variance) / mean;
    }
  }

  // If only 1 snapshot is available, return it normalized
  if (recent.length === 1) {
    return {
      bids: normalizeBookLevels(latest.bids, "bids"),
      asks: normalizeBookLevels(latest.asks, "asks"),
      ts: toNum(latest.ts, Date.now()),
      snapshotCount: 1,
      spanMs,
      depthVolatility,
    };
  }

  // Intersect price levels across `recent` snapshots: conservative size = min size across snapshots
  const minSideLevels = (sideKey) => {
    const maps = recent.map((snap) => {
      const m = new Map();
      for (const [p, s] of normalizeBookLevels(snap[sideKey], sideKey)) {
        m.set(p, (m.get(p) || 0) + s);
      }
      return m;
    });

    const baseMap = maps[maps.length - 1];
    const conservative = [];
    for (const [price, latestSize] of baseMap.entries()) {
      let minSize = latestSize;
      for (let i = 0; i < maps.length - 1; i++) {
        const s = maps[i].get(price) ?? 0;
        if (s < minSize) minSize = s;
      }
      if (minSize > 0) {
        conservative.push([price, minSize]);
      }
    }
    return normalizeBookLevels(conservative, sideKey);
  };

  return {
    bids: minSideLevels("bids"),
    asks: minSideLevels("asks"),
    ts: toNum(latest.ts, Date.now()),
    snapshotCount: recent.length,
    spanMs,
    depthVolatility,
  };
}

/**
 * Discount dominant single-level wall if it exceeds maxWallDominance of 0.5% depth (FX-03b, EC-15).
 */
export function applyWallDiscount(levels, midPrice, maxWallDominance = 0.6, wallHaircut = 0.75) {
  const band50 = computeBandDepth(levels, midPrice, 50);
  if (band50.concentration <= maxWallDominance || !(band50.maxLevelPrice > 0)) {
    return {
      levels,
      wallDetected: false,
      concentration: band50.concentration,
      wallPrice: null,
    };
  }

  const discounted = levels.map(([p, s]) => {
    if (Math.abs(p - band50.maxLevelPrice) < 1e-12) {
      return [p, s * (1 - wallHaircut)];
    }
    return [p, s];
  });

  return {
    levels: discounted,
    wallDetected: true,
    concentration: band50.concentration,
    wallPrice: band50.maxLevelPrice,
  };
}

/**
 * Evaluate all order-book & cost checks for a specific notional.
 */
function evaluateNotionalAgainstBook({
  notional,
  side,
  bids,
  asks,
  mid,
  spreadBps,
  cfg,
  feeEntryBps,
  feeExitBps,
  fundingBps,
  expectedMoveBps,
  vol1mUsd,
  vol5mUsd,
}) {
  const isLong = side !== "short";
  const entryLevels = isLong ? asks : bids;
  const exitLevels = isLong ? bids : asks;
  const bestEntry = isLong ? asks[0]?.[0] : bids[0]?.[0];
  const bestExit = isLong ? bids[0]?.[0] : asks[0]?.[0];

  const bid10 = computeBandDepth(bids, mid, 10).depthUsd;
  const ask10 = computeBandDepth(asks, mid, 10).depthUsd;
  const bid25 = computeBandDepth(bids, mid, 25).depthUsd;
  const ask25 = computeBandDepth(asks, mid, 25).depthUsd;
  const bid50Info = computeBandDepth(bids, mid, 50);
  const ask50Info = computeBandDepth(asks, mid, 50);
  const bid50 = bid50Info.depthUsd;
  const ask50 = ask50Info.depthUsd;
  const bid100 = computeBandDepth(bids, mid, 100).depthUsd;
  const ask100 = computeBandDepth(asks, mid, 100).depthUsd;

  const entryDepth50 = isLong ? ask50 : bid50;
  const exitDepth50 = isLong ? bid50 : ask50;
  const total50 = bid50 + ask50;
  const imbalance = total50 > 0 ? bid50 / total50 : 0.5;
  const oppositeRatio = entryDepth50 > 0 ? exitDepth50 / entryDepth50 : 0;

  const entryWalk = walkBook(entryLevels, notional, 0, 0, bestEntry);
  const exitNowWalk = walkBook(exitLevels, notional, 0, 0, bestExit);
  const exitStressWalk = walkBook(
    exitLevels,
    notional,
    cfg.exitStressHaircut,
    cfg.exitStressGapBps,
    bestExit
  );

  const reasons = [];

  // 1. One-sided book check (FX-02g, EC-16)
  if (entryDepth50 <= 0 || exitDepth50 <= 0 || oppositeRatio < cfg.minOppositeDepthRatio) {
    reasons.push("one-sided-book");
  }

  // 2. Entry depth multiple (FX-02e)
  if (entryDepth50 < notional * cfg.minEntryDepthMult) {
    reasons.push("entry-depth-thin");
  }

  // 3. Entry walk impact (FX-02f)
  if (!entryWalk.fullyFillable || entryWalk.impactBps > cfg.maxEntryImpactBps) {
    reasons.push("entry-impact-high");
  }

  // 4. Exit depth multiple (FX-02g)
  if (exitDepth50 < notional * cfg.minExitDepthMult) {
    reasons.push("exit-depth-thin");
  }

  // 5. Exit stress walk (FX-02h)
  if (!exitStressWalk.fullyFillable) {
    reasons.push("exit-unfillable");
  } else if (exitStressWalk.impactBps > cfg.maxExitStressImpactBps) {
    reasons.push("exit-stress-high");
  }

  // 6. Participation cap (FX-02j, EC-17)
  if (vol1mUsd !== null && vol1mUsd > 0) {
    const max1m = (cfg.maxParticipation1mPct / 100) * vol1mUsd;
    if (notional > max1m) {
      reasons.push("participation-cap");
    }
  } else if (vol5mUsd !== null && vol5mUsd > 0) {
    const max5m = (cfg.maxParticipation5mPct / 100) * vol5mUsd;
    if (notional > max5m) {
      reasons.push("participation-cap");
    }
  }

  // 7. Net edge vs round-trip cost (FX-02k)
  const exitWeightedImpact =
    0.5 * (Number.isFinite(exitNowWalk.impactBps) ? exitNowWalk.impactBps : cfg.maxExitStressImpactBps) +
    0.5 * (Number.isFinite(exitStressWalk.impactBps) ? exitStressWalk.impactBps : cfg.maxExitStressImpactBps);
  const entryImp = Number.isFinite(entryWalk.impactBps) ? entryWalk.impactBps : cfg.maxEntryImpactBps;
  const roundTripCostBps = feeEntryBps + feeExitBps + entryImp + exitWeightedImpact + Math.max(0, fundingBps);

  if (expectedMoveBps !== null && expectedMoveBps > 0) {
    if (expectedMoveBps < roundTripCostBps * cfg.minEdgeMultiple) {
      reasons.push("net-edge-low");
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    metrics: {
      bestBid: bids[0]?.[0] || 0,
      bestAsk: asks[0]?.[0] || 0,
      mid,
      spreadBps,
      bidDepth10: bid10,
      askDepth10: ask10,
      bidDepth25: bid25,
      askDepth25: ask25,
      bidDepth50: bid50,
      askDepth50: ask50,
      bidDepth100: bid100,
      askDepth100: ask100,
      imbalance,
      oppositeRatio,
      entryDepth50,
      exitDepth50,
      entryVwap: entryWalk.vwap,
      entryWorstPrice: entryWalk.worstPrice,
      entryImpactBps: entryWalk.impactBps,
      entryLevelsConsumed: entryWalk.levelsConsumed,
      entryFullyFillable: entryWalk.fullyFillable,
      exitNowVwap: exitNowWalk.vwap,
      exitNowImpactBps: exitNowWalk.impactBps,
      exitNowFullyFillable: exitNowWalk.fullyFillable,
      exitStressVwap: exitStressWalk.vwap,
      exitStressWorstPrice: exitStressWalk.worstPrice,
      exitStressImpactBps: exitStressWalk.impactBps,
      exitStressFullyFillable: exitStressWalk.fullyFillable,
      roundTripCostBps,
      expectedMoveBps,
    },
  };
}

/**
 * Liquidity-Fitted Position Sizing (Section 3.4 FX-05).
 * Binary-searches (8 iterations) for the largest notional in [minAllowedNotional, plannedNotional]
 * that passes all EQE checks, rounded down to exchange lotSize.
 */
export function sizeToFit({
  plannedNotional,
  checkNotionalFn,
  venuePrice,
  instrument = {},
  minViableFraction = 0.25,
}) {
  const target = toNum(plannedNotional, 0);
  const instMinNotional = Math.max(0, toNum(instrument.minNotional, 5));
  const minAllowed = Math.max(instMinNotional, target * clamp(toNum(minViableFraction, 0.25), 0.05, 1));

  if (target < minAllowed) {
    return {
      ok: false,
      action: "reject",
      reason: "size-too-small-to-fit",
      approvedNotional: 0,
      approvedQty: 0,
    };
  }

  // First check if minimum viable notional can pass
  const minEval = checkNotionalFn(minAllowed);
  if (!minEval.ok) {
    return {
      ok: false,
      action: "reject",
      reason: "size-too-small-to-fit",
      primaryFailure: minEval.reasons[0] || "exit-depth-thin",
      approvedNotional: 0,
      approvedQty: 0,
      evalResult: minEval,
    };
  }

  let low = minAllowed;
  let high = target;
  let bestNotional = minAllowed;
  let bestEval = minEval;

  for (let i = 0; i < 8; i++) {
    const midNotional = (low + high) / 2;
    const ev = checkNotionalFn(midNotional);
    if (ev.ok) {
      bestNotional = midNotional;
      bestEval = ev;
      low = midNotional;
    } else {
      high = midNotional;
    }
  }

  // Round down to exchange lotSize/stepSize if venuePrice is provided
  if (venuePrice > 0) {
    const rounded = roundAndValidateQty({
      targetNotional: bestNotional,
      venuePrice,
      instrument,
      maxNotionalDeviationPct: 100, // allow size reduction
    });
    if (!rounded.ok || rounded.notional < minAllowed - 1e-6) {
      return {
        ok: false,
        action: "reject",
        reason: "size-too-small-to-fit",
        approvedNotional: 0,
        approvedQty: 0,
        evalResult: bestEval,
      };
    }
    return {
      ok: true,
      action: "size-reduced",
      reason: "size-reduced",
      approvedNotional: rounded.notional,
      approvedQty: rounded.qty,
      evalResult: checkNotionalFn(rounded.notional),
    };
  }

  return {
    ok: true,
    action: "size-reduced",
    reason: "size-reduced",
    approvedNotional: round(bestNotional, 4),
    approvedQty: 0,
    evalResult: bestEval,
  };
}

/**
 * Full Execution Quality Gate (Section 3.1 - 3.6).
 * Returns a deterministic ExecutabilityReport for every candidate trade.
 */
export function evaluateExecutability({
  symbol,
  venue = "unknown",
  side = "long",
  plannedNotional = null,
  desiredNotional = null,
  book = null,
  snapshots = null,
  coin = null,
  markPrice = null,
  instrument = {},
  settings = {},
  feeEntryBps = 5,
  feeExitBps = 5,
  fundingBps = 0,
  expectedMoveBps = null,
  nowMs = Date.now(),
} = {}) {
  const targetNotional = toNum(plannedNotional ?? desiredNotional, 1000) || 1000;
  plannedNotional = targetNotional;
  const cfg = { ...DEFAULT_EQE_SETTINGS, ...(settings?.eqe || settings || {}) };
  const reasons = [];

  // --- Stage 1: Cheap checks before order-book inspection (Section 3.1) ---
  if (coin) {
    const signalTs = toNum(coin.fetchedAt ?? coin.ts, null);
    if (signalTs !== null && cfg.maxSignalAgeSec > 0) {
      if (nowMs - signalTs > cfg.maxSignalAgeSec * 1000) {
        reasons.push("data-stale");
      }
    }

    // Absolute USD OI & Volume floors (EC-49)
    if (coin.oiChangeUsd !== undefined && coin.oiChangeUsd !== null && cfg.minAbsOiChangeUsd > 0) {
      if (Math.abs(toNum(coin.oiChangeUsd, 0)) < cfg.minAbsOiChangeUsd) {
        reasons.push("abs-floor");
      }
    }
    if (coin.vol1hUsd !== undefined && coin.vol1hUsd !== null && cfg.minAbsVol1hUsd > 0) {
      if (toNum(coin.vol1hUsd, 0) < cfg.minAbsVol1hUsd && !reasons.includes("abs-floor")) {
        reasons.push("abs-floor");
      }
    }
  }

  // --- Stage 2: Order-book presence, freshness, and structure ---
  let activeBook = book;
  let depthVolatility = 0;

  if (Array.isArray(snapshots) && snapshots.length > 0) {
    const stable = buildStableBook(snapshots, {
      stableSnapshots: cfg.stableSnapshots,
      minSpanMs: cfg.stableMinSpanMs,
    });
    activeBook = stable;
    depthVolatility = stable.depthVolatility;
  } else if (book && typeof book.depthVolatility === "number") {
    depthVolatility = book.depthVolatility;
  }

  const bookTs = toNum(activeBook?.ts ?? activeBook?.timestamp, null);
  const bookAgeMs = bookTs !== null ? Math.max(0, nowMs - bookTs) : Infinity;

  if (!activeBook || !Array.isArray(activeBook.bids) || !Array.isArray(activeBook.asks)) {
    return buildReport({
      symbol,
      venue,
      side,
      pass: false,
      action: "reject",
      reasons: [...reasons, "book-stale"],
      plannedNotional,
      approvedNotional: 0,
      bookAgeMs,
      depthVolatility,
      metrics: null,
    });
  }

  if (bookTs !== null && bookAgeMs > cfg.maxBookAgeMs) {
    reasons.push("book-stale");
  }

  let bids = normalizeBookLevels(activeBook.bids, "bids");
  let asks = normalizeBookLevels(activeBook.asks, "asks");

  if (bids.length === 0 || asks.length === 0) {
    return buildReport({
      symbol,
      venue,
      side,
      pass: false,
      action: "reject",
      reasons: [...new Set([...reasons, "hollow-book"])],
      plannedNotional,
      approvedNotional: 0,
      bookAgeMs,
      depthVolatility,
      metrics: null,
    });
  }

  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];

  // Crossed or locked book (EC-13)
  if (!(bestBid > 0) || !(bestAsk > 0) || bestBid >= bestAsk) {
    return buildReport({
      symbol,
      venue,
      side,
      pass: false,
      action: "reject",
      reasons: [...new Set([...reasons, "book-crossed"])],
      plannedNotional,
      approvedNotional: 0,
      bookAgeMs,
      depthVolatility,
      metrics: { bestBid, bestAsk, mid: (bestBid + bestAsk) / 2, spreadBps: 0 },
    });
  }

  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = ((bestAsk - bestBid) / mid) * 10000;

  // Mark-to-Mid basis check (EC-18)
  const mark = toNum(markPrice, null);
  if (mark !== null && mark > 0 && cfg.maxBasisBps > 0) {
    const basisBps = (Math.abs(mark - mid) / mid) * 10000;
    if (basisBps > cfg.maxBasisBps) {
      reasons.push("price-stale");
    }
  }

  // Hollow book: minimum levels or adjacent gap (EC-14, FX-02c)
  const bid50Pre = computeBandDepth(bids, mid, 50);
  const ask50Pre = computeBandDepth(asks, mid, 50);
  if (
    bids.length < cfg.minBookLevels ||
    asks.length < cfg.minBookLevels ||
    bid50Pre.maxGapBps > cfg.maxAdjacentGapBps ||
    ask50Pre.maxGapBps > cfg.maxAdjacentGapBps
  ) {
    reasons.push("hollow-book");
  }

  // Spread check (FX-02d)
  if (spreadBps > cfg.maxSpreadBps) {
    reasons.push("spread-wide");
  }

  // Flickering book check (FX-03c)
  if (depthVolatility > cfg.maxDepthVolatility) {
    reasons.push("flickering-book");
  }

  // Single-level wall dominance (FX-03b, EC-15)
  const isLong = side !== "short";
  const entrySidePre = isLong ? ask50Pre : bid50Pre;
  const exitSidePre = isLong ? bid50Pre : ask50Pre;
  let wallDetected = false;
  if (
    entrySidePre.concentration > cfg.maxWallDominance ||
    exitSidePre.concentration > cfg.maxWallDominance
  ) {
    wallDetected = true;
    const discBids = applyWallDiscount(bids, mid, cfg.maxWallDominance, cfg.wallHaircut);
    const discAsks = applyWallDiscount(asks, mid, cfg.maxWallDominance, cfg.wallHaircut);
    bids = discBids.levels;
    asks = discAsks.levels;
    reasons.push("wall-risk");
  }

  const vol1mUsd = toNum(coin?.vol1mUsd ?? (coin?.volUsd24h ? coin.volUsd24h / 1440 : null), null);
  const vol5mUsd = toNum(coin?.vol5mUsd ?? (coin?.volUsd24h ? coin.volUsd24h / 288 : null), null);

  const checkNotionalFn = (n) =>
    evaluateNotionalAgainstBook({
      notional: n,
      side,
      bids,
      asks,
      mid,
      spreadBps,
      cfg,
      feeEntryBps,
      feeExitBps,
      fundingBps,
      expectedMoveBps,
      vol1mUsd,
      vol5mUsd,
    });

  const fullEval = checkNotionalFn(plannedNotional);

  // If structural/book-level reasons already failed, reject immediately
  if (reasons.length > 0) {
    const allReasons = [...new Set([...reasons, ...fullEval.reasons])];
    return buildReport({
      symbol,
      venue,
      side,
      pass: false,
      action: "reject",
      reasons: allReasons,
      plannedNotional,
      approvedNotional: 0,
      bookAgeMs,
      depthVolatility,
      wallDetected,
      metrics: fullEval.metrics,
    });
  }

  if (fullEval.ok) {
    return buildReport({
      symbol,
      venue,
      side,
      pass: true,
      action: "full-size",
      reasons: [],
      plannedNotional,
      approvedNotional: plannedNotional,
      bookAgeMs,
      depthVolatility,
      wallDetected,
      metrics: fullEval.metrics,
    });
  }

  // Try Liquidity-Fitted Sizing (FX-05) if enabled and failure is size-sensitive
  const sizeSensitiveReasons = new Set([
    "entry-depth-thin",
    "entry-impact-high",
    "exit-depth-thin",
    "exit-unfillable",
    "exit-stress-high",
    "participation-cap",
    "net-edge-low",
  ]);
  const onlySizeSensitive = fullEval.reasons.every((r) => sizeSensitiveReasons.has(r));

  if (cfg.liquiditySizing && onlySizeSensitive) {
    const fitted = sizeToFit({
      plannedNotional,
      checkNotionalFn,
      venuePrice: isLong ? bestAsk : bestBid,
      instrument,
      minViableFraction: cfg.minViableFraction,
    });

    if (fitted.ok) {
      return buildReport({
        symbol,
        venue,
        side,
        pass: true,
        action: "size-reduced",
        reasons: ["size-reduced"],
        originalReasons: fullEval.reasons,
        plannedNotional,
        approvedNotional: fitted.approvedNotional,
        approvedQty: fitted.approvedQty,
        bookAgeMs,
        depthVolatility,
        wallDetected,
        metrics: fitted.evalResult.metrics,
      });
    }

    return buildReport({
      symbol,
      venue,
      side,
      pass: false,
      action: "reject",
      reasons: [...new Set([...fullEval.reasons, "size-too-small-to-fit"])],
      plannedNotional,
      approvedNotional: 0,
      bookAgeMs,
      depthVolatility,
      wallDetected,
      metrics: fullEval.metrics,
    });
  }

  return buildReport({
    symbol,
    venue,
    side,
    pass: false,
    action: "reject",
    reasons: fullEval.reasons,
    plannedNotional,
    approvedNotional: 0,
    bookAgeMs,
    depthVolatility,
    wallDetected,
    metrics: fullEval.metrics,
  });
}

function buildReport({
  symbol,
  venue,
  side,
  pass,
  action,
  reasons,
  originalReasons = [],
  plannedNotional,
  approvedNotional,
  approvedQty = null,
  bookAgeMs,
  depthVolatility = 0,
  wallDetected = false,
  metrics,
}) {
  const formattedMetrics = metrics
    ? {
        bestBid: metrics.bestBid,
        bestAsk: metrics.bestAsk,
        mid: round(metrics.mid, 8),
        spreadBps: round(metrics.spreadBps, 2),
        bidDepth10: Math.round(metrics.bidDepth10 || 0),
        askDepth10: Math.round(metrics.askDepth10 || 0),
        bidDepth25: Math.round(metrics.bidDepth25 || 0),
        askDepth25: Math.round(metrics.askDepth25 || 0),
        bidDepth50: Math.round(metrics.bidDepth50 || 0),
        askDepth50: Math.round(metrics.askDepth50 || 0),
        bidDepth100: Math.round(metrics.bidDepth100 || 0),
        askDepth100: Math.round(metrics.askDepth100 || 0),
        imbalance: round(metrics.imbalance ?? 0.5, 4),
        oppositeRatio: round(metrics.oppositeRatio ?? 1, 4),
        entryDepth50: Math.round(metrics.entryDepth50 || 0),
        exitDepth50: Math.round(metrics.exitDepth50 || 0),
        entryVwap: round(metrics.entryVwap || 0, 8),
        entryWorstPrice: round(metrics.entryWorstPrice || 0, 8),
        entryImpactBps: Number.isFinite(metrics.entryImpactBps)
          ? round(metrics.entryImpactBps, 2)
          : null,
        entryLevelsConsumed: metrics.entryLevelsConsumed || 0,
        entryFullyFillable: Boolean(metrics.entryFullyFillable),
        exitNowVwap: round(metrics.exitNowVwap || 0, 8),
        exitNowImpactBps: Number.isFinite(metrics.exitNowImpactBps)
          ? round(metrics.exitNowImpactBps, 2)
          : null,
        exitNowFullyFillable: Boolean(metrics.exitNowFullyFillable),
        exitStressVwap: round(metrics.exitStressVwap || 0, 8),
        exitStressWorstPrice: round(metrics.exitStressWorstPrice || 0, 8),
        exitStressImpactBps: Number.isFinite(metrics.exitStressImpactBps)
          ? round(metrics.exitStressImpactBps, 2)
          : null,
        exitStressFullyFillable: Boolean(metrics.exitStressFullyFillable),
        roundTripCostBps: Number.isFinite(metrics.roundTripCostBps)
          ? round(metrics.roundTripCostBps, 2)
          : null,
        expectedMoveBps: metrics.expectedMoveBps,
      }
    : null;

  return {
    symbol,
    venue,
    side,
    ok: Boolean(pass),
    pass: Boolean(pass),
    action, // "full-size" | "size-reduced" | "reject"
    reasons: Array.isArray(reasons) ? reasons : [],
    originalReasons,
    plannedNotional: round(toNum(plannedNotional, 0), 2),
    approvedNotional: round(toNum(approvedNotional, 0), 2),
    approvedQty,
    bookAgeMs: Number.isFinite(bookAgeMs) ? Math.round(bookAgeMs) : null,
    depthVolatility: round(toNum(depthVolatility, 0), 4),
    wallDetected: Boolean(wallDetected),
    spreadBps: formattedMetrics?.spreadBps ?? null,
    entryDepth50: formattedMetrics?.entryDepth50 ?? 0,
    exitDepth50: formattedMetrics?.exitDepth50 ?? 0,
    entryImpactBps: formattedMetrics?.entryImpactBps ?? null,
    exitStressImpactBps: formattedMetrics?.exitStressImpactBps ?? null,
    roundTripCostBps: formattedMetrics?.roundTripCostBps ?? null,
    metrics: formattedMetrics,
    timestamp: Date.now(),
  };
}

/**
 * Continuous Exit Liquidity Monitor for Open Positions (Section 3.5 FX-07a..d).
 * Evaluates current exit book for each open position, classifies health as
 * green / amber / red, and triggers onLiquidityCollapse after `graceReads` consecutive red reads.
 */
export class ExitLiquidityMonitor {
  constructor(options = {}) {
    this.options = { ...DEFAULT_EQE_SETTINGS, ...options };
    this.streaks = new Map(); // posId -> consecutive red reads
    this.lastStatus = new Map(); // posId -> status object
  }

  evaluatePosition(pos, book, settings = {}) {
    const cfg = { ...this.options, ...(settings?.eqe || settings || {}) };
    const posId = pos?.id || pos?.symbol || "unknown";
    const isLong = pos?.side !== "short";
    const mark = toNum(pos?.markPrice, toNum(pos?.entryPrice, 0));
    const remainingNotional = Math.max(0, toNum(pos?.qty, 0) * mark);

    if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) {
      const redCount = (this.streaks.get(posId) || 0) + 1;
      this.streaks.set(posId, redCount);
      const triggered = redCount >= (cfg.collapseGraceReads || 2);
      const status = {
        positionId: posId,
        symbol: pos?.symbol,
        health: "red",
        reason: "book-missing",
        fullyFillable: false,
        exitNowImpactBps: Infinity,
        exitStressImpactBps: Infinity,
        exitDepth50Usd: 0,
        consecutiveRedReads: redCount,
        triggeredAction: triggered ? cfg.onLiquidityCollapse : null,
      };
      this.lastStatus.set(posId, status);
      return status;
    }

    const bids = normalizeBookLevels(book.bids, "bids");
    const asks = normalizeBookLevels(book.asks, "asks");
    const exitLevels = isLong ? bids : asks;
    const bestExit = exitLevels[0]?.[0] || mark;
    const mid =
      bids.length > 0 && asks.length > 0 ? (bids[0][0] + asks[0][0]) / 2 : bestExit;

    const exitBand50 = computeBandDepth(exitLevels, mid, 50);
    const exitNow = walkBook(exitLevels, remainingNotional, 0, 0, bestExit);
    const exitStress = walkBook(
      exitLevels,
      remainingNotional,
      cfg.exitStressHaircut,
      cfg.exitStressGapBps,
      bestExit
    );

    const maxStress = toNum(cfg.maxExitStressImpactBps, 50);
    let health = "green";
    if (!exitNow.fullyFillable || !exitStress.fullyFillable || exitNow.impactBps > maxStress) {
      health = "red";
    } else if (
      exitNow.impactBps > 0.6 * maxStress ||
      exitStress.impactBps > maxStress ||
      exitBand50.depthUsd < remainingNotional * 2
    ) {
      health = "amber";
    }

    let redCount = this.streaks.get(posId) || 0;
    if (health === "red") {
      redCount += 1;
    } else {
      redCount = 0;
    }
    this.streaks.set(posId, redCount);

    const grace = Math.max(1, toNum(cfg.collapseGraceReads, 2));
    const triggered = health === "red" && redCount >= grace;

    const status = {
      positionId: posId,
      symbol: pos?.symbol,
      health,
      fullyFillable: exitNow.fullyFillable && exitStress.fullyFillable,
      exitNowImpactBps: Number.isFinite(exitNow.impactBps) ? round(exitNow.impactBps, 2) : null,
      exitStressImpactBps: Number.isFinite(exitStress.impactBps)
        ? round(exitStress.impactBps, 2)
        : null,
      exitDepth50Usd: Math.round(exitBand50.depthUsd),
      remainingNotional: round(remainingNotional, 2),
      consecutiveRedReads: redCount,
      triggeredAction: triggered ? cfg.onLiquidityCollapse || "tighten" : null,
      updatedAt: Date.now(),
    };

    this.lastStatus.set(posId, status);
    return status;
  }

  clearPosition(posId) {
    this.streaks.delete(posId);
    this.lastStatus.delete(posId);
  }
}
