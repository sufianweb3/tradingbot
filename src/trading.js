/**
 * Pure trading logic: criteria evaluation, level math, PnL and statistics.
 * Nothing here touches the network or the filesystem, which makes it testable.
 */

import { toNum, round } from "./util.js";

export const OI_TIMEFRAMES = ["5m", "15m", "30m", "1h", "4h"];
export const VOL_TIMEFRAMES = ["1h", "4h"];
export const PRICE_TIMEFRAMES = ["5m", "1h"];

export const OI_FIELD = {
  "5m": "m5OiChangePercent",
  "15m": "m15OiChangePercent",
  "30m": "m30OiChangePercent",
  "1h": "h1OiChangePercent",
  "4h": "h4OiChangePercent",
};

export const VOL_FIELD = {
  "1h": "h1VolChangePercent",
  "4h": "h4VolChangePercent",
};

export const PRICE_FIELD = {
  "5m": "m5PriceChangePercent",
  "1h": "h1PriceChangePercent",
};

export const OI_LABEL = {
  "5m": "OI 5m",
  "15m": "OI 15m",
  "30m": "OI 30m",
  "1h": "OI 1h",
  "4h": "OI 4h",
};

export const VOL_LABEL = {
  "1h": "Volume 1h",
  "4h": "Volume 4h",
};

export const PRICE_LABEL = {
  "5m": "Price 5m",
  "1h": "Price 1h",
};

export function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

export function compare(value, op, threshold) {
  const v = toNum(value);
  const t = toNum(threshold);
  if (v === null || t === null) return false;
  return op === "<=" ? v <= t : v >= t;
}

/**
 * Convert a configured SL/TP percentage into a raw price move percentage.
 * riskMode "roe"    -> % of margin (with leverage applied)
 * riskMode "price"  -> % of the coin price
 */
export function priceMovePct(riskMode, pct, leverage) {
  const p = toNum(pct, 0);
  if (riskMode === "price") return p;
  const lev = Math.max(1, toNum(leverage, 1));
  return p / lev;
}

export function computeLevels({ side, entry, settings }) {
  const lev = Math.max(1, toNum(settings.leverage, 1));
  const mode = settings.riskMode === "price" ? "price" : "roe";
  const slMove = Math.abs(priceMovePct(mode, settings.slPercent, lev)) / 100;
  const tp1Move = Math.abs(priceMovePct(mode, settings.tp1Percent, lev)) / 100;
  const tpMaxMove = Math.abs(priceMovePct(mode, settings.tpMaxPercent, lev)) / 100;
  const trailMove = Math.abs(priceMovePct(mode, settings.trailingDistancePercent, lev)) / 100;
  const dir = side === "short" ? -1 : 1;

  return {
    dir,
    slPrice: Math.max(Number.EPSILON, entry * (1 - dir * slMove)),
    tp1Price: Math.max(Number.EPSILON, entry * (1 + dir * tp1Move)),
    tpMaxPrice: Math.max(Number.EPSILON, entry * (1 + dir * tpMaxMove)),
    liqPrice: Math.max(
      Number.EPSILON,
      entry * (1 - dir * Math.max(0.001, 1 / lev - 0.005))
    ),
    // Raw price fractions, useful for the UI.
    slMove,
    tp1Move,
    tpMaxMove,
    trailMove,
  };
}

