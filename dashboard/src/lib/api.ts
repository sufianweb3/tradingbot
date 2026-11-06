import {
  seedExchanges,
  type ActivityItem,
  type Coin,
  type EquityPoint,
  type Exchange,
  type FilterRow,
  type Position,
  type Side,
  type StrategyProfile,
  type Trade,
} from "./data";

/* ------------------------------------------------------------------------- */
/* Bot API types                                                              */
/* ------------------------------------------------------------------------- */

export interface BotMarketRow {
  symbol: string;
  name?: string | null;
  price?: number | null;
  oi?: Record<string, number | null>;
  vol?: Record<string, number | null>;
  oiUsd?: number | null;
  volUsd24h?: number | null;
  priceChange5m?: number | null;
  priceChange1h?: number | null;
  priceChange24h?: number | null;
  qualified?: boolean;
  side?: string | null;
  isConflict?: boolean;
  passCount?: number;
  total?: number;
  score?: number;
  venue?: string | null;
  tradable?: boolean;
  stale?: boolean;
  cooling?: boolean;
  coolingRemainingSec?: number;
  excluded?: boolean;
  open?: boolean;
  blockReason?: string | null;
}

export interface BotPositionView {
  id: string;
  symbol: string;
  side: Side;
  venue?: string | null;
  venueName?: string | null;
  entryTime: number;
  entryPrice: number;
  markPrice: number;
  margin: number;
  leverage: number;
  qty?: number;
  roe?: number;
  slPrice?: number;
  stopPrice?: number;
  tp1Price?: number;
  tpMaxPrice?: number;
  trailingActive?: boolean;
  exitHealth?: { health?: string };
  routeSummary?: { totalCostBps?: number };
}

export interface BotTrade {
  id: string;
  symbol: string;
  side: Side;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  margin: number;
  leverage: number;
  pnlNet: number;
  roe: number;
  feesPaid?: number;
  exitReason?: string;
}

export interface BotStats {
  initialFund?: number;
  balance?: number;
  equity?: number;
  available?: number;
  unrealizedPnl?: number;
  realizedPnl?: number;
  totalTrades?: number;
  openTrades?: number;
  winrate?: number;
  maxDrawdownPct?: number;
}

export interface BotLog {
  t: number;
  level: string;
  msg: string;
  data?: unknown;
}

export interface BotEquityPoint {
  t: number;
  equity: number;
  balance?: number;
  unrealized?: number;
}

export interface BotMeta {
  running?: boolean;
  scanning?: boolean;
  killSwitch?: boolean;
  scanCount?: number;
  lastScan?: { at?: number; ms?: number; total?: number; qualified?: number; opened?: number } | number | null;
  nextScanAt?: number | null;
  marketAgeMs?: number | null;
  coinglass?: { state?: string; connected?: boolean; coins?: number; ageMs?: number | null };
}

export interface BotSettings {
  totalFund?: number;
  mode?: "paper" | "live";
  riskMode?: "roe" | "price";
  direction?: "auto" | "long" | "short";
  minOiUsd?: number;
  minVolUsd24h?: number;
  excludeSymbols?: string;
  allowCoinglassPrice?: boolean;
  scanIntervalSec?: number;
  priceRefreshMs?: number;
  feePercent?: number;
  slippagePercent?: number;
  reenterEnabled?: boolean;
  reenterDelayMin?: number;
  autoStart?: boolean;
  coinglassKeySet?: boolean;
  venues?: string[];
  live?: {
    exchange?: string;
    marginPerTrade?: number;
    maxOpenPositions?: number;
    dailyLossCap?: number;
    clampLeverage?: boolean;
  };
  profiles?: Record<Side, Record<string, unknown>>;
  eqe?: Record<string, unknown>;
  sim?: Record<string, unknown>;
  exec?: Record<string, unknown>;
  route?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BotBootstrap {
  serverTime?: number;
  settings: BotSettings;
  initialFund?: number;
  meta?: BotMeta;
  stats?: BotStats;
  positions?: BotPositionView[];
  markets?: BotMarketRow[];
  trades?: BotTrade[];
  equityCurve?: BotEquityPoint[];
  logs?: BotLog[];
  speed?: Record<string, unknown>;
}

export interface BotDashboard {
  serverTime?: number;
  meta?: BotMeta;
  stats?: BotStats;
  positions?: BotPositionView[];
  markets?: BotMarketRow[];
  equityCurve?: BotEquityPoint[];
  logs?: BotLog[];
  speed?: Record<string, unknown>;
}

export interface BotVenueStatus {
  id: string;
  name: string;
  tier?: string;
  liveSupported?: boolean;
  connected: boolean;
  maskedKey?: string | null;
  isActive?: boolean;
}

export interface BotExchangeStatus {
  mode?: "paper" | "live";
  activeVenue?: string;
  venues?: BotVenueStatus[];
}

/* ------------------------------------------------------------------------- */
/* HTTP                                                                      */
/* ------------------------------------------------------------------------- */

export class ApiError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status = 0, payload: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.payload = payload;
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

function post(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    cache: "no-store",
    ...init,
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError("The bot API returned a non-JSON response.", response.status);
    }
  }
  const record = (payload ?? {}) as Record<string, unknown>;
  if (!response.ok || record.ok === false) {
    throw new ApiError(
      typeof record.error === "string" ? record.error : `Request failed (${response.status})`,
      response.status,
      payload,
    );
  }
  return payload as T;
}

