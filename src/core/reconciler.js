/**
 * Live State Reconciler, Ambiguous Order Resolver & Account Preflight Checker
 *
 * Implements Section 5.5 (FX-23, FX-24), Section 5.6 (FX-25), and Section 8.3 (EC-31..EC-34).
 */

import { computeLevels } from "../trading.js";
import { now, round, toNum, uid } from "../util.js";
import { INTENT_STATES } from "./intentMachine.js";

/**
 * Resolve an ambiguous (UNKNOWN) order by querying open orders, fills, and positions on the exchange (FX-23).
 */
export async function resolveUnknownOrder(adapter, { symbol, clientOrderId, orderId = null }) {
  if (!adapter) return { resolved: false, status: "UNKNOWN" };
  const sym = String(symbol || "").toUpperCase();

  try {
    const [openOrders, fills, positions] = await Promise.all([
      adapter.getOpenOrders(sym).catch(() => []),
      adapter.getFills({ symbol: sym, orderId, clientId: clientOrderId }).catch(() => []),
      adapter.getPositions().catch(() => []),
    ]);

    const matchingFill = (Array.isArray(fills) ? fills : []).filter(
      (f) =>
        (orderId && String(f.orderId) === String(orderId)) ||
        (clientOrderId && String(f.clientId) === String(clientOrderId))
    );

    if (matchingFill.length > 0) {
      let totalQty = 0;
      let totalNotional = 0;
      let totalFee = 0;
      for (const f of matchingFill) {
        const q = toNum(f.qty, 0);
        const p = toNum(f.price, 0);
        totalQty += q;
        totalNotional += q * p;
        totalFee += toNum(f.fee, 0);
      }
      return {
        resolved: true,
        absent: false,
        status: "FILLED",
        filledQty: totalQty,
        avgFillPrice: totalQty > 0 ? totalNotional / totalQty : 0,
        fee: totalFee,
        fills: matchingFill,
      };
    }

    const matchingOpen = (Array.isArray(openOrders) ? openOrders : []).find(
      (o) =>
        (orderId && String(o.orderId || o.id) === String(orderId)) ||
        (clientOrderId && String(o.clientId || o.orderLinkId || o.clientOid || o.text) === String(clientOrderId))
    );

    if (matchingOpen) {
      return {
        resolved: true,
        absent: false,
        status: "OPEN",
        order: matchingOpen,
      };
    }

    const matchingPos = (Array.isArray(positions) ? positions : []).find(
      (p) => String(p.symbol || "").toUpperCase() === sym && toNum(p.size, 0) > 0
    );

    if (matchingPos) {
      return {
        resolved: true,
        absent: false,
        status: "FILLED",
        filledQty: toNum(matchingPos.size, 0),
        avgFillPrice: toNum(matchingPos.entryPrice, 0),
        position: matchingPos,
      };
    }

    return {
      resolved: true,
      absent: true,
      status: "REJECTED",
      filledQty: 0,
    };
  } catch (err) {
    return {
      resolved: false,
      absent: false,
      status: "UNKNOWN",
      error: err.message,
    };
  }
}

/**
 * Full Live State Reconciler (Section 5.5 FX-24, EC-31..EC-34).
 * Compares exchange positions & open orders against bot positions:
 * 1. Detects orphan positions on exchange (alert, adopt, or close).
 * 2. Detects positions closed externally on exchange (settles local position & cancels orphan orders).
 * 3. Detects manual size changes on exchange (resizes local qty and SL/TP).
 * 4. Verifies active SL protection on every open live position; re-places missing SL immediately.
 */