/** One active filter -> one check. Blank thresholds are ignored (not configured). */
export function buildChecks(coin, settings = {}) {
  const checks = [];
  for (const f of settings.oiFilters || []) {
    if (!f.enabled) continue;
    const threshold = toNum(f.threshold);
    if (threshold === null) continue;
    const value = toNum(coin?.oi?.[f.key]);
    checks.push({
      group: "oi",
      key: f.key,
      label: OI_LABEL[f.key] || `OI ${f.key}`,
      op: f.op === "<=" ? "<=" : ">=",
      threshold,
      value,
      pass: compare(value, f.op, threshold),
    });
  }
  for (const f of settings.volFilters || []) {
    if (!f.enabled) continue;
    const threshold = toNum(f.threshold);
    if (threshold === null) continue;
    const value = toNum(coin?.vol?.[f.key]);
    checks.push({
      group: "vol",
      key: f.key,
      label: VOL_LABEL[f.key] || `Volume ${f.key}`,
      op: f.op === "<=" ? "<=" : ">=",
      threshold,
      value,
      pass: compare(value, f.op, threshold),
    });
  }
  for (const f of settings.priceFilters || []) {
    if (!f.enabled) continue;
    const threshold = toNum(f.threshold);
    if (threshold === null) continue;
    const value = toNum(
      coin?.priceChange?.[f.key] ??
        (f.key === "5m" ? coin?.priceChange5m : f.key === "1h" ? coin?.priceChange1h : null)
    );
    checks.push({
      group: "price",
      key: f.key,
      label: PRICE_LABEL[f.key] || `Price ${f.key}`,
      op: f.op === "<=" ? "<=" : ">=",
      threshold,
      value,
      pass: compare(value, f.op, threshold),
    });
  }
  return checks;
}

export function enabledFilterCount(settings = {}) {
  const count = (list) =>
    (list || []).filter((f) => f.enabled && toNum(f.threshold) !== null).length;
  return (
    count(settings.oiFilters) +
    count(settings.volFilters) +
    count(settings.priceFilters)
  );
}

/**
 * Evaluate a coin against all enabled filters for a profile/settings.
 * Side can be passed explicitly (e.g. "long" | "short") for dual profiles (S1-S3),
 * or derived from filters/direction for legacy settings.
 */
export function evaluateCoin(coin, settings = {}, explicitSide = null) {
  if (settings.enabled === false) {
    return {
      configured: false,
      qualified: false,
      side: explicitSide || null,
      checks: [],
      passCount: 0,
      total: 0,
      missing: 0,
      needsDirection: false,
    };
  }

  const checks = buildChecks(coin, settings);
  if (!checks.length) {
    return {
      configured: false,
      qualified: false,
      side: explicitSide || null,
      checks,
      passCount: 0,
      total: 0,
      missing: 0,
      needsDirection: false,
    };
  }

  const oiChecks = checks.filter((c) => c.group === "oi");
  const directionChecks = oiChecks.length ? oiChecks : checks;
  const ops = new Set(directionChecks.map((c) => c.op));
  const autoSide = ops.size === 1 ? (ops.has("<=") ? "short" : "long") : null;
  const explicit = explicitSide || settings.direction || settings.side;
  const side = explicit === "long" || explicit === "short" ? explicit : autoSide;

  const passCount = checks.filter((c) => c.pass).length;
  const missing = checks.filter((c) => c.value === null).length;
  const qualified = passCount === checks.length && Boolean(side);

  return {
    configured: true,
    qualified,
    side,
    autoSide,
    checks,
    passCount,
    total: checks.length,
    missing,
    needsDirection: !side && passCount === checks.length,
  };
}

export function scoreCandidate(coin, evaluation) {
  let score = 0;
  for (const c of evaluation.checks) {
    if (c.threshold === 0) {
      score += c.pass ? 1 : 0;
    } else {
      const ratio = Math.abs(c.value ?? 0) / Math.abs(c.threshold);
      score += Math.min(ratio, 5);
    }
  }
  score += Math.log10(Math.max(1, toNum(coin.oiUsd, 0))) / 20;
  return score;
}

/** Unrealized PnL for the *remaining* quantity of an open position. */
export function positionMetrics(pos, price) {
  const p = toNum(price, pos.entryPrice);
  const qty = toNum(pos.qty, 0);
  const dir = pos.side === "short" ? -1 : 1;
  const gross = (p - pos.entryPrice) * qty * dir;
  const exitFee = p * qty * (toNum(pos.feePercent, 0) / 100);
  const net = gross - exitFee;
  const margin = Math.max(1e-9, toNum(pos.margin, 0));
  return {
    price: p,
    gross,
    exitFee,
    net,
    grossRoe: (gross / margin) * 100,
    netRoe: (net / margin) * 100,
    notional: p * qty,
  };
}

export function effectiveStopPrice(pos) {
  if (!pos.trailingActive || !Number.isFinite(pos.trailStopPrice)) return pos.slPrice;
  return pos.trailStopPrice;
}

