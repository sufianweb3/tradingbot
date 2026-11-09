import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  buildQueryString,
  hmacSha256,
  hmacSha512,
  sha512Hex,
  signGateRequest,
  signKuCoinRequest,
} from "../src/signers.js";
import { GateAdapter } from "../src/venues/gate.js";
import { KuCoinAdapter } from "../src/venues/kucoin.js";

function mockFetch(handler) {
  return async (url, options = {}) => handler(url, options);
}

// -------------------------------------------------------------
// AREA 1: WebCrypto Signers Stress & Oracle Tests
// -------------------------------------------------------------

test("signers stress: sha512Hex matches node crypto oracle across adversarial inputs", async () => {
  const inputs = [
    "",
    "a",
    "abc",
    "The quick brown fox jumps over the lazy dog",
    "🚀🔥💥 Crypto Trading Bot 🤖",
    "বাংলা ভাষা ও গণিত",
    "\u0000\u0001\u0002\u0003\n\r\t\"'\\",
    JSON.stringify({ a: 1, b: "hello", nested: { arr: [1, 2, 3, "foo"] } }),
    "x".repeat(100_000), // 100 KB
  ];

  for (const input of inputs) {
    const webCryptoHex = await sha512Hex(input);
    const nodeHex = crypto.createHash("sha512").update(input, "utf8").digest("hex");
    assert.equal(webCryptoHex, nodeHex, `Hash mismatch for input of length ${input.length}`);
  }

  // Edge cases: null, undefined, Uint8Array
  const nullHex = await sha512Hex(null);
  const emptyHex = crypto.createHash("sha512").update("").digest("hex");
  assert.equal(nullHex, emptyHex);

  const undefHex = await sha512Hex(undefined);
  assert.equal(undefHex, emptyHex);

  const uint8Input = new Uint8Array([1, 2, 3, 4, 5]);
  const uint8Hex = await sha512Hex(uint8Input);
  const nodeUint8Hex = crypto.createHash("sha512").update(uint8Input).digest("hex");
  assert.equal(uint8Hex, nodeUint8Hex);
});

test("signers stress: signGateRequest oracle verification & adversarial inputs", async () => {
  const apiKey = "gate_test_key_xyz";
  const secret = "gate_test_secret_abc123";
  const path = "/api/v4/futures/usdt/orders";

  // Check required validation
  await assert.rejects(() => signGateRequest({ apiKey: "", secret, path }), /requires apiKey and secret/i);
  await assert.rejects(() => signGateRequest({ apiKey, secret: "", path }), /requires apiKey and secret/i);
  await assert.rejects(() => signGateRequest({ apiKey, secret, path: "" }), /requires a URL path/i);

  // Test cases
  const testCases = [
    { method: "GET", path: "/api/v4/futures/usdt/accounts", params: {}, body: null, timestamp: 1700000000 },
    { method: "POST", path: "/api/v4/futures/usdt/orders", params: {}, body: { contract: "BTC_USDT", size: 10 }, timestamp: 1700000001 },
    { method: "get", path: "/api/v4/futures/usdt/tickers", params: { contract: "ETH_USDT" }, body: null, timestamp: 0 },
    { method: "DELETE", path: "/api/v4/futures/usdt/orders/12345", params: { settle: "usdt" }, body: "", timestamp: -1 },
    {
      method: "POST",
      path: "/api/v4/futures/usdt/orders",
      params: { z: "last", a: "first", m: "mid" },
      body: JSON.stringify({ note: "unicode: 🚀বাংলা" }),
      timestamp: 2500000000,
    },
  ];

  for (const tc of testCases) {
    const res = await signGateRequest({
      apiKey,
      secret,
      method: tc.method,
      path: tc.path,
      params: tc.params,
      body: tc.body,
      timestamp: tc.timestamp,
    });

    const m = tc.method.toUpperCase();
    const ts = String(tc.timestamp);
    const qs = buildQueryString(tc.params);
    const bodyStr = tc.body ? (typeof tc.body === "string" ? tc.body : JSON.stringify(tc.body)) : "";
    const hashedPayload = crypto.createHash("sha512").update(bodyStr, "utf8").digest("hex");
    const signString = `${m}\n${tc.path}\n${qs}\n${hashedPayload}\n${ts}`;
    const oracleSig = crypto.createHmac("sha512", secret).update(signString, "utf8").digest("hex");

    assert.equal(res.headers.KEY, apiKey);
    assert.equal(res.headers.Timestamp, ts);
    assert.equal(res.headers.SIGN, oracleSig);
    assert.equal(res.signature, oracleSig);
    assert.equal(res.hashedPayload, hashedPayload);
    assert.equal(res.signString, signString);
  }
});

