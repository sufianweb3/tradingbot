/**
 * Dedicated automated unit tests for Backup Export & Import (Milestone M6 / R1)
 *
 * Covers:
 * - Default key stripping (coinglassApiKey, coinglassKeySet, live credentials)
 * - Opt-in key inclusion ({ includeKeys: true })
 * - State restoration: settings, trades, equity curve, logs
 * - API key preservation invariant on import (stripped backup never clobbers active key)
 * - Explicit API key restoration when opt-in backup is provided
 * - Validation & error rejection (null, non-object, missing state)
 * - Both Node Store (src/store.js) and Browser IndexedDbStore (web/store-idb.js)
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import "fake-indexeddb/auto";

import { Store, createInitialState } from "../src/store.js";
import { IndexedDbStore } from "../web/store-idb.js";
import { Engine } from "../src/engine.js";

function createTempStoreFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
  return path.join(dir, "state.json");
}

/* ------------------------------------------------------------------ */
/* Node Store (src/store.js) Tests                                    */
/* ------------------------------------------------------------------ */

test("Store (Node): exportBackup strips API keys by default", () => {
  const filePath = createTempStoreFile();
  const store = new Store(filePath);
  store.load();

  store.state.settings.coinglassApiKey = "SECRET_CG_KEY_XYZ";
  store.state.settings.coinglassKeySet = true;
  store.state.settings.live = {
    venue: "bybit",
    apiKey: "BYBIT_API_KEY_SECRET",
    secret: "BYBIT_SECRET_HMAC",
    passphrase: "PASSPHRASE_SECRET",
    margin: 250,
  };
  store.save();
  store.flush();

  // 1. Default export (no argument)
  const backupDefault = store.exportBackup();
  assert.equal(backupDefault.settings.coinglassApiKey, "", "coinglassApiKey must be empty string");
  assert.equal(backupDefault.settings.coinglassKeySet, undefined, "coinglassKeySet must be deleted");
  assert.equal(backupDefault.settings.live?.apiKey, undefined, "live.apiKey must be deleted");
  assert.equal(backupDefault.settings.live?.secret, undefined, "live.secret must be deleted");
  assert.equal(backupDefault.settings.live?.passphrase, undefined, "live.passphrase must be deleted");
  assert.equal(backupDefault.settings.live?.venue, "bybit", "non-sensitive venue preserved");
  assert.equal(backupDefault.settings.live?.margin, 250, "non-sensitive margin preserved");

  // Ensure state property in backup is also sanitized
  assert.equal(backupDefault.state.settings.coinglassApiKey, "");
  assert.equal(backupDefault.state.settings.live?.apiKey, undefined);

  // 2. Explicit includeKeys: false
  const backupExplicitFalse = store.exportBackup({ includeKeys: false });
  assert.equal(backupExplicitFalse.settings.coinglassApiKey, "");
  assert.equal(backupExplicitFalse.settings.live?.apiKey, undefined);
});

test("Store (Node): exportBackup preserves API keys when includeKeys: true", () => {
  const filePath = createTempStoreFile();
  const store = new Store(filePath);
  store.load();

  store.state.settings.coinglassApiKey = "RETAINED_CG_KEY_123";
  store.state.settings.coinglassKeySet = true;
  store.state.settings.live = {
    venue: "kucoin",
    apiKey: "KUCOIN_KEY_123",
    secret: "KUCOIN_SECRET_456",
    passphrase: "KUCOIN_PASS_789",
    margin: 500,
  };
  store.save();
  store.flush();

  const backup = store.exportBackup({ includeKeys: true });
  assert.equal(backup.settings.coinglassApiKey, "RETAINED_CG_KEY_123");
  assert.equal(backup.settings.coinglassKeySet, true);
  assert.equal(backup.settings.live.apiKey, "KUCOIN_KEY_123");
  assert.equal(backup.settings.live.secret, "KUCOIN_SECRET_456");
  assert.equal(backup.settings.live.passphrase, "KUCOIN_PASS_789");
  assert.equal(backup.state.settings.coinglassApiKey, "RETAINED_CG_KEY_123");
});

