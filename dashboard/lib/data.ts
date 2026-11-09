export type Side = "long" | "short";
export type CoinStatus = "qualified" | "near" | "watch";

export interface Coin {
  symbol: string;
  name: string;
  price: number;
  oi5m: number;
  oi15m: number;
  oi1h: number;
  oi4h: number;
  vol1h: number;
  vol4h: number;
  change5m: number;
  change1h: number;
  change4h: number;
  change24h: number;
  score: number;
  status: CoinStatus;
  direction: Side;
  venues: string[];
  spark: number[];
  reentry?: string;
}

export interface Position {
  id: string;
  symbol: string;
  name: string;
  side: Side;
  leverage: number;
  margin: number;
  entry: number;
  mark: number;
  tp1: number;
  tpMax: number;
  stop: number;
  openedAt: Date;
  spark: number[];
  trailingArmed: boolean;
  venue: string;
  routeBps: number;
  exitLiquidity: "OK" | "Thin" | "Critical";
}

export interface Trade {
  id: string;
  symbol: string;
  name: string;
  side: Side;
  margin: number;
  leverage: number;
  entry: number;
  exit: number;
  pnl: number;
  roe: number;
  fees: number;
  openedAt: Date;
  closedAt: Date;
  reason: "TP1 + trail" | "Stop loss" | "Max TP" | "Manual" | "Liquidation guard";
}

export type ActivityType = "trade" | "scan" | "risk" | "system";

export interface ActivityItem {
  id: string;
  type: ActivityType;
  title: string;
  detail: string;
  at: Date;
}

export interface Venue {
  key: string;
  name: string;
  latency: number;
  status: "healthy" | "degraded";
  coins: number;
}

export interface FilterRow {
  id: string;
  kind: "oi" | "volume" | "price";
  timeframe: string;
  operator: "≥" | "≤";
  value: number;
  enabled: boolean;
}

export interface StrategyProfile {
  enabled: boolean;
  leverage: number;
  sizingMode: "allocation" | "fixedMargin" | "fixedQty";
  allocation: number;
  allocationBase: "initial" | "equity";
  fixedMargin: number;
  fixedQty: number;
  stopLoss: number;
  tp1: number;
  tp1Close: number;
  tpMax: number;
  trailing: boolean;
  trailingStart: "tp1" | "immediate";
  trailDistance: number;
  maxTrades: number;
  maxOpenPositions: number;
  maxPositionsPerCoin: number;
  reentryEnabled: boolean;
  reentryDelay: number;
  filters: FilterRow[];
}

export interface Exchange {
  id: string;
  name: string;
  shortName: string;
  tier: string;
  liveSupported: boolean;
  readOnly?: boolean;
  connected: boolean;
  active: boolean;
  maskedKey: string;
  balance: number;
  latency: number;
  feeBps: number;
  status: "connected" | "available" | "paper" | "price-feed";
  note?: string;
}


export interface EquityPoint {
  at: Date;
  value: number;
}

export const START_FUND = 25_000;

function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSpark(seed: number, end: number, trend: number, count = 26) {
  const random = seeded(seed);
  const points: number[] = [];
  let value = end / (1 + trend / 100);
  for (let i = 0; i < count; i += 1) {
    const progress = i / (count - 1);
    const target = end / (1 + (trend / 100) * (1 - progress));
    value += (target - value) * 0.22 + (random() - 0.5) * end * 0.0042;
    points.push(value);
  }
  points[points.length - 1] = end;
  return points;
}

interface CoinSeed {
  symbol: string;
  name: string;
  price: number;
  oi5m: number;
  oi15m: number;
  oi1h: number;
  oi4h: number;
  vol1h: number;
  vol4h: number;
  change1h: number;
  change24h: number;
  score: number;
  status: CoinStatus;
  direction: Side;
  venues: string[];
}

