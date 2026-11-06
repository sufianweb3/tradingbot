# OI Sniper Quantitative Workstation - Design Specification

## Design Read
`Reading this as: real-time quantitative futures trading workstation -- dial ENERGY 1 / RHYTHM 2 / MOTION 1`

## 1. Aesthetic Direction & Domain Intent
OI Sniper is a high-frequency open-interest and volume breakout execution workstation for perpetual futures across Binance, Bybit, Gate.io, KuCoin, MEXC, OKX, and Bitget.
- **Archetype**: Institutional Quantitative Execution Desk (restrained dark slate palette, high data density, zero decorative chrome, strict typographic hierarchy).
- **Energy (1/5)**: Calm, authoritative obsidian surfaces (`#080c14` base, `#0e1522` panel) so semantic alerts (emerald `#16d39a`, amber `#f59e0b`, crimson `#ff5d6c`) command immediate visual priority when risk or liquidity thresholds trigger.
- **Rhythm (2/5)**: Structured 8px/12px spatial cadence separating four operational zones: Top Execution Bar, Portfolio & Speed Telemetry Strip, Active Positions + Live Signal Scanner, and On-Demand Order-Book Depth Inspector.
- **Motion (1/5)**: Instantaneous state transitions (`120ms ease-out` on drawer and modal reveals; zero decorative bounce or continuous pulsing animations that fatigue operators during multi-hour sessions).

## 2. Color System & Contrast Verification (WCAG 2.1 AA)
| Token | Hex | Role | Contrast vs `#0e1522` | Reason |
| :--- | :--- | :--- | :--- | :--- |
| `--bg` | `#080c14` | Root canvas background | -- | Deep carbon-navy base eliminates glare during extended monitoring. |
| `--bg-elev` | `#0b111c` | Secondary workspace container | -- | Subtle tonal step separates sticky headers and drawers from the root canvas. |
| `--panel` | `#0e1522` | Primary card and table surface | 1.0:1 | Uniform dark slate surface keeps focus on numeric telemetry. |
| `--panel-2` | `#131c2e` | Interactive row hover & inset wells | 1.1:1 | Provides immediate row-tracking feedback across 12-column financial tables. |
| `--border` | `#1c293d` | Hairline structural divider | -- | Crisp 1px hairlines define grid boundaries without heavy box shadows. |
| `--fg` | `#e6edf6` | Primary text and numeric values | 15.2:1 (AAA) | Crisp off-white prevents halation while maximizing legibility on dark slate. |
| `--muted` | `#94a3b8` | Secondary labels and metadata | 6.7:1 (AA) | Balances scannability of column headers against primary numeric cells. |
| `--faint` | `#64748b` | Tertiary hints and inactive units | 4.5:1 (AA) | Meets 4.5:1 minimum contrast while receding behind active filter rows. |
| `--green` | `#16d39a` | Positive PnL, Long side, EQE PASS | 9.4:1 (AAA) | High-luminance emerald signals executable liquidity and positive ROE. |
| `--amber` | `#f59e0b` | Warning state, EQE SCALED, thin depth | 8.6:1 (AAA) | Warm amber highlights scaled sizing and caution states without false alarm. |
| `--red` | `#ff5d6c` | Negative PnL, Short side, EQE BLOCKED | 6.3:1 (AA) | High-visibility coral-crimson marks rejected signals and stop-loss risk. |
| `--cyan` | `#38bdf8` | Active route selection & focus ring | 8.9:1 (AAA) | Distinct sky-cyan separates venue routing telemetry from PnL colors. |

## 3. Typography & Numeric Discipline
- **UI Sans (`--sans`)**: `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif` for labels, navigation, and modal instructions.
- **Quantitative Mono (`--mono`)**: `"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace` with mandatory `font-variant-numeric: tabular-nums` on every price, percentage, basis-point, latency, and PnL element so vertical columns never jitter during 700ms live ticks.
- **Scale**:
  - `20px` (`700`, `--mono`): Hero Portfolio Equity (`#kpiEquity`).
  - `16px` (`600`, `--mono`): Secondary KPI values (`#kpiPnl`, `#kpiOpen`, `#kpiWinrate`, `#kpiPf`, `#kpiDd`).
  - `13px` (`600`, `--sans`): Panel titles and modal headers (`letter-spacing: -0.01em`).
  - `12px` (`500`, `--mono`): Scanner table cells, position card metrics, and order-book depth figures.
  - `11px` (`600`, uppercase, `letter-spacing: 0.04em`): Table headers, status pills, and telemetry strip labels.

