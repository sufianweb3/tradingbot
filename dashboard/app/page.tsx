"use client";

import React, { useState, useCallback, useMemo } from "react";
import { AppProvider, useApp } from "../store/AppStore";
import { ErrorState, Skeleton, SkeletonCard, SkeletonLine } from "../components/ui";
import { Topbar } from "../components/Topbar";
import { TelemetryStrip } from "../components/TelemetryStrip";
import { KpiStrip } from "../components/KpiStrip";
import { PositionsPanel } from "../components/PositionsPanel";
import { ScannerTable, ScannerCoin } from "../components/ScannerTable";
import { CoinGlassFeed } from "../components/CoinGlassFeed";
import { EquityChart } from "../components/EquityChart";
import { TradesAndLogs } from "../components/TradesAndLogs";
import { StrategyDrawer, StrategyFullConfig } from "../components/StrategyDrawer";
import {
  InspectorModal,
  ExchangeModal,
  LiveConfirmModal,
  OnboardingModal,
  AuthModal,
  CoinInspectorData,
} from "../components/modals";
import { positionMetrics } from "../lib/metrics";
import { buildHtmlReport, buildTradesCsv } from "../lib/report";
import { downloadFile } from "../lib/download";

function WorkstationContent() {
  const {
    running,
    toggleRunning,
    scanNow,
    mode,
    setMode,
    killSwitch,
    setKillSwitch,
    panicAll,
    resetSample,
    dataSource,
    apiError,
    reconcile,
    positions,
    coins,
    trades,
    activity,
    closePosition,
    closeAll,
    equity,
    realised,
    openPnlValue,
    initialFund,
    stats,
    series,
    drawdown,
    telemetry,
    exchanges,
    activeExchange,
    setActiveExchange,
    connectExchange,
    disconnectExchange,
    settings,
    saveSettings,
    liveGuardrails,
    saveLiveGuardrails,
    openLiveConfirm,
    closeLiveConfirm,
    liveConfirmOpen,
    activateLive,
    clearActivity,
    exportBackup,
    importBackup,
    notify,
  } = useApp();

  // Local UI state
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isExchangeModalOpen, setIsExchangeModalOpen] = useState(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const [inspectedCoin, setInspectedCoin] = useState<CoinInspectorData | null>(null);
  const [workspaceTab, setWorkspaceTab] = useState<
    "all" | "positions" | "scanner" | "chart" | "trades"
  >("all");

  // Adapt positions for PositionsPanel
  const adaptedPositions = useMemo(() => {
    return positions.map((p) => {
      const metrics = positionMetrics(p);
      return {
        id: String(p.id),
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entry,
        markPrice: p.mark,
        margin: p.margin,
        notional: metrics.notional,
        leverage: p.leverage,
        pnl: metrics.pnl,
        roe: metrics.roe,
        venue: p.venue || activeExchange?.name || "Bybit",
        routeBps: p.routeBps ?? 4.8,
        stopLoss: p.stop,
        takeProfit1: p.tp1,
        exitLiquidity: p.exitLiquidity || "OK",
        exitImpactBps: 2.1,
        lifecycleStep: 5,
      };
    });
  }, [positions, activeExchange]);

  // Adapt coins for ScannerTable
  const adaptedScannerCoins: ScannerCoin[] = useMemo(() => {
    return coins.map((c) => ({
      symbol: c.symbol,
      price: c.price,
      score: c.score,
      status: c.status === "qualified" ? "qualified" : c.status === "near" ? "near" : "all",
      direction: c.direction as any,
      oi5m: c.oi5m,
      oi15m: c.oi15m,
      oi30m: (c as any).oi30m ?? Number((c.oi15m * 1.15).toFixed(2)),
      oi1h: c.oi1h,
      oi4h: c.oi4h,
      vol1h: c.vol1h,
      vol4h: c.vol4h,
      routeVenue: c.venues?.[0] || activeExchange?.name || "Bybit",
      routeBps: 4.8,
      eqeVerdict: c.score >= 85 ? "PASS" : c.score >= 66 ? "SCALED" : "BLOCKED",
      venues: c.venues || ["Binance", "Bybit", "Gate", "KuCoin"],
    }));
  }, [coins, activeExchange]);

  // Adapt coins for CoinGlassFeed
  const adaptedFeedCoins = useMemo(() => {
    return coins.map((c) => ({
      symbol: c.symbol,
      oi5m: c.oi5m,
      vol1h: c.vol1h,
    }));
  }, [coins]);

  // Adapt trades for TradesAndLogs
  const adaptedTrades = useMemo(() => {
    return trades.map((t) => ({
      id: String(t.id),
      symbol: t.symbol,
      side: t.side,
      entryPrice: t.entry,
      exitPrice: t.exit,
      qty: (t.margin * (t.leverage || 10)) / (t.entry || 1),
      margin: t.margin,
      pnl: t.pnl,
      roe: t.roe,
      fee: t.fees,
      reason: t.reason,
      closedAt: t.closedAt instanceof Date ? t.closedAt.toISOString().slice(11, 19) : String(t.closedAt),
      holdTime: "4m 12s",
      venue: activeExchange?.name || "Bybit",
    }));
  }, [trades, activeExchange]);

  // Adapt series for EquityChart
  const adaptedSeries = useMemo(() => {
    return series.map((s) => ({
      time: typeof s.at === "number" ? new Date(s.at).toTimeString().slice(0, 5) : String(s.at),
      equity: s.value,
    }));
  }, [series]);

  // Adapt exchanges for ExchangeModal
  const adaptedExchanges = useMemo(() => {
    return exchanges.map((ex) => ({
      id: ex.id,
      name: ex.name,
      tier: ex.tier,
      connected: ex.connected,
      isActive: ex.id === activeExchange?.id,
      maskedKey: ex.maskedKey,
      liveSupported: ex.liveSupported,
    }));
  }, [exchanges, activeExchange]);

  // Handlers
  const handleToggleMode = useCallback(
    (targetMode: "paper" | "live") => {
      if (targetMode === "live") {
        openLiveConfirm();
      } else {
        setMode("paper");
        notify("Switched to Paper Mode");
      }
    },
    [openLiveConfirm, setMode, notify]
  );

  const handleInspect = useCallback((coin: ScannerCoin) => {
    setInspectedCoin({
      symbol: coin.symbol,
      price: coin.price,
      score: coin.score,
      direction: coin.direction === "conflict" ? "long" : coin.direction,
      venues: coin.venues || ["Binance", "Bybit", "Gate", "KuCoin"],
      status: coin.status,
    });
  }, []);

  const handleExportReport = useCallback(() => {
    const html = buildHtmlReport({
      equity,
      startFund: initialFund,
      stats,
      positions,
      trades,
      series,
      mode,
      exchange: activeExchange?.name || "Bybit",
      drawdown,
    });
    downloadFile(`oi-sniper-report-${new Date().toISOString().slice(0, 10)}.html`, html, "text/html");
    notify("HTML Report Exported", "Report downloaded successfully");
  }, [equity, initialFund, stats, positions, trades, series, mode, activeExchange, drawdown, notify]);

  const handleExportCsv = useCallback(() => {
    const csv = buildTradesCsv(trades);
    downloadFile(`oi-sniper-trades-${new Date().toISOString().slice(0, 10)}.csv`, csv, "text/csv");
    notify("Trade History Exported", "CSV downloaded successfully");
  }, [trades, notify]);

  const handleSaveStrategy = useCallback(
    async (fullConfig: StrategyFullConfig) => {
      await saveSettings(fullConfig as any);
      await saveLiveGuardrails(fullConfig.live);
      notify("Strategy Saved", "Updated profile and guardrails applied");
    },
    [saveSettings, saveLiveGuardrails, notify]
  );

  const handleCopyPreset = useCallback(() => {
    if (typeof window !== "undefined") {
      const hash = `#preset=balanced&lev=${(settings?.long as any)?.leverage ?? 20}`;
      navigator.clipboard?.writeText(window.location.origin + window.location.pathname + hash);
      notify("Preset Link Copied", "Shareable URL copied to clipboard");
    }
  }, [settings, notify]);

  if (dataSource === "loading") return <WorkstationSkeleton />;

  if (dataSource === "offline") {
    const unauthorized = /unauthor|401/i.test(apiError ?? "");
    return (
      <div className="mx-auto max-w-xl p-6">
        <ErrorState
          title={unauthorized ? "Admin token rejected" : "Bot API unreachable"}
          description={
            unauthorized
              ? "The backend refused the admin token. Clear it and enter the correct ADMIN_SECRET."
              : `${apiError ?? "The backend did not respond."} Check that the backend is running and NEXT_PUBLIC_API_BASE is correct.`
          }
          action={{
            label: unauthorized ? "Clear token and reload" : "Retry",
            onClick: () => {
              if (unauthorized) window.localStorage.removeItem("oi_admin_token");
              window.location.reload();
            },
          }}
        />
      </div>
    );
  }

  return (
    <div className="relative z-10 mx-auto max-w-[1780px] p-2 sm:p-3 flex flex-col gap-2.5 font-sans">
      {/* 1. Topbar */}
      <Topbar
        mode={mode}
        running={running}
        killSwitch={killSwitch}
        activeExchange={activeExchange?.name || "BYBIT"}
        coinglassLatency={telemetry.signalP50 ? `${telemetry.signalP50}ms` : "--"}
        scanCount={coins.length}
        nextScanSec={15}
        dirtyStrategy={false}
        onToggleMode={handleToggleMode}
        onToggleRunning={toggleRunning}
        onTriggerScan={scanNow}
        onToggleKillSwitch={() => setKillSwitch(!killSwitch)}
        onPanic={panicAll}
        onResetPaper={resetSample}
        onToggleSettings={() => setIsSettingsOpen(!isSettingsOpen)}
        onOpenExchangeModal={() => setIsExchangeModalOpen(true)}
        onExportReport={handleExportReport}
        onExportCsv={handleExportCsv}
      />

      {/* 2. Telemetry Strip (FX-84, FX-85) */}
      <TelemetryStrip
        telemetry={{
          p50LatencyMs: telemetry.signalP50,
          p95LatencyMs: telemetry.signalP95,
          scrapeAgeSec: telemetry.scrapeAge,
          bookAgeMs: telemetry.bookAge,
          loopLagMs: telemetry.loopLag,
        }}
        venues={exchanges.map((x) => ({
          venue: x.name,
          code: x.shortName,
          status: x.connected || x.status === "price-feed" ? ("ok" as const) : ("warn" as const),
          latencyMs: x.latency,
        }))}
        onReconcile={reconcile}
      />

      {/* 3. KPI Strip (8 Cards / 3 Clusters) */}
      <KpiStrip
        stats={{
          initialFund,
          equity,
          realizedPnl: realised,
          unrealizedPnl: openPnlValue,
          winrate: stats.winRate,
          profitFactor: stats.profitFactor,
          maxDrawdownPct: Math.abs(drawdown),
          totalTrades: stats.count,
          wins: stats.wins,
          losses: stats.losses,
          breakevens: stats.count - stats.wins - stats.losses,
          grossProfit: stats.grossWin,
          grossLoss: stats.grossLoss,
          totalFees: stats.fees,
          peakEquity: initialFund + stats.grossWin,
        }}
        openPositionsCount={positions.length}
      />

      {/* 4. Workspace View Selector */}
      <div className="flex items-center justify-between px-1 text-xs font-mono select-none">
        <div className="flex items-center gap-1 bg-[#0c1119] p-1 rounded-md border border-[#192434]">
          {[
            { id: "all", label: "All Views" },
            { id: "positions", label: `Positions (${positions.length})` },
            { id: "scanner", label: `Scanner (${coins.length})` },
            { id: "chart", label: "Equity Chart" },
            { id: "trades", label: `History (${trades.length})` },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setWorkspaceTab(tab.id as any)}
              className={`px-3 py-1 rounded transition-colors ${
                workspaceTab === tab.id
                  ? "bg-sky-500/15 text-sky-400 font-semibold border border-sky-500/30"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="text-[11px] text-slate-500 hidden md:block">
          Single-screen quantitative workstation · sub-second tick telemetry
        </div>
      </div>

      {/* 5. Main Workstation Views Grid */}
      <div className="flex flex-col gap-3">
        {/* Open Positions Panel (FX-82, FX-83, FX-86) */}
        {(workspaceTab === "all" || workspaceTab === "positions") && (
          <PositionsPanel
            positions={adaptedPositions}
            onClosePosition={closePosition}
            onCloseAll={closeAll}
          />
        )}

        {/* Scanner Table & CoinGlass Feed Grid (FX-80, FX-88) */}
        {(workspaceTab === "all" || workspaceTab === "scanner") && (
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-3 w-full">
            <div className="xl:col-span-8">
              <ScannerTable
                coins={adaptedScannerCoins}
                onInspect={handleInspect}
              />
            </div>
            <div className="xl:col-span-4">
              <CoinGlassFeed coins={adaptedFeedCoins} />
            </div>
          </div>
        )}

        {/* Equity Curve Chart */}
        {(workspaceTab === "all" || workspaceTab === "chart") && (
          <EquityChart series={adaptedSeries} initialFund={initialFund} />
        )}

        {/* Trades Ledger & Monospace Activity Log (FX-87) */}
        {(workspaceTab === "all" || workspaceTab === "trades") && (
          <TradesAndLogs
            trades={adaptedTrades}
            activity={activity.map((a) => ({
              id: String(a.id),
              time: a.at ? new Date(a.at).toTimeString().slice(0, 8) : "--:--:--",
              level: (a.type as any) === "alert" || (a.type as any) === "panic" ? "ALERT" : "INFO",
              message: `${a.title}: ${a.detail}`,
            }))}
            onExportCsv={handleExportCsv}
            onClearLogs={clearActivity}
            onDownloadLogs={() => {
              const text = activity
                .map((a) => `[${a.at ? new Date(a.at).toISOString() : ""}] [${a.type}] ${a.title}: ${a.detail}`)
                .join("\n");
              downloadFile(`oi-sniper-activity-${Date.now()}.log`, text, "text/plain");
            }}
          />
        )}
      </div>

      {/* 6. Strategy Drawer (FX-90) */}
      <StrategyDrawer
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        config={settings as any}
        onSave={handleSaveStrategy}
        onExportBackup={(includeKeys) => exportBackup(includeKeys)}
        onImportBackup={importBackup}
        onCopyPreset={handleCopyPreset}
      />

      {/* 7. Modals */}
      <InspectorModal
        isOpen={inspectedCoin !== null}
        onClose={() => setInspectedCoin(null)}
        coin={inspectedCoin}
      />

      <ExchangeModal
        isOpen={isExchangeModalOpen}
        onClose={() => setIsExchangeModalOpen(false)}
        exchanges={adaptedExchanges}
        onSelectActive={setActiveExchange}
        onConnect={async (venue, creds) => {
          await connectExchange({ venue, testnet: false, ...creds });
          return true;
        }}
        onDisconnect={disconnectExchange}
      />

      <LiveConfirmModal
        isOpen={liveConfirmOpen}
        onClose={closeLiveConfirm}
        activeExchange={activeExchange?.name || "Bybit"}
        marginPerTrade={liveGuardrails.marginPerTrade}
        dailyLossCap={liveGuardrails.dailyLossCap}
        onConfirmLive={async () => {
          activateLive();
        }}
      />

      <OnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
        onSelectPreset={(preset) => {
          notify(`Applied ${preset.toUpperCase()} preset`);
        }}
        onOpenExchangeModal={() => setIsExchangeModalOpen(true)}
      />

      <AuthModal
        isOpen={isAuthModalOpen}
        onClose={() => setIsAuthModalOpen(false)}
        onSuccess={() => {
          notify("Authenticated with ADMIN_SECRET");
        }}
      />
    </div>
  );
}

function WorkstationSkeleton() {
  return (
    <div
      className="relative z-10 mx-auto max-w-[1780px] p-2 sm:p-3 flex flex-col gap-2.5"
      role="status"
      aria-label="Loading workstation"
    >
      <div className="flex items-center justify-between p-3 bg-[#0c1119] border border-[#192434] rounded-lg">
        <SkeletonLine size="lg" width="w-48" />
        <div className="flex gap-2">
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-7 w-20" />
          <Skeleton className="h-7 w-24" />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-3">
        <div className="xl:col-span-8 p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col gap-3">
          {Array.from({ length: 9 }).map((_, i) => (
            <SkeletonLine key={i} size="md" />
          ))}
        </div>
        <div className="xl:col-span-4 p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonLine key={i} size="lg" />
          ))}
        </div>
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export default function WorkstationPage() {
  return (
    <AppProvider>
      <WorkstationContent />
    </AppProvider>
  );
}
