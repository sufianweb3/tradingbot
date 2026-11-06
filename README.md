# OI Sniper - CoinGlass screener + paper-trading bot

A local, browser-based **paper-trading** bot. It screens the full CoinGlass market
table for open-interest and volume percentage moves, prices every coin from public
exchange feeds, and simulates leveraged trades with a configurable exit plan.

Nothing is ever sent to an exchange. All fills, fees, slippage, PnL and reports are
simulated in a local JSON file.

```
CoinGlass OI / volume %  ──►  filter + rank  ──►  open paper trade
                                                    │
                    public exchange tickers  ──►  mark / TP / SL / trail
                                                    │
                                             stats + equity curve + report
```

---

## Quick start

Requirements: **Node.js 20+** (tested on Node 26). There are **no npm dependencies**.

```bat
cd D:\OpenCode\projects\oi_bot
npm.cmd start
```

Then open <http://127.0.0.1:3000>.

> On Windows PowerShell, `npm.ps1` may be blocked by the execution policy. Use
> `npm.cmd start` (or plain `node server.js`). If port 3000 is busy, set `PORT`:
>
> ```bat
> set PORT=3100
> node server.js
> ```

The server starts with the bot **paused**, because filters are intentionally blank
by default. Configure at least one OI/Volume row in the dashboard, press
**Save & apply**, then **Start bot**.

### Environment variables

| Variable   | Default        | Meaning                          |
| ---------- | -------------- | -------------------------------- |
| `PORT`     | `3000`         | HTTP port                        |
| `HOST`     | `127.0.0.1`    | Bind address (local only)        |
| `DATA_DIR` | `./data`       | Where `state.json` is persisted  |

---

## Dashboard

- **Strategy settings** (left panel) - capital, leverage, sizing, SL/TP, trailing,
  OI/volume filters with per-row on/off toggles, direction, universe limits, max
  trades, scan/refresh timing, fees, venues.
- **KPI strip** - equity, total P/L, open P/L, win rate, profit factor, max
  drawdown, trade count, fees.
- **CoinGlass connection** - a green **Connected** / red **Disconnected** pill in
  the top bar. It reflects the last scrape attempt against `capi.coinglass.com`;
  hover it for the last success time, data age, latency, coin count and last
  error.
- **CoinGlass live data** - a dedicated real-time feed of everything the bot
  scraped, crypto only, in the format **coin name · OI 5m % · Volume 1h %**. Sort
  by biggest move, OI high/low, or volume high/low; search by coin; the footer
  shows how many rows are displayed and when the data was last refreshed.
- **Open positions** - live ROE, progress bar, current stop, TP levels, distance
  to TP1/stop, manual close.
- **Live scanner** - *Qualified* / *Near miss* / *All* tabs, search, per-row
  pass/fail colouring and one-click manual trade.
- **Fund PnL** - equity curve with hover tooltip and initial-fund baseline.
- **Trade history** - filterable, paginated, CSV export.
- **Activity log** - newest-first engine events.
- **Report** - downloads a self-contained HTML report (equity SVG + full trade
  history). `CSV` and `JSON` exports are also available from the API.
- **Reset** - clears trades, PnL, equity curve and history; keeps settings.

Settings are only applied when you press **Save & apply**. Unsaved changes show an
`unsaved` badge. Changing **Total fund** mid-run resets the paper account (the fund
defines the run).

---

## Strategy rules

### 1. Signals (CoinGlass)

Percent changes are taken from the CoinGlass market table:

| Group        | Timeframes              | Fields |
| ------------ | ----------------------- | ------ |
| Open interest | 5m, 15m, 30m, 1h, 4h  | `m5OiChangePercent`, `m15OiChangePercent`, `m30OiChangePercent`, `h1OiChangePercent`, `h4OiChangePercent` |
| Volume        | 1h, 4h                  | `h1VolChangePercent`, `h4VolChangePercent` |

Every **enabled** row with a numeric threshold must pass (`≥` or `≤`). Rows are
**off and blank by default** - a blank/disabled row is ignored entirely. If no row
is configured, scans report `no-filters` and no trades open.

**Direction** is `auto` by default:

- all enabled OI filters use `≥` → **long**
- all enabled OI filters use `≤` → **short**
- mixed OI operators → direction cannot be inferred; set *Trade direction*
  explicitly (otherwise the coin cannot qualify)

