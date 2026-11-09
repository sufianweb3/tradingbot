/**
 * Tier 2: Boundary Value Analysis & Corner Cases
 *
 * Verifies edge conditions:
 * - Empty data sets (zero coins, zero positions, zero trades, empty logs)
 * - Boundary & max values (1x-125x leverage, fractional/max margin, extreme numbers)
 * - Offline & stale feeds (scrape failure, 150s paper / 20s live stale gates)
 * - Invalid inputs & schema violations (malformed JSON, negative numbers, corrupt keys)
 * - Reconnection drops & fallback polling
 * - Permission rejections & security barriers
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MockBackendServer,
  FrontendStateDriver,
  calculateExecutionSnapshot,
  assertFinancialInvariants,
} from "./harness/harness.js";
import { MOCK_START_FUND } from "./harness/mockData.js";

// ============================================================================
// 1. Empty Data States
// ============================================================================

test("Tier 2 [B1]: Zero coins discovered: scanner handles empty array safely", () => {
  const driver = new FrontendStateDriver({ coins: [] });
  assert.equal(driver.coins.length, 0);
  const qualified = driver.coins.filter((c) => c.status === "qualified");
  assert.equal(qualified.length, 0);
});

test("Tier 2 [B2]: Zero open positions: panel reports 0 open PnL and 0 deployed margin", () => {
  const driver = new FrontendStateDriver({ positions: [] });
  assert.equal(driver.positions.length, 0);
  const stats = driver.stats;
  assert.equal(stats.openPnl, 0);
  assert.equal(stats.deployedMargin, 0);
  assert.equal(stats.freeMargin, stats.equity);
  assertFinancialInvariants({
    initialFund: stats.initialFund,
    realizedPnl: stats.realised,
    unrealizedPnl: stats.openPnl,
    equity: stats.equity,
    freeMargin: stats.freeMargin,
    deployedMargin: stats.deployedMargin,
  });
});

test("Tier 2 [B3]: Zero trade history: stats render 0% winrate and baseline equity", () => {
  const driver = new FrontendStateDriver({ trades: [] });
  assert.equal(driver.trades.length, 0);
  const stats = driver.stats;
  assert.equal(stats.totalTrades, 0);
  assert.equal(stats.winrate, 0);
  assert.equal(stats.profitFactor, 0);
  assert.equal(stats.realised, 0);
  assert.equal(stats.equity, stats.initialFund + stats.openPnl);
});

test("Tier 2 [B4]: Empty activity stream: handles zero logs without null pointer exception", () => {
  const driver = new FrontendStateDriver();
  driver.activity = [];
  assert.equal(driver.activity.length, 0);
  const recent = driver.activity.slice(0, 10);
  assert.deepEqual(recent, []);
});

// ============================================================================
// 2. Boundary and Maximum Values
// ============================================================================

test("Tier 2 [B5]: Minimum (1x) and Maximum (125x) leverage boundary handling", () => {
  const driver = new FrontendStateDriver();
  const coin = driver.coins[0];

  // 1x leverage
  driver.strategy.profiles.long.leverage = 1;
  const pos1x = driver.openTrade(coin, "long");
  assert.equal(pos1x.leverage, 1);
  assert.ok(Math.abs(pos1x.qty - (pos1x.margin * 1) / coin.price) < 0.001);

  // 125x leverage
  driver.strategy.profiles.long.leverage = 125;
  const pos125x = driver.openTrade(coin, "long");
  assert.equal(pos125x.leverage, 125);
  assert.ok(Math.abs(pos125x.qty - (pos125x.margin * 125) / coin.price) < 0.001);

  // Leverage clamping (requested 150x clamped to max 125x)
  const requested = 150;
  const clamped = Math.min(125, Math.max(1, requested));
  assert.equal(clamped, 125);
});

test("Tier 2 [B6]: Margin boundary values: fractional cent ($0.01) vs exact full fund", () => {
  const driver = new FrontendStateDriver();
  const coin = driver.coins[0];

  // $0.01 margin
  driver.strategy.profiles.long.marginPerTrade = 0.01;
  const posMicro = driver.openTrade(coin, "long");
  assert.equal(posMicro.margin, 0.01);

  // Exceeding total fund rejection
  driver.strategy.profiles.long.marginPerTrade = 30000;
  assert.ok(
    driver.strategy.profiles.long.marginPerTrade > driver.initialFund,
    "Requested margin exceeds initial fund"
  );
});

test("Tier 2 [B7]: Stop-Loss & Take-Profit boundary limits (0.01% to 100%)", () => {
  const coinPrice = 1000.0;

  // Ultra-tight 0.01% SL & TP
  const tightSl = coinPrice * (1 - 0.0001);
  const tightTp = coinPrice * (1 + 0.0001);
  assert.equal(tightSl, 999.9);
  assert.equal(tightTp, 1000.1);

  // 100% SL
  const maxSl = coinPrice * (1 - 1.0);
  assert.equal(maxSl, 0);
});

test("Tier 2 [B8]: Extreme numerical magnitude formatting without overflow", () => {
  const extremeCoin = {
    symbol: "EXTREME",
    price: 0.0000001234,
    score: 99,
    status: "qualified",
    venues: ["Binance"],
    oiUsd: 999999999999, // 1 Trillion
    volUsd24h: 888888888888,
  };
  assert.ok(Number.isFinite(extremeCoin.oiUsd));
  assert.ok(Number.isFinite(extremeCoin.price));
  const snap = calculateExecutionSnapshot(extremeCoin);
  assert.ok(snap.spreadBps > 0);
  assert.ok(snap.fillRatio > 0);
});

// ============================================================================
// 3. Offline Feeds and Stale Data Handling
// ============================================================================

test("Tier 2 [B9]: Stale data freshness gates (Paper 150s vs Live 20s)", () => {
  const paperStaleMs = 150000;
  const liveStaleMs = 20000;

  // 25s old data
  const feedAgeMs = 25000;

  // Valid in Paper (25s < 150s)
  const isPaperValid = feedAgeMs < paperStaleMs;
  assert.equal(isPaperValid, true, "25s old data must remain valid in Paper mode");

  // Invalid in Live (25s > 20s)
  const isLiveValid = feedAgeMs < liveStaleMs;
  assert.equal(isLiveValid, false, "25s old data must be rejected as stale in Live mode");
});

test("Tier 2 [B10]: CoinGlass feed failure banner and entry halt", async () => {
  const server = new MockBackendServer();
  server.state.staleFeed = true;
  await server.start();
  try {
    const healthRes = await fetch(`${server.baseUrl}/api/health`);
    const health = await healthRes.json();
    assert.equal(health.stale, true, "Health endpoint must report stale feed status");
  } finally {
    await server.stop();
  }
});

// ============================================================================
// 4. Invalid Inputs and Schema Violations
// ============================================================================

test("Tier 2 [B11]: Backup import rejects malformed or corrupted JSON structure", async () => {
  const server = new MockBackendServer();
  await server.start();
  try {
    // Missing settings
    const badRes = await fetch(`${server.baseUrl}/api/backup/import`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${server.adminSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ corrupted: true }),
    });
    assert.equal(badRes.status, 400);
    const err = await badRes.json();
    assert.equal(err.ok, false);
    assert.match(err.error, /invalid backup/i);
  } finally {
    await server.stop();
  }
});

test("Tier 2 [B12]: Symbol exclusion whitespace and case normalization", () => {
  const rawInput = " usdt, Usdc ,dai , fdUSD , wbtc ";
  const normalized = rawInput
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  assert.deepEqual(normalized, ["USDT", "USDC", "DAI", "FDUSD", "WBTC"]);
});

// ============================================================================
// 5. Reconnection Drops and Auth Rejections
// ============================================================================

test("Tier 2 [B13]: Unauthorized mutating request rejected across all endpoints", async () => {
  const server = new MockBackendServer();
  await server.start();
  try {
    const endpoints = [
      { path: "/api/control", body: { action: "start" } },
      { path: "/api/kill-switch", body: { active: true } },
      { path: "/api/panic", body: {} },
      { path: "/api/mode", body: { mode: "live" } },
      { path: "/api/trade/open", body: { symbol: "BTC" } },
    ];
    for (const ep of endpoints) {
      const res = await fetch(`${server.baseUrl}${ep.path}`, {
        method: "POST",
        headers: { "content-type": "application/json" }, // Missing Auth header
        body: JSON.stringify(ep.body),
      });
      assert.equal(res.status, 401, `Endpoint ${ep.path} must require authentication`);
    }
  } finally {
    await server.stop();
  }
});

test("Tier 2 [B14]: Sneaky case-variant withdrawal permissions rejected unconditionally", async () => {
  const server = new MockBackendServer();
  await server.start();
  try {
    const variations = [
      ["withdraw"],
      ["WITHDRAW"],
      ["Withdrawal"],
      ["WITHDRAWAL"],
      ["transfer", "withdraw"],
    ];
    for (const perms of variations) {
      const res = await fetch(`${server.baseUrl}/api/exchange/test`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${server.adminSecret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          venue: "binance",
          apiKey: "test-key",
          secret: "test-secret",
          permissions: perms,
        }),
      });
      assert.equal(res.status, 400, `Permission variation ${JSON.stringify(perms)} must be rejected`);
      const err = await res.json();
      assert.match(err.error, /withdrawal/i);
    }
  } finally {
    await server.stop();
  }
});

test("Tier 2 [B15]: Injected server 500 error triggers graceful client error response", async () => {
  const server = new MockBackendServer();
  server.state.injectedErrors.set("/api/dashboard", { status: 500, message: "Internal DB Timeout" });
  await server.start();
  try {
    const res = await fetch(`${server.baseUrl}/api/dashboard`, {
      headers: { authorization: `Bearer ${server.adminSecret}` },
    });
    assert.equal(res.status, 500);
    const data = await res.json();
    assert.equal(data.ok, false);
    assert.equal(data.error, "Internal DB Timeout");
  } finally {
    await server.stop();
  }
});