const coinSeeds: CoinSeed[] = [
  {
    symbol: "BTC",
    name: "Bitcoin",
    price: 69_187.2,
    oi5m: 2.84,
    oi15m: 4.12,
    oi1h: 5.08,
    oi4h: 8.34,
    vol1h: 48.2,
    vol4h: 71.5,
    change1h: 0.92,
    change24h: 2.41,
    score: 86,
    status: "qualified",
    direction: "long",
    venues: ["Binance", "Bybit", "OKX"],
  },
  {
    symbol: "ETH",
    name: "Ethereum",
    price: 3_598.41,
    oi5m: 3.42,
    oi15m: 5.26,
    oi1h: 6.74,
    oi4h: 9.1,
    vol1h: 62.8,
    vol4h: 84.2,
    change1h: 1.36,
    change24h: 4.18,
    score: 91,
    status: "qualified",
    direction: "long",
    venues: ["Binance", "Bybit", "OKX", "Gate"],
  },
  {
    symbol: "SOL",
    name: "Solana",
    price: 178.15,
    oi5m: 4.16,
    oi15m: 6.02,
    oi1h: 8.48,
    oi4h: 12.22,
    vol1h: 96.4,
    vol4h: 128.7,
    change1h: -1.42,
    change24h: -2.86,
    score: 88,
    status: "qualified",
    direction: "short",
    venues: ["Binance", "Bybit", "OKX"],
  },
  {
    symbol: "HYPE",
    name: "Hyperliquid",
    price: 39.06,
    oi5m: 3.08,
    oi15m: 4.44,
    oi1h: 7.16,
    oi4h: 10.32,
    vol1h: 74.1,
    vol4h: 96.8,
    change1h: 1.68,
    change24h: 6.22,
    score: 84,
    status: "qualified",
    direction: "long",
    venues: ["Bybit", "OKX", "Gate"],
  },
  {
    symbol: "SUI",
    name: "Sui",
    price: 4.218,
    oi5m: 5.24,
    oi15m: 7.18,
    oi1h: 9.42,
    oi4h: 14.6,
    vol1h: 112.8,
    vol4h: 148.2,
    change1h: 2.34,
    change24h: 8.16,
    score: 82,
    status: "qualified",
    direction: "long",
    venues: ["Binance", "Bybit", "Gate"],
  },
  {
    symbol: "LINK",
    name: "Chainlink",
    price: 17.842,
    oi5m: -3.18,
    oi15m: -5.44,
    oi1h: -7.82,
    oi4h: -9.16,
    vol1h: 81.5,
    vol4h: 104.3,
    change1h: -0.84,
    change24h: -1.92,
    score: 79,
    status: "qualified",
    direction: "short",
    venues: ["Binance", "OKX", "Bybit"],
  },
  {
    symbol: "DOGE",
    name: "Dogecoin",
    price: 0.1642,
    oi5m: 1.42,
    oi15m: 2.34,
    oi1h: 3.18,
    oi4h: 4.02,
    vol1h: 38.4,
    vol4h: 52.7,
    change1h: 0.42,
    change24h: 1.18,
    score: 68,
    status: "near",
    direction: "long",
    venues: ["Binance", "Bybit", "OKX"],
  },
  {
    symbol: "AVAX",
    name: "Avalanche",
    price: 36.42,
    oi5m: -1.86,
    oi15m: -3.12,
    oi1h: -4.48,
    oi4h: -6.02,
    vol1h: 42.6,
    vol4h: 58.4,
    change1h: -0.62,
    change24h: -1.44,
    score: 66,
    status: "near",
    direction: "short",
    venues: ["Binance", "Bybit", "Gate"],
  },
  {
    symbol: "TIA",
    name: "Celestia",
    price: 5.842,
    oi5m: 2.26,
    oi15m: 3.44,
    oi1h: 4.12,
    oi4h: 5.86,
    vol1h: 34.8,
    vol4h: 47.2,
    change1h: 0.74,
    change24h: 2.08,
    score: 64,
    status: "near",
    direction: "long",
    venues: ["Bybit", "OKX", "Gate"],
  },
  {
    symbol: "NEAR",
    name: "Near Protocol",
    price: 5.116,
    oi5m: -2.08,
    oi15m: -3.66,
    oi1h: -5.24,
    oi4h: -7.48,
    vol1h: 44.2,
    vol4h: 61.8,
    change1h: -0.96,
    change24h: -2.24,
    score: 61,
    status: "near",
    direction: "short",
    venues: ["Binance", "OKX", "Bybit"],
  },
  {
    symbol: "ARB",
    name: "Arbitrum",
    price: 0.8421,
    oi5m: 1.12,
    oi15m: 1.84,
    oi1h: 2.42,
    oi4h: 3.86,
    vol1h: 22.6,
    vol4h: 38.4,
    change1h: 0.38,
    change24h: 0.94,
    score: 48,
    status: "watch",
    direction: "long",
    venues: ["Binance", "Bybit", "OKX"],
  },
  {
    symbol: "OP",
    name: "Optimism",
    price: 1.862,
    oi5m: -0.84,
    oi15m: -1.42,
    oi1h: -2.08,
    oi4h: -3.44,
    vol1h: 19.8,
    vol4h: 31.2,
    change1h: -0.28,
    change24h: -0.72,
    score: 44,
    status: "watch",
    direction: "short",
    venues: ["Binance", "OKX", "Gate"],
  },
  {
    symbol: "WIF",
    name: "dogwifhat",
    price: 2.418,
    oi5m: 2.04,
    oi15m: 2.88,
    oi1h: 3.64,
    oi4h: 5.12,
    vol1h: 54.2,
    vol4h: 72.8,
    change1h: 1.12,
    change24h: 2.84,
    score: 58,
    status: "watch",
    direction: "long",
    venues: ["Binance", "Bybit", "Gate"],
  },
  {
    symbol: "PEPE",
    name: "Pepe",
    price: 0.00001142,
    oi5m: -2.42,
    oi15m: -3.84,
    oi1h: -5.02,
    oi4h: -6.88,
    vol1h: 66.4,
    vol4h: 88.1,
    change1h: -1.24,
    change24h: -3.16,
    score: 56,
    status: "watch",
    direction: "short",
    venues: ["Binance", "Bybit", "OKX"],
  },
];

