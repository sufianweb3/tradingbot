/**
 * E2E Test Harness: Mock Backend Server, State Driver, DOM Inspector, and Assertions
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  MOCK_START_FUND,
  MOCK_SEED_COINS,
  MOCK_SEED_POSITIONS,
  MOCK_SEED_TRADES,
  MOCK_SEED_TELEMETRY,
  MOCK_SEED_EXCHANGES,
  MOCK_DEFAULT_STRATEGY,
} from "./mockData.js";

/* ------------------------------------------------------------------------- */
/* 1. In-Memory Mock Backend Server                                          */
/* ------------------------------------------------------------------------- */

export class MockBackendServer {
  constructor(options = {}) {
    this.adminSecret = options.adminSecret || "e2e-test-secret-token";
    this.port = 0;
    this.server = null;
    this.connections = new Set();
    this.state = {
      running: true,
      mode: "paper",
      killSwitch: false,
      scanCount: 142,
      coins: JSON.parse(JSON.stringify(MOCK_SEED_COINS)),
      positions: JSON.parse(JSON.stringify(MOCK_SEED_POSITIONS)),
      trades: JSON.parse(JSON.stringify(MOCK_SEED_TRADES)),
      telemetry: JSON.parse(JSON.stringify(MOCK_SEED_TELEMETRY)),
      exchanges: JSON.parse(JSON.stringify(MOCK_SEED_EXCHANGES)),
      settings: JSON.parse(JSON.stringify(MOCK_DEFAULT_STRATEGY)),
      vault: new Map(),
      wsTickets: new Set(),
      failWithdrawalCheck: true,
      injectedErrors: new Map(),
      staleFeed: false,
    };
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        try {
          await this._handleRequest(req, res);
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });

      this.server.on("connection", (socket) => {
        this.connections.add(socket);
        socket.on("close", () => this.connections.delete(socket));
      });

      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port;
        resolve(`http://127.0.0.1:${this.port}`);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      for (const socket of this.connections) {
        socket.destroy();
      }
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  get baseUrl() {
    return `http://127.0.0.1:${this.port}`;
  }

