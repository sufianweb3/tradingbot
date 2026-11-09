import assert from "node:assert/strict";
import test from "node:test";
import { GateAdapter } from "../src/venues/gate.js";
import { KuCoinAdapter } from "../src/venues/kucoin.js";
import { MexcAdapter } from "../src/venues/mexc.js";

function mockFetch(handler) {
  return async (url, options = {}) => {
    return handler(url, options);
  };
}

// ============================================================================
// 1. GATE.IO ADVERSARIAL ORDER EXECUTION & LIFECYCLE
// ============================================================================

test("gate adversarial: placeMarket signed sizing handles negative input qty for short", async () => {
  let capturedBody = null;
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v4/futures/usdt/orders")) {
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            id: 101,
            contract: capturedBody.contract,
            size: capturedBody.size,
            price: "0",
            fill_price: "60000",
            text: capturedBody.text,
            create_time: 1700000000,
          }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new GateAdapter({ apiKey: "k", secret: "s", fetchFn });

  // Caller passes negative qty for short (common mistake) -> adapter must sanitize and output negative Gate size
  const resShortNeg = await adapter.placeMarket({
    symbol: "BTC_USDT",
    side: "short",
    qty: -4.5,
    clientId: "short_test_1",
  });

  assert.equal(capturedBody.size, -4.5);
  assert.equal(resShortNeg.side, "short");
  assert.equal(resShortNeg.qty, 4.5); // Normalized returned qty is always non-negative magnitude

  // Caller passes negative qty for long -> adapter must sanitize to positive
  const resLongNeg = await adapter.placeMarket({
    symbol: "BTC_USDT",
    side: "long",
    qty: -10,
    clientId: "long_test_1",
  });

  assert.equal(capturedBody.size, 10);
  assert.equal(resLongNeg.side, "long");
  assert.equal(resLongNeg.qty, 10);
});

