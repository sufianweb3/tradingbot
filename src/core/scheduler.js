/**
 * Priority Scheduler, Rate-Limit Reservation & Backpressure Controller
 *
 * Implements Section 7.5 (FX-51), Section 9.5 (FX-64), and Section 8.7 (EC-60).
 *
 * Priority Levels:
 * - P0: Emergency exits, panic close, SL placement, SL failure recovery.
 * - P1: New entry order submission, TP1/trailing stop updates, active position mark price ticks.
 * - P2: Signal diff scan, EQE book evaluation for candidate entries, reconcile loop.
 * - P3: Full CoinGlass table refresh, UI telemetry broadcast, report/export generation.
 */

import { toNum } from "../util.js";

export class VenueRateLimiter {
  constructor({ capacityPerMin = 1200, reserveProtectedFraction = 0.3 } = {}) {
    this.capacityPerMin = Math.max(10, toNum(capacityPerMin, 1200));
    this.reserveProtectedFraction = Math.max(0.1, Math.min(0.8, toNum(reserveProtectedFraction, 0.3)));
    this.tokens = this.capacityPerMin;
    this.lastRefillMs = Date.now();
  }

  _refill(nowMs = Date.now()) {
    const elapsedMs = Math.max(0, nowMs - this.lastRefillMs);
    if (elapsedMs <= 0) return;
    const added = (elapsedMs / 60000) * this.capacityPerMin;
    this.tokens = Math.min(this.capacityPerMin, this.tokens + added);
    this.lastRefillMs = nowMs;
  }

  /**
   * Try to consume weight tokens.
   * P0 and P1 can use 100% of tokens; P2 and P3 cannot dip into the 30% reserved pool (FX-51).
   */
  tryConsume(priority = "P2", weight = 1, nowMs = Date.now()) {
    this._refill(nowMs);
    const w = Math.max(1, toNum(weight, 1));
    const reservedFloor =
      priority === "P0" || priority === "P1"
        ? 0
        : this.capacityPerMin * this.reserveProtectedFraction;

    if (this.tokens - w >= reservedFloor - 1e-6) {
      this.tokens = Math.max(0, this.tokens - w);
      return { allowed: true, remainingTokens: Math.floor(this.tokens), reservedFloor };
    }

    return {
      allowed: false,
      reason: "rate-limit-reserved-for-protection",
      remainingTokens: Math.floor(this.tokens),
      reservedFloor,
    };
  }
}

export class PriorityScheduler {
  constructor({ maxLagMs = 50, onBackpressure = null } = {}) {
    this.maxLagMs = toNum(maxLagMs, 50);
    this.onBackpressure = onBackpressure;
    this.queues = {
      P0: [],
      P1: [],
      P2: [],
      P3: [],
    };
    this.rateLimiters = new Map(); // venue -> VenueRateLimiter
    this.lagMs = 0;
    this.backpressureActive = false;
    this.running = false;
    this.stats = {
      executed: { P0: 0, P1: 0, P2: 0, P3: 0 },
      droppedOrDeferred: 0,
      backpressureEvents: 0,
    };
  }

  getVenueLimiter(venue, capacityPerMin = 1200) {
    const v = String(venue || "default").toLowerCase();
    if (!this.rateLimiters.has(v)) {
      this.rateLimiters.set(v, new VenueRateLimiter({ capacityPerMin }));
    }
    return this.rateLimiters.get(v);
  }

  /**
   * Update measured event-loop lag and toggle P2/P3 backpressure if lag > 50ms (FX-64).
   */
  reportEventLoopLag(lagMs) {
    this.lagMs = Math.max(0, toNum(lagMs, 0));
    const shouldPauseLow = this.lagMs > this.maxLagMs;
    if (shouldPauseLow && !this.backpressureActive) {
      this.backpressureActive = true;
      this.stats.backpressureEvents++;
      if (typeof this.onBackpressure === "function") {
        try {
          this.onBackpressure({ active: true, lagMs: this.lagMs, reason: "engine-busy" });
        } catch {
          /* ignore */
        }
      }
    } else if (!shouldPauseLow && this.backpressureActive) {
      this.backpressureActive = false;
      if (typeof this.onBackpressure === "function") {
        try {
          this.onBackpressure({ active: false, lagMs: this.lagMs, reason: null });
        } catch {
          /* ignore */
        }
      }
    }
    return this.backpressureActive;
  }

  /**
   * Schedule a task in P0..P3 and return a Promise for its completion.
   */
  schedule(priority, taskFn, { venue = null, weight = 1, label = "" } = {}) {
    const prio = ["P0", "P1", "P2", "P3"].includes(priority) ? priority : "P2";

    if (venue) {
      const limiter = this.getVenueLimiter(venue);
      const check = limiter.tryConsume(prio, weight);
      if (!check.allowed) {
        this.stats.droppedOrDeferred++;
        return Promise.reject(new Error(check.reason));
      }
    }

    return new Promise((resolve, reject) => {
      this.queues[prio].push({
        prio,
        taskFn,
        label,
        enqueuedAt: Date.now(),
        resolve,
        reject,
      });
      this._drain();
    });
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const next = this._pickNext();
        if (!next) break;
        this.stats.executed[next.prio]++;
        try {
          const res = await next.taskFn();
          next.resolve(res);
        } catch (err) {
          next.reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }

  _pickNext() {
    if (this.queues.P0.length > 0) return this.queues.P0.shift();
    if (this.queues.P1.length > 0) return this.queues.P1.shift();
    if (this.backpressureActive) {
      return null;
    }
    if (this.queues.P2.length > 0) return this.queues.P2.shift();
    if (this.queues.P3.length > 0) return this.queues.P3.shift();
    return null;
  }

  snapshot() {
    return {
      lagMs: this.lagMs,
      backpressureActive: this.backpressureActive,
      queued: {
        P0: this.queues.P0.length,
        P1: this.queues.P1.length,
        P2: this.queues.P2.length,
        P3: this.queues.P3.length,
      },
      executed: { ...this.stats.executed },
      droppedOrDeferred: this.stats.droppedOrDeferred,
      backpressureEvents: this.stats.backpressureEvents,
    };
  }
}
