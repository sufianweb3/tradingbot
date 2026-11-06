/**
 * Authoritative Versioned Market State Store & Subscription Manager
 *
 * Implements Section 9.2 (FX-61) and Section 7.4 (FX-48, FX-49).
 */

import { toNum } from "../util.js";

export class MarketStateStore {
  constructor({ maxBookSubscriptions = 40, coalesceWindowMs = 250, maxBookSnapshots = 10 } = {}) {
    this.version = 0;
    this.maxBookSubscriptions = maxBookSubscriptions;
    this.coalesceWindowMs = coalesceWindowMs;
    this.maxBookSnapshots = maxBookSnapshots;

    this.books = new Map(); // `${venue}:${symbol}` -> { bids, asks, ts, version, seq }
    this.bookRings = new Map(); // `${venue}:${symbol}` -> Array<{ bids, asks, ts, seq }>
    this.quotes = new Map(); // `${venue}:${symbol}` -> { last, mark, index, bid, ask, ts, version }
    this.funding = new Map(); // `${venue}:${symbol}` -> { rate, nextFundingTs, ts, version }
    this.instruments = new Map(); // `${venue}:${symbol}` -> instrument spec
    this.signals = new Map(); // `${symbol}` -> { coin, version, ts, fingerprint }
    this.priceHistory = new Map(); // `${symbol}` -> Array<{ t, price }> (15m rolling)

    this.subscriptions = new Map(); // `${venue}:${symbol}` -> { venue, symbol, refs: Set<string>, priority: number, updatedAt: number }
    this._inFlight = new Map(); // key -> { promise, startedAt }
  }

  _key(venue, symbol) {
    return `${String(venue || "").toLowerCase()}:${String(symbol || "").toUpperCase()}`;
  }

  _bump() {
    this.version += 1;
    return this.version;
  }

  /**
   * Update order-book snapshot and maintain the ring buffer (last 10 snapshots).
   */
  updateBook(venue, symbol, { bids = [], asks = [], ts = Date.now(), seq = null } = {}) {
    const key = this._key(venue, symbol);
    const prev = this.books.get(key);

    // Sequence check for out-of-order frames (EC-40)
    if (prev && seq !== null && prev.seq !== null && seq < prev.seq) {
      return { updated: false, reason: "sequence-regression", prevSeq: prev.seq, seq };
    }

    const ver = this._bump();
    const snap = {
      venue: String(venue).toLowerCase(),
      symbol: String(symbol).toUpperCase(),
      bids,
      asks,
      ts,
      seq,
      version: ver,
    };
    this.books.set(key, snap);

    if (!this.bookRings.has(key)) {
      this.bookRings.set(key, []);
    }
    const ring = this.bookRings.get(key);
    ring.push({ bids, asks, ts, seq });
    if (ring.length > this.maxBookSnapshots) {
      ring.splice(0, ring.length - this.maxBookSnapshots);
    }

    const sub = this.subscriptions.get(key);
    if (sub) sub.updatedAt = ts;

    return { updated: true, version: ver, snapshot: snap };
  }

  getBook(venue, symbol) {
    return this.books.get(this._key(venue, symbol)) || null;
  }

  getBookSnapshots(venue, symbol) {
    return this.bookRings.get(this._key(venue, symbol)) || [];
  }

  updateQuote(venue, symbol, quote = {}) {
    const key = this._key(venue, symbol);
    const ver = this._bump();
    const ts = toNum(quote.ts, Date.now());
    const entry = {
      venue: String(venue).toLowerCase(),
      symbol: String(symbol).toUpperCase(),
      last: toNum(quote.last ?? quote.price, 0),
      mark: toNum(quote.mark ?? quote.markPrice ?? quote.price, 0),
      index: toNum(quote.index ?? quote.indexPrice, 0),
      bid: toNum(quote.bid, 0),
      ask: toNum(quote.ask, 0),
      ts,
      version: ver,
    };
    this.quotes.set(key, entry);

    const symKey = String(symbol).toUpperCase();
    const price = entry.mark || entry.last;
    if (price > 0) {
      this._recordPriceHistory(symKey, price, ts);
    }
    return entry;
  }

  getQuote(venue, symbol) {
    return this.quotes.get(this._key(venue, symbol)) || null;
  }

  updateFunding(venue, symbol, { rate = 0, nextFundingTs = null, ts = Date.now() } = {}) {
    const key = this._key(venue, symbol);
    const ver = this._bump();
    const entry = {
      venue: String(venue).toLowerCase(),
      symbol: String(symbol).toUpperCase(),
      rate: toNum(rate, 0),
      nextFundingTs: toNum(nextFundingTs, null),
      ts,
      version: ver,
    };
    this.funding.set(key, entry);
    return entry;
  }

  getFunding(venue, symbol) {
    return this.funding.get(this._key(venue, symbol)) || null;
  }

  setInstrument(venue, symbol, inst) {
    const key = this._key(venue, symbol);
    this.instruments.set(key, { ...inst, updatedAt: Date.now() });
  }

  getInstrument(venue, symbol) {
    return this.instruments.get(this._key(venue, symbol)) || null;
  }

