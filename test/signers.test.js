import assert from "node:assert/strict";
import test from "node:test";
import {
  buildQueryString,
  getAdjustedTime,
  getClockOffset,
  hmacSha256,
  hmacSha512,
  setClockOffset,
  sha512Hex,
  signBinanceRequest,
  signBybitRequest,
  signGateRequest,
  signKuCoinRequest,
  signKucoinRequest,
  syncTime,
} from "../src/signers.js";

test("signers: hmacSha256 produces valid signature matching standard vector", async () => {
  // RFC 4231 test vector 2: key = "Jefe", data = "what do ya want for nothing?"
  // Expected HMAC-SHA-256: 5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843
  const secret = "Jefe";
  const message = "what do ya want for nothing?";
  const sig = await hmacSha256(secret, message);
  assert.equal(sig, "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
});

test("signers: hmacSha512 produces valid signature matching standard vector", async () => {
  // RFC 4231 test vector 2 for HMAC-SHA-512
  const secret = "Jefe";
  const message = "what do ya want for nothing?";
  const sig = await hmacSha512(secret, message);
  assert.equal(
    sig,
    "164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737"
  );
});

test("signers: buildQueryString sorts keys deterministically", () => {
  const params = {
    symbol: "BTCUSDT",
    side: "BUY",
    quantity: 1,
    price: 50000,
  };
  const qs = buildQueryString(params);
  assert.equal(qs, "price=50000&quantity=1&side=BUY&symbol=BTCUSDT");
});

test("signers: clock offset sync and adjusted time", async () => {
  setClockOffset("test_venue", 1500);
  assert.equal(getClockOffset("test_venue"), 1500);

  const localNow = Date.now();
  const adjusted = getAdjustedTime("test_venue");
  assert.ok(adjusted >= localNow + 1490 && adjusted <= localNow + 1510);

  // Test syncTime with synthetic server time
  const mockServerTime = Date.now() + 5000;
  const syncRes = await syncTime("test_venue", async () => mockServerTime);
  assert.equal(syncRes.venue, "test_venue");
  assert.ok(syncRes.offset >= 4900 && syncRes.offset <= 5100);
});

test("signers: signBinanceRequest formats headers and query with signature", async () => {
  const apiKey = "binance-api-key";
  const secret = "binance-secret";
  const res = await signBinanceRequest({
    apiKey,
    secret,
    params: { symbol: "ETHUSDT", side: "BUY", quantity: 2 },
    timestamp: 1600000000000,
    recvWindow: 5000,
  });

  assert.equal(res.headers["X-MBX-APIKEY"], apiKey);
  assert.ok(res.queryString.includes("symbol=ETHUSDT"));
  assert.ok(res.queryString.includes("timestamp=1600000000000"));
  assert.ok(res.signature.length === 64);
  assert.ok(res.fullQueryString.endsWith(`&signature=${res.signature}`));
});

test("signers: signBybitRequest formats V5 headers and signature payload", async () => {
  const apiKey = "bybit-api-key";
  const secret = "bybit-secret";
  const body = { category: "linear", symbol: "BTCUSDT", qty: "0.1" };
  const res = await signBybitRequest({
    apiKey,
    secret,
    body,
    method: "POST",
    timestamp: 1600000000000,
    recvWindow: 5000,
  });

  assert.equal(res.headers["X-BAPI-API-KEY"], apiKey);
  assert.equal(res.headers["X-BAPI-TIMESTAMP"], "1600000000000");
  assert.equal(res.headers["X-BAPI-RECV-WINDOW"], "5000");
  assert.equal(res.headers["X-BAPI-SIGN-TYPE"], "2");
  assert.ok(res.headers["X-BAPI-SIGN"].length === 64);
  assert.equal(res.bodyStr, JSON.stringify(body));
});

test("signers: sha512Hex computes standard SHA-512 hashes", async () => {
  // Empty string vector
  const emptyHash = await sha512Hex("");
  assert.equal(
    emptyHash,
    "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"
  );

  // Vector for "abc"
  const abcHash = await sha512Hex("abc");
  assert.equal(
    abcHash,
    "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f"
  );
});

test("signers: signGateRequest formats APIv4 HMAC-SHA512 headers and payload", async () => {
  const apiKey = "gate-test-api-key";
  const secret = "gate-test-secret";
  const body = { contract: "BTC_USDT", size: 10, price: "0", tif: "ioc" };
  const res = await signGateRequest({
    apiKey,
    secret,
    method: "POST",
    path: "/api/v4/futures/usdt/orders",
    params: {},
    body,
    timestamp: 1700000000,
  });

  assert.equal(res.headers["KEY"], apiKey);
  assert.equal(res.headers["Timestamp"], "1700000000");
  assert.equal(res.headers["Content-Type"], "application/json");
  assert.equal(res.headers["Accept"], "application/json");
  assert.ok(res.headers["SIGN"].length === 128); // SHA-512 hex is 128 characters
  assert.equal(res.bodyStr, JSON.stringify(body));
  assert.ok(res.signString.includes("POST\n/api/v4/futures/usdt/orders\n\n"));
  assert.ok(res.signString.endsWith("\n1700000000"));

  // Check required validation
  await assert.rejects(
    () => signGateRequest({ apiKey: "", secret }),
    /requires apiKey and secret/i
  );
  await assert.rejects(
    () => signGateRequest({ apiKey, secret, path: "" }),
    /requires a URL path/i
  );
});

test("signers: signKuCoinRequest formats HMAC-SHA256 Base64 headers, signed passphrase, and signature", async () => {
  const apiKey = "kucoin-test-api-key";
  const secret = "kucoin-test-secret";
  const passphrase = "kucoin-passphrase-123";
  const body = { clientOid: "test-oid-1", symbol: "XBTUSDTM", type: "market", size: 1 };
  const res = await signKuCoinRequest({
    apiKey,
    secret,
    passphrase,
    method: "POST",
    endpoint: "/api/v1/orders",
    body,
    timestamp: 1700000000000,
  });

  assert.equal(res.headers["KC-API-KEY"], apiKey);
  assert.equal(res.headers["KC-API-TIMESTAMP"], "1700000000000");
  assert.equal(res.headers["KC-API-KEY-VERSION"], "2");
  assert.ok(res.headers["KC-API-SIGN"].length > 20); // Base64 signature
  assert.ok(res.headers["KC-API-PASSPHRASE"].length > 10); // Base64 signed passphrase
  assert.equal(res.endpoint, "/api/v1/orders");
  assert.equal(res.bodyStr, JSON.stringify(body));

  // Test alias
  assert.equal(typeof signKucoinRequest, "function");

  // Check required validation
  await assert.rejects(
    () => signKuCoinRequest({ apiKey: "", secret, passphrase, endpoint: "/test" }),
    /requires apiKey, secret, and passphrase/i
  );
  await assert.rejects(
    () => signKuCoinRequest({ apiKey, secret, passphrase: "", endpoint: "/test" }),
    /requires apiKey, secret, and passphrase/i
  );
});

