/**
 * ExchangeAdapter Base Interface (PRD 6.3)
 *
 * All exchange connectors (Binance, Bybit, Gate, KuCoin, MEXC) MUST implement
 * this unified contract.
 */

export class ExchangeAdapter {
  constructor({ apiKey = "", secret = "", testnet = false, fetchFn = null } = {}) {
    this.id = "base";
    this.name = "Base Adapter";
    this.apiKey = apiKey;
    this.secret = secret;
    this.testnet = Boolean(testnet);
    this.fetch = fetchFn || globalThis.fetch.bind(globalThis);
  }

  /**
   * Return venue execution capabilities.
   * @returns {{ trading: boolean, reason?: string }}
   */
  capabilities() {
    return { trading: true };
  }

  /**
   * Validate credentials and permissions.
   * MANDATORY SECURITY CHECK (PRD 5.6 E3):
   * MUST reject credentials if withdrawal permissions are enabled!
   * @param {{ apiKey: string, secret: string, passphrase?: string }} creds
   * @returns {Promise<{ ok: boolean, canTrade: boolean, canWithdraw: boolean, error?: string }>}
   */
  async validateKey(_creds) {
    throw new Error(`validateKey() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Fetch USDT balance and equity.
   * @returns {Promise<{ availableUsdt: number, equityUsdt: number, walletUsdt?: number }>}
   */
  async getBalance() {
    throw new Error(`getBalance() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Fetch tradable linear instruments and rules (lot size, tick size, min notional, max leverage).
   * @returns {Promise<Array<{ symbol: string, baseCoin: string, quoteCoin: string, tickSize: number, lotSize: number, minNotional: number, maxLeverage: number, minQty: number }>>}
   */
  async getInstruments() {
    throw new Error(`getInstruments() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Ensure account is configured for One-Way mode and Isolated margin.
   * @returns {Promise<{ oneWay: boolean, isolated: boolean }>}
   */
  async ensureAccountMode() {
    throw new Error(`ensureAccountMode() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Set leverage for a symbol. Clamps to symbol max leverage if needed.
   * @param {string} symbol
   * @param {number} leverage
   */
  async setLeverage(_symbol, _leverage) {
    throw new Error(`setLeverage() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Place an immediate market order.
   * @param {{ symbol: string, side: 'long'|'short', qty: number, clientId: string, reduceOnly?: boolean, sl?: number, tp?: number }} o
   * @returns {Promise<{ id: string, orderId: string, symbol: string, side: string, price: number, qty: number, notional: number, fee: number, feeAsset: string, time: number }>}
   */
  async placeMarket(_o) {
    throw new Error(`placeMarket() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Place an exchange-side stop loss conditional order.
   * @param {{ symbol: string, side: 'long'|'short', qty?: number, closePosition?: boolean, triggerPrice: number, clientId: string }} o
   * @returns {Promise<{ id: string, orderId: string, clientId: string, symbol: string, side: string, triggerPrice: number, status: string }>}
   */
  async placeStop(_o) {
    throw new Error(`placeStop() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Place a reduce-only limit order (e.g. for TP1).
   * @param {{ symbol: string, side: 'long'|'short', qty: number, price: number, clientId: string }} o
   * @returns {Promise<{ id: string, orderId: string, clientId: string, symbol: string, side: string, price: number, qty: number, status: string }>}
   */
  async placeReduceLimit(_o) {
    throw new Error(`placeReduceLimit() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Amend/move an active stop loss order trigger price (for trailing stop).
   * @param {{ orderId?: string, clientId?: string, symbol: string }} ref
   * @param {number} triggerPrice
   */
  async amendStop(_ref, _triggerPrice) {
    throw new Error(`amendStop() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Cancel a specific order.
   * @param {{ orderId?: string, clientId?: string, symbol: string }} ref
   */
  async cancel(_ref) {
    throw new Error(`cancel() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Cancel all open and conditional orders for a symbol.
   * @param {string} symbol
   */
  async cancelAll(_symbol) {
    throw new Error(`cancelAll() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Get all active positions for this venue.
   * @returns {Promise<Array<{ symbol: string, side: 'long'|'short', size: number, entryPrice: number, markPrice: number, leverage: number, unrealizedPnl: number, liqPrice: number }>>}
   */
  async getPositions() {
    throw new Error(`getPositions() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Get all open orders for symbol.
   */
  async getOpenOrders(_symbol) {
    throw new Error(`getOpenOrders() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Get trade fills for an order.
   */
  async getFills(_orderRef) {
    throw new Error(`getFills() must be implemented by ${this.id} adapter.`);
  }

  /**
   * Close a position with an immediate market order.
   * @param {string} symbol
   * @param {number} [qty]
   */
  async closePosition(_symbol, _qty = null) {
    throw new Error(`closePosition() must be implemented by ${this.id} adapter.`);
  }
}
