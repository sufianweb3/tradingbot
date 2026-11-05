/**
 * Binance USDT-M Futures Adapter (PRD 5.6, 6.3)
 *
 * Implements ExchangeAdapter for Binance Futures (fapi.binance.com).
 * Enforces one-way mode, clock sync, and rejects withdrawal permissions.
 */

import { signBinanceRequest, syncTime } from "../signers.js";
import { ExchangeAdapter } from "./interface.js";

const DEFAULT_BASE_URL = "https://fapi.binance.com";
const TESTNET_BASE_URL = "https://testnet.binancefuture.com";

export class BinanceAdapter extends ExchangeAdapter {
  constructor({ apiKey = "", secret = "", testnet = false, fetchFn = null } = {}) {
    super({ apiKey, secret, testnet, fetchFn });
    this.id = "binance";
    this.name = "Binance USDT-M Futures";
    this.baseUrl = testnet ? TESTNET_BASE_URL : DEFAULT_BASE_URL;
  }

  capabilities() {
    return { trading: true };
  }

  /**
   * Internal signed request dispatcher.
   */
  async _request(endpoint, { method = "GET", params = {}, body = null } = {}) {
    const isPostOrDelete = method === "POST" || method === "DELETE" || method === "PUT";
    const signed = await signBinanceRequest({
      apiKey: this.apiKey,
      secret: this.secret,
      params,
    });

    let url = `${this.baseUrl}${endpoint}`;
    let reqInit = {
      method,
      headers: signed.headers,
    };

    if (isPostOrDelete) {
      if (body) {
        reqInit.body = signed.fullQueryString;
      } else {
        url = `${url}?${signed.fullQueryString}`;
      }
    } else {
      url = `${url}?${signed.fullQueryString}`;
    }

    const res = await this.fetch(url, reqInit);
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Binance HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    if (!res.ok || (json && json.code && json.code < 0)) {
      const msg = json?.msg || `Binance API error (code: ${json?.code || res.status})`;
      const err = new Error(msg);
      err.code = json?.code;
      err.status = res.status;
      throw err;
    }

    return json;
  }

  /**
   * Public server time check & drift sync.
   */
  async syncServerTime() {
    return syncTime("binance", async () => {
      const res = await this.fetch(`${this.baseUrl}/fapi/v1/time`);
      const data = await res.json();
      return Number(data.serverTime);
    });
  }

  /**
   * Validate credentials and inspect permissions (PRD 5.6 E3).
   * MUST reject credentials if withdrawal permissions are enabled!
   */
  async validateKey(creds = {}) {
    const testApiKey = creds.apiKey || this.apiKey;
    const testSecret = creds.secret || this.secret;

    if (!testApiKey || !testSecret) {
      return { ok: false, canTrade: false, canWithdraw: false, error: "Missing API key or secret." };
    }

    const probe = new BinanceAdapter({
      apiKey: testApiKey,
      secret: testSecret,
      testnet: this.testnet,
      fetchFn: this.fetch,
    });

    try {
      await probe.syncServerTime();
      const account = await probe._request("/fapi/v2/account");

      // Check withdrawal permissions (PRD E3)
      const canWithdraw = Boolean(
        account.canWithdraw === true ||
        account.enableWithdrawals === true ||
        account.withdraw === true
      );

      if (canWithdraw) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: true,
          error: "API key has withdrawal permissions enabled. For safety, delete this key and create one with Trading only.",
        };
      }

