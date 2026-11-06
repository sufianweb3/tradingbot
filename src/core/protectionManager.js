/**
 * Exchange-Side Protection Manager & 4-Rung Controlled Exit Ladder
 *
 * Implements Section 5.3 (FX-21) and Section 5.4 (FX-22a..h) and Section 8.3 (EC-27..EC-34).
 */

import { round, toNum } from "../util.js";
import {
  checkSlLiquidationBuffer,
  roundAndValidateStopPrice,
  splitTp1Quantities,
} from "./units.js";

export const DEFAULT_EXEC_SETTINGS = {
  entryOrderType: "ioc-limit", // "ioc-limit" | "market"
  maxEntrySlippageBps: 25,
  retryEntryOnce: false,
  slTriggerBy: "mark", // "mark" | "last"
  stopMinDistanceTicks: 2,
  slLiqBuffer: 0.25,
  trailMinStepTicks: 2,
  trailMinIntervalMs: 2000,
  exitLadder: true,
  exitLadderRungs: [
    { maxImpactBps: 25, weight: 0.4 },
    { maxImpactBps: 45, weight: 0.35 },
    { maxImpactBps: 70, weight: 0.25 },
  ],
  orphanAction: "alert", // "alert" | "close" | "adopt"
  reconcileIntervalMs: 15000,
};

