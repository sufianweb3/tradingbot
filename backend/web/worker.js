/**
 * Dedicated Browser Web Worker Runtime for OI Sniper
 *
 * Runs the strategy Engine, IndexedDB persistence, and CoinGlass scraping
 * completely off the UI thread inside a dedicated Web Worker.
 */

import { Engine } from "../src/engine.js";
import { getCredentials } from "../src/vault.js";
import { createVenueAdapter } from "../src/venues/index.js";
import { CoinGlassWorkerClient } from "./cg-worker.js";
import { DataWorkerRuntime } from "./dataWorker.js";
import { EngineWorkerRuntime } from "./engineWorker.js";
import { handleRpcRequest } from "./routes.js";
import { IndexedDbStore } from "./store-idb.js";

const BOOTED_AT = Date.now();
const BROADCAST_NAME = "oi-sniper-bus";

let store = null;
let engine = null;
let cgClient = null;
let dataWorker = null;
let engineWorker = null;
let bus = null;
let readyResolve = null;
const readyPromise = new Promise((resolve) => {
  readyResolve = resolve;
});

async function boot() {
  console.log("[worker] Initializing IndexedDbStore...");
  store = await IndexedDbStore.open();
  const wasRunning = Boolean(store.state?.meta?.running);

  cgClient = new CoinGlassWorkerClient();
  if (store.state?.settings?.coinglassApiKey) {
    cgClient.setApiKey(store.state.settings.coinglassApiKey);
  }

  engine = new Engine({
    store,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
    },
  });

  // Wire Dual-Worker Data <-> Engine MessageChannel pipeline (FX-60)
  if (typeof MessageChannel !== "undefined") {
    const channel = new MessageChannel();
    dataWorker = new DataWorkerRuntime({
      cgClient,
      hub: engine.hub,
      port: channel.port1,
      settings: store.state?.settings || {},
    });
    engineWorker = new EngineWorkerRuntime({
      engine,
      port: channel.port2,
    });
  } else {
    dataWorker = new DataWorkerRuntime({
      cgClient,
      hub: engine.hub,
      settings: store.state?.settings || {},
    });
    engineWorker = new EngineWorkerRuntime({ engine });
  }

  // Inject in-worker scraper to bypass Cloudflare block
  engine._marketData = async () => {
    const startedAt = Date.now();
    const res = await cgClient.fetchMarkets();
    if (dataWorker && Array.isArray(res?.coins)) {
      dataWorker.ingestBatch(res.coins, {
        lane: "top100",
        startedAt,
        fetchedInMs: res.fetchedInMs,
      });
    }
    engine.marketCache = {
      at: Date.now(),
      coins: res.coins,
      total: res.total,
      pages: res.pages,
      fetchedInMs: res.fetchedInMs,
      error: null,
    };
    return engine.marketCache;
  };

  try {
    await engine.init();
    console.log("[worker] Engine initialized successfully.");

    // Restore Live exchange adapter if credentials exist in Vault (PRD 5.6, 5.7)
    const activeVenue = store.state?.settings?.live?.exchange;
    if (activeVenue) {
      try {
        const creds = await getCredentials(activeVenue, { idbStore: store });
        if (creds && creds.apiKey && creds.secret) {
          const adapter = createVenueAdapter(activeVenue, { apiKey: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase });
          engine.setLiveAdapter(adapter);
          console.log(`[worker] Restored live adapter for ${activeVenue}`);
        }
      } catch (err) {
        console.warn("[worker] Live adapter restore warning:", err?.message);
      }
    }
  } catch (err) {
    console.error("[worker] Engine init failed:", err);
  }

  // PRD Autostart on load: resume running state if previous session was running
  if (wasRunning && !engine.state.meta.running) {
    console.log("[worker] Resuming running state from previous session.");
    engine.start("resume");
  }

  // Setup BroadcastChannel for multi-tab state sync
  try {
    if (typeof BroadcastChannel !== "undefined") {
      bus = new BroadcastChannel(BROADCAST_NAME);
    }
  } catch (err) {
    console.warn("[worker] BroadcastChannel not supported:", err);
  }

  // Periodic CoinGlass background scraper (fast lane 10s, full lane 60s)
  setInterval(async () => {
    try {
      await engine.refreshMarketsIfStale();
    } catch {
      /* handled inside cgClient */
    }
  }, 15000);

  // Live telemetry broadcast loop (every 1 second)
  setInterval(() => {
    if (!engine || !bus) return;
    try {
      const live = engine.getLive();
      const payload = {
        type: "TICK",
        serverTime: Date.now(),
        ...live,
        stats: engine.getStats(),
        running: engine.state.meta.running,
        coinglassStale: cgClient.isStale(),
        stopNewEntries: cgClient.status.stopNewEntries,
      };
      bus.postMessage(payload);
    } catch {
      /* ignore broadcast errors */
    }
  }, 1000);

  readyResolve();
}

self.onmessage = async (e) => {
  const req = e.data;
  if (!req) return;

  // Flush command on pagehide/tab close
  if (req.type === "FLUSH") {
    if (store) {
      await store.flush();
    }
    self.postMessage({ id: req.id, ok: true, type: "FLUSH_ACK" });
    return;
  }

  await readyPromise;

  const { id, path, method = "GET", body = {}, query = {} } = req;
  try {
    const res = await handleRpcRequest(
      { path, method, body, query },
      { engine, store, cgClient, bootedAt: BOOTED_AT }
    );
    self.postMessage({
      id,
      ok: res.status >= 200 && res.status < 400,
      status: res.status,
      ...res.data,
    });
  } catch (err) {
    console.error("[worker] Request failed:", path, err);
    self.postMessage({
      id,
      ok: false,
      status: 500,
      error: err.message || "internal-worker-error",
    });
  }
};

boot().catch((err) => {
  console.error("[worker] Boot failed fatally:", err);
});
