/**
 * Instrument Normalization, Multiplier Detection, Unit Conversion, and Precision Guards.
 * Implements Section 8.1 (EC-01..EC-12) and Section 5.4 (FX-22e, FX-22h).
 */

import { toNum } from "../util.js";

const MULTIPLIER_PREFIX_RE = /^(1000000|100000|10000|1000|100|1M)([A-Z0-9]+)$/i;

/**
 * Detect contract base multiplier from symbol prefix (e.g. 1000PEPE, 1000000MOG, 1MBABYDOGE)
 * or explicit contract metadata (EC-02).
 */
export function parseSymbolMultiplier(symbol, contractMeta = {}) {
  const rawSym = String(symbol || "")
    .toUpperCase()
    .replace(/[-_]/g, "")
    .replace(/USDTM?$/, "")
    .replace(/SWAP$/, "");

  const explicitMult = toNum(contractMeta?.baseMultiplier ?? contractMeta?.multiplier, null);
  const match = rawSym.match(MULTIPLIER_PREFIX_RE);
  if (match) {
    const prefix = match[1].toUpperCase();
    const mult = prefix === "1M" ? 1000000 : Number(prefix);
    return {
      baseMultiplier: explicitMult && explicitMult > 1 ? explicitMult : mult,
      canonicalBase: match[2].toUpperCase(),
      rawBase: rawSym,
      prefixed: true,
    };
  }

  return {
    baseMultiplier: explicitMult && explicitMult > 0 ? explicitMult : 1,
    canonicalBase: rawSym === "XBT" ? "BTC" : rawSym,
    rawBase: rawSym,
    prefixed: false,
  };
}

/**
 * Normalize a venue price and quantity to canonical 1x base coin units (EC-02, EC-05).
 */
export function normalizeToCanonicalBase({ venuePrice, contractQty, symbol, contractMeta = {} }) {
  const { baseMultiplier, canonicalBase } = parseSymbolMultiplier(symbol, contractMeta);
  const contractSize = Math.max(1e-12, toNum(contractMeta?.contractSize ?? contractMeta?.quantoMultiplier, 1));
  const unitFactor = contractSize * baseMultiplier;
  const pricePerBase = baseMultiplier > 1 ? toNum(venuePrice, 0) / baseMultiplier : toNum(venuePrice, 0);
  const baseQty = toNum(contractQty, 0) * unitFactor;
  return {
    canonicalBase,
    baseMultiplier,
    contractSize,
    unitFactor,
    pricePerBase,
    baseQty,
    notional: toNum(venuePrice, 0) * toNum(contractQty, 0) * contractSize,
  };
}

/**
 * Convert target notional (USD) and venue contract price into venue order quantity (contracts or base)
 * and validate against stepSize/lotSize, minQty, minNotional, and coarse contract size (EC-05, EC-06, EC-07).
 */
export function roundAndValidateQty({
  targetNotional,
  venuePrice,
  instrument = {},
  maxNotionalDeviationPct = 10,
}) {
  const price = toNum(venuePrice, 0);
  const notional = toNum(targetNotional, 0);
  if (!(price > 0) || !(notional > 0)) {
    return { ok: false, reason: "invalid-price-or-notional", qty: 0, notional: 0 };
  }

  const contractSize = Math.max(1e-12, toNum(instrument.contractSize, 1));
  const stepSize = Math.max(1e-12, toNum(instrument.lotSize ?? instrument.stepSize, 1e-8));
  const minQty = Math.max(0, toNum(instrument.minQty, 0));
  const minNotional = Math.max(0, toNum(instrument.minNotional, 5));

  // Value of 1 unit of qty on this venue
  const unitValueUsd = price * contractSize;
  const rawUnits = notional / unitValueUsd;

  // Always round down to stepSize (EC-06)
  const steps = Math.floor((rawUnits + 1e-12) / stepSize);
  const decimals = Math.max(0, Math.ceil(-Math.log10(stepSize)));
  const roundedQty = Number((steps * stepSize).toFixed(Math.min(12, decimals + 2)));
  const actualNotional = roundedQty * unitValueUsd;

  if (roundedQty <= 0 || roundedQty < minQty) {
    return {
      ok: false,
      reason: "below-min-qty",
      qty: roundedQty,
      minQty,
      notional: actualNotional,
    };
  }

  if (actualNotional + 1e-9 < minNotional) {
    return {
      ok: false,
      reason: "below-min-notional",
      qty: roundedQty,
      minNotional,
      notional: actualNotional,
    };
  }

  const deviationPct = (Math.abs(actualNotional - notional) / notional) * 100;
  if (deviationPct > maxNotionalDeviationPct) {
    return {
      ok: false,
      reason: "coarse-contract-size",
      qty: roundedQty,
      notional: actualNotional,
      targetNotional: notional,
      deviationPct,
    };
  }

  return {
    ok: true,
    qty: roundedQty,
    notional: actualNotional,
    targetNotional: notional,
    deviationPct,
    contractSize,
    stepSize,
  };
}

