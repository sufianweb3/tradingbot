/**
 * Passive AI trade dataset logger.
 *
 * This module only observes the engine. It never changes settings, filters,
 * sizing, positions or prices. It listens to the engine's existing `trade`
 * event and samples the engine's already-fetched market/quote data once per
 * second for every open position.
 *
 * Output (one folder per trade):
 *   data/ai-dataset/<entry-time>_<symbol>_<side>_<trade-id>/
 *     trade.json    entry snapshot: strategy settings, coin, signal, plan
 *     ticks.jsonl   one JSON line per second while the position is open
 *     events.jsonl  open / partial / close / note events
 *     summary.json  final trade result, stats and file list
 *   data/ai-dataset/index.jsonl  one line per open/close for fast discovery
 *
 * Disable with AI_TRADE_LOG=0. Change the folder with AI_DATASET_DIR. Change
 * the sample interval with AI_TRADE_INTERVAL_MS (minimum 250 ms).
 */

import fs from "node:fs";
import path from "node:path";
import { iso, now, round, toNum } from "./util.js";
import { positionMetrics } from "./trading.js";

const SCHEMA_TRADE = "oi-bot-ai-trade/v1";
const SCHEMA_TICK = "oi-bot-ai-tick/v1";
const SCHEMA_SUMMARY = "oi-bot-ai-trade-summary/v1";
const SCHEMA_INDEX = "oi-bot-ai-index/v1";

