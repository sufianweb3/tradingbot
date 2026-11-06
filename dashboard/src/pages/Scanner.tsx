import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  ScanLine,
  ScanSearch,
  Search,
  X,
} from "lucide-react";
import {
  defaultStrategy,
  type Coin,
  type FilterRow,
  type Side,
} from "../lib/data";
import {
  ago,
  cn,
  pct,
  price,
  usd,
} from "../lib/format";
import { executionFor, statusTone } from "../lib/execution";
import { useApp } from "../store/AppStore";
import {
  Button,
  Card,
  CoinMark,
  DataRow,
  EmptyState,
  Input,
  PageHeader,
  Pill,
  SectionHead,
  Segmented,
  Select,
  SidePill,
  Switch,
} from "../components/ui";
import { DivergingBar, Meter, Sparkline } from "../components/charts";
import { ExecutionInspector } from "../components/ExecutionInspector";

type ScannerTab = "qualified" | "near" | "all";
type ExecutionFilter = "all" | "PASS" | "SCALED" | "BLOCKED";
type SortKey = "score" | "oi5m" | "vol1h" | "change1h";

function coinValue(coin: Coin, filter: FilterRow) {
  if (filter.kind === "oi") {
    const key = `oi${filter.timeframe}` as keyof Coin;
    return Number(coin[key] ?? 0);
  }
  if (filter.kind === "price") {
    const key = `change${filter.timeframe}` as keyof Coin;
    return Number(coin[key] ?? 0);
  }
  const key = `vol${filter.timeframe}` as keyof Coin;
  return Number(coin[key] ?? 0);
}

function filterPass(value: number, filter: FilterRow) {
  return filter.operator === "≥" ? value >= filter.value : value <= filter.value;
}

