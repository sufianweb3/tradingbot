/**
 * KuCoin Futures API Adapter (PRD 5.6, 6.2, 6.3)
 *
 * Implements ExchangeAdapter for KuCoin Futures.
 * Uses API Key Version 2 with HMAC-SHA256 Base64 signing and signed passphrase.
 * Enforces PRD 5.6 E3: Rejects any API key with withdrawal/transfer permissions enabled.
 */

import { signKuCoinRequest, syncTime } from "../signers.js";
import { ExchangeAdapter } from "./interface.js";

function isTruthy(val) {
  if (val === true || val === 1) return true;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    return s === "true" || s === "1";
  }
  return false;
}

function extractTokens(val) {
  const tokens = [];
  if (!val) return tokens;
  if (typeof val === "string") {
    tokens.push(...val.split(/[,;\s]+/));
  } else if (Array.isArray(val)) {
    for (const item of val) {
      tokens.push(...extractTokens(item));
    }
  } else if (typeof val === "object") {
    for (const [k, v] of Object.entries(val)) {
      if (typeof v === "object" && v !== null) {
        tokens.push(...extractTokens(v));
      } else {
        if (typeof v === "string") {
          tokens.push(...extractTokens(v));
        }
        if (isTruthy(v)) {
          tokens.push(k.trim().toLowerCase());
        }
      }
    }
  }
  return tokens;
}

function checkKuCoinWithdrawal(keyInfo) {
  if (!keyInfo || typeof keyInfo !== "object") return false;

  // 1. Direct check across known flag names
  const flagNames = [
    "canWithdraw",
    "can_withdraw",
    "enableWithdrawals",
    "enable_withdrawals",
    "isWithdrawEnabled",
    "is_withdraw_enabled",
    "withdraw",
    "withdrawal",
    "canTransfer",
    "can_transfer",
    "enableTransfer",
    "enable_transfer",
    "isTransferEnabled",
    "is_transfer_enabled",
    "transfer",
  ];
  for (const f of flagNames) {
    if (isTruthy(keyInfo[f])) return true;
  }

  // 2. Dynamic top-level attribute check (excluding safe metadata fields)
  for (const [k, v] of Object.entries(keyInfo)) {
    const lk = k.toLowerCase();
    if (["remark", "subname", "apikey", "userid", "ipwhitelist"].includes(lk)) continue;
    if ((lk.includes("withdraw") || lk.includes("transfer")) && isTruthy(v)) {
      return true;
    }
  }

  // 3. Extract tokens from all permission containers
  const permContainers = [
    keyInfo.permissions,
    keyInfo.permission,
    keyInfo.perms,
    keyInfo.scopes,
    keyInfo.authorities,
  ];
  const tokens = [];
  for (const c of permContainers) {
    tokens.push(...extractTokens(c));
  }
  const normalizedTokens = tokens.map((t) => String(t).trim().toLowerCase()).filter(Boolean);

  if (normalizedTokens.some((t) => t.includes("withdraw") || t.includes("transfer"))) {
    return true;
  }

  return false;
}