test("Store (Node): exportBackup conforms to PRD §5.10 / R7 backup schema", () => {
  const filePath = createTempStoreFile();
  const store = new Store(filePath);
  store.load();

  const backup = store.exportBackup();
  assert.equal(backup.version, 1, "version must be 1");
  assert.equal(backup.app, "oi-sniper-web", "app identifier must match");
  assert.ok(typeof backup.exportedAt === "string" && !isNaN(Date.parse(backup.exportedAt)), "valid ISO timestamp");
  assert.ok(typeof backup.settings === "object", "settings must be present");
  assert.ok(Array.isArray(backup.trades), "trades must be an array");
  assert.ok(Array.isArray(backup.equityCurve), "equityCurve must be an array");
  assert.ok(Array.isArray(backup.curve), "curve alias must match equityCurve");
  assert.ok(Array.isArray(backup.logs), "logs must be an array");
  assert.ok(typeof backup.state === "object", "state must be present");
});

test("Store (Node): importBackup restores settings, trades, equityCurve, and logs", () => {
  const filePath = createTempStoreFile();
  const store = new Store(filePath);
  store.load();

  const backupPayload = {
    version: 1,
    app: "oi-sniper-web",
    exportedAt: new Date().toISOString(),
    settings: {
      totalFund: 2500,
      leverage: 35,
      slPercent: 18,
    },
    trades: [
      { id: "t1", symbol: "BTC", grossPnl: 150, pnlNet: 140 },
      { id: "t2", symbol: "ETH", grossPnl: -50, pnlNet: -55 },
    ],
    equityCurve: [
      { t: 1000, equity: 2500 },
      { t: 2000, equity: 2585 },
    ],
    logs: [
      { t: 1000, level: "info", msg: "Bot started" },
      { t: 2000, level: "warn", msg: "Position closed" },
    ],
  };

  const res = store.importBackup(backupPayload);
  assert.equal(res.ok, true);
  assert.equal(res.trades, 2);

  assert.equal(store.state.settings.totalFund, 2500);
  assert.equal(store.state.settings.leverage, 35);
  assert.equal(store.state.settings.slPercent, 18);
  assert.equal(store.state.trades.length, 2);
  assert.equal(store.state.trades[0].symbol, "BTC");
  assert.equal(store.state.equityCurve.length, 2);
  assert.equal(store.state.equityCurve[1].equity, 2585);
  assert.equal(store.state.logs.length, 2);
  assert.equal(store.state.logs[1].msg, "Position closed");
});

test("Store (Node): importBackup preserves existing CoinGlass API key when importing key-stripped backup", () => {
  const filePath = createTempStoreFile();
  const store = new Store(filePath);
  store.load();

  // Existing user has an active API key
  store.state.settings.coinglassApiKey = "EXISTING_ACTIVE_KEY_ABC";
  store.save();
  store.flush();

  // Incoming backup has no key (stripped default export)
  const incomingBackup = {
    version: 1,
    settings: {
      totalFund: 1000,
      coinglassApiKey: "",
    },
    trades: [],
    equityCurve: [],
    logs: [],
  };

  store.importBackup(incomingBackup);

  // Invariant: User does NOT lose their existing key
  assert.equal(
    store.state.settings.coinglassApiKey,
    "EXISTING_ACTIVE_KEY_ABC",
    "must preserve existing active API key when imported key is empty"
  );
});

test("Store (Node): importBackup updates CoinGlass API key when incoming backup includes key", () => {
  const filePath = createTempStoreFile();
  const store = new Store(filePath);
  store.load();

  store.state.settings.coinglassApiKey = "OLD_KEY";
  store.save();
  store.flush();

  const optInBackup = {
    version: 1,
    settings: {
      totalFund: 1000,
      coinglassApiKey: "NEW_RESTORED_KEY_XYZ",
    },
    trades: [],
  };

  store.importBackup(optInBackup);
  assert.equal(store.state.settings.coinglassApiKey, "NEW_RESTORED_KEY_XYZ");
});

test("Store (Node): importBackup rejects invalid formats and missing state", () => {
  const filePath = createTempStoreFile();
  const store = new Store(filePath);
  store.load();

  // Invalid formats (null, primitives)
  assert.throws(() => store.importBackup(null), /invalid-backup-format/);
  assert.throws(() => store.importBackup(undefined), /invalid-backup-format/);
  assert.throws(() => store.importBackup("not an object"), /invalid-backup-format/);
  assert.throws(() => store.importBackup(12345), /invalid-backup-format/);

  // Missing state/settings
  assert.throws(() => store.importBackup({}), /backup-missing-state/);
  assert.throws(() => store.importBackup({ version: 1, app: "oi-sniper-web" }), /backup-missing-state/);
});