  async _readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  _sendJson(res, status, payload) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
    });
    res.end(JSON.stringify(payload));
  }

  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const pathname = url.pathname;
    const authHeader = req.headers.authorization || "";
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();

    // CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
      });
      return res.end();
    }

    // Injected error check
    if (this.state.injectedErrors.has(pathname)) {
      const err = this.state.injectedErrors.get(pathname);
      return this._sendJson(res, err.status || 500, { ok: false, error: err.message });
    }

    // Public health check
    if (pathname === "/api/health") {
      return this._sendJson(res, 200, {
        ok: true,
        serverTime: Date.now(),
        generation: "v2-e2e-suite",
        stale: this.state.staleFeed,
        running: this.state.running,
      });
    }

    // Zero-trust authentication gate for all other endpoints
    if (this.adminSecret && bearer !== this.adminSecret) {
      return this._sendJson(res, 401, {
        ok: false,
        error: "Unauthorized: Invalid or missing ADMIN_SECRET Bearer token",
      });
    }

    const body = req.method === "POST" ? await this._readBody(req) : {};

    switch (pathname) {
      case "/api/bootstrap": {
        return this._sendJson(res, 200, {
          ok: true,
          mode: this.state.mode,
          running: this.state.running,
          killSwitch: this.state.killSwitch,
          settings: this.state.settings,
          stats: this._computeStats(),
          positions: this.state.positions,
          coins: this.state.coins,
          trades: this.state.trades,
          exchanges: this.state.exchanges,
          telemetry: this.state.telemetry,
        });
      }

      case "/api/dashboard": {
        return this._sendJson(res, 200, {
          ok: true,
          stats: this._computeStats(),
          positions: this.state.positions,
          coins: this.state.coins,
          trades: this.state.trades.slice(0, 50),
          telemetry: this.state.telemetry,
          venues: this.state.exchanges,
          running: this.state.running,
          mode: this.state.mode,
          killSwitch: this.state.killSwitch,
        });
      }

      case "/api/trades": {
        const limit = Number(url.searchParams.get("limit") || 100);
        return this._sendJson(res, 200, {
          ok: true,
          trades: this.state.trades.slice(0, limit),
          total: this.state.trades.length,
        });
      }

      case "/api/exchange/status": {
        return this._sendJson(res, 200, {
          ok: true,
          exchanges: this.state.exchanges,
        });
      }

      case "/api/control": {
        const action = body.action;
        if (action === "start") this.state.running = true;
        else if (action === "pause") this.state.running = false;
        else if (action === "toggle") this.state.running = !this.state.running;
        else if (action === "reset") {
          this.state.trades = [];
          this.state.positions = [];
        } else if (action === "close-all") {
          this._closeAllPositions("API Close All");
        }
        return this._sendJson(res, 200, {
          ok: true,
          running: this.state.running,
          action,
        });
      }

      case "/api/scan": {
        this.state.scanCount += 1;
        return this._sendJson(res, 200, {
          ok: true,
          scanCount: this.state.scanCount,
          qualifiedCount: this.state.coins.filter((c) => c.status === "qualified").length,
        });
      }

      case "/api/trade/open": {
        if (this.state.killSwitch) {
          return this._sendJson(res, 400, {
            ok: false,
            error: "Trade rejected: Kill Switch is actively engaged.",
          });
        }
        const symbol = String(body.symbol || "").toUpperCase();
        const side = body.side === "short" ? "short" : "long";
        const coin = this.state.coins.find((c) => c.symbol === symbol);
        if (!coin) {
          return this._sendJson(res, 404, { ok: false, error: `Symbol ${symbol} not found.` });
        }
        const newPos = {
          id: `pos_${symbol.toLowerCase()}_${Date.now()}`,
          symbol,
          name: coin.name || symbol,
          side,
          venue: this.state.settings.live.exchange || "bybit",
          venueName: "Bybit V5 Linear",
          openedAt: Date.now(),
          entryPrice: coin.price,
          markPrice: coin.price,
          margin: 1000,
          leverage: 10,
          qty: 1.0,
          slPrice: side === "long" ? coin.price * 0.985 : coin.price * 1.015,
          tp1Price: side === "long" ? coin.price * 1.02 : coin.price * 0.98,
          tpMaxPrice: side === "long" ? coin.price * 1.04 : coin.price * 0.96,
          trailingActive: true,
          trailingStop: side === "long" ? coin.price * 0.985 : coin.price * 1.015,
          roe: 0.0,
          pnl: 0.0,
          exitHealth: { health: "LIQ OK" },
          routeSummary: { totalCostBps: 5.0 },
          spark: [coin.price],
        };
        this.state.positions.push(newPos);
        return this._sendJson(res, 200, { ok: true, position: newPos });
      }

      case "/api/trade/close": {
        const id = body.id;
        const index = this.state.positions.findIndex((p) => p.id === id);
        if (index === -1) {
          return this._sendJson(res, 404, { ok: false, error: "Position not found." });
        }
        const [pos] = this.state.positions.splice(index, 1);
        const closedTrade = {
          id: `tr_${Date.now()}`,
          symbol: pos.symbol,
          side: pos.side,
          venue: pos.venue,
          entryPrice: pos.entryPrice,
          exitPrice: pos.markPrice,
          margin: pos.margin,
          leverage: pos.leverage,
          pnlNet: pos.pnl - 5.0, // minus fee
          roe: pos.roe,
          feesPaid: 5.0,
          entryTime: pos.openedAt,
          exitTime: Date.now(),
          exitReason: body.reason || "Manual Close",
        };
        this.state.trades.unshift(closedTrade);
        return this._sendJson(res, 200, { ok: true, trade: closedTrade });
      }

      case "/api/mode": {
        const requestedMode = body.mode;
        if (requestedMode === "live") {
          if (!body.confirmed || body.confirmation !== "LIVE") {
            return this._sendJson(res, 400, {
              ok: false,
              error: "Live mode requires explicit typed confirmation 'LIVE'.",
            });
          }
          // Must have at least one connected exchange
          const hasConnected = this.state.exchanges.some((e) => e.connected);
          if (!hasConnected) {
            return this._sendJson(res, 400, {
              ok: false,
              error: "Cannot switch to Live mode without a connected and verified exchange.",
            });
          }
          this.state.mode = "live";
        } else {
          this.state.mode = "paper";
        }
        return this._sendJson(res, 200, { ok: true, mode: this.state.mode });
      }

      case "/api/kill-switch": {
        this.state.killSwitch = Boolean(body.active);
        return this._sendJson(res, 200, { ok: true, killSwitch: this.state.killSwitch });
      }

      case "/api/panic": {
        const count = this._closeAllPositions("Emergency Panic");
        this.state.killSwitch = true;
        return this._sendJson(res, 200, { ok: true, closedCount: count, killSwitch: true });
      }

      case "/api/reconcile": {
        return this._sendJson(res, 200, {
          ok: true,
          reconciled: true,
          syncedPositions: this.state.positions.length,
          timestamp: Date.now(),
        });
      }

      case "/api/settings": {
        if (body.settings && typeof body.settings === "object") {
          this.state.settings = { ...this.state.settings, ...body.settings };
        }
        return this._sendJson(res, 200, { ok: true, settings: this.state.settings });
      }

      case "/api/coinglass/key": {
        return this._sendJson(res, 200, { ok: true, configured: Boolean(body.apiKey) });
      }

      case "/api/exchange/select": {
        const venue = String(body.venue || "").toLowerCase();
        this.state.settings.live.exchange = venue;
        return this._sendJson(res, 200, { ok: true, venue });
      }

      case "/api/exchange/test": {
        const venue = String(body.venue || "").toLowerCase();
        // Withdrawal permission rejection per PRD 5.6 E3
        const hasWithdrawal =
          Boolean(body.hasWithdrawalPermission) ||
          (Array.isArray(body.permissions) &&
            body.permissions.some((p) => String(p).toLowerCase().includes("withdraw")));
        if (hasWithdrawal) {
          return this._sendJson(res, 400, {
            ok: false,
            error: "Security Violation: API key has withdrawal permissions enabled. Connect rejected.",
          });
        }
        if (!body.apiKey || !body.secret) {
          return this._sendJson(res, 400, { ok: false, error: "API key and secret are required." });
        }
        return this._sendJson(res, 200, {
          ok: true,
          balance: { availableUsdt: 12500.5, equityUsdt: 15400.0 },
          instrumentsCount: 248,
          accountMode: { oneWay: true, isolated: true },
        });
      }

      case "/api/exchange/connect": {
        const venue = String(body.venue || "").toLowerCase();
        const hasWithdrawal =
          Boolean(body.hasWithdrawalPermission) ||
          (Array.isArray(body.permissions) &&
            body.permissions.some((p) => String(p).toLowerCase().includes("withdraw")));
        if (hasWithdrawal) {
          return this._sendJson(res, 400, {
            ok: false,
            error: "Security Violation: Withdrawal permission detected. Refusing to store credentials.",
          });
        }
        const masked = `${body.apiKey.slice(0, 2)}****${body.apiKey.slice(-4)}`;
        this.state.vault.set(venue, { apiKey: body.apiKey, secret: body.secret, masked });
        const ex = this.state.exchanges.find((e) => e.id === venue);
        if (ex) {
          ex.connected = true;
          ex.balance = 12500.5;
        }
        return this._sendJson(res, 200, { ok: true, maskedKey: masked });
      }

      case "/api/exchange/disconnect": {
        const venue = String(body.venue || "").toLowerCase();
        this.state.vault.delete(venue);
        const ex = this.state.exchanges.find((e) => e.id === venue);
        if (ex) {
          ex.connected = false;
          ex.balance = 0;
        }
        return this._sendJson(res, 200, { ok: true, venue });
      }

      case "/api/backup/export": {
        const includeKeys = url.searchParams.get("includeKeys") === "true";
        const backup = {
          version: "2.0.0",
          timestamp: Date.now(),
          settings: this.state.settings,
          trades: this.state.trades,
          positions: this.state.positions,
        };
        if (includeKeys) {
          backup.vault = Array.from(this.state.vault.entries());
        }
        return this._sendJson(res, 200, {
          ok: true,
          backup,
          filename: `oi-sniper-backup-${Date.now()}.json`,
        });
      }

      case "/api/backup/import": {
        const backup = body;
        if (!backup || !backup.settings) {
          return this._sendJson(res, 400, { ok: false, error: "Invalid backup JSON structure." });
        }
        this.state.settings = backup.settings;
        if (Array.isArray(backup.trades)) this.state.trades = backup.trades;
        return this._sendJson(res, 200, { ok: true, imported: true });
      }

      case "/api/auth/ws-ticket": {
        const ticket = `wst_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
        this.state.wsTickets.add(ticket);
        return this._sendJson(res, 200, { ok: true, ticket });
      }

      default: {
        return this._sendJson(res, 404, { ok: false, error: `Route not found: ${pathname}` });
      }
    }
  }

  _computeStats() {
    let realizedPnl = 0;
    let wins = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    for (const trade of this.state.trades) {
      realizedPnl += trade.pnlNet;
      if (trade.pnlNet > 0) {
        wins += 1;
        grossProfit += trade.pnlNet;
      } else {
        grossLoss += Math.abs(trade.pnlNet);
      }
    }
    let openPnl = 0;
    for (const pos of this.state.positions) {
      openPnl += pos.pnl;
    }
    const totalTrades = this.state.trades.length;
    const winrate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;
    const equity = MOCK_START_FUND + realizedPnl + openPnl;

    return {
      initialFund: MOCK_START_FUND,
      equity,
      balance: MOCK_START_FUND + realizedPnl,
      unrealizedPnl: openPnl,
      realizedPnl,
      totalTrades,
      openTrades: this.state.positions.length,
      winrate,
      profitFactor,
      maxDrawdownPct: 4.85,
    };
  }

  _closeAllPositions(reason) {
    const closed = this.state.positions.splice(0, this.state.positions.length);
    for (const pos of closed) {
      this.state.trades.unshift({
        id: `tr_${Date.now()}_${pos.symbol}`,
        symbol: pos.symbol,
        side: pos.side,
        venue: pos.venue,
        entryPrice: pos.entryPrice,
        exitPrice: pos.markPrice,
        margin: pos.margin,
        leverage: pos.leverage,
        pnlNet: pos.pnl - 5.0,
        roe: pos.roe,
        feesPaid: 5.0,
        entryTime: pos.openedAt,
        exitTime: Date.now(),
        exitReason: reason,
      });
    }
    return closed.length;
  }
}

/* ------------------------------------------------------------------------- */
/* 2. Frontend State Driver (AppStore Simulation)                            */
/* ------------------------------------------------------------------------- */

export class FrontendStateDriver {
  constructor(initialData = {}) {
    this.initialFund = initialData.initialFund || MOCK_START_FUND;
    this.mode = initialData.mode || "paper";
    this.running = initialData.running !== undefined ? initialData.running : true;
    this.killSwitch = Boolean(initialData.killSwitch);
    this.coins = JSON.parse(JSON.stringify(initialData.coins || MOCK_SEED_COINS));
    this.positions = JSON.parse(JSON.stringify(initialData.positions || MOCK_SEED_POSITIONS));
    this.trades = JSON.parse(JSON.stringify(initialData.trades || MOCK_SEED_TRADES));
    this.telemetry = JSON.parse(JSON.stringify(initialData.telemetry || MOCK_SEED_TELEMETRY));
    this.exchanges = JSON.parse(JSON.stringify(initialData.exchanges || MOCK_SEED_EXCHANGES));
    this.strategy = JSON.parse(JSON.stringify(initialData.strategy || MOCK_DEFAULT_STRATEGY));
    this.scanCount = 10;
    this.dirtyStrategy = false;
    this.activity = [];
  }

  setMode(mode) {
    if (mode === "live") {
      const activeExchange = this.exchanges.find((e) => e.connected);
      if (!activeExchange) {
        throw new Error("Cannot switch to live mode without connected exchange.");
      }
      this.mode = "live";
    } else {
      this.mode = "paper";
    }
    this._log("INFO", `Trading mode changed to ${this.mode.toUpperCase()}`);
  }

  toggleRunning() {
    this.running = !this.running;
    this._log("INFO", `Engine ${this.running ? "resumed" : "paused"}`);
  }

  setKillSwitch(active) {
    this.killSwitch = Boolean(active);
    this._log("WARN", `Kill switch ${this.killSwitch ? "ENGAGED" : "disarmed"}`);
  }

  panicAll() {
    const count = this.positions.length;
    const closed = this.positions.splice(0, this.positions.length);
    for (const pos of closed) {
      this.trades.unshift({
        id: `tr_${Date.now()}_${pos.symbol}`,
        symbol: pos.symbol,
        side: pos.side,
        venue: pos.venue,
        entryPrice: pos.entryPrice,
        exitPrice: pos.markPrice,
        margin: pos.margin,
        leverage: pos.leverage,
        pnlNet: pos.pnl - 4.5,
        roe: pos.roe,
        feesPaid: 4.5,
        entryTime: pos.openedAt,
        exitTime: Date.now(),
        exitReason: "Emergency Panic",
      });
    }
    this.killSwitch = true;
    this._log("ALERT", `PANIC: Closed all ${count} positions and engaged kill switch`);
  }

  scanNow() {
    this.scanCount += 1;
    this._log("INFO", `Manual scan #${this.scanCount} completed`);
  }

  openTrade(coin, side = "long") {
    if (this.killSwitch) {
      throw new Error("Entry blocked: Kill switch is active.");
    }
    const profile = side === "short" ? this.strategy.profiles.short : this.strategy.profiles.long;
    if (!profile.enabled) {
      throw new Error(`Profile ${side} is disabled.`);
    }
    const pos = {
      id: `pos_${coin.symbol}_${Date.now()}`,
      symbol: coin.symbol,
      name: coin.name || coin.symbol,
      side,
      venue: this.strategy.live.exchange || "bybit",
      venueName: "Bybit V5 Linear",
      openedAt: Date.now(),
      entryPrice: coin.price,
      markPrice: coin.price,
      margin: profile.marginPerTrade,
      leverage: profile.leverage,
      qty: (profile.marginPerTrade * profile.leverage) / coin.price,
      slPrice: side === "long" ? coin.price * (1 - profile.slPercent / 100) : coin.price * (1 + profile.slPercent / 100),
      tp1Price: side === "long" ? coin.price * (1 + profile.tp1Percent / 100) : coin.price * (1 - profile.tp1Percent / 100),
      tpMaxPrice: side === "long" ? coin.price * (1 + profile.tpMaxPercent / 100) : coin.price * (1 - profile.tpMaxPercent / 100),
      trailingActive: profile.trailingEnabled,
      trailingStop: side === "long" ? coin.price * (1 - profile.slPercent / 100) : coin.price * (1 + profile.slPercent / 100),
      roe: 0.0,
      pnl: 0.0,
      exitHealth: { health: "LIQ OK" },
      routeSummary: { totalCostBps: 5.0 },
      spark: [coin.price],
    };
    this.positions.push(pos);
    this._log("INFO", `Opened ${side.toUpperCase()} ${coin.symbol} @ ${coin.price}`);
    return pos;
  }

  closePosition(id) {
    const idx = this.positions.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const [pos] = this.positions.splice(idx, 1);
    const trade = {
      id: `tr_${Date.now()}`,
      symbol: pos.symbol,
      side: pos.side,
      venue: pos.venue,
      entryPrice: pos.entryPrice,
      exitPrice: pos.markPrice,
      margin: pos.margin,
      leverage: pos.leverage,
      pnlNet: pos.pnl - 4.5,
      roe: pos.roe,
      feesPaid: 4.5,
      entryTime: pos.openedAt,
      exitTime: Date.now(),
      exitReason: "Manual Close",
    };
    this.trades.unshift(trade);
    this._log("INFO", `Closed ${pos.side.toUpperCase()} ${pos.symbol} PnL: $${trade.pnlNet.toFixed(2)}`);
    return trade;
  }

  updateMarkPrice(symbol, nextPrice) {
    for (const pos of this.positions) {
      if (pos.symbol === symbol) {
        pos.markPrice = nextPrice;
        pos.spark.push(nextPrice);
        if (pos.side === "long") {
          pos.roe = ((nextPrice - pos.entryPrice) / pos.entryPrice) * pos.leverage * 100;
          pos.pnl = (pos.margin * pos.roe) / 100;
          // Advance trailing stop higher only
          if (pos.trailingActive && nextPrice > pos.entryPrice) {
            const proposedStop = nextPrice * 0.985;
            if (proposedStop > pos.trailingStop) {
              pos.trailingStop = proposedStop;
            }
          }
        } else {
          pos.roe = ((pos.entryPrice - nextPrice) / pos.entryPrice) * pos.leverage * 100;
          pos.pnl = (pos.margin * pos.roe) / 100;
          // Advance trailing stop lower only
          if (pos.trailingActive && nextPrice < pos.entryPrice) {
            const proposedStop = nextPrice * 1.015;
            if (proposedStop < pos.trailingStop) {
              pos.trailingStop = proposedStop;
            }
          }
        }
      }
    }
  }

  get stats() {
    let realised = 0;
    let wins = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    for (const t of this.trades) {
      realised += t.pnlNet;
      if (t.pnlNet > 0) {
        wins += 1;
        grossProfit += t.pnlNet;
      } else {
        grossLoss += Math.abs(t.pnlNet);
      }
    }
    let openPnl = 0;
    let deployedMargin = 0;
    for (const p of this.positions) {
      openPnl += p.pnl;
      deployedMargin += p.margin;
    }
    const equity = this.initialFund + realised + openPnl;
    const totalTrades = this.trades.length;
    return {
      initialFund: this.initialFund,
      equity,
      realised,
      openPnl,
      deployedMargin,
      freeMargin: Math.max(0, equity - deployedMargin),
      totalTrades,
      winrate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
      maxDrawdownPct: 4.85,
    };
  }

  _log(level, msg) {
    this.activity.unshift({
      id: `act_${Date.now()}_${Math.random()}`,
      timestamp: Date.now(),
      level,
      message: msg,
    });
  }
}

