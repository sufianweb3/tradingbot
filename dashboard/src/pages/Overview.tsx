import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeftRight,
  ArrowUpRight,
  Plus,
  Radar,
  RefreshCw,
  ScanLine,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
} from "lucide-react";
import {
  START_FUND,
  type ActivityType,
  type Coin,
  type Position,
} from "../lib/data";
import {
  ago,
  cn,
  compactUsd,
  countdown,
  pct,
  price,
  signedUsd,
  usd,
} from "../lib/format";
import { positionMetrics } from "../lib/metrics";
import { useApp } from "../store/AppStore";
import {
  AnimatedNumber,
  Button,
  Card,
  CoinMark,
  DataRow,
  PageHeader,
  Pill,
  Progress,
  SectionHead,
  Segmented,
  SidePill,
} from "../components/ui";
import { DivergingBar, EquityChart, Meter } from "../components/charts";
import { PositionTable } from "../components/PositionTable";

type Timeframe = "1D" | "1W" | "1M" | "ALL";

const timeframeCounts: Record<Timeframe, number> = {
  "1D": 8,
  "1W": 56,
  "1M": 240,
  ALL: 720,
};

const activityIcon: Record<ActivityType, typeof Radar> = {
  trade: ArrowLeftRight,
  scan: Radar,
  risk: ShieldAlert,
  system: Settings2,
};

const activityTone: Record<ActivityType, string> = {
  trade: "bg-accent-soft text-accent",
  scan: "bg-pos-soft text-pos",
  risk: "bg-warn-soft text-warn",
  system: "bg-surface-2 text-muted",
};

function EquityCard() {
  const { series, equity, realised, openPnlValue, freeMargin, deployedMargin, positions } =
    useApp();
  const [timeframe, setTimeframe] = useState<Timeframe>("1M");
  const data = series.slice(-timeframeCounts[timeframe]);
  const change = equity - START_FUND;
  const changePct = (change / START_FUND) * 100;
  const openNotional = positions.reduce(
    (sum, position) => sum + positionMetrics(position).notional,
    0,
  );

  return (
    <Card className="col-span-12 overflow-hidden xl:col-span-8">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 pt-5 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11.5px] font-medium text-muted">Account equity</p>
          <div className="mt-2 flex flex-wrap items-baseline gap-2.5">
            <AnimatedNumber
              value={equity}
              format={(value) => usd(value)}
              className="text-[34px] font-semibold leading-none tracking-[-0.035em] text-ink sm:text-[42px]"
            />
            <Pill tone={change >= 0 ? "pos" : "neg"}>{pct(changePct)}</Pill>
          </div>
          <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[10.5px] text-muted">
            <span>
              Start <span className="num text-ink-2">{usd(START_FUND)}</span>
            </span>
            <span>
              Realised{" "}
              <span className={cn("num", realised >= 0 ? "text-pos" : "text-neg")}>
                {signedUsd(realised)}
              </span>
            </span>
            <span>
              Open{" "}
              <span className={cn("num", openPnlValue >= 0 ? "text-pos" : "text-neg")}>
                {signedUsd(openPnlValue)}
              </span>
            </span>
          </div>
        </div>
        <Segmented
          options={[
            { value: "1D", label: "1D" },
            { value: "1W", label: "1W" },
            { value: "1M", label: "1M" },
            { value: "ALL", label: "All" },
          ]}
          value={timeframe}
          onChange={setTimeframe}
          ariaLabel="Chart range"
        />
      </div>
      <div className="px-3 pb-2 pt-5 sm:px-4">
        <EquityChart data={data} />
      </div>
      <div className="grid grid-cols-2 gap-px border-t border-line bg-line sm:grid-cols-4">
        {[
          { label: "Available margin", value: usd(freeMargin, 0), tone: "text-ink" },
          { label: "Deployed margin", value: usd(deployedMargin, 0), tone: "text-ink" },
          {
            label: "Open P&L",
            value: signedUsd(openPnlValue),
            tone: openPnlValue >= 0 ? "text-pos" : "text-neg",
          },
          { label: "Open notional", value: compactUsd(openNotional), tone: "text-ink" },
        ].map((item) => (
          <div key={item.label} className="bg-surface px-5 py-3.5">
            <p className="text-[9.5px] text-faint">{item.label}</p>
            <p className={cn("num mt-1 text-[12.5px] font-semibold", item.tone)}>
              {item.value}
            </p>
          </div>
        ))}
      </div>
    </Card>
  );
}

