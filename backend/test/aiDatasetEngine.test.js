/**
 * Integration check: the passive logger must work with the real Engine event
 * payload, not just a fake event emitter. The exchange hub is stubbed so this
 * test never touches the network or real trading.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Engine } from "../src/engine.js";
import { createInitialState } from "../src/store.js";
import { attachAiTradeLogger } from "../src/aiDataset.js";

test("AI logger records a real Engine open/close cycle", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oi-ai-engine-"));
  const datasetDir = path.join(tmp, "ai-dataset");
  const engine = new Engine({ dataDir: tmp });
  engine.state = createInitialState({
    totalFund: 500,
    allocationPercent: 50,
    leverage: 50,
    slPercent: 20,
    tp1Percent: 50,
    tp1ClosePercent: 50,
    tpMaxPercent: 1000,
    trailingEnabled: true,
    trailingStart: "tp1",
    trailingDistancePercent: 20,
    feePercent: 0.05,
    slippagePercent: 0.02,
    cooldownSec: 0,
  });
  engine.hub = {
    resolve: () => ({
      venue: "stub",
      venueName: "Stub",
      venueSymbol: "BTCUSDT",
      base: "BTC",
      symbol: "BTCUSDT",
      price: 100,
      volUsd: 1e9,
    }),
    quote: async () => ({
      price: 100,
      ts: Date.now(),
      venue: "stub",
      venueName: "Stub",
      venueSymbol: "BTCUSDT",
      base: "BTC",
      stale: false,
      fallback: false,
    }),
    summary: () => ({ venues: [], okVenues: 0, totalVenues: 0, instruments: 0 }),
    discover: async () => {},
  };
  engine.marketCache = {
    at: Date.now(),
    coins: [
      {
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
      },
    ],
    total: 1,
    pages: 1,
    error: null,
  };

  const logger = attachAiTradeLogger(engine, { dir: datasetDir, intervalMs: 60000 });
  try {
    const opened = await engine.openManual("BTC", { force: true });
    assert.equal(opened.ok, true);
    assert.equal(engine.state.positions.length, 1);

    await logger.tickNow();
    await logger.tickNow();

    const dirs = fs
      .readdirSync(datasetDir, { withFileTypes: true })
      .filter((d) => d.isDirectory());
    assert.equal(dirs.length, 1);
    const tradeDir = path.join(datasetDir, dirs[0].name);

    const entry = JSON.parse(fs.readFileSync(path.join(tradeDir, "trade.json"), "utf8"));
    assert.equal(entry.schema, "oi-bot-ai-trade/v1");
    assert.equal(entry.symbol, "BTC");
    assert.equal(entry.settings.leverage, 50);
    assert.equal(entry.entry.leverage, 50);
    assert.equal(entry.signal.oi["5m"], 3);
    assert.ok(Array.isArray(entry.criteria));
    assert.equal(entry.coin.name, "Bitcoin");
    assert.equal(entry.row.symbol, "BTC");

    const ticks = fs
      .readFileSync(path.join(tradeDir, "ticks.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.ok(ticks.length >= 2);
    assert.equal(ticks[0].coin.symbol, "BTC");
    assert.ok(ticks[0].metrics.price > 0);
    assert.ok(ticks[0].metrics.grossRoe !== undefined);

    const closed = await engine.closePositionById(opened.position.id, "test close");
    assert.equal(closed.ok, true);
    assert.equal(engine.state.positions.length, 0);

    const summary = JSON.parse(fs.readFileSync(path.join(tradeDir, "summary.json"), "utf8"));
    assert.equal(summary.schema, "oi-bot-ai-trade-summary/v1");
    assert.equal(summary.trade.symbol, "BTC");
    assert.equal(summary.trade.exitReason, "test close");
    assert.ok(summary.ticks >= 2);
    assert.equal(logger.sessions.size, 0);
  } finally {
    logger.dispose();
    engine.destroy?.();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
