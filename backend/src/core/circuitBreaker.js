/**
 * Per-(Venue, Endpoint-Class) Circuit Breakers, Latency Quantiles & Clock Drift Guard
 *
 * Implements Section 9.6 (FX-65) and Section 8.7 (EC-60, EC-61, EC-62).
 */

import { round, toNum } from "../util.js";

export class EndpointCircuitBreaker {
  constructor({
    venue,
    endpointClass = "public",
    failureThreshold = 5,
    cooldownMs = 15000,
    maxSamples = 50,
  }) {
    this.venue = String(venue).toLowerCase();
    this.endpointClass = endpointClass;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.maxSamples = maxSamples;

    this.state = "closed"; // "closed" | "open" | "half-open"
    this.consecutiveFailures = 0;
    this.openedAtMs = 0;
    this.openUntilMs = 0;
    this.lastError = null;
    this.samples = []; // Array<{ ok: boolean, rttMs: number, ts: number, status?: number }>
  }

  canExecute(nowMs = Date.now()) {
    if (this.state === "closed") return { allowed: true, state: "closed" };
    if (this.state === "open") {
      if (nowMs >= this.openUntilMs) {
        this.state = "half-open";
        return { allowed: true, state: "half-open" };
      }
      return {
        allowed: false,
        state: "open",
        reason: `circuit-open:${this.venue}:${this.endpointClass}`,
        remainingMs: Math.max(0, this.openUntilMs - nowMs),
      };
    }
    return { allowed: true, state: "half-open" };
  }

  recordSuccess(rttMs = 0, nowMs = Date.now()) {
    this.consecutiveFailures = 0;
    this.state = "closed";
    this.lastError = null;
    this._pushSample({ ok: true, rttMs: Math.max(0, toNum(rttMs, 0)), ts: nowMs });
  }

  recordFailure(err, { rttMs = 0, retryAfterMs = null, nowMs = Date.now() } = {}) {
    this.consecutiveFailures += 1;
    this.lastError = String(err?.message || err || "error");
    const status = toNum(err?.status, null);
    this._pushSample({ ok: false, rttMs: Math.max(0, toNum(rttMs, 0)), ts: nowMs, status });

    const isRateLimit = status === 429 || status === 418 || /429|rate limit/i.test(this.lastError);
    if (this.state === "half-open" || isRateLimit || this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAtMs = nowMs;
      const waitMs =
        retryAfterMs && retryAfterMs > 0
          ? retryAfterMs
          : isRateLimit
          ? Math.max(this.cooldownMs, 30000)
          : this.cooldownMs;
      this.openUntilMs = nowMs + waitMs;
    }
  }

  _pushSample(sample) {
    this.samples.push(sample);
    if (this.samples.length > this.maxSamples) {
      this.samples.splice(0, this.samples.length - this.maxSamples);
    }
  }

  metrics(nowMs = Date.now()) {
    this.canExecute(nowMs);
    const total = this.samples.length;
    if (total === 0) {
      return {
        venue: this.venue,
        endpointClass: this.endpointClass,
        state: this.state,
        p50RttMs: 0,
        p95RttMs: 0,
        errorRate: 0,
        consecutiveFailures: this.consecutiveFailures,
        lastError: this.lastError,
      };
    }

    const errors = this.samples.filter((s) => !s.ok).length;
    const rtts = this.samples
      .filter((s) => s.ok && s.rttMs > 0)
      .map((s) => s.rttMs)
      .sort((a, b) => a - b);

    const quantile = (arr, q) => {
      if (!arr.length) return 0;
      const idx = Math.min(arr.length - 1, Math.floor(q * arr.length));
      return Math.round(arr[idx]);
    };

    return {
      venue: this.venue,
      endpointClass: this.endpointClass,
      state: this.state,
      p50RttMs: quantile(rtts, 0.5),
      p95RttMs: quantile(rtts, 0.95),
      errorRate: round(errors / total, 4),
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }
}

export class CircuitBreakerRegistry {
  constructor() {
    this.breakers = new Map(); // `${venue}:${endpointClass}` -> EndpointCircuitBreaker
    this.clockDriftMs = new Map(); // venue -> driftMs
    this.wsAgeMs = new Map(); // venue -> lastWsFrameTs
  }

  getBreaker(venue, endpointClass = "public") {
    const key = `${String(venue).toLowerCase()}:${endpointClass}`;
    if (!this.breakers.has(key)) {
      this.breakers.set(
        key,
        new EndpointCircuitBreaker({ venue, endpointClass })
      );
    }
    return this.breakers.get(key);
  }

  /**
   * Record clock drift for a venue (EC-62: block live orders if abs(drift) > 1000ms).
   */
  recordClockDrift(venue, driftMs) {
    const v = String(venue).toLowerCase();
    const d = toNum(driftMs, 0);
    this.clockDriftMs.set(v, d);
    return {
      ok: Math.abs(d) <= 1000,
      driftMs: d,
      reason: Math.abs(d) > 1000 ? "clock-drift-exceeded" : null,
    };
  }

  recordWsFrame(venue, ts = Date.now()) {
    this.wsAgeMs.set(String(venue).toLowerCase(), ts);
  }

  /**
   * Compute overall venue health status (ok | degraded | down) for SOR and UI (FX-37, FX-84).
   */
  getVenueHealth(venue, nowMs = Date.now()) {
    const v = String(venue).toLowerCase();
    const pub = this.getBreaker(v, "public").metrics(nowMs);
    const ord = this.getBreaker(v, "order").metrics(nowMs);
    const acc = this.getBreaker(v, "account").metrics(nowMs);
    const driftMs = toNum(this.clockDriftMs.get(v), 0);
    const lastWs = this.wsAgeMs.get(v) || null;
    const wsAgeMs = lastWs ? Math.max(0, nowMs - lastWs) : null;

    let health = "ok";
    if (ord.state === "open" || (pub.state === "open" && acc.state === "open")) {
      health = "down";
    } else if (
      pub.state === "open" ||
      acc.state === "open" ||
      ord.state === "half-open" ||
      pub.errorRate > 0.25 ||
      ord.errorRate > 0.15 ||
      Math.abs(driftMs) > 1000
    ) {
      health = "degraded";
    }

    return {
      venue: v,
      health,
      clockDriftMs: driftMs,
      clockOk: Math.abs(driftMs) <= 1000,
      wsAgeMs,
      p50OrderRttMs: ord.p50RttMs || pub.p50RttMs,
      p95OrderRttMs: ord.p95RttMs || pub.p95RttMs || 100,
      recentErrorRate: Math.max(pub.errorRate, ord.errorRate),
      endpoints: {
        public: pub,
        order: ord,
        account: acc,
      },
    };
  }

  getAllVenuesHealth(venues = ["bybit", "binance", "gate", "kucoin", "mexc", "okx", "bitget"], nowMs = Date.now()) {
    return venues.map((v) => this.getVenueHealth(v, nowMs));
  }

  summary(venues = ["bybit", "binance", "gate", "kucoin", "mexc", "okx", "bitget"], nowMs = Date.now()) {
    return this.getAllVenuesHealth(venues, nowMs);
  }
}
