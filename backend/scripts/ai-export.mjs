/**
 * Export the passive AI trade dataset into one streaming JSONL file.
 *
 * Usage:
 *   npm run ai:export
 *   npm run ai:export -- <dataset-dir> <output-dir>
 *
 * Every line is a self-contained record:
 *   {"record":"trade", ...}    entry snapshot (settings, coin, plan, signal)
 *   {"record":"tick", ...}     one per sampled second
 *   {"record":"event", ...}    partial / close / resume events
 *   {"record":"summary", ...}  final result for the trade
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const root = path.resolve(process.argv[2] || path.join("data", "ai-dataset"));
const outDir = path.resolve(
  process.argv[3] || path.join(path.dirname(root), "ai-export")
);

if (!fs.existsSync(root)) {
  console.error(`Dataset folder not found: ${root}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
const outFile = path.join(outDir, `ai-trades-${stamp}.jsonl`);
const out = fs.createWriteStream(outFile, { encoding: "utf8" });

const counts = { trades: 0, ticks: 0, events: 0, summaries: 0 };

function writeLine(value) {
  const line = JSON.stringify(value) + "\n";
  if (!out.write(line)) {
    return new Promise((resolve) => out.once("drain", resolve));
  }
  return Promise.resolve();
}

async function eachJsonLine(file, fn) {
  if (!fs.existsSync(file)) return;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const text = line.replace(/^\uFEFF/, "").trim();
    if (!text) continue;
    try {
      await fn(JSON.parse(text));
    } catch {
      /* ignore a partial/corrupt line instead of aborting the export */
    }
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

const dirs = fs
  .readdirSync(root, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const name of dirs) {
  const dir = path.join(root, name);
  if (path.resolve(dir) === outDir) continue;
  const trade = readJson(path.join(dir, "trade.json"));
  const summary = readJson(path.join(dir, "summary.json"));
  const tradeId = trade?.tradeId || summary?.tradeId || name;

  if (trade) {
    await writeLine({ record: "trade", datasetDir: name, ...trade });
    counts.trades++;
  }

  await eachJsonLine(path.join(dir, "ticks.jsonl"), async (tick) => {
    await writeLine({ record: "tick", tradeId, ...tick });
    counts.ticks++;
  });

  await eachJsonLine(path.join(dir, "events.jsonl"), async (event) => {
    await writeLine({ record: "event", tradeId, ...event });
    counts.events++;
  });

  if (summary) {
    await writeLine({ record: "summary", datasetDir: name, ...summary });
    counts.summaries++;
  }
}

await new Promise((resolve, reject) => {
  out.end(resolve);
  out.on("error", reject);
});

const manifest = {
  schema: "oi-bot-ai-export/v1",
  createdAt: new Date().toISOString(),
  source: root,
  output: outFile,
  counts,
};
fs.writeFileSync(
  path.join(outDir, `ai-trades-${stamp}.manifest.json`),
  JSON.stringify(manifest, null, 2),
  "utf8"
);

console.log(`Exported ${counts.trades} trade(s) to ${outFile}`);
console.log(
  `Records: ${counts.ticks} ticks, ${counts.events} events, ${counts.summaries} summaries`
);
