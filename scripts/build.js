/**
 * Static build for the Vercel preview deployment.
 *
 * The dashboard is plain HTML/CSS/ES modules in `public/`, so the build only
 * has to copy it into Vercel's output directory. The server-side engine lives
 * on Cloudflare (Durable Object); `vercel.json` proxies `/api/*` there, which
 * keeps the preview functional without duplicating the engine on Vercel.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "public");
const DIST = path.join(ROOT, "dist");

if (!fs.existsSync(SRC)) {
  console.error("[build] public/ not found");
  process.exit(1);
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SRC, DIST, { recursive: true });

const files = fs
  .readdirSync(DIST, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).length;

console.log(`[build] copied ${files} static files from public/ -> dist/`);
