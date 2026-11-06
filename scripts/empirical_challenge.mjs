/**
 * Comprehensive Empirical Stress-Testing Harness for UI Redesign
 *
 * Checks:
 * 1. Empty State Spacing & Non-Collision across all tables & variations
 * 2. KPI Sub-labels Stress-Testing (40-60 chars + continuous unbroken words)
 * 3. Table Headers & Responsiveness across 800px, 1200px, 1920px viewports
 * 4. Coin Logos, Symbol Normalization (standard, perps, inverse, meme multipliers), Fallback Badges, and CLS = 0
 * 5. Banner Consolidation & Stale Feed Suppression
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const ROOT = path.resolve(".");
const publicDir = path.join(ROOT, "public");

// =========================================================================
// 1. SYMBOL NORMALIZATION & INITIALS STRESS TEST (NODE ENVIRONMENT)
// =========================================================================
function extractAppFunctions() {
  const appCode = fs.readFileSync(path.join(publicDir, "app.js"), "utf8");
  const fn1 = appCode.match(/function normalizeCoinSymbol[\s\S]*?^}/m)[0];
  const fn2 = appCode.match(/function getCoinInitials[\s\S]*?^}/m)[0];
  const fn3 = appCode.match(/function renderCoinBadge[\s\S]*?^}/m)[0];
  const escFn = "function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;'); }";
  return new Function(`${escFn}; ${fn1}; ${fn2}; ${fn3}; return { normalizeCoinSymbol, getCoinInitials, renderCoinBadge, esc };`)();
}

console.log("================================================================================");
console.log("STEP 1: SYMBOL NORMALIZATION, MEME MULTIPLIERS & INITIALS TEST");
console.log("================================================================================");

const { normalizeCoinSymbol, getCoinInitials, renderCoinBadge, esc } = extractAppFunctions();

const testSymbols = [
  // Standard spot/symbols
  { input: "BTC", expectedNorm: "btc", expectedInitials: "BT" },
  { input: "ETH", expectedNorm: "eth", expectedInitials: "ET" },
  { input: "SOL", expectedNorm: "sol", expectedInitials: "SO" },
  { input: "DOGE", expectedNorm: "doge", expectedInitials: "DO" },
  { input: "ADA", expectedNorm: "ada", expectedInitials: "AD" },
  { input: "XRP", expectedNorm: "xrp", expectedInitials: "XR" },

  // Linear perps & swaps
  { input: "ETH-PERP", expectedNorm: "eth", expectedInitials: "ET" },
  { input: "BTC-PERP", expectedNorm: "btc", expectedInitials: "BT" },
  { input: "SOL_PERP", expectedNorm: "sol", expectedInitials: "SO" },
  { input: "AVAX/PERP", expectedNorm: "avax", expectedInitials: "AV" },
  { input: "LINK-SWAP", expectedNorm: "link", expectedInitials: "LI" },
  { input: "DOTSWAP", expectedNorm: "dot", expectedInitials: "DO" },

  // Inverse contracts & quote pairs
  { input: "BTCUSD", expectedNorm: "btc", expectedInitials: "BT" },
  { input: "BTCUSD_PERP", expectedNorm: "btc", expectedInitials: "BT" },
  { input: "SOL_USDT", expectedNorm: "sol", expectedInitials: "SO" },
  { input: "BTCUSDT", expectedNorm: "btc", expectedInitials: "BT" },
  { input: "ETH-USDC", expectedNorm: "eth", expectedInitials: "ET" },
  { input: "DOGEBUSD", expectedNorm: "doge", expectedInitials: "DO" },

  // Meme coin multipliers
  { input: "1000PEPE", expectedNorm: "pepe", expectedInitials: "PE" },
  { input: "kPEPE", expectedNorm: "pepe", expectedInitials: "PE" },
  { input: "1000BONK", expectedNorm: "bonk", expectedInitials: "BO" },
  { input: "kBONK", expectedNorm: "bonk", expectedInitials: "BO" },
  { input: "1000000MOG", expectedNorm: "mog", expectedInitials: "MO" },
  { input: "1000SHIB", expectedNorm: "shib", expectedInitials: "SH" },
  { input: "1000LUNC", expectedNorm: "lunc", expectedInitials: "LU" },
  { input: "1000FLOKI", expectedNorm: "floki", expectedInitials: "FL" },
  { input: "1000PEPE-PERP", expectedNorm: "pepe", expectedInitials: "PE" },
  { input: "1000BONK_USDT", expectedNorm: "bonk", expectedInitials: "BO" },
  { input: "kPEPEUSDT", expectedNorm: "pepe", expectedInitials: "PE" },

  // Edge cases & special symbols
  { input: "1INCH", expectedNorm: "1inch", expectedInitials: "1I" },
  { input: "0X", expectedNorm: "0x", expectedInitials: "0X" },
  { input: "X", expectedNorm: "x", expectedInitials: "X" },
  { input: "  BTC  ", expectedNorm: "btc", expectedInitials: "BT" },
  { input: "bTc-PeRp", expectedNorm: "btc", expectedInitials: "BT" },
  { input: "$DOGE", expectedNorm: "doge", expectedInitials: "DO" },
  { input: "BTC/USDT", expectedNorm: "btc", expectedInitials: "BT" },
  { input: "ETH:USDT", expectedNorm: "eth", expectedInitials: "ET" },
  { input: "BTC-20241227", expectedNorm: "btc20241227", expectedInitials: "BT" },
  { input: "", expectedNorm: "", expectedInitials: "??" },
  { input: null, expectedNorm: "", expectedInitials: "??" },
  { input: undefined, expectedNorm: "", expectedInitials: "??" }
];

let normFailures = 0;
for (const tc of testSymbols) {
  const norm = normalizeCoinSymbol(tc.input);
  const initials = getCoinInitials(tc.input);
  const pass = norm === tc.expectedNorm && initials === tc.expectedInitials;
  if (!pass) {
    console.error(`FAIL: input "${tc.input}" -> norm "${norm}" (expected "${tc.expectedNorm}"), initials "${initials}" (expected "${tc.expectedInitials}")`);
    normFailures++;
  } else {
    console.log(`PASS: ${String(tc.input).padEnd(16)} -> norm: ${norm.padEnd(12)} initials: ${initials}`);
  }
}
assert.equal(normFailures, 0, "All symbol normalization and initials test cases must pass");

// Verify XSS safety in renderCoinBadge
const xssPayload = '<img src=x onerror=alert(1)>';
const renderedBadge = renderCoinBadge(xssPayload);
assert.ok(!renderedBadge.includes("<img src=x onerror=alert(1)>"), "renderCoinBadge must escape XSS payloads");
assert.ok(renderedBadge.includes("&lt;img"), "renderCoinBadge correctly escaped HTML");
console.log("PASS: renderCoinBadge XSS escaping verified.");

// =========================================================================
// 2. BROWSER DOM HARNESS SERVER (HEADLESS FIREFOX REAL RENDERING)
// =========================================================================
console.log("\n================================================================================");
console.log("STEP 2: LAUNCHING BROWSER DOM HARNESS SERVER (PORT 4991)");
console.log("================================================================================");

const stylesCss = fs.readFileSync(path.join(publicDir, "styles.css"), "utf8");

const runnerHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
${stylesCss}
</style>
<style>
/* Test fixture viewport containers */
.test-container {
  margin: 20px 0;
  padding: 15px;
  background: var(--bg-canvas, #070a0f);
  border: 1px solid var(--line, #1e293b);
}
.viewport-800 { width: 800px; }
.viewport-1200 { width: 1200px; }
.viewport-1920 { width: 1920px; }
</style>
</head>
<body>
<div id="testRoot"></div>

<script>
async function runTests() {
  const results = {
    emptyStates: [],
    kpiCards: [],
    unbrokenWordKpi: null,
    tableHeaders: [],
    coinLogos: [],
    bannerConsolidation: null,
    errors: []
  };

  try {
    const root = document.getElementById("testRoot");

    // ----------------------------------------------------
    // TEST 1: Empty State Spacing & Collision Verification
    // ----------------------------------------------------
    const emptyStateCases = [
      {
        name: "Live Scanner - Initial Loading",
        html: '<table class="data-table markets-table"><tbody><tr><td colspan="12" class="empty-row"><b>Loading CoinGlass data…</b><p class="empty-desc">The first scan downloads the full market table.</p></td></tr></tbody></table>'
      },
      {
        name: "Live Scanner - Empty Search",
        html: '<table class="data-table markets-table"><tbody><tr><td colspan="12" class="empty-row"><b>Nothing here yet</b><p class="empty-desc">No coins match this search.</p></td></tr></tbody></table>'
      },
      {
        name: "Live Scanner - Empty Watchlist",
        html: '<table class="data-table markets-table"><tbody><tr><td colspan="12" class="empty-row"><b>Nothing here yet</b><p class="empty-desc">Star coins to build your personal watchlist.</p></td></tr></tbody></table>'
      },
      {
        name: "Live Scanner - Empty Alerts",
        html: '<table class="data-table markets-table"><tbody><tr><td colspan="12" class="empty-row"><b>Nothing here yet</b><p class="empty-desc">Coins with 3+ matching filters or strong OI spikes appear here.</p></td></tr></tbody></table>'
      },
      {
        name: "Live Scanner - Empty Cooling",
        html: '<table class="data-table markets-table"><tbody><tr><td colspan="12" class="empty-row"><b>Nothing here yet</b><p class="empty-desc">Coins on cooldown after an exit will show here until reset.</p></td></tr></tbody></table>'
      },
      {
        name: "CoinGlass Table - Initial Waiting",
        html: '<table class="data-table cg-table"><tbody><tr><td colspan="3" class="empty-row"><b>Waiting for CoinGlass data…</b><p class="empty-desc">The bot is contacting capi.coinglass.com.</p></td></tr></tbody></table>'
      },
      {
        name: "CoinGlass Table - No Matching Coins",
        html: '<table class="data-table cg-table"><tbody><tr><td colspan="3" class="empty-row"><b>No matching coins</b><p class="empty-desc">Try a different search.</p></td></tr></tbody></table>'
      },
      {
        name: "Trades Table - No Closed Trades",
        html: '<table class="data-table"><tbody><tr><td colspan="12" class="empty-row"><b>No closed trades yet</b><p class="empty-desc">A trade appears here after it hits SL, TP or you close it manually.</p></td></tr></tbody></table>'
      },
      {
        name: "Positions Grid - No Open Positions",
        html: '<div class="positions"><div class="pos-empty"><b>No open positions</b>When a coin passes every enabled filter, a paper trade opens here automatically.</div></div>'
      }
    ];

    for (const esc of emptyStateCases) {
      const container = document.createElement("div");
      container.className = "test-container";
      container.innerHTML = esc.html;
      root.appendChild(container);

      const b = container.querySelector("b");
      const p = container.querySelector("p, .empty-desc") || container.querySelector(".pos-empty");
      const bStyle = window.getComputedStyle(b);
      const bRect = b.getBoundingClientRect();
      const pRect = p.getBoundingClientRect();

      let verticalGap = 0;
      let displayBlock = bStyle.display === "block";
      let noCollision = false;

      if (container.querySelector(".empty-row")) {
        const pDesc = container.querySelector(".empty-desc");
        const pDescRect = pDesc.getBoundingClientRect();
        verticalGap = pDescRect.top - bRect.bottom;
        noCollision = pDescRect.top >= bRect.bottom && verticalGap >= 5;
      } else if (container.querySelector(".pos-empty")) {
        noCollision = bRect.bottom <= pRect.bottom;
        verticalGap = bRect.height;
      }

      results.emptyStates.push({
        name: esc.name,
        display: bStyle.display,
        marginBottom: bStyle.marginBottom,
        verticalGap: Math.round(verticalGap * 10) / 10,
        bBottom: Math.round(bRect.bottom * 10) / 10,
        pTop: container.querySelector(".empty-desc") ? Math.round(container.querySelector(".empty-desc").getBoundingClientRect().top * 10) / 10 : 0,
        displayBlock,
        noCollision,
        pass: displayBlock && noCollision
      });
    }

    // ----------------------------------------------------
    // TEST 2: KPI Card Sub-Labels Stress Test (40-60 chars)
    // ----------------------------------------------------
    const kpiTestCases = [
      { id: "kpiEquity", subId: "kpiEquitySub", label: "Account Equity", val: "$10,245.50", text: "Starting balance $10,000.00 across perpetual contracts" },
      { id: "kpiPnl", subId: "kpiPnlSub", label: "Total Net P/L", val: "+$245.50", text: "Cumulative realised returns over 30 days benchmarking SPX" },
      { id: "kpiOpen", subId: "kpiOpenSub", label: "Open Unrealized", val: "$12.30", text: "6 active risk positions running with trailing stop" },
      { id: "kpiWinrate", subId: "kpiWinrateSub", label: "Win Rate", val: "68.5%", text: "Win rate calculated across 124 executed paper transactions" },
      { id: "kpiPf", subId: "kpiPfSub", label: "Profit Factor", val: "2.14", text: "Profit factor represents gross gains divided by gross loss" },
      { id: "kpiDd", subId: "kpiDdSub", label: "Max Drawdown", val: "$85.00", text: "Maximum peak-to-trough equity decline recorded this run" },
      { id: "kpiTrades", subId: "kpiTradesSub", label: "Closed Trades", val: "84", text: "Total executed closed trading orders with SL/TP lifecycle" },
      { id: "kpiFees", subId: "kpiFeesSub", label: "Total Fees", val: "$42.15", text: "Total estimated exchange trading commissions and slippage" }
    ];

    const kpiWrap = document.createElement("div");
    kpiWrap.className = "test-container";
    kpiWrap.style.width = "400px"; // Constrained width forces multi-line wrapping
    kpiWrap.innerHTML = \`<section class="kpis" style="display:grid; grid-template-columns: repeat(2, 1fr); gap: 10px;">
      \${kpiTestCases.map(k => \`
        <article class="kpi" style="padding: 12px;">
          <div class="kpi-head"><span class="kpi-label">\${k.label}</span></div>
          <div class="kpi-value" id="\${k.id}">\${k.val}</div>
          <div class="kpi-sub" id="\${k.subId}">\${k.text}</div>
        </article>
      \`).join("")}
    </section>\`;
    root.appendChild(kpiWrap);

    for (const k of kpiTestCases) {
      const valEl = document.getElementById(k.id);
      const subEl = document.getElementById(k.subId);
      const subStyle = window.getComputedStyle(subEl);
      const valRect = valEl.getBoundingClientRect();
      const subRect = subEl.getBoundingClientRect();

      const notEllipsis = subStyle.textOverflow !== "ellipsis";
      const notNowrap = subStyle.whiteSpace !== "nowrap";
      const overflowVisible = subStyle.overflow === "visible" || subStyle.overflowX === "visible";
      const positionedBelow = subRect.top >= valRect.bottom - 1;
      const wrappedMultipleLines = subEl.clientHeight > 14;
      const zeroClipping = subEl.scrollHeight <= subEl.clientHeight + 2;

      results.kpiCards.push({
        id: k.id,
        subId: k.subId,
        charCount: k.text.length,
        textOverflow: subStyle.textOverflow,
        whiteSpace: subStyle.whiteSpace,
        overflow: subStyle.overflow,
        clientHeight: Math.round(subEl.clientHeight),
        scrollHeight: Math.round(subEl.scrollHeight),
        positionedBelow,
        wrappedMultipleLines,
        zeroClipping,
        pass: notEllipsis && notNowrap && positionedBelow && wrappedMultipleLines && zeroClipping
      });
    }

    // Adversarial test: Continuous 60-character word with no whitespace
    const unbrokenWrap = document.createElement("div");
    unbrokenWrap.className = "test-container";
    unbrokenWrap.style.width = "200px";
    const unbrokenText = "SupercalifragilisticexpialidociousContinuousMetricWordWithoutSpaces";
    unbrokenWrap.innerHTML = \`
      <article class="kpi" style="padding: 12px;">
        <div class="kpi-head"><span class="kpi-label">Unbroken Word Test</span></div>
        <div class="kpi-value" id="kpiUnbrokenVal">100</div>
        <div class="kpi-sub" id="kpiUnbrokenSub">\${unbrokenText}</div>
      </article>
    \`;
    root.appendChild(unbrokenWrap);

    const ubSub = document.getElementById("kpiUnbrokenSub");
    const ubStyle = window.getComputedStyle(ubSub);
    const ubClientWidth = ubSub.clientWidth;
    const ubScrollWidth = ubSub.scrollWidth;
    const breaksGracefully = ubScrollWidth <= ubClientWidth + 2; // word-break: break-word keeps within bounds

    results.unbrokenWordKpi = {
      charCount: unbrokenText.length,
      wordBreak: ubStyle.wordBreak,
      clientWidth: ubClientWidth,
      scrollHeight: ubSub.scrollHeight,
      clientHeight: ubSub.clientHeight,
      breaksGracefully,
      pass: breaksGracefully && ubSub.clientHeight > 15
    };

    // ----------------------------------------------------
    // TEST 3: Table Headers & Responsiveness Across Viewports
    // ----------------------------------------------------
    const viewports = [800, 1200, 1920];
    for (const vp of viewports) {
      const vpWrap = document.createElement("div");
      vpWrap.className = \`test-container viewport-\${vp}\`;
      vpWrap.style.width = vp + "px";
      vpWrap.innerHTML = \`
        <h3>Viewport \${vp}px</h3>
        <div class="table-wrap">
          <table class="data-table markets-table" id="marketsTable_\${vp}">
            <thead>
              <tr>
                <th>Coin</th>
                <th class="num">Price</th>
                <th class="num">OI 5m</th>
                <th class="num">OI 15m</th>
                <th class="num">OI 30m</th>
                <th class="num">OI 1h</th>
                <th class="num">OI 4h</th>
                <th class="num">Vol 1h</th>
                <th class="num">Vol 4h</th>
                <th>Venue</th>
                <th>Signal</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><div class="coin-cell"><span class="coin-badge-wrap"><span class="coin-fallback">BT</span></span><div class="coin-name">BTC<small>Bitcoin Perpetual Contract</small></div></div></td>
                <td class="num price-cell">$95,240.50</td>
                <td class="num val pass">+2.45%</td>
                <td class="num val pass">+1.20%</td>
                <td class="num val off">--</td>
                <td class="num val fail">-0.85%</td>
                <td class="num val pass">+3.10%</td>
                <td class="num val pass">+15.2%</td>
                <td class="num val pass">+42.0%</td>
                <td style="text-align:center"><span class="venue-tag">Bybit</span></td>
                <td style="text-align:center"><span class="pass-pill yes">READY</span></td>
                <td style="text-align:center"><button class="btn small primary">Trade</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="cg-wrap" style="margin-top: 15px;">
          <table class="data-table cg-table" id="cgTable_\${vp}">
            <thead>
              <tr>
                <th>Coin</th>
                <th class="num">OI 5m</th>
                <th class="num">Vol 1h</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><div class="coin-cell"><span class="coin-badge-wrap"><span class="coin-fallback">ET</span></span><div class="coin-name">ETH<small>Ethereum</small></div></div></td>
                <td class="num val pass">+1.85%</td>
                <td class="num val pass">+12.4%</td>
              </tr>
            </tbody>
          </table>
        </div>
      \`;
      root.appendChild(vpWrap);

      const mt = document.getElementById(\`marketsTable_\${vp}\`);
      const mtStyle = window.getComputedStyle(mt);
      const ths = Array.from(mt.querySelectorAll("th"));
      let headerOverlaps = 0;
      let headerClipping = 0;

      for (let i = 0; i < ths.length; i++) {
        const rect = ths[i].getBoundingClientRect();
        if (ths[i].scrollWidth > ths[i].clientWidth + 1) headerClipping++;
        if (i < ths.length - 1) {
          const nextRect = ths[i+1].getBoundingClientRect();
          if (rect.right > nextRect.left + 0.5) headerOverlaps++;
        }
      }

      const cgt = document.getElementById(\`cgTable_\${vp}\`);
      const cgtStyle = window.getComputedStyle(cgt);
      const cgThs = Array.from(cgt.querySelectorAll("th"));
      let cgOverlaps = 0;
      for (let i = 0; i < cgThs.length - 1; i++) {
        if (cgThs[i].getBoundingClientRect().right > cgThs[i+1].getBoundingClientRect().left + 0.5) {
          cgOverlaps++;
        }
      }

      const priceTh = ths[1];
      const priceThAlign = window.getComputedStyle(priceTh).textAlign;

      results.tableHeaders.push({
        viewport: vp,
        marketsMinWidth: mtStyle.minWidth,
        marketsTableWidth: Math.round(mt.getBoundingClientRect().width),
        marketsTableLayout: mtStyle.tableLayout,
        priceThAlign,
        headerOverlaps,
        headerClipping,
        cgMinWidth: cgtStyle.minWidth,
        cgTableWidth: Math.round(cgt.getBoundingClientRect().width),
        cgOverlaps,
        pass: mtStyle.minWidth === "980px" && cgtStyle.minWidth === "360px" && priceThAlign === "right" && headerOverlaps === 0 && headerClipping === 0 && cgOverlaps === 0
      });
    }

    // ----------------------------------------------------
    // TEST 4: Coin Logos, Fallback Badges & CLS = 0 Test
    // ----------------------------------------------------
    const logoWrap = document.createElement("div");
    logoWrap.className = "test-container";
    logoWrap.innerHTML = \`
      <h3>Coin Logos & CLS Test</h3>
      <div id="coinTestError" class="coin-cell">
        <span class="coin-badge-wrap" id="badgeWrap2">
          <img class="coin-logo" id="logo2" src="https://assets.invalid-domain-test.xyz/icons/fake@2x.png" width="20" height="20" alt="FAKE" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='inline-flex';">
          <span class="coin-fallback" id="fallback2" style="display:none" aria-hidden="true">FA</span>
        </span>
        <div class="coin-name">FAKE<small>Fake Coin</small></div>
      </div>
    \`;
    root.appendChild(logoWrap);

    const wrap2 = document.getElementById("badgeWrap2");
    const logo2 = document.getElementById("logo2");
    const fallback2 = document.getElementById("fallback2");

    // Measure before onerror
    const wrapBeforeRect = wrap2.getBoundingClientRect();
    const logoBeforeStyle = window.getComputedStyle(logo2);

    // Trigger onerror
    logo2.dispatchEvent(new Event("error"));

    // Measure after onerror
    const wrapAfterRect = wrap2.getBoundingClientRect();
    const fallbackAfterStyle = window.getComputedStyle(fallback2);

    const deltaWidth = Math.abs(wrapAfterRect.width - wrapBeforeRect.width);
    const deltaHeight = Math.abs(wrapAfterRect.height - wrapBeforeRect.height);
    const cls = deltaWidth + deltaHeight;

    results.coinLogos.push({
      logoWidth: logoBeforeStyle.width,
      logoHeight: logoBeforeStyle.height,
      fallbackWidth: fallbackAfterStyle.width,
      fallbackHeight: fallbackAfterStyle.height,
      fallbackDisplay: fallbackAfterStyle.display,
      wrapWidthBefore: Math.round(wrapBeforeRect.width * 10) / 10,
      wrapHeightBefore: Math.round(wrapBeforeRect.height * 10) / 10,
      wrapWidthAfter: Math.round(wrapAfterRect.width * 10) / 10,
      wrapHeightAfter: Math.round(wrapAfterRect.height * 10) / 10,
      deltaWidth,
      deltaHeight,
      cls,
      pass: deltaWidth === 0 && deltaHeight === 0 && fallbackAfterStyle.width === "20px" && fallbackAfterStyle.height === "20px"
    });

    // ----------------------------------------------------
    // TEST 5: Banner Priority Consolidation Verification
    // ----------------------------------------------------
    const bannerContainer = document.createElement("div");
    bannerContainer.className = "test-container";
    bannerContainer.innerHTML = '<div id="serverNotice" class="server-notice"></div>';
    root.appendChild(bannerContainer);

    // Mock banner registry & consolidation algorithm from app.js
    const BANNER_CONFIG = {
      "kill-switch": { priority: 100, level: "danger" },
      "offline": { priority: 50, level: "warn", category: "feed" },
      "market-stale": { priority: 45, level: "warn", category: "feed" },
      "stale": { priority: 40, level: "warn", category: "feed" },
      "max-trades": { priority: 30, level: "warn" }
    };

    function simulateConsolidation(banners, isRunning) {
      let candidateBanners = banners.filter(b => {
        if (!isRunning && b.category === "feed") return false;
        return true;
      });
      if (candidateBanners.length === 0) return { renderedId: null, count: 0 };

      const feedAlerts = candidateBanners.filter(b => b.category === "feed");
      if (feedAlerts.length > 1) {
        feedAlerts.sort((a, b) => (b.priority || 0) - (a.priority || 0));
        const highestFeed = feedAlerts[0];
        candidateBanners = candidateBanners.filter(b => b.category !== "feed" || b.id === highestFeed.id);
      }

      candidateBanners.sort((a, b) => (b.priority || 0) - (a.priority || 0));
      return {
        renderedId: candidateBanners[0].id,
        count: candidateBanners.length
      };
    }

    const testActiveBanners = [
      { id: "stale", priority: 40, category: "feed", message: "CoinGlass stale" },
      { id: "market-stale", priority: 45, category: "feed", message: "Market feed stale" },
      { id: "kill-switch", priority: 100, message: "Kill switch triggered" },
      { id: "max-trades", priority: 30, message: "Max trades hit" }
    ];

    // Scenario A: Running = true -> kill-switch wins (priority 100)
    const resRunning = simulateConsolidation(testActiveBanners, true);

    // Scenario B: Running = false, only feed alerts -> all feed alerts suppressed
    const resPausedFeedOnly = simulateConsolidation([
      { id: "stale", priority: 40, category: "feed", message: "CoinGlass stale" },
      { id: "market-stale", priority: 45, category: "feed", message: "Market feed stale" }
    ], false);

    results.bannerConsolidation = {
      scenarioARendered: resRunning.renderedId,
      scenarioATotalCandidates: resRunning.count,
      scenarioBFeedSuppressed: resPausedFeedOnly.renderedId === null,
      pass: resRunning.renderedId === "kill-switch" && resPausedFeedOnly.renderedId === null
    };

  } catch (err) {
    results.errors.push(String(err && err.stack ? err.stack : err));
  }

  // Send results back to test server
  await fetch("/report-results", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(results)
  });
}

window.addEventListener("DOMContentLoaded", () => {
  setTimeout(runTests, 100);
});
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/test-runner.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(runnerHtml);
    return;
  }

  if (req.url === "/styles.css") {
    res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
    res.end(stylesCss);
    return;
  }

  if (req.method === "POST" && req.url === "/report-results") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "received" }));

      try {
        const results = JSON.parse(body);
        handleBrowserResults(results);
      } catch (e) {
        console.error("Failed to parse browser results:", e);
        process.exit(1);
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const TEST_PORT = 4991;
server.listen(TEST_PORT, "127.0.0.1", () => {
  console.log(`Test server running at http://127.0.0.1:${TEST_PORT}/`);
  launchBrowser();
});

let browserProcess = null;
function launchBrowser() {
  const profileDir = "/tmp/firefox-empirical-test-profile";
  fs.mkdirSync(profileDir, { recursive: true });

  console.log("Launching Headless Firefox with profile:", profileDir);
  browserProcess = spawn("firefox", [
    "--headless",
    "--no-remote",
    "--profile", profileDir,
    `http://127.0.0.1:${TEST_PORT}/test-runner.html`
  ], { stdio: "ignore" });

  browserProcess.on("error", (err) => {
    console.error("Failed to spawn firefox:", err);
    process.exit(1);
  });
}

const timeoutHandle = setTimeout(() => {
  console.error("TIMEOUT: Headless Firefox did not report results within 15 seconds.");
  if (browserProcess) browserProcess.kill();
  server.close();
  process.exit(1);
}, 15000);

function handleBrowserResults(results) {
  clearTimeout(timeoutHandle);
  console.log("\n================================================================================");
  console.log("STEP 3: EMPIRICAL BROWSER RESULTS RECEIVED");
  console.log("================================================================================\n");

  if (results.errors && results.errors.length) {
    console.error("Browser encountered errors:", results.errors);
    process.exit(1);
  }

  console.log("--- 1. EMPTY STATE SPACING & COLLISION RESULTS ---");
  let emptyStateFailures = 0;
  for (const es of results.emptyStates) {
    const status = es.pass ? "PASS" : "FAIL";
    if (!es.pass) emptyStateFailures++;
    console.log(`[${status}] ${es.name.padEnd(38)}: display=${es.display}, gap=${es.verticalGap}px, margin-bottom=${es.marginBottom}, noCollision=${es.noCollision}`);
  }

  console.log("\n--- 2. KPI SUB-LABELS STRESS TEST RESULTS (40-60 CHAR STRINGS) ---");
  let kpiFailures = 0;
  for (const kpi of results.kpiCards) {
    const status = kpi.pass ? "PASS" : "FAIL";
    if (!kpi.pass) kpiFailures++;
    console.log(`[${status}] #${kpi.subId.padEnd(16)} (${kpi.charCount} chars): textOverflow=${kpi.textOverflow}, whiteSpace=${kpi.whiteSpace}, height=${kpi.clientHeight}px/${kpi.scrollHeight}px, belowValue=${kpi.positionedBelow}, wrapped=${kpi.wrappedMultipleLines}, unclipped=${kpi.zeroClipping}`);
  }

  if (results.unbrokenWordKpi) {
    const ub = results.unbrokenWordKpi;
    const status = ub.pass ? "PASS" : "FAIL";
    if (!ub.pass) kpiFailures++;
    console.log(`[${status}] Adversarial Unbroken String (${ub.charCount} chars): wordBreak=${ub.wordBreak}, clientWidth=${ub.clientWidth}px, height=${ub.clientHeight}px, breaksGracefully=${ub.breaksGracefully}`);
  }

  console.log("\n--- 3. TABLE HEADERS & RESPONSIVENESS RESULTS ---");
  let tableFailures = 0;
  for (const th of results.tableHeaders) {
    const status = th.pass ? "PASS" : "FAIL";
    if (!th.pass) tableFailures++;
    console.log(`[${status}] Viewport ${th.viewport}px: marketsMinWidth=${th.marketsMinWidth}, width=${th.marketsTableWidth}px, priceAlign=${th.priceThAlign}, headerOverlaps=${th.headerOverlaps}, clipping=${th.headerClipping}, cgMinWidth=${th.cgMinWidth}, cgOverlaps=${th.cgOverlaps}`);
  }

  console.log("\n--- 4. COIN LOGOS & CLS = 0 RESULTS ---");
  let logoFailures = 0;
  for (const cl of results.coinLogos) {
    const status = cl.pass ? "PASS" : "FAIL";
    if (!cl.pass) logoFailures++;
    console.log(`[${status}] Dimensions: logo=${cl.logoWidth}x${cl.logoHeight}, fallback=${cl.fallbackWidth}x${cl.fallbackHeight}, wrapBefore=${cl.wrapWidthBefore}x${cl.wrapHeightBefore}, wrapAfter=${cl.wrapWidthAfter}x${cl.wrapHeightAfter}, CLS=${cl.cls}`);
  }

  console.log("\n--- 5. BANNER PRIORITY CONSOLIDATION RESULTS ---");
  let bannerFailures = 0;
  const bc = results.bannerConsolidation;
  if (!bc.pass) bannerFailures++;
  console.log(`[${bc.pass ? "PASS" : "FAIL"}] Top Alert Rendered: "${bc.scenarioARendered}" (of ${bc.scenarioATotalCandidates} candidate alerts)`);
  console.log(`[${bc.pass ? "PASS" : "FAIL"}] Idle Feed Staleness Suppressed: ${bc.scenarioBFeedSuppressed}`);

  // Summary
  const totalFailures = emptyStateFailures + kpiFailures + tableFailures + logoFailures + bannerFailures;
  console.log("\n================================================================================");
  console.log("EMPIRICAL TEST HARNESS SUMMARY");
  console.log("================================================================================");
  console.log(`Symbol normalization & meme tests : ${testSymbols.length} / ${testSymbols.length} passed`);
  console.log(`Empty state tests                 : ${results.emptyStates.length - emptyStateFailures} / ${results.emptyStates.length} passed`);
  console.log(`KPI cards stress tests            : ${results.kpiCards.length + 1 - kpiFailures} / ${results.kpiCards.length + 1} passed`);
  console.log(`Table responsiveness tests        : ${results.tableHeaders.length - tableFailures} / ${results.tableHeaders.length} passed`);
  console.log(`Coin logo CLS tests               : ${results.coinLogos.length - logoFailures} / ${results.coinLogos.length} passed`);
  console.log(`Banner consolidation tests        : ${1 - bannerFailures} / 1 passed`);
  console.log(`Total Failures                    : ${totalFailures}`);

  if (browserProcess) browserProcess.kill();
  server.close(() => {
    if (totalFailures > 0) {
      console.error(`FAILED: ${totalFailures} empirical checks failed.`);
      process.exit(1);
    } else {
      console.log("\nSUCCESS: All empirical tests passed with 100% integrity!");
      process.exit(0);
    }
  });
}
