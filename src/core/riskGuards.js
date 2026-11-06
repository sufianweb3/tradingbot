/**
 * Risk Guardrails, Funding Guard, Signal Confirmation, and Preset Sanitizer.
 *
 * Implements Section 10.6, FX-15, EC-21, EC-22, EC-50, EC-53, EC-55, EC-56, EC-65, EC-67.
 */

import { clamp, toNum } from "../util.js";

export const DEFAULT_RISK_SETTINGS = {
  minAbsOiChangeUsd: 250000,
  minAbsVol1hUsd: 500000,
  maxEntriesPerMin: 2,
  maxSameDirectionPositions: 3,
  maxTotalMarginPct: 60,
  maxMarginPerTrade: 500,
  maxLeverage: 50,
  dailyLossCapPct: 10,
  lossStreakPauseCount: 3,
  lossStreakPauseMin: 30,
  fundingGuard: true,
  maxAdverseFundingBps: 25,
  fundingBlackoutMin: 5,
  confirmScans: 1,
  maxSignalAgeSec: 20,
  liveArmExpiryH: 24,
  maxDrawdownKillPct: 25,
};

/**
 * Compute next 8-hour funding boundary (00:00, 08:00, 16:00 UTC) or custom funding timestamp.
 */
export function nextFundingBoundaryMs(nowMs = Date.now(), customNextFundingTs = null) {
  const custom = toNum(customNextFundingTs, null);
  if (custom && custom > nowMs) return custom;
  const eightHoursMs = 8 * 3600 * 1000;
  return Math.ceil((nowMs + 1) / eightHoursMs) * eightHoursMs;
}

/**
 * Evaluate Funding Guard (FX-15, EC-21).
 * Blocks entry if within `fundingBlackoutMin` of a funding timestamp AND
 * adverse funding rate exceeds `maxAdverseFundingBps`.
 * Notice: fundingRate may be given as decimal (e.g. 0.003 = 30 bps) or percentage (0.3% = 30 bps) or bps.
 * By convention in CoinGlass/exchanges:
 * - if abs(rate) < 0.05, treat as decimal fraction (0.0025 = 25 bps -> rate * 10000) unless rateBps is explicit.
 */
export function checkFundingGuard({
  side,
  fundingRate = 0,
  fundingRateBps = null,
  nextFundingTs = null,
  nowMs = Date.now(),
  riskSettings = {},
}) {
  const cfg = { ...DEFAULT_RISK_SETTINGS, ...(riskSettings || {}) };
  if (!cfg.fundingGuard) return { ok: true, adverseBps: 0, minutesToFunding: null };

  const rawRate = toNum(fundingRate, 0);
  const bps =
    fundingRateBps !== null && fundingRateBps !== undefined
      ? toNum(fundingRateBps, 0)
      : Math.abs(rawRate) <= 0.05
      ? rawRate * 10000
      : rawRate * 100;

  // Positive funding means Longs pay Shorts; Negative funding means Shorts pay Longs
  const isLong = side !== "short";
  const adverseBps = isLong ? Math.max(0, bps) : Math.max(0, -bps);

  const nextBoundary = nextFundingBoundaryMs(nowMs, nextFundingTs);
  const minutesToFunding = Math.max(0, (nextBoundary - nowMs) / 60000);

  if (
    minutesToFunding <= toNum(cfg.fundingBlackoutMin, 5) &&
    adverseBps > toNum(cfg.maxAdverseFundingBps, 25)
  ) {
    return {
      ok: false,
      reason: "funding-guard",
      adverseBps,
      minutesToFunding,
      maxAdverseFundingBps: cfg.maxAdverseFundingBps,
    };
  }

  return {
    ok: true,
    adverseBps,
    minutesToFunding,
  };
}

/**
 * Portfolio & Burst Risk Guardrail Manager (Section 10.6, EC-50, EC-55, EC-56, EC-67).
 */
