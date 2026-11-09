/**
 * Golden-file test comparing Node AES-128-ECB decryption and WebCrypto AES-CBC unpadded emulation.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";

import { decryptBody as webDecryptBody } from "../web/cg-worker.js";

function nodeAesEcbEncrypt(buffer, key) {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(buffer), cipher.final()]);
}

function nodeAesEcbDecrypt(buffer, key) {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(buffer), decipher.final()]);
}

test("Node AES-128-ECB and WebCrypto AES-CBC emulation produce identical decrypted payloads", async () => {
  const pathname = "/api/home/v2/coinMarkets";
  const v = "1";
  const ctx = { pathname, cacheTs: "1234567890", timeHeader: "" };

  // Generate key0
  const key0 = Buffer.from(Buffer.from(pathname, "utf8").toString("base64").slice(0, 16), "utf8");
  const actualKeyStr = "fedcba0987654321"; // 16 bytes
  const actualKey = Buffer.from(actualKeyStr, "utf8");

  // Create encrypted user header: gzip(actualKey) -> AES-128-ECB(key0)
  const gzippedKey = zlib.gzipSync(Buffer.from(actualKeyStr, "utf8"));
  const userEnc = nodeAesEcbEncrypt(gzippedKey, key0);
  const userB64 = userEnc.toString("base64");

  // Create sample CoinGlass payload
  const sampleData = {
    code: "0",
    msg: "success",
    data: {
      total: 1,
      list: [
        {
          symbol: "BTC",
          name: "Bitcoin",
          price: 65432.1,
          m5OiChangePercent: 3.14,
          h1VolChangePercent: 12.5,
          openInterest: 1000000000,
          volUsd: 5000000000,
        },
      ],
    },
  };

  // Encrypt body: gzip(JSON) -> AES-128-ECB(actualKey)
  const gzippedJson = zlib.gzipSync(Buffer.from(JSON.stringify(sampleData), "utf8"));
  const bodyEnc = nodeAesEcbEncrypt(gzippedJson, actualKey);
  const encryptedB64 = bodyEnc.toString("base64");

  // 1. Decrypt via Node.js
  const nodeActualKey = zlib.gunzipSync(nodeAesEcbDecrypt(Buffer.from(userB64, "base64"), key0)).toString("utf8");
  const nodeDecrypted = JSON.parse(
    zlib.gunzipSync(nodeAesEcbDecrypt(Buffer.from(encryptedB64, "base64"), Buffer.from(nodeActualKey, "utf8"))).toString("utf8")
  );

  // 2. Decrypt via WebCrypto (web/cg-worker.js)
  const webDecrypted = await webDecryptBody(encryptedB64, userB64, v, ctx);

  // Assert exact deep equality
  assert.deepEqual(webDecrypted, nodeDecrypted, "WebCrypto decryption must match Node decryption exactly");
  assert.equal(webDecrypted.data.list[0].symbol, "BTC");
  assert.equal(webDecrypted.data.list[0].price, 65432.1);
});
