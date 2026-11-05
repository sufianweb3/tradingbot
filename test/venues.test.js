import assert from "node:assert/strict";
import test from "node:test";
import { BinanceAdapter } from "../src/venues/binance.js";
import { BybitAdapter } from "../src/venues/bybit.js";
import { GateAdapter } from "../src/venues/gate.js";
import { KuCoinAdapter } from "../src/venues/kucoin.js";
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

  const gate = createVenueAdapter("gate", { apiKey: "k", secret: "s" });
  assert.equal(gate.id, "gate");
  assert.equal(gate.capabilities().trading, true);

  const kucoin = createVenueAdapter("kucoin", { apiKey: "k", secret: "s", passphrase: "p" });
  assert.equal(kucoin.id, "kucoin");
  assert.equal(kucoin.capabilities().trading, true);

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

test("gate: validateKey REJECTS key with withdrawal permission (PRD 5.6 E3)", async () => {
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/api/v4/spot/time")) {
      return { ok: true, json: async () => ({ server_time: Date.now() }) };
    }
    if (url.includes("/api/v4/account/detail")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            user_id: 12345,
            perms: [
              { name: "futures", read_only: false },
              { name: "wallet", read_only: false }, // WITHDRAWAL ENABLED - DANGEROUS!
            ],
          }),
      };
    }
    if (url.includes("/api/v4/futures/usdt/accounts")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            user: 12345,
            currency: "USDT",
            total: "1000.00",
            available: "1000.00",
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new GateAdapter({ apiKey: "test-gate-key", secret: "test-gate-secret", fetchFn });
  const res = await adapter.validateKey();

  assert.equal(res.ok, false);
  assert.equal(res.canWithdraw, true);
  assert.ok(res.error.includes("withdrawal permissions enabled"));
  assert.ok(res.error.includes("delete this key"));
});

test("gate: validateKey succeeds when trading is enabled and withdrawal is disabled", async () => {
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/api/v4/spot/time")) {
      return { ok: true, json: async () => ({ server_time: Date.now() }) };
    }
    if (url.includes("/api/v4/account/detail")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            user_id: 12345,
            perms: [
              { name: "futures", read_only: false },
              { name: "wallet", read_only: true },
            ],
          }),
      };
    }
    if (url.includes("/api/v4/futures/usdt/accounts")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            user: 12345,
            currency: "USDT",
            total: "1500.50",
            available: "1200.25",
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new GateAdapter({ apiKey: "test-gate-key", secret: "test-gate-secret", fetchFn });
  const res = await adapter.validateKey();

  assert.equal(res.ok, true);
  assert.equal(res.canTrade, true);
  assert.equal(res.canWithdraw, false);
  assert.equal(res.accountId, "12345");
});

test("gate: getBalance parses USDT account funds correctly", async () => {
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/api/v4/futures/usdt/accounts")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            user: 12345,
            currency: "USDT",
            total: "2500.50",
            available: "2100.25",
            position_margin: "400.25",
            unrealised_pnl: "15.00",
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new GateAdapter({ apiKey: "test-gate-key", secret: "test-gate-secret", fetchFn });
  const bal = await adapter.getBalance();

  assert.equal(bal.availableUsdt, 2100.25);
  assert.equal(bal.equityUsdt, 2515.5);
  assert.equal(bal.walletUsdt, 2500.5);
});

test("gate: placeMarket submits order with correct contract size (negative for short)", async () => {
  let submittedBody = null;
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v4/futures/usdt/orders")) {
      submittedBody = JSON.parse(init.body);
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            id: 998877,
            contract: "BTC_USDT",
            size: submittedBody.size,
            price: "0",
            fill_price: "50000",
            text: submittedBody.text,
            finish_as: "filled",
            create_time: 1700000000,
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new GateAdapter({ apiKey: "test-key", secret: "test-secret", fetchFn });
  const fillShort = await adapter.placeMarket({
    symbol: "BTC_USDT",
    side: "short",
    qty: 5,
    clientId: "client_short_001",
  });

  assert.equal(submittedBody.contract, "BTC_USDT");
  assert.equal(submittedBody.size, -5); // Gate APIv4: negative size indicates short
  assert.ok(submittedBody.text.startsWith("t-"));
  assert.equal(fillShort.side, "short");
  assert.equal(fillShort.price, 50000);
  assert.equal(fillShort.qty, 5);
});