/* ------------------------------------------------------------------------- */
/* 3. Execution Quality Engine & Router Calculations (FX-80, FX-82, FX-90)    */
/* ------------------------------------------------------------------------- */

export function calculateExecutionSnapshot(coin) {
  const quality = Math.max(0, Math.min(100, coin.score));
  const spreadBps = 0.7 + Math.max(0, 100 - quality) * 0.045;
  const impactBps = 1.8 + Math.max(0, 100 - quality) * 0.11;
  const oneWayBps = spreadBps / 2 + impactBps + 2.75;
  const roundTripBps = oneWayBps * 2;
  const fillRatio =
    coin.status === "qualified" ? (quality >= 85 ? 1 : 0.68) : quality >= 66 ? 0.42 : 0.18;
  const status =
    coin.status === "qualified"
      ? quality >= 85
        ? "PASS"
        : "SCALED"
      : coin.status === "near" && quality >= 66
        ? "SCALED"
        : "BLOCKED";

  const venues = Array.from(new Set([...coin.venues, "Binance", "Bybit", "Gate", "KuCoin"])).slice(0, 4);
  const routes = venues
    .map((venue, idx) => {
      const feeBps = [2.5, 2.75, 3.0, 3.5][idx % 4];
      const venueSpread = spreadBps + idx * 0.12;
      const venueImpact = impactBps + idx * 0.42;
      return {
        venue,
        feeBps,
        spreadBps: venueSpread,
        impactBps: venueImpact,
        totalBps: venueSpread / 2 + venueImpact + feeBps,
        best: false,
      };
    })
    .sort((a, b) => a.totalBps - b.totalBps);
  if (routes[0]) routes[0].best = true;

  return {
    status,
    route: routes[0]?.venue || "Bybit",
    spreadBps,
    impactBps,
    oneWayBps,
    roundTripBps,
    fillRatio,
    routes,
  };
}

