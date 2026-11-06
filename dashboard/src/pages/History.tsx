import { useEffect, useMemo, useState } from "react";
import { Download, Search } from "lucide-react";
import type { Trade } from "../lib/data";
import {
  ago,
  cn,
  dateTime,
  price,
  signedUsd,
  usd,
} from "../lib/format";
import { tradeStats } from "../lib/metrics";
import { downloadFile, tradesToCsv } from "../lib/download";
import { useApp } from "../store/AppStore";
import {
  Button,
  Card,
  CoinMark,
  EmptyState,
  Input,
  PageHeader,
  Pill,
  Segmented,
  Select,
  SidePill,
} from "../components/ui";

type SideFilter = "all" | "long" | "short";
type ResultFilter = "all" | "wins" | "losses";

const pageSize = 10;

const reasonTone: Record<Trade["reason"], "pos" | "neg" | "accent" | "neutral" | "warn"> = {
  "TP1 + trail": "pos",
  "Stop loss": "neg",
  "Max TP": "accent",
  Manual: "neutral",
  "Liquidation guard": "warn",
};

export default function HistoryPage() {
  const { trades, notify } = useApp();
  const [query, setQuery] = useState("");
  const [side, setSide] = useState<SideFilter>("all");
  const [result, setResult] = useState<ResultFilter>("all");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return trades.filter((trade) => {
      const matchesQuery =
        !normalized ||
        `${trade.symbol} ${trade.name} ${trade.reason}`.toLowerCase().includes(normalized);
      const matchesSide = side === "all" || trade.side === side;
      const matchesResult =
        result === "all" ||
        (result === "wins" && trade.pnl > 0) ||
        (result === "losses" && trade.pnl <= 0);
      return matchesQuery && matchesSide && matchesResult;
    });
  }, [query, result, side, trades]);

  const stats = useMemo(() => tradeStats(filtered), [filtered]);
  const netRealised = useMemo(
    () => filtered.reduce((sum, trade) => sum + trade.pnl, 0),
    [filtered],
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  useEffect(() => {
    setPage(0);
  }, [query, side, result]);

  const exportCsv = () => {
    const csv = tradesToCsv(
      filtered.map((trade) => ({
        date: dateTime(trade.closedAt),
        symbol: trade.symbol,
        side: trade.side,
        margin: trade.margin,
        leverage: trade.leverage,
        entry: trade.entry,
        exit: trade.exit,
        pnl: trade.pnl,
        roe: trade.roe,
        fees: trade.fees,
        reason: trade.reason,
      })),
      [
        { key: "date", label: "Closed at" },
        { key: "symbol", label: "Coin" },
        { key: "side", label: "Side" },
        { key: "margin", label: "Margin" },
        { key: "leverage", label: "Leverage" },
        { key: "entry", label: "Entry" },
        { key: "exit", label: "Exit" },
        { key: "pnl", label: "Net P&L" },
        { key: "roe", label: "ROE %" },
        { key: "fees", label: "Fees" },
        { key: "reason", label: "Exit reason" },
      ],
    );
    downloadFile(
      `oi-sniper-trades-${new Date().toISOString().slice(0, 10)}.csv`,
      csv,
      "text/csv;charset=utf-8",
    );
    notify("CSV exported", `${filtered.length} closed trades downloaded.`);
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="History"
        subtitle="Closed paper trades with fills, fees, return on margin and the exit that closed them."
        actions={
          <Button
            variant="secondary"
            size="md"
            onClick={exportCsv}
            disabled={filtered.length === 0}
            icon={<Download size={14} strokeWidth={1.9} aria-hidden="true" />}
          >
            Export CSV
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-4">
        {[
          {
            label: "Net realised",
            value: signedUsd(netRealised),
            tone: netRealised >= 0 ? "text-pos" : "text-neg",
          },
          { label: "Closed trades", value: String(stats.count), tone: "text-ink" },
          { label: "Win rate", value: `${stats.winRate.toFixed(1)}%`, tone: "text-ink" },
          { label: "Fees", value: usd(stats.fees), tone: "text-ink" },
        ].map((item) => (
          <div key={item.label} className="bg-surface px-4 py-4 sm:px-5">
            <p className="text-[10px] text-muted">{item.label}</p>
            <p className={cn("num mt-1.5 text-[18px] font-semibold tracking-[-0.02em]", item.tone)}>
              {item.value}
            </p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-5">
        {[
          { label: "Predicted impact", value: "5.8 bps", hint: "entry average" },
          { label: "Realized slippage", value: "6.4 bps", hint: "fills vs mark" },
          { label: "Calibration drift", value: "+0.6 bps", hint: "model vs fills" },
          { label: "Realism mode", value: "Standard", hint: "order book + latency" },
          { label: "Funding accrued", value: "$18.40", hint: "paper account" },
        ].map((item, index) => (
          <div
            key={item.label}
            className={cn(
              "bg-surface px-4 py-3 sm:px-5",
              index === 4 && "col-span-2 sm:col-span-1",
            )}
          >
            <p className="text-[9.5px] text-faint">{item.label}</p>
            <p className="num mt-1 text-[13px] font-semibold text-ink">{item.value}</p>
            <p className="mt-0.5 text-[8.5px] text-faint">{item.hint}</p>
          </div>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-5 py-4 sm:px-6">
          <div className="w-full sm:w-[220px]">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search coin or reason"
              aria-label="Search trades"
              leading={<Search size={12} strokeWidth={2} aria-hidden="true" />}
              className="h-8 bg-surface text-[11.5px]"
            />
          </div>
          <Segmented
            options={[
              { value: "all", label: "All" },
              { value: "long", label: "Long" },
              { value: "short", label: "Short" },
            ]}
            value={side}
            onChange={setSide}
            ariaLabel="Filter by side"
          />
          <div className="w-[132px]">
            <Select
              value={result}
              onChange={(event) => setResult(event.target.value as ResultFilter)}
              aria-label="Filter by result"
              className="h-8 text-[11.5px]"
            >
              <option value="all">All results</option>
              <option value="wins">Wins</option>
              <option value="losses">Losses</option>
            </Select>
          </div>
          <p className="ml-auto text-[10.5px] text-faint">
            {filtered.length} {filtered.length === 1 ? "trade" : "trades"}
          </p>
        </div>

        {rows.length ? (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[900px] border-collapse text-left">
              <thead>
                <tr className="border-y border-line">
                  {["Closed", "Coin", "Side", "Entry", "Exit", "Size", "Net P&L", "ROE", "Exit reason"].map(
                    (label, index) => (
                      <th
                        key={label}
                        scope="col"
                        className={cn(
                          "px-3 py-2.5 text-[10px] font-medium text-faint",
                          index === 0 && "pl-6",
                          index > 2 && index < 8 && "text-right",
                          index === 8 && "pl-3 pr-6",
                        )}
                      >
                        {label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((trade) => (
                  <tr
                    key={trade.id}
                    className="border-b border-line transition-colors duration-150 last:border-0 hover:bg-surface-2"
                  >
                    <td className="py-3 pl-6 pr-3">
                      <p className="text-[11px] font-medium text-ink">{ago(trade.closedAt)}</p>
                      <p className="mt-0.5 text-[9.5px] text-faint">{dateTime(trade.closedAt)}</p>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-2.5">
                        <CoinMark symbol={trade.symbol} size="sm" />
                        <div>
                          <p className="text-[11.5px] font-semibold leading-none text-ink">{trade.symbol}</p>
                          <p className="mt-1 text-[9.5px] leading-none text-muted">{trade.name}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-1.5">
                        <SidePill side={trade.side} />
                        <span className="num text-[9.5px] text-muted">{trade.leverage}×</span>
                      </div>
                    </td>
                    <td className="num px-3 py-3 text-right text-[11px] text-ink-2">{price(trade.entry)}</td>
                    <td className="num px-3 py-3 text-right text-[11px] text-ink-2">{price(trade.exit)}</td>
                    <td className="px-3 py-3 text-right">
                      <p className="num text-[11px] text-ink">{usd(trade.margin, 0)}</p>
                      <p className="num mt-0.5 text-[9.5px] text-faint">margin</p>
                    </td>
                    <td className={cn("num px-3 py-3 text-right text-[11.5px] font-semibold", trade.pnl >= 0 ? "text-pos" : "text-neg")}>
                      {signedUsd(trade.pnl)}
                    </td>
                    <td className={cn("num px-3 py-3 text-right text-[11px]", trade.roe >= 0 ? "text-pos" : "text-neg")}>
                      {trade.roe > 0 ? "+" : ""}
                      {trade.roe.toFixed(1)}%
                    </td>
                    <td className="py-3 pl-3 pr-6">
                      <Pill tone={reasonTone[trade.reason]} className="h-5 px-2 text-[9.5px]">
                        {trade.reason}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>

            <div className="md:hidden">
              {rows.map((trade) => (
                <div key={trade.id} className="border-b border-line px-5 py-3.5 last:border-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <CoinMark symbol={trade.symbol} size="sm" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-[12px] font-semibold leading-none text-ink">{trade.symbol}</p>
                          <SidePill side={trade.side} />
                        </div>
                        <p className="mt-1 truncate text-[9.5px] leading-none text-muted">{trade.name}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className={cn("num text-[12px] font-semibold", trade.pnl >= 0 ? "text-pos" : "text-neg")}>
                        {signedUsd(trade.pnl)}
                      </p>
                      <p className={cn("num mt-1 text-[9.5px]", trade.roe >= 0 ? "text-pos" : "text-neg")}>
                        {trade.roe > 0 ? "+" : ""}
                        {trade.roe.toFixed(1)}% ROE
                      </p>
                    </div>
                  </div>
                  <div className="mt-2.5 flex items-center justify-between gap-2">
                    <span className="text-[9.5px] text-faint">{dateTime(trade.closedAt)}</span>
                    <Pill tone={reasonTone[trade.reason]} className="h-5 px-2 text-[9px]">
                      {trade.reason}
                    </Pill>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <EmptyState
            icon={<Search size={17} aria-hidden="true" />}
            title="No trades match these filters"
            description="Clear the search or switch the side and result filters."
            action={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setQuery("");
                  setSide("all");
                  setResult("all");
                }}
              >
                Clear filters
              </Button>
            }
          />
        )}

        <div className="flex items-center justify-between border-t border-line px-5 py-3 sm:px-6">
          <p className="text-[10px] text-faint">
            {filtered.length
              ? `${currentPage * pageSize + 1}–${Math.min(
                  filtered.length,
                  (currentPage + 1) * pageSize,
                )} of ${filtered.length}`
              : "No trades"}
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-[10.5px]"
              disabled={currentPage === 0}
              onClick={() => setPage((value) => Math.max(0, value - 1))}
            >
              Previous
            </Button>
            <span className="num px-1 text-[10px] text-muted">
              {currentPage + 1} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2.5 text-[10.5px]"
              disabled={currentPage >= pageCount - 1}
              onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      </Card>

      <p className="px-1 text-[10px] leading-[1.5] text-faint">
        Exports use the active filters. All fills are simulated with the configured
        taker fee and slippage.
      </p>
    </div>
  );
}
