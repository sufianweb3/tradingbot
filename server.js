/**
 * Zero-dependency local web server + JSON API.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./src/engine.js";
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

const DIST_DIR = path.join(__dirname, "dist");

function resolveStaticPath(rel) {
  // Check dist first
  const inDist = path.resolve(DIST_DIR, rel);
  if (inDist.startsWith(DIST_DIR + path.sep) && fs.existsSync(inDist) && fs.statSync(inDist).isFile()) {
    return inDist;
  }
  // Check web/
  if (rel.startsWith("web/")) {
    const inWeb = path.resolve(__dirname, rel);
    if (inWeb.startsWith(path.join(__dirname, "web") + path.sep) && fs.existsSync(inWeb) && fs.statSync(inWeb).isFile()) {
      return inWeb;
    }
  }
  // Check src/
  if (rel.startsWith("src/")) {
    const inSrc = path.resolve(__dirname, rel);
    if (inSrc.startsWith(path.join(__dirname, "src") + path.sep) && fs.existsSync(inSrc) && fs.statSync(inSrc).isFile()) {
      return inSrc;
    }
  }
  // Check public/
  const inPublic = path.resolve(PUBLIC_DIR, rel);
  if (inPublic.startsWith(PUBLIC_DIR + path.sep) && fs.existsSync(inPublic) && fs.statSync(inPublic).isFile()) {
    return inPublic;
  }
  return null;
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  rel = decodeURIComponent(rel).replace(/\\/g, "/");

  const full = resolveStaticPath(rel);
  if (full) {
    const ext = path.extname(full).toLowerCase();
    const isStatus = rel === "status.json";
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": isStatus ? "no-store, no-cache, must-revalidate, max-age=0" : "no-cache, must-revalidate",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self' https://capi.coinglass.com https://open-api-v4.coinglass.com https://contract.mexc.com https://api.gateio.ws https://api-futures.kucoin.com https://fapi.binance.com https://api.bybit.com https://api.bitget.com https://www.okx.com;",
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  // SPA fallback
  const index = resolveStaticPath("index.html") || path.join(PUBLIC_DIR, "index.html");
  if (fs.existsSync(index)) {
    res.writeHead(200, {
      "content-type": MIME[".html"],
      "cache-control": "no-cache",
      "content-security-policy": "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self' https://capi.coinglass.com https://open-api-v4.coinglass.com https://contract.mexc.com https://api.gateio.ws https://api-futures.kucoin.com https://fapi.binance.com https://api.bybit.com https://api.bitget.com https://www.okx.com;",
    });
    fs.createReadStream(index).pipe(res);
  } else {
    sendText(res, 404, "Not found.");
  }
}

const engine = new Engine({ dataDir: DATA_DIR });
engine.init().catch((err) => {
  console.error("[engine] init error:", err.message);
});

// Passive AI dataset logger. It only listens to engine events and reads
// state; removing this block leaves the bot and its trading logic identical.
let aiLogger = { dispose() {} };
try {
  aiLogger = attachAiTradeLogger(engine);
} catch (err) {
  console.warn(`[ai-dataset] disabled: ${err.message}`);
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
          "access-control-allow-methods": "GET,POST,OPTIONS",
          "access-control-allow-headers": "content-type",
        });
        return res.end();
      }

      if (method === "GET" && pathname === "/api/health") {
        const cg = engine.getMarketStatus();
        return sendJson(res, 200, {
          ok: true,
          serverTime: now(),
          running: engine.state.meta.running,
          positions: engine.state.positions.length,
          trades: engine.state.trades.length,
          uptimeSec: Math.round(process.uptime()),
          coinglass: cg.state,
          coinglassConnected: cg.connected,
          coinglassCoins: cg.coins,
          coinglassSource: cg.source,
          coinglassApiKeySet: cg.apiKeySet,
        });
      }

      if (method === "GET" && pathname === "/api/bootstrap") {
        return sendJson(res, 200, { ok: true, ...engine.getBootstrap() });
      }

      if (method === "GET" && pathname === "/api/live") {
        return sendJson(res, 200, { ok: true, ...engine.getLive() });
      }

      if (method === "GET" && pathname === "/api/dashboard") {
        if (!engine.marketCache.coins.length) {
          try {
            await engine.refreshMarketsIfStale();
          } catch {
            /* serve the empty cache */
          }
        } else if (engine.marketCache.error || now() - engine.marketCache.at > 900) {
          engine.refreshMarketsIfStale().catch(() => null);
        }
        return sendJson(res, 200, {
          ok: true,
          serverTime: now(),
          ...engine.getLive(),
          markets: engine.getMarketRows(),
          meta: engine.getMeta(),
          venues: engine.hub.summary(),
        });
      }

      if (method === "GET" && pathname === "/api/markets") {
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
          venues: engine.hub.summary(),
        });
      }

      if (method === "GET" && pathname === "/api/config") {
        return sendJson(res, 200, {
          ok: true,
          settings: engine.publicSettings(),
          initialFund: engine.state.initialFund,
          stats: engine.getStats(),
        });
      }

      if (method === "GET" && pathname === "/api/trades") {
        const limit = toNum(url.searchParams.get("limit"), 200);
        const offset = toNum(url.searchParams.get("offset"), 0);
        const data = engine.getTrades({ limit, offset });
        return sendJson(res, 200, { ok: true, ...data });
      }

      if (method === "GET" && pathname === "/api/logs") {
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
            datasetDir: aiLogger?.dir || null,
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
        const data = engine.getReportData();
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
        const result = engine.updateSettings(patch);
        return sendJson(res, 200, { ok: true, ...result, stats: engine.getStats() });
      }

      if (method === "POST" && pathname === "/api/device/market") {
        const body = await readBody(req);
        const result = engine.ingestDeviceFeed(body || {});
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/coinglass/key") {
        const body = await readBody(req);
        const key = body?.clear === true ? null : body?.apiKey ?? body?.key;
        if (key !== null && typeof key !== "string") {
          return sendJson(res, 400, { ok: false, error: "invalid-api-key" });
        }
        const result = engine.setCoinglassApiKey(key);
        return sendJson(res, 200, { ok: true, ...result, stats: engine.getStats() });
      }

      if (method === "POST" && pathname === "/api/control") {
        const body = await readBody(req);
        const action = String(body?.action || "");
        if (action === "start") return sendJson(res, 200, { ok: true, ...engine.start("ui") });
        if (action === "pause") return sendJson(res, 200, { ok: true, ...engine.pause("ui") });
        if (action === "toggle") return sendJson(res, 200, { ok: true, ...engine.toggle() });
        if (action === "reset") {
          const result = engine.reset();
          return sendJson(res, 200, { ok: true, ...result });
        }
        if (action === "close-all") {
          const result = await engine.closeAll("Manual close all");
          return sendJson(res, 200, { ok: true, ...result });
        }
        return sendJson(res, 400, { ok: false, error: "unknown-action" });
      }

      if (method === "POST" && pathname === "/api/scan") {
        const result = await engine.scan({ manual: true });
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (method === "POST" && pathname === "/api/trade/open") {
        const body = await readBody(req);
        const result = await engine.openManual(body?.symbol, { force: body?.force !== false });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/trade/close") {
        const body = await readBody(req);
        const result = await engine.closePositionById(String(body?.id || ""), body?.reason || "Manual");
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
  console.log("  OI Sniper - paper trading bot");
  console.log(`  -> http://${HOST}:${PORT}`);
  console.log(`  data: ${path.join(DATA_DIR, "state.json")}`);
  console.log("");
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, saving state...`);
  try {
    aiLogger.dispose();
  } catch {
    /* logger is passive; never block shutdown */
  }
  engine.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
