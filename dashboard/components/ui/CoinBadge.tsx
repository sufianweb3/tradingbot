"use client";

import React, { useState } from "react";

export interface CoinBadgeProps {
  symbol: string;
  rawLogo?: string;
  className?: string;
}

export function normalizeCoinSymbol(sym: string): string {
  let s = String(sym || "").trim().toLowerCase();
  s = s.replace(/[-_/]?(perp|swap)$/i, "");
  s = s.replace(/[-_/]?(usdt|usdc|usd|busd)$/i, "");
  s = s.replace(/^(1000000|100000|10000|1000|100|k)([a-z]+)$/i, "$2");
  s = s.replace(/[^a-z0-9]/g, "");
  return s || String(sym || "").trim().toLowerCase();
}

export function getCoinInitials(sym: string): string {
  const norm = normalizeCoinSymbol(sym).toUpperCase();
  const raw = String(sym || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const target = norm || raw;
  return target.slice(0, 2) || "??";
}

export function CoinBadge({ symbol, rawLogo, className = "" }: CoinBadgeProps) {
  const [hasError, setHasError] = useState(false);
  const norm = normalizeCoinSymbol(symbol);
  const initials = getCoinInitials(symbol);
  const src = rawLogo || (norm ? `https://assets.coincap.io/assets/icons/${norm}@2x.png` : "");

  return (
    <span
      className={`coin-badge-wrap relative inline-flex items-center justify-center shrink-0 w-5 h-5 ${className}`}
      title={symbol}
    >
      {src && !hasError ? (
        <img
          className="coin-logo w-5 h-5 rounded-full object-cover shrink-0 align-middle"
          src={src}
          alt={symbol}
          width={20}
          height={20}
          loading="lazy"
          onError={() => setHasError(true)}
        />
      ) : (
        <span
          className="coin-fallback w-5 h-5 rounded-full inline-flex items-center justify-center text-[8.5px] font-bold font-mono text-slate-400 bg-gradient-to-br from-slate-800 to-slate-900 border border-slate-400/20 shrink-0 select-none tracking-tight"
          aria-hidden="true"
        >
          {initials}
        </span>
      )}
    </span>
  );
}

export default CoinBadge;
