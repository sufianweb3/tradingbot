import type { EquityPoint, Position, Trade } from "./data";
import { clamp, shortDate } from "./format";

export interface PositionMetrics {
  notional: number;
  pnl: number;
  roe: number;
  progress: number;
  tpDistancePct: number;
  stopDistancePct: number;
  liquidation: number;
}

export function positionMetrics(position: Position): PositionMetrics {
  const notional = position.margin * position.leverage;
  const move =
    position.side === "long"
      ? (position.mark - position.entry) / position.entry
      : (position.entry - position.mark) / position.entry;
  const pnl = notional * move;
  const roe = (pnl / position.margin) * 100;
  const progress =
    position.side === "long"
      ? clamp((position.mark - position.entry) / (position.tp1 - position.entry), 0, 1)
      : clamp((position.entry - position.mark) / (position.entry - position.tp1), 0, 1);
  const tpDistancePct =
    position.side === "long"
      ? ((position.tp1 - position.mark) / position.mark) * 100
      : ((position.mark - position.tp1) / position.mark) * 100;
  const stopDistancePct =
    position.side === "long"
      ? ((position.mark - position.stop) / position.mark) * 100
      : ((position.stop - position.mark) / position.mark) * 100;
  const liquidation =
    position.side === "long"
      ? position.entry * (1 - 1 / position.leverage + 0.005)
      : position.entry * (1 + 1 / position.leverage - 0.005);
  return {
    notional,
    pnl,
    roe,
    progress,
    tpDistancePct,
    stopDistancePct,
    liquidation,
  };
}

export function openPnl(positions: Position[]) {
  return positions.reduce((sum, position) => sum + positionMetrics(position).pnl, 0);
}

export function realisedPnl(trades: Trade[]) {
  return trades.reduce((sum, trade) => sum + trade.pnl, 0);
}

export function drawdownSeries(series: EquityPoint[]) {
  let peak = -Infinity;
  return series.map((point) => {
    peak = Math.max(peak, point.value);
    return { at: point.at, value: ((point.value - peak) / peak) * 100 };
  });
}

export function maxDrawdown(series: EquityPoint[]) {
  let peak = -Infinity;
  let worst = 0;
  for (const point of series) {
    peak = Math.max(peak, point.value);
    worst = Math.min(worst, ((point.value - peak) / peak) * 100);
  }
  return worst;
}

export function tradeStats(trades: Trade[]) {
  const wins = trades.filter((trade) => trade.pnl > 0);
  const losses = trades.filter((trade) => trade.pnl < 0);
  const grossWin = wins.reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.pnl, 0));
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const avgTrade = trades.length
    ? trades.reduce((sum, trade) => sum + trade.pnl, 0) / trades.length
    : 0;
  const best = trades.reduce<Trade | null>(
    (top, trade) => (!top || trade.pnl > top.pnl ? trade : top),
    null,
  );
  const worst = trades.reduce<Trade | null>(
    (low, trade) => (!low || trade.pnl < low.pnl ? trade : low),
    null,
  );
  const fees = trades.reduce((sum, trade) => sum + trade.fees, 0);
  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : 0,
    profitFactor: grossLoss ? grossWin / grossLoss : 0,
    avgTrade,
    avgWin,
    avgLoss,
    best,
    worst,
    fees,
    grossWin,
    grossLoss,
    expectancy: trades.length ? avgTrade : 0,
  };
}

export function monthlyReturns(series: EquityPoint[]) {
  const buckets = new Map<string, { label: string; start: number; end: number }>();
  for (const point of series) {
    const key = `${point.at.getFullYear()}-${point.at.getMonth()}`;
    const label = point.at.toLocaleDateString("en-US", { month: "short" });
    const current = buckets.get(key);
    if (!current) {
      buckets.set(key, { label, start: point.value, end: point.value });
    } else {
      current.end = point.value;
    }
  }
  return Array.from(buckets.values()).map((bucket) => ({
    label: bucket.label,
    value: ((bucket.end - bucket.start) / bucket.start) * 100,
  }));
}

export function weeklyReturns(series: EquityPoint[], limit = 8) {
  if (series.length < 2) return [];
  const buckets = new Map<
    string,
    { label: string; start: number; end: number }
  >();
  for (const point of series) {
    const monday = new Date(point.at);
    const offset = (monday.getDay() + 6) % 7;
    monday.setDate(monday.getDate() - offset);
    const key = monday.toDateString();
    const current = buckets.get(key);
    if (!current) {
      buckets.set(key, {
        label: shortDate(monday),
        start: point.value,
        end: point.value,
      });
    } else {
      current.end = point.value;
    }
  }
  return Array.from(buckets.values())
    .slice(-limit)
    .map((bucket) => ({
      label: bucket.label,
      value: ((bucket.end - bucket.start) / bucket.start) * 100,
    }));
}

