import test from "node:test";
import assert from "node:assert/strict";

import { fetchTopMarkets, fetchCoinMarkets } from "../public/cg-browser.js";

const ROW = {
  symbol: "BTC",
  price: 65000,
  openInterest: 1000000,
  volUsd: 500000,
  m5OiChangePercent: 1.5,
  h1VolChangePercent: 2.5,
};

function mockCoinGlass(t) {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (href.startsWith("https://capi.coinglass.com")) {
      throw new Error("Failed to fetch");
    }
    if (href.startsWith("/api/coinglass/markets")) {
      return new Response(JSON.stringify({ list: [ROW], total: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected url: ${href}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return calls;
}

test("device feed uses the same-origin proxy when CoinGlass is blocked", async (t) => {
  const calls = mockCoinGlass(t);
  const result = await fetchTopMarkets();

  assert.equal(result.coins.length, 1);
  assert.equal(result.coins[0].symbol, "BTC");
  assert.equal(result.coins[0].oi["5m"], 1.5);
  assert.ok(calls.some((href) => href.startsWith("/api/coinglass/markets?page=1")));
});

test("full feed uses the same-origin proxy when CoinGlass is blocked", async (t) => {
  const calls = mockCoinGlass(t);
  const result = await fetchCoinMarkets();

  assert.equal(result.coins.length, 1);
  assert.equal(result.coins[0].symbol, "BTC");
  assert.equal(result.coins[0].vol["1h"], 2.5);
  assert.ok(calls.some((href) => href.startsWith("/api/coinglass/markets?page=1")));
});