You can force `long` or `short` in the settings.

### 2. Universe

- The complete CoinGlass table is downloaded (about 1,030 coins, 11 pages).
- A coin is tradable when at least one enabled price venue lists it.
  *Use CoinGlass price if no exchange feed exists* is **off** by default, which
  keeps non-crypto rows (gold, oil, indices) out of the trade universe.
- Stablecoins and wrapped majors are excluded by default; edit the comma-separated
  list in the dashboard.
- Optional minimum OI and 24h-volume filters apply before a coin can trade.

### 3. Entry and sizing

Each qualifying coin is evaluated and opened independently within a scan - the bot
does **not** wait for every coin before acting. Default sizing:

- Total fund **$500**
- Allocation **50% of the initial fund** per trade → **$250 margin**
- Leverage **50x** → **$12,500 notional**
- Entry fee **0.05%** and slippage **0.02%** per side (configurable)

Trades are limited by free margin. Changing `maxOpenPositions` or `maxTrades`
(0 = unlimited) can cap the run. When max trades is reached the bot pauses itself
and the report is ready to download.

### Re-entry on the same coin

| Setting | Default | Meaning |
| ------- | ------- | ------- |
| Max positions per coin | 1 | `1` = classic one-at-a-time rule. Raise it to stack several entries into the same move (e.g. `3` while a coin dumps). |
| Re-enter trade (same coin) | Off | Off = the coin may trade again at the next scan as soon as the filters pass after a close. On = the delay below applies. |
| Delay (minutes) | 30 | When **Re-enter trade** is on, no new trade opens on that coin for this many minutes, counted from the close time. |

The delay is per coin: closing BTC blocks only BTC, so ETH can be entered
immediately. It is also applied to manual opens and survives a server restart
(the last close per coin is stored in the state snapshot). Setting the delay to
`0` while the switch is on behaves the same as off.

Each entry is an independent position with its own SL/TP/trailing, so stacking
`3` means three separate $250-margin entries (limited by free margin and
`maxOpenPositions`). States created before this option existed are migrated from
the old 300-second cooldown to the off state.

The **Qualified** tab only counts coins that can trade *right now*. A coin that
passes the filters but is inside its re-entry delay appears in the **coins** tab
with a `RE-ENTRY <time>` badge and a disabled trade button showing the remaining
time. The scan log also says why nothing opened, e.g.:

```
Qualified: 2, opened 0 - 2 in re-entry delay (SXT (10h 58m), ARX (11h 3m)).
```


### 4. Exits

SL/TP values are **ROE (% of margin)** by default. The equivalent price move is:

```
price move % = ROE % / leverage
```

At 50x: SL 20% → 0.4% price move; TP1 50% → 1%; TP max 1000% → 20%.
Switch *Risk unit* to `price` to use raw coin-price percentages instead.

Defaults:

| Rule                | Default | Behaviour |
| ------------------- | ------- | --------- |
| Stop loss           | 20% ROE | Closes the whole remaining position |
| TP1                 | 50% ROE | Closes 50% of the original quantity |
| TP1 close           | 50%     | Portion closed at TP1 |
| Trailing stop       | on      | Starts after TP1; 20% ROE trail from the peak |
| Max TP              | 1000% ROE | Closes the runner |
| Liquidation guard   | -       | Approximate 1/leverage − 0.5% maintenance |

After TP1 the remainder trails from the highest (long) / lowest (short) price seen.
The trail is armed in the same tick as the TP1 partial exit. Realised TP1 cash is
counted in equity and statistics while the runner is still open.

### 5. Fees, slippage and marks

- Taker fee is charged on entry and on every exit (default 0.05%/side).
- Slippage moves the fill against you on entry and exit (default 0.02%/side).
- Prices come from public exchange tickers. Per-position quotes refresh every 2s
  (configurable). If the primary feed fails, the bot tries up to two other venues,
  then falls back to the last cached quote for up to two minutes.

---

## Report and statistics

The report includes an equity curve and the complete trade history. Statistics:

- Equity, total P/L and return %
- Realised and unrealised P/L
- Total trades, wins, losses, breakeven, win rate
- Profit factor (gross profit / gross loss)
- Average trade, average win/loss, expectancy
- Max drawdown ($ and %) calculated from the equity curve
- Best/worst trade, long/short breakdown, win/loss streaks
- Fees paid (closed + open entry + estimated exit fees)