/**
 * Compute all dashboard statistics.
 * @param {object} args
 * @param {Array} args.trades closed trades
 * @param {Array} args.positions open positions
 * @param {Map|object} args.marks position id -> current price
 */
export function computeStats({ trades, positions, marks, initialFund, equityCurve, feePercent = 0 }) {
  const closed = Array.isArray(trades) ? trades : [];
  const open = Array.isArray(positions) ? positions : [];
  const markFor = (p) => {
    if (marks instanceof Map) return marks.get(p.id) ?? p.markPrice ?? p.entryPrice;
    if (marks && typeof marks === "object") return marks[p.id] ?? p.markPrice ?? p.entryPrice;
    return p.markPrice ?? p.entryPrice;
  };

  let realizedPnl = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let feesClosed = 0;
  let best = null;
  let worst = null;
  let winStreak = 0;
  let lossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let longCount = 0;
  let longPnl = 0;
  let shortCount = 0;
  let shortPnl = 0;

  const sorted = [...closed].sort((a, b) => (a.exitTime || 0) - (b.exitTime || 0));
  for (const t of sorted) {
    const pnl = toNum(t.pnlNet, 0);
    realizedPnl += pnl;
    feesClosed += toNum(t.feesPaid, 0);
    if (pnl > 0) {
      wins++;
      grossProfit += pnl;
      winStreak++;
      lossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, winStreak);
    } else if (pnl < 0) {
      losses++;
      grossLoss += Math.abs(pnl);
      lossStreak++;
      winStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    } else {
      breakeven++;
      winStreak = 0;
      lossStreak = 0;
    }
    if (!best || pnl > best.pnlNet) best = t;
    if (!worst || pnl < worst.pnlNet) worst = t;
    if (t.side === "short") {
      shortCount++;
      shortPnl += pnl;
    } else {
      longCount++;
      longPnl += pnl;
    }
  }

  let openGross = 0;
  let openNet = 0;
  let openEntryFees = 0;
  let openExitFees = 0;
  let openPartialNet = 0;
  let openPartialFees = 0;
  for (const p of open) {
    const m = positionMetrics(p, markFor(p));
    openGross += m.gross;
    openNet += m.net;
    openEntryFees += toNum(p.entryFee, 0);
    openExitFees += m.exitFee;
    for (const part of p.partials || []) {
      openPartialNet += toNum(part.net, 0);
      openPartialFees += toNum(part.fee, 0);
    }
  }

  // Partial exits are realised cash even while the remainder of a trade is open.
  const realizedCash = realizedPnl + openPartialNet;
  const balance = toNum(initialFund, 0) + realizedCash - openEntryFees;
  const equity = balance + openNet;
  const lockedMargin = open.reduce((a, p) => a + toNum(p.margin, 0), 0);
  const totalPnl = equity - toNum(initialFund, 0);

  const values = [];
  if (Array.isArray(equityCurve)) {
    for (const pt of equityCurve) {
      const v = toNum(pt?.equity);
      if (v !== null) values.push(v);
    }
  }
  values.push(toNum(initialFund, 0));
  values.push(equity);

  let peak = -Infinity;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;
  let runningPeak = -Infinity;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = peak - v;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      runningPeak = peak;
      maxDrawdownPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }

  const totalTrades = closed.length;
  const winrate = totalTrades ? (wins / totalTrades) * 100 : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  const avgWin = wins ? grossProfit / wins : 0;
  const avgLoss = losses ? grossLoss / losses : 0;
  const avgTrade = totalTrades ? realizedPnl / totalTrades : 0;

  return {
    initialFund: toNum(initialFund, 0),
    balance,
    equity,
    lockedMargin,
    available: balance - lockedMargin,
    realizedPnl: realizedCash,
    unrealizedPnl: openNet,
    openGrossPnl: openGross,
    totalPnl,
    returnPct: initialFund > 0 ? (totalPnl / initialFund) * 100 : 0,
    totalTrades,
    openTrades: open.length,
    wins,
    losses,
    breakeven,
    winrate,
    grossProfit,
    grossLoss,
    profitFactor,
    avgWin,
    avgLoss,
    avgTrade,
    expectancy: totalTrades
      ? (wins / totalTrades) * avgWin - (losses / totalTrades) * avgLoss
      : 0,
    maxDrawdown,
    maxDrawdownPct,
    maxDrawdownPeak: Number.isFinite(runningPeak) ? runningPeak : null,
    feesPaid: feesClosed + openEntryFees + openPartialFees + openExitFees,
    feesClosed,
    openEntryFees,
    openExitFees,
    openPartialFees,
    openPartialNet,
    bestTrade: best,
    worstTrade: worst,
    maxWinStreak,
    maxLossStreak,
    long: { count: longCount, pnl: longPnl },
    short: { count: shortCount, pnl: shortPnl },
    lastTradeAt: sorted.length ? sorted[sorted.length - 1].exitTime : null,
  };
}

