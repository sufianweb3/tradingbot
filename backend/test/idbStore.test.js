/**
 * Tests for IndexedDB store adapter (web/store-idb.js)
 * Uses fake-indexeddb for deterministic Node test execution.
 */

import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";

import { IndexedDbStore } from "../web/store-idb.js";
import { createInitialState } from "../src/store.js";

test("idbStore initializes and loads initial state cleanly", async () => {
  const store = await IndexedDbStore.open();
  const state = store.load();

  assert.ok(state, "state should exist");
  assert.equal(typeof state.settings, "object", "settings should be an object");
  assert.equal(state.settings.totalFund, 500, "default totalFund should be 500");
  assert.equal(state.initialFund, 500, "default initialFund should be 500");
  assert.ok(Array.isArray(state.positions), "positions should be an array");
  assert.ok(Array.isArray(state.trades), "trades should be an array");
  assert.equal(store.fallbackMode, false, "should not be in fallback mode when IDB is available");
});

test("idbStore debounces save and flushes dirty state to IndexedDB", async () => {
  const store = await IndexedDbStore.open();
  const state = store.load();

  state.settings.totalFund = 1200;
  state.positions.push({ id: "pos_1", symbol: "BTC", status: "open", qty: 1, entryPrice: 60000, margin: 250 });
  store.save(state);

  // Flush immediately
  await store.flush();

  // Re-open from IDB to verify persistence
  const reloaded = await IndexedDbStore.open();
  const loadedState = reloaded.load();

  assert.equal(loadedState.settings.totalFund, 1200, "persisted fund total should match");
  assert.equal(loadedState.positions.length, 1, "persisted position should be retained");
  assert.equal(loadedState.positions[0].symbol, "BTC", "symbol should match");
});

test("idbStore resets strategy data while preserving configuration", async () => {
  const store = await IndexedDbStore.open();
  store.state = createInitialState();
  store.state.settings.leverage = 25;
  store.state.trades.push({ id: "t1", symbol: "ETH", grossPnl: 50 });
  store.save(store.state);
  await store.flush();

  await store.reset();

  assert.equal(store.state.trades.length, 0, "trades should be wiped after reset");
  assert.equal(store.state.positions.length, 0, "positions should be wiped after reset");
  assert.equal(store.state.settings.leverage, 25, "settings should survive reset");
});

test("idbStore exports and imports complete backup JSON", async () => {
  const store = await IndexedDbStore.open();
  store.state = createInitialState();
  store.state.trades.push({ id: "trade_99", symbol: "SOL", grossPnl: 100 });
  await store.flush();

  const backup = await store.exportBackup();
  assert.equal(backup.version, 1, "backup version should be 1");
  assert.ok(backup.state, "backup state must exist");
  assert.equal(backup.state.trades.length, 1, "trade should be present in backup");

  // Create another instance and import
  const freshStore = await IndexedDbStore.open();
  await freshStore.importBackup(backup);

  assert.equal(freshStore.state.trades.length, 1, "imported trades should match");
  assert.equal(freshStore.state.trades[0].symbol, "SOL", "imported symbol should match");
});

test("idbStore imports legacy state.json from v1 server", async () => {
  const store = await IndexedDbStore.open();
  const legacyState = {
    version: 1,
    settings: { totalFund: 2000, leverage: 10 },
    initialFund: 2000,
    positions: [],
    trades: [{ id: "legacy_1", symbol: "DOGE", grossPnl: 42 }],
    equityCurve: [{ t: 1000, equity: 2000 }],
    logs: [],
    meta: { running: false },
  };

  const res = await store.importLegacyState(legacyState);
  assert.ok(res.ok, "legacy import should succeed");
  assert.equal(store.state.settings.totalFund, 2000, "legacy fund should migrate");
  assert.equal(store.state.settings.leverage, 10, "legacy settings should migrate");
  assert.equal(store.state.trades.length, 1, "legacy trades should migrate");
});

test("idbStore graceful fallback to in-memory mode when IDB is unavailable", async () => {
  const store = await IndexedDbStore.open({ idbFactory: null });
  assert.equal(store.fallbackMode, true, "should enter fallbackMode when idbFactory is null");

  const state = store.load();
  assert.ok(state, "fallback state should still load");
  state.settings.totalFund = 888;
  store.save(state);
  await store.flush();

  assert.equal(store.load().settings.totalFund, 888, "fallback in-memory store should work seamlessly");
});
