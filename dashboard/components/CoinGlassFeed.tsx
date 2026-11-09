"use client";

import React, { useState, useMemo } from "react";
import { CoinBadge } from "./ui/CoinBadge";
import { Search } from "lucide-react";

export interface CoinGlassItem {
  symbol: string;
  oi5m: number;
  vol1h: number;
}

export interface CoinGlassFeedProps {
  coins: CoinGlassItem[];
  updatedSecAgo?: number;
}

export function CoinGlassFeed({ coins = [], updatedSecAgo }: CoinGlassFeedProps) {
  const [sortKey, setSortKey] = useState<"abs" | "oiDesc" | "oiAsc" | "volDesc" | "volAsc">("abs");
  const [search, setSearch] = useState<string>("");

  const filteredCoins = useMemo(() => {
    let list = [...coins];
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((c) => c.symbol.toLowerCase().includes(q));
    }

    list.sort((a, b) => {
      if (sortKey === "abs") return Math.abs(b.oi5m) - Math.abs(a.oi5m);
      if (sortKey === "oiDesc") return b.oi5m - a.oi5m;
      if (sortKey === "oiAsc") return a.oi5m - b.oi5m;
      if (sortKey === "volDesc") return b.vol1h - a.vol1h;
      if (sortKey === "volAsc") return a.vol1h - b.vol1h;
      return 0;
    });

    return list;
  }, [coins, sortKey, search]);

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
      id="panelCoinGlass"
      aria-label="CoinGlass Live Feed"
      className="panel bg-[#0c1119] border border-[#192434] rounded-lg p-4 flex flex-col font-mono select-none"
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[#192434] gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-slate-100 tracking-wider uppercase">
            CoinGlass Live Data
          </h2>
          <span
            id="cgBadge"
            className="px-1.5 py-0.5 text-[9px] font-semibold rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
          >
            <span id="cgBadgeText">Live</span>
          </span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Sort Select */}
          <select
            id="cgSort"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value as any)}
            className="px-2 py-1 text-xs bg-[#070a0f] border border-[#192434] rounded text-slate-200 focus:outline-none"
          >
            <option value="abs">Sort: Absolute OI</option>
            <option value="oiDesc">Sort: OI High → Low</option>
            <option value="oiAsc">Sort: OI Low → High</option>
            <option value="volDesc">Sort: Vol High → Low</option>
            <option value="volAsc">Sort: Vol Low → High</option>
          </select>

          {/* Search */}
          <div className="relative">
            <input
              type="text"
              id="cgSearch"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter..."
              className="w-20 sm:w-28 pl-6 pr-2 py-1 text-xs bg-[#070a0f] border border-[#192434] rounded text-slate-100 focus:outline-none focus:border-sky-500"
            />
            <Search size={11} className="absolute left-2 top-2 text-slate-500" />
          </div>
        </div>
      </div>

      <div className="text-[11px] text-slate-500 py-2" id="cgSub">
        Top perpetual contracts ranked by sub-second open interest and volume flow
      </div>

      {/* Feed Table */}
      <div className="overflow-x-auto flex-1 max-h-[360px] overflow-y-auto">
        <table className="cg-table w-full text-left text-xs">
          <thead className="sticky top-0 bg-[#0c1119] z-10">
            <tr className="border-b border-[#192434] text-slate-500 text-[10px]">
              <th className="py-2 px-3 font-medium">COIN</th>
              <th className="py-2 px-2 font-medium text-right">OI 5M</th>
              <th className="py-2 px-3 font-medium text-right">VOL 1H</th>
            </tr>
          </thead>
          <tbody>
            {filteredCoins.length === 0 ? (
              <tr>
                <td colSpan={3} className="empty-row py-8 text-center text-slate-500">
                  <b className="text-slate-400 font-semibold block mb-1">No Movers</b>
                  <span>No data in CoinGlass flow table.</span>
                </td>
              </tr>
            ) : (
              filteredCoins.map((coin) => (
                <tr
                  key={coin.symbol}
                  className="border-b border-[#192434]/40 hover:bg-[#111823]/60 transition-colors"
                >
                  <td className="py-2 px-3">
                    <div className="flex items-center gap-2">
                      <CoinBadge symbol={coin.symbol} />
                      <span className="font-semibold text-slate-200">{coin.symbol}</span>
                    </div>
                  </td>
                  <td className={`py-2 px-2 text-right tabular-nums ${getTone(coin.oi5m)}`}>
                    {formatPct(coin.oi5m)}
                  </td>
                  <td className={`py-2 px-3 text-right tabular-nums ${getTone(coin.vol1h)}`}>
                    {formatPct(coin.vol1h)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      <div id="cgFoot" className="pt-2.5 border-t border-[#192434] flex items-center justify-between text-xs text-slate-500">
        <span>{filteredCoins.length} movers</span>
        <span id="cgUpdated" className="tabular-nums">
          {updatedSecAgo !== undefined ? `Updated ${updatedSecAgo}s ago` : "Live"}
        </span>
      </div>
    </section>
  );
}

export default CoinGlassFeed;
