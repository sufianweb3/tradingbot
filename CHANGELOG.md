# Changelog

All notable changes to this project are documented here.

Releases are tagged `V1`, `V2`, ... on `main`, and `package.json` uses the matching
SemVer major (`V1` = `1.x.x`). Runtime data is never committed.

## [Unreleased]

### Added

- Trade history now shows the entry snapshot for every closed trade: OI change
  (5m/15m/30m/1h/4h), volume change (1h/4h) and price change (5m/1h).
- The CSV export includes the same nine entry-signal columns.
- CoinGlass market rows now carry the 5m price change (server, API and browser
  device feed), and positions store it in their `signal` snapshot.

### Fixed

- Vercel preview builds no longer fail with `Missing script: "build"`.
  `npm run build` copies the static dashboard into `dist/`, and `vercel.json`
  proxies `/api/*` to the Cloudflare Worker so previews stay functional.

## [V3] - 2026-11-07

### Added

- **Multi-strategy portfolio.** Run up to 20 independent paper accounts (5–7 is a
  comfortable target) at the same time. Each strategy has its own fund, filters,
  sizing, exit plan, positions, trades, equity curve, logs and JSON state file.
- `src/portfolio.js` owns strategy lifecycle: create, clone, rename, select,
  start/pause one or all, reset, delete, compare and portfolio-wide summaries.
- `src/marketFeed.js` extracts the CoinGlass cache/device feed/connection status
  so every strategy reads one shared snapshot instead of scraping N times.
- Shared `ExchangeHub` across strategies, plus in-flight quote coalescing for
  accounts holding the same coin.
- Dashboard **strategy bar** with live chips, portfolio totals and start-all /
  pause-all / compare actions; **strategy comparison** table with per-row
  start/pause/edit; **create/clone** dialog and delete action.
- New API: `/api/strategies`, `/api/strategies/select`, `/api/strategies/:id`,
  `/api/compare`; existing endpoints accept an optional `strategy` parameter and
  default to the selected account.
- `test/portfolio.test.js` covers isolation, cloning, persistence, legacy
  migration, selection, start/pause, deletion and shared API keys.

### Changed

- Local persistence moved to `data/strategies/index.json` plus
  `data/strategies/<id>.json`. The legacy `data/state.json` is adopted as the
  `main` strategy on first boot, so existing history is preserved.
- AI dataset folders are namespaced per strategy: `data/ai-dataset/<id>/`.
- Cloudflare Durable Object storage is namespaced per strategy (`state:<id>`),
  with the legacy `state` key reused for the migrated `main` account.
- Cloudflare engine generation bumped to `g10`.
- Version bumped to `3.0.0`.

## [V2] - 2026-11-04

### Added

- Explicit **Re-enter trade (same coin)** switch plus a **Delay (minutes)** field.
  With the switch off, a coin can trade again at the next scan after a close;
  with it on, that coin is blocked for the configured delay from its close time.
  The delay is persisted per coin and survives server restarts.
- **Download logs** button in the Activity log panel. It streams one JSONL file
  containing the bot activity log and the passive AI trade dataset (entry, ticks,
  events and summaries), with `/api/logs` as the API equivalent.
- `src/logExport.js` shared export streamer and unit tests for the export format.

### Changed

- Re-entry delay is configured in minutes in the dashboard; the engine still
  stores an effective `cooldownSec` so older API clients keep working.
- The scanner uses `RE-ENTRY <time>` and "re-entry delay" wording instead of
  the old "cooling"/"cooldown" labels.
- Cloudflare engine generation bumped to `g9`.

### Fixed

- The re-entry delay now derives its value from `reenterEnabled` and
  `reenterDelayMin` at runtime, so a state saved with a stale `cooldownSec: 0`
  cannot bypass the 30-minute block. Restart the bot after deploying so the new
  engine build loads; the saved close times are rebuilt from trade history.

## [V1] - 2026-11-04

Initial public release.

### Added

- CoinGlass open-interest / volume screener with an encrypted public-endpoint
  client and an optional official API key.
- Multi-exchange public price feeds (Binance, MEXC, Bitget, OKX, Bybit, Gate,
  KuCoin).
- Paper-trading engine: position sizing, leverage, fees, slippage, TP/SL,
  trailing stops and a liquidation approximation.
- Zero-dependency Node.js server with JSON persistence and a REST API.
- Browser dashboard: live scanner, CoinGlass feed, open positions, KPIs, equity
  curve, trade history and HTML/CSV/JSON reports.
- Cloudflare Workers deployment backed by a SQLite Durable Object engine.
- Unit tests for the engine and trading math (`node --test`).

### Notes

- Paper trading only — no orders are ever sent to an exchange.
- Runtime state (`data/`), secrets, and the local CoinGlass reference bundle
  (`js/`, `home.html`) are not tracked.