test("signers stress: signKuCoinRequest oracle verification & adversarial inputs", async () => {
  const apiKey = "kucoin_key_abc";
  const secret = "kucoin_secret_def";
  const passphrase = "kucoin_passphrase_xyz!@#";

  // Check required validation
  await assert.rejects(() => signKuCoinRequest({ apiKey: "", secret, passphrase, endpoint: "/api/v1/orders" }), /requires apiKey, secret, and passphrase/i);
  await assert.rejects(() => signKuCoinRequest({ apiKey, secret: "", passphrase, endpoint: "/api/v1/orders" }), /requires apiKey, secret, and passphrase/i);
  await assert.rejects(() => signKuCoinRequest({ apiKey, secret, passphrase: "", endpoint: "/api/v1/orders" }), /requires apiKey, secret, and passphrase/i);
  await assert.rejects(() => signKuCoinRequest({ apiKey, secret, passphrase, endpoint: "" }), /requires an endpoint path/i);

  const testCases = [
    { method: "GET", endpoint: "/api/v1/user/api-key", params: {}, body: null, timestamp: 1700000000000 },
    { method: "POST", endpoint: "/api/v1/orders", params: {}, body: { symbol: "XBTUSDTM", size: 5 }, timestamp: 1700000000001 },
    { method: "GET", endpoint: "/api/v1/contracts/active", params: { symbol: "XBTUSDTM" }, body: null, timestamp: 0 },
    { method: "DELETE", endpoint: "/api/v1/orders/12345?query=existing", params: { more: "param" }, body: "", timestamp: -1 },
    {
      method: "POST",
      endpoint: "/api/v1/orders",
      params: {},
      body: JSON.stringify({ clientOid: "oid-🚀-বাংলা" }),
      timestamp: 2500000000000,
    },
  ];

  for (const tc of testCases) {
    const res = await signKuCoinRequest({
      apiKey,
      secret,
      passphrase,
      method: tc.method,
      endpoint: tc.endpoint,
      params: tc.params,
      body: tc.body,
      timestamp: tc.timestamp,
    });

    const m = tc.method.toUpperCase();
    const ts = String(tc.timestamp);
    let fullEndpoint = tc.endpoint;
    const qs = buildQueryString(tc.params);
    if (qs) {
      fullEndpoint = fullEndpoint.includes("?") ? `${fullEndpoint}&${qs}` : `${fullEndpoint}?${qs}`;
    }
    const bodyStr = tc.body ? (typeof tc.body === "string" ? tc.body : JSON.stringify(tc.body)) : "";
    const signString = `${ts}${m}${fullEndpoint}${bodyStr}`;

    const oracleSignedPassphrase = crypto.createHmac("sha256", secret).update(passphrase, "utf8").digest("base64");
    const oracleSig = crypto.createHmac("sha256", secret).update(signString, "utf8").digest("base64");

    assert.equal(res.headers["KC-API-KEY"], apiKey);
    assert.equal(res.headers["KC-API-TIMESTAMP"], ts);
    assert.equal(res.headers["KC-API-PASSPHRASE"], oracleSignedPassphrase);
    assert.equal(res.headers["KC-API-SIGN"], oracleSig);
    assert.equal(res.headers["KC-API-KEY-VERSION"], "2");
    assert.equal(res.signature, oracleSig);
    assert.equal(res.signedPassphrase, oracleSignedPassphrase);
    assert.equal(res.endpoint, fullEndpoint);
  }
});

