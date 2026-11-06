/**
 * Dedicated Data Worker Runtime (Section 9.1 FX-60, Section 7.1 FX-40..FX-43)
 *
 * Handles CoinGlass scraping/decryption, multi-lane scheduling (Movers, Hot, Top100, Full),
 * public exchange L2 book fetching, and compact diff streaming to the Engine Worker over MessagePort.
 */

import {
  DEFAULT_SPEED_SETTINGS,
  LaneInFlightGuard,
  computeMarketDiff,
} from "../src/core/speed.js";
import { toNum } from "../src/util.js";

export class DataWorkerRuntime {
  constructor({ cgClient = null, hub = null, port = null, settings = {} } = {}) {
    this.cgClient = cgClient;
    this.hub = hub;
    this.port = port;
    this.settings = { ...DEFAULT_SPEED_SETTINGS, ...(settings?.speed || settings || {}) };
    this.laneGuard = new LaneInFlightGuard();
    this.knownCoins = new Map(); // symbol -> coin
    this.bookTargets = new Map(); // `${venue}:${symbol}` -> { venue, symbol, priority }
    this.timers = new Set();
    this.running = false;
    this.stats = {
      moversRuns: 0,
      hotRuns: 0,
      top100Runs: 0,
      fullRuns: 0,
      booksFetched: 0,
      diffsEmitted: 0,
    };

    if (this.port) {
      this.attachPort(this.port);
    }
  }

  attachPort(port) {
    this.port = port;
    if (typeof port.onmessage !== "undefined" || typeof port.addEventListener === "function") {
      const handler = (ev) => {
        const msg = ev?.data ?? ev;
        this._handleMessage(msg);
      };
      if (typeof port.addEventListener === "function") {
        port.addEventListener("message", handler);
        if (typeof port.start === "function") port.start();
      } else {
        port.onmessage = handler;
      }
    }
  }

  _post(message) {
    if (!this.port || typeof this.port.postMessage !== "function") return;
    try {
      this.port.postMessage(message);
    } catch {
      /* ignore channel errors */
    }
  }

  _handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    switch (msg.type) {
      case "CONFIGURE_SPEED":
        this.settings = { ...this.settings, ...(msg.speed || {}) };
        break;
      case "SUBSCRIBE_BOOKS":
        for (const item of Array.isArray(msg.items) ? msg.items : []) {
          if (item?.venue && item?.symbol) {
            const key = `${String(item.venue).toLowerCase()}:${String(item.symbol).toUpperCase()}`;
            this.bookTargets.set(key, {
              venue: String(item.venue).toLowerCase(),
              symbol: String(item.symbol).toUpperCase(),
              priority: toNum(item.priority, 1),
            });
          }
        }
        break;
      case "UNSUBSCRIBE_BOOKS":
        for (const item of Array.isArray(msg.items) ? msg.items : []) {
          if (item?.venue && item?.symbol) {
            const key = `${String(item.venue).toLowerCase()}:${String(item.symbol).toUpperCase()}`;
            this.bookTargets.delete(key);
          }
        }
        break;
      case "FETCH_NOW":
        this.runTop100Lane().catch(() => {});
        break;
      default:
        break;
    }
  }

  /**
   * Ingest a batch of CoinGlass rows, compute diff against knownCoins, and emit MARKET_DIFF (FX-43).
   */
  ingestBatch(coins = [], meta = {}) {
    const tScrape = toNum(meta.startedAt, Date.now());
    const tDecrypt = Date.now();
    const diff = computeMarketDiff(this.knownCoins, coins);
    for (const c of diff.updated) {
      this.knownCoins.set(String(c.symbol).toUpperCase(), c);
    }
    if (diff.changedCount > 0 || meta.forceEmit) {
      this.stats.diffsEmitted++;
      this._post({
        type: "MARKET_DIFF",
        diff,
        lane: meta.lane || "top100",
        t_scrape: tScrape,
        t_decrypt: tDecrypt,
        fetchedInMs: toNum(meta.fetchedInMs, tDecrypt - tScrape),
      });
    }
    return diff;
  }

  async runTop100Lane() {
    if (!this.cgClient) return null;
    return this.laneGuard.run("top100", async () => {
      const startedAt = Date.now();
      this.stats.top100Runs++;
      const res = await this.cgClient.fetchMarkets();
      if (res && Array.isArray(res.coins)) {
        this.ingestBatch(res.coins, {
          lane: "top100",
          startedAt,
          fetchedInMs: res.fetchedInMs,
        });
      }
      return res;
    });
  }

  async runHotBookLane() {
    if (!this.hub || this.bookTargets.size === 0) return [];
    return this.laneGuard.run("hotBooks", async () => {
      this.stats.hotRuns++;
      const targets = [...this.bookTargets.values()].slice(0, this.settings.maxBookSubscriptions || 40);
      const updates = [];
      await Promise.allSettled(
        targets.map(async (t) => {
          const b = await this.hub.fetchBook({ venue: t.venue, venueSymbol: t.symbol }, { maxAgeMs: 600 });
          if (b) {
            this.stats.booksFetched++;
            updates.push(b);
          }
        })
      );
      if (updates.length > 0) {
        this._post({
          type: "BOOK_UPDATES",
          books: updates,
          ts: Date.now(),
        });
      }
      return updates;
    });
  }

  stop() {
    this.running = false;
    for (const id of this.timers) {
      clearInterval(id);
    }
    this.timers.clear();
  }
}

// If executed directly as a standalone Web Worker
if (
  typeof self !== "undefined" &&
  typeof self.postMessage === "function" &&
  typeof window === "undefined" &&
  self.name === "oi-sniper-data-worker"
) {
  const runtime = new DataWorkerRuntime({ port: self });
  self.onmessage = (e) => {
    if (e.data?.type === "ATTACH_PORT" && e.ports?.[0]) {
      runtime.attachPort(e.ports[0]);
    } else {
      runtime._handleMessage(e.data);
    }
  };
}
