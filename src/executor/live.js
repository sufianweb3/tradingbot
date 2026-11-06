/**
 * Live Trading Executor (PRD 5.8, 6.2)
 *
 * Dispatches real orders to active ExchangeAdapter (Binance, Bybit).
 * Enforces pre-trade guardrails, mandatory exchange-side stop loss placement,
 * automated trailing stop amendments, and periodic position reconciliation.
 */

import { computeLevels, positionMetrics, roundLevel } from "../trading.js";
import { now, round, toNum, uid } from "../util.js";
import { ProtectionManager, DEFAULT_EXEC_SETTINGS } from "../core/protectionManager.js";
import { reconcileExchangeState, runAccountPreflight, resolveUnknownOrder } from "../core/reconciler.js";
import { verifyOrderUnitSanity, roundAndValidateQty } from "../core/units.js";

export class LiveExecutor {
  constructor(engine, { adapter = null } = {}) {
    this.engine = engine;
    this.mode = "live";
    this.adapter = adapter;
    this.runId = uid("run_").slice(0, 8);
    this._leverageConfigured = new Set();
    this.instruments = new Map(); // symbol -> instrument rules
    this.dailyLossExceeded = false;
    this.protectionManager = new ProtectionManager({
      settings: engine?.state?.settings?.exec || DEFAULT_EXEC_SETTINGS,
      logger: (level, msg) => engine?.log?.(level, msg),
    });
  }

  /**
   * Run preflight account verification (`FX-25`).
   */
  async runPreflight(opts = {}) {
    if (!this.adapter) {
      return { ok: false, stage: "adapter", reason: "no-adapter-connected" };
    }
    return runAccountPreflight({
      adapter: this.adapter,
      symbol: opts.symbol || "BTCUSDT",
      includeTestOrder: Boolean(opts.includeTestOrder),
      maxClockDriftMs: toNum(this.engine?.state?.settings?.exec?.clockDriftMaxMs, 2500),
    });
  }

  setAdapter(adapter) {
    this.adapter = adapter;
    this._leverageConfigured.clear();
    this.instruments.clear();
  }

  async init() {
    if (!this.adapter) {
      throw new Error("LiveExecutor requires a connected exchange adapter.");
    }
    // Load tradable instruments and precision rules
    try {
      const list = await this.adapter.getInstruments();
      for (const inst of list) {
        this.instruments.set(inst.symbol.toUpperCase(), inst);
      }
      // Ensure one-way and isolated margin
      await this.adapter.ensureAccountMode();
    } catch (err) {
      console.warn("[live-executor] Setup probe warning:", err?.message);
    }
    return { ok: true, mode: "live", exchange: this.adapter.id };
  }

  /**
   * Pre-trade checks before entering any live trade (PRD 5.8 L1).
   */
  async preTradeCheck(symbol, side, margin, notional) {
    const engine = this.engine;
    const s = engine.state.settings;
    const liveSettings = s.live || {};

    // 1. Kill switch check
    if (engine.killSwitchActive || engine.liveEnabled === false) {
      return {
        ok: false,
        reason: engine.liveEnabled === false ? "live-disabled-by-status" : "kill-switch-active",
      };
    }

    // 2. Daily loss cap guardrail (PRD L9)
    const dailyLossCap = toNum(liveSettings.dailyLossCap, 0);
    if (dailyLossCap > 0) {
      const stats = engine.getStats();
      const currentLoss = Math.min(0, toNum(stats.realizedPnl, 0) + toNum(stats.unrealizedPnl, 0));
      if (Math.abs(currentLoss) >= dailyLossCap) {
        this.dailyLossExceeded = true;
        return { ok: false, reason: `daily-loss-cap-hit ($${dailyLossCap})` };
      }
    }

    // 3. Max live open positions guardrail
    const maxLivePositions = toNum(liveSettings.maxOpenPositions, 0);
    const openLive = engine.state.positions.filter((p) => p.mode === "live").length;
    if (maxLivePositions > 0 && openLive >= maxLivePositions) {
      return { ok: false, reason: `max-live-positions-reached (${openLive}/${maxLivePositions})` };
    }

    // 4. Max margin per trade guardrail
    const maxMargin = toNum(liveSettings.marginPerTrade, 0);
    if (maxMargin > 0 && margin > maxMargin) {
      return { ok: false, reason: `margin-exceeds-live-cap ($${margin} > $${maxMargin})` };
    }

    // 5. Symbol listed on active exchange
    const inst = this.instruments.get(symbol.toUpperCase());
    if (this.instruments.size > 0 && !inst) {
      return { ok: false, reason: `symbol-not-listed-on-${this.adapter.id}` };
    }

    // 6. Minimum notional check
    if (inst && inst.minNotional && notional < inst.minNotional) {
      return { ok: false, reason: `notional-below-min ($${notional} < $${inst.minNotional})` };
    }

    // 7. Balance check
    try {
      const bal = await this.adapter.getBalance();
      if (margin > bal.availableUsdt) {
        return { ok: false, reason: `insufficient-available-usdt ($${margin} > $${bal.availableUsdt})` };
      }
    } catch (err) {
      return { ok: false, reason: `balance-check-failed: ${err?.message}` };
    }

    return { ok: true, instrument: inst };
  }