// -------------------------------------------------------------
// AREA 2: Security Invariant (PRD 5.6 E3) Adversarial Key Validation
// -------------------------------------------------------------

test("adversarial: GateAdapter validateKey against sneaky withdrawal payloads", async () => {
  const sneakyWithdrawalPayloads = [
    // Standard
    { perms: [{ name: "wallet", read_only: false }, { name: "futures", read_only: false }] },
    // Uppercase / casing
    { perms: [{ name: "WALLET", read_only: false }, { name: "futures", read_only: false }] },
    { perms: [{ name: "WITHDRAW", read_only: true }] },
    { perms: [{ name: "WITHDRAWAL", read_only: false }] },
    { perms: [{ name: "Withdrawal", read_only: false }] },
    { perms: [{ name: "spot_withdraw", read_only: false }] },
    // String array perms
    { perms: ["withdraw", "futures"] },
    { perms: ["WITHDRAWAL"] },
    // Alternative property names
    { perms: [{ perm: "withdraw" }] },
    { perms: [{ permission: "withdraw" }] },
    // Falsy / non-boolean read_only
    { perms: [{ name: "wallet", read_only: "false" }] },
    { perms: [{ name: "wallet", read_only: 0 }] },
    // Permissions field
    { permissions: ["withdraw"] },
    { permissions: "wallet,withdraw" },
    // Boolean / truthy flags
    { canWithdraw: true },
    { can_withdraw: true },
    { enable_withdrawals: true },
    { enableWithdrawals: true },
    { withdraw: true },
    { canWithdraw: "true" },
    { canWithdraw: 1 },
    { can_withdraw: "true" },
    { can_withdraw: 1 },
    // Uppercase and whitespace truthy flags
    { canWithdraw: "TRUE" },
    { canWithdraw: "True" },
    { canWithdraw: " 1 " },
    { can_withdraw: "TRUE" },
    { can_withdraw: "True" },
    { can_withdraw: " 1 " },
    { enable_withdrawals: "TRUE" },
    { enable_withdrawals: "True" },
    { enableWithdrawals: "TRUE" },
    { isWithdrawEnabled: "TRUE" },
    { is_withdraw_enabled: "True" },
    { withdraw: "TRUE" },
    { withdrawal: "True" },
    { perms: { withdraw: "TRUE" } },
    { perms: { withdraw: "True" } },
    { perms: { withdraw: " 1 " } },
    { perms: [{ name: "wallet", read_only: "FALSE" }] },
    { perms: [{ name: "wallet", read_only: " 0 " }] },
  ];

  const failedPayloads = [];

  for (const [idx, payload] of sneakyWithdrawalPayloads.entries()) {
    const fetchFn = mockFetch(async (url) => {
      if (url.includes("/api/v4/spot/time")) {
        return { ok: true, json: async () => ({ server_time: Date.now() }) };
      }
      if (url.includes("/api/v4/account/detail")) {
        return {
          ok: true,
          text: async () => JSON.stringify(payload),
        };
      }
      if (url.includes("/api/v4/futures/usdt/accounts")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ user: 1, currency: "USDT", total: "100", canTrade: true }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const adapter = new GateAdapter({ apiKey: "k", secret: "s", fetchFn });
    const res = await adapter.validateKey();

    if (res.ok !== false || res.canWithdraw !== true || !res.error?.includes("withdrawal permissions enabled")) {
      failedPayloads.push({ idx, payload, res });
    }
  }

  assert.equal(
    failedPayloads.length,
    0,
    `GateAdapter failed to reject ${failedPayloads.length} sneaky withdrawal payloads:\n` +
      failedPayloads.map((f) => `  #${f.idx}: ${JSON.stringify(f.payload)} => res: ${JSON.stringify(f.res)}`).join("\n")
  );
});

test("adversarial: KuCoinAdapter validateKey against sneaky withdrawal payloads", async () => {
  const sneakyWithdrawalPayloads = [
    // Standard array
    { permissions: ["Futures", "Withdraw"] },
    { permissions: ["Futures", "Withdrawal"] },
    { permissions: ["futures", "withdrawal"] },
    { permissions: ["WITHDRAWAL"] },
    { permissions: ["Transfer"] },
    { permissions: ["transfer"] },
    { permissions: ["TRANSFER"] },
    // String permissions (plural vs singular)
    { permissions: "General,Trade,Withdrawal" },
    { permissions: "Withdrawal" },
    { permissions: "Futures,Transfer" },
    { permission: "Futures,Withdrawal" },
    { permission: "withdraw" },
    { permission: "transfer" },
    // Nested objects / mixed array
    { permissions: [{ name: "Withdraw" }] },
    { permissions: [{ permission: "Withdraw" }] },
    { permissions: ["Futures", { name: "Withdrawal" }] },
    // Boolean / truthy flags
    { canWithdraw: true },
    { enableWithdrawals: true },
    { can_withdraw: true },
    { isWithdrawEnabled: true },
    { canWithdraw: "true" },
    { canWithdraw: 1 },
    { can_withdraw: "true" },
    { can_withdraw: 1 },
    // Dictionary objects with string truthy values
    { permissions: { futures: true, withdraw: "true" } },
    { permissions: { futures: true, withdraw: "TRUE" } },
    { permissions: { futures: true, withdraw: "True" } },
    { permissions: { futures: true, withdraw: " 1 " } },
    { permissions: { futures: true, transfer: "1" } },
    { permissions: { futures: true, transfer: "true" } },
    { permissions: { futures: true, transfer: "TRUE" } },
    { permissions: { futures: true, transfer: " 1 " } },
    { permissions: { futures: true, withdrawal: "TRUE" } },
    { permissions: { trade: true, canWithdraw: "1" } },
    { permissions: { trade: true, isWithdrawEnabled: "true" } },
  ];

  const failedPayloads = [];

  for (const [idx, payload] of sneakyWithdrawalPayloads.entries()) {
    const fetchFn = mockFetch(async (url) => {
      if (url.includes("/api/v1/timestamp")) {
        return { ok: true, json: async () => ({ code: "200000", data: Date.now() }) };
      }
      if (url.includes("/api/v1/user/api-key")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ code: "200000", data: payload }),
        };
      }
      if (url.includes("/api/v1/account-overview")) {
        return {
          ok: true,
          text: async () => JSON.stringify({ code: "200000", data: { accountEquity: 100, canTrade: true } }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });
    const res = await adapter.validateKey();

    if (res.ok !== false || res.canWithdraw !== true || !res.error?.includes("withdrawal permissions enabled")) {
      failedPayloads.push({ idx, payload, res });
    }
  }

  assert.equal(
    failedPayloads.length,
    0,
    `KuCoinAdapter failed to reject ${failedPayloads.length} sneaky withdrawal payloads:\n` +
      failedPayloads.map((f) => `  #${f.idx}: ${JSON.stringify(f.payload)} => res: ${JSON.stringify(f.res)}`).join("\n")
  );
});

// -------------------------------------------------------------
// AREA 3: Gate.io & KuCoin Regression Protection (Challenger R2)
// -------------------------------------------------------------

test("adversarial: GateAdapter validateKey accepts valid keys with uppercase/mixed-case read-only flags", async () => {
  const validReadOnlyPerms = [
    { perms: [{ name: "wallet", read_only: "TRUE" }, { name: "futures", read_only: false }] },
    { perms: [{ name: "wallet", read_only: "True" }, { name: "futures", read_only: false }] },
    { perms: [{ name: "wallet", read_only: " 1 " }, { name: "futures", read_only: false }] },
    { perms: [{ name: "wallet", readonly: "TRUE" }, { name: "futures", read_only: false }] },
    { perms: [{ name: "wallet", readonly: " 1 " }, { name: "futures", read_only: false }] },
  ];

  for (const payload of validReadOnlyPerms) {
    const fetchFn = mockFetch(async (url) => {
      if (url.includes("/api/v4/spot/time")) return { ok: true, json: async () => ({ server_time: Date.now() }) };
      if (url.includes("/api/v4/account/detail")) return { ok: true, text: async () => JSON.stringify(payload) };
      if (url.includes("/api/v4/futures/usdt/accounts")) {
        return { ok: true, text: async () => JSON.stringify({ user: 12345, currency: "USDT", total: "1000", canTrade: true }) };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const adapter = new GateAdapter({ apiKey: "k", secret: "s", fetchFn });
    const res = await adapter.validateKey();
    assert.equal(res.ok, true, `Expected ok: true for ${JSON.stringify(payload)}, got: ${JSON.stringify(res)}`);
    assert.equal(res.canTrade, true);
    assert.equal(res.canWithdraw, false);
    assert.equal(res.accountId, "12345");
  }
});

test("adversarial: GateAdapter validateKey rejects trading access when futures permission is read_only with uppercase/mixed-case flags", async () => {
  const readOnlyFuturesPerms = [
    { perms: [{ name: "wallet", read_only: true }, { name: "futures", read_only: "TRUE" }] },
    { perms: [{ name: "wallet", read_only: true }, { name: "futures", read_only: "True" }] },
    { perms: [{ name: "wallet", read_only: true }, { name: "futures", read_only: " 1 " }] },
    { perms: [{ name: "wallet", read_only: true }, { name: "futures", readonly: "TRUE" }] },
  ];

  for (const payload of readOnlyFuturesPerms) {
    const fetchFn = mockFetch(async (url) => {
      if (url.includes("/api/v4/spot/time")) return { ok: true, json: async () => ({ server_time: Date.now() }) };
      if (url.includes("/api/v4/account/detail")) return { ok: true, text: async () => JSON.stringify(payload) };
      if (url.includes("/api/v4/futures/usdt/accounts")) {
        return { ok: true, text: async () => JSON.stringify({ user: 12345, currency: "USDT", total: "1000", canTrade: true }) };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const adapter = new GateAdapter({ apiKey: "k", secret: "s", fetchFn });
    const res = await adapter.validateKey();
    assert.equal(res.ok, false, `Expected ok: false for ${JSON.stringify(payload)}`);
    assert.equal(res.canTrade, false, `Expected canTrade: false for ${JSON.stringify(payload)}`);
    assert.equal(res.canWithdraw, false);
    assert.ok(res.error?.includes("Futures Trading permissions"), `Expected futures trading error, got: ${res.error}`);
  }
});

test("adversarial: KuCoinAdapter validateKey rejects trading access for empty or missing permission arrays", async () => {
  const emptyPermPayloads = [
    { permissions: [""] },
    { permissions: [] },
    { permissions: ["   "] },
    { permissions: ["", "  "] },
    { permission: "" },
    { permission: "   " },
    { permissions: ["Spot"] },
  ];

  for (const payload of emptyPermPayloads) {
    const fetchFn = mockFetch(async (url) => {
      if (url.includes("/api/v1/timestamp")) return { ok: true, json: async () => ({ code: "200000", data: Date.now() }) };
      if (url.includes("/api/v1/user/api-key")) return { ok: true, text: async () => JSON.stringify({ code: "200000", data: payload }) };
      if (url.includes("/api/v1/account-overview")) {
        return { ok: true, text: async () => JSON.stringify({ code: "200000", data: { accountEquity: 100, canTrade: true } }) };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });
    const res = await adapter.validateKey();
    assert.equal(res.ok, false, `Expected ok: false for ${JSON.stringify(payload)}, got: ${JSON.stringify(res)}`);
    assert.equal(res.canTrade, false, `Expected canTrade: false for ${JSON.stringify(payload)}`);
    assert.equal(res.canWithdraw, false);
    assert.ok(res.error?.includes("Futures Trading permissions"), `Expected futures trading error, got: ${res.error}`);
  }
});