export const api = {
  bootstrap: () => request<BotBootstrap>("/api/bootstrap"),
  dashboard: () => request<BotDashboard>("/api/dashboard"),
  trades: (limit = 200) => request<{ trades: BotTrade[]; total?: number }>(`/api/trades?limit=${limit}`),
  exchangeStatus: () => request<BotExchangeStatus>("/api/exchange/status"),
  control: (action: "start" | "pause" | "toggle" | "reset" | "close-all") =>
    request<Record<string, unknown>>("/api/control", post({ action })),
  scan: () => request<Record<string, unknown>>("/api/scan", post({})),
  openTrade: (symbol: string, side?: Side) =>
    request<Record<string, unknown>>("/api/trade/open", post({ symbol, side, force: true })),
  closeTrade: (id: string) => request<Record<string, unknown>>("/api/trade/close", post({ id })),
  mode: (mode: "paper" | "live") =>
    request<Record<string, unknown>>(
      "/api/mode",
      post(mode === "live" ? { mode, confirmed: true, confirmation: "LIVE" } : { mode }),
    ),
  killSwitch: (active: boolean) =>
    request<Record<string, unknown>>("/api/kill-switch", post({ active })),
  panic: () => request<Record<string, unknown>>("/api/panic", post({})),
  reconcile: () => request<Record<string, unknown>>("/api/reconcile", post({})),
  saveSettings: (settings: Record<string, unknown>) =>
    request<{ settings?: BotSettings; reset?: boolean }>("/api/settings", post({ settings })),
  coinglassKey: (apiKey: string | null) =>
    request<{ settings?: BotSettings }>("/api/coinglass/key", post({ apiKey })),
  exchangeSelect: (venue: string) =>
    request<Record<string, unknown>>("/api/exchange/select", post({ venue })),
  exchangeTest: (body: {
    venue: string;
    apiKey: string;
    secret: string;
    passphrase?: string;
  }) =>
    request<{
      balance?: { availableUsdt?: number; equityUsdt?: number };
      instrumentsCount?: number;
      accountMode?: unknown;
    }>("/api/exchange/test", post(body)),
  exchangeConnect: (body: {
    venue: string;
    apiKey: string;
    secret: string;
    passphrase?: string;
  }) => request<{ maskedKey?: string; settings?: BotSettings }>("/api/exchange/connect", post(body)),
  exchangeDisconnect: (venue: string) =>
    request<Record<string, unknown>>("/api/exchange/disconnect", post({ venue })),
  backupExport: (includeKeys: boolean) =>
    request<{ backup: unknown; filename?: string }>(
      `/api/backup/export?includeKeys=${includeKeys ? "true" : "false"}`,
    ),
  backupImport: (backup: unknown) =>
    request<Record<string, unknown>>("/api/backup/import", post(backup)),
};

/* ------------------------------------------------------------------------- */
/* Mapping helpers                                                           */
/* ------------------------------------------------------------------------- */

const num = (value: unknown, fallback = 0): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const optionalNum = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function hash(text: string) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