/**
 * Runtime unit sanity check (Section 8.1 EC-05):
 * Before sending any live order, verify that computed order notional is within 2% of
 * independent markPrice * baseQty. Otherwise abort with unit-mismatch.
 */
export function verifyOrderUnitSanity({
  orderQty,
  venuePrice,
  independentMarkPrice,
  expectedNotional,
  instrument = {},
  maxTolerancePct = 2.0,
}) {
  const qty = toNum(orderQty, 0);
  const price = toNum(venuePrice, 0);
  const mark = toNum(independentMarkPrice, price);
  const contractSize = Math.max(1e-12, toNum(instrument.contractSize, 1));
  if (!(qty > 0) || !(price > 0) || !(mark > 0)) {
    return { ok: false, reason: "unit-mismatch", detail: "non-positive qty or price" };
  }

  const computedOrderNotional = qty * price * contractSize;
  const markNotional = qty * mark * contractSize;
  const refNotional = toNum(expectedNotional, markNotional);

  const diffVsRefPct = (Math.abs(computedOrderNotional - refNotional) / Math.max(1e-9, refNotional)) * 100;
  const diffVsMarkPct = (Math.abs(computedOrderNotional - markNotional) / Math.max(1e-9, markNotional)) * 100;

  if (diffVsRefPct > maxTolerancePct || diffVsMarkPct > maxTolerancePct) {
    return {
      ok: false,
      reason: "unit-mismatch",
      computedOrderNotional,
      refNotional,
      markNotional,
      diffVsRefPct,
      diffVsMarkPct,
    };
  }

  return {
    ok: true,
    computedOrderNotional,
    refNotional,
    markNotional,
    diffVsRefPct,
    diffVsMarkPct,
  };
}

/**
 * Split quantity into TP1 partial and runner remainder (EC-08, FX-22c).
 * If either leg is below minQty or minNotional, skips TP1 split and keeps 100% on single exit plan.
 */
export function splitTp1Quantities(totalQty, tp1ClosePercent, instrument = {}, price = 0) {
  const qty = toNum(totalQty, 0);
  const pct = toNum(tp1ClosePercent, 50);
  const stepSize = Math.max(1e-12, toNum(instrument.lotSize ?? instrument.stepSize, 1e-8));
  const minQty = Math.max(0, toNum(instrument.minQty, stepSize));
  const minNotional = Math.max(0, toNum(instrument.minNotional, 5));
  const contractSize = Math.max(1e-12, toNum(instrument.contractSize, 1));
  const decimals = Math.max(0, Math.ceil(-Math.log10(stepSize)));

  if (!(qty > 0) || pct <= 0 || pct >= 100) {
    return { canSplit: false, tp1Qty: 0, runnerQty: qty, reason: "no-split-configured" };
  }

  const rawTp1 = qty * (pct / 100);
  const tp1Steps = Math.floor((rawTp1 + 1e-12) / stepSize);
  const tp1Qty = Number((tp1Steps * stepSize).toFixed(Math.min(12, decimals + 2)));
  const runnerQty = Number((qty - tp1Qty).toFixed(Math.min(12, decimals + 2)));

  const unitUsd = price > 0 ? price * contractSize : 0;
  const tp1Notional = unitUsd > 0 ? tp1Qty * unitUsd : minNotional;
  const runnerNotional = unitUsd > 0 ? runnerQty * unitUsd : minNotional;

  if (
    tp1Qty < minQty ||
    runnerQty < minQty ||
    (unitUsd > 0 && (tp1Notional < minNotional || runnerNotional < minNotional))
  ) {
    return {
      canSplit: false,
      tp1Qty: 0,
      runnerQty: qty,
      reason: "tp1-remainder-below-min",
    };
  }

  return {
    canSplit: true,
    tp1Qty,
    runnerQty,
    reason: null,
  };
}

/**
 * Round SL trigger price away from entry (long SL rounded down, short SL rounded up)
 * and verify it is on the losing side of markPrice by at least stopMinDistanceTicks (EC-09, FX-22e).
 */
