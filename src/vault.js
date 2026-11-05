/**
 * Secure Key Vault for Exchange API Credentials (PRD 5.7)
 *
 * Encrypts exchange API keys and secrets using pure WebCrypto AES-GCM (256-bit).
 * Decrypted credentials live ONLY in Worker memory and are NEVER logged,
 * NEVER exported in backups, and NEVER exposed over UI RPCs.
 */

import { now } from "./util.js";

const DEVICE_KEY_ID = "__device_key__";
const PBKDF2_ITERATIONS = 100_000;

// In-memory decrypted key cache: lives ONLY in Worker runtime memory
const _memoryCache = new Map();

/**
 * Mask an API key showing only first 2 and last 4 characters.
 */
export function maskKey(apiKey) {
  if (!apiKey || typeof apiKey !== "string") return "";
  const s = apiKey.trim();
  if (s.length <= 6) return "****";
  return `${s.slice(0, 2)}${"*".repeat(Math.max(4, s.length - 6))}${s.slice(-4)}`;
}

/**
 * Get the global WebCrypto subtle instance.
 */
function getSubtle() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto SubtleCrypto is not available in this environment.");
  }
  return subtle;
}

/**
 * Convert buffer to Array of bytes for JSON serialization.
 */
function toByteArray(buffer) {
  return Array.from(new Uint8Array(buffer));
}

/**
 * Convert byte array back to Uint8Array.
 */
function fromByteArray(arr) {
  return new Uint8Array(arr);
}

/**
 * Derive an AES-GCM 256-bit CryptoKey from a passphrase using PBKDF2.
 */
export async function deriveKeyFromPassphrase(passphrase, saltBytes) {
  const subtle = getSubtle();
  const enc = new TextEncoder();
  const rawKeyMaterial = await subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    rawKeyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Retrieve or generate the device-bound AES-GCM 256-bit master key.
 */
export async function getOrCreateDeviceKey(idbStore = null) {
  const subtle = getSubtle();

  // If store is provided and has getVaultKey, check if master key raw bytes exist
  if (idbStore && typeof idbStore.getVaultKey === "function") {
    try {
      const stored = await idbStore.getVaultKey(DEVICE_KEY_ID);
      if (stored && stored.rawKey) {
        return await subtle.importKey(
          "raw",
          fromByteArray(stored.rawKey),
          { name: "AES-GCM" },
          false,
          ["encrypt", "decrypt"]
        );
      }
    } catch {
      /* proceed to create */
    }
  }

  // Generate new device key
  const key = await subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // extractable temporarily to persist device key in vault store
    ["encrypt", "decrypt"]
  );

  if (idbStore && typeof idbStore.putVaultKey === "function") {
    try {
      const raw = await subtle.exportKey("raw", key);
      await idbStore.putVaultKey(DEVICE_KEY_ID, {
        key: DEVICE_KEY_ID,
        rawKey: toByteArray(raw),
        createdAt: now(),
      });
    } catch {
      /* ignore storage failure, use in-memory */
    }
  }

  return key;
}

/**
 * Encrypt a credentials object with AES-GCM 256-bit.
 */
export async function encryptCredentials(credentials, { masterKey = null, passphrase = null, idbStore = null } = {}) {
  const subtle = getSubtle();
  const enc = new TextEncoder();
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));

  let key = masterKey;
  let saltBytes = null;

  if (passphrase) {
    saltBytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    key = await deriveKeyFromPassphrase(passphrase, saltBytes);
  } else if (!key) {
    key = await getOrCreateDeviceKey(idbStore);
  }

  const plaintext = enc.encode(JSON.stringify(credentials));
  const ciphertext = await subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );

  return {
    ciphertext: toByteArray(ciphertext),
    iv: toByteArray(iv),
    salt: saltBytes ? toByteArray(saltBytes) : null,
  };
}

/**
 * Decrypt a credentials object from AES-GCM 256-bit payload.
 */
export async function decryptCredentials(encryptedPayload, { masterKey = null, passphrase = null, idbStore = null } = {}) {
  const subtle = getSubtle();
  const dec = new TextDecoder();
  const { ciphertext, iv, salt } = encryptedPayload;

  if (!ciphertext || !iv) {
    throw new Error("Invalid encrypted payload: missing ciphertext or iv.");
  }

  let key = masterKey;
  if (salt && passphrase) {
    key = await deriveKeyFromPassphrase(passphrase, fromByteArray(salt));
  } else if (!key) {
    key = await getOrCreateDeviceKey(idbStore);
  }

  const decryptedBuf = await subtle.decrypt(
    { name: "AES-GCM", iv: fromByteArray(iv) },
    key,
    fromByteArray(ciphertext)
  );

  const jsonStr = dec.decode(decryptedBuf);
  return JSON.parse(jsonStr);
}

