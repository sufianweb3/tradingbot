/**
 * Durable Object that hosts the paper-trading engine.
 *
 * One instance ("main") owns the whole strategy: state lives in the object's
 * SQLite storage, and the engine's timers are backed by Durable Object alarms
 * so scanning/pricing continues while nobody has the dashboard open.
 */

import { Engine } from "../src/engine.js";
import { renderCsv, renderJson, renderReport } from "../src/report.js";
import { now, toNum } from "../src/util.js";
import { ENGINE_GENERATION } from "./build.js";
import { DurableStore } from "./store.js";
import { AlarmTimers } from "./timers.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
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

export class EngineV3DO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.bootedAt = Date.now();
    this.ready = ctx.blockConcurrencyWhile(() => this.boot());
  }

  async boot() {
    const saved = await this.ctx.storage.get("state");
    const wasRunning = Boolean(saved?.meta?.running);

    this.store = new DurableStore(this.ctx.storage, saved);
    this.timers = new AlarmTimers(this.ctx);
    this.engine = new Engine({ store: this.store, timers: this.timers });

    try {
      await this.engine.init();
    } catch (err) {
      console.error("[engine] init failed:", err && err.message);
    }

    // A Durable Object can be evicted at any time; resume the run the user
    // left behind instead of silently pausing after every restart.
    if (wasRunning && !this.engine.state.meta.running) {
      this.engine.start("resume");
    }
    await this.store.flush();
  }

  async alarm() {
    await this.ready;
    try {
      await this.timers.runDue();
    } finally {
      await this.store.flush();
    }
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method || "GET";

    try {
      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      if (method === "GET" && pathname === "/api/health") {
        const cg = this.engine.getMarketStatus();
        return json(200, {
          ok: true,
          serverTime: now(),
          generation: ENGINE_GENERATION,
          running: this.engine.state.meta.running,
          positions: this.engine.state.positions.length,
          trades: this.engine.state.trades.length,
          uptimeSec: Math.round((Date.now() - this.bootedAt) / 1000),
          coinglass: cg.state,
          coinglassConnected: cg.connected,
          coinglassCoins: cg.coins,
          coinglassSource: cg.source,
          coinglassApiKeySet: cg.apiKeySet,
        });
      }

      if (method === "GET" && pathname === "/api/bootstrap") {
        return json(200, { ok: true, ...this.engine.getBootstrap() });
      }

      if (method === "GET" && pathname === "/api/live") {
        return json(200, { ok: true, ...this.engine.getLive() });
      }

      if (method === "GET" && pathname === "/api/dashboard") {
        // One request for both the live state and the market table. Polling two
        // endpoints separately doubles the Durable Object request bill, and the
        // free plan allows 100k/day.
        if (!this.engine.marketCache.coins.length) {
          try {
            await this.engine.refreshMarketsIfStale();
          } catch {
            /* serve the empty cache */
          }
        } else if (this.engine.marketCache.error || now() - this.engine.marketCache.at > 900) {
          this.ctx.waitUntil(this.engine.refreshMarketsIfStale().catch(() => null));
        }
        const live = this.engine.getLive();
        return json(200, {
          ok: true,
          serverTime: now(),
          ...live,
          markets: this.engine.getMarketRows(),
          meta: this.engine.getMeta(),
          venues: this.engine.hub.summary(),
        });
      }

      if (method === "GET" && pathname === "/api/markets") {
        // Serve the cached table immediately and refresh behind the response so
        // a 1s poll never waits ~1s for seven CoinGlass requests. Only the very
        // first request (empty cache) blocks.
        if (!this.engine.marketCache.coins.length) {
          try {
            await this.engine.refreshMarketsIfStale();
          } catch {
            /* fall through to the (empty) cache */
          }
        } else if (this.engine.marketCache.error || now() - this.engine.marketCache.at > 900) {
          this.ctx.waitUntil(
            this.engine.refreshMarketsIfStale().catch(() => null)
          );
        }
        return json(200, {
          ok: true,
          serverTime: now(),
          markets: this.engine.getMarketRows(),
          meta: this.engine.getMeta(),
          venues: this.engine.hub.summary(),
        });
      }

      if (method === "GET" && pathname === "/api/config") {
        return json(200, {
          ok: true,
          settings: this.engine.publicSettings(),
          initialFund: this.engine.state.initialFund,
          stats: this.engine.getStats(),
        });
      }

      if (method === "GET" && pathname === "/api/trades") {
        const limit = toNum(url.searchParams.get("limit"), 200);
        const offset = toNum(url.searchParams.get("offset"), 0);
        return json(200, { ok: true, ...this.engine.getTrades({ limit, offset }) });
      }

      if (method === "GET" && pathname === "/api/logs") {
        // The Worker has no filesystem, so the AI trade dataset is only
        // available from the local server. Still export the activity log.
        const at = now();
        const stampText = new Date(at)
          .toISOString()
          .replace(/[:.]/g, "-")
          .replace("T", "_")
          .slice(0, 19);
        const records = [
          {
            record: "meta",
            schema: "oi-bot-log-export/v1",
            version: 1,
            createdAt: new Date(at).toISOString(),
            generatedAt: at,
            app: "oi-sniper",
            initialFund: this.engine.state.initialFund,
            settings: this.engine.publicSettings(),
            stats: this.engine.getStats(),
            meta: this.engine.getMeta(),
          },
        ];
        for (const entry of this.engine.state.logs || []) {
          records.push({ record: "log", ...entry });
        }
        const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
        const disp = url.searchParams.get("download") !== "0" ? "attachment" : "inline";
        return text(200, body, "application/x-ndjson; charset=utf-8", {
          "content-disposition": `${disp}; filename="oi-bot-logs-${stampText}.jsonl"`,
        });
      }

      if (method === "GET" && pathname === "/api/report") {
        const format = (url.searchParams.get("format") || "html").toLowerCase();
        const download = url.searchParams.get("download") !== "0";
        const data = this.engine.getReportData();
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
        const result = this.engine.updateSettings(patch);
        await this.store.flush();
        return json(200, { ok: true, ...result, stats: this.engine.getStats() });
      }

      if (method === "POST" && pathname === "/api/device/market") {
        const body = await readBody(request);
        const result = this.engine.ingestDeviceFeed(body || {});
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
        const result = this.engine.setCoinglassApiKey(key);
        await this.store.flush();
        return json(200, { ok: true, ...result, stats: this.engine.getStats() });
      }

      if (method === "POST" && pathname === "/api/control") {
        const body = await readBody(request);
        const action = String(body?.action || "");
        let result;
        if (action === "start") result = this.engine.start("ui");
        else if (action === "pause") result = this.engine.pause("ui");
        else if (action === "toggle") result = this.engine.toggle();
        else if (action === "reset") result = this.engine.reset();
        else if (action === "close-all") result = await this.engine.closeAll("Manual close all");
        else return json(400, { ok: false, error: "unknown-action" });
        await this.store.flush();
        return json(200, { ok: true, ...result });
      }

      if (method === "POST" && pathname === "/api/scan") {
        const result = await this.engine.scan({ manual: true });
        await this.store.flush();
        return json(200, { ok: true, ...result });
      }

      if (method === "POST" && pathname === "/api/trade/open") {
        const body = await readBody(request);
        const result = await this.engine.openManual(body?.symbol, { force: body?.force !== false });
        await this.store.flush();
        return json(result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/trade/close") {
        const body = await readBody(request);
        const result = await this.engine.closePositionById(
          String(body?.id || ""),
          body?.reason || "Manual"
        );
        await this.store.flush();
        return json(result.ok ? 200 : 400, result);
      }

      return json(404, { ok: false, error: "not-found" });
    } catch (err) {
      const status = err.message === "invalid-json" ? 400 : 500;
      console.error("[api]", err);
      return json(status, { ok: false, error: err.message || "server-error" });
    } finally {
      this.ctx.waitUntil(this.store.flush().catch(() => null));
    }
  }
}
