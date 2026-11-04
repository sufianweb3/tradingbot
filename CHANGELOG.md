# Changelog

All notable changes to this project are documented here.

Releases are tagged `V1`, `V2`, ... on `main`, and `package.json` uses the matching
SemVer major (`V1` = `1.x.x`). Runtime data is never committed.

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
