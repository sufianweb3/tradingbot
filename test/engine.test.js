/**
 * Engine integration tests. No network: the exchange hub is stubbed so we can
 * drive fills, partial exits and trailing stops deterministically.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Engine } from "../src/engine.js";
import { createInitialState, sanitizeLoadedState as require_store } from "../src/store.js";

function makeEngine(settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-bot-test-"));
  const engine = new Engine({ dataDir: dir });
  engine.state = createInitialState({
    totalFund: 500,
    allocationPercent: 50,
    allocationBase: "initial",
    leverage: 50,
    slPercent: 20,
    tp1Percent: 50,
    tp1ClosePercent: 50,
    tpMaxPercent: 1000,
    trailingEnabled: true,
    trailingStart: "tp1",
    trailingDistancePercent: 20,
    feePercent: 0,
    slippagePercent: 0,
    ...settings,
  });
  engine.hub = {
    resolve: () => null,
    quote: async () => ({ price: 100, ts: Date.now(), venue: "stub", venueName: "Stub", base: "BTC" }),
    summary: () => ({ venues: [], okVenues: 0, totalVenues: 0, instruments: 0 }),
    discover: async () => {},
  };
  return engine;
}

function coin(symbol) {
  return {
    symbol,
    name: symbol,
    price: 100,
    oi: { "5m": 10 },
    vol: { "1h": 10 },
    oiUsd: 1e9,
    volUsd24h: 1e9,
  };
}

function open(engine, symbol, price = 100) {
  return engine._openPosition(
    coin(symbol),
    { venue: "stub", venueName: "Stub", venueSymbol: symbol, base: symbol, price, ts: Date.now() },
    { side: "long", checks: [] }
  );
}

test("50%-of-fund sizing fills two positions despite entry fees", () => {
  const engine = makeEngine();
  try {
    const a = open(engine, "BTC");
    const b = open(engine, "ETH");
    assert.ok(a && b, "both positions should open");
    assert.equal(engine.state.positions.length, 2);
    // 500 fund / 2 allocation = 250 margin each, 50x = 12,500 notional.
    for (const p of engine.state.positions) {
      assert.equal(p.margin, 250);
      assert.ok(Math.abs(p.notional - 12500) < 1e-6);
      assert.ok(Math.abs(p.qty - 125) < 1e-9);
      assert.ok(Math.abs(p.slPrice - 99.6) < 1e-9);
      assert.ok(Math.abs(p.tp1Price - 101) < 1e-9);
      assert.ok(Math.abs(p.tpMaxPrice - 120) < 1e-9);
    }
    // A third position cannot be funded.
    const c = open(engine, "SOL");
    assert.equal(c, null);
    assert.equal(engine.state.positions.length, 2);
  } finally {
    engine.destroy();
  }
});

test("a price tick takes TP1 partially, then closes the runner on the trail", async () => {
  const engine = makeEngine();
  try {
    const pos = open(engine, "BTC", 100);
    assert.ok(pos);

    // +1.2% price -> +60% ROE, above the 50% TP1.
    engine.hub.quote = async () => ({
      price: 101.2,
      ts: Date.now(),
      venue: "stub",
      venueName: "Stub",
      base: "BTC",
    });
    await engine._tickPrices();
    let p = engine.state.positions[0];
    assert.equal(engine.state.positions.length, 1);
    assert.equal(p.tp1Hit, true);
    assert.equal(p.trailingActive, true);
    assert.ok(Math.abs(p.qty - 62.5) < 1e-9, "half the quantity is taken at TP1");
    assert.equal(p.partials.length, 1);
    assert.ok(Math.abs(p.partials[0].gross - 75) < 1e-9); // 1.2 * 62.5

    // Retrace through the trail: peak 101.2 * (1 - 0.004) = 100.7952.
    engine.hub.quote = async () => ({
      price: 99,
      ts: Date.now(),
      venue: "stub",
      venueName: "Stub",
      base: "BTC",
    });
    await engine._tickPrices();
    assert.equal(engine.state.positions.length, 0);
    assert.equal(engine.state.trades.length, 1);
    const trade = engine.state.trades[0];
    assert.equal(trade.exitReason, "Trailing SL");
    // Partial +75, runner (99 - 100) * 62.5 = -62.5.
    assert.ok(Math.abs(trade.grossPnl - 12.5) < 1e-9);
    assert.ok(Math.abs(trade.pnlNet - 12.5) < 1e-9);
    assert.equal(trade.qty, 125);
  } finally {
    engine.destroy();
  }
});

test("stop loss closes the whole position and records one trade", async () => {
  const engine = makeEngine();
  try {
    open(engine, "BTC", 100);
    engine.hub.quote = async () => ({
      price: 99.5,
      ts: Date.now(),
      venue: "stub",
      venueName: "Stub",
      base: "BTC",
    });
    await engine._tickPrices();
    assert.equal(engine.state.positions.length, 0);
    assert.equal(engine.state.trades.length, 1);
    const trade = engine.state.trades[0];
    assert.equal(trade.exitReason, "SL");
    // (99.5 - 100) * 125 = -62.5
    assert.ok(Math.abs(trade.pnlNet + 62.5) < 1e-9);
    const stats = engine.getStats();
    assert.equal(stats.totalTrades, 1);
    assert.equal(stats.losses, 1);
    assert.ok(stats.equity < 500);
  } finally {
    engine.destroy();
  }
});

test("maxTrades pauses the bot after the configured number of closed trades", async () => {
  const engine = makeEngine({ maxTrades: 1 });
  try {
    engine.state.meta.running = true;
    open(engine, "BTC", 100);
    engine.hub.quote = async () => ({
      price: 99.5,
      ts: Date.now(),
      venue: "stub",
      venueName: "Stub",
      base: "BTC",
    });
    await engine._tickPrices();
    assert.equal(engine.state.meta.running, false);
    assert.equal(engine.state.meta.stopReason, "max-trades");
  } finally {
    engine.destroy();
  }
});

test("manual close uses the last mark when the feed is unavailable", async () => {
  const engine = makeEngine();
  try {
    const pos = open(engine, "BTC", 100);
    pos.markPrice = 102;
    engine.hub.quote = async () => null;
    const res = await engine.closePositionById(pos.id, "Manual");
    assert.equal(res.ok, true);
    assert.equal(res.trade.exitReason, "Manual");
    assert.ok(Math.abs(res.trade.pnlNet - 250) < 1e-9); // (102-100)*125
    assert.equal(engine.state.positions.length, 0);
  } finally {
    engine.destroy();
  }
});

test("changing the fund with no history re-bases the equity curve", () => {
  const engine = makeEngine();
  try {
    const res = engine.updateSettings({ totalFund: 1000 });
    assert.equal(res.reset, false);
    assert.equal(engine.state.initialFund, 1000);
    assert.equal(engine.state.settings.totalFund, 1000);
    assert.equal(engine.state.equityCurve.length, 1);
    assert.equal(engine.state.equityCurve[0].equity, 1000);
    assert.equal(engine.getStats().totalPnl, 0);
  } finally {
    engine.destroy();
  }
});

test("changing the fund with history resets trades and positions", () => {
  const engine = makeEngine();
  try {
    open(engine, "BTC", 100);
    assert.equal(engine.state.positions.length, 1);
    const res = engine.updateSettings({ totalFund: 750 });
    assert.equal(res.reset, true);
    assert.equal(engine.state.initialFund, 750);
    assert.equal(engine.state.trades.length, 0);
    assert.equal(engine.state.positions.length, 0);
    assert.equal(engine.state.meta.running, false);
    assert.equal(engine.getStats().equity, 750);
  } finally {
    engine.destroy();
  }
});

test("CoinGlass API key is write-only and survives routine saves", () => {
  const engine = makeEngine();
  try {
    const res = engine.setCoinglassApiKey("  secret-key  ");
    assert.equal(engine.state.settings.coinglassApiKey, "secret-key");
    // Never echoed back to a client.
    assert.equal(res.settings.coinglassApiKey, "");
    assert.equal(res.settings.coinglassKeySet, true);
    assert.equal(engine.getBootstrap().settings.coinglassApiKey, "");
    assert.equal(engine.getReportData().settings.coinglassApiKey, "");
    assert.equal(engine.getMeta().coinglassKeySet, true);
    assert.equal(engine.getMarketStatus().source, "api");

    // A normal settings save posts a blank key and must not clear it.
    engine.updateSettings({ totalFund: 500, coinglassApiKey: "" });
    assert.equal(engine.state.settings.coinglassApiKey, "secret-key");

    engine.setCoinglassApiKey(null);
    assert.equal(engine.state.settings.coinglassApiKey, "");
    assert.equal(engine.getMeta().coinglassKeySet, false);
    assert.equal(engine.getMarketStatus().source, "scrape");
  } finally {
    engine.destroy();
  }
});

test("device feed overrides scraping and is normalised", () => {
  const engine = makeEngine();
  try {
    const res = engine.ingestDeviceFeed({
      coins: [
        { symbol: "btc", name: "Bitcoin", price: 100, oi: { "5m": 3.5, "1h": -1 }, vol: { "1h": 2 }, oiUsd: 1e9, volUsd24h: 5e8 },
        { symbol: "ETH", name: "Ethereum", price: 50, oi: { "15m": 1 }, vol: { "4h": 4 } },
        { symbol: "bad symbol!", price: 1 },
        { symbol: "BTC", price: 999 },
      ],
      total: 2,
      fetchedAt: Date.now(),
    });
    assert.equal(res.ok, true);
    assert.equal(res.coins, 2, "invalid and duplicate rows are dropped");
    assert.equal(engine.getMarketStatus().source, "device");
    assert.equal(engine.getMarketStatus().connected, true);
    assert.equal(engine.marketCache.coins[0].symbol, "BTC");
    assert.equal(engine.marketCache.coins[0].oi["5m"], 3.5);
    assert.equal(engine.marketCache.coins[0].price, 100, "first row wins over the duplicate");

    const empty = engine.ingestDeviceFeed({ coins: [] });
    assert.equal(empty.ok, false);
  } finally {
    engine.destroy();
  }
});

test("stacking: maxPositionsPerCoin allows more than one trade per coin", () => {
  const engine = makeEngine({
    allocationPercent: 20,
    maxPositionsPerCoin: 1,
    reenterEnabled: false,
    reenterDelayMin: 0,
  });
  try {
    assert.ok(open(engine, "BTC"));
    assert.equal(open(engine, "BTC"), null, "default rule keeps one position per coin");
    assert.equal(engine.state.positions.length, 1);

    engine.updateSettings({ maxPositionsPerCoin: 3 });
    assert.ok(open(engine, "BTC"), "second position allowed");
    assert.ok(open(engine, "BTC"), "third position allowed");
    assert.equal(open(engine, "BTC"), null, "fourth blocked by the per-coin cap");
    assert.equal(engine.state.positions.length, 3);
    engine.marketCache = { at: Date.now(), coins: [coin("BTC")], total: 1, pages: 1, error: null };
    assert.equal(engine.getMarketRows().find((r) => r.symbol === "BTC").openCount, 3);
  } finally {
    engine.destroy();
  }
});

test("re-entry: a closed coin can trade again as soon as it qualifies", () => {
  const engine = makeEngine({ allocationPercent: 20, cooldownSec: 0 });
  try {
    const first = open(engine, "BTC");
    assert.ok(first);
    engine._closePosition(first, 100, "test close");
    assert.equal(engine.state.positions.length, 0);

    const second = open(engine, "BTC");
    assert.ok(second, "cooldown 0 must allow an immediate second trade");
    assert.notEqual(second.id, first.id);
  } finally {
    engine.destroy();
  }
});

test("re-entry: cooldownSec still blocks a fast re-entry when configured", () => {
  const engine = makeEngine({ allocationPercent: 20, cooldownSec: 300 });
  try {
    const first = open(engine, "BTC");
    engine._closePosition(first, 100, "test close");
    assert.equal(open(engine, "BTC"), null, "cooling for 300s");
    engine.marketCache = { at: Date.now(), coins: [coin("BTC")], total: 1, pages: 1, error: null };
    assert.equal(engine.getMarketRows().find((r) => r.symbol === "BTC").cooling, true);
  } finally {
    engine.destroy();
  }
});

test("legacy state: the old 300s cooldown migrates to the 12h default once", () => {
  const legacy = require_store({
    settings: { totalFund: 500, cooldownSec: 300 },
    initialFund: 500,
  });
  assert.equal(legacy.settings.reenterEnabled, true);
  assert.equal(legacy.settings.reenterDelayMin, 720);
  assert.equal(legacy.settings.cooldownSec, 43200);

  // A state written by the new build keeps an explicit legacy cooldown.
  const current = require_store({
    settings: { totalFund: 500, cooldownSec: 300, maxPositionsPerCoin: 2 },
    initialFund: 500,
    meta: { reentryDefaultsVersion: 1 },
  });
  assert.equal(current.settings.cooldownSec, 300);
  assert.equal(current.settings.maxPositionsPerCoin, 2);
});

test("cooling is reported with a remaining time and a block reason", async () => {
  const engine = makeEngine({ cooldownSec: 40000 });
  try {
    const p = open(engine, "BTC");
    engine._closePosition(p, 100, "test close");
    const remaining = engine._coolingRemainingSec("BTC");
    assert.ok(remaining > 39000, `expected ~40000s, got ${remaining}`);
    assert.equal(engine._isCooling("BTC"), true);
    assert.equal(
      engine._blockReason({
        symbol: "BTC",
        excluded: false,
        stale: false,
        tradable: true,
        cooling: true,
        price: 100,
      }),
      "cooling"
    );
    const manual = await engine.openManual("BTC");
    assert.equal(manual.ok, false);
    assert.equal(manual.error, "cooling");
    assert.ok(manual.remainingSec > 39000);
  } finally {
    engine.destroy();
  }
});

test("re-entry delay in minutes blocks only the same coin", () => {
  const engine = makeEngine({
    allocationPercent: 20,
    reenterEnabled: true,
    reenterDelayMin: 30,
  });
  try {
    assert.equal(engine.state.settings.cooldownSec, 1800);
    const btc = open(engine, "BTC");
    engine._closePosition(btc, 100, "test close");
    assert.equal(engine._isCooling("BTC"), true);
    assert.ok(engine._coolingRemainingSec("BTC") > 1790);
    assert.equal(engine._isCooling("ETH"), false, "other coins are not delayed");
    assert.ok(open(engine, "ETH"), "ETH can open while BTC is delayed");
    assert.equal(open(engine, "BTC"), null, "BTC cannot re-enter during the delay");
    assert.ok(engine.state.meta.reentryBlocks.BTC > 0, "close time is persisted");
  } finally {
    engine.destroy();
  }
});

test("re-entry delay is derived from minutes even when cooldownSec is stale", () => {
  const engine = makeEngine({
    allocationPercent: 20,
    reenterEnabled: true,
    reenterDelayMin: 30,
    cooldownSec: 0,
  });
  try {
    // Simulate a state saved by an older build: the explicit fields are set,
    // but the derived cooldownSec is still 0.
    engine.state.settings.cooldownSec = 0;
    const btc = open(engine, "BTC");
    engine._closePosition(btc, 100, "test close");
    assert.equal(engine._isCooling("BTC"), true, "explicit delay must win over stale cooldownSec");
    assert.ok(engine._coolingRemainingSec("BTC") > 1790);
    assert.equal(open(engine, "BTC"), null, "BTC cannot re-enter during the 30m delay");
  } finally {
    engine.destroy();
  }
});

test("re-entry delay survives a server restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-bot-restart-"));
  const engine = new Engine({ dataDir: dir });
  try {
    engine.state = createInitialState({
      totalFund: 500,
      allocationPercent: 20,
      reenterEnabled: true,
      reenterDelayMin: 30,
    });
    const pos = open(engine, "BTC");
    engine._closePosition(pos, 100, "test close");
    engine.store.save(engine.state);
    engine.store.flush();
  } finally {
    engine.destroy();
  }

  const restarted = new Engine({ dataDir: dir });
  try {
    assert.ok(restarted._coolingRemainingSec("BTC") > 1700);
    assert.equal(restarted._isCooling("BTC"), true);
  } finally {
    restarted.destroy();
  }
});

test("default same-coin lock blocks for 12h and can be turned off", () => {
  const engine = makeEngine({ allocationPercent: 20 });
  try {
    assert.equal(engine.state.settings.reenterEnabled, true);
    assert.equal(engine.state.settings.reenterDelayMin, 720);

    const pos = open(engine, "BTC");
    engine._closePosition(pos, 100, "test close");
    assert.equal(engine._isCooling("BTC"), true, "12h lock is on by default");
    assert.ok(engine._coolingRemainingSec("BTC") > 43190);
    assert.equal(engine._isCooling("ETH"), false, "other coins are unaffected");

    engine.marketCache = {
      at: Date.now(),
      coins: [coin("BTC")],
      total: 1,
      pages: 1,
      error: null,
    };
    const row = engine.getMarketRows().find((r) => r.symbol === "BTC");
    assert.equal(row.cooling, true);
    assert.ok(row.coolingRemainingSec > 43190);

    engine.updateSettings({ reenterEnabled: false });
    assert.equal(engine.state.settings.cooldownSec, 0);
    assert.equal(engine._isCooling("BTC"), false);
    assert.ok(open(engine, "BTC"), "re-entry is allowed once the lock is off");
  } finally {
    engine.destroy();
  }
});

test("same-coin lock blocks stacking even when maxPositionsPerCoin is higher", () => {
  const engine = makeEngine({ allocationPercent: 20, maxPositionsPerCoin: 3 });
  try {
    assert.ok(open(engine, "BTC"), "first entry opens");
    assert.equal(open(engine, "BTC"), null, "the lock blocks a second same-coin entry");
    assert.equal(engine.state.positions.length, 1);
  } finally {
    engine.destroy();
  }
});

test("price loop schedules nothing while flat and starts when a position opens", () => {
  const engine = makeEngine();
  const scheduled = [];
  engine.timers = {
    setTimeout: (fn, ms) => {
      scheduled.push(ms);
      return scheduled.length;
    },
    clearTimeout: () => {},
  };
  try {
    engine._schedulePriceTick();
    assert.equal(scheduled.length, 0, "an idle bot must not wake the engine");
    open(engine, "BTC");
    assert.ok(scheduled.length >= 1, "opening a position starts the price loop");
  } finally {
    engine.destroy();
  }
});

test("dual scan: a coin qualifying for both long and short is skipped as conflict (PRD S5)", async () => {
  const engine = makeEngine({
    profiles: {
      long: {
        enabled: true,
        oiFilters: [{ key: "5m", enabled: true, op: ">=", threshold: 5 }],
      },
      short: {
        enabled: true,
        oiFilters: [{ key: "5m", enabled: true, op: "<=", threshold: 10 }],
      },
    },
  });
  try {
    engine.state.meta.running = true;
    // BTC has OI 5m = 7, passing BOTH >= 5 (long) AND <= 10 (short) -> conflict!
    const conflictCoin = {
      symbol: "BTC",
      name: "Bitcoin",
      price: 100,
      oi: { "5m": 7 },
      vol: { "1h": 10 },
      oiUsd: 1e8,
      volUsd24h: 1e8,
    };
    engine.marketCache = {
      at: Date.now(),
      coins: [conflictCoin],
      total: 1,
      pages: 1,
      error: null,
    };

    const rows = engine.getMarketRows();
    const btcRow = rows.find((r) => r.symbol === "BTC");
    assert.ok(btcRow);
    assert.equal(btcRow.isConflict, true);
    assert.equal(btcRow.side, "conflict");
    assert.equal(btcRow.qualified, false);
    assert.equal(btcRow.blockReason, "conflict");

    const res = await engine.scan();
    assert.equal(res.opened, 0, "conflict coin must not be opened");
    assert.equal(engine.state.positions.length, 0);
  } finally {
    engine.destroy();
  }
});

test("one-way mode forbids opening an opposite position on the same coin (PRD S6)", () => {
  const engine = makeEngine({
    profiles: {
      long: { enabled: true, maxPositionsPerCoin: 3 },
      short: { enabled: true, maxPositionsPerCoin: 3 },
    },
  });
  try {
    // Open a LONG position on BTC
    const longPos = engine._openPosition(
      coin("BTC"),
      { venue: "stub", venueName: "Stub", venueSymbol: "BTC", base: "BTC", price: 100, ts: Date.now() },
      { side: "long", checks: [] }
    );
    assert.ok(longPos);
    assert.equal(engine.state.positions.length, 1);

    // Attempting to open a SHORT on BTC must be blocked by one-way position mode
    const shortPos = engine._openPosition(
      coin("BTC"),
      { venue: "stub", venueName: "Stub", venueSymbol: "BTC", base: "BTC", price: 100, ts: Date.now() },
      { side: "short", checks: [] }
    );
    assert.equal(shortPos, null, "opposite short position must be blocked on BTC");
    assert.equal(engine._canOpenMore("BTC", "short"), false);
    // But another LONG is allowed up to maxPositionsPerCoin
    assert.equal(engine._canOpenMore("BTC", "long"), true);
  } finally {
    engine.destroy();
  }
});

test("short trade execution: opens, takes TP1 partially, and closes on trailing stop", async () => {
  const engine = makeEngine({
    allocationPercent: 50,
    leverage: 50,
    profiles: {
      short: {
        enabled: true,
        leverage: 50,
        slPercent: 20,
        tp1Percent: 50, // 50% ROE at 50x = 1% price move down -> 99.0
        tp1ClosePercent: 50,
        trailingEnabled: true,
        trailingStart: "tp1",
        trailingDistancePercent: 20, // 20% ROE at 50x = 0.4% distance
      },
    },
  });
  try {
    // Open a SHORT on ETH @ 100
    const shortPos = engine._openPosition(
      coin("ETH"),
      { venue: "stub", venueName: "Stub", venueSymbol: "ETH", base: "ETH", price: 100, ts: Date.now() },
      { side: "short", checks: [] }
    );
    assert.ok(shortPos);
    assert.equal(shortPos.side, "short");
    assert.equal(shortPos.slPrice, 100.4); // SL above entry
    assert.equal(shortPos.tp1Price, 99);   // TP1 below entry

    // Price drops to 99 -> triggers TP1 partial exit
    engine.hub.quote = async () => ({ price: 99, ts: Date.now(), venue: "stub", venueName: "Stub", base: "ETH" });
    await engine._tickPrices();
    assert.equal(shortPos.tp1Hit, true);
    assert.equal(shortPos.partials.length, 1);
    assert.equal(shortPos.partials[0].reason, "TP1");

    // Price drops further to 95 -> trailing stop tightens to 95 * 1.004 = 95.38
    engine.hub.quote = async () => ({ price: 95, ts: Date.now(), venue: "stub", venueName: "Stub", base: "ETH" });
    await engine._tickPrices();
    assert.equal(shortPos.trailingActive, true);
    assert.ok(Math.abs(shortPos.trailStopPrice - 95.38) < 1e-6);

    // Price bounces up to 96 -> above trailing stop 95.38 -> closes on Trailing SL
    engine.hub.quote = async () => ({ price: 96, ts: Date.now(), venue: "stub", venueName: "Stub", base: "ETH" });
    await engine._tickPrices();

    assert.equal(engine.state.positions.length, 0, "position closed");
    assert.equal(engine.state.trades.length, 1, "trade recorded");
    const trade = engine.state.trades[0];
    assert.equal(trade.side, "short");
    assert.equal(trade.profile, "short");
    assert.ok(trade.pnlNet > 0, "net PnL is positive on winning short trade");
  } finally {
    engine.destroy();
  }
});

test("Engine._finalize preserves live trade audit fields (PRD L14 / §6.5)", () => {
  const engine = makeEngine();
  try {
    const pos = engine._openPosition(
      coin("BTC"),
      { venue: "bybit", venueName: "Bybit", venueSymbol: "BTCUSDT", base: "BTC", price: 100, ts: Date.now() },
      { side: "long", checks: [] }
    );
    assert.ok(pos);

    // Attach mock live execution audit metadata to position
    pos.orderIds = ["ord_entry_1", "ord_sl_2"];
    pos.fills = [{ id: "fill_1", price: 100, qty: 1, fee: 0.05 }];
    pos.feesExchange = 0.05;
    pos.fundingExchange = -0.01;
    pos.protection = { slOrderId: "sl_123", tp1OrderId: "tp_456" };
    pos.exchangeSymbol = "BTCUSDT";
    pos.clientIdPrefix = "oi_bybit_";

    const trade = engine._finalize(pos, "manual-test");
    assert.ok(trade, "finalized trade record returned");
    assert.deepEqual(trade.orderIds, ["ord_entry_1", "ord_sl_2"]);
    assert.deepEqual(trade.fills, [{ id: "fill_1", price: 100, qty: 1, fee: 0.05 }]);
    assert.equal(trade.feesExchange, 0.05);
    assert.equal(trade.fundingExchange, -0.01);
    assert.deepEqual(trade.protection, { slOrderId: "sl_123", tp1OrderId: "tp_456" });
    assert.equal(trade.exchangeSymbol, "BTCUSDT");
    assert.equal(trade.clientIdPrefix, "oi_bybit_");
  } finally {
    engine.destroy();
  }
});