/**
 * Store credentials in vault: encrypts and saves in IDB, caches decrypted in memory.
 */
export async function saveCredentials(venueId, credentials, { idbStore = null, passphrase = null } = {}) {
  if (!venueId || typeof venueId !== "string") {
    throw new Error("Invalid venueId for vault save.");
  }
  if (!credentials || typeof credentials !== "object" || !credentials.apiKey || !credentials.secret) {
    throw new Error("Invalid credentials: must include apiKey and secret.");
  }

  const vId = venueId.toLowerCase().trim();
  const encrypted = await encryptCredentials(credentials, { passphrase, idbStore });
  const masked = maskKey(credentials.apiKey);

  const vaultRecord = {
    key: vId,
    venue: vId,
    ...encrypted,
    maskedKey: masked,
    passphraseProtected: Boolean(passphrase),
    createdAt: now(),
    updatedAt: now(),
  };

  if (idbStore && typeof idbStore.putVaultKey === "function") {
    await idbStore.putVaultKey(vId, vaultRecord);
  }

  // Update in-memory worker cache
  _memoryCache.set(vId, {
    venue: vId,
    credentials: { ...credentials },
    maskedKey: masked,
  });

  return {
    ok: true,
    venue: vId,
    maskedKey: masked,
    connected: true,
  };
}

/**
 * Retrieve credentials for a venue.
 * Returns from memory cache if present; otherwise decrypts from IDB and caches.
 */
export async function getCredentials(venueId, { idbStore = null, passphrase = null } = {}) {
  const vId = venueId?.toLowerCase()?.trim();
  if (!vId) return null;

  if (_memoryCache.has(vId)) {
    return _memoryCache.get(vId).credentials;
  }

  if (idbStore && typeof idbStore.getVaultKey === "function") {
    const record = await idbStore.getVaultKey(vId);
    if (!record || !record.ciphertext) return null;

    try {
      const creds = await decryptCredentials(record, { passphrase, idbStore });
      _memoryCache.set(vId, {
        venue: vId,
        credentials: creds,
        maskedKey: record.maskedKey || maskKey(creds.apiKey),
      });
      return creds;
    } catch (err) {
      console.warn(`[vault] Decryption failed for venue ${vId}:`, err?.message);
      return null;
    }
  }

  return null;
}

/**
 * Check if vault has credentials for a venue (without decrypting).
 */
export async function hasCredentials(venueId, { idbStore = null } = {}) {
  const vId = venueId?.toLowerCase()?.trim();
  if (!vId) return false;
  if (_memoryCache.has(vId)) return true;

  if (idbStore && typeof idbStore.getVaultKey === "function") {
    const record = await idbStore.getVaultKey(vId);
    return Boolean(record && record.ciphertext);
  }
  return false;
}

/**
 * Remove credentials for a venue from both memory and storage.
 */
export async function removeCredentials(venueId, { idbStore = null } = {}) {
  const vId = venueId?.toLowerCase()?.trim();
  if (!vId) return { ok: false };

  _memoryCache.delete(vId);

  if (idbStore && typeof idbStore.deleteVaultKey === "function") {
    await idbStore.deleteVaultKey(vId);
  }

  return { ok: true, venue: vId };
}

/**
 * List all stored keys (metadata only - NEVER reveals secret or full key).
 */
export async function listVaultEntries({ idbStore = null } = {}) {
  const entries = [];

  if (idbStore && typeof idbStore.listVaultKeys === "function") {
    const records = await idbStore.listVaultKeys();
    for (const r of records) {
      if (r.key === DEVICE_KEY_ID) continue; // skip internal device key
      entries.push({
        venue: r.venue || r.key,
        maskedKey: r.maskedKey || "****",
        passphraseProtected: Boolean(r.passphraseProtected),
        createdAt: r.createdAt || null,
        updatedAt: r.updatedAt || null,
        inMemory: _memoryCache.has(r.venue || r.key),
      });
    }
    return entries;
  }

  // Fallback to in-memory list
  for (const [venue, data] of _memoryCache.entries()) {
    entries.push({
      venue,
      maskedKey: data.maskedKey,
      passphraseProtected: false,
      createdAt: now(),
      updatedAt: now(),
      inMemory: true,
    });
  }

  return entries;
}

/**
 * Wipe all credentials from memory and storage immediately.
 */
export async function wipeVault({ idbStore = null } = {}) {
  _memoryCache.clear();
  if (idbStore && typeof idbStore.clearVault === "function") {
    await idbStore.clearVault();
  }
  return { ok: true };
}