export class RiskGuardManager {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_RISK_SETTINGS, ...(settings || {}) };
    this.entryTimestamps = []; // timestamps (ms) of opened entries
    this.confirmCounts = new Map(); // `${symbol}:${side}` -> consecutive scan count
    this.pausedUntilMs = 0;
    this.pauseReason = null;
    this.liveArmedAtMs = null;
  }

  updateSettings(patch = {}) {
    this.settings = { ...this.settings, ...(patch || {}) };
  }

  armLive(nowMs = Date.now()) {
    this.liveArmedAtMs = nowMs;
  }

  disarmLive() {
    this.liveArmedAtMs = null;
  }

  /**
   * Check whether Live mode arm has expired (EC-67).
   */
  checkLiveArmExpiry(nowMs = Date.now()) {
    const expiryH = toNum(this.settings.liveArmExpiryH, 24);
    if (!(expiryH > 0) || !this.liveArmedAtMs) return { expired: false };
    const elapsedH = (nowMs - this.liveArmedAtMs) / (3600 * 1000);
    if (elapsedH >= expiryH) {
      return {
        expired: true,
        reason: "live-arm-expired",
        elapsedHours: elapsedH,
        expiryHours: expiryH,
      };
    }
    return { expired: false, elapsedHours: elapsedH, remainingHours: expiryH - elapsedH };
  }

  /**
   * Record a scan qualification result for multi-scan confirmation (EC-50).
   */
  recordScanQualification(symbol, side, qualified) {
    const key = `${String(symbol).toUpperCase()}:${side}`;
    const required = Math.max(1, Math.round(toNum(this.settings.confirmScans, 1)));
    if (!qualified) {
      this.confirmCounts.delete(key);
      return { confirmed: false, count: 0, required };
    }
    const next = (this.confirmCounts.get(key) || 0) + 1;
    this.confirmCounts.set(key, next);
    return {
      confirmed: next >= required,
      count: next,
      required,
    };
  }

  /**
   * Record a newly opened entry for burst rate limiting (maxEntriesPerMin).
   */
  recordEntry(nowMs = Date.now()) {
    this.entryTimestamps.push(nowMs);
    this._pruneEntries(nowMs);
  }

  _pruneEntries(nowMs = Date.now()) {
    const cutoff = nowMs - 60000;
    while (this.entryTimestamps.length > 0 && this.entryTimestamps[0] <= cutoff) {
      this.entryTimestamps.shift();
    }
  }

  /**
   * Compute UTC-day realized + unrealized + fees PnL and check against dailyLossCapPct (EC-55).
   */
  checkDailyLossCap({
    trades = [],
    positions = [],
    equity = 0,
    initialFund = 500,
    dailyLossCapUsd = 0,
    dailyLossCapPct = null,
    nowMs = Date.now(),
  }) {
    const utcDayStart = new Date(nowMs);
    utcDayStart.setUTCHours(0, 0, 0, 0);
    const dayStartMs = utcDayStart.getTime();

    let todayRealized = 0;
    for (const t of trades) {
      const exitTs = toNum(t.exitTime ?? t.closedAt, 0);
      if (exitTs >= dayStartMs) {
        todayRealized += toNum(t.pnlNet, 0);
      }
    }

    let openUnrealized = 0;
    for (const p of positions) {
      openUnrealized += toNum(p.unrealizedPnl ?? p.netPnl, 0) - toNum(p.entryFee, 0);
    }

    const totalTodayPnl = todayRealized + openUnrealized;
    const refBase = Math.max(1, toNum(initialFund, 500), toNum(equity, 0));
    const pctCap = toNum(dailyLossCapPct ?? this.settings.dailyLossCapPct, 0);
    const usdCapFromPct = pctCap > 0 ? (refBase * pctCap) / 100 : 0;
    const explicitUsdCap = toNum(dailyLossCapUsd, 0);

    const effectiveCapUsd =
      explicitUsdCap > 0 && usdCapFromPct > 0
        ? Math.min(explicitUsdCap, usdCapFromPct)
        : explicitUsdCap > 0
        ? explicitUsdCap
        : usdCapFromPct;

    if (effectiveCapUsd > 0 && totalTodayPnl <= -effectiveCapUsd) {
      return {
        ok: false,
        reason: "daily-loss-cap",
        todayPnl: totalTodayPnl,
        capUsd: effectiveCapUsd,
      };
    }

    return {
      ok: true,
      todayPnl: totalTodayPnl,
      capUsd: effectiveCapUsd,
    };
  }

  /**
   * Check consecutive stop-loss streak (Section 10.6).
   */
  checkLossStreak(trades = [], nowMs = Date.now()) {
    const maxStreak = toNum(this.settings.lossStreakPauseCount, 3);
    const pauseMin = toNum(this.settings.lossStreakPauseMin, 30);
    if (!(maxStreak > 0) || !(pauseMin > 0)) return { ok: true, streak: 0 };

    if (this.pausedUntilMs > nowMs) {
      return {
        ok: false,
        reason: "loss-streak-paused",
        pausedUntilMs: this.pausedUntilMs,
        remainingSec: Math.ceil((this.pausedUntilMs - nowMs) / 1000),
      };
    }

    const sorted = [...trades].sort((a, b) => toNum(b.exitTime, 0) - toNum(a.exitTime, 0));
    let streak = 0;
    let latestLossAt = 0;
    for (const t of sorted) {
      const net = toNum(t.pnlNet, 0);
      const isStop = /sl|stop|liquidation/i.test(String(t.exitReason || ""));
      if (net < 0 && isStop) {
        if (streak === 0) latestLossAt = toNum(t.exitTime, 0);
        streak++;
      } else {
        break;
      }
    }

    if (streak >= maxStreak && latestLossAt > 0) {
      const pauseEnd = latestLossAt + pauseMin * 60000;
      if (nowMs < pauseEnd) {
        this.pausedUntilMs = pauseEnd;
        return {
          ok: false,
          reason: "loss-streak-paused",
          streak,
          pausedUntilMs: pauseEnd,
          remainingSec: Math.ceil((pauseEnd - nowMs) / 1000),
        };
      }
    }

    return { ok: true, streak };
  }

  /**
   * Full pre-entry risk guardrail evaluation (Section 10.6, EC-53, EC-55, EC-56).
   */
  evaluateEntryRisk({
    symbol,
    side = "long",
    mode = "paper",
    margin = 0,
    leverage = 10,
    equity = 500,
    initialFund = 500,
    lockedMargin = 0,
    positions = [],
    trades = [],
    signalAgeMs = 0,
    fundingRate = 0,
    nextFundingTs = null,
    nowMs = Date.now(),
    liveSettings = {},
  } = {}) {
    const cfg = this.settings;

    // 1. Live arm expiry check (EC-67)
    if (mode === "live") {
      const armCheck = this.checkLiveArmExpiry(nowMs);
      if (armCheck.expired) {
        return { ok: false, reason: "live-arm-expired", detail: armCheck };
      }
    }

    // 2. Signal age check (EC-53)
    const maxSigAgeMs = toNum(cfg.maxSignalAgeSec, 20) * 1000;
    if (maxSigAgeMs > 0 && signalAgeMs > maxSigAgeMs) {
      return { ok: false, reason: "data-stale", signalAgeMs, maxSigAgeMs };
    }

    // 3. Burst entry rate limit (maxEntriesPerMin, EC-56)
    this._pruneEntries(nowMs);
    const maxPerMin = toNum(cfg.maxEntriesPerMin, 2);
    if (maxPerMin > 0 && this.entryTimestamps.length >= maxPerMin) {
      return {
        ok: false,
        reason: "burst-entry-cap",
        entriesLastMin: this.entryTimestamps.length,
        maxEntriesPerMin: maxPerMin,
      };
    }

    // 4. Same-direction correlated position cap (maxSameDirectionPositions, EC-56)
    const maxSameDir = toNum(cfg.maxSameDirectionPositions, 3);
    if (maxSameDir > 0) {
      const sameDirCount = positions.filter((p) => p.side === side).length;
      if (sameDirCount >= maxSameDir) {
        return {
          ok: false,
          reason: "same-direction-cap",
          sameDirCount,
          maxSameDirectionPositions: maxSameDir,
        };
      }
    }

    // 5. Total margin in use cap (maxTotalMarginPct, EC-56)
    const maxMarginPct = toNum(
      mode === "live" && liveSettings?.maxMarginInUsePct > 0
        ? liveSettings.maxMarginInUsePct
        : cfg.maxTotalMarginPct,
      60
    );
    if (maxMarginPct > 0 && equity > 0) {
      const nextMarginPct = ((lockedMargin + margin) / equity) * 100;
      if (nextMarginPct > maxMarginPct + 1e-6) {
        return {
          ok: false,
          reason: "total-margin-cap",
          nextMarginPct,
          maxTotalMarginPct: maxMarginPct,
        };
      }
    }

    // 6. Live per-trade margin and leverage caps
    if (mode === "live") {
      const maxMarginTrade = toNum(
        liveSettings?.marginPerTrade > 0 ? liveSettings.marginPerTrade : cfg.maxMarginPerTrade,
        500
      );
      if (maxMarginTrade > 0 && margin > maxMarginTrade + 1e-6) {
        return {
          ok: false,
          reason: "margin-exceeds-live-cap",
          margin,
          maxMarginPerTrade: maxMarginTrade,
        };
      }

      const maxLev = toNum(cfg.maxLeverage, 50);
      if (maxLev > 0 && leverage > maxLev) {
        return {
          ok: false,
          reason: "leverage-exceeds-live-cap",
          leverage,
          maxLeverage: maxLev,
        };
      }
    }

    // 7. Daily loss cap check (EC-55)
    const dailyCheck = this.checkDailyLossCap({
      trades,
      positions,
      equity,
      initialFund,
      dailyLossCapUsd: liveSettings?.dailyLossCap || 0,
      dailyLossCapPct: cfg.dailyLossCapPct,
      nowMs,
    });
    if (!dailyCheck.ok) {
      return dailyCheck;
    }

    // 8. Loss streak pause check
    const streakCheck = this.checkLossStreak(trades, nowMs);
    if (!streakCheck.ok) {
      return streakCheck;
    }

    // 9. Funding guard (FX-15, EC-21)
    const fundCheck = checkFundingGuard({
      side,
      fundingRate,
      nextFundingTs,
      nowMs,
      riskSettings: cfg,
    });
    if (!fundCheck.ok) {
      return fundCheck;
    }

    return {
      ok: true,
      symbol,
      side,
    };
  }
}