Download from the dashboard, or directly:

```
GET /api/report?format=html&download=1
GET /api/report?format=csv&download=1
GET /api/report?format=json&download=1
```

---

## Price venues

Public tickers are used, with no API keys:

| Key      | Venue    | Instrument style |
| -------- | -------- | ---------------- |
| `mexc`   | MEXC     | `BTC_USDT`       |
| `gate`   | Gate.io  | `BTC_USDT`       |
| `kucoin` | KuCoin   | `XBTUSDTM`       |
| `binance`| Binance  | `BTCUSDT`        |
| `bybit`  | Bybit    | `BTCUSDT`        |
| `bitget` | Bitget   | `BTCUSDT`        |
| `okx`    | OKX      | `BTC-USDT-SWAP`  |

Discovery downloads every venue's 24h tickers, picks the venue with the deepest
24h quote volume for each coin, and caches the map for 10 minutes. Venue failures
are shown in the dashboard; the bot keeps running with the remaining venues.

> OKX is supported but may return Cloudflare `403` from some networks. The other
> venues continue to work and the venue status panel shows the error.

---

## CoinGlass data

The public website's internal endpoint is used (no API key):

```
https://capi.coinglass.com/api/home/v2/coinMarkets
  ?sort=openInterest&order=desc&keyword=&pageNum=N&pageSize=100&ex=all&tags=crypto
```

`tags=crypto` mirrors the **Crypto** tab of CoinGlass's *All / Crypto / TradFi /
Spot / Categories* ribbon, so TradFi stocks, indices and commodities (XAU, CL,
NVDA, SPY, …) are never returned. Tokenised equities that CoinGlass still files
under crypto (rows carrying a `stockSymbol`, e.g. `US_RGTI`) are dropped as a
second safety net.

Responses are AES-128-ECB encrypted + gzipped. `src/coinglass.js` implements the
two-layer decryption in Node:

1. `key0 = base64(pathname)[:16]` when the `v` header is `1`
2. `AES-128-ECB(user header, key0) → gunzip → actual key`
3. `AES-128-ECB(data field, actual key) → gunzip → JSON`

If CoinGlass changes its encryption version or endpoint, the dashboard shows the
fetch error and existing cached signals are used for up to 5 minutes. New trades
are not opened from signal data older than 2.5 minutes.

The top-bar indicator reports **Connected** after a successful scrape and
**Disconnected** after a failed one. The scraped rows are shown live in the
*CoinGlass live data* panel. `/api/health` exposes the same state as
`coinglass`, `coinglassConnected`, `coinglassCoins`, `coinglassSource` and
`coinglassApiKeySet`.

### Optional official API key

By default the bot scrapes the website and needs no key. If you have a
CoinGlass API plan (Standard or above), paste the key into **Strategy settings →
CoinGlass data source** and press **Save key**. The bot then calls:

```
GET https://open-api-v4.coinglass.com/api/futures/coins-markets
  ?exchange_list=Binance,OKX,Bybit,Gate,KuCoin,MEXC,Bitget&per_page=100&page=N
  CG-API-KEY: <your key>
```

- Key present → official API (`source: "api"`).
- Key empty → website scraper (`source: "scrape"`).
- The key is **write-only**: it is stored in the state snapshot but every API
  response returns `coinglassApiKey: ""` plus `coinglassKeySet: true|false`.
- Saving the normal settings form never clears a stored key. Use **Clear key**
  to fall back to scraping.
- Saving or clearing a key drops the signal cache so the next scan uses the new
  source immediately.

> The official `coins-markets` endpoint requires a **Standard** plan (Hobbyist
> and Startup return an error). On Cloudflare Workers this is the only working
> CoinGlass path, because CoinGlass blocks Cloudflare's egress IPs from the
> scraper endpoint.

### Device feed (scrape from your browser)

When no API key is stored, the dashboard tab itself scrapes CoinGlass with the
same encrypted endpoint and pushes the rows to the engine. Nothing to enable:
press **Start** (or just open the dashboard) and the feed begins.

- **Fast lane** - one request for page 1 (top 100 by OI) every ~0.7 s, then a
  small merge push to the engine every 5 s.
- **Full lane** - all 7 pages every 30 s, replacing the table so every coin is
  current.