export const seedCoins: Coin[] = coinSeeds.map((coin, index) => ({
  ...coin,
  change5m: Number((coin.change1h * 0.42).toFixed(2)),
  change4h: Number((coin.change24h * 0.78).toFixed(2)),
  spark: makeSpark(100 + index * 17, coin.price, coin.change1h * 3 + coin.change24h),
  ...(coin.symbol === "AVAX" ? { reentry: "12m 08s" } : {}),
}));

export const seedPositions: Position[] = [
  {
    id: "pos_btc_01",
    symbol: "BTC",
    name: "Bitcoin",
    side: "long",
    leverage: 50,
    margin: 1_250,
    entry: 68_412.5,
    mark: 69_187.2,
    tp1: 69_096.6,
    tpMax: 71_133.0,
    stop: 68_138.6,
    openedAt: new Date(Date.now() - 1000 * 60 * 74),
    spark: makeSpark(11, 69_187.2, 1.13),
    trailingArmed: true,
    venue: "Bybit",
    routeBps: 3.8,
    exitLiquidity: "OK",
  },
  {
    id: "pos_eth_02",
    symbol: "ETH",
    name: "Ethereum",
    side: "long",
    leverage: 25,
    margin: 900,
    entry: 3_521.8,
    mark: 3_598.41,
    tp1: 3_592.25,
    tpMax: 3_874.0,
    stop: 3_500.7,
    openedAt: new Date(Date.now() - 1000 * 60 * 48),
    spark: makeSpark(23, 3_598.41, 2.18),
    trailingArmed: true,
    venue: "Binance",
    routeBps: 4.2,
    exitLiquidity: "OK",
  },
  {
    id: "pos_sol_03",
    symbol: "SOL",
    name: "Solana",
    side: "short",
    leverage: 20,
    margin: 800,
    entry: 176.42,
    mark: 178.15,
    tp1: 172.85,
    tpMax: 162.1,
    stop: 179.42,
    openedAt: new Date(Date.now() - 1000 * 60 * 31),
    spark: makeSpark(37, 178.15, -0.98),
    trailingArmed: false,
    venue: "Bybit",
    routeBps: 11.6,
    exitLiquidity: "Thin",
  },
  {
    id: "pos_hype_04",
    symbol: "HYPE",
    name: "Hyperliquid",
    side: "long",
    leverage: 10,
    margin: 600,
    entry: 38.42,
    mark: 39.06,
    tp1: 39.58,
    tpMax: 43.04,
    stop: 37.84,
    openedAt: new Date(Date.now() - 1000 * 60 * 18),
    spark: makeSpark(53, 39.06, 1.66),
    trailingArmed: false,
    venue: "OKX",
    routeBps: 5.1,
    exitLiquidity: "OK",
  },
];

