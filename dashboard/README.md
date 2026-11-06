# OI Sniper — React dashboard preview

A clean, Apple-inspired execution dashboard for the CoinGlass open-interest paper-trading bot.

Built with React 19, Vite 7, Tailwind CSS 4, TypeScript, Motion and Lucide.

This app lives in `dashboard/` and is completely independent from the bot runtime in
`src/`, `public/` and `web/`. It does not change the existing dashboard, the server or
the trading engine.

## Run locally

From the repository root:

```bash
cd dashboard
npm install
npm run dev
```

Open **http://127.0.0.1:5173**.

On Windows PowerShell, if `npm.ps1` is blocked by the execution policy, use
`npm.cmd install` and `npm.cmd run dev` instead.

For a production check:

```bash
npm run build
npm run preview
```

## Screens

| Route | Screen |
| --- | --- |
| `/` | Overview: equity curve, engine status, telemetry, positions, scanner, exposure and activity |
| `/scanner` | Full scanner with tabs, side/sort filters, execution gate, search, signal detail and L2 inspector |
| `/feed` | Raw CoinGlass market feed with OI/volume windows, search, sort and feed health |
| `/positions` | Position cards with ROE, stop/TP ladder, route, exit liquidity and trade lifecycle |
| `/performance` | Equity, drawdown, weekly returns, trade breakdown and HTML/CSV/JSON reports |
| `/history` | Filterable, paginated trades with execution-quality calibration and CSV export |
| `/strategy` | Profiles, sizing, exits, entry filters, execution gate, routing, universe, cadence and live guardrails |
| `/exchanges` | Exchange vault: API keys, test/connect/disconnect, active venue, balances and live guardrails |
| `/activity` | Scan, trade, risk and system timeline with JSONL log export and clear-view |
| `/settings` | Appearance, execution mode, CoinGlass, notifications, data/backup, reports, guide and reset |

## Included bot features

- **Paper and live execution modes.** Live mode requires a connected exchange, explicit acknowledgement and the configured guardrails. A persistent live banner and a safety menu keep the mode visible. The kill switch blocks new entries immediately.
- **Exchange connections.** Seven venues with connection state, masked keys, balances, active-venue selection and read-only price feeds. The key wizard supports API key, secret, KuCoin passphrase and testnet, with instructions per venue.
- **Safety controls.** Kill switch, panic close-all, close all, reconcile venues and reset paper account, all with confirmation where destructive.
- **Execution quality.** EQE pass/scaled/gated filter, route badges, one-way/round-trip cost, spread, depth, book freshness, max safe notional and a two-sided order-book depth chart with cross-venue route comparison.
- **Telemetry.** Signal-to-order latency (p50/p95), scrape age, book age, loop lag, venue health and reconcile.
- **Strategy.** Long/short profiles, presets, fixed-margin/fixed-quantity sizing, ROE/price risk unit, trailing start, OI/volume/price filters, profile limits, universe filters, routing, simulator realism, fees, slippage, scan cadence and live guardrails.
- **Positions and history.** Exit liquidity health, route bps, expandable lifecycle, execution-quality calibration and CSV/report exports.
- **Settings and data.** CoinGlass API key, browser notifications, backup import/export, preset link, legacy state import, sample reset and a quick guide.
- **Interaction.** Start/pause engine, manual scans, open/close/undo, command menu (`⌘K`), light/dark/system themes, reduced motion, responsive navigation and keyboard-accessible controls.

## Notes

- This is a **UI preview with local sample data**. It does not call the bot API or an exchange.
- Live mode, exchange keys, guardrails and test-connection results are simulated in the browser. No real order is submitted and API secrets are never stored or committed.
- Numbers are simulated for the interface and reset on reload. Use Settings → Sample data to reset manually.
- The account, strategy rules and feature surface mirror the bot in the repository root. The screens are intentionally not wired to the bot API yet.
- To connect it later, point the store actions at the bot endpoints (`/api/dashboard`, `/api/settings`, `/api/scan`, `/api/trade/*`) and keep paper mode as the default.

## Design system

- Warm neutral canvas, white 20px surfaces, hairline rules and a compact translucent toolbar
- One blue accent for actions and selection; green and red only for money and directional state
- One dark engine surface anchors the overview without turning the whole product into a terminal
- System-sans typography (Inter bundle), tabular numerals, 10–14px UI type and 4/8px spacing rhythm
- Hand-built SVG charts: one accent series, 2px line, 3–5 gridlines, no chart library, no pie or gauge
- Motion is state-only: page fades, toasts, command menu and scan countdown, with a reduced-motion path
- Safe defaults: paper mode on load, destructive actions confirmed, live route clearly marked in red