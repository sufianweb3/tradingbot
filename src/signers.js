/**
 * Pure WebCrypto Signers & Clock Synchronization (PRD 5.6, 5.7, 6.2)
 *
 * Implements HMAC-SHA256 and HMAC-SHA512 signing using browser crypto.subtle.
 * Handles server time drift synchronization and per-venue signature schemas.
 */

// Clock drift offsets relative to local client time in milliseconds: serverTime - clientTime
const _clockOffsets = new Map();

/**
 * Convert an ArrayBuffer or Uint8Array to a lowercase hex string.
 */
export function bufToHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Convert an ArrayBuffer or Uint8Array to a Base64 string.
 */
export function bufToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}

/**
 * Compute HMAC-SHA256 signature using WebCrypto.
 * @returns {Promise<string>} Hex-encoded signature string
 */
export async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const keyMaterial = enc.encode(secret);
  const msgBytes = typeof message === "string" ? enc.encode(message) : new Uint8Array(message);

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuf = await globalThis.crypto.subtle.sign("HMAC", key, msgBytes);
  return bufToHex(sigBuf);
}

/**
 * Compute HMAC-SHA256 signature encoded as Base64.
 */
export async function hmacSha256Base64(secret, message) {
  const enc = new TextEncoder();
  const keyMaterial = enc.encode(secret);
  const msgBytes = typeof message === "string" ? enc.encode(message) : new Uint8Array(message);

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sigBuf = await globalThis.crypto.subtle.sign("HMAC", key, msgBytes);
  return bufToBase64(sigBuf);
}

/**
 * Compute HMAC-SHA512 signature using WebCrypto.
 * @returns {Promise<string>} Hex-encoded signature string
 */
export async function hmacSha512(secret, message) {
  const enc = new TextEncoder();
  const keyMaterial = enc.encode(secret);
  const msgBytes = typeof message === "string" ? enc.encode(message) : new Uint8Array(message);

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );

  const sigBuf = await globalThis.crypto.subtle.sign("HMAC", key, msgBytes);
  return bufToHex(sigBuf);
}

/**
 * Set the clock drift offset in ms for a venue.
 */
export function setClockOffset(venueId, offsetMs) {
  if (!venueId) return;
  _clockOffsets.set(venueId.toLowerCase().trim(), Math.round(Number(offsetMs) || 0));
}

/**
 * Get current clock offset in ms for a venue.
 */
export function getClockOffset(venueId) {
  if (!venueId) return 0;
  return _clockOffsets.get(venueId.toLowerCase().trim()) || 0;
}

/**
 * Get adjusted timestamp for a venue incorporating synced clock drift.
 */
export function getAdjustedTime(venueId) {
  return Date.now() + getClockOffset(venueId);
}

/**
 * Synchronize local clock with exchange server time.
 * Calculates half-RTT to estimate accurate server epoch.
 */
export async function syncTime(venueId, fetchServerTimeFn) {
  const vId = venueId?.toLowerCase()?.trim();
  if (!vId || typeof fetchServerTimeFn !== "function") {
    return { offset: 0, rtt: 0, serverTime: Date.now() };
  }

  const t0 = Date.now();
  const serverTime = await fetchServerTimeFn();
  const t1 = Date.now();

  const rtt = Math.max(0, t1 - t0);
  const estimatedServerNow = serverTime + Math.round(rtt / 2);
  const offset = estimatedServerNow - t1;

  setClockOffset(vId, offset);
  return {
    venue: vId,
    offset,
    rtt,
    serverTime,
    adjustedNow: t1 + offset,
  };
}

/**
 * Build sorted URL query string from parameters object.
 */
export function buildQueryString(params = {}) {
  if (!params || typeof params !== "object") return "";
  const keys = Object.keys(params).sort();
  const parts = [];
  for (const k of keys) {
    const val = params[k];
    if (val !== undefined && val !== null && val !== "") {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(val)}`);
    }
  }
  return parts.join("&");
}

/**
 * Sign a Binance USDT-M Futures request (HMAC-SHA256).
 */
export async function signBinanceRequest({
  apiKey,
  secret,
  params = {},
  timestamp = null,
  recvWindow = 5000,
}) {
  if (!apiKey || !secret) {
    throw new Error("Binance signing requires apiKey and secret.");
  }

  const fullParams = {
    ...params,
    recvWindow,
    timestamp: timestamp || getAdjustedTime("binance"),
  };

  const queryString = buildQueryString(fullParams);
  const signature = await hmacSha256(secret, queryString);

  return {
    headers: {
      "X-MBX-APIKEY": apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    queryString,
    signature,
    fullQueryString: `${queryString}&signature=${signature}`,
    timestamp: fullParams.timestamp,
  };
}

/**
 * Sign a Bybit V5 Linear request (HMAC-SHA256).
 * Payload: timestamp + apiKey + recvWindow + (queryString | bodyJson)
 */
export async function signBybitRequest({
  apiKey,
  secret,
  params = {},
  body = null,
  method = "GET",
  timestamp = null,
  recvWindow = 5000,
}) {
  if (!apiKey || !secret) {
    throw new Error("Bybit signing requires apiKey and secret.");
  }

  const m = method.toUpperCase();
  const ts = String(timestamp || getAdjustedTime("bybit"));
  const rw = String(recvWindow);

  let payloadSuffix = "";
  let queryString = "";
  let bodyStr = "";

  if (m === "GET") {
    queryString = buildQueryString(params);
    payloadSuffix = queryString;
  } else {
    bodyStr = typeof body === "string" ? body : JSON.stringify(body || {});
    payloadSuffix = bodyStr;
  }

  const signPayload = `${ts}${apiKey}${rw}${payloadSuffix}`;
  const signature = await hmacSha256(secret, signPayload);

  return {
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": ts,
      "X-BAPI-SIGN": signature,
      "X-BAPI-RECV-WINDOW": rw,
      "X-BAPI-SIGN-TYPE": "2",
      "Content-Type": "application/json",
    },
    queryString,
    bodyStr,
    signature,
    timestamp: Number(ts),
  };
}