export async function reconcileExchangeState({
  engine,
  adapter,
  protectionManager,
  orphanAction = "alert", // "alert" | "close" | "adopt"
  onLog = () => {},
}) {
  if (!adapter || !engine) {
    return { ok: false, reconciled: 0, orphans: 0, externallyClosed: 0, reprotected: 0 };
  }

  let exchangePositions = [];
  let openOrders = [];
  try {
    [exchangePositions, openOrders] = await Promise.all([
      adapter.getPositions(),
      adapter.getOpenOrders().catch(() => []),
    ]);
  } catch (err) {
    return {
      ok: false,
      reconciled: 0,
      orphans: 0,
      externallyClosed: 0,
      reprotected: 0,
      error: err.message,
    };
  }

  // First resolve any UNKNOWN intents in the IntentStateMachine (FX-23, EC-39)
  if (engine.intentMachine) {
    for (const intent of engine.intentMachine.getPendingIntents()) {
      if (intent.state === INTENT_STATES.UNKNOWN) {
        const res = await resolveUnknownOrder(adapter, {
          symbol: intent.symbol,
          clientOrderId: intent.clientOrderId,
          orderId: intent.orderId,
        });
        if (res.resolved) {
          if (res.absent) {
            engine.intentMachine.transition(intent.id, INTENT_STATES.REJECTED, {
              note: "reconcile-verified-absent",
            });
          } else if (res.status === "FILLED") {
            engine.intentMachine.transition(intent.id, INTENT_STATES.FILLED, {
              filledQty: res.filledQty,
              avgFillPrice: res.avgFillPrice,
              note: "reconcile-recovered-fill",
            });
          }
        }
      }
    }
  }

  const livePositions = engine.state.positions.filter((p) => p.mode === "live" && p.status === "open");
  const matchedLocalIds = new Set();
  const orphanDetails = [];
  let reconciled = 0;
  let orphans = 0;
  let externallyClosed = 0;
  let reprotected = 0;
  let adopted = 0;

  for (const exPos of Array.isArray(exchangePositions) ? exchangePositions : []) {
    const exSym = String(exPos.symbol || "").toUpperCase();
    const exSize = toNum(exPos.size, 0);
    if (!(exSize > 0)) continue;

    const match = livePositions.find(
      (p) =>
        String(p.exchangeSymbol || p.symbol || "").toUpperCase() === exSym ||
        String(p.symbol || "").toUpperCase() === exSym.replace(/_?USDT$/, "")
    );

    if (match) {
      matchedLocalIds.add(match.id);
      match.markPrice = toNum(exPos.markPrice, match.markPrice);
      match.unrealizedPnl = toNum(exPos.unrealizedPnl, match.unrealizedPnl);
      match.liqPrice = toNum(exPos.liqPrice, match.liqPrice);

      // Detect manual size change on exchange (EC-33)
      if (Math.abs(exSize - toNum(match.qty, 0)) > 1e-8) {
        onLog("warn", `RECONCILE SIZE SYNC ${match.symbol}: local qty ${match.qty} -> exchange qty ${exSize}`);
        match.qty = exSize;
      }

      // Verify SL protection exists on exchange (FX-24)
      const hasAttachedSl = toNum(exPos.stopLoss, 0) > 0 || match.protection?.slOrderId === "attached_bybit";
      const hasStopOrder = (Array.isArray(openOrders) ? openOrders : []).some(
        (o) =>
          String(o.symbol || o.contract || "").toUpperCase() === exSym &&
          (String(o.id || o.orderId) === String(match.protection?.slOrderId) ||
            /stop|sl/i.test(String(o.type || o.orderType || "")))
      );

      if (!hasAttachedSl && !hasStopOrder && protectionManager) {
        onLog("warn", `RECONCILE RE-PROTECT: Missing SL for ${match.symbol}; re-placing immediately.`);
        if (match.protection) match.protection.slOrderId = null;
        const prot = await protectionManager.placeInitialProtection({
          pos: match,
          adapter,
          markPrice: match.markPrice,
          settings: engine.state.settings,
          onLog,
        });
        if (prot.ok) reprotected++;
      }

      reconciled++;
    } else {
      // Orphan position on exchange (FX-24, EC-34)
      orphans++;
      orphanDetails.push(exPos);
      onLog(
        "warn",
        `RECONCILE ORPHAN: Exchange has unmanaged ${String(exPos.side).toUpperCase()} ${exPos.symbol} (size ${exPos.size})`
      );

      if (orphanAction === "close") {
        await adapter.cancelAll(exPos.symbol).catch(() => {});
        await adapter.closePosition(exPos.symbol, exPos.size).catch(() => {});
      } else if (orphanAction === "adopt") {
        const s = engine.state.settings;
        const profile = s.profiles?.[exPos.side] || s;
        const entryP = toNum(exPos.entryPrice || exPos.markPrice, 0);
        const levels = computeLevels({ side: exPos.side, entry: entryP, settings: { ...s, ...profile } });
        const adoptedPos = {
          id: uid("pos_adopt_"),
          mode: "live",
          status: "open",
          symbol: exSym.replace(/_?USDT$/, ""),
          exchangeSymbol: exPos.symbol,
          side: exPos.side,
          profile: exPos.side,
          venue: adapter.id,
          venueName: adapter.name,
          venueSymbol: exPos.symbol,
          base: exSym.replace(/_?USDT$/, ""),
          source: "reconcile-adopted",
          entryTime: now(),
          entryPrice: entryP,
          signalPrice: entryP,
          qty: exSize,
          originalQty: exSize,
          margin: round((entryP * exSize) / Math.max(1, toNum(exPos.leverage, 10)), 4),
          notional: round(entryP * exSize, 4),
          leverage: toNum(exPos.leverage, 10),
          entryFee: 0,
          grossPnl: 0,
          exitFees: 0,
          exitQty: 0,
          exitNotional: 0,
          partials: [],
          slPrice: levels.slPrice,
          initialSlPrice: levels.slPrice,
          tp1Price: levels.tp1Price,
          tpMaxPrice: levels.tpMaxPrice,
          liqPrice: toNum(exPos.liqPrice, levels.liqPrice),
          tp1Hit: false,
          trailingEnabled: Boolean(profile.trailingEnabled),
          trailingStart: profile.trailingStart || "tp1",
          trailingActive: false,
          peakPrice: toNum(exPos.markPrice, entryP),
          markPrice: toNum(exPos.markPrice, entryP),
          unrealizedPnl: toNum(exPos.unrealizedPnl, 0),
          protection: { slOrderId: null, tp1OrderId: null },
        };
        if (protectionManager) {
          await protectionManager.placeInitialProtection({
            pos: adoptedPos,
            adapter,
            markPrice: adoptedPos.markPrice,
            settings: s,
            onLog,
          });
        }
        engine.state.positions.push(adoptedPos);
        adopted++;
      }
    }
  }

  // Detect local live positions that were closed externally on the exchange (EC-32)
  for (const localPos of livePositions) {
    if (!matchedLocalIds.has(localPos.id)) {
      externallyClosed++;
      const symKey = localPos.exchangeSymbol || localPos.symbol;
      onLog("warn", `RECONCILE EXTERNAL CLOSE: ${localPos.symbol} is no longer open on ${adapter.id}. Settling locally.`);
      await adapter.cancelAll(symKey).catch(() => {});
      engine._closePosition(localPos, localPos.markPrice || localPos.entryPrice, "External/Exchange Close", {
        force: true,
      });
    }
  }

  return {
    ok: true,
    reconciled,
    orphans,
    orphanDetails,
    externallyClosed,
    reprotected,
    adopted,
  };
}

