"use client";

import React, { useState, useMemo, useRef } from "react";
import { EmptyState } from "./ui/EmptyState";

export interface EquityPoint {
  time: number | string;
  equity: number;
}

export interface EquityChartProps {
  series?: EquityPoint[];
  initialFund?: number;
}

export function EquityChart({
  series = [],
  initialFund = 10000,
}: EquityChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // SVG dimensions
  const width = 800;
  const height = 240;
  const padding = { top: 20, right: 30, bottom: 30, left: 60 };

  const { minVal, maxVal, points, pathD, areaD, baselineY } = useMemo(() => {
    if (!series || series.length === 0) {
      return { minVal: 0, maxVal: 1, points: [], pathD: "", areaD: "", baselineY: height / 2 };
    }

    const values = series.map((s) => s.equity);
    const min = Math.min(...values, initialFund * 0.98);
    const max = Math.max(...values, initialFund * 1.02);
    const range = max - min || 1;

    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;

    const pts = series.map((pt, i) => {
      const x = padding.left + (i / Math.max(1, series.length - 1)) * plotW;
      const y = padding.top + plotH - ((pt.equity - min) / range) * plotH;
      return { x, y, pt };
    });

    // Build cubic bezier curve
    let d = "";
    if (pts.length > 0) {
      d = `M ${pts[0].x} ${pts[0].y}`;
      for (let i = 1; i < pts.length; i++) {
        const prev = pts[i - 1];
        const curr = pts[i];
        const cpX1 = prev.x + (curr.x - prev.x) / 2;
        const cpY1 = prev.y;
        const cpX2 = prev.x + (curr.x - prev.x) / 2;
        const cpY2 = curr.y;
        d += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${curr.x} ${curr.y}`;
      }
    }

    const first = pts[0];
    const last = pts[pts.length - 1];
    const area = pts.length > 0
      ? `${d} L ${last.x} ${padding.top + plotH} L ${first.x} ${padding.top + plotH} Z`
      : "";

    const baseNormY = padding.top + plotH - ((initialFund - min) / range) * plotH;

    return {
      minVal: min,
      maxVal: max,
      points: pts,
      pathD: d,
      areaD: area,
      baselineY: baseNormY,
    };
  }, [series, initialFund]);

  const activePoint = hoverIndex !== null && points[hoverIndex] ? points[hoverIndex] : null;

  return (
    <section
      id="panelChart"
      aria-label="Account Equity Curve"
      className="panel bg-[#0c1119] border border-[#192434] rounded-lg p-4 flex flex-col font-mono select-none"
    >
      {/* Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[#192434] gap-2 flex-wrap">
        <div>
          <h2 className="text-xs font-semibold text-slate-100 tracking-wider uppercase">
            Fund PnL / Equity Curve
          </h2>
          <span id="chartSub" className="text-[11px] text-slate-400">
            Realized + mark-to-market performance relative to ${initialFund.toLocaleString()} initial fund
          </span>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 text-[11px] text-slate-400">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 bg-emerald-400 rounded-full" />
            <span className="text-slate-300">Portfolio Equity</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 border-t border-dashed border-slate-500" />
            <span>Starting Fund (${initialFund.toLocaleString()})</span>
          </div>
        </div>
      </div>

      {/* SVG Chart Container */}
      <div
        ref={containerRef}
        className="relative w-full mt-3 overflow-hidden"
        onMouseLeave={() => setHoverIndex(null)}
      >
        {points.length === 0 && (
          <EmptyState
            title="No equity history yet"
            description="The curve appears after the bot records its first closed trade."
            className="absolute inset-0 flex flex-col items-center justify-center"
          />
        )}
        <svg
          id="equityChart"
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto"
          role="img"
          aria-label="Account equity curve over time"
          onMouseMove={(e) => {
            if (!containerRef.current || points.length === 0) return;
            const rect = containerRef.current.getBoundingClientRect();
            const relX = (e.clientX - rect.left) / rect.width;
            const idx = Math.min(
              points.length - 1,
              Math.max(0, Math.round(relX * (points.length - 1)))
            );
            setHoverIndex(idx);
          }}
        >
          <defs>
            <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.22" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {[0.25, 0.5, 0.75].map((pct) => {
            const y = padding.top + (height - padding.top - padding.bottom) * pct;
            return (
              <line
                key={pct}
                x1={padding.left}
                y1={y}
                x2={width - padding.right}
                y2={y}
                stroke="#192434"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            );
          })}

          {/* Baseline Initial Fund */}
          <line
            x1={padding.left}
            y1={baselineY}
            x2={width - padding.right}
            y2={baselineY}
            stroke="#64748b"
            strokeWidth="1"
            strokeDasharray="4 4"
          />

          {/* Area under curve */}
          {areaD && <path d={areaD} fill="url(#equityGrad)" />}

          {/* Stroke curve */}
          {pathD && (
            <path
              d={pathD}
              fill="none"
              stroke="#10b981"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* Active hover crosshair and marker */}
          {activePoint && (
            <>
              <line
                x1={activePoint.x}
                y1={padding.top}
                x2={activePoint.x}
                y2={height - padding.bottom}
                stroke="#38bdf8"
                strokeWidth="1"
                strokeDasharray="2 2"
              />
              <circle
                cx={activePoint.x}
                cy={activePoint.y}
                r="4.5"
                fill="#38bdf8"
                stroke="#070a0f"
                strokeWidth="2"
              />
            </>
          )}

          {/* Y Axis scale text */}
          <text
            x={padding.left - 8}
            y={padding.top + 10}
            fill="#64748b"
            fontSize="9"
            fontFamily="monospace"
            textAnchor="end"
          >
            ${maxVal.toFixed(0)}
          </text>
          <text
            x={padding.left - 8}
            y={baselineY + 3}
            fill="#94a3b8"
            fontSize="9"
            fontFamily="monospace"
            textAnchor="end"
          >
            ${initialFund.toFixed(0)}
          </text>
          <text
            x={padding.left - 8}
            y={height - padding.bottom}
            fill="#64748b"
            fontSize="9"
            fontFamily="monospace"
            textAnchor="end"
          >
            ${minVal.toFixed(0)}
          </text>
        </svg>

        {/* Floating Tooltip */}
        {activePoint && (
          <div
            id="chartTooltip"
            className="absolute z-20 pointer-events-none p-2 rounded-lg bg-[#070a0f] border border-sky-500/40 shadow-xl text-xs"
            style={{
              left: `${(activePoint.x / width) * 100}%`,
              top: `${(activePoint.y / height) * 100}%`,
              transform: "translate(-50%, -120%)",
            }}
          >
            <div className="text-[10px] text-slate-400">{String(activePoint.pt.time)}</div>
            <div className="font-semibold text-slate-100 tabular-nums">
              ${activePoint.pt.equity.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
            <div className="text-[10px] text-emerald-400 tabular-nums">
              {activePoint.pt.equity >= initialFund ? "+" : ""}
              {(
                ((activePoint.pt.equity - initialFund) / initialFund) *
                100
              ).toFixed(2)}
              % Return
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

export default EquityChart;
