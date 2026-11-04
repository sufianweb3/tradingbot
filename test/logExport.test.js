/**
 * Bot log data collector export tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  logExportFilename,
  renderStateLogExport,
  streamBotLogExport,
} from "../src/logExport.js";

function fakeEngine() {
  return {
    state: {
      initialFund: 500,
      logs: [
        { t: 1000, level: "info", msg: "Bot started" },
        { t: 2000, level: "warn", msg: "No feed" },
      ],
    },
    publicSettings: () => ({ reenterEnabled: true, reenterDelayMin: 30 }),
    getStats: () => ({ equity: 500, trades: 0 }),
    getMeta: () => ({ running: true, scanCount: 1 }),
  };
}

async function collect(iterator) {
  let out = "";
  for await (const chunk of iterator) out += chunk;
  return out;
}

test("log export streams the activity log and the AI dataset", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oi-bot-logs-"));
  try {
    const datasetDir = path.join(root, "ai-dataset");
    const tradeDir = path.join(datasetDir, "2026-11-04_SXT_long_pos_1");
    fs.mkdirSync(tradeDir, { recursive: true });
    fs.writeFileSync(
      path.join(datasetDir, "index.jsonl"),
      JSON.stringify({ event: "open", tradeId: "pos_1" }) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tradeDir, "trade.json"),
      JSON.stringify({ tradeId: "pos_1", symbol: "SXT" }),
      "utf8"
    );
    fs.writeFileSync(
      path.join(tradeDir, "ticks.jsonl"),
      JSON.stringify({ seq: 1, mark: { price: 1 } }) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tradeDir, "events.jsonl"),
      JSON.stringify({ event: "close" }) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(tradeDir, "summary.json"),
      JSON.stringify({ tradeId: "pos_1", pnlNet: 5 }),
      "utf8"
    );

    const text = await collect(
      streamBotLogExport(fakeEngine(), { datasetDir, at: 1762290000000 })
    );
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(records[0].record, "meta");
    assert.equal(records[0].schema, "oi-bot-log-export/v1");
    assert.equal(records[0].settings.reenterEnabled, true);
    assert.equal(records.filter((r) => r.record === "log").length, 2);
    assert.equal(records.filter((r) => r.record === "ai-index").length, 1);
    assert.equal(records.filter((r) => r.record === "ai-trade").length, 1);
    assert.equal(records.filter((r) => r.record === "ai-tick").length, 1);
    assert.equal(records.filter((r) => r.record === "ai-event").length, 1);
    assert.equal(records.filter((r) => r.record === "ai-summary").length, 1);
    assert.equal(records.find((r) => r.record === "ai-tick").tradeId, "pos_1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("log export can skip the dataset and still returns logs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oi-bot-logs-"));
  try {
    const text = await collect(
      streamBotLogExport(fakeEngine(), {
        datasetDir: path.join(root, "missing"),
        includeDataset: false,
      })
    );
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 3);
    assert.equal(records[0].record, "meta");
    assert.equal(records[1].record, "log");
    assert.equal(records[2].record, "log");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("state-only export works without a filesystem", () => {
  const text = renderStateLogExport(fakeEngine(), { at: 1762290000000 });
  const records = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 3);
  assert.equal(records[0].record, "meta");
  assert.equal(records[2].msg, "No feed");
});

test("log export filename is timestamped and safe", () => {
  const name = logExportFilename(1762290000000);
  assert.match(name, /^oi-bot-logs-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.jsonl$/);
});
