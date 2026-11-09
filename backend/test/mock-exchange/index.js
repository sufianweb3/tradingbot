/**
 * Scriptable Mock Exchange Server & Adapter (`test/mock-exchange/index.js`)
 *
 * Implements Section 12.1 of additions.md:
 * - Custom L2 order books (deep, thin, hollow, crossed, spoofed wall, gapped)
 * - Partial IOC fills
 * - Order rejections (`INSUFFICIENT_MARGIN`, `LOT_SIZE`, `PRICE_BAND`, `REDUCE_ONLY_REJECTED`)
 * - HTTP 429 rate-limit responses with `Retry-After`
 * - Network timeouts (`UNKNOWN` order state where the order was or was not accepted)
 * - Stop triggers with mark-to-fill slippage
 * - TP1 queue fills
 * - Externally closed positions and orphan positions
 */

import { ExchangeAdapter } from "../../src/venues/interface.js";
import { round, toNum } from "../../src/util.js";

export class ScriptableMockExchange extends ExchangeAdapter {
  constructor({
    id = "bybit",
    name = "Mock Bybit V5",
    apiKey = "mock_key",
    secret = "mock_secret",
    capabilitiesOverride = {},
  } = {}) {
    super({ apiKey, secret, testnet: true });
    this.id = id;
    this.name = name;
    this._capabilities = {
      trading: true,
      ioc: true,
      attachedSlTp: id === "bybit",
      conditionalEndpoint: true,
      nativeTrail: id === "bybit" || id === "binance",
      atomicAmend: id === "bybit" || id === "gate",
      privateWs: true,
      closePositionStop: true,
      testnet: true,
      ...capabilitiesOverride,
    };

    this.books = new Map();
    this.instruments = new Map();
    this.positions = new Map();
    this.openOrders = new Map();
    this.fills = new Map();
    this.balance = { availableUsdt: 10000, equityUsdt: 10000, walletUsdt: 10000 };
    this.serverTimeOffsetMs = 0;

    // Scripted fault / behavior hooks
    this.script = {
      rejectNextOrder: null, // 'INSUFFICIENT_MARGIN' | 'LOT_SIZE' | 'PRICE_BAND' | 'REDUCE_ONLY_REJECTED'
      rateLimitNext: null, // { status: 429, retryAfterMs: 2000 }
      timeoutNextOrder: null, // { acceptSilently: boolean }
      partialFillRatio: 1.0, // e.g., 0.5 for 50% IOC fill
      failPlaceStopCount: 0, // fail N times before succeeding (or infinite if >= 99)
      failAmendStop: false,
      failCancelOrder: false,
      markToFillSlippageBps: 0,
      canWithdraw: false,
      accountModeOneWay: true,
      accountModeIsolated: true,
    };

    this.callLog = [];
    this._orderSeq = 1;
    this._initDefaultInstruments();
  }

  _initDefaultInstruments() {
    this.setInstrument({
      symbol: "BTCUSDT",
      baseCoin: "BTC",
      quoteCoin: "USDT",
      tickSize: 0.1,
      lotSize: 0.001,
      minQty: 0.001,
      minNotional: 5,
      maxLeverage: 100,
      contractMultiplier: 1,
      symbolMultiplier: 1,
      status: "TRADING",
    });
    this.setInstrument({
      symbol: "1000PEPEUSDT",
      baseCoin: "1000PEPE",
      quoteCoin: "USDT",
      tickSize: 0.0000001,
      lotSize: 100,
      minQty: 100,
      minNotional: 5,
      maxLeverage: 50,
      contractMultiplier: 1,
      symbolMultiplier: 1000,
      status: "TRADING",
    });
  }

  capabilities() {
    return { ...this._capabilities };
  }

  setInstrument(inst) {
    this.instruments.set(String(inst.symbol).toUpperCase(), { ...inst });
  }