/**
 * Advance an open position one price tick.
 * Returns an action descriptor; the engine applies it. Pure so it can be tested.
 */
export function positionAction(pos, price, opts = {}) {
  const p = toNum(price);
  if (p === null) return { type: "none", reason: "no-price" };
  const dir = pos.side === "short" ? -1 : 1;
  const next = {
    peakPrice: dir > 0 ? Math.max(pos.peakPrice, p) : Math.min(pos.peakPrice, p),
    trailingActive: pos.trailingActive,
    trailStopPrice: pos.trailStopPrice,
    tp1Hit: pos.tp1Hit,
  };

  // Liquidation first (gap protection).
  if (dir > 0 ? p <= pos.liqPrice : p >= pos.liqPrice) {
    return { type: "close", reason: "Liquidation", price: pos.liqPrice, next, force: true };
  }

  // Activate / advance trailing stop.
  if (pos.trailingEnabled && (pos.trailingStart === "immediate" || pos.tp1Hit)) {
    const rawTrail =
      dir > 0 ? next.peakPrice * (1 - pos.trailMove) : next.peakPrice * (1 + pos.trailMove);
    next.trailingActive = true;
    if (dir > 0) {
      // Long: trailing stop moves upward only, bounded by slPrice
      const prevStop = toNum(pos.trailStopPrice, -Infinity);
      next.trailStopPrice = Math.max(pos.slPrice, prevStop, rawTrail);
    } else {
      // Short: trailing stop moves downward only, bounded by slPrice
      const prevStop = toNum(pos.trailStopPrice, Infinity);
      next.trailStopPrice = Math.min(pos.slPrice, prevStop, rawTrail);
    }
  }

  const stop = next.trailingActive ? next.trailStopPrice : pos.slPrice;
  if (dir > 0 ? p <= stop : p >= stop) {
    const isTrail = next.trailingActive && (pos.tp1Hit || pos.trailingStart === "immediate");
    return {
      type: "close",
      reason: isTrail ? "Trailing SL" : "SL",
      price: stop,
      next,
    };
  }

  if (!pos.tp1Hit && (dir > 0 ? p >= pos.tp1Price : p <= pos.tp1Price)) {
    return { type: "partial", reason: "TP1", price: p, next, pct: pos.tp1ClosePercent };
  }

  if (pos.tp1Hit && (dir > 0 ? p >= pos.tpMaxPrice : p <= pos.tpMaxPrice)) {
    return { type: "close", reason: "TP max", price: pos.tpMaxPrice, next };
  }

  return { type: "none", next };
}

/**
 * Apply slippage to an entry or exit price based on position side.
 */
export function applySlippage(price, side, kind, slipPercent) {
  const slip = Math.max(0, toNum(slipPercent, 0)) / 100;
  const dir = side === "long" ? 1 : -1;
  const sign = kind === "entry" ? dir : -dir;
  return price * (1 + sign * slip);
}

/**
 * Round a price or level to exchange tickSize.
 */
export function roundLevel(price, tickSize) {
  const p = Number(price);
  const t = Number(tickSize);
  if (!(p > 0) || !(t > 0)) return price;
  const inv = 1 / t;
  return Math.round(p * inv) / inv;
}
