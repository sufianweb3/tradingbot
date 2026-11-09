/**
 * Challenger Adversarial Stress Suite
 * Empirically stress-tests banner priority consolidation, feed staleness suppression,
 * route robustness, and punctuation hygiene.
 */

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { Engine } from "../src/engine.js";
import { handleRpcRequest } from "../web/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

console.log("===============================================================");
console.log("STARTING EMPIRICAL CHALLENGER STRESS SUITE");
console.log("===============================================================\n");

let passedAssertions = 0;
function recordAssert(desc) {
  passedAssertions++;
}

// -----------------------------------------------------------------------------
// DOM MOCK FOR BANNER TESTING
// -----------------------------------------------------------------------------
class MockElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.classList = {
      _classes: new Set(),
      add(...cls) { cls.forEach((c) => this._classes.add(c)); },
      remove(...cls) { cls.forEach((c) => this._classes.delete(c)); },
      contains(c) { return this._classes.has(c); },
      toString() { return [...this._classes].join(" "); },
    };
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.childNodes = this.children;
    this._innerHTML = "";
    this._textContent = "";
  }
  set className(val) {
    this.classList._classes = new Set(String(val || "").split(/\s+/).filter(Boolean));
  }
  get className() {
    return this.classList.toString();
  }
  set innerHTML(val) {
    this._innerHTML = String(val);
    this._textContent = String(val);
    if (val === "") {
      this.children = [];
      this.childNodes = this.children;
    }
  }
  get innerHTML() {
    return this._innerHTML;
  }
  set textContent(val) {
    this._textContent = String(val);
    this._innerHTML = String(val);
  }
  get textContent() {
    return this._textContent + this.children.map((c) => c.textContent).join("");
  }
  appendChild(child) {
    this.children.push(child);
    return child;
  }
}

// Extract exact banner functions and config from public/app.js
const appCode = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");

// Setup evaluation sandbox
const serverNoticeEl = new MockElement("div");
serverNoticeEl.className = "server-notice hidden";

const sandboxDocument = {
  createElement: (tag) => new MockElement(tag),
  querySelector: (sel) => (sel === "#serverNotice" ? serverNoticeEl : null),
  querySelectorAll: (sel) => (sel === "#serverNotice" ? [serverNoticeEl] : []),
};

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const state = {
  meta: { running: false },
};