test("Store (Node): roundtrip exportBackup -> modify -> importBackup restores state", () => {
  const filePath = createTempStoreFile();
  const store = new Store(filePath);
  store.load();

  store.state.settings.totalFund = 1500;
  store.state.settings.leverage = 20;
  store.state.trades.push({ id: "tr_1", symbol: "SOL", grossPnl: 45 });
  store.state.equityCurve.push({ t: 500, equity: 1545 });
  store.save();
  store.flush();

  const exported = store.exportBackup();

  // Mutate local state
  store.state.settings.totalFund = 9999;
  store.state.trades = [];
  store.state.equityCurve = [];
  store.save();
  store.flush();

  // Restore
  store.importBackup(exported);

  assert.equal(store.state.settings.totalFund, 1500);
  assert.equal(store.state.trades.length, 1);
  assert.equal(store.state.equityCurve.length, exported.equityCurve.length);
  assert.equal(store.state.equityCurve[store.state.equityCurve.length - 1].equity, 1545);
});

test("Store (Node): importBackup caps logs to 1000 items", () => {
  const filePath = createTempStoreFile();
  const store = new Store(filePath);
  store.load();

  const manyLogs = [];
  for (let i = 0; i < 1500; i++) {
    manyLogs.push({ t: i, level: "info", msg: `Log entry ${i}` });
  }

  const payload = {
    settings: { totalFund: 500 },
    logs: manyLogs,
  };

  store.importBackup(payload);
  assert.equal(store.state.logs.length, 1000, "logs must be capped to 1000");
  assert.equal(store.state.logs[0].msg, "Log entry 500", "should retain most recent 1000");
  assert.equal(store.state.logs[999].msg, "Log entry 1499");
});

/* ------------------------------------------------------------------ */
/* Browser IndexedDbStore (web/store-idb.js) Tests                    */
/* ------------------------------------------------------------------ */

test("IndexedDbStore (IDB): exportBackup strips API keys by default", async () => {
  const store = await IndexedDbStore.open();
  store.state = createInitialState();
  store.state.settings.coinglassApiKey = "SENSITIVE_IDB_CG_KEY";
  store.state.settings.coinglassKeySet = true;
  store.state.settings.live = {
    venue: "binance",
    apiKey: "BINANCE_SECRET_KEY",
    secret: "BINANCE_SECRET_HMAC",
    margin: 100,
  };
  await store.flush();

  const backup = await store.exportBackup();
  assert.equal(backup.settings.coinglassApiKey, "", "coinglassApiKey must be empty string");
  assert.equal(backup.settings.coinglassKeySet, undefined, "coinglassKeySet must be deleted");
  assert.equal(backup.settings.live?.apiKey, undefined, "live.apiKey must be stripped");
  assert.equal(backup.settings.live?.secret, undefined, "live.secret must be stripped");
  assert.equal(backup.settings.live?.venue, "binance", "non-sensitive live venue preserved");
});

test("IndexedDbStore (IDB): exportBackup includes API keys when opt-in includeKeys: true", async () => {
  const store = await IndexedDbStore.open();
  store.state = createInitialState();
  store.state.settings.coinglassApiKey = "OPT_IN_IDB_KEY";
  store.state.settings.coinglassKeySet = true;
  store.state.settings.live = {
    venue: "gate",
    apiKey: "GATE_API_KEY",
    secret: "GATE_SECRET",
  };
  await store.flush();

  const backup = await store.exportBackup({ includeKeys: true });
  assert.equal(backup.settings.coinglassApiKey, "OPT_IN_IDB_KEY");
  assert.equal(backup.settings.coinglassKeySet, true);
  assert.equal(backup.settings.live.apiKey, "GATE_API_KEY");
  assert.equal(backup.settings.live.secret, "GATE_SECRET");
});

test("IndexedDbStore (IDB): importBackup restores state and syncs IndexedDB stores", async () => {
  const store = await IndexedDbStore.open();
  store.state = createInitialState();

  const backupData = {
    version: 1,
    app: "oi-sniper-web",
    settings: {
      totalFund: 3000,
      leverage: 15,
    },
    trades: [
      { id: "idb_t1", symbol: "AVAX", grossPnl: 80 },
    ],
    equityCurve: [
      { t: 100, equity: 3000 },
      { t: 200, equity: 3080 },
    ],
    logs: [
      { t: 100, level: "info", msg: "Restored in IDB" },
    ],
  };

  const res = await store.importBackup(backupData);
  assert.equal(res.ok, true);
  assert.equal(res.trades, 1);

  assert.equal(store.state.settings.totalFund, 3000);
  assert.equal(store.state.settings.leverage, 15);
  assert.equal(store.state.trades.length, 1);
  assert.equal(store.state.trades[0].symbol, "AVAX");
  assert.equal(store.state.equityCurve.length, 2);
  assert.equal(store.state.logs.length, 1);
});

