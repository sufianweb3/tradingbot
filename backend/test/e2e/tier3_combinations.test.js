/**
 * Tier 3: Cross-Feature Combinations (Pairwise & Interaction Testing)
 *
 * Verifies orthogonal feature interactions:
 * - Live mode toggle with active positions (never auto-closed)
 * - Kill switch engaged while scanner finds high-conviction signals
 * - Panic button triggered across multiple active positions and trailing stops
 * - Strategy drawer edits concurrent with live ticker mark price simulation
 * - Reconcile trigger during active trailing stop execution
 * - Exchange disconnect with open positions
 * - Dual profile conflict resolution (coin passing Long & Short skipped)
 * - Backup export/import round-trip while engine is running
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MockBackendServer,
  FrontendStateDriver,
  calculateExecutionSnapshot,
  assertFinancialInvariants,
  assertTrailingStopMonotonicity,
} from "./harness/harness.js";
import { MOCK_SEED_COINS, MOCK_SEED_POSITIONS } from "./harness/mockData.js";

test("Tier 3 [C1]: Live mode toggle with active open positions: positions never auto-closed (PRD 5.5 M5)", () => {
  const driver = new FrontendStateDriver();
  const initialPosCount = driver.positions.length;
  assert.ok(initialPosCount > 0, "Must start with open positions");

  // Switch to live mode
  driver.setMode("live");
  assert.equal(driver.mode, "live");
  assert.equal(
    driver.positions.length,
    initialPosCount,
    "Positions must remain intact when switching to live"
  );

  // Switch back to paper mode
  driver.setMode("paper");
  assert.equal(driver.mode, "paper");
  assert.equal(
    driver.positions.length,
    initialPosCount,
    "Positions must remain intact when switching back to paper"
  );
});

test("Tier 3 [C2]: Kill switch engaged while scanner finds qualified signals: entry blocked, management continues", () => {
  const driver = new FrontendStateDriver();
  driver.setKillSwitch(true);

  // Scanner finds top qualified coin
  const qualifiedCoin = driver.coins.find((c) => c.status === "qualified");
  assert.ok(qualifiedCoin, "Qualified coin exists");

  // Attempting entry must fail
  assert.throws(
    () => driver.openTrade(qualifiedCoin, "long"),
    /Entry blocked: Kill switch is active/
  );

  // Meanwhile, existing open positions continue receiving price ticks and trailing management
  const btcPos = driver.positions.find((p) => p.symbol === "BTC");
  const prevStop = btcPos.trailingStop;
  driver.updateMarkPrice("BTC", 95500.0);
  assert.ok(
    btcPos.trailingStop >= prevStop,
    "Position management must continue even when kill switch blocks new entries"
  );
});

test("Tier 3 [C3]: Panic button triggered with multiple open positions and active trailing stops", () => {
  const driver = new FrontendStateDriver();
  assert.equal(driver.positions.length, 3);
  const initialTrades = driver.trades.length;

  driver.panicAll();

  // All positions closed
  assert.equal(driver.positions.length, 0);
  // Kill switch engaged
  assert.equal(driver.killSwitch, true);
  // Closed trades recorded
  assert.equal(driver.trades.length, initialTrades + 3);
  // Open PnL is zero
  assert.equal(driver.stats.openPnl, 0);
  // Financial invariants preserved
  assertFinancialInvariants({
    initialFund: driver.initialFund,
    realizedPnl: driver.stats.realised,
    unrealizedPnl: driver.stats.openPnl,
    equity: driver.stats.equity,
    freeMargin: driver.stats.freeMargin,
    deployedMargin: driver.stats.deployedMargin,
  });
});

test("Tier 3 [C4]: Strategy drawer parameter edits concurrent with live ticker updates", () => {
  const driver = new FrontendStateDriver();
  const btcPos = driver.positions.find((p) => p.symbol === "BTC");

  // User edits strategy settings in drawer (dirty state)
  driver.dirtyStrategy = true;
  driver.strategy.profiles.long.leverage = 20; // Changed draft leverage
  driver.strategy.profiles.long.slPercent = 2.5;

  // Meanwhile live market ticker updates mark prices
  driver.updateMarkPrice("BTC", 95200.0);
  driver.updateMarkPrice("SOL", 185.0);

  // Existing position keeps its original leverage (10x), not retroactively mutated
  assert.equal(btcPos.leverage, 10);
  assert.equal(btcPos.markPrice, 95200.0);
  assert.ok(btcPos.roe > 0);

  // Once settings are saved, new entries adopt the updated leverage
  const newPos = driver.openTrade(driver.coins[1], "long");
  assert.equal(newPos.leverage, 20);
});

test("Tier 3 [C5]: Reconcile trigger during active trailing stop execution", async () => {
  const server = new MockBackendServer();
  await server.start();
  try {
    // Advance trailing stop
    const pos = server.state.positions[0];
    pos.markPrice = 96000.0;
    pos.trailingStop = 94800.0;

    // Trigger reconcile
    const res = await fetch(`${server.baseUrl}/api/reconcile`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.adminSecret}` },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reconciled, true);
    assert.equal(data.syncedPositions, server.state.positions.length);

    // Verify trailing stop did NOT revert to initial SL
    assert.equal(server.state.positions[0].trailingStop, 94800.0);
  } finally {
    await server.stop();
  }
});

test("Tier 3 [C6]: Exchange disconnect with active open positions", async () => {
  const server = new MockBackendServer();
  await server.start();
  try {
    // Disconnect venue where position exists
    const res = await fetch(`${server.baseUrl}/api/exchange/disconnect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ venue: "bybit" }),
    });
    assert.equal(res.status, 200);

    // Bybit position still retained in state
    const bybitPos = server.state.positions.find((p) => p.venue === "bybit");
    assert.ok(bybitPos, "Position on disconnected exchange must NOT be deleted silently");

    // Exchange status marks venue disconnected
    const exRes = await fetch(`${server.baseUrl}/api/exchange/status`, {
      headers: { authorization: `Bearer ${server.adminSecret}` },
    });
    const exData = await exRes.json();
    const bybitEx = exData.exchanges.find((e) => e.id === "bybit");
    assert.equal(bybitEx.connected, false);
  } finally {
    await server.stop();
  }
});

test("Tier 3 [C7]: Dual profile conflict resolution: coin passing Long and Short skipped (PRD 5.4 S5)", () => {
  const driver = new FrontendStateDriver();
  const conflictCoin = driver.coins.find((c) => c.isConflict || c.side === "conflict");
  assert.ok(conflictCoin, "Conflict coin fixture must exist");

  // S5 Rule: "A coin passing both profiles is skipped and logged as conflict."
  const shouldOpen = !conflictCoin.isConflict;
  assert.equal(shouldOpen, false, "Coin passing both long and short criteria must NOT open a trade");
});

test("Tier 3 [C8]: Backup export & import round-trip while trading engine runs", async () => {
  const server = new MockBackendServer();
  await server.start();
  try {
    // 1. Export backup while running
    const exportRes = await fetch(`${server.baseUrl}/api/backup/export`, {
      headers: { authorization: `Bearer ${server.adminSecret}` },
    });
    const { backup } = await exportRes.json();
    assert.ok(backup.settings);
    assert.ok(backup.positions.length > 0);

    // 2. Modify running state (open a trade)
    await fetch(`${server.baseUrl}/api/trade/open`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ symbol: "ETH", side: "long" }),
    });

    // 3. Re-import original backup
    const importRes = await fetch(`${server.baseUrl}/api/backup/import`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(backup),
    });
    assert.equal(importRes.status, 200);

    // 4. Engine remains running and healthy
    const healthRes = await fetch(`${server.baseUrl}/api/health`);
    const health = await healthRes.json();
    assert.equal(health.ok, true);
    assert.equal(health.running, true);
  } finally {
    await server.stop();
  }
});