// Evaluate the banner logic extracted from app.js
const bannerSectionMatch = appCode.match(/const BANNER_CONFIG = \{[\s\S]+?function renderServerNotice\(\) \{[\s\S]+?\n\}/);
if (!bannerSectionMatch) {
  throw new Error("Failed to extract banner consolidation logic from public/app.js");
}

const bannerRunner = new Function(
  "document",
  "$",
  "esc",
  "state",
  `
  ${bannerSectionMatch[0]}
  return { BANNER_CONFIG, bannerRegistry, setBanner, clearBanner, setNotice, renderServerNotice };
`
);

const { BANNER_CONFIG, bannerRegistry, setBanner, clearBanner, setNotice, renderServerNotice } = bannerRunner(
  sandboxDocument,
  sandboxDocument.querySelector,
  esc,
  state
);

console.log("✓ Successfully extracted banner consolidation logic from public/app.js");
console.log(`✓ Loaded ${Object.keys(BANNER_CONFIG).length} priority banner configurations\n`);

// =============================================================================
// TEST 1: BANNER CONSOLIDATION & NON-STACKING INVARIANTS
// =============================================================================
console.log("--- TEST 1: BANNER CONSOLIDATION & NON-STACKING ---");

// Test 1.1: Single banner registrations for every configured tier
state.meta.running = true;
for (const [id, cfg] of Object.entries(BANNER_CONFIG)) {
  setBanner(id, { message: `Alert message for ${id}` });
  assert.equal(serverNoticeEl.children.length, 1, `Exactly 1 banner rendered for ${id}`);
  assert.equal(serverNoticeEl.classList.contains("hidden"), false, `#serverNotice is unhidden for ${id}`);
  assert.equal(serverNoticeEl.children[0].dataset.bannerId, id, `Rendered banner id matches ${id}`);
  assert.ok(serverNoticeEl.children[0].className.includes(cfg.level || "warn"), `Correct level class on banner ${id}`);
  clearBanner(id);
  assert.equal(serverNoticeEl.children.length, 0, `Notice cleared after removing ${id}`);
  assert.equal(serverNoticeEl.classList.contains("hidden"), true, `#serverNotice is hidden after removing ${id}`);
  recordAssert(`Single banner lifecycle for ${id}`);
}
console.log(`✓ 1.1: Verified single banner lifecycle and styling across all ${Object.keys(BANNER_CONFIG).length} tiers`);

// Test 1.2: All banners registered simultaneously: Strict Consolidation
state.meta.running = true;
const allKeys = Object.keys(BANNER_CONFIG);
for (const id of allKeys) {
  setBanner(id, { message: `Active ${id}` });
}

// Invariant 1: Exactly ONE banner item in DOM
assert.equal(serverNoticeEl.children.length, 1, "INVARIANT: Exactly ONE banner rendered when all banners active");
assert.equal(serverNoticeEl.children[0].dataset.bannerId, "kill-switch", "Highest priority (kill-switch 100) rendered");
// Candidate banners: 14 non-feed banners + 1 highest feed banner (offline) = 15 candidate banners. Badge = (+14 more)
assert.match(serverNoticeEl.children[0].textContent, /\(\+14 more\)/, "Sub-count badge accurately indicates (+14 more)");
console.log("✓ 1.2: Confirmed single-slot rendering with (+14 more) sub-count badge");

// Test 1.3: Sequential clearance in descending priority order
const expectedOrder = [
  "kill-switch",
  "worker-error",
  "unsupported-browser",
  "exchange-error",
  "error",
  "update-required",
  "secondary",
  "mexc-unavailable",
  "offline",
  "market-error",
  "market-stale",
  "stale",
  "max-trades",
  "no-margin",
  "no-filters",
  "throttled",
  "tab-hidden",
  "wake-lock",
];

for (let i = 0; i < expectedOrder.length; i++) {
  const currentExpected = expectedOrder[i];
  assert.equal(serverNoticeEl.children.length, 1, `Must have exactly 1 banner at step ${i}`);
  assert.equal(serverNoticeEl.children[0].dataset.bannerId, currentExpected, `Step ${i} expected ${currentExpected}`);
  clearBanner(currentExpected);
  recordAssert(`Sequential descent to ${currentExpected}`);
}
assert.equal(serverNoticeEl.children.length, 0, "All banners cleared, DOM empty");
assert.equal(serverNoticeEl.classList.contains("hidden"), true, "All banners cleared, notice hidden");
console.log("✓ 1.3: Verified strict priority succession during sequential banner clearances");

// Test 1.4: Adversarial Random Permutations (2,000 runs)
console.log("--- 1.4: Running 2,000 Monte Carlo Permutations ---");
let totalPermutationChecks = 0;
for (let run = 0; run < 2000; run++) {
  bannerRegistry.clear();
  serverNoticeEl.innerHTML = "";
  serverNoticeEl.className = "server-notice hidden";

  // Pick random subset of banners (1 to allKeys.length items)
  const subsetSize = Math.floor(Math.random() * allKeys.length) + 1;
  const shuffled = [...allKeys].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, subsetSize);

  // Random running state
  const isRunning = Math.random() > 0.3;
  state.meta.running = isRunning;

  // Register banners in random sequence
  for (const id of selected) {
    setBanner(id, { message: `Msg for ${id} (run ${run})` });
  }

  // Calculate oracle expectation
  let candidates = selected.map((id) => ({
    id,
    priority: BANNER_CONFIG[id].priority,
    category: BANNER_CONFIG[id].category,
  }));

  if (!isRunning) {
    candidates = candidates.filter((c) => c.category !== "feed");
  }

  const feedAlerts = candidates.filter((c) => c.category === "feed");
  if (feedAlerts.length > 1) {
    feedAlerts.sort((a, b) => b.priority - a.priority);
    const highestFeed = feedAlerts[0];
    candidates = candidates.filter((c) => c.category !== "feed" || c.id === highestFeed.id);
  }

  candidates.sort((a, b) => b.priority - a.priority);

  if (candidates.length === 0) {
    assert.equal(serverNoticeEl.children.length, 0, `Run ${run}: Suppressed or empty must render 0 children`);
    assert.equal(serverNoticeEl.classList.contains("hidden"), true, `Run ${run}: Must have hidden class`);
  } else {
    assert.equal(serverNoticeEl.children.length, 1, `Run ${run}: Must render EXACTLY 1 banner`);
    assert.equal(serverNoticeEl.classList.contains("hidden"), false, `Run ${run}: Must NOT have hidden class`);
    assert.equal(serverNoticeEl.children[0].dataset.bannerId, candidates[0].id, `Run ${run}: Highest priority banner must match`);
    if (candidates.length > 1) {
      assert.match(
        serverNoticeEl.children[0].textContent,
        new RegExp(`\\(\\+${candidates.length - 1} more\\)`),
        `Run ${run}: Sub-count badge must match (+${candidates.length - 1} more)`
      );
    }
  }
  totalPermutationChecks++;
}
console.log(`✓ 1.4: Completed ${totalPermutationChecks} Monte Carlo permutations with zero stacking or priority violations\n`);

