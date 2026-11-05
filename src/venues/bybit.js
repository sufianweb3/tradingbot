/**
 * Bybit V5 Linear Futures Adapter (PRD 5.6, 6.3)
 *
 * Implements ExchangeAdapter for Bybit V5 (api.bybit.com).
 * Enforces one-way mode, clock sync, attached stops, and rejects withdrawal permissions.
 */

import { signBybitRequest, syncTime } from "../signers.js";
import { ExchangeAdapter } from "./interface.js";

const DEFAULT_BASE_URL = "https://api.bybit.com";
const TESTNET_BASE_URL = "https://api-testnet.bybit.com";

export class BybitAdapter extends ExchangeAdapter {
  constructor({ apiKey = "", secret = "", testnet = false, fetchFn = null } = {}) {
    super({ apiKey, secret, testnet, fetchFn });
    this.id = "bybit";
    this.name = "Bybit V5 Linear";
    this.baseUrl = testnet ? TESTNET_BASE_URL : DEFAULT_BASE_URL;
  }

  capabilities() {
    return { trading: true };
  }

  /**
   * Internal signed request dispatcher for Bybit V5.
   */
  async _request(endpoint, { method = "GET", params = {}, body = null } = {}) {
    const isGet = method.toUpperCase() === "GET";
    const signed = await signBybitRequest({
      apiKey: this.apiKey,
      secret: this.secret,
      params: isGet ? params : {},
      body: isGet ? null : (body || params),
      method,
    });

    let url = `${this.baseUrl}${endpoint}`;
    if (isGet && signed.queryString) {
      url = `${url}?${signed.queryString}`;
    }

    const reqInit = {
      method,
      headers: signed.headers,
    };

    if (!isGet) {
      reqInit.body = signed.bodyStr;
    }

    const res = await this.fetch(url, reqInit);
    const text = await res.text();

    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Bybit HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    if (!res.ok || (json && json.retCode !== 0)) {
      const msg = json?.retMsg || `Bybit API error (code: ${json?.retCode || res.status})`;
      const err = new Error(msg);
      err.code = json?.retCode;
      err.status = res.status;
      throw err;
    }

    return json.result;
  }

