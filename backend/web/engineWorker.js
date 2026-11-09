/**
 * Dedicated Engine Worker Runtime (Section 9.1 FX-60, Section 7.2 FX-45)
 *
 * Receives compact market diffs and L2 book updates from DataWorkerRuntime over MessageChannel,
 * updates the authoritative MarketStateStore, triggers event-driven incremental diff scans,
 * and coordinates EQE, SOR, Paper/Live Execution, and Protection Manager.
 */

import { applyMarketDiff, computeWatchlist } from "../src/core/speed.js";
import { toNum } from "../src/util.js";

export class EngineWorkerRuntime {
  constructor({ engine, port = null } = {}) {
    this.engine = engine;
    this.port = port;
    this.coinMap = new Map();
    this.hotSet = new Map();
    if (this.port) {
      this.attachPort(this.port);
    }
  }

  attachPort(port) {
    this.port = port;
    if (typeof port.onmessage !== "undefined" || typeof port.addEventListener === "function") {
      const handler = (ev) => {
        const msg = ev?.data ?? ev;
        this.handleDataMessage(msg);
      };
      if (typeof port.addEventListener === "function") {
        port.addEventListener("message", handler);
        if (typeof port.start === "function") port.start();
      } else {
        port.onmessage = handler;
      }
    }
  }

  handleDataMessage(msg) {
    if (!msg || typeof msg !== "object" || !this.engine) return;

    if (msg.type === "MARKET_DIFF" && msg.diff) {
      const tEvalStart = Date.now();
      applyMarketDiff(this.coinMap, msg.diff);
      const allCoins = [...this.coinMap.values()];

      if (this.engine.stateStore) {
        this.engine.stateStore.ingestSignals(msg.diff.updated || [], msg.diff.ts || tEvalStart);
      }

      this.engine.marketCache = {
        ...this.engine.marketCache,
        at: msg.diff.ts || tEvalStart,
        coins: allCoins,
        total: Math.max(toNum(msg.diff.totalCount, 0), allCoins.length),
        fetchedInMs: toNum(msg.fetchedInMs, 0),
        error: null,
      };

      // Update watchlist pre-warming (FX-44)
      if (this.engine.state?.settings?.speed?.prewarmBooks !== false) {
        const watchlist = computeWatchlist(allCoins, this.engine.state?.settings || {}, {
          hotSet: this.hotSet,
          nowMs: tEvalStart,
        });
        this.engine.watchlist = watchlist;
        if (this.port && typeof this.port.postMessage === "function") {
          const items = watchlist.slice(0, 15).map((w) => {
            const resolved = this.engine.hub?.resolve(w.symbol);
            return resolved
              ? { venue: resolved.venue, symbol: resolved.venueSymbol, priority: w.qualified ? 2 : 1 }
              : null;
          }).filter(Boolean);
          if (items.length > 0) {
            try {
              this.port.postMessage({ type: "SUBSCRIBE_BOOKS", items });
            } catch {
              /* ignore */
            }
          }
        }
      }

      const tEvalEnd = Date.now();
      if (this.engine.latencyTracker) {
        this.engine.latencyTracker.recordTrace({
          t_scrape: msg.t_scrape || tEvalStart,
          t_decrypt: msg.t_decrypt || tEvalStart,
          t_eval: tEvalEnd,
        });
      }

      // Event-driven incremental scan on changed rows when running (FX-45)
      if (
        this.engine.state?.meta?.running &&
        this.engine.state?.settings?.speed?.eventDrivenScan !== false &&
        Array.isArray(msg.diff.updated) &&
        msg.diff.updated.length > 0 &&
        !this.engine.scanning
      ) {
        this.engine.scan({ manual: false, changedOnly: msg.diff.updated }).catch(() => {});
      }
    } else if (msg.type === "BOOK_UPDATES" && Array.isArray(msg.books)) {
      for (const b of msg.books) {
        if (b && b.venue && b.venueSymbol && this.engine.stateStore) {
          this.engine.stateStore.updateBook(b.venue, b.venueSymbol, {
            bids: b.bids,
            asks: b.asks,
            ts: b.ts || Date.now(),
          });
        }
      }
    }
  }
}
