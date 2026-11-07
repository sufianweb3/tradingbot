/**
 * Durable Object that hosts the multi-strategy paper-trading portfolio.
 *
 * One instance ("engine-<generation>") owns every strategy. Each strategy has
 * its own state under a namespaced storage key, and the engine's timers are
 * backed by Durable Object alarms so scanning/pricing continues while nobody
 * has the dashboard open.
 */

import { Portfolio } from "../src/portfolio.js";
import { renderStateLogExport } from "../src/logExport.js";
import { renderCsv, renderJson, renderReport } from "../src/report.js";
import { now, toNum } from "../src/util.js";
import { ENGINE_GENERATION } from "./build.js";
import { DurableStore } from "./store.js";
import { AlarmTimers } from "./timers.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function text(status, body, type = "text/plain; charset=utf-8", extra = {}) {
  return new Response(body, {
    status,
    headers: {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

async function readBody(request) {
  const raw = await request.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("invalid-json");
  }
}

function strategyIdFrom(url, body = null) {
  return String(
    body?.strategy || body?.strategyId || url.searchParams.get("strategy") || ""
  ).trim();
}

export class EngineV3DO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.bootedAt = Date.now();
    this.ready = ctx.blockConcurrencyWhile(() => this.boot());
  }

  async boot() {
    const storage = this.ctx.storage;
    const savedConfig = await storage.get("portfolio");
    this.timers = new AlarmTimers(this.ctx);
    const adapter = {
      loadConfig: async () => savedConfig,
      saveConfig: async (config) => storage.put("portfolio", config),
      loadState: async (entry) =>
        entry.storeKey
          ? await storage.get(entry.storeKey)
          : await storage.get(`state:${entry.id}`),
      createStore: (entry, saved) =>
        new DurableStore(storage, saved, entry.storeKey || `state:${entry.id}`),
      deleteStore: async (entry) => storage.delete(entry.storeKey || `state:${entry.id}`),
      legacyEntry: async () => {
        const legacy = await storage.get("state");
        if (!legacy) return null;
        return {
          id: "main",
          name: "Main strategy",
          createdAt: now(),
          storeKey: "state",
        };
      },
    };

    this.portfolio = new Portfolio({
      timers: this.timers,
      adapter,
      resume: true,
    });

    try {
      await this.portfolio.init();
    } catch (err) {
      console.error("[portfolio] init failed:", err && err.message);
    }
    await this.portfolio.flush();
  }

  async flushAll() {
    try {
      await this.portfolio?.flush();
    } catch {
      /* best effort */
    }
  }

  async alarm() {
    await this.ready;
    try {
      await this.timers.runDue();
    } finally {
      await this.flushAll();
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method || "GET";
    const portfolio = this.portfolio;

    const engineFor = (body = null) =>
      portfolio.resolve(strategyIdFrom(url, body)) || portfolio.selected();

    try {
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      if (method === "GET" && pathname === "/api/health") {
        const cg = portfolio.getMarketStatus();
        const strategies = portfolio.list();
        return json(200, {
          ok: true,
          serverTime: now(),
          generation: ENGINE_GENERATION,
          running: strategies.some((s) => s.running),
          runningStrategies: strategies.filter((s) => s.running).length,
          strategies: strategies.length,
          positions: strategies.reduce((a, s) => a + s.openTrades, 0),
          trades: strategies.reduce((a, s) => a + s.totalTrades, 0),
          uptimeSec: Math.round((Date.now() - this.bootedAt) / 1000),
          coinglass: cg.state,
          coinglassConnected: cg.connected,
          coinglassCoins: cg.coins,
          coinglassSource: cg.source,
          coinglassApiKeySet: cg.apiKeySet,
        });
      }

      if (method === "GET" && (pathname === "/api/strategies" || pathname === "/api/compare")) {
        return json(200, {
          ok: true,
          selectedId: portfolio.selectedId(),
          strategies: portfolio.list(),
          portfolio: portfolio.summary(),
        });
      }

      if (method === "POST" && pathname === "/api/strategies") {
        const body = await readBody(request);
        const result = await portfolio.create({
          name: body?.name,
          fund: body?.fund,
          settings: body?.settings && typeof body.settings === "object" ? body.settings : null,
          cloneFrom: body?.cloneFrom || null,
          start: body?.start === true,
        });
        await this.flushAll();
        return json(result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/strategies/select") {
        const body = await readBody(request);
        const result = await portfolio.select(body?.id);
        await this.flushAll();
        return json(result.ok ? 200 : 404, result);
      }

      const strategyRoute = pathname.match(/^\/api\/strategies\/([^/]+)$/);
      if (strategyRoute) {
        const id = decodeURIComponent(strategyRoute[1]);
        if (method === "GET") {
          const engine = portfolio.resolve(id);
          if (!engine) return json(404, { ok: false, error: "strategy-not-found" });
          return json(200, {
            ok: true,
            strategy: portfolio.list().find((s) => s.id === id),
            settings: engine.publicSettings(),
            stats: engine.getStats(),
          });
        }
        if (method === "DELETE") {
          const result = await portfolio.remove(id);
          await this.flushAll();
          return json(result.ok ? 200 : 400, result);
        }
        if (method === "POST" || method === "PATCH") {
          const body = await readBody(request);
          const result = await portfolio.update(id, {
            name: body?.name,
            fund: body?.fund,
            settings: body?.settings && typeof body.settings === "object" ? body.settings : body,
            start: body?.start === true,
            pause: body?.pause === true,
          });
          await this.flushAll();
          return json(result.ok ? 200 : 404, result);
        }
      }

      if (method === "GET" && pathname === "/api/bootstrap") {
        const payload = portfolio.getBootstrap(strategyIdFrom(url));
        if (payload.error) return json(404, { ok: false, ...payload });
        return json(200, { ok: true, ...payload });
      }

      if (method === "GET" && pathname === "/api/live") {
        const engine = engineFor();
        if (!engine) return json(404, { ok: false, error: "strategy-not-found" });
        return json(200, { ok: true, ...engine.getLive() });
      }

      if (method === "GET" && pathname === "/api/dashboard") {
        const engine = engineFor();
        if (!engine) return json(404, { ok: false, error: "strategy-not-found" });
        // One request for both the live state and the market table. Polling two
        // endpoints separately doubles the Durable Object request bill, and the
        // free plan allows 100k/day.
        if (!engine.marketCache.coins.length) {
          try {
            await engine.refreshMarketsIfStale();
          } catch {
            /* serve the empty cache */
          }
        } else if (engine.marketCache.error || now() - engine.marketCache.at > 900) {
          this.ctx.waitUntil(engine.refreshMarketsIfStale().catch(() => null));
        }
        const payload = portfolio.getDashboard(engine.id);
        return json(200, { ok: true, ...payload });
      }

      if (method === "GET" && pathname === "/api/markets") {
        const engine = engineFor();
        if (!engine) return json(404, { ok: false, error: "strategy-not-found" });
        if (!engine.marketCache.coins.length) {
          try {
            await engine.refreshMarketsIfStale();
          } catch {
            /* fall through to the (empty) cache */
          }
        } else if (engine.marketCache.error || now() - engine.marketCache.at > 900) {
          this.ctx.waitUntil(engine.refreshMarketsIfStale().catch(() => null));
        }
        return json(200, {
          ok: true,
          serverTime: now(),
          markets: engine.getMarketRows(),
          meta: engine.getMeta(),
          venues: portfolio.hub.summary(),
          selectedId: engine.id,
          strategies: portfolio.list(),
          portfolio: portfolio.summary(),
        });
      }

      if (method === "GET" && pathname === "/api/config") {
        const engine = engineFor();
        const config = portfolio.getStrategyConfig(engine?.id);
        if (!config) return json(404, { ok: false, error: "strategy-not-found" });
        return json(200, {
          ok: true,
          strategy: { id: engine.id, name: engine.name },
          ...config,
          strategies: portfolio.list(),
          portfolio: portfolio.summary(),
        });
      }

      if (method === "GET" && pathname === "/api/trades") {
        const limit = toNum(url.searchParams.get("limit"), 200);
        const offset = toNum(url.searchParams.get("offset"), 0);
        return json(200, {
          ok: true,
          ...portfolio.getTrades(strategyIdFrom(url), { limit, offset }),
        });
      }

      if (method === "GET" && pathname === "/api/logs") {
        const engine = engineFor();
        const at = now();
        const stampText = new Date(at)
          .toISOString()
          .replace(/[:.]/g, "-")
          .replace("T", "_")
          .slice(0, 19);
        const body = renderStateLogExport(engine, { at });
        const disp = url.searchParams.get("download") !== "0" ? "attachment" : "inline";
        return text(200, body, "application/x-ndjson; charset=utf-8", {
          "content-disposition": `${disp}; filename="oi-bot-logs-${stampText}.jsonl"`,
        });
      }

      if (method === "GET" && pathname === "/api/report") {
        const format = (url.searchParams.get("format") || "html").toLowerCase();
        const download = url.searchParams.get("download") !== "0";
        const data = portfolio.getReportData(strategyIdFrom(url));
        if (!data) return json(404, { ok: false, error: "strategy-not-found" });
        const base = `oi-sniper-report-${stamp()}`;
        const disp = download ? "attachment" : "inline";
        if (format === "csv") {
          return text(200, renderCsv(data), "text/csv; charset=utf-8", {
            "content-disposition": `${disp}; filename="${base}.csv"`,
          });
        }
        if (format === "json") {
          return text(200, renderJson(data), "application/json; charset=utf-8", {
            "content-disposition": `${disp}; filename="${base}.json"`,
          });
        }
        return text(200, renderReport(data), "text/html; charset=utf-8", {
          "content-disposition": `${disp}; filename="${base}.html"`,
        });
      }

      if (method === "POST" && pathname === "/api/settings") {
        const body = await readBody(request);
        const patch = body?.settings && typeof body.settings === "object" ? body.settings : body;
        if (!patch || typeof patch !== "object") {
          return json(400, { ok: false, error: "invalid-settings" });
        }
        const clean = { ...patch };
        delete clean.strategy;
        delete clean.strategyId;
        const engine = engineFor(body);
        if (!engine) return json(404, { ok: false, error: "strategy-not-found" });
        const result = await portfolio.updateSettings(engine.id, clean);
        await this.flushAll();
        return json(200, {
          ok: true,
          ...result,
          strategies: portfolio.list(),
        });
      }

      if (method === "POST" && pathname === "/api/device/market") {
        const body = await readBody(request);
        const result = portfolio.ingestDeviceFeed(body || {});
        // Deliberately no flush: the device feed is transient and a push every
        // few seconds must not consume storage writes.
        return json(result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/coinglass/key") {
        const body = await readBody(request);
        const key = body?.clear === true ? null : body?.apiKey ?? body?.key;
        if (key !== null && typeof key !== "string") {
          return json(400, { ok: false, error: "invalid-api-key" });
        }
        const result = await portfolio.setCoinglassApiKey(key);
        await this.flushAll();
        return json(200, {
          ok: true,
          ...result,
          stats: portfolio.selected()?.getStats(),
        });
      }

      if (method === "POST" && pathname === "/api/control") {
        const body = await readBody(request);
        const action = String(body?.action || "");
        const id = strategyIdFrom(url, body);
        if (action === "start-all") {
          const result = await portfolio.startAll();
          await this.flushAll();
          return json(200, { ok: true, ...result, strategies: portfolio.list() });
        }
        if (action === "pause-all") {
          const result = await portfolio.pauseAll();
          await this.flushAll();
          return json(200, { ok: true, ...result, strategies: portfolio.list() });
        }
        if (action === "close-all-strategies") {
          const result = await portfolio.closeAllStrategies();
          await this.flushAll();
          return json(200, { ok: true, ...result, strategies: portfolio.list() });
        }
        const engine = portfolio.resolve(id) || portfolio.selected();
        if (!engine) return json(404, { ok: false, error: "strategy-not-found" });
        let result;
        if (action === "start") result = portfolio.start(engine.id);
        else if (action === "pause") result = portfolio.pause(engine.id);
        else if (action === "toggle") result = portfolio.toggle(engine.id);
        else if (action === "reset") result = await portfolio.reset(engine.id);
        else if (action === "close-all") result = await portfolio.closeAll(engine.id);
        else return json(400, { ok: false, error: "unknown-action" });
        await this.flushAll();
        return json(200, {
          ok: true,
          ...result,
          strategies: portfolio.list(),
        });
      }

      if (method === "POST" && pathname === "/api/scan") {
        const body = await readBody(request);
        const engine = engineFor(body);
        if (!engine) return json(404, { ok: false, error: "strategy-not-found" });
        const result = await engine.scan({ manual: true });
        await this.flushAll();
        return json(200, { ok: true, ...result });
      }

      if (method === "POST" && pathname === "/api/trade/open") {
        const body = await readBody(request);
        const engine = engineFor(body);
        if (!engine) return json(404, { ok: false, error: "strategy-not-found" });
        const result = await engine.openManual(body?.symbol, { force: body?.force !== false });
        await this.flushAll();
        return json(result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/trade/close") {
        const body = await readBody(request);
        const id = String(body?.id || "");
        let engine = null;
        for (const candidate of portfolio.engines.values()) {
          if (candidate.state.positions.some((p) => p.id === id)) {
            engine = candidate;
            break;
          }
        }
        if (!engine) engine = engineFor(body);
        if (!engine) return json(404, { ok: false, error: "strategy-not-found" });
        const result = await engine.closePositionById(id, body?.reason || "Manual");
        await this.flushAll();
        return json(result.ok ? 200 : 400, result);
      }

      return json(404, { ok: false, error: "not-found" });
    } catch (err) {
      const status = err.message === "invalid-json" ? 400 : 500;
      console.error("[api]", err);
      return json(status, { ok: false, error: err.message || "server-error" });
    } finally {
      this.ctx.waitUntil(this.flushAll());
    }
  }
}