test("gate adversarial: client order id prefixing ('t-') and length capping", async () => {
  let capturedBodies = [];
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v4/futures/usdt/orders")) {
      const b = JSON.parse(init.body);
      capturedBodies.push(b);
      return {
        ok: true,
        text: async () => JSON.stringify({ id: 200 + capturedBodies.length, contract: b.contract, size: b.size }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new GateAdapter({ apiKey: "k", secret: "s", fetchFn });

  // 1. Unprefixed ID: should get 't-' prefix
  await adapter.placeMarket({ symbol: "BTC_USDT", side: "long", qty: 1, clientId: "my_order_123" });
  assert.equal(capturedBodies[0].text, "t-my_order_123");
  assert.ok(capturedBodies[0].text.length <= 28);

  // 2. Already prefixed ID: should NOT double-prefix to 't-t-...'
  await adapter.placeMarket({ symbol: "BTC_USDT", side: "long", qty: 1, clientId: "t-already_prefixed" });
  assert.equal(capturedBodies[1].text, "t-already_prefixed");
  assert.ok(!capturedBodies[1].text.startsWith("t-t-"));

  // 3. Excessively long ID (> 28 chars): must be sliced to <= 28 chars and preserve 't-'
  const longId = "super_extra_long_client_order_id_exceeding_gate_limit_123456789";
  await adapter.placeMarket({ symbol: "BTC_USDT", side: "long", qty: 1, clientId: longId });
  assert.ok(capturedBodies[2].text.startsWith("t-"));
  assert.ok(capturedBodies[2].text.length <= 28);

  // 4. Excessively long ID that already started with 't-': must stay <= 28 chars
  const longPreId = "t-long_prefixed_client_order_id_overflowing_28_chars";
  await adapter.placeMarket({ symbol: "BTC_USDT", side: "long", qty: 1, clientId: longPreId });
  assert.ok(capturedBodies[3].text.startsWith("t-"));
  assert.ok(capturedBodies[3].text.length <= 28);
  assert.ok(!capturedBodies[3].text.startsWith("t-t-"));
});

test("gate adversarial: stop loss rule directions (long rule 2 vs short rule 1) and closePosition flag", async () => {
  let capturedStops = [];
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v4/futures/usdt/price_orders")) {
      const b = JSON.parse(init.body);
      capturedStops.push(b);
      return { ok: true, text: async () => JSON.stringify({ id: 500 + capturedStops.length }) };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new GateAdapter({ apiKey: "k", secret: "s", fetchFn });

  // Long stop loss: must trigger when price <= triggerPrice (rule 2 in Gate.io)
  const stopLong = await adapter.placeStop({
    symbol: "BTC_USDT",
    side: "long",
    qty: 2,
    triggerPrice: 62000,
    clientId: "sl_long_1",
    closePosition: true,
  });

  assert.equal(capturedStops[0].trigger.rule, 2); // rule 2: <=
  assert.equal(capturedStops[0].trigger.price, "62000");
  assert.equal(capturedStops[0].trigger.price_type, 1); // Mark price
  assert.equal(capturedStops[0].initial.size, 0); // closePosition true -> size 0
  assert.equal(capturedStops[0].initial.close, true);
  assert.equal(stopLong.side, "long");
  assert.equal(stopLong.triggerPrice, 62000);

  // Short stop loss: must trigger when price >= triggerPrice (rule 1 in Gate.io)
  const stopShort = await adapter.placeStop({
    symbol: "BTC_USDT",
    side: "short",
    qty: 2,
    triggerPrice: 71000,
    clientId: "sl_short_1",
    closePosition: true,
  });

  assert.equal(capturedStops[1].trigger.rule, 1); // rule 1: >=
  assert.equal(capturedStops[1].trigger.price, "71000");
  assert.equal(capturedStops[1].trigger.price_type, 1); // Mark price
  assert.equal(capturedStops[1].initial.size, 0);
  assert.equal(capturedStops[1].initial.close, true);
  assert.equal(stopShort.side, "short");

  // Partial stop without closing entire position (closePosition: false)
  await adapter.placeStop({
    symbol: "BTC_USDT",
    side: "long",
    qty: 1.5,
    triggerPrice: 61500,
    closePosition: false,
  });

  assert.equal(capturedStops[2].initial.close, false);
  assert.equal(capturedStops[2].initial.size, -1.5); // Selling to stop long partial
});

test("gate adversarial: closePosition handles active long, active short, partial close, and non-existent position", async () => {
  let submittedOrders = [];
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v4/futures/usdt/positions")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify([
            { contract: "BTC_USDT", size: 5, entry_price: "60000", mark_price: "61000", unrealised_pnl: "5000" },
            { contract: "ETH_USDT", size: -20, entry_price: "3000", mark_price: "2950", unrealised_pnl: "1000" },
          ]),
      };
    }
    if (url.includes("/api/v4/futures/usdt/orders")) {
      const b = JSON.parse(init.body);
      submittedOrders.push(b);
      return {
        ok: true,
        text: async () => JSON.stringify({ id: 900 + submittedOrders.length, contract: b.contract, size: b.size }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new GateAdapter({ apiKey: "k", secret: "s", fetchFn });

  // 1. Close long BTC position -> must send market short with reduce_only: true
  const closeBtc = await adapter.closePosition("BTC_USDT");
  assert.ok(closeBtc);
  assert.equal(submittedOrders[0].contract, "BTC_USDT");
  assert.equal(submittedOrders[0].size, -5); // Gate: negative size to sell
  assert.equal(submittedOrders[0].reduce_only, true);

  // 2. Close short ETH position -> must send market long with reduce_only: true
  const closeEth = await adapter.closePosition("ETH_USDT");
  assert.ok(closeEth);
  assert.equal(submittedOrders[1].contract, "ETH_USDT");
  assert.equal(submittedOrders[1].size, 20); // Gate: positive size to buy
  assert.equal(submittedOrders[1].reduce_only, true);

  // 3. Partial close of long BTC position
  await adapter.closePosition("BTC_USDT", 2);
  assert.equal(submittedOrders[2].contract, "BTC_USDT");
  assert.equal(submittedOrders[2].size, -2);
  assert.equal(submittedOrders[2].reduce_only, true);

  // 4. Non-existent position -> returns null cleanly without throw
  const nonExistent = await adapter.closePosition("SOL_USDT");
  assert.equal(nonExistent, null);
});

// ============================================================================
// 2. KUCOIN ADVERSARIAL ORDER EXECUTION & LIFECYCLE
// ============================================================================

test("kucoin adversarial: placeMarket marginMode, leverage binding, and reduceOnly", async () => {
  let submittedOrders = [];
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v1/orders")) {
      const b = JSON.parse(init.body);
      submittedOrders.push(b);
      return { ok: true, text: async () => JSON.stringify({ code: "200000", data: { orderId: `kc_${submittedOrders.length}` } }) };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });

  // 1. Set leverage per symbol
  await adapter.setLeverage("XBTUSDTM", 30);

  // 2. Place long market order
  await adapter.placeMarket({
    symbol: "XBTUSDTM",
    side: "long",
    qty: 3,
    clientId: "kc_long_1",
    reduceOnly: false,
  });

  assert.equal(submittedOrders[0].symbol, "XBTUSDTM");
  assert.equal(submittedOrders[0].side, "buy");
  assert.equal(submittedOrders[0].size, 3);
  assert.equal(submittedOrders[0].leverage, "30");
  assert.equal(submittedOrders[0].marginMode, "ISOLATED");
  assert.equal(submittedOrders[0].reduceOnly, false);
  assert.equal(submittedOrders[0].clientOid, "kc_long_1");

  // 3. Place short market order with reduceOnly
  await adapter.placeMarket({
    symbol: "ETHUSDTM",
    side: "short",
    qty: 10,
    clientId: "kc_short_reduce",
    reduceOnly: true,
  });

  assert.equal(submittedOrders[1].symbol, "ETHUSDTM");
  assert.equal(submittedOrders[1].side, "sell");
  assert.equal(submittedOrders[1].size, 10);
  assert.equal(submittedOrders[1].leverage, "10"); // Default leverage when not set
  assert.equal(submittedOrders[1].marginMode, "ISOLATED");
  assert.equal(submittedOrders[1].reduceOnly, true);
});

