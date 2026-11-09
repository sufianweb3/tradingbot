"use client";

import React from "react";
import { RefreshCw } from "lucide-react";

export interface VenueHealth {
  venue: string;
  code: string;
  status: "ok" | "warn" | "err";
  latencyMs?: number;
}

export interface TelemetryData {
  p50LatencyMs?: number;
  p95LatencyMs?: number;
  scrapeAgeSec?: number;
  bookAgeMs?: number;
  loopLagMs?: number;
}

export interface TelemetryStripProps {
  telemetry?: TelemetryData;
  venues?: VenueHealth[];
  onReconcile: () => void;
  isReconciling?: boolean;
}

export function TelemetryStrip({
  telemetry = {
    p50LatencyMs: 12,
    p95LatencyMs: 28,
    scrapeAgeSec: 4.2,
    bookAgeMs: 380,
    loopLagMs: 0.8,
  },
  venues = [
    { venue: "Binance", code: "BN", status: "ok", latencyMs: 24 },
    { venue: "Bybit", code: "BY", status: "ok", latencyMs: 38 },
    { venue: "Gate", code: "GT", status: "ok", latencyMs: 46 },
    { venue: "KuCoin", code: "KC", status: "ok", latencyMs: 52 },
    { venue: "MEXC", code: "MX", status: "warn", latencyMs: 110 },
  ],
  onReconcile,
  isReconciling = false,
}: TelemetryStripProps) {
  const p50 = telemetry.p50LatencyMs ?? 12;
  const p95 = telemetry.p95LatencyMs ?? 28;
  const scrapeAge = (telemetry.scrapeAgeSec ?? 4.2).toFixed(1);
  const bookAge = telemetry.bookAgeMs ?? 380;
  const loopLag = (telemetry.loopLagMs ?? 0.8).toFixed(1);

  return (
    <section
      id="telemetryStrip"
      aria-label="System Telemetry and Venue Health"
      className="telemetry-strip flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-[#0c1119] border-b border-[#192434] text-xs font-mono select-none"
    >
      {/* FX-85: Speed Telemetry Bar */}
      <div id="speedTelemetryBar" className="flex items-center gap-3 sm:gap-4 flex-wrap">
        <div className="flex items-center gap-1.5 tel-item">
          <span className="text-slate-500 text-[10px]">PIPE LATENCY (P50/P95):</span>
          <span className="text-slate-200 font-medium tabular-nums">
            <b id="telLatencyP50">{p50}ms</b> / <b id="telLatencyP95">{p95}ms</b>
          </span>
        </div>

        <div className="flex items-center gap-1.5 tel-item">
          <span className="text-slate-500 text-[10px]">SCRAPE:</span>
          <span className="text-slate-200 font-medium tabular-nums">
            <b id="telScrapeAge">{scrapeAge}s</b>
          </span>
        </div>

        <div className="flex items-center gap-1.5 tel-item">
          <span className="text-slate-500 text-[10px]">BOOKS:</span>
          <span className="text-slate-200 font-medium tabular-nums">
            <b id="telBookAge">{bookAge}ms</b>
          </span>
        </div>

        <div className="flex items-center gap-1.5 tel-item">
          <span className="text-slate-500 text-[10px]">LOOP LAG:</span>
          <span className="text-emerald-400 font-medium tabular-nums">
            <b id="telLoopLag">{loopLag}ms</b>
          </span>
        </div>
      </div>

      {/* FX-84: Venue Health Bar & Reconcile Now */}
      <div id="venueHealthBar" className="flex items-center gap-2 sm:gap-3 flex-wrap">
        <div id="venueHealthPills" className="flex items-center gap-1.5">
          {venues.map((v) => {
            const dotColor =
              v.status === "ok"
                ? "bg-emerald-400"
                : v.status === "warn"
                ? "bg-amber-400"
                : "bg-rose-500";
            return (
              <span
                key={v.code}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#070a0f] border border-[#192434] text-[10px] text-slate-300 tabular-nums"
                title={`${v.venue}: ${v.latencyMs ?? "--"}ms`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
                <span>{v.code}</span>
              </span>
            );
          })}
        </div>

        <button
          type="button"
          id="btnReconcileNow"
          onClick={onReconcile}
          disabled={isReconciling}
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#111823] hover:bg-[#16202e] border border-[#192434] text-slate-300 hover:text-slate-100 transition-colors disabled:opacity-50 text-[11px]"
          title="Force immediate reconciliation of exchange positions & orders"
        >
          <RefreshCw size={11} className={isReconciling ? "animate-spin" : ""} />
          <span>Reconcile</span>
        </button>
      </div>
    </section>
  );
}

export default TelemetryStrip;