  /**
   * Compute a compact fingerprint of a CoinGlass row's signal-relevant fields.
   */
  _fingerprintCoin(c) {
    const oi = c?.oi || {};
    const vol = c?.vol || {};
    const pc = c?.priceChange || {};
    return `${c?.price ?? ""}|${c?.oiUsd ?? ""}|${c?.volUsd24h ?? ""}|${oi["5m"] ?? ""}:${oi["15m"] ?? ""}:${oi["30m"] ?? ""}:${oi["1h"] ?? ""}:${oi["4h"] ?? ""}|${vol["1h"] ?? ""}:${vol["4h"] ?? ""}|${pc["5m"] ?? c?.priceChange5m ?? ""}:${pc["1h"] ?? c?.priceChange1h ?? ""}`;
  }

  /**
   * Ingest CoinGlass market rows and return only the symbols whose signal fields changed (FX-45).
   */
  ingestSignals(coins = [], ts = Date.now()) {
    const changedSymbols = [];
    const changedCoins = [];
    const ver = this._bump();

    for (const coin of Array.isArray(coins) ? coins : []) {
      const sym = String(coin?.symbol || "").toUpperCase().trim();
      if (!sym) continue;
      const fp = this._fingerprintCoin(coin);
      const prev = this.signals.get(sym);
      if (!prev || prev.fingerprint !== fp) {
        this.signals.set(sym, {
          coin: { ...coin, symbol: sym, fetchedAt: ts },
          fingerprint: fp,
          version: ver,
          ts,
        });
        changedSymbols.push(sym);
        changedCoins.push(coin);
      } else {
        prev.ts = ts;
      }
      if (coin.price > 0) {
        this._recordPriceHistory(sym, coin.price, ts);
      }
    }

    return {
      version: ver,
      total: this.signals.size,
      changedCount: changedSymbols.length,
      changedSymbols,
      changedCoins,
    };
  }

  getSignal(symbol) {
    return this.signals.get(String(symbol || "").toUpperCase())?.coin || null;
  }

  getAllSignals() {
    return [...this.signals.values()].map((s) => s.coin);
  }

  _recordPriceHistory(symbol, price, ts = Date.now()) {
    if (!this.priceHistory.has(symbol)) {
      this.priceHistory.set(symbol, []);
    }
    const list = this.priceHistory.get(symbol);
    list.push({ t: ts, price });
    const cutoff = ts - 15 * 60 * 1000;
    while (list.length > 0 && list[0].t < cutoff) {
      list.shift();
    }
  }

  /**
   * Request coalescing: duplicate book/ticker fetches for the same key within 250ms
   * share a single in-flight Promise (FX-61).
   */
  async coalesceFetch(key, fetcherFn, windowMs = this.coalesceWindowMs) {
    const nowMs = Date.now();
    const existing = this._inFlight.get(key);
    if (existing && nowMs - existing.startedAt <= windowMs) {
      return existing.promise;
    }

    const promise = Promise.resolve()
      .then(() => fetcherFn())
      .finally(() => {
        const cur = this._inFlight.get(key);
        if (cur && cur.promise === promise) {
          this._inFlight.delete(key);
        }
      });

    this._inFlight.set(key, { promise, startedAt: nowMs });
    return promise;
  }

  /**
   * Ref-counted L2 order-book subscription manager capped at maxBookSubscriptions (FX-48, FX-61).
   * Priority: 2 = open position (never evicted), 1 = watchlist candidate.
   */
  subscribeBook(venue, symbol, subscriberId = "default", priority = 1) {
    const key = this._key(venue, symbol);
    const existing = this.subscriptions.get(key);
    if (existing) {
      existing.refs.add(subscriberId);
      existing.priority = Math.max(existing.priority, priority);
      existing.updatedAt = Date.now();
      return { subscribed: true, key, evicted: null };
    }

    let evicted = null;
    if (this.subscriptions.size >= this.maxBookSubscriptions) {
      // Evict oldest priority-1 subscription; never evict priority-2 (open positions)
      let victimKey = null;
      let oldestTs = Infinity;
      for (const [k, sub] of this.subscriptions.entries()) {
        if (sub.priority < 2 && sub.updatedAt < oldestTs) {
          oldestTs = sub.updatedAt;
          victimKey = k;
        }
      }
      if (victimKey) {
        this.subscriptions.delete(victimKey);
        evicted = victimKey;
      } else if (priority < 2) {
        return { subscribed: false, reason: "subscription-cap-reached", key, evicted: null };
      }
    }

    this.subscriptions.set(key, {
      venue: String(venue).toLowerCase(),
      symbol: String(symbol).toUpperCase(),
      refs: new Set([subscriberId]),
      priority,
      updatedAt: Date.now(),
    });

    return { subscribed: true, key, evicted };
  }

  unsubscribeBook(venue, symbol, subscriberId = "default") {
    const key = this._key(venue, symbol);
    const sub = this.subscriptions.get(key);
    if (!sub) return false;
    sub.refs.delete(subscriberId);
    if (sub.refs.size === 0) {
      this.subscriptions.delete(key);
      return true;
    }
    return false;
  }

  listBookSubscriptions() {
    return [...this.subscriptions.values()].map((s) => ({
      venue: s.venue,
      symbol: s.symbol,
      refCount: s.refs.size,
      priority: s.priority,
      updatedAt: s.updatedAt,
    }));
  }
}
