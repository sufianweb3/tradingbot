/**
 * Strategy Presets & Preset Link Encoding / Decoding Module (Milestone M6)
 *
 * Implements PRD §5.9:
 * - Built-in presets: balanced, aggressive, conservative
 * - createPresetHash: serializes settings to sanitized base64 URL hash, stripping sensitive keys
 * - parsePresetHash: deserializes URL hash into sanitized settings object, stripping sensitive keys
 */

export const PRESETS = {
  balanced: {
    allocationPercent: 50,
    leverage: 50,
    slPercent: 20,
    tp1Percent: 50,
    tp1ClosePercent: 50,
    tpMaxPercent: 1000,
    trailingEnabled: true,
    trailingStart: "tp1",
    trailingDistancePercent: 20,
    oiFilters: [
      { key: "5m", enabled: true, op: ">=", threshold: 2.0, group: "oi" },
      { key: "15m", enabled: false, op: ">=", threshold: null, group: "oi" },
      { key: "30m", enabled: false, op: ">=", threshold: null, group: "oi" },
      { key: "1h", enabled: false, op: ">=", threshold: null, group: "oi" },
      { key: "4h", enabled: false, op: ">=", threshold: null, group: "oi" },
    ],
  },
  aggressive: {
    allocationPercent: 50,
    leverage: 75,
    slPercent: 15,
    tp1Percent: 30,
    tp1ClosePercent: 50,
    tpMaxPercent: 500,
    trailingEnabled: true,
    trailingStart: "immediate",
    trailingDistancePercent: 15,
    oiFilters: [
      { key: "5m", enabled: true, op: ">=", threshold: 3.0, group: "oi" },
      { key: "15m", enabled: false, op: ">=", threshold: null, group: "oi" },
      { key: "30m", enabled: false, op: ">=", threshold: null, group: "oi" },
      { key: "1h", enabled: false, op: ">=", threshold: null, group: "oi" },
      { key: "4h", enabled: false, op: ">=", threshold: null, group: "oi" },
    ],
  },
  conservative: {
    allocationPercent: 25,
    leverage: 20,
    slPercent: 25,
    tp1Percent: 60,
    tp1ClosePercent: 50,
    tpMaxPercent: 1000,
    trailingEnabled: true,
    trailingStart: "tp1",
    trailingDistancePercent: 25,
    oiFilters: [
      { key: "5m", enabled: false, op: ">=", threshold: null, group: "oi" },
      { key: "15m", enabled: true, op: ">=", threshold: 2.0, group: "oi" },
      { key: "30m", enabled: false, op: ">=", threshold: null, group: "oi" },
      { key: "1h", enabled: false, op: ">=", threshold: null, group: "oi" },
      { key: "4h", enabled: false, op: ">=", threshold: null, group: "oi" },
    ],
  },
};

function safeBtoa(str) {
  if (typeof btoa === "function") {
    return btoa(str);
  }
  return Buffer.from(str, "binary").toString("base64");
}

function safeAtob(b64) {
  if (typeof atob === "function") {
    return atob(b64);
  }
  return Buffer.from(b64, "base64").toString("binary");
}

/**
 * Creates a sanitized Base64 URL hash from strategy settings.
 * Strips all sensitive credentials (CoinGlass and live exchange keys).
 *
 * @param {object} settings
 * @returns {string} Base64 URI string
 */
export function createPresetHash(settings) {
  const clean = JSON.parse(JSON.stringify(settings || {}));
  clean.coinglassApiKey = "";
  delete clean.coinglassKeySet;
  if (clean.live) {
    delete clean.live.apiKey;
    delete clean.live.secret;
    delete clean.live.passphrase;
  }
  const json = JSON.stringify(clean);
  return safeBtoa(encodeURIComponent(json));
}

/**
 * Parses a preset URL hash string and returns the sanitized settings object.
 * Handles '#preset=', 'preset=', or raw hash string.
 * Defensively strips sensitive credentials even if present in the encoded payload.
 *
 * @param {string} hashStr
 * @returns {object}
 */
export function parsePresetHash(hashStr) {
  if (typeof hashStr !== "string" || !hashStr.trim()) {
    throw new Error("Invalid preset hash: input must be a non-empty string");
  }
  const trimmed = hashStr.trim();
  const raw = trimmed.startsWith("#preset=")
    ? trimmed.slice(8)
    : trimmed.startsWith("preset=")
    ? trimmed.slice(7)
    : trimmed;

  if (!raw) {
    throw new Error("Invalid preset hash: empty payload");
  }

  let jsonStr;
  try {
    const binary = safeAtob(raw);
    jsonStr = decodeURIComponent(binary);
  } catch (err) {
    throw new Error(`Failed to decode preset hash: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse preset JSON: ${err.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid preset content: expected JSON object");
  }

  // Defensive sanitization: strip any sensitive credentials even if maliciously crafted into hash
  parsed.coinglassApiKey = "";
  delete parsed.coinglassKeySet;
  if (parsed.live) {
    delete parsed.live.apiKey;
    delete parsed.live.secret;
    delete parsed.live.passphrase;
  }

  return parsed;
}

import { sanitizeImportedPreset } from "./core/riskGuards.js";

/**
 * Parses and risk-clamps an untrusted imported preset URL hash (`EC-65`).
 * Forces `mode: "paper"`, `eqe.enabled: true`, `leverage <= 50`, `allocationPercent <= 50`,
 * and strips all credentials.
 */
export function parseSanitizedPresetHash(hashStr) {
  const parsed = parsePresetHash(hashStr);
  const res = sanitizeImportedPreset(parsed);
  return {
    ...res.preset,
    _warnings: res.warnings,
    _sanitized: res.sanitized,
  };
}

export { sanitizeImportedPreset };
export { deepMerge } from "./util.js";
