/**
 * Venue Adapters Registry (PRD 5.6, 6.2)
 */

import { BinanceAdapter } from "./binance.js";
import { BybitAdapter } from "./bybit.js";
import { GateAdapter } from "./gate.js";
import { KuCoinAdapter } from "./kucoin.js";
import { ExchangeAdapter } from "./interface.js";

export { BinanceAdapter } from "./binance.js";
export { BybitAdapter } from "./bybit.js";
export { GateAdapter } from "./gate.js";
export { KuCoinAdapter } from "./kucoin.js";
export { ExchangeAdapter } from "./interface.js";

export const SUPPORTED_VENUES = [
  { id: "binance", name: "Binance USDT-M Futures", tier: "v1", liveSupported: true },
  { id: "bybit", name: "Bybit V5 Linear", tier: "v1", liveSupported: true },
  { id: "gate", name: "Gate.io USDT Futures", tier: "v1-m4", liveSupported: true },
  { id: "kucoin", name: "KuCoin Futures", tier: "v1-m4", liveSupported: true },
  { id: "mexc", name: "MEXC Futures", tier: "v1-m5", liveSupported: false },
];

export function createVenueAdapter(venueId, options = {}) {
  const v = String(venueId || "").toLowerCase().trim();
  switch (v) {
    case "binance":
      return new BinanceAdapter(options);
    case "bybit":
      return new BybitAdapter(options);
    case "gate":
      return new GateAdapter(options);
    case "kucoin":
      return new KuCoinAdapter(options);
    default:
      throw new Error(`Unsupported exchange adapter venue: '${venueId}'`);
  }
}