const tradeSeeds: Array<[string, string, Side, number, Trade["reason"], boolean]> = [
  ["BTC", "Bitcoin", "long", 212.4, "TP1 + trail", true],
  ["ETH", "Ethereum", "long", 148.2, "TP1 + trail", true],
  ["SOL", "Solana", "short", -92.4, "Stop loss", false],
  ["HYPE", "Hyperliquid", "long", 186.6, "Max TP", true],
  ["SUI", "Sui", "long", 224.8, "TP1 + trail", true],
  ["LINK", "Chainlink", "short", 104.2, "TP1 + trail", true],
  ["DOGE", "Dogecoin", "long", -68.4, "Stop loss", false],
  ["AVAX", "Avalanche", "short", 78.6, "TP1 + trail", true],
  ["TIA", "Celestia", "long", -54.2, "Manual", false],
  ["NEAR", "Near Protocol", "short", 132.8, "TP1 + trail", true],
  ["ARB", "Arbitrum", "long", 46.4, "TP1 + trail", true],
  ["OP", "Optimism", "short", -84.6, "Stop loss", false],
  ["WIF", "dogwifhat", "long", 192.2, "Max TP", true],
  ["PEPE", "Pepe", "short", 88.4, "TP1 + trail", true],
  ["BTC", "Bitcoin", "long", -72.8, "Stop loss", false],
  ["ETH", "Ethereum", "short", 142.6, "TP1 + trail", true],
  ["SOL", "Solana", "long", 258.4, "Max TP", true],
  ["HYPE", "Hyperliquid", "long", -96.2, "Liquidation guard", false],
  ["SUI", "Sui", "short", 62.8, "Manual", true],
  ["LINK", "Chainlink", "long", 108.4, "TP1 + trail", true],
  ["DOGE", "Dogecoin", "short", 74.2, "TP1 + trail", true],
  ["AVAX", "Avalanche", "long", -58.6, "Manual", false],
  ["TIA", "Celestia", "short", 116.8, "TP1 + trail", true],
  ["NEAR", "Near Protocol", "long", -88.4, "Stop loss", false],
  ["ARB", "Arbitrum", "short", 52.6, "TP1 + trail", true],
  ["OP", "Optimism", "long", 96.2, "TP1 + trail", true],
  ["WIF", "dogwifhat", "short", -64.8, "Manual", false],
  ["PEPE", "Pepe", "long", 82.4, "TP1 + trail", true],
  ["BTC", "Bitcoin", "short", 174.6, "Max TP", true],
  ["ETH", "Ethereum", "long", -78.2, "Stop loss", false],
  ["SOL", "Solana", "long", 128.4, "TP1 + trail", true],
  ["SUI", "Sui", "long", 66.2, "Manual", true],
  ["LINK", "Chainlink", "short", -52.4, "Manual", false],
  ["HYPE", "Hyperliquid", "long", 146.8, "TP1 + trail", true],
  ["DOGE", "Dogecoin", "long", 58.6, "TP1 + trail", true],
  ["AVAX", "Avalanche", "short", -72.8, "Stop loss", false],
];

const random = seeded(2_026_110_6);

export const seedTrades: Trade[] = tradeSeeds.map(
  ([symbol, name, side, pnl, reason, won], index) => {
    const base = coinSeeds.find((coin) => coin.symbol === symbol)?.price ?? 1;
    const margin = [500, 600, 750, 900][index % 4];
    const leverage = [10, 20, 25, 50][(index + 1) % 4];
    const roe = (pnl / margin) * 100;
    const move = (pnl / (margin * leverage)) * (side === "long" ? 1 : -1);
    const entry = base * (0.94 + random() * 0.12);
    const exit = entry * (1 + move);
    const closedAt = new Date(Date.now() - (index * 4.7 + 0.8 + random() * 1.4) * 3_600_000);
    const openedAt = new Date(closedAt.getTime() - (18 + random() * 160) * 60_000);
    return {
      id: `trade_${index + 1}`,
      symbol,
      name,
      side,
      margin,
      leverage,
      entry,
      exit,
      pnl,
      roe,
      fees: Number((margin * leverage * 0.001 + 1.4).toFixed(2)),
      openedAt,
      closedAt,
      reason: reason as Trade["reason"],
    };
  },
);

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