- The engine prefers a feed younger than **90 s** over any server-side scrape, so
  the Cloudflare deployment produces signals without an API key. The window is
  wide because browsers throttle hidden tabs to about one timer per minute.
- The badge under *CoinGlass live data* shows `device feed · top N coins · ms`.
- **The tab must stay open, and ideally visible.** Closed tabs stop the feed;
  hidden tabs are throttled by the browser (Chrome: ~1/min) and may be frozen
  after a while. Locally, the Node process keeps scraping on its own regardless.

### Cloudflare request budget (free plan)

Workers Free allows **100,000 Durable Object requests per day**, and every HTTP
request, alarm and WebSocket message counts. The first version polled
`/api/live` + `/api/markets` every 1-1.5 s and pushed the device feed every 2 s,
which is about **219k/day** - the live bot was therefore killed by the quota
after roughly 11 hours.

The current design budgets about **47k/day idle / 76k/day with an open position**:

| Source | Rate | Requests/day |
| ------ | ---- | ------------ |
| `/api/dashboard` (live + markets in one response) | 4 s | 21.6k |
| Device feed fast push | 5 s | 17.3k |
| Device feed full push | 30 s | 2.9k |
| `/api/trades` | 30 s | 2.9k |
| Scan alarm | 30 s | 2.9k |
| Price-tick alarm (only while a position is open) | 3 s | 28.8k |

The price loop now stops completely when flat, and the dashboard pauses network
polling while the tab is hidden. Tabs elect a leader through a localStorage
heartbeat: only that tab pushes the device feed, and any other tab polls once
every ~25 s instead of every 4 s. If the leader is closed, another tab takes
over within ~10 s. Keep at least one tab open.

If the quota is exhausted the Worker returns `500`. The dashboard shows a
banner, pauses requests for 60 s, and resumes automatically. The daily limit
resets at **00:00 UTC**. The Workers Paid plan ($5/mo) removes the daily cap.


### Latency

Measured from this network against the live endpoint:

| Stage | Before | Now |
| --- | --- | --- |
| Market cache TTL | 10 s | 0.9 s |
| `/api/markets` refresh gate | 60 s | 0.9 s, served from cache (no blocking) |
| Dashboard row poll | 7 s | 4 s for server flags; local device rows ~0.7 s |
| Full 671-coin scrape | ~1.3 s (4 at a time) | ~1.0 s (all pages parallel) |
| Top-100 refresh | - | ~0.48 s (one request) |
| Browser → cloud push (100 rows, 35 KB) | - | ~0.2 s |
| `/api/dashboard` response | 1.2-2.5 s (blocking) | ~0.25 s |

Final measured loop against the live worker: scrape **480 ms** → push **204 ms** →
engine reports data age **~190 ms**. The rows the engine trades on are therefore
well under a second old, refreshed continuously, instead of up to a minute.

Two hard limits remain:

1. A single CoinGlass request is ~350-700 ms from a home connection, so a
   guaranteed sub-500 ms round trip is not physically possible. Continuous
   refresh keeps it at one request of lag.
2. CoinGlass only republishes OI/volume percentages every ~1-2 s (measured:
   15 polls in 8.7 s, 4 value changes), so polling faster than that returns
   identical numbers.

Requests are throttled to ~1 per second per source, and a failed scrape backs
off for 20 s instead of retrying on every poll.

---

## HTTP API

All endpoints return JSON unless noted.

| Method | Path                | Purpose |
| ------ | ------------------- | ------- |
| GET    | `/api/health`       | Liveness, running flag, counts, CoinGlass connection state |
| GET    | `/api/bootstrap`    | Settings, stats, markets, trades, curve, logs |
| GET    | `/api/live`         | Stats, positions, curve, logs, venues, CoinGlass status |
| GET    | `/api/dashboard`    | Live state + screener rows + meta in one request (used by the UI) |
| GET    | `/api/markets`      | Screener rows + meta (auto-refreshes CoinGlass after 60s) |
| GET    | `/api/config`       | Settings, initial fund, stats |
| GET    | `/api/trades`       | Paginated closed trades (`limit`, `offset`) |
| GET    | `/api/report`       | HTML / CSV / JSON report (`format`, `download`) |
| GET    | `/api/logs`         | Download bot activity log + collected dataset as JSONL (`download`, `dataset=0`) |
| POST   | `/api/settings`     | Save settings (`{ settings: {...} }` or a flat object) |
| POST   | `/api/coinglass/key`| Set `{ apiKey }` or clear `{ clear: true }` the CoinGlass key |
| POST   | `/api/device/market`| Browser feed: `{ coins, merge, total, pages }` |
| POST   | `/api/control`      | `start`, `pause`, `toggle`, `reset`, `close-all` |
| POST   | `/api/scan`         | Manual scan (dry-run while paused) |
| POST   | `/api/trade/open`   | `{ symbol, force }` manual paper entry |
| POST   | `/api/trade/close`  | `{ id, reason }` manual close |