export function calculateExecutionCostPreview(profile, feePercent = 0.05, slippagePercent = 0.02) {
  const leverage = profile.leverage || 10;
  const tp1 = profile.tp1Percent || 2.0;
  const roundTripFeeBps = feePercent * 2 * 100; // e.g. 0.05% * 2 = 10 bps
  const slippageBps = slippagePercent * 2 * 100; // e.g. 4 bps
  const totalCostBps = roundTripFeeBps + slippageBps; // 14 bps
  const breakevenMovePct = (totalCostBps / 100); // 0.14%
  const netEdgeMultiple = tp1 > 0 ? (tp1 / breakevenMovePct) : 0;

  return {
    roundTripCostBps: totalCostBps,
    breakevenMovePct,
    netEdgeMultiple,
  };
}

/* ------------------------------------------------------------------------- */
/* 4. DOM & CSS Contract Inspector                                           */
/* ------------------------------------------------------------------------- */

function resolveProjectRoot(customRoot) {
  if (customRoot) return customRoot;
  const cwd = path.resolve(".");
  if (fs.existsSync(path.join(cwd, "package.json")) && fs.existsSync(path.join(cwd, "dashboard"))) {
    return cwd;
  }
  if (fs.existsSync(path.join(cwd, "tradingbot/package.json"))) {
    return path.join(cwd, "tradingbot");
  }
  return cwd;
}