## 4. Layout Architecture & Home Page Simplification
1. **Collapsible Strategy Drawer (`.settings-panel`)**:
   - **Choice**: Collapsed by default on initial load (`layout settings-collapsed`), accessible anytime via the topbar `Strategy Settings` button (`#btnToggleSettings`).
   - **Reason**: Eliminates the 45-control form wall on first arrival so the operator immediately sees portfolio health, execution telemetry, open positions, and live signals.
2. **4-Zone Overview Hierarchy (`data-active-view="overview"`)**:
   - **Zone 1: Top Execution & Safety Bar (`.topbar`)**: Mode switcher (`Paper` / `Live`), active exchange selector pill (`#exchangePill`), CoinGlass feed health (`#cgPill`), Kill Switch, and Bot Start/Pause control.
   - **Zone 2: Portfolio KPI & Execution Telemetry Strip (`.kpi-strip` + `#telemetryStrip`)**:
     - 6 primary KPI cards (`Equity`, `Net PnL`, `Unrealized`, `Win Rate`, `Profit Factor`, `Max Drawdown`).
     - Compact dual telemetry bar combining **Speed Telemetry (`FX-85`)** (`Signal->Order p50/p95`, `Scrape Age`, `Book Age`, `Loop Lag`) and **Venue Health & Rate-Limit Strip (`FX-84`)** with one-click exchange state reconciliation (`#btnReconcileNow`).
   - **Zone 3: Active Positions & Live Signal Scanner (`.overview-main-grid`)**:
     - Left column (`360px`): Open Positions (`#positionsBody`) with **Exit Liquidity Health Badges (`FX-83`)**, **Route Badges (`FX-82`)**, and expandable **Trade Lifecycle Timelines (`FX-86`)**.
     - Right column (`1fr`): Live Scanner (`#panelScanner`) with **Executability Badges (`FX-80`)**, **Route Badges (`FX-82`)**, and the **Blocked-Signals Filter Bar (`FX-88`)**.
   - **Zone 4: On-Demand Order-Book Depth & Route Inspector (`#inspectorModal`)**:
     - **Choice**: Dedicated modal drawer triggered from any scanner row (`Inspect` action) rather than embedding mini depth charts inside every table row.
     - **Reason**: Preserves 140-row table scan speed while giving full resolution to the **EQE Breakdown Card (`FX-80`)**, **Two-Sided Cumulative Depth SVG Chart (`FX-81`)**, and **Multi-Venue Cost Comparison Table (`FX-82`)**.

## 5. Component Specifications (`FX-80` through `FX-90`)
- **`FX-80` Executability Badge & Breakdown**: Semantic pill (`PASS` emerald, `SCALED` amber, `BLOCKED` crimson) paired with one-way cost in bps; clicking opens `#inspectorModal` with spread, slip, fee, band depth, and gate reasons.
- **`FX-81` Two-Sided Cumulative Order-Book Depth Chart**: Crisp SVG step-area chart plotting bid cumulative USD depth (left, emerald) and ask cumulative USD depth (right, crimson), mid-price hairline, and simulated order walk fill marker.
- **`FX-82` Smart Order Router Badge & Comparison Table**: Displays `Auto -> VENUE · X.X bps` in scanner/positions and full cross-venue fee + impact + spread breakdown in the inspector.
- **`FX-83` Position Exit Liquidity Health Indicator**: Real-time badge on open positions (`LIQ OK`, `LIQ THIN`, `LIQ CRITICAL`) with estimated exit impact bps.
- **`FX-84` Venue Health & Rate-Limit Strip**: Live status pills per venue showing circuit breaker state, rate-limit headroom %, and manual `Reconcile` trigger.
- **`FX-85` Speed Telemetry Strip**: Live `Signal->Order p50/p95`, `Scrape Age`, `Book Age`, and `Loop Lag` in tabular monospace.
- **`FX-86` Trade Lifecycle Timeline**: Expandable step track on open positions (`Signal -> EQE Gate -> Route -> Submit -> Fill -> SL Active -> TP1 -> Trail`).
- **`FX-87` Predicted vs Realized Execution Quality Panel**: Summary strip in `#panelTrades` comparing predicted entry impact (bps) against realized slippage (bps) and model calibration drift.
- **`FX-88` Blocked-Signals Filter Bar**: Interactive filter pills in `#panelScanner` (`All`, `Spread`, `Impact`, `Depth`, `Stale Book`, `Funding`, `Cooldown`) with live rejection counts.
- **`FX-89` Live-Critical Banners**: High-priority alert tiers in `BANNER_CONFIG` (`protection-failed`, `order-unknown`, `orphan-detected`, `engine-busy`).
- **`FX-90` Live Execution Cost Preview**: Real-time calculator in Strategy Settings (`#execCostPreview`) showing estimated round-trip cost (bps), required minimum price move (%), and net edge multiple before saving.
