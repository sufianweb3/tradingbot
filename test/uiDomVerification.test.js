import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "../src/engine.js";
import { saveCredentials } from "../src/vault.js";
import { handleRpcRequest } from "../web/routes.js";

const ROOT = path.resolve(".");
const cssPath = path.join(ROOT, "public/styles.css");
const appPath = path.join(ROOT, "public/app.js");
const htmlPath = path.join(ROOT, "public/index.html");
const routesPath = path.join(ROOT, "web/routes.js");
const serverPath = path.join(ROOT, "scripts/server.js");
const workerPath = path.join(ROOT, "web/worker.js");

test("DOM Verification: .empty-row b has block display and spacing", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  assert.match(
    css,
    /\.empty-row\s+b\s*\{[^}]*display:\s*block/i,
    ".empty-row b must have display: block to prevent text collisions"
  );
  assert.match(
    css,
    /\.empty-row\s+b\s*\{[^}]*margin(-bottom)?:\s*[1-9]/i,
    ".empty-row b must have positive margin-bottom separating title from description"
  );
});

test("DOM Verification: .kpi-sub displays without clipping or ellipsis", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  const kpiSubBlock = css.match(/\.kpi-sub\s*\{([^}]+)\}/);
  assert.ok(kpiSubBlock, ".kpi-sub rule must exist in styles.css");
  assert.doesNotMatch(
    kpiSubBlock[1],
    /text-overflow:\s*ellipsis/i,
    ".kpi-sub must not truncate with text-overflow: ellipsis"
  );
  assert.doesNotMatch(
    kpiSubBlock[1],
    /white-space:\s*nowrap/i,
    ".kpi-sub must allow wrapping or full-width breathing room"
  );
});

test("DOM Verification: HTML KPI cards place .kpi-sub after .kpi-value", () => {
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(
    html,
    /<div class="kpi-value hero-val" id="kpiEquity">[^<]*<\/div>\s*<div class="kpi-sub" id="kpiEquitySub">/,
    "kpiEquitySub must be placed below kpiEquity on its own dedicated full-width line"
  );
  assert.match(
    html,
    /<div class="kpi-value" id="kpiPnl">[^<]*<\/div>\s*<div class="kpi-sub" id="kpiPnlSub">/,
    "kpiPnlSub must be placed below kpiPnl on its own line"
  );
});

test("DOM Verification: coin logo and fallback badge CSS rules are defined with matching dimensions", () => {
  const css = fs.readFileSync(cssPath, "utf8");
  assert.match(css, /\.coin-logo\s*\{[^}]*width:\s*20px/i, ".coin-logo width must be 20px");
  assert.match(css, /\.coin-logo\s*\{[^}]*height:\s*20px/i, ".coin-logo height must be 20px");
  assert.match(css, /\.coin-fallback\s*\{[^}]*width:\s*20px/i, ".coin-fallback width must be 20px");
  assert.match(css, /\.coin-fallback\s*\{[^}]*height:\s*20px/i, ".coin-fallback height must be 20px");
  assert.match(css, /\.coin-badge-wrap\s*\{[^}]*width:\s*20px/i, ".coin-badge-wrap width must be 20px");
  assert.match(css, /\.coin-badge-wrap\s*\{[^}]*height:\s*20px/i, ".coin-badge-wrap height must be 20px");
});

