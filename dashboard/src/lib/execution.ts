import type { Coin } from "./data";

export type ExecutionStatus = "PASS" | "SCALED" | "BLOCKED";

export interface RouteQuote {
  venue: string;
  feeBps: number;
  spreadBps: number;
  impactBps: number;
  totalBps: number;
  best: boolean;
}

export interface ExecutionSnapshot {
  status: ExecutionStatus;
  route: string;
  spreadBps: number;
  impactBps: number;
  oneWayBps: number;
  roundTripBps: number;
  bandDepthUsd: number;
  maxSafeNotional: number;
  bookAgeMs: number;
  fillRatio: number;
  reasons: string[];
  routes: RouteQuote[];
}

export function executionFor(coin: Coin): ExecutionSnapshot {
  const quality = Math.max(0, Math.min(100, coin.score));
  const spreadBps = 0.7 + Math.max(0, 100 - quality) * 0.045;
  const impactBps = 1.8 + Math.max(0, 100 - quality) * 0.11;
  const oneWay = spreadBps / 2 + impactBps + 2.75;
  const roundTrip = oneWay * 2;
  const fillRatio =
    coin.status === "qualified" ? (quality >= 85 ? 1 : 0.68) : quality >= 66 ? 0.42 : 0.18;
  const status: ExecutionStatus =
    coin.status === "qualified"
      ? quality >= 85
        ? "PASS"
        : "SCALED"
      : coin.status === "near" && quality >= 66
        ? "SCALED"
        : "BLOCKED";
  const venues = Array.from(
    new Set([...coin.venues, "Binance", "Bybit", "OKX", "Gate"]),
  ).slice(0, 4);
  const routes = venues
    .map((venue, index) => {
      const feeBps = [2.5, 2.75, 3, 3.5][index % 4];
      const venueSpread = spreadBps + index * 0.12;
      const venueImpact = impactBps + index * 0.42;
      return {
        venue,
        feeBps,
        spreadBps: venueSpread,
        impactBps: venueImpact,
        totalBps: venueSpread / 2 + venueImpact + feeBps,
        best: false,
      };
    })
    .sort((a, b) => a.totalBps - b.totalBps);
  if (routes[0]) routes[0].best = true;

  const reasons =
    status === "PASS"
      ? [
          "Spread and cumulative depth are inside the execution gate.",
          "Requested size fills inside the 50 bps band.",
        ]
      : status === "SCALED"
        ? [
            `Sizing scaled to ${Math.round(fillRatio * 100)}% of the requested notional to fit book depth.`,
            "Entry cost remains below the configured one-way cap.",
          ]
        : [
            "One-way cost is above the execution gate.",
            "Book is too thin for the requested notional at this size.",
            "Signal remains visible but cannot open automatically.",
          ];

  return {
    status,
    route: routes[0]?.venue ?? coin.venues[0] ?? "Bybit",
    spreadBps,
    impactBps,
    oneWayBps: oneWay,
    roundTripBps: roundTrip,
    bandDepthUsd: Math.round(140_000 + quality * 2_900),
    maxSafeNotional: Math.round((8_000 + quality * 420) / 100) * 100,
    bookAgeMs: 42 + Math.round((100 - quality) * 2.4),
    fillRatio,
    reasons,
    routes,
  };
}

export const statusTone: Record<
  ExecutionStatus,
  "pos" | "warn" | "neg"
> = {
  PASS: "pos",
  SCALED: "warn",
  BLOCKED: "neg",
};
