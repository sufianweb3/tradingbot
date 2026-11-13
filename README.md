# OI Sniper - CoinGlass screener + paper-trading bot

A local, browser-based **paper-trading** bot. It screens the full CoinGlass market
table for open-interest and volume percentage moves, prices every coin from public
exchange feeds, and simulates leveraged trades with a configurable exit plan.

Run **up to 20 strategies side by side** (5-7 is a comfortable target), each with
its own fund, filters, sizing, exit plan, positions and trade history. All
strategies share one exchange hub and one CoinGlass snapshot, so running several
accounts does not multiply the network load.

Nothing is ever sent to an exchange. All fills, fees, slippage, PnL and reports are
simulated in local JSON files.

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
| `DATA_DIR` | `./data`       | Runtime data (`strategies/`, AI dataset) |

---

## Dashboard

The default dashboard is the vanilla app at `/`. A React dashboard is also built
from `dashboard/` and served at **`/dashboard/`**; it uses the same JSON API, keeps
paper mode as the default and shows whether it is connected to the bot or running
on sample data. Build it with `npm run build` (or `npm run build:dashboard` to
refresh only the React app).

- **Strategy bar** - chips for every paper account with live P/L, a portfolio
  summary (equity, P/L, open trades, running count), and **+ New strategy**,
  **Start all**, **Pause all** and **Compare** actions. Click a chip or table row
  to open that account.
- **Strategy comparison** - one row per account: state, fund, equity, P/L,
  return, open/closed trades, win rate, max drawdown and leverage. Start/pause or
  edit a strategy directly from the table.
- **Strategy settings** (left panel) - capital, leverage, sizing, SL/TP, trailing,
  OI/volume filters with per-row on/off toggles, direction, universe limits, max
  trades, scan/refresh timing, fees, venues. Every field belongs to the selected
  strategy only.
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

**New strategy** creates an empty paper account. Choose a name, a fund and
optionally a strategy to clone the settings from; cloning copies rules only, never
trades or positions. **Edit** renames an account or changes its fund, and
**Delete** removes its state file (the last remaining strategy cannot be deleted).
The CoinGlass API key is shared by the whole portfolio.

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

### Same-coin lock (12 hours)

The bot never opens a new trade on a coin while that coin is inside its
same-coin lock window. The lock is **on by default for 12 hours** and starts
from the coin's latest trade activity:

| Setting | Default | Meaning |
| ------- | ------- | ------- |
| Block same-coin re-entry | On | Off = the coin may trade again as soon as the filters pass after a close. |
| Lock window (minutes) | 720 | No new trade on that coin for this long after its latest open, partial exit or close. |

The lock is per coin: closing BTC blocks only BTC, so ETH can be entered
immediately. It is enforced from **trade history and live positions**, not just
the last close:

- A coin with an open position is locked from its entry time.
- A closed trade is locked from the later of its entry, partial-exit and close
  times, so a fast close still leaves a full 12-hour window.
- Stats are rebuilt from `state.trades` + `state.positions` on startup, so a
  restart, backup import or manual open cannot bypass the lock.
- The delay also applies to manual opens.
- While the lock is on, it takes precedence over **Max positions per coin**:
  stacking a second entry on the same coin is blocked until the window expires.

A coin that passes the filters but is inside the lock appears in the **coins**
tab with a `LOCKED <time>` badge and a disabled trade button showing the
remaining time. The scan log also says why nothing opened, e.g.:

```
Qualified: 2, opened 0 - 2 locked by the same-coin rule (SXT (10h 58m), ARX (11h 3m)).
```

To allow stacking again, turn **Block same-coin re-entry** off (or set the lock
window to `0`). States created before this option existed are migrated once to
the 12-hour default; after that the switch is respected.


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

If a browser cannot reach `capi.coinglass.com` directly (ad blockers, strict
tracking protection, corporate proxies or regional blocking), the dashboard
falls back to the same-origin `/api/coinglass/markets?page=N` proxy. The local
Node server and the Vercel function at `api/coinglass/markets.js` fetch and
decrypt the page server-side, so the browser only talks to its own origin.

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
> and Startup return an error).

### Device feed (scrape from your browser)

