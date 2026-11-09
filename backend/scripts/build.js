#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const DASHBOARD_SRC = path.join(ROOT, "dashboard");
const DASHBOARD_DIST = path.join(DASHBOARD_SRC, "dist");

const args = new Set(process.argv.slice(2));
const skipDashboard = args.has("--skip-dashboard");
const onlyDashboard = args.has("--only-dashboard");

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function runNpm(npmArgs, cwd) {
  if (process.platform === "win32") {
    return spawnSync("cmd.exe", ["/d", "/s", "/c", `npm ${npmArgs.join(" ")}`], {
      cwd,
      stdio: "inherit",
    });
  }
  return spawnSync("npm", npmArgs, { cwd, stdio: "inherit" });
}

/**
 * Build the React dashboard into dist/dashboard/. The app is a separate Vite
 * project under dashboard/ and is served by the bot at /dashboard/.
 */
function buildDashboard() {
  if (!fs.existsSync(DASHBOARD_SRC)) {
    console.warn("[build] dashboard/ not found, skipping the React dashboard.");
    return;
  }

  const modules = path.join(DASHBOARD_SRC, "node_modules");
  if (!fs.existsSync(modules)) {
    console.log("[build] Installing dashboard dependencies...");
    const install = runNpm(["install", "--no-audit", "--no-fund"], DASHBOARD_SRC);
    if (install.status !== 0) {
      throw new Error("dashboard dependency install failed");
    }
  }

  console.log("[build] Building React dashboard -> dashboard/dist/ ...");
  const result = runNpm(["run", "build"], DASHBOARD_SRC);
  if (result.status !== 0) {
    throw new Error("dashboard build failed");
  }

  if (!fs.existsSync(path.join(DASHBOARD_DIST, "index.html"))) {
    throw new Error("dashboard build produced no index.html");
  }

  console.log("[build] Copying dashboard/dist/ -> dist/dashboard/ ...");
  copyDirRecursive(DASHBOARD_DIST, path.join(DIST, "dashboard"));
}

if (onlyDashboard) {
  console.log("[build] --only-dashboard: refreshing dist/dashboard/ only...");
  fs.mkdirSync(DIST, { recursive: true });
  fs.rmSync(path.join(DIST, "dashboard"), { recursive: true, force: true });
  buildDashboard();
  console.log("[build] Dashboard build complete -> dist/dashboard/");
} else {
  console.log("[build] Preparing dist/ directory...");
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // Copy public contents directly to dist/ (index.html, app.js, styles.css, status.json)
  const publicDir = path.join(ROOT, "public");
  if (fs.existsSync(publicDir)) {
    console.log("[build] Copying public/ -> dist/ ...");
    copyDirRecursive(publicDir, DIST);
  }

  // Copy web/ to dist/web/
  const webDir = path.join(ROOT, "web");
  if (fs.existsSync(webDir)) {
    console.log("[build] Copying web/ -> dist/web/ ...");
    copyDirRecursive(webDir, path.join(DIST, "web"));
  }

  // Copy src/ to dist/src/
  const srcDir = path.join(ROOT, "src");
  if (fs.existsSync(srcDir)) {
    console.log("[build] Copying src/ -> dist/src/ ...");
    copyDirRecursive(srcDir, path.join(DIST, "src"));
  }

  if (skipDashboard) {
    console.log("[build] --skip-dashboard set, not building the React dashboard.");
  } else {
    buildDashboard();
  }

  // Ensure status.json exists
  const statusPath = path.join(DIST, "status.json");
  if (!fs.existsSync(statusPath)) {
    fs.writeFileSync(
      statusPath,
      JSON.stringify(
        { minVersion: "2.0.0", liveEnabled: true, message: "" },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }

  console.log("[build] Build complete -> dist/ ready for static deployment.");
}
