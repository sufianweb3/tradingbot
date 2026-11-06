import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, RefreshCw, Search } from "lucide-react";
import type { Coin } from "../lib/data";
import { ago, cn, pct, price } from "../lib/format";
import { useApp } from "../store/AppStore";
import {
  Button,
  Card,
  CoinMark,
  EmptyState,
  Input,
  PageHeader,
  Pill,
  SectionHead,
  Select,
  SidePill,
} from "../components/ui";
import { DivergingBar } from "../components/charts";

type FeedSort = "oi5m" | "oi1h" | "vol1h" | "change24h" | "symbol";

export default function FeedPage() {
  const { coins, lastScan, scanNow, running } = useApp();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<FeedSort>("oi5m");

  const rows = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return coins
      .filter(
        (coin) =>
          !normalized ||
          `${coin.symbol} ${coin.name}`.toLowerCase().includes(normalized),
      )
      .sort((a, b) => {
        if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
        return Number(b[sort]) - Number(a[sort]);
      });
  }, [coins, query, sort]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="Market feed"
        subtitle="The raw crypto market table from CoinGlass, before the strategy filters run."
        actions={
          <>
            <Link to="/scanner">
              <Button variant="ghost" size="md" icon={<ArrowUpRight size={14} strokeWidth={1.9} aria-hidden="true" />}>
                Open scanner
              </Button>
            </Link>
            <Button
              variant="secondary"
              size="md"
              onClick={scanNow}
              icon={<RefreshCw size={14} strokeWidth={1.9} aria-hidden="true" />}
            >
              Refresh feed
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-3 lg:grid-cols-5">
        {[
          { label: "Feed status", value: running ? "Connected" : "Paused", hint: "CoinGlass browser feed" },
          { label: "Coins in view", value: "412", hint: "14 in this sample" },
          { label: "Pages", value: "7", hint: "crypto-only table" },
          { label: "Data age", value: "190 ms", hint: "last successful scrape" },
          { label: "Refresh", value: "30 sec", hint: "scan cadence" },
        ].map((item, index) => (
          <div
            key={item.label}
            className={cn(
              "bg-surface px-4 py-4 sm:px-5",
              index === 4 && "col-span-2 sm:col-span-2 lg:col-span-1",
            )}
          >
            <p className="text-[10px] text-muted">{item.label}</p>
            <p className="num mt-1.5 text-[17px] font-semibold tracking-[-0.02em] text-ink">{item.value}</p>
            <p className="mt-0.5 text-[9.5px] text-faint">{item.hint}</p>
          </div>
        ))}
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 px-5 py-4 sm:px-6">
          <div className="w-full sm:w-[250px]">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search coin"
              aria-label="Search market feed"
              leading={<Search size={12} strokeWidth={2} aria-hidden="true" />}
              className="h-8 bg-surface text-[11.5px]"
            />
          </div>
          <div className="w-[150px]">
            <Select
              value={sort}
              onChange={(event) => setSort(event.target.value as FeedSort)}
              aria-label="Sort feed"
              className="h-8 text-[11px]"
            >
              <option value="oi5m">OI 5m high to low</option>
              <option value="oi1h">OI 1h high to low</option>
              <option value="vol1h">Volume 1h high to low</option>
              <option value="change24h">24h change high to low</option>
              <option value="symbol">Symbol A to Z</option>
            </Select>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Pill tone={running ? "pos" : "warn"} dot pulse={running}>
              {running ? "Streaming" : "Paused"}
            </Pill>
            <span className="text-[10px] text-faint">Updated {ago(lastScan)}</span>
          </div>
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[1040px] border-collapse text-left">
            <thead>
              <tr className="border-y border-line">
                <th className="py-2.5 pl-6 pr-3 text-[10px] font-medium text-faint" scope="col">Coin</th>
                <th className="px-3 py-2.5 text-right text-[10px] font-medium text-faint" scope="col">Price</th>
                <th className="px-3 py-2.5 text-[10px] font-medium text-faint" scope="col">OI 5m</th>
                <th className="px-3 py-2.5 text-right text-[10px] font-medium text-faint" scope="col">OI 15m</th>
                <th className="px-3 py-2.5 text-right text-[10px] font-medium text-faint" scope="col">OI 1h</th>
                <th className="px-3 py-2.5 text-right text-[10px] font-medium text-faint" scope="col">OI 4h</th>
                <th className="px-3 py-2.5 text-right text-[10px] font-medium text-faint" scope="col">Vol 1h</th>
                <th className="px-3 py-2.5 text-right text-[10px] font-medium text-faint" scope="col">Vol 4h</th>
                <th className="px-3 py-2.5 text-right text-[10px] font-medium text-faint" scope="col">1h</th>
                <th className="px-3 py-2.5 text-right text-[10px] font-medium text-faint" scope="col">24h</th>
                <th className="px-3 py-2.5 text-[10px] font-medium text-faint" scope="col">Venues</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((coin) => (
                <tr key={coin.symbol} className="border-b border-line transition-colors duration-150 last:border-0 hover:bg-surface-2">
                  <td className="py-3 pl-6 pr-3">
                    <div className="flex items-center gap-2.5">
                      <CoinMark symbol={coin.symbol} size="sm" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <p className="text-[12px] font-semibold leading-none text-ink">{coin.symbol}</p>
                          <SidePill side={coin.direction} />
                        </div>
                        <p className="mt-1 truncate text-[9.5px] leading-none text-muted">{coin.name}</p>
                      </div>
                    </div>
                  </td>
                  <td className="num px-3 py-3 text-right text-[11.5px] text-ink">{price(coin.price)}</td>
                  <td className="w-[110px] px-3 py-3">
                    <p className="num text-[11px] font-medium text-ink">{pct(coin.oi5m)}</p>
                    <DivergingBar value={coin.oi5m} max={6} className="mt-1.5" />
                  </td>
                  <td className={cn("num px-3 py-3 text-right text-[10.5px]", coin.oi15m >= 0 ? "text-ink" : "text-ink-2")}>{pct(coin.oi15m)}</td>
                  <td className={cn("num px-3 py-3 text-right text-[10.5px]", coin.oi1h >= 0 ? "text-ink" : "text-ink-2")}>{pct(coin.oi1h)}</td>
                  <td className={cn("num px-3 py-3 text-right text-[10.5px]", coin.oi4h >= 0 ? "text-ink" : "text-ink-2")}>{pct(coin.oi4h)}</td>
                  <td className="num px-3 py-3 text-right text-[10.5px] text-ink">{pct(coin.vol1h, 1)}</td>
                  <td className="num px-3 py-3 text-right text-[10.5px] text-ink">{pct(coin.vol4h, 1)}</td>
                  <td className={cn("num px-3 py-3 text-right text-[10.5px]", coin.change1h >= 0 ? "text-pos" : "text-neg")}>{pct(coin.change1h)}</td>
                  <td className={cn("num px-3 py-3 text-right text-[10.5px]", coin.change24h >= 0 ? "text-pos" : "text-neg")}>{pct(coin.change24h)}</td>
                  <td className="px-3 py-3">
                    <span className="text-[9px] leading-[1.3] text-muted">{coin.venues.join(", ")}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="md:hidden">
          {rows.map((coin) => (
            <div key={coin.symbol} className="border-b border-line px-5 py-3 last:border-0">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <CoinMark symbol={coin.symbol} size="sm" />
                  <div>
                    <div className="flex items-center gap-1.5">
                      <p className="text-[12px] font-semibold text-ink">{coin.symbol}</p>
                      <SidePill side={coin.direction} />
                    </div>
                    <p className="mt-1 text-[9.5px] text-muted">{coin.name}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="num text-[11.5px] font-medium text-ink">{price(coin.price)}</p>
                  <p className={cn("num mt-1 text-[9.5px]", coin.change1h >= 0 ? "text-pos" : "text-neg")}>
                    {pct(coin.change1h)} 1h
                  </p>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[9.5px]">
                <span className="text-muted">OI 5m <b className="num text-ink">{pct(coin.oi5m)}</b></span>
                <span className="text-muted">OI 1h <b className="num text-ink">{pct(coin.oi1h)}</b></span>
                <span className="text-muted">Vol 1h <b className="num text-ink">{pct(coin.vol1h, 0)}</b></span>
                <span className="text-muted">24h <b className={cn("num", coin.change24h >= 0 ? "text-pos" : "text-neg")}>{pct(coin.change24h)}</b></span>
              </div>
            </div>
          ))}
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={<Search size={17} aria-hidden="true" />}
            title="No coins match this search"
            description="Clear the search or refresh the CoinGlass feed."
            action={
              <Button variant="secondary" size="sm" onClick={() => setQuery("")}>
                Clear search
              </Button>
            }
          />
        ) : (
          <div className="flex flex-col gap-1 border-t border-line px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <p className="text-[10px] text-faint">
              Showing {rows.length} sample rows of 412 crypto pairs
            </p>
            <p className="text-[10px] text-faint">Source: CoinGlass browser feed</p>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-12 gap-4 lg:gap-5">
        <Card className="col-span-12 sm:col-span-6">
          <SectionHead title="Feed notes" subtitle="What this table represents" />
          <div className="space-y-2.5 px-5 pb-5 pt-5 sm:px-6">
            <p className="text-[10.5px] leading-[1.6] text-muted">
              The feed is crypto-only. TradFi indices, commodities and tokenised equities are
              removed before the rows reach the scanner. A coin enters the scanner when it has a
              live price venue and passes the active OI, volume or price filters.
            </p>
            <Link to="/scanner" className="inline-flex items-center gap-1 text-[10.5px] font-medium text-accent">
              See qualified signals
              <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
            </Link>
          </div>
        </Card>
        <Card className="col-span-12 sm:col-span-6">
          <SectionHead title="Feed health" subtitle="Last scrape and device lane" />
          <div className="px-5 pb-5 pt-5 sm:px-6">
            <div className="space-y-2.5">
              {[
                { label: "Fast lane", value: "Top 100 rows, 0.7s" },
                { label: "Full lane", value: "7 pages, 30s" },
                { label: "Data age", value: "190 ms" },
                { label: "Last scan", value: ago(lastScan) },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between text-[10.5px]">
                  <span className="text-muted">{row.label}</span>
                  <span className="num text-ink">{row.value}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 border-t border-line pt-3 text-[9.5px] leading-[1.5] text-faint">
              Keep this tab visible for the fastest browser feed. Hidden tabs refresh less often.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