When no API key is stored, the dashboard tab itself scrapes CoinGlass with the
same encrypted endpoint and pushes the rows to the engine. Nothing to enable:
press **Start** (or just open the dashboard) and the feed begins.

- **Fast lane** - one request for page 1 (top 100 by OI) every ~0.7 s, then a
  small merge push to the engine every 5 s.
- **Full lane** - all 7 pages every 30 s, replacing the table so every coin is
  current.
- The engine prefers a feed younger than **90 s** over any server-side scrape, so
  the engine produces signals without an API key. The window is wide because
  browsers throttle hidden tabs to about one timer per minute.
- The badge under *CoinGlass live data* shows `device feed · top N coins · ms`.
- **The tab must stay open, and ideally visible.** Closed tabs stop the feed;
  hidden tabs are throttled by the browser (Chrome: ~1/min) and may be frozen
  after a while. Locally, the Node process keeps scraping on its own regardless.

### Polling budget

The dashboard combines live state and the screener into one `/api/dashboard`
request every 4 s and polls `/api/trades` every 30 s. Tabs elect a leader through
a localStorage heartbeat: only that tab pushes the device feed, and other tabs
poll once every ~25 s instead of every 4 s. If the leader is closed, another tab
takes over within ~10 s. Keep at least one tab open for the device feed.


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

All endpoints return JSON unless noted. Endpoints that act on one account accept
an optional `strategy=<id>` query parameter (GET) or `strategy` field in the JSON
body (POST); without it the selected strategy is used. The old single-strategy API
is therefore unchanged.

| Method | Path                | Purpose |
| ------ | ------------------- | ------- |
| GET    | `/api/health`       | Liveness, portfolio counts, CoinGlass connection state |
| GET    | `/api/strategies`   | `{ selectedId, strategies, portfolio }` |
| POST   | `/api/strategies`   | Create: `{ name, fund, settings?, cloneFrom?, start? }` |
| POST   | `/api/strategies/select` | Select the active account: `{ id }` |
| GET    | `/api/strategies/:id` | One strategy summary, settings and stats |
| POST   | `/api/strategies/:id` | Update name/fund (and optionally start/pause) |
| DELETE | `/api/strategies/:id` | Delete an account and its state file |
| GET    | `/api/compare`      | Same payload as `/api/strategies` |
| GET    | `/api/bootstrap`    | Settings, stats, markets, trades, curve, logs, portfolio |
| GET    | `/api/live`         | Stats, positions, curve, logs, venues, CoinGlass status |
| GET    | `/api/dashboard`    | Live state + screener rows + meta + portfolio in one request |
| GET    | `/api/markets`      | Screener rows + meta (auto-refreshes CoinGlass after 60s) |
| GET    | `/api/config`       | Settings, initial fund, stats |
| GET    | `/api/trades`       | Paginated closed trades (`limit`, `offset`) |
| GET    | `/api/report`       | HTML / CSV / JSON report (`format`, `download`) |
| GET    | `/api/logs`         | Download bot activity log + collected dataset as JSONL (`download`, `dataset=0`) |
| POST   | `/api/settings`     | Save settings (`{ settings: {...}, strategy? }` or a flat object) |
| POST   | `/api/coinglass/key`| Set `{ apiKey }` or clear `{ clear: true }` the shared CoinGlass key |
| POST   | `/api/device/market`| Browser feed: `{ coins, merge, total, pages }` |
| POST   | `/api/control`      | `start`, `pause`, `toggle`, `reset`, `close-all`, `start-all`, `pause-all`, `close-all-strategies` |
| POST   | `/api/scan`         | Manual scan (dry-run while paused) |
| POST   | `/api/trade/open`   | `{ symbol, force }` manual paper entry |
| POST   | `/api/trade/close`  | `{ id, reason }` manual close (the account is found automatically) |

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

- Portfolio config lives in `data/strategies/index.json`; each strategy has its own
  snapshot at `data/strategies/<id>.json`.
- The old single-account `data/state.json` is adopted automatically as the
  `main` strategy on first boot of V3. It is kept in place, so no history is lost.
- Writes are debounced (500 ms) and flushed atomically via a temp file.
- A corrupt strategy file is renamed to `<file>.corrupt-<timestamp>` and a fresh
  account is created for that strategy only.