/** Build a small deterministic sparkline that ends at the current price. */
function sparkFor(seedText: string, end: number, trendPct: number, count = 26) {
  if (!(end > 0)) return Array.from({ length: count }, () => 0);
  let state = hash(seedText) || 1;
  const random = () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const start = end / (1 + (Number.isFinite(trendPct) ? trendPct : 0) / 100);
  const points: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const progress = index / (count - 1);
    const target = start + (end - start) * progress;
    const noise = (random() - 0.5) * end * 0.0025;
    points.push(index === count - 1 ? end : target + noise);
  }
  return points;
}

function coolingLabel(seconds: number) {
  const total = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
}

export function mapCoins(rows: BotMarketRow[] | undefined): Coin[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const total = num(row.total);
    const pass = num(row.passCount);
    const qualified = Boolean(row.qualified);
    const status: Coin["status"] = qualified
      ? "qualified"
      : row.isConflict || row.excluded
        ? "watch"
        : total > 0 && pass >= Math.max(1, total - 1)
          ? "near"
          : "watch";
    const direction: Side = row.side === "short" ? "short" : "long";
    const change1h = optionalNum(row.priceChange1h) ?? 0;
    const change24h = optionalNum(row.priceChange24h) ?? 0;
    const priceValue = num(row.price);
    return {
      symbol: String(row.symbol ?? "").toUpperCase(),
      name: row.name || String(row.symbol ?? "").toUpperCase(),
      price: priceValue,
      oi5m: optionalNum(row.oi?.["5m"]) ?? 0,
      oi15m: optionalNum(row.oi?.["15m"]) ?? 0,
      oi1h: optionalNum(row.oi?.["1h"]) ?? 0,
      oi4h: optionalNum(row.oi?.["4h"]) ?? 0,
      vol1h: optionalNum(row.vol?.["1h"]) ?? 0,
      vol4h: optionalNum(row.vol?.["4h"]) ?? 0,
      change5m: optionalNum(row.priceChange5m) ?? 0,
      change1h,
      change4h: change24h,
      change24h,
      score: Math.round(
        Math.min(99, Math.max(0, (total > 0 ? (pass / total) * 70 : 0) + Math.min(29, num(row.score) * 6))),
      ),
      status,
      direction,
      venues: row.venue ? [row.venue] : [],
      spark: sparkFor(String(row.symbol ?? "coin"), priceValue, change1h + change24h / 4),
      ...(row.cooling && row.coolingRemainingSec
        ? { reentry: coolingLabel(row.coolingRemainingSec) }
        : {}),
    };
  });
}

export function mapPositions(
  views: BotPositionView[] | undefined,
  names?: Map<string, string>,
): Position[] {
  if (!Array.isArray(views)) return [];
  return views.map((view) => {
    const entry = num(view.entryPrice);
    const mark = num(view.markPrice, entry);
    const side: Side = view.side === "short" ? "short" : "long";
    const health = String(view.exitHealth?.health ?? "green").toLowerCase();
    return {
      id: String(view.id),
      symbol: String(view.symbol ?? "").toUpperCase(),
      name: names?.get(String(view.symbol ?? "").toUpperCase()) || String(view.symbol ?? "").toUpperCase(),
      side,
      leverage: Math.max(1, num(view.leverage, 1)),
      margin: num(view.margin),
      entry,
      mark,
      tp1: num(view.tp1Price, entry),
      tpMax: num(view.tpMaxPrice, entry),
      stop: num(view.stopPrice ?? view.slPrice, entry),
      openedAt: new Date(num(view.entryTime, Date.now())),
      spark: sparkFor(String(view.id), mark, num(view.roe)),
      trailingArmed: Boolean(view.trailingActive),
      venue: view.venueName || view.venue || "—",
      routeBps: num(view.routeSummary?.totalCostBps),
      exitLiquidity: health === "red" || health === "critical" ? "Critical" : health === "yellow" ? "Thin" : "OK",
    };
  });
}

function tradeReason(reason: string | undefined): Trade["reason"] {
  const value = String(reason ?? "").toLowerCase();
  if (value.includes("liquid")) return "Liquidation guard";
  if (value.includes("stop") || value.includes("sl")) return "Stop loss";
  if (value.includes("tp1") || value.includes("trail") || value.includes("partial")) return "TP1 + trail";
  if (value.includes("tp") || value.includes("target")) return "Max TP";
  return "Manual";
}