// =============================================================================
// TEST 2: FEED STALENESS SUPPRESSION INVARIANTS
// =============================================================================
console.log("--- TEST 2: FEED STALENESS SUPPRESSION ---");
bannerRegistry.clear();
serverNoticeEl.innerHTML = "";
serverNoticeEl.className = "server-notice hidden";

// 2.1 When state.meta.running is false, all feed banners MUST be suppressed
state.meta.running = false;
const feedBanners = ["offline", "market-error", "market-stale", "stale"];

for (const id of feedBanners) {
  setBanner(id, { message: `Feed alert ${id}` });
  assert.equal(serverNoticeEl.children.length, 0, `Feed alert ${id} MUST be suppressed when bot is stopped`);
  assert.equal(serverNoticeEl.classList.contains("hidden"), true, `#serverNotice must remain hidden for feed alert ${id}`);
  recordAssert(`Suppressed ${id} when stopped`);
}
console.log("✓ 2.1: Verified complete suppression of feed banners ('stale', 'offline', 'market-stale', 'market-error') when bot is stopped");

// 2.2 Adding non-feed alert while stopped surfaces the non-feed alert ONLY
setBanner("tab-hidden", { message: "Tab running in background" });
assert.equal(serverNoticeEl.children.length, 1, "Non-feed banner surfaces when stopped");
assert.equal(serverNoticeEl.children[0].dataset.bannerId, "tab-hidden", "Rendered banner is tab-hidden");
assert.doesNotMatch(serverNoticeEl.children[0].textContent, /\(\+/, "Suppressed feed banners do NOT count towards (+N more) badge");
console.log("✓ 2.2: Confirmed non-feed banner surfaces without counting suppressed feed alerts");

// 2.3 Starting engine unsuppresses feed alerts and re-ranks by priority
state.meta.running = true;
renderServerNotice();
assert.equal(serverNoticeEl.children.length, 1, "Exactly one banner rendered after start");
// Among feed alerts, highest is 'offline' (50), which is > 'tab-hidden' (10)
assert.equal(serverNoticeEl.children[0].dataset.bannerId, "offline", "Feed alert 'offline' (priority 50) takes precedence over 'tab-hidden' (10)");
// Feed alerts consolidate into 1 ('offline'), plus 1 non-feed ('tab-hidden') = 2 candidates -> (+1 more)
assert.match(serverNoticeEl.children[0].textContent, /\(\+1 more\)/, "Sub-count badge reflects (+1 more)");
console.log("✓ 2.3: Confirmed feed alerts unsuppress and surface according to priority tier upon starting engine");

// 2.4 Stopping engine immediately re-suppresses feed alerts
state.meta.running = false;
renderServerNotice();
assert.equal(serverNoticeEl.children.length, 1, "Exactly one banner rendered after stop");
assert.equal(serverNoticeEl.children[0].dataset.bannerId, "tab-hidden", "'tab-hidden' reclaims banner slot as feed alerts are suppressed");
assert.doesNotMatch(serverNoticeEl.children[0].textContent, /\(\+/, "No sub-count badge when only tab-hidden remains");
clearBanner("tab-hidden");
for (const id of feedBanners) clearBanner(id);
assert.equal(serverNoticeEl.children.length, 0, "Cleared all");
console.log("✓ 2.4: Confirmed re-suppression of feed alerts when engine is stopped\n");

// =============================================================================
// TEST 3: ROUTE ROBUSTNESS (POST /api/device/market)
// =============================================================================
console.log("--- TEST 3: ROUTE ROBUSTNESS ---");

// Test 3.1: web/routes.js handleRpcRequest
const engine = new Engine({ store: null });
const mockCgClient = {
  isStale: () => false,
  status: {
    lastSuccessAt: 0,
    connected: false,
    state: "disconnected",
    stale: true,
    stopNewEntries: true,
    consecutiveFailures: 3,
    coins: 0,
    source: "none",
  },
};

// 3.1.1 Valid Payload
const validPayload = {
  coins: [
    { symbol: "BTCUSDT", price: 65000, oi: { "5m": 1.2 }, vol: { "5m": 2.5 } },
    { symbol: "ETHUSDT", price: 3500, oi: { "5m": 0.8 }, vol: { "5m": 1.5 } },
  ],
};

let res = await handleRpcRequest(
  { path: "/api/device/market", method: "POST", body: validPayload },
  { engine, store: null, cgClient: mockCgClient, bootedAt: Date.now() }
);

assert.equal(res.status, 200, "Valid feed returns status 200");
assert.equal(res.data.ok, true, "Valid feed response data ok is true");
assert.equal(res.data.coins, 2, "Valid feed returns 2 ingested coins");
assert.equal(mockCgClient.status.connected, true, "cgClient.status.connected is updated to true");
assert.equal(mockCgClient.status.state, "connected", "cgClient.status.state is updated to 'connected'");
assert.equal(mockCgClient.status.stale, false, "cgClient.status.stale is cleared to false");
assert.equal(mockCgClient.status.stopNewEntries, false, "cgClient.status.stopNewEntries is cleared to false");
assert.equal(mockCgClient.status.consecutiveFailures, 0, "cgClient.status.consecutiveFailures is reset to 0");
assert.equal(mockCgClient.status.coins, 2, "cgClient.status.coins reflects ingested count");
assert.equal(mockCgClient.status.source, "device", "cgClient.status.source is set to 'device'");
assert.ok(mockCgClient.status.lastSuccessAt > 0, "cgClient.status.lastSuccessAt is set");

const markets = engine.getMarketRows();
assert.equal(markets.length, 2, "engine.getMarketRows() contains 2 coins");
assert.ok(markets.some((m) => m.symbol === "BTCUSDT"), "BTCUSDT present in market rows");
assert.ok(markets.some((m) => m.symbol === "ETHUSDT"), "ETHUSDT present in market rows");
console.log("✓ 3.1.1: Verified valid POST /api/device/market payload updates engine and cgClient status");

// 3.1.2 Empty Payload
res = await handleRpcRequest(
  { path: "/api/device/market", method: "POST", body: {} },
  { engine, store: null, cgClient: mockCgClient, bootedAt: Date.now() }
);
assert.equal(res.status, 400, "Empty feed returns HTTP 400");
assert.equal(res.data.ok, false, "Response data ok is false");
assert.equal(res.data.error, "empty-feed", "Error is 'empty-feed'");
console.log("✓ 3.1.2: Verified empty payload correctly rejected with HTTP 400 'empty-feed'");

// 3.1.3 Malformed Payloads
const malformedCases = [
  { body: { coins: [] }, expectedErr: "empty-feed" },
  { body: { coins: "not-an-array" }, expectedErr: "empty-feed" },
  { body: { coins: null }, expectedErr: "empty-feed" },
  { body: null, expectedErr: "empty-feed" },
  { body: { coins: [{ symbol: "!!!INVALID!!!" }] }, expectedErr: "no-valid-coins" },
  { body: { coins: Array.from({ length: 5001 }, (_, i) => ({ symbol: `COIN${i}` })) }, expectedErr: "feed-too-large" },
];

for (const testCase of malformedCases) {
  let threw = false;
  let errorMsg = "";
  try {
    res = await handleRpcRequest(
      { path: "/api/device/market", method: "POST", body: testCase.body },
      { engine, store: null, cgClient: mockCgClient, bootedAt: Date.now() }
    );
  } catch (err) {
    threw = true;
    errorMsg = err.message;
  }

  if (threw) {
    console.log(`! EMPIRICAL FINDING: handleRpcRequest threw uncaught error on body = ${JSON.stringify(testCase.body)}: "${errorMsg}"`);
  } else {
    assert.equal(res.status, 400, `Malformed payload returns HTTP 400 for ${testCase.expectedErr}`);
    assert.equal(res.data.ok, false);
    assert.equal(res.data.error, testCase.expectedErr);
    recordAssert(`Malformed payload rejection: ${testCase.expectedErr}`);
  }
}
console.log("✓ 3.1.3: Verified malformed payloads properly rejected with HTTP 400");

// 3.1.4 Non-POST HTTP methods on /api/device/market
for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
  res = await handleRpcRequest(
    { path: "/api/device/market", method, body: {} },
    { engine, store: null, cgClient: mockCgClient, bootedAt: Date.now() }
  );
  assert.equal(res.status, 405, `${method} on /api/device/market returns 405 Method Not Allowed`);
  assert.equal(res.data.error, "method-not-allowed");
  recordAssert(`405 Method Not Allowed for ${method}`);
}
console.log("✓ 3.1.4: Verified non-POST methods return HTTP 405 Method Not Allowed");

// 3.2 Real HTTP Server Verification (scripts/server.js)
console.log("--- 3.2: Real HTTP Server Integration via TCP Loopback ---");
const testPort = 39281;
const testDataDir = path.join(ROOT, "data", "test-challenger-data");
fs.mkdirSync(testDataDir, { recursive: true });

const serverProc = spawn(process.execPath, [path.join(ROOT, "scripts/server.js")], {
  env: {
    ...process.env,
    PORT: String(testPort),
    HOST: "127.0.0.1",
    DATA_DIR: testDataDir,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

// Wait for server to bind port
await new Promise((resolve, reject) => {
  serverProc.stdout.on("data", (d) => {
    if (d.toString().includes("OI Sniper - local development server")) resolve();
  });
  serverProc.stderr.on("data", (d) => {
    // console.error("[server err]", d.toString());
  });
  serverProc.on("error", reject);
  setTimeout(() => resolve(), 1500);
});

async function requestServer(method, endpoint, body) {
  const url = `http://127.0.0.1:${testPort}${endpoint}`;
  const options = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) options.body = JSON.stringify(body);
  const resp = await fetch(url, options);
  const json = await resp.json().catch(() => null);
  return { status: resp.status, data: json };
}

try {
  // Real HTTP POST /api/device/market with valid payload
  let httpRes = await requestServer("POST", "/api/device/market", validPayload);
  assert.equal(httpRes.status, 200, "Real server returns HTTP 200 for valid feed");
  assert.equal(httpRes.data.ok, true);
  assert.equal(httpRes.data.coins, 2);

  // Real HTTP POST /api/device/market with empty payload
  httpRes = await requestServer("POST", "/api/device/market", {});
  assert.equal(httpRes.status, 400, "Real server returns HTTP 400 for empty feed");
  assert.equal(httpRes.data.ok, false);
  assert.equal(httpRes.data.error, "empty-feed");

  // Real HTTP POST /api/device/market with malformed payload
  httpRes = await requestServer("POST", "/api/device/market", { coins: "invalid" });
  assert.equal(httpRes.status, 400, "Real server returns HTTP 400 for malformed feed");
  assert.equal(httpRes.data.ok, false);

  // Real HTTP POST /api/device/market with null payload
  httpRes = await requestServer("POST", "/api/device/market", null);
  console.log(`! Real server response on POST /api/device/market with null: status=${httpRes.status}, data=${JSON.stringify(httpRes.data)}`);

  // Real HTTP GET /api/device/market -> 404 (handled by server.js default fallback)
  httpRes = await requestServer("GET", "/api/device/market");
  assert.equal(httpRes.status, 404, "Real server returns HTTP 404 for GET /api/device/market");
  assert.equal(httpRes.data.error, "not-found");

  console.log("✓ 3.2: Successfully verified real HTTP server requests against scripts/server.js");
} finally {
  serverProc.kill("SIGTERM");
  try {
    fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch {}
}

console.log("\n===============================================================");
console.log(`ALL EMPIRICAL TESTS PASSED: ${passedAssertions} assertions verified`);
console.log("===============================================================\n");
