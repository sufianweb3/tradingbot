"use client";

import React from "react";

export interface BotStats {
  initialFund: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  winrate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  maxDrawdownUsd?: number;
  totalTrades: number;
  wins?: number;
  losses?: number;
  breakevens?: number;
  grossProfit?: number;
  grossLoss?: number;
  totalFees?: number;
  peakEquity?: number;
}

export interface KpiStripProps {
  stats?: BotStats;
  openPositionsCount?: number;
}

export function KpiStrip({
  stats = {
    initialFund: 10000,
    equity: 10482.5,
    realizedPnl: 514.2,
    unrealizedPnl: -31.7,
    winrate: 68.4,
    profitFactor: 2.14,
    maxDrawdownPct: 2.45,
    totalTrades: 36,
    wins: 24,
    losses: 11,
    breakevens: 1,
    grossProfit: 960,
    grossLoss: 446,
    totalFees: 48.2,
    peakEquity: 10510,
  },
  openPositionsCount = 3,
}: KpiStripProps) {
  const equityDelta = stats.equity - stats.initialFund;
  const equityPct = (equityDelta / (stats.initialFund || 1)) * 100;
  const eqSign = equityDelta >= 0 ? "+" : "";

  const pnlSign = stats.realizedPnl >= 0 ? "+" : "";
  const openSign = stats.unrealizedPnl >= 0 ? "+" : "";

  return (
    <section
      id="kpis"
      aria-label="Key Performance Indicators"
      className="kpis grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2 p-3 bg-[#070a0f] border-b border-[#192434] font-mono select-none"
    >
      {/* 1. Account Equity (Hero) */}
      <div className="capital-group col-span-1 p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col justify-between">
        <div className="kpi-head text-[10px] uppercase tracking-wider text-slate-400 font-bold">
          Account Equity
        </div>
        <div
          id="kpiEquity"
          className="kpi-value hero-val text-[23px] font-bold tracking-tight text-white tabular-nums my-1 leading-tight"
        >
          ${stats.equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
        <div
          id="kpiEquitySub"
          className="kpi-sub text-[11px] text-emerald-400 tabular-nums w-full break-words leading-tight"
        >
          start ${stats.initialFund.toLocaleString("en-US", { minimumFractionDigits: 2 })} · {eqSign}${Math.abs(equityDelta).toFixed(2)} ({eqSign}{equityPct.toFixed(2)}%)
        </div>
      </div>

      {/* 2. Net Realized P/L */}
      <div className="capital-group col-span-1 p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col justify-between">
        <div className="kpi-head text-[10px] uppercase tracking-wider text-slate-400 font-bold">
          Net P/L
        </div>
        <div
          id="kpiPnl"
          className={`kpi-value text-[20px] font-bold tracking-tight tabular-nums my-1 leading-tight ${
            stats.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"
          }`}
        >
          {pnlSign}${Math.abs(stats.realizedPnl).toFixed(2)}
        </div>
        <div
          id="kpiPnlSub"
          className="kpi-sub text-[11px] text-slate-400 tabular-nums w-full break-words leading-tight"
        >
          {equityPct >= 0 ? "+" : ""}{equityPct.toFixed(2)}% return · {stats.totalTrades} trades
        </div>
      </div>

      {/* 3. Open Unrealized */}
      <div className="capital-group col-span-1 p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col justify-between">
        <div className="kpi-head text-[10px] uppercase tracking-wider text-slate-400 font-bold">
          Open Unrealized
        </div>
        <div
          id="kpiOpen"
          className={`kpi-value text-[20px] font-bold tracking-tight tabular-nums my-1 leading-tight ${
            stats.unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"
          }`}
        >
          {openSign}${Math.abs(stats.unrealizedPnl).toFixed(2)}
        </div>
        <div
          id="kpiOpenSub"
          className="kpi-sub text-[11px] text-slate-400 tabular-nums w-full break-words leading-tight"
        >
          {openPositionsCount} active positions
        </div>
      </div>

      {/* 4. Win Rate */}
      <div className="perf-group col-span-1 p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col justify-between">
        <div className="kpi-head text-[10px] uppercase tracking-wider text-slate-400 font-bold">
          Win Rate
        </div>
        <div
          id="kpiWinrate"
          className="kpi-value text-[20px] font-bold tracking-tight text-slate-100 tabular-nums my-1 leading-tight"
        >
          {stats.winrate.toFixed(1)}%
        </div>
        <div
          id="kpiWinrateSub"
          className="kpi-sub text-[11px] text-slate-400 tabular-nums w-full break-words leading-tight"
        >
          {stats.wins ?? 24}W / {stats.losses ?? 11}L / {stats.breakevens ?? 1}BE
        </div>
      </div>

      {/* 5. Profit Factor */}
      <div className="perf-group col-span-1 p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col justify-between">
        <div className="kpi-head text-[10px] uppercase tracking-wider text-slate-400 font-bold">
          Profit Factor
        </div>
        <div
          id="kpiPf"
          className="kpi-value text-[20px] font-bold tracking-tight text-emerald-400 tabular-nums my-1 leading-tight"
        >
          {stats.profitFactor.toFixed(2)}
        </div>
        <div
          id="kpiPfSub"
          className="kpi-sub text-[11px] text-slate-400 tabular-nums w-full break-words leading-tight"
        >
          Gross: ${Math.round(stats.grossProfit ?? 960)} / ${Math.round(stats.grossLoss ?? 446)}
        </div>
      </div>

      {/* 6. Max Drawdown */}
      <div className="perf-group col-span-1 p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col justify-between">
        <div className="kpi-head text-[10px] uppercase tracking-wider text-slate-400 font-bold">
          Max Drawdown
        </div>
        <div
          id="kpiDd"
          className="kpi-value text-[20px] font-bold tracking-tight text-rose-400 tabular-nums my-1 leading-tight"
        >
          -{stats.maxDrawdownPct.toFixed(2)}%
        </div>
        <div
          id="kpiDdSub"
          className="kpi-sub text-[11px] text-slate-400 tabular-nums w-full break-words leading-tight"
        >
          Peak ${stats.peakEquity?.toLocaleString("en-US", { minimumFractionDigits: 2 }) ?? "10,510.00"}
        </div>
      </div>

      {/* 7. Closed Trades */}
      <div className="volume-group col-span-1 p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col justify-between">
        <div className="kpi-head text-[10px] uppercase tracking-wider text-slate-400 font-bold">
          Closed Trades
        </div>
        <div
          id="kpiTrades"
          className="kpi-value text-[20px] font-bold tracking-tight text-slate-100 tabular-nums my-1 leading-tight"
        >
          {stats.totalTrades}
        </div>
        <div
          id="kpiTradesSub"
          className="kpi-sub text-[11px] text-slate-400 tabular-nums w-full break-words leading-tight"
        >
          Completed
        </div>
      </div>

      {/* 8. Cumulative Fees */}
      <div className="volume-group col-span-1 p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col justify-between">
        <div className="kpi-head text-[10px] uppercase tracking-wider text-slate-400 font-bold">
          Total Fees
        </div>
        <div
          id="kpiFees"
          className="kpi-value text-[20px] font-bold tracking-tight text-slate-300 tabular-nums my-1 leading-tight"
        >
          ${(stats.totalFees ?? 48.2).toFixed(2)}
        </div>
        <div
          id="kpiFeesSub"
          className="kpi-sub text-[11px] text-slate-400 tabular-nums w-full break-words leading-tight"
        >
          incl. open positions
        </div>
      </div>
    </section>
  );
}

export default KpiStrip;