/**
 * Sanitize an imported preset (e.g. from #preset= URL hash) against hard safety caps (EC-65).
 * Prevents malicious links from setting 200x leverage, 100% allocation, or 0.01% SL.
 */
export function sanitizeImportedPreset(rawPreset = {}) {
  const p = rawPreset && typeof rawPreset === "object" ? JSON.parse(JSON.stringify(rawPreset)) : {};
  const warnings = [];

  // Strip any credentials or live mode arming
  p.coinglassApiKey = "";
  delete p.coinglassKeySet;
  p.mode = "paper";
  if (p.eqe && typeof p.eqe === "object" && p.eqe.enabled === false) {
    warnings.push("eqe.enabled forced to true on imported preset");
    p.eqe.enabled = true;
  }
  if (p.live && typeof p.live === "object") {
    delete p.live.apiKey;
    delete p.live.secret;
    delete p.live.passphrase;
  }

  const clampProfile = (obj, label) => {
    if (!obj || typeof obj !== "object") return;
    if (obj.leverage !== undefined && toNum(obj.leverage, 20) > 75) {
      warnings.push(`${label}: leverage clamped from ${obj.leverage}x to 75x`);
      obj.leverage = 75;
    }
    if (obj.allocationPercent !== undefined && toNum(obj.allocationPercent, 50) > 50) {
      warnings.push(`${label}: allocationPercent clamped from ${obj.allocationPercent}% to 50%`);
      obj.allocationPercent = 50;
    }
    if (obj.slPercent !== undefined && toNum(obj.slPercent, 20) < 2) {
      warnings.push(`${label}: slPercent raised from ${obj.slPercent}% to minimum 2%`);
      obj.slPercent = 2;
    }
  };

  clampProfile(p, "root");
  if (p.profiles && typeof p.profiles === "object") {
    clampProfile(p.profiles.long, "profiles.long");
    clampProfile(p.profiles.short, "profiles.short");
  }

  return {
    preset: p,
    warnings,
    sanitized: warnings.length > 0,
  };
}