test("IndexedDbStore (IDB): importBackup preserves existing CoinGlass key when incoming is stripped", async () => {
  const store = await IndexedDbStore.open();
  store.state = createInitialState();
  store.state.settings.coinglassApiKey = "MY_EXISTING_IDB_KEY";
  await store.flush();

  const strippedBackup = {
    version: 1,
    settings: {
      totalFund: 500,
      coinglassApiKey: "",
    },
    trades: [],
  };

  await store.importBackup(strippedBackup);
  assert.equal(
    store.state.settings.coinglassApiKey,
    "MY_EXISTING_IDB_KEY",
    "IDB store must preserve active key across stripped backup imports"
  );
});

test("IndexedDbStore (IDB): importBackup rejects invalid format and missing state", async () => {
  const store = await IndexedDbStore.open();

  await assert.rejects(async () => {
    await store.importBackup(null);
  }, /invalid-backup-format/);

  await assert.rejects(async () => {
    await store.importBackup("invalid");
  }, /invalid-backup-format/);

  await assert.rejects(async () => {
    await store.importBackup({});
  }, /backup-missing-state/);
});

test("Store (Node): importBackup with corrupted trade elements safely strips invalid elements without crashing engine.getStats()", () => {
  const filePath = createTempStoreFile();
  const store = new Store(filePath);
  store.load();
  const engine = new Engine(store);

  const corruptedPayload = {
    version: 1,
    app: "oi-sniper-web",
    settings: {
      totalFund: 1000,
      mode: "paper",
    },
    // Malformed array containing null, undefined, primitives, empty object, and valid trade
    trades: [
      null,
      undefined,
      42,
      "corrupted_entry",
      {},
      { id: "" },
      {
        id: "T_VALID_1",
        symbol: "BTC",
        side: "long",
        mode: "paper",
        entryPrice: 100,
        exitPrice: 110,
        margin: 100,
        leverage: 10,
        pnlNet: 100,
        grossPnl: 100,
        feesPaid: 2,
        exitTime: Date.now(),
      },
    ],
    equityCurve: [
      null,
      undefined,
      "not an object",
      {},
      { equity: "not a number" },
      { equity: 1100, t: Date.now() },
    ],
  };

  const res = store.importBackup(corruptedPayload);
  assert.equal(res.ok, true);

  // Invariant: only the single genuinely valid trade object with non-empty string id is retained
  assert.equal(store.state.trades.length, 1);
  assert.equal(store.state.trades[0].id, "T_VALID_1");

  // Invariant: only valid equityCurve point with finite equity is retained
  assert.equal(store.state.equityCurve.length, 1);
  assert.equal(store.state.equityCurve[0].equity, 1100);
  assert.ok(store.state.equityCurve[0].time !== undefined);

  // Invariant: engine.getStats() executes smoothly without throwing TypeError
  engine.state = store.state;
  let stats;
  assert.doesNotThrow(() => {
    stats = engine.getStats("paper");
  });
  assert.ok(stats, "stats must be returned");
  assert.equal(stats.totalTrades, 1);
  assert.equal(stats.realizedPnl, 100);
});

test("IndexedDbStore (IDB): importBackup with corrupted trade and equityCurve elements safely strips invalid items", async () => {
  const store = await IndexedDbStore.open();
  store.state = createInitialState();

  const corruptedPayload = {
    version: 1,
    app: "oi-sniper-web",
    settings: {
      totalFund: 2000,
      mode: "live",
    },
    trades: [
      null,
      undefined,
      "bad",
      100,
      { id: "" },
      { notId: "missing id" },
      {
        id: "IDB_VALID_1",
        symbol: "ETH",
        side: "short",
        mode: "live",
        entryPrice: 2000,
        exitPrice: 1900,
        pnlNet: 150,
      },
    ],
    equityCurve: [
      null,
      "invalid",
      { equity: NaN },
      { equity: Infinity },
      { equity: 2150, t: 5000 },
    ],
  };

  const res = await store.importBackup(corruptedPayload);
  assert.equal(res.ok, true);
  assert.equal(res.trades, 1);

  assert.equal(store.state.trades.length, 1);
  assert.equal(store.state.trades[0].id, "IDB_VALID_1");
  assert.equal(store.state.equityCurve.length, 1);
  assert.equal(store.state.equityCurve[0].equity, 2150);
  assert.equal(store.state.equityCurve[0].time, 5000);
});

