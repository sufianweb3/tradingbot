import { useMemo, useState } from "react";
import { START_FUND } from "../lib/data";
import {
  cn,
  dateTime,
  duration,
  pct,
  signedUsd,
  usd,
} from "../lib/format";
import {
  drawdownSeries,
  maxDrawdown,
  tradeStats,
  weeklyReturns,
} from "../lib/metrics";
import { useApp } from "../store/AppStore";
import {
  Button,
  Card,
  DataRow,
  PageHeader,
  Pill,
  SectionHead,
  Segmented,
} from "../components/ui";
import { DrawdownChart, EquityChart, WeeklyReturns } from "../components/charts";
import { ReportMenu } from "../components/ReportMenu";

type Timeframe = "1D" | "1W" | "1M" | "ALL";

const timeframeCounts: Record<Timeframe, number> = {
  "1D": 8,
  "1W": 56,
  "1M": 240,
  ALL: 720,
};

export default function PerformancePage() {
  const {
    series,
    equity,
    realised,
    openPnlValue,
    stats,
    trades,
    positions,
    deployedMargin,
    freeMargin,
  } = useApp();
  const [timeframe, setTimeframe] = useState<Timeframe>("1M");
  const chartData = series.slice(-timeframeCounts[timeframe]);
  const drawdowns = useMemo(() => drawdownSeries(series), [series]);
  const weeks = useMemo(() => weeklyReturns(series, 8), [series]);
  const longStats = useMemo(
    () => tradeStats(trades.filter((trade) => trade.side === "long")),
    [trades],
  );
  const shortStats = useMemo(
    () => tradeStats(trades.filter((trade) => trade.side === "short")),
    [trades],
  );
  const totalReturn = ((equity - START_FUND) / START_FUND) * 100;
  const currentDrawdown = drawdowns[drawdowns.length - 1]?.value ?? 0;
  const maxDd = maxDrawdown(series);
  const avgHold = trades.length
    ? trades.reduce(
        (sum, trade) => sum + (trade.closedAt.getTime() - trade.openedAt.getTime()),
        0,
      ) / trades.length
    : 0;
  const exitReasons = [
    "TP1 + trail",
    "Stop loss",
    "Max TP",
    "Manual",
    "Liquidation guard",
  ]
    .map((reason) => ({
      reason,
      count: trades.filter((trade) => trade.reason === reason).length,
    }))
    .filter((entry) => entry.count > 0);

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="Performance"
        subtitle="Equity, drawdown and trade quality for the current paper account."
        actions={<ReportMenu />}
      />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
        {[
          {
            label: "Net P&L",
            value: signedUsd(equity - START_FUND),
            tone: equity >= START_FUND ? "text-pos" : "text-neg",
          },
          { label: "Total return", value: pct(totalReturn), tone: totalReturn >= 0 ? "text-pos" : "text-neg" },
          { label: "Profit factor", value: stats.profitFactor.toFixed(2), tone: "text-ink" },
          { label: "Max drawdown", value: pct(maxDd, 1), tone: "text-neg" },
          { label: "Expectancy", value: signedUsd(stats.expectancy), tone: stats.expectancy >= 0 ? "text-pos" : "text-neg" },
        ].map((item, index) => (
          <div
            key={item.label}
            className={cn(
              "bg-surface px-4 py-4 sm:px-5",
              index === 4 && "col-span-2 sm:col-span-2 lg:col-span-1",
            )}
          >
            <p className="text-[10px] text-muted">{item.label}</p>
            <p className={cn("num mt-1.5 text-[18px] font-semibold tracking-[-0.02em]", item.tone)}>
              {item.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-12 gap-4 lg:gap-5">
        <Card className="col-span-12 overflow-hidden xl:col-span-8">
          <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6">
            <div>
              <h2 className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink">
                Equity curve
              </h2>
              <p className="mt-0.5 text-[12px] text-muted">
                Paper account, marked to market
              </p>
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
              ariaLabel="Performance range"
            />
          </div>
          <div className="flex items-baseline gap-2.5 px-5 pt-4 sm:px-6">
            <p className="num text-[28px] font-semibold leading-none tracking-[-0.03em] text-ink">
              {usd(equity)}
            </p>
            <Pill tone={totalReturn >= 0 ? "pos" : "neg"}>{pct(totalReturn)}</Pill>
          </div>
          <div className="px-3 pb-2 pt-3 sm:px-4">
            <EquityChart data={chartData} height={256} />
          </div>
        </Card>

        <Card className="col-span-12 xl:col-span-4">
          <SectionHead title="Account summary" subtitle="Since the account opened" />
          <div className="px-5 pb-5 pt-5 sm:px-6">
            <div className="space-y-2.5">
              <DataRow label="Starting fund" value={usd(START_FUND)} />
              <DataRow
                label="Realised P&L"
                value={signedUsd(realised)}
                tone={realised >= 0 ? "pos" : "neg"}
              />
              <DataRow
                label="Open P&L"
                value={signedUsd(openPnlValue)}
                tone={openPnlValue >= 0 ? "pos" : "neg"}
              />
              <DataRow label="Fees paid" value={usd(stats.fees)} />
              <div className="border-t border-line pt-2.5">
                <DataRow label="Ending equity" value={usd(equity)} />
              </div>
            </div>
            <div className="mt-5 rounded-[12px] border border-line bg-surface-2 p-3">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-muted">Return on starting fund</span>
                <span className={cn("num font-semibold", totalReturn >= 0 ? "text-pos" : "text-neg")}>
                  {pct(totalReturn)}
                </span>
              </div>
              <div className="relative mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
                <span
                  className={cn("absolute inset-y-0 left-0 rounded-full", totalReturn >= 0 ? "bg-pos" : "bg-neg")}
                  style={{ width: `${Math.min(100, Math.abs(totalReturn) * 3)}%` }}
                />
              </div>
              <p className="mt-2 text-[9.5px] leading-[1.45] text-faint">
                {pct(totalReturn)} against the $25,000 starting balance.
              </p>
            </div>
            <div className="mt-5 space-y-2.5 border-t border-line pt-4">
              <DataRow label="Win rate" value={`${stats.winRate.toFixed(1)}%`} />
              <DataRow label="Profit factor" value={stats.profitFactor.toFixed(2)} />
              <DataRow label="Average hold" value={duration(avgHold)} />
              <DataRow label="Deployed margin" value={usd(deployedMargin, 0)} />
              <DataRow label="Available margin" value={usd(freeMargin, 0)} />
              <DataRow label="Open positions" value={String(positions.length)} />
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-12 gap-4 lg:gap-5">
        <Card className="col-span-12 overflow-hidden sm:col-span-6 xl:col-span-4">
          <SectionHead title="Drawdown" subtitle="Distance from the running peak" />
          <div className="px-5 pb-5 pt-5 sm:px-6">
            <div className="flex items-baseline justify-between">
              <p className="num text-[22px] font-semibold tracking-[-0.02em] text-neg">{pct(currentDrawdown, 1)}</p>
              <Pill tone="neg">Max {pct(maxDd, 1)}</Pill>
            </div>
            <DrawdownChart data={drawdowns} height={112} className="mt-4" />
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4">
              <div>
                <p className="text-[9.5px] text-faint">Peak equity</p>
                <p className="num mt-1 text-[12px] font-medium text-ink">
                  {usd(Math.max(...series.map((point) => point.value)))}
                </p>
              </div>
              <div>
                <p className="text-[9.5px] text-faint">From peak</p>
                <p className="num mt-1 text-[12px] font-medium text-neg">
                  {pct(currentDrawdown, 1)}
                </p>
              </div>
            </div>
          </div>
        </Card>

        <Card className="col-span-12 sm:col-span-6 xl:col-span-4">
          <SectionHead title="Weekly returns" subtitle="Change in equity, week by week" />
          <div className="px-5 pb-5 pt-5 sm:px-6">
            <WeeklyReturns data={weeks} />
            <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[9.5px] text-faint">
              <span>{weeks.filter((week) => week.value >= 0).length} of {weeks.length} weeks positive</span>
              <span className={cn("num", Math.max(...weeks.map((week) => week.value)) >= 0 ? "text-pos" : "text-neg")}>
                Best {pct(Math.max(...weeks.map((week) => week.value)), 1)}
              </span>
            </div>
          </div>
        </Card>

        <Card className="col-span-12 xl:col-span-4">
          <SectionHead title="Trade breakdown" subtitle={`${stats.count} closed trades`} />
          <div className="px-5 pb-5 pt-5 sm:px-6">
            <div className="space-y-3">
              {[
                { label: "Long", stats: longStats, tone: "text-pos" },
                { label: "Short", stats: shortStats, tone: "text-neg" },
              ].map((side) => (
                <div key={side.label} className="flex items-center justify-between gap-3">
                  <span className={cn("text-[11px] font-medium", side.tone)}>{side.label}</span>
                  <span className="num text-[10.5px] text-muted">{side.stats.count} trades</span>
                  <span className="num text-[10.5px] text-muted">{side.stats.winRate.toFixed(0)}% win</span>
                  <span className={cn("num text-[11px] font-semibold", side.stats.avgTrade >= 0 ? "text-pos" : "text-neg")}>
                    {signedUsd(side.stats.avgTrade)}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-4 space-y-2.5 border-t border-line pt-4">
              <DataRow label="Average win" value={signedUsd(stats.avgWin)} tone="pos" />
              <DataRow label="Average loss" value={signedUsd(-stats.avgLoss)} tone="neg" />
              <DataRow label="Best trade" value={`${stats.best?.symbol ?? "—"} ${signedUsd(stats.best?.pnl ?? 0)}`} tone="pos" />
              <DataRow label="Worst trade" value={`${stats.worst?.symbol ?? "—"} ${signedUsd(stats.worst?.pnl ?? 0)}`} tone="neg" />
            </div>
            <div className="mt-4 border-t border-line pt-4">
              <p className="text-[10px] font-medium text-faint">Exit reasons</p>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
                {exitReasons.map((entry) => (
                  <div key={entry.reason} className="flex items-center justify-between gap-2 text-[10px]">
                    <span className="truncate text-muted">{entry.reason}</span>
                    <span className="num font-medium text-ink">{entry.count}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>

      <p className="px-1 text-[10px] leading-[1.5] text-faint">
        Last refreshed {dateTime(new Date())}. Statistics use closed paper trades and
        the current mark for open positions.
      </p>
    </div>
  );
}