export function mapTrades(trades: BotTrade[] | undefined, names?: Map<string, string>): Trade[] {
  if (!Array.isArray(trades)) return [];
  return trades.map((trade) => ({
    id: String(trade.id),
    symbol: String(trade.symbol ?? "").toUpperCase(),
    name: names?.get(String(trade.symbol ?? "").toUpperCase()) || String(trade.symbol ?? "").toUpperCase(),
    side: trade.side === "short" ? "short" : "long",
    margin: num(trade.margin),
    leverage: Math.max(1, num(trade.leverage, 1)),
    entry: num(trade.entryPrice),
    exit: num(trade.exitPrice),
    pnl: num(trade.pnlNet),
    roe: num(trade.roe),
    fees: num(trade.feesPaid),
    openedAt: new Date(num(trade.entryTime, Date.now())),
    closedAt: new Date(num(trade.exitTime, Date.now())),
    reason: tradeReason(trade.exitReason),
  }));
}

export function mapLogs(logs: BotLog[] | undefined, since = 0): ActivityItem[] {
  if (!Array.isArray(logs)) return [];
  return logs
    .filter((log) => num(log.t) > since)
    .map((log, index) => {
      const message = String(log.msg ?? "Engine event");
      const level = String(log.level ?? "info").toLowerCase();
      const lower = message.toLowerCase();
      const type: ActivityItem["type"] =
        /open|close|fill|tp1|stop|trail|position|trade|exit|entry/.test(lower)
          ? "trade"
          : /scan|market|coinglass|universe|feed/.test(lower)
            ? "scan"
            : /kill|risk|panic|reconcile|guard|drawdown|loss|margin/.test(lower)
              ? "risk"
              : "system";
      let detail = level.toUpperCase();
      if (log.data !== undefined) {
        try {
          detail = JSON.stringify(log.data).slice(0, 180);
        } catch {
          detail = level.toUpperCase();
        }
      }
      return {
        id: `log_${num(log.t)}_${index}`,
        type,
        title: message,
        detail,
        at: new Date(num(log.t, Date.now())),
      };
    })
    .reverse();
}

export function mapEquity(
  curve: BotEquityPoint[] | undefined,
  initialFund: number,
  currentEquity?: number,
): EquityPoint[] {
  const points = (Array.isArray(curve) ? curve : [])
    .map((point) => ({
      at: new Date(num(point.t, Date.now())),
      value: num(point.equity, initialFund),
    }))
    .filter((point) => Number.isFinite(point.value))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (!points.length) {
    const now = Date.now();
    return [
      { at: new Date(now - 3_600_000), value: initialFund },
      { at: new Date(now), value: num(currentEquity, initialFund) },
    ];
  }
  if (points.length === 1) {
    points.unshift({ at: new Date(points[0].at.getTime() - 3_600_000), value: initialFund });
  }
  return points;
}

export function mapExchanges(
  status: BotExchangeStatus | null,
  previous: Exchange[] = [],
): Exchange[] {
  const statusById = new Map((status?.venues ?? []).map((venue) => [venue.id, venue]));
  const known = new Set(seedExchanges.map((exchange) => exchange.id));
  const merged = seedExchanges.map((base) => {
    const live = statusById.get(base.id);
    const existing = previous.find((exchange) => exchange.id === base.id);
    if (!live) {
      return {
        ...base,
        active: false,
        balance: existing?.balance ?? 0,
        connected: Boolean(existing?.connected),
        maskedKey: existing?.maskedKey ?? "",
      };
    }
    return {
      ...base,
      name: base.name,
      tier: live.tier || base.tier,
      liveSupported: live.liveSupported ?? base.liveSupported,
      connected: Boolean(live.connected),
      active: Boolean(live.isActive),
      maskedKey: live.maskedKey ?? "",
      balance: existing?.balance ?? 0,
      status: live.connected
        ? ("connected" as const)
        : base.readOnly
          ? ("price-feed" as const)
          : base.liveSupported
            ? ("available" as const)
            : ("paper" as const),
    };
  });
  for (const venue of status?.venues ?? []) {
    if (known.has(venue.id)) continue;
    merged.push({
      id: venue.id,
      name: venue.name,
      shortName: venue.id.slice(0, 2).toUpperCase(),
      tier: venue.tier || "Futures",
      liveSupported: Boolean(venue.liveSupported),
      connected: Boolean(venue.connected),
      active: Boolean(venue.isActive),
      maskedKey: venue.maskedKey ?? "",
      balance: 0,
      latency: 0,
      feeBps: 5,
      status: venue.connected ? "connected" : "available",
    });
  }
  return merged;
}

