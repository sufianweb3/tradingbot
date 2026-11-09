"use client";

import React, { useState } from "react";
import { CoinBadge } from "./ui/CoinBadge";
import { X, ChevronDown, ChevronUp } from "lucide-react";

export interface PositionItem {
  id: string;
  symbol: string;
  side: "long" | "short" | "LONG" | "SHORT";
  entryPrice: number;
  markPrice: number;
  margin: number;
  notional?: number;
  leverage: number;
  pnl: number;
  roe: number;
  venue?: string;
  routeBps?: number;
  stopLoss?: number;
  takeProfit1?: number;
  exitLiquidity?: "green" | "amber" | "red" | "OK" | "Thin" | "Critical" | string;
  exitImpactBps?: number;
  lifecycleStep?: number; // 1 to 7
}

export interface PositionsPanelProps {
  positions: PositionItem[];
  onClosePosition: (id: string) => void;
  onCloseAll: () => void;
  isClosingAll?: boolean;
}

const LIFECYCLE_STEPS = [
  "SIGNAL",
  "EQE_GATE",
  "ROUTED",
  "FILLED",
  "SL_PROTECTED",
  "TP1_PLACED",
  "TRAIL_EXIT",
];

export function PositionsPanel({
  positions = [],
  onClosePosition,
  onCloseAll,
  isClosingAll = false,
}: PositionsPanelProps) {
  const [expandedLifecycles, setExpandedLifecycles] = useState<Record<string, boolean>>({});

  const toggleLifecycle = (id: string) => {
    setExpandedLifecycles((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const totalMargin = positions.reduce((acc, p) => acc + (p.margin || 0), 0);

  return (
    <section
      id="panelPositions"
      aria-label="Open Positions"
      className="panel bg-[#0c1119] border border-[#192434] rounded-lg p-4 flex flex-col font-mono select-none"
    >
      {/* Panel Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[#192434] gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-slate-100 tracking-wider uppercase">
            Open Positions
          </h2>
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-800 text-slate-300">
            {positions.length}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span id="positionsSub" className="text-xs text-slate-400 hidden sm:inline-block">
            {positions.length} active positions · ${totalMargin.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} margin
          </span>
          <button
            type="button"
            id="btnCloseAll"
            disabled={positions.length === 0 || isClosingAll}
            onClick={onCloseAll}
            className="px-2.5 py-1 text-xs font-medium rounded bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-400 hover:text-rose-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isClosingAll ? "Closing All..." : "Close All"}
          </button>
        </div>
      </div>

      {/* Positions Body */}
      <div id="positionsBody" className="pt-3 flex flex-col gap-3">
        {positions.length === 0 ? (
          <div className="empty-row p-8 text-center text-slate-500 text-xs">
            <b className="text-slate-400 font-semibold block mb-1">No Open Positions</b>
            <span>Waiting for qualified scanner signals to execute entries.</span>
          </div>
        ) : (
          positions.map((pos) => {
            const isLong = String(pos.side).toLowerCase() === "long";
            const roePositive = pos.roe >= 0;
            const roeSign = roePositive ? "+" : "";
            const pnlSign = pos.pnl >= 0 ? "+" : "";
            const notional = pos.notional ?? pos.margin * (pos.leverage || 10);
            const routeVenue = pos.venue || "Bybit";
            const routeBps = pos.routeBps ?? 4.8;

            // Liquidity Badge calculation (FX-83)
            const liqRaw = String(pos.exitLiquidity || "OK").toUpperCase();
            const liqStatus = liqRaw.includes("CRIT") || liqRaw === "RED"
              ? "LIQ CRITICAL"
              : liqRaw.includes("THIN") || liqRaw === "AMBER"
              ? "LIQ THIN"
              : "LIQ OK";
            const liqTone = liqStatus === "LIQ OK"
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
              : liqStatus === "LIQ THIN"
              ? "bg-amber-500/10 text-amber-400 border-amber-500/30"
              : "bg-rose-500/10 text-rose-400 border-rose-500/30";

            // PnL Progress Track: calculate mark position relative to SL and TP1
            const sl = pos.stopLoss || (isLong ? pos.entryPrice * 0.98 : pos.entryPrice * 1.02);
            const tp = pos.takeProfit1 || (isLong ? pos.entryPrice * 1.04 : pos.entryPrice * 0.96);
            const range = Math.abs(tp - sl) || 1;
            const progress = isLong
              ? Math.min(100, Math.max(0, ((pos.markPrice - sl) / range) * 100))
              : Math.min(100, Math.max(0, ((sl - pos.markPrice) / range) * 100));

            const currentStep = pos.lifecycleStep ?? 5; // default 5 = SL_PROTECTED

            return (
              <div
                key={pos.id}
                className="p-3.5 bg-[#070a0f] border border-[#192434] rounded-lg flex flex-col gap-3 hover:border-slate-700 transition-colors"
              >
                {/* Top Row: Coin identification, side, leverage, route, liq badges & close */}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <CoinBadge symbol={pos.symbol} />
                    <span className="font-semibold text-slate-100 text-xs">
                      {pos.symbol} / USDT
                    </span>
                    <span
                      className={`px-1.5 py-0.5 text-[10px] font-semibold rounded ${
                        isLong
                          ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                          : "bg-rose-500/15 text-rose-400 border border-rose-500/30"
                      }`}
                    >
                      {isLong ? "LONG" : "SHORT"}
                    </span>
                    <span className="px-1.5 py-0.5 text-[10px] rounded bg-slate-800 text-slate-300">
                      {pos.leverage}×
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* Route Badge (FX-82) */}
                    <span
                      className="route-badge px-2 py-0.5 text-[10px] rounded bg-[#111823] border border-[#192434] text-slate-300 tabular-nums"
                      title="Executed Venue & Cost Basis"
                    >
                      {routeVenue} · {routeBps.toFixed(1)} bps
                    </span>

                    {/* Exit Liquidity Badge (FX-83) */}
                    <span
                      className={`liq-badge px-2 py-0.5 text-[10px] font-semibold rounded border tabular-nums ${liqTone}`}
                      title="Real-time exit liquidity health"
                    >
                      {liqStatus} · {(pos.exitImpactBps ?? 2.1).toFixed(1)} bps
                    </span>

                    {/* Close Position Button */}
                    <button
                      type="button"
                      onClick={() => onClosePosition(pos.id)}
                      className="w-6 h-6 rounded flex items-center justify-center text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                      title="Close this position"
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>

                {/* Second Row: Valuation Metrics Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                  <div className="flex flex-col">
                    <span className="text-[10px] text-slate-500">ENTRY / MARK</span>
                    <span className="text-slate-200 tabular-nums font-medium mt-0.5">
                      ${pos.entryPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })} →{" "}
                      <strong className="text-white">
                        ${pos.markPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </strong>
                    </span>
                  </div>

                  <div className="flex flex-col">
                    <span className="text-[10px] text-slate-500">MARGIN / NOTIONAL</span>
                    <span className="text-slate-300 tabular-nums mt-0.5">
                      ${pos.margin.toFixed(2)} (${notional.toFixed(0)})
                    </span>
                  </div>

                  <div className="flex flex-col">
                    <span className="text-[10px] text-slate-500">LIVE ROE %</span>
                    <span
                      className={`tabular-nums font-semibold mt-0.5 ${
                        roePositive ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {roeSign}{pos.roe.toFixed(2)}%
                    </span>
                  </div>

                  <div className="flex flex-col sm:text-right">
                    <span className="text-[10px] text-slate-500">UNREALIZED PnL</span>
                    <span
                      className={`tabular-nums font-bold mt-0.5 ${
                        pos.pnl >= 0 ? "text-emerald-400" : "text-rose-400"
                      }`}
                    >
                      {pnlSign}${Math.abs(pos.pnl).toFixed(2)}
                    </span>
                  </div>
                </div>

                {/* Third Row: PnL Progress Track */}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center justify-between text-[10px] text-slate-500 tabular-nums">
                    <span>SL ${sl.toFixed(2)}</span>
                    <span className="text-slate-300 font-semibold">Mark ${pos.markPrice.toFixed(2)}</span>
                    <span>TP1 ${tp.toFixed(2)}</span>
                  </div>
                  <div className="w-full h-1.5 rounded-full bg-[#111823] overflow-hidden relative">
                    <div
                      className={`h-full rounded-full transition-all duration-150 ${
                        roePositive ? "bg-emerald-500" : "bg-rose-500"
                      }`}
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>

                {/* Fourth Row: FX-86 Execution Lifecycle Timeline */}
                <div className="pc-lifecycle pt-2 border-t border-[#192434]/40 flex flex-col gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleLifecycle(pos.id)}
                    className="flex items-center justify-between text-[10px] text-slate-400 hover:text-slate-200 transition-colors w-full"
                  >
                    <span className="font-semibold uppercase tracking-wider">
                      Execution Lifecycle (FX-86): Step {currentStep} / 7
                    </span>
                    <span className="flex items-center gap-1">
                      {expandedLifecycles[pos.id] ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </span>
                  </button>

                  {expandedLifecycles[pos.id] && (
                    <div className="grid grid-cols-7 gap-1 pt-1.5 text-center text-[9px] font-mono">
                      {LIFECYCLE_STEPS.map((step, idx) => {
                        const stepNum = idx + 1;
                        const isDone = stepNum <= currentStep;
                        const isCurrent = stepNum === currentStep;
                        return (
                          <div
                            key={step}
                            className={`p-1 rounded border flex flex-col items-center gap-0.5 ${
                              isCurrent
                                ? "bg-sky-500/20 border-sky-400 text-sky-200 font-bold"
                                : isDone
                                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                                : "bg-[#111823] border-[#192434] text-slate-600"
                            }`}
                          >
                            <span>{stepNum}</span>
                            <span className="truncate w-full">{step}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

export default PositionsPanel;