test("kucoin adversarial: stop loss rule directions (long stop 'down' vs short stop 'up')", async () => {
  let submittedStops = [];
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v1/orders")) {
      const b = JSON.parse(init.body);
      submittedStops.push(b);
      return { ok: true, text: async () => JSON.stringify({ code: "200000", data: { orderId: `kc_sl_${submittedStops.length}` } }) };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });

  // Long stop loss: must sell when price drops ('down')
  await adapter.placeStop({
    symbol: "XBTUSDTM",
    side: "long",
    qty: 1,
    triggerPrice: 62500,
    clientId: "kc_sl_long",
    closePosition: true,
  });

  assert.equal(submittedStops[0].side, "sell");
  assert.equal(submittedStops[0].stop, "down");
  assert.equal(submittedStops[0].stopPrice, "62500");
  assert.equal(submittedStops[0].stopPriceType, "MP");
  assert.equal(submittedStops[0].closeOrder, true);
  assert.equal(submittedStops[0].reduceOnly, true);

  // Short stop loss: must buy when price rises ('up')
  await adapter.placeStop({
    symbol: "XBTUSDTM",
    side: "short",
    qty: 1,
    triggerPrice: 71500,
    clientId: "kc_sl_short",
    closePosition: true,
  });

  assert.equal(submittedStops[1].side, "buy");
  assert.equal(submittedStops[1].stop, "up");
  assert.equal(submittedStops[1].stopPrice, "71500");
  assert.equal(submittedStops[1].stopPriceType, "MP");
  assert.equal(submittedStops[1].closeOrder, true);
  assert.equal(submittedStops[1].reduceOnly, true);
});

