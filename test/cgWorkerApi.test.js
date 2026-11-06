import test from "node:test";
import assert from "node:assert/strict";

import { CoinGlassWorkerClient } from "../web/cg-worker.js";

const API_ROW = {
  symbol: "BTC",
  current_price: 65000,
  open_interest_change_percent_5m: 1.25,
  open_interest_change_percent_15m: 2,
  open_interest_change_percent_30m: 3,
  open_interest_change_percent_1h: 4,
  open_interest_change_percent_4h: 5,
  volume_change_percent_1h: 6,
  volume_change_percent_24h: 7,
  open_interest_change_percent_24h: 8,
  price_change_percent_5m: 0.1,
  price_change_percent_1h: 0.2,
  price_change_percent_24h: 0.3,
  open_interest_usd: 1000000,
  avg_open_interest_usd: 1000000,
  open_interest_amount: 1000000,
  open_interest_volume_ratio: 2,
  avg_volume_usd: 500000,
  avg_funding_rate_by_oi: 0.0001,
};

test("CoinGlass worker uses the documented official API endpoint and auth header", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: { ...(options.headers || {}) } });
    return new Response(JSON.stringify({ code: "0", msg: "success", data: [API_ROW] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new CoinGlassWorkerClient();
  client.setApiKey("test-key");
  const result = await client.fetchMarkets();

  assert.equal(result.coins.length, 1);
  assert.equal(result.coins[0].symbol, "BTC");
  assert.equal(result.coins[0].oi["5m"], 1.25);
  assert.equal(client.status.source, "api");
  assert.equal(client.status.stopNewEntries, false);
  assert.equal(calls.length, 1);

  const [call] = calls;
  assert.match(call.url, /\/api\/futures\/coins-markets\?/);
  assert.equal(call.headers["CG-API-KEY"], "test-key");
  assert.equal(call.headers.coinglassSecret, undefined);
});

test("CoinGlass worker falls back to scraping when the official API rejects the key", async (t) => {
  const client = new CoinGlassWorkerClient();
  client.setApiKey("bad-key");
  client._fetchViaOfficialApi = async () => {
    throw new Error("CoinGlass API HTTP 401 (check API key / plan)");
  };
  client._fetchScrape = async () => ({
    coins: [{ symbol: "ETH", oi: { "5m": 1 }, vol: { "1h": 2 } }],
    total: 1,
    pages: 1,
  });

  const result = await client.fetchMarkets();

  assert.equal(result.coins[0].symbol, "ETH");
  assert.equal(client.status.source, "scrape");
  assert.match(client.status.apiError, /401/);
  assert.equal(client.status.stopNewEntries, false);
  assert.equal(client.status.consecutiveFailures, 0);
});

test("CoinGlass worker falls back to the same-origin proxy when direct scraping is blocked", async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push(href);
    if (href.startsWith("https://capi.coinglass.com")) {
      throw new Error("Failed to fetch");
    }
    if (href.startsWith("/api/coinglass/markets")) {
      return new Response(
        JSON.stringify({
          list: [
            {
              symbol: "BTC",
              price: 65000,
              openInterest: 1000000,
              volUsd: 500000,
              m5OiChangePercent: 1.5,
              h1VolChangePercent: 2.5,
            },
          ],
          total: 1,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`unexpected url: ${href}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const client = new CoinGlassWorkerClient();
  const result = await client.fetchMarkets();

  assert.equal(result.coins.length, 1);
  assert.equal(result.coins[0].symbol, "BTC");
  assert.equal(result.coins[0].oi["5m"], 1.5);
  assert.equal(client.status.connected, true);
  assert.equal(client.status.stopNewEntries, false);
  assert.equal(client.status.lastError, null);
  assert.ok(calls.some((href) => href.startsWith("/api/coinglass/markets?page=1")));
});