export function roundAndValidateStopPrice({
  side,
  rawStopPrice,
  entryPrice,
  markPrice,
  tickSize = 0.0001,
  stopMinDistanceTicks = 2,
}) {
  const tick = Math.max(1e-12, toNum(tickSize, 0.0001));
  const raw = toNum(rawStopPrice, 0);
  const entry = toNum(entryPrice, 0);
  const mark = toNum(markPrice, entry);
  if (!(raw > 0)) {
    return { ok: false, reason: "invalid-stop-price", stopPrice: 0 };
  }

  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));
  const isLong = side !== "short";
  // Round away from entry: Long SL rounds down (floor), Short SL rounds up (ceil)
  const steps = isLong ? Math.floor((raw + 1e-12) / tick) : Math.ceil((raw - 1e-12) / tick);
  const stopPrice = Number((steps * tick).toFixed(Math.min(12, decimals + 2)));
  const minDistance = Math.max(1, toNum(stopMinDistanceTicks, 2)) * tick;

  if (isLong) {
    if (entry > 0 && stopPrice >= entry) {
      return { ok: false, reason: "stop-rounded-into-entry", stopPrice, entryPrice: entry };
    }
    if (mark > 0 && mark - stopPrice < minDistance - 1e-12) {
      return { ok: false, reason: "stop-too-close-to-mark", stopPrice, markPrice: mark, minDistance };
    }
  } else {
    if (entry > 0 && stopPrice <= entry) {
      return { ok: false, reason: "stop-rounded-into-entry", stopPrice, entryPrice: entry };
    }
    if (mark > 0 && stopPrice - mark < minDistance - 1e-12) {
      return { ok: false, reason: "stop-too-close-to-mark", stopPrice, markPrice: mark, minDistance };
    }
  }

  return { ok: true, stopPrice, tickSize: tick, minDistance };
}

/**
 * Verify stop loss is safely inside liquidation price by slLiqBuffer (FX-22h, EC-29).
 * Requires: abs(entry - slPrice) <= (1 - slLiqBuffer) * abs(entry - liqPrice)
 */
export function checkSlLiquidationBuffer({
  side,
  entryPrice,
  slPrice,
  liqPrice,
  slLiqBuffer = 0.25,
}) {
  const entry = toNum(entryPrice, 0);
  const sl = toNum(slPrice, 0);
  const liq = toNum(liqPrice, 0);
  const buf = Math.max(0.01, Math.min(0.95, toNum(slLiqBuffer, 0.25)));

  if (!(entry > 0) || !(sl > 0) || !(liq > 0)) {
    return { ok: false, reason: "invalid-liq-check-inputs" };
  }

  const isLong = side !== "short";
  if (isLong && sl <= liq) {
    return { ok: false, reason: "sl-beyond-liquidation", slPrice: sl, liqPrice: liq };
  }
  if (!isLong && sl >= liq) {
    return { ok: false, reason: "sl-beyond-liquidation", slPrice: sl, liqPrice: liq };
  }

  const slDist = Math.abs(entry - sl);
  const liqDist = Math.abs(entry - liq);
  const maxAllowedSlDist = (1 - buf) * liqDist;

  if (slDist > maxAllowedSlDist + 1e-9) {
    const safeSl = isLong ? entry - maxAllowedSlDist : entry + maxAllowedSlDist;
    return {
      ok: false,
      reason: "sl-too-close-to-liquidation",
      slDist,
      liqDist,
      maxAllowedSlDist,
      suggestedSlPrice: safeSl,
    };
  }

  return { ok: true, slDist, liqDist, maxAllowedSlDist };
}

/**
 * Sanity-check venue price against CoinGlass reference price (normalized for multiplier) (EC-01).
 */
export function sanityCheckPriceVsCoinglass(venuePrice, cgPrice, symbol, contractMeta = {}, maxDeviationPct = 5) {
  const vPrice = toNum(venuePrice, 0);
  const cPrice = toNum(cgPrice, 0);
  if (!(vPrice > 0) || !(cPrice > 0)) return { ok: false, reason: "missing-price" };

  const { baseMultiplier } = parseSymbolMultiplier(symbol, contractMeta);
  const candidates = [vPrice];
  if (baseMultiplier > 1) {
    candidates.push(vPrice / baseMultiplier);
    candidates.push(vPrice * baseMultiplier);
  }

  let bestDeviationPct = Infinity;
  for (const cand of candidates) {
    const dev = (Math.abs(cand - cPrice) / cPrice) * 100;
    if (dev < bestDeviationPct) bestDeviationPct = dev;
  }

  if (bestDeviationPct > maxDeviationPct) {
    return {
      ok: false,
      reason: "symbol-price-mismatch",
      deviationPct: bestDeviationPct,
      venuePrice: vPrice,
      cgPrice: cPrice,
    };
  }

  return { ok: true, deviationPct: bestDeviationPct };
}

/**
 * Hard filter to USDT-settled linear perpetual contracts only (EC-03, EC-11).
 */
