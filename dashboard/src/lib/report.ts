import type { EquityPoint, Position, Trade } from "./data";
import { positionMetrics, tradeStats } from "./metrics";
import { usd, signedUsd, pct, price } from "./format";
import { tradesToCsv } from "./download";

function esc(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ReportPayload {
  equity: number;
  startFund: number;
  stats: ReturnType<typeof tradeStats>;
  positions: Position[];
  trades: Trade[];
  series: EquityPoint[];
  mode: "paper" | "live";
  exchange: string;
  drawdown: number;
}

function equitySvg(series: EquityPoint[], className = "") {
  if (series.length < 2) return "";
  const values = series.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const path = series
    .map((point, index) => {
      const x = (index / (series.length - 1)) * 720;
      const y = 170 - ((point.value - min) / range) * 140;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="${className}" viewBox="0 0 720 180" preserveAspectRatio="none" role="img" aria-label="Equity curve">
    <path d="${path} L 720 180 L 0 180 Z" fill="rgba(0,113,227,.08)" />
    <path d="${path}" fill="none" stroke="#0071e3" stroke-width="2" />
  </svg>`;
}

export function buildHtmlReport(payload: ReportPayload) {
  const {
    equity,
    startFund,
    stats,
    positions,
    trades,
    series,
    mode,
    exchange,
    drawdown,
  } = payload;
  const net = equity - startFund;
  const returnPct = (net / startFund) * 100;
  const openRows = positions
    .map((position) => {
      const metrics = positionMetrics(position);
      return `<tr>
        <td>${esc(position.symbol)} / USDT</td>
        <td>${esc(position.side)}</td>
        <td class="num">${usd(position.margin, 0)}</td>
        <td class="num">${price(position.entry)}</td>
        <td class="num">${price(position.mark)}</td>
        <td class="num ${metrics.pnl >= 0 ? "pos" : "neg"}">${signedUsd(metrics.pnl)}</td>
        <td class="num ${metrics.roe >= 0 ? "pos" : "neg"}">${metrics.roe.toFixed(1)}%</td>
      </tr>`;
    })
    .join("");
  const tradeRows = trades
    .slice(0, 25)
    .map(
      (trade) => `<tr>
        <td>${esc(trade.closedAt.toLocaleDateString("en-US"))}</td>
        <td>${esc(trade.symbol)}</td>
        <td>${esc(trade.side)}</td>
        <td class="num">${price(trade.entry)}</td>
        <td class="num">${price(trade.exit)}</td>
        <td class="num ${trade.pnl >= 0 ? "pos" : "neg"}">${signedUsd(trade.pnl)}</td>
        <td class="num">${trade.roe.toFixed(1)}%</td>
        <td>${esc(trade.reason)}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OI Sniper report — ${new Date().toISOString().slice(0, 10)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #f5f5f7; color: #1d1d1f; font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 48px 24px 64px; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 28px; }
  h1 { margin: 0; font-size: 30px; letter-spacing: -.03em; }
  .sub { margin-top: 6px; color: #6e6e73; font-size: 12px; }
  .brand { width: 38px; height: 38px; border-radius: 10px; background: #0071e3; display: grid; place-items: center; }
  .grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 1px; background: rgba(29,29,31,.08); border: 1px solid rgba(29,29,31,.08); border-radius: 14px; overflow: hidden; }
  .stat { background: #fff; padding: 16px; }
  .stat span { font-size: 10px; color: #6e6e73; }
  .stat b { display: block; margin-top: 5px; font-size: 20px; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  section { margin-top: 20px; background: #fff; border: 1px solid rgba(29,29,31,.08); border-radius: 16px; padding: 20px; }
  h2 { margin: 0 0 12px; font-size: 14px; }
  .chrome { padding: 6px 0 0; }
  svg { width: 100%; height: 200px; display: block; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 6px; font-size: 10px; font-weight: 500; color: #737378; border-bottom: 1px solid rgba(29,29,31,.08); }
  td { padding: 8px 6px; font-size: 11px; border-bottom: 1px solid rgba(29,29,31,.06); }
  tr:last-child td { border-bottom: 0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .pos { color: #087f45; }
  .neg { color: #cf2e21; }
  .note { margin-top: 24px; color: #737378; font-size: 10px; }
  @media (max-width: 720px) { .grid { grid-template-columns: repeat(2, 1fr); } header { flex-direction: column; } }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>OI Sniper</h1>
      <p class="sub">Paper execution report · ${new Date().toLocaleString("en-US")} · ${mode === "live" ? `Live route ${esc(exchange)}` : "Paper mode"}</p>
    </div>
    <div class="brand" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="20" height="20"><path d="M7 22.2 13 15l4.2 3.2L25 9.5" fill="none" stroke="white" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>
  </header>

  <div class="grid">
    <div class="stat"><span>Account equity</span><b>${usd(equity)}</b></div>
    <div class="stat"><span>Net P&L</span><b class="${net >= 0 ? "pos" : "neg"}">${signedUsd(net)}</b><span>${pct(returnPct)}</span></div>
    <div class="stat"><span>Win rate</span><b>${stats.winRate.toFixed(1)}%</b><span>${stats.wins}W / ${stats.losses}L</span></div>
    <div class="stat"><span>Profit factor</span><b>${stats.profitFactor.toFixed(2)}</b></div>
    <div class="stat"><span>Max drawdown</span><b class="neg">${pct(drawdown, 1)}</b></div>
  </div>

  <section class="chrome">
    <h2>Equity curve</h2>
    ${equitySvg(series)}
  </section>

  <section>
    <h2>Open positions</h2>
    <table>
      <thead><tr><th>Position</th><th>Side</th><th class="num">Margin</th><th class="num">Entry</th><th class="num">Mark</th><th class="num">P&L</th><th class="num">ROE</th></tr></thead>
      <tbody>${openRows || '<tr><td colspan="7">No open positions.</td></tr>'}</tbody>
    </table>
  </section>

  <section>
    <h2>Closed trades (latest 25)</h2>
    <table>
      <thead><tr><th>Closed</th><th>Coin</th><th>Side</th><th class="num">Entry</th><th class="num">Exit</th><th class="num">Net P&L</th><th class="num">ROE</th><th>Reason</th></tr></thead>
      <tbody>${tradeRows || '<tr><td colspan="8">No closed trades.</td></tr>'}</tbody>
    </table>
  </section>

  <p class="note">Simulated paper account. Past performance is not indicative of future results. This report contains no exchange keys. Generated locally by the OI Sniper UI preview.</p>
</main>
</body>
</html>`;
}

export function buildJsonReport(payload: ReportPayload) {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      app: "OI Sniper",
      mode: payload.mode,
      exchange: payload.exchange,
      startFund: payload.startFund,
      equity: payload.equity,
      netPnl: payload.equity - payload.startFund,
      drawdownPct: payload.drawdown,
      stats: payload.stats,
      openPositions: payload.positions,
      trades: payload.trades,
    },
    null,
    2,
  );
}

export function buildTradesCsv(trades: Trade[]) {
  return tradesToCsv(
    trades.map((trade) => ({
      closed: trade.closedAt.toISOString(),
      symbol: trade.symbol,
      side: trade.side,
      margin: trade.margin,
      leverage: trade.leverage,
      entry: trade.entry,
      exit: trade.exit,
      pnl: trade.pnl,
      roe: trade.roe,
      fees: trade.fees,
      reason: trade.reason,
    })),
    [
      { key: "closed", label: "Closed at" },
      { key: "symbol", label: "Coin" },
      { key: "side", label: "Side" },
      { key: "margin", label: "Margin" },
      { key: "leverage", label: "Leverage" },
      { key: "entry", label: "Entry" },
      { key: "exit", label: "Exit" },
      { key: "pnl", label: "Net P&L" },
      { key: "roe", label: "ROE %" },
      { key: "fees", label: "Fees" },
      { key: "reason", label: "Exit reason" },
    ],
  );
}

export function buildPresetLink() {
  const clean = {
    version: 1,
    profiles: {
      long: {
        allocation: 5,
        leverage: 50,
        stopLoss: 20,
        tp1: 50,
        tp1Close: 50,
        tpMax: 1000,
        trailing: true,
        trailingStart: "tp1",
        trailDistance: 20,
      },
      short: {
        allocation: 3.5,
        leverage: 25,
        stopLoss: 15,
        tp1: 40,
        tp1Close: 50,
        tpMax: 800,
        trailing: true,
        trailingStart: "tp1",
        trailDistance: 18,
      },
    },
    eqe: { enabled: true, maxOneWayCostBps: 18, maxSpreadBps: 12, minDepthMultiple: 3 },
    mode: "paper",
  };
  const encoded = btoa(encodeURIComponent(JSON.stringify(clean)));
  return `${window.location.origin}/strategy#preset=${encoded}`;
}

export function decodePresetLink(hash: string) {
  try {
    if (!hash.startsWith("#preset=")) return null;
    const decoded = decodeURIComponent(atob(hash.slice(8)));
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}