export class DomContractInspector {
  constructor(projectRoot) {
    this.projectRoot = resolveProjectRoot(projectRoot);
    this.cssPath = path.join(this.projectRoot, "public/styles.css");
    this.htmlPath = path.join(this.projectRoot, "public/index.html");
    this.appJsPath = path.join(this.projectRoot, "public/app.js");
    this.vercelJsonPath = path.join(this.projectRoot, "vercel.json");
    this.dashboardDir = path.join(this.projectRoot, "dashboard/src");
  }

  verifyDarkLuxuryTokens() {
    const css = fs.readFileSync(this.cssPath, "utf8");
    // Verify obsidian theme tokens
    assert.match(css, /--bg|background|#070a0f/i, "Must declare dark luxury canvas background token");
    assert.match(css, /tabular-nums/i, "Mandatory tabular-nums font feature for financial data");
  }

  verifyKpiSublines() {
    const css = fs.readFileSync(this.cssPath, "utf8");
    const kpiSubBlock = css.match(/\.kpi-sub\s*\{([^}]+)\}/);
    assert.ok(kpiSubBlock, ".kpi-sub rule must exist in styles.css");
    assert.doesNotMatch(kpiSubBlock[1], /text-overflow:\s*ellipsis/i, ".kpi-sub must not truncate with ellipsis");
  }

