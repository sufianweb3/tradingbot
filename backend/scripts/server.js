/**
 * Zero-dependency local web server + JSON API.
 * For local development and testing only.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { Engine } from "../src/engine.js";
import { pullRemoteState, remoteEnabled } from "../src/remoteState.js";
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
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || "0.0.0.0";

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
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,authorization",
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

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
if (!ADMIN_SECRET) console.warn("[server] ADMIN_SECRET is not set: the API is open. Set it before exposing this server.");

function isAuthorized(req) {
  if (!ADMIN_SECRET) return true;
  const header = String(req.headers.authorization || "");
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(ADMIN_SECRET).digest();
  return crypto.timingSafeEqual(a, b);
}

if (remoteEnabled) {
  const remote = await pullRemoteState();
  if (remote) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, "state.json"), remote, "utf8");
    console.log("[server] state restored from remote store");
  }
}

const engine = new Engine({ dataDir: DATA_DIR });
engine.init().catch((err) => {
  console.error("[engine] init error:", err.message);
});

async function syncLiveAdapterForVenue(venue) {
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

// Passive AI dataset logger
let aiLogger = { dispose() {} };
try {
  aiLogger = attachAiTradeLogger(engine);
} catch (err) {
  console.warn(`[ai-dataset] disabled: ${err.message}`);
}

function dashboardPayload() {
  return {
    ok: true,
    serverTime: now(),
    ...engine.getLive(),
    markets: engine.getMarketRows(),
    meta: engine.getMeta(),
    venues: engine.hub ? engine.hub.summary() : null,
    stats: engine.getStats(),
  };
}

// Minimal dependency-free WebSocket (RFC 6455) used to push the dashboard snapshot.
const wsClients = new Set();

function wsFrame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) head = Buffer.from([0x80 | opcode, 126, len >> 8, len & 255]);
  else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

function wsBroadcast() {
  if (!wsClients.size) return;
  const frame = wsFrame(0x1, Buffer.from(JSON.stringify(dashboardPayload())));
  for (const sock of wsClients) sock.write(frame);
}
setInterval(wsBroadcast, 1000).unref();

function handleUpgrade(req, socket) {
  const url = new URL(req.url || "/", "http://x");
  const key = req.headers["sec-websocket-key"];
  const fail = (line) => {
    socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (url.pathname !== "/ws" || !key) return fail("404 Not Found");
  if (ADMIN_SECRET) {
    const a = crypto.createHash("sha256").update(url.searchParams.get("token") || "").digest();
    const b = crypto.createHash("sha256").update(ADMIN_SECRET).digest();
    if (!crypto.timingSafeEqual(a, b)) return fail("401 Unauthorized");
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  wsClients.add(socket);
  socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(dashboardPayload()))));
  socket.on("data", (buf) => {
    const op = buf[0] & 0x0f;
    if (op === 0x8) socket.end(wsFrame(0x8, Buffer.alloc(0)));
    else if (op === 0x9) socket.write(wsFrame(0xa, Buffer.alloc(0)));
  });
  const drop = () => wsClients.delete(socket);
  socket.on("close", drop);
  socket.on("error", drop);
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
          "access-control-allow-headers": "content-type,authorization",
        });
        return res.end();
      }

      if (pathname !== "/api/health" && !isAuthorized(req)) {
        return sendJson(res, 401, { ok: false, error: "unauthorized" });
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
            /* serve empty cache */
          }
        }
        return sendJson(res, 200, dashboardPayload());
      }

      if (method === "GET" && pathname === "/api/markets") {
        return sendJson(res, 200, { ok: true, markets: engine.getMarketRows() });
      }

      if ((method === "GET" || method === "POST") && pathname === "/api/eqe") {
        const body = method === "POST" ? await readBody(req).catch(() => ({})) : {};
        const symbol = body?.symbol || url.searchParams.get("symbol") || "BTC";
        const side = body?.side || url.searchParams.get("side") || "long";
        const notional = body?.notional ?? url.searchParams.get("notional");
        const eqe = await engine.evaluateSymbolEqe(symbol, side, notional, body?.book || null);
        return sendJson(res, 200, eqe);
      }

      if ((method === "GET" || method === "POST") && pathname === "/api/route") {
        const body = method === "POST" ? await readBody(req).catch(() => ({})) : {};
        const symbol = body?.symbol || url.searchParams.get("symbol") || "BTC";
        const side = body?.side || url.searchParams.get("side") || "long";
        const notional = body?.notional ?? url.searchParams.get("notional");
        const route = await engine.evaluateSymbolRoute(symbol, side, notional, body?.candidates || null);
        return sendJson(res, 200, route);
      }

      if (method === "GET" && pathname === "/api/speed") {
        return sendJson(res, 200, { ok: true, ...engine.getSpeedTelemetry() });
      }

      if (method === "GET" && pathname === "/api/venues/health") {
        return sendJson(res, 200, { ok: true, venues: engine.getVenuesHealth() });
      }

      if (method === "POST" && pathname === "/api/reconcile") {
        const rec = await engine.liveExecutor.reconcile();
        return sendJson(res, 200, { ok: true, ...rec });
      }

      if (method === "POST" && pathname === "/api/preflight") {
        const body = await readBody(req).catch(() => ({}));
        const pre = await engine.runPreflight(body || {});
        return sendJson(res, 200, pre);
      }

      if (method === "GET" && pathname === "/api/config") {
        return sendJson(res, 200, { ok: true, ...engine.getConfig() });
      }

      if (method === "GET" && pathname === "/api/trades") {
        const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
        const all = engine.state.trades || [];
        const total = all.length;
        const start = (page - 1) * limit;
        const slice = all.slice(Math.max(0, total - start - limit), Math.max(0, total - start)).reverse();
        return sendJson(res, 200, { ok: true, trades: slice, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
      }

      if (method === "GET" && pathname === "/api/logs") {
        const stampText = stamp();
        const records = [
          {
            record: "snapshot",
            timestamp: now(),
            uptimeSec: Math.round(process.uptime()),
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
        if (!patch || typeof patch !== "object") return sendJson(res, 400, { ok: false, error: "invalid-settings" });
        const prevExchange = engine.state.settings?.live?.exchange || "bybit";
        const result = engine.updateSettings(patch);
        const nextExchange = engine.state.settings?.live?.exchange || "bybit";
        if (nextExchange !== prevExchange) {
          await syncLiveAdapterForVenue(nextExchange);
        }
        return sendJson(res, 200, { ok: true, ...result, stats: engine.getStats() });
      }

      if (method === "GET" && pathname === "/api/exchange/status") {
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
        const connected = await syncLiveAdapterForVenue(supported.id);
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
            capabilityProbe = { ok: false, trading: false, futuresOrderAvailable: false, message: err.message };
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
        const active = body?.active !== undefined ? Boolean(body.active) : !engine.killSwitchActive;
        engine.killSwitchActive = active;
        engine.log(active ? "warn" : "info", `Kill switch ${active ? "ACTIVATED (all new entries stopped)" : "DEACTIVATED"}`);
        return sendJson(res, 200, { ok: true, active: engine.killSwitchActive });
      }

      if (method === "POST" && pathname === "/api/panic") {
        const result = await engine.activeExecutor.panic();
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (method === "POST" && pathname === "/api/coinglass/key") {
        const body = await readBody(req);
        const key = body?.clear === true ? null : body?.apiKey ?? body?.key;
        if (key !== null && typeof key !== "string") return sendJson(res, 400, { ok: false, error: "invalid-api-key" });
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
        const side = body?.side === "long" || body?.side === "short" ? body.side : null;
        const result = await engine.openManual(body?.symbol, {
          force: body?.force !== false,
          side,
        });
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/trade/close") {
        const body = await readBody(req);
        const result = await engine.closePositionById(String(body?.id || ""), body?.reason || "Manual");
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "GET" && pathname === "/api/backup/export") {
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
        const result = engine.store.importBackup(body);
        engine.state = engine.store.state;
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (method === "POST" && pathname === "/api/device/market") {
        const body = await readBody(req);
        const result = engine.ingestDeviceFeed(body);
        return sendJson(res, result.ok ? 200 : 400, result);
      }

      if (method === "POST" && pathname === "/api/status-config") {
        const body = await readBody(req);
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

server.on("upgrade", handleUpgrade);

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  OI Sniper - local development server");
  console.log(`  -> http://${HOST}:${PORT}`);
  console.log(`  data: ${path.join(DATA_DIR, "state.json")}`);
  console.log("");
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, saving state...`);
  try {
    aiLogger.dispose();
  } catch {
    /* ignore */
  }
  engine.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