export const seedExchanges: Exchange[] = [
  {
    id: "bybit",
    name: "Bybit",
    shortName: "BY",
    tier: "V5 Linear",
    liveSupported: true,
    connected: true,
    active: true,
    maskedKey: "•••• 8f2c",
    balance: 1_284.5,
    latency: 54,
    feeBps: 5.5,
    status: "connected",
  },
  {
    id: "binance",
    name: "Binance",
    shortName: "BN",
    tier: "USDT-M Futures",
    liveSupported: true,
    connected: false,
    active: false,
    maskedKey: "",
    balance: 0,
    latency: 38,
    feeBps: 4.5,
    status: "available",
  },
  {
    id: "gate",
    name: "Gate.io",
    shortName: "GT",
    tier: "USDT Futures",
    liveSupported: true,
    connected: false,
    active: false,
    maskedKey: "",
    balance: 0,
    latency: 96,
    feeBps: 5,
    status: "available",
  },
  {
    id: "kucoin",
    name: "KuCoin",
    shortName: "KC",
    tier: "Futures",
    liveSupported: true,
    connected: false,
    active: false,
    maskedKey: "",
    balance: 0,
    latency: 108,
    feeBps: 6,
    status: "available",
  },
  {
    id: "mexc",
    name: "MEXC",
    shortName: "MX",
    tier: "Futures",
    liveSupported: false,
    connected: false,
    active: false,
    maskedKey: "",
    balance: 0,
    latency: 74,
    feeBps: 6,
    status: "paper",
    note: "Futures order API unavailable. Paper execution only.",
  },
  {
    id: "okx",
    name: "OKX",
    shortName: "OK",
    tier: "USDT Perpetual",
    liveSupported: false,
    readOnly: true,
    connected: false,
    active: false,
    maskedKey: "",
    balance: 0,
    latency: 82,
    feeBps: 5,
    status: "price-feed",
    note: "Used for price discovery and routing.",
  },
  {
    id: "bitget",
    name: "Bitget",
    shortName: "BG",
    tier: "USDT-M Futures",
    liveSupported: false,
    readOnly: true,
    connected: false,
    active: false,
    maskedKey: "",
    balance: 0,
    latency: 88,
    feeBps: 6,
    status: "price-feed",
    note: "Used for price discovery and routing.",
  },
];

export const seedTelemetry = {
  signalP50: 42,
  signalP95: 118,
  scrapeAge: 190,
  bookAge: 84,
  loopLag: 12,
};

export const seedActivity: ActivityItem[] = [
  {
    id: "act_1",
    type: "trade",
    title: "Opened HYPE long",
    detail: "$600 margin at 10×, entry 38.42, TP1 armed at 39.58",
    at: minutesAgo(18),
  },
  {
    id: "act_2",
    type: "scan",
    title: "Scan complete",
    detail: "412 coins scanned, 6 qualified, 1 position opened",
    at: minutesAgo(21),
  },
  {
    id: "act_3",
    type: "trade",
    title: "TP1 filled on ETH long",
    detail: "Closed 50% at 3,592.25, realised +$224.10, runner trailing",
    at: minutesAgo(29),
  },
  {
    id: "act_4",
    type: "risk",
    title: "Trailing stop raised on BTC long",
    detail: "Stop moved to 68,642.80, locks +28.4% ROE",
    at: minutesAgo(34),
  },
  {
    id: "act_5",
    type: "scan",
    title: "Near miss: DOGE",
    detail: "OI 5m +1.42% against 2.00% threshold, volume filter passed",
    at: minutesAgo(44),
  },
  {
    id: "act_6",
    type: "trade",
    title: "Opened SOL short",
    detail: "$800 margin at 20×, entry 176.42, invalidation at 179.42",
    at: minutesAgo(49),
  },
  {
    id: "act_7",
    type: "system",
    title: "Venue routing refreshed",
    detail: "Binance, Bybit and OKX selected for the active universe",
    at: minutesAgo(58),
  },
  {
    id: "act_8",
    type: "scan",
    title: "Scan complete",
    detail: "412 coins scanned, 5 qualified, 0 positions opened",
    at: minutesAgo(63),
  },
  {
    id: "act_9",
    type: "trade",
    title: "Closed AVAX short",
    detail: "Manual exit at 36.84, realised +$78.60",
    at: minutesAgo(84),
  },
  {
    id: "act_10",
    type: "risk",
    title: "Drawdown guard checked",
    detail: "Peak-to-trough 3.8%, within the 12% account limit",
    at: minutesAgo(96),
  },
  {
    id: "act_11",
    type: "system",
    title: "CoinGlass browser feed connected",
    detail: "Top 100 rows merged in 480 ms, data age 190 ms",
    at: minutesAgo(112),
  },
  {
    id: "act_12",
    type: "scan",
    title: "Scan complete",
    detail: "409 coins scanned, 4 qualified, 1 position opened",
    at: minutesAgo(121),
  },
  {
    id: "act_13",
    type: "trade",
    title: "Opened BTC long",
    detail: "$1,250 margin at 50×, entry 68,412.50, stop 68,138.60",
    at: minutesAgo(146),
  },
  {
    id: "act_14",
    type: "system",
    title: "Paper account initialised",
    detail: "Fund $25,000, fees 0.05%/side, slippage 0.02%/side",
    at: minutesAgo(180),
  },
];