function EngineCard() {
  const { running, lastScan, autoScan, positions, mode, activeExchange, killSwitch } = useApp();
  const [now, setNow] = useState(() => Date.now());
  const { venues } = useMemo(
    () => ({
      venues: [
        { name: "Binance", latency: 38 },
        { name: "Bybit", latency: 54 },
        { name: "OKX", latency: 82 },
      ],
    }),
    [],
  );

  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => {
      const timestamp = Date.now();
      setNow(timestamp);
      if (timestamp - lastScan.getTime() >= 30_000) autoScan();
    }, 1000);
    return () => window.clearInterval(interval);
  }, [autoScan, lastScan, running]);

  const elapsed = running ? now - lastScan.getTime() : 0;
  const remaining = Math.max(0, 30 - elapsed / 1000);
  const progress = Math.min(1, elapsed / 30_000);

  return (
    <Card tone="engine" className="relative col-span-12 overflow-hidden shadow-card xl:col-span-4">
      <div className="engine-canvas pointer-events-none absolute inset-0 opacity-70" aria-hidden="true" />
      <div className="relative flex h-full flex-col p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-[10.5px] text-engine-muted">Engine</p>
            <p className="mt-0.5 text-[13px] font-medium text-engine-ink">
              {mode === "live" ? `Live execution on ${activeExchange?.name ?? "no exchange"}` : "Paper execution"}
            </p>
          </div>
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full border border-[var(--engine-line)] px-2.5 text-[10px] font-medium text-engine-ink">
            <span
              className={cn("status-dot", running ? "text-[var(--engine-pos)] is-pulsing" : "text-[var(--engine-muted)]")}
              aria-hidden="true"
            />
            {running ? "Running" : "Paused"}
          </span>
        </div>

        <div className="mt-7 flex items-end justify-between gap-4">
          <div>
            <p className="text-[10px] text-engine-muted">Next scan</p>
            <p className="num mt-1.5 text-[38px] font-semibold leading-none tracking-[-0.03em] text-engine-ink">
              {running ? countdown(remaining) : "--:--"}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] text-engine-muted">Last scan</p>
            <p className="mt-1 text-[11.5px] font-medium text-engine-ink">
              {running ? ago(lastScan) : "Paused"}
            </p>
          </div>
        </div>

        <div className="mt-4 h-[3px] overflow-hidden rounded-full bg-[var(--engine-line)]">
          <div
            className="h-full origin-left rounded-full bg-[var(--engine-pos)] transition-transform duration-1000 ease-linear"
            style={{ transform: `scaleX(${progress})` }}
          />
        </div>

        <div className="mt-6 grid grid-cols-2 gap-x-5 gap-y-4">
          {[
            { label: "Active filters", value: "5 across 2 profiles" },
            { label: "Universe", value: "412 coins" },
            { label: "Direction", value: "Automatic" },
            { label: "Open positions", value: `${positions.length} of 8` },
          ].map((item) => (
            <div key={item.label}>
              <p className="text-[9.5px] text-engine-muted">{item.label}</p>
              <p className="num mt-1 text-[11.5px] font-medium text-engine-ink">{item.value}</p>
            </div>
          ))}
        </div>

        {killSwitch ? (
          <div className="mt-4 flex items-center gap-2 rounded-[9px] border border-[var(--toast-danger)]/30 bg-[var(--toast-danger)]/10 px-3 py-2">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--toast-danger)]" aria-hidden="true" />
            <p className="text-[9.5px] font-medium text-[var(--toast-danger)]">
              Kill switch active, new entries blocked
            </p>
          </div>
        ) : null}

        <div className="mt-6 border-t border-[var(--engine-line)] pt-4">
          <div className="mb-2.5 flex items-center justify-between">
            <p className="text-[9.5px] text-engine-muted">Venue latency</p>
            <p className="text-[9.5px] text-engine-muted">Best executable</p>
          </div>
          <div className="space-y-2">
            {venues.map((venue) => (
              <div key={venue.name} className="flex items-center gap-3">
                <span className="w-[54px] text-[10px] text-engine-ink">{venue.name}</span>
                <span className="h-[2px] flex-1 overflow-hidden rounded-full bg-[var(--engine-line)]">
                  <span
                    className="block h-full rounded-full bg-[var(--engine-pos)]"
                    style={{ width: `${Math.max(12, 100 - venue.latency / 1.6)}%` }}
                  />
                </span>
                <span className="num w-10 text-right text-[9.5px] text-engine-muted">
                  {venue.latency} ms
                </span>
              </div>
            ))}
          </div>
        </div>

        <Link
          to="/strategy"
          className="mt-auto flex items-center justify-between border-t border-[var(--engine-line)] pt-4 text-[10.5px] font-medium text-engine-ink transition-colors duration-150 hover:text-[var(--engine-pos)]"
        >
          Manage strategy
          <ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />
        </Link>
      </div>
    </Card>
  );
}