---

## Tests

```bat
npm.cmd test
```

The suite uses Node's built-in test runner and covers filter evaluation, ROE/price
level math, SL/TP/trailing/liquidation actions, partial-exit accounting, statistics,
settings normalisation, report rendering, position sizing and engine close paths.

---

## Persistence

- State lives in `data/state.json` (or `$DATA_DIR/state.json`).
- Writes are debounced (500 ms) and flushed atomically via a temp file.
- A corrupt state file is renamed to `state.json.corrupt-<timestamp>` and a fresh
  account is created.
- The bot always loads **paused** after a restart locally. Open paper positions
  are restored and managed, but no new trades open until you press Start. On
  Cloudflare the Durable Object resumes a run that was active before eviction.
- **Reset** keeps your settings and clears trades/PnL/history.
- Changing **Total fund** resets the paper account because the fund defines the
  run.

---

## AI trade dataset (passive logger)

The local server attaches a read-only logger after the engine starts. It never
changes filters, sizing, positions or execution; it only listens to the existing
`trade` events and samples state once per second while a position is open.

Each trade gets its own folder under `data/ai-dataset/`:

```
data/ai-dataset/
  index.jsonl                      open/close index for quick discovery
  <entry-time>_<symbol>_<side>_<id>/
    trade.json                     settings, coin row, signal, plan, entry
    ticks.jsonl                    one JSON line per second while open
    events.jsonl                   open, partial, close and resume events
    summary.json                   final PnL, ROE, exit reason and stats
```

What is recorded:

- **Settings** at entry: every filter/timeframe, direction, sizing, leverage,
  fees, slippage, TP/SL/trailing and max-position rule.
- **Coin data** at entry: the exact screener row (`Coin`, price, OI 5m/15m/30m/
  1h/4h, Volume 1h/4h, venue, signal, score, pass count) plus the raw CoinGlass
  coin object (OI USD, volume USD, funding, 1h/24h price changes).
- **Trade data**: margin, notional, quantity, leverage, fees, entry/signal price,
  SL/TP1/TP max/liquidation levels, trailing settings and the signal checks.
- **Price history**: every second from entry to close, including the exchange
  quote, engine mark, stale/fallback flags, unrealized PnL/ROE, distances to
  SL/TP and the live CoinGlass row for that coin.
- **Outcome**: final trade object, exit reason, fees paid, PnL, ROE, duration
  and account statistics after the close.

Export everything into one JSONL file for AI processing:

```bat
npm.cmd run ai:export
```

The export is written to `data/ai-export/ai-trades-<timestamp>.jsonl` with a
matching `.manifest.json`. Pass custom folders with
`npm.cmd run ai:export -- <dataset-dir> <output-dir>`.

The dashboard's **Download logs** button (Activity log panel) downloads the same
kind of file without stopping the bot: bot activity log entries first, then the
AI dataset (`ai-trade`, `ai-tick`, `ai-event`, `ai-summary`) as JSONL. The API
equivalent is:

```bat
GET /api/logs?download=1
GET /api/logs?download=1&dataset=0   :: activity log only
```

On the Cloudflare deployment the endpoint returns the activity log only, because
Workers have no filesystem for the dataset folders.