- The bot always loads **paused** after a local restart. Open paper positions are
  restored and managed, but no new trades open until you press Start.
- **Reset** keeps the strategy's settings and clears its trades/PnL/history.
- Changing **Total fund** resets that paper account because the fund defines the
  run. Other strategies are unaffected.
- Deleting a strategy removes its snapshot file and index entry; the last
  remaining strategy cannot be deleted.

---

## AI trade dataset (passive logger)

The local server attaches a read-only logger after the engine starts. It never
changes filters, sizing, positions or execution; it only listens to the existing
`trade` events and samples state once per second while a position is open.

Each trade gets its own folder under `data/ai-dataset/<strategy-id>/` (one
observer per strategy, so accounts stay separate):

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

On the static browser deployment the endpoint returns the activity log only, because
the Web Worker has no filesystem for the dataset folders.

Environment variables (optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_TRADE_LOG` | `1` | Set to `0` to disable the logger completely |
| `AI_DATASET_DIR` | `data/ai-dataset` | Where trade folders are written |
| `AI_TRADE_INTERVAL_MS` | `1000` | Sampling interval (minimum 250 ms) |

The logger is local-only. It is not attached in the static Web Worker, where
there is no filesystem; runtime state there remains in IndexedDB.

---

## Static browser deployment

`npm run build` produces a self-contained `dist/` folder that can be hosted on any
static file server. In that mode the dashboard runs the engine inside a dedicated
Web Worker and persists state in IndexedDB, so no backend process is needed.

- The static build is single-account: the Web Worker runtime does not host the
  multi-strategy `Portfolio` yet.
- Run the local Node server (`npm start`) to use the multi-strategy dashboard and
  the `/api/strategies` endpoints.
- CoinGlass signals come from the browser device feed (tab open) or the optional
  API key; exchange pricing uses the public venue APIs.
- State and stored credentials live in the browser profile, not in the bundle.

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
scripts/server.js      zero-dependency local HTTP server + JSON API
scripts/build.js       copies public/, web/ and src/ into dist/ and builds the dashboard
web/worker.js          browser Web Worker runtime (single-account static mode)
web/api.js             worker RPC client; prefers the Node API when it is reachable
web/routes.js          worker-side /api/* handlers
web/store-idb.js       IndexedDB persistence for the browser runtime
src/coinglass.js       encrypted CoinGlass fetch/decrypt + official API client
src/exchanges.js       multi-venue discovery, symbol resolution, quotes
src/marketFeed.js      shared CoinGlass cache, device feed and connection status
src/portfolio.js       multi-strategy lifecycle, persistence and API payloads
src/trading.js         pure filters, levels, PnL, stats, positionAction
src/engine.js          per-strategy scan loop, trades, positions, persistence
src/core/reentryGuard.js  per-coin 12h lock from trade history + live positions
src/aiDataset.js       passive AI trade dataset logger (observer only)
src/logExport.js       streams activity log + dataset as one downloadable JSONL
src/store.js           defaults, normalisation, JSON store
src/report.js          HTML/CSV/JSON reports + SVG equity chart
scripts/ai-export.mjs  streams the AI dataset into one JSONL file
public/                dashboard (vanilla HTML/CSS/JS, no build step)
dashboard/             React dashboard (Vite, served at /dashboard/)
test/                  node:test suites
data/strategies/       portfolio index + one JSON snapshot per strategy (git-ignored)
data/state.json        legacy single-account state, migrated as "main" (git-ignored)
js/, home.html         local-only CoinGlass reference bundle (git-ignored)
```

---

## Versioning

- Releases are tagged `V1`, `V2`, `V3`, ... on `main`.
- `package.json` follows the same major (`V1` = `1.x.x`, `V3` = `3.x.x`).
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
- On the static browser deployment, CoinGlass and some venues can reject requests
  from the browser's network; the device feed and the optional API key help.
- The static browser deployment runs one account. Multi-strategy accounts need the
  local Node server.
- Public exchange endpoints can be geo-blocked (notably OKX on some networks).
- Intra-tick gaps can fill stops at the mark price, which may be worse than the
  configured stop.
- Past performance is not indicative of future results. This is not financial
  advice.
