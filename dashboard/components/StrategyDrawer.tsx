"use client";

import React, { useState, useMemo } from "react";
import { X, Save, RotateCcw, Download, Upload, Copy, Key, Shield } from "lucide-react";

export interface StrategyProfileConfig {
  enabled: boolean;
  leverage: number;
  sizingMode: "allocation" | "margin" | "qty";
  allocationPercent: number;
  fixedMargin: number;
  fixedQty: number;
  slPercent: number;
  tp1Percent: number;
  tp1ClosePercent: number;
  tpMaxPercent: number;
  trailingEnabled: boolean;
  trailingStart: "tp1" | "immediate";
  trailingDistancePercent: number;
  oi5mMin: number;
  oi15mMin: number;
  oi1hMin: number;
  vol1hMin: number;
}

export interface LiveGuardrailsConfig {
  exchange: string;
  marginPerTrade: number;
  dailyLossCap: number;
  maxOpenPositions: number;
  clampLeverage: boolean;
}

export interface StrategyFullConfig {
  long: StrategyProfileConfig;
  short: StrategyProfileConfig;
  totalFund: number;
  riskMode: "roe" | "price";
  scanIntervalSec: number;
  priceRefreshMs: number;
  feePercent: number;
  slippagePercent: number;
  minOiUsd: number;
  minVolUsd24h: number;
  excludeSymbols: string;
  allowCoinglassPrice: boolean;
  reenterEnabled: boolean;
  reenterDelayMin: number;
  autoStart: boolean;
  notifications: boolean;
  live: LiveGuardrailsConfig;
}

export interface StrategyDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  config?: StrategyFullConfig;
  onSave: (config: StrategyFullConfig) => Promise<void> | void;
  onRevert?: () => void;
  onReset?: () => void;
  onExportBackup?: (includeKeys: boolean) => void;
  onImportBackup?: (jsonStr: string) => void;
  onCopyPreset?: () => void;
}

const DEFAULT_PROFILE: StrategyProfileConfig = {
  enabled: true,
  leverage: 20,
  sizingMode: "allocation",
  allocationPercent: 5,
  fixedMargin: 250,
  fixedQty: 1,
  slPercent: 20,
  tp1Percent: 40,
  tp1ClosePercent: 50,
  tpMaxPercent: 100,
  trailingEnabled: true,
  trailingStart: "tp1",
  trailingDistancePercent: 10,
  oi5mMin: 2.0,
  oi15mMin: 3.5,
  oi1hMin: 5.0,
  vol1hMin: 15.0,
};

const DEFAULT_CONFIG: StrategyFullConfig = {
  long: { ...DEFAULT_PROFILE },
  short: { ...DEFAULT_PROFILE },
  totalFund: 10000,
  riskMode: "roe",
  scanIntervalSec: 15,
  priceRefreshMs: 1000,
  feePercent: 0.05,
  slippagePercent: 0.05,
  minOiUsd: 1000000,
  minVolUsd24h: 5000000,
  excludeSymbols: "",
  allowCoinglassPrice: true,
  reenterEnabled: true,
  reenterDelayMin: 30,
  autoStart: false,
  notifications: true,
  live: {
    exchange: "bybit",
    marginPerTrade: 250,
    dailyLossCap: 500,
    maxOpenPositions: 3,
    clampLeverage: true,
  },
};

