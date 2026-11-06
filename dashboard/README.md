# OI Sniper: React dashboard

A clean, Apple-inspired execution dashboard for the CoinGlass open-interest paper-trading bot.

Built with React 19, Vite 7, Tailwind CSS 4, TypeScript, Motion and Lucide.

This app lives in `dashboard/`. When the bot is built it is compiled into
`dist/dashboard/` and served at **`/dashboard/`**, while the original dashboard
stays at **`/`**. It talks to the bot's JSON API on the same origin and falls back
to local sample data when the API is unreachable.

## Run locally

Two options.

**Through the bot (real API, recommended):**

```bash
npm run build      # builds public/, web/, src/ and dashboard/
npm start          # then open http://127.0.0.1:3000/dashboard/
```

On Windows PowerShell, if `npm.ps1` is blocked by the execution policy, use
`npm.cmd run build` and `npm.cmd start` instead.

For UI iteration with the bot running separately:

```bash
npm run dev:dashboard   # Vite dev server on http://127.0.0.1:5173
```

The dev server proxies `/api` to `http://127.0.0.1:3000`, so start the bot with
`npm start` in another terminal to see live data.

**Standalone sample preview:**

```bash
cd dashboard
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. Without the bot API the dashboard renders the
bundled sample account and marks the data source as `Sample data` in the header.

For a production check of the standalone app:

```bash
npm run build
npm run preview
```

## Screens

| Route | Screen |
| --- | --- |
| `/dashboard/` | Overview: equity curve, engine status, telemetry, positions, scanner, exposure and activity |
| `/dashboard/scanner` | Full scanner with tabs, side/sort filters, execution gate, search, signal detail and L2 inspector |
| `/dashboard/feed` | Raw CoinGlass market feed with OI/volume windows, search, sort and feed health |
| `/dashboard/positions` | Position cards with ROE, stop/TP ladder, route, exit liquidity and trade lifecycle |
| `/dashboard/performance` | Equity, drawdown, weekly returns, trade breakdown and HTML/CSV/JSON reports |
| `/dashboard/history` | Filterable, paginated trades with execution-quality calibration and CSV export |
| `/dashboard/strategy` | Profiles, sizing, exits, entry filters, execution gate, routing, universe, cadence and live guardrails |
| `/dashboard/exchanges` | Exchange vault: API keys, test/connect/disconnect, active venue, balances and live guardrails |
| `/dashboard/activity` | Scan, trade, risk and system timeline with JSONL log export and clear-view |
| `/dashboard/settings` | Appearance, execution mode, CoinGlass, notifications, data/backup, reports, guide and reset |

Standalone dev/preview runs at `/` because the Vite dev server is not behind the
`/dashboard/` prefix.

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

- The dashboard is wired to the bot's same-origin JSON API: `/api/bootstrap`, `/api/dashboard`, `/api/trades`, `/api/settings`, `/api/scan`, `/api/trade/*`, `/api/exchange/*`, `/api/mode`, `/api/kill-switch`, `/api/panic`, `/api/reconcile`, `/api/control`, `/api/coinglass/key` and `/api/backup/*`.
- Paper mode is the default. Live orders are only routed after an exchange is connected, live mode is confirmed and the guardrails are saved.
- When the API cannot be reached, the store keeps the last known state or seeds the sample account and shows `Sample data` in the header. Clicking that pill retries the connection.
- API keys are sent to the bot and stored in its vault. They are never written to the repository and never returned to the browser.
- The old dashboard remains at `/`; the React app is served at `/dashboard/` with a client-side routing fallback.
- `npm run dev` builds the bot only (`--skip-dashboard`); use `npm run build` or `npm run build:dashboard` to include the React app in `dist/dashboard/`.

## Design system

- Warm neutral canvas, white 20px surfaces, hairline rules and a compact translucent toolbar
- One blue accent for actions and selection; green and red only for money and directional state
- One dark engine surface anchors the overview without turning the whole product into a terminal
- System-sans typography (Inter bundle), tabular numerals, 10–14px UI type and 4/8px spacing rhythm
- Hand-built SVG charts: one accent series, 2px line, 3–5 gridlines, no chart library, no pie or gauge
- Motion is state-only: page fades, toasts, command menu and scan countdown, with a reduced-motion path
- Safe defaults: paper mode on load, destructive actions confirmed, live route clearly marked in red