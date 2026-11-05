/**
 * MEXC Futures Contract API v1 Adapter (PRD 5.6, 6.2, 6.3, Risk R5)
 *
 * Implements ExchangeAdapter for MEXC USDT perpetual futures (contract.mexc.com).
 * Enforces PRD 5.6 E3: Rejects any API key with withdrawal/transfer permissions enabled.
 * Enforces PRD 5.6 / Risk R5: Capability probe detects official futures order API availability;
 * if unavailable, restricts strictly to Paper mode with zero unofficial methods.
 */

import { signMexcRequest, syncTime } from "../signers.js";
import { ExchangeAdapter } from "./interface.js";

function isTruthyFlag(val) {
  if (val === true || val === 1) return true;
  if (typeof val === "string") {
    const s = val.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
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
    return s === "false" || s === "0" || s === "no";
  }
  return false;
}

/**
 * Check if a permission payload grants withdrawal or transfer privileges.
 * Enforces PRD 5.6 E3 Security Invariant across all payload permutations.
 */
export function checkMexcWithdrawalPermission(payload) {
  if (!payload || typeof payload !== "object") return false;

  // 1. Check direct properties on object
  for (const [k, v] of Object.entries(payload)) {
    const lk = k.toLowerCase().replace(/[-_]/g, "");
    if ((lk.includes("withdraw") || lk.includes("transfer")) && isTruthyFlag(v)) {
      return true;
    }
  }

  // Explicit known boolean/string/numeric flag names
  const flagNames = [
    "canWithdraw",
    "can_withdraw",
    "enableWithdrawals",
    "enable_withdrawals",
    "withdraw",
    "withdrawal",
    "isWithdrawEnabled",
    "is_withdraw_enabled",
    "canTransfer",
    "can_transfer",
    "enableTransfer",
    "enable_transfer",
    "isTransferEnabled",
    "is_transfer_enabled",
    "transfer",
  ];
  for (const f of flagNames) {
    if (isTruthyFlag(payload[f])) return true;
  }

  // 2. Scan permission containers (permissions, perms, scopes, authorities, etc.)
  const permContainers = [
    payload.permissions,
    payload.permission,
    payload.perms,
    payload.scopes,
    payload.authorities,
    payload.permList,
  ];

  for (const container of permContainers) {
    if (!container) continue;

    if (typeof container === "string") {
      const tokens = container.split(/[,;\s|/]+/);
      for (const t of tokens) {
        const lt = t.trim().toLowerCase();
        if (lt.includes("withdraw") || lt.includes("transfer")) return true;
      }
    } else if (Array.isArray(container)) {
      for (const item of container) {
        if (!item) continue;
        if (typeof item === "string") {
          const lt = item.trim().toLowerCase();
          if (lt.includes("withdraw") || lt.includes("transfer")) return true;
        } else if (typeof item === "object") {
          const raw = JSON.stringify(item).toLowerCase();
          const name = String(item.name || item.perm || item.permission || item.type || item.scope || "").trim().toLowerCase();
          const readOnlyProp = item.read_only !== undefined ? item.read_only : (item.readonly !== undefined ? item.readonly : item.readOnly);
          const isReadOnly = isReadOnlyValue(readOnlyProp);

          if ((name.includes("withdraw") || name.includes("transfer")) && !isReadOnly) {
            return true;
          }
          if ((name === "wallet" || name === "wallets") && !isReadOnly) {
            return true;
          }
          if (checkMexcWithdrawalPermission(item)) {
            return true;
          }
        }
      }
    } else if (typeof container === "object") {
      for (const [k, v] of Object.entries(container)) {
        const lk = k.toLowerCase().replace(/[-_]/g, "");
        if ((lk.includes("withdraw") || lk.includes("transfer")) && isTruthyFlag(v)) {
          return true;
        }
        if (typeof v === "object" && v !== null) {
          if (checkMexcWithdrawalPermission(v)) return true;
        }
      }
    }
  }

  // 3. Recursive inspection for nested dictionaries (e.g. { data: { ... } }, { result: { ... } })
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === "object" && v !== null && ["data", "result", "account", "info", "user", "detail"].includes(k.toLowerCase())) {
      if (checkMexcWithdrawalPermission(v)) return true;
    }
  }

  return false;
}

