import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Crosshair,
  ScanLine,
  X,
} from "lucide-react";
import type { Position } from "../lib/data";
import {
  ago,
  clamp,
  cn,
  compactUsd,
  price,
  signedUsd,
  usd,
} from "../lib/format";
import { positionMetrics } from "../lib/metrics";
import { useApp } from "../store/AppStore";
import {
  Button,
  Card,
  CoinMark,
  DataRow,
  EmptyState,
  PageHeader,
  Pill,
  Segmented,
  SidePill,
} from "../components/ui";
import { Sparkline } from "../components/charts";

type SideFilter = "all" | "long" | "short";

function RiskLadder({ position }: { position: Position }) {
  const metrics = positionMetrics(position);
  const values = [position.stop, position.entry, position.tp1, position.tpMax, position.mark];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const at = (value: number) => clamp(((value - min) / (max - min)) * 100, 0, 100);
  const zone = (a: number, b: number) => {
    const left = Math.min(at(a), at(b));
    const width = Math.abs(at(a) - at(b));
    return { left: `${left}%`, width: `${width}%` };
  };
  const markPct = at(position.mark);

  return (
    <div className="mt-4">
      <div className="relative h-2 rounded-full bg-surface-2">
        <span
          className="absolute inset-y-0 rounded-full bg-neg-soft"
          style={zone(position.entry, position.stop)}
        />
        <span
          className="absolute inset-y-0 rounded-full bg-pos-soft"
          style={zone(position.entry, position.tp1)}
        />
        <span
          className="absolute inset-y-0 rounded-full bg-accent-soft-2"
          style={zone(position.tp1, position.tpMax)}
        />
        <span
          className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink shadow-[0_0_0_2px_var(--surface)]"
          style={{ left: `${markPct}%` }}
          title={`Mark ${price(position.mark)}`}
        />
      </div>
      <div className="mt-2 flex items-center justify-between text-[9.5px] text-faint">
        {position.side === "long" ? (
          <>
            <span>Stop {price(position.stop)}</span>
            <span>Entry {price(position.entry)}</span>
            <span>TP1 {price(position.tp1)}</span>
            <span>Max {price(position.tpMax)}</span>
          </>
        ) : (
          <>
            <span>Max {price(position.tpMax)}</span>
            <span>TP1 {price(position.tp1)}</span>
            <span>Entry {price(position.entry)}</span>
            <span>Stop {price(position.stop)}</span>
          </>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between text-[10px]">
        <span className="text-muted">
          Stop distance <span className="num text-neg">{metrics.stopDistancePct.toFixed(2)}%</span>
        </span>
        <span className="text-muted">
          TP1 distance{" "}
          <span className={cn("num", metrics.tpDistancePct > 0 ? "text-pos" : "text-muted")}>
            {metrics.tpDistancePct > 0 ? `${metrics.tpDistancePct.toFixed(2)}%` : "reached"}
          </span>
        </span>
      </div>
    </div>
  );
}

function PositionCard({ position }: { position: Position }) {
  const { closePosition } = useApp();
  const [showLifecycle, setShowLifecycle] = useState(false);
  const metrics = positionMetrics(position);
  const positive = metrics.pnl >= 0;
  const tp1Hit =
    position.side === "long" ? position.mark >= position.tp1 : position.mark <= position.tp1;
  const exitTone =
    position.exitLiquidity === "OK"
      ? "pos"
      : position.exitLiquidity === "Thin"
        ? "warn"
        : "neg";
  const lifecycle = [
    { label: "Signal", done: true },
    { label: "EQE gate", done: true },
    { label: "Route", done: true },
    { label: "Fill", done: true },
    { label: "SL active", done: true },
    { label: "TP1", done: tp1Hit },
    { label: "Trail", done: position.trailingArmed },
  ];

  return (
    <Card className="flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-4 px-5 pt-5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <CoinMark symbol={position.symbol} size="lg" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[15px] font-semibold leading-none tracking-[-0.02em] text-ink">
                {position.symbol}
                <span className="ml-1 text-[11px] font-normal text-faint">/ USDT</span>
              </p>
              <SidePill side={position.side} />
              <Pill tone="neutral" className="h-5 px-2 text-[9.5px]">
                {position.leverage}×
              </Pill>
            </div>
            <p className="mt-1.5 text-[10.5px] text-muted">
              {position.name} perpetual, opened {ago(position.openedAt)}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => closePosition(position.id)}
          aria-label={`Close ${position.symbol} ${position.side}`}
          title="Close position"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-faint transition-colors duration-150 hover:bg-neg-soft hover:text-neg"
        >
          <X size={14} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>

      <div className="flex items-end justify-between gap-4 px-5 pt-5 sm:px-6">
        <div>
          <p className={cn("num text-[30px] font-semibold leading-none tracking-[-0.03em]", positive ? "text-pos" : "text-neg")}>
            {metrics.roe > 0 ? "+" : ""}
            {metrics.roe.toFixed(1)}%
          </p>
          <p className="mt-1.5 text-[10.5px] text-muted">
            Unrealised P&amp;L{" "}
            <span className={cn("num", positive ? "text-pos" : "text-neg")}>
              {signedUsd(metrics.pnl)}
            </span>
          </p>
        </div>
        <div className="w-[132px] shrink-0">
          <Sparkline data={position.spark} fluid tone={positive ? "pos" : "neg"} className="h-10" />
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-5 gap-y-3 border-y border-line px-5 py-4 sm:px-6">
        <DataRow label="Entry" value={price(position.entry)} />
        <DataRow label="Mark" value={price(position.mark)} />
        <DataRow label="Notional" value={compactUsd(metrics.notional)} />
        <DataRow label="Margin" value={usd(position.margin, 0)} />
      </div>

      <div className="px-5 sm:px-6">
        <RiskLadder position={position} />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
          <span className="flex items-center gap-1.5 text-[9.5px] text-muted">
            <span className="status-dot text-pos" aria-hidden="true" />
            Route {position.venue} at {position.routeBps} bps
          </span>
          <Pill tone={exitTone} className="h-5 px-2 text-[8.5px]">
            Exit liquidity {position.exitLiquidity}
          </Pill>
        </div>
      </div>

      {showLifecycle ? (
        <div className="mx-5 mt-3 rounded-[10px] border border-line bg-surface-2 px-3 py-3 sm:mx-6">
          <div className="flex items-center justify-between">
            <p className="text-[9.5px] font-medium text-muted">Trade lifecycle</p>
            <span className="text-[9px] text-faint">
              {tp1Hit ? "Runner active" : "Working toward TP1"}
            </span>
          </div>
          <div className="mt-3 flex items-center">
            {lifecycle.map((step, index) => (
              <div key={step.label} className="flex min-w-0 flex-1 items-center last:flex-none">
                <div className="flex flex-col items-center gap-1">
                  <span
                    className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-full border text-[8px]",
                      step.done
                        ? "border-pos/30 bg-pos-soft text-pos"
                        : "border-line bg-surface text-faint",
                    )}
                  >
                    {step.done ? <Check size={9} strokeWidth={2.8} aria-hidden="true" /> : index + 1}
                  </span>
                  <span className={cn("whitespace-nowrap text-[8px]", step.done ? "text-ink-2" : "text-faint")}>
                    {step.label}
                  </span>
                </div>
                {index < lifecycle.length - 1 ? (
                  <span
                    className={cn(
                      "mx-1 mb-3 h-px flex-1",
                      step.done ? "bg-pos/30" : "bg-line",
                    )}
                  />
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-auto flex items-center justify-between gap-3 px-5 pb-5 pt-5 sm:px-6">
        <button
          type="button"
          onClick={() => setShowLifecycle((value) => !value)}
          aria-expanded={showLifecycle}
          className="flex items-center gap-1 text-[9.5px] font-medium text-muted transition-colors duration-150 hover:text-ink"
        >
          Lifecycle
          <ChevronDown
            size={12}
            strokeWidth={2}
            className={cn("transition-transform duration-150", showLifecycle && "rotate-180")}
            aria-hidden="true"
          />
        </button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => closePosition(position.id)}
          className="h-8"
        >
          Close position
        </Button>
      </div>
    </Card>
  );
}

export default function PositionsPage() {
  const { positions, deployedMargin, freeMargin, openPnlValue, scanNow, closeAll, requestConfirm } = useApp();
  const [filter, setFilter] = useState<SideFilter>("all");
  const filtered = positions.filter(
    (position) => filter === "all" || position.side === filter,
  );
  const openNotional = positions.reduce(
    (sum, position) => sum + positionMetrics(position).notional,
    0,
  );

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="Positions"
        subtitle="Every paper position with its live mark, exit ladder and risk distance."
        actions={
          <>
            <Link to="/scanner">
              <Button
                variant="ghost"
                size="md"
                icon={<Crosshair size={14} strokeWidth={1.9} aria-hidden="true" />}
              >
                Scanner
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
            {positions.length > 0 ? (
              <Button
                variant="danger"
                size="md"
                onClick={() =>
                  requestConfirm({
                    title: "Close every open position?",
                    description:
                      "All positions close at the current mark. The engine keeps running unless the kill switch is active.",
                    confirmLabel: "Close all positions",
                    tone: "danger",
                    onConfirm: closeAll,
                  })
                }
                icon={<X size={13} strokeWidth={2} aria-hidden="true" />}
              >
                Close all
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-4">
        {[
          {
            label: "Open P&L",
            value: signedUsd(openPnlValue),
            tone: openPnlValue >= 0 ? "text-pos" : "text-neg",
          },
          { label: "Deployed margin", value: usd(deployedMargin, 0), tone: "text-ink" },
          { label: "Available margin", value: usd(freeMargin, 0), tone: "text-ink" },
          { label: "Open notional", value: compactUsd(openNotional), tone: "text-ink" },
        ].map((item) => (
          <div key={item.label} className="bg-surface px-4 py-4 sm:px-5">
            <p className="text-[10px] text-muted">{item.label}</p>
            <p className={cn("num mt-1.5 text-[18px] font-semibold tracking-[-0.02em]", item.tone)}>
              {item.value}
            </p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11.5px] text-muted">
          {positions.length} open {positions.length === 1 ? "position" : "positions"}
        </p>
        <Segmented
          options={[
            { value: "all", label: "All", count: positions.length },
            { value: "long", label: "Long", count: positions.filter((p) => p.side === "long").length },
            { value: "short", label: "Short", count: positions.filter((p) => p.side === "short").length },
          ]}
          value={filter}
          onChange={setFilter}
          ariaLabel="Filter positions by side"
        />
      </div>

      {filtered.length ? (
        <div className="grid grid-cols-12 gap-4 lg:gap-5">
          {filtered.map((position) => (
            <div key={position.id} className="col-span-12 lg:col-span-6">
              <PositionCard position={position} />
            </div>
          ))}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon={<Crosshair size={17} aria-hidden="true" />}
            title={positions.length ? "No positions on this side" : "No open positions"}
            description={
              positions.length
                ? "Switch the filter or open a new signal from the scanner."
                : "The engine is flat. Qualified signals will open paper positions automatically."
            }
            action={
              <Link to="/scanner">
                <Button variant="primary" size="sm" icon={<ArrowUpRight size={13} aria-hidden="true" />}>
                  Open scanner
                </Button>
              </Link>
            }
          />
        </Card>
      )}

      <p className="px-1 text-[10px] leading-[1.5] text-faint">
        Exits are simulated at the mark price with configured fees and slippage.
        Liquidation is approximate.
      </p>
    </div>
  );
}