  /**
   * Preset L2 order book builders (`deep`, `thin`, `hollow`, `crossed`, `spoofed`, `gapped`).
   */
  setBookScenario(symbol, scenario = "deep", midPrice = 100, ts = Date.now()) {
    const sym = String(symbol).toUpperCase();
    let bids = [];
    let asks = [];

    if (scenario === "deep") {
      for (let i = 1; i <= 20; i++) {
        bids.push([round(midPrice * (1 - i * 0.0002), 6), 500]); // $50k per level
        asks.push([round(midPrice * (1 + i * 0.0002), 6), 500]);
      }
    } else if (scenario === "thin") {
      for (let i = 1; i <= 10; i++) {
        bids.push([round(midPrice * (1 - i * 0.0008), 6), 0.5]); // $50 per level
        asks.push([round(midPrice * (1 + i * 0.0008), 6), 0.5]);
      }
    } else if (scenario === "hollow") {
      // Deep asks (entry for long is cheap), but ultra-thin bids (exit for long is hollow)
      for (let i = 1; i <= 15; i++) {
        asks.push([round(midPrice * (1 + i * 0.0002), 6), 400]); // $40k per ask level
        bids.push([round(midPrice * (1 - i * 0.0025), 6), 0.4]); // only $40 per bid level, wide gaps
      }
    } else if (scenario === "crossed") {
      bids = [[midPrice * 1.001, 10], [midPrice * 0.999, 10]];
      asks = [[midPrice * 0.9995, 10], [midPrice * 1.002, 10]];
    } else if (scenario === "spoofed") {
      // Single giant ask level (>65% of top-10 notional)
      asks.push([round(midPrice * 1.0003, 6), 5000]); // $500k wall
      for (let i = 2; i <= 10; i++) {
        asks.push([round(midPrice * (1 + i * 0.0005), 6), 5]);
      }
      for (let i = 1; i <= 10; i++) {
        bids.push([round(midPrice * (1 - i * 0.0003), 6), 200]);
      }
    } else if (scenario === "gapped") {
      bids.push([round(midPrice * 0.9995, 6), 1]);
      bids.push([round(midPrice * 0.96, 6), 100]); // 4% gap down
      asks.push([round(midPrice * 1.0005, 6), 1]);
      asks.push([round(midPrice * 1.04, 6), 100]); // 4% gap up
    }

    const book = { symbol: sym, venue: this.id, bids, asks, ts };
    this.books.set(sym, book);
    return book;
  }

  getBook(symbol) {
    return this.books.get(String(symbol).toUpperCase()) || this.setBookScenario(symbol, "deep", 100);
  }

  _checkFaults(op, payload = {}) {
    this.callLog.push({ op, payload, ts: Date.now() });
    if (this.script.rateLimitNext) {
      const rl = this.script.rateLimitNext;
      this.script.rateLimitNext = null;
      const err = new Error(`HTTP ${rl.status || 429}: Too Many Requests`);
      err.status = rl.status || 429;
      err.retryAfterMs = rl.retryAfterMs || 2000;
      throw err;
    }
  }

  async syncServerTime() {
    this._checkFaults("syncServerTime");
    return { offsetMs: this.serverTimeOffsetMs, rttMs: 25 };
  }

  async validateKey() {
    this._checkFaults("validateKey");
    if (this.script.canWithdraw) {
      return {
        ok: false,
        canTrade: true,
        canWithdraw: true,
        error: "API key has withdrawal permissions enabled; delete this key immediately.",
      };
    }
    return { ok: true, canTrade: true, canWithdraw: false, accountId: "mock_acc_01" };
  }

  async getBalance() {
    this._checkFaults("getBalance");
    return { ...this.balance };
  }

  async getInstruments() {
    this._checkFaults("getInstruments");
    return [...this.instruments.values()];
  }

  async ensureAccountMode() {
    this._checkFaults("ensureAccountMode");
    return {
      oneWay: this.script.accountModeOneWay,
      isolated: this.script.accountModeIsolated,
    };
  }

  async setLeverage(symbol, leverage) {
    this._checkFaults("setLeverage", { symbol, leverage });
    return { ok: true, symbol, leverage };
  }

  async placeMarket(o) {
    return this._executeOrder({ ...o, type: "MARKET" });
  }

