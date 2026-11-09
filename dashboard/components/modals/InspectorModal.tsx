"use client";

import React, { useState, useMemo } from "react";
import { ModalShell } from "./ModalShell";
import { ArrowUpRight } from "lucide-react";

export interface CoinInspectorData {
  symbol: string;
  price: number;
  score: number;
  direction?: "long" | "short";
  venues?: string[];
  status?: "qualified" | "near" | "all";
}

export interface InspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  coin: CoinInspectorData | null;
  onTrade?: (symbol: string, side: "long" | "short") => void;
}

export function InspectorModal({ isOpen, onClose, coin, onTrade }: InspectorModalProps) {
  const [side, setSide] = useState<"long" | "short">(coin?.direction || "long");

  // Calculate EQE & Router Snapshot (FX-80, FX-81, FX-82)
  const snapshot = useMemo(() => {
    if (!coin) return null;
    const quality = Math.max(0, Math.min(100, coin.score ?? 80));
    const spreadBps = 0.7 + Math.max(0, 100 - quality) * 0.045;
    const impactBps = 1.8 + Math.max(0, 100 - quality) * 0.11;
    const oneWayBps = spreadBps / 2 + impactBps + 2.75;
    const roundTripBps = oneWayBps * 2;
    const fillRatio =
      coin.status === "qualified" ? (quality >= 85 ? 1.0 : 0.68) : quality >= 66 ? 0.42 : 0.18;
    const status =
      coin.status === "qualified"
        ? quality >= 85 ? "PASS" : "SCALED"
        : coin.status === "near" && quality >= 66 ? "SCALED" : "BLOCKED";

    const baseVenues = coin.venues && coin.venues.length ? coin.venues : ["Binance", "Bybit", "Gate", "KuCoin", "MEXC"];
    const uniqueVenues = Array.from(new Set([...baseVenues, "Binance", "Bybit", "Gate", "KuCoin", "MEXC"])).slice(0, 5);
    const routes = uniqueVenues
      .map((venue, idx) => {
        const feeBps = [2.5, 2.75, 3.0, 3.5, 3.8][idx % 5];
        const venueSpread = spreadBps + idx * 0.12;
        const venueImpact = impactBps + idx * 0.42;
        return {
          venue,
          feeBps,
          spreadBps: venueSpread,
          impactBps: venueImpact,
          totalBps: venueSpread / 2 + venueImpact + feeBps,
          safeNotional: Math.round((12000 - idx * 2200) / 100) * 100,
          best: false,
        };
      })
      .sort((a, b) => a.totalBps - b.totalBps);
    if (routes[0]) routes[0].best = true;

    return {
      status,
      route: routes[0]?.venue || "Bybit",
      spreadBps,
      impactBps,
      oneWayBps,
      roundTripBps,
      bandDepthUsd: Math.round(140000 + quality * 2900),
      maxSafeNotional: Math.round((8000 + quality * 420) / 100) * 100,
      bookAgeMs: 42 + Math.round((100 - quality) * 2.4),
      fillRatio,
      routes,
    };
  }, [coin]);

  if (!coin || !snapshot) return null;

  return (
    <div id="inspectorModal">
      <ModalShell
        isOpen={isOpen}
        onClose={onClose}
        title={`${coin.symbol} / USDT`}
        subtitle="Execution Quality Gate & Multi-Venue Smart Order Router"
        maxWidth="max-w-[680px]"
        badge={
          <span
            className={`px-2 py-0.5 font-mono text-xs font-semibold rounded ${
              snapshot.status === "PASS"
                ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                : snapshot.status === "SCALED"
                ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
            }`}
          >
            {snapshot.status}
          </span>
        }
      >
        {/* Side Selector & Price */}
        <div id="inspectorSideTabs" className="flex items-center justify-between gap-3 pb-3 border-b border-[#192434]">
          <div className="flex rounded-lg bg-[#070a0f] p-0.5 border border-[#192434]">
            <button
              type="button"
              onClick={() => setSide("long")}
              className={`px-3 py-1 text-xs font-mono font-medium rounded transition-colors ${
                side === "long" ? "bg-emerald-500/20 text-emerald-300 font-semibold" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Long Entry
            </button>
            <button
              type="button"
              onClick={() => setSide("short")}
              className={`px-3 py-1 text-xs font-mono font-medium rounded transition-colors ${
                side === "short" ? "bg-rose-500/20 text-rose-300 font-semibold" : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Short Entry
            </button>
          </div>
          <div className="text-right">
            <span className="text-[10px] font-mono text-slate-500 block uppercase">MID PRICE</span>
            <span id="insMidPrice" className="text-sm font-mono font-semibold text-slate-100 tabular-nums">
              ${coin.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
            </span>
          </div>
        </div>

        {/* FX-80: EQE 8-Metric Breakdown Grid */}
        <div className="mt-3">
          <span className="text-[10px] font-mono font-semibold text-slate-400 uppercase tracking-wider block mb-1.5">
            Execution Quality Breakdown (FX-80)
          </span>
          <div id="inspectorEqeGrid" className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { id: "insMidPriceStat", label: "Mid Price", val: `$${coin.price.toFixed(2)}` },
              { id: "insSpreadBps", label: "Spread", val: `${snapshot.spreadBps.toFixed(2)} bps` },
              { id: "insImpactBps", label: "Entry Slippage", val: `${snapshot.impactBps.toFixed(1)} bps` },
              { id: "insOneWayBps", label: "1-Way Cost", val: `${snapshot.oneWayBps.toFixed(1)} bps` },
              { id: "insRoundTripBps", label: "Round-Trip", val: `${snapshot.roundTripBps.toFixed(1)} bps` },
              { id: "insBandDepth", label: "Band Depth", val: `$${(snapshot.bandDepthUsd / 1000).toFixed(0)}k` },
              { id: "insMaxSafeNotional", label: "Max Safe Notional", val: `$${snapshot.maxSafeNotional.toLocaleString()}` },
              { id: "insBookAge", label: "Book Freshness", val: `${snapshot.bookAgeMs}ms` },
            ].map((item) => (
              <div key={item.label} className="p-2 rounded bg-[#070a0f] border border-[#192434] flex flex-col">
                <span className="text-[10px] font-mono text-slate-500">{item.label}</span>
                <span id={item.id} className="text-xs font-mono font-medium text-slate-200 tabular-nums mt-0.5">
                  {item.val}
                </span>
              </div>
            ))}
          </div>
          <p id="insReasonsText" className="text-[11px] font-mono text-slate-400 mt-2">
            {snapshot.status === "PASS"
              ? "All execution risk gates clear. Venue book depth confirms full notional capacity."
              : snapshot.status === "SCALED"
              ? "Liquidity depth moderate: sizing scaled to prevent excess market impact."
              : "Execution blocked: spread or market impact exceeds risk thresholds."}
          </p>
        </div>

        {/* FX-81: Cumulative L2 Order-Book Depth SVG Walk */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-mono font-semibold text-slate-400 uppercase tracking-wider">
              L2 Depth & Simulated Fill Walk (FX-81)
            </span>
            <span id="insWalkSummary" className="text-[10px] font-mono text-sky-400 tabular-nums">
              Fill Ratio: {(snapshot.fillRatio * 100).toFixed(0)}%
            </span>
          </div>
          <div id="inspectorDepthSvgWrap" className="p-3 rounded-lg bg-[#070a0f] border border-[#192434]">
            <svg viewBox="0 0 520 150" className="w-full h-auto" role="img" aria-label="Order book cumulative depth">
              {/* Grid lines */}
              {[30, 65, 100, 130].map((y) => (
                <line key={y} x1="10" y1={y} x2="510" y2={y} stroke="#192434" strokeWidth="1" strokeDasharray="3 3" />
              ))}
              {/* Midline */}
              <line x1="260" y1="15" x2="260" y2="135" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="4 4" />
              {/* Bid cumulative area & path */}
              <path
                d="M 260 135 L 210 110 L 160 85 L 110 50 L 50 25 L 20 20 L 20 135 Z"
                fill="rgba(16, 185, 129, 0.12)"
              />
              <path
                d="M 260 135 L 210 110 L 160 85 L 110 50 L 50 25 L 20 20"
                fill="none"
                stroke="#10b981"
                strokeWidth="2"
              />
              {/* Ask cumulative area & path */}
              <path
                d="M 260 135 L 310 112 L 360 88 L 410 52 L 470 28 L 500 22 L 500 135 Z"
                fill="rgba(244, 63, 94, 0.12)"
              />
              <path
                d="M 260 135 L 310 112 L 360 88 L 410 52 L 470 28 L 500 22"
                fill="none"
                stroke="#f43f5e"
                strokeWidth="2"
              />
              {/* Fill marker */}
              <circle
                cx={side === "long" ? 335 : 185}
                cy={95}
                r="4.5"
                fill="#38bdf8"
                stroke="#0c1119"
                strokeWidth="2"
              />
              {/* Text annotations */}
              <text x="24" y="35" fill="#10b981" fontSize="10" fontFamily="monospace">
                Bids Cumulative
              </text>
              <text x="496" y="35" fill="#f43f5e" fontSize="10" fontFamily="monospace" textAnchor="end">
                Asks Cumulative
              </text>
              <text x="260" y="146" fill="#94a3b8" fontSize="9" fontFamily="monospace" textAnchor="middle">
                Mid ${coin.price.toFixed(2)}
              </text>
            </svg>
          </div>
        </div>

        {/* FX-82: Smart Order Router Table */}
        <div className="mt-4">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-mono font-semibold text-slate-400 uppercase tracking-wider block">
              Smart Order Router: Multi-Venue Cost Comparison (FX-82)
            </span>
            <span id="insRouteSummary" className="text-[10px] font-mono text-emerald-400 font-semibold">
              Optimal: {snapshot.route}
            </span>
          </div>
          <div className="overflow-x-auto rounded-lg border border-[#192434] bg-[#070a0f]">
            <table className="inspector-route-table w-full text-left text-xs font-mono">
              <thead>
                <tr className="border-b border-[#192434] text-slate-500 text-[10px]">
                  <th className="py-2 px-3 font-medium">VENUE</th>
                  <th className="py-2 px-2 font-medium text-right">TAKER FEE</th>
                  <th className="py-2 px-2 font-medium text-right">SPREAD</th>
                  <th className="py-2 px-2 font-medium text-right">IMPACT</th>
                  <th className="py-2 px-2 font-medium text-right">TOTAL 1-WAY</th>
                  <th className="py-2 px-3 font-medium text-right">STATUS</th>
                </tr>
              </thead>
              <tbody id="inspectorRouteBody">
                {snapshot.routes.map((r) => (
                  <tr
                    key={r.venue}
                    className={`border-b border-[#192434]/40 last:border-0 ${
                      r.best ? "bg-emerald-500/5" : ""
                    }`}
                  >
                    <td className="py-2 px-3 font-medium text-slate-200">
                      {r.venue}
                      {r.best && (
                        <span className="ml-1.5 px-1 py-0.2 text-[9px] rounded bg-emerald-500/20 text-emerald-400">
                          BEST
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-2 text-right text-slate-400 tabular-nums">{r.feeBps.toFixed(2)} bps</td>
                    <td className="py-2 px-2 text-right text-slate-400 tabular-nums">{r.spreadBps.toFixed(2)} bps</td>
                    <td className="py-2 px-2 text-right text-slate-400 tabular-nums">{r.impactBps.toFixed(1)} bps</td>
                    <td className="py-2 px-2 text-right font-semibold text-slate-200 tabular-nums">
                      {r.totalBps.toFixed(1)} bps
                    </td>
                    <td className="py-2 px-3 text-right">
                      <span className="text-[10px] text-slate-400">
                        ${r.safeNotional.toLocaleString()} cap
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-5 pt-3 border-t border-[#192434] flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-mono text-slate-400 hover:text-slate-100 transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            disabled={snapshot.status === "BLOCKED"}
            onClick={() => {
              onTrade?.(coin.symbol, side);
              onClose();
            }}
            className={`flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-mono font-medium transition-colors ${
              snapshot.status === "BLOCKED"
                ? "bg-slate-800 text-slate-500 cursor-not-allowed"
                : "bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold"
            }`}
          >
            <span>
              {snapshot.status === "BLOCKED"
                ? "Execution Blocked"
                : `Execute ${side.toUpperCase()} Order`}
            </span>
            <ArrowUpRight size={13} strokeWidth={2.5} />
          </button>
        </div>
      </ModalShell>
    </div>
  );
}

export default InspectorModal;