test("DOM Verification: app.js contains coin logo helper with CoinCap CDN and fallback", () => {
  const app = fs.readFileSync(appPath, "utf8");
  assert.match(app, /assets\.coincap\.io\/assets\/icons/i, "app.js must use CoinCap CDN for coin logos");
  assert.match(app, /onerror=.*style\.display\s*=\s*['"]none['"]/i, "Coin logo img must hide on error");
  assert.match(app, /coin-fallback/i, "Coin fallback element must be rendered");
});

test("DOM Verification: Live Scanner table renders coin logos with fallback", () => {
  const app = fs.readFileSync(appPath, "utf8");
  const scannerFunc = app.slice(app.indexOf("function renderMarkets"), app.indexOf("function renderTrades"));
  assert.ok(
    scannerFunc.includes("coin-logo") || scannerFunc.includes("renderCoinBadge"),
    "Live Scanner table must render coin logo/badge"
  );
});

test("DOM Verification: CoinGlass table renders coin logos with fallback", () => {
  const app = fs.readFileSync(appPath, "utf8");
  const cgFunc = app.slice(app.indexOf("function renderCoinGlassTable"), app.indexOf("function renderBanner"));
  assert.ok(
    cgFunc.includes("coin-logo") || cgFunc.includes("renderCoinBadge"),
    "CoinGlass table must render coin logo/badge"
  );
});

test("DOM Verification: Open Positions cards render coin logos with fallback", () => {
  const app = fs.readFileSync(appPath, "utf8");
  const posFunc = app.slice(app.indexOf("function renderPositions"), app.indexOf("function filterFor"));
  assert.ok(
    posFunc.includes("coin-logo") || posFunc.includes("renderCoinBadge"),
    "Open Positions cards must render coin logo img and fallback"
  );
});

test("DOM Verification: Banner consolidation BANNER_CONFIG priority tiers defined", () => {
  const app = fs.readFileSync(appPath, "utf8");
  assert.match(app, /const BANNER_CONFIG = \{/, "BANNER_CONFIG must be defined");
  assert.match(app, /"offline":\s*\{\s*priority:\s*50/i, "offline feed banner priority configured");
  assert.match(app, /"stale":\s*\{\s*priority:\s*40/i, "stale feed banner priority configured");
});

test("DOM Verification: routes.js and server.js implement /api/device/market", () => {
  const routes = fs.readFileSync(routesPath, "utf8");
  const server = fs.readFileSync(serverPath, "utf8");
  assert.match(routes, /case\s+["']\/api\/device\/market["']:/, "routes.js must handle /api/device/market");
  assert.match(server, /pathname\s*===\s*["']\/api\/device\/market["']/, "server.js must handle /api/device/market");
});

test("DOM Verification: worker.js refreshes markets periodically", () => {
  const worker = fs.readFileSync(workerPath, "utf8");
  assert.match(worker, /await\s+engine\.refreshMarketsIfStale\(\)/, "worker.js must call refreshMarketsIfStale");
});

test("DOM Verification: Zero em and en dashes in public/ and src/", () => {
  const targetFiles = [
    cssPath,
    htmlPath,
    appPath,
    routesPath,
    serverPath,
    workerPath,
    path.join(ROOT, "src/util.js"),
    path.join(ROOT, "src/exchanges.js"),
    path.join(ROOT, "src/engine.js"),
    path.join(ROOT, "src/report.js"),
  ];
  for (const file of targetFiles) {
    const content = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(content, /[\u2013\u2014]/, `${path.basename(file)} must not contain em or en dashes`);
  }
});

test("DOM Verification: Exchange selector synchronization across modal, topbar, settings dropdown, and routes", () => {
  const app = fs.readFileSync(appPath, "utf8");
  const css = fs.readFileSync(cssPath, "utf8");
  const routes = fs.readFileSync(routesPath, "utf8");
  const server = fs.readFileSync(serverPath, "utf8");

  assert.match(routes, /case\s+["']\/api\/exchange\/select["']:/, "routes.js must implement /api/exchange/select");
  assert.match(server, /pathname\s*===\s*["']\/api\/exchange\/select["']/, "server.js must implement /api/exchange/select");
  assert.match(app, /async\s+function\s+selectActiveExchange/, "app.js must define selectActiveExchange");
  assert.match(app, /btn-select-exchange/, "app.js must render .btn-select-exchange buttons in #exchangeModal");
  assert.match(app, /exchange-active-badge/, "app.js must render .exchange-active-badge on the active exchange card");
  assert.match(css, /\.exchange-card-actions\s*\{/, "styles.css must define .exchange-card-actions");
  assert.match(css, /\.exchange-active-badge\s*\{/, "styles.css must define .exchange-active-badge");
});

test("Route Verification: POST /api/exchange/select updates settings.live.exchange and syncs liveExecutor adapter", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oi-exchange-select-"));
  const engine = new Engine({ dataDir: dir });

  const map = new Map();
  const mockStore = {
    state: engine.state,
    async flush() {},
    async getVaultKey(key) {
      return map.get(key) || null;
    },
    async putVaultKey(key, data) {
      map.set(key, { ...data, key });
      return true;
    },
    async deleteVaultKey(key) {
      map.delete(key);
      return true;
    },
    async listVaultKeys() {
      return Array.from(map.values());
    },
  };

  // Save credentials for gate in the vault
  await saveCredentials("gate", { apiKey: "gate-key-123456", secret: "gate-secret-123456" }, { idbStore: mockStore });

  // 1. Select gate (which has stored credentials)
  const resGate = await handleRpcRequest(
    {
      method: "POST",
      path: "/api/exchange/select",
      body: { venue: "gate" },
    },
    {
      engine,
      store: mockStore,
    }
  );
  assert.equal(resGate.status, 200);
  assert.equal(resGate.data.ok, true);
  assert.equal(resGate.data.activeVenue, "gate");
  assert.equal(resGate.data.connected, true);
  assert.equal(engine.state.settings.live.exchange, "gate");
  assert.equal(engine.liveExecutor.adapter?.id, "gate");

  // 2. Select binance (no stored credentials) -> updates exchange setting and clears adapter
  const resBinance = await handleRpcRequest(
    {
      method: "POST",
      path: "/api/exchange/select",
      body: { venue: "binance" },
    },
    {
      engine,
      store: mockStore,
    }
  );
  assert.equal(resBinance.status, 200);
  assert.equal(resBinance.data.ok, true);
  assert.equal(resBinance.data.activeVenue, "binance");
  assert.equal(resBinance.data.connected, false);
  assert.equal(engine.state.settings.live.exchange, "binance");
  assert.equal(engine.liveExecutor.adapter, null);

  // 3. Reject unsupported venue
  const resBad = await handleRpcRequest(
    {
      method: "POST",
      path: "/api/exchange/select",
      body: { venue: "kraken" },
    },
    {
      engine,
      store: mockStore,
    }
  );
  assert.equal(resBad.status, 400);
  assert.equal(resBad.data.ok, false);
});
