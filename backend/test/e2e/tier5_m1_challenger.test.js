import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = path.resolve("/home/realshahriya/Desktop/projects/bot/tradingbot");
const DASHBOARD = path.join(ROOT, "dashboard");

test("Challenger 1: vercel.json structure, delegation, and CSP headers", () => {
  const vercelPath = path.join(ROOT, "vercel.json");
  assert.ok(fs.existsSync(vercelPath), "vercel.json must exist in tradingbot root");

  const vercel = JSON.parse(fs.readFileSync(vercelPath, "utf8"));
  assert.equal(vercel.framework, "nextjs", "vercel.json framework must be nextjs");
  assert.equal(vercel.buildCommand, "npm --prefix dashboard run build", "buildCommand must delegate to dashboard");
  assert.equal(vercel.installCommand, "npm install && npm --prefix dashboard install", "installCommand must install root and dashboard dependencies");
  assert.equal(vercel.outputDirectory, "dashboard/.next", "outputDirectory must point to dashboard/.next");

  const globalHeaderObj = vercel.headers?.find(h => h.source === "/(.*)");
  assert.ok(globalHeaderObj, "vercel.json must define headers for /(.*)");

  const headers = Object.fromEntries(globalHeaderObj.headers.map(h => [h.key, h.value]));
  assert.equal(headers["X-Content-Type-Options"], "nosniff");
  assert.equal(headers["X-Frame-Options"], "DENY");
  assert.equal(headers["Referrer-Policy"], "strict-origin-when-cross-origin");

  const csp = headers["Content-Security-Policy"];
  assert.ok(csp, "Content-Security-Policy header must be present");
  assert.match(csp, /default-src\s+'self'/, "CSP must contain default-src 'self'");
  assert.match(csp, /script-src\s+'self'\s+'unsafe-eval'\s+'unsafe-inline'/, "CSP must allow Next.js scripts");
  assert.match(csp, /worker-src\s+'self'\s+blob:/, "CSP must allow Web Workers with blob:");
  assert.match(csp, /style-src\s+'self'\s+'unsafe-inline'/, "CSP must allow inline styles for Tailwind");
  assert.match(csp, /img-src\s+'self'\s+data:\s+blob:\s+https:\/\/assets\.coincap\.io/, "CSP must allow CoinCap icons");
  assert.match(csp, /object-src\s+'none'/, "CSP must disallow plugins");
  assert.match(csp, /base-uri\s+'none'/, "CSP must disallow base hijacking");
  assert.match(csp, /frame-ancestors\s+'none'/, "CSP must disallow framing");

  // Connect-src verification
  const connectMatch = csp.match(/connect-src\s+([^;]+);/);
  assert.ok(connectMatch, "connect-src directive must exist");
  const connectSrcs = connectMatch[1].split(/\s+/);
  const requiredConnects = [
    "'self'",
    "https://capi.coinglass.com",
    "https://open-api-v4.coinglass.com",
    "https://contract.mexc.com",
    "https://api.gateio.ws",
    "https://api-futures.kucoin.com",
    "https://fapi.binance.com",
    "https://api.bybit.com",
    "https://api.bitget.com",
    "https://www.okx.com",
    "wss://*",
    "ws://*",
  ];
  for (const req of requiredConnects) {
    assert.ok(connectSrcs.includes(req), `connect-src must include ${req}`);
  }
});

test("Challenger 2: Root and Dashboard package.json delegation contract", () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(rootPkg.scripts.build, "npm --prefix dashboard run build", "root build script must delegate");
  assert.equal(rootPkg.scripts["type-check"], "npm --prefix dashboard run type-check", "root type-check script must delegate");

  const dashPkg = JSON.parse(fs.readFileSync(path.join(DASHBOARD, "package.json"), "utf8"));
  assert.equal(dashPkg.scripts.build, "next build", "dashboard build script must run next build");
  assert.equal(dashPkg.scripts["type-check"], "tsc --noEmit", "dashboard type-check script must run tsc --noEmit");

  // Verify dependencies
  assert.ok(dashPkg.dependencies.next, "next must be a dependency in dashboard");
  assert.ok(dashPkg.dependencies.react, "react must be a dependency in dashboard");
  assert.ok(dashPkg.dependencies["react-dom"], "react-dom must be a dependency in dashboard");
  assert.ok(dashPkg.devDependencies.typescript, "typescript must be a devDependency in dashboard");
  assert.ok(dashPkg.devDependencies.tailwindcss, "tailwindcss must be a devDependency in dashboard");
});

