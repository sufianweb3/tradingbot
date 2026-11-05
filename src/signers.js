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
 * Compute SHA-512 digest encoded as lowercase hex string.
 * @param {string|Uint8Array} message
 * @returns {Promise<string>} Hex-encoded SHA-512 hash
 */
export async function sha512Hex(message = "") {
  const enc = new TextEncoder();
  const msgBytes = typeof message === "string" ? enc.encode(message) : new Uint8Array(message || []);
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-512", msgBytes);
  return bufToHex(hashBuf);
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

/**
 * Sign a Gate.io APIv4 request (HMAC-SHA512).
 * Format:
 * Method + "\n" + URL_Path + "\n" + QueryString + "\n" + HexEncode(SHA512(Body)) + "\n" + Timestamp
 * Headers: KEY, SIGN, Timestamp (seconds), Content-Type: application/json, Accept: application/json
 */
export async function signGateRequest({
  apiKey,
  secret,
  method = "GET",
  path,
  params = {},
  body = null,
  timestamp = null,
}) {
  if (!apiKey || !secret) {
    throw new Error("Gate.io signing requires apiKey and secret.");
  }
  if (!path) {
    throw new Error("Gate.io signing requires a URL path.");
  }

  const m = method.toUpperCase();
  const ts = String(
    timestamp !== null && timestamp !== undefined
      ? timestamp
      : Math.floor(getAdjustedTime("gate") / 1000)
  );

  const queryString = buildQueryString(params);
  const bodyStr = body ? (typeof body === "string" ? body : JSON.stringify(body)) : "";
  const hashedPayload = await sha512Hex(bodyStr);

  const signString = `${m}\n${path}\n${queryString}\n${hashedPayload}\n${ts}`;
  const signature = await hmacSha512(secret, signString);

  return {
    headers: {
      KEY: apiKey,
      SIGN: signature,
      Timestamp: ts,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    signature,
    timestamp: Number(ts),
    queryString,
    bodyStr,
    hashedPayload,
    signString,
  };
}

/**
 * Sign a KuCoin Futures request (HMAC-SHA256 Base64, API Key Version 2).
 * Passphrase signed: hmacSha256Base64(secret, passphrase)
 * Sign string: TimestampInMs + Method + Endpoint + Body
 * Headers: KC-API-KEY, KC-API-SIGN, KC-API-TIMESTAMP, KC-API-PASSPHRASE, KC-API-KEY-VERSION: 2
 */
export async function signKuCoinRequest({
  apiKey,
  secret,
  passphrase,
  method = "GET",
  endpoint,
  params = {},
  body = null,
  timestamp = null,
}) {
  if (!apiKey || !secret || !passphrase) {
    throw new Error("KuCoin signing requires apiKey, secret, and passphrase.");
  }
  if (!endpoint) {
    throw new Error("KuCoin signing requires an endpoint path.");
  }

  const m = method.toUpperCase();
  const ts = String(
    timestamp !== null && timestamp !== undefined
      ? timestamp
      : getAdjustedTime("kucoin")
  );

  let fullEndpoint = endpoint;
  const qs = buildQueryString(params);
  if (qs) {
    fullEndpoint = fullEndpoint.includes("?") ? `${fullEndpoint}&${qs}` : `${fullEndpoint}?${qs}`;
  }

  const bodyStr = body ? (typeof body === "string" ? body : JSON.stringify(body)) : "";
  const signedPassphrase = await hmacSha256Base64(secret, passphrase);

  const signString = `${ts}${m}${fullEndpoint}${bodyStr}`;
  const signature = await hmacSha256Base64(secret, signString);

  return {
    headers: {
      "KC-API-KEY": apiKey,
      "KC-API-SIGN": signature,
      "KC-API-TIMESTAMP": ts,
      "KC-API-PASSPHRASE": signedPassphrase,
      "KC-API-KEY-VERSION": "2",
      "Content-Type": "application/json",
    },
    signature,
    signedPassphrase,
    timestamp: Number(ts),
    endpoint: fullEndpoint,
    bodyStr,
    signString,
  };
}

export const signKucoinRequest = signKuCoinRequest;

/**
 * Sign a MEXC Contract/Futures API request (HMAC-SHA256).
 * String to sign: ApiKey + Request-Time + paramString
 * - For GET: paramString is alphabetically sorted query string (buildQueryString(params))
 * - For POST/PUT/DELETE: paramString is raw JSON string body
 * - If queryString is explicitly provided, it is used as paramString
 * Headers: ApiKey, Request-Time, Signature, Content-Type: application/json
 */
export async function signMexcRequest({
  apiKey = "",
  secret = "",
  secretKey = "",
  method = "GET",
  params = {},
  queryString = "",
  body = null,
  timestamp = null,
}) {
  const signingKey = secret || secretKey;
  if (!apiKey || !signingKey) {
    throw new Error("MEXC signing requires apiKey and secret.");
  }

  const m = String(method).toUpperCase();
  const ts = String(
    timestamp !== null && timestamp !== undefined
      ? timestamp
      : getAdjustedTime("mexc")
  );

  let paramStr = "";
  let bodyStr = "";
  let queryStr = "";

  if (queryString) {
    paramStr = queryString;
    queryStr = queryString;
  } else if (m === "GET") {
    if (params && Object.keys(params).length > 0) {
      paramStr = buildQueryString(params);
      queryStr = paramStr;
    }
  } else {
    if (body !== null && body !== undefined) {
      bodyStr = typeof body === "string" ? body : JSON.stringify(body);
      paramStr = bodyStr;
    } else if (params && Object.keys(params).length > 0) {
      paramStr = buildQueryString(params);
      queryStr = paramStr;
    }
  }

  const signPayload = `${apiKey}${ts}${paramStr}`;
  const signature = await hmacSha256(signingKey, signPayload);

  return {
    headers: {
      ApiKey: apiKey,
      "Request-Time": ts,
      Signature: signature,
      "Content-Type": "application/json",
    },
    signature,
    timestamp: Number(ts),
    signString: signPayload,
    queryString: queryStr,
    bodyStr,
  };
}

export const signMEXCRequest = signMexcRequest;

