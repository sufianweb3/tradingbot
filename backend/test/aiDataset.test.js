/**
 * AI dataset logger tests. Uses a fake engine so no network or trading code is
 * involved; the logger must remain a pure observer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { attachAiTradeLogger } from "../src/aiDataset.js";

function makeFakeEngine(dir) {
  const listeners = new Map();
  const t = Date.now();
  const coin = {
    symbol: "BTC",
    name: "Bitcoin",
    price: 100,
    oi: { "5m": 3, "15m": 4, "30m": 5, "1h": 6, "4h": 7 },
    vol: { "1h": 40, "4h": 55 },
    oiUsd: 1e9,
    volUsd24h: 2e9,
    oiChange24h: 8,
    volChange24h: 9,
    priceChange1h: 1.2,
    priceChange24h: 3.4,
    funding: 0.01,
  };
  const position = {
    id: "pos_test123",
    status: "open",
    symbol: "BTC",
    side: "long",
    venue: "stub",
    venueName: "Stub",
    venueSymbol: "BTCUSDT",
    base: "BTC",
    source: "Stub",
    entryTime: t,
    entryPrice: 100,
    signalPrice: 100,
    qty: 1,
    originalQty: 1,
    margin: 50,
    notional: 5000,
    leverage: 50,
    entryFee: 2.5,
    feePercent: 0.05,
    slippagePercent: 0.02,
    slPrice: 95,
    initialSlPrice: 95,
    tp1Price: 105,
    tpMaxPrice: 120,
    liqPrice: 90,
    trailingEnabled: true,
    trailingStart: "tp1",
    trailingDistancePercent: 20,
    trailStopPrice: null,
    trailingActive: false,
    peakPrice: 100,
    peakRoe: 0,
    markPrice: 100,
    markTs: t,
    markVenue: "stub",
    priceStale: false,
    quoteFailures: 0,
    fallbackStreak: 0,
    riskMode: "roe",
    slPercent: 20,
    tp1Percent: 50,
    tpMaxPercent: 1000,
    tp1ClosePercent: 50,
    criteria: [{ group: "oi", key: "5m", label: "OI 5m", op: ">=", threshold: 2, value: 3, pass: true }],
    signal: { oi: coin.oi, vol: coin.vol, oiUsd: coin.oiUsd, volUsd24h: coin.volUsd24h, price: 100 },
  };
  const engine = {
    store: { file: path.join(dir, "state.json") },
    state: { positions: [], settings: { leverage: 50, totalFund: 500 } },
    marketCache: { coins: [coin] },
    hub: {
      quotes: new Map([["stub:BTCUSDT", { price: 100, ts: t, venue: "stub", venueName: "Stub", venueSymbol: "BTCUSDT", base: "BTC", stale: false, fallback: false }]]),
      async quote() {
        return {
          price: 101,
          ts: Date.now(),
          venue: "stub",
          venueName: "Stub",
          venueSymbol: "BTCUSDT",
          base: "BTC",
          stale: false,
          fallback: false,
        };
      },
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    emit(event, payload) {
      for (const fn of listeners.get(event) || []) fn(payload);
    },
    publicSettings() {
      return { ...this.state.settings, coinglassApiKey: "", coinglassKeySet: false };
    },
    getMarketRows() {
      return [
        {
          symbol: "BTC",
          price: 101,
          oi: coin.oi,
          vol: coin.vol,
          oiUsd: coin.oiUsd,
          volUsd24h: coin.volUsd24h,
          venue: "Stub",
          venueKey: "stub",
          tradable: true,
          stale: false,
          excluded: false,
          open: true,
          openCount: 1,
          maxPerCoin: 1,
          cooling: false,
          configured: true,
          qualified: true,
          side: "long",
          passCount: 1,
          total: 1,
          score: 1.5,
          blockReason: "coin-cap",
        },
      ];
    },
    getStats() {
      return { equity: 500, balance: 500, available: 450, lockedMargin: 50, totalTrades: 0, openTrades: 1 };
    },
    position,
  };
  return engine;
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("AI logger records entry, per-second ticks, partial and close", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oi-ai-test-"));
  const datasetDir = path.join(tmp, "ai-dataset");
  const engine = makeFakeEngine(tmp);
  const logger = attachAiTradeLogger(engine, { dir: datasetDir, intervalMs: 60000 });
  assert.equal(logger.enabled, true);

  try {
    engine.state.positions.push(engine.position);
    engine.emit("trade", { type: "open", position: engine.position });

    const dirs = fs
      .readdirSync(datasetDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    assert.equal(dirs.length, 1);
    const tradeDir = path.join(datasetDir, dirs[0].name);

    const entry = JSON.parse(fs.readFileSync(path.join(tradeDir, "trade.json"), "utf8"));
    assert.equal(entry.schema, "oi-bot-ai-trade/v1");
    assert.equal(entry.tradeId, "pos_test123");
    assert.equal(entry.settings.leverage, 50);
    assert.equal(entry.coin.oi["5m"], 3);
    assert.equal(entry.row.side, "long");
    assert.equal(entry.plan.slPrice, 95);

    await logger.tickNow();
    await logger.tickNow();
    const ticks = readJsonl(path.join(tradeDir, "ticks.jsonl"));
    assert.ok(ticks.length >= 2, `expected at least 2 ticks, got ${ticks.length}`);
    const tick = ticks[ticks.length - 1];
    assert.equal(tick.schema, "oi-bot-ai-tick/v1");
    assert.ok(tick.metrics.price > 0);
    assert.equal(tick.coin.symbol, "BTC");
    assert.equal(tick.row.qualified, true);
    assert.equal(tick.position.stopPrice, 95);

    engine.position.tp1Hit = true;
    engine.position.partials = [{ t: Date.now(), reason: "TP1", qty: 0.5, price: 105, gross: 2.5, fee: 0.1, net: 2.4 }];
    engine.emit("trade", { type: "partial", position: engine.position });

    const trade = {
      ...engine.position,
      id: "pos_test123",
      status: "closed",
      exitTime: Date.now(),
      exitPrice: 105,
      grossPnl: 5,
      exitFees: 1,
      pnlNet: 1.5,
      roe: 3,
      exitReason: "TP max",
      feesPaid: 3.5,
      durationMs: 60000,
    };
    engine.state.positions = [];
    engine.emit("trade", { type: "close", trade });

    const events = readJsonl(path.join(tradeDir, "events.jsonl"));
    assert.ok(events.some((e) => e.event === "partial"));
    assert.ok(events.some((e) => e.event === "close"));

    const summary = JSON.parse(fs.readFileSync(path.join(tradeDir, "summary.json"), "utf8"));
    assert.equal(summary.schema, "oi-bot-ai-trade-summary/v1");
    assert.equal(summary.trade.pnlNet, 1.5);
    assert.ok(summary.ticks >= 2);

    const index = readJsonl(path.join(datasetDir, "index.jsonl"));
    assert.ok(index.some((e) => e.event === "open"));
    assert.ok(index.some((e) => e.event === "close"));
    assert.equal(logger.sessions.size, 0);
  } finally {
    logger.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("AI logger can be disabled without side effects", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oi-ai-test-"));
  const engine = makeFakeEngine(tmp);
  const logger = attachAiTradeLogger(engine, { enabled: false, dir: path.join(tmp, "data") });
  assert.equal(logger.enabled, false);
  assert.equal(typeof logger.dispose, "function");
  assert.equal(fs.existsSync(path.join(tmp, "data")), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});