      // Check trading permissions
      const canTrade = Boolean(account.canTrade === true);
      if (!canTrade) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: false,
          error: "API key does not have Futures Trading permissions enabled on Binance.",
        };
      }

      return {
        ok: true,
        canTrade: true,
        canWithdraw: false,
      };
    } catch (err) {
      return {
        ok: false,
        canTrade: false,
        canWithdraw: false,
        error: err.message || "Failed to validate Binance credentials.",
      };
    }
  }

  /**
   * Get USDT balance and total margin equity.
   */
  async getBalance() {
    const data = await this._request("/fapi/v2/balance");
    const usdt = Array.isArray(data) ? data.find((a) => a.asset === "USDT") : null;

    if (!usdt) {
      return { availableUsdt: 0, equityUsdt: 0, walletUsdt: 0 };
    }

    return {
      availableUsdt: Number(usdt.withdrawAvailable || usdt.availableBalance || 0),
      equityUsdt: Number(usdt.balance || usdt.crossWalletBalance || 0),
      walletUsdt: Number(usdt.balance || 0),
    };
  }

  /**
   * Get linear instrument rules and lot sizing.
   */
  async getInstruments() {
    const res = await this.fetch(`${this.baseUrl}/fapi/v1/exchangeInfo`);
    const data = await res.json();
    const symbols = Array.isArray(data.symbols) ? data.symbols : [];

    const instruments = [];
    for (const s of symbols) {
      if (s.contractType !== "PERPETUAL" || s.status !== "TRADING" || s.quoteAsset !== "USDT") {
        continue;
      }

      let tickSize = 0.01;
      let lotSize = 1;
      let minQty = 1;
      let minNotional = 5;

      for (const f of s.filters || []) {
        if (f.filterType === "PRICE_FILTER") {
          tickSize = Number(f.tickSize) || tickSize;
        } else if (f.filterType === "LOT_SIZE") {
          lotSize = Number(f.stepSize) || lotSize;
          minQty = Number(f.minQty) || minQty;
        } else if (f.filterType === "MIN_NOTIONAL") {
          minNotional = Number(f.notional) || minNotional;
        }
      }

      instruments.push({
        symbol: s.symbol,
        baseCoin: s.baseAsset,
        quoteCoin: s.quoteAsset,
        tickSize,
        lotSize,
        minQty,
        minNotional,
        maxLeverage: 125, // Binance standard default, refined per-pair
      });
    }

    return instruments;
  }

  /**
   * Ensure One-Way position mode is active.
   */
  async ensureAccountMode() {
    try {
      const mode = await this._request("/fapi/v1/positionSide/dual");
      if (mode.dualSidePosition === true) {
        // Switch to One-Way mode
        await this._request("/fapi/v1/positionSide/dual", {
          method: "POST",
          params: { dualSidePosition: "false" },
        });
      }
      return { oneWay: true, isolated: true };
    } catch (err) {
      if (err.code === -4059) {
        // No need to change position side
        return { oneWay: true, isolated: true };
      }
      throw err;
    }
  }

  /**
   * Set leverage for a symbol.
   */
  async setLeverage(symbol, leverage) {
    await this._request("/fapi/v1/leverage", {
      method: "POST",
      params: {
        symbol: symbol.toUpperCase(),
        leverage: Math.round(Number(leverage)),
      },
    });
  }

  /**
   * Place an immediate market order.
   */
  async placeMarket({ symbol, side, qty, clientId, reduceOnly = false }) {
    const binanceSide = side.toLowerCase() === "long" ? "BUY" : "SELL";
    const params = {
      symbol: symbol.toUpperCase(),
      side: binanceSide,
      type: "MARKET",
      quantity: qty,
      newClientOrderId: clientId,
    };
    if (reduceOnly) {
      params.reduceOnly = "true";
    }

    const order = await this._request("/fapi/v1/order", {
      method: "POST",
      params,
    });

    const avgPrice = Number(order.avgPrice) || Number(order.price) || 0;
    const executedQty = Number(order.executedQty) || Number(qty);

    return {
      id: String(order.orderId),
      orderId: String(order.orderId),
      clientId: order.clientOrderId || clientId,
      symbol: order.symbol,
      side: side.toLowerCase(),
      price: avgPrice,
      qty: executedQty,
      notional: avgPrice * executedQty,
      fee: 0,
      feeAsset: "USDT",
      time: order.updateTime || Date.now(),
    };
  }

  /**
   * Place an exchange-side stop loss order (STOP_MARKET).
   */
  async placeStop({ symbol, side, qty, triggerPrice, clientId, closePosition = false }) {
    // For a long position, stop order sells; for a short position, stop order buys
    const stopSide = side.toLowerCase() === "long" ? "SELL" : "BUY";
    const params = {
      symbol: symbol.toUpperCase(),
      side: stopSide,
      type: "STOP_MARKET",
      stopPrice: triggerPrice,
      newClientOrderId: clientId,
    };

    if (closePosition) {
      params.closePosition = "true";
    } else {
      params.quantity = qty;
      params.reduceOnly = "true";
    }

    const order = await this._request("/fapi/v1/order", {
      method: "POST",
      params,
    });

    return {
      id: String(order.orderId),
      orderId: String(order.orderId),
      clientId: order.clientOrderId || clientId,
      symbol: order.symbol,
      side: side.toLowerCase(),
      triggerPrice: Number(order.stopPrice || triggerPrice),
      status: order.status || "NEW",
    };
  }

  /**
   * Place a reduce-only limit order (for TP1).
   */
  async placeReduceLimit({ symbol, side, qty, price, clientId }) {
    const limitSide = side.toLowerCase() === "long" ? "SELL" : "BUY";
    const params = {
      symbol: symbol.toUpperCase(),
      side: limitSide,
      type: "LIMIT",
      timeInForce: "GTC",
      reduceOnly: "true",
      price,
      quantity: qty,
      newClientOrderId: clientId,
    };

    const order = await this._request("/fapi/v1/order", {
      method: "POST",
      params,
    });

    return {
      id: String(order.orderId),
      orderId: String(order.orderId),
      clientId: order.clientOrderId || clientId,
      symbol: order.symbol,
      side: side.toLowerCase(),
      price: Number(order.price || price),
      qty: Number(order.origQty || qty),
      status: order.status || "NEW",
    };
  }

  /**
   * Amend/move an active stop loss order trigger price (cancel + replace).
   */
  async amendStop(ref, triggerPrice) {
    if (!ref.symbol) throw new Error("amendStop requires symbol.");
    try {
      await this.cancel(ref);
    } catch {
      /* ignore cancel failure if already triggered or absent */
    }

    return this.placeStop({
      symbol: ref.symbol,
      side: ref.side || "long",
      qty: ref.qty,
      triggerPrice,
      clientId: `trail_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      closePosition: ref.closePosition !== false,
    });
  }

  /**
   * Cancel an open order by orderId or origClientOrderId.
   */
  async cancel(ref) {
    const params = { symbol: ref.symbol.toUpperCase() };
    if (ref.orderId) {
      params.orderId = ref.orderId;
    } else if (ref.clientId) {
      params.origClientOrderId = ref.clientId;
    } else {
      throw new Error("cancel requires orderId or clientId.");
    }

    await this._request("/fapi/v1/order", {
      method: "DELETE",
      params,
    });
  }

  /**
   * Cancel all open orders for a symbol.
   */
  async cancelAll(symbol) {
    await this._request("/fapi/v1/allOpenOrders", {
      method: "DELETE",
      params: { symbol: symbol.toUpperCase() },
    });
  }

  /**
   * Get active positions.
   */
  async getPositions() {
    const data = await this._request("/fapi/v2/positionRisk");
    const active = [];

    for (const r of data || []) {
      const amt = Number(r.positionAmt);
      if (Math.abs(amt) > 0) {
        active.push({
          symbol: r.symbol,
          side: amt > 0 ? "long" : "short",
          size: Math.abs(amt),
          entryPrice: Number(r.entryPrice) || 0,
          markPrice: Number(r.markPrice) || 0,
          leverage: Number(r.leverage) || 1,
          unrealizedPnl: Number(r.unRealizedProfit) || 0,
          liqPrice: Number(r.liquidationPrice) || 0,
        });
      }
    }

    return active;
  }

  /**
   * Get open orders for a symbol.
   */
  async getOpenOrders(symbol = null) {
    const params = symbol ? { symbol: symbol.toUpperCase() } : {};
    return this._request("/fapi/v1/openOrders", { params });
  }

  /**
   * Get fills / trades for an order.
   */
  async getFills(orderRef) {
    const params = { symbol: orderRef.symbol.toUpperCase() };
    if (orderRef.orderId) params.orderId = orderRef.orderId;
    const trades = await this._request("/fapi/v1/userTrades", { params });
    return (trades || []).map((t) => ({
      id: String(t.id),
      orderId: String(t.orderId),
      price: Number(t.price),
      qty: Number(t.qty),
      fee: Number(t.commission),
      feeAsset: t.commissionAsset,
      time: t.time,
    }));
  }

  /**
   * Close a position with an immediate market order.
   */
  async closePosition(symbol, qty = null) {
    const positions = await this.getPositions();
    const pos = positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());
    if (!pos) {
      throw new Error(`No active Binance position found for ${symbol}`);
    }

    const closeQty = qty !== null ? qty : pos.size;
    const closeSide = pos.side === "long" ? "short" : "long";

    return this.placeMarket({
      symbol,
      side: closeSide,
      qty: closeQty,
      clientId: `close_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      reduceOnly: true,
    });
  }
}