test("gate: placeStop and placeReduceLimit create orders with correct payload", async () => {
  let stopBody = null;
  let reduceBody = null;
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v4/futures/usdt/price_orders")) {
      stopBody = JSON.parse(init.body);
      return {
        ok: true,
        text: async () => JSON.stringify({ id: 111222, status: "open" }),
      };
    }
    if (url.includes("/api/v4/futures/usdt/orders")) {
      reduceBody = JSON.parse(init.body);
      return {
        ok: true,
        text: async () => JSON.stringify({ id: 333444, status: "open" }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new GateAdapter({ apiKey: "test-key", secret: "test-secret", fetchFn });

  const stop = await adapter.placeStop({
    symbol: "BTC_USDT",
    side: "long",
    qty: 1,
    triggerPrice: 65000,
    clientId: "sl_gate_1",
    closePosition: true,
  });

  assert.equal(stop.id, "111222");
  assert.equal(stopBody.trigger.rule, 2); // 2 (<=) for Long stop loss
  assert.equal(stopBody.trigger.price, "65000");
  assert.equal(stopBody.initial.close, true);

  const tp = await adapter.placeReduceLimit({
    symbol: "BTC_USDT",
    side: "long",
    qty: 2,
    price: 72000,
    clientId: "tp_gate_1",
  });

  assert.equal(tp.id, "333444");
  assert.equal(reduceBody.size, -2); // Closing long by selling
  assert.equal(reduceBody.price, "72000");
  assert.equal(reduceBody.reduce_only, true);
});

test("gate: getPositions, cancel, and cancelAll operate cleanly", async () => {
  let cancelledUrl = null;
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v4/futures/usdt/positions")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify([
            { contract: "BTC_USDT", size: 10, entry_price: "68000", mark_price: "68500", leverage: "10", unrealised_pnl: "50", liq_price: "62000" },
            { contract: "ETH_USDT", size: 0, entry_price: "0", mark_price: "3500", leverage: "10", unrealised_pnl: "0", liq_price: "0" },
          ]),
      };
    }
    if (init.method === "DELETE") {
      cancelledUrl = url;
      return { ok: true, text: async () => JSON.stringify({ label: "SUCCESS" }) };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new GateAdapter({ apiKey: "test-key", secret: "test-secret", fetchFn });
  const pos = await adapter.getPositions();
  assert.equal(pos.length, 1);
  assert.equal(pos[0].symbol, "BTC_USDT");
  assert.equal(pos[0].side, "long");
  assert.equal(pos[0].size, 10);
  assert.equal(pos[0].unrealizedPnl, 50);

  const cRes = await adapter.cancel({ orderId: "12345" });
  assert.equal(cRes.ok, true);
  assert.ok(cancelledUrl.includes("12345"));

  const caRes = await adapter.cancelAll("BTC_USDT");
  assert.equal(caRes.ok, true);
});

test("kucoin: validateKey REJECTS key with withdrawal or transfer permission (PRD 5.6 E3)", async () => {
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/api/v1/timestamp")) {
      return { ok: true, json: async () => ({ code: "200000", data: Date.now() }) };
    }
    if (url.includes("/api/v1/user/api-key")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            code: "200000",
            data: {
              apiKey: "kucoin-api-key",
              permissions: ["Futures", "Withdraw"], // WITHDRAWAL ENABLED - DANGEROUS!
            },
          }),
      };
    }
    if (url.includes("/api/v1/account-overview")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            code: "200000",
            data: { accountEquity: 1000, availableBalance: 1000, currency: "USDT" },
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });
  const res = await adapter.validateKey();

  assert.equal(res.ok, false);
  assert.equal(res.canWithdraw, true);
  assert.ok(res.error.includes("withdrawal permissions enabled"));
  assert.ok(res.error.includes("delete this key"));
});

test("kucoin: validateKey succeeds when trading is enabled and withdrawal is disabled", async () => {
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/api/v1/timestamp")) {
      return { ok: true, json: async () => ({ code: "200000", data: Date.now() }) };
    }
    if (url.includes("/api/v1/user/api-key")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            code: "200000",
            data: {
              apiKey: "kucoin-api-key",
              permissions: ["Futures"],
            },
          }),
      };
    }
    if (url.includes("/api/v1/account-overview")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            code: "200000",
            data: { accountEquity: 3200.75, availableBalance: 2800.5, currency: "USDT" },
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });
  const res = await adapter.validateKey();

  assert.equal(res.ok, true);
  assert.equal(res.canTrade, true);
  assert.equal(res.canWithdraw, false);
  assert.equal(res.accountId, "kucoin-api-key");
});

