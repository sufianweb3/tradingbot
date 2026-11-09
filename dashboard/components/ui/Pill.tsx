import React, { ReactNode } from "react";

export type PillTone = "neutral" | "pos" | "neg" | "warn" | "accent" | "sor" | "dark";
export type PillSize = "sm" | "md";

export interface PillProps {
  tone?: PillTone;
  size?: PillSize;
  dot?: boolean;
  pulse?: boolean;
  tabular?: boolean;
  children: ReactNode;
  className?: string;
}

const toneStyles: Record<PillTone, string> = {
  neutral: "bg-slate-800/80 text-slate-300 border-slate-700/60",
  pos: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  neg: "bg-rose-500/15 text-rose-400 border-rose-500/30",
  warn: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  accent: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  sor: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  dark: "bg-slate-900/90 text-slate-400 border-slate-800",
};

const dotColors: Record<PillTone, string> = {
  neutral: "bg-slate-400",
  pos: "bg-emerald-400",
  neg: "bg-rose-400",
  warn: "bg-amber-400",
  accent: "bg-sky-400",
  sor: "bg-purple-400",
  dark: "bg-slate-600",
};

export function Pill({
  tone = "neutral",
  size = "sm",
  dot = false,
  pulse = false,
  tabular = false,
  children,
  className = "",
}: PillProps) {
  const sizeClasses = size === "sm" ? "h-5 px-2 text-[10.5px]" : "h-6 px-2.5 text-[11.5px]";

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded font-mono font-medium border leading-none ${sizeClasses} ${toneStyles[tone]} ${tabular ? "tabular-nums" : ""} ${className}`}
    >
      {dot && (
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColors[tone]} ${pulse ? "animate-pulse" : ""}`}
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}

export function SideBadge({ side }: { side: "long" | "short" | "conflict" | string }) {
  const s = String(side).toLowerCase();
  if (s === "long") {
    return <Pill tone="pos" size="sm" className="font-semibold uppercase tracking-wider">LONG</Pill>;
  }
  if (s === "short") {
    return <Pill tone="neg" size="sm" className="font-semibold uppercase tracking-wider">SHORT</Pill>;
  }
  return <Pill tone="warn" size="sm" className="font-semibold uppercase tracking-wider">CONFLICT</Pill>;
}

export function EqeBadge({
  verdict,
  bps,
}: {
  verdict: "PASS" | "SCALED" | "BLOCKED" | string;
  bps?: number;
}) {
  const v = String(verdict).toUpperCase();
  const tone: PillTone = v === "PASS" ? "pos" : v === "SCALED" ? "warn" : "neg";
  const bpsText = typeof bps === "number" ? ` · ${bps.toFixed(1)} bps` : "";

  return (
    <Pill tone={tone} size="sm" tabular className="font-semibold tracking-tight">
      {v}{bpsText}
    </Pill>
  );
}

export function LiquidityBadge({
  status,
  bps,
}: {
  status: "green" | "amber" | "red" | "LIQ OK" | "LIQ THIN" | "LIQ CRITICAL" | string;
  bps?: number;
}) {
  const s = String(status).toUpperCase();
  const isOk = s.includes("OK") || s === "GREEN";
  const isThin = s.includes("THIN") || s === "AMBER";
  const tone: PillTone = isOk ? "pos" : isThin ? "warn" : "neg";
  const label = isOk ? "LIQ OK" : isThin ? "LIQ THIN" : "LIQ CRITICAL";
  const bpsText = typeof bps === "number" ? ` · ${bps.toFixed(1)} bps` : "";

  return (
    <Pill tone={tone} size="sm" tabular className="font-semibold tracking-tight">
      {label}{bpsText}
    </Pill>
  );
}

export function VenueBadge({ venue }: { venue: string }) {
  const v = String(venue || "BINANCE").toUpperCase();
  return (
    <Pill tone="neutral" size="sm" className="text-slate-200 uppercase font-semibold">
      {v}
    </Pill>
  );
}

export default Pill;