  verifyCoinLogoDimensions() {
    const css = fs.readFileSync(this.cssPath, "utf8");
    assert.match(css, /\.coin-logo\s*\{[^}]*width:\s*20px/i, ".coin-logo width must be 20px");
    assert.match(css, /\.coin-logo\s*\{[^}]*height:\s*20px/i, ".coin-logo height must be 20px");
    assert.match(css, /\.coin-fallback\s*\{[^}]*width:\s*20px/i, ".coin-fallback width must be 20px");
    assert.match(css, /\.coin-fallback\s*\{[^}]*height:\s*20px/i, ".coin-fallback height must be 20px");
  }

  verifyShimmerSkeleton() {
    const css = fs.readFileSync(this.cssPath, "utf8");
    assert.match(css, /shimmer|skeleton/i, "Shimmer loading mask animation must be defined");
  }

  verifyVercelDeploymentConfig() {
    assert.ok(fs.existsSync(this.vercelJsonPath), "vercel.json must exist at project root");
    const config = JSON.parse(fs.readFileSync(this.vercelJsonPath, "utf8"));
    assert.ok(config.headers || config.routes || config.outputDirectory || config.rewrites, "vercel.json must specify deployment settings");
  }
}

/* ------------------------------------------------------------------------- */
/* 5. Invariant Assertion Helpers                                            */
/* ------------------------------------------------------------------------- */