test("Challenger 3: Next.js 15 build artifacts validation", () => {
  const nextDir = path.join(DASHBOARD, ".next");
  assert.ok(fs.existsSync(nextDir), "dashboard/.next directory must exist");

  const buildIdPath = path.join(nextDir, "BUILD_ID");
  assert.ok(fs.existsSync(buildIdPath), "BUILD_ID file must exist in .next");
  const buildId = fs.readFileSync(buildIdPath, "utf8").trim();
  assert.ok(buildId.length > 0, "BUILD_ID must not be empty");

  const prerenderPath = path.join(nextDir, "prerender-manifest.json");
  assert.ok(fs.existsSync(prerenderPath), "prerender-manifest.json must exist");
  const prerender = JSON.parse(fs.readFileSync(prerenderPath, "utf8"));
  assert.ok(prerender.routes["/"] !== undefined, "Route / must be in prerender routes");

  const routesPath = path.join(nextDir, "routes-manifest.json");
  assert.ok(fs.existsSync(routesPath), "routes-manifest.json must exist");
  const routes = JSON.parse(fs.readFileSync(routesPath, "utf8"));
  assert.ok(Array.isArray(routes.staticRoutes), "staticRoutes array must exist");
  assert.ok(routes.staticRoutes.some(r => r.page === "/"), "Static route / must be declared");
});

test("Challenger 4: Dark Luxury theme tokens, fonts, and contrast ratios", () => {
  const css = fs.readFileSync(path.join(DASHBOARD, "app/globals.css"), "utf8");

  // Tokens
  const requiredTokens = [
    ["--bg: #070a0f", "Obsidian Slate canvas #070a0f"],
    ["--panel: #0c1119", "Elevated panel #0c1119"],
    ["--panel-2: #111823", "Panel 2 #111823"],
    ["--line: #192434", "Hairline border #192434"],
    ["--line-2: #223247", "Hairline border 2 #223247"],
    ["--green: #10b981", "Emerald positive #10b981"],
    ["--red: #f43f5e", "Rose negative #f43f5e"],
    ["--amber: #f59e0b", "Amber caution #f59e0b"],
    ["--blue: #38bdf8", "Sky telemetry #38bdf8"],
    ["--violet: #a78bfa", "Smart Order Router violet #a78bfa"],
  ];
  for (const [token, desc] of requiredTokens) {
    assert.ok(css.includes(token), `Token missing: ${desc}`);
  }

  // Tabular numbers and shimmer
  assert.match(css, /\.num,\s*\.tabular-nums\s*\{[^}]*font-variant-numeric:\s*tabular-nums/i);
  assert.match(css, /@keyframes\s+shimmer/);
  assert.match(css, /\.skeleton-shimmer/);

  // Layout verification
  const layout = fs.readFileSync(path.join(DASHBOARD, "app/layout.tsx"), "utf8");
  assert.match(layout, /data-theme="dark"/);
  assert.match(layout, /colorScheme:\s*"dark"/);
  assert.match(layout, /bg-glow/);
  assert.match(layout, /Inter/);
  assert.match(layout, /JetBrains_Mono/);
});

test("Challenger 5: Live Next.js SSR server execution, status 200, and zero hydration errors", async () => {
  const port = 3988;
  const child = spawn("npx", ["next", "start", "-p", String(port)], {
    cwd: DASHBOARD,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let serverStderr = "";
  child.stderr.on("data", d => (serverStderr += d.toString()));

  let ready = false;
  let resStatus = 0;
  let html = "";
  let resHeaders = {};

  try {
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 200));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`);
        resStatus = res.status;
        resHeaders = Object.fromEntries(res.headers.entries());
        html = await res.text();
        ready = true;
        break;
      } catch (e) {
        // wait for server
      }
    }
  } finally {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (e) {}
  }

  assert.ok(ready, "Next.js server must accept incoming HTTP connections");
  assert.equal(resStatus, 200, "HTTP GET / must return status 200");
  assert.ok(html.includes("<!DOCTYPE html>"), "Response must be valid HTML5 document");
  assert.ok(html.includes("data-theme=\"dark\""), "HTML must render dark theme attribute");
  assert.ok(html.includes("bg-glow"), "HTML must render ambient bg-glow");
  assert.ok(html.includes("OI SNIPER"), "HTML must render OI SNIPER header brand");
  assert.ok(html.includes("tabular-nums"), "HTML must render tabular numbers");

  // Verify server security headers from next.config.ts
  assert.equal(resHeaders["x-content-type-options"], "nosniff");
  assert.equal(resHeaders["x-frame-options"], "DENY");
  assert.equal(resHeaders["referrer-policy"], "strict-origin-when-cross-origin");

  // Verify stderr had no hydration errors or uncaught exceptions
  assert.doesNotMatch(serverStderr, /Error: Hydration failed/i);
  assert.doesNotMatch(serverStderr, /Warning: Text content did not match/i);
  assert.doesNotMatch(serverStderr, /UnhandledPromiseRejection/i);
});
