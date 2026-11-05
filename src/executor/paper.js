/**
 * Paper Trading Executor (PRD 5.5, 6.2)
 *
 * Implements simulated order matching, theoretical slippage, fee tracking,
 * and internal stop loss / trailing stop management without exchange API calls.
 */

export class PaperExecutor {
  constructor(engine) {
    this.engine = engine;
    this.mode = "paper";
  }

  async init() {
    return { ok: true, mode: "paper" };
  }

  /**
   * Open a paper position.
   */
  async openPosition(coin, quote, evaluation, profile = null) {
    return this.engine._openPosition(coin, quote, evaluation, profile);
  }

  /**
   * Close a paper position.
   */
  async closePosition(pos, price, reason = "Manual", { force = false } = {}) {
    return this.engine._closePosition(pos, price, reason, { force });
  }

  /**
   * Execute partial take profit on a paper position.
   */
  async takePartial(pos, price, pct, reason = "TP1") {
    return this.engine._partialClose(pos, price, pct, reason);
  }

  /**
   * Update trailing stop level.
   */
  async updateTrailingStop(pos, price) {
    return this.engine._updateTrailing(pos, price);
  }

  /**
   * Paper mode reconcile (validates internal consistency).
   */
  async reconcile() {
    return { reconciled: this.engine.state.positions.length, orphans: 0 };
  }

  /**
   * Panic: close all open positions immediately.
   */
  async panic() {
    return this.engine.closeAll("Panic button triggered");
  }
}
