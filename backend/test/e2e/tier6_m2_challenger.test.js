import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve("/home/realshahriya/Desktop/projects/bot/tradingbot");
const DASHBOARD = path.join(ROOT, "dashboard");

test("Challenger M2-1: Milestone 2 UI Component and Modal Inventory", () => {
  const componentsDir = path.join(DASHBOARD, "components");
  const uiDir = path.join(componentsDir, "ui");
  const modalsDir = path.join(componentsDir, "modals");

  // Core Workstation Components
  const workstationComponents = [
    "Topbar.tsx",
    "TelemetryStrip.tsx",
    "KpiStrip.tsx",
    "PositionsPanel.tsx",
    "ScannerTable.tsx",
    "CoinGlassFeed.tsx",
    "EquityChart.tsx",
    "TradesAndLogs.tsx",
    "StrategyDrawer.tsx",
  ];
  for (const comp of workstationComponents) {
    const fullPath = path.join(componentsDir, comp);
    assert.ok(fs.existsSync(fullPath), `Workstation component missing: ${comp}`);
    const stat = fs.statSync(fullPath);
    assert.ok(stat.size > 200, `Component ${comp} must not be an empty stub`);
  }

  // UI Primitives
  const uiPrimitives = [
    "Button.tsx",
    "Card.tsx",
    "CoinBadge.tsx",
    "Pill.tsx",
    "Skeleton.tsx",
    "Slider.tsx",
    "Switch.tsx",
  ];
  for (const prim of uiPrimitives) {
    const fullPath = path.join(uiDir, prim);
    assert.ok(fs.existsSync(fullPath), `UI primitive missing: ${prim}`);
  }

  // Modals
  const modals = [
    "AuthModal.tsx",
    "ExchangeModal.tsx",
    "InspectorModal.tsx",
    "LiveConfirmModal.tsx",
    "ModalShell.tsx",
    "OnboardingModal.tsx",
  ];
  for (const modal of modals) {
    const fullPath = path.join(modalsDir, modal);
    assert.ok(fs.existsSync(fullPath), `Modal missing: ${modal}`);
  }
});

test("Challenger M2-2: Anti-Slop, Typography & Zero Unicode Dashes Scan across M2 codebase", () => {
  const dirsToScan = [
    path.join(DASHBOARD, "components"),
    path.join(DASHBOARD, "app"),
    path.join(DASHBOARD, "lib"),
    path.join(DASHBOARD, "store"),
  ];

  function getFilesRecursively(dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    const list = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of list) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(getFilesRecursively(fullPath));
      } else if (/\.(tsx|ts|html|css)$/.test(entry.name)) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const allFiles = dirsToScan.flatMap(getFilesRecursively);
  assert.ok(allFiles.length > 20, "At least 20 source files must be scanned");

  for (const file of allFiles) {
    const content = fs.readFileSync(file, "utf8");
    const relPath = path.relative(ROOT, file);

    // No em or en dashes
    assert.doesNotMatch(content, /[\u2013\u2014]/, `${relPath} contains prohibited em or en dash`);

    // No placeholder slop
    assert.doesNotMatch(content, /lorem\s+ipsum/i, `${relPath} contains placeholder lorem ipsum`);
  }
});

test("Challenger M2-3: Tabular Numbers and Obsidian Slate Styling Enforcement", () => {
  const css = fs.readFileSync(path.join(DASHBOARD, "app/globals.css"), "utf8");

  // Tabular numbers rule must exist
  assert.match(
    css,
    /\.num,\s*\.tabular-nums\s*\{[^}]*font-variant-numeric:\s*tabular-nums/i,
    "globals.css must enforce tabular-nums"
  );

  // Obsidian theme tokens
  const obsidianTokens = [
    ["--bg: #070a0f", "Obsidian Canvas #070a0f"],
    ["--panel: #0c1119", "Elevated Panel #0c1119"],
    ["--line: #192434", "Hairline Border #192434"],
    ["--green: #10b981", "Emerald Positive #10b981"],
    ["--red: #f43f5e", "Rose Negative #f43f5e"],
  ];
  for (const [token, desc] of obsidianTokens) {
    assert.ok(css.includes(token), `Obsidian token missing: ${desc}`);
  }

  // Positions, KPI, and Scanner components must reference tabular numbers
  const kpiContent = fs.readFileSync(path.join(DASHBOARD, "components/KpiStrip.tsx"), "utf8");
  assert.match(kpiContent, /tabular-nums/, "KpiStrip must use tabular-nums");

  const posContent = fs.readFileSync(path.join(DASHBOARD, "components/PositionsPanel.tsx"), "utf8");
  assert.match(posContent, /tabular-nums/, "PositionsPanel must use tabular-nums");

  const topbarContent = fs.readFileSync(path.join(DASHBOARD, "components/Topbar.tsx"), "utf8");
  assert.match(topbarContent, /tabular-nums/, "Topbar must use tabular-nums");
});