  /**
   * Open a Live position on the exchange.
   */
  async openPosition(coin, quote, evaluation, profile = null) {
    const engine = this.engine;
    if (!this.adapter) {
      engine.log("error", "Cannot open Live trade: no exchange connected.");
      return null;
    }

    const s = engine.state.settings;
    const side = evaluation.side;
    if (side !== "long" && side !== "short") return null;
    const p = profile || s.profiles?.[side] || s;

    const price = toNum(quote.price);
    if (!(price > 0)) return null;

    const sizing = engine._allocationFor(price, p);
    const margin = sizing.margin;
    let qty = sizing.qty;
    const notional = sizing.notional;

    // Run Pre-trade checks
    const check = await this.preTradeCheck(coin.symbol, side, margin, notional);
    if (!check.ok) {
      engine.log("warn", `LIVE SKIP ${coin.symbol}: ${check.reason}`);
      return null;
    }

    const inst = check.instrument;

    // Adjust lot size and precision
    if (inst && inst.lotSize) {
      const precisionSteps = Math.floor(qty / inst.lotSize);
      qty = round(precisionSteps * inst.lotSize, 8);
      if (qty < (inst.minQty || 0)) {
        engine.log("warn", `LIVE SKIP ${coin.symbol}: quantity ${qty} below minQty ${inst.minQty}`);
        return null;
      }
    }

    // 1. Ensure Leverage set for this symbol
    const targetLev = Math.min(sizing.lev, inst?.maxLeverage || sizing.lev);
    const symKey = coin.symbol.toUpperCase();
    if (!this._leverageConfigured.has(symKey)) {
      try {
        await this.adapter.setLeverage(symKey, targetLev);
        this._leverageConfigured.add(symKey);
      } catch (err) {
        engine.log("warn", `Failed to set leverage for ${symKey}: ${err.message}`);
      }
    }

    // Compute SL and TP levels
    const levels = computeLevels({ side, entry: price, settings: { ...s, ...p } });
    const slPrice = inst?.tickSize ? roundLevel(levels.slPrice, inst.tickSize) : round(levels.slPrice, 4);
    const tp1Price = inst?.tickSize ? roundLevel(levels.tp1Price, inst.tickSize) : round(levels.tp1Price, 4);
    const clientId = `live_${this.runId}_${Date.now()}_${coin.symbol}`;

    engine.log("info", `LIVE SUBMIT ${side.toUpperCase()} ${coin.symbol} qty=${qty} lev=${targetLev}x @ ~$${price}`);

    let fill;
    try {
      fill = await this.adapter.placeMarket({
        symbol: symKey,
        side,
        qty,
        clientId,
        sl: this.adapter.id === "bybit" ? slPrice : null, // Bybit attached SL
      });
    } catch (err) {
      engine.log("error", `LIVE ORDER FAILED for ${coin.symbol}: ${err.message}`);
      return null;
    }

    const fillPrice = fill.price > 0 ? fill.price : price;
    const filledQty = fill.qty > 0 ? fill.qty : qty;
    const filledNotional = fillPrice * filledQty;

    const pos = {
      id: uid("pos_live_"),
      mode: "live",
      status: "open",
      symbol: coin.symbol,
      exchangeSymbol: symKey,
      side,
      profile: side,
      venue: this.adapter.id,
      venueName: this.adapter.name,
      venueSymbol: symKey,
      base: coin.symbol,
      source: "exchange-live",
      entryTime: now(),
      entryPrice: fillPrice,
      signalPrice: price,
      qty: filledQty,
      originalQty: filledQty,
      margin: round(filledNotional / targetLev, 4),
      notional: round(filledNotional, 4),
      leverage: targetLev,
      entryFee: fill.fee || 0,
      grossPnl: 0,
      exitFees: 0,
      exitQty: 0,
      exitNotional: 0,
      partials: [],
      slPrice,
      initialSlPrice: slPrice,
      tp1Price,
      tpMaxPrice: levels.tpMaxPrice,
      liqPrice: levels.liqPrice,
      tp1Hit: false,
      trailingActive: levels.trailingActive,
      peakPrice: fillPrice,
      troughPrice: fillPrice,
      markPrice: fillPrice,
      unrealizedPnl: 0,
      unrealizedRoe: 0,
      orderIds: [fill.id],
      protection: {
        slOrderId: null,
        tp1OrderId: null,
      },
      evaluation,
    };

    // 2. Exchange-Side Stop Loss Placement (PRD 5.8 L3)
    // Mandatory: if not natively attached, place immediately. If placement fails, CLOSE MARKET!
    if (this.adapter.id !== "bybit") {
      try {
        const slOrder = await this.adapter.placeStop({
          symbol: symKey,
          side,
          qty: filledQty,
          triggerPrice: slPrice,
          clientId: `sl_${pos.id}`,
          closePosition: true,
        });
        pos.protection.slOrderId = slOrder.id;
        engine.log("info", `LIVE SL PLACED for ${coin.symbol} @ $${slPrice} (Order ${slOrder.id})`);
      } catch (err) {
        engine.log("error", `CRITICAL: Live SL placement failed for ${coin.symbol} (${err.message}). CLOSING POSITION AT MARKET!`);
        try {
          await this.adapter.closePosition(symKey);
        } catch (closeErr) {
          engine.log("error", `EMERGENCY: Failed to market close unsecured position ${coin.symbol}: ${closeErr.message}`);
        }
        return null;
      }
    } else {
      pos.protection.slOrderId = "attached_bybit";
    }

    // 3. Place TP1 Reduce-Only Limit Order (PRD 5.8 L4)
    if (tp1Price > 0 && (p.tp1ClosePercent || 50) > 0) {
      const tp1Qty = round((filledQty * (toNum(p.tp1ClosePercent, 50) / 100)), 8);
      if (tp1Qty > 0) {
        try {
          const tpOrder = await this.adapter.placeReduceLimit({
            symbol: symKey,
            side,
            qty: tp1Qty,
            price: tp1Price,
            clientId: `tp1_${pos.id}`,
          });
          pos.protection.tp1OrderId = tpOrder.id;
          engine.log("info", `LIVE TP1 PLACED for ${coin.symbol}: ${tp1Qty} @ $${tp1Price} (Order ${tpOrder.id})`);
        } catch (err) {
          engine.log("warn", `Could not place exchange-side TP1 for ${coin.symbol}: ${err.message}`);
        }
      }
    }

    engine.state.positions.push(pos);
    engine.emit("position:open", pos);
    engine._persist();
    return pos;
  }