export const venues: Venue[] = [
  { key: "binance", name: "Binance", latency: 38, status: "healthy", coins: 401 },
  { key: "bybit", name: "Bybit", latency: 54, status: "healthy", coins: 386 },
  { key: "okx", name: "OKX", latency: 82, status: "healthy", coins: 367 },
  { key: "gate", name: "Gate.io", latency: 96, status: "healthy", coins: 374 },
  { key: "mexc", name: "MEXC", latency: 74, status: "degraded", coins: 312 },
];

const longFilters: FilterRow[] = [
  { id: "f1", kind: "oi", timeframe: "5m", operator: "≥", value: 2, enabled: true },
  { id: "f2", kind: "oi", timeframe: "15m", operator: "≥", value: 3.5, enabled: true },
  { id: "f3", kind: "volume", timeframe: "1h", operator: "≥", value: 40, enabled: true },
];

const shortFilters: FilterRow[] = [
  { id: "f4", kind: "oi", timeframe: "5m", operator: "≤", value: -2.5, enabled: true },
  { id: "f5", kind: "volume", timeframe: "1h", operator: "≥", value: 55, enabled: true },
];

export const defaultStrategy: Record<Side, StrategyProfile> = {
  long: {
    enabled: true,
    leverage: 50,
    sizingMode: "allocation",
    allocation: 5,
    allocationBase: "initial",
    fixedMargin: 500,
    fixedQty: 1,
    stopLoss: 20,
    tp1: 50,
    tp1Close: 50,
    tpMax: 1000,
    trailing: true,
    trailingStart: "tp1",
    trailDistance: 20,
    maxTrades: 30,
    maxOpenPositions: 8,
    maxPositionsPerCoin: 1,
    reentryEnabled: false,
    reentryDelay: 30,
    filters: longFilters,
  },
  short: {
    enabled: true,
    leverage: 25,
    sizingMode: "allocation",
    allocation: 3.5,
    allocationBase: "initial",
    fixedMargin: 400,
    fixedQty: 1,
    stopLoss: 15,
    tp1: 40,
    tp1Close: 50,
    tpMax: 800,
    trailing: true,
    trailingStart: "tp1",
    trailDistance: 18,
    maxTrades: 20,
    maxOpenPositions: 4,
    maxPositionsPerCoin: 1,
    reentryEnabled: true,
    reentryDelay: 60,
    filters: shortFilters,
  },
};

export function buildEquitySeries(start: number, end: number, points = 240, seed = 71): EquityPoint[] {
  const random = seeded(seed);
  const now = Date.now();
  const raw: number[] = [];
  for (let i = 0; i < points; i += 1) {
    const p = i / (points - 1);
    const trend = start + (end - start) * p;
    const wave =
      Math.sin(p * Math.PI * 5.4) * start * 0.017 +
      Math.sin(p * Math.PI * 12.6 + 0.8) * start * 0.0065;
    const noise = (random() - 0.5) * start * 0.005 * Math.sin(p * Math.PI);
    raw.push(trend + wave + noise);
  }
  const last = raw[raw.length - 1];
  return raw.map((value, index) => ({
    at: new Date(now - (points - 1 - index) * 3 * 3_600_000),
    value: Math.max(start * 0.82, value + (end - last) * (index / (points - 1))),
  }));
}