export function StrategyDrawer({
  isOpen,
  onClose,
  config,
  onSave,
  onRevert,
  onReset,
  onExportBackup,
  onImportBackup,
  onCopyPreset,
}: StrategyDrawerProps) {
  const effectiveConfig: StrategyFullConfig = useMemo(
    () =>
      config && config.long
        ? { ...DEFAULT_CONFIG, ...config, live: { ...DEFAULT_CONFIG.live, ...(config as any).live } }
        : DEFAULT_CONFIG,
    [config],
  );
  const [profileTab, setProfileTab] = useState<"long" | "short">("long");
  const [draft, setDraft] = useState<StrategyFullConfig>(effectiveConfig);
  const [isDirty, setIsDirty] = useState(false);
  const [exportKeys, setExportKeys] = useState(false);
  const [cgApiKeyInput, setCgApiKeyInput] = useState("");
  const [activeVenues, setActiveVenues] = useState<Record<string, boolean>>({
    binance: true,
    bybit: true,
    gate: true,
    kucoin: true,
    mexc: true,
  });

  const activeProfile = draft?.[profileTab] || DEFAULT_PROFILE;

  const updateProfile = (key: keyof StrategyProfileConfig, val: any) => {
    setDraft((prev) => ({
      ...prev,
      [profileTab]: {
        ...prev[profileTab],
        [key]: val,
      },
    }));
    setIsDirty(true);
  };

  const updateGlobal = (key: keyof StrategyFullConfig, val: any) => {
    setDraft((prev) => ({
      ...prev,
      [key]: val,
    }));
    setIsDirty(true);
  };

  const updateLive = (key: keyof LiveGuardrailsConfig, val: any) => {
    setDraft((prev) => ({
      ...prev,
      live: {
        ...prev.live,
        [key]: val,
      },
    }));
    setIsDirty(true);
  };

  // FX-90 Live Execution Cost Preview Calculations
  const costPreview = useMemo(() => {
    const feeBps = draft.feePercent * 100 * 2; // round-trip fees in bps
    const slipBps = draft.slippagePercent * 100 * 2; // round-trip slippage in bps
    const roundTripBps = feeBps + slipBps + 4.0; // total round trip basis points
    const minMovePct = roundTripBps / 100;
    const targetMovePct = (activeProfile.tp1Percent / activeProfile.leverage) || 2.0;
    const edgeMultiple = targetMovePct > 0 ? (targetMovePct / minMovePct) : 1.0;
    const isEdgeOk = edgeMultiple >= 3.0;

    return {
      roundTripBps,
      minMovePct,
      edgeMultiple,
      haircutPct: 35,
      isEdgeOk,
    };
  }, [draft.feePercent, draft.slippagePercent, activeProfile.tp1Percent, activeProfile.leverage]);

  if (!isOpen) return null;

  return (
    <aside
      className="panel settings-panel fixed top-0 right-0 bottom-0 z-50 w-full sm:w-[480px] bg-[#0c1119] border-l border-[#192434] shadow-2xl flex flex-col font-mono select-none"
      role="complementary"
      aria-label="Strategy Configuration"
    >
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-[#192434]">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-slate-100 tracking-wider uppercase">
            Strategy Configuration
          </h2>
          {isDirty && (
            <span
              id="dirtyBadge"
              className="flex items-center gap-1 px-1.5 py-0.2 text-[9px] font-semibold rounded bg-amber-500/20 text-amber-300 border border-amber-500/30"
            >
              <span id="dirtyDot" className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              unsaved
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            id="btnCloseSettings"
            onClick={onClose}
            className="w-7 h-7 rounded flex items-center justify-center text-slate-400 hover:text-slate-100 hover:bg-[#111823] transition-colors"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Dual Profile Tabs */}
      <div id="profileTabs" className="px-4 pt-3 pb-2 border-b border-[#192434] flex items-center justify-between gap-2">
        <div className="flex rounded-md bg-[#070a0f] p-0.5 border border-[#192434]">
          <button
            type="button"
            onClick={() => setProfileTab("long")}
            className={`tab flex items-center gap-1.5 px-3 py-1 text-xs rounded transition-colors ${
              profileTab === "long"
                ? "bg-emerald-500/20 text-emerald-300 font-semibold"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <span className="side-dot long w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span>Long Profile</span>
          </button>
          <button
            type="button"
            onClick={() => setProfileTab("short")}
            className={`tab flex items-center gap-1.5 px-3 py-1 text-xs rounded transition-colors ${
              profileTab === "short"
                ? "bg-rose-500/20 text-rose-300 font-semibold"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <span className="side-dot short w-1.5 h-1.5 rounded-full bg-rose-400" />
            <span>Short Profile</span>
          </button>
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            id="profileEnabled"
            checked={activeProfile.enabled}
            onChange={(e) => updateProfile("enabled", e.target.checked)}
            className="rounded border-[#192434] bg-[#070a0f] text-sky-500 focus:ring-0"
          />
          <span id="profileEnabledLabel" className="text-xs text-slate-300">
            {activeProfile.enabled ? "Active" : "Disabled"}
          </span>
        </label>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5 text-xs">
        {/* Profile Sizing & Leverage */}
        <div className="space-y-3">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold block">
            Position Sizing & Leverage ({profileTab.toUpperCase()})
          </span>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">Leverage (1x - 125x)</label>
              <input
                type="number"
                min={1}
                max={125}
                value={activeProfile.leverage}
                onChange={(e) => updateProfile("leverage", Math.min(125, Math.max(1, Number(e.target.value))))}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums focus:outline-none focus:border-sky-500"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">Sizing Mode</label>
              <select
                value={activeProfile.sizingMode}
                onChange={(e) => updateProfile("sizingMode", e.target.value as any)}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 focus:outline-none focus:border-sky-500"
              >
                <option value="allocation">% of Total Fund</option>
                <option value="margin">Fixed Margin ($)</option>
                <option value="qty">Fixed Quantity</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-slate-400 mb-1 text-[11px]">
              {activeProfile.sizingMode === "allocation"
                ? "Per Trade Fund Allocation (%)"
                : activeProfile.sizingMode === "margin"
                ? "Per Trade Margin (USDT)"
                : "Quantity Per Trade"}
            </label>
            <input
              type="number"
              step={0.1}
              value={
                activeProfile.sizingMode === "allocation"
                  ? activeProfile.allocationPercent
                  : activeProfile.sizingMode === "margin"
                  ? activeProfile.fixedMargin
                  : activeProfile.fixedQty
              }
              onChange={(e) => {
                const val = Number(e.target.value);
                if (activeProfile.sizingMode === "allocation") updateProfile("allocationPercent", val);
                else if (activeProfile.sizingMode === "margin") updateProfile("fixedMargin", val);
                else updateProfile("fixedQty", val);
              }}
              className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums focus:outline-none focus:border-sky-500"
            />
            <p id="sizingNote" className="text-[10px] text-slate-500 mt-1">
              Estimated margin per trade: $
              {(
                (draft.totalFund * (activeProfile.allocationPercent || 5)) /
                100
              ).toFixed(2)}
            </p>
          </div>
        </div>

        {/* Profile Exits & Stops */}
        <div className="space-y-3 pt-3 border-t border-[#192434]">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold block">
            Exits & Stop Loss Rules
          </span>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">Stop Loss % (ROE)</label>
              <input
                type="number"
                step={0.5}
                value={activeProfile.slPercent}
                onChange={(e) => updateProfile("slPercent", Number(e.target.value))}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums focus:outline-none focus:border-sky-500"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">Take Profit 1 % (ROE)</label>
              <input
                type="number"
                step={0.5}
                value={activeProfile.tp1Percent}
                onChange={(e) => updateProfile("tp1Percent", Number(e.target.value))}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">TP1 Close %</label>
              <input
                type="number"
                value={activeProfile.tp1ClosePercent}
                onChange={(e) => updateProfile("tp1ClosePercent", Number(e.target.value))}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums focus:outline-none focus:border-sky-500"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">Max Take Profit %</label>
              <input
                type="number"
                value={activeProfile.tpMaxPercent}
                onChange={(e) => updateProfile("tpMaxPercent", Number(e.target.value))}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums focus:outline-none focus:border-sky-500"
              />
            </div>
          </div>

          {/* Trailing Stop */}
          <div className="p-3 rounded bg-[#070a0f] border border-[#192434] space-y-2">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-slate-300 font-medium">Trailing Stop Mechanism</span>
              <input
                type="checkbox"
                checked={activeProfile.trailingEnabled}
                onChange={(e) => updateProfile("trailingEnabled", e.target.checked)}
                className="rounded border-[#192434] bg-[#0c1119] text-sky-500 focus:ring-0"
              />
            </label>
            {activeProfile.trailingEnabled && (
              <div className="grid grid-cols-2 gap-2 pt-1 text-[11px]">
                <div>
                  <span className="text-slate-400 block mb-0.5">Start After</span>
                  <select
                    value={activeProfile.trailingStart}
                    onChange={(e) => updateProfile("trailingStart", e.target.value as any)}
                    className="w-full p-1 bg-[#0c1119] border border-[#192434] rounded text-slate-200"
                  >
                    <option value="tp1">After TP1 Fill</option>
                    <option value="immediate">Immediate on Fill</option>
                  </select>
                </div>
                <div>
                  <span className="text-slate-400 block mb-0.5">Trail Distance %</span>
                  <input
                    type="number"
                    value={activeProfile.trailingDistancePercent}
                    onChange={(e) => updateProfile("trailingDistancePercent", Number(e.target.value))}
                    className="w-full p-1 bg-[#0c1119] border border-[#192434] rounded text-slate-200 tabular-nums"
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* FX-90: Live Execution Cost Preview */}
        <div id="execCostPreview" className="p-3 rounded-lg bg-[#070a0f] border border-sky-500/30 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase font-bold text-sky-400 tracking-wider">
              Live Execution Cost Preview (FX-90)
            </span>
            <span
              id="ecpEdgeBadge"
              className={`px-1.5 py-0.2 text-[9px] font-semibold rounded ${
                costPreview.isEdgeOk
                  ? "bg-emerald-500/20 text-emerald-400"
                  : "bg-amber-500/20 text-amber-400"
              }`}
            >
              {costPreview.isEdgeOk ? "Edge OK" : "Edge Caution"}
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-[11px]">
            <div className="flex flex-col">
              <span className="text-[9px] text-slate-500 uppercase">Est. Round-Trip</span>
              <span id="ecpRoundTripBps" className="font-semibold text-slate-200 tabular-nums">
                {costPreview.roundTripBps.toFixed(1)} bps
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] text-slate-500 uppercase">Min Breakeven Move</span>
              <span id="ecpMinMovePct" className="font-semibold text-slate-200 tabular-nums">
                {costPreview.minMovePct.toFixed(2)}%
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] text-slate-500 uppercase">Net Edge Multiple</span>
              <span id="ecpEdgeMultiple" className="font-semibold text-emerald-400 tabular-nums">
                {costPreview.edgeMultiple.toFixed(1)}x
              </span>
            </div>
            <div className="flex flex-col">
              <span className="text-[9px] text-slate-500 uppercase">Sim Haircut</span>
              <span id="ecpHaircutPct" className="font-semibold text-slate-400 tabular-nums">
                {costPreview.haircutPct}%
              </span>
            </div>
          </div>
        </div>

        {/* Signal Filters */}
        <div className="space-y-3 pt-3 border-t border-[#192434]">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold block">
            Signal Surge Filters ({profileTab.toUpperCase()})
          </span>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">Min OI 5m Surge (%)</label>
              <input
                type="number"
                step={0.1}
                value={activeProfile.oi5mMin}
                onChange={(e) => updateProfile("oi5mMin", Number(e.target.value))}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">Min OI 15m Surge (%)</label>
              <input
                type="number"
                step={0.1}
                value={activeProfile.oi15mMin}
                onChange={(e) => updateProfile("oi15mMin", Number(e.target.value))}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">Min OI 1h Surge (%)</label>
              <input
                type="number"
                step={0.1}
                value={activeProfile.oi1hMin}
                onChange={(e) => updateProfile("oi1hMin", Number(e.target.value))}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">Min Vol 1h Surge (%)</label>
              <input
                type="number"
                step={0.5}
                value={activeProfile.vol1hMin}
                onChange={(e) => updateProfile("vol1hMin", Number(e.target.value))}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums"
              />
            </div>
          </div>
        </div>

        {/* Global Capital & CoinGlass API Key */}
        <div className="space-y-3 pt-3 border-t border-[#192434]">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold block">
            Capital & Data Sources
          </span>
          <div>
            <label className="block text-slate-400 mb-1 text-[11px]">Total Starting Fund (USDT)</label>
            <input
              type="number"
              value={draft.totalFund}
              onChange={(e) => updateGlobal("totalFund", Number(e.target.value))}
              className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums"
            />
          </div>

          <div className="p-3 rounded bg-[#070a0f] border border-[#192434] space-y-2">
            <span className="text-slate-300 font-medium block">CoinGlass API Key</span>
            <div className="flex gap-2">
              <input
                type="password"
                id="cgApiKey"
                value={cgApiKeyInput}
                onChange={(e) => setCgApiKeyInput(e.target.value)}
                placeholder="Enter key to enable official API..."
                className="flex-1 px-2.5 py-1 text-xs bg-[#0c1119] border border-[#192434] rounded text-slate-100 focus:outline-none"
              />
              <button
                type="button"
                id="btnSaveCgKey"
                onClick={() => {
                  try {
                    localStorage.setItem("oi_cg_key", cgApiKeyInput);
                  } catch {}
                  setIsDirty(true);
                }}
                className="px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs"
              >
                Save
              </button>
              <button
                type="button"
                id="btnClearCgKey"
                onClick={() => {
                  setCgApiKeyInput("");
                  try {
                    localStorage.removeItem("oi_cg_key");
                  } catch {}
                }}
                className="px-2 py-1 rounded text-rose-400 hover:bg-rose-500/10 text-xs"
              >
                Clear
              </button>
            </div>
            <span id="cgKeyState" className="text-[10px] text-slate-500 block">
              {cgApiKeyInput ? "Key configured · official endpoint active" : "Using fallback web scraping"}
            </span>
          </div>
        </div>

        {/* Universe & Symbol Exclusions */}
        <div className="space-y-3 pt-3 border-t border-[#192434]">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold block">
            Universe Exclusions & Thresholds
          </span>
          <div>
            <label className="block text-slate-400 mb-1 text-[11px]">Excluded Symbols (comma-separated)</label>
            <input
              type="text"
              value={draft.excludeSymbols}
              onChange={(e) => updateGlobal("excludeSymbols", e.target.value)}
              placeholder="e.g. LUNA, FTT, DOGE"
              className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100"
            />
          </div>

          <div id="venueToggles" className="flex items-center gap-2 flex-wrap pt-1">
            <span className="text-slate-400 text-[11px] block w-full">Supported Venues:</span>
            {["binance", "bybit", "gate", "kucoin", "mexc"].map((v) => (
              <label key={v} className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#070a0f] border border-[#192434] cursor-pointer text-[10px] uppercase text-slate-300">
                <input
                  type="checkbox"
                  checked={activeVenues[v]}
                  onChange={(e) => setActiveVenues((prev) => ({ ...prev, [v]: e.target.checked }))}
                  className="rounded border-[#192434] bg-[#0c1119] text-sky-500 focus:ring-0"
                />
                <span>{v}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Live Execution Guardrails (FX-61) */}
        <div id="liveSettingsGroup" className="space-y-3 pt-3 border-t border-[#192434]">
          <span className="text-[10px] uppercase tracking-wider text-rose-400 font-bold block flex items-center gap-1.5">
            <Shield size={12} />
            Live Guardrails & Risk Caps
          </span>
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">Max Margin / Trade ($)</label>
              <input
                type="number"
                value={draft.live.marginPerTrade}
                onChange={(e) => updateLive("marginPerTrade", Number(e.target.value))}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 text-[11px]">Daily Loss Cap ($)</label>
              <input
                type="number"
                value={draft.live.dailyLossCap}
                onChange={(e) => updateLive("dailyLossCap", Number(e.target.value))}
                className="w-full px-2.5 py-1.5 bg-[#070a0f] border border-[#192434] rounded text-slate-100 tabular-nums"
              />
            </div>
          </div>
        </div>

        {/* State Backup & Preset Sharing */}
        <div className="space-y-2 pt-3 border-t border-[#192434]">
          <span className="text-[10px] uppercase tracking-wider text-slate-500 font-bold block">
            State Backup & Preset Sharing
          </span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-400 cursor-pointer">
              <input
                type="checkbox"
                id="chkExportApiKeys"
                checked={exportKeys}
                onChange={(e) => setExportKeys(e.target.checked)}
                className="rounded border-[#192434] bg-[#070a0f] text-sky-500 focus:ring-0"
              />
              <span>Include API keys in export</span>
            </label>
          </div>
          <div className="flex items-center gap-2 flex-wrap pt-1">
            {onExportBackup && (
              <button
                type="button"
                id="btnExportBackup"
                onClick={() => onExportBackup(exportKeys)}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#111823] hover:bg-[#16202e] border border-[#192434] text-slate-300 text-xs"
              >
                <Download size={11} />
                <span>Export Backup</span>
              </button>
            )}
            {onCopyPreset && (
              <button
                type="button"
                id="btnCopyPreset"
                onClick={onCopyPreset}
                className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#111823] hover:bg-[#16202e] border border-[#192434] text-slate-300 text-xs"
              >
                <Copy size={11} />
                <span>Copy URL Hash</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Sticky Action Footer */}
      <div className="p-4 border-t border-[#192434] bg-[#070a0f] flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {onReset && (
            <button
              type="button"
              id="btnReset2"
              onClick={() => {
                setDraft(DEFAULT_CONFIG);
                setIsDirty(true);
                onReset();
              }}
              className="px-2.5 py-1.5 rounded bg-transparent hover:bg-slate-800 text-slate-400 hover:text-slate-200 text-xs"
              title="Reset to factory defaults"
            >
              Reset
            </button>
          )}
          {onRevert && (
            <button
              type="button"
              id="btnRevert"
              disabled={!isDirty}
              onClick={() => {
                setDraft(effectiveConfig);
                setIsDirty(false);
                onRevert();
              }}
              className="px-2.5 py-1.5 rounded bg-[#111823] hover:bg-[#16202e] border border-[#192434] text-slate-300 text-xs disabled:opacity-40"
            >
              Revert
            </button>
          )}
        </div>

        <button
          type="button"
          id="btnSave"
          onClick={async () => {
            await onSave(draft);
            setIsDirty(false);
          }}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs transition-colors shadow-sm"
        >
          <Save size={13} />
          <span>Save & Apply</span>
        </button>
      </div>
    </aside>
  );
}

export default StrategyDrawer;
