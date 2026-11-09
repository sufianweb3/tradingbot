import test from "node:test";
import assert from "node:assert/strict";

import { normaliseCoin, normaliseApiCoin } from "../src/coinglass.js";
import { buildChecks, evaluateCoin } from "../src/trading.js";
import { normalizeSettings, DEFAULT_SETTINGS } from "../src/store.js";

test("normaliseCoin maps m5PriceChangePercent to priceChange5m and priceChange['5m']", () => {
  const rawScrape = {
    symbol: "BTC",
    coinName: "Bitcoin",
    price: "65000.5",
    openInterest: "12345678",
    volUsd: "98765432",
    m5PriceChangePercent: "2.45",
    h1PriceChangePercent: "5.10",
    h4PriceChangePercent: "-1.20",
    h24PriceChangePercent: "3.75",
    m5OiChangePercent: "1.5",
    h1OiChangePercent: "3.2",
    h4OiChangePercent: "4.8",
    h24OiChangePercent: "7.1",
    m5VolChangePercent: "10.5",
    h1VolChangePercent: "22.3",
    h4VolChangePercent: "15.0",
    h24VolChangePercent: "50.2",
  };

  const coin = normaliseCoin(rawScrape);
  assert.equal(coin.priceChange5m, 2.45);
  assert.equal(coin.priceChange1h, 5.10);
  assert.equal(coin.priceChange["5m"], 2.45);
  assert.equal(coin.priceChange["1h"], 5.10);
});

test("normaliseApiCoin maps price_change_percent_5m to priceChange5m and priceChange['5m']", () => {
  const rawApi = {
    symbol: "ETH",
    coin_name: "Ethereum",
    price: 3500.25,
    open_interest: 8500000,
    vol_usd: 45000000,
    price_change_percent_5m: -1.75,
    price_change_percent_1h: 0.85,
    price_change_percent_4h: -3.40,
    price_change_percent_24h: 4.10,
    oi_change_percent_5m: 0.8,
    oi_change_percent_1h: 1.5,
    oi_change_percent_4h: -2.1,
    oi_change_percent_24h: 6.0,
    vol_change_percent_5m: -5.0,
    vol_change_percent_1h: 12.0,
    vol_change_percent_4h: 8.5,
    vol_change_percent_24h: 30.0,
  };

  const coin = normaliseApiCoin(rawApi);
  assert.equal(coin.priceChange5m, -1.75);
  assert.equal(coin.priceChange1h, 0.85);
  assert.equal(coin.priceChange["5m"], -1.75);
  assert.equal(coin.priceChange["1h"], 0.85);
});

test("buildChecks correctly checks 5m and 1h price filters with >= and <=", () => {
  const coin = {
    symbol: "SOL",
    price: 150,
    priceChange5m: 1.8,
    priceChange1h: -0.9,
    priceChange: { "5m": 1.8, "1h": -0.9 },
  };

  const settingsPassing = {
    priceFilters: [
      { key: "5m", enabled: true, op: ">=", threshold: 1.0 },
      { key: "1h", enabled: true, op: "<=", threshold: 0.0 },
    ],
  };

  const checksPass = buildChecks(coin, settingsPassing);
  assert.equal(checksPass.length, 2);
  assert.equal(checksPass[0].key, "5m");
  assert.equal(checksPass[0].pass, true);
  assert.equal(checksPass[1].key, "1h");
  assert.equal(checksPass[1].pass, true);

  const settingsFailing = {
    priceFilters: [
      { key: "5m", enabled: true, op: ">=", threshold: 2.5 },
      { key: "1h", enabled: true, op: "<=", threshold: -1.5 },
    ],
  };

  const checksFail = buildChecks(coin, settingsFailing);
  assert.equal(checksFail.length, 2);
  assert.equal(checksFail[0].pass, false);
  assert.equal(checksFail[1].pass, false);
});

test("evaluateCoin enforces 5m and 1h price change thresholds in Long profile", () => {
  const coinPass = {
    symbol: "BTC",
    price: 60000,
    oi: { "5m": 2.5, "1h": 5.0 },
    vol: { "1h": 15 },
    priceChange5m: 1.2,
    priceChange1h: 3.5,
  };

  const coinFail = {
    symbol: "BTC",
    price: 60000,
    oi: { "5m": 2.5, "1h": 5.0 },
    vol: { "1h": 15 },
    priceChange5m: 0.4, // Fails >= 1.0 threshold
    priceChange1h: 3.5,
  };

  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    minOiUsd: 0,
    minVolUsd: 0,
    profiles: {
      long: {
        enabled: true,
        oiFilters: [{ key: "5m", enabled: true, op: ">=", threshold: 2.0 }],
        volFilters: [],
        priceFilters: [
          { key: "5m", enabled: true, op: ">=", threshold: 1.0 },
          { key: "1h", enabled: true, op: ">=", threshold: 2.0 },
        ],
      },
      short: { enabled: false },
    },
  });

  const evalPass = evaluateCoin(coinPass, settings);
  assert.equal(evalPass.qualified, true);
  assert.equal(evalPass.side, "long");

  const evalFail = evaluateCoin(coinFail, settings);
  assert.equal(evalFail.qualified, false);
  const failedCheck = evalFail.checks.find((c) => c.key === "5m" && c.group === "price");
  assert.ok(failedCheck, "Must have price 5m check in checks list");
  assert.equal(failedCheck.pass, false);
});

test("evaluateCoin enforces 5m and 1h price change thresholds in Short profile", () => {
  const coinPass = {
    symbol: "ETH",
    price: 3000,
    oi: { "5m": -2.5, "1h": -5.0 },
    vol: { "1h": 15 },
    priceChange5m: -1.5,
    priceChange1h: -4.0,
  };

  const coinFail = {
    symbol: "ETH",
    price: 3000,
    oi: { "5m": -2.5, "1h": -5.0 },
    vol: { "1h": 15 },
    priceChange5m: -0.2, // Fails <= -1.0 threshold
    priceChange1h: -4.0,
  };

  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    minOiUsd: 0,
    minVolUsd: 0,
    profiles: {
      long: { enabled: false },
      short: {
        enabled: true,
        oiFilters: [{ key: "5m", enabled: true, op: "<=", threshold: -2.0 }],
        volFilters: [],
        priceFilters: [
          { key: "5m", enabled: true, op: "<=", threshold: -1.0 },
          { key: "1h", enabled: true, op: "<=", threshold: -2.0 },
        ],
      },
    },
  });

  const evalPass = evaluateCoin(coinPass, settings);
  assert.equal(evalPass.qualified, true);
  assert.equal(evalPass.side, "short");

  const evalFail = evaluateCoin(coinFail, settings);
  assert.equal(evalFail.qualified, false);
  const failedCheck = evalFail.checks.find((c) => c.key === "5m" && c.group === "price");
  assert.ok(failedCheck);
  assert.equal(failedCheck.pass, false);
});
