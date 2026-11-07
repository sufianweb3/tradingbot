/**
 * Zero-dependency local web server + JSON API.
 *
 * The server hosts a portfolio of independent paper strategies. Existing
 * clients keep working: when no `strategy` is supplied the selected strategy is
 * used, which is the account migrated from the old single-strategy state file.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Portfolio } from "./src/portfolio.js";
import { attachAiTradeLogger } from "./src/aiDataset.js";
import { logExportFilename, streamBotLogExport } from "./src/logExport.js";
import { renderCsv, renderJson, renderReport } from "./src/report.js";
import { now, toNum } from "./src/util.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, "data");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendText(res, status, body, type = "text/plain; charset=utf-8", extra = {}) {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error("request-too-large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid-json"));
      }
    });
    req.on("error", reject);
  });
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function strategyIdFrom(url, body = null) {
  return String(
    body?.strategy || body?.strategyId || url.searchParams.get("strategy") || ""
  ).trim();
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  rel = decodeURIComponent(rel).replace(/\\/g, "/");
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== PUBLIC_DIR) {
    return sendText(res, 403, "Forbidden");
  }
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) throw new Error("not a file");
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(full).pipe(res);
  } catch {
    // SPA fallback
    const index = path.join(PUBLIC_DIR, "index.html");
    if (fs.existsSync(index)) {
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
      fs.createReadStream(index).pipe(res);
    } else {
      sendText(res, 404, "Not found. Run `npm start` from the project directory.");
    }
  }
}

const portfolio = new Portfolio({ dataDir: DATA_DIR });
await portfolio.init();

// Passive AI dataset logger. One observer per strategy, each writing to its own
// folder. Removing this block leaves the bot and its trading logic identical.
const aiLoggers = new Map();
try {
  const aiRoot = process.env.AI_DATASET_DIR
    ? path.resolve(process.env.AI_DATASET_DIR)
    : path.join(DATA_DIR, "ai-dataset");
  for (const engine of portfolio.engines.values()) {
    try {
      aiLoggers.set(
        engine.id,
        attachAiTradeLogger(engine, { dir: path.join(aiRoot, engine.id) })
      );
    } catch (err) {
      console.warn(`[ai-dataset] ${engine.id} disabled: ${err.message}`);
    }
  }
} catch (err) {
  console.warn(`[ai-dataset] disabled: ${err.message}`);
}

function engineFor(url, body = null) {
  return portfolio.resolve(strategyIdFrom(url, body)) || portfolio.selected();
}

function findEngineWithPosition(id) {
  for (const engine of portfolio.engines.values()) {
    if (engine.state.positions.some((p) => p.id === id)) return engine;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;
  const method = req.method || "GET";

  try {
    if (pathname.startsWith("/api/")) {
      if (method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type",
        });
        return res.end();
      }

      if (method === "GET" && pathname === "/api/health") {
        const cg = portfolio.getMarketStatus();
        const strategies = portfolio.list();
        return sendJson(res, 200, {
          ok: true,
          serverTime: now(),
          running: strategies.some((s) => s.running),
          runningStrategies: strategies.filter((s) => s.running).length,
          strategies: strategies.length,
          positions: strategies.reduce((a, s) => a + s.openTrades, 0),
          trades: strategies.reduce((a, s) => a + s.totalTrades, 0),
          uptimeSec: Math.round(process.uptime()),
          coinglass: cg.state,
          coinglassConnected: cg.connected,
          coinglassCoins: cg.coins,
          coinglassSource: cg.source,
          coinglassApiKeySet: cg.apiKeySet,
        });
      }

      if (method === "GET" && pathname === "/api/strategies") {
        return sendJson(res, 200, {
          ok: true,
          selectedId: portfolio.selectedId(),
          strategies: portfolio.list(),
          portfolio: portfolio.summary(),
        });
      }

      if (method === "GET" && pathname === "/api/compare") {
        return sendJson(res, 200, {
          ok: true,
          selectedId: portfolio.selectedId(),
          strategies: portfolio.list(),
          portfolio: portfolio.summary(),
        });
      }

      if (method === "POST" && pathname === "/api/strategies") {
        const body = await readBody(req);
        const result = await portfolio.create({
          name: body?.name,
          fund: body?.fund,
          settings: body?.settings && typeof body.settings === "object" ? body.settings : null,
          cloneFrom: body?.cloneFrom || null,
          start: body?.start === true,
        });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/strategies/select") {
        const body = await readBody(req);
        const result = await portfolio.select(body?.id);
        return sendJson(res, result.ok ? 200 : 404, result);
      }

      const strategyRoute = pathname.match(/^\/api\/strategies\/([^/]+)$/);
      if (strategyRoute) {
        const id = decodeURIComponent(strategyRoute[1]);
        if (method === "GET") {
          const engine = portfolio.resolve(id);
          if (!engine) return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
          return sendJson(res, 200, {
            ok: true,
            strategy: portfolio.list().find((s) => s.id === id),
            settings: engine.publicSettings(),
            stats: engine.getStats(),
          });
        }
        if (method === "DELETE") {
          const result = await portfolio.remove(id);
          return sendJson(res, result.ok ? 200 : 400, result);
        }
        if (method === "POST" || method === "PATCH") {
          const body = await readBody(req);
          const result = await portfolio.update(id, {
            name: body?.name,
            fund: body?.fund,
            settings: body?.settings && typeof body.settings === "object" ? body.settings : body,
            start: body?.start === true,
            pause: body?.pause === true,
          });
          return sendJson(res, result.ok ? 200 : 404, result);
        }
      }

      if (method === "GET" && pathname === "/api/bootstrap") {
        const payload = portfolio.getBootstrap(strategyIdFrom(url));
        if (payload.error) return sendJson(res, 404, { ok: false, ...payload });
        return sendJson(res, 200, { ok: true, ...payload });
      }

      if (method === "GET" && pathname === "/api/live") {
        const engine = engineFor(url);
        if (!engine) return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
        return sendJson(res, 200, { ok: true, ...engine.getLive() });
      }

      if (method === "GET" && pathname === "/api/dashboard") {
        const engine = engineFor(url);
        if (!engine) return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
        if (!engine.marketCache.coins.length) {
          try {
            await engine.refreshMarketsIfStale();
          } catch {
            /* serve the empty cache */
          }
        } else if (engine.marketCache.error || now() - engine.marketCache.at > 900) {
          engine.refreshMarketsIfStale().catch(() => null);
        }
        const payload = portfolio.getDashboard(engine.id);
        return sendJson(res, 200, { ok: true, ...payload });
      }

      if (method === "GET" && pathname === "/api/markets") {
        const engine = engineFor(url);
        if (!engine) return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
        // Serve the cached table immediately, refresh in the background.
        if (!engine.marketCache.coins.length) {
          try {
            await engine.refreshMarketsIfStale();
          } catch {
            /* fall through to the empty cache */
          }
        } else if (engine.marketCache.error || now() - engine.marketCache.at > 900) {
          engine.refreshMarketsIfStale().catch(() => null);
        }
        return sendJson(res, 200, {
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
        const engine = engineFor(url);
        const config = portfolio.getStrategyConfig(engine?.id);
        if (!config) return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
        return sendJson(res, 200, {
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
        const data = portfolio.getTrades(strategyIdFrom(url), { limit, offset });
        return sendJson(res, 200, { ok: true, ...data });
      }

      if (method === "GET" && pathname === "/api/logs") {
        const engine = engineFor(url);
        const logger = engine ? aiLoggers.get(engine.id) : null;
        const includeDataset = url.searchParams.get("dataset") !== "0";
        const download = url.searchParams.get("download") !== "0";
        const disp = download ? "attachment" : "inline";
        res.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "content-disposition": `${disp}; filename="${logExportFilename()}"`,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        try {
          const chunks = streamBotLogExport(engine, {
            datasetDir: logger?.dir || null,
            includeDataset,
          });
          for await (const chunk of chunks) {
            if (res.destroyed) break;
            if (!res.write(chunk)) {
              await new Promise((resolve) => res.once("drain", resolve));
            }
          }
        } catch (err) {
          console.error("[logs]", err.message);
        }
        res.end();
        return;
      }

      if (method === "GET" && pathname === "/api/report") {
        const format = (url.searchParams.get("format") || "html").toLowerCase();
        const download = url.searchParams.get("download") !== "0";
        const data = portfolio.getReportData(strategyIdFrom(url));
        if (!data) return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
        const base = `oi-sniper-report-${stamp()}`;
        const disp = download ? "attachment" : "inline";
        if (format === "csv") {
          return sendText(res, 200, renderCsv(data), "text/csv; charset=utf-8", {
            "content-disposition": `${disp}; filename="${base}.csv"`,
          });
        }
        if (format === "json") {
          return sendText(res, 200, renderJson(data), "application/json; charset=utf-8", {
            "content-disposition": `${disp}; filename="${base}.json"`,
          });
        }
        return sendText(res, 200, renderReport(data), "text/html; charset=utf-8", {
          "content-disposition": `${disp}; filename="${base}.html"`,
        });
      }

      if (method === "POST" && pathname === "/api/settings") {
        const body = await readBody(req);
        const patch = body?.settings && typeof body.settings === "object" ? body.settings : body;
        if (!patch || typeof patch !== "object") {
          return sendJson(res, 400, { ok: false, error: "invalid-settings" });
        }
        const clean = { ...patch };
        delete clean.strategy;
        delete clean.strategyId;
        const engine = engineFor(url, body);
        if (!engine) return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
        const result = await portfolio.updateSettings(engine.id, clean);
        return sendJson(res, 200, { ok: true, ...result, strategies: portfolio.list() });
      }

      if (method === "POST" && pathname === "/api/device/market") {
        const body = await readBody(req);
        const result = portfolio.ingestDeviceFeed(body || {});
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/coinglass/key") {
        const body = await readBody(req);
        const key = body?.clear === true ? null : body?.apiKey ?? body?.key;
        if (key !== null && typeof key !== "string") {
          return sendJson(res, 400, { ok: false, error: "invalid-api-key" });
        }
        const result = await portfolio.setCoinglassApiKey(key);
        return sendJson(res, 200, {
          ok: true,
          ...result,
          stats: portfolio.selected()?.getStats(),
        });
      }

      if (method === "POST" && pathname === "/api/control") {
        const body = await readBody(req);
        const action = String(body?.action || "");
        const id = strategyIdFrom(url, body);
        if (action === "start-all") {
          const result = await portfolio.startAll();
          return sendJson(res, 200, { ok: true, ...result, strategies: portfolio.list() });
        }
        if (action === "pause-all") {
          const result = await portfolio.pauseAll();
          return sendJson(res, 200, { ok: true, ...result, strategies: portfolio.list() });
        }
        if (action === "close-all-strategies") {
          const result = await portfolio.closeAllStrategies();
          return sendJson(res, 200, { ok: true, ...result, strategies: portfolio.list() });
        }
        const engine = portfolio.resolve(id) || portfolio.selected();
        if (!engine) return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
        if (action === "start") {
          return sendJson(res, 200, {
            ok: true,
            ...portfolio.start(engine.id),
            strategies: portfolio.list(),
          });
        }
        if (action === "pause") {
          return sendJson(res, 200, {
            ok: true,
            ...portfolio.pause(engine.id),
            strategies: portfolio.list(),
          });
        }
        if (action === "toggle") {
          return sendJson(res, 200, {
            ok: true,
            ...portfolio.toggle(engine.id),
            strategies: portfolio.list(),
          });
        }
        if (action === "reset") {
          const result = await portfolio.reset(engine.id);
          return sendJson(res, 200, { ok: true, ...result, strategies: portfolio.list() });
        }
        if (action === "close-all") {
          const result = await portfolio.closeAll(engine.id);
          return sendJson(res, 200, { ok: true, ...result, strategies: portfolio.list() });
        }
        return sendJson(res, 400, { ok: false, error: "unknown-action" });
      }

      if (method === "POST" && pathname === "/api/scan") {
        const body = await readBody(req);
        const engine = engineFor(url, body);
        if (!engine) return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
        const result = await engine.scan({ manual: true });
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (method === "POST" && pathname === "/api/trade/open") {
        const body = await readBody(req);
        const engine = engineFor(url, body);
        if (!engine) return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
        const result = await engine.openManual(body?.symbol, { force: body?.force !== false });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/trade/close") {
        const body = await readBody(req);
        const id = String(body?.id || "");
        const engine = findEngineWithPosition(id) || engineFor(url, body);
        if (!engine) return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
        const result = await engine.closePositionById(id, body?.reason || "Manual");
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      return sendJson(res, 404, { ok: false, error: "not-found" });
    }

    if (method !== "GET" && method !== "HEAD") {
      return sendText(res, 405, "Method not allowed");
    }
    return serveStatic(req, res, pathname);
  } catch (err) {
    const status = err.message === "invalid-json" || err.message === "request-too-large" ? 400 : 500;
    console.error("[server]", err);
    return sendJson(res, status, { ok: false, error: err.message || "server-error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  OI Sniper - multi-strategy paper trading bot");
  console.log(`  -> http://${HOST}:${PORT}`);
  console.log(`  data: ${path.join(DATA_DIR, "strategies")}`);
  console.log(`  strategies: ${portfolio.list().length}`);
  console.log("");
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, saving state...`);
  for (const logger of aiLoggers.values()) {
    try {
      logger.dispose();
    } catch {
      /* logger is passive; never block shutdown */
    }
  }
  portfolio.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
