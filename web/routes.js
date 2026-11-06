/**
 * RPC Route Handlers for Web Worker Strategy Engine
 *
 * Implements the full /api/* REST endpoint contract for the browser-hosted runtime.
 */

import { renderCsv, renderJson, renderReport } from "../src/report.js";
import { now } from "../src/util.js";
import {
  saveCredentials,
  getCredentials,
  removeCredentials,
  listVaultEntries,
  maskKey,
} from "../src/vault.js";
import { createVenueAdapter, SUPPORTED_VENUES } from "../src/venues/index.js";

export const APP_VERSION = "2.0.0";
export const ENGINE_GENERATION = `v2-web-${APP_VERSION}`;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export async function handleRpcRequest({ path, method = "GET", body = {}, query = {} }, { engine, store, cgClient, bootedAt }) {
  const pathname = path.split("?")[0];

  switch (pathname) {
    case "/api/health": {
      const cg = engine.getMarketStatus();
      const cgStale = cgClient ? cgClient.isStale() : false;
      const stopEntries = cgClient ? cgClient.status.stopNewEntries : false;
      return {
        status: 200,
        data: {
          ok: true,
          serverTime: now(),
          generation: ENGINE_GENERATION,
          running: Boolean(engine.state.meta.running),
          positions: engine.state.positions.length,
          trades: engine.state.trades.length,
          uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
          coinglass: cg.state,
          coinglassConnected: cg.connected && !cgStale,
          coinglassStale: cgStale,
          stopNewEntries: stopEntries,
          coinglassCoins: cg.coins,
          coinglassSource: cg.source,
          coinglassApiKeySet: cg.apiKeySet,
          fallbackMode: Boolean(store.fallbackMode),
        },
      };
    }

    case "/api/bootstrap": {
      return {
        status: 200,
        data: {
          ok: true,
          version: APP_VERSION,
          generation: ENGINE_GENERATION,
          ...engine.getBootstrap(),
          fallbackMode: Boolean(store.fallbackMode),
        },
      };
    }

    case "/api/live": {
      return {
        status: 200,
        data: {
          ok: true,
          ...engine.getLive(),
        },
      };
    }

    case "/api/dashboard": {
      if (!engine.marketCache.coins.length) {
        try {
          await engine.refreshMarketsIfStale();
        } catch {
          /* serve empty cache */
        }
      }
      const live = engine.getLive();
      return {
        status: 200,
        data: {
          ok: true,
          serverTime: now(),
          ...live,
          markets: engine.getMarketRows(),
          meta: engine.getMeta(),
          venues: engine.hub ? engine.hub.summary() : null,
          stats: engine.getStats(),
          coinglassStale: cgClient ? cgClient.isStale() : false,
          stopNewEntries: cgClient ? cgClient.status.stopNewEntries : false,
        },
      };
    }

    case "/api/markets": {
      return {
        status: 200,
        data: {
          ok: true,
          markets: engine.getMarketRows(),
        },
      };
    }

    case "/api/config": {
      return {
        status: 200,
        data: {
          ok: true,
          ...engine.getConfig(),
        },
      };
    }

    case "/api/trades": {
      const page = Math.max(1, Number(query.page) || 1);
      const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
      const all = engine.state.trades || [];
      const total = all.length;
      const start = (page - 1) * limit;
      const slice = all.slice(Math.max(0, total - start - limit), Math.max(0, total - start)).reverse();
      return {
        status: 200,
        data: {
          ok: true,
          trades: slice,
          total,
          page,
          pages: Math.max(1, Math.ceil(total / limit)),
        },
      };
    }

    case "/api/logs": {
      const records = [
        {
          record: "snapshot",
          timestamp: now(),
          uptimeSec: Math.round((Date.now() - bootedAt) / 1000),
          stats: engine.getStats(),
          meta: engine.getMeta(),
        },
      ];
      for (const entry of engine.state.logs || []) {
        records.push({ record: "log", ...entry });
      }
      const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
      return {
        status: 200,
        data: {
          ok: true,
          content,
          filename: `oi-bot-logs-${stamp()}.jsonl`,
        },
      };
    }

    case "/api/report": {
      const format = String(query.format || "html").toLowerCase();
      const reportData = engine.getReportData();
      const base = `oi-sniper-report-${stamp()}`;
      if (format === "csv") {
        return {
          status: 200,
          data: { ok: true, format: "csv", content: renderCsv(reportData), filename: `${base}.csv` },
        };
      }
      if (format === "json") {
        return {
          status: 200,
          data: { ok: true, format: "json", content: renderJson(reportData), filename: `${base}.json` },
        };
      }
      return {
        status: 200,
        data: { ok: true, format: "html", content: renderReport(reportData), filename: `${base}.html` },
      };
    }

    case "/api/settings": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const patch = body?.settings && typeof body.settings === "object" ? body.settings : body;
      if (!patch || typeof patch !== "object") {
        return { status: 400, data: { ok: false, error: "invalid-settings" } };
      }
      const result = engine.updateSettings(patch);
      await store.flush();
      return {
        status: 200,
        data: { ok: true, ...result, stats: engine.getStats() },
      };
    }

    case "/api/coinglass/key": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const key = body?.clear === true ? null : body?.apiKey ?? body?.key;
      if (key !== null && typeof key !== "string") {
        return { status: 400, data: { ok: false, error: "invalid-api-key" } };
      }
      const result = engine.setCoinglassApiKey(key);
      if (cgClient) cgClient.setApiKey(key);
      await store.flush();
      return {
        status: 200,
        data: { ok: true, ...result, stats: engine.getStats() },
      };
    }

    case "/api/control": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const action = String(body?.action || "");
      let result;
      if (action === "start") {
        result = engine.start("ui");
      } else if (action === "pause") {
        result = engine.pause("ui");
      } else if (action === "toggle") {
        result = engine.toggle();
      } else if (action === "reset") {
        result = engine.reset();
      } else if (action === "close-all") {
        result = await engine.closeAll("Manual close all");
      } else {
        return { status: 400, data: { ok: false, error: "unknown-action" } };
      }
      await store.flush();
      return {
        status: 200,
        data: { ok: true, ...result },
      };
    }

    case "/api/scan": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const result = await engine.scan({ manual: true });
      await store.flush();
      return {
        status: 200,
        data: { ok: true, ...result },
      };
    }

    case "/api/trade/open": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      if (cgClient && cgClient.status.stopNewEntries) {
        return { status: 400, data: { ok: false, error: "coinglass-feed-offline" } };
      }
      const result = await engine.openManual(body?.symbol, {
        force: body?.force !== false,
        side: body?.side || null,
      });
      await store.flush();
      return {
        status: result.ok ? 200 : 400,
        data: result,
      };
    }

    case "/api/trade/close": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const result = await engine.closePositionById(
        String(body?.id || ""),
        body?.reason || "Manual"
      );
      await store.flush();
      return {
        status: result.ok ? 200 : 400,
        data: result,
      };
    }

    case "/api/backup/export": {
      const searchParams = new URLSearchParams(path.includes("?") ? path.split("?")[1] : "");
      const includeKeys =
        query?.includeKeys === true ||
        query?.includeKeys === "true" ||
        searchParams.get("includeKeys") === "true" ||
        body?.includeKeys === true;
      const backup = await store.exportBackup({ includeKeys });
      return {
        status: 200,
        data: {
          ok: true,
          backup,
          filename: `oi-sniper-backup-${stamp()}.json`,
        },
      };
    }

    case "/api/status-config": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const { liveEnabled = true, message = "" } = body || {};
      if (typeof engine.setStatusConfig === "function") {
        engine.setStatusConfig({ liveEnabled, message });
      }
      return {
        status: 200,
        data: { ok: true, liveEnabled: engine.liveEnabled },
      };
    }

    case "/api/backup/import": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const res = await store.importBackup(body);
      engine.state = store.state;
      return {
        status: 200,
        data: { ok: true, ...res },
      };
    }

    case "/api/backup/legacy": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const res = await store.importLegacyState(body);
      engine.state = store.state;
      return {
        status: 200,
        data: { ok: true, ...res },
      };
    }

    case "/api/exchange/connect": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const { venue, apiKey, secret, passphrase } = body || {};
      if (!venue || !apiKey || !secret) {
        return { status: 400, data: { ok: false, error: "missing-venue-or-credentials" } };
      }
      let adapter;
      try {
        adapter = createVenueAdapter(venue, { apiKey, secret, passphrase });
      } catch (err) {
        return { status: 400, data: { ok: false, error: err.message } };
      }

      const val = await adapter.validateKey({ apiKey, secret, passphrase });
      if (!val.ok) {
        return {
          status: 400,
          data: {
            ok: false,
            canTrade: false,
            canWithdraw: Boolean(val.canWithdraw),
            error: val.error || "Key validation failed",
          },
        };
      }

      await saveCredentials(venue, { apiKey, secret, passphrase }, { idbStore: store });
      engine.setLiveAdapter(adapter);
      return {
        status: 200,
        data: {
          ok: true,
          venue: adapter.id,
          canTrade: true,
          canWithdraw: false,
          maskedKey: maskKey(apiKey),
        },
      };
    }

    case "/api/exchange/test": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const venue = body?.venue || engine.state.settings?.live?.exchange || "bybit";
      let apiKey = body?.apiKey;
      let secret = body?.secret;
      let passphrase = body?.passphrase;

      if (!apiKey || !secret) {
        const creds = await getCredentials(venue, { idbStore: store });
        if (!creds) {
          return { status: 400, data: { ok: false, error: `No stored credentials found for ${venue}` } };
        }
        apiKey = creds.apiKey;
        secret = creds.secret;
        passphrase = creds.passphrase;
      }

      let adapter;
      try {
        adapter = createVenueAdapter(venue, { apiKey, secret, passphrase });
      } catch (err) {
        return { status: 400, data: { ok: false, error: err.message } };
      }

      const val = await adapter.validateKey({ apiKey, secret, passphrase });
      if (!val.ok) {
        return {
          status: 400,
          data: {
            ok: false,
            venue,
            canTrade: false,
            canWithdraw: Boolean(val.canWithdraw),
            error: val.error,
          },
        };
      }

      let balance = { availableUsdt: 0, equityUsdt: 0 };
      try {
        balance = await adapter.getBalance();
      } catch (err) {
        return { status: 400, data: { ok: false, venue, error: `Balance check failed: ${err.message}` } };
      }

      let instruments = [];
      try {
        instruments = await adapter.getInstruments();
      } catch (err) {
        console.warn(`[routes] Instruments load warning for ${venue}:`, err?.message);
      }

      let modeCheck = { oneWay: true, isolated: true };
      try {
        modeCheck = await adapter.ensureAccountMode();
      } catch (err) {
        console.warn(`[routes] Account mode check warning for ${venue}:`, err?.message);
      }

      let capabilities = { trading: true };
      let capabilityProbe = null;
      if (typeof adapter.probeCapability === "function") {
        try {
          capabilityProbe = await adapter.probeCapability();
        } catch (err) {
          capabilityProbe = { ok: false, trading: false, futuresOrderAvailable: false, message: err.message };
        }
      }
      if (typeof adapter.capabilities === "function") {
        capabilities = adapter.capabilities();
      }

      return {
        status: 200,
        data: {
          ok: true,
          venue,
          canTrade: true,
          canWithdraw: false,
          balance,
          instrumentsCount: instruments.length,
          accountMode: modeCheck,
          capabilities,
          capabilityProbe,
        },
      };
    }

    case "/api/exchange/disconnect": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const venue = body?.venue;
      if (!venue) return { status: 400, data: { ok: false, error: "missing-venue" } };
      await removeCredentials(venue, { idbStore: store });
      if (engine.state.settings?.live?.exchange === venue && engine.state.settings?.mode === "live") {
        await engine.setMode("paper");
      }
      return { status: 200, data: { ok: true, venue } };
    }

    case "/api/exchange/status": {
      const entries = await listVaultEntries({ idbStore: store });
      const activeVenue = engine.state.settings?.live?.exchange || "bybit";
      const venuesStatus = SUPPORTED_VENUES.map((v) => {
        const connectedEntry = entries.find((e) => e.venue === v.id);
        return {
          ...v,
          connected: Boolean(connectedEntry),
          maskedKey: connectedEntry?.maskedKey || null,
          updatedAt: connectedEntry?.updatedAt || null,
          isActive: v.id === activeVenue,
        };
      });
      return {
        status: 200,
        data: {
          ok: true,
          mode: engine.state.settings?.mode || "paper",
          activeVenue,
          venues: venuesStatus,
        },
      };
    }

    case "/api/mode": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const targetMode = body?.mode === "live" ? "live" : "paper";
      if (targetMode === "live") {
        const conf = String(body?.confirmation || "").trim();
        if (conf !== "I UNDERSTAND" && conf !== "LIVE") {
          return {
            status: 400,
            data: {
              ok: false,
              error: "Switching to Live requires typing 'I UNDERSTAND' to confirm real-money risk.",
            },
          };
        }
        const activeVenue = engine.state.settings?.live?.exchange || "bybit";
        const creds = await getCredentials(activeVenue, { idbStore: store });
        if (!creds) {
          return {
            status: 400,
            data: {
              ok: false,
              error: `Cannot switch to Live: no credentials found for ${activeVenue}. Connect exchange first.`,
            },
          };
        }
        const adapter = createVenueAdapter(activeVenue, { apiKey: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase });
        const val = await adapter.validateKey(creds);
        if (!val.ok) {
          return {
            status: 400,
            data: {
              ok: false,
              error: `Connection test failed for ${activeVenue}: ${val.error}`,
            },
          };
        }
        if (typeof adapter.probeCapability === "function") {
          try {
            await adapter.probeCapability();
          } catch {
            // Handled via capabilities() check below
          }
        }
        const caps = typeof adapter.capabilities === "function" ? adapter.capabilities() : { trading: true };
        if (!caps.trading) {
          return {
            status: 400,
            data: {
              ok: false,
              error: caps.reason || "Futures order API unavailable at MEXC",
            },
          };
        }
        engine.setLiveAdapter(adapter);
      }

      const result = await engine.setMode(targetMode);
      await store.flush();
      return {
        status: result.ok ? 200 : 400,
        data: result,
      };
    }

    case "/api/kill-switch": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const active = body?.active !== undefined ? Boolean(body.active) : !engine.killSwitchActive;
      engine.killSwitchActive = active;
      engine.log(active ? "warn" : "info", `Kill switch ${active ? "ACTIVATED (all new entries stopped)" : "DEACTIVATED"}`);
      return { status: 200, data: { ok: true, active: engine.killSwitchActive } };
    }

    case "/api/panic": {
      if (method !== "POST") return { status: 405, data: { ok: false, error: "method-not-allowed" } };
      const res = await engine.activeExecutor.panic();
      await store.flush();
      return { status: 200, data: { ok: true, ...res } };
    }

    default:
      return { status: 404, data: { ok: false, error: "not-found" } };
  }
}