  /**
   * Close a Live position on the exchange.
   */
  async closePosition(pos, price, reason = "Manual") {
    const engine = this.engine;
    if (!this.adapter) return null;

    const symKey = pos.exchangeSymbol || pos.symbol.toUpperCase();

    // Cancel conditional orders first
    try {
      await this.adapter.cancelAll(symKey);
    } catch (err) {
      console.warn(`[live-executor] cancelAll error on close for ${symKey}:`, err?.message);
    }

    // Send market close order
    let fill = null;
    try {
      fill = await this.adapter.closePosition(symKey, pos.qty);
    } catch (err) {
      engine.log("error", `LIVE CLOSE FAILED for ${symKey}: ${err.message}`);
    }

    const closePrice = fill?.price > 0 ? fill.price : price;
    return engine._closePosition(pos, closePrice, reason, { force: true });
  }

  /**
   * Move exchange-side stop loss for trailing stop (PRD 5.8 L5).
   */
  async updateTrailingStop(pos, currentPrice) {
    const engine = this.engine;
    const oldSl = pos.slPrice;
    engine._updateTrailing(pos, currentPrice);

    // If SL moved, amend the exchange-side stop order
    if (pos.slPrice !== oldSl && this.adapter) {
      const symKey = pos.exchangeSymbol || pos.symbol.toUpperCase();
      try {
        if (typeof this.adapter.amendStop === "function") {
          await this.adapter.amendStop(
            { symbol: symKey, orderId: pos.protection?.slOrderId, side: pos.side },
            pos.slPrice
          );
        } else if (typeof this.adapter.placeStop === "function") {
          await this.adapter.placeStop(
            symKey,
            pos.side === "long" ? "sell" : "buy",
            pos.slPrice,
            pos.qty
          );
        }
        engine.log("info", `LIVE TRAILING STOP AMENDED for ${pos.symbol} -> $${round(pos.slPrice, 4)}`);
      } catch (err) {
        console.warn(`[live-executor] Failed to amend trailing stop on ${symKey}:`, err?.message);
      }
    }
  }

