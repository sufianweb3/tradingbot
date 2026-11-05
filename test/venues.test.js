import assert from "node:assert/strict";
import test from "node:test";
import { BinanceAdapter } from "../src/venues/binance.js";
import { BybitAdapter } from "../src/venues/bybit.js";
import { createVenueAdapter } from "../src/venues/index.js";

function mockFetch(handler) {
  return async (url, options = {}) => {
    return handler(url, options);
  };
}

test("venues factory creates adapters correctly", () => {
  const binance = createVenueAdapter("binance", { apiKey: "k", secret: "s" });
  assert.equal(binance.id, "binance");
  assert.equal(binance.capabilities().trading, true);

  const bybit = createVenueAdapter("bybit", { apiKey: "k", secret: "s" });
  assert.equal(bybit.id, "bybit");
  assert.equal(bybit.capabilities().trading, true);

  assert.throws(() => createVenueAdapter("unknown_venue"), /unsupported/i);
});

test("binance: validateKey REJECTS key with withdrawal permission (PRD 5.6 E3)", async () => {
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/fapi/v1/time")) {
      return { ok: true, json: async () => ({ serverTime: Date.now() }) };
    }
    if (url.includes("/fapi/v2/account")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            canTrade: true,
            canWithdraw: true, // WITHDRAWAL ENABLED - DANGEROUS!
            feeTier: 0,
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new BinanceAdapter({ apiKey: "test-api-key", secret: "test-secret", fetchFn });
  const res = await adapter.validateKey();

  assert.equal(res.ok, false);
  assert.equal(res.canWithdraw, true);
  assert.ok(res.error.includes("withdrawal permissions enabled"));
  assert.ok(res.error.includes("delete this key"));
});

test("binance: validateKey succeeds when trading is enabled and withdrawal is disabled", async () => {
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/fapi/v1/time")) {
      return { ok: true, json: async () => ({ serverTime: Date.now() }) };
    }
    if (url.includes("/fapi/v2/account")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            canTrade: true,
            canWithdraw: false,
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new BinanceAdapter({ apiKey: "test-api-key", secret: "test-secret", fetchFn });
  const res = await adapter.validateKey();

  assert.equal(res.ok, true);
  assert.equal(res.canTrade, true);
  assert.equal(res.canWithdraw, false);
});

test("binance: getBalance parses USDT account funds", async () => {
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/fapi/v2/balance")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify([
            { asset: "BTC", balance: "0.5" },
            { asset: "USDT", balance: "1000.50", availableBalance: "850.25", crossWalletBalance: "1000.50" },
          ]),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new BinanceAdapter({ apiKey: "test-api-key", secret: "test-secret", fetchFn });
  const bal = await adapter.getBalance();

  assert.equal(bal.availableUsdt, 850.25);
  assert.equal(bal.equityUsdt, 1000.5);
});

test("bybit: validateKey REJECTS key with withdrawal permission (PRD 5.6 E3)", async () => {
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/v5/market/time")) {
      return { ok: true, json: async () => ({ time: Date.now() }) };
    }
    if (url.includes("/v5/user/query-api")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            retCode: 0,
            result: {
              permissions: {
                ContractTrade: ["Order", "Position"],
                Withdrawal: ["Withdraw"], // WITHDRAWAL ENABLED - DANGEROUS!
              },
            },
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new BybitAdapter({ apiKey: "test-key", secret: "test-secret", fetchFn });
  const res = await adapter.validateKey();

  assert.equal(res.ok, false);
  assert.equal(res.canWithdraw, true);
  assert.ok(res.error.includes("withdrawal permissions enabled"));
});

test("bybit: validateKey succeeds when trading is enabled and withdrawal is disabled", async () => {
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/v5/market/time")) {
      return { ok: true, json: async () => ({ time: Date.now() }) };
    }
    if (url.includes("/v5/user/query-api")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            retCode: 0,
            result: {
              permissions: {
                ContractTrade: ["Order", "Position"],
                Withdrawal: [],
              },
            },
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new BybitAdapter({ apiKey: "test-key", secret: "test-secret", fetchFn });
  const res = await adapter.validateKey();

  assert.equal(res.ok, true);
  assert.equal(res.canTrade, true);
  assert.equal(res.canWithdraw, false);
});

test("bybit: placeMarket attaches native stopLoss to avoid gaps (PRD 5.8 L3)", async () => {
  let submittedBody = null;
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/v5/order/create")) {
      submittedBody = JSON.parse(init.body);
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            retCode: 0,
            result: {
              orderId: "ord_12345",
              orderLinkId: submittedBody.orderLinkId,
            },
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new BybitAdapter({ apiKey: "test-key", secret: "test-secret", fetchFn });
  const fill = await adapter.placeMarket({
    symbol: "BTCUSDT",
    side: "long",
    qty: 0.05,
    clientId: "client_order_999",
    sl: 48000,
  });

  assert.equal(fill.id, "ord_12345");
  assert.equal(submittedBody.symbol, "BTCUSDT");
  assert.equal(submittedBody.side, "Buy");
  assert.equal(submittedBody.stopLoss, "48000");
  assert.equal(submittedBody.slTriggerBy, "MarkPrice");
});