test("kucoin adversarial: closePosition handles active long, active short, partial close, and missing position", async () => {
  let submittedOrders = [];
  const fetchFn = mockFetch(async (url, init) => {
    if (url.includes("/api/v1/positions")) {
      return {
        ok: true,
        text: async () =>
          JSON.stringify({
            code: "200000",
            data: [
              { symbol: "XBTUSDTM", isOpen: true, currentQty: 4, avgEntryPrice: 65000, markPrice: 66000, unrealisedPnl: 4000 },
              { symbol: "ETHUSDTM", isOpen: true, currentQty: -12, avgEntryPrice: 3200, markPrice: 3100, unrealisedPnl: 1200 },
            ],
          }),
      };
    }
    if (url.includes("/api/v1/orders")) {
      const b = JSON.parse(init.body);
      submittedOrders.push(b);
      return { ok: true, text: async () => JSON.stringify({ code: "200000", data: { orderId: `close_${submittedOrders.length}` } }) };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });

  // 1. Close long XBT -> submits sell market order with reduceOnly
  const closeLong = await adapter.closePosition("XBTUSDTM");
  assert.ok(closeLong);
  assert.equal(submittedOrders[0].symbol, "XBTUSDTM");
  assert.equal(submittedOrders[0].side, "sell");
  assert.equal(submittedOrders[0].size, 4);
  assert.equal(submittedOrders[0].reduceOnly, true);

  // 2. Close short ETH -> submits buy market order with reduceOnly
  const closeShort = await adapter.closePosition("ETHUSDTM");
  assert.ok(closeShort);
  assert.equal(submittedOrders[1].symbol, "ETHUSDTM");
  assert.equal(submittedOrders[1].side, "buy");
  assert.equal(submittedOrders[1].size, 12);
  assert.equal(submittedOrders[1].reduceOnly, true);

  // 3. Partial close of long XBT (qty = 1.5)
  await adapter.closePosition("XBTUSDTM", 1.5);
  assert.equal(submittedOrders[2].symbol, "XBTUSDTM");
  assert.equal(submittedOrders[2].side, "sell");
  assert.equal(submittedOrders[2].size, 1.5);
  assert.equal(submittedOrders[2].reduceOnly, true);

  // 4. Missing position -> returns null
  const missing = await adapter.closePosition("SOLUSDTM");
  assert.equal(missing, null);
});

// ============================================================================
// 3. BALANCE PARSING: ZERO BALANCES, MALFORMED RESPONSES, FLOATING POINT PRECISION
// ============================================================================

test("gate adversarial: getBalance handles zero balances, malformed responses, and floating precision", async () => {
  let responseData = null;
  const fetchFn = mockFetch(async () => {
    return { ok: true, text: async () => JSON.stringify(responseData) };
  });
  const adapter = new GateAdapter({ apiKey: "k", secret: "s", fetchFn });

  // 1. Zero balances
  responseData = { total: "0", available: "0", unrealised_pnl: "0" };
  const balZero = await adapter.getBalance();
  assert.equal(balZero.availableUsdt, 0);
  assert.equal(balZero.equityUsdt, 0);
  assert.equal(balZero.walletUsdt, 0);

  // 2. Malformed / empty object
  responseData = {};
  const balEmpty = await adapter.getBalance();
  assert.equal(balEmpty.availableUsdt, 0);
  assert.equal(balEmpty.equityUsdt, 0);
  assert.equal(balEmpty.walletUsdt, 0);

  // 3. High precision decimals and negative unrealized PnL
  responseData = {
    total: "10500.12345678",
    available: "8500.87654321",
    unrealised_pnl: "-500.12345678",
  };
  const balPrec = await adapter.getBalance();
  assert.equal(balPrec.availableUsdt, 8500.87654321);
  assert.equal(balPrec.walletUsdt, 10500.12345678);
  assert.equal(balPrec.equityUsdt, 10000); // 10500.12345678 - 500.12345678
});

test("kucoin adversarial: getBalance handles zero balances, malformed responses, and floating precision", async () => {
  let responseData = null;
  const fetchFn = mockFetch(async () => {
    return { ok: true, text: async () => JSON.stringify({ code: "200000", data: responseData }) };
  });
  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });

  // 1. Zero balances
  responseData = { availableBalance: 0, accountEquity: 0, marginBalance: 0 };
  const balZero = await adapter.getBalance();
  assert.equal(balZero.availableUsdt, 0);
  assert.equal(balZero.equityUsdt, 0);
  assert.equal(balZero.walletUsdt, 0);

  // 2. Empty data
  responseData = {};
  const balEmpty = await adapter.getBalance();
  assert.equal(balEmpty.availableUsdt, 0);
  assert.equal(balEmpty.equityUsdt, 0);
  assert.equal(balEmpty.walletUsdt, 0);

  // 3. High precision decimals
  responseData = {
    availableBalance: 1234.56789012,
    accountEquity: 5678.12345678,
    marginBalance: 5678.12345678,
  };
  const balPrec = await adapter.getBalance();
  assert.equal(balPrec.availableUsdt, 1234.56789012);
  assert.equal(balPrec.equityUsdt, 5678.12345678);
  assert.equal(balPrec.walletUsdt, 5678.12345678);
});

// ============================================================================
// 4. POSITION NORMALIZATION: EMPTY, ACTIVE, SHORT WITH NEGATIVE SIZES, UNREALIZED PNL
// ============================================================================