export function assertFinancialInvariants(stats) {
  const expectedEquity = stats.initialFund + stats.realizedPnl + stats.unrealizedPnl;
  assert.ok(
    Math.abs(stats.equity - expectedEquity) < 0.001,
    `Financial invariant breached: Equity (${stats.equity}) != Initial (${stats.initialFund}) + Realized (${stats.realizedPnl}) + Unrealized (${stats.unrealizedPnl})`
  );
  assert.ok(stats.equity >= 0, "Equity cannot be negative in bounded test scenario");
  if (stats.deployedMargin !== undefined) {
    assert.ok(
      stats.freeMargin >= 0,
      `Free margin (${stats.freeMargin}) cannot be negative when deployed margin is ${stats.deployedMargin}`
    );
  }
}

export function assertTrailingStopMonotonicity(stopHistory, side = "long") {
  assert.ok(stopHistory.length >= 2, "Trailing stop history must have at least 2 observations");
  for (let i = 1; i < stopHistory.length; i++) {
    const prev = stopHistory[i - 1];
    const curr = stopHistory[i];
    if (side === "long") {
      assert.ok(
        curr >= prev,
        `Long trailing stop retreated! Previous: ${prev}, Current: ${curr} (Must be monotonically non-decreasing)`
      );
    } else {
      assert.ok(
        curr <= prev,
        `Short trailing stop loosened! Previous: ${prev}, Current: ${curr} (Must be monotonically non-increasing)`
      );
    }
  }
}
