/**
 * Dedicated unit tests for Preset Hash serialization & deserialization (Milestone M6 / R2)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  PRESETS,
  createPresetHash,
  parsePresetHash,
  deepMerge,
} from "../src/presets.js";
import { deepMerge as deepMergeUtil } from "../src/util.js";

test("PRESETS schema defines balanced, aggressive, and conservative profiles", () => {
  const keys = Object.keys(PRESETS);
  assert.ok(keys.includes("balanced"), "should define balanced");
  assert.ok(keys.includes("aggressive"), "should define aggressive");
  assert.ok(keys.includes("conservative"), "should define conservative");

  for (const name of keys) {
    const p = PRESETS[name];
    assert.equal(typeof p.allocationPercent, "number");
    assert.equal(typeof p.leverage, "number");
    assert.equal(typeof p.slPercent, "number");
    assert.equal(typeof p.tp1Percent, "number");
    assert.ok(Array.isArray(p.oiFilters), `${name}.oiFilters should be an array`);
    assert.ok(p.oiFilters.length >= 3, `${name}.oiFilters should have filter rows`);
  }
});

test("createPresetHash and parsePresetHash roundtrip standard settings", () => {
  const originalSettings = {
    totalFund: 1000,
    leverage: 25,
    slPercent: 15,
    tp1Percent: 40,
    tp1ClosePercent: 50,
    tpMaxPercent: 500,
    trailingEnabled: true,
    trailingStart: "tp1",
    trailingDistancePercent: 15,
    oiFilters: [
      { key: "5m", enabled: true, op: ">=", threshold: 2.5, group: "oi" },
      { key: "1h", enabled: true, op: ">=", threshold: 5.0, group: "oi" },
    ],
  };

  const hash = createPresetHash(originalSettings);
  assert.equal(typeof hash, "string");
  assert.ok(hash.length > 0);

  const restored = parsePresetHash(hash);
  assert.equal(restored.totalFund, 1000);
  assert.equal(restored.leverage, 25);
  assert.equal(restored.slPercent, 15);
  assert.equal(restored.tp1Percent, 40);
  assert.equal(restored.tpMaxPercent, 500);
  assert.equal(restored.trailingEnabled, true);
  assert.deepEqual(restored.oiFilters, originalSettings.oiFilters);
});

test("createPresetHash strictly strips sensitive keys on export", () => {
  const settingsWithSecrets = {
    totalFund: 500,
    leverage: 50,
    coinglassApiKey: "SECRET_COINGLASS_API_KEY_12345",
    coinglassKeySet: true,
    live: {
      venue: "bybit",
      apiKey: "MY_BYBIT_KEY_999",
      secret: "SUPER_SECRET_HMAC_KEY",
      passphrase: "KUCOIN_PASSPHRASE_SECRET",
      margin: 100,
    },
  };

  const hash = createPresetHash(settingsWithSecrets);

  // Raw base64 decode check: ensure none of the secret strings appear in the raw payload
  const rawDecoded = decodeURIComponent(atob(hash));
  assert.ok(!rawDecoded.includes("SECRET_COINGLASS_API_KEY_12345"), "must strip coinglassApiKey");
  assert.ok(!rawDecoded.includes("MY_BYBIT_KEY_999"), "must strip live.apiKey");
  assert.ok(!rawDecoded.includes("SUPER_SECRET_HMAC_KEY"), "must strip live.secret");
  assert.ok(!rawDecoded.includes("KUCOIN_PASSPHRASE_SECRET"), "must strip live.passphrase");
  assert.ok(!rawDecoded.includes("coinglassKeySet"), "must delete coinglassKeySet");

  const parsed = parsePresetHash(hash);
  assert.equal(parsed.coinglassApiKey, "", "coinglassApiKey must be empty string");
  assert.equal(parsed.coinglassKeySet, undefined, "coinglassKeySet must not exist");
  assert.equal(parsed.live?.apiKey, undefined, "live.apiKey must be stripped");
  assert.equal(parsed.live?.secret, undefined, "live.secret must be stripped");
  assert.equal(parsed.live?.passphrase, undefined, "live.passphrase must be stripped");
  assert.equal(parsed.live?.venue, "bybit", "non-sensitive live settings preserved");
  assert.equal(parsed.live?.margin, 100, "non-sensitive live margin preserved");
});

test("parsePresetHash defensively sanitizes sensitive keys even if present in raw hash", () => {
  // Adversarial scenario: an attacker crafts a hash containing credentials
  const craftedPayload = {
    leverage: 30,
    coinglassApiKey: "MALICIOUS_KEY_ATTEMPT",
    coinglassKeySet: true,
    live: {
      apiKey: "INJECTED_API_KEY",
      secret: "INJECTED_SECRET",
      passphrase: "INJECTED_PASSPHRASE",
      venue: "binance",
    },
  };

  const craftedHash = btoa(encodeURIComponent(JSON.stringify(craftedPayload)));
  const parsed = parsePresetHash(craftedHash);

  assert.equal(parsed.coinglassApiKey, "");
  assert.equal(parsed.coinglassKeySet, undefined);
  assert.equal(parsed.live.apiKey, undefined);
  assert.equal(parsed.live.secret, undefined);
  assert.equal(parsed.live.passphrase, undefined);
  assert.equal(parsed.live.venue, "binance");
});

test("parsePresetHash handles '#preset=', 'preset=', and raw hash strings", () => {
  const sample = { leverage: 42, slPercent: 12 };
  const rawHash = createPresetHash(sample);

  const parsedFromRaw = parsePresetHash(rawHash);
  const parsedFromPreset = parsePresetHash(`preset=${rawHash}`);
  const parsedFromHashPreset = parsePresetHash(`#preset=${rawHash}`);

  assert.equal(parsedFromRaw.leverage, 42);
  assert.equal(parsedFromPreset.leverage, 42);
  assert.equal(parsedFromHashPreset.leverage, 42);
  assert.deepEqual(parsedFromRaw, parsedFromPreset);
  assert.deepEqual(parsedFromRaw, parsedFromHashPreset);
});

test("built-in PRESETS roundtrip validation", () => {
  for (const [name, presetConfig] of Object.entries(PRESETS)) {
    const hash = createPresetHash(presetConfig);
    const parsed = parsePresetHash(hash);

    assert.equal(parsed.allocationPercent, presetConfig.allocationPercent, `${name} allocationPercent matches`);
    assert.equal(parsed.leverage, presetConfig.leverage, `${name} leverage matches`);
    assert.equal(parsed.slPercent, presetConfig.slPercent, `${name} slPercent matches`);
    assert.equal(parsed.tp1Percent, presetConfig.tp1Percent, `${name} tp1Percent matches`);
    assert.deepEqual(parsed.oiFilters, presetConfig.oiFilters, `${name} oiFilters matches`);
  }
});

test("createPresetHash and parsePresetHash handle Unicode and special characters", () => {
  const unicodeSettings = {
    name: "Strategy 🚀 日本語 & symbols %$#@!",
    symbolWhitelist: ["1000PEPE", "DOGE🐶"],
    note: "High volatility ± 5.5%",
  };

  const hash = createPresetHash(unicodeSettings);
  const parsed = parsePresetHash(hash);

  assert.equal(parsed.name, "Strategy 🚀 日本語 & symbols %$#@!");
  assert.deepEqual(parsed.symbolWhitelist, ["1000PEPE", "DOGE🐶"]);
  assert.equal(parsed.note, "High volatility ± 5.5%");
});

test("createPresetHash handles empty or null/undefined settings gracefully", () => {
  const hashNull = createPresetHash(null);
  const hashUndefined = createPresetHash(undefined);
  const hashEmpty = createPresetHash({});

  const parsedNull = parsePresetHash(hashNull);
  const parsedUndefined = parsePresetHash(hashUndefined);
  const parsedEmpty = parsePresetHash(hashEmpty);

  assert.equal(parsedNull.coinglassApiKey, "");
  assert.equal(parsedUndefined.coinglassApiKey, "");
  assert.equal(parsedEmpty.coinglassApiKey, "");
});

test("parsePresetHash rejects malformed inputs gracefully", () => {
  // Empty, null, undefined
  assert.throws(() => parsePresetHash(null), /Invalid preset hash/);
  assert.throws(() => parsePresetHash(undefined), /Invalid preset hash/);
  assert.throws(() => parsePresetHash(""), /Invalid preset hash/);
  assert.throws(() => parsePresetHash("   "), /Invalid preset hash/);
  assert.throws(() => parsePresetHash("#preset="), /empty payload/);
  assert.throws(() => parsePresetHash("preset="), /empty payload/);

  // Invalid base64
  assert.throws(() => parsePresetHash("!@#$%^&*()"), /Failed to decode preset hash/);

  // Invalid JSON (valid base64 of non-JSON string)
  const nonJsonBase64 = btoa(encodeURIComponent("this is not json"));
  assert.throws(() => parsePresetHash(nonJsonBase64), /Failed to parse preset JSON/);

  // Non-object JSON (valid base64 of number or array or primitive)
  const numberBase64 = btoa(encodeURIComponent("12345"));
  assert.throws(() => parsePresetHash(numberBase64), /Invalid preset content: expected JSON object/);

  const arrayBase64 = btoa(encodeURIComponent("[1, 2, 3]"));
  assert.throws(() => parsePresetHash(arrayBase64), /Invalid preset content: expected JSON object/);
});

test("deepMerge is exported from presets.js and matches util.js implementation", () => {
  assert.equal(typeof deepMerge, "function");
  assert.equal(deepMerge, deepMergeUtil);
});

test("deepMerge merges preset configuration deeply into user settings", () => {
  const userSettings = {
    totalFund: 5000,
    coinglassApiKey: "USER_ACTIVE_KEY_123",
    profiles: {
      long: {
        allocationPercent: 30,
        leverage: 10,
        slPercent: 10,
      },
    },
  };

  const presetToApply = PRESETS.aggressive;

  // Simulate onboarding or preset button behavior
  const mergedProfiles = {
    long: deepMerge(userSettings.profiles.long, presetToApply),
    short: deepMerge({}, presetToApply),
  };

  assert.equal(mergedProfiles.long.allocationPercent, presetToApply.allocationPercent);
  assert.equal(mergedProfiles.long.leverage, presetToApply.leverage);
  assert.equal(mergedProfiles.long.slPercent, presetToApply.slPercent);
  assert.equal(mergedProfiles.long.trailingEnabled, true);
  assert.deepEqual(mergedProfiles.long.oiFilters, presetToApply.oiFilters);

  // Full settings merge as done in URL hash preset link loading
  const mergedSettings = deepMerge(userSettings, {
    leverage: presetToApply.leverage,
    slPercent: presetToApply.slPercent,
    tp1Percent: presetToApply.tp1Percent,
  });

  assert.equal(mergedSettings.totalFund, 5000, "user totalFund preserved");
  assert.equal(mergedSettings.coinglassApiKey, "USER_ACTIVE_KEY_123", "user key preserved");
  assert.equal(mergedSettings.leverage, presetToApply.leverage);
  assert.equal(mergedSettings.slPercent, presetToApply.slPercent);
});

test("deepMerge safely resists prototype pollution attempts (__proto__, constructor, prototype)", () => {
  const maliciousPayloads = [
    JSON.parse('{"__proto__": {"polluted1": "pwned"}}'),
    JSON.parse('{"constructor": {"prototype": {"polluted2": "pwned"}}}'),
    JSON.parse('{"prototype": {"polluted3": "pwned"}}'),
    JSON.parse('{"nested": {"__proto__": {"polluted4": "pwned"}}}'),
  ];

  const target = { safe: "initial" };

  for (const malicious of maliciousPayloads) {
    const result = deepMerge(target, malicious);
    assert.equal(result.safe, "initial");
    // Target prototype must remain pure Object.prototype
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
  }

  // Verify global Object.prototype was NOT polluted
  const cleanObj = {};
  assert.equal(cleanObj.polluted1, undefined);
  assert.equal(cleanObj.polluted2, undefined);
  assert.equal(cleanObj.polluted3, undefined);
  assert.equal(cleanObj.polluted4, undefined);
  assert.equal(Object.prototype.polluted1, undefined);
  assert.equal(Object.prototype.polluted2, undefined);
  assert.equal(Object.prototype.polluted3, undefined);
  assert.equal(Object.prototype.polluted4, undefined);
});