test("gate adversarial: position normalization filters empty positions and normalizes short positions with negative size", async () => {
  const fetchFn = mockFetch(async () => {
    return {
      ok: true,
      text: async () =>
        JSON.stringify([
          // Inactive / zero-size positions
          { contract: "ETH_USDT", size: 0, entry_price: "0", unrealised_pnl: "0" },
          { contract: "BNB_USDT", size: "0", entry_price: "0", unrealised_pnl: "0" },
          // Active long position
          {
            contract: "BTC_USDT",
            size: "2.5",
            entry_price: "64000.5",
            mark_price: "65000.0",
            leverage: "10",
            unrealised_pnl: "2498.75",
            liq_price: "58000.0",
          },
          // Active short position (Gate uses negative size)
          {
            contract: "SOL_USDT",
            size: "-50.0",
            entry_price: "150.0",
            mark_price: "155.0",
            leverage: "5",
            unrealised_pnl: "-250.0",
            liq_price: "178.0",
          },
        ]),
    };
  });

  const adapter = new GateAdapter({ apiKey: "k", secret: "s", fetchFn });
  const positions = await adapter.getPositions();

  assert.equal(positions.length, 2);

  // Verify Long
  const btcPos = positions.find((p) => p.symbol === "BTC_USDT");
  assert.ok(btcPos);
  assert.equal(btcPos.side, "long");
  assert.equal(btcPos.size, 2.5);
  assert.equal(btcPos.entryPrice, 64000.5);
  assert.equal(btcPos.unrealizedPnl, 2498.75);

  // Verify Short
  const solPos = positions.find((p) => p.symbol === "SOL_USDT");
  assert.ok(solPos);
  assert.equal(solPos.side, "short");
  assert.equal(solPos.size, 50.0); // Normalized magnitude must be positive
  assert.equal(solPos.entryPrice, 150.0);
  assert.equal(solPos.unrealizedPnl, -250.0); // PnL sign preserved
});

test("kucoin adversarial: position normalization filters empty positions and normalizes short positions with negative size", async () => {
  const fetchFn = mockFetch(async () => {
    return {
      ok: true,
      text: async () =>
        JSON.stringify({
          code: "200000",
          data: [
            // Closed / inactive positions
            { symbol: "ETHUSDTM", isOpen: false, currentQty: 0, avgEntryPrice: 0, unrealisedPnl: 0 },
            // Active long
            {
              symbol: "XBTUSDTM",
              isOpen: true,
              currentQty: 1.5,
              avgEntryPrice: 65000,
              markPrice: 66000,
              realLeverage: 20,
              unrealisedPnl: 1500,
              liquidationPrice: 62000,
            },
            // Active short (KuCoin uses negative currentQty)
            {
              symbol: "SOLUSDTM",
              isOpen: true,
              currentQty: -40,
              avgEntryPrice: 160,
              markPrice: 155,
              realLeverage: 10,
              unrealisedPnl: 200,
              liquidationPrice: 175,
            },
          ],
        }),
    };
  });

  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });
  const positions = await adapter.getPositions();

  assert.equal(positions.length, 2);

  // Long
  const btcPos = positions.find((p) => p.symbol === "XBTUSDTM");
  assert.ok(btcPos);
  assert.equal(btcPos.side, "long");
  assert.equal(btcPos.size, 1.5);
  assert.equal(btcPos.unrealizedPnl, 1500);

  // Short
  const solPos = positions.find((p) => p.symbol === "SOLUSDTM");
  assert.ok(solPos);
  assert.equal(solPos.side, "short");
  assert.equal(solPos.size, 40); // Magnitude must be positive
  assert.equal(solPos.unrealizedPnl, 200);
});

// ============================================================================
// 5. ERROR HANDLING: 400, 401, 429, API ERROR CODES, MALFORMED HTML
// ============================================================================

test("gate adversarial: error handling across HTTP 400, 401, 429, and 502 HTML", async () => {
  let mockStatus = 400;
  let mockResponse = {};

  const fetchFn = mockFetch(async () => {
    return {
      ok: mockStatus >= 200 && mockStatus < 300,
      status: mockStatus,
      statusText: `Status ${mockStatus}`,
      text: async () => (typeof mockResponse === "string" ? mockResponse : JSON.stringify(mockResponse)),
    };
  });

  const adapter = new GateAdapter({ apiKey: "k", secret: "s", fetchFn });

  // 1. HTTP 400 with Gate error label and message
  mockStatus = 400;
  mockResponse = { label: "INVALID_PARAM", message: "contract does not exist" };
  await assert.rejects(
    async () => adapter.getBalance(),
    /Gate\.io API error \(400\): contract does not exist/
  );

  // 2. HTTP 401 Unauthorized
  mockStatus = 401;
  mockResponse = { label: "INVALID_KEY", message: "invalid key or signature" };
  await assert.rejects(
    async () => adapter.getBalance(),
    /Gate\.io API error \(401\): invalid key or signature/
  );

  // 3. HTTP 429 Rate Limited
  mockStatus = 429;
  mockResponse = { label: "TOO_MANY_REQUESTS", message: "rate limit exceeded" };
  await assert.rejects(
    async () => adapter.getBalance(),
    /Gate\.io API error \(429\): rate limit exceeded/
  );

  // 4. HTTP 502 Bad Gateway with raw HTML text
  mockStatus = 502;
  mockResponse = "<html><body>502 Bad Gateway</body></html>";
  await assert.rejects(
    async () => adapter.getBalance(),
    /Gate\.io API error \(502\): Status 502/
  );
});

