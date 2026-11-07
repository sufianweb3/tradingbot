/**
 * Self-contained HTML / CSV / JSON strategy reports.
 * The HTML report embeds an SVG equity curve, so it can be saved or printed to PDF.
 */

import { escapeHtml, iso, round, toNum } from "./util.js";

const money = (n, d = 2) =>
  (toNum(n, 0) < 0 ? "-$" : "$") +
  Math.abs(toNum(n, 0)).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });

const pct = (n, d = 2) => `${toNum(n, 0) >= 0 ? "+" : ""}${toNum(n, 0).toFixed(d)}%`;

const duration = (ms) => {
  const s = Math.max(0, Math.round(toNum(ms, 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
};

function niceNumber(n) {
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(0);
}

export function equitySvg(curve, initialFund, width = 940, height = 300) {
  const points = (Array.isArray(curve) ? curve : []).filter((p) => Number.isFinite(toNum(p?.equity)));
  if (!points.length) points.push({ t: Date.now(), equity: initialFund });
  if (points.length === 1) points.unshift({ t: points[0].t - 1, equity: initialFund });

  const values = points.map((p) => toNum(p.equity));
  values.push(toNum(initialFund));
  let min = Math.min(...values);
  let max = Math.max(...values);
  const spread = Math.max(1e-9, max - min);
  const pad = Math.max(spread * 0.12, Math.abs(initialFund) * 0.005, 0.5);
  min -= pad;
  max += pad;

  const left = 68;
  const right = 18;
  const top = 16;
  const bottom = 30;
  const iw = width - left - right;
  const ih = height - top - bottom;
  const n = points.length;
  const x = (i) => left + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => top + (1 - (v - min) / (max - min)) * ih;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(2)},${y(toNum(p.equity)).toFixed(2)}`).join(" ");
  const area = `${line} L${x(n - 1).toFixed(2)},${(top + ih).toFixed(2)} L${x(0).toFixed(2)},${(top + ih).toFixed(2)} Z`;
  const last = toNum(points[n - 1].equity);
  const up = last >= toNum(initialFund);
  const stroke = up ? "#0f9d76" : "#d9485f";

  const grid = [];
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    const yy = y(v);
    grid.push(
      `<line x1="${left}" y1="${yy.toFixed(2)}" x2="${left + iw}" y2="${yy.toFixed(2)}" stroke="#e6ebf0" stroke-width="1"/>` +
        `<text x="${left - 8}" y="${(yy + 3.5).toFixed(2)}" text-anchor="end" font-size="10" fill="#7c8794">$${niceNumber(v)}</text>`
    );
  }
  const initY = y(toNum(initialFund));
  const firstT = points[0].t;
  const lastT = points[n - 1].t;

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="Equity curve" style="display:block">
  <defs>
    <linearGradient id="eqfill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${stroke}" stop-opacity="0.26"/>
      <stop offset="100%" stop-color="${stroke}" stop-opacity="0.02"/>
    </linearGradient>
  </defs>
  ${grid.join("")}
  <line x1="${left}" y1="${initY.toFixed(2)}" x2="${left + iw}" y2="${initY.toFixed(2)}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4"/>
  <path d="${area}" fill="url(#eqfill)"/>
  <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${x(n - 1).toFixed(2)}" cy="${y(last).toFixed(2)}" r="3.6" fill="${stroke}" stroke="#fff" stroke-width="2"/>
  <text x="${left}" y="${height - 8}" font-size="10" fill="#7c8794">${escapeHtml(iso(firstT))}</text>
  <text x="${left + iw}" y="${height - 8}" text-anchor="end" font-size="10" fill="#7c8794">${escapeHtml(iso(lastT))}</text>
  <text x="${left + 6}" y="${(initY - 6).toFixed(2)}" font-size="10" fill="#94a3b8">initial ${money(initialFund)}</text>
  <text x="${left + iw - 4}" y="${(top + 12).toFixed(2)}" text-anchor="end" font-size="11" font-weight="600" fill="${stroke}">${money(last)}</text>
</svg>`;
}

function filterRows(settings) {
  const rows = [];
  for (const f of settings.oiFilters || []) {
    rows.push({
      group: "Open Interest",
      label: `OI ${f.key}`,
      enabled: f.enabled && toNum(f.threshold) !== null,
      op: f.op || ">=",
      threshold: f.threshold,
    });
  }
  for (const f of settings.volFilters || []) {
    rows.push({
      group: "Volume",
      label: `Volume ${f.key}`,
      enabled: f.enabled && toNum(f.threshold) !== null,
      op: f.op || ">=",
      threshold: f.threshold,
    });
  }
  return rows
    .map(
      (r) => `<tr>
        <td>${escapeHtml(r.label)}</td>
        <td>${r.enabled ? `<span class="pill on">ON</span>` : `<span class="pill off">OFF</span>`}</td>
        <td>${r.enabled ? `${escapeHtml(r.op)} ${toNum(r.threshold).toFixed(2)}%` : "—"}</td>
      </tr>`
    )
    .join("");
}

function tradeRows(trades) {
  if (!trades.length) {
    return `<tr><td colspan="12" class="empty">No closed trades yet.</td></tr>`;
  }
  return trades
    .map((t) => {
      const win = toNum(t.pnlNet) >= 0;
      return `<tr>
      <td class="mono">${escapeHtml(iso(t.exitTime))}</td>
      <td><strong>${escapeHtml(t.symbol)}</strong></td>
      <td><span class="side ${t.side}">${escapeHtml(t.side)}</span></td>
      <td class="mono">${escapeHtml(t.venueName || t.venue || "—")}</td>
      <td class="mono">${toNum(t.entryPrice).toPrecision(6)}</td>
      <td class="mono">${toNum(t.exitPrice ?? t.exitPriceAvg).toPrecision(6)}</td>
      <td class="mono">${money(t.margin)}</td>
      <td class="mono">${toNum(t.leverage).toFixed(0)}x</td>
      <td class="mono ${win ? "pos" : "neg"}">${money(t.pnlNet)}</td>
      <td class="mono ${win ? "pos" : "neg"}">${pct(t.roe)}</td>
      <td class="mono">${money(t.feesPaid)}</td>
      <td>${escapeHtml(t.exitReason || "—")}</td>
    </tr>`;
    })
    .join("");
}

export function renderReport(data) {
  const { settings, stats, trades, positions, equityCurve, generatedAt, initialFund } = data;
  const start = trades.length ? trades[0].entryTime : data.meta?.createdAt;
  const end = trades.length ? trades[trades.length - 1].exitTime : generatedAt;
  const pf =
    stats.profitFactor === null
      ? stats.grossProfit > 0
        ? "∞"
        : "0.00"
      : toNum(stats.profitFactor).toFixed(2);

  const positionsHtml = positions.length
    ? positions
        .map(
          (p) => `<tr>
          <td><strong>${escapeHtml(p.symbol)}</strong></td>
          <td><span class="side ${p.side}">${escapeHtml(p.side)}</span></td>
          <td class="mono">${toNum(p.entryPrice).toPrecision(6)}</td>
          <td class="mono">${toNum(p.markPrice).toPrecision(6)}</td>
          <td class="mono">${money(p.margin)}</td>
          <td class="mono ${p.netTotal >= 0 ? "pos" : "neg"}">${money(p.netTotal)}</td>
          <td class="mono ${p.roe >= 0 ? "pos" : "neg"}">${pct(p.roe)}</td>
          <td>${escapeHtml(p.venueName || p.venue)}</td>
        </tr>`
        )
        .join("")
    : `<tr><td colspan="8" class="empty">No open positions.</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OI Sniper — Strategy Report</title>
<style>
  :root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--bg:#f6f8fb;--card:#fff;--green:#0f9d76;--red:#d9485f;--amber:#b7791f}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
  .wrap{max-width:1180px;margin:0 auto;padding:28px 22px 60px}
  header{background:linear-gradient(135deg,#0b1220,#13233a);color:#fff;border-radius:16px;padding:26px 28px;margin-bottom:18px}
  header h1{margin:0 0 6px;font-size:24px;letter-spacing:.2px}
  header p{margin:0;color:#a9b8cc;font-size:13px}
  .badge{display:inline-block;background:#1d4ed8;color:#fff;font-size:11px;font-weight:700;letter-spacing:.8px;padding:3px 8px;border-radius:999px;margin-left:8px;vertical-align:2px}
  .kpis{display:grid;grid-template-columns:repeat(6,1fr);gap:12px;margin:16px 0}
  .kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
  .kpi .label{font-size:11px;text-transform:uppercase;letter-spacing:.7px;color:var(--muted);font-weight:700}
  .kpi .value{font-size:20px;font-weight:700;margin-top:5px;font-variant-numeric:tabular-nums}
  .kpi .sub{font-size:11px;color:var(--muted);margin-top:2px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin-bottom:16px}
  .card h2{font-size:14px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted);margin:0 0 14px}
  .grid{display:grid;grid-template-columns:1.6fr 1fr;gap:16px}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);border-bottom:1px solid var(--line);padding:8px 8px;white-space:nowrap}
  td{border-bottom:1px solid #f1f5f9;padding:8px 8px;vertical-align:middle}
  tr:last-child td{border-bottom:0}
  .mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums}
  .pos{color:var(--green);font-weight:600}.neg{color:var(--red);font-weight:600}
  .side{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}
  .side.long{background:#d8f5ec;color:#0b7a5c}.side.short{background:#fde2e6;color:#b4233a}
  .pill{display:inline-block;padding:1px 7px;border-radius:999px;font-size:10px;font-weight:700}
  .pill.on{background:#d8f5ec;color:#0b7a5c}.pill.off{background:#eef2f6;color:#7c8794}
  .empty{text-align:center;color:var(--muted);padding:20px}
  .muted{color:var(--muted)}
  .statline{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #eef2f6;font-size:12.5px}
  .statline:last-child{border-bottom:0}
  .statline span:first-child{color:var(--muted)}
  .statline span:last-child{font-weight:600;font-variant-numeric:tabular-nums}
  footer{margin-top:24px;color:var(--muted);font-size:11.5px;line-height:1.6}
  @media (max-width:900px){.kpis{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}
  @media print{body{background:#fff}.wrap{padding:0}header{border-radius:0}.card{break-inside:avoid}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>OI Sniper <span class="badge">PAPER</span></h1>
    <p>Strategy report · generated ${escapeHtml(iso(generatedAt))} · ${escapeHtml(iso(start))} → ${escapeHtml(iso(end))}</p>
  </header>

  <div class="kpis">
    <div class="kpi"><div class="label">Equity</div><div class="value">${money(stats.equity)}</div><div class="sub">start ${money(initialFund)}</div></div>
    <div class="kpi"><div class="label">Total P/L</div><div class="value ${stats.totalPnl >= 0 ? "pos" : "neg"}">${money(stats.totalPnl)}</div><div class="sub">${pct(stats.returnPct)} return</div></div>
    <div class="kpi"><div class="label">Win rate</div><div class="value">${toNum(stats.winrate).toFixed(1)}%</div><div class="sub">${stats.wins}W / ${stats.losses}L</div></div>
    <div class="kpi"><div class="label">Profit factor</div><div class="value">${pf}</div><div class="sub">${money(stats.grossProfit)} / ${money(stats.grossLoss)}</div></div>
    <div class="kpi"><div class="label">Max drawdown</div><div class="value neg">${money(stats.maxDrawdown)}</div><div class="sub">${toNum(stats.maxDrawdownPct).toFixed(2)}%</div></div>
    <div class="kpi"><div class="label">Trades</div><div class="value">${stats.totalTrades}</div><div class="sub">${stats.openTrades} open</div></div>
  </div>

  <div class="card">
    <h2>Fund PnL</h2>
    ${equitySvg(equityCurve, initialFund)}
  </div>

  <div class="grid">
    <div class="card">
      <h2>Performance detail</h2>
      <div class="statline"><span>Realized P/L</span><span class="${stats.realizedPnl >= 0 ? "pos" : "neg"}">${money(stats.realizedPnl)}</span></div>
      <div class="statline"><span>Unrealized P/L</span><span class="${stats.unrealizedPnl >= 0 ? "pos" : "neg"}">${money(stats.unrealizedPnl)}</span></div>
      <div class="statline"><span>Fees paid (incl. open)</span><span>${money(stats.feesPaid)}</span></div>
      <div class="statline"><span>Average trade</span><span>${money(stats.avgTrade)}</span></div>
      <div class="statline"><span>Average win / loss</span><span>${money(stats.avgWin)} / ${money(stats.avgLoss)}</span></div>
      <div class="statline"><span>Expectancy / trade</span><span>${money(stats.expectancy)}</span></div>
      <div class="statline"><span>Best / worst</span><span>${money(stats.bestTrade?.pnlNet ?? 0)} / ${money(stats.worstTrade?.pnlNet ?? 0)}</span></div>
      <div class="statline"><span>Long trades</span><span>${stats.long.count} · ${money(stats.long.pnl)}</span></div>
      <div class="statline"><span>Short trades</span><span>${stats.short.count} · ${money(stats.short.pnl)}</span></div>
      <div class="statline"><span>Max win / loss streak</span><span>${stats.maxWinStreak} / ${stats.maxLossStreak}</span></div>
    </div>
    <div class="card">
      <h2>Strategy settings</h2>
      <div class="statline"><span>Total fund</span><span>${money(settings.totalFund)}</span></div>
      <div class="statline"><span>Sizing</span><span>${escapeHtml(settings.sizingMode)} · ${settings.sizingMode === "allocation" ? `${settings.allocationPercent}% of ${settings.allocationBase}` : settings.sizingMode === "fixedMargin" ? money(settings.fixedMargin) : `${settings.fixedQty} coins`}</span></div>
      <div class="statline"><span>Leverage</span><span>${settings.leverage}x</span></div>
      <div class="statline"><span>SL / TP1 / TP max</span><span>${settings.slPercent}% / ${settings.tp1Percent}% / ${settings.tpMaxPercent}%</span></div>
      <div class="statline"><span>TP1 close / trailing</span><span>${settings.tp1ClosePercent}% · ${settings.trailingEnabled ? `${settings.trailingDistancePercent}% from ${settings.trailingStart}` : "off"}</span></div>
      <div class="statline"><span>Direction</span><span>${escapeHtml(settings.direction)}</span></div>
      <div class="statline"><span>Fee / slippage</span><span>${settings.feePercent}% / ${settings.slippagePercent}%</span></div>
      <div class="statline"><span>Max trades</span><span>${settings.maxTrades || "unlimited"}</span></div>
      <table style="margin-top:12px"><thead><tr><th>Filter</th><th>State</th><th>Condition</th></tr></thead><tbody>${filterRows(settings)}</tbody></table>
    </div>
  </div>

  <div class="card">
    <h2>Open positions</h2>
    <table>
      <thead><tr><th>Coin</th><th>Side</th><th>Entry</th><th>Mark</th><th>Margin</th><th>Net P/L</th><th>ROE</th><th>Venue</th></tr></thead>
      <tbody>${positionsHtml}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>Trade history (${trades.length})</h2>
    <div style="overflow-x:auto">
      <table>
        <thead><tr><th>Closed</th><th>Coin</th><th>Side</th><th>Venue</th><th>Entry</th><th>Exit</th><th>Margin</th><th>Lev</th><th>Net P/L</th><th>ROE</th><th>Fees</th><th>Reason</th></tr></thead>
        <tbody>${tradeRows(trades)}</tbody>
      </table>
    </div>
  </div>

  <footer>
    <strong>Paper trading only.</strong> No orders were sent to any exchange. Prices come from public exchange tickers; CoinGlass data is used for the OI/volume filter.
    Results include simulated taker fees and slippage, but not funding, partial fills or latency. Past performance is not indicative of future results.
  </footer>
</div>
</body>
</html>`;
}

export function renderCsv(data) {
  const cols = [
    "id",
    "symbol",
    "side",
    "venue",
    "entryTime",
    "exitTime",
    "entryPrice",
    "exitPrice",
    "qty",
    "margin",
    "leverage",
    "grossPnl",
    "entryFee",
    "exitFees",
    "feesPaid",
    "pnlNet",
    "roe",
    "peakRoe",
    "exitReason",
    "durationSec",
    "oi5m",
    "oi15m",
    "oi30m",
    "oi1h",
    "oi4h",
    "vol1h",
    "vol4h",
    "priceChange5m",
    "priceChange1h",
  ];
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(",")];
  for (const t of data.trades || []) {
    const oi = t.signal?.oi || {};
    const vol = t.signal?.vol || {};
    const row = {
      ...t,
      entryTime: iso(t.entryTime),
      exitTime: iso(t.exitTime),
      durationSec: Math.round(toNum(t.durationMs, 0) / 1000),
      oi5m: oi["5m"],
      oi15m: oi["15m"],
      oi30m: oi["30m"],
      oi1h: oi["1h"],
      oi4h: oi["4h"],
      vol1h: vol["1h"],
      vol4h: vol["4h"],
      priceChange5m: t.signal?.priceChange5m,
      priceChange1h: t.signal?.priceChange1h,
    };
    lines.push(cols.map((c) => esc(row[c])).join(","));
  }
  return lines.join("\r\n");
}

export function renderJson(data) {
  return JSON.stringify(
    {
      generatedAt: iso(data.generatedAt),
      settings: data.settings,
      initialFund: data.initialFund,
      stats: data.stats,
      positions: data.positions,
      trades: data.trades,
      equityCurve: data.equityCurve,
    },
    null,
    2
  );
}
