/**
 * Unit tests for the pure strategy logic: filters, level math, position
 * management, statistics, settings normalisation and report rendering.
 *
 * Run with: npm test  (node --test test/*.test.js)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  OI_TIMEFRAMES,
  VOL_TIMEFRAMES,
  buildChecks,
  compare,
  computeLevels,
  computeStats,
  enabledFilterCount,
  evaluateCoin,
  positionAction,
  positionMetrics,
  priceMovePct,
} from "../src/trading.js";
import { DEFAULT_SETTINGS, createInitialState, normalizeSettings } from "../src/store.js";
import { equitySvg, renderCsv, renderJson, renderReport } from "../src/report.js";

const RISK = {
  leverage: 50,
  riskMode: "roe",
  slPercent: 20,
  tp1Percent: 50,
  tpMaxPercent: 1000,
  trailingDistancePercent: 20,
};

function settingsWith(overrides = {}) {
  return normalizeSettings({ ...DEFAULT_SETTINGS, ...overrides });
}

function position(overrides = {}) {
  return {
    id: "pos_test",
    status: "open",
    symbol: "BTC",
    side: "long",
    entryPrice: 100,
    qty: 1,
    originalQty: 1,
    margin: 2,
    slPrice: 99.6,
    tp1Price: 101,
    tpMaxPrice: 120,
    liqPrice: 98.5,
    trailMove: 0.004,
    tp1Hit: false,
    trailingEnabled: true,
    trailingStart: "tp1",
    trailingActive: false,
    trailStopPrice: null,
    peakPrice: 100,
    tp1ClosePercent: 50,
    feePercent: 0,
    slPercent: 20,
    tp1Percent: 50,
    ...overrides,
  };
}

test("compare handles >=, <= and unparseable values", () => {
  assert.equal(compare(5, ">=", 5), true);
  assert.equal(compare(4.9, ">=", 5), false);
  assert.equal(compare(-3, "<=", -2), true);
  assert.equal(compare(null, ">=", 0), false);
  assert.equal(compare(1, ">=", ""), false);
});

test("priceMovePct converts ROE to a price move and passes price mode through", () => {
  assert.equal(priceMovePct("roe", 20, 50), 0.4);
  assert.equal(priceMovePct("roe", 1000, 100), 10);
  assert.equal(priceMovePct("price", 20, 50), 20);
  // leverage is clamped to at least 1
  assert.equal(priceMovePct("roe", 20, 0), 20);
});

test("computeLevels places long levels correctly in ROE mode", () => {
  const lv = computeLevels({ side: "long", entry: 100, settings: RISK });
  assert.equal(lv.dir, 1);
  assert.ok(Math.abs(lv.slPrice - 99.6) < 1e-9);
  assert.ok(Math.abs(lv.tp1Price - 101) < 1e-9);
  assert.ok(Math.abs(lv.tpMaxPrice - 120) < 1e-9);
  assert.ok(Math.abs(lv.liqPrice - 98.5) < 1e-9);
  assert.ok(lv.slPrice < 100 && lv.tp1Price > 100 && lv.liqPrice < lv.slPrice);
});

test("computeLevels mirrors levels for shorts", () => {
  const lv = computeLevels({ side: "short", entry: 100, settings: RISK });
  assert.equal(lv.dir, -1);
  assert.ok(Math.abs(lv.slPrice - 100.4) < 1e-9);
  assert.ok(Math.abs(lv.tp1Price - 99) < 1e-9);
  assert.ok(Math.abs(lv.tpMaxPrice - 80) < 1e-9);
  assert.ok(Math.abs(lv.liqPrice - 101.5) < 1e-9);
});

test("price risk mode uses the percentage directly", () => {
  const lv = computeLevels({
    side: "long",
    entry: 200,
    settings: { ...RISK, riskMode: "price", slPercent: 10, tp1Percent: 20, tpMaxPercent: 100, trailingDistancePercent: 5 },
  });
  assert.ok(Math.abs(lv.slPrice - 180) < 1e-9);
  assert.ok(Math.abs(lv.tp1Price - 240) < 1e-9);
  assert.ok(Math.abs(lv.tpMaxPrice - 400) < 1e-9);
});

test("filters are blank by default and ignored until configured", () => {
  const s = settingsWith();
  assert.equal(enabledFilterCount(s), 0);
  assert.equal(s.oiFilters.length, OI_TIMEFRAMES.length);
  assert.equal(s.volFilters.length, VOL_TIMEFRAMES.length);
  for (const f of [...s.oiFilters, ...s.volFilters]) {
    assert.equal(f.enabled, false);
    assert.equal(f.threshold, null);
  }

  const coin = { oi: { "5m": 99 }, vol: { "1h": 99 } };
  const ev = evaluateCoin(coin, s);
  assert.equal(ev.configured, false);
  assert.equal(ev.qualified, false);
  assert.equal(ev.side, null);
  assert.equal(ev.checks.length, 0);
});

test("an enabled row with a blank threshold still does not count", () => {
  const s = settingsWith({
    oiFilters: [{ key: "5m", enabled: true, op: ">=", threshold: "" }],
  });
  assert.equal(enabledFilterCount(s), 0);
  assert.equal(s.oiFilters.find((f) => f.key === "5m").threshold, null);
});

test("all enabled filters must pass and side is derived from OI operators", () => {
  const s = settingsWith({
    oiFilters: [{ key: "5m", enabled: true, op: ">=", threshold: 5 }],
    volFilters: [{ key: "1h", enabled: true, op: ">=", threshold: 10 }],
  });
  assert.equal(enabledFilterCount(s), 2);

  const longCoin = { oi: { "5m": 6 }, vol: { "1h": 11 } };
  const longEv = evaluateCoin(longCoin, s);
  assert.equal(longEv.configured, true);
  assert.equal(longEv.qualified, true);
  assert.equal(longEv.side, "long");
  assert.equal(longEv.passCount, 2);
  assert.equal(longEv.total, 2);

  const failing = evaluateCoin({ oi: { "5m": 6 }, vol: { "1h": 9 } }, s);
  assert.equal(failing.qualified, false);
  assert.equal(failing.passCount, 1);

  const shortSettings = settingsWith({
    oiFilters: [{ key: "5m", enabled: true, op: "<=", threshold: -5 }],
  });
  const shortEv = evaluateCoin({ oi: { "5m": -6 }, vol: {} }, shortSettings);
  assert.equal(shortEv.qualified, true);
  assert.equal(shortEv.side, "short");
});

test("mixed OI operators require an explicit direction", () => {
  const s = settingsWith({
    oiFilters: [
      { key: "5m", enabled: true, op: ">=", threshold: 1 },
      { key: "4h", enabled: true, op: "<=", threshold: 5 },
    ],
  });
  const ev = evaluateCoin({ oi: { "5m": 2, "4h": 3 }, vol: {} }, s);
  assert.equal(ev.passCount, 2);
  assert.equal(ev.autoSide, null);
  assert.equal(ev.side, null);
  assert.equal(ev.qualified, false);
  assert.equal(ev.needsDirection, true);

  const forced = evaluateCoin({ oi: { "5m": 2, "4h": 3 }, vol: {} }, { ...s, direction: "long" });
  assert.equal(forced.side, "long");
  assert.equal(forced.qualified, true);
});

test("missing market data fails the check and is counted", () => {
  const s = settingsWith({
    oiFilters: [{ key: "5m", enabled: true, op: ">=", threshold: 5 }],
  });
  const ev = evaluateCoin({ oi: {}, vol: {} }, s);
  assert.equal(ev.qualified, false);
  assert.equal(ev.missing, 1);
  assert.equal(ev.checks[0].value, null);
  assert.equal(buildChecks({ oi: {} }, s)[0].pass, false);
});

test("positionMetrics values the remaining quantity and exit fee", () => {
  const m = positionMetrics(position({ qty: 2, feePercent: 0.1 }), 110);
  assert.ok(Math.abs(m.gross - 20) < 1e-9); // (110-100) * 2
  assert.ok(Math.abs(m.exitFee - 0.22) < 1e-9); // 110 * 2 * 0.1%
  assert.ok(Math.abs(m.net - 19.78) < 1e-9);
  assert.ok(Math.abs(m.grossRoe - 1000) < 1e-9); // 20 / 2 margin
});

test("positionAction closes on stop loss", () => {
  const a = positionAction(position(), 99);
  assert.equal(a.type, "close");
  assert.equal(a.reason, "SL");
  assert.equal(a.price, 99.6);
});

test("liquidation takes priority over the stop", () => {
  const a = positionAction(position(), 98);
  assert.equal(a.type, "close");
  assert.equal(a.reason, "Liquidation");
  assert.equal(a.price, 98.5);
  assert.equal(a.force, true);
});

test("TP1 takes a partial exit and leaves the rest open", () => {
  const a = positionAction(position(), 101.5);
  assert.equal(a.type, "partial");
  assert.equal(a.reason, "TP1");
  assert.equal(a.price, 101.5);
  assert.equal(a.pct, 50);
});

test("trailing stop arms after TP1 and closes on the retrace", () => {
  const p = position({
    tp1Hit: true,
    trailingActive: true,
    trailStopPrice: 100.5,
    peakPrice: 102,
  });
  const a = positionAction(p, 100.8);
  assert.equal(a.type, "close");
  assert.equal(a.reason, "Trailing SL");
  // peak 102 * (1 - 0.004) = 101.592
  assert.ok(Math.abs(a.price - 101.592) < 1e-9);
});

test("trailing start immediate arms without TP1", () => {
  const p = position({ trailingStart: "immediate" });
  const a = positionAction(p, 100.2);
  assert.equal(a.type, "none");
  assert.equal(a.next.trailingActive, true);
  assert.ok(Math.abs(a.next.trailStopPrice - 99.7992) < 1e-9);
});

test("TP max closes the runner after TP1", () => {
  const p = position({ tp1Hit: true, trailingActive: false });
  const a = positionAction(p, 121);
  assert.equal(a.type, "close");
  assert.equal(a.reason, "TP max");
  assert.equal(a.price, 120);
});

test("short position actions mirror longs", () => {
  const p = position({
    side: "short",
    slPrice: 100.4,
    tp1Price: 99,
    tpMaxPrice: 80,
    liqPrice: 101.5,
    peakPrice: 100,
    trailMove: 0.004,
  });
  assert.equal(positionAction(p, 100.5).reason, "SL");
  assert.equal(positionAction(p, 102).reason, "Liquidation");
  assert.equal(positionAction(p, 102).force, true);
  const partial = positionAction(p, 98.5);
  assert.equal(partial.type, "partial");
  assert.equal(partial.reason, "TP1");
});

test("short trailing stop ratchets downward and triggers on upward bounce", () => {
  const p = position({
    side: "short",
    slPrice: 100.4,
    tp1Price: 99,
    tpMaxPrice: 80,
    liqPrice: 101.5,
    peakPrice: 99,
    tp1Hit: true,
    trailingActive: true,
    trailStopPrice: 99.5,
    trailMove: 0.005, // 0.5%
  });

  // Price drops favorably to 90 -> peak becomes 90, trail stop should be 90 * (1 + 0.005) = 90.45
  const step1 = positionAction(p, 90);
  assert.equal(step1.type, "none");
  assert.equal(step1.next.peakPrice, 90);
  assert.ok(Math.abs(step1.next.trailStopPrice - 90.45) < 1e-9);

  // Price bounces up slightly to 90.2 -> peak stays 90, trail stop must NOT loosen
  const step2 = positionAction({ ...p, ...step1.next }, 90.2);
  assert.equal(step2.type, "none");
  assert.equal(step2.next.peakPrice, 90);
  assert.ok(Math.abs(step2.next.trailStopPrice - 90.45) < 1e-9);

  // Price rises to 90.5 -> above trail stop 90.45 -> triggers Trailing SL close
  const step3 = positionAction({ ...p, ...step1.next }, 90.5);
  assert.equal(step3.type, "close");
  assert.equal(step3.reason, "Trailing SL");
  assert.ok(Math.abs(step3.price - 90.45) < 1e-9);
});

test("short TP max closes the runner when price drops to or below tpMaxPrice", () => {
  const p = position({
    side: "short",
    slPrice: 100.4,
    tp1Price: 99,
    tpMaxPrice: 80,
    tp1Hit: true,
    trailingActive: false,
  });
  const a = positionAction(p, 79.5);
  assert.equal(a.type, "close");
  assert.equal(a.reason, "TP max");
  assert.equal(a.price, 80);
});

test("short positionMetrics computes inverted PnL and ROE", () => {
  const pos = position({ side: "short", entryPrice: 100, qty: 2, margin: 4, feePercent: 0.1 });
  // Price drops to 90: gross gain is (100 - 90) * 2 = +20
  const win = positionMetrics(pos, 90);
  assert.ok(Math.abs(win.gross - 20) < 1e-9);
  assert.ok(Math.abs(win.exitFee - 0.18) < 1e-9); // 90 * 2 * 0.1%
  assert.ok(Math.abs(win.net - 19.82) < 1e-9);
  assert.ok(Math.abs(win.grossRoe - 500) < 1e-9); // 20 / 4 margin * 100 = 500%

  // Price rises to 105: gross loss is (100 - 105) * 2 = -10
  const loss = positionMetrics(pos, 105);
  assert.ok(Math.abs(loss.gross - (-10)) < 1e-9);
  assert.ok(Math.abs(loss.grossRoe - (-250)) < 1e-9);
});

test("dual profiles evaluate independently and price filters work", () => {
  const s = normalizeSettings({
    profiles: {
      long: {
        enabled: true,
        oiFilters: [{ key: "5m", enabled: true, op: ">=", threshold: 5 }],
        priceFilters: [{ key: "1h", enabled: true, op: ">=", threshold: 2 }],
      },
      short: {
        enabled: true,
        oiFilters: [{ key: "5m", enabled: true, op: "<=", threshold: -5 }],
        priceFilters: [{ key: "1h", enabled: true, op: "<=", threshold: -2 }],
      },
    },
  });

  const bullishCoin = { oi: { "5m": 6 }, vol: {}, priceChange1h: 3 };
  const longEv = evaluateCoin(bullishCoin, s.profiles.long, "long");
  const shortEv = evaluateCoin(bullishCoin, s.profiles.short, "short");
  assert.equal(longEv.qualified, true);
  assert.equal(longEv.side, "long");
  assert.equal(shortEv.qualified, false);

  const bearishCoin = { oi: { "5m": -8 }, vol: {}, priceChange1h: -4 };
  const bLong = evaluateCoin(bearishCoin, s.profiles.long, "long");
  const bShort = evaluateCoin(bearishCoin, s.profiles.short, "short");
  assert.equal(bLong.qualified, false);
  assert.equal(bShort.qualified, true);
  assert.equal(bShort.side, "short");
});

test("legacy settings migrate to profiles.long with profiles.short disabled", () => {
  const legacy = {
    totalFund: 1000,
    leverage: 25,
    slPercent: 15,
    tp1Percent: 40,
    oiFilters: [{ key: "15m", enabled: true, op: ">=", threshold: 3 }],
  };
  const normalized = normalizeSettings(legacy);
  assert.equal(normalized.profiles.long.enabled, true);
  assert.equal(normalized.profiles.long.leverage, 25);
  assert.equal(normalized.profiles.long.slPercent, 15);
  assert.equal(normalized.profiles.long.tp1Percent, 40);
  assert.equal(normalized.profiles.short.enabled, false);
  assert.equal(normalized.leverage, 25); // Top-level mirror works
});

test("computeStats aggregates wins, losses, profit factor and streaks", () => {
  const trades = [
    { id: "a", side: "long", pnlNet: 10, feesPaid: 1, exitTime: 1 },
    { id: "b", side: "short", pnlNet: -5, feesPaid: 1, exitTime: 2 },
    { id: "c", side: "long", pnlNet: 20, feesPaid: 1, exitTime: 3 },
  ];
  const stats = computeStats({
    trades,
    positions: [],
    initialFund: 100,
    equityCurve: [
      { t: 1, equity: 100 },
      { t: 2, equity: 125 },
      { t: 3, equity: 90 },
      { t: 4, equity: 125 },
    ],
  });
  assert.equal(stats.totalTrades, 3);
  assert.equal(stats.wins, 2);
  assert.equal(stats.losses, 1);
  assert.equal(stats.winrate, (2 / 3) * 100);
  assert.equal(stats.realizedPnl, 25);
  assert.equal(stats.balance, 125);
  assert.equal(stats.equity, 125);
  assert.equal(stats.totalPnl, 25);
  assert.equal(stats.grossProfit, 30);
  assert.equal(stats.grossLoss, 5);
  assert.equal(stats.profitFactor, 6);
  assert.equal(stats.maxDrawdown, 35); // 125 -> 90
  assert.equal(stats.maxWinStreak, 1);
  assert.equal(stats.maxLossStreak, 1);
  assert.equal(stats.long.count, 2);
  assert.equal(stats.short.count, 1);
  assert.equal(stats.bestTrade.id, "c");
  assert.equal(stats.worstTrade.id, "b");
});

test("computeStats counts partial exits as realized cash for open positions", () => {
  const open = position({
    qty: 0.5,
    entryFee: 1,
    markPrice: 110,
    partials: [{ net: 4, fee: 0.2 }],
  });
  const stats = computeStats({
    trades: [{ id: "a", side: "long", pnlNet: 5, feesPaid: 1, exitTime: 1 }],
    positions: [open],
    initialFund: 100,
    equityCurve: [{ t: 1, equity: 100 }],
  });
  assert.equal(stats.openTrades, 1);
  assert.equal(stats.realizedPnl, 9); // 5 closed + 4 partial
  assert.ok(Math.abs(stats.balance - 108) < 1e-9); // 100 + 9 - 1 open entry fee
  assert.ok(Math.abs(stats.unrealizedPnl - 5) < 1e-9); // remaining 0.5 @ +10
  assert.ok(Math.abs(stats.equity - 113) < 1e-9);
  assert.equal(stats.lockedMargin, 2);
  assert.ok(Math.abs(stats.available - 106) < 1e-9);
});

test("computeStats handles an empty account", () => {
  const stats = computeStats({ trades: [], positions: [], initialFund: 500, equityCurve: [] });
  assert.equal(stats.totalTrades, 0);
  assert.equal(stats.winrate, 0);
  assert.equal(stats.profitFactor, null);
  assert.equal(stats.equity, 500);
  assert.equal(stats.totalPnl, 0);
  assert.equal(stats.maxDrawdown, 0);
});

test("normalizeSettings supplies the documented defaults", () => {
  const s = normalizeSettings();
  assert.equal(s.totalFund, 500);
  assert.equal(s.allocationPercent, 50);
  assert.equal(s.leverage, 50);
  assert.equal(s.slPercent, 20);
  assert.equal(s.tp1Percent, 50);
  assert.equal(s.tp1ClosePercent, 50);
  assert.equal(s.tpMaxPercent, 1000);
  assert.equal(s.trailingEnabled, true);
  assert.equal(s.trailingDistancePercent, 20);
  assert.equal(s.maxTrades, 0);
  assert.equal(s.riskMode, "roe");
  assert.equal(s.sizingMode, "allocation");
});

test("normalizeSettings clamps bad numbers and rejects unknown options", () => {
  const s = normalizeSettings({
    totalFund: -10,
    allocationPercent: 999,
    leverage: 0,
    slPercent: -5,
    feePercent: 99,
    sizingMode: "martingale",
    riskMode: "magic",
    direction: "sideways",
    venues: ["mexc", "not-a-venue"],
  });
  assert.equal(s.totalFund, 1);
  assert.equal(s.allocationPercent, 100);
  assert.equal(s.leverage, 1);
  assert.equal(s.slPercent, 0.01);
  assert.equal(s.feePercent, 2);
  assert.equal(s.sizingMode, "allocation");
  assert.equal(s.riskMode, "roe");
  assert.equal(s.direction, "auto");
  assert.deepEqual(s.venues, ["mexc"]);
});

test("normalizeSettings canonicalises excluded symbols", () => {
  const s = normalizeSettings({ excludeSymbols: " usdc , wbtc;DAI " });
  assert.equal(s.excludeSymbols, "USDC,WBTC,DAI");
});

test("createInitialState starts paused with a funded equity curve", () => {
  const st = createInitialState({ totalFund: 750 });
  assert.equal(st.settings.totalFund, 750);
  assert.equal(st.initialFund, 750);
  assert.equal(st.trades.length, 0);
  assert.equal(st.positions.length, 0);
  assert.equal(st.equityCurve.length, 1);
  assert.equal(st.equityCurve[0].equity, 750);
  assert.equal(st.meta.running, false);
});

function reportData() {
  const settings = settingsWith({
    oiFilters: [{ key: "5m", enabled: true, op: ">=", threshold: 3 }],
  });
  const trades = [
    {
      id: "t1",
      symbol: "BTC",
      side: "long",
      venue: "mexc",
      venueName: "MEXC",
      entryTime: Date.UTC(2026, 0, 1),
      exitTime: Date.UTC(2026, 0, 1, 1),
      entryPrice: 100,
      exitPrice: 102,
      margin: 250,
      leverage: 50,
      grossPnl: 12,
      entryFee: 1,
      exitFees: 1,
      feesPaid: 2,
      pnlNet: 10,
      roe: 4,
      exitReason: "TP max",
      durationMs: 3600000,
    },
  ];
  const stats = computeStats({
    trades,
    positions: [],
    initialFund: 500,
    equityCurve: [
      { t: Date.UTC(2026, 0, 1), equity: 500 },
      { t: Date.UTC(2026, 0, 1, 1), equity: 510 },
    ],
  });
  return {
    generatedAt: Date.UTC(2026, 0, 1, 2),
    settings,
    initialFund: 500,
    meta: { createdAt: Date.UTC(2026, 0, 1) },
    stats,
    positions: [],
    trades,
    equityCurve: [
      { t: Date.UTC(2026, 0, 1), equity: 500 },
      { t: Date.UTC(2026, 0, 1, 1), equity: 510 },
    ],
    logs: [],
    venues: { venues: [] },
  };
}

test("renderCsv emits a header and one row per trade", () => {
  const csv = renderCsv(reportData());
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("id,symbol,side,venue"));
  assert.ok(lines[1].includes("BTC"));
  assert.ok(lines[1].includes("TP max"));
});

test("renderJson round-trips the report payload", () => {
  const parsed = JSON.parse(renderJson(reportData()));
  assert.equal(parsed.initialFund, 500);
  assert.equal(parsed.trades.length, 1);
  assert.equal(parsed.stats.totalTrades, 1);
});

test("renderReport contains the KPIs, filters and full trade history", () => {
  const html = renderReport(reportData());
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("PAPER"));
  assert.ok(html.includes("Total P/L"));
  assert.ok(html.includes("Profit factor"));
  assert.ok(html.includes("Max drawdown"));
  assert.ok(html.includes("OI 5m"));
  assert.ok(html.includes("BTC"));
  assert.ok(html.includes("TP max"));
  assert.ok(html.includes("<svg"));
  assert.ok(html.includes("$500.00"));
});

test("equitySvg handles a single point and an empty curve", () => {
  assert.ok(equitySvg([], 500).includes("<svg"));
  assert.ok(equitySvg([{ t: Date.now(), equity: 500 }], 500).includes("<svg"));
  assert.ok(!equitySvg([{ t: Date.now(), equity: NaN }], 500).includes("NaN"));
});