test("kucoin adversarial: error handling across HTTP 200 with error code, 400, 401, 429, and 500 HTML", async () => {
  let mockStatus = 200;
  let mockResponse = {};

  const fetchFn = mockFetch(async () => {
    return {
      ok: mockStatus >= 200 && mockStatus < 300,
      status: mockStatus,
      statusText: `Status ${mockStatus}`,
      text: async () => (typeof mockResponse === "string" ? mockResponse : JSON.stringify(mockResponse)),
    };
  });

  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });

  // 1. HTTP 200 with KuCoin inner error code (e.g. 400100 Invalid API Key)
  mockStatus = 200;
  mockResponse = { code: "400100", msg: "Invalid API-KEY" };
  await assert.rejects(
    async () => adapter.getBalance(),
    /KuCoin API error \(400100\): Invalid API-KEY/
  );

  // 2. HTTP 400 with insufficient balance
  mockStatus = 400;
  mockResponse = { code: "200001", msg: "Insufficient balance" };
  await assert.rejects(
    async () => adapter.getBalance(),
    /KuCoin API error \(200001\): Insufficient balance/
  );

  // 3. HTTP 401 Unauthorized
  mockStatus = 401;
  mockResponse = { code: "400001", msg: "Unauthorized" };
  await assert.rejects(
    async () => adapter.getBalance(),
    /KuCoin API error \(400001\): Unauthorized/
  );

  // 4. HTTP 429 Rate limit
  mockStatus = 429;
  mockResponse = { code: "429000", msg: "Too many requests" };
  await assert.rejects(
    async () => adapter.getBalance(),
    /KuCoin API error \(429000\): Too many requests/
  );

  // 5. HTTP 500 with raw HTML text
  mockStatus = 500;
  mockResponse = "<html>Internal Server Error</html>";
  await assert.rejects(
    async () => adapter.getBalance(),
    /KuCoin API error \(500\): Status 500/
  );
});

// ============================================================================
// 6. PRD 5.6 E3 SECURITY INVARIANT ADVERSARIAL COMBINATIONS
// ============================================================================

test("gate adversarial: validateKey security invariant thoroughly catches withdrawal variations", async () => {
  let keyInfoResponse = {};
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/api/v4/spot/time")) return { ok: true, json: async () => ({ server_time: Date.now() }) };
    if (url.includes("/api/v4/account/detail")) return { ok: true, text: async () => JSON.stringify(keyInfoResponse) };
    if (url.includes("/api/v4/futures/usdt/accounts")) return { ok: true, text: async () => JSON.stringify({ user: 123 }) };
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new GateAdapter({ apiKey: "k", secret: "s", fetchFn });

  // 1. Boolean can_withdraw: true
  keyInfoResponse = { can_withdraw: true };
  const res1 = await adapter.validateKey();
  assert.equal(res1.ok, false);
  assert.equal(res1.canWithdraw, true);

  // 2. Boolean enable_withdrawals: true
  keyInfoResponse = { enable_withdrawals: true };
  const res2 = await adapter.validateKey();
  assert.equal(res2.ok, false);
  assert.equal(res2.canWithdraw, true);

  // 3. Perms array with explicit withdraw permission
  keyInfoResponse = { perms: [{ name: "spot_withdraw", read_only: false }] };
  const res3 = await adapter.validateKey();
  assert.equal(res3.ok, false);
  assert.equal(res3.canWithdraw, true);

  // 4. Perms array with futures read-only (cannot trade)
  keyInfoResponse = { perms: [{ name: "futures", read_only: true }] };
  const res4 = await adapter.validateKey();
  assert.equal(res4.ok, false);
  assert.equal(res4.canTrade, false);
  assert.ok(res4.error.includes("Futures Trading permissions"));
});

