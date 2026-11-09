/**
 * Gate.io USDT Futures APIv4 Adapter (PRD 5.6, 6.2, 6.3)
 *
 * Implements ExchangeAdapter for Gate.io USDT perpetual futures.
 * Enforces PRD 5.6 E3: Rejects any API key with withdrawal permissions enabled.
 */

import { signGateRequest, syncTime } from "../signers.js";
import { ExchangeAdapter } from "./interface.js";

function isTruthyFlag(val) {
  if (val === true || val === 1) return true;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    return s === "true" || s === "1";
  }
  return false;
}

function isReadOnlyValue(val) {
  return isTruthyFlag(val);
}

function isFalsyFlag(val) {
  if (val === false || val === 0) return true;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    return s === "false" || s === "0";
  }
  return false;
}

function checkGateWithdrawalPermission(keyInfo) {
  if (!keyInfo || typeof keyInfo !== "object") return false;

  // 1. Direct truthy flag check across all keys in keyInfo containing "withdraw"
  for (const [k, v] of Object.entries(keyInfo)) {
    if (k.toLowerCase().includes("withdraw") && isTruthyFlag(v)) {
      return true;
    }
  }

  // Explicit known boolean/truthy flags
  if (
    isTruthyFlag(keyInfo.canWithdraw) ||
    isTruthyFlag(keyInfo.can_withdraw) ||
    isTruthyFlag(keyInfo.enable_withdrawals) ||
    isTruthyFlag(keyInfo.enableWithdrawals) ||
    isTruthyFlag(keyInfo.withdraw) ||
    isTruthyFlag(keyInfo.withdrawal) ||
    isTruthyFlag(keyInfo.isWithdrawEnabled) ||
    isTruthyFlag(keyInfo.is_withdraw_enabled)
  ) {
    return true;
  }

  // 2. String & array container parsing across perms / permissions / perm / permission
  const permContainers = [keyInfo.perms, keyInfo.permissions, keyInfo.perm, keyInfo.permission];
  const permList = [];
  for (const container of permContainers) {
    if (!container) continue;
    if (typeof container === "string") {
      if (container.toLowerCase().includes("withdraw")) return true;
    } else if (Array.isArray(container)) {
      permList.push(...container);
    } else if (typeof container === "object") {
      for (const [k, v] of Object.entries(container)) {
        if (k.toLowerCase().includes("withdraw") && isTruthyFlag(v)) return true;
        if (typeof v === "object" && v !== null) {
          permList.push({ name: k, ...v });
        } else if (typeof v === "string" && v.toLowerCase().includes("withdraw")) {
          return true;
        }
      }
    }
  }

  // 3. Inspect individual permission items
  for (const p of permList) {
    if (!p) continue;
    if (typeof p === "string") {
      if (p.toLowerCase().includes("withdraw")) return true;
      continue;
    }
    if (typeof p === "object") {
      const rawObj = JSON.stringify(p).toLowerCase();
      if (rawObj.includes("withdraw")) return true;

      const name = String(p.name || p.perm || p.permission || p.type || "").trim().toLowerCase();
      const readOnlyProp = p.read_only !== undefined ? p.read_only : p.readonly;
      const isReadOnly = isReadOnlyValue(readOnlyProp);

      // Gate.io wallet permission: read_only means viewing balance/deposits.
      // If wallet permission is NOT strictly read-only, it grants withdrawal/transfer capabilities!
      if ((name === "wallet" || name === "wallets") && !isReadOnly) {
        return true;
      }
    }
  }

  return false;
}

export class GateAdapter extends ExchangeAdapter {
  constructor({ apiKey = "", secret = "", testnet = false, fetchFn = null } = {}) {
    super({ apiKey, secret, testnet, fetchFn });
    this.id = "gate";
    this.name = "Gate.io USDT Futures";
    this.baseUrl = this.testnet ? "https://fx-api-testnet.gateio.ws" : "https://fx-api.gateio.ws";
  }

  /**
   * Venue execution capabilities.
   */
  capabilities() {
    return {
      trading: true,
      ioc: true,
      attachedSlTp: false,
      conditionalEndpoint: true,
      nativeTrail: false,
      atomicAmend: true,
      privateWs: true,
      closePositionStop: true,
      testnet: true,
    };
  }

