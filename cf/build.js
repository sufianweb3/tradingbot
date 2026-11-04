/**
 * Engine build identity.
 *
 * A running Durable Object keeps executing the code version it started with,
 * even after a deploy. Bumping `ENGINE_GENERATION` gives the engine a fresh
 * instance (and therefore new code), and `/api/health` reports which generation
 * answered so the deployed code can be verified.
 */

export const ENGINE_GENERATION = "g9";