  /**
   * Public server time check & drift sync.
   */
  async syncServerTime() {
    return syncTime("bybit", async () => {
      const res = await this.fetch(`${this.baseUrl}/v5/market/time`);
      const data = await res.json();
      return Number(data.result?.timeNano ? Math.floor(Number(data.result.timeNano) / 1e6) : data.time);
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

    const probe = new BybitAdapter({
      apiKey: testApiKey,
      secret: testSecret,
      testnet: this.testnet,
      fetchFn: this.fetch,
    });

    try {
      await probe.syncServerTime();
      const info = await probe._request("/v5/user/query-api");

      const perms = info?.permissions || {};
      const rawPerms = JSON.stringify(perms).toLowerCase();

      // Check withdrawal permissions (PRD E3)
      const hasWithdrawal = Boolean(
        (Array.isArray(perms.Withdrawal) && perms.Withdrawal.length > 0) ||
        (Array.isArray(perms.Wallet) && perms.Wallet.some((w) => String(w).toLowerCase().includes("withdraw"))) ||
        info?.canWithdraw === true
      );

      if (hasWithdrawal) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: true,
          error: "API key has withdrawal permissions enabled. For safety, delete this key and create one with Trading only.",
        };
      }

      // Check trading permissions
      const hasContractTrade = Boolean(
        perms.ContractTrade?.length > 0 ||
        perms.Order?.includes("CreateOrder") ||
        rawPerms.includes("contracttrade") ||
        rawPerms.includes("order")
      );

      if (!hasContractTrade) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: false,
          error: "API key does not have Linear/Futures trading permission enabled on Bybit.",
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
        error: err.message || "Failed to validate Bybit credentials.",
      };
    }
  }

  /**
   * Get USDT balance and total margin equity.
   */
  async getBalance() {
    let result = null;
    try {
      result = await this._request("/v5/account/wallet-balance", {
        params: { accountType: "UNIFIED" },
      });
    } catch {
      result = await this._request("/v5/account/wallet-balance", {
        params: { accountType: "CONTRACT" },
      });
    }

    const accountList = result?.list || [];
    const account = accountList[0];
    if (!account) {
      return { availableUsdt: 0, equityUsdt: 0, walletUsdt: 0 };
    }

    const coins = account.coin || [];
    const usdt = coins.find((c) => c.coin === "USDT");

    if (!usdt) {
      return {
        availableUsdt: Number(account.totalAvailableBalance || 0),
        equityUsdt: Number(account.totalEquity || 0),
        walletUsdt: Number(account.totalWalletBalance || 0),
      };
    }

    return {
      availableUsdt: Number(usdt.availableToWithdraw || usdt.availableBalance || account.totalAvailableBalance || 0),
      equityUsdt: Number(usdt.equity || account.totalEquity || 0),
      walletUsdt: Number(usdt.walletBalance || account.totalWalletBalance || 0),
    };
  }

  /**
   * Get linear instrument rules and lot sizing.
   */
  async getInstruments() {
    const res = await this.fetch(`${this.baseUrl}/v5/market/instruments-info?category=linear`);
    const data = await res.json();
    const list = data?.result?.list || [];

    const instruments = [];
    for (const item of list) {
      if (item.status !== "Trading" || item.quoteCoin !== "USDT") {
        continue;
      }

      instruments.push({
        symbol: item.symbol,
        baseCoin: item.baseCoin,
        quoteCoin: item.quoteCoin,
        tickSize: Number(item.priceFilter?.tickSize) || 0.01,
        lotSize: Number(item.lotSizeFilter?.qtyStep) || 1,
        minQty: Number(item.lotSizeFilter?.minOrderQty) || 1,
        minNotional: Number(item.lotSizeFilter?.minNotionalValue) || 5,
        maxLeverage: Number(item.leverageFilter?.maxLeverage) || 50,
      });
    }

    return instruments;
  }

  /**
   * Ensure One-Way position mode is active (mode: 0).
   */
  async ensureAccountMode() {
    try {
      await this._request("/v5/position/switch-mode", {
        method: "POST",
        body: {
          category: "linear",
          coin: "USDT",
          mode: 0, // 0 = Merged Single (One-Way)
        },
      });
      return { oneWay: true, isolated: true };
    } catch (err) {
      // RetCode 110025: Position mode is not modified
      if (err.code === 110025) {
        return { oneWay: true, isolated: true };
      }
      throw err;
    }
  }

  /**
   * Set leverage for a symbol.
   */
  async setLeverage(symbol, leverage) {
    const levStr = String(Math.round(Number(leverage)));
    try {
      await this._request("/v5/position/set-leverage", {
        method: "POST",
        body: {
          category: "linear",
          symbol: symbol.toUpperCase(),
          buyLeverage: levStr,
          sellLeverage: levStr,
        },
      });
    } catch (err) {
      // RetCode 110043: Set leverage not modified
      if (err.code === 110043) {
        return;
      }
      throw err;
    }
  }

  /**
   * Place an immediate market order.
   * Bybit allows attaching stopLoss and takeProfit directly on order creation!
   */
  async placeMarket({ symbol, side, qty, clientId, reduceOnly = false, sl = null, tp = null }) {
    const bybitSide = side.toLowerCase() === "long" ? "Buy" : "Sell";
    const body = {
      category: "linear",
      symbol: symbol.toUpperCase(),
      side: bybitSide,
      orderType: "Market",
      qty: String(qty),
      orderLinkId: clientId,
      reduceOnly: Boolean(reduceOnly),
      positionIdx: 0, // One-Way mode
    };

    if (sl) {
      body.stopLoss = String(sl);
      body.slTriggerBy = "MarkPrice";
    }
    if (tp) {
      body.takeProfit = String(tp);
      body.tpTriggerBy = "MarkPrice";
    }

    const res = await this._request("/v5/order/create", {
      method: "POST",
      body,
    });

    return {
      id: res.orderId,
      orderId: res.orderId,
      clientId: res.orderLinkId || clientId,
      symbol: symbol.toUpperCase(),
      side: side.toLowerCase(),
      price: 0, // Market order fill price populated on fill/reconcile
      qty: Number(qty),
      notional: 0,
      fee: 0,
      feeAsset: "USDT",
      time: Date.now(),
    };
  }

  /**
   * Place or update position-level stop loss.
   */
  async placeStop({ symbol, triggerPrice, clientId = null }) {
    await this._request("/v5/position/trading-stop", {
      method: "POST",
      body: {
        category: "linear",
        symbol: symbol.toUpperCase(),
        stopLoss: String(triggerPrice),
        slTriggerBy: "MarkPrice",
        tpslMode: "Full",
        positionIdx: 0,
      },
    });

    return {
      id: `sl_${symbol}_${triggerPrice}`,
      orderId: `sl_${symbol}_${triggerPrice}`,
      clientId: clientId || `sl_${Date.now()}`,
      symbol: symbol.toUpperCase(),
      triggerPrice: Number(triggerPrice),
      status: "ACTIVE",
    };
  }

  /**
   * Place a reduce-only limit order (for TP1).
   */
  async placeReduceLimit({ symbol, side, qty, price, clientId }) {
    const limitSide = side.toLowerCase() === "long" ? "Sell" : "Buy";
    const res = await this._request("/v5/order/create", {
      method: "POST",
      body: {
        category: "linear",
        symbol: symbol.toUpperCase(),
        side: limitSide,
        orderType: "Limit",
        qty: String(qty),
        price: String(price),
        orderLinkId: clientId,
        reduceOnly: true,
        positionIdx: 0,
      },
    });

    return {
      id: res.orderId,
      orderId: res.orderId,
      clientId: res.orderLinkId || clientId,
      symbol: symbol.toUpperCase(),
      side: side.toLowerCase(),
      price: Number(price),
      qty: Number(qty),
      status: "NEW",
    };
  }

  /**
   * Amend/move an active stop loss (uses Bybit trading-stop endpoint).
   */
  async amendStop(ref, triggerPrice) {
    return this.placeStop({
      symbol: ref.symbol,
      triggerPrice,
      clientId: ref.clientId,
    });
  }

  /**
   * Cancel an open order by orderId or orderLinkId.
   */
  async cancel(ref) {
    const body = {
      category: "linear",
      symbol: ref.symbol.toUpperCase(),
    };
    if (ref.orderId) {
      body.orderId = ref.orderId;
    } else if (ref.clientId) {
      body.orderLinkId = ref.clientId;
    } else {
      throw new Error("cancel requires orderId or clientId.");
    }

    await this._request("/v5/order/cancel", {
      method: "POST",
      body,
    });
  }

  /**
   * Cancel all open orders for a symbol.
   */
  async cancelAll(symbol) {
    await this._request("/v5/order/cancel-all", {
      method: "POST",
      body: {
        category: "linear",
        symbol: symbol.toUpperCase(),
      },
    });
  }

  /**
   * Get active positions.
   */
  async getPositions() {
    const res = await this._request("/v5/position/list", {
      params: {
        category: "linear",
        settleCoin: "USDT",
      },
    });

    const active = [];
    for (const r of res?.list || []) {
      const size = Number(r.size);
      if (size > 0) {
        active.push({
          symbol: r.symbol,
          side: r.side.toLowerCase() === "buy" ? "long" : "short",
          size,
          entryPrice: Number(r.avgPrice) || 0,
          markPrice: Number(r.markPrice) || 0,
          leverage: Number(r.leverage) || 1,
          unrealizedPnl: Number(r.unrealisedPnl) || 0,
          liqPrice: Number(r.liqPrice) || 0,
          stopLoss: Number(r.stopLoss) || 0,
          takeProfit: Number(r.takeProfit) || 0,
        });
      }
    }

    return active;
  }

  /**
   * Get open orders for a symbol.
   */
  async getOpenOrders(symbol = null) {
    const params = { category: "linear" };
    if (symbol) params.symbol = symbol.toUpperCase();
    const res = await this._request("/v5/order/realtime", { params });
    return res?.list || [];
  }

  /**
   * Get execution fills.
   */
  async getFills(orderRef) {
    const params = {
      category: "linear",
      symbol: orderRef.symbol.toUpperCase(),
    };
    if (orderRef.orderId) params.orderId = orderRef.orderId;
    const res = await this._request("/v5/execution/list", { params });
    return (res?.list || []).map((t) => ({
      id: t.execId,
      orderId: t.orderId,
      price: Number(t.execPrice),
      qty: Number(t.execQty),
      fee: Number(t.execFee),
      feeAsset: "USDT",
      time: Number(t.execTime),
    }));
  }

  /**
   * Close a position with an immediate market order.
   */
  async closePosition(symbol, qty = null) {
    const positions = await this.getPositions();
    const pos = positions.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());
    if (!pos) {
      throw new Error(`No active Bybit position found for ${symbol}`);
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
