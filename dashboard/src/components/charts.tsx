import { useId, useMemo, useState } from "react";
import type { EquityPoint } from "../lib/data";
import {
  cn,
  compactUsd,
  pct,
  shortDate,
  usd,
} from "../lib/format";

function smoothPath(points: Array<{ x: number; y: number }>) {
  if (points.length === 0) return "";
  return points.reduce((acc, point, index, all) => {
    if (index === 0) return `M ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
    const previous = all[index - 1];
    const control = (previous.x + point.x) / 2;
    return `${acc} C ${control.toFixed(2)} ${previous.y.toFixed(2)}, ${control.toFixed(2)} ${point.y.toFixed(2)}, ${point.x.toFixed(2)} ${point.y.toFixed(2)}`;
  }, "");
}

export function Sparkline({
  data,
  tone = "auto",
  className,
  fluid = false,
}: {
  data: number[];
  tone?: "auto" | "pos" | "neg" | "muted" | "accent";
  className?: string;
  fluid?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const safe = data.length > 1 ? data : [1, 1];
  const min = Math.min(...safe);
  const max = Math.max(...safe);
  const range = max - min || 1;
  const points = safe.map((value, index) => ({
    x: (index / (safe.length - 1)) * 120,
    y: 34 - ((value - min) / range) * 28 - 3,
  }));
  const line = smoothPath(points);
  const area = `${line} L 120 36 L 0 36 Z`;
  const direction =
    tone === "auto"
      ? safe[safe.length - 1] >= safe[0]
        ? "pos"
        : "neg"
      : tone;

  return (
    <svg
      viewBox="0 0 120 36"
      preserveAspectRatio="none"
      className={cn(
        fluid ? "h-10 w-full" : "h-8 w-[104px]",
        "overflow-visible",
        direction === "pos" && "text-pos",
        direction === "neg" && "text-neg",
        direction === "muted" && "text-faint",
        direction === "accent" && "text-accent",
        className,
      )}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`spark-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.14" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${id})`} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function EquityChart({
  data,
  height = 232,
  className,
}: {
  data: EquityPoint[];
  height?: number;
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const safe = data.length > 1 ? data : [{ at: new Date(), value: 0 }, { at: new Date(), value: 0 }];
  const values = safe.map((point) => point.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = (rawMax - rawMin) * 0.16 || rawMax * 0.01 || 1;
  const min = rawMin - padding;
  const max = rawMax + padding;
  const range = max - min || 1;

  const points = safe.map((point, index) => ({
    x: (index / (safe.length - 1)) * 1000,
    y: height - ((point.value - min) / range) * height,
  }));
  const line = smoothPath(points);
  const area = `${line} L 1000 ${height} L 0 ${height} Z`;
  const labels = [max, max - range * 0.25, max - range * 0.5, max - range * 0.75, min];
  const xIndexes = [0, Math.floor((safe.length - 1) / 3), Math.floor(((safe.length - 1) * 2) / 3), safe.length - 1];

  const active = hover === null ? null : safe[hover];
  const activeX = hover === null ? 0 : (hover / (safe.length - 1)) * 100;
  const activeY = active === null ? 0 : ((max - active.value) / range) * 100;
  const delta = active === null ? 0 : ((active.value - safe[0].value) / safe[0].value) * 100;

  return (
    <div className={cn("select-none", className)}>
      <div className="flex gap-3">
        <div
          className="num flex w-10 shrink-0 flex-col justify-between pb-0 text-right text-[9.5px] leading-none text-faint"
          style={{ height }}
          aria-hidden="true"
        >
          {labels.map((label, index) => (
            <span key={index}>{compactUsd(label)}</span>
          ))}
        </div>
        <div
          className="relative min-w-0 flex-1 touch-none"
          style={{ height }}
          onPointerMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
            setHover(Math.round(ratio * (safe.length - 1)));
          }}
          onPointerLeave={() => setHover(null)}
        >
          <svg
            viewBox={`0 0 1000 ${height}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
            role="img"
            aria-label={`Equity curve from ${usd(safe[0].value)} to ${usd(safe[safe.length - 1].value)}`}
          >
            <defs>
              <linearGradient id={`equity-${id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
                <stop offset="72%" stopColor="var(--accent)" stopOpacity="0.035" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
              </linearGradient>
            </defs>
            {[0, 0.25, 0.5, 0.75, 1].map((step) => (
              <line
                key={step}
                x1="0"
                x2="1000"
                y1={step * height}
                y2={step * height}
                stroke="var(--grid)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            <path d={area} fill={`url(#equity-${id})`} />
            <path
              d={line}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {hover !== null && active ? (
            <>
              <div
                className="pointer-events-none absolute inset-y-0 w-px bg-line-strong"
                style={{ left: `${activeX}%` }}
              />
              <div
                className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-surface bg-accent shadow-[0_0_0_1px_var(--accent)]"
                style={{ left: `${activeX}%`, top: `${activeY}%` }}
              />
              <div
                className={cn(
                  "pointer-events-none absolute top-1 z-10 w-[148px] rounded-xl border border-line bg-surface p-3 shadow-float",
                  activeX > 68 ? "-translate-x-[calc(100%+10px)]" : "translate-x-[10px]",
                )}
                style={{ left: `${activeX}%` }}
              >
                <p className="text-[10px] text-muted">{shortDate(active.at)}</p>
                <p className="num mt-1 text-[14px] font-semibold tracking-[-0.01em] text-ink">
                  {usd(active.value)}
                </p>
                <p className={cn("num mt-0.5 text-[10.5px] font-medium", delta >= 0 ? "text-pos" : "text-neg")}>
                  {pct(delta)} since start
                </p>
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div className="mt-2.5 flex justify-between pl-[52px] text-[9.5px] text-faint">
        {xIndexes.map((index, position) => (
          <span key={position} className={cn(position === 0 && "-translate-x-1", position === 3 && "translate-x-1")}>
            {shortDate(safe[index].at)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function DrawdownChart({
  data,
  height = 108,
  className,
}: {
  data: Array<{ at: Date; value: number }>;
  height?: number;
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  const safe = data.length > 1 ? data : [{ at: new Date(), value: 0 }, { at: new Date(), value: 0 }];
  const min = Math.min(...safe.map((point) => point.value), -0.2);
  const points = safe.map((point, index) => ({
    x: (index / (safe.length - 1)) * 1000,
    y: (Math.abs(point.value) / Math.abs(min)) * height,
  }));
  const line = smoothPath(points);
  const area = `${line} L 1000 0 L 0 0 Z`;
  const last = safe[safe.length - 1].value;

  return (
    <div className={className}>
      <div className="relative" style={{ height }}>
        <svg
          viewBox={`0 0 1000 ${height}`}
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
          role="img"
          aria-label={`Drawdown chart, current ${pct(last)}`}
        >
          <defs>
            <linearGradient id={`dd-${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--neg)" stopOpacity="0.02" />
              <stop offset="100%" stopColor="var(--neg)" stopOpacity="0.16" />
            </linearGradient>
          </defs>
          <line
            x1="0"
            x2="1000"
            y1="0.5"
            y2="0.5"
            stroke="var(--grid)"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
          <path d={area} fill={`url(#dd-${id})`} />
          <path
            d={line}
            fill="none"
            stroke="var(--neg)"
            strokeWidth="1.6"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <div className="mt-1 flex items-center justify-between text-[9.5px] text-faint">
        <span>0%</span>
        <span className="num text-neg">{pct(min)}</span>
      </div>
    </div>
  );
}

export function DivergingBar({
  value,
  max,
  tone = "accent",
  className,
}: {
  value: number;
  max: number;
  tone?: "accent" | "muted";
  className?: string;
}) {
  const width = Math.min(50, (Math.abs(value) / Math.max(max, 1)) * 50);
  return (
    <span className={cn("relative block h-[3px] w-full overflow-hidden rounded-full bg-surface-3", className)}>
      <span className="absolute inset-y-0 left-1/2 w-px bg-line-strong" />
      <span
        className={cn(
          "absolute inset-y-0 rounded-full",
          tone === "accent" ? "bg-accent" : "bg-faint",
        )}
        style={{
          left: value >= 0 ? "50%" : `${50 - width}%`,
          width: `${width}%`,
        }}
      />
    </span>
  );
}

export function Meter({
  value,
  max = 100,
  className,
}: {
  value: number;
  max?: number;
  className?: string;
}) {
  const ratio = Math.min(1, Math.max(0, value / max));
  return (
    <span className={cn("relative block h-1 w-full overflow-hidden rounded-full bg-surface-3", className)}>
      <span className="block h-full rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}

export function WeeklyReturns({
  data,
}: {
  data: Array<{ label: string; value: number }>;
}) {
  const max = useMemo(
    () => Math.max(...data.map((entry) => Math.abs(entry.value)), 0.2),
    [data],
  );
  return (
    <div className="space-y-2.5">
      {data.map((entry) => (
        <div key={entry.label} className="grid grid-cols-[46px_minmax(0,1fr)_52px] items-center gap-3">
          <span className="text-[10.5px] text-muted">{entry.label}</span>
          <span className="relative block h-2 rounded-full bg-surface-2">
            <span className="absolute inset-y-0 left-1/2 w-px bg-line" />
            <span
              className={cn(
                "absolute inset-y-0 rounded-full",
                entry.value >= 0 ? "bg-accent" : "bg-neg",
              )}
              style={{
                left: entry.value >= 0 ? "50%" : `${50 - (Math.abs(entry.value) / max) * 50}%`,
                width: `${(Math.abs(entry.value) / max) * 50}%`,
              }}
            />
          </span>
          <span
            className={cn(
              "num text-right text-[10.5px] font-medium",
              entry.value >= 0 ? "text-pos" : "text-neg",
            )}
          >
            {pct(entry.value, 1)}
          </span>
        </div>
      ))}
    </div>
  );
}