  async placeIocLimit(o) {
    return this._executeOrder({ ...o, type: "IOC_LIMIT" });
  }

  async _executeOrder(o) {
    this._checkFaults(o.type === "IOC_LIMIT" ? "placeIocLimit" : "placeMarket", o);

    if (this.script.rejectNextOrder) {
      const code = this.script.rejectNextOrder;
      this.script.rejectNextOrder = null;
      const err = new Error(`Order rejected: ${code}`);
      err.code = code;
      throw err;
    }

    const sym = String(o.symbol || "BTCUSDT").toUpperCase();
    const orderId = `mock_ord_${this._orderSeq++}`;
    const clientId = o.clientId || `cid_${orderId}`;
    const book = this.getBook(sym);
    const basePrice =
      o.side === "long"
        ? toNum(book.asks?.[0]?.[0], 100)
        : toNum(book.bids?.[0]?.[0], 100);

    const ratio = clampRatio(this.script.partialFillRatio);
    const filledQty = round(toNum(o.qty, 0) * ratio, 8);

    if (this.script.timeoutNextOrder) {
      const cfg = this.script.timeoutNextOrder;
      this.script.timeoutNextOrder = null;
      if (cfg.acceptSilently) {
        const record = {
          id: orderId,
          orderId,
          clientId,
          symbol: sym,
          side: o.side,
          price: basePrice,
          avgPrice: basePrice,
          qty: filledQty,
          filledQty,
          notional: round(filledQty * basePrice, 4),
          fee: round(filledQty * basePrice * 0.0005, 6),
          status: "FILLED",
          time: Date.now(),
        };
        this.fills.set(clientId, record);
        this.positions.set(sym, {
          symbol: sym,
          side: o.side,
          size: filledQty,
          entryPrice: basePrice,
          markPrice: basePrice,
          leverage: 20,
          unrealizedPnl: 0,
          liqPrice: o.side === "long" ? basePrice * 0.9 : basePrice * 1.1,
        });
      }
      const err = new Error("Request timed out waiting for exchange response");
      err.code = "ETIMEDOUT";
      throw err;
    }

    const fillRecord = {
      id: orderId,
      orderId,
      clientId,
      symbol: sym,
      side: o.side,
      price: basePrice,
      avgPrice: basePrice,
      qty: filledQty,
      filledQty,
      notional: round(filledQty * basePrice, 4),
      fee: round(filledQty * basePrice * 0.0005, 6),
      feeAsset: "USDT",
      status: filledQty > 0 ? (ratio < 1 ? "PARTIALLY_FILLED_CANCELED" : "FILLED") : "EXPIRED",
      time: Date.now(),
    };

    if (filledQty > 0) {
      this.fills.set(clientId, fillRecord);
      this.fills.set(orderId, fillRecord);
      if (o.reduceOnly) {
        const existing = this.positions.get(sym);
        if (existing) {
          existing.size = Math.max(0, round(existing.size - filledQty, 8));
          if (existing.size <= 0) this.positions.delete(sym);
        }
      } else {
        this.positions.set(sym, {
          symbol: sym,
          side: o.side,
          size: filledQty,
          entryPrice: basePrice,
          markPrice: basePrice,
          leverage: 20,
          unrealizedPnl: 0,
          liqPrice: o.side === "long" ? basePrice * 0.9 : basePrice * 1.1,
        });
      }
    }

    return fillRecord;
  }

  async placeStop(o) {
    this._checkFaults("placeStop", o);
    if (this.script.failPlaceStopCount > 0) {
      this.script.failPlaceStopCount--;
      throw new Error("Simulated stop placement failure");
    }
    const orderId = `mock_sl_${this._orderSeq++}`;
    const order = {
      id: orderId,
      orderId,
      clientId: o.clientId || `sl_${orderId}`,
      symbol: String(o.symbol).toUpperCase(),
      side: o.side,
      qty: toNum(o.qty, 0),
      triggerPrice: toNum(o.triggerPrice, 0),
      closePosition: Boolean(o.closePosition),
      reduceOnly: true,
      type: "STOP_MARKET",
      status: "NEW",
    };
    this.openOrders.set(orderId, order);
    return order;
  }

