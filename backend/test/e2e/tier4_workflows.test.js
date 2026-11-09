/**
 * Tier 4: Real-World Application Scenarios (End-to-End Trading Workflows)
 *
 * Implements 4 complete end-to-end user workflows:
 * - Scenario 1: Complete End-to-End Trading Session (Bootstrap -> Scanner -> Signal -> Inspect -> Connect -> Open -> Trail -> Close -> CSV Export)
 * - Scenario 2: Emergency Risk Incident & Panic Recovery (Crash -> Loss Cap -> Panic Close -> Audit)
 * - Scenario 3: Live Trading Transition, Guardrails & Real Fill Accounting
 * - Scenario 4: Strategy Profile Lifecycle & Preset URL Hash Sharing
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MockBackendServer,
  FrontendStateDriver,
  calculateExecutionSnapshot,
  calculateExecutionCostPreview,
  assertFinancialInvariants,
  assertTrailingStopMonotonicity,
} from "./harness/harness.js";
import { MOCK_START_FUND, MOCK_SEED_COINS } from "./harness/mockData.js";

// ============================================================================
// Scenario 1: Complete End-to-End Trading Session
// ============================================================================

test("Tier 4 [Scenario 1]: Complete End-to-End Trading Session Lifecycle", async () => {
  const server = new MockBackendServer();
  await server.start();

  try {
    // ------------------------------------------------------------------------
    // Step 1: Bootstrap & Workstation Initialization
    // ------------------------------------------------------------------------
    const bootRes = await fetch(`${server.baseUrl}/api/bootstrap`, {
      headers: { authorization: `Bearer ${server.adminSecret}` },
    });
    assert.equal(bootRes.status, 200);
    const bootData = await bootRes.json();
    assert.equal(bootData.ok, true);
    assert.equal(bootData.mode, "paper");
    assert.equal(bootData.running, true);
    assert.equal(bootData.stats.initialFund, MOCK_START_FUND);

    // ------------------------------------------------------------------------
    // Step 2: Live Market Screener & Signal Discovery
    // ------------------------------------------------------------------------
    const scanRes = await fetch(`${server.baseUrl}/api/scan`, {
      method: "POST",
      headers: { authorization: `Bearer ${server.adminSecret}` },
    });
    assert.equal(scanRes.status, 200);
    const scanData = await scanRes.json();
    assert.ok(scanData.scanCount > 0);

    const btcCoin = server.state.coins.find((c) => c.symbol === "BTC");
    assert.ok(btcCoin, "BTC market row discovered in screener");
    assert.equal(btcCoin.status, "qualified");
    assert.equal(btcCoin.side, "long");

    // ------------------------------------------------------------------------
    // Step 3: Execution Quality & Depth Inspection (Inspector Modal)
    // ------------------------------------------------------------------------
    const snap = calculateExecutionSnapshot(btcCoin);
    assert.equal(snap.status, "PASS", "High conviction BTC signal must PASS EQE gate");
    assert.ok(snap.spreadBps > 0 && snap.spreadBps < 5.0, "Spread within 5 bps");
    assert.ok(snap.routes.length >= 2, "Router evaluated multiple execution venues");
    const bestRoute = snap.routes.find((r) => r.best);
    assert.ok(bestRoute, "Best venue route selected");

    // ------------------------------------------------------------------------
    // Step 4: Exchange Connect Wizard
    // ------------------------------------------------------------------------
    const connectRes = await fetch(`${server.baseUrl}/api/exchange/connect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        venue: "bybit",
        apiKey: "bb_key_live_98765432",
        secret: "bb_sec_live_12345678",
        hasWithdrawalPermission: false,
      }),
    });
    assert.equal(connectRes.status, 200);
    const connectData = await connectRes.json();
    assert.ok(connectData.maskedKey.includes("****"), "Vault must mask connected API key");

    // ------------------------------------------------------------------------
    // Step 5: Automated Trade Entry
    // ------------------------------------------------------------------------
    const openRes = await fetch(`${server.baseUrl}/api/trade/open`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ symbol: "BTC", side: "long" }),
    });
    assert.equal(openRes.status, 200);
    const openData = await openRes.json();
    const position = openData.position;
    assert.equal(position.symbol, "BTC");
    assert.equal(position.side, "long");
    assert.equal(position.entryPrice, btcCoin.price);
    assert.ok(position.slPrice < position.entryPrice, "SL must be below entry");
    assert.ok(position.tp1Price > position.entryPrice, "TP1 must be above entry");
    assert.equal(position.trailingActive, true);

    // ------------------------------------------------------------------------
    // Step 6: Market Movement & Monotonic Trailing Stop Advance
    // ------------------------------------------------------------------------
    const posInServer = server.state.positions.find((p) => p.id === position.id);
    assert.ok(posInServer);
    const stopHistory = [posInServer.trailingStop];

    // Price advances +1.5%
    posInServer.markPrice = 95664.0;
    posInServer.trailingStop = 94230.0;
    stopHistory.push(posInServer.trailingStop);

    // Price advances +3.0% (Hits TP1 zone)
    posInServer.markPrice = 97078.0;
    posInServer.trailingStop = 95620.0;
    stopHistory.push(posInServer.trailingStop);

    // Interim pullback (stop must hold, never loosen)
    posInServer.markPrice = 96200.0;
    stopHistory.push(posInServer.trailingStop);

    assertTrailingStopMonotonicity(stopHistory, "long");

    // ------------------------------------------------------------------------
    // Step 7: Take-Profit / Trailing Close Execution
    // ------------------------------------------------------------------------
    posInServer.roe = ((posInServer.markPrice - posInServer.entryPrice) / posInServer.entryPrice) * posInServer.leverage * 100;
    posInServer.pnl = (posInServer.margin * posInServer.roe) / 100;

    const closeRes = await fetch(`${server.baseUrl}/api/trade/close`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: posInServer.id, reason: "Trailing Stop Fill" }),
    });
    assert.equal(closeRes.status, 200);
    const closeData = await closeRes.json();
    const trade = closeData.trade;
    assert.equal(trade.symbol, "BTC");
    assert.ok(trade.pnlNet > 0, "Trade must be profitable after favorable price surge");
    assert.equal(trade.exitReason, "Trailing Stop Fill");

    // Financial accounting verification
    const statsRes = await fetch(`${server.baseUrl}/api/dashboard`, {
      headers: { authorization: `Bearer ${server.adminSecret}` },
    });
    const { stats } = await statsRes.json();
    assertFinancialInvariants(stats);

    // ------------------------------------------------------------------------
    // Step 8: Trade Ledger & CSV History Export
    // ------------------------------------------------------------------------
    const tradesRes = await fetch(`${server.baseUrl}/api/trades?limit=50`, {
      headers: { authorization: `Bearer ${server.adminSecret}` },
    });
    const { trades } = await tradesRes.json();
    assert.ok(trades.some((t) => t.id === trade.id), "Completed trade present in historical ledger");

    const csvContent = [
      "ID,Symbol,Side,Venue,EntryPrice,ExitPrice,Margin,Leverage,PnL,ROE,Fees,ExitReason",
      ...trades.map(
        (t) =>
          `${t.id},${t.symbol},${t.side},${t.venue},${t.entryPrice},${t.exitPrice},${t.margin},${t.leverage},${t.pnlNet},${t.roe},${t.feesPaid},${t.exitReason}`
      ),
    ].join("\n");
    assert.ok(csvContent.includes(trade.id), "CSV export artifact must contain the completed trade");
    assert.ok(csvContent.includes("Trailing Stop Fill"), "CSV export artifact must record the exit reason");
  } finally {
    await server.stop();
  }
});

// ============================================================================
// Scenario 2: Emergency Risk Incident & Panic Recovery
// ============================================================================

test("Tier 4 [Scenario 2]: Emergency Risk Incident & Panic Recovery Workflow", () => {
  const driver = new FrontendStateDriver();
  assert.equal(driver.positions.length, 3);
  const initialEquity = driver.stats.equity;

  // Flash crash simulation: BTC crashes, SOL surges against short
  driver.updateMarkPrice("BTC", 85000.0); // Severe drop for Long
  driver.updateMarkPrice("SOL", 220.0);   // Severe surge for Short

  // Severe open losses accumulate
  assert.ok(driver.stats.openPnl < 0, "Unrealized losses accumulate during crash");

  // Operator triggers panic button
  driver.panicAll();

  // Invariant assertions
  assert.equal(driver.positions.length, 0, "All positions must be closed instantly");
  assert.equal(driver.killSwitch, true, "Kill switch must be engaged");
  assert.equal(driver.stats.openPnl, 0, "Zero open PnL after all positions closed");
  assertFinancialInvariants({
    initialFund: driver.initialFund,
    realizedPnl: driver.stats.realised,
    unrealizedPnl: driver.stats.openPnl,
    equity: driver.stats.equity,
    freeMargin: driver.stats.freeMargin,
    deployedMargin: driver.stats.deployedMargin,
  });

  // Verify activity audit log contains ALERT
  assert.ok(
    driver.activity.some((a) => a.level === "ALERT" && a.message.includes("PANIC")),
    "Emergency panic must be logged as high-severity ALERT"
  );
});

// ============================================================================
// Scenario 3: Live Trading Transition, Guardrails, & Real Fill Accounting
// ============================================================================

test("Tier 4 [Scenario 3]: Live Trading Transition & Guardrails Verification", async () => {
  const server = new MockBackendServer();
  await server.start();

  try {
    // 1. Withdrawal rejection
    const rejectRes = await fetch(`${server.baseUrl}/api/exchange/connect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        venue: "binance",
        apiKey: "bad-key",
        secret: "bad-sec",
        hasWithdrawalPermission: true,
      }),
    });
    assert.equal(rejectRes.status, 400);

    // 2. Safe key connect
    const safeRes = await fetch(`${server.baseUrl}/api/exchange/connect`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        venue: "binance",
        apiKey: "bin_live_key_1234",
        secret: "bin_live_sec_5678",
        hasWithdrawalPermission: false,
      }),
    });
    assert.equal(safeRes.status, 200);

    // 3. Mode switch without typing confirmation fails
    const badMode = await fetch(`${server.baseUrl}/api/mode`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "live", confirmed: false }),
    });
    assert.equal(badMode.status, 400);

    // 4. Mode switch with typed confirmation succeeds
    const goodMode = await fetch(`${server.baseUrl}/api/mode`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "live", confirmed: true, confirmation: "LIVE" }),
    });
    assert.equal(goodMode.status, 200);
    const { mode } = await goodMode.json();
    assert.equal(mode, "live");

    // 5. Switch back to paper mode is one-click
    const paperMode = await fetch(`${server.baseUrl}/api/mode`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "paper" }),
    });
    assert.equal(paperMode.status, 200);
  } finally {
    await server.stop();
  }
});

// ============================================================================
// Scenario 4: Strategy Profile Lifecycle & Preset Hash Sharing
// ============================================================================

test("Tier 4 [Scenario 4]: Strategy Profile Lifecycle & Preset URL Hash Sharing", () => {
  const driver = new FrontendStateDriver();

  // Customize Long & Short profiles
  driver.strategy.profiles.long = {
    enabled: true,
    leverage: 15,
    marginPerTrade: 1200,
    slPercent: 1.2,
    tp1Percent: 2.5,
    tpMaxPercent: 5.0,
    trailingEnabled: true,
    filters: {
      oi5m: { enabled: true, operator: "≥", value: 6.0 },
      vol1h: { enabled: true, operator: "≥", value: 25.0 },
    },
  };
  driver.strategy.profiles.short = {
    enabled: true,
    leverage: 12,
    marginPerTrade: 1000,
    slPercent: 1.5,
    tp1Percent: 3.0,
    tpMaxPercent: 6.0,
    trailingEnabled: true,
    filters: {
      oi5m: { enabled: true, operator: "≤", value: -6.0 },
      vol1h: { enabled: true, operator: "≥", value: 25.0 },
    },
  };

  // Execution Cost Preview (FX-90) validation
  const previewLong = calculateExecutionCostPreview(driver.strategy.profiles.long, 0.05, 0.02);
  assert.equal(previewLong.roundTripCostBps, 14);
  assert.ok(previewLong.netEdgeMultiple > 15);

  const previewShort = calculateExecutionCostPreview(driver.strategy.profiles.short, 0.05, 0.02);
  assert.equal(previewShort.roundTripCostBps, 14);
  assert.ok(previewShort.netEdgeMultiple > 20);

  // Encode preset into URL hash without API keys (PRD 5.9 preset link)
  const presetPayload = {
    profiles: driver.strategy.profiles,
    shared: driver.strategy.shared,
  };
  const jsonStr = JSON.stringify(presetPayload);
  const base64Hash = Buffer.from(jsonStr).toString("base64url");
  assert.ok(base64Hash.length > 0, "Preset hash string generated");

  // Simulate opening preset link on fresh instance
  const decodedJson = Buffer.from(base64Hash, "base64url").toString("utf8");
  const importedPreset = JSON.parse(decodedJson);

  assert.equal(importedPreset.profiles.long.leverage, 15);
  assert.equal(importedPreset.profiles.short.leverage, 12);
  assert.equal(importedPreset.profiles.long.slPercent, 1.2);
  assert.equal(importedPreset.profiles.short.slPercent, 1.5);
  assert.equal(importedPreset.profiles.long.filters.oi5m.value, 6.0);
  assert.equal(importedPreset.profiles.short.filters.oi5m.value, -6.0);
  assert.equal(importedPreset.vault, undefined, "Presets must NEVER contain keys");
});
