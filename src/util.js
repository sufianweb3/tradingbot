/** Small shared helpers (no dependencies). */

export const now = () => Date.now();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function round(n, digits = 2) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

export function toNum(v, fallback = null) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : fallback;
}

export function uid(prefix = "") {
  return (
    prefix +
    Math.random().toString(36).slice(2, 8) +
    Date.now().toString(36).slice(-5)
  );
}

export function formatMoney(n, digits = 2) {
  const x = toNum(n, 0);
  const sign = x < 0 ? "-" : "";
  return sign + "$" + Math.abs(x).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatPct(n, digits = 2) {
  const x = toNum(n, 0);
  return (x > 0 ? "+" : "") + x.toFixed(digits) + "%";
}

export function compact(n) {
  const x = toNum(n, 0);
  const abs = Math.abs(x);
  if (abs >= 1e12) return (x / 1e12).toFixed(2) + "T";
  if (abs >= 1e9) return (x / 1e9).toFixed(2) + "B";
  if (abs >= 1e6) return (x / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (x / 1e3).toFixed(2) + "K";
  return x.toFixed(2);
}

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Run async jobs with a concurrency cap. */
export async function mapLimit(items, limit, fn) {
  const list = Array.from(items);
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), list.length) }, async () => {
    while (cursor < list.length) {
      const i = cursor++;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Deep merge plain objects/arrays (arrays are replaced, not concatenated). */
export function deepMerge(...sources) {
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const out = {};
  for (const src of sources) {
    if (!isObj(src)) continue;
    for (const [k, v] of Object.entries(src)) {
      if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
      else if (Array.isArray(v)) out[k] = v.map((x) => (isObj(x) ? deepMerge(x) : x));
      else out[k] = v;
    }
  }
  return out;
}

export function iso(t) {
  if (!t) return "—";
  try {
    return new Date(t).toISOString().replace("T", " ").replace(".000Z", "Z");
  } catch {
    return "—";
  }
}

export function shortTime(t) {
  if (!t) return "—";
  try {
    return new Date(t).toLocaleTimeString("en-GB", { hour12: false });
  } catch {
    return "—";
  }
}

export function shortDateTime(t) {
  if (!t) return "—";
  try {
    return new Date(t).toLocaleString("en-GB", {
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
}