Environment variables (optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_TRADE_LOG` | `1` | Set to `0` to disable the logger completely |
| `AI_DATASET_DIR` | `data/ai-dataset` | Where trade folders are written |
| `AI_TRADE_INTERVAL_MS` | `1000` | Sampling interval (minimum 250 ms) |

The logger is local-only. It is not attached in the Cloudflare Worker, where
there is no filesystem; runtime state there remains in Durable Object storage.

---

## Cloudflare deployment (24/7)

The bot can run entirely on Cloudflare, so the dashboard is reachable at any
time and the engine keeps scanning even when your computer is off.

**Live dashboard:** <https://oi-sniper.ashogexplore.workers.dev>

Architecture:

```
Browser ──► Worker (cf/index.js)
              ├── /api/*  ──► EngineDO (one Durable Object, named "main")
              │                 ├── engine state in DO SQLite storage
              │                 └── scanning/pricing via DO alarms
              └── everything else ──► env.ASSETS (public/)
```

- `cf/do.js` - Durable Object router, mirrors the local JSON API and resumes a
  running bot after eviction.
- `cf/store.js` - storage adapter so the engine persists to DO storage instead
  of `data/state.json`.
- `cf/timers.js` - maps the engine's `setTimeout`/`clearTimeout` onto the single
  Durable Object alarm.
- `wrangler.jsonc` - Worker, assets binding, DO binding and SQLite migration.

Commands:

```bat
npm.cmd run cloud:deploy     :: deploy to Cloudflare
npm.cmd run cloud:tail       :: stream live logs
```

Notes:

- CoinGlass, Binance, MEXC and Bitget reject Cloudflare's egress IPs (`403`).
  Cloud spot pricing falls back to OKX / Bybit / Gate / KuCoin; CoinGlass signals
  come from the browser device feed (tab open) or the optional API key.
- State and the stored key live in the Durable Object, not in the Worker bundle.
- The free Workers plan supports this stack (one Durable Object, SQLite-backed),
  but only if the request budget above is respected.
- A Durable Object keeps running the code version it started with, so after
  changing engine code bump `ENGINE_GENERATION` in `cf/build.js`. That starts a
  fresh paper account; settings and the API key must be re-entered.

### Cloudflare MCP server

The project registers Cloudflare's managed MCP server in `opencode.json`:

```json
{
  "mcp": {
    "servers": {
      "cloudflare-api": {
        "type": "remote",
        "url": "https://mcp.cloudflare.com/mcp"
      }
    }
  }
}
```

Open `/mcps` in OpenCode → `cloudflare-api` → sign in. The server endpoint is
<https://mcp.cloudflare.com/mcp>.

---

## Project structure

```
server.js              zero-dependency HTTP server + JSON API
cf/index.js            Cloudflare Worker entry (API → DO, else static assets)
cf/do.js               Durable Object: engine host + HTTP API
cf/store.js            Durable Object storage adapter
cf/timers.js           alarm-backed setTimeout/clearTimeout
wrangler.jsonc         Cloudflare bindings + migrations
src/coinglass.js       encrypted CoinGlass fetch/decrypt + official API client
src/exchanges.js       multi-venue discovery, symbol resolution, quotes
src/trading.js         pure filters, levels, PnL, stats, positionAction
src/engine.js          scan loop, trade opening, position management, persistence
src/aiDataset.js       passive AI trade dataset logger (observer only)
src/logExport.js       streams activity log + dataset as one downloadable JSONL
src/store.js           defaults, normalisation, JSON store
src/report.js          HTML/CSV/JSON reports + SVG equity chart
scripts/ai-export.mjs  streams the AI dataset into one JSONL file
public/                dashboard (vanilla HTML/CSS/JS, no build step)
test/                  node:test suites
data/state.json        local runtime state (created on first run, git-ignored)
js/, home.html         local-only CoinGlass reference bundle (git-ignored)
```

---

## Versioning

- Releases are tagged `V1`, `V2`, ... on `main`.
- `package.json` follows the same major (`V1` = `1.x.x`).
- `CHANGELOG.md` records every release; add a new section before tagging.
- Runtime state under `data/` and local secrets are never committed.

---

## Limitations

- **Paper only.** No orders, balances, funding, borrow or liquidation engine from a
  real venue. Liquidation is an approximation.
- Fills are all-or-nothing at the quoted price ± slippage; no order book, partial
  fills, latency or market impact.
- CoinGlass is scraped from an undocumented internal endpoint by default. It can
  change or rate-limit without notice; the optional official API key avoids the
  scraper entirely.
- On Cloudflare, CoinGlass blocks the scraper endpoint from Workers IPs, so the
  cloud deployment needs the official API key for signals.
- Public exchange endpoints can be geo-blocked (notably OKX on some networks).
- Intra-tick gaps can fill stops at the mark price, which may be worse than the
  configured stop.
- Past performance is not indicative of future results. This is not financial
  advice.
