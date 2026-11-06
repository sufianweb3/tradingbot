import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Engine } from "../src/engine.js";
import { LiveExecutor } from "../src/executor/live.js";
import { createInitialState } from "../src/store.js";

function makeStubAdapter(positions = []) {
  return {
    id: "bybit",
    name: "Bybit",
    probeCapability: async () => ({ futuresOrderAvailable: true, trading: true }),
    getBalance: async () => ({ totalUsdt: 1000, availableUsdt: 1000 }),
    getInstruments: async () => [{ symbol: "BTCUSDT", minNotional: 5, lotSize: 0.001, minQty: 0.001, maxLeverage: 100 }],
    getPositions: async () => positions,
    placeMarket: async (sym, side, qty) => ({ orderId: "ord-1", symbol: sym, side, qty, price: 100 }),
    placeStop: async (sym, side, triggerPrice, qty) => ({ orderId: "stop-1", symbol: sym, side, triggerPrice, qty }),
    placeReduceLimit: async (sym, side, price, qty) => ({ orderId: "tp-1", symbol: sym, side, price, qty }),
    setLeverage: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
    cancelAll: async () => ({ ok: true }),
    closePosition: async (sym, side, qty) => ({ orderId: "close-1", symbol: sym, side, qty, price: 99 }),
  };
}

function makeEngine(settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-status-test-"));
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
    mode: "live",
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

test("status.json matches contract schema", () => {
  const statusFile = path.resolve("public/status.json");
  assert.ok(fs.existsSync(statusFile), "public/status.json must exist");
  const parsed = JSON.parse(fs.readFileSync(statusFile, "utf8"));
  assert.equal(typeof parsed.minVersion, "string");
  assert.equal(typeof parsed.liveEnabled, "boolean");
  assert.equal(typeof parsed.message, "string");
});

test("LiveExecutor.preTradeCheck allows trade when liveEnabled: true and killSwitchActive: false", async () => {
  const engine = makeEngine();
  const adapter = makeStubAdapter();
  engine.setLiveAdapter(adapter);
  await engine.liveExecutor.init();

  engine.liveEnabled = true;
  engine.killSwitchActive = false;

  const check = await engine.liveExecutor.preTradeCheck("BTCUSDT", "long", 250, 12500);
  assert.equal(check.ok, true);
});

test("LiveExecutor.preTradeCheck blocks new Live trade when liveEnabled: false with live-disabled-by-status", async () => {
  const engine = makeEngine();
  const adapter = makeStubAdapter();
  engine.setLiveAdapter(adapter);
  await engine.liveExecutor.init();

  engine.setStatusConfig({ liveEnabled: false, message: "Emergency maintenance" });
  assert.equal(engine.liveEnabled, false);
  assert.equal(engine.statusMessage, "Emergency maintenance");

  const check = await engine.liveExecutor.preTradeCheck("BTCUSDT", "long", 250, 12500);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "live-disabled-by-status");
});

test("LiveExecutor.preTradeCheck blocks new Live trade when killSwitchActive: true with kill-switch-active", async () => {
  const engine = makeEngine();
  const adapter = makeStubAdapter();
  engine.setLiveAdapter(adapter);
  await engine.liveExecutor.init();

  engine.liveEnabled = true;
  engine.killSwitchActive = true;

  const check = await engine.liveExecutor.preTradeCheck("BTCUSDT", "long", 250, 12500);
  assert.equal(check.ok, false);
  assert.equal(check.reason, "kill-switch-active");
});

test("Engine.setMode('live') blocks switching to live when liveEnabled: false", async () => {
  const engine = makeEngine({ mode: "paper" });
  const adapter = makeStubAdapter();
  engine.setLiveAdapter(adapter);

  engine.setStatusConfig({ liveEnabled: false });
  const res = await engine.setMode("live");
  assert.equal(res.ok, false);
  assert.match(res.error, /disabled by status configuration/i);
  assert.equal(engine.state.settings.mode, "paper");
});

test("When liveEnabled: false, existing open Live positions are monitored and exited normally", async () => {
  const engine = makeEngine({ mode: "live" });
  let trailingUpdated = false;
  let closedOnExchange = false;

  const adapter = makeStubAdapter();
  adapter.placeStop = async () => {
    trailingUpdated = true;
    return { orderId: "stop-updated" };
  };
  adapter.closePosition = async () => {
    closedOnExchange = true;
    return { orderId: "close-done" };
  };

  engine.setLiveAdapter(adapter);
  await engine.liveExecutor.init();

  // Add an existing open live position
  const pos = {
    id: "live-pos-1",
    symbol: "BTC",
    side: "long",
    mode: "live",
    status: "open",
    entryPrice: 100,
    currentPrice: 100,
    markPrice: 100,
    qty: 125,
    originalQty: 125,
    margin: 250,
    notional: 12500,
    leverage: 50,
    slPrice: 99.6,
    tp1Price: 101.0,
    tpMaxPrice: 120.0,
    tp1Hit: false,
    trailingActive: false,
    trailingStopPrice: null,
    highestPrice: 100,
    lowestPrice: 100,
    grossPnl: 0,
    entryFee: 0,
    exitFees: 0,
    exitQty: 0,
    exitNotional: 0,
    partials: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  engine.state.positions.push(pos);

  // Kill switch activates
  engine.setStatusConfig({ liveEnabled: false, message: "Maintenance window" });

  // 1. New trade attempt is blocked
  const openResult = await engine.liveExecutor.openPosition(
    { symbol: "BTC" },
    { price: 100 },
    { side: "long", qualified: true },
    null
  );
  assert.equal(openResult, null);

  // 2. Existing open position is updated via trailing stop
  await engine.liveExecutor.updateTrailingStop(pos, 105);
  assert.equal(pos.trailingActive, true);
  assert.ok(pos.trailingStopPrice > 0);
  assert.equal(trailingUpdated, true);

  // 3. Existing open position can close normally
  const closeRes = await engine.liveExecutor.closePosition(pos, 99.5, "SL");
  assert.ok(closeRes);
  assert.equal(closedOnExchange, true);
});

test("Paper trading mode continues opening and closing trades even when liveEnabled: false", async () => {
  const engine = makeEngine({ mode: "paper" });
  engine.setStatusConfig({ liveEnabled: false, message: "Live trading disabled" });

  const c = {
    symbol: "BTC",
    name: "Bitcoin",
    price: 100,
    oi: { "5m": 3.0 },
    vol: { "1h": 20 },
    oiUsd: 1000000,
    volUsd24h: 5000000,
    priceChange5m: 1.5,
    priceChange1h: 2.0,
  };
  const quote = { price: 100, ts: Date.now(), venue: "stub", base: "BTC" };
  const ev = { side: "long", qualified: true, checks: [] };

  const pos = await engine.paperExecutor.openPosition(c, quote, ev);
  assert.ok(pos, "Paper trade should open successfully");
  assert.equal(pos.symbol, "BTC");
  assert.equal(pos.mode, "paper");

  const closeRes = await engine.paperExecutor.closePosition(pos, 101, "TP1");
  assert.ok(closeRes);
  assert.equal(engine.state.trades.length, 1);
});