export default function ScannerPage() {
  const {
    coins,
    scanNow,
    lastScan,
    notify,
    openTrade,
  } = useApp();
  const [tab, setTab] = useState<ScannerTab>("qualified");
  const [query, setQuery] = useState("");
  const [autoTrade, setAutoTrade] = useState(true);
  const [execFilter, setExecFilter] = useState<ExecutionFilter>("all");
  const [sideFilter, setSideFilter] = useState<"all" | Side>("all");
  const [sortKey, setSortKey] = useState<SortKey>("score");
  const [inspectCoin, setInspectCoin] = useState<Coin | null>(null);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(
    coins.find((coin) => coin.status === "qualified")?.symbol ?? null,
  );

  const qualified = coins.filter((coin) => coin.status === "qualified");
  const near = coins.filter((coin) => coin.status === "near");
  const execCounts = useMemo(() => {
    const counts = { PASS: 0, SCALED: 0, BLOCKED: 0 };
    for (const coin of coins) counts[executionFor(coin).status] += 1;
    return counts;
  }, [coins]);

  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return coins.filter((coin) => {
      const matchesTab =
        tab === "all" ||
        (tab === "qualified" && coin.status === "qualified") ||
        (tab === "near" && coin.status === "near");
      const matchesQuery =
        !normalized ||
        `${coin.symbol} ${coin.name}`.toLowerCase().includes(normalized);
      const matchesExecution =
        execFilter === "all" || executionFor(coin).status === execFilter;
      const matchesSide = sideFilter === "all" || coin.direction === sideFilter;
      return matchesTab && matchesQuery && matchesExecution && matchesSide;
    }).sort((a, b) => b[sortKey] - a[sortKey]);
  }, [coins, execFilter, query, sideFilter, sortKey, tab]);

  const selected =
    coins.find((coin) => coin.symbol === selectedSymbol) ??
    visible[0] ??
    qualified[0] ??
    coins[0];

  const toggleAutoTrade = (next: boolean) => {
    setAutoTrade(next);
    notify(
      next ? "Auto-trade enabled" : "Auto-trade paused",
      next
        ? "Qualified signals will open paper positions on the next scan."
        : "Signals keep updating. Nothing opens automatically.",
    );
  };

  const selectCoin = (symbol: string) => {
    setSelectedSymbol(symbol);
    if (typeof window !== "undefined" && window.innerWidth < 1280) {
      window.setTimeout(() => {
        const target = document.getElementById("signal-detail");
        target?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
            ? "auto"
            : "smooth",
          block: "start",
        });
      }, 80);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="Live scanner"
        subtitle="Every crypto pair in the CoinGlass universe, ranked by open-interest and volume expansion."
        actions={
          <>
            <div className="flex h-9 items-center gap-2.5 rounded-full border border-line bg-surface px-3.5">
              <span className="text-[11px] font-medium text-muted">Auto-trade</span>
              <Switch checked={autoTrade} onChange={toggleAutoTrade} label="Auto-trade" />
            </div>
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

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-4">
        {[
          { label: "Qualified", value: `${qualified.length}`, hint: "ready to trade" },
          { label: "Near miss", value: `${near.length}`, hint: "within 30% of a filter" },
          { label: "Universe", value: "412", hint: "coins with a live venue" },
          { label: "Last scan", value: ago(lastScan), hint: "30 second cadence" },
        ].map((item) => (
          <div key={item.label} className="bg-surface px-4 py-4 sm:px-5">
            <p className="text-[10px] text-muted">{item.label}</p>
            <p className="num mt-1.5 text-[18px] font-semibold tracking-[-0.02em] text-ink">
              {item.value}
            </p>
            <p className="mt-0.5 text-[9.5px] text-faint">{item.hint}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-12 items-start gap-4 lg:gap-5">
        <div className="col-span-12 min-w-0 space-y-4 sm:space-y-5 xl:col-span-8">
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 px-5 pt-5 sm:px-6">
            <Segmented
              options={[
                { value: "qualified", label: "Qualified", count: qualified.length },
                { value: "near", label: "Near miss", count: near.length },
                { value: "all", label: "All coins", count: coins.length },
              ]}
              value={tab}
              onChange={(next) => setTab(next)}
              ariaLabel="Scanner list"
            />
            <div className="ml-auto w-full sm:w-[180px]">
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search coin"
                aria-label="Search coins"
                leading={<Search size={12} strokeWidth={2} aria-hidden="true" />}
                className="h-8 bg-surface text-[11.5px]"
              />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line px-5 pt-3 sm:px-6">
            <span className="text-[9.5px] text-faint">Execution gate</span>
            <div className="max-w-full overflow-x-auto no-scrollbar">
              <Segmented
                options={[
                  { value: "all", label: "All rows", count: coins.length },
                  { value: "PASS", label: "Pass", count: execCounts.PASS },
                  { value: "SCALED", label: "Scaled", count: execCounts.SCALED },
                  { value: "BLOCKED", label: "Gated", count: execCounts.BLOCKED },
                ]}
                value={execFilter}
                onChange={setExecFilter}
                ariaLabel="Execution gate filter"
              />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <div className="w-[102px]">
                <Select
                  value={sideFilter}
                  onChange={(event) =>
                    setSideFilter(event.target.value as "all" | Side)
                  }
                  aria-label="Filter by side"
                  className="h-8 text-[10.5px]"
                >
                  <option value="all">All sides</option>
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </Select>
              </div>
              <div className="w-[118px]">
                <Select
                  value={sortKey}
                  onChange={(event) => setSortKey(event.target.value as SortKey)}
                  aria-label="Sort scanner"
                  className="h-8 text-[10.5px]"
                >
                  <option value="score">Score</option>
                  <option value="oi5m">OI 5m</option>
                  <option value="vol1h">Volume 1h</option>
                  <option value="change1h">Price 1h</option>
                </Select>
              </div>
            </div>
          </div>

          <div className="mt-3 hidden overflow-x-auto md:block">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="border-y border-line">
                  <th className="py-2.5 pl-6 pr-3 text-[10px] font-medium text-faint" scope="col">Coin</th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-medium text-faint" scope="col">Price</th>
                  <th className="px-3 py-2.5 text-[10px] font-medium text-faint" scope="col">OI 5m</th>
                  <th className="px-3 py-2.5 text-[10px] font-medium text-faint" scope="col">Volume 1h</th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-medium text-faint" scope="col">1h</th>
                  <th className="w-[112px] px-3 py-2.5 text-[10px] font-medium text-faint" scope="col">Execution</th>
                  <th className="w-[62px] px-3 py-2.5 text-right text-[10px] font-medium text-faint" scope="col">Score</th>
                  <th className="w-10 py-2.5 pl-2 pr-5" scope="col"><span className="sr-only">Inspect</span></th>
                </tr>
              </thead>
              <tbody>
                {visible.map((coin) => {
                  const active = selected?.symbol === coin.symbol;
                  const exec = executionFor(coin);
                  return (
                    <tr
                      key={coin.symbol}
                      tabIndex={0}
                      onClick={() => selectCoin(coin.symbol)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          selectCoin(coin.symbol);
                        }
                      }}
                      aria-label={`Inspect ${coin.symbol}`}
                      className={cn(
                        "cursor-pointer border-b border-line transition-colors duration-150 last:border-0",
                        active ? "bg-accent-soft" : "hover:bg-surface-2",
                      )}
                    >
                      <td className="py-3 pl-6 pr-3">
                        <div className="flex items-center gap-2.5">
                          <CoinMark symbol={coin.symbol} size="sm" />
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <p className="text-[12px] font-semibold leading-none text-ink">{coin.symbol}</p>
                              <SidePill side={coin.direction} />
                              {coin.reentry ? (
                                <Pill tone="warn" className="h-5 px-1.5 text-[9px]">
                                  Re-entry {coin.reentry}
                                </Pill>
                              ) : null}
                            </div>
                            <p className="mt-1 truncate text-[10px] leading-none text-muted">{coin.name}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right">
                        <p className="num text-[12px] font-medium text-ink">{price(coin.price)}</p>
                        <p className={cn("num mt-0.5 text-[10px]", coin.change24h >= 0 ? "text-pos" : "text-neg")}>
                          {pct(coin.change24h)} 24h
                        </p>
                      </td>
                      <td className="w-[108px] px-3 py-3">
                        <p className="num text-[11.5px] font-medium text-ink">{pct(coin.oi5m)}</p>
                        <DivergingBar value={coin.oi5m} max={6} className="mt-1.5" />
                      </td>
                      <td className="w-[110px] px-3 py-3">
                        <p className="num text-[11.5px] font-medium text-ink">{pct(coin.vol1h, 1)}</p>
                        <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-surface-3">
                          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, coin.vol1h)}%` }} />
                        </div>
                      </td>
                      <td className={cn("num px-3 py-3 text-right text-[11.5px] font-medium", coin.change1h >= 0 ? "text-pos" : "text-neg")}>
                        {pct(coin.change1h)}
                      </td>
                      <td className="px-3 py-3">
                        <Pill tone={statusTone[exec.status]} className="h-5 px-2 text-[8.5px]">
                          {exec.status}
                        </Pill>
                        <p className="mt-1 truncate text-[9px] text-faint">
                          {exec.route} at {exec.oneWayBps.toFixed(1)} bps
                        </p>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <span className="num text-[11px] font-semibold text-ink">{coin.score}</span>
                          <Meter value={coin.score} className="w-8" />
                        </div>
                      </td>
                      <td className="py-3 pl-2 pr-5 text-right">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            setInspectCoin(coin);
                          }}
                          title={`Inspect ${coin.symbol} execution`}
                          aria-label={`Inspect ${coin.symbol} execution`}
                          className={cn(
                            "flex h-7 w-7 items-center justify-center rounded-full transition-colors duration-150 hover:bg-accent-soft hover:text-accent",
                            active ? "text-accent" : "text-faint",
                          )}
                        >
                          <ScanSearch size={14} strokeWidth={1.8} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="md:hidden">
            {visible.map((coin) => (
              <button
                key={coin.symbol}
                type="button"
                onClick={() => selectCoin(coin.symbol)}
                className={cn(
                  "flex w-full items-center gap-3 border-b border-line px-5 py-3 text-left transition-colors duration-150 last:border-0",
                  selected?.symbol === coin.symbol ? "bg-accent-soft" : "hover:bg-surface-2",
                )}
              >
                <CoinMark symbol={coin.symbol} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-[12px] font-semibold leading-none text-ink">{coin.symbol}</p>
                    <SidePill side={coin.direction} />
                    <Pill
                      tone={statusTone[executionFor(coin).status]}
                      className="h-4 px-1.5 text-[8px]"
                    >
                      {executionFor(coin).status}
                    </Pill>
                  </div>
                  <p className="mt-1 truncate text-[9.5px] leading-none text-muted">
                    {coin.name}, OI 5m {pct(coin.oi5m)}, Vol {pct(coin.vol1h, 1)}
                  </p>
                </div>
                <div className="text-right">
                  <p className="num text-[11.5px] font-medium text-ink">{price(coin.price)}</p>
                  <p className={cn("num mt-1 text-[9.5px]", coin.change1h >= 0 ? "text-pos" : "text-neg")}>
                    {pct(coin.change1h)} 1h
                  </p>
                </div>
                <ChevronRight size={13} className="shrink-0 text-faint" aria-hidden="true" />
              </button>
            ))}
          </div>

          {visible.length === 0 ? (
            <EmptyState
              icon={<Search size={17} aria-hidden="true" />}
              title="No coins match this view"
              description="Try the near-miss tab, clear the search, or run a fresh scan."
              action={
                <Button variant="secondary" size="sm" onClick={() => { setQuery(""); setTab("all"); }}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <div className="flex items-center justify-between border-t border-line px-6 py-3 text-[10px] text-faint">
              <span>Showing {visible.length} of {coins.length} coins</span>
              <span>{qualified.length} qualified right now</span>
            </div>
          )}
          </Card>
          <div className="hidden md:block">
            <ScanRules />
          </div>
        </div>

        <div id="signal-detail" className="col-span-12 min-w-0 scroll-mt-20 xl:col-span-4 xl:sticky xl:top-[80px]">
          {selected ? (
            <SignalDetail
              coin={selected}
              onOpen={() => openTrade(selected)}
              onInspect={() => setInspectCoin(selected)}
            />
          ) : (
            <Card>
              <EmptyState
                title="Select a coin"
                description="Pick a row to inspect its signal, filter checks and trade plan."
              />
            </Card>
          )}
        </div>
      </div>

      <ExecutionInspector
        coin={inspectCoin}
        open={Boolean(inspectCoin)}
        onClose={() => setInspectCoin(null)}
        onTrade={(coin, side) => openTrade(coin, side)}
      />
    </div>
  );
}

function ScanRules() {
  const profiles = [
    { side: "long" as const, label: "Long", profile: defaultStrategy.long },
    { side: "short" as const, label: "Short", profile: defaultStrategy.short },
  ];

  return (
    <Card className="overflow-hidden">
      <SectionHead
        title="Scan rules"
        subtitle="Both profiles are evaluated on every pass."
        action={
          <Link
            to="/strategy"
            className="inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:text-accent-strong"
          >
            Edit strategy
            <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
          </Link>
        }
      />
      <div className="mt-4 grid gap-px border-t border-line bg-line sm:grid-cols-2">
        {profiles.map(({ side, label, profile }) => (
          <div key={side} className="bg-surface px-5 py-5 sm:px-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <SidePill side={side} />
                <span className="text-[11.5px] font-medium text-ink">{label} profile</span>
              </div>
              <span className="num text-[9.5px] text-faint">
                {profile.leverage}× leverage, {profile.allocation}% of fund
              </span>
            </div>
            <div className="mt-3 space-y-2">
              {profile.filters
                .filter((filter) => filter.enabled)
                .map((filter) => (
                  <div key={filter.id} className="flex items-center justify-between gap-3 text-[10.5px]">
                    <span className="text-muted">
                      {filter.kind === "oi"
                        ? "Open interest"
                        : filter.kind === "price"
                          ? "Price change"
                          : "Volume"}{" "}
                      {filter.timeframe}
                    </span>
                    <span className="num font-medium text-ink">
                      {filter.operator} {filter.value}%
                    </span>
                  </div>
                ))}
            </div>
            <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5 text-[9.5px] text-faint">
              <span>{profile.filters.filter((filter) => filter.enabled).length} filters active</span>
              <span>Automatic direction</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SignalDetail({
  coin,
  onOpen,
  onInspect,
}: {
  coin: Coin;
  onOpen: () => void;
  onInspect: () => void;
}) {
  const { mode } = useApp();
  const strategy = defaultStrategy[coin.direction];
  const checks = strategy.filters.filter((filter) => filter.enabled);
  const execution = executionFor(coin);
  const isLong = coin.direction === "long";
  const leverage = strategy.leverage;
  const moveRatio = (roe: number) => roe / leverage / 100;
  const entry = coin.price;
  const stop = isLong ? entry * (1 - moveRatio(strategy.stopLoss)) : entry * (1 + moveRatio(strategy.stopLoss));
  const tp1 = isLong ? entry * (1 + moveRatio(strategy.tp1)) : entry * (1 - moveRatio(strategy.tp1));
  const tpMax = isLong ? entry * (1 + moveRatio(strategy.tpMax)) : entry * (1 - moveRatio(strategy.tpMax));

  return (
    <Card className="overflow-hidden">
      <div className="px-5 pt-5 sm:px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <CoinMark symbol={coin.symbol} size="lg" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-[16px] font-semibold leading-none tracking-[-0.02em] text-ink">
                  {coin.symbol}
                </p>
                <SidePill side={coin.direction} />
                <Pill
                  tone={statusTone[execution.status]}
                  className="h-5 px-1.5 text-[8.5px]"
                >
                  {execution.status}
                </Pill>
              </div>
              <p className="mt-1.5 truncate text-[11px] text-muted">{coin.name} perpetual</p>
            </div>
          </div>
          <div className="text-right">
            <p className="num text-[16px] font-semibold leading-none tracking-[-0.02em] text-ink">
              {price(coin.price)}
            </p>
            <p className={cn("num mt-1.5 text-[10.5px]", coin.change1h >= 0 ? "text-pos" : "text-neg")}>
              {pct(coin.change1h)} 1h
            </p>
          </div>
        </div>

        <div className="mt-4 rounded-[12px] border border-line bg-surface-2 px-3 py-2">
          <Sparkline data={coin.spark} fluid tone={coin.change1h >= 0 ? "pos" : "neg"} className="h-12" />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
          {[
            { label: "OI 5m", value: pct(coin.oi5m) },
            { label: "OI 1h", value: pct(coin.oi1h) },
            { label: "Volume 1h", value: pct(coin.vol1h, 1) },
            { label: "Live venues", value: `${coin.venues.length}` },
          ].map((item) => (
            <div key={item.label}>
              <p className="text-[9.5px] text-faint">{item.label}</p>
              <p className="num mt-1 text-[12px] font-medium text-ink">{item.value}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <div className="flex items-center justify-between">
            <p className="text-[11.5px] font-medium text-ink">Signal strength</p>
            <p className="num text-[11.5px] font-semibold text-ink">{coin.score} / 100</p>
          </div>
          <Meter value={coin.score} className="mt-2 h-1.5" />
          <p className="mt-2 text-[10px] leading-[1.45] text-muted">
            Ranked against the full universe on OI expansion, volume and venue depth.
          </p>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <p className="text-[11.5px] font-medium text-ink">Filter checks</p>
          <div className="mt-2 space-y-2">
            {checks.map((filter) => {
              const value = coinValue(coin, filter);
              const pass = filterPass(value, filter);
              return (
                <div key={filter.id} className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                      pass ? "bg-pos-soft text-pos" : "bg-neg-soft text-neg",
                    )}
                  >
                    {pass ? (
                      <Check size={10} strokeWidth={2.6} aria-hidden="true" />
                    ) : (
                      <X size={10} strokeWidth={2.6} aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1 text-[10.5px] text-ink-2">
                    {filter.kind === "oi" ? "Open interest" : filter.kind === "price" ? "Price" : "Volume"} {filter.timeframe}{" "}
                    <span className="text-faint">{filter.operator} {filter.value}%</span>
                  </span>
                  <span className={cn("num text-[10.5px] font-medium", pass ? "text-pos" : "text-neg")}>
                    {pct(value)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-5 border-t border-line pt-4">
          <p className="text-[11.5px] font-medium text-ink">
            {mode === "live" ? "Live trade plan" : "Paper trade plan"}
          </p>
          <div className="mt-2.5 space-y-2">
            <DataRow label="Entry" value={price(entry)} />
            <DataRow label="Stop loss" value={`${price(stop)} at ${strategy.stopLoss}% ROE`} tone="neg" />
            <DataRow label="TP1, close 50%" value={`${price(tp1)} at ${strategy.tp1}% ROE`} tone="pos" />
            <DataRow label="Max TP" value={`${price(tpMax)} at ${strategy.tpMax}% ROE`} />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {coin.venues.map((venue) => (
            <Pill key={venue} tone="neutral" className="h-5 px-2 text-[9.5px]">
              {venue}
            </Pill>
          ))}
        </div>

        <div className="mt-5 flex items-stretch gap-2">
          <Button
            variant="secondary"
            size="md"
            className="flex-1"
            onClick={onInspect}
            icon={<ScanSearch size={14} strokeWidth={1.9} aria-hidden="true" />}
          >
            Inspect
          </Button>
          <Button
            variant="primary"
            size="md"
            className="flex-[1.45]"
            onClick={onOpen}
            disabled={Boolean(coin.reentry)}
            icon={<ArrowUpRight size={14} strokeWidth={2} aria-hidden="true" />}
          >
            {coin.reentry
              ? `Re-entry in ${coin.reentry}`
              : mode === "live"
                ? "Open live trade"
                : "Open paper trade"}
          </Button>
        </div>
        <p className="mt-2 pb-5 text-center text-[9.5px] leading-[1.4] text-faint">
          $500 margin. Leverage and exits follow the {coin.direction} profile.
          {mode === "live" ? " Orders route through the active exchange." : " All fills are simulated."}
        </p>
      </div>
    </Card>
  );
}
