# Changelog

All notable changes to this project are documented here.

Releases are tagged `V1`, `V2`, ... on `main`, and `package.json` uses the matching
SemVer major (`V1` = `1.x.x`). Runtime data is never committed.

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