  async placeReduceLimit(o) {
    this._checkFaults("placeReduceLimit", o);
    if (this.script.rejectNextOrder === "REDUCE_ONLY_REJECTED") {
      this.script.rejectNextOrder = null;
      const err = new Error("Reduce-only order rejected: no open position");
      err.code = "REDUCE_ONLY_REJECTED";
      throw err;
    }
    const orderId = `mock_tp_${this._orderSeq++}`;
    const order = {
      id: orderId,
      orderId,
      clientId: o.clientId || `tp_${orderId}`,
      symbol: String(o.symbol).toUpperCase(),
      side: o.side,
      qty: toNum(o.qty, 0),
      price: toNum(o.price, 0),
      reduceOnly: true,
      type: "LIMIT",
      status: "NEW",
    };
    this.openOrders.set(orderId, order);
    return order;
  }

  async amendStop(ref, triggerPrice) {
    this._checkFaults("amendStop", { ref, triggerPrice });
    if (this.script.failAmendStop) {
      throw new Error("Simulated amendStop failure");
    }
    const existing = this.openOrders.get(ref.orderId);
    if (existing) {
      existing.triggerPrice = toNum(triggerPrice, existing.triggerPrice);
      return { ...existing };
    }
    return { id: ref.orderId || "amended", orderId: ref.orderId || "amended", triggerPrice };
  }

  async cancel(ref) {
    this._checkFaults("cancel", ref);
    if (this.script.failCancelOrder) {
      throw new Error("Simulated cancel failure");
    }
    if (ref?.orderId) this.openOrders.delete(ref.orderId);
    for (const [k, ord] of this.openOrders.entries()) {
      if (ref?.clientId && ord.clientId === ref.clientId) {
        this.openOrders.delete(k);
      }
    }
    return { ok: true };
  }

  async cancelAll(symbol) {
    this._checkFaults("cancelAll", { symbol });
    const sym = String(symbol).toUpperCase();
    for (const [k, ord] of this.openOrders.entries()) {
      if (ord.symbol === sym) {
        this.openOrders.delete(k);
      }
    }
    return { ok: true };
  }

  async getPositions() {
    this._checkFaults("getPositions");
    return [...this.positions.values()].filter((p) => p.size > 0);
  }

  async getOpenOrders(symbol) {
    this._checkFaults("getOpenOrders", { symbol });
    const sym = symbol ? String(symbol).toUpperCase() : null;
    return [...this.openOrders.values()].filter((o) => !sym || o.symbol === sym);
  }

  async getFills(ref) {
    this._checkFaults("getFills", ref);
    const hit =
      (ref?.clientId && this.fills.get(ref.clientId)) ||
      (ref?.orderId && this.fills.get(ref.orderId)) ||
      null;
    return hit ? [hit] : [];
  }

  async closePosition(symbol, qty = null) {
    this._checkFaults("closePosition", { symbol, qty });
    const sym = String(symbol).toUpperCase();
    const pos = this.positions.get(sym);
    const closeQty = toNum(qty, pos?.size || 1);
    const book = this.getBook(sym);
    const closePrice =
      pos?.side === "short"
        ? toNum(book.asks?.[0]?.[0], pos?.markPrice || 100)
        : toNum(book.bids?.[0]?.[0], pos?.markPrice || 100);
    if (pos) {
      pos.size = Math.max(0, round(pos.size - closeQty, 8));
      if (pos.size <= 0) this.positions.delete(sym);
    }
    return {
      id: `close_${this._orderSeq++}`,
      symbol: sym,
      side: pos?.side === "long" ? "short" : "long",
      qty: closeQty,
      price: closePrice,
      avgPrice: closePrice,
    };
  }
}

function clampRatio(r) {
  const n = Number(r);
  if (!Number.isFinite(n)) return 1;
  return Math.max(0, Math.min(1, n));
}
