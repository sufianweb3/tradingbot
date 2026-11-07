/**
 * Zero-dependency local web server + JSON API.
 * For local development and testing only.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Portfolio } from "../src/portfolio.js";
import { cgFetch } from "../src/coinglass.js";
import { attachAiTradeLogger } from "../src/aiDataset.js";
import { logExportFilename, streamBotLogExport } from "../src/logExport.js";
import { renderCsv, renderJson, renderReport } from "../src/report.js";
import { now, toNum } from "../src/util.js";
import {
  saveCredentials,
  getCredentials,
  removeCredentials,
  listVaultEntries,
  maskKey,
} from "../src/vault.js";
import { createVenueAdapter, SUPPORTED_VENUES } from "../src/venues/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const DIST_DIR = path.join(ROOT, "dist");
const DASHBOARD_DIR = path.join(DIST_DIR, "dashboard");
const DASHBOARD_SRC_DIR = path.join(ROOT, "dashboard", "dist");
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

const CSP =
  "default-src 'self'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; connect-src 'self' https://capi.coinglass.com https://open-api-v4.coinglass.com https://contract.mexc.com https://api.gateio.ws https://api-futures.kucoin.com https://fapi.binance.com https://api.bybit.com https://api.bitget.com https://www.okx.com;";

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

function resolveStaticPath(rel) {
  // Check dist first
  const inDist = path.resolve(DIST_DIR, rel);
  if (inDist.startsWith(DIST_DIR + path.sep) && fs.existsSync(inDist) && fs.statSync(inDist).isFile()) {
    return inDist;
  }
  // Check web/
  if (rel.startsWith("web/")) {
    const inWeb = path.resolve(ROOT, rel);
    if (inWeb.startsWith(path.join(ROOT, "web") + path.sep) && fs.existsSync(inWeb) && fs.statSync(inWeb).isFile()) {
      return inWeb;
    }
  }
  // Check src/
  if (rel.startsWith("src/")) {
    const inSrc = path.resolve(ROOT, rel);
    if (inSrc.startsWith(path.join(ROOT, "src") + path.sep) && fs.existsSync(inSrc) && fs.statSync(inSrc).isFile()) {
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

function dashboardRoot() {
  if (fs.existsSync(path.join(DASHBOARD_DIR, "index.html"))) return DASHBOARD_DIR;
  if (fs.existsSync(path.join(DASHBOARD_SRC_DIR, "index.html"))) return DASHBOARD_SRC_DIR;
  return null;
}

async function serveDashboard(req, res, pathname) {
  const root = dashboardRoot();
  if (!root) {
    sendText(
      res,
      404,
      "React dashboard build not found. Run `npm run build:dashboard` or `npm run build`.",
      "text/plain; charset=utf-8"
    );
    return;
  }

  let rel = pathname.replace(/^\/dashboard\/?/, "") || "index.html";
  rel = decodeURIComponent(rel).replace(/\\/g, "/");

  const full = path.resolve(root, rel);
  const insideRoot =
    full === root || full.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

  if (insideRoot && fs.existsSync(full) && fs.statSync(full).isFile()) {
    const ext = path.extname(full).toLowerCase();
    const immutable = rel.startsWith("assets/");
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache, must-revalidate",
      "x-content-type-options": "nosniff",
      "content-security-policy": CSP,
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  // Client-side routing: every unknown /dashboard/* path renders the SPA.
  const index = path.join(root, "index.html");
  res.writeHead(200, {
    "content-type": MIME[".html"],
    "cache-control": "no-cache, must-revalidate",
    "x-content-type-options": "nosniff",
    "content-security-policy": CSP,
  });
  fs.createReadStream(index).pipe(res);
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

const portfolio = new Portfolio({ dataDir: DATA_DIR });
await portfolio.init();

function strategyIdFrom(url, body = null) {
  return String(
    body?.strategy || body?.strategyId || url.searchParams.get("strategy") || ""
  ).trim();
}

function engineFor(url, body = null) {
  const id = strategyIdFrom(url, body);
  if (id) return portfolio.resolve(id);
  return portfolio.selected();
}

function findEngineWithPosition(id) {
  for (const engine of portfolio.engines.values()) {
    if (engine.state.positions.some((p) => p.id === id)) return engine;
  }
  return null;
}

function strategyError(res) {
  return sendJson(res, 404, { ok: false, error: "strategy-not-found" });
}

// Passive AI dataset loggers: one observer per strategy, each writing to its
// own folder. Removing this block leaves the bot and its trading logic identical.
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

async function syncLiveAdapterForVenue(venue, engine = portfolio.selected()) {
  if (!engine) return false;
  const creds = await getCredentials(venue, { idbStore: engine.store });
  if (creds?.apiKey && creds?.secret) {
    try {
      const adapter = createVenueAdapter(venue, {
        apiKey: creds.apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
      });
      engine.setLiveAdapter(adapter);
      if (engine.state.settings?.mode === "live" && engine.liveExecutor) {
        try {
          await engine.liveExecutor.init();
        } catch (err) {
          console.warn(`[server] Live executor init warning for ${venue}:`, err?.message);
        }
      }
      return true;
    } catch (err) {
      console.warn(`[server] Failed to create adapter for ${venue}:`, err?.message);
    }
  }
  engine.setLiveAdapter(null);
  if (engine.state.settings?.mode === "live") {
    await engine.setMode("paper");
  }
  return false;
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
          if (!engine) return strategyError(res);
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

      if (method === "GET" && pathname === "/api/coinglass/markets") {
        const page = Math.max(1, Math.min(40, Number(url.searchParams.get("page")) || 1));
        const target =
          `https://capi.coinglass.com/api/home/v2/coinMarkets?sort=openInterest` +
          `&order=desc&keyword=&pageNum=${page}&pageSize=100&ex=all&tags=crypto`;
        try {
          const data = await cgFetch(target);
          return sendJson(res, 200, data);
        } catch (err) {
          return sendJson(res, 502, { ok: false, error: err.message || "coinglass-proxy-failed" });
        }
      }

      if (method === "GET" && pathname === "/api/bootstrap") {
        const payload = portfolio.getBootstrap(strategyIdFrom(url));
        if (payload.error) return sendJson(res, 404, { ok: false, ...payload });
        return sendJson(res, 200, { ok: true, ...payload });
      }

      if (method === "GET" && pathname === "/api/live") {
        const engine = engineFor(url);
        if (!engine) return strategyError(res);
        return sendJson(res, 200, { ok: true, ...engine.getLive() });
      }

      if (method === "GET" && pathname === "/api/dashboard") {
        const engine = engineFor(url);
        if (!engine) return strategyError(res);
        if (!engine.marketCache.coins.length) {
          try {
            await engine.refreshMarketsIfStale();
          } catch {
            /* serve empty cache */
          }
        }
        const payload = portfolio.getDashboard(engine.id);
        return sendJson(res, 200, { ok: true, ...payload });
      }

      if (method === "GET" && pathname === "/api/markets") {
        const engine = engineFor(url);
        if (!engine) return strategyError(res);
        return sendJson(res, 200, {
          ok: true,
          markets: engine.getMarketRows(),
          meta: engine.getMeta(),
          venues: portfolio.hub.summary(),
          selectedId: engine.id,
          strategies: portfolio.list(),
          portfolio: portfolio.summary(),
        });
      }

      if ((method === "GET" || method === "POST") && pathname === "/api/eqe") {
        const body = method === "POST" ? await readBody(req).catch(() => ({})) : {};
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const symbol = body?.symbol || url.searchParams.get("symbol") || "BTC";
        const side = body?.side || url.searchParams.get("side") || "long";
        const notional = body?.notional ?? url.searchParams.get("notional");
        const eqe = await engine.evaluateSymbolEqe(symbol, side, notional, body?.book || null);
        return sendJson(res, 200, eqe);
      }

      if ((method === "GET" || method === "POST") && pathname === "/api/route") {
        const body = method === "POST" ? await readBody(req).catch(() => ({})) : {};
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const symbol = body?.symbol || url.searchParams.get("symbol") || "BTC";
        const side = body?.side || url.searchParams.get("side") || "long";
        const notional = body?.notional ?? url.searchParams.get("notional");
        const route = await engine.evaluateSymbolRoute(symbol, side, notional, body?.candidates || null);
        return sendJson(res, 200, route);
      }

      if (method === "GET" && pathname === "/api/speed") {
        const engine = engineFor(url);
        if (!engine) return strategyError(res);
        return sendJson(res, 200, { ok: true, ...engine.getSpeedTelemetry() });
      }

      if (method === "GET" && pathname === "/api/venues/health") {
        const engine = engineFor(url);
        if (!engine) return strategyError(res);
        return sendJson(res, 200, { ok: true, venues: engine.getVenuesHealth() });
      }

      if (method === "POST" && pathname === "/api/reconcile") {
        const body = await readBody(req).catch(() => ({}));
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const rec = await engine.liveExecutor.reconcile();
        return sendJson(res, 200, { ok: true, ...rec });
      }

      if (method === "POST" && pathname === "/api/preflight") {
        const body = await readBody(req).catch(() => ({}));
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const pre = await engine.runPreflight(body || {});
        return sendJson(res, 200, pre);
      }

      if (method === "GET" && pathname === "/api/config") {
        const engine = engineFor(url);
        if (!engine) return strategyError(res);
        return sendJson(res, 200, {
          ok: true,
          strategy: { id: engine.id, name: engine.name },
          settings: engine.publicSettings(),
          initialFund: engine.state.initialFund,
          stats: engine.getStats(),
          strategies: portfolio.list(),
          portfolio: portfolio.summary(),
        });
      }

      if (method === "GET" && pathname === "/api/trades") {
        const engine = engineFor(url);
        if (!engine) return strategyError(res);
        const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
        const offsetParam = url.searchParams.get("offset");
        const offset =
          offsetParam === null
            ? (page - 1) * limit
            : Math.max(0, Number(offsetParam) || 0);
        const all = engine.state.trades || [];
        const total = all.length;
        const end = Math.max(0, total - offset);
        const start = Math.max(0, end - limit);
        const slice = all.slice(start, end).reverse();
        return sendJson(res, 200, {
          ok: true,
          trades: slice,
          total,
          offset,
          page,
          pages: Math.max(1, Math.ceil(total / limit)),
        });
      }

      if (method === "GET" && pathname === "/api/logs") {
        const engine = engineFor(url);
        if (!engine) return strategyError(res);
        const stampText = stamp();
        const records = [
          {
            record: "snapshot",
            timestamp: now(),
            uptimeSec: Math.round(process.uptime()),
            strategy: { id: engine.id, name: engine.name },
            stats: engine.getStats(),
            meta: engine.getMeta(),
          },
        ];
        for (const entry of engine.state.logs || []) {
          records.push({ record: "log", ...entry });
        }
        const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
        const disp = url.searchParams.get("download") !== "0" ? "attachment" : "inline";
        return sendText(res, 200, body, "application/x-ndjson; charset=utf-8", {
          "content-disposition": `${disp}; filename="oi-bot-logs-${stampText}.jsonl"`,
        });
      }

      if (method === "GET" && pathname === "/api/report") {
        const format = (url.searchParams.get("format") || "html").toLowerCase();
        const download = url.searchParams.get("download") !== "0";
        const data = portfolio.getReportData(strategyIdFrom(url));
        if (!data) return strategyError(res);
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
        if (!engine) return strategyError(res);
        const prevExchange = engine.state.settings?.live?.exchange || "bybit";
        const result = engine.updateSettings(clean);
        const nextExchange = engine.state.settings?.live?.exchange || "bybit";
        if (nextExchange !== prevExchange) {
          await syncLiveAdapterForVenue(nextExchange, engine);
        }
        return sendJson(res, 200, {
          ok: true,
          ...result,
          stats: engine.getStats(),
          strategies: portfolio.list(),
        });
      }

      if (method === "GET" && pathname === "/api/exchange/status") {
        const engine = engineFor(url);
        if (!engine) return strategyError(res);
        const entries = await listVaultEntries({ idbStore: engine.store });
        const activeVenue = engine.state.settings?.live?.exchange || "bybit";
        const venuesStatus = SUPPORTED_VENUES.map((v) => {
          const connectedEntry = entries.find((e) => e.venue === v.id);
          return {
            ...v,
            connected: Boolean(connectedEntry),
            maskedKey: connectedEntry?.maskedKey || null,
            updatedAt: connectedEntry?.updatedAt || null,
            isActive: v.id === activeVenue,
          };
        });
        return sendJson(res, 200, {
          ok: true,
          mode: engine.state.settings?.mode || "paper",
          activeVenue,
          venues: venuesStatus,
        });
      }

      if (method === "POST" && pathname === "/api/exchange/select") {
        const body = await readBody(req);
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const venue = String(body?.venue || "").toLowerCase().trim();
        const supported = SUPPORTED_VENUES.find((v) => v.id === venue);
        if (!supported) {
          return sendJson(res, 400, { ok: false, error: `Unsupported exchange venue: '${venue}'` });
        }
        engine.updateSettings({
          live: {
            ...(engine.state.settings?.live || {}),
            exchange: supported.id,
          },
        });
        const connected = await syncLiveAdapterForVenue(supported.id, engine);
        return sendJson(res, 200, {
          ok: true,
          activeVenue: supported.id,
          connected,
          mode: engine.state.settings?.mode || "paper",
          settings: engine.publicSettings(),
        });
      }

      if (method === "POST" && pathname === "/api/exchange/connect") {
        const body = await readBody(req);
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const { venue, apiKey, secret, passphrase } = body || {};
        if (!venue || !apiKey || !secret) {
          return sendJson(res, 400, { ok: false, error: "missing-venue-or-credentials" });
        }
        let adapter;
        try {
          adapter = createVenueAdapter(venue, { apiKey, secret, passphrase });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
        const val = await adapter.validateKey({ apiKey, secret, passphrase });
        if (!val.ok) {
          return sendJson(res, 400, {
            ok: false,
            canTrade: false,
            canWithdraw: Boolean(val.canWithdraw),
            error: val.error || "Key validation failed",
          });
        }
        await saveCredentials(venue, { apiKey, secret, passphrase }, { idbStore: engine.store });
        engine.setLiveAdapter(adapter);
        engine.updateSettings({
          live: {
            ...(engine.state.settings?.live || {}),
            exchange: adapter.id,
          },
        });
        return sendJson(res, 200, {
          ok: true,
          venue: adapter.id,
          activeVenue: adapter.id,
          canTrade: true,
          canWithdraw: false,
          maskedKey: maskKey(apiKey),
          settings: engine.publicSettings(),
        });
      }

      if (method === "POST" && pathname === "/api/exchange/test") {
        const body = await readBody(req);
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const venue = body?.venue || engine.state.settings?.live?.exchange || "bybit";
        let apiKey = body?.apiKey;
        let secret = body?.secret;
        let passphrase = body?.passphrase;
        if (!apiKey || !secret) {
          const creds = await getCredentials(venue, { idbStore: engine.store });
          if (!creds) {
            return sendJson(res, 400, { ok: false, error: `No stored credentials found for ${venue}` });
          }
          apiKey = creds.apiKey;
          secret = creds.secret;
          passphrase = creds.passphrase;
        }
        let adapter;
        try {
          adapter = createVenueAdapter(venue, { apiKey, secret, passphrase });
        } catch (err) {
          return sendJson(res, 400, { ok: false, error: err.message });
        }
        const val = await adapter.validateKey({ apiKey, secret, passphrase });
        if (!val.ok) {
          return sendJson(res, 400, {
            ok: false,
            venue,
            canTrade: false,
            canWithdraw: Boolean(val.canWithdraw),
            error: val.error,
          });
        }
        let balance = { availableUsdt: 0, equityUsdt: 0 };
        try {
          balance = await adapter.getBalance();
        } catch (err) {
          return sendJson(res, 400, { ok: false, venue, error: `Balance check failed: ${err.message}` });
        }
        let instruments = [];
        try {
          instruments = await adapter.getInstruments();
        } catch (err) {
          console.warn(`[server] Instruments load warning for ${venue}:`, err?.message);
        }
        let modeCheck = { oneWay: true, isolated: true };
        try {
          modeCheck = await adapter.ensureAccountMode();
        } catch (err) {
          console.warn(`[server] Account mode check warning for ${venue}:`, err?.message);
        }
        let capabilities = { trading: true };
        let capabilityProbe = null;
        if (typeof adapter.probeCapability === "function") {
          try {
            capabilityProbe = await adapter.probeCapability();
          } catch (err) {
            capabilityProbe = {
              ok: false,
              trading: false,
              futuresOrderAvailable: false,
              message: err.message,
            };
          }
        }
        if (typeof adapter.capabilities === "function") {
          capabilities = adapter.capabilities();
        }
        return sendJson(res, 200, {
          ok: true,
          venue,
          canTrade: true,
          canWithdraw: false,
          balance,
          instrumentsCount: instruments.length,
          accountMode: modeCheck,
          capabilities,
          capabilityProbe,
        });
      }

      if (method === "POST" && pathname === "/api/exchange/disconnect") {
        const body = await readBody(req);
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const venue = body?.venue;
        if (!venue) return sendJson(res, 400, { ok: false, error: "missing-venue" });
        await removeCredentials(venue, { idbStore: engine.store });
        if (engine.state.settings?.live?.exchange === venue && engine.state.settings?.mode === "live") {
          await engine.setMode("paper");
        }
        return sendJson(res, 200, { ok: true, venue });
      }

      if (method === "POST" && pathname === "/api/mode") {
        const body = await readBody(req);
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const targetMode = body?.mode === "live" ? "live" : "paper";
        if (targetMode === "live") {
          const confirmed =
            body?.confirmed === true ||
            String(body?.confirmation || "").trim() === "LIVE" ||
            String(body?.confirmation || "").trim() === "I UNDERSTAND";
          if (!confirmed) {
            return sendJson(res, 400, {
              ok: false,
              error: "Please confirm switching to Live mode.",
            });
          }
          const activeVenue = engine.state.settings?.live?.exchange || "bybit";
          const creds = await getCredentials(activeVenue, { idbStore: engine.store });
          if (!creds) {
            return sendJson(res, 400, {
              ok: false,
              error: `Cannot switch to Live: no credentials found for ${activeVenue}. Connect exchange first.`,
            });
          }
          const adapter = createVenueAdapter(activeVenue, {
            apiKey: creds.apiKey,
            secret: creds.secret,
            passphrase: creds.passphrase,
          });
          const val = await adapter.validateKey(creds);
          if (!val.ok) {
            return sendJson(res, 400, {
              ok: false,
              error: `Connection test failed for ${activeVenue}: ${val.error}`,
            });
          }
          if (typeof adapter.probeCapability === "function") {
            try {
              await adapter.probeCapability();
            } catch {
              /* Handled via capabilities() check below */
            }
          }
          const caps = typeof adapter.capabilities === "function" ? adapter.capabilities() : { trading: true };
          if (!caps.trading) {
            return sendJson(res, 400, {
              ok: false,
              error: caps.reason || "Futures order API unavailable at MEXC",
            });
          }
          engine.setLiveAdapter(adapter);
        }
        const result = await engine.setMode(targetMode);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/kill-switch") {
        const body = await readBody(req);
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const active = body?.active !== undefined ? Boolean(body.active) : !engine.killSwitchActive;
        engine.killSwitchActive = active;
        engine.log(
          active ? "warn" : "info",
          `Kill switch ${active ? "ACTIVATED (all new entries stopped)" : "DEACTIVATED"}`
        );
        return sendJson(res, 200, { ok: true, active: engine.killSwitchActive });
      }

      if (method === "POST" && pathname === "/api/panic") {
        const body = await readBody(req).catch(() => ({}));
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const result = await engine.activeExecutor.panic();
        return sendJson(res, 200, { ok: true, ...result });
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
        if (!engine) return strategyError(res);
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
        if (!engine) return strategyError(res);
        const result = await engine.scan({ manual: true });
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (method === "POST" && pathname === "/api/trade/open") {
        const body = await readBody(req);
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const side = body?.side === "long" || body?.side === "short" ? body.side : null;
        const result = await engine.openManual(body?.symbol, {
          force: body?.force !== false,
          side,
        });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/trade/close") {
        const body = await readBody(req);
        const id = String(body?.id || "");
        const engine = findEngineWithPosition(id) || engineFor(url, body);
        if (!engine) return strategyError(res);
        const result = await engine.closePositionById(id, body?.reason || "Manual");
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "GET" && pathname === "/api/backup/export") {
        const engine = engineFor(url);
        if (!engine) return strategyError(res);
        const includeKeys = url.searchParams.get("includeKeys") === "true";
        const backup = engine.store.exportBackup({ includeKeys });
        return sendJson(res, 200, {
          ok: true,
          backup,
          filename: `oi-sniper-backup-${stamp()}.json`,
        });
      }

      if (method === "POST" && pathname === "/api/backup/import") {
        const body = await readBody(req);
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const result = engine.store.importBackup(body);
        engine.state = engine.store.state;
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (method === "POST" && pathname === "/api/device/market") {
        const body = await readBody(req);
        const result = portfolio.ingestDeviceFeed(body);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/status-config") {
        const body = await readBody(req);
        const engine = engineFor(url, body);
        if (!engine) return strategyError(res);
        const { liveEnabled = true, message = "" } = body || {};
        engine.setStatusConfig({ liveEnabled, message });
        return sendJson(res, 200, { ok: true, liveEnabled: engine.liveEnabled });
      }

      return sendJson(res, 404, { ok: false, error: "not-found" });
    }

    if (method !== "GET" && method !== "HEAD") {
      return sendText(res, 405, "Method not allowed");
    }
    if (pathname === "/dashboard" || pathname.startsWith("/dashboard/")) {
      return serveDashboard(req, res, pathname);
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
  console.log("  OI Sniper - multi-strategy local development server");
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