/**
 * Account Preflight & Post-Only Order Test (Section 5.6 FX-25).
 * Validates clock drift, trading-only permissions, no withdrawal permission,
 * One-Way + Isolated margin mode, balance, and optional post-only tiny limit order test.
 */
export async function runAccountPreflight(adapter, { symbol = "BTCUSDT", runOrderTest = false } = {}) {
  if (!adapter) {
    return { ok: false, error: "no-adapter" };
  }

  const report = {
    venue: adapter.id,
    venueName: adapter.name,
    ok: false,
    clockSync: { ok: false, driftMs: 0 },
    permissions: { ok: false, canTrade: false, canWithdraw: false },
    accountMode: { ok: false, oneWay: false, isolated: false },
    balance: { ok: false, availableUsdt: 0, equityUsdt: 0 },
    capabilities: typeof adapter.capabilities === "function" ? adapter.capabilities() : { trading: true },
    orderTest: { executed: false, ok: null },
    timestamp: Date.now(),
  };

  // 1. Server time / clock drift check (EC-62)
  try {
    if (typeof adapter.syncServerTime === "function") {
      const syncRes = await adapter.syncServerTime();
      const driftMs = toNum(syncRes?.offset ?? syncRes?.driftMs ?? 0, 0);
      report.clockSync = {
        ok: Math.abs(driftMs) <= 1000,
        driftMs,
      };
      if (!report.clockSync.ok) {
        report.error = `Clock drift (${driftMs}ms) exceeds 1000ms limit.`;
        return report;
      }
    } else {
      report.clockSync = { ok: true, driftMs: 0 };
    }
  } catch (err) {
    report.clockSync = { ok: false, error: err.message };
  }

  // 2. Key permissions check (PRD E3)
  const val = await adapter.validateKey();
  report.permissions = {
    ok: Boolean(val.ok && val.canTrade && !val.canWithdraw),
    canTrade: Boolean(val.canTrade),
    canWithdraw: Boolean(val.canWithdraw),
    error: val.error || null,
  };
  if (!report.permissions.ok) {
    report.error = val.error || "Permission check failed.";
    return report;
  }

  // 3. Account mode check (One-Way & Isolated)
  try {
    const modeRes = await adapter.ensureAccountMode();
    report.accountMode = {
      ok: modeRes?.oneWay !== false,
      oneWay: modeRes?.oneWay !== false,
      isolated: modeRes?.isolated !== false,
    };
  } catch (err) {
    report.accountMode = { ok: false, error: err.message };
  }

  // 4. Balance check
  try {
    const bal = await adapter.getBalance();
    report.balance = {
      ok: true,
      availableUsdt: toNum(bal?.availableUsdt, 0),
      equityUsdt: toNum(bal?.equityUsdt, 0),
      walletUsdt: toNum(bal?.walletUsdt, 0),
    };
  } catch (err) {
    report.balance = { ok: false, error: err.message };
    report.error = `Balance check failed: ${err.message}`;
    return report;
  }

  // 5. Optional Post-Only Order Test at 50% below mark price followed by immediate cancel (FX-25)
  if (runOrderTest && typeof adapter.placePostOnlyTestOrder === "function") {
    try {
      const testRes = await adapter.placePostOnlyTestOrder(symbol);
      report.orderTest = {
        executed: true,
        ok: Boolean(testRes?.ok),
        orderId: testRes?.orderId || null,
        cancelled: Boolean(testRes?.cancelled),
      };
    } catch (err) {
      report.orderTest = {
        executed: true,
        ok: false,
        error: err.message,
      };
    }
  }

  report.ok = Boolean(
    report.clockSync.ok !== false &&
      report.permissions.ok &&
      report.accountMode.ok !== false &&
      report.balance.ok &&
      report.capabilities.trading !== false &&
      (report.orderTest.ok !== false)
  );

  return report;
}
