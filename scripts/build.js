#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DIST = path.join(ROOT, "dist");

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