test("kucoin: getBalance parses USDT account funds correctly", async () => {
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/api/v1/account-overview")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            code: "200000",
            data: {
              accountEquity: 4500.25,
              availableBalance: 4100.0,
              marginBalance: 4500.25,
              currency: "USDT",
            },
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });
  const bal = await adapter.getBalance();

  assert.equal(bal.availableUsdt, 4100.0);
  assert.equal(bal.equityUsdt, 4500.25);
  assert.equal(bal.walletUsdt, 4500.25);
});

test("kucoin: placeMarket, setLeverage, placeStop, and placeReduceLimit submit orders", async () => {
  let marketBody = null;
  let stopBody = null;
  let reduceBody = null;

  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v1/orders")) {
      const b = JSON.parse(init.body);
      if (b.type === "market" && !b.stop) {
        marketBody = b;
        return { ok: true, text: async () => JSON.stringify({ code: "200000", data: { orderId: "k_ord_1" } }) };
      }
      if (b.stop) {
        stopBody = b;
        return { ok: true, text: async () => JSON.stringify({ code: "200000", data: { orderId: "k_stop_1" } }) };
      }
      if (b.type === "limit") {
        reduceBody = b;
        return { ok: true, text: async () => JSON.stringify({ code: "200000", data: { orderId: "k_tp_1" } }) };
      }
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });
  await adapter.setLeverage("XBTUSDTM", 25);

  const mOrder = await adapter.placeMarket({
    symbol: "XBTUSDTM",
    side: "long",
    qty: 2,
    clientId: "kc_client_1",
  });

  assert.equal(mOrder.id, "k_ord_1");
  assert.equal(marketBody.symbol, "XBTUSDTM");
  assert.equal(marketBody.side, "buy");
  assert.equal(marketBody.leverage, "25");
  assert.equal(marketBody.marginMode, "ISOLATED");

  const sOrder = await adapter.placeStop({
    symbol: "XBTUSDTM",
    side: "long",
    qty: 2,
    triggerPrice: 65000,
    clientId: "kc_sl_1",
    closePosition: true,
  });

  assert.equal(sOrder.id, "k_stop_1");
  assert.equal(stopBody.side, "sell");
  assert.equal(stopBody.stop, "down");
  assert.equal(stopBody.stopPrice, "65000");

  const rOrder = await adapter.placeReduceLimit({
    symbol: "XBTUSDTM",
    side: "long",
    qty: 1,
    price: 72000,
    clientId: "kc_tp_1",
  });

  assert.equal(rOrder.id, "k_tp_1");
  assert.equal(reduceBody.side, "sell");
  assert.equal(reduceBody.type, "limit");
  assert.equal(reduceBody.price, "72000");
  assert.equal(reduceBody.reduceOnly, true);
});

test("kucoin: getPositions, cancel, and cancelAll operate cleanly", async () => {
  let deletedUrls = [];
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v1/positions")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            code: "200000",
            data: [
              { symbol: "XBTUSDTM", isOpen: true, currentQty: 3, avgEntryPrice: 68000, markPrice: 68500, realLeverage: 20, unrealisedPnl: 150, liquidationPrice: 62000 },
              { symbol: "ETHUSDTM", isOpen: false, currentQty: 0, avgEntryPrice: 0, markPrice: 3500, realLeverage: 10, unrealisedPnl: 0, liquidationPrice: 0 },
            ],
          }),
      };
    }
    if (init.method === "DELETE") {
      deletedUrls.push(url);
      return { ok: true, text: async () => JSON.stringify({ code: "200000", data: {} }) };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });
  const pos = await adapter.getPositions();
  assert.equal(pos.length, 1);
  assert.equal(pos[0].symbol, "XBTUSDTM");
  assert.equal(pos[0].side, "long");
  assert.equal(pos[0].size, 3);
  assert.equal(pos[0].unrealizedPnl, 150);

  const cRes = await adapter.cancel({ orderId: "k_ord_999" });
  assert.equal(cRes.ok, true);
  assert.ok(deletedUrls.some((u) => u.includes("k_ord_999")));

  const caRes = await adapter.cancelAll("XBTUSDTM");
  assert.equal(caRes.ok, true);
});

