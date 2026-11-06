import { useEffect, useMemo, useState } from "react";
import { ArrowUpRight, Check, X } from "lucide-react";
import type { Coin, Side } from "../lib/data";
import { cn, price, usd } from "../lib/format";
import { executionFor, statusTone } from "../lib/execution";
import { useApp } from "../store/AppStore";
import { Button, CoinMark, Pill, Segmented, SidePill } from "./ui";
import { ModalShell } from "./ActionModals";

function DepthChart({ coin }: { coin: Coin }) {
  const data = useMemo(() => {
    const seed = coin.symbol.charCodeAt(0) + coin.score;
    const levels = Array.from({ length: 11 }, (_, index) => {
      const bidDepth = Math.round((18_000 + (seed * (index + 1) * 1_700) % 62_000) / 500) * 500;
      const askDepth = Math.round((16_000 + (seed * (index + 2) * 1_450) % 58_000) / 500) * 500;
      return {
        bidDepth,
        askDepth,
        bidX: 260 - index * 21,
        askX: 260 + index * 21,
      };
    });
    let bidCumulative = 0;
    let askCumulative = 0;
    return levels.map((level, index) => {
      bidCumulative += level.bidDepth;
      askCumulative += level.askDepth;
      return {
        ...level,
        index,
        bidCumulative,
        askCumulative,
      };
    });
  }, [coin.score, coin.symbol]);

  const maxDepth = Math.max(
    ...data.map((point) => Math.max(point.bidCumulative, point.askCumulative)),
  );
  const yFor = (value: number) => 170 - (value / maxDepth) * 132;
  const bidPath = [
    "M 260 170",
    ...data.map((point) => `V ${yFor(point.bidCumulative).toFixed(2)} H ${point.bidX}`),
    "L 18 170 Z",
  ].join(" ");
  const askPath = [
    "M 260 170",
    ...data.map((point) => `V ${yFor(point.askCumulative).toFixed(2)} H ${point.askX}`),
    "L 502 170 Z",
  ].join(" ");

  return (
    <div>
      <svg
        viewBox="0 0 520 190"
        className="h-auto w-full"
        role="img"
        aria-label={`Cumulative order-book depth for ${coin.symbol}`}
      >
        {[0, 1, 2, 3, 4].map((step) => (
          <line
            key={step}
            x1="18"
            x2="502"
            y1={26 + step * 34}
            y2={26 + step * 34}
            stroke="var(--grid)"
            strokeWidth="1"
          />
        ))}
        <path d={bidPath} fill="var(--pos-soft)" stroke="var(--pos)" strokeWidth="1.4" />
        <path d={askPath} fill="var(--neg-soft)" stroke="var(--neg)" strokeWidth="1.4" />
        <line
          x1="260"
          x2="260"
          y1="18"
          y2="178"
          stroke="var(--line-strong)"
          strokeWidth="1"
          strokeDasharray="3 4"
        />
        <circle cx="260" cy={yFor(maxDepth * 0.44)} r="3.5" fill="var(--accent)" />
        <text x="262" y="24" fill="var(--faint)" fontSize="8.5">
          mid {price(coin.price)}
        </text>
      </svg>
      <div className="mt-1 flex items-center justify-between text-[9px] text-faint">
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-pos" aria-hidden="true" />
          Bids
        </span>
        <span>cumulative depth</span>
        <span className="flex items-center gap-1.5">
          Asks
          <span className="h-1.5 w-1.5 rounded-full bg-neg" aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}

export function ExecutionInspector({
  coin,
  open,
  onClose,
  onTrade,
}: {
  coin: Coin | null;
  open: boolean;
  onClose: () => void;
  onTrade: (coin: Coin, side: Side) => void;
}) {
  const { mode, liveGuardrails, activeExchange } = useApp();
  const [side, setSide] = useState<Side>(coin?.direction ?? "long");

  useEffect(() => {
    if (coin) setSide(coin.direction);
  }, [coin]);

  if (!coin) return null;
  if (!open) return null;
  const execution = executionFor(coin);
  const canTrade = execution.status !== "BLOCKED";

  return (
    <ModalShell
      onClose={onClose}
      label={`Execution inspector for ${coin.symbol}`}
      width="max-w-[640px]"
    >
      <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-5 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <CoinMark symbol={coin.symbol} size="lg" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-ink">
                {coin.symbol}
                <span className="ml-1 text-[11px] font-normal text-faint">/ USDT</span>
              </h2>
              <SidePill side={side} />
            </div>
            <p className="mt-1 text-[10.5px] text-muted">
              Execution quality &amp; route inspector
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={statusTone[execution.status]} dot>
            {execution.status}
          </Pill>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
            className="flex h-7 w-7 items-center justify-center rounded-full text-faint hover:bg-surface-2 hover:text-ink"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="max-h-[70vh] overflow-y-auto px-5 py-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            options={[
              { value: "long", label: "Long entry" },
              { value: "short", label: "Short entry" },
            ]}
            value={side}
            onChange={setSide}
            ariaLabel="Inspect side"
          />
          <span className="num text-[11px] text-muted">
            Mark {price(coin.price)}
          </span>
        </div>

        <div className="mt-4 flex items-start gap-2.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
          <span
            className={cn(
              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
              canTrade ? "bg-pos-soft text-pos" : "bg-neg-soft text-neg",
            )}
          >
            {canTrade ? (
              <Check size={10} strokeWidth={2.8} aria-hidden="true" />
            ) : (
              <X size={10} strokeWidth={2.8} aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0">
            <p className="text-[10.5px] font-medium text-ink">
              {execution.status === "PASS"
                ? "Executable at requested size"
                : execution.status === "SCALED"
                  ? "Executable with a size haircut"
                  : "Execution gate rejected this entry"}
            </p>
            <p className="mt-0.5 text-[10px] leading-[1.5] text-muted">
              {execution.reasons[0]}
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-[12px] border border-line bg-line sm:grid-cols-4">
          {[
            { label: "Mid price", value: price(coin.price) },
            { label: "Spread", value: `${execution.spreadBps.toFixed(2)} bps` },
            { label: "Entry slippage", value: `${execution.impactBps.toFixed(1)} bps` },
            { label: "Book freshness", value: `${execution.bookAgeMs} ms` },
            { label: "One-way cost", value: `${execution.oneWayBps.toFixed(1)} bps` },
            { label: "Round-trip", value: `${execution.roundTripBps.toFixed(1)} bps` },
            { label: "Band depth", value: usd(execution.bandDepthUsd, 0) },
            { label: "Max safe notional", value: usd(execution.maxSafeNotional, 0) },
          ].map((item) => (
            <div key={item.label} className="bg-surface px-3 py-2.5">
              <p className="text-[9px] text-faint">{item.label}</p>
              <p className="num mt-1 text-[11px] font-medium text-ink">{item.value}</p>
            </div>
          ))}
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between">
            <p className="text-[11.5px] font-medium text-ink">Order-book depth</p>
            <span className="num text-[9.5px] text-faint">
              fill {Math.round(execution.fillRatio * 100)}% · VWAP{" "}
              {price(coin.price * (side === "long" ? 1.0007 : 0.9993))}
            </span>
          </div>
          <div className="mt-2 rounded-[12px] border border-line bg-surface-2 px-3 pb-2 pt-3">
            <DepthChart coin={coin} />
          </div>
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between">
            <p className="text-[11.5px] font-medium text-ink">Best route</p>
            <Pill tone="neutral" className="h-5 px-2 text-[9px]">
              {execution.route} at {(execution.routes[0]?.totalBps ?? execution.oneWayBps).toFixed(1)} bps
            </Pill>
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-left">
              <thead>
                <tr className="border-y border-line">
                  {["Venue", "Fee", "Spread", "Impact", "Total"].map((label, index) => (
                    <th
                      key={label}
                      scope="col"
                      className={cn(
                        "px-2 py-2 text-[9.5px] font-medium text-faint",
                        index > 0 && "text-right",
                        index === 0 && "pl-1",
                      )}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {execution.routes.map((route) => (
                  <tr
                    key={route.venue}
                    className={cn(
                      "border-b border-line last:border-0",
                      route.best && "bg-pos-soft/40",
                    )}
                  >
                    <td className="px-1 py-2 text-[10.5px] font-medium text-ink">
                      {route.venue}
                      {route.best ? (
                        <span className="ml-1.5 text-[8.5px] font-semibold text-pos">best</span>
                      ) : null}
                    </td>
                    <td className="num px-2 py-2 text-right text-[10px] text-muted">
                      {route.feeBps.toFixed(2)}
                    </td>
                    <td className="num px-2 py-2 text-right text-[10px] text-muted">
                      {route.spreadBps.toFixed(2)}
                    </td>
                    <td className="num px-2 py-2 text-right text-[10px] text-muted">
                      {route.impactBps.toFixed(1)}
                    </td>
                    <td className="num px-2 py-2 text-right text-[10px] font-medium text-ink">
                      {route.totalBps.toFixed(1)} bps
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[9.5px] leading-[1.5] text-faint">
            Auto route compares venue fee, spread and simulated market impact. The active
            exchange is {activeExchange?.name ?? "not selected"}.
          </p>
        </div>

        {mode === "live" ? (
          <div className="mt-4 rounded-[10px] border border-warn/30 bg-warn-soft px-3 py-2.5 text-[10px] leading-[1.5] text-warn">
            Live mode is armed. The guardrail cap is{" "}
            {liveGuardrails.marginPerTrade > 0
              ? usd(liveGuardrails.marginPerTrade, 0)
              : "using strategy sizing"}
            . This preview does not submit orders.
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-4 sm:px-6">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!canTrade}
          onClick={() => {
            onTrade(coin, side);
            onClose();
          }}
          icon={<ArrowUpRight size={13} strokeWidth={2} aria-hidden="true" />}
        >
          {canTrade
            ? execution.status === "SCALED"
              ? "Open scaled trade"
              : mode === "live"
                ? "Open live trade"
                : "Open paper trade"
            : "Execution blocked"}
        </Button>
      </div>
    </ModalShell>
  );
}
