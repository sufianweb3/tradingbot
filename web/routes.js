/**
 * RPC Route Handlers for Web Worker Strategy Engine
 *
 * Implements the full /api/* REST endpoint contract for the browser-hosted runtime.
 */

import { renderCsv, renderJson, renderReport } from "../src/report.js";
import { now } from "../src/util.js";

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
      const backup = await store.exportBackup();
      return {
        status: 200,
        data: {
          ok: true,
          backup,
          filename: `oi-sniper-backup-${stamp()}.json`,
        },
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

    default:
      return { status: 404, data: { ok: false, error: "not-found" } };
  }
}