  /**
   * Reconcile live positions and orders against the exchange (PRD 5.8 L7).
   */
  async reconcile() {
    if (!this.adapter) return { reconciled: 0, orphans: 0 };
    const engine = this.engine;

    let exchangePositions = [];
    try {
      exchangePositions = await this.adapter.getPositions();
    } catch (err) {
      console.warn("[live-executor] Reconcile query failed:", err?.message);
      return { reconciled: 0, orphans: 0, error: err?.message };
    }

    let reconciled = 0;
    let orphans = 0;

    // Check exchange positions against internal state
    const exSymbols = new Set();
    let closedExternally = 0;
    for (const exPos of exchangePositions) {
      exSymbols.add(exPos.symbol.toUpperCase());
      const match = engine.state.positions.find(
        (p) => p.mode === "live" && (p.symbol.toUpperCase() === exPos.symbol.toUpperCase() || p.exchangeSymbol?.toUpperCase() === exPos.symbol.toUpperCase())
      );

      if (match) {
        // Update live stats from exchange
        match.markPrice = exPos.markPrice || match.markPrice;
        match.unrealizedPnl = exPos.unrealizedPnl;
        match.liqPrice = exPos.liqPrice || match.liqPrice;
        reconciled++;
      } else {
        // Orphan position detected on exchange
        orphans++;
        engine.log("warn", `RECONCILE ORPHAN: Exchange has unmanaged ${exPos.side.toUpperCase()} ${exPos.symbol} (size ${exPos.size})`);
      }
    }

    // Detect positions closed externally on the exchange (`FX-24`, `EC-37`)
    const livePositions = engine.state.positions.filter((p) => p.mode === "live" && p.status === "open");
    for (const localPos of livePositions) {
      const symKey = (localPos.exchangeSymbol || localPos.symbol || "").toUpperCase();
      if (exchangePositions.length > 0 && !exSymbols.has(symKey) && !exSymbols.has(localPos.symbol.toUpperCase())) {
        closedExternally++;
        engine.log("warn", `RECONCILE CLOSED EXTERNALLY: ${localPos.symbol} no longer open on ${this.adapter.id}`);
      }
    }

    return { reconciled, orphans, closedExternally };
  }

  /**
   * Panic: cancel all orders and market-close all positions on exchange (PRD 5.8 L10).
   */
  async panic() {
    const engine = this.engine;
    engine.log("warn", "PANIC TRIGGERED: Cancelling all orders and market closing all Live positions!");
    engine.killSwitchActive = true;

    if (this.adapter) {
      const livePositions = engine.state.positions.filter((p) => p.mode === "live");
      for (const pos of livePositions) {
        try {
          const symKey = pos.exchangeSymbol || pos.symbol.toUpperCase();
          await this.adapter.cancelAll(symKey);
          await this.adapter.closePosition(symKey);
        } catch (err) {
          engine.log("error", `Panic close failed for ${pos.symbol}: ${err.message}`);
        }
      }
    }

    return engine.closeAll("Panic button triggered");
  }
}
