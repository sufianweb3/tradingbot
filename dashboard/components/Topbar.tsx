"use client";

import React, { useState, useEffect } from "react";
import {
  Play,
  Pause,
  RefreshCw,
  SlidersHorizontal,
  ShieldAlert,
  AlertTriangle,
  RotateCcw,
  FileText,
  Download,
  Key,
} from "lucide-react";

export interface TopbarProps {
  mode: "paper" | "live";
  running: boolean;
  killSwitch: boolean;
  activeExchange?: string;
  coinglassLatency?: number | string;
  scanCount?: number;
  nextScanSec?: number;
  dirtyStrategy?: boolean;
  onToggleMode: (mode: "paper" | "live") => void;
  onToggleRunning: () => void;
  onTriggerScan: () => void;
  onToggleKillSwitch: () => void;
  onPanic: () => void;
  onResetPaper?: () => void;
  onToggleSettings: () => void;
  onOpenExchangeModal: () => void;
  onExportReport?: () => void;
  onExportCsv?: () => void;
}

export function Topbar({
  mode,
  running,
  killSwitch,
  activeExchange = "BYBIT",
  coinglassLatency = "42ms",
  scanCount = 12,
  nextScanSec = 15,
  dirtyStrategy = false,
  onToggleMode,
  onToggleRunning,
  onTriggerScan,
  onToggleKillSwitch,
  onPanic,
  onResetPaper,
  onToggleSettings,
  onOpenExchangeModal,
  onExportReport,
  onExportCsv,
}: TopbarProps) {
  const [clock, setClock] = useState("");

  useEffect(() => {
    const updateTime = () => {
      const d = new Date();
      setClock(d.toTimeString().slice(0, 8));
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="topbar sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 bg-[#0c1119] border-b border-[#192434] text-xs font-mono select-none">
      {/* Brand & Subtitle */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <h1 className="text-sm font-semibold tracking-wider text-slate-100 uppercase">
            OI SNIPER
          </h1>
        </div>
        <span
          id="engineSubtitle"
          className="hidden sm:inline-block text-[11px] text-slate-400 border-l border-[#192434] pl-3"
        >
          CoinGlass OI + Volume · {mode} engine
        </span>
      </div>

      {/* Mode Switch & Diagnostic Pills */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Mode Toggle */}
        <div className="flex rounded-md bg-[#070a0f] p-0.5 border border-[#192434]">
          <button
            type="button"
            id="btnModePaper"
            onClick={() => onToggleMode("paper")}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors ${
              mode === "paper"
                ? "bg-slate-800 text-slate-100 shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Paper
          </button>
          <button
            type="button"
            id="btnModeLive"
            onClick={() => onToggleMode("live")}
            className={`px-2.5 py-1 text-[11px] font-semibold rounded transition-colors ${
              mode === "live"
                ? "bg-rose-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Live
          </button>
        </div>

        {/* Exchange Pill */}
        <button
          type="button"
          id="exchangePill"
          onClick={onOpenExchangeModal}
          className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#070a0f] border border-[#192434] hover:border-slate-700 text-slate-300 transition-colors"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />
          <span>Exchange: {activeExchange.toUpperCase()}</span>
        </button>

        {/* CoinGlass Pill */}
        <div
          id="cgPill"
          className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#070a0f] border border-[#192434] text-slate-300"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span>CoinGlass: {typeof coinglassLatency === "number" ? `${coinglassLatency}ms` : coinglassLatency}</span>
        </div>

        {/* Engine Status Pill */}
        <div
          id="statusPill"
          className={`flex items-center gap-1.5 px-2 py-1 rounded border ${
            running
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
              : "bg-slate-800/80 border-slate-700/60 text-slate-400"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              running ? "bg-emerald-400 animate-pulse" : "bg-slate-500"
            }`}
          />
          <span className="font-semibold">{running ? "RUNNING" : "PAUSED"}</span>
        </div>

        {/* Kill Switch Active Pill */}
        {killSwitch && (
          <div
            id="killSwitchPill"
            className="flex items-center gap-1.5 px-2 py-1 rounded bg-rose-500/15 border border-rose-500/30 text-rose-400 animate-pulse"
          >
            <ShieldAlert size={12} />
            <span className="font-semibold">KILL SWITCH ON</span>
          </div>
        )}

        {/* Scan Timer & Clock */}
        <div className="hidden lg:flex items-center gap-3 text-slate-400 pl-2 border-l border-[#192434]">
          <span id="scanInfo" className="tabular-nums">
            Next scan: {nextScanSec}s
          </span>
          <span id="clock" className="tabular-nums font-semibold text-slate-200">
            {clock}
          </span>
        </div>
      </div>

      {/* Action Controls */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* Toggle Engine */}
        <button
          type="button"
          id="btnToggle"
          onClick={onToggleRunning}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md font-semibold transition-colors ${
            running
              ? "bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-amber-300"
              : "bg-sky-500 hover:bg-sky-400 text-slate-950"
          }`}
        >
          {running ? <Pause size={13} /> : <Play size={13} />}
          <span id="toggleText">{running ? "Pause" : "Start"}</span>
        </button>

        {/* Scan Now */}
        <button
          type="button"
          id="btnScan"
          onClick={onTriggerScan}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#111823] border border-[#192434] hover:bg-[#16202e] text-slate-200 transition-colors"
        >
          <RefreshCw size={13} />
          <span>Scan</span>
        </button>

        {/* Strategy Settings Drawer Toggle */}
        <button
          type="button"
          id="btnToggleSettings"
          onClick={onToggleSettings}
          className="relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[#111823] border border-[#192434] hover:bg-[#16202e] text-slate-200 transition-colors"
        >
          <SlidersHorizontal size={13} />
          <span>Strategy</span>
          {dirtyStrategy && (
            <span
              id="dirtyDot"
              className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-amber-400 border-2 border-[#0c1119]"
            />
          )}
        </button>

        {/* Exchange Vault Button */}
        <button
          type="button"
          id="btnExchangeConnect"
          onClick={onOpenExchangeModal}
          className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-[#111823] border border-[#192434] hover:bg-[#16202e] text-slate-400 hover:text-slate-200 transition-colors"
          title="Connect Exchange Keys"
        >
          <Key size={13} />
        </button>

        {/* Report / CSV Exports */}
        {onExportReport && (
          <button
            type="button"
            id="btnReport"
            onClick={onExportReport}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-[#111823] border border-[#192434] hover:bg-[#16202e] text-slate-400 hover:text-slate-200 transition-colors"
            title="Export HTML Performance Report"
          >
            <FileText size={13} />
          </button>
        )}
        {onExportCsv && (
          <button
            type="button"
            id="btnCsv"
            onClick={onExportCsv}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-[#111823] border border-[#192434] hover:bg-[#16202e] text-slate-400 hover:text-slate-200 transition-colors"
            title="Download Closed Trades CSV"
          >
            <Download size={13} />
          </button>
        )}

        {/* Emergency Controls */}
        <button
          type="button"
          id="btnKillSwitch"
          onClick={onToggleKillSwitch}
          className={`flex items-center gap-1 px-2 py-1.5 rounded-md border transition-colors ${
            killSwitch
              ? "bg-rose-600 text-white border-rose-500 font-semibold"
              : "bg-transparent hover:bg-rose-500/10 border-rose-500/30 text-rose-400"
          }`}
          title="Kill Switch: Halt new entries"
        >
          <ShieldAlert size={13} />
          <span>Kill</span>
        </button>

        <button
          type="button"
          id="btnPanic"
          onClick={onPanic}
          className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-rose-500/20 hover:bg-rose-500/30 border border-rose-500/40 text-rose-300 transition-colors font-semibold"
          title="Panic: Close all positions immediately"
        >
          <AlertTriangle size={13} />
          <span>Panic</span>
        </button>

        {onResetPaper && mode === "paper" && (
          <button
            type="button"
            id="btnReset"
            onClick={onResetPaper}
            className="flex items-center gap-1 px-2 py-1.5 rounded-md bg-transparent hover:bg-slate-800 border border-[#192434] text-slate-400 hover:text-slate-200 transition-colors"
            title="Reset Paper Fund"
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
    </header>
  );
}

export default Topbar;
