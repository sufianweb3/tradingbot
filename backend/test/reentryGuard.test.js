/**
 * Same-coin re-entry guard: pure index/status tests plus persistence migration.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REENTRY_WINDOW_MIN,
  buildReentryIndex,
  getReentryStatus,
  positionActivityAt,
  resolveReentryWindow,
  tradeActivityAt,
} from "../src/core/reentryGuard.js";
import { createInitialState, normalizeSettings, sanitizeLoadedState } from "../src/store.js";

const HOUR = 60 * 60 * 1000;
const now = Date.now();

function settings(overrides = {}) {
  return normalizeSettings({ totalFund: 500, ...overrides });
}

test("re-entry defaults to a 12 hour lock", () => {
  const s = settings();
  assert.equal(DEFAULT_REENTRY_WINDOW_MIN, 720);
  assert.equal(s.reenterEnabled, true);
  assert.equal(s.reenterDelayMin, 720);
  assert.equal(s.cooldownSec, 43200);

  const cfg = resolveReentryWindow(s);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.windowSec, 43200);
});

test("the lock starts at the latest trade activity (entry, partial or close)", () => {
  const trade = {
    symbol: "BTC",
    entryTime: now - 5 * HOUR,
    exitTime: now - 1 * HOUR,
    partials: [{ t: now - 2 * HOUR }],
  };
  assert.equal(tradeActivityAt(trade), now - 1 * HOUR);

  const index = buildReentryIndex({ trades: [trade] });
  const status = getReentryStatus("BTC", index, settings(), now);
  assert.equal(status.blocked, true);
  assert.equal(status.source, "trade-history");
  assert.ok(status.remainingSec >= 11 * 3600);
  assert.ok(status.remainingSec <= 12 * 3600);
});

test("live positions lock their coin from entry time", () => {
  const position = { symbol: "ETH", status: "open", entryTime: now - 2 * HOUR };
  assert.equal(positionActivityAt(position), now - 2 * HOUR);

  const index = buildReentryIndex({ positions: [position] });
  const status = getReentryStatus("ETH", index, settings(), now);
  assert.equal(status.blocked, true);
  assert.equal(status.open, true);
  assert.equal(status.source, "open-position");
  assert.ok(status.remainingSec > 9 * 3600);
});

test("only the traded coin is locked", () => {
  const index = buildReentryIndex({
    trades: [{ symbol: "BTC", entryTime: now - HOUR, exitTime: now - HOUR }],
  });
  assert.equal(getReentryStatus("BTC", index, settings(), now).blocked, true);
  assert.equal(getReentryStatus("ETH", index, settings(), now).blocked, false);
});

test("a window that has elapsed no longer blocks", () => {
  const index = buildReentryIndex({
    trades: [{ symbol: "BTC", entryTime: now - 20 * HOUR, exitTime: now - 13 * HOUR }],
  });
  const status = getReentryStatus("BTC", index, settings(), now);
  assert.equal(status.blocked, false);
  assert.equal(status.remainingSec, 0);
});

test("disabling the lock clears the block without losing the activity data", () => {
  const index = buildReentryIndex({
    trades: [{ symbol: "BTC", entryTime: now - HOUR, exitTime: now - HOUR }],
  });
  const off = settings({ reenterEnabled: false });
  const status = getReentryStatus("BTC", index, off, now);
  assert.equal(status.enabled, false);
  assert.equal(status.blocked, false);
  assert.ok(status.lastTradeAt > 0);
});

test("store rebuilds the lock from trade history and live positions", () => {
  const state = sanitizeLoadedState({
    settings: { totalFund: 500 },
    trades: [{ id: "t1", symbol: "btc", entryTime: now - 2 * HOUR, exitTime: now - HOUR }],
    positions: [
      { id: "p1", symbol: "eth", status: "open", entryTime: now - 3 * HOUR, qty: 1, margin: 10 },
    ],
    meta: { reentryDefaultsVersion: 1 },
  });

  assert.ok(state.meta.reentryBlocks.BTC >= now - HOUR);
  assert.ok(state.meta.reentryBlocks.ETH >= now - 3 * HOUR);

  const index = buildReentryIndex({
    trades: state.trades,
    positions: state.positions,
    blocks: state.meta.reentryBlocks,
  });
  assert.equal(getReentryStatus("BTC", index, state.settings, now).blocked, true);
  assert.equal(getReentryStatus("ETH", index, state.settings, now).blocked, true);
  assert.equal(getReentryStatus("ETH", index, state.settings, now).open, true);
});

test("a fresh state marks the new defaults and keeps the 12h lock", () => {
  const state = createInitialState({ totalFund: 500 });
  assert.equal(state.meta.reentryDefaultsVersion, 1);
  assert.equal(state.settings.reenterEnabled, true);
  assert.equal(state.settings.reenterDelayMin, 720);
});