export class ProtectionManager {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_EXEC_SETTINGS, ...(settings?.exec || settings || {}) };
    this.lastTrailUpdateAt = new Map(); // posId -> timestamp
  }

  updateSettings(patch = {}) {
    this.settings = { ...this.settings, ...(patch?.exec || patch || {}) };
  }

  /**
   * Place initial SL and TP1 protection for a newly filled position (FX-20 step 7-8, FX-22a, FX-22e, FX-22h).
   * If SL placement fails after retry, executes immediate emergency market close!
   */
  async placeInitialProtection({
    pos,
    adapter,
    instrument = {},
    markPrice = null,
    settings = {},
    onLog = () => {},
  }) {
    const cfg = { ...this.settings, ...(settings?.exec || {}) };
    const symKey = pos.exchangeSymbol || pos.symbol;
    const tickSize = toNum(instrument?.tickSize, 0.0001);
    const currentMark = toNum(markPrice ?? pos.markPrice, pos.entryPrice);

    // 1. Liquidation proximity check (FX-22h, EC-29)
    let rawSl = pos.slPrice;
    if (pos.liqPrice > 0) {
      const liqCheck = checkSlLiquidationBuffer({
        side: pos.side,
        entryPrice: pos.entryPrice,
        slPrice: rawSl,
        liqPrice: pos.liqPrice,
        slLiqBuffer: cfg.slLiqBuffer,
      });
      if (!liqCheck.ok && liqCheck.suggestedSlPrice > 0) {
        onLog("warn", `${pos.symbol}: tightening SL to respect liquidation buffer (${liqCheck.reason}).`);
        rawSl = liqCheck.suggestedSlPrice;
      }
    }

    // 2. Stop trigger validity pre-check (FX-22e, EC-09, EC-28)
    const stopCheck = roundAndValidateStopPrice({
      side: pos.side,
      rawStopPrice: rawSl,
      entryPrice: pos.entryPrice,
      markPrice: currentMark,
      tickSize,
      stopMinDistanceTicks: cfg.stopMinDistanceTicks,
    });

    if (!stopCheck.ok) {
      if (stopCheck.reason === "stop-too-close-to-mark") {
        // EC-28: Mark has already crossed or is within min ticks of SL during entry -> close immediately at market!
        onLog("error", `CRITICAL: ${pos.symbol} mark (${currentMark}) already crossed SL (${rawSl}). Closing at market!`);
        await adapter.closePosition(symKey, pos.qty).catch(() => {});
        return { ok: false, emergencyClosed: true, reason: stopCheck.reason };
      }
    }

    const validSlPrice = stopCheck.stopPrice > 0 ? stopCheck.stopPrice : rawSl;
    pos.slPrice = validSlPrice;
    pos.initialSlPrice = validSlPrice;

    // 3. Place Exchange-Side Stop-Loss (unless already attached on entry)
    let slPlaced = Boolean(pos.protection?.slOrderId && pos.protection.slOrderId !== "pending");
    let slOrder = null;

    if (!slPlaced) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          slOrder = await adapter.placeStop({
            symbol: symKey,
            side: pos.side,
            qty: pos.qty,
            triggerPrice: validSlPrice,
            triggerBy: cfg.slTriggerBy,
            clientId: `sl_${pos.id}_${attempt}`,
            closePosition: true,
            reduceOnly: true,
          });
          if (slOrder && (slOrder.id || slOrder.orderId)) {
            pos.protection = pos.protection || {};
            pos.protection.slOrderId = slOrder.id || slOrder.orderId;
            slPlaced = true;
            break;
          }
        } catch (err) {
          onLog("warn", `SL placement attempt ${attempt + 1} failed for ${pos.symbol}: ${err.message}`);
        }
      }
    }

    // Mandatory invariant: if SL cannot be placed within 2 attempts, emergency close position at market!
    if (!slPlaced) {
      onLog("error", `CRITICAL: SL placement failed for ${pos.symbol}. Executing emergency market close!`);
      try {
        await adapter.closePosition(symKey, pos.qty);
      } catch (closeErr) {
        onLog("error", `EMERGENCY: Failed to close unprotected position ${pos.symbol}: ${closeErr.message}`);
      }
      return { ok: false, emergencyClosed: true, reason: "protection-failed" };
    }

    // 4. Split TP1 and Runner quantities (EC-08, FX-22c)
    const split = splitTp1Quantities(pos.qty, pos.tp1ClosePercent ?? 50, instrument, pos.entryPrice);
    pos.protection = pos.protection || {};
    pos.protection.tp1Split = split;

    if (split.canSplit && pos.tp1Price > 0) {
      try {
        const tpOrder = await adapter.placeReduceLimit({
          symbol: symKey,
          side: pos.side,
          qty: split.tp1Qty,
          price: pos.tp1Price,
          clientId: `tp1_${pos.id}`,
          reduceOnly: true,
        });
        pos.protection.tp1OrderId = tpOrder.id || tpOrder.orderId;
        pos.protection.tp1Qty = split.tp1Qty;
        pos.protection.runnerQty = split.runnerQty;
      } catch (err) {
        onLog("warn", `Could not place TP1 reduce-only limit for ${pos.symbol}: ${err.message}`);
      }
    }

    return {
      ok: true,
      slOrderId: pos.protection.slOrderId,
      tp1OrderId: pos.protection.tp1OrderId || null,
      slPrice: validSlPrice,
    };
  }

  /**
   * Never-Unprotected Stop Update (FX-22b, FX-22d, FX-22e):
   * Throttles trailing updates by trailMinStepTicks and trailMinIntervalMs,
   * validates stop distance vs mark, and places the new stop BEFORE cancelling the old stop
   * when atomic amend is unavailable.
   */
  async updateTrailingStopProtected({
    pos,
    newStopPrice,
    markPrice,
    adapter,
    instrument = {},
    force = false,
  }) {
    if (!pos || !adapter) return { updated: false, reason: "missing-pos-or-adapter" };
    const cfg = this.settings;
    const tickSize = Math.max(1e-12, toNum(instrument?.tickSize, 0.0001));
    const oldStop = toNum(pos.slPrice, 0);
    const mark = toNum(markPrice ?? pos.markPrice, pos.entryPrice);
    const isLong = pos.side !== "short";

    // Ensure stop only moves in favorable direction
    if (oldStop > 0 && !force) {
      if (isLong && newStopPrice <= oldStop) return { updated: false, reason: "not-improved" };
      if (!isLong && newStopPrice >= oldStop) return { updated: false, reason: "not-improved" };
    }

    // Validate new stop price against mark (FX-22e)
    const stopCheck = roundAndValidateStopPrice({
      side: pos.side,
      rawStopPrice: newStopPrice,
      entryPrice: 0, // trailing stop can move past entry into profit
      markPrice: mark,
      tickSize,
      stopMinDistanceTicks: cfg.stopMinDistanceTicks,
    });

    if (!stopCheck.ok) {
      if (stopCheck.reason === "stop-too-close-to-mark") {
        // Price already crossed trailing stop -> trigger market close
        return { updated: false, crossedMark: true, reason: "stop-crossed-mark" };
      }
      return { updated: false, reason: stopCheck.reason };
    }

    const roundedStop = stopCheck.stopPrice;
    const stepDiff = Math.abs(roundedStop - oldStop);
    const minStep = Math.max(1, toNum(cfg.trailMinStepTicks, 2)) * tickSize;
    const nowMs = Date.now();
    const lastUpd = this.lastTrailUpdateAt.get(pos.id) || 0;
    const nearStop = mark > 0 && Math.abs(mark - roundedStop) / mark <= 0.003;

    // Throttle check (FX-22d)
    if (!force && !nearStop) {
      if (stepDiff < minStep - 1e-12) {
        return { updated: false, reason: "below-min-step-ticks" };
      }
      if (nowMs - lastUpd < toNum(cfg.trailMinIntervalMs, 2000)) {
        return { updated: false, reason: "throttled-interval" };
      }
    }

    const symKey = pos.exchangeSymbol || pos.symbol;
    const caps = typeof adapter.capabilities === "function" ? adapter.capabilities() : {};
    const oldOrderId = pos.protection?.slOrderId;

    // FX-22b: Atomic amend if supported, else Place-New-Then-Cancel-Old!
    if (caps.atomicAmend && typeof adapter.amendStop === "function" && oldOrderId) {
      const amended = await adapter.amendStop(
        { symbol: symKey, orderId: oldOrderId, side: pos.side, qty: pos.qty },
        roundedStop
      );
      pos.slPrice = roundedStop;
      pos.trailStopPrice = roundedStop;
      if (amended?.id || amended?.orderId) {
        pos.protection = pos.protection || {};
        pos.protection.slOrderId = amended.id || amended.orderId;
      }
      this.lastTrailUpdateAt.set(pos.id, nowMs);
      return { updated: true, method: "atomic-amend", stopPrice: roundedStop };
    }

    // Place new SL FIRST before cancelling old SL (Never-Unprotected Rule FX-22b)
    const newOrder = await adapter.placeStop({
      symbol: symKey,
      side: pos.side,
      qty: pos.qty,
      triggerPrice: roundedStop,
      triggerBy: cfg.slTriggerBy,
      clientId: `trail_${pos.id}_${nowMs}`,
      closePosition: true,
      reduceOnly: true,
    });

    if (!newOrder || (!newOrder.id && !newOrder.orderId)) {
      return { updated: false, reason: "new-stop-placement-failed" };
    }

    // Only after new SL is confirmed active, cancel old SL
    if (oldOrderId && oldOrderId !== "attached_bybit" && oldOrderId !== (newOrder.id || newOrder.orderId)) {
      await adapter.cancel({ symbol: symKey, orderId: oldOrderId }).catch(() => {});
    }

    pos.slPrice = roundedStop;
    pos.trailStopPrice = roundedStop;
    pos.protection = pos.protection || {};
    pos.protection.slOrderId = newOrder.id || newOrder.orderId;
    this.lastTrailUpdateAt.set(pos.id, nowMs);

    return {
      updated: true,
      method: "place-new-then-cancel-old",
      stopPrice: roundedStop,
      slOrderId: pos.protection.slOrderId,
    };
  }

  /**
   * Handle TP1 fill transition to Runner protection (FX-22c, EC-31).
   * Resizes SL to runnerQty (using Never-Unprotected sequence) and places TP Max reduce-only order.
   */
  async handleTp1Fill({ pos, filledTp1Qty, adapter, instrument = {}, markPrice = null }) {
    if (!pos || !adapter) return { ok: false };
    const symKey = pos.exchangeSymbol || pos.symbol;
    const runnerQty = Math.max(0, round(toNum(pos.originalQty ?? pos.qty, 0) - toNum(filledTp1Qty, 0), 8));
    pos.qty = runnerQty;
    pos.tp1Hit = true;
    pos.tp1Time = Date.now();

    if (runnerQty <= 1e-12) {
      await adapter.cancelAll(symKey).catch(() => {});
      return { ok: true, runnerQty: 0, closed: true };
    }

    // Activate trailing stop if trailingStart === "tp1"
    const dir = pos.side === "short" ? -1 : 1;
    let nextSl = pos.slPrice;
    if (pos.trailingEnabled && pos.trailingStart === "tp1") {
      const peak = toNum(pos.peakPrice, toNum(markPrice, pos.entryPrice));
      const move = toNum(pos.trailMove, 0.01);
      const rawTrail = dir > 0 ? peak * (1 - move) : peak * (1 + move);
      pos.trailingActive = true;
      nextSl = dir > 0 ? Math.max(pos.slPrice, rawTrail) : Math.min(pos.slPrice, rawTrail);
    }

    // Update SL for runner quantity using Never-Unprotected rule
    await this.updateTrailingStopProtected({
      pos,
      newStopPrice: nextSl,
      markPrice: markPrice ?? pos.markPrice,
      adapter,
      instrument,
      force: true,
    });

    // Place TP Max reduce-only limit order for runnerQty if configured
    if (pos.tpMaxPrice > 0) {
      try {
        const tpMaxOrder = await adapter.placeReduceLimit({
          symbol: symKey,
          side: pos.side,
          qty: runnerQty,
          price: pos.tpMaxPrice,
          clientId: `tpmax_${pos.id}`,
          reduceOnly: true,
        });
        pos.protection = pos.protection || {};
        pos.protection.tpMaxOrderId = tpMaxOrder.id || tpMaxOrder.orderId;
      } catch {
        /* optional runner TP Max order */
      }
    }

    return {
      ok: true,
      runnerQty,
      slPrice: pos.slPrice,
      tpMaxOrderId: pos.protection?.tpMaxOrderId || null,
    };
  }

  /**
   * Controlled 4-Rung Exit Ladder for Live positions (Section 5.3 FX-21).
   * Slices exit across IOC limit rungs (+25, +45, +70 bps) before market cleanup.
   */
  async executeExitLadder({
    adapter,
    symbol,
    side,
    totalQty,
    bestExitPrice,
    instrument = {},
    rungs = null,
  }) {
    const activeRungs = Array.isArray(rungs) && rungs.length > 0 ? rungs : this.settings.exitLadderRungs;
    const isLong = side !== "short";
    const dir = isLong ? 1 : -1;
    const stepSize = Math.max(1e-12, toNum(instrument.lotSize ?? instrument.stepSize, 1e-8));
    const minQty = Math.max(0, toNum(instrument.minQty, stepSize));
    const tickSize = Math.max(1e-12, toNum(instrument.tickSize, 0.0001));
    const priceDecimals = Math.max(0, Math.ceil(-Math.log10(tickSize)));
    const qtyDecimals = Math.max(0, Math.ceil(-Math.log10(stepSize)));

    let remaining = toNum(totalQty, 0);
    const fills = [];
    const caps = typeof adapter.capabilities === "function" ? adapter.capabilities() : {};

    if (this.settings.exitLadder && bestExitPrice > 0 && caps.ioc && typeof adapter.placeIocLimit === "function") {
      for (let i = 0; i < activeRungs.length; i++) {
        if (remaining < minQty) break;
        const r = activeRungs[i];
        const rawRungQty = totalQty * toNum(r.weight, 0.33);
        const steps = Math.floor(( Math.min(remaining, rawRungQty) + 1e-12) / stepSize);
        const rungQty = Number((steps * stepSize).toFixed(Math.min(12, qtyDecimals + 2)));
        if (rungQty < minQty) continue;

        const maxImpBps = toNum(r.maxImpactBps, 25);
        const rawLimit = bestExitPrice * (1 - dir * (maxImpBps / 10000));
        const limitPrice = Number((Math.round(rawLimit / tickSize) * tickSize).toFixed(Math.min(12, priceDecimals + 2)));

        try {
          const fill = await adapter.placeIocLimit({
            symbol,
            side: isLong ? "short" : "long",
            qty: rungQty,
            price: limitPrice,
            reduceOnly: true,
            clientId: `exit_r${i + 1}_${Date.now()}`,
          });
          const filled = toNum(fill?.filledQty ?? fill?.qty, 0);
          if (filled > 0) {
            remaining = Math.max(0, Number((remaining - filled).toFixed(Math.min(12, qtyDecimals + 2))));
            fills.push({ rung: i + 1, qty: filled, price: toNum(fill.price, limitPrice) });
          }
        } catch {
          /* proceed to next rung or market cleanup */
        }
      }
    }

    // Rung 4: Cleanup remaining quantity with reduce-only Market order
    if (remaining >= minQty || fills.length === 0) {
      const cleanupQty = remaining >= minQty ? remaining : totalQty;
      const mktFill = await adapter.closePosition(symbol, cleanupQty);
      if (mktFill) {
        fills.push({
          rung: 4,
          qty: toNum(mktFill.qty, cleanupQty),
          price: toNum(mktFill.price, bestExitPrice),
        });
        remaining = 0;
      }
    }

    let totalFilled = 0;
    let totalNotional = 0;
    for (const f of fills) {
      totalFilled += f.qty;
      totalNotional += f.qty * f.price;
    }

    return {
      ok: totalFilled > 0,
      filledQty: totalFilled,
      vwap: totalFilled > 0 ? totalNotional / totalFilled : bestExitPrice,
      fills,
    };
  }

  /**
   * Periodic Orphan Order Sweep (FX-22g, EC-27):
   * Cancels any open orders on symbols with zero open position.
   */
  async sweepOrphanOrders(adapter, openPositions = []) {
    if (!adapter || typeof adapter.getOpenOrders !== "function") {
      return { swept: 0, symbols: [] };
    }
    const activeSymbols = new Set(
      openPositions
        .filter((p) => p && p.status === "open" && toNum(p.qty, 0) > 0)
        .map((p) => String(p.exchangeSymbol || p.symbol || "").toUpperCase())
    );

    const openOrders = await adapter.getOpenOrders().catch(() => []);
    const orphanSymbols = new Set();

    for (const ord of Array.isArray(openOrders) ? openOrders : []) {
      const sym = String(ord?.symbol || ord?.contract || "").toUpperCase();
      if (sym && !activeSymbols.has(sym)) {
        orphanSymbols.add(sym);
      }
    }

    for (const sym of orphanSymbols) {
      await adapter.cancelAll(sym).catch(() => {});
    }

    return {
      swept: orphanSymbols.size,
      symbols: [...orphanSymbols],
    };
  }
}
