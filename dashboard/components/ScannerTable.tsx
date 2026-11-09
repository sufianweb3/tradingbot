"use client";

import React, { useState, useMemo } from "react";
import { CoinBadge } from "./ui/CoinBadge";
import { Search, Eye, ArrowUpRight } from "lucide-react";

export interface ScannerCoin {
  symbol: string;
  price: number;
  score: number;
  status: "qualified" | "near" | "all";
  direction: "long" | "short" | "conflict";
  oi5m: number;
  oi15m: number;
  oi30m: number;
  oi1h: number;
  oi4h: number;
  vol1h: number;
  vol4h: number;
  routeVenue?: string;
  routeBps?: number;
  eqeVerdict?: "PASS" | "SCALED" | "BLOCKED";
  eqeReason?: string;
  venues?: string[];
}

export interface ScannerTableProps {
  coins: ScannerCoin[];
  onInspect: (coin: ScannerCoin) => void;
  onTrade?: (symbol: string, side: "long" | "short") => void;
  countdownSec?: number;
}

export function ScannerTable({
  coins = [],
  onInspect,
  onTrade,
  countdownSec,
}: ScannerTableProps) {
  const [activeTab, setActiveTab] = useState<"qualified" | "near" | "all">("qualified");
  const [sideFilter, setSideFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  const [blockedFilter, setBlockedFilter] = useState<string>("all");

  // Filtered coins
  const filteredCoins = useMemo(() => {
    return coins.filter((coin) => {
      // Tab filter
      if (activeTab === "qualified" && coin.status !== "qualified") return false;
      if (activeTab === "near" && coin.status !== "near") return false;

      // Side filter
      if (sideFilter !== "all" && coin.direction !== sideFilter) return false;

      // Search filter
      if (search.trim()) {
        const q = search.toLowerCase();
        if (!coin.symbol.toLowerCase().includes(q)) return false;
      }

      // Blocked filter (FX-88)
      if (blockedFilter === "pass" && coin.eqeVerdict !== "PASS") return false;
      if (blockedFilter === "scaled" && coin.eqeVerdict !== "SCALED") return false;
      if (blockedFilter === "blocked" && coin.eqeVerdict !== "BLOCKED") return false;

      return true;
    });
  }, [coins, activeTab, sideFilter, search, blockedFilter]);

  const blockedCounts = useMemo(() => {
    let pass = 0;
    let scaled = 0;
    let blocked = 0;
    coins.forEach((c) => {
      if (c.eqeVerdict === "PASS") pass++;
      else if (c.eqeVerdict === "SCALED") scaled++;
      else blocked++;
    });
    return { pass, scaled, blocked, total: coins.length };
  }, [coins]);

  const formatPct = (val?: number) => {
    if (typeof val !== "number" || !Number.isFinite(val)) return "--";
    const sign = val > 0 ? "+" : "";
    return `${sign}${val.toFixed(2)}%`;
  };

  const getTone = (val?: number) => {
    if (typeof val !== "number" || !Number.isFinite(val)) return "text-slate-400";
    return val > 0 ? "text-emerald-400" : val < 0 ? "text-rose-400" : "text-slate-400";
  };

  return (
    <section
      id="panelScanner"
      aria-label="Perpetuals Market Scanner"
      className="panel bg-[#0c1119] border border-[#192434] rounded-lg p-4 flex flex-col font-mono select-none"
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[#192434] gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-slate-100 tracking-wider uppercase">
            Live Scanner
          </h2>
          <span id="scannerSub" className="text-xs text-slate-400">
            {coins.length} pairs monitored
          </span>
        </div>

        {/* Tab & Filter Controls */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Tabs */}
          <div id="marketTabs" className="flex rounded-md bg-[#070a0f] p-0.5 border border-[#192434]">
            <button
              type="button"
              id="tabQualified"
              onClick={() => setActiveTab("qualified")}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                activeTab === "qualified"
                  ? "bg-slate-800 text-slate-100 font-semibold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Qualified
            </button>
            <button
              type="button"
              id="tabNear"
              onClick={() => setActiveTab("near")}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                activeTab === "near"
                  ? "bg-slate-800 text-slate-100 font-semibold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              Near miss
            </button>
            <button
              type="button"
              id="tabAll"
              onClick={() => setActiveTab("all")}
              className={`px-2.5 py-1 text-xs rounded transition-colors ${
                activeTab === "all"
                  ? "bg-slate-800 text-slate-100 font-semibold"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              All
            </button>
          </div>

          {/* Side Filter */}
          <select
            id="marketSideFilter"
            value={sideFilter}
            onChange={(e) => setSideFilter(e.target.value)}
            className="px-2 py-1 text-xs bg-[#070a0f] border border-[#192434] rounded text-slate-200 focus:outline-none"
          >
            <option value="all">All sides</option>
            <option value="long">Long only</option>
            <option value="short">Short only</option>
            <option value="conflict">Conflict</option>
          </select>

          {/* Search Box */}
          <div className="relative">
            <input
              type="text"
              id="marketSearch"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search..."
              className="w-24 sm:w-32 pl-6 pr-2 py-1 text-xs bg-[#070a0f] border border-[#192434] rounded text-slate-100 focus:outline-none focus:border-sky-500"
            />
            <Search size={12} className="absolute left-2 top-2 text-slate-500" />
          </div>
        </div>
      </div>

      {/* FX-88: Blocked Signals Filter Bar */}
      <div id="blockedSignalsBar" className="py-2.5 border-b border-[#192434]/60 flex items-center justify-between gap-2 flex-wrap text-xs">
        <div id="blockedFilterPills" className="flex items-center gap-1.5 flex-wrap">
          <button
            type="button"
            onClick={() => setBlockedFilter("all")}
            className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
              blockedFilter === "all"
                ? "bg-sky-500/20 text-sky-300 font-semibold"
                : "bg-[#070a0f] text-slate-400 hover:text-slate-200"
            }`}
          >
            All Rows ({blockedCounts.total})
          </button>
          <button
            type="button"
            onClick={() => setBlockedFilter("pass")}
            className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
              blockedFilter === "pass"
                ? "bg-emerald-500/20 text-emerald-300 font-semibold"
                : "bg-[#070a0f] text-slate-400 hover:text-slate-200"
            }`}
          >
            EQE Pass ({blockedCounts.pass})
          </button>
          <button
            type="button"
            onClick={() => setBlockedFilter("scaled")}
            className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
              blockedFilter === "scaled"
                ? "bg-amber-500/20 text-amber-300 font-semibold"
                : "bg-[#070a0f] text-slate-400 hover:text-slate-200"
            }`}
          >
            Scaled ({blockedCounts.scaled})
          </button>
          <button
            type="button"
            onClick={() => setBlockedFilter("blocked")}
            className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
              blockedFilter === "blocked"
                ? "bg-rose-500/20 text-rose-300 font-semibold"
                : "bg-[#070a0f] text-slate-400 hover:text-slate-200"
            }`}
          >
            Gated / Blocked ({blockedCounts.blocked})
          </button>
        </div>

        <span id="blockedSignalsSummary" className="text-[10px] text-slate-500">
          EQE liquidity gate active · click any coin's Inspect button for live L2 book & route analysis
        </span>
      </div>

      {/* 12-Column High-Density Table */}
      <div className="overflow-x-auto mt-2">
        <table className="markets-table w-full text-left text-xs">
          <thead>
            <tr className="border-b border-[#192434] text-slate-500 text-[10px]">
              <th className="py-2.5 px-3 font-medium">COIN</th>
              <th className="py-2.5 px-2 font-medium text-right">PRICE</th>
              <th className="py-2.5 px-2 font-medium text-right">OI 5M</th>
              <th className="py-2.5 px-2 font-medium text-right">OI 15M</th>
              <th className="py-2.5 px-2 font-medium text-right">OI 30M</th>
              <th className="py-2.5 px-2 font-medium text-right">OI 1H</th>
              <th className="py-2.5 px-2 font-medium text-right">OI 4H</th>
              <th className="py-2.5 px-2 font-medium text-right">VOL 1H</th>
              <th className="py-2.5 px-2 font-medium text-right">VOL 4H</th>
              <th className="py-2.5 px-2 font-medium text-right">ROUTE (FX-82)</th>
              <th className="py-2.5 px-2 font-medium text-center">SIGNAL & VERDICT (FX-80)</th>
              <th className="py-2.5 px-3 font-medium text-right">ACTION</th>
            </tr>
          </thead>
          <tbody>
            {filteredCoins.length === 0 ? (
              <tr>
                <td colSpan={12} className="empty-row py-8 text-center text-slate-500">
                  <b className="text-slate-400 font-semibold block mb-1">No Matches Found</b>
                  <span>No perpetual pairs match your filter or tab selection.</span>
                </td>
              </tr>
            ) : (
              filteredCoins.map((coin) => {
                const verdict = coin.eqeVerdict || (coin.score >= 85 ? "PASS" : coin.score >= 66 ? "SCALED" : "BLOCKED");
                const verdictTone =
                  verdict === "PASS"
                    ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                    : verdict === "SCALED"
                    ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                    : "bg-rose-500/15 text-rose-400 border border-rose-500/30";

                const isLong = coin.direction === "long";
                const isShort = coin.direction === "short";
                const sideTone = isLong
                  ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30"
                  : isShort
                  ? "bg-rose-500/15 text-rose-400 border border-rose-500/30"
                  : "bg-amber-500/15 text-amber-400 border border-amber-500/30";

                return (
                  <tr
                    key={coin.symbol}
                    className="border-b border-[#192434]/40 hover:bg-[#111823]/60 transition-colors"
                  >
                    {/* 1. Coin */}
                    <td className="py-2.5 px-3">
                      <div className="flex items-center gap-2">
                        <CoinBadge symbol={coin.symbol} />
                        <div>
                          <div className="font-semibold text-slate-100">{coin.symbol}</div>
                          <div className="text-[10px] text-slate-500">USDT</div>
                        </div>
                      </div>
                    </td>

                    {/* 2. Price */}
                    <td className="py-2.5 px-2 text-right font-medium text-slate-200 tabular-nums">
                      ${coin.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                    </td>

                    {/* 3. OI 5m */}
                    <td className={`py-2.5 px-2 text-right tabular-nums ${getTone(coin.oi5m)}`}>
                      {formatPct(coin.oi5m)}
                    </td>

                    {/* 4. OI 15m */}
                    <td className={`py-2.5 px-2 text-right tabular-nums ${getTone(coin.oi15m)}`}>
                      {formatPct(coin.oi15m)}
                    </td>

                    {/* 5. OI 30m */}
                    <td className={`py-2.5 px-2 text-right tabular-nums ${getTone(coin.oi30m)}`}>
                      {formatPct(coin.oi30m)}
                    </td>

                    {/* 6. OI 1h */}
                    <td className={`py-2.5 px-2 text-right tabular-nums ${getTone(coin.oi1h)}`}>
                      {formatPct(coin.oi1h)}
                    </td>

                    {/* 7. OI 4h */}
                    <td className={`py-2.5 px-2 text-right tabular-nums ${getTone(coin.oi4h)}`}>
                      {formatPct(coin.oi4h)}
                    </td>

                    {/* 8. Vol 1h */}
                    <td className={`py-2.5 px-2 text-right tabular-nums ${getTone(coin.vol1h)}`}>
                      {formatPct(coin.vol1h)}
                    </td>

                    {/* 9. Vol 4h */}
                    <td className={`py-2.5 px-2 text-right tabular-nums ${getTone(coin.vol4h)}`}>
                      {formatPct(coin.vol4h)}
                    </td>

                    {/* 10. Route & Venue (FX-82) */}
                    <td className="py-2.5 px-2 text-right tabular-nums">
                      <span className="text-[11px] text-slate-300">
                        {coin.routeVenue || "Bybit"} · {(coin.routeBps ?? 4.8).toFixed(1)} bps
                      </span>
                    </td>

                    {/* 11. Signal & EQE Verdict Badge (FX-80) */}
                    <td className="py-2.5 px-2 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <span className={`px-1.5 py-0.5 text-[9px] font-semibold rounded uppercase ${sideTone}`}>
                          {coin.direction.toUpperCase()}
                        </span>
                        <span className={`px-1.5 py-0.5 text-[9px] font-semibold rounded tabular-nums ${verdictTone}`}>
                          {verdict}
                        </span>
                      </div>
                    </td>

                    {/* 12. Actions */}
                    <td className="py-2.5 px-3 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => onInspect(coin)}
                          className="flex items-center gap-1 px-2 py-1 rounded bg-[#111823] hover:bg-[#16202e] border border-[#192434] text-slate-300 hover:text-slate-100 transition-colors text-[11px]"
                          title="Inspect Order Book Depth & Smart Router"
                        >
                          <Eye size={11} />
                          <span>Inspect</span>
                        </button>
                        {onTrade && (
                          <button
                            type="button"
                            disabled={verdict === "BLOCKED"}
                            onClick={() => onTrade(coin.symbol, isLong ? "long" : "short")}
                            className="flex items-center gap-1 px-2 py-1 rounded bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-sky-400 hover:text-sky-300 transition-colors text-[11px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
                            title="Execute trade"
                          >
                            <span>Trade</span>
                            <ArrowUpRight size={11} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div id="marketFoot" className="pt-3 border-t border-[#192434] flex items-center justify-between text-xs text-slate-500">
        <span>Showing {filteredCoins.length} of {coins.length} perpetuals</span>
        <span id="scanCountdown" className="tabular-nums">
          {countdownSec !== undefined ? `Next cycle in ${countdownSec}s` : "Live scan"}
        </span>
      </div>
    </section>
  );
}

export default ScannerTable;