test("Challenger M2-4: Next.js Static Prerender Full Page DOM Contract Validation", () => {
  const htmlPath = path.join(DASHBOARD, ".next/server/app/index.html");
  assert.ok(fs.existsSync(htmlPath), "Prerendered index.html must exist in .next/server/app");

  const html = fs.readFileSync(htmlPath, "utf8");

  // Core workstation sections in static HTML
  const requiredDomContracts = [
    { id: "OI SNIPER", desc: "Topbar Brand Title" },
    { id: "id=\"engineSubtitle\"", desc: "Topbar Engine Subtitle" },
    { id: "id=\"telemetryStrip\"", desc: "Telemetry Strip (FX-85)" },
    { id: "id=\"venueHealthPills\"", desc: "Venue Health Indicators (FX-84)" },
    { id: "id=\"speedTelemetryBar\"", desc: "Speed Telemetry Bar" },
    { id: "id=\"kpis\"", desc: "KPI Strip Root Section" },
    { id: "id=\"kpiEquity\"", desc: "Hero KPI Equity Card" },
    { id: "id=\"kpiEquitySub\"", desc: "KPI Equity Subline" },
    { id: "id=\"kpiPnl\"", desc: "KPI Net Realized PnL" },
    { id: "id=\"panelPositions\"", desc: "Open Positions Panel Section" },
    { id: "id=\"positionsBody\"", desc: "Positions Panel Body" },
    { id: "id=\"btnCloseAll\"", desc: "Emergency Close All Button" },
    { id: "id=\"panelScanner\"", desc: "Perpetuals Scanner Section" },
    { id: "id=\"panelChart\"", desc: "Account Equity Curve Section" },
    { id: "id=\"tradeExecQualityStrip\"", desc: "Execution Quality Strip (FX-87)" },
    { id: "data-theme=\"dark\"", desc: "Dark Theme Document Attribute" },
    { id: "bg-glow", desc: "Dark Luxury Background Glow" },
  ];

  for (const contract of requiredDomContracts) {
    assert.ok(html.includes(contract.id), `Prerendered HTML missing ${contract.desc} (${contract.id})`);
  }
});

test("Challenger M2-5: Live Next.js Production SSR Concurrent Stress & Zero Hydration Warnings", async () => {
  const port = 4821;
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: DASHBOARD,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let serverStderr = "";
  let serverStdout = "";
  child.stderr.on("data", (d) => (serverStderr += d.toString()));
  child.stdout.on("data", (d) => (serverStdout += d.toString()));

  let ready = false;

  try {
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try {
        const ping = await fetch(`http://127.0.0.1:${port}/`);
        if (ping.status === 200) {
          ready = true;
          break;
        }
      } catch (e) {
        // server warming up
      }
    }

    assert.ok(ready, "Next.js production server failed to accept connections within 8 seconds");

    // Perform concurrent requests
    const urls = [
      `http://127.0.0.1:${port}/`,
      `http://127.0.0.1:${port}/?mode=paper`,
      `http://127.0.0.1:${port}/?mode=live`,
      `http://127.0.0.1:${port}/?tab=scanner`,
      `http://127.0.0.1:${port}/`,
    ];

    const responses = await Promise.all(urls.map((url) => fetch(url)));
    for (const res of responses) {
      assert.equal(res.status, 200, "Concurrent HTTP request must return 200 OK");
      const html = await res.text();
      assert.ok(html.includes("<!DOCTYPE html>"), "Response must be valid HTML5");
      assert.ok(html.includes("OI SNIPER"), "Response must contain workstation brand");
    }
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (e) {}
  }

  // Hydration and SSR error assertions
  assert.doesNotMatch(serverStderr, /Error: Hydration failed/i, "Server must not log Hydration failed");
  assert.doesNotMatch(
    serverStderr,
    /Warning: Text content did not match/i,
    "Server must not log Text content did not match"
  );
  assert.doesNotMatch(
    serverStderr,
    /UnhandledPromiseRejection/i,
    "Server must not have unhandled promise rejections"
  );
});

test("Challenger M2-6: Protected Directory Immutability & UI DOM Verification Preserved", async () => {
  // Sanitize environment to avoid node:test recursion warning
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;

  // Run node --test test/uiDomVerification.test.js
  const domVerification = spawn("node", ["--test", "test/uiDomVerification.test.js"], {
    cwd: ROOT,
    env: childEnv,
    stdio: "pipe",
  });

  let output = "";
  domVerification.stdout.on("data", (d) => (output += d.toString()));
  domVerification.stderr.on("data", (d) => (output += d.toString()));

  const exitCode = await new Promise((resolve) => {
    domVerification.on("close", resolve);
  });

  assert.equal(exitCode, 0, `uiDomVerification.test.js must exit with 0. Output: ${output}`);
  assert.match(output, /pass 16/, "All 16 DOM contract invariants must pass");
});