function TelemetryStrip() {
  const { telemetry, exchanges, reconcile } = useApp();
  const metrics = [
    { label: "Signal to order", value: `${telemetry.signalP50} ms`, hint: `p95 ${telemetry.signalP95} ms` },
    { label: "Scrape age", value: `${telemetry.scrapeAge} ms`, hint: "CoinGlass feed" },
    { label: "Book age", value: `${telemetry.bookAge} ms`, hint: "L2 snapshots" },
    { label: "Loop lag", value: `${telemetry.loopLag} ms`, hint: "scan cadence" },
  ];

  return (
    <div className="grid gap-px overflow-hidden rounded-[16px] border border-line bg-line lg:grid-cols-[1.25fr_1fr]">
      <div className="bg-surface px-4 py-3.5 sm:px-5">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-medium text-muted">Execution telemetry</p>
          <Pill tone="pos" dot pulse className="h-5 px-2 text-[8.5px]">
            Streaming
          </Pill>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
          {metrics.map((metric) => (
            <div key={metric.label}>
              <p className="text-[9px] text-faint">{metric.label}</p>
              <p className="num mt-0.5 text-[12px] font-semibold text-ink">{metric.value}</p>
              <p className="text-[8.5px] text-faint">{metric.hint}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="bg-surface px-4 py-3.5 sm:px-5">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-medium text-muted">Venue health</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={reconcile}
            className="h-6 px-2 text-[9.5px]"
            icon={<RefreshCw size={11} strokeWidth={2} aria-hidden="true" />}
          >
            Reconcile
          </Button>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {exchanges.map((exchange) => (
            <span
              key={exchange.id}
              title={exchange.note ?? exchange.tier}
              className="inline-flex h-5 items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 text-[8.5px] text-ink-2"
            >
              <span
                className={cn(
                  "status-dot",
                  exchange.status === "connected"
                    ? "text-pos"
                    : exchange.readOnly
                      ? "text-accent"
                      : exchange.status === "paper"
                        ? "text-warn"
                        : "text-faint",
                )}
                aria-hidden="true"
              />
              {exchange.name}
              <span className="num text-faint">{exchange.latency} ms</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function StatsStrip() {
  const { stats, drawdown } = useApp();
  const items = [
    {
      label: "Win rate",
      value: `${stats.winRate.toFixed(1)}%`,
      hint: `${stats.wins} of ${stats.count} closed trades`,
      tone: "text-ink",
    },
    {
      label: "Profit factor",
      value: stats.profitFactor.toFixed(2),
      hint: "gross win over gross loss",
      tone: "text-ink",
    },
    {
      label: "Max drawdown",
      value: pct(drawdown, 1),
      hint: "peak to trough",
      tone: "text-neg",
    },
    {
      label: "Average trade",
      value: signedUsd(stats.avgTrade),
      hint: "per closed trade",
      tone: stats.avgTrade >= 0 ? "text-pos" : "text-neg",
    },
    {
      label: "Fees paid",
      value: usd(stats.fees),
      hint: "taker, both sides",
      tone: "text-ink",
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
      {items.map((item, index) => (
        <div
          key={item.label}
          className={cn(
            "bg-surface px-4 py-4 sm:px-5",
            index === items.length - 1 && "col-span-2 sm:col-span-2 lg:col-span-1",
          )}
        >
          <p className="text-[10px] text-muted">{item.label}</p>
          <p className={cn("num mt-1.5 text-[18px] font-semibold tracking-[-0.02em]", item.tone)}>
            {item.value}
          </p>
          <p className="mt-0.5 text-[9.5px] text-faint">{item.hint}</p>
        </div>
      ))}
    </div>
  );
}

function ScannerPreview({ coins }: { coins: Coin[] }) {
  const { openTrade, lastScan } = useApp();
  const qualified = coins.filter((coin) => coin.status === "qualified");
  const near = coins.filter((coin) => coin.status === "near");
  const rows = qualified.slice(0, 6);

  return (
    <Card className="col-span-12 overflow-hidden xl:col-span-7">
      <SectionHead
        title="Signal scanner"
        subtitle={`${qualified.length} qualified. ${near.length} coins near the threshold.`}
        action={
          <Link
            to="/scanner"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:text-accent-strong"
          >
            Open scanner
            <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
          </Link>
        }
      />
      <div className="mt-4 px-5 sm:px-6">
        <div className="hidden sm:block">
          <div className="grid grid-cols-[minmax(0,1.5fr)_92px_92px_58px_62px] items-center gap-3 border-y border-line py-2 text-[9.5px] text-faint">
            <span>Coin</span>
            <span>OI 5m</span>
            <span>Volume 1h</span>
            <span className="text-right">Score</span>
            <span />
          </div>
          {rows.map((coin) => (
            <div
              key={coin.symbol}
              className="grid grid-cols-[minmax(0,1.5fr)_92px_92px_58px_62px] items-center gap-3 border-b border-line py-3 last:border-0"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <CoinMark symbol={coin.symbol} size="sm" />
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="text-[12px] font-semibold leading-none text-ink">{coin.symbol}</p>
                    <SidePill side={coin.direction} />
                  </div>
                  <p className="mt-1 truncate text-[10px] leading-none text-muted">{coin.name}</p>
                </div>
              </div>
              <div>
                <p className="num text-[11.5px] font-medium text-ink">{pct(coin.oi5m)}</p>
                <DivergingBar value={coin.oi5m} max={6} className="mt-1.5" />
              </div>
              <div>
                <p className="num text-[11.5px] font-medium text-ink">{pct(coin.vol1h, 1)}</p>
                <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${Math.min(100, coin.vol1h)}%` }}
                  />
                </div>
              </div>
              <div className="text-right">
                <p className="num text-[11.5px] font-semibold text-ink">{coin.score}</p>
                <Meter value={coin.score} className="mt-1.5" />
              </div>
              <div className="text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 border border-line px-2 text-[10px]"
                  icon={<Plus size={11} strokeWidth={2.2} aria-hidden="true" />}
                  onClick={() => openTrade(coin)}
                  aria-label={`Open ${coin.symbol} ${coin.direction} paper trade`}
                >
                  Trade
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="sm:hidden">
          {rows.map((coin) => (
            <div key={coin.symbol} className="flex items-center gap-3 border-b border-line py-3 last:border-0">
              <CoinMark symbol={coin.symbol} size="sm" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="text-[12px] font-semibold leading-none text-ink">{coin.symbol}</p>
                  <SidePill side={coin.direction} />
                </div>
                <p className="num mt-1 text-[9.5px] text-muted">
                  OI {pct(coin.oi5m)} <span className="text-faint">/</span> Vol {pct(coin.vol1h, 1)}
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <span className="num text-[11px] font-semibold text-ink">{coin.score}</span>
                <button
                  type="button"
                  onClick={() => openTrade(coin)}
                  aria-label={`Open ${coin.symbol} ${coin.direction} paper trade`}
                  className="flex h-7 w-7 items-center justify-center rounded-full border border-line text-muted transition-colors duration-150 hover:border-line-strong hover:text-ink"
                >
                  <Plus size={12} strokeWidth={2.2} aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-line px-5 py-3 text-[9.5px] text-faint sm:px-6">
        <span>Showing {rows.length} of {qualified.length} qualified</span>
        <span>Last scan {ago(lastScan)}</span>
      </div>
    </Card>
  );
}

function ExposureCard() {
  const { positions, freeMargin, deployedMargin, openPnlValue } = useApp();
  const longNotional = positions
    .filter((position) => position.side === "long")
    .reduce((sum, position) => sum + positionMetrics(position).notional, 0);
  const shortNotional = positions
    .filter((position) => position.side === "short")
    .reduce((sum, position) => sum + positionMetrics(position).notional, 0);
  const total = longNotional + shortNotional;
  const longShare = total ? (longNotional / total) * 100 : 0;

  return (
    <Card>
      <SectionHead
        title="Exposure"
        subtitle={`${positions.length} open positions, ${compactUsd(total)} notional`}
      />
      <div className="px-5 pb-5 pt-5 sm:px-6">
        <div className="flex h-2 overflow-hidden rounded-full bg-surface-2">
          <div className="bg-pos" style={{ width: `${longShare}%` }} />
          <div className="bg-neg" style={{ width: `${100 - longShare}%` }} />
        </div>
        <div className="mt-3 flex items-start justify-between gap-4">
          <div>
            <p className="flex items-center gap-1.5 text-[10px] text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-pos" aria-hidden="true" />
              Long
            </p>
            <p className="num mt-1 text-[12px] font-semibold text-ink">{compactUsd(longNotional)}</p>
          </div>
          <div className="text-right">
            <p className="flex items-center justify-end gap-1.5 text-[10px] text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-neg" aria-hidden="true" />
              Short
            </p>
            <p className="num mt-1 text-[12px] font-semibold text-ink">{compactUsd(shortNotional)}</p>
          </div>
        </div>
        <div className="mt-5 space-y-2.5 border-t border-line pt-4">
          <DataRow label="Available margin" value={usd(freeMargin, 0)} />
          <DataRow label="Deployed margin" value={usd(deployedMargin, 0)} />
          <DataRow
            label="Open P&L"
            value={signedUsd(openPnlValue)}
            tone={openPnlValue >= 0 ? "pos" : "neg"}
          />
        </div>
      </div>
    </Card>
  );
}

function ActivityCard() {
  const { activity } = useApp();
  return (
    <Card>
      <SectionHead
        title="Activity"
        subtitle="Engine events, newest first"
        action={
          <Link
            to="/activity"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:text-accent-strong"
          >
            View all
            <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
          </Link>
        }
      />
      <div className="px-5 pb-3 pt-3 sm:px-6">
        {activity.slice(0, 4).map((item, index) => {
          const Icon = activityIcon[item.type];
          return (
            <div
              key={item.id}
              className={cn(
                "flex gap-3 py-3",
                index !== 3 && "border-b border-line",
              )}
            >
              <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full", activityTone[item.type])}>
                <Icon size={12} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="truncate text-[11.5px] font-medium text-ink">{item.title}</p>
                  <span className="shrink-0 text-[9.5px] text-faint">{ago(item.at)}</span>
                </div>
                <p className="mt-0.5 line-clamp-1 text-[10.5px] text-muted">{item.detail}</p>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default function OverviewPage() {
  const { coins, positions, scanNow, running, updatedAt, mode, activeExchange } = useApp();

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="Overview"
        badge={
          mode === "live" ? (
            <Pill tone="neg" dot pulse>
              Live
            </Pill>
          ) : null
        }
        subtitle={
          running
            ? mode === "live"
              ? `Live execution on ${activeExchange?.name ?? "no exchange"}. Scans the CoinGlass universe every 30 seconds. Updated ${ago(updatedAt)}.`
              : `Paper account. Scans the CoinGlass universe every 30 seconds. Updated ${ago(updatedAt)}.`
            : "The engine is paused and open positions stay marked."
        }
        actions={
          <>
            <Link to="/strategy">
              <Button
                variant="ghost"
                size="md"
                icon={<SlidersHorizontal size={14} strokeWidth={1.9} aria-hidden="true" />}
              >
                Strategy
              </Button>
            </Link>
            <Button
              variant="secondary"
              size="md"
              onClick={scanNow}
              icon={<ScanLine size={14} strokeWidth={1.9} aria-hidden="true" />}
            >
              Scan now
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-12 gap-4 lg:gap-5">
        <EquityCard />
        <EngineCard />
      </div>

      <StatsStrip />
      <TelemetryStrip />

      <Card className="overflow-hidden">
        <SectionHead
          title="Open positions"
          subtitle={`${positions.length} open, ${usd(
            positions.reduce((sum, position) => sum + position.margin, 0),
            0,
          )} margin deployed`}
          action={
            <Link
              to="/positions"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:text-accent-strong"
            >
              View all
              <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
            </Link>
          }
        />
        <div className="mt-4">
          {positions.length ? (
            <PositionTable positions={positions} />
          ) : (
            <p className="px-6 py-10 text-center text-[12px] text-muted">
              No open positions. The next qualified signal will open one.
            </p>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-12 items-start gap-4 lg:gap-5">
        <ScannerPreview coins={coins} />
        <div className="col-span-12 grid gap-4 sm:grid-cols-2 xl:col-span-5 xl:grid-cols-1 lg:gap-5">
          <ExposureCard />
          <ActivityCard />
        </div>
      </div>

      <p className="px-1 pt-1 text-[10px] leading-[1.5] text-faint">
        Preview data. Values are simulated for the interface and do not represent
        live exchange activity.
      </p>
    </div>
  );
}