export function mapTelemetry(speed: Record<string, unknown> | undefined) {
  const stages = (speed?.stages ?? {}) as Record<string, { p50?: number; p95?: number }>;
  const signal = stages.signalToOrderMs ?? {};
  return {
    signalP50: Math.round(num(signal.p50)),
    signalP95: Math.round(num(signal.p95)),
    scrapeAge: Math.round(num(speed?.scrapeAgeMs)),
    bookAge: Math.round(num(speed?.bookAgeMs)),
    loopLag: Math.round(num(speed?.eventLoopLagMs)),
  };
}

export function metaTimestamp(meta: BotMeta | undefined): Date {
  const lastScan = meta?.lastScan;
  if (typeof lastScan === "number" && lastScan > 0) return new Date(lastScan);
  if (lastScan && typeof lastScan === "object" && lastScan.at) return new Date(num(lastScan.at));
  return new Date();
}

/* ------------------------------------------------------------------------- */
/* Settings mapping                                                          */
/* ------------------------------------------------------------------------- */

export interface BotGlobalSettings {
  totalFund: number;
  riskMode: "roe" | "price";
  direction: "auto" | "long" | "short";
  minOiUsd: number;
  minVolUsd24h: number;
  excludeSymbols: string;
  allowCoinglassPrice: boolean;
  scanIntervalSec: number;
  priceRefreshMs: number;
  feePercent: number;
  slippagePercent: number;
  reenterEnabled: boolean;
  reenterDelayMin: number;
  autoStart: boolean;
  notifications: boolean;
}

export interface BotExecutionSettings {
  eqeEnabled: boolean;
  maxOneWayCostBps: number;
  maxSpreadBps: number;
  minDepthMultiple: number;
  autoSizeToLiquidity: boolean;
  entryOrderType: "ioc-limit" | "market";
  fundingGuard: boolean;
  routeMode: "auto" | "pinned";
  realismMode: "standard" | "conservative" | "stress" | "optimistic";
}

export interface BotLiveGuardrails {
  exchange: string;
  marginPerTrade: number;
  dailyLossCap: number;
  maxOpenPositions: number;
  clampLeverage: boolean;
}

const timeframeByKind: Record<FilterRow["kind"], string[]> = {
  oi: ["5m", "15m", "30m", "1h", "4h"],
  volume: ["1h", "4h"],
  price: ["5m", "1h"],
};

function botFiltersToRows(side: Side, kind: FilterRow["kind"], list: unknown): FilterRow[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((filter): filter is Record<string, unknown> => Boolean(filter) && typeof filter === "object")
    .map((filter) => ({
      id: `${side}_${kind}_${String(filter.key ?? "")}`,
      kind,
      timeframe: String(filter.key ?? "5m"),
      operator: filter.op === "<=" ? "≤" : "≥",
      value: num(filter.threshold),
      enabled: Boolean(filter.enabled),
    }));
}

