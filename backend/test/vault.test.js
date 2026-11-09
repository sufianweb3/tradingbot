import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptCredentials,
  deriveKeyFromPassphrase,
  encryptCredentials,
  getCredentials,
  hasCredentials,
  listVaultEntries,
  maskKey,
  removeCredentials,
  saveCredentials,
  wipeVault,
} from "../src/vault.js";

// Mock IDB store for vault testing
function createMockVaultStore() {
  const map = new Map();
  return {
    async getVaultKey(key) {
      return map.get(key) || null;
    },
    async putVaultKey(key, data) {
      map.set(key, { ...data, key });
      return true;
    },
    async deleteVaultKey(key) {
      map.delete(key);
      return true;
    },
    async listVaultKeys() {
      return Array.from(map.values());
    },
    async clearVault() {
      map.clear();
      return true;
    },
  };
}

test("maskKey masks characters safely", () => {
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("123"), "****");
  assert.equal(maskKey("123456"), "****");
  assert.equal(maskKey("AB12345678YZ"), "AB******78YZ");
  assert.equal(maskKey("my-binance-api-key-9999"), "my*****************9999");
});

test("vault: encrypt and decrypt round-trip with device key", async () => {
  const store = createMockVaultStore();
  const sampleCreds = {
    apiKey: "binance-api-key-test-1234",
    secret: "binance-secret-test-5678",
  };

  const enc = await encryptCredentials(sampleCreds, { idbStore: store });
  assert.ok(enc.ciphertext.length > 0);
  assert.ok(enc.iv.length === 12);

  const dec = await decryptCredentials(enc, { idbStore: store });
  assert.deepEqual(dec, sampleCreds);
});

test("vault: passphrase encryption protects credentials and rejects wrong passphrase", async () => {
  const sampleCreds = {
    apiKey: "bybit-key-xyz",
    secret: "bybit-secret-abc",
  };
  const passphrase = "correct-horse-battery-staple";

  const enc = await encryptCredentials(sampleCreds, { passphrase });
  assert.ok(enc.salt);

  // Decrypt with correct passphrase
  const dec = await decryptCredentials(enc, { passphrase });
  assert.deepEqual(dec, sampleCreds);

  // Decrypt with incorrect passphrase must fail
  await assert.rejects(
    async () => {
      await decryptCredentials(enc, { passphrase: "wrong-passphrase" });
    },
    /operation failed|bad signature|tag check failed|mac check failed|error/i
  );
});

test("vault: tampered ciphertext throws error", async () => {
  const sampleCreds = { apiKey: "test-key", secret: "test-secret" };
  const enc = await encryptCredentials(sampleCreds);

  // Flip a byte in ciphertext
  enc.ciphertext[0] ^= 0xff;

  await assert.rejects(async () => {
    await decryptCredentials(enc);
  });
});

test("vault: saveCredentials, getCredentials, and listVaultEntries invariants", async () => {
  const store = createMockVaultStore();
  await wipeVault({ idbStore: store });

  const binanceCreds = {
    apiKey: "binance-key-987654321",
    secret: "binance-secret-secret",
  };

  const saveRes = await saveCredentials("binance", binanceCreds, { idbStore: store });
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.venue, "binance");
  assert.equal(saveRes.connected, true);
  assert.ok(saveRes.maskedKey.startsWith("bi"));
  assert.ok(saveRes.maskedKey.endsWith("4321"));

  // hasCredentials
  const has = await hasCredentials("binance", { idbStore: store });
  assert.equal(has, true);

  // getCredentials
  const loaded = await getCredentials("binance", { idbStore: store });
  assert.deepEqual(loaded, binanceCreds);

  // listVaultEntries (CRITICAL SECURITY INVARIANT: NEVER EXPOSE FULL KEYS OR SECRETS)
  const list = await listVaultEntries({ idbStore: store });
  assert.equal(list.length, 1);
  const entry = list[0];
  assert.equal(entry.venue, "binance");
  assert.equal(entry.maskedKey, saveRes.maskedKey);
  assert.equal(entry.secret, undefined);
  assert.equal(entry.apiKey, undefined);

  // removeCredentials
  await removeCredentials("binance", { idbStore: store });
  const hasAfter = await hasCredentials("binance", { idbStore: store });
  assert.equal(hasAfter, false);
  const loadedAfter = await getCredentials("binance", { idbStore: store });
  assert.equal(loadedAfter, null);
});