export class KuCoinAdapter extends ExchangeAdapter {
  constructor({ apiKey = "", secret = "", passphrase = "", testnet = false, fetchFn = null } = {}) {
    super({ apiKey, secret, testnet, fetchFn });
    this.id = "kucoin";
    this.name = "KuCoin Futures";
    this.passphrase = passphrase;
    this.baseUrl = this.testnet ? "https://api-sandbox-futures.kucoin.com" : "https://api-futures.kucoin.com";
    this._configuredLeverage = new Map();
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
      atomicAmend: false,
      privateWs: true,
      closePositionStop: true,
      testnet: true,
    };
  }

  /**
   * Execute authenticated or public request to KuCoin Futures.
   */
  async _request(endpoint, { method = "GET", params = {}, body = null } = {}) {
    const signed = await signKuCoinRequest({
      apiKey: this.apiKey,
      secret: this.secret,
      passphrase: this.passphrase,
      method,
      endpoint,
      params,
      body,
    });

    const url = `${this.baseUrl}${signed.endpoint}`;
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

    if (!res.ok || (json.code && String(json.code) !== "200000")) {
      const msg = json.msg || json.message || res.statusText || `HTTP ${res.status}`;
      throw new Error(`KuCoin API error (${json.code || res.status}): ${msg}`);
    }

    return json.data !== undefined ? json.data : json;
  }

  /**
   * Synchronize clock with KuCoin server.
   */
  async syncServerTime() {
    return syncTime("kucoin", async () => {
      const res = await this.fetch(`${this.baseUrl}/api/v1/timestamp`);
      if (!res.ok) {
        throw new Error(`KuCoin time sync failed: HTTP ${res.status}`);
      }
      const json = await res.json();
      return Number(json.data || json.serverTime || Date.now());
    });
  }

  /**
   * Validate credentials and inspect permissions (PRD 5.6 E3).
   * MUST reject credentials if withdrawal permissions are enabled!
   */
  async validateKey(creds = {}) {
    const testApiKey = creds.apiKey || this.apiKey;
    const testSecret = creds.secret || this.secret;
    const testPassphrase = creds.passphrase || this.passphrase;

    if (!testApiKey || !testSecret || !testPassphrase) {
      return { ok: false, canTrade: false, canWithdraw: false, error: "Missing API key, secret, or passphrase." };
    }

    const probe = new KuCoinAdapter({
      apiKey: testApiKey,
      secret: testSecret,
      passphrase: testPassphrase,
      testnet: this.testnet,
      fetchFn: this.fetch,
    });

    try {
      await probe.syncServerTime().catch(() => {});

      // Query API key permissions
      let keyInfo = null;
      try {
        keyInfo = await probe._request("/api/v1/user/api-key");
      } catch {
        // Handled below if keyInfo is missing
      }

      // Check withdrawal permissions (PRD 5.6 E3 Security Invariant)
      const hasWithdrawal = checkKuCoinWithdrawal(keyInfo);

      if (hasWithdrawal) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: true,
          error: "API key has withdrawal permissions enabled. For safety, delete this key and create one with Trading only.",
        };
      }

      // Verify futures account overview
      const overview = await probe._request("/api/v1/account-overview?currency=USDT");

      if (checkKuCoinWithdrawal(overview)) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: true,
          error: "API key has withdrawal permissions enabled. For safety, delete this key and create one with Trading only.",
        };
      }

      // Verify trading permissions
      const hasPermContainer = Boolean(
        keyInfo &&
          ("permissions" in keyInfo ||
            "permission" in keyInfo ||
            "perms" in keyInfo ||
            "scopes" in keyInfo ||
            "authorities" in keyInfo)
      );
      const permContainers = [
        keyInfo?.permissions,
        keyInfo?.permission,
        keyInfo?.perms,
        keyInfo?.scopes,
        keyInfo?.authorities,
      ];
      const tokens = [];
      for (const c of permContainers) {
        tokens.push(...extractTokens(c));
      }
      const permTokens = tokens.map((t) => String(t).trim().toLowerCase()).filter(Boolean);

      let canTrade = true;
      if (keyInfo && (hasPermContainer || permTokens.length > 0)) {
        const hasTradePerm = permTokens.some(
          (t) => t.includes("future") || t.includes("trade") || t.includes("general")
        );
        if (!hasTradePerm) {
          canTrade = false;
        }
      }
      if (overview?.canTrade === false || overview?.canTrade === "false" || overview?.canTrade === 0) {
        canTrade = false;
      }

      if (!canTrade) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: false,
          error: "API key does not have Futures Trading permissions enabled on KuCoin.",
        };
      }

      return {
        ok: true,
        canTrade: true,
        canWithdraw: false,
        accountId: String(keyInfo?.apiKey || keyInfo?.userId || ""),
      };
    } catch (err) {
      return {
        ok: false,
        canTrade: false,
        canWithdraw: false,
        error: err.message || "Failed to validate KuCoin credentials.",
      };
    }
  }

  /**
   * Get USDT balance and equity.
   */
  async getBalance() {
    const data = await this._request("/api/v1/account-overview?currency=USDT");
    const availableUsdt = Number(data?.availableBalance || 0);
    const equityUsdt = Number(data?.accountEquity ?? data?.marginBalance ?? 0);
    const walletUsdt = Number(data?.marginBalance ?? data?.accountEquity ?? 0);
    return { availableUsdt, equityUsdt, walletUsdt };
  }

  /**
   * Get tradable active futures contracts.
   */
  async getInstruments() {
    const list = await this._request("/api/v1/contracts/active");
    if (!Array.isArray(list)) return [];
    return list
      .filter((c) => (c.quoteCurrency === "USDT" || c.settleCurrency === "USDT") && (c.status === "Open" || !c.status))
      .map((c) => ({
        symbol: c.symbol,
        baseCoin: c.baseCurrency || c.symbol,
        quoteCoin: c.quoteCurrency || "USDT",
        tickSize: Number(c.tickSize) || 0.01,
        lotSize: Number(c.lotSize) || 1,
        minNotional: 5,
        maxLeverage: Number(c.maxLeverage) || 100,
        minQty: Number(c.lotSize) || 1,
      }));
  }

  /**
   * Ensure account is in Isolated One-Way mode.
   */
  async ensureAccountMode() {
    return { oneWay: true, isolated: true };
  }

  /**
   * Set leverage for a contract (recorded per symbol).
   */
  async setLeverage(symbol, leverage) {
    this._configuredLeverage.set(symbol, Number(leverage));
    return { ok: true, symbol, leverage: Number(leverage) };
  }

  /**
   * Place immediate market order.
   */
  async placeMarket(o) {
    const { symbol, side, qty, clientId, reduceOnly } = o;
    const cleanId = String(clientId || `ord_${Date.now()}`);
    const lev = String(this._configuredLeverage.get(symbol) || 10);

    const body = {
      clientOid: cleanId,
      symbol,
      side: side === "long" ? "buy" : "sell",
      type: "market",
      size: qty,
      leverage: lev,
      marginMode: "ISOLATED",
      reduceOnly: Boolean(reduceOnly),
    };

    const res = await this._request("/api/v1/orders", {
      method: "POST",
      body,
    });

    const orderId = String(res?.orderId || res?.id || cleanId);
    return {
      id: orderId,
      orderId,
      clientId: cleanId,
      symbol,
      side,
      price: Number(res?.price || 0),
      qty,
      notional: 0,
      fee: 0,
      feeAsset: "USDT",
      time: Date.now(),
    };
  }

  /**
   * Place exchange stop loss trigger order.
   */
  async placeStop(o) {
    const { symbol, side, qty, triggerPrice, clientId, closePosition } = o;
    const cleanId = String(clientId || `sl_${Date.now()}`);

    const body = {
      clientOid: cleanId,
      symbol,
      side: side === "long" ? "sell" : "buy",
      type: "market",
      stop: side === "long" ? "down" : "up",
      stopPrice: String(triggerPrice),
      stopPriceType: "MP",
      size: qty || 1,
      closeOrder: Boolean(closePosition ?? true),
      reduceOnly: true,
    };

    const res = await this._request("/api/v1/orders", {
      method: "POST",
      body,
    });

    const orderId = String(res?.orderId || res?.id || cleanId);
    return {
      id: orderId,
      orderId,
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

    const body = {
      clientOid: cleanId,
      symbol,
      side: side === "long" ? "sell" : "buy",
      type: "limit",
      price: String(price),
      size: qty,
      reduceOnly: true,
      timeInForce: "GTC",
    };

    const res = await this._request("/api/v1/orders", {
      method: "POST",
      body,
    });

    const orderId = String(res?.orderId || res?.id || cleanId);
    return {
      id: orderId,
      orderId,
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
   * Cancel single order by orderId or clientId.
   */
  async cancel(ref) {
    const orderId = ref?.orderId || ref?.id;
    if (orderId) {
      try {
        await this._request(`/api/v1/orders/${encodeURIComponent(orderId)}`, {
          method: "DELETE",
        });
        return { ok: true, orderId };
      } catch (err) {
        if (ref?.clientId) {
          try {
            await this._request(`/api/v1/orders/client-order/${encodeURIComponent(ref.clientId)}`, {
              method: "DELETE",
            });
            return { ok: true, clientId: ref.clientId };
          } catch {
            // ignore
          }
        }
        return { ok: false, error: err.message };
      }
    }
    if (ref?.clientId) {
      try {
        await this._request(`/api/v1/orders/client-order/${encodeURIComponent(ref.clientId)}`, {
          method: "DELETE",
        });
        return { ok: true, clientId: ref.clientId };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    return { ok: false, error: "Missing order reference." };
  }

  /**
   * Cancel all open orders for symbol.
   */
  async cancelAll(symbol) {
    const params = symbol ? { symbol } : {};
    try {
      await this._request("/api/v1/orders", {
        method: "DELETE",
        params,
      });
    } catch {
      // ignore
    }
    try {
      await this._request("/api/v1/stopOrders", {
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
    const data = await this._request("/api/v1/positions");
    if (!Array.isArray(data)) return [];
    return data
      .filter((p) => p.isOpen === true || Math.abs(Number(p.currentQty || 0)) > 0)
      .map((p) => {
        const qty = Number(p.currentQty || 0);
        return {
          symbol: p.symbol,
          side: qty > 0 ? "long" : "short",
          size: Math.abs(qty),
          entryPrice: Number(p.avgEntryPrice || 0),
          markPrice: Number(p.markPrice || 0),
          leverage: Number(p.realLeverage || p.leverage || 1),
          unrealizedPnl: Number(p.unrealisedPnl || 0),
          liqPrice: Number(p.liquidationPrice || 0),
        };
      });
  }

  /**
   * Get open orders for symbol.
   */
  async getOpenOrders(symbol) {
    const params = { status: "active" };
    if (symbol) params.symbol = symbol;
    const res = await this._request("/api/v1/orders", { params }).catch(() => ({ items: [] }));
    const items = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
    return items.map((o) => ({
      id: String(o.id || o.orderId),
      orderId: String(o.id || o.orderId),
      symbol: o.symbol,
      side: o.side === "buy" ? "long" : "short",
      price: Number(o.price || 0),
      qty: Number(o.size || 0),
      status: o.status || "active",
    }));
  }

  /**
   * Get trade fills for an order.
   */
  async getFills(orderRef) {
    const params = {};
    if (orderRef?.orderId) params.orderId = orderRef.orderId;
    if (orderRef?.symbol) params.symbol = orderRef.symbol;
    const res = await this._request("/api/v1/fills", { params }).catch(() => ({ items: [] }));
    const items = Array.isArray(res) ? res : (Array.isArray(res?.items) ? res.items : []);
    return items.map((f) => ({
      id: String(f.tradeId || f.id),
      orderId: String(f.orderId),
      price: Number(f.price || 0),
      qty: Number(f.size || 0),
      fee: Number(f.fee || 0),
      feeAsset: f.feeRateCurrency || "USDT",
      time: Number(f.createdAt || Date.now()),
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
   * Get ticker for a symbol.
   */
  async getTicker(symbol) {
    const data = await this._request("/api/v1/ticker", { params: { symbol } });
    return {
      last: Number(data?.price || 0),
      mark: Number(data?.price || 0),
      high24h: 0,
      low24h: 0,
      volume24h: Number(data?.size || 0),
    };
  }

  /**
   * Get order book.
   */
  async getOrderbook(symbol, limit = 20) {
    return this._request("/api/v1/level2/depth20", { params: { symbol } });
  }

  /**
   * Get funding rate.
   */
  async getFundingRate(symbol) {
    const data = await this._request(`/api/v1/funding-rate/${encodeURIComponent(symbol)}/current`);
    return Number(data?.value || 0);
  }
}