export function profilesFromSettings(
  settings: BotSettings | null,
): Record<Side, StrategyProfile> | null {
  if (!settings?.profiles) return null;
  const build = (side: Side): StrategyProfile | null => {
    const profile = settings.profiles?.[side];
    if (!profile) return null;
    return {
      enabled: Boolean(profile.enabled),
      leverage: Math.max(1, num(profile.leverage, 1)),
      sizingMode:
        profile.sizingMode === "fixedMargin" || profile.sizingMode === "fixedQty"
          ? profile.sizingMode
          : "allocation",
      allocation: num(profile.allocationPercent, 5),
      allocationBase: profile.allocationBase === "equity" ? "equity" : "initial",
      fixedMargin: num(profile.fixedMargin, 500),
      fixedQty: num(profile.fixedQty, 1),
      stopLoss: num(profile.slPercent, 20),
      tp1: num(profile.tp1Percent, 50),
      tp1Close: num(profile.tp1ClosePercent, 50),
      tpMax: num(profile.tpMaxPercent, 1000),
      trailing: profile.trailingEnabled !== false,
      trailingStart: profile.trailingStart === "immediate" ? "immediate" : "tp1",
      trailDistance: num(profile.trailingDistancePercent, 20),
      maxTrades: num(profile.maxTrades),
      maxOpenPositions: num(profile.maxOpenPositions),
      maxPositionsPerCoin: Math.max(1, num(profile.maxPositionsPerCoin, 1)),
      reentryEnabled: settings.reenterEnabled !== false,
      reentryDelay: num(settings.reenterDelayMin, 30),
      filters: [
        ...botFiltersToRows(side, "oi", profile.oiFilters),
        ...botFiltersToRows(side, "volume", profile.volFilters),
        ...botFiltersToRows(side, "price", profile.priceFilters),
      ],
    };
  };
  const long = build("long");
  const short = build("short");
  if (!long || !short) return null;
  return { long, short };
}

export function globalFromSettings(settings: BotSettings | null): BotGlobalSettings {
  return {
    totalFund: num(settings?.totalFund, 25_000),
    riskMode: settings?.riskMode === "price" ? "price" : "roe",
    direction:
      settings?.direction === "long" || settings?.direction === "short" ? settings.direction : "auto",
    minOiUsd: num(settings?.minOiUsd),
    minVolUsd24h: num(settings?.minVolUsd24h),
    excludeSymbols: String(settings?.excludeSymbols ?? ""),
    allowCoinglassPrice: Boolean(settings?.allowCoinglassPrice),
    scanIntervalSec: num(settings?.scanIntervalSec, 30),
    priceRefreshMs: num(settings?.priceRefreshMs, 3000),
    feePercent: num(settings?.feePercent, 0.05),
    slippagePercent: num(settings?.slippagePercent, 0.02),
    reenterEnabled: settings?.reenterEnabled !== false,
    reenterDelayMin: num(settings?.reenterDelayMin, 30),
    autoStart: Boolean(settings?.autoStart),
    notifications: true,
  };
}

export function executionFromSettings(settings: BotSettings | null): BotExecutionSettings {
  const eqe = (settings?.eqe ?? {}) as Record<string, unknown>;
  const sim = (settings?.sim ?? {}) as Record<string, unknown>;
  const exec = (settings?.exec ?? {}) as Record<string, unknown>;
  const route = (settings?.route ?? {}) as Record<string, unknown>;
  const realism = String(sim.realismMode ?? "realistic").toLowerCase();
  return {
    eqeEnabled: eqe.enabled !== false,
    maxOneWayCostBps: num(eqe.maxEntryImpactBps, 18),
    maxSpreadBps: num(eqe.maxSpreadBps, 12),
    minDepthMultiple: num(eqe.minEntryDepthMult, 3),
    autoSizeToLiquidity: eqe.liquiditySizing !== false,
    entryOrderType: exec.entryOrderType === "market" ? "market" : "ioc-limit",
    fundingGuard: sim.applyFunding !== false,
    routeMode: route.mode === "pinned" ? "pinned" : "auto",
    realismMode:
      realism === "optimistic"
        ? "optimistic"
        : realism === "pessimistic"
          ? "conservative"
          : realism === "live-equivalent"
            ? "stress"
            : "standard",
  };
}

export function venuesFromSettings(settings: BotSettings | null): Record<string, boolean> {
  const active = new Set(Array.isArray(settings?.venues) ? settings.venues : []);
  const record: Record<string, boolean> = {};
  for (const key of ["binance", "bybit", "okx", "gate", "kucoin", "mexc", "bitget"]) {
    record[key] = active.has(key);
  }
  return record;
}

export function liveFromSettings(settings: BotSettings | null): BotLiveGuardrails {
  const live = settings?.live ?? {};
  return {
    exchange: String(live.exchange ?? "bybit"),
    marginPerTrade: num(live.marginPerTrade),
    dailyLossCap: num(live.dailyLossCap),
    maxOpenPositions: num(live.maxOpenPositions),
    clampLeverage: live.clampLeverage !== false,
  };
}