function clone(value) {
  if (value === null || value === undefined) return value ?? null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function safePart(value) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function fileStamp(ms) {
  try {
    return new Date(ms).toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  } catch {
    return String(ms);
  }
}

function jsonLine(value) {
  return JSON.stringify(value) + "\n";
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

function appendLine(file, value) {
  fs.appendFileSync(file, jsonLine(value), "utf8");
}

function pctDistance(target, price, dir) {
  const p = toNum(price);
  const t = toNum(target);
  if (!(p > 0) || !(t > 0)) return null;
  return round(((t / p - 1) * 100) * dir, 6);
}

/**
 * Attach the logger to an Engine instance.
 *
 * @param {object} engine
 * @param {object} [options]
 * @param {boolean} [options.enabled]
 * @param {string} [options.dir]
 * @param {number} [options.intervalMs]
 * @param {boolean} [options.quote] sample a fresh exchange quote each tick
 * @returns {{enabled:boolean, dir?:string, dispose:Function, tickNow?:Function, sessions?:Map}}
 */
export function attachAiTradeLogger(engine, options = {}) {
  const enabled = options.enabled ?? process.env.AI_TRADE_LOG !== "0";
  if (!enabled) return { enabled: false, dispose() {} };

  const intervalMs = Math.max(
    250,
    toNum(options.intervalMs ?? process.env.AI_TRADE_INTERVAL_MS, 1000) ?? 1000
  );
  const stateFile = engine?.store?.file;
  const rootDir =
    options.dir ||
    process.env.AI_DATASET_DIR ||
    (stateFile
      ? path.join(path.dirname(stateFile), "ai-dataset")
      : path.resolve("data", "ai-dataset"));
  const useQuote = options.quote !== false;

  try {
    fs.mkdirSync(rootDir, { recursive: true });
  } catch (err) {
    console.warn(`[ai-dataset] disabled, cannot create ${rootDir}: ${err.message}`);
    return { enabled: false, dispose() {} };
  }

  /** @type {Map<string, {id:string, dir:string, pos:object, startedAt:number, ticks:number, resumed:boolean}>} */
  const sessions = new Map();
  let timer = null;
  let tickPromise = null;
  let disposed = false;

  function getCoin(symbol) {
    try {
      return engine.marketCache?.coins?.find((c) => c.symbol === symbol) || null;
    } catch {
      return null;
    }
  }

  function getRows() {
    try {
      return engine.getMarketRows() || [];
    } catch {
      return [];
    }
  }

  function getStats() {
    try {
      return clone(engine.getStats());
    } catch {
      return null;
    }
  }

  function cachedQuote(pos) {
    try {
      const quotes = engine.hub?.quotes;
      if (!quotes || typeof quotes.get !== "function") return null;
      return clone(quotes.get(`${pos.venue}:${pos.venueSymbol}`)) || null;
    } catch {
      return null;
    }
  }

  function findExistingDir(tradeId) {
    try {
      const suffix = `_${safePart(tradeId)}`;
      return (
        fs
          .readdirSync(rootDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name.endsWith(suffix))
          .map((d) => path.join(rootDir, d.name))[0] || null
      );
    } catch {
      return null;
    }
  }

  function countLines(file) {
    try {
      return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  function entrySnapshot(pos) {
    const settings = clone(engine.publicSettings?.() || engine.state?.settings || null);
    const coin = clone(getCoin(pos.symbol));
    const row = clone(getRows().find((r) => r.symbol === pos.symbol) || null);
    const quote = cachedQuote(pos);
    return {
      schema: SCHEMA_TRADE,
      version: 1,
      createdAt: now(),
      tradeId: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      status: "open",
      settings,
      account: getStats(),
      venue: {
        venue: pos.venue,
        venueName: pos.venueName,
        venueSymbol: pos.venueSymbol,
        base: pos.base,
        source: pos.source,
      },
      entry: {
        entryTime: pos.entryTime,
        entryPrice: pos.entryPrice,
        signalPrice: pos.signalPrice,
        qty: pos.qty,
        originalQty: pos.originalQty,
        margin: pos.margin,
        notional: pos.notional,
        leverage: pos.leverage,
        entryFee: pos.entryFee,
        feePercent: pos.feePercent,
        slippagePercent: pos.slippagePercent,
      },
      plan: {
        riskMode: pos.riskMode,
        slPercent: pos.slPercent,
        tp1Percent: pos.tp1Percent,
        tpMaxPercent: pos.tpMaxPercent,
        tp1ClosePercent: pos.tp1ClosePercent,
        slPrice: pos.slPrice,
        initialSlPrice: pos.initialSlPrice,
        tp1Price: pos.tp1Price,
        tpMaxPrice: pos.tpMaxPrice,
        liqPrice: pos.liqPrice,
        trailingEnabled: Boolean(pos.trailingEnabled),
        trailingStart: pos.trailingStart,
        trailingDistancePercent: pos.trailingDistancePercent,
      },
      signal: clone(pos.signal),
      criteria: clone(pos.criteria || []),
      coin,
      row,
      entryQuote: quote,
      position: clone(pos),
    };
  }

  function startSession(pos, { resumed = false } = {}) {
    if (!pos?.id || sessions.has(pos.id)) return;
    const existing = findExistingDir(pos.id);
    const dir =
      existing ||
      path.join(
        rootDir,
        `${fileStamp(pos.entryTime || now())}_${safePart(pos.symbol)}_${safePart(
          pos.side
        )}_${safePart(pos.id)}`
      );
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!existing || !fs.existsSync(path.join(dir, "trade.json"))) {
        writeJsonAtomic(path.join(dir, "trade.json"), entrySnapshot(pos));
      }
    } catch (err) {
      console.warn(`[ai-dataset] could not start ${pos.symbol}: ${err.message}`);
      return;
    }

    const session = {
      id: pos.id,
      dir,
      pos: clone(pos),
      startedAt: pos.entryTime || now(),
      ticks: existing ? countLines(path.join(dir, "ticks.jsonl")) : 0,
      resumed: Boolean(existing) || resumed,
    };
    sessions.set(pos.id, session);

    try {
      appendLine(path.join(rootDir, "index.jsonl"), {
        schema: SCHEMA_INDEX,
        event: "open",
        at: now(),
        tradeId: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        dir: path.relative(rootDir, dir),
        entryTime: pos.entryTime,
        resumed: session.resumed,
      });
      appendLine(path.join(dir, "events.jsonl"), {
        schema: SCHEMA_TRADE,
        event: session.resumed ? "resume" : "open",
        at: now(),
        iso: iso(now()),
        position: clone(pos),
      });
    } catch (err) {
      console.warn(`[ai-dataset] could not write ${pos.symbol}: ${err.message}`);
    }

    ensureTimer();
    tickNow().catch(() => {});
  }

  function stopTimerIfIdle() {
    if (timer && sessions.size === 0) {
      clearInterval(timer);
      timer = null;
    }
  }

  function ensureTimer() {
    if (timer || disposed || sessions.size === 0) return;
    timer = setInterval(() => {
      tickNow().catch(() => {});
    }, intervalMs);
    timer.unref?.();
  }

  async function sampleSession(session, rowBySymbol, coinBySymbol) {
    const pos = engine.state?.positions?.find((p) => p.id === session.id) || null;
    if (!pos) {
      sessions.delete(session.id);
      return;
    }

    const t = now();
    let quote = null;
    if (useQuote) {
      try {
        quote = await engine.hub.quote(
          { venue: pos.venue, venueSymbol: pos.venueSymbol, base: pos.base },
          { maxAgeMs: 1500 }
        );
      } catch {
        quote = null;
      }
    }

    const price = toNum(quote?.price, pos.markPrice ?? pos.entryPrice);
    const metrics = positionMetrics(pos, price);
    const dir = pos.side === "short" ? -1 : 1;
    const stop = pos.trailingActive && Number.isFinite(pos.trailStopPrice)
      ? pos.trailStopPrice
      : pos.slPrice;
    const coin = clone(coinBySymbol.get(pos.symbol) || null);
    const row = clone(rowBySymbol.get(pos.symbol) || null);

    const line = {
      schema: SCHEMA_TICK,
      seq: ++session.ticks,
      t,
      iso: iso(t),
      elapsedMs: t - (pos.entryTime || session.startedAt),
      quote: quote
        ? {
            price: quote.price,
            ts: quote.ts,
            ageMs: quote.ts ? t - quote.ts : null,
            venue: quote.venue,
            venueName: quote.venueName,
            venueSymbol: quote.venueSymbol,
            base: quote.base,
            stale: Boolean(quote.stale),
            fallback: Boolean(quote.fallback),
          }
        : null,
      mark: {
        price: pos.markPrice,
        ts: pos.markTs,
        ageMs: pos.markTs ? t - pos.markTs : null,
        stale: Boolean(pos.priceStale),
        venue: pos.markVenue,
      },
      position: {
        qty: pos.qty,
        tp1Hit: Boolean(pos.tp1Hit),
        trailingActive: Boolean(pos.trailingActive),
        trailStopPrice: pos.trailStopPrice,
        slPrice: pos.slPrice,
        tp1Price: pos.tp1Price,
        tpMaxPrice: pos.tpMaxPrice,
        liqPrice: pos.liqPrice,
        stopPrice: stop,
        peakPrice: pos.peakPrice,
        peakRoe: pos.peakRoe,
        fallbackStreak: pos.fallbackStreak,
        quoteFailures: pos.quoteFailures,
      },
      metrics: {
        price,
        gross: metrics.gross,
        exitFee: metrics.exitFee,
        net: metrics.net,
        grossRoe: metrics.grossRoe,
        netRoe: metrics.netRoe,
        notional: metrics.notional,
      },
      distances: {
        tp1Pct: pctDistance(pos.tp1Price, price, dir),
        tpMaxPct: pctDistance(pos.tpMaxPrice, price, dir),
        stopPct: pctDistance(stop, price, dir),
        liqPct: pctDistance(pos.liqPrice, price, dir),
      },
      coin,
      row,
    };

    try {
      appendLine(path.join(session.dir, "ticks.jsonl"), line);
    } catch (err) {
      console.warn(`[ai-dataset] tick write failed for ${pos.symbol}: ${err.message}`);
    }
  }

  async function tickNow() {
    if (disposed || sessions.size === 0) return;
    if (tickPromise) return tickPromise;
    tickPromise = (async () => {
      try {
        const rowBySymbol = new Map(getRows().map((r) => [r.symbol, r]));
        const coinBySymbol = new Map(
          (engine.marketCache?.coins || []).map((c) => [c.symbol, c])
        );
        await Promise.allSettled(
          [...sessions.values()].map((s) => sampleSession(s, rowBySymbol, coinBySymbol))
        );
      } finally {
        tickPromise = null;
        stopTimerIfIdle();
      }
    })();
    return tickPromise;
  }

  function onTrade(event) {
    try {
      const type = event?.type;
      if (type === "open" && event.position) {
        startSession(event.position);
        return;
      }
      const pos = event?.position || event?.trade;
      if (!pos) return;
      const session = sessions.get(pos.id || event?.trade?.id);
      if (!session) return;

      if (type === "partial") {
        appendLine(path.join(session.dir, "events.jsonl"), {
          schema: SCHEMA_TRADE,
          event: "partial",
          at: now(),
          iso: iso(now()),
          position: clone(pos),
          partials: clone(pos.partials || []),
        });
        return;
      }

      if (type === "close") {
        const trade = event.trade || pos;
        const closedAt = now();
        try {
          appendLine(path.join(session.dir, "ticks.jsonl"), {
            schema: SCHEMA_TICK,
            seq: ++session.ticks,
            t: closedAt,
            iso: iso(closedAt),
            elapsedMs: closedAt - session.startedAt,
            final: true,
            quote: null,
            mark: {
              price: trade.exitPrice,
              ts: trade.exitTime,
              ageMs: trade.exitTime ? closedAt - trade.exitTime : null,
              stale: false,
              venue: trade.venue,
            },
            position: { qty: 0, tp1Hit: Boolean(trade.tp1Hit), trailingActive: false },
            metrics: {
              price: trade.exitPrice,
              gross: trade.grossPnl,
              exitFee: trade.exitFees,
              net: trade.pnlNet,
              grossRoe: null,
              netRoe: trade.roe,
              notional: trade.notional,
            },
            distances: null,
            exit: {
              reason: trade.exitReason,
              exitTime: trade.exitTime,
              exitPrice: trade.exitPrice,
              pnlNet: trade.pnlNet,
              roe: trade.roe,
              feesPaid: trade.feesPaid,
              durationMs: trade.durationMs,
            },
            coin: clone(getCoin(trade.symbol)),
            row: clone(getRows().find((r) => r.symbol === trade.symbol) || null),
          });
        } catch {
          /* the summary below still records the outcome */
        }
        try {
          appendLine(path.join(session.dir, "events.jsonl"), {
            schema: SCHEMA_TRADE,
            event: "close",
            at: now(),
            iso: iso(now()),
            trade: clone(trade),
          });
        } catch {
          /* the summary below still records the outcome */
        }
        const summary = {
          schema: SCHEMA_SUMMARY,
          version: 1,
          tradeId: session.id,
          symbol: trade.symbol,
          side: trade.side,
          startedAt: session.startedAt,
          closedAt: now(),
          ticks: session.ticks,
          resumed: session.resumed,
          trade: clone(trade),
          finalCoin: clone(getCoin(trade.symbol)),
          finalRow: clone(getRows().find((r) => r.symbol === trade.symbol) || null),
          statsAfter: getStats(),
          files: {
            entry: "trade.json",
            ticks: "ticks.jsonl",
            events: "events.jsonl",
          },
        };
        try {
          writeJsonAtomic(path.join(session.dir, "summary.json"), summary);
        } catch (err) {
          console.warn(`[ai-dataset] summary write failed for ${session.id}: ${err.message}`);
        }
        try {
          appendLine(path.join(rootDir, "index.jsonl"), {
            schema: SCHEMA_INDEX,
            event: "close",
            at: now(),
            tradeId: session.id,
            symbol: trade.symbol,
            side: trade.side,
            dir: path.relative(rootDir, session.dir),
            entryTime: trade.entryTime,
            exitTime: trade.exitTime,
            pnlNet: trade.pnlNet,
            roe: trade.roe,
            exitReason: trade.exitReason,
            ticks: session.ticks,
          });
        } catch {
          /* index is best effort */
        }
        sessions.delete(session.id);
        stopTimerIfIdle();
      }
    } catch (err) {
      console.warn(`[ai-dataset] event handling failed: ${err.message}`);
    }
  }

  const unsubscribe = engine.on("trade", onTrade);

  // A server restart can leave paper positions open. Resume those trade files
  // instead of losing the rest of the price history.
  for (const pos of engine.state?.positions || []) {
    if (pos?.id && pos.qty > 0) startSession(pos, { resumed: true });
  }

  console.log(
    `[ai-dataset] passive logger on -> ${rootDir} (sample ${intervalMs} ms, quote=${useQuote})`
  );

  return {
    enabled: true,
    dir: rootDir,
    sessions,
    tickNow,
    dispose() {
      disposed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      try {
        unsubscribe?.();
      } catch {
        /* ignore */
      }
      sessions.clear();
    },
  };
}
