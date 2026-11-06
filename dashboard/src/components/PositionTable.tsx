import { X } from "lucide-react";
import type { Position } from "../lib/data";
import { cn, compactUsd, price, signedUsd, usd } from "../lib/format";
import { positionMetrics } from "../lib/metrics";
import { useApp } from "../store/AppStore";
import { CoinMark, Progress, SidePill } from "./ui";

export function PositionTable({
  positions,
  className,
}: {
  positions: Position[];
  className?: string;
}) {
  const { closePosition } = useApp();

  return (
    <>
      <div className="md:hidden">
        {positions.map((position) => {
          const metrics = positionMetrics(position);
          const positive = metrics.pnl >= 0;
          return (
            <div key={position.id} className="border-b border-line px-5 py-4 last:border-0">
              <div className="flex items-start gap-3">
                <CoinMark symbol={position.symbol} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-[12.5px] font-semibold leading-none text-ink">
                      {position.symbol}
                      <span className="ml-1 font-normal text-faint">/ USDT</span>
                    </p>
                    <SidePill side={position.side} />
                    <span className="num text-[10px] text-muted">{position.leverage}×</span>
                  </div>
                  <p className="mt-1 text-[10px] text-muted">
                    {position.name}, {compactUsd(metrics.notional)} notional
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => closePosition(position.id)}
                  title={`Close ${position.symbol} ${position.side}`}
                  aria-label={`Close ${position.symbol} ${position.side} position`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-faint transition-colors duration-150 hover:bg-neg-soft hover:text-neg"
                >
                  <X size={13} strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
              <div className="mt-3 flex items-end justify-between gap-3">
                <div>
                  <p className={cn("num text-[18px] font-semibold leading-none", positive ? "text-pos" : "text-neg")}>
                    {metrics.roe > 0 ? "+" : ""}
                    {metrics.roe.toFixed(1)}%
                  </p>
                  <p className="mt-1 text-[9.5px] text-faint">Return on margin</p>
                </div>
                <div className="text-right">
                  <p className={cn("num text-[13px] font-semibold", positive ? "text-pos" : "text-neg")}>
                    {signedUsd(metrics.pnl)}
                  </p>
                  <p className="num mt-1 text-[9.5px] text-faint">
                    TP1 {metrics.tpDistancePct > 0 ? `${metrics.tpDistancePct.toFixed(2)}%` : "reached"}
                  </p>
                </div>
              </div>
              <Progress value={metrics.progress} tone={positive ? "pos" : "neg"} className="mt-3" />
            </div>
          );
        })}
      </div>

      <div className={cn("hidden min-w-0 overflow-x-auto md:block", className)}>
        <table className="w-full min-w-[760px] border-collapse text-left">
        <thead>
          <tr className="border-y border-line">
            <th className="py-2.5 pl-6 pr-3 text-[10.5px] font-medium text-faint" scope="col">
              Position
            </th>
            <th className="px-3 py-2.5 text-[10.5px] font-medium text-faint" scope="col">
              Side
            </th>
            <th className="px-3 py-2.5 text-right text-[10.5px] font-medium text-faint" scope="col">
              Size
            </th>
            <th className="px-3 py-2.5 text-right text-[10.5px] font-medium text-faint" scope="col">
              Mark / entry
            </th>
            <th className="w-[164px] px-3 py-2.5 text-[10.5px] font-medium text-faint" scope="col">
              Return on margin
            </th>
            <th className="px-3 py-2.5 text-right text-[10.5px] font-medium text-faint" scope="col">
              Unrealised P&amp;L
            </th>
            <th className="py-2.5 pl-3 pr-5 text-right text-[10.5px] font-medium text-faint" scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => {
            const metrics = positionMetrics(position);
            const positive = metrics.pnl >= 0;
            return (
              <tr
                key={position.id}
                className="group border-b border-line transition-colors duration-150 last:border-0 hover:bg-surface-2"
              >
                <td className="py-3.5 pl-6 pr-3">
                  <div className="flex items-center gap-3">
                    <CoinMark symbol={position.symbol} />
                    <div className="min-w-0">
                      <p className="text-[12.5px] font-semibold leading-[1.2] text-ink">
                        {position.symbol}
                        <span className="ml-1.5 font-normal text-faint">/ USDT</span>
                      </p>
                      <p className="mt-0.5 truncate text-[10.5px] leading-none text-muted">
                        {position.name}
                      </p>
                    </div>
                  </div>
                </td>
                <td className="px-3 py-3.5">
                  <div className="flex items-center gap-2">
                    <SidePill side={position.side} />
                    <span className="num text-[10.5px] text-muted">{position.leverage}×</span>
                  </div>
                </td>
                <td className="px-3 py-3.5 text-right">
                  <p className="num text-[12px] font-medium text-ink">
                    {compactUsd(metrics.notional)}
                  </p>
                  <p className="num mt-0.5 text-[10.5px] text-muted">
                    {usd(position.margin, 0)} margin
                  </p>
                </td>
                <td className="px-3 py-3.5 text-right">
                  <p className="num text-[12px] font-medium text-ink">{price(position.mark)}</p>
                  <p className="num mt-0.5 text-[10.5px] text-muted">{price(position.entry)}</p>
                </td>
                <td className="px-3 py-3.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <span
                      className={cn(
                        "num text-[12.5px] font-semibold",
                        positive ? "text-pos" : "text-neg",
                      )}
                    >
                      {metrics.roe > 0 ? "+" : ""}
                      {metrics.roe.toFixed(1)}%
                    </span>
                    <span className="num text-[9.5px] text-faint">
                      TP1 {metrics.tpDistancePct > 0 ? `${metrics.tpDistancePct.toFixed(2)}%` : "reached"}
                    </span>
                  </div>
                  <Progress
                    value={metrics.progress}
                    tone={positive ? "pos" : "neg"}
                    className="mt-2"
                  />
                  <div className="mt-1.5 flex items-center justify-between text-[9px] text-faint">
                    <span>Entry</span>
                    <span>TP1</span>
                  </div>
                </td>
                <td className="px-3 py-3.5 text-right">
                  <p
                    className={cn(
                      "num text-[12.5px] font-semibold",
                      positive ? "text-pos" : "text-neg",
                    )}
                  >
                    {signedUsd(metrics.pnl)}
                  </p>
                  <p className="num mt-0.5 text-[10px] text-muted">
                    {position.trailingArmed ? "Trailing armed" : "Fixed stop"}
                  </p>
                </td>
                <td className="py-3.5 pl-3 pr-5 text-right">
                  <button
                    type="button"
                    onClick={() => closePosition(position.id)}
                    title={`Close ${position.symbol} ${position.side}`}
                    aria-label={`Close ${position.symbol} ${position.side} position`}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full text-faint transition-[color,background-color] duration-150 hover:bg-neg-soft hover:text-neg"
                  >
                    <X size={13} strokeWidth={2} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </>
  );
}