function rowsToBotFilters(rows: FilterRow[], kind: FilterRow["kind"]) {
  return timeframeByKind[kind].map((timeframe) => {
    const match = [...rows]
      .reverse()
      .find((filter) => filter.kind === kind && filter.timeframe === timeframe);
    return {
      key: timeframe,
      enabled: Boolean(match?.enabled),
      op: match?.operator === "≤" ? "<=" : ">=",
      threshold: match ? match.value : null,
      group: kind,
    };
  });
}

function profileToBot(profile: StrategyProfile) {
  return {
    enabled: profile.enabled,
    leverage: profile.leverage,
    sizingMode: profile.sizingMode,
    allocationPercent: profile.allocation,
    allocationBase: profile.allocationBase,
    fixedMargin: profile.fixedMargin,
    fixedQty: profile.fixedQty,
    slPercent: profile.stopLoss,
    tp1Percent: profile.tp1,
    tp1ClosePercent: profile.tp1Close,
    tpMaxPercent: profile.tpMax,
    trailingEnabled: profile.trailing,
    trailingStart: profile.trailingStart,
    trailingDistancePercent: profile.trailDistance,
    maxTrades: profile.maxTrades,
    maxOpenPositions: profile.maxOpenPositions,
    maxPositionsPerCoin: profile.maxPositionsPerCoin,
    oiFilters: rowsToBotFilters(profile.filters, "oi"),
    volFilters: rowsToBotFilters(profile.filters, "volume"),
    priceFilters: rowsToBotFilters(profile.filters, "price"),
  };
}

export function buildSettingsPatch({
  profiles,
  global,
  execution,
  venues,
  live,
}: {
  profiles: Record<Side, StrategyProfile>;
  global: BotGlobalSettings;
  execution: BotExecutionSettings;
  venues: Record<string, boolean>;
  live: BotLiveGuardrails;
}): Record<string, unknown> {
  return {
    totalFund: global.totalFund,
    riskMode: global.riskMode,
    direction: global.direction,
    minOiUsd: global.minOiUsd,
    minVolUsd24h: global.minVolUsd24h,
    excludeSymbols: global.excludeSymbols,
    allowCoinglassPrice: global.allowCoinglassPrice,
    scanIntervalSec: global.scanIntervalSec,
    priceRefreshMs: global.priceRefreshMs,
    feePercent: global.feePercent,
    slippagePercent: global.slippagePercent,
    reenterEnabled: global.reenterEnabled,
    reenterDelayMin: global.reenterDelayMin,
    autoStart: global.autoStart,
    venues: Object.keys(venues).filter((key) => venues[key]),
    profiles: {
      long: profileToBot(profiles.long),
      short: profileToBot(profiles.short),
    },
    eqe: {
      enabled: execution.eqeEnabled,
      maxEntryImpactBps: execution.maxOneWayCostBps,
      maxSpreadBps: execution.maxSpreadBps,
      minEntryDepthMult: execution.minDepthMultiple,
      liquiditySizing: execution.autoSizeToLiquidity,
    },
    exec: {
      entryOrderType: execution.entryOrderType,
    },
    sim: {
      applyFunding: execution.fundingGuard,
      realismMode:
        execution.realismMode === "standard"
          ? "realistic"
          : execution.realismMode === "conservative"
            ? "pessimistic"
            : execution.realismMode === "stress"
              ? "live-equivalent"
              : "optimistic",
    },
    route: {
      mode: execution.routeMode,
    },
    live: {
      exchange: live.exchange,
      marginPerTrade: live.marginPerTrade,
      dailyLossCap: live.dailyLossCap,
      maxOpenPositions: live.maxOpenPositions,
      clampLeverage: live.clampLeverage,
    },
  };
}

export function liveGuardrailsPatch(live: BotLiveGuardrails): Record<string, unknown> {
  return {
    live: {
      exchange: live.exchange,
      marginPerTrade: live.marginPerTrade,
      dailyLossCap: live.dailyLossCap,
      maxOpenPositions: live.maxOpenPositions,
      clampLeverage: live.clampLeverage,
    },
  };
}

export function readableError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}