export class MexcAdapter extends ExchangeAdapter {
  constructor({ apiKey = "", secret = "", testnet = false, fetchFn = null } = {}) {
    super({ apiKey, secret, testnet, fetchFn });
    this.id = "mexc";
    this.name = "MEXC Futures";
    this.baseUrl = "https://contract.mexc.com";
    this._tradingCapable = false;
    this._probeReason = "Futures order API unavailable at MEXC";
    this._configuredLeverage = new Map();
  }

  /**
   * Return venue execution capabilities (PRD 6.3, Risk R5).
   * Reflects capability probe status.
   */
  capabilities() {
    return {
      trading: this._tradingCapable,
      ...(this._probeReason ? { reason: this._probeReason } : {}),
    };
  }

  /**
   * Synchronize local client clock with MEXC server time.
   */
  async syncServerTime() {
    return syncTime("mexc", async () => {
      const url = `${this.baseUrl}/api/v1/contract/ping`;
      const res = await this.fetch(url, { method: "GET" });
      const json = await res.json().catch(() => ({}));
      if (json && typeof json.data === "number") {
        return json.data;
      }
      return Date.now();
    });
  }

  /**
   * Execute authenticated or public request to MEXC Contract API.
   */
  async _request(path, { method = "GET", params = {}, body = null } = {}) {
    const signed = await signMexcRequest({
      apiKey: this.apiKey,
      secret: this.secret,
      method,
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
      const msg = json.message || json.msg || res.statusText || `HTTP ${res.status}`;
      const err = new Error(`MEXC API error (${res.status}): ${msg}`);
      err.status = res.status;
      err.code = json.code;
      throw err;
    }

    if (json && (json.success === false || (json.code !== undefined && json.code !== 0 && json.code !== 200))) {
      const msg = json.message || json.msg || `MEXC API error (code: ${json.code})`;
      const err = new Error(msg);
      err.code = json.code;
      err.status = res.status;
      throw err;
    }

    return json.data !== undefined ? json.data : json;
  }

  /**
   * Capability Probe (PRD 5.6, Risk R5):
   * Probes official futures order endpoint POST /api/v1/private/order/create.
   * If official futures order placement succeeds, Live trading is enabled.
   * If maintenance or unavailable, sets trading = false with
   * "Futures order API unavailable at MEXC" and restricts to Paper mode.
   * Strictly NO unofficial methods or web scraping.
   */
  async probeCapability() {
    try {
      const probeOrder = {
        symbol: "BTC_USDT",
        price: 10000,
        vol: 1,
        side: 1,
        type: 1,
        openType: 1,
        externalOid: `probe_${Date.now()}`,
      };

      const res = await this._request("/api/v1/private/order/create", {
        method: "POST",
        body: probeOrder,
      });

      this._tradingCapable = true;
      this._probeReason = undefined;

      // Cancel test probe order if order ID returned
      if (res && (res.orderId || res.id)) {
        await this.cancel({ symbol: "BTC_USDT", orderId: res.orderId || res.id }).catch(() => {});
      }

      return {
        ok: true,
        trading: true,
        futuresOrderAvailable: true,
        message: "Futures order API operational",
        data: res,
      };
    } catch (err) {
      this._tradingCapable = false;
      this._probeReason = "Futures order API unavailable at MEXC";
      return {
        ok: false,
        trading: false,
        futuresOrderAvailable: false,
        reason: "Futures order API unavailable at MEXC",
        message: "Futures order API unavailable at MEXC",
        error: err.message,
      };
    }
  }

  /**
   * Validate credentials and inspect permissions (PRD 5.6 E3).
   * Strictly rejects credentials if withdrawal or transfer permissions are enabled!
   */
  async validateKey(creds = {}) {
    const testApiKey = creds.apiKey || this.apiKey;
    const testSecret = creds.secret || this.secret;

    if (!testApiKey || !testSecret) {
      return { ok: false, canTrade: false, canWithdraw: false, error: "Missing API key or secret." };
    }

    const probe = new MexcAdapter({
      apiKey: testApiKey,
      secret: testSecret,
      testnet: this.testnet,
      fetchFn: this.fetch,
    });

    try {
      await probe.syncServerTime().catch(() => {});

      // Query API key info / permissions / account detail
      let keyInfo = null;
      try {
        keyInfo = await probe._request("/api/v1/private/account/api_key_info");
      } catch {
        try {
          keyInfo = await probe._request("/api/v1/private/account/user_info");
        } catch {
          try {
            keyInfo = await probe._request("/api/v1/private/account/detail");
          } catch {
            // Handled below if missing
          }
        }
      }

      // Check withdrawal permissions on keyInfo (PRD 5.6 E3 Security Invariant)
      if (checkMexcWithdrawalPermission(keyInfo)) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: true,
          error: "API key has withdrawal permissions enabled. For safety, delete this key and create one with Trading only.",
        };
      }

      // Query account assets to verify futures account reachable
      let assets = null;
      try {
        assets = await probe._request("/api/v1/private/account/assets");
      } catch (err) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: false,
          error: `Failed to reach MEXC futures account: ${err.message}`,
        };
      }

      // Check withdrawal permissions on assets response as well
      if (checkMexcWithdrawalPermission(assets)) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: true,
          error: "API key has withdrawal permissions enabled. For safety, delete this key and create one with Trading only.",
        };
      }

      // Verify trading permissions
      let canTrade = true;
      if (keyInfo) {
        if (keyInfo.canTrade === false || keyInfo.trade === false) {
          canTrade = false;
        }

        const permContainers = [keyInfo.permissions, keyInfo.permission, keyInfo.perms, keyInfo.scopes];
        const tokens = [];
        for (const c of permContainers) {
          if (!c) continue;
          if (typeof c === "string") tokens.push(...c.split(/[,;\s]+/));
          else if (Array.isArray(c)) {
            for (const item of c) {
              if (typeof item === "string") tokens.push(item);
              else if (typeof item === "object" && item !== null) {
                const name = String(item.name || item.perm || item.type || "").toLowerCase();
                const isReadOnly = isReadOnlyValue(item.read_only !== undefined ? item.read_only : item.readonly);
                if ((name.includes("contract") || name.includes("futures")) && isReadOnly) {
                  canTrade = false;
                }
              }
            }
          }
        }

        const normTokens = tokens.map((t) => t.trim().toLowerCase()).filter(Boolean);
        if (normTokens.length > 0) {
          const hasFutures = normTokens.some((t) =>
            t.includes("futures") || t.includes("contract") || t.includes("trade") || t.includes("deal")
          );
          if (!hasFutures) {
            canTrade = false;
          }
        }
      }

      if (!canTrade) {
        return {
          ok: false,
          canTrade: false,
          canWithdraw: false,
          error: "API key does not have Futures Trading permissions enabled on MEXC.",
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
        error: err.message || "Failed to validate MEXC credentials.",
      };
    }
  }

  /**
   * Fetch USDT balance and equity from /api/v1/private/account/assets.
   */
  async getBalance() {
    const data = await this._request("/api/v1/private/account/assets");
    let assets = [];
    if (Array.isArray(data)) {
      assets = data;
    } else if (data && Array.isArray(data.assets)) {
      assets = data.assets;
    } else if (data && typeof data === "object") {
      assets = [data];
    }

    const usdt = assets.find((a) => String(a.currency || a.asset || "").toUpperCase() === "USDT");
    if (!usdt) {
      return { availableUsdt: 0, equityUsdt: 0, walletUsdt: 0 };
    }

    const available = Number(usdt.availableBalance ?? usdt.available ?? usdt.free ?? 0);
    const equity = Number(usdt.equity ?? usdt.total ?? usdt.availableBalance ?? 0);
    const wallet = Number(usdt.cashBalance ?? usdt.walletBalance ?? available);

    return {
      availableUsdt: isNaN(available) ? 0 : available,
      equityUsdt: isNaN(equity) ? 0 : equity,
      walletUsdt: isNaN(wallet) ? 0 : wallet,
    };
  }

  /**
   * Fetch tradable USDT perpetual contracts from /api/v1/contract/detail.
   */
  async getInstruments() {
    const data = await this._request("/api/v1/contract/detail");
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : []);

    const instruments = [];
    for (const item of list) {
      if (!item) continue;
      const symbol = String(item.symbol || "");
      // Active state on MEXC is 0 (Online/Trading); symbol must end with _USDT
      const isActive = item.state === 0 || item.state === undefined;
      if (!isActive || !symbol.toUpperCase().endsWith("_USDT")) continue;

      instruments.push({
        symbol,
        baseCoin: item.baseCoin || symbol.split("_")[0],
        quoteCoin: item.quoteCoin || "USDT",
        tickSize: Number(item.priceUnit || item.tickSize || 0.1),
        lotSize: Number(item.volUnit || item.lotSize || 1),
        minNotional: Number(item.minNotional || 5),
        maxLeverage: Number(item.maxLeverage || 100),
        minQty: Number(item.minVol || item.minQty || 1),
      });
    }

    return instruments;
  }

  /**
   * Ensure account is configured for One-Way mode and Isolated margin.
   */
  async ensureAccountMode() {
    return { oneWay: true, isolated: true };
  }

  /**
   * Set leverage for symbol via /api/v1/private/position/change_leverage.
   */
  async setLeverage(symbol, leverage) {
    const lev = Math.round(Number(leverage) || 1);
    await this._request("/api/v1/private/position/change_leverage", {
      method: "POST",
      body: {
        symbol,
        leverage: lev,
        openType: 1, // Isolated
      },
    });
    this._configuredLeverage.set(symbol, lev);
  }

  /**
   * Place an immediate market order.
   * Throws if trading capability is unavailable.
   */
  async placeMarket({ symbol, side, qty, clientId, reduceOnly = false }) {
    if (!this.capabilities().trading) {
      throw new Error(this.capabilities().reason || "Futures order API unavailable at MEXC");
    }

    const isLong = side === "long";
    // MEXC side codes:
    // 1 = Open Long (buy open)
    // 2 = Close Short (buy close, reduceOnly)
    // 3 = Open Short (sell open)
    // 4 = Close Long (sell close, reduceOnly)
    const mexSide = isLong ? (reduceOnly ? 2 : 1) : (reduceOnly ? 4 : 3);
    const vol = Math.abs(Number(qty));

    const body = {
      symbol,
      price: 0,
      vol,
      side: mexSide,
      type: 5, // Market order
      openType: 1, // Isolated
      externalOid: clientId ? String(clientId).slice(0, 32) : undefined,
      reduceOnly: Boolean(reduceOnly),
    };

    const res = await this._request("/api/v1/private/order/create", {
      method: "POST",
      body,
    });

    const orderId = String(res?.orderId || res?.id || "");
    const price = Number(res?.price || res?.avgPrice || 0);

    return {
      id: orderId || clientId || "",
      orderId,
      clientId: String(clientId || ""),
      symbol,
      side,
      price,
      qty: vol,
      notional: Number(res?.notional || price * vol || 0),
      fee: Number(res?.fee || 0),
      feeAsset: "USDT",
      time: Number(res?.createTime || res?.time || Date.now()),
    };
  }

  /**
   * Place a conditional stop order for SL.
   * Throws if trading capability is unavailable.
   */
  async placeStop({ symbol, side, qty, triggerPrice, clientId, closePosition = false }) {
    if (!this.capabilities().trading) {
      throw new Error(this.capabilities().reason || "Futures order API unavailable at MEXC");
    }

    const isLong = side === "long";
    const mexSide = isLong ? (closePosition ? 4 : 1) : (closePosition ? 2 : 3);
    const vol = qty ? Math.abs(Number(qty)) : 0;

    const body = {
      symbol,
      stopPrice: Number(triggerPrice),
      triggerPrice: Number(triggerPrice),
      vol,
      side: mexSide,
      type: 5, // Market on trigger
      openType: 1,
      externalOid: clientId ? String(clientId).slice(0, 32) : undefined,
      closePosition: Boolean(closePosition),
    };

    let res;
    try {
      res = await this._request("/api/v1/private/stoporder/create", {
        method: "POST",
        body,
      });
    } catch {
      // Fallback to order create if unified
      res = await this._request("/api/v1/private/order/create", {
        method: "POST",
        body,
      });
    }

    const orderId = String(res?.orderId || res?.id || "");
    return {
      id: orderId || clientId || "",
      orderId,
      clientId: String(clientId || ""),
      symbol,
      side,
      triggerPrice: Number(triggerPrice),
      status: "NEW",
    };
  }

  /**
   * Place a reduce-only limit order (TP1 / partial exit).
   * Throws if trading capability is unavailable.
   */
  async placeReduceLimit({ symbol, side, qty, price, clientId }) {
    if (!this.capabilities().trading) {
      throw new Error(this.capabilities().reason || "Futures order API unavailable at MEXC");
    }

    const isLong = side === "long";
    const mexSide = isLong ? 4 : 2; // 4=Close Long, 2=Close Short
    const vol = Math.abs(Number(qty));

    const body = {
      symbol,
      price: Number(price),
      vol,
      side: mexSide,
      type: 1, // Limit order
      openType: 1,
      externalOid: clientId ? String(clientId).slice(0, 32) : undefined,
      reduceOnly: true,
    };

    const res = await this._request("/api/v1/private/order/create", {
      method: "POST",
      body,
    });

    const orderId = String(res?.orderId || res?.id || "");
    return {
      id: orderId || clientId || "",
      orderId,
      clientId: String(clientId || ""),
      symbol,
      side,
      price: Number(price),
      qty: vol,
      status: "NEW",
    };
  }

  /**
   * Amend active stop order trigger price.
   */
  async amendStop(ref, triggerPrice) {
    if (ref?.orderId) {
      await this.cancel(ref).catch(() => {});
    }
    return this.placeStop({
      symbol: ref.symbol,
      side: ref.side || "long",
      qty: ref.qty,
      triggerPrice,
      clientId: ref.clientId,
      closePosition: ref.closePosition ?? true,
    });
  }

  /**
   * Cancel an open order.
   */
  async cancel(ref = {}) {
    const { symbol, orderId, clientId } = ref;
    const body = orderId
      ? [String(orderId)]
      : { symbol, externalOid: clientId };

    try {
      await this._request("/api/v1/private/order/cancel", {
        method: "POST",
        body,
      });
    } catch {
      try {
        await this._request("/api/v1/private/stoporder/cancel", {
          method: "POST",
          body,
        });
      } catch {
        // Ignored if already cancelled
      }
    }
    return { ok: true };
  }

  /**
   * Cancel all open orders for symbol.
   */
  async cancelAll(symbol) {
    try {
      await this._request("/api/v1/private/order/cancel_all", {
        method: "POST",
        body: { symbol },
      });
    } catch {
      // Ignored
    }
    try {
      await this._request("/api/v1/private/stoporder/cancel_all", {
        method: "POST",
        body: { symbol },
      });
    } catch {
      // Ignored
    }
    return { ok: true };
  }

  /**
   * Get all active positions from /api/v1/private/position/open_positions.
   * Normalizes long (positionType: 1) and short (positionType: 2).
   */
  async getPositions() {
    const data = await this._request("/api/v1/private/position/open_positions");
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : []);

    const positions = [];
    for (const item of list) {
      if (!item) continue;
      const vol = Math.abs(Number(item.holdVol || item.size || 0));
      if (vol <= 0) continue;

      // positionType: 1 = Long, 2 = Short
      const side = item.positionType === 2 ? "short" : "long";
      const entryPrice = Number(item.holdAvgPrice || item.entryPrice || 0);
      const markPrice = Number(item.fairPrice || item.markPrice || entryPrice);
      const leverage = Number(item.leverage || 1);
      const unrealizedPnl = Number(item.unRealizedPnl ?? item.unrealizedPnl ?? 0);
      const liqPrice = Number(item.liquidatePrice || item.liqPrice || 0);

      positions.push({
        symbol: item.symbol,
        side,
        size: vol,
        entryPrice,
        markPrice,
        leverage,
        unrealizedPnl,
        liqPrice,
      });
    }

    return positions;
  }

  /**
   * Get open orders for symbol.
   */
  async getOpenOrders(symbol = null) {
    const params = symbol ? { symbol } : {};
    const data = await this._request("/api/v1/private/order/open_orders", { params });
    return Array.isArray(data) ? data : [];
  }

  /**
   * Get trade fills for order.
   */
  async getFills(orderRef = {}) {
    const { symbol, orderId } = orderRef;
    const params = { symbol, orderId };
    const data = await this._request("/api/v1/private/order/deals", { params }).catch(() => []);
    const list = Array.isArray(data) ? data : [];
    return list.map((d) => ({
      id: String(d.id || d.dealId || ""),
      orderId: String(d.orderId || orderId || ""),
      price: Number(d.price || d.dealPrice || 0),
      qty: Math.abs(Number(d.vol || d.dealVol || 0)),
      fee: Number(d.fee || 0),
      feeAsset: "USDT",
      time: Number(d.createTime || d.dealTime || Date.now()),
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
    const closeQty = qty !== null && qty !== undefined ? Math.min(pos.size, Math.abs(Number(qty))) : pos.size;

    return this.placeMarket({
      symbol,
      side: closeSide,
      qty: closeQty,
      clientId: `close_${Date.now()}`,
      reduceOnly: true,
    });
  }
}
