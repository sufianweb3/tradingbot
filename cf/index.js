/**
 * Cloudflare Worker entry point.
 *
 * `/api/*` is handled by a single Durable Object that owns the trading engine,
 * everything else is served from the static dashboard in `public/`.
 *
 * Bump `ENGINE_GENERATION` whenever the engine code changes: a Durable Object
 * that is already running keeps executing the version it started with, so a
 * new generation name guarantees the new code is used. The dashboard sends its
 * settings/state with it, so a bump starts from a clean paper account.
 */

import { EngineV3DO } from "./do.js";
import { ENGINE_GENERATION } from "./build.js";

export { EngineV3DO };
// Alias kept so the previously deployed class name still resolves.
export { EngineV3DO as EngineV2DO };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const id = env.ENGINE.idFromName(`engine-${ENGINE_GENERATION}`);
      return env.ENGINE.get(id).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