test("kucoin adversarial: validateKey security invariant thoroughly catches withdrawal & transfer variations", async () => {
  let keyInfoResponse = {};
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/api/v1/timestamp")) return { ok: true, json: async () => ({ code: "200000", data: Date.now() }) };
    if (url.includes("/api/v1/user/api-key")) return { ok: true, text: async () => JSON.stringify({ code: "200000", data: keyInfoResponse }) };
    if (url.includes("/api/v1/account-overview")) return { ok: true, text: async () => JSON.stringify({ code: "200000", data: { accountEquity: 100 } }) };
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new KuCoinAdapter({ apiKey: "k", secret: "s", passphrase: "p", fetchFn });

  // 1. Array containing 'Transfer'
  keyInfoResponse = { permissions: ["Futures", "Transfer"] };
  const res1 = await adapter.validateKey();
  assert.equal(res1.ok, false);
  assert.equal(res1.canWithdraw, true);

  // 2. Comma string containing 'withdraw'
  keyInfoResponse = { permission: "General,Trade,Withdraw" };
  const res2 = await adapter.validateKey();
  assert.equal(res2.ok, false);
  assert.equal(res2.canWithdraw, true);

  // 3. Missing futures trading permission
  keyInfoResponse = { permissions: ["Spot"] };
  const res3 = await adapter.validateKey();
  assert.equal(res3.ok, false);
  assert.equal(res3.canTrade, false);
  assert.ok(res3.error.includes("Futures Trading permissions"));
});

// ============================================================================
// 7. MEXC ADVERSARIAL SECURITY & LIFECYCLE (MILESTONE M5)
// ============================================================================

