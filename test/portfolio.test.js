/**
 * Multi-strategy portfolio tests.
 *
 * Strategies are real Engine instances with real JSON stores in a temporary
 * directory. Only the network edges (exchange hub and CoinGlass feed) and the
 * timers are stubbed, so these tests never touch a socket and never run a
 * background scan.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Portfolio } from "../src/portfolio.js";

class StubHub {
  constructor() {
    this.discoverCalls = 0;
  }

  async discover() {
    this.discoverCalls++;
  }

  summary() {
    return { venues: [], okVenues: 0, totalVenues: 0, instruments: 0 };
  }

  resolve() {
    return null;
  }

  async quote() {
    return null;
  }
}

class StubFeed {
  constructor() {
    this.cache = {
      at: Date.now(),
      coins: [],
      total: 0,
      pages: 0,
      fetchedInMs: 0,
      error: null,
    };
    this.status = {
      state: "connected",
      connected: true,
      refreshing: false,
      source: "scrape",
      lastError: null,
      coins: 0,
      pages: 0,
    };
    this.invalidations = 0;
  }

  key() {
    return "";
  }

  get() {
    return this.cache;
  }

  getStatus(extra = {}) {
    return { ...this.status, apiKeySet: false, ...extra };
  }

  invalidate() {
    this.invalidations++;
  }

  ingestDeviceFeed() {
    return { ok: false, error: "empty-feed" };
  }
}

function stubTimers() {
  let next = 1;
  const tasks = new Map();
  return {
    tasks,
    setTimeout(fn, ms) {
      const id = next++;
      tasks.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oi-portfolio-"));
}

function makePortfolio(dir, options = {}) {
  const hub = options.hub || new StubHub();
  const feed = options.feed || new StubFeed();
  const timers = options.timers || stubTimers();
  return new Portfolio({ dataDir: dir, hub, feed, timers, ...options });
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

test("first boot creates one main strategy and persists the index", async () => {
  const dir = tempDir();
  const portfolio = makePortfolio(dir);
  try {
    await portfolio.init();
    assert.equal(portfolio.list().length, 1);
    assert.equal(portfolio.selectedId(), "main");
    assert.equal(fs.existsSync(path.join(dir, "strategies", "index.json")), true);
    assert.equal(fs.existsSync(path.join(dir, "strategies", "main.json")), true);
  } finally {
    portfolio.destroy();
  }
});

test("each strategy keeps its own fund, settings, positions and file", async () => {
  const dir = tempDir();
  const portfolio = makePortfolio(dir);
  try {
    await portfolio.init();
    const main = portfolio.selected();
    assert.ok(open(main, "BTC"), "main strategy opens its own position");
    assert.equal(main.state.positions.length, 1);

    const created = await portfolio.create({
      name: "Momentum",
      fund: 1000,
      settings: { leverage: 10, feePercent: 0, slippagePercent: 0, slPercent: 12 },
    });
    assert.equal(created.ok, true);
    const momentum = portfolio.resolve(created.strategy.id);
    assert.ok(momentum);
    assert.notEqual(momentum.id, main.id);
    assert.equal(momentum.state.positions.length, 0, "positions are not shared");
    assert.equal(momentum.state.settings.totalFund, 1000);
    assert.equal(momentum.state.settings.leverage, 10);
    assert.equal(momentum.state.settings.slPercent, 12);
    assert.equal(main.state.settings.totalFund, 500, "main fund is untouched");
    assert.equal(portfolio.list().length, 2);
    assert.equal(portfolio.selectedId(), momentum.id, "a new strategy becomes selected");
    assert.equal(
      fs.existsSync(path.join(dir, "strategies", `${momentum.id}.json`)),
      true
    );

    const summary = portfolio.summary();
    assert.equal(summary.count, 2);
    assert.equal(summary.initialFund, 1500);
  } finally {
    portfolio.destroy();
  }
});

test("clone copies settings but not trades or positions", async () => {
  const dir = tempDir();
  const portfolio = makePortfolio(dir);
  try {
    await portfolio.init();
    const main = portfolio.selected();
    await portfolio.update(main.id, {
      settings: { slPercent: 33, leverage: 7, feePercent: 0, slippagePercent: 0 },
    });
    assert.ok(open(main, "ETH"));
    assert.equal(main.state.positions.length, 1);

    const result = await portfolio.create({ name: "Clone", cloneFrom: main.id, fund: 250 });
    assert.equal(result.ok, true);
    const clone = portfolio.resolve(result.strategy.id);
    assert.equal(clone.state.settings.slPercent, 33);
    assert.equal(clone.state.settings.leverage, 7);
    assert.equal(clone.state.settings.totalFund, 250);
    assert.equal(clone.state.positions.length, 0);
    assert.equal(clone.state.trades.length, 0);
    assert.equal(main.state.positions.length, 1);
  } finally {
    portfolio.destroy();
  }
});

test("index and per-strategy state survive a restart", async () => {
  const dir = tempDir();
  const first = makePortfolio(dir);
  let createdId = null;
  try {
    await first.init();
    const created = await first.create({
      name: "Swing",
      fund: 800,
      settings: { maxOpenPositions: 3, feePercent: 0, slippagePercent: 0 },
    });
    createdId = created.strategy.id;
    await first.flush();
  } finally {
    first.destroy();
  }

  const second = makePortfolio(dir);
  try {
    await second.init();
    assert.equal(second.list().length, 2);
    assert.equal(second.selectedId(), createdId);
    const swing = second.resolve(createdId);
    assert.ok(swing);
    assert.equal(swing.name, "Swing");
    assert.equal(swing.state.settings.totalFund, 800);
    assert.equal(swing.state.settings.maxOpenPositions, 3);
  } finally {
    second.destroy();
  }
});

test("legacy single-account state is adopted as the main strategy", async () => {
  const dir = tempDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      settings: { totalFund: 1234, leverage: 25, slPercent: 15 },
      initialFund: 1234,
      trades: [],
      positions: [],
      equityCurve: [],
      logs: [],
      meta: { running: false },
    })
  );

  const portfolio = makePortfolio(dir);
  try {
    await portfolio.init();
    assert.equal(portfolio.list().length, 1);
    const main = portfolio.selected();
    assert.equal(main.id, "main");
    assert.equal(main.state.settings.totalFund, 1234);
    assert.equal(main.state.settings.leverage, 25);
    assert.equal(portfolio.entries.get("main").file, "state.json");
    assert.equal(fs.existsSync(path.join(dir, "state.json")), true);

    const created = await portfolio.create({ name: "Second", fund: 400 });
    assert.equal(created.ok, true);
    assert.equal(portfolio.list().length, 2);
    // The legacy account keeps its original file; new accounts get their own.
    assert.equal(portfolio.entries.get("main").file, "state.json");
    assert.equal(
      fs.existsSync(path.join(dir, "strategies", `${created.strategy.id}.json`)),
      true
    );
  } finally {
    portfolio.destroy();
  }
});

test("select, start/pause all and delete keep the portfolio consistent", async () => {
  const dir = tempDir();
  const portfolio = makePortfolio(dir);
  try {
    await portfolio.init();
    const mainId = portfolio.selectedId();
    const created = await portfolio.create({ name: "Runner", fund: 600 });
    const runnerId = created.strategy.id;

    const selected = await portfolio.select(mainId);
    assert.equal(selected.ok, true);
    assert.equal(portfolio.selectedId(), mainId);

    const started = await portfolio.startAll();
    assert.equal(started.ok, true);
    assert.equal(started.started, 2);
    for (const engine of portfolio.engines.values()) {
      assert.equal(engine.state.meta.running, true);
      assert.equal(portfolio.entries.get(engine.id).desiredRunning, true);
    }

    const paused = await portfolio.pauseAll();
    assert.equal(paused.paused, 2);
    for (const engine of portfolio.engines.values()) {
      assert.equal(engine.state.meta.running, false);
      assert.equal(portfolio.entries.get(engine.id).desiredRunning, false);
    }

    const runnerFile = path.join(dir, "strategies", `${runnerId}.json`);
    assert.equal(fs.existsSync(runnerFile), true);
    const removed = await portfolio.remove(runnerId);
    assert.equal(removed.ok, true);
    assert.equal(removed.selectedId, mainId);
    assert.equal(fs.existsSync(runnerFile), false);
    assert.equal(portfolio.list().length, 1);

    const last = await portfolio.remove(mainId);
    assert.equal(last.ok, false);
    assert.equal(last.error, "last-strategy");
  } finally {
    portfolio.destroy();
  }
});

test("one CoinGlass key is shared with every strategy, including new ones", async () => {
  const dir = tempDir();
  const feed = new StubFeed();
  const portfolio = makePortfolio(dir, { feed });
  try {
    await portfolio.init();
    const before = feed.invalidations;
    const res = await portfolio.setCoinglassApiKey("  shared-secret  ");
    assert.equal(res.ok, true);
    assert.ok(feed.invalidations > before, "the shared feed is invalidated");
    for (const engine of portfolio.engines.values()) {
      assert.equal(engine.state.settings.coinglassApiKey, "shared-secret");
    }
    const selectedSettings = portfolio.selected().publicSettings();
    assert.equal(selectedSettings.coinglassApiKey, "");
    assert.equal(selectedSettings.coinglassKeySet, true);

    const created = await portfolio.create({ name: "Keyed", fund: 700 });
    assert.equal(
      portfolio.resolve(created.strategy.id).state.settings.coinglassApiKey,
      "shared-secret"
    );

    await portfolio.setCoinglassApiKey(null);
    for (const engine of portfolio.engines.values()) {
      assert.equal(engine.state.settings.coinglassApiKey, "");
    }
    assert.equal(portfolio.selected().publicSettings().coinglassKeySet, false);
  } finally {
    portfolio.destroy();
  }
});

test("dashboard, bootstrap and compare payloads expose the whole portfolio", async () => {
  const dir = tempDir();
  const portfolio = makePortfolio(dir);
  try {
    await portfolio.init();
    const created = await portfolio.create({ name: "Scalper", fund: 900 });
    const id = created.strategy.id;

    const dashboard = portfolio.getDashboard();
    assert.equal(dashboard.selectedId, id);
    assert.equal(dashboard.strategies.length, 2);
    assert.equal(dashboard.portfolio.count, 2);
    assert.equal(dashboard.venues.okVenues, 0);

    const bootstrap = portfolio.getBootstrap(id);
    assert.equal(bootstrap.selectedId, id);
    assert.equal(bootstrap.strategy.id, id);
    assert.equal(bootstrap.strategies.length, 2);
    assert.equal(bootstrap.portfolio.count, 2);

    const config = portfolio.getStrategyConfig(id);
    assert.equal(config.settings.totalFund, 900);
    assert.equal(config.settings.coinglassApiKey, "");
  } finally {
    portfolio.destroy();
  }
});

test("a strategy created from another inherits the shared feed without rescanning", async () => {
  const dir = tempDir();
  const hub = new StubHub();
  const feed = new StubFeed();
  const portfolio = makePortfolio(dir, { hub, feed });
  try {
    await portfolio.init();
    const discoverBefore = hub.discoverCalls;
    await portfolio.create({ name: "No prime", fund: 500 });
    // Creating a strategy must not trigger exchange discovery or CoinGlass.
    assert.equal(hub.discoverCalls, discoverBefore);
    assert.equal(portfolio.engines.size, 2);
  } finally {
    portfolio.destroy();
  }
});
