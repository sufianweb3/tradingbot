/**
 * Bot log data collector export.
 *
 * Streams a single JSONL file with everything the bot has collected:
 *
 *   {"record":"meta", ...}       engine/settings/account snapshot
 *   {"record":"log", ...}        bot activity log entry
 *   {"record":"ai-index", ...}   passive AI dataset open/close index
 *   {"record":"ai-trade", ...}   AI dataset entry snapshot (trade.json)
 *   {"record":"ai-tick", ...}    one sampled second of an open trade
 *   {"record":"ai-event", ...}   open/partial/close/resume event
 *   {"record":"ai-summary", ...} final result for the trade
 *
 * The dataset part only exists on the local Node server (Cloudflare Workers
 * have no filesystem); the API still returns the activity log there.
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { now } from "./util.js";

export const LOG_EXPORT_SCHEMA = "oi-bot-log-export/v1";

export function logExportFilename(at = now()) {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  return `oi-bot-logs-${stamp}.jsonl`;
}

function line(record) {
  return JSON.stringify(record) + "\n";
}

async function* readJsonLines(file) {
  if (!fs.existsSync(file)) return;
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      const text = raw.replace(/^\uFEFF/, "").trim();
      if (!text) continue;
      try {
        yield JSON.parse(text);
      } catch {
        // Ignore a partially written line instead of aborting the download.
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function safeSettings(engine) {
  try {
    return engine.publicSettings();
  } catch {
    return null;
  }
}

function safeStats(engine) {
  try {
    return engine.getStats();
  } catch {
    return null;
  }
}

function safeMeta(engine) {
  try {
    return engine.getMeta();
  } catch {
    return null;
  }
}

/**
 * Yield JSONL lines for the activity log plus the AI trade dataset.
 *
 * @param {object} engine
 * @param {object} [options]
 * @param {string|null} [options.datasetDir] folder written by aiDataset.js
 * @param {boolean} [options.includeDataset]
 * @param {number} [options.at]
 */
export async function* streamBotLogExport(
  engine,
  { datasetDir = null, includeDataset = true, at = now() } = {}
) {
  yield line({
    record: "meta",
    schema: LOG_EXPORT_SCHEMA,
    version: 1,
    createdAt: new Date(at).toISOString(),
    generatedAt: at,
    app: "oi-sniper",
    initialFund: engine?.state?.initialFund ?? null,
    settings: safeSettings(engine),
    stats: safeStats(engine),
    meta: safeMeta(engine),
  });

  const logs = Array.isArray(engine?.state?.logs) ? engine.state.logs : [];
  for (const entry of logs) {
    yield line({ record: "log", ...entry });
  }

  if (!includeDataset || !datasetDir) return;
  if (!fs.existsSync(datasetDir)) return;

  const indexFile = path.join(datasetDir, "index.jsonl");
  for await (const entry of readJsonLines(indexFile)) {
    yield line({ record: "ai-index", datasetDir: path.basename(datasetDir), ...entry });
  }

  let dirs = [];
  try {
    dirs = fs
      .readdirSync(datasetDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return;
  }

  for (const name of dirs) {
    const dir = path.join(datasetDir, name);
    const trade = readJson(path.join(dir, "trade.json"));
    const summary = readJson(path.join(dir, "summary.json"));
    const tradeId = trade?.tradeId || summary?.tradeId || name;

    if (trade) yield line({ record: "ai-trade", datasetDir: name, ...trade });

    for await (const tick of readJsonLines(path.join(dir, "ticks.jsonl"))) {
      yield line({ record: "ai-tick", datasetDir: name, tradeId, ...tick });
    }
    for await (const event of readJsonLines(path.join(dir, "events.jsonl"))) {
      yield line({ record: "ai-event", datasetDir: name, tradeId, ...event });
    }
    if (summary) yield line({ record: "ai-summary", datasetDir: name, ...summary });
  }
}

/**
 * Log-only export used where there is no filesystem (Cloudflare Durable
 * Object). Returns the same JSONL shape as the local server.
 */
export function renderStateLogExport(engine, { at = now() } = {}) {
  const records = [
    {
      record: "meta",
      schema: LOG_EXPORT_SCHEMA,
      version: 1,
      createdAt: new Date(at).toISOString(),
      generatedAt: at,
      app: "oi-sniper",
      initialFund: engine?.state?.initialFund ?? null,
      settings: safeSettings(engine),
      stats: safeStats(engine),
      meta: safeMeta(engine),
    },
  ];
  for (const entry of Array.isArray(engine?.state?.logs) ? engine.state.logs : []) {
    records.push({ record: "log", ...entry });
  }
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