test("mexc adversarial: validateKey security invariant thoroughly catches withdrawal & transfer variations", async () => {
  let keyInfoResponse = {};
  let assetsResponse = [{ currency: "USDT", availableBalance: 100, equity: 100 }];

  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/api/v1/contract/ping")) return { ok: true, json: async () => ({ success: true, code: 0, data: Date.now() }) };
    if (url.includes("/api/v1/private/account/api_key_info")) {
      return { ok: true, text: async () => JSON.stringify({ success: true, code: 0, data: keyInfoResponse }) };
    }
    if (url.includes("/api/v1/private/account/assets")) {
      return { ok: true, text: async () => JSON.stringify({ success: true, code: 0, data: assetsResponse }) };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new MexcAdapter({ apiKey: "k", secret: "s", fetchFn });

  // 1. Stringified boolean 'can_withdraw: "TRUE"'
  keyInfoResponse = { can_withdraw: "TRUE" };
  const res1 = await adapter.validateKey();
  assert.equal(res1.ok, false);
  assert.equal(res1.canWithdraw, true);
  assert.ok(res1.error.includes("withdrawal permissions enabled"));

  // 2. Numeric flag 'transfer: 1'
  keyInfoResponse = { transfer: 1 };
  const res2 = await adapter.validateKey();
  assert.equal(res2.ok, false);
  assert.equal(res2.canWithdraw, true);

  // 3. Comma-delimited list 'permissions: "SPOT,FUTURES,WITHDRAWAL"'
  keyInfoResponse = { permissions: "SPOT,FUTURES,WITHDRAWAL" };
  const res3 = await adapter.validateKey();
  assert.equal(res3.ok, false);
  assert.equal(res3.canWithdraw, true);

  // 4. Array of tokens '["FUTURES", "WITHDRAW"]'
  keyInfoResponse = { permissions: ["FUTURES", "WITHDRAW"] };
  const res4 = await adapter.validateKey();
  assert.equal(res4.ok, false);
  assert.equal(res4.canWithdraw, true);

  // 5. Array of objects with non-read-only withdraw
  keyInfoResponse = { perms: [{ name: "withdraw", read_only: false }] };
  const res5 = await adapter.validateKey();
  assert.equal(res5.ok, false);
  assert.equal(res5.canWithdraw, true);

  // 6. Array of objects with wallet non-read-only
  keyInfoResponse = { perms: [{ name: "wallet", read_only: false }] };
  const res6 = await adapter.validateKey();
  assert.equal(res6.ok, false);
  assert.equal(res6.canWithdraw, true);

  // 7. Nested dictionary '{ permissions: { withdraw: true } }'
  keyInfoResponse = { permissions: { withdraw: true } };
  const res7 = await adapter.validateKey();
  assert.equal(res7.ok, false);
  assert.equal(res7.canWithdraw, true);

  // 8. Nested dictionary '{ perms: { transfer: 1 } }'
  keyInfoResponse = { perms: { transfer: 1 } };
  const res8 = await adapter.validateKey();
  assert.equal(res8.ok, false);
  assert.equal(res8.canWithdraw, true);

  // 9. Sneaky withdrawal in assets response
  keyInfoResponse = { permissions: ["FUTURES"] };
  assetsResponse = { canWithdraw: true, assets: [{ currency: "USDT", availableBalance: 100 }] };
  const res9 = await adapter.validateKey();
  assert.equal(res9.ok, false);
  assert.equal(res9.canWithdraw, true);
  assetsResponse = [{ currency: "USDT", availableBalance: 100, equity: 100 }];

  // 10. Missing futures trading permission
  keyInfoResponse = { permissions: ["SPOT"] };
  const res10 = await adapter.validateKey();
  assert.equal(res10.ok, false);
  assert.equal(res10.canTrade, false);
  assert.ok(res10.error.includes("Futures Trading permissions"));
});

test("mexc adversarial: getBalance handles zero balances, malformed responses, and floating precision", async () => {
  let mockAssets = [];
  const fetchFn = mockFetch(async (url) => {
    if (url.includes("/api/v1/private/account/assets")) {
      return {
        ok: true,
        text: async () => JSON.stringify({ success: true, code: 0, data: mockAssets }),
      };
    }
    throw new Error(`Unexpected url: ${url}`);
  });

  const adapter = new MexcAdapter({ apiKey: "k", secret: "s", fetchFn });

  // 1. Empty assets array
  mockAssets = [];
  const b1 = await adapter.getBalance();
  assert.equal(b1.availableUsdt, 0);
  assert.equal(b1.equityUsdt, 0);
  assert.equal(b1.walletUsdt, 0);

  // 2. High floating precision strings
  mockAssets = [
    {
      currency: "USDT",
      availableBalance: "1234.56789012",
      equity: "2345.67890123",
      cashBalance: "1234.56789012",
    },
  ];
  const b2 = await adapter.getBalance();
  assert.equal(b2.availableUsdt, 1234.56789012);
  assert.equal(b2.equityUsdt, 2345.67890123);
  assert.equal(b2.walletUsdt, 1234.56789012);
});

test("mexc adversarial: error handling across HTTP 200 with error code, 400, 401, 429, and 503 HTML", async () => {
  let mockStatus = 200;
  let mockResponse = {};

  const fetchFn = mockFetch(async () => {
    return {
      ok: mockStatus >= 200 && mockStatus < 300,
      status: mockStatus,
      statusText: `Status ${mockStatus}`,
      text: async () => (typeof mockResponse === "string" ? mockResponse : JSON.stringify(mockResponse)),
    };
  });

  const adapter = new MexcAdapter({ apiKey: "k", secret: "s", fetchFn });

  // 1. HTTP 200 with MEXC business error code
  mockStatus = 200;
  mockResponse = { success: false, code: 2001, message: "System busy" };
  await assert.rejects(
    async () => adapter.getBalance(),
    /System busy/
  );

  // 2. HTTP 400 Bad Request
  mockStatus = 400;
  mockResponse = { code: 400, message: "Invalid parameters" };
  await assert.rejects(
    async () => adapter.getBalance(),
    /MEXC API error \(400\): Invalid parameters/
  );

  // 3. HTTP 401 Unauthorized
  mockStatus = 401;
  mockResponse = { code: 401, message: "Signature error" };
  await assert.rejects(
    async () => adapter.getBalance(),
    /MEXC API error \(401\): Signature error/
  );

  // 4. HTTP 429 Rate limit
  mockStatus = 429;
  mockResponse = { code: 429, message: "Too many requests" };
  await assert.rejects(
    async () => adapter.getBalance(),
    /MEXC API error \(429\): Too many requests/
  );

  // 5. HTTP 503 HTML maintenance page
  mockStatus = 503;
  mockResponse = "<html><body>503 Service Temporarily Unavailable</body></html>";
  await assert.rejects(
    async () => adapter.getBalance(),
    /MEXC API error \(503\): Status 503/
  );
});