export function isUsdtLinearPerp(contract = {}) {
  const quote = String(contract.quoteCoin || contract.quoteAsset || contract.quoteCurrency || "USDT").toUpperCase();
  const settle = String(contract.settleCoin || contract.settleAsset || contract.settleCurrency || quote).toUpperCase();
  if (quote !== "USDT" || settle !== "USDT") return false;
  if (contract.isInverse === true || contract.inverse === true) return false;
  if (contract.contractType && !["PERPETUAL", "LINEAR", "SWAP", "PERP"].includes(String(contract.contractType).toUpperCase())) {
    return false;
  }
  return isTradableContractStatus(contract);
}

/**
 * Require contract status to be active Trading/Open and not delisting (EC-11).
 */
export function isTradableContractStatus(contract = {}) {
  if (contract.in_delisting === true || contract.isDelisting === true) return false;
  const status = String(contract.status ?? contract.state ?? "TRADING").toUpperCase();
  if (["SUSPENDED", "SETTLING", "DELISTING", "CLOSED", "OFFLINE", "PAUSE", "HALT"].includes(status)) {
    return false;
  }
  if (contract.state !== undefined && typeof contract.state === "number" && contract.state !== 0) {
    return false;
  }
  return ["TRADING", "OPEN", "ONLINE", "ACTIVE", "0", "TRUE"].includes(status);
}

/**
 * Block newly listed perpetuals younger than minListingAgeHours (EC-04).
 */
export function checkListingAge(contract = {}, minListingAgeHours = 24, nowMs = Date.now()) {
  const minHours = toNum(minListingAgeHours, 24);
  if (!(minHours > 0)) return { ok: true, ageHours: null };
  const launchTs = toNum(
    contract.launchTime ?? contract.onboardDate ?? contract.openTime ?? contract.listingTime ?? contract.createdAt,
    null
  );
  if (!launchTs || !(launchTs > 0)) return { ok: true, ageHours: null };
  const launchMs = launchTs < 1e11 ? launchTs * 1000 : launchTs;
  const ageHours = (nowMs - launchMs) / (3600 * 1000);
  if (ageHours < minHours) {
    return { ok: false, reason: "too-new", ageHours, minListingAgeHours: minHours };
  }
  return { ok: true, ageHours };
}

/**
 * Clamp leverage and notional against venue leverage brackets (EC-10).
 */
export function clampToLeverageBracket({
  desiredLeverage,
  notional,
  instrument = {},
  clampLeverage = true,
}) {
  const reqLev = Math.max(1, Math.round(toNum(desiredLeverage, 1)));
  const maxInstLev = Math.max(1, toNum(instrument.maxLeverage, 100));
  let maxAllowedLev = maxInstLev;
  let maxBracketNotional = Infinity;

  if (Array.isArray(instrument.brackets) && instrument.brackets.length > 0) {
    const sorted = [...instrument.brackets].sort(
      (a, b) => toNum(a.maxNotional ?? a.notionalCap, Infinity) - toNum(b.maxNotional ?? b.notionalCap, Infinity)
    );
    const matching = sorted.find((b) => toNum(notional, 0) <= toNum(b.maxNotional ?? b.notionalCap, Infinity)) || sorted[sorted.length - 1];
    if (matching) {
      maxAllowedLev = Math.min(maxAllowedLev, Math.max(1, toNum(matching.maxLeverage, maxInstLev)));
      maxBracketNotional = toNum(matching.maxNotional ?? matching.notionalCap, Infinity);
    }
  }

  if (reqLev > maxAllowedLev) {
    if (!clampLeverage) {
      return {
        ok: false,
        reason: "leverage-unavailable",
        requestedLeverage: reqLev,
        maxLeverage: maxAllowedLev,
      };
    }
    return {
      ok: true,
      clamped: true,
      reason: "leverage-clamped",
      leverage: maxAllowedLev,
      requestedLeverage: reqLev,
      maxBracketNotional,
    };
  }

  return {
    ok: true,
    clamped: false,
    reason: null,
    leverage: reqLev,
    requestedLeverage: reqLev,
    maxBracketNotional,
  };
}

/**
 * Check cross-venue price divergence (EC-12: token rebrand / migration / broken feed).
 */
export function checkCrossVenueDivergence(venuePrices = [], maxDivergencePct = 30) {
  const valid = venuePrices
    .map((p) => (p && typeof p === "object" ? toNum(p.midPrice ?? p.price, 0) : toNum(p, 0)))
    .filter((p) => p > 0);
  if (valid.length < 2) return { ok: true, divergencePct: 0 };
  const minP = Math.min(...valid);
  const maxP = Math.max(...valid);
  const divergencePct = ((maxP - minP) / minP) * 100;
  if (divergencePct > maxDivergencePct) {
    return { ok: false, reason: "cross-venue-divergence", divergencePct, minPrice: minP, maxPrice: maxP };
  }
  return { ok: true, divergencePct, minPrice: minP, maxPrice: maxP };
}
