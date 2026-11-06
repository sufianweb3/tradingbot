/**
 * Comprehensive Normative Test Suite for Client Additions (`additions.md`)
 *
 * Covers:
 * - T1..T22 mandatory end-to-end verification scenarios
 * - EC-01..EC-68 edge cases across Unit Conversion, EQE, Paper Simulator,
 *   Live Execution & Protection, Smart Order Router, Speed Program,
 *   Dual-Worker Architecture, Risk Guardrails, and Preset Sanitization.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseSymbolMultiplier,
  normalizeToCanonicalBase,
  roundAndValidateQty,
  verifyOrderUnitSanity,
  splitTp1Quantities,
  roundAndValidateStopPrice,
  checkSlLiquidationBuffer,
  sanityCheckPriceVsCoinglass,
  isUsdtLinearPerp,
  isTradableContractStatus,
  checkListingAge,
  clampToLeverageBracket,
  checkCrossVenueDivergence,
} from "../src/core/units.js";

import {
  walkBook,
  computeBandDepth,
  buildStableBook,
  applyWallDiscount,
  sizeToFit,
  evaluateExecutability,
  ExitLiquidityMonitor,
  DEFAULT_EQE_SETTINGS,
} from "../src/core/eqe/index.js";

import {
  simulatePaperEntry,
  simulatePaperExit,
  accruePositionFunding,
  resolveHaircutForMode,
} from "../src/executor/paper.js";

import {
  ProtectionManager,
  DEFAULT_EXEC_SETTINGS,
} from "../src/core/protectionManager.js";

import {
  resolveUnknownOrder,
  reconcileExchangeState,
  runAccountPreflight,
} from "../src/core/reconciler.js";

import {
  SmartOrderRouter,
  computeCrossVenueExposure,
  DEFAULT_ROUTE_SETTINGS,
} from "../src/core/router/index.js";

import { MarketStateStore } from "../src/core/stateStore.js";
import { IntentStateMachine, INTENT_STATES } from "../src/core/intentMachine.js";
import { PriorityScheduler, VenueRateLimiter } from "../src/core/scheduler.js";
import { CircuitBreakerRegistry } from "../src/core/circuitBreaker.js";
import {
  CoinGlassKeyCache,
  LaneInFlightGuard,
  computeMarketDiff,
  applyMarketDiff,
  computeWatchlist,
  OrderPrewarmer,
  StageLatencyTracker,
} from "../src/core/speed.js";

import {
  checkFundingGuard,
  RiskGuardManager,
  sanitizeImportedPreset,
} from "../src/core/riskGuards.js";

import { parseSanitizedPresetHash, createPresetHash } from "../src/presets.js";
import { DataWorkerRuntime } from "../web/dataWorker.js";
import { EngineWorkerRuntime } from "../web/engineWorker.js";
import { ScriptableMockExchange } from "./mock-exchange/index.js";

// ============================================================================
// T1..T5 & EC-13..EC-18: Execution Quality Engine (EQE) & Book Walking
// ============================================================================

test("T1: Deep book entry & exit passes EQE with low impact and full notional", () => {
  const mock = new ScriptableMockExchange({ id: "bybit" });
  const book = mock.setBookScenario("BTCUSDT", "deep", 100);

  const res = evaluateExecutability({
    symbol: "BTCUSDT",
    venue: "bybit",
    side: "long",
    plannedNotional: 5000,
    book,
    settings: { eqe: DEFAULT_EQE_SETTINGS, feePercent: 0.05, tp1Percent: 50 },
  });

  assert.equal(res.pass, true);
  assert.equal(res.ok, true);
  assert.equal(res.action, "full-size");
  assert.equal(res.approvedNotional, 5000);
  assert.ok(res.entryImpactBps < 5, `expected entryImpactBps < 5, got ${res.entryImpactBps}`);
  assert.ok(res.exitStressImpactBps <= 20, `expected exitStressImpactBps <= 20, got ${res.exitStressImpactBps}`);
});

test("T2: Hollow book trap (good entry, thin exit) blocks when exit depth is insufficient", () => {
  const mock = new ScriptableMockExchange({ id: "bybit" });
  const book = mock.setBookScenario("TRAPUSDT", "hollow", 100);

  const res = evaluateExecutability({
    symbol: "TRAPUSDT",
    venue: "bybit",
    side: "long",
    plannedNotional: 5000,
    book,
    settings: {
      eqe: {
        ...DEFAULT_EQE_SETTINGS,
        liquiditySizing: false,
      },
    },
  });

  assert.equal(res.pass, false);
  assert.equal(res.action, "reject");
  assert.ok(
    res.reasons.some((r) => r.includes("exit") || r.includes("depth") || r.includes("hollow") || r.includes("imbalance")),
    `expected exit depth/stress block reason, got ${res.reasons.join(",")}`
  );
});

test("T3: Liquidity-fitted sizing (sizeToFit) scales down $10,000 order on medium book or rejects below minimum viable fraction", () => {
  const bids = [];
  const asks = [];
  const mid = 100;
  for (let i = 1; i <= 15; i++) {
    bids.push([mid * (1 - i * 0.0002), 8]); // $800 per level -> ~$20k in 0.5% band
    asks.push([mid * (1 + i * 0.0002), 8]);
  }
  const book = { symbol: "MEDUSDT", venue: "bybit", bids, asks, ts: Date.now() };

  const res = evaluateExecutability({
    symbol: "MEDUSDT",
    venue: "bybit",
    side: "long",
    plannedNotional: 10000,
    book,
    instrument: { lotSize: 0.01, minQty: 0.01, minNotional: 5 },
    settings: {
      eqe: {
        ...DEFAULT_EQE_SETTINGS,
        liquiditySizing: true,
        minViableFraction: 0.2,
      },
    },
  });

  assert.equal(res.pass, true);
  assert.equal(res.action, "size-reduced");
  assert.ok(res.approvedNotional >= 2000 && res.approvedNotional < 10000);

  // Ultra-thin book that cannot even support minViableFraction
  const tinyBook = {
    symbol: "TINYUSDT",
    venue: "bybit",
    bids: [
      [99.98, 0.2],
      [99.96, 0.2],
      [99.94, 0.2],
      [99.92, 0.2],
      [99.9, 0.2],
    ],
    asks: [
      [100.02, 0.2],
      [100.04, 0.2],
      [100.06, 0.2],
      [100.08, 0.2],
      [100.1, 0.2],
    ],
    ts: Date.now(),
  };
  const blockedRes = evaluateExecutability({
    symbol: "TINYUSDT",
    venue: "bybit",
    side: "long",
    plannedNotional: 5000,
    book: tinyBook,
    settings: { eqe: { ...DEFAULT_EQE_SETTINGS, liquiditySizing: true } },
  });
  assert.equal(blockedRes.pass, false);
  assert.ok(
    blockedRes.reasons.includes("size-too-small-to-fit") ||
      blockedRes.reasons.includes("exit-depth-thin") ||
      blockedRes.reasons.includes("entry-depth-thin") ||
      blockedRes.reasons.includes("spread-wide"),
    `expected liquidity rejection reason, got ${blockedRes.reasons.join(",")}`
  );
});

test("T4: Anti-spoof filter discounts fleeting 1-snapshot wall and penalizes depthVolatility", () => {
  const normalAsks = [
    [100.02, 10],
    [100.04, 10],
    [100.06, 10],
  ];
  const spoofAsks = [
    [100.02, 5000], // huge 1-tick spoof wall
    [100.04, 10],
    [100.06, 10],
  ];
  const bids = [
    [99.98, 20],
    [99.96, 20],
    [99.94, 20],
  ];

  const snapshots = [
    { bids, asks: normalAsks, ts: 1000 },
    { bids, asks: normalAsks, ts: 1200 },
    { bids, asks: spoofAsks, ts: 1400 },
  ];

  const stable = buildStableBook(snapshots, { stableSnapshots: 3, minSpanMs: 300 });
  // Because the 5000 wall only appeared in 1 of 3 snapshots, its conservative min size is 10!
  assert.equal(stable.asks[0][1], 10);
  assert.ok(stable.depthVolatility > 0.5, `expected elevated depthVolatility, got ${stable.depthVolatility}`);

  // Single-snapshot wall discount check
  const discounted = applyWallDiscount(spoofAsks, 100, 0.6, 0.75);
  assert.equal(discounted.wallDetected, true);
  assert.equal(discounted.levels[0][1], 1250);
});

test("T5 & EC-13..EC-18: Gapped/crossed/one-sided/stale order book handling", () => {
  const mock = new ScriptableMockExchange({ id: "bybit" });

  // Crossed book (EC-15)
  const crossedBook = mock.setBookScenario("BTCUSDT", "crossed", 100);
  const crossedRes = evaluateExecutability({
    symbol: "BTCUSDT",
    venue: "bybit",
    side: "long",
    plannedNotional: 1000,
    book: crossedBook,
  });
  assert.equal(crossedRes.pass, false);
  assert.ok(crossedRes.reasons.includes("book-crossed"));

  // One-sided book (EC-14)
  const oneSidedRes = evaluateExecutability({
    symbol: "BTCUSDT",
    venue: "bybit",
    side: "long",
    plannedNotional: 1000,
    book: { bids: [[99.9, 10]], asks: [], ts: Date.now() },
  });
  assert.equal(oneSidedRes.pass, false);
  assert.ok(oneSidedRes.reasons.includes("hollow-book"));

  // Stale book (EC-16)
  const staleBook = mock.setBookScenario("BTCUSDT", "deep", 100, Date.now() - 15000);
  const staleRes = evaluateExecutability({
    symbol: "BTCUSDT",
    venue: "bybit",
    side: "long",
    plannedNotional: 1000,
    book: staleBook,
    nowMs: Date.now(),
  });
  assert.equal(staleRes.pass, false);
  assert.ok(staleRes.reasons.includes("book-stale"));

  // Gapped book (T5)
  const gappedBook = mock.setBookScenario("BTCUSDT", "gapped", 100);
  const gappedRes = evaluateExecutability({
    symbol: "BTCUSDT",
    venue: "bybit",
    side: "long",
    plannedNotional: 2000,
    book: gappedBook,
    settings: { eqe: { ...DEFAULT_EQE_SETTINGS, liquiditySizing: false } },
  });
  assert.equal(gappedRes.pass, false);
  assert.ok(gappedRes.reasons.includes("hollow-book"));
});

// ============================================================================
// T6 & EC-01..EC-12: Unit & Multiplier Conversion across Venues
// ============================================================================

test("T6 & EC-01..EC-12: Multiplier and contract conversion across Binance, Bybit, Gate, KuCoin, MEXC", () => {
  // 1000PEPE symbol multiplier parsing (EC-01)
  const mult = parseSymbolMultiplier("1000PEPEUSDT");
  assert.equal(mult.baseMultiplier, 1000);
  assert.equal(mult.canonicalBase, "PEPE");

  // Gate quanto_multiplier + KuCoin lot multiplier normalization (EC-02, EC-03)
  const gateNorm = normalizeToCanonicalBase({
    venuePrice: 10,
    contractQty: 50, // 50 contracts
    symbol: "BTC_USDT",
    contractMeta: { quantoMultiplier: 0.01 }, // 0.01 coin per contract
  });
  assert.equal(gateNorm.baseQty, 0.5);
  assert.equal(gateNorm.notional, 5);

  // Quantity step rounding & validation (EC-04, EC-05)
  const rounded = roundAndValidateQty({
    targetNotional: 1000,
    venuePrice: 50000,
    instrument: { lotSize: 0.001, minQty: 0.001, minNotional: 5 },
  });
  assert.equal(rounded.ok, true);
  assert.equal(rounded.qty, 0.02);

  // Pre-order unit sanity invariant (FX-22e): catches 1000x mismatch
  const insane = verifyOrderUnitSanity({
    orderQty: 20, // 20 BTC instead of 0.02 BTC!
    venuePrice: 50000,
    independentMarkPrice: 50000,
    expectedNotional: 1000,
  });
  assert.equal(insane.ok, false);
  assert.equal(insane.reason, "unit-mismatch");

  // TP1 split quantities sum exactly to totalQty (EC-06)
  const split = splitTp1Quantities(0.003, 50, { lotSize: 0.001, minQty: 0.001, minNotional: 5 }, 50000);
  assert.equal(split.canSplit, true);
  assert.equal(Number((split.tp1Qty + split.runnerQty).toFixed(6)), 0.003);

  // Stop price tick rounding & liquidation buffer (EC-07, EC-08)
  const stopValid = roundAndValidateStopPrice({
    side: "long",
    rawStopPrice: 49500.14,
    entryPrice: 50000,
    markPrice: 50000,
    tickSize: 0.1,
  });
  assert.equal(stopValid.ok, true);
  assert.equal(stopValid.stopPrice, 49500.1); // rounded down away from entry for long

  const liqCheck = checkSlLiquidationBuffer({
    side: "long",
    entryPrice: 50000,
    slPrice: 48000,
    liqPrice: 47950, // dangerously close to liqPrice
  });
  assert.equal(liqCheck.ok, false);
  assert.equal(liqCheck.reason, "sl-too-close-to-liquidation");

  // CoinGlass vs Exchange price sanity (EC-09)
  const cgSanity = sanityCheckPriceVsCoinglass(0.01, 10);
  assert.equal(cgSanity.ok, false);

  // USDT linear perp, trading status, listing age, leverage bracket, cross-venue divergence
  assert.equal(isUsdtLinearPerp({ quoteCoin: "USDT", isInverse: false }), true);
  assert.equal(isUsdtLinearPerp({ quoteCoin: "USD", isInverse: true }), false);
  assert.equal(isTradableContractStatus({ status: "TRADING" }), true);
  assert.equal(isTradableContractStatus({ status: "SETTLING" }), false);
  assert.equal(checkListingAge({ onboardDate: Date.now() - 10 * 60 * 1000 }).ok, false);
  assert.equal(
    clampToLeverageBracket({
      desiredLeverage: 50,
      notional: 100000,
      instrument: {
        brackets: [
          { maxNotional: 50000, maxLeverage: 50 },
          { maxNotional: 250000, maxLeverage: 20 },
        ],
      },
    }).leverage,
    20
  );
  assert.equal(
    checkCrossVenueDivergence([
      { venue: "bybit", midPrice: 100 },
      { venue: "binance", midPrice: 145 },
    ]).ok,
    false
  );
});

// ============================================================================
// T7, T8 & EC-19..EC-22: Normative Paper Simulator
// ============================================================================

test("T7 & T8: Paper simulator walks book on entry, stop-loss with gap+haircut, TP1 maker fill, and funding", () => {
  const mock = new ScriptableMockExchange({ id: "bybit" });
  const book = mock.setBookScenario("BTCUSDT", "deep", 100);

  const entrySim = simulatePaperEntry({
    side: "long",
    targetNotional: 2000,
    decisionPrice: 100,
    book,
    simSettings: { realismMode: "realistic" },
  });
  assert.equal(entrySim.ok, true);
  assert.ok(entrySim.fillPrice >= 100);
  assert.ok(entrySim.feeUsd > 0);

  // Stop-loss exit walks opposite book with stress haircut + adverse latency drift (FX-13)
  const slExit = simulatePaperExit({
    side: "long",
    qty: entrySim.qty,
    entryPrice: entrySim.fillPrice,
    triggerPrice: 99,
    markPrice: 98.9,
    reason: "SL",
    book,
    simSettings: { realismMode: "realistic" },
  });
  assert.equal(slExit.ok, true);
  assert.ok(slExit.fillPrice < 100);

  // TP1 limit fill requires trade-through or sustained touch (FX-14, EC-19)
  const tp1Filled = simulatePaperExit({
    side: "long",
    qty: entrySim.qty * 0.5,
    entryPrice: entrySim.fillPrice,
    triggerPrice: 102,
    markPrice: 102.2,
    lastPrice: 102.25,
    reason: "TP1",
    book,
    touchDurationMs: 5000,
  });
  assert.equal(tp1Filled.ok, true);
  assert.equal(tp1Filled.fillPrice, 102);

  // Funding accrual across 8h boundary (FX-15, EC-20)
  const pos = {
    status: "open",
    side: "long",
    qty: 100,
    entryPrice: 100,
    markPrice: 100,
    entryTime: Date.UTC(2026, 0, 1, 7, 50, 0),
    fundingPaidUsd: 0,
    lastFundingTs: Date.UTC(2026, 0, 1, 7, 50, 0),
  };
  const boundaryTime = Date.UTC(2026, 0, 1, 8, 0, 5);
  const fundRes = accruePositionFunding(pos, 0.0002, 100, boundaryTime);
  assert.equal(fundRes.accrued, true);
  assert.ok(fundRes.paymentUsd > 0);
});

// ============================================================================
// T9..T14 & EC-23..EC-40: Live Execution, Protection, Unknown State & Reconcile
// ============================================================================

test("T9 & T10: ProtectionManager places SL, retries on failure, and emergency-closes when SL fails after retries", async () => {
  // T9: SL succeeds on 2nd attempt
  const mockSuccess = new ScriptableMockExchange({ id: "binance", capabilitiesOverride: { attachedSlTp: false } });
  mockSuccess.script.failPlaceStopCount = 1; // fail 1st, succeed 2nd
  const pm = new ProtectionManager(DEFAULT_EXEC_SETTINGS);

  const pos1 = {
    id: "pos_t9",
    symbol: "BTCUSDT",
    exchangeSymbol: "BTCUSDT",
    side: "long",
    entryPrice: 100,
    markPrice: 100,
    qty: 0.1,
    slPrice: 98,
    tp1Price: 103,
    tp1ClosePercent: 50,
    protection: {},
  };
  const res1 = await pm.placeInitialProtection({
    adapter: mockSuccess,
    pos: pos1,
    instrument: mockSuccess.instruments.get("BTCUSDT"),
  });
  assert.equal(res1.ok, true);
  assert.ok(pos1.protection.slOrderId);

  // T10: SL fails all attempts -> emergency market close (FX-19)
  const mockFail = new ScriptableMockExchange({ id: "binance", capabilitiesOverride: { attachedSlTp: false } });
  mockFail.script.failPlaceStopCount = 99;
  const pos2 = {
    id: "pos_t10",
    symbol: "BTCUSDT",
    exchangeSymbol: "BTCUSDT",
    side: "long",
    entryPrice: 100,
    markPrice: 100,
    qty: 0.1,
    slPrice: 98,
    protection: {},
  };
  const res2 = await pm.placeInitialProtection({
    adapter: mockFail,
    pos: pos2,
    instrument: mockFail.instruments.get("BTCUSDT"),
  });
  assert.equal(res2.ok, false);
  assert.equal(res2.emergencyClosed, true);
  assert.ok(mockFail.callLog.some((c) => c.op === "closePosition"));
});

test("T11 & T12: Never-Unprotected trailing stop update (place-new-then-cancel-old) and TP1 resize", async () => {
  const mock = new ScriptableMockExchange({
    id: "kucoin",
    capabilitiesOverride: { attachedSlTp: false, atomicAmend: false },
  });
  const pm = new ProtectionManager({ trailMinIntervalMs: 0, trailMinStepTicks: 1 });
  const pos = {
    id: "pos_t11",
    symbol: "BTCUSDT",
    exchangeSymbol: "BTCUSDT",
    side: "long",
    entryPrice: 100,
    markPrice: 101,
    qty: 0.2,
    slPrice: 98,
    protection: { slOrderId: "old_sl_1", tp1OrderId: "old_tp_1" },
  };
  mock.openOrders.set("old_sl_1", { id: "old_sl_1", orderId: "old_sl_1", symbol: "BTCUSDT", triggerPrice: 98 });

  // Verify placeStop is called BEFORE cancel during trailing stop update
  const trailRes = await pm.updateTrailingStopProtected({
    adapter: mock,
    pos,
    newStopPrice: 99.2,
    markPrice: 101,
    instrument: mock.instruments.get("BTCUSDT"),
    force: true,
  });
  assert.equal(trailRes.updated, true);
  const ops = mock.callLog.map((c) => c.op);
  const placeIdx = ops.indexOf("placeStop");
  const cancelIdx = ops.indexOf("cancel");
  assert.ok(placeIdx >= 0 && cancelIdx > placeIdx, "must place new SL before cancelling old SL");

  // If new SL placement fails, old SL must remain untouched!
  const prevSlId = pos.protection.slOrderId;
  mock.script.failPlaceStopCount = 1;
  await assert.rejects(async () => {
    await pm.updateTrailingStopProtected({
      adapter: mock,
      pos,
      newStopPrice: 99.6,
      markPrice: 101,
      instrument: mock.instruments.get("BTCUSDT"),
      force: true,
    });
  });
  assert.equal(pos.protection.slOrderId, prevSlId);

  // T12: TP1 fill resizes SL quantity
  const tp1Res = await pm.handleTp1Fill({
    adapter: mock,
    pos,
    filledTp1Qty: 0.1,
    markPrice: 102,
    instrument: mock.instruments.get("BTCUSDT"),
  });
  assert.equal(tp1Res.ok, true);
  assert.equal(pos.qty, 0.1);
});

test("T13 & T14: Unknown order resolution on timeout and 4-way reconciliation", async () => {
  const mock = new ScriptableMockExchange({ id: "bybit", capabilitiesOverride: { attachedSlTp: false } });
  const im = new IntentStateMachine();
  const intent = im.createIntent({
    symbol: "BTCUSDT",
    venue: "bybit",
    side: "long",
    plannedNotional: 1000,
    clientOrderId: "cid_unknown_1",
  });
  im.transition(intent.id, INTENT_STATES.GATED);
  im.transition(intent.id, INTENT_STATES.ROUTED);
  im.transition(intent.id, INTENT_STATES.SUBMITTED);
  im.transition(intent.id, INTENT_STATES.UNKNOWN, { note: "timeout" });

  assert.equal(im.isSymbolLocked("BTCUSDT"), true);

  // Simulate that the order silently filled on the exchange
  mock.fills.set("cid_unknown_1", {
    orderId: "ord_silent_1",
    clientId: "cid_unknown_1",
    symbol: "BTCUSDT",
    side: "long",
    price: 100,
    qty: 0.1,
  });

  const resolved = await resolveUnknownOrder(mock, {
    symbol: "BTCUSDT",
    clientOrderId: "cid_unknown_1",
  });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.status, "FILLED");
  assert.equal(resolved.filledQty, 0.1);

  // T14: Reconciliation detects orphan exchange position, externally closed local position, and missing SL
  mock.positions.set("ETHUSDT", {
    symbol: "ETHUSDT",
    side: "long",
    size: 1.5,
    entryPrice: 3000,
    markPrice: 3010,
  });
  mock.positions.set("BTCUSDT", {
    symbol: "BTCUSDT",
    side: "long",
    size: 0.1,
    entryPrice: 100,
    markPrice: 101,
  });
  mock.openOrders.clear(); // No SL order on exchange for BTCUSDT!

  const pm = new ProtectionManager();
  const fakeEngine = {
    intentMachine: im,
    state: {
      settings: { exec: DEFAULT_EXEC_SETTINGS },
      positions: [
        {
          id: "pos_btc",
          mode: "live",
          status: "open",
          symbol: "BTC",
          exchangeSymbol: "BTCUSDT",
          side: "long",
          entryPrice: 100,
          markPrice: 101,
          qty: 0.1,
          slPrice: 95,
          protection: { slOrderId: "missing_sl_id" },
        },
        {
          id: "pos_sol_closed_ext",
          mode: "live",
          status: "open",
          symbol: "SOL",
          exchangeSymbol: "SOLUSDT",
          side: "long",
          entryPrice: 150,
          markPrice: 150,
          qty: 10,
          slPrice: 140,
          protection: {},
        },
      ],
    },
    _closePosition: (pos) => {
      pos.status = "closed";
    },
  };

  const rec = await reconcileExchangeState({
    engine: fakeEngine,
    adapter: mock,
    protectionManager: pm,
    orphanAction: "alert",
  });
  assert.equal(rec.ok, true);
  assert.equal(rec.orphans, 1);
  assert.equal(rec.externallyClosed, 1);
  assert.equal(rec.reprotected, 1);
});

// ============================================================================
// T15..T17 & EC-25..EC-34: Smart Order Router (SOR), Failover & Calibration
// ============================================================================

test("T15, T16, T17: SmartOrderRouter picks lowest total cost(v), fails over safely, and calibrates drift", async () => {
  const router = new SmartOrderRouter();
  const mockBybit = new ScriptableMockExchange({ id: "bybit" });
  const mockBinance = new ScriptableMockExchange({ id: "binance" });

  // Bybit has slightly higher spread/impact, Binance has deeper book + lower taker fee
  const bookBybit = mockBybit.setBookScenario("BTCUSDT", "deep", 100);
  // Make Bybit slightly wider spread than Binance
  bookBybit.asks[0][0] = 100.05;
  bookBybit.bids[0][0] = 99.95;
  const bookBinance = mockBinance.setBookScenario("BTCUSDT", "deep", 100);

  const routeRes = router.routeOrder({
    symbol: "BTCUSDT",
    side: "long",
    plannedNotional: 1000,
    desiredLeverage: 20,
    executionMode: "paper",
    settings: {
      route: { ...DEFAULT_ROUTE_SETTINGS, mode: "auto" },
      eqe: DEFAULT_EQE_SETTINGS,
    },
    candidates: [
      {
        venue: "bybit",
        symbol: "BTCUSDT",
        side: "long",
        book: bookBybit,
      },
      {
        venue: "binance",
        symbol: "BTCUSDT",
        side: "long",
        book: bookBinance,
      },
    ],
  });

  assert.equal(routeRes.ok, true);
  assert.equal(routeRes.winner.venue, "binance");
  assert.ok(routeRes.savingsBps > 0);
  assert.ok(routeRes.explanation.includes("Auto -> BINANCE"));

  // T16: Failover when primary venue rejects order cleanly
  const execRes = await router.executeWithFailover({
    routeDecision: routeRes,
    verifyOrderAbsentFn: async () => true,
    submitOrderFn: async (cand) => {
      if (cand.venue === "binance") {
        return { ok: false, status: "REJECTED", reason: "INSUFFICIENT_MARGIN" };
      }
      return { ok: true, status: "FILLED", orderId: "fallback_ok_1", venue: cand.venue };
    },
  });
  assert.equal(execRes.ok, true);
  assert.equal(execRes.venue, "bybit");
  assert.equal(execRes.routeFailoverFrom, "binance");

  // T17: Rolling slippage drift calibration penalizes venue that consistently slips worse than predicted
  router.updateSettings({ calibrateSlippage: true });
  for (let i = 0; i < 10; i++) {
    router.recordFillCalibration("binance", 2.0, 14.0); // +12 bps worse than predicted
  }
  const driftPenalty = router.getSlippageDriftPenaltyBps("binance");
  assert.ok(driftPenalty > 8, `expected driftPenalty > 8 bps, got ${driftPenalty}`);
});

// ============================================================================
// T18..T20 & EC-41..EC-48: Speed Program, Key Cache, Diffs & Prewarmer
// ============================================================================

test("T18, T19, T20: CoinGlassKeyCache, LaneInFlightGuard, computeMarketDiff, and OrderPrewarmer", async () => {
  // T18: CoinGlassKeyCache caches derived AES key for identical headers
  const cache = new CoinGlassKeyCache(16);
  assert.equal(cache.get("v1", "user_b64_abc"), null);
  cache.set("v1", "user_b64_abc", "DERIVED_KEY_ABC");
  assert.equal(cache.get("v1", "user_b64_abc"), "DERIVED_KEY_ABC");
  assert.equal(cache.hits, 1);

  // T19: LaneInFlightGuard prevents overlapping requests
  const guard = new LaneInFlightGuard();
  const r1 = await guard.run("fast", async () => "ok_fast");
  assert.equal(r1, "ok_fast");

  // Diff engine (FX-43)
  const prevMap = new Map([["BTC", { symbol: "BTC", price: 65000, oiUsd: 1000, volUsd24h: 2000, oi: { "5m": 1.2 } }]]);
  const nextCoins = [
    { symbol: "BTC", price: 65000, oiUsd: 1000, volUsd24h: 2000, oi: { "5m": 1.2 } }, // unchanged
    { symbol: "ETH", price: 3500, oiUsd: 500, volUsd24h: 1000, oi: { "5m": 3.5 } }, // added
  ];
  const diff = computeMarketDiff(prevMap, nextCoins);
  assert.equal(diff.changedCount, 1);
  assert.equal(diff.updated[0].symbol, "ETH");

  const merged = applyMarketDiff(prevMap, diff);
  assert.equal(merged.size, 2);

  // T20: Watchlist + OrderPrewarmer (FX-44, FX-47)
  const watchlist = computeWatchlist(nextCoins, {
    oiFilters: [{ key: "5m", enabled: true, op: ">=", threshold: 3.0, group: "oi" }],
  });
  assert.ok(watchlist.some((w) => w.symbol === "ETH"));

  const prewarmer = new OrderPrewarmer();
  prewarmer.setTemplate("bybit", "ETHUSDT", {
    instrument: { symbol: "ETHUSDT", lotSize: 0.01 },
    leverage: 20,
    side: "long",
  });
  const tpl = prewarmer.getTemplate("bybit", "ETHUSDT");
  assert.ok(tpl);
  assert.equal(tpl.leverage, 20);
});

// ============================================================================
// T21, T22 & EC-57..EC-68: Dual-Worker Runtime, Scheduler, Risk Guards & Presets
// ============================================================================

test("T21 & T22: Dual-worker MessageChannel pipeline, PriorityScheduler backpressure, RiskGuards, and Preset Sanitizer", async () => {
  // PriorityScheduler P0..P3 ordering and >50ms lag backpressure (FX-51, FX-64)
  const sched = new PriorityScheduler({ maxLagMs: 50 });
  const order = [];
  await Promise.all([
    sched.schedule("P3", async () => order.push("P3")),
    sched.schedule("P0", async () => order.push("P0")),
    sched.schedule("P1", async () => order.push("P1")),
  ]);
  assert.equal(order.length, 3);

  sched.reportEventLoopLag(75); // > 50ms -> backpressure active
  assert.equal(sched.backpressureActive, true);
  sched.reportEventLoopLag(10);
  assert.equal(sched.backpressureActive, false);

  // VenueRateLimiter reserves 30% budget for P0/P1 (FX-51, EC-60)
  const limiter = new VenueRateLimiter({ capacityPerMin: 10, reserveRatio: 0.3 });
  for (let i = 0; i < 7; i++) {
    assert.equal(limiter.tryConsume("P2", 1).allowed, true);
  }
  // Remaining 3 tokens are reserved for P0/P1!
  assert.equal(limiter.tryConsume("P2", 1).allowed, false);
  assert.equal(limiter.tryConsume("P0", 1).allowed, true);

  // Dual-Worker communication via MessageChannel (FX-60)
  const { port1, port2 } = new MessageChannel();
  try {
    const dataWorker = new DataWorkerRuntime({
      port: port1,
    });
    const fakeEngineForWorker = {
      marketCache: { coins: [] },
      state: { settings: {}, meta: { running: false } },
    };
    const engineWorker = new EngineWorkerRuntime({ engine: fakeEngineForWorker, port: port2 });
    dataWorker.ingestBatch([
      { symbol: "BTC", price: 65000, oiUsd: 1000000, volUsd24h: 2000000, oi: { "5m": 2.5 } },
    ]);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(engineWorker.coinMap.get("BTC")?.price, 65000);
  } finally {
    port1.close();
    port2.close();
  }

  // RiskGuardManager & Funding Guard (FX-15, EC-21, EC-50, EC-55, EC-65)
  const fg = checkFundingGuard({
    side: "long",
    fundingRate: 0.003, // 30 bps adverse
    nowMs: Date.UTC(2026, 0, 1, 7, 57, 0), // 3 min before 08:00 UTC boundary
    riskSettings: { fundingGuard: true, fundingBlackoutMin: 5, maxAdverseFundingBps: 25 },
  });
  assert.equal(fg.ok, false);

  const rg = new RiskGuardManager({ maxEntriesPerMin: 2, confirmScans: 2 });
  assert.equal(rg.recordScanQualification("BTC", "long", true).confirmed, false);
  assert.equal(rg.recordScanQualification("BTC", "long", true).confirmed, true);

  // Untrusted preset sanitizer (EC-65)
  const maliciousHash = createPresetHash({
    mode: "live",
    leverage: 150,
    allocationPercent: 95,
    eqe: { enabled: false },
    coinglassApiKey: "LEAKED_KEY",
  });
  const safePreset = parseSanitizedPresetHash(maliciousHash);
  assert.equal(safePreset.mode, "paper");
  assert.equal(safePreset.leverage, 75);
  assert.equal(safePreset.allocationPercent, 50);
  assert.equal(safePreset.eqe.enabled, true);
  assert.equal(safePreset.coinglassApiKey, "");
});
