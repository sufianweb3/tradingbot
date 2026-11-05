/**
 * IndexedDB storage adapter for the paper-trading engine.
 *
 * Persists engine state, settings, trades, equity curve, activity logs,
 * and passive AI dataset inside the browser's IndexedDB ('oi-sniper-db').
 * Provides automatic in-memory fallback for private browsing / blocked storage.
 */

import { createInitialState, sanitizeLoadedState } from "../src/store.js";
import { now } from "../src/util.js";

export const DB_NAME = "oi-sniper-db";
export const DB_VERSION = 1;
export const FLUSH_DELAY_MS = 400;
export const MAX_LOG_RECORDS = 5000;
export const MAX_DATASET_RECORDS = 10000;

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("idb-request-failed"));
  });
}

function promisifyTx(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("idb-transaction-failed"));
    tx.onabort = () => reject(tx.error || new Error("idb-transaction-aborted"));
  });
}

export class IndexedDbStore {
  constructor({ db = null, savedState = null, fallbackMode = false } = {}) {
    this.db = db;
    this.fallbackMode = fallbackMode;
    this.state = savedState ? sanitizeLoadedState(savedState) : null;
    this._timer = null;
    this._dirty = false;
    this._flushChain = Promise.resolve();
  }

  static async open({ idbFactory } = {}) {
    const idb = idbFactory !== undefined ? idbFactory : (typeof indexedDB !== "undefined" ? indexedDB : null);
    if (!idb) {
      console.warn("[idb-store] IndexedDB unavailable - using in-memory store.");
      const store = new IndexedDbStore({ fallbackMode: true });
      store.load();
      return store;
    }

    try {
      const db = await new Promise((resolve, reject) => {
        const req = idb.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = (e) => {
          const database = e.target.result;
          if (!database.objectStoreNames.contains("state")) {
            database.createObjectStore("state", { keyPath: "key" });
          }
          if (!database.objectStoreNames.contains("settings")) {
            database.createObjectStore("settings", { keyPath: "key" });
          }
          if (!database.objectStoreNames.contains("trades")) {
            database.createObjectStore("trades", { keyPath: "id" });
          }
          if (!database.objectStoreNames.contains("curve")) {
            database.createObjectStore("curve", { keyPath: "time" });
          }
          if (!database.objectStoreNames.contains("logs")) {
            database.createObjectStore("logs", { keyPath: "id", autoIncrement: true });
          }
          if (!database.objectStoreNames.contains("dataset")) {
            database.createObjectStore("dataset", { keyPath: "id", autoIncrement: true });
          }
          if (!database.objectStoreNames.contains("vault")) {
            database.createObjectStore("vault", { keyPath: "key" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error("idb-open-failed"));
        req.onblocked = () => {
          console.warn("[idb-store] Database open blocked by another tab.");
        };
      });

      // Load active state from 'state' object store
      let saved = null;
      try {
        const tx = db.transaction("state", "readonly");
        const store = tx.objectStore("state");
        const row = await promisifyRequest(store.get("current"));
        if (row && row.value) {
          saved = row.value;
        }
      } catch (err) {
        console.warn("[idb-store] Failed to read existing state:", err?.message);
      }

      const instance = new IndexedDbStore({ db, savedState: saved, fallbackMode: false });
      instance.load();
      return instance;
    } catch (err) {
      console.warn("[idb-store] Failed to initialize IndexedDB, falling back to memory:", err?.message);
      const fallback = new IndexedDbStore({ fallbackMode: true });
      fallback.load();
      return fallback;
    }
  }

  load() {
    if (!this.state) {
      this.state = createInitialState();
      this.save(this.state);
    }
    return this.state;
  }

  replace(state) {
    this.state = sanitizeLoadedState(state);
    this.save(this.state);
  }

  save(state) {
    if (state) this.state = state;
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, FLUSH_DELAY_MS);
  }

  async flush() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (!this._dirty || !this.db || this.fallbackMode) {
      return this._flushChain;
    }

    this._dirty = false;
    const snapshot = JSON.parse(JSON.stringify(this.state));

    this._flushChain = this._flushChain
      .catch(() => null)
      .then(async () => {
        try {
          const tx = this.db.transaction(["state", "trades", "curve", "settings"], "readwrite");
          const stateStore = tx.objectStore("state");
          const settingsStore = tx.objectStore("settings");
          const tradesStore = tx.objectStore("trades");
          const curveStore = tx.objectStore("curve");

          // Save primary singleton
          stateStore.put({ key: "current", value: snapshot, updatedAt: now() });

          // Save settings mirror
          if (snapshot.settings) {
            settingsStore.put({ key: "config", value: snapshot.settings, updatedAt: now() });
          }

          // Mirror closed trades
          if (Array.isArray(snapshot.trades)) {
            for (const trade of snapshot.trades.slice(-500)) {
              if (trade && trade.id) tradesStore.put(trade);
            }
          }

          // Mirror equity curve (last 1000 points)
          if (Array.isArray(snapshot.equityCurve)) {
            for (const pt of snapshot.equityCurve.slice(-1000)) {
              if (pt && pt.time) curveStore.put(pt);
            }
          }

          await promisifyTx(tx);
        } catch (err) {
          console.error("[idb-store] Flush failed:", err?.message);
        }
      });

    return this._flushChain;
  }

  async reset() {
    const currentSettings = this.state?.settings;
    this.state = createInitialState();
    if (currentSettings) {
      this.state.settings = currentSettings;
    }
    if (this.db && !this.fallbackMode) {
      try {
        const tx = this.db.transaction(["trades", "curve", "logs", "dataset"], "readwrite");
        tx.objectStore("trades").clear();
        tx.objectStore("curve").clear();
        tx.objectStore("logs").clear();
        tx.objectStore("dataset").clear();
        await promisifyTx(tx);
      } catch (err) {
        console.warn("[idb-store] Reset clear error:", err?.message);
      }
    }
    this.save(this.state);
    await this.flush();
    return { ok: true };
  }

  async appendLog(entry) {
    if (!this.db || this.fallbackMode) return;
    try {
      const tx = this.db.transaction("logs", "readwrite");
      const store = tx.objectStore("logs");
      store.add({ ...entry, createdAt: now() });
      await promisifyTx(tx);
    } catch {
      /* ignore non-blocking log write */
    }
  }

  async appendDatasetTick(tick) {
    if (!this.db || this.fallbackMode) return;
    try {
      const tx = this.db.transaction("dataset", "readwrite");
      const store = tx.objectStore("dataset");
      store.add({ ...tick, recordedAt: now() });
      await promisifyTx(tx);
    } catch {
      /* ignore non-blocking tick write */
    }
  }

  async exportBackup() {
    await this.flush();
    const backup = {
      version: 1,
      app: "oi-sniper-web",
      exportedAt: now(),
      state: this.state,
    };

    if (this.db && !this.fallbackMode) {
      try {
        const tx = this.db.transaction(["trades", "curve", "logs"], "readonly");
        const tradesReq = promisifyRequest(tx.objectStore("trades").getAll());
        const curveReq = promisifyRequest(tx.objectStore("curve").getAll());
        const logsReq = promisifyRequest(tx.objectStore("logs").getAll());
        const [trades, curve, logs] = await Promise.all([tradesReq, curveReq, logsReq]);
        backup.trades = trades || [];
        backup.curve = curve || [];
        backup.logs = (logs || []).slice(-1000);
      } catch (err) {
        console.warn("[idb-store] Additional store backup read failed:", err?.message);
      }
    }
    return backup;
  }

  async importBackup(data) {
    if (!data || typeof data !== "object") {
      throw new Error("invalid-backup-format");
    }
    const incomingState = data.state || (data.fund && data.settings ? data : null);
    if (!incomingState) {
      throw new Error("backup-missing-state");
    }

    this.state = sanitizeLoadedState(incomingState);
    if (Array.isArray(data.trades) && data.trades.length > (this.state.trades?.length || 0)) {
      this.state.trades = data.trades;
    }
    if (Array.isArray(data.curve) && data.curve.length > (this.state.equityCurve?.length || 0)) {
      this.state.equityCurve = data.curve;
    }

    this.save(this.state);
    await this.flush();
    return { ok: true, trades: this.state.trades.length, positions: this.state.positions.length };
  }

  async importLegacyState(json) {
    return this.importBackup({ state: json });
  }
}