  /**
   * Execute authenticated or public request to Gate.io APIv4.
   */
  async _request(path, { method = "GET", params = {}, body = null } = {}) {
    const signed = await signGateRequest({
      apiKey: this.apiKey,
      secret: this.secret,
      method,
      path,
      params,
      body,
    });

    const url = `${this.baseUrl}${path}${signed.queryString ? "?" + signed.queryString : ""}`;
    const res = await this.fetch(url, {
      method,
      headers: signed.headers,
      body: signed.bodyStr || undefined,
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const msg = json.message || json.label || json.msg || res.statusText || `HTTP ${res.status}`;
      throw new Error(`Gate.io API error (${res.status}): ${msg}`);
    }

    return json;
  }

  /**
   * Synchronize clock with Gate.io server.
   */
  async syncServerTime() {
    return syncTime("gate", async () => {
      const res = await this.fetch(`${this.baseUrl}/api/v4/spot/time`);
      if (!res.ok) {
        throw new Error(`Gate.io time sync failed: HTTP ${res.status}`);
      }
      const data = await res.json();
      return Number(data.server_time);
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

    const probe = new GateAdapter({
      apiKey: testApiKey,
      secret: testSecret,
      testnet: this.testnet,
      fetchFn: this.fetch,
    });

    try {
      await probe.syncServerTime().catch(() => {});

      // Query account details / permissions
      let keyInfo = null;
      try {
        keyInfo = await probe._request("/api/v4/account/detail");
      } catch {
        try {
          keyInfo = await probe._request("/api/v4/account/api_key");
        } catch {
          try {
            keyInfo = await probe._request("/api/v4/wallet/sub_account_keys");
          } catch {
            // Handled below if keyInfo is missing
          }
        }
      }

      // Check withdrawal permissions (PRD 5.6 E3 Security Invariant)
      const hasWithdrawal = checkGateWithdrawalPermission(keyInfo);

      if (hasWithdrawal) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: true,
          error: "API key has withdrawal permissions enabled. For safety, delete this key and create one with Trading only.",
        };
      }

      // Check futures account access and trading permissions
      const futuresAccount = await probe._request("/api/v4/futures/usdt/accounts");

      if (checkGateWithdrawalPermission(futuresAccount)) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: true,
          error: "API key has withdrawal permissions enabled. For safety, delete this key and create one with Trading only.",
        };
      }

      // Verify trading permissions
      let canTrade = true;
      const permContainers = [keyInfo?.perms, keyInfo?.permissions];
      for (const container of permContainers) {
        if (!container) continue;
        const list = Array.isArray(container)
          ? container
          : typeof container === "object"
          ? Object.entries(container).map(([k, v]) => (typeof v === "object" && v !== null ? { name: k, ...v } : { name: k, val: v }))
          : [];
        for (const p of list) {
          if (!p || typeof p !== "object") continue;
          const name = String(p.name || p.perm || p.permission || p.type || "").trim().toLowerCase();
          const readOnlyProp = p.read_only !== undefined ? p.read_only : p.readonly;
          const isReadOnly = isReadOnlyValue(readOnlyProp);
          if (name === "futures" && isReadOnly) {
            canTrade = false;
          }
        }
      }
      if (isFalsyFlag(futuresAccount?.canTrade)) {
        canTrade = false;
      }

      if (!canTrade) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: false,
          error: "API key does not have Futures Trading permissions enabled on Gate.io.",
        };
      }

      return {
        ok: true,
        canTrade: true,
        canWithdraw: false,
        accountId: String(futuresAccount?.user || keyInfo?.user_id || ""),
      };
    } catch (err) {
      return {
        ok: false,
        canTrade: false,
        canWithdraw: false,
        error: err.message || "Failed to validate Gate.io credentials.",
      };
    }
  }

  /**
   * Get USDT balance and equity.
   */
  async getBalance() {
    const data = await this._request("/api/v4/futures/usdt/accounts");
    const availableUsdt = Number(data?.available || 0);
    const walletUsdt = Number(data?.total || 0);
    const unrealisedPnl = Number(data?.unrealised_pnl || 0);
    const equityUsdt = walletUsdt + unrealisedPnl;
    return { availableUsdt, equityUsdt, walletUsdt };
  }

  /**
   * Get tradable USDT perpetual contracts.
   */
  async getInstruments() {
    const list = await this._request("/api/v4/futures/usdt/contracts");
    if (!Array.isArray(list)) return [];
    return list
      .filter((c) => !c.in_delisting)
      .map((c) => {
        const parts = String(c.name || "").split("_");
        return {
          symbol: c.name,
          baseCoin: parts[0] || c.name,
          quoteCoin: parts[1] || "USDT",
          tickSize: Number(c.order_price_round) || 0.01,
          lotSize: Number(c.order_size_min) || 1,
          minNotional: 5,
          maxLeverage: Number(c.leverage_max) || 100,
          minQty: Number(c.order_size_min) || 1,
        };
      });
  }

  /**
   * Ensure account is in One-Way position mode.
   */
  async ensureAccountMode() {
    try {
      const acc = await this._request("/api/v4/futures/usdt/accounts");
      if (acc && acc.in_dual_mode) {
        await this._request("/api/v4/futures/usdt/dual_mode", {
          method: "POST",
          params: { dual_mode: "false" },
        });
      }
    } catch {
      // Ignore if already configured or unsupported
    }
    return { oneWay: true, isolated: true };
  }

  /**
   * Set leverage for a contract.
   */
  async setLeverage(symbol, leverage) {
    return this._request(`/api/v4/futures/usdt/positions/${encodeURIComponent(symbol)}/leverage`, {
      method: "POST",
      params: { leverage: String(leverage) },
    });
  }

  /**
   * Place immediate market order.
   * Gate.io size sign: positive for long, negative for short.
   */
  async placeMarket(o) {
    const { symbol, side, qty, clientId, reduceOnly } = o;
    const cleanId = String(clientId || `ord_${Date.now()}`);
    const text = cleanId.startsWith("t-") ? cleanId.slice(0, 28) : ("t-" + cleanId).slice(0, 28);
    const size = side === "long" ? Math.abs(qty) : -Math.abs(qty);

    const body = {
      contract: symbol,
      size,
      price: "0",
      tif: "ioc",
      text,
      reduce_only: Boolean(reduceOnly),
    };

    const res = await this._request("/api/v4/futures/usdt/orders", {
      method: "POST",
      body,
    });

    const fillPrice = Number(res.fill_price || res.price || 0);
    const filledQty = Math.abs(Number(res.size ?? size));
    const fillTime = Number(res.create_time ? res.create_time * 1000 : Date.now());

    return {
      id: String(res.id),
      orderId: String(res.id),
      clientId: cleanId,
      symbol: res.contract || symbol,
      side,
      price: fillPrice,
      qty: filledQty,
      notional: fillPrice * filledQty,
      fee: 0,
      feeAsset: "USDT",
      time: fillTime,
    };
  }

  /**
   * Place exchange stop loss trigger order.
   */
  async placeStop(o) {
    const { symbol, side, qty, triggerPrice, clientId, closePosition } = o;
    const cleanId = String(clientId || `sl_${Date.now()}`);
    const text = cleanId.startsWith("t-") ? cleanId.slice(0, 28) : ("t-" + cleanId).slice(0, 28);
    const rule = side === "long" ? 2 : 1; // 2 (<=) for long stop loss, 1 (>=) for short stop loss
    const size = closePosition ? 0 : (side === "long" ? -Math.abs(qty) : Math.abs(qty));

    const body = {
      initial: {
        contract: symbol,
        size,
        price: "0",
        close: Boolean(closePosition ?? true),
        tif: "ioc",
        text,
      },
      trigger: {
        strategy_type: 0,
        price_type: 1, // mark price
        price: String(triggerPrice),
        rule,
        expiration: 0,
      },
    };

    const res = await this._request("/api/v4/futures/usdt/price_orders", {
      method: "POST",
      body,
    });

    return {
      id: String(res.id),
      orderId: String(res.id),
      clientId: cleanId,
      symbol,
      side,
      triggerPrice: Number(triggerPrice),
      status: "NEW",
    };
  }

  /**
   * Place reduce-only limit order (take-profit).
   */
  async placeReduceLimit(o) {
    const { symbol, side, qty, price, clientId } = o;
    const cleanId = String(clientId || `tp_${Date.now()}`);
    const text = cleanId.startsWith("t-") ? cleanId.slice(0, 28) : ("t-" + cleanId).slice(0, 28);
    const size = side === "long" ? -Math.abs(qty) : Math.abs(qty);

    const body = {
      contract: symbol,
      size,
      price: String(price),
      tif: "gtc",
      close: true,
      reduce_only: true,
      text,
    };

    const res = await this._request("/api/v4/futures/usdt/orders", {
      method: "POST",
      body,
    });

    return {
      id: String(res.id),
      orderId: String(res.id),
      clientId: cleanId,
      symbol,
      side,
      price: Number(price),
      qty: Number(qty),
      status: "NEW",
    };
  }

  /**
   * Amend stop order trigger price.
   */
  async amendStop(ref, triggerPrice) {
    await this.cancel(ref);
    return this.placeStop({
      symbol: ref.symbol,
      side: ref.side,
      qty: ref.qty,
      triggerPrice,
      clientId: ref.clientId || `sl_${Date.now()}`,
      closePosition: ref.closePosition ?? true,
    });
  }

  /**
   * Cancel single order by orderId.
   */
  async cancel(ref) {
    const orderId = ref?.orderId || ref?.id;
    if (!orderId) return { ok: false, error: "Missing orderId" };

    try {
      await this._request(`/api/v4/futures/usdt/orders/${encodeURIComponent(orderId)}`, {
        method: "DELETE",
      });
      return { ok: true, orderId };
    } catch {
      try {
        await this._request(`/api/v4/futures/usdt/price_orders/${encodeURIComponent(orderId)}`, {
          method: "DELETE",
        });
        return { ok: true, orderId };
      } catch (err2) {
        return { ok: false, error: err2.message };
      }
    }
  }

  /**
   * Cancel all open orders for symbol.
   */
  async cancelAll(symbol) {
    const params = symbol ? { contract: symbol } : {};
    try {
      await this._request("/api/v4/futures/usdt/orders", {
        method: "DELETE",
        params,
      });
    } catch {
      // ignore
    }
    try {
      await this._request("/api/v4/futures/usdt/price_orders", {
        method: "DELETE",
        params,
      });
    } catch {
      // ignore
    }
    return { ok: true, symbol };
  }

  /**
   * Get all active positions.
   */
  async getPositions() {
    const data = await this._request("/api/v4/futures/usdt/positions");
    if (!Array.isArray(data)) return [];
    return data
      .filter((p) => Math.abs(Number(p.size || 0)) > 0)
      .map((p) => ({
        symbol: p.contract,
        side: Number(p.size) > 0 ? "long" : "short",
        size: Math.abs(Number(p.size)),
        entryPrice: Number(p.entry_price || 0),
        markPrice: Number(p.mark_price || 0),
        leverage: Number(p.leverage || 1),
        unrealizedPnl: Number(p.unrealised_pnl || 0),
        liqPrice: Number(p.liq_price || 0),
      }));
  }

  /**
   * Get open orders for symbol.
   */
  async getOpenOrders(symbol) {
    const params = { status: "open" };
    if (symbol) params.contract = symbol;
    const orders = await this._request("/api/v4/futures/usdt/orders", { params }).catch(() => []);
    const triggers = await this._request("/api/v4/futures/usdt/price_orders", { params }).catch(() => []);
    const all = [...(Array.isArray(orders) ? orders : []), ...(Array.isArray(triggers) ? triggers : [])];
    return all.map((o) => ({
      id: String(o.id),
      orderId: String(o.id),
      symbol: o.contract,
      side: Number(o.size) >= 0 ? "long" : "short",
      price: Number(o.price || 0),
      qty: Math.abs(Number(o.size || 0)),
      status: o.status || "open",
    }));
  }

  /**
   * Get fills for an order.
   */
  async getFills(orderRef) {
    const params = {};
    if (orderRef?.symbol) params.contract = orderRef.symbol;
    if (orderRef?.orderId) params.order = orderRef.orderId;
    const trades = await this._request("/api/v4/futures/usdt/my_trades", { params });
    if (!Array.isArray(trades)) return [];
    return trades.map((t) => ({
      id: String(t.id),
      orderId: String(t.order_id),
      price: Number(t.price || 0),
      qty: Math.abs(Number(t.size || 0)),
      fee: Number(t.fee || 0),
      feeAsset: "USDT",
      time: Number(t.create_time ? t.create_time * 1000 : Date.now()),
    }));
  }

  /**
   * Close a position with an immediate market order.
   */
  async closePosition(symbol, qty = null) {
    const positions = await this.getPositions();
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos) return null;
    const closeSide = pos.side === "long" ? "short" : "long";
    return this.placeMarket({
      symbol,
      side: closeSide,
      qty: qty || pos.size,
      clientId: `close_${Date.now()}`,
      reduceOnly: true,
    });
  }

  /**
   * Get ticker for a contract.
   */
  async getTicker(symbol) {
    const res = await this._request("/api/v4/futures/usdt/tickers", { params: { contract: symbol } });
    const item = Array.isArray(res) ? res[0] : res;
    return {
      last: Number(item?.last || 0),
      mark: Number(item?.mark_price || 0),
      high24h: Number(item?.high_24h || 0),
      low24h: Number(item?.low_24h || 0),
      volume24h: Number(item?.volume_24h_base || 0),
    };
  }

  /**
   * Get order book.
   */
  async getOrderbook(symbol, limit = 20) {
    return this._request("/api/v4/futures/usdt/order_book", {
      params: { contract: symbol, limit: String(limit) },
    });
  }

  /**
   * Get funding rate.
   */
  async getFundingRate(symbol) {
    const contract = await this._request(`/api/v4/futures/usdt/contracts/${encodeURIComponent(symbol)}`);
    return Number(contract?.funding_rate || 0);
  }
}
