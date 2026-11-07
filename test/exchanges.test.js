/**
 * Shared exchange hub behaviour used by the multi-strategy portfolio.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ExchangeHub, VENUES } from "../src/exchanges.js";

function entry(venue, base, volUsd = 1) {
  return {
    venue,
    venueName: VENUES[venue]?.name || venue,
    base,
    symbol: `${base}USDT`,
    venueSymbol: `${base}USDT`,
    price: 100,
    volUsd,
    discoveredAt: Date.now(),
  };
}

test("resolve honours each strategy's own venue list", () => {
  const hub = new ExchangeHub({ venueKeys: ["okx", "mexc", "gate"] });
  const okx = entry("okx", "BTC", 10);
  const mexc = entry("mexc", "BTC", 100);
  hub.maps.set("okx", new Map([["BTC", okx]]));
  hub.maps.set("mexc", new Map([["BTC", mexc]]));
  hub.maps.set("gate", new Map());
  hub.best.set("BTC", mexc);

  assert.equal(hub.resolve("BTC", ["okx"]).venue, "okx");
  assert.equal(hub.resolve("BTC", ["mexc"]).venue, "mexc");
  assert.equal(hub.resolve("BTC", ["gate"]), null, "a disabled venue cannot leak in");
  assert.equal(hub.resolve("BTC", ["gate", "okx"]).venue, "okx");
  assert.equal(hub.resolve("BTC").venue, "mexc", "no filter keeps the global best");
});

test("concurrent quotes for the same instrument share one request", async () => {
  const original = VENUES.okx.fetchOne;
  let calls = 0;
  VENUES.okx.fetchOne = async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return 42;
  };
  try {
    const hub = new ExchangeHub({ venueKeys: ["okx"] });
    const btc = entry("okx", "BTC");
    const [a, b] = await Promise.all([
      hub.quote(btc, { venueKeys: ["okx"] }),
      hub.quote(btc, { venueKeys: ["okx"] }),
    ]);
    assert.equal(calls, 1, "two strategies holding BTC must not double the quote");
    assert.equal(a.price, 42);
    assert.equal(b.price, 42);
  } finally {
    VENUES.okx.fetchOne = original;
  }
});
