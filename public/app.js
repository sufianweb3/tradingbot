/* OI Sniper dashboard: vanilla JS, no build step. */

import { fetchCoinMarkets, fetchTopMarkets, mergeTopRows } from "./cg-browser.js";
import { initApi, api as localApi, takeOverEngine, onLiveTick, onStatusChange, isLeaderTab, APP_VERSION } from "./web/api.js";
import { PRESETS, createPresetHash, parsePresetHash, deepMerge } from "./src/presets.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const VENUE_NAMES = {
  okx: "OKX",
  mexc: "MEXC",
  gate: "Gate.io",
  kucoin: "KuCoin",
  binance: "Binance",
  bybit: "Bybit",
  bitget: "Bitget",
};
const VENUE_ORDER = ["okx", "mexc", "gate", "kucoin", "binance", "bybit", "bitget"];
const OI_LABELS = { "5m": "OI 5m", "15m": "OI 15m", "30m": "OI 30m", "1h": "OI 1h", "4h": "OI 4h" };
const VOL_LABELS = { "1h": "Vol 1h", "4h": "Vol 4h" };
const PRICE_LABELS = { "5m": "Price 5m", "1h": "Price 1h" };
const TAB_LABELS = { qualified: "qualified", near: "near-miss", all: "coins" };

const state = {
  settings: null,
  activeProfile: "long",
  sideFilter: "all",
  initialFund: 0,
  meta: {},
  stats: {},
  positions: [],
  markets: [],
  trades: [],
  tradesTotal: 0,
  equityCurve: [],
  logs: [],
  venues: { venues: [] },
  tab: "qualified",
  search: "",
  tradeSearch: "",
  cgSearch: "",
  cgSort: "abs",
  dirty: false,
  loaded: false,
  prevTrades: 0,
  serverOffset: 0,
  logCutoff: 0,
  maxTradesNotified: false,
  requestErrors: 0,
  chart: { points: [], hover: null },
  device: {
    enabled: false,
    busy: false,
    errors: 0,
    lastPushAt: 0,
    lastFetchAt: 0,
    coins: [],
    latencyMs: null,
    pausedUntil: 0,
  },
  serverPausedUntil: 0,
  quotaNotice: false,
  legacyApi: false,
};

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
const num = (v, d = 0) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
/** 40000 -> "11h 6m", 90 -> "1m", 45 -> "45s". */
const humanDuration = (sec) => {
  const s = Math.max(0, Math.round(num(sec, 0)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const money = (n, d = 2) => {
  const x = num(n);
  return (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
const signedMoney = (n, d = 2) => {
  const x = num(n);
  return (x > 0 ? "+" : x < 0 ? "-" : "") + "$" + Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
};
const pct = (n, d = 2) => {
  const x = num(n);
  return (x > 0 ? "+" : "") + x.toFixed(d) + "%";
};
const compact = (n) => {
  const x = num(n);
  const a = Math.abs(x);
  if (a >= 1e12) return (x / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (x / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (x / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return (x / 1e3).toFixed(1) + "K";
  return x.toFixed(0);
};
const price = (n) => {
  const x = num(n);
  if (!x) return "--";
  if (x >= 1000) return x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (x >= 100) return x.toFixed(3);
  if (x >= 1) return x.toFixed(4);
  if (x >= 0.01) return x.toFixed(5);
  return x.toFixed(8);
};
const qty = (n) => {
  const x = num(n);
  if (Math.abs(x) >= 1000) return x.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (Math.abs(x) >= 1) return x.toFixed(3);
  return x.toPrecision(4);
};
const time = (t) => {
  if (!t) return "--";
  try {
    return new Date(t).toLocaleTimeString("en-GB", { hour12: false });
  } catch {
    return "--";
  }
};
const dateTime = (t) => {
  if (!t) return "--";
  try {
    return new Date(t).toLocaleString("en-GB", {
      month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  } catch {
    return "--";
  }
};
const duration = (ms) => {
  const s = Math.max(0, Math.round(num(ms) / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + (s % 60) + "s";
  return Math.floor(m / 60) + "h " + (m % 60) + "m";
};
const cls = (v) => (num(v) > 0 ? "pos" : num(v) < 0 ? "neg" : "");
const ago = (ms) => {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "--";
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 1) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
};

const BANNER_CONFIG = {
  "kill-switch": { priority: 100, level: "danger" },
  "worker-error": { priority: 95, level: "danger" },
  "unsupported-browser": { priority: 90, level: "danger" },
  "exchange-error": { priority: 80, level: "danger" },
  "error": { priority: 75, level: "danger" },
  "update-required": { priority: 65, level: "warn" },
  "secondary": { priority: 62, level: "warn" },
  "mexc-unavailable": { priority: 60, level: "warn" },
  "offline": { priority: 50, level: "warn", category: "feed" },
  "market-error": { priority: 48, level: "warn", category: "feed" },
  "market-stale": { priority: 45, level: "warn", category: "feed" },
  "stale": { priority: 40, level: "warn", category: "feed" },
  "max-trades": { priority: 30, level: "warn" },
  "no-margin": { priority: 25, level: "warn" },
  "no-filters": { priority: 20, level: "info" },
  "throttled": { priority: 15, level: "info" },
  "tab-hidden": { priority: 10, level: "info" },
  "wake-lock": { priority: 5, level: "info" },
};

const bannerRegistry = new Map(); // id -> { id, priority, category, level, message, kind, actionText, actionFn }

function setBanner(id, bannerData) {
  if (!bannerData) {
    bannerRegistry.delete(id);
  } else {
    const config = BANNER_CONFIG[id] || {};
    bannerRegistry.set(id, {
      id,
      priority: config.priority ?? 10,
      category: config.category,
      level: bannerData.level || config.level || "warn",
      ...bannerData,
    });
  }
  renderServerNotice();
}

function clearBanner(id) {
  bannerRegistry.delete(id);
  renderServerNotice();
}

let activeNotice = null;

function setNotice(notice) {
  activeNotice = notice;
  if (!notice) {
    bannerRegistry.delete("general");
    bannerRegistry.delete("error");
  } else {
    const id = notice.kind || "general";
    const config = BANNER_CONFIG[id] || {};
    const level = notice.level || (notice.kind === "error" || notice.kind === "kill-switch" ? "danger" : (config.level || "warn"));
    bannerRegistry.set(id, {
      id,
      priority: config.priority ?? 75,
      category: config.category,
      level,
      message: notice.message,
      kind: notice.kind,
    });
  }
  renderServerNotice();
}

async function api(path, { method = "GET", body } = {}) {
  return localApi(path, { method, body });
}

function noteServerError(err) {
  setNotice({ kind: "error", message: `Engine request failed: ${err.message || "runtime error"}` });
}

function renderServerNotice() {
  const el = $("#serverNotice");
  if (!el) return;
  if (bannerRegistry.size === 0) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }

  const isRunning = Boolean(state.meta?.running);

  // Filter banners
  let candidateBanners = [...bannerRegistry.values()].filter((banner) => {
    // When bot is stopped/paused, suppress entry-paused warning banners for feed staleness
    if (!isRunning && banner.category === "feed") {
      return false;
    }
    return true;
  });

  if (candidateBanners.length === 0) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }

  // If multiple feed alerts exist, keep only the single highest priority one
  const feedAlerts = candidateBanners.filter((b) => b.category === "feed");
  if (feedAlerts.length > 1) {
    feedAlerts.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const highestFeed = feedAlerts[0];
    candidateBanners = candidateBanners.filter((b) => b.category !== "feed" || b.id === highestFeed.id);
  }

  // Sort descending by priority
  candidateBanners.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  const banner = candidateBanners[0];
  if (!banner) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }

  el.classList.remove("hidden");
  el.innerHTML = "";

  const item = document.createElement("div");
  item.className = `banner-item ${banner.level || "warn"}`;
  item.dataset.bannerId = banner.id;

  const msgSpan = document.createElement("span");
  msgSpan.innerHTML = esc(banner.message);
  item.appendChild(msgSpan);

  if (candidateBanners.length > 1) {
    const badge = document.createElement("span");
    badge.className = "banner-sub-count";
    badge.style.marginLeft = "8px";
    badge.style.fontSize = "10.5px";
    badge.style.opacity = "0.75";
    badge.style.fontFamily = "var(--mono)";
    badge.textContent = `(+${candidateBanners.length - 1} more)`;
    msgSpan.appendChild(badge);
  }

  if (banner.id === "secondary" || banner.kind === "secondary") {
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.style.marginLeft = "10px";
    btn.textContent = "Take Over Engine";
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = "Taking over...";
      await takeOverEngine();
    };
    item.appendChild(btn);
  } else if (banner.actionText && typeof banner.actionFn === "function") {
    const btn = document.createElement("button");
    btn.className = "btn small ghost";
    btn.style.marginLeft = "10px";
    btn.textContent = banner.actionText;
    btn.onclick = banner.actionFn;
    item.appendChild(btn);
  }

  el.appendChild(item);
}

function normalizeCoinSymbol(sym) {
  if (!sym) return "";
  let s = String(sym).trim().toLowerCase();
  s = s.replace(/[-_/]?(perp|swap)$/i, "");
  s = s.replace(/[-_/]?(usdt|usdc|usd|busd)$/i, "");
  s = s.replace(/^(1000000|100000|10000|1000|100|k)([a-z]+)$/i, "$2");
  s = s.replace(/[^a-z0-9]/g, "");
  return s || String(sym).trim().toLowerCase();
}

function getCoinInitials(sym) {
  const norm = normalizeCoinSymbol(sym).toUpperCase();
  const raw = String(sym || "").replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  const target = norm || raw;
  return target.slice(0, 2) || "??";
}

function renderCoinBadge(symbol, rawLogo) {
  const norm = normalizeCoinSymbol(symbol);
  const initials = getCoinInitials(symbol);
  const src = rawLogo || (norm ? `https://assets.coincap.io/assets/icons/${norm}@2x.png` : "");
  if (!src) {
    return `<span class="coin-badge-wrap"><span class="coin-fallback" aria-hidden="true">${esc(initials)}</span></span>`;
  }
  return `<span class="coin-badge-wrap"><img class="coin-logo" src="${esc(src)}" alt="${esc(symbol)}" loading="lazy" width="20" height="20" onerror="this.style.display='none';if(this.nextElementSibling)this.nextElementSibling.style.display='inline-flex';"><span class="coin-fallback" style="display:none" aria-hidden="true">${esc(initials)}</span></span>`;
}

function clearServerError() {
  state.serverPausedUntil = 0;
  state.quotaNotice = false;
  renderServerNotice();
}

function toast(message, type = "info", sub = "") {
  const box = document.createElement("div");
  box.className = `toast ${type}`;
  box.innerHTML = `<div>${esc(message)}</div>${sub ? `<small>${esc(sub)}</small>` : ""}`;
  $("#toasts").appendChild(box);
  setTimeout(() => {
    box.style.transition = "opacity .25s, transform .25s";
    box.style.opacity = "0";
    box.style.transform = "translateY(6px)";
    setTimeout(() => box.remove(), 260);
  }, 4200);
}

/* ------------------------------------------------------------------ */
/* Settings form                                                      */
/* ------------------------------------------------------------------ */
const SETTINGS_ROOT = $(".settings-panel");

function buildFilterRows(container, list, group) {
  if (!container) return;
  container.innerHTML = list
    .map((f) => {
      const label =
        group === "oi"
          ? OI_LABELS[f.key] || f.key
          : group === "vol"
          ? VOL_LABELS[f.key] || f.key
          : PRICE_LABELS[f.key] || `Price ${f.key}`;
      const off = f.enabled && f.threshold !== null && f.threshold !== "" ? "" : "off";
      return `<div class="filter-row ${off}" data-key="${f.key}" data-group="${group}">
        <label class="switch"><input type="checkbox" data-f="enabled" ${f.enabled ? "checked" : ""}><i></i></label>
        <span class="filter-name">${esc(label)}</span>
        <select data-f="op">
          <option value=">=" ${f.op !== "<=" ? "selected" : ""}>≥</option>
          <option value="<=" ${f.op === "<=" ? "selected" : ""}>≤</option>
        </select>
        <input type="number" step="0.01" data-f="threshold" value="${f.threshold ?? ""}" placeholder="--">
        <span class="cur" data-cur="${group}.${f.key}">--</span>
      </div>`;
    })
    .join("");
}

function buildVenueToggles() {
  // Preserve unsaved checkbox changes when the 7s market poll rebuilds this list.
  const checked = state.dirty
    ? new Set($$(".venue-chip input:checked").map((el) => el.value))
    : new Set(state.settings?.venues || []);
  const statuses = new Map((state.venues?.venues || []).map((v) => [v.key, v]));
  $("#venueToggles").innerHTML = VENUE_ORDER.map((key) => {
    const st = statuses.get(key);
    const offline = st && st.ok === false ? " offline" : "";
    const title = st ? (st.ok ? `${st.count} instruments` : st.error || "offline") : "not checked yet";
    return `<label class="venue-chip${offline}" title="${esc(title)}">
      <input type="checkbox" value="${key}" ${checked.has(key) ? "checked" : ""}>
      <span>${esc(VENUE_NAMES[key] || key)}${st ? ` <em>${st.ok ? st.count : "!"}</em>` : ""}</span>
    </label>`;
  }).join("");
}

function setSettingValue(el, value) {
  if (el.type === "checkbox") el.checked = Boolean(value);
  else if (value === null || value === undefined) el.value = "";
  else el.value = value;
}

function collectCurrentProfile() {
  const side = state.activeProfile || "long";
  if (!state.settings) state.settings = {};
  if (!state.settings.profiles) {
    state.settings.profiles = { long: {}, short: {} };
  }
  const prof = { ...(state.settings.profiles[side] || {}) };
  const enableBox = $("#profileEnabled");
  if (enableBox) prof.enabled = enableBox.checked;
  $$("[data-profile-setting]").forEach((el) => {
    const k = el.dataset.profileSetting;
    if (el.type === "checkbox") prof[k] = el.checked;
    else if (el.type === "number") prof[k] = el.value === "" ? null : Number(el.value);
    else prof[k] = el.value;
  });
  prof.oiFilters = collectFilters("#oiFilters", prof.oiFilters);
  prof.volFilters = collectFilters("#volFilters", prof.volFilters);
  prof.priceFilters = collectFilters("#priceFilters", prof.priceFilters);
  state.settings.profiles[side] = prof;
  return prof;
}

function renderSettingsForm() {
  if (!state.settings) return;
  const side = state.activeProfile || "long";
  if (!state.settings.profiles) {
    state.settings.profiles = {
      long: { ...state.settings, enabled: true },
      short: { ...state.settings, enabled: false },
    };
  }
  const prof = state.settings.profiles[side] || state.settings;

  // Render shared settings
  $$("[data-setting]").forEach((el) => setSettingValue(el, state.settings[el.dataset.setting]));

  // Profile tabs & active profile controls
  $$("#profileTabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.profile === side));
  const enabledBox = $("#profileEnabled");
  if (enabledBox) enabledBox.checked = Boolean(prof.enabled);
  const enabledLabel = $("#profileEnabledLabel");
  if (enabledLabel) {
    enabledLabel.textContent = side === "short" ? "Enable Short Profile" : "Enable Long Profile";
  }

  // Profile-specific settings
  $$("[data-profile-setting]").forEach((el) => setSettingValue(el, prof[el.dataset.profileSetting]));

  // Live guardrail settings
  const liveConf = state.settings.live || {};
  $$("[data-live-setting]").forEach((el) => setSettingValue(el, liveConf[el.dataset.liveSetting]));

  buildFilterRows($("#oiFilters"), prof.oiFilters || [], "oi");
  buildFilterRows($("#volFilters"), prof.volFilters || [], "vol");
  buildFilterRows($("#priceFilters"), prof.priceFilters || [], "price");
  buildVenueToggles();
  updateVisibility();
  updateDerived();
  renderCgKeyState();
  setDirty(false);
}

function collectFilters(selector, previous) {
  const container = $(selector);
  if (!container) return previous || [];
  return $$(`${selector} .filter-row`).map((row) => {
    const prev = (previous || []).find((f) => f.key === row.dataset.key) || {};
    const raw = row.querySelector('[data-f="threshold"]').value.trim();
    const t = raw === "" ? null : Number(raw);
    return {
      key: row.dataset.key,
      group: prev.group || row.dataset.group,
      enabled: row.querySelector('[data-f="enabled"]').checked,
      op: row.querySelector('[data-f="op"]').value,
      threshold: Number.isFinite(t) ? t : null,
    };
  });
}

function collectSettings() {
  collectCurrentProfile();
  const out = JSON.parse(JSON.stringify(state.settings || {}));
  // Write-only / derived fields are never part of a settings save.
  delete out.coinglassApiKey;
  delete out.coinglassKeySet;
  $$("[data-setting]").forEach((el) => {
    const key = el.dataset.setting;
    if (el.type === "checkbox") out[key] = el.checked;
    else if (el.type === "number") out[key] = el.value === "" ? null : Number(el.value);
    else out[key] = el.value;
  });
  out.live = out.live || {};
  $$("[data-live-setting]").forEach((el) => {
    const key = el.dataset.liveSetting;
    if (el.type === "checkbox") out.live[key] = el.checked;
    else if (el.type === "number") out.live[key] = el.value === "" ? 0 : Number(el.value);
    else out.live[key] = el.value;
  });
  out.venues = $$(".venue-chip input:checked").map((el) => el.value);
  return out;
}

function setDirty(dirty) {
  state.dirty = dirty;
  $("#dirtyBadge")?.classList.toggle("hidden", !dirty);
  $("#dirtyDot")?.classList.toggle("hidden", !dirty);
}

function updateVisibility() {
  const mode = $('[data-profile-setting="sizingMode"]')?.value || "allocation";
  $$("[data-show]").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.show !== mode);
  });
}

function updateDerived() {
  const lev = Math.max(1, num($('[data-profile-setting="leverage"]')?.value, 1));
  const fund = num($('[data-setting="totalFund"]')?.value, 0);
  const mode = $('[data-profile-setting="sizingMode"]')?.value || "allocation";
  const allocPct = num($('[data-profile-setting="allocationPercent"]')?.value, 50);
  const fixedMargin = num($('[data-profile-setting="fixedMargin"]')?.value, 0);
  const fixedQty = num($('[data-profile-setting="fixedQty"]')?.value, 0);
  const riskMode = $('[data-setting="riskMode"]')?.value || "roe";
  const sl = num($('[data-profile-setting="slPercent"]')?.value, 0);
  const tp1 = num($('[data-profile-setting="tp1Percent"]')?.value, 0);
  const tpMax = num($('[data-profile-setting="tpMaxPercent"]')?.value, 0);

  let margin = 0;
  if (mode === "allocation") margin = (fund * allocPct) / 100;
  else if (mode === "fixedMargin") margin = fixedMargin;
  else margin = (fixedQty * 1) / lev;

  const note = $("#sizingNote");
  if (note) {
    if (mode === "fixedQty") {
      note.textContent = `Each trade buys ${fixedQty || 0} coins. Margin = notional ÷ leverage.`;
    } else {
      note.textContent = `Each trade uses ${money(margin)} margin → ${money(margin * lev)} notional at ${lev}x.`;
    }
    note.classList.toggle("neg", mode !== "fixedQty" && margin > fund + 0.001);
  }

  const reenterEl = $("#reenterHint");
  if (reenterEl) {
    const on = Boolean($('[data-setting="reenterEnabled"]')?.checked);
    const mins = Math.max(0, num($('[data-setting="reenterDelayMin"]')?.value, 0));
    reenterEl.classList.remove("neg");
    if (!on) {
      reenterEl.textContent = "Off: coins can re-enter immediately after a close.";
    } else if (mins <= 0) {
      reenterEl.textContent = "Delay 0 = immediately after a close.";
    } else {
      reenterEl.textContent = `= no same-coin trade for ${humanDuration(mins * 60)} after a close.`;
      if (mins > 1440) {
        reenterEl.classList.add("neg");
        reenterEl.textContent += " (very long block)";
      }
    }
  }

  const hint = $('[data-setting="riskMode"]')?.closest(".setting-group")?.querySelector(".hint");
  if (hint) {
    if (riskMode === "roe") {
      hint.textContent = `${sl}% ROE stop = ${(sl / lev).toFixed(2)}% price move at ${lev}x`;
    } else {
      hint.textContent = `Stop = ${sl}% price move; at ${lev}x that is ${(sl * lev).toFixed(1)}% ROE`;
    }
    if (tpMax && tp1 && tpMax < tp1) hint.textContent += " · TP max < TP1";
  }
}

function markDirty() {
  setDirty(true);
  updateDerived();
}

SETTINGS_ROOT.addEventListener("input", (e) => {
  if (e.target.matches('[data-live-setting="exchange"]')) return;
  if (e.target.matches("[data-setting], [data-live-setting], [data-profile-setting], [data-f], #profileEnabled")) {
    if (e.target.matches('[data-profile-setting="sizingMode"], [data-setting="sizingMode"]')) updateVisibility();
    if (e.target.matches('[data-f="enabled"]')) {
      const row = e.target.closest(".filter-row");
      row.classList.toggle("off", !e.target.checked);
    }
    markDirty();
  }
});
SETTINGS_ROOT.addEventListener("change", (e) => {
  if (e.target.matches('[data-live-setting="exchange"]')) {
    selectActiveExchange(e.target.value);
    return;
  }
  if (e.target.matches("[data-setting], [data-live-setting], [data-profile-setting], [data-f], #profileEnabled")) {
    if (e.target.matches('[data-profile-setting="sizingMode"], [data-setting="sizingMode"]')) updateVisibility();
    if (e.target.matches('[data-f="enabled"]')) {
      const row = e.target.closest(".filter-row");
      row.classList.toggle("off", !e.target.checked);
    }
    markDirty();
  }
});

/* ------------------------------------------------------------------ */
/* Rendering                                                          */
/* ------------------------------------------------------------------ */
function renderStatus() {
  const m = state.meta || {};
  const pill = $("#statusPill");
  const text = $("#statusText");
  pill.className = "status-pill";
  if (m.scanning) {
    pill.classList.add("scanning");
    text.textContent = "Scanning…";
  } else if (m.running) {
    pill.classList.add("running");
    text.textContent = "Running";
  } else if (m.stopReason === "max-trades") {
    pill.classList.add("stopped");
    text.textContent = "Max trades";
  } else {
    pill.classList.add("paused");
    text.textContent = "Paused";
  }

  const toggle = $("#btnToggle");
  const icon = $("#toggleIcon");
  const label = $("#toggleText");
  if (m.running) {
    toggle.classList.remove("primary");
    icon.textContent = "❚❚";
    label.textContent = "Pause bot";
  } else {
    toggle.classList.add("primary");
    icon.textContent = "▶";
    label.textContent = "Start bot";
  }

  const scan = m.lastScan;
  if (scan) {
    const parts = [
      `scan #${m.scanCount || 0}`,
      `${(scan.total || 0).toLocaleString()} coins`,
      `${scan.qualified || 0} qualified`,
      `${scan.ms || 0} ms`,
    ];
    if (scan.error === "no-filters") parts.push("no filters");
    $("#scanInfo").textContent = parts.join(" · ");
  } else {
    $("#scanInfo").textContent = m.marketTotal ? `${m.marketTotal} coins loaded` : "Waiting for data…";
  }

  const total = m.marketTotal || 0;
  $("#feedFoot").textContent = state.venues
    ? `${state.venues.okVenues}/${state.venues.totalVenues} feeds · ${(state.venues.instruments || 0).toLocaleString()} instruments`
    : "--";
  renderBanner();
  renderCountdown();
}

/* CoinGlass feed */
/* CoinGlass connection + live feed                                   */
/* ------------------------------------------------------------------ */
const CG_SORT_LABEL = {
  abs: "biggest OI 5m move",
  oiDesc: "OI 5m high → low",
  oiAsc: "OI 5m low → high",
  volDesc: "volume 1h high → low",
  volAsc: "volume 1h low → high",
};

function cgInfo() {
  return state.meta?.coinglass || state.meta?.marketStatus || {};
}

function cgAge(cg) {
  if (cg.lastSuccessAt) {
    return Math.max(0, Date.now() + num(state.serverOffset) - num(cg.lastSuccessAt));
  }
  return cg.ageMs ?? null;
}

function renderConnection() {
  const cg = cgInfo();
  const raw = cg.state || (cg.connected ? "connected" : "connecting");
  const kind =
    raw === "connected" && cg.connected !== false
      ? "connected"
      : raw === "connecting" || raw === "idle" || !cg.lastAttemptAt
        ? "connecting"
        : "disconnected";
  const label =
    kind === "connected"
      ? "CoinGlass: connected"
      : kind === "disconnected"
        ? "CoinGlass: disconnected"
        : "CoinGlass: connecting…";
  const badgeLabel = kind === "connected" ? "Connected" : kind === "disconnected" ? "Disconnected" : "Connecting";
  const ageMs = cgAge(cg);

  const tip = [];
  if (cg.lastSuccessAt) tip.push(`last success ${dateTime(cg.lastSuccessAt)}`);
  if (ageMs !== null && ageMs !== undefined) tip.push(`data ${ago(ageMs)}`);
  if (cg.lastLatencyMs !== null && cg.lastLatencyMs !== undefined) tip.push(`${Math.round(num(cg.lastLatencyMs))} ms`);
  if (cg.coins) tip.push(`${num(cg.coins).toLocaleString()} coins`);
  if (cg.lastError) tip.push(`error: ${cg.lastError}`);
  if (cg.consecutiveFailures) tip.push(`${cg.consecutiveFailures} failed attempt(s)`);

  const pill = $("#cgPill");
  if (pill) {
    const name = `status-pill ${kind}`;
    if (pill.className !== name) pill.className = name;
    pill.title = tip.join(" · ") || "CoinGlass scraping status";
  }
  const pillText = $("#cgPillText");
  if (pillText) pillText.textContent = label;

  const badge = $("#cgBadge");
  if (badge) {
    const name = `status-pill ${kind}`;
    if (badge.className !== name) badge.className = name;
  }
  const badgeText = $("#cgBadgeText");
  if (badgeText) badgeText.textContent = badgeLabel;

  const sub = $("#cgSub");
  if (sub) {
    const viaApi = cg.source === "api";
    const viaDevice = cg.source === "device";
    const origin = viaApi
      ? "official CoinGlass API"
      : viaDevice
        ? "this browser (device feed)"
        : "capi.coinglass.com";
    if (kind === "connected") {
      sub.textContent = `Crypto only · live from ${origin} · ${num(
        cg.coins
      ).toLocaleString()} coins · ${num(cg.pages)} pages · updated ${ago(ageMs)}`;
    } else if (kind === "disconnected") {
      const blocked = !viaApi && /403/.test(String(cg.lastError || ""));
      if (blocked && !cg.apiKeySet) {
        sub.textContent =
          "Waiting for this browser to feed data. Keep this tab open, or add an official API key.";
      } else {
        sub.textContent = `${viaApi ? "API" : "Scrape"} failed: ${
          cg.lastError || "unknown error"
        }${cg.lastSuccessAt ? ` · last data ${ago(ageMs)}` : ""}`;
      }
    } else {
      sub.textContent = `Contacting the ${origin}…`;
    }
  }

  renderDeviceBadge();
  renderCgKeyState();
}

function renderCgKeyState() {
  const el = $("#cgKeyState");
  if (!el) return;
  const cg = cgInfo();
  const set = Boolean(
    state.settings?.coinglassKeySet ?? state.meta?.coinglassKeySet ?? cg.apiKeySet
  );
  if (set) {
    const active = cg.source === "api" && cg.connected;
    el.textContent = active
      ? "API key saved: using the official CoinGlass API."
      : "API key saved: waiting for the next refresh.";
  } else {
    el.textContent = "No API key: scraping the public website.";
  }
}

function renderCoinGlassTable() {
  const body = $("#cgBody");
  if (!body) return;
  const foot = $("#cgFoot");
  const updated = $("#cgUpdated");
  const all = state.markets || [];
  const q = (state.cgSearch || "").trim().toLowerCase();

  let rows = all.filter((m) => {
    const oi = m.oi?.["5m"];
    const vol = m.vol?.["1h"];
    return (oi !== null && oi !== undefined) || (vol !== null && vol !== undefined);
  });
  if (q) {
    rows = rows.filter(
      (m) =>
        String(m.symbol || "").toLowerCase().includes(q) ||
        String(m.name || "").toLowerCase().includes(q)
    );
  }

  const value = (m, key) => {
    const v = key === "vol" ? m.vol?.["1h"] : m.oi?.["5m"];
    return v === null || v === undefined || !Number.isFinite(Number(v)) ? NaN : Number(v);
  };
  const sort = CG_SORT_LABEL[state.cgSort] ? state.cgSort : "abs";
  if (sort === "oiDesc") rows.sort((a, b) => value(b, "oi") - value(a, "oi"));
  else if (sort === "oiAsc") rows.sort((a, b) => value(a, "oi") - value(b, "oi"));
  else if (sort === "volDesc") rows.sort((a, b) => value(b, "vol") - value(a, "vol"));
  else if (sort === "volAsc") rows.sort((a, b) => value(a, "vol") - value(b, "vol"));
  else {
    rows.sort(
      (a, b) =>
        Math.abs(value(b, "oi")) - Math.abs(value(a, "oi")) ||
        Math.abs(value(b, "vol")) - Math.abs(value(a, "vol"))
    );
  }

  const limit = 100;
  const shown = rows.slice(0, limit);
  if (!all.length) {
    body.innerHTML = `<tr><td colspan="3" class="empty-row"><b>Waiting for CoinGlass data…</b><p class="empty-desc">The bot is contacting capi.coinglass.com.</p></td></tr>`;
    if (foot) foot.textContent = "No rows yet";
  } else if (!shown.length) {
    body.innerHTML = `<tr><td colspan="3" class="empty-row"><b>No matching coins</b><p class="empty-desc">Try a different search.</p></td></tr>`;
    if (foot) foot.textContent = `0 of ${rows.length} coins`;
  } else {
    body.innerHTML = shown
      .map((m) => {
        const oi = m.oi?.["5m"];
        const vol = m.vol?.["1h"];
        const logo = renderCoinBadge(m.symbol, m.logo);
        return `<tr>
          <td><div class="coin-cell">${logo}<div class="coin-name">${esc(m.symbol)}<small>${esc(m.name || "")}</small></div></div></td>
          <td class="num ${oi === null || oi === undefined ? "" : cls(oi)}">${oi === null || oi === undefined ? "--" : pct(oi)}</td>
          <td class="num ${vol === null || vol === undefined ? "" : cls(vol)}">${vol === null || vol === undefined ? "--" : pct(vol)}</td>
        </tr>`;
      })
      .join("");
    if (foot) {
      foot.textContent = `Showing ${shown.length} of ${rows.length} coins${
        q ? " (filtered)" : ""
      } · sorted by ${CG_SORT_LABEL[sort]}`;
    }
  }

  const cg = cgInfo();
  if (updated) updated.textContent = cg.lastSuccessAt ? `updated ${ago(cgAge(cg))}` : "not scraped yet";
}

function renderBanner() {
  const m = state.meta || {};
  const s = state.stats || {};

  if (m.stopReason === "max-trades") {
    setBanner("max-trades", { level: "warn", message: `Max trades reached (${m.maxTrades}). Download the report, then reset the strategy to run another batch.` });
  } else {
    clearBanner("max-trades");
  }

  if (!m.filtersConfigured && state.loaded) {
    setBanner("no-filters", { level: "info", message: "No filter is configured. Enable at least one OI or Volume row and enter a threshold to start scanning." });
  } else {
    clearBanner("no-filters");
  }

  if (m.marketError) {
    setBanner("market-error", { level: "warn", message: `CoinGlass feed error: ${m.marketError}` });
  } else {
    clearBanner("market-error");
  }

  if (m.marketAgeMs && m.marketAgeMs > 180000) {
    setBanner("market-stale", { level: "warn", message: "Market data is more than 3 minutes old. New trades are paused until the feed recovers." });
  } else {
    clearBanner("market-stale");
  }

  if (m.running && s.available !== undefined && s.available < 1 && s.openTrades > 0) {
    setBanner("no-margin", { level: "warn", message: "No free margin left. New signals will wait until a position closes." });
  } else {
    clearBanner("no-margin");
  }

  const legacyBanner = $("#banner");
  if (legacyBanner) {
    legacyBanner.classList.add("hidden");
  }
}

function renderKpis() {
  const s = state.stats || {};
  const start = state.initialFund || 0;
  const set = (id, value, klass = "") => {
    const el = $(id);
    el.textContent = value;
    el.className = "kpi-value " + klass;
  };

  set("#kpiEquity", money(s.equity ?? start), cls((s.equity ?? start) - start));
  $("#kpiEquitySub").textContent = `start ${money(start)} · cash ${money(s.balance ?? start)}`;

  set("#kpiPnl", signedMoney(s.totalPnl), cls(s.totalPnl));
  $("#kpiPnlSub").textContent = `${pct(s.returnPct)} return · realized ${signedMoney(s.realizedPnl)}`;

  set("#kpiOpen", signedMoney(s.unrealizedPnl), cls(s.unrealizedPnl));
  $("#kpiOpenSub").textContent = `${s.openTrades || 0} open · margin ${money(s.lockedMargin)}`;

  set("#kpiWinrate", `${num(s.winrate).toFixed(1)}%`);
  $("#kpiWinrateSub").textContent = `${s.wins || 0}W / ${s.losses || 0}L`;

  const pf = s.profitFactor === null || s.profitFactor === undefined
    ? (s.grossProfit > 0 ? "∞" : "--")
    : num(s.profitFactor).toFixed(2);
  set("#kpiPf", pf, s.profitFactor !== null && s.profitFactor >= 1 ? "pos" : s.profitFactor !== null ? "neg" : "");
  $("#kpiPfSub").textContent = `${money(s.grossProfit)} / ${money(s.grossLoss)}`;

  set("#kpiDd", money(s.maxDrawdown), s.maxDrawdown > 0 ? "neg" : "");
  $("#kpiDdSub").textContent = `${num(s.maxDrawdownPct).toFixed(2)}% · peak ${money(s.maxDrawdownPeak || start)}`;

  set("#kpiTrades", `${s.totalTrades || 0}`);
  const max = num(state.meta?.maxTrades);
  $("#kpiTradesSub").textContent = max > 0 ? `${Math.max(0, max - (s.totalTrades || 0))} remaining of ${max}` : "unlimited";

  set("#kpiFees", money(s.feesPaid));
  $("#kpiFeesSub").textContent = `closed ${money(s.feesClosed)}`;
}

function renderPositions() {
  const box = $("#positionsBody");
  const list = state.positions || [];
  $("#positionsSub").textContent = list.length
    ? `${list.length} open · margin ${money(state.stats?.lockedMargin)} · free ${money(state.stats?.available)}`
    : "No open positions";
  $("#btnCloseAll").classList.toggle("hidden", !list.length);

  if (!list.length) {
    box.innerHTML = `<div class="pos-empty"><b>No open positions</b>When a coin passes every enabled filter, a paper trade opens here automatically.</div>`;
    return;
  }

  box.innerHTML = list
    .map((p) => {
      const win = num(p.roe) >= 0;
      const logo = p.symbol ? renderCoinBadge(p.symbol) : "";
      return `<article class="position-card ${win ? "win" : "loss"}">
        <div class="pc-head">
          <div class="pc-symbol">${logo}<span>${esc(p.symbol)}</span><span class="side-tag ${esc(p.side)}">${esc(p.side)}</span>${p.tp1Hit ? '<span class="tp1-hit">TP1</span>' : ""}</div>
          <div class="pc-head-right">
            <span class="pc-roe ${win ? "pos" : "neg"}">${pct(p.roe)}</span>
            <button class="btn small ghost" data-close="${esc(p.id)}" type="button">Close</button>
          </div>
        </div>
        <div class="pc-grid">
          <div class="pc-stat"><span>Entry</span><b>${price(p.entryPrice)}</b></div>
          <div class="pc-stat"><span>Mark</span><b class="${p.priceStale ? "" : cls(p.markPrice - p.entryPrice)}" title="${p.priceStale ? "stale quote" : ""}">${price(p.markPrice)}${p.priceStale ? ' <span class="stale-dot"></span>' : ""}</b></div>
          <div class="pc-stat"><span>Net P/L</span><b class="${cls(p.netTotal)}">${signedMoney(p.netTotal)}</b></div>
          <div class="pc-stat"><span>Margin</span><b>${money(p.margin)}</b></div>
          <div class="pc-stat"><span>Qty</span><b>${qty(p.qty)}</b></div>
          <div class="pc-stat"><span>Stop / TP1</span><b>${price(p.stopPrice)} → ${price(p.tp1Price)}</b></div>
        </div>
        <div class="pc-progress">
          <div class="progress-track"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, num(p.progress)))}%"></div></div>
          <div class="progress-labels"><span>SL ${pct(-num(p.slPercent), 1)}</span><span>Entry</span><span>TP1 ${pct(num(p.tp1Percent), 1)}</span></div>
        </div>
        <div class="pc-foot">
          <span class="pc-meta">${esc(p.venueName || p.venue)} · ${num(p.leverage)}x · ${duration(p.ageMs)}${p.trailingActive ? ` · trail ${price(p.trailStopPrice)}` : ""}</span>
          <div class="pc-actions"><span class="subtle">${p.tp1Hit ? "running with trail" : `TP max ${pct(num(p.tpMaxPercent), 0)}`}</span></div>
        </div>
      </article>`;
    })
    .join("");
}

function filterFor(group, key) {
  const list = group === "oi" ? state.settings?.oiFilters : state.settings?.volFilters;
  return (list || []).find((f) => f.key === key);
}

function cellValue(group, key, value) {
  const f = filterFor(group, key);
  const active = f && f.enabled && f.threshold !== null && f.threshold !== undefined;
  if (value === null || value === undefined) {
    return `<td class="num"><span class="val na">--</span></td>`;
  }
  if (!active) {
    return `<td class="num"><span class="val off">${pct(value)}</span></td>`;
  }
  const pass = f.op === "<=" ? num(value) <= num(f.threshold) : num(value) >= num(f.threshold);
  return `<td class="num"><span class="val ${pass ? "pass" : "fail"}" title="needs ${f.op} ${f.threshold}%">${pct(value)}</span></td>`;
}

function marketRoomForMore(m) {
  const openCount = num(m.openCount, m.open ? 1 : 0);
  const perCoin = Math.max(1, num(m.maxPerCoin, 1));
  return openCount < perCoin;
}

/** Coins that pass the filters and could open a trade right now. */
function qualifiedMarkets() {
  return (state.markets || []).filter(
    (m) =>
      m.qualified &&
      m.tradable &&
      !m.excluded &&
      !m.cooling &&
      !m.stale &&
      marketRoomForMore(m)
  );
}
/** Coins that pass the filters but are inside the re-entry delay. */
function coolingMarkets() {
  return (state.markets || []).filter((m) => m.qualified && m.cooling);
}
function nearMarkets() {
  return (state.markets || []).filter(
    (m) => m.configured && !m.qualified && m.total > 0 && m.passCount === m.total - 1
  );
}

function renderMarketTabs() {
  const actionable = qualifiedMarkets().length;
  const cooling = coolingMarkets().length;
  const qTab = $("#tabQualified");
  qTab.textContent = actionable;
  if (qTab.parentElement) {
    qTab.parentElement.title = cooling
      ? `${actionable} tradable now · ${cooling} qualified but cooling down`
      : `${actionable} tradable now`;
  }
  $("#tabNear").textContent = nearMarkets().length;
  $("#tabAll").textContent = (state.markets || []).length;
  $$("#marketTabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.tab));
}

function renderMarkets() {
  const tbody = $("#marketsBody");
  const all = state.markets || [];
  let list =
    state.tab === "qualified" ? qualifiedMarkets() : state.tab === "near" ? nearMarkets() : all;
  if (state.sideFilter && state.sideFilter !== "all") {
    if (state.sideFilter === "conflict") {
      list = list.filter((m) => m.isConflict || m.side === "conflict");
    } else {
      list = list.filter((m) => m.side === state.sideFilter && !m.isConflict);
    }
  }
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter(
      (m) => m.symbol.toLowerCase().includes(q) || String(m.name || "").toLowerCase().includes(q)
    );
  }
  list = [...list].sort((a, b) => {
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    if (a.isConflict !== b.isConflict) return a.isConflict ? 1 : -1;
    if (num(a.passCount) !== num(b.passCount)) return num(b.passCount) - num(a.passCount);
    if (num(a.score) !== num(b.score)) return num(b.score) - num(a.score);
    return num(b.oiUsd) - num(a.oiUsd);
  });

  const limit = 140;
  const shown = list.slice(0, limit);
  renderMarketTabs();

  if (!all.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty-row"><b>Loading CoinGlass data…</b><p class="empty-desc">The first scan downloads the full market table.</p></td></tr>`;
    $("#marketFoot").textContent = "--";
    return;
  }

  if (!shown.length) {
    const cooling = coolingMarkets();
    let msg;
    if (state.tab === "qualified") {
      if (cooling.length) {
        msg = `${cooling.length} coin(s) pass the filters but are waiting for their re-entry delay after a recent trade: ${cooling
          .slice(0, 4)
          .map((m) => `${m.symbol} (${humanDuration(m.coolingRemainingSec)})`)
          .join(", ")}. Open the "coins" tab to see them, or turn Re-enter trade off in Execution settings.`;
      } else {
        msg = state.meta.filtersConfigured
          ? "No coin currently passes every enabled filter. The bot will keep scanning."
          : "No filters configured. Turn on at least one OI or Volume row and set a threshold.";
      }
    } else if (state.tab === "near") {
      msg = "No near-miss coins right now.";
    } else {
      msg = "No coins match this search.";
    }
    tbody.innerHTML = `<tr><td colspan="12" class="empty-row"><b>Nothing here yet</b><p class="empty-desc">${esc(msg)}</p></td></tr>`;
  } else {
    tbody.innerHTML = shown
      .map((m) => {
        const logo = renderCoinBadge(m.symbol, m.logo);
        const openCount = num(m.openCount, m.open ? 1 : 0);
        const perCoin = Math.max(1, num(m.maxPerCoin, 1));
        const roomForMore = openCount < perCoin;
        const coolLeft = Math.max(0, num(m.coolingRemainingSec, 0));
        let signal = `<span class="pass-pill no">off</span>`;
        if (openCount > 0 && !roomForMore) {
          signal = `<span class="pass-pill ready">OPEN${openCount > 1 ? ` ×${openCount}` : ""}</span>`;
        } else if (m.isConflict || m.side === "conflict") {
          signal = `<span class="side-tag conflict" title="Qualified for both Long and Short: skipped">CONFLICT</span>`;
        } else if (m.stale) {
          signal = `<span class="pass-pill no" title="CoinGlass data is stale">STALE</span>`;
        } else if (m.qualified && !m.tradable) {
          signal = `<span class="pass-pill no" title="No exchange price feed for this coin">NO FEED</span>`;
        } else if (m.cooling) {
          signal = `<span class="pass-pill no" title="Re-entry delay">RE-ENTRY ${humanDuration(coolLeft)}</span>`;
        } else if (m.qualified && m.side) {
          signal = `<span class="side-tag ${esc(m.side)}">${esc(m.side)}</span>`;
          if (openCount > 0) signal += ` <span class="pass-pill ready">${openCount}/${perCoin}</span>`;
        } else if (m.configured) signal = `<span class="pass-pill no">${m.passCount}/${m.total}</span>`;
        let venue = m.venue ? `<span class="venue-tag">${esc(m.venue)}</span>` : `<span class="subtle">no feed</span>`;
        if (m.excluded) venue = `<span class="subtle">excluded</span>`;
        const canTrade = m.qualified && roomForMore && m.tradable && !m.excluded && !m.cooling && !m.stale && !m.isConflict;
        let blockShort = "";
        let blockText = "";
        if ((m.qualified || m.isConflict) && !canTrade) {
          if (m.isConflict) {
            blockShort = "Conflict";
            blockText = "Coin qualifies for both Long and Short profiles: skipped to avoid conflicting positions.";
          } else if (m.stale) {
            blockShort = "Stale";
            blockText = "CoinGlass data is more than 2.5 minutes old.";
          } else if (!m.tradable) {
            blockShort = "No feed";
            blockText = "No exchange price feed for this coin.";
          } else if (m.cooling) {
            blockShort = `Delay ${humanDuration(coolLeft)}`;
            blockText = `Re-entry delay: ${humanDuration(coolLeft)} left. Turn "Re-enter trade" off or lower the delay to trade again immediately.`;
          } else if (!roomForMore) {
            blockShort = `Max ${perCoin}`;
            blockText = `Max positions per coin (${perCoin}) already open.`;
          } else if (m.excluded) {
            blockShort = "Excluded";
            blockText = "This symbol is in the excluded list.";
          }
        }
        const tradeCell = canTrade
          ? `<button class="btn small primary row-trade" data-open="${esc(m.symbol)}" data-side="${esc(m.side || 'long')}" type="button">Trade</button>`
          : blockShort
            ? `<button class="btn small row-trade" type="button" disabled title="${esc(blockText)}">${esc(blockShort)}</button>`
            : "";
        return `<tr>
          <td><div class="coin-cell">${logo}<div class="coin-name">${esc(m.symbol)}<small>${esc(m.name || "")}</small></div></div></td>
          <td class="price-cell">${price(m.price)}</td>
          ${cellValue("oi", "5m", m.oi?.["5m"])}
          ${cellValue("oi", "15m", m.oi?.["15m"])}
          ${cellValue("oi", "30m", m.oi?.["30m"])}
          ${cellValue("oi", "1h", m.oi?.["1h"])}
          ${cellValue("oi", "4h", m.oi?.["4h"])}
          ${cellValue("vol", "1h", m.vol?.["1h"])}
          ${cellValue("vol", "4h", m.vol?.["4h"])}
          <td>${venue}</td>
          <td>${signal}</td>
          <td>${tradeCell}</td>
        </tr>`;
      })
      .join("");
  }

  $("#marketFoot").textContent = `Showing ${shown.length} of ${list.length} ${TAB_LABELS[state.tab] || "coins"} · ${all.length.toLocaleString()} coins on CoinGlass · ${(state.meta?.marketTotal || all.length).toLocaleString()} loaded`;
  $("#scannerSub").textContent = state.meta?.lastScan
    ? `${state.meta.lastScan.scanned || 0} evaluated · ${qualifiedMarkets().length} tradable now${
        coolingMarkets().length ? ` · ${coolingMarkets().length} cooling` : ""
      } · ${state.meta.lastScan.ms || 0} ms/scan · data ${
        state.meta.marketAgeMs ? Math.round(state.meta.marketAgeMs / 1000) + "s old" : "fresh"
      }`
    : `${all.length.toLocaleString()} coins loaded`;
  renderMarketMax();
}

function renderMarketMax() {
  for (const el of $$(".cur[data-cur]")) {
    const [group, key] = el.dataset.cur.split(".");
    let best = null;
    for (const m of state.markets || []) {
      const v = m?.[group]?.[key];
      if (v === null || v === undefined) continue;
      if (best === null || v > best) best = v;
    }
    if (best === null) {
      el.textContent = "--";
      el.className = "cur";
    } else {
      el.textContent = pct(best);
      el.className = "cur " + cls(best);
    }
  }
}

function renderTrades() {
  const tbody = $("#tradesBody");
  const q = state.tradeSearch.toLowerCase();
  const list = (state.trades || []).filter(
    (t) =>
      !q ||
      String(t.symbol || "").toLowerCase().includes(q) ||
      String(t.exitReason || "").toLowerCase().includes(q) ||
      String(t.side || "").toLowerCase().includes(q)
  );
  $("#historySub").textContent = `${state.tradesTotal || 0} closed trades · winrate ${num(state.stats?.winrate).toFixed(1)}% · net ${signedMoney(state.stats?.realizedPnl)}`;
  $("#btnLoadMore").classList.toggle("hidden", state.trades.length >= (state.tradesTotal || 0));

  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty-row"><b>No closed trades yet</b><p class="empty-desc">A trade appears here after it hits SL, TP or you close it manually.</p></td></tr>`;
    $("#tradesFoot").textContent = "--";
    return;
  }

  tbody.innerHTML = list
    .map((t) => {
      const win = num(t.pnlNet) >= 0;
      const parts = Array.isArray(t.partials) ? t.partials.length : 0;
      return `<tr>
        <td class="subtle">${dateTime(t.exitTime)}</td>
        <td><strong>${esc(t.symbol)}</strong></td>
        <td><span class="side-tag ${esc(t.side)}">${esc(t.side)}</span></td>
        <td class="price-cell">${price(t.entryPrice)} → ${price(t.exitPrice ?? t.exitPriceAvg)}</td>
        <td class="num mono">${qty(t.qty)}</td>
        <td class="num mono">${money(t.margin)}</td>
        <td class="num mono ${win ? "pos" : "neg"}">${signedMoney(t.pnlNet)}</td>
        <td class="num mono ${num(t.roe) >= 0 ? "pos" : "neg"}">${pct(t.roe)}</td>
        <td class="num mono subtle">${money(t.feesPaid)}</td>
        <td><span class="venue-tag" title="${parts} partial exit(s)">${esc(t.exitReason || "--")}${parts > 1 ? ` · ${parts}` : ""}</span></td>
        <td class="num subtle">${duration(t.durationMs)}</td>
        <td class="subtle">${esc(t.venueName || t.venue || "--")}</td>
      </tr>`;
    })
    .join("");
  $("#tradesFoot").textContent = `Showing ${list.length} of ${state.tradesTotal} closed trades`;
}

function renderLogs() {
  const box = $("#logsList");
  const list = (state.logs || []).filter((l) => l.t > state.logCutoff).slice(-80).reverse();
  if (!list.length) {
    box.innerHTML = `<div class="log-line"><span class="log-msg">No activity yet.</span></div>`;
    return;
  }
  box.innerHTML = list
    .map(
      (l) =>
        `<div class="log-line"><span class="log-time">${time(l.t)}</span><span class="log-level ${esc(l.level)}">${esc(l.level.toUpperCase())}</span><span class="log-msg">${esc(l.msg)}</span></div>`
    )
    .join("");
}

/* ------------------------------------------------------------------ */
/* Chart                                                              */
/* ------------------------------------------------------------------ */
function drawChart() {
  const canvas = $("#equityChart");
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = rect.width;
  const h = rect.height;
  const padL = 48;
  const padR = 12;
  const padT = 14;
  const padB = 22;
  const iw = w - padL - padR;
  const ih = h - padT - padB;

  let points = (state.equityCurve || []).filter((p) => Number.isFinite(num(p.equity, NaN)));
  if (points.length === 0) points = [{ t: Date.now(), equity: state.stats?.equity ?? state.initialFund }];
  if (points.length === 1) points = [{ t: points[0].t - 1000, equity: state.initialFund }, ...points];
  if (points.length > 700) {
    const step = Math.ceil(points.length / 700);
    points = points.filter((_, i) => i % step === 0 || i === points.length - 1);
  }

  const values = points.map((p) => num(p.equity));
  const initial = num(state.initialFund, values[0]);
  values.push(initial);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const spread = Math.max(0.01, max - min);
  const pad = Math.max(spread * 0.14, Math.abs(initial) * 0.004, 0.25);
  min -= pad;
  max += pad;

  const t0 = num(points[0].t);
  const t1 = num(points[points.length - 1].t);
  const span = Math.max(1, t1 - t0);
  const x = (t) => padL + ((num(t) - t0) / span) * iw;
  const y = (v) => padT + (1 - (num(v) - min) / (max - min)) * ih;

  ctx.clearRect(0, 0, w, h);

  // Grid + y labels
  ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 4; i++) {
    const v = min + ((max - min) * i) / 4;
    const yy = y(v);
    ctx.strokeStyle = "rgba(38,56,77,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(w - padR, yy);
    ctx.stroke();
    ctx.fillStyle = "#5d7088";
    ctx.textAlign = "right";
    ctx.fillText("$" + compact(v), padL - 7, yy);
  }

  // Initial fund line
  const iy = y(initial);
  ctx.strokeStyle = "rgba(139,156,177,0.55)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(padL, iy);
  ctx.lineTo(w - padR, iy);
  ctx.stroke();
  ctx.setLineDash([]);

  const last = num(points[points.length - 1].equity);
  const up = last >= initial;
  const stroke = up ? "#16d39a" : "#ff5d6c";

  // Area
  const grad = ctx.createLinearGradient(0, padT, 0, padT + ih);
  grad.addColorStop(0, up ? "rgba(22,211,154,0.25)" : "rgba(255,93,108,0.22)");
  grad.addColorStop(1, "rgba(22,211,154,0)");
  ctx.beginPath();
  points.forEach((p, i) => {
    const xx = x(p.t);
    const yy = y(p.equity);
    if (i === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.lineTo(x(points[points.length - 1].t), padT + ih);
  ctx.lineTo(x(points[0].t), padT + ih);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  points.forEach((p, i) => {
    const xx = x(p.t);
    const yy = y(p.equity);
    if (i === 0) ctx.moveTo(xx, yy);
    else ctx.lineTo(xx, yy);
  });
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  // Last point glow
  const lx = x(points[points.length - 1].t);
  const ly = y(last);
  ctx.beginPath();
  ctx.arc(lx, ly, 7, 0, Math.PI * 2);
  ctx.fillStyle = up ? "rgba(22,211,154,0.16)" : "rgba(255,93,108,0.16)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(lx, ly, 3, 0, Math.PI * 2);
  ctx.fillStyle = stroke;
  ctx.fill();
  ctx.strokeStyle = "#0b1220";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // X labels
  ctx.fillStyle = "#5d7088";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
  const days = span > 86400000;
  ctx.fillText(days ? dateTime(points[0].t).slice(0, 12) : time(points[0].t), padL, h - padB + 6);
  ctx.textAlign = "right";
  ctx.fillText(days ? dateTime(points[points.length - 1].t).slice(0, 12) : time(points[points.length - 1].t), w - padR, h - padB + 6);

  // Hover crosshair
  if (state.chart.hover !== null && points[state.chart.hover]) {
    const hp = points[state.chart.hover];
    const hx = x(hp.t);
    const hy = y(hp.equity);
    ctx.strokeStyle = "rgba(139,156,177,0.45)";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hx, padT);
    ctx.lineTo(hx, padT + ih);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(hx, hy, 4, 0, Math.PI * 2);
    ctx.fillStyle = stroke;
    ctx.fill();
    ctx.strokeStyle = "#0b1220";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  state.chart.points = points.map((p) => ({ x: x(p.t), y: y(p.equity), t: p.t, equity: num(p.equity) }));
  state.chart.geom = { w, h, padT, padB, span };

  const peak = Math.max(...values);
  const dd = peak - last;
  $("#chartSub").textContent = `${points.length} samples · peak ${money(peak)} · drawdown ${money(dd)}`;
}

function chartHover(e) {
  const canvas = $("#equityChart");
  const pts = state.chart.points || [];
  if (!pts.length) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  let best = 0;
  let bestD = Infinity;
  pts.forEach((p, i) => {
    const d = Math.abs(p.x - mx);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (bestD > 40) {
    state.chart.hover = null;
    $("#chartTooltip").classList.add("hidden");
  } else {
    state.chart.hover = best;
    const p = pts[best];
    const tip = $("#chartTooltip");
    tip.classList.remove("hidden");
    tip.innerHTML = `<div class="t">${esc(dateTime(p.t))}</div><div class="v">${money(p.equity)}</div>`;
    const wrapRect = canvas.parentElement.getBoundingClientRect();
    tip.style.left = `${canvas.offsetLeft + p.x}px`;
    tip.style.top = `${canvas.offsetTop + p.y}px`;
  }
  drawChart();
}

/* ------------------------------------------------------------------ */
/* Load + poll                                                        */
/* ------------------------------------------------------------------ */
function applyBootstrap(data) {
  state.settings = data.settings;
  state.initialFund = data.initialFund;
  state.meta = data.meta || {};
  state.stats = data.stats || {};
  state.positions = data.positions || [];
  state.markets = data.markets || [];
  state.trades = data.trades || [];
  state.tradesTotal = data.tradesTotal || 0;
  state.equityCurve = data.equityCurve || [];
  state.logs = data.logs || [];
  state.venues = data.venues || { venues: [] };
  state.serverOffset = num(data.serverTime) - Date.now();
  state.prevTrades = num(state.stats.totalTrades);
  state.loaded = true;
  state.maxTradesNotified = state.meta.stopReason === "max-trades";
  localStorage.setItem("oiSniperSettings", JSON.stringify(state.settings));
  renderSettingsForm();
  renderAll();
}

function renderAll() {
  renderModeState();
  renderStatus();
  renderConnection();
  renderKpis();
  renderPositions();
  renderMarkets();
  renderCoinGlassTable();
  drawChart();
  renderTrades();
  renderLogs();
}

async function loadBootstrap() {
  try {
    const data = await api("/api/bootstrap");
    applyBootstrap(data);
    state.requestErrors = 0;
    clearServerError();

    // Auto-import strategy preset from URL hash if present
    if (window.location.hash && window.location.hash.startsWith("#preset=")) {
      try {
        const preset = parsePresetHash(window.location.hash);
        const prevKey = state.settings?.coinglassApiKey;
        state.settings = deepMerge(state.settings || {}, preset);
        if (prevKey && !state.settings.coinglassApiKey) {
          state.settings.coinglassApiKey = prevKey;
        }
        await api("/api/settings", { method: "POST", body: { settings: state.settings } });
        renderSettingsForm();
        toast("Preset loaded", "success", "Imported strategy settings from URL preset (API keys stripped).");
        history.replaceState(null, "", window.location.pathname);
      } catch (err) {
        toast("Preset error", "error", "Failed to load preset link: " + err.message);
      }
    }
  } catch (err) {
    state.requestErrors++;
    noteServerError(err);
    if (state.requestErrors === 1) toast("Cannot reach the bot server", "error", err.message);
    const wait = state.serverPausedUntil > Date.now() ? 15000 : Math.min(30000, 2500 * state.requestErrors);
    setTimeout(loadBootstrap, wait);
  }
}

let liveBusy = false;
async function refreshLive() {
  if (liveBusy) return;
  liveBusy = true;
  try {
    const data = await api("/api/live");
    state.meta = data.meta || state.meta;
    state.stats = data.stats || state.stats;
    state.positions = data.positions || [];
    state.equityCurve = data.equityCurve || state.equityCurve;
    state.logs = data.logs || state.logs;
    state.venues = data.venues || state.venues;
    state.serverOffset = num(data.serverTime) - Date.now();
    state.requestErrors = 0;
    notificationManager.handlePositions(state.positions);
    notificationManager.handleRunningState(state.meta?.running, state.meta?.stopReason);

    if (num(state.stats.totalTrades) > num(state.prevTrades)) {
      const prev = num(state.prevTrades);
      state.prevTrades = num(state.stats.totalTrades);
      await refreshTrades();
      const t = state.trades[0];
      if (t) {
        toast(
          `Closed ${t.symbol} ${num(t.pnlNet) >= 0 ? "in profit" : "at a loss"}`,
          num(t.pnlNet) >= 0 ? "success" : "error",
          `${signedMoney(t.pnlNet)} · ${pct(t.roe)} · ${t.exitReason}`
        );
      }
      refreshMarkets();
    }

    if (state.meta.stopReason === "max-trades" && !state.maxTradesNotified) {
      state.maxTradesNotified = true;
      toast("Max trades reached", "warn", "Download the report or reset to run another batch.");
    }
    if (state.meta.stopReason !== "max-trades") state.maxTradesNotified = false;

    renderStatus();
    renderConnection();
    renderKpis();
    renderPositions();
    drawChart();
    renderLogs();
    renderMarketTabs();
  } catch (err) {
    state.requestErrors++;
    noteServerError(err);
  } finally {
    liveBusy = false;
  }
}

let marketsBusy = false;
async function refreshMarkets() {
  if (marketsBusy) return;
  // When the browser is feeding the engine, the rows are already live locally;
  // only re-read the server view occasionally for meta/flags.
  if (state.device.enabled && Date.now() - (state.lastServerMarketsAt || 0) < 5000) return;
  state.lastServerMarketsAt = Date.now();
  marketsBusy = true;
  try {
    const data = await api("/api/markets");
    state.markets = data.markets || [];
    state.meta = data.meta || state.meta;
    state.venues = data.venues || state.venues;
    renderStatus();
    renderConnection();
    renderMarkets();
    renderCoinGlassTable();
    buildVenueToggles();
    renderVenueStatus();
  } catch (err) {
    noteServerError(err);
    /* keep old data */
  } finally {
    marketsBusy = false;
  }
}

let dashBusy = false;
/**
 * One request per tick for both live state and the market table.
 *
 * Cloudflare's free plan allows 100,000 Durable Object requests per day, and
 * every fetch, alarm and WebSocket message counts. Polling /api/live and
 * /api/markets separately used ~144k/day on its own, so they are merged here.
 */
async function refreshDashboard() {
  if (dashBusy) return;
  // Follower tabs poll slowly so a second open tab cannot double the bill.
  if (!isLeader() && Date.now() - lastFollowerPollAt < 25000) return;
  if (Date.now() < state.serverPausedUntil) {
    renderServerNotice();
    return;
  }
  // A Durable Object can still be running code from before /api/dashboard
  // existed; fall back to the two old endpoints instead of breaking the UI.
  if (state.legacyApi) {
    await refreshLive();
    await refreshMarkets();
    return;
  }
  dashBusy = true;
  try {
    const data = await api("/api/dashboard");
    state.meta = data.meta || state.meta;
    state.stats = data.stats || state.stats;
    state.positions = data.positions || [];
    state.equityCurve = data.equityCurve || state.equityCurve;
    state.logs = data.logs || state.logs;
    state.venues = data.venues || state.venues;
    state.markets = data.markets || [];
    state.serverOffset = num(data.serverTime) - Date.now();
    state.requestErrors = 0;
    lastFollowerPollAt = Date.now();
    clearServerError();

    // Keep the locally scraped numbers on top of the server snapshot.
    if (state.device.enabled && state.device.coins.length) {
      applyLiveRows(state.device.coins);
    }

    if (num(state.stats.totalTrades) > num(state.prevTrades)) {
      const prev = num(state.prevTrades);
      state.prevTrades = num(state.stats.totalTrades);
      await refreshTrades();
      const t = state.trades[0];
      if (t) {
        toast(
          `Closed ${t.symbol} ${num(t.pnlNet) >= 0 ? "in profit" : "at a loss"}`,
          num(t.pnlNet) >= 0 ? "success" : "error",
          `${signedMoney(t.pnlNet)} · ${pct(t.roe)} · ${t.exitReason}`
        );
      }
    }

    if (state.meta.stopReason === "max-trades" && !state.maxTradesNotified) {
      state.maxTradesNotified = true;
      toast("Max trades reached", "warn", "Download the report or reset to run another batch.");
    }
    if (state.meta.stopReason !== "max-trades") state.maxTradesNotified = false;

    renderStatus();
    renderConnection();
    renderKpis();
    renderPositions();
    drawChart();
    renderLogs();
    renderMarkets();
    renderCoinGlassTable();
    buildVenueToggles();
    renderVenueStatus();
  } catch (err) {
    if (err.status === 404) {
      state.legacyApi = true;
      state.requestErrors = 0;
    } else {
      state.requestErrors++;
      noteServerError(err);
    }
  } finally {
    dashBusy = false;
  }
}

/* Device feed: browser scrapes CoinGlass and pushes data to engine */
const DEVICE_FAST_MS = 700;
const DEVICE_FULL_MS = 30000;
// One POST every 5s keeps the engine fresh without burning the DO quota
// (2s would be 43k requests/day on its own).
const DEVICE_PUSH_MS = 5000;
const DEVICE_MAX_ERRORS = 3;

/* ------------------------------------------------------------------ */
/* Single-tab leader lock                                              */
/* ------------------------------------------------------------------ */
// Every tab that pushes the device feed or polls the API costs Durable
// Object requests. Two tabs would roughly double the free-tier budget, so
// one tab is elected leader (localStorage heartbeat) and does the pushing;
// the others only poll slowly and take over within ~10s if the leader dies.
const TAB_ID = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const LEADER_KEY = "oiSniperLeader";
const LEADER_STALE_MS = 9000;
let leaderStorageOk = true;

function readLeader() {
  let raw;
  try {
    raw = localStorage.getItem(LEADER_KEY);
  } catch {
    leaderStorageOk = false;
    return null;
  }
  if (!raw) return null;
  try {
    const val = JSON.parse(raw);
    return val && typeof val.ts === "number" && val.id ? val : null;
  } catch {
    return null; // corrupt entry: treat as no leader
  }
}

function claimLeader(force = false) {
  if (!leaderStorageOk) return true;
  const cur = readLeader();
  const stale = !cur || Date.now() - cur.ts > LEADER_STALE_MS;
  if (!force && !stale && cur.id !== TAB_ID) return false;
  try {
    localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, ts: Date.now() }));
    return true;
  } catch {
    leaderStorageOk = false;
    return true;
  }
}

function isLeader() {
  if (!leaderStorageOk) return true;
  const cur = readLeader();
  return Boolean(cur && cur.id === TAB_ID && Date.now() - cur.ts <= LEADER_STALE_MS);
}

let leaderHeartbeat = null;
function startLeaderHeartbeat() {
  if (leaderHeartbeat) return;
  leaderHeartbeat = setInterval(() => {
    claimLeader();
    renderDeviceBadge();
  }, 3000);
}

// Followers still poll, but only once every ~25s: enough to notice that the
// leader tab was closed, without paying for a second full poll rate.
let lastFollowerPollAt = 0;

function deviceModeActive() {
  const keySet = state.settings?.coinglassKeySet ?? state.meta?.coinglassKeySet;
  return !keySet;
}

/** Copy fresh numbers into the server-enriched rows so the table repaints now. */
function applyLiveRows(freshCoins) {
  if (!freshCoins?.length) return;
  const by = new Map(freshCoins.map((c) => [c.symbol, c]));
  let touched = false;
  for (const row of state.markets || []) {
    const f = by.get(row.symbol);
    if (!f) continue;
    row.oi = f.oi;
    row.vol = f.vol;
    if (f.price !== null && f.price !== undefined) row.price = f.price;
    row.oiUsd = f.oiUsd;
    row.volUsd24h = f.volUsd24h;
    touched = true;
  }
  if (touched) {
    renderCoinGlassTable();
    renderMarkets();
  }
}

function renderDeviceBadge() {
  const el = $("#cgDevice");
  if (!el) return;
  const d = state.device;
  if (!deviceModeActive()) {
    el.textContent = "";
    el.className = "cg-device hidden";
    return;
  }
  el.classList.remove("hidden");
  if (d.enabled) {
    el.className = "cg-device on";
    const who = isLeader() ? "this tab" : "another tab";
    el.textContent = `device feed · ${who} feeding · top ${d.coins.length} coins · ${Math.round(d.latencyMs || 0)} ms`;
  } else if (d.pausedUntil > Date.now()) {
    el.className = "cg-device off";
    el.textContent = "device feed paused (retrying)…";
  } else {
    el.className = "cg-device";
    el.textContent = d.busy ? "device feed: scraping…" : "device feed idle";
  }
}

async function pushDeviceFeed(meta, { merge = false, coins = null } = {}) {
  const rows = coins || state.device.coins;
  if (!rows?.length) return;
  // Only the elected tab pushes; a second tab would double the DO requests.
  if (!isLeader()) return;
  // The server is over quota / down: do not add failed requests.
  if (Date.now() < state.serverPausedUntil) return;
  try {
    await api("/api/device/market", {
      method: "POST",
      body: {
        coins: rows,
        total: meta?.total ?? state.device.coins.length,
        pages: meta?.pages ?? 1,
        fetchedAt: Date.now(),
        fetchedInMs: state.device.latencyMs,
        merge,
      },
    });
    state.device.lastPushAt = Date.now();
  } catch (err) {
    noteServerError(err);
    /* the next tick retries */
  }
}

let deviceFastBusy = false;
async function deviceFastTick() {
  if (!state.loaded || !deviceModeActive()) return;
  if (Date.now() < state.device.pausedUntil || Date.now() < state.serverPausedUntil) return;
  if (deviceFastBusy) return;
  deviceFastBusy = true;
  try {
    const res = await fetchTopMarkets();
    state.device.enabled = true;
    state.device.errors = 0;
    state.device.latencyMs = res.fetchedInMs;
    state.device.lastFetchAt = Date.now();
    state.device.coins = mergeTopRows(state.device.coins, res.coins);
    applyLiveRows(res.coins);
    renderDeviceBadge();
    if (Date.now() - state.device.lastPushAt >= DEVICE_PUSH_MS) {
      state.device.lastPushAt = Date.now();
      // Fast lane: only the top-100 rows, merged into the server's table.
      pushDeviceFeed(res, { merge: true, coins: res.coins }).catch(() => {});
    }
  } catch {
    state.device.errors++;
    if (state.device.errors >= DEVICE_MAX_ERRORS) {
      state.device.enabled = false;
      state.device.pausedUntil = Date.now() + 15000;
      state.device.errors = 0;
      renderDeviceBadge();
    }
  } finally {
    deviceFastBusy = false;
  }
}

let deviceFullBusy = false;
async function deviceFullTick() {
  if (!state.loaded || !deviceModeActive()) return;
  if (Date.now() < state.device.pausedUntil || Date.now() < state.serverPausedUntil) return;
  if (deviceFullBusy) return;
  deviceFullBusy = true;
  try {
    const res = await fetchCoinMarkets();
    state.device.coins = res.coins;
    state.device.enabled = true;
    state.device.errors = 0;
    state.device.latencyMs = res.fetchedInMs;
    applyLiveRows(res.coins);
    renderDeviceBadge();
    await pushDeviceFeed(res, { coins: res.coins });
  } catch {
    /* the fast tick keeps the top rows alive */
  } finally {
    deviceFullBusy = false;
  }
}

let deviceFeedStarted = false;
function startDeviceFeed() {
  // The leader lock matters even with an API key: it also gates dashboard polls.
  claimLeader();
  startLeaderHeartbeat();
  renderDeviceBadge();
  if (!deviceModeActive()) return;
  // Called on page load and on Start; avoid duplicate scrape loops.
  if (deviceFeedStarted) return;
  deviceFeedStarted = true;
  deviceFullTick();
  deviceFastTick();
  // Unlike the dashboard poll, the device feed must keep running when the tab
  // is hidden: the browser throttles it to ~1/min, which is why the engine
  // accepts a feed up to 90s old.
  deviceLoop(deviceFastTick, DEVICE_FAST_MS);
  deviceLoop(deviceFullTick, DEVICE_FULL_MS);
}

function renderVenueStatus() {
  const v = state.venues || {};
  const el = $("#venueStatus");
  if (el) {
    el.textContent = `${v.okVenues || 0}/${v.totalVenues || 0} online · ${(v.instruments || 0).toLocaleString()} instruments`;
    el.className = "venue-status " + ((v.okVenues || 0) === 0 ? "neg" : v.okVenues < v.totalVenues ? "" : "pos");
    if ((v.okVenues || 0) < (v.totalVenues || 0)) el.style.color = "var(--amber)";
    else el.style.color = "";
  }
}

let tradesBusy = false;
async function refreshTrades(append = false) {
  if (tradesBusy) return;
  tradesBusy = true;
  try {
    const offset = append ? state.trades.length : 0;
    const data = await api(`/api/trades?limit=100&offset=${offset}`);
    if (append) state.trades = [...state.trades, ...(data.trades || [])];
    else state.trades = data.trades || [];
    state.tradesTotal = data.total || 0;
    state.prevTrades = num(state.stats.totalTrades);
    renderTrades();
    notificationManager.handleTrades(state.trades);
  } catch {
    /* ignore */
  } finally {
    tradesBusy = false;
  }
}

function renderCountdown() {
  const el = $("#scanCountdown");
  const m = state.meta || {};
  if (!m.running) {
    el.textContent = m.stopReason === "max-trades" ? "max trades reached" : "bot paused";
    return;
  }
  if (m.scanning) {
    el.textContent = "scanning now…";
    return;
  }
  if (!m.nextScanAt) {
    el.textContent = "waiting…";
    return;
  }
  const left = Math.max(0, Math.ceil((num(m.nextScanAt) - (Date.now() + state.serverOffset)) / 1000));
  el.textContent = `next scan in ${left}s`;
}

function tickClock() {
  $("#clock").textContent = time(Date.now());
  renderConnection();
  renderCountdown();
}

/* ------------------------------------------------------------------ */
/* Actions                                                            */
/* ------------------------------------------------------------------ */
async function saveSettings() {
  const btn = $("#btnSave");
  btn.disabled = true;
  const payload = collectSettings();
  try {
    const res = await api("/api/settings", { method: "POST", body: { settings: payload } });
    state.settings = res.settings;
    state.initialFund = res.settings.totalFund;
    state.stats = res.stats || state.stats;
    localStorage.setItem("oiSniperSettings", JSON.stringify(state.settings));
    renderSettingsForm();
    renderModeState();
    toast(res.reset ? "Settings saved: account reset" : "Settings saved", "success", res.reset ? "Total fund changed, so paper history was cleared." : "New trades use the new rules immediately.");
    await refreshLive();
    await refreshMarkets();
    await refreshTrades();
  } catch (err) {
    toast("Could not save settings", "error", err.message);
  } finally {
    btn.disabled = false;
  }
}

async function control(action, confirmText) {
  if (confirmText && !window.confirm(confirmText)) return;
  try {
    const res = await api("/api/control", { method: "POST", body: { action } });
    if (action === "start" && res.ok === false) {
      toast("Cannot start", "error", res.error === "max-trades-reached" ? "Max trades reached. Reset the strategy first." : res.error);
      return;
    }
    if (action === "reset") {
      state.maxTradesNotified = false;
      await loadBootstrap();
      toast("Strategy reset", "success", "Trades, PnL and history cleared. Settings kept.");
      refreshMarkets();
      return;
    }
    if (action === "close-all") {
      toast(`Closed ${res.closed || 0} position(s)`, "info");
    }
    await refreshLive();
    await refreshMarkets();
    if (action === "pause") toast("Bot paused", "warn", "Open positions are still managed.");
    if (action === "start") {
      // The click is also the signal to start scraping from this device.
      startDeviceFeed();
      toast("Bot started", "success", deviceModeActive() ? "Scanning for signals · device feed running in this tab." : "Scanning for signals…");
    }
  } catch (err) {
    toast("Action failed", "error", err.message);
  }
}

async function manualOpen(symbol, side = null, button = null) {
  if (button) button.disabled = true;
  try {
    const res = await api("/api/trade/open", {
      method: "POST",
      body: { symbol, side, force: true },
    });
    const p = res.position;
    toast(`Opened ${p.side.toUpperCase()} ${p.symbol}`, "success", `@ ${price(p.entryPrice)} · ${money(p.margin)} margin`);
    await refreshLive();
    await refreshMarkets();
  } catch (err) {
    const payload = err.payload || {};
    const map = {
      "cannot-open": "Not enough free margin, max positions reached, or an opposite position is already open.",
      "already-open": "This coin already has the maximum number of open positions (see Max positions per coin).",
      "coin-not-found": "Coin is not in the current CoinGlass table.",
      "no-price-feed": "No exchange price feed available for this coin.",
      "max-open": "Max open positions reached.",
      "cooling": `Re-entry delay: ${humanDuration(payload.remainingSec)} left. Turn "Re-enter trade" off or lower the delay to re-enter immediately.`,
    };
    let sub = map[err.message] || err.message;
    if (err.message === "cannot-open" && payload.reason) {
      const reasons = {
        "no-margin": `Not enough free margin: needs ${money(payload.requiredMargin || 0)}, ${money(payload.available || 0)} available.`,
        "coin-cap": "Max positions per coin already open.",
        "max-open": "Max open positions reached.",
        "cooling": "Still in the re-entry delay.",
        "opposite-position": "One-way mode: cannot open opposite trade on a coin with an active position.",
        "conflict": "Coin qualifies for both Long and Short profiles.",
        "no-feed": "No exchange price feed for this coin.",
        "stale": "CoinGlass data is stale.",
        "no-size": "Position size rounds to zero: check the sizing settings.",
      };
      sub = reasons[payload.reason] || sub;
    }
    toast("Trade not opened", "error", sub);
  } finally {
    if (button) button.disabled = false;
  }
}

async function closePosition(id, button) {
  if (button) button.disabled = true;
  try {
    const res = await api("/api/trade/close", { method: "POST", body: { id } });
    toast("Position closed", res.trade && res.trade.pnlNet >= 0 ? "success" : "warn", res.trade ? `${signedMoney(res.trade.pnlNet)} · ${res.trade.exitReason}` : "");
    await refreshLive();
    await refreshTrades();
    await refreshMarkets();
  } catch (err) {
    toast("Close failed", "error", err.message);
    if (button) button.disabled = false;
  }
}

async function manualScan() {
  const btn = $("#btnScan");
  btn.disabled = true;
  btn.textContent = "Scanning…";
  try {
    const res = await api("/api/scan", { method: "POST", body: {} });
    if (res.error === "no-filters") {
      toast("No filters configured", "warn", "Enable at least one OI or Volume row and set a threshold.");
    } else if (res.error === "already-scanning") {
      toast("A scan is already running", "info");
    } else if (res.dryRun) {
      toast(`Manual scan: ${res.qualified || 0} qualified`, "info", "Bot is paused, so no trades were opened.");
    } else {
      toast(
        res.opened ? `Opened ${res.opened} trade${res.opened > 1 ? "s" : ""}` : "Scan complete",
        res.opened ? "success" : "info",
        `${res.qualified || 0} qualified · ${res.total || 0} coins · ${res.ms || 0} ms`
      );
    }
    await refreshLive();
    await refreshMarkets();
  } catch (err) {
    toast("Scan failed", "error", err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Scan now";
  }
}

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */
async function saveCgKey(clear) {
  const input = $("#cgApiKey");
  const key = clear ? "" : String(input?.value || "").trim();
  if (!clear && !key) {
    toast("Paste a key first", "info", "Leave the field empty to keep scraping the website.");
    return;
  }
  try {
    const res = await api("/api/coinglass/key", {
      method: "POST",
      body: clear ? { clear: true } : { apiKey: key },
    });
    if (res.settings) state.settings = res.settings;
    if (input) input.value = "";
    renderSettingsForm();
    toast(
      clear ? "API key cleared" : "API key saved",
      "success",
      clear ? "Falling back to website scraping." : "The bot will use the official CoinGlass API."
    );
    await refreshLive();
    await refreshMarkets();
  } catch (err) {
    toast("Could not update the API key", "error", err.message);
  }
}

$("#btnSaveCgKey").addEventListener("click", () => saveCgKey(false));
$("#btnClearCgKey").addEventListener("click", () => saveCgKey(true));
$("#btnToggle").addEventListener("click", () => control(state.meta?.running ? "pause" : "start"));
$("#btnScan").addEventListener("click", manualScan);
$("#btnSave").addEventListener("click", saveSettings);
$("#btnRevert").addEventListener("click", () => {
  renderSettingsForm();
  toast("Changes reverted", "info");
});
$("#btnReset").addEventListener("click", () =>
  control("reset", "Reset the paper account?\n\nThis clears all trades, PnL, equity curve and history. Your settings are kept.")
);
$("#btnReset2").addEventListener("click", () =>
  control("reset", "Reset the paper account?\n\nThis clears all trades, PnL, equity curve and history. Your settings are kept.")
);
$("#btnCloseAll").addEventListener("click", () =>
  control("close-all", "Close every open paper position at the current market price?")
);
$("#btnReport").addEventListener("click", () => {
  window.location.href = "/api/report?format=html&download=1";
});
$("#btnTradesCsv").addEventListener("click", () => {
  window.location.href = "/api/report?format=csv&download=1";
});

$("#marketTabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  state.tab = tab.dataset.tab;
  renderMarkets();
});
$("#marketSearch").addEventListener("input", (e) => {
  state.search = e.target.value.trim();
  renderMarkets();
});
$("#cgSearch").addEventListener("input", (e) => {
  state.cgSearch = e.target.value.trim();
  renderCoinGlassTable();
});
$("#cgSort").addEventListener("change", (e) => {
  state.cgSort = e.target.value;
  renderCoinGlassTable();
});
$("#tradeSearch").addEventListener("input", (e) => {
  state.tradeSearch = e.target.value.trim();
  renderTrades();
});
$("#btnLoadMore").addEventListener("click", () => refreshTrades(true));
$("#btnClearLogs").addEventListener("click", () => {
  state.logCutoff = Date.now();
  renderLogs();
});
$("#btnDownloadLogs").addEventListener("click", () => {
  window.location.href = "/api/logs?download=1";
  toast("Preparing log download", "info", "Includes bot activity logs plus collected trade dataset records.");
});

$("#marketsBody").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-open]");
  if (btn) manualOpen(btn.dataset.open, btn.dataset.side || null, btn);
});
$("#positionsBody").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-close]");
  if (btn) closePosition(btn.dataset.close, btn);
});

$("#profileTabs")?.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-profile]");
  if (!btn || btn.dataset.profile === state.activeProfile) return;
  collectCurrentProfile();
  state.activeProfile = btn.dataset.profile;
  renderSettingsForm();
});

$("#marketSideFilter")?.addEventListener("change", (e) => {
  state.sideFilter = e.target.value;
  renderMarkets();
});

$("#equityChart").addEventListener("mousemove", chartHover);
$("#equityChart").addEventListener("mouseleave", () => {
  state.chart.hover = null;
  $("#chartTooltip").classList.add("hidden");
  drawChart();
});

window.addEventListener("resize", () => {
  clearTimeout(window.__chartResize);
  window.__chartResize = setTimeout(drawChart, 150);
});
window.addEventListener("beforeunload", () => {
  if (state.dirty) return "You have unsaved settings.";
});

/* ------------------------------------------------------------------ */
/* Poll loops                                                         */
/* ------------------------------------------------------------------ */
function loop(fn, ms) {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    if (!document.hidden) {
      try {
        await fn();
      } catch {
        /* individual functions handle errors */
      }
    }
    setTimeout(run, ms);
  };
  setTimeout(run, ms);
  return () => {
    stopped = true;
  };
}

/**
 * Same as loop() but keeps running in a hidden tab. Browser throttles
 * background timers, so this cannot guarantee an exact rate: it does not stop
 * on purpose. The engine accepts a device feed up to 90s old.
 */
function deviceLoop(fn, ms) {
  let stopped = false;
  const run = async () => {
    if (stopped) return;
    try {
      await fn();
    } catch {
      /* individual functions handle errors */
    }
    setTimeout(run, ms);
  };
  setTimeout(run, ms);
  return () => {
    stopped = true;
  };
}

/* ------------------------------------------------------------------ */
/* Strategy Presets & Preset Link Encoding                            */
/* ------------------------------------------------------------------ */
export { PRESETS, createPresetHash, parsePresetHash };

/* ------------------------------------------------------------------ */
/* Browser Desktop Notifications Manager                              */
/* ------------------------------------------------------------------ */
export const notificationManager = {
  enabled: false,
  lastStaleNoticeAt: 0,
  lastBotRunning: null,
  knownOpenPositions: new Set(),
  lastClosedTradesCount: 0,
  initialized: false,

  init() {
    const saved = localStorage.getItem("oi_sniper_notifications_v1");
    this.enabled = saved === "true" && "Notification" in window && Notification.permission === "granted";
    const chk = $("#chkNotifications");
    if (chk) {
      chk.checked = this.enabled;
      chk.onchange = async () => {
        if (chk.checked) {
          if (!("Notification" in window)) {
            toast("Notifications unsupported", "error", "Your browser does not support desktop notifications.");
            chk.checked = false;
            return;
          }
          if (Notification.permission === "default") {
            const perm = await Notification.requestPermission();
            if (perm !== "granted") {
              toast("Permission denied", "warn", "Desktop notifications were not granted.");
              chk.checked = false;
              this.enabled = false;
              localStorage.setItem("oi_sniper_notifications_v1", "false");
              return;
            }
          } else if (Notification.permission === "denied") {
            toast("Permission blocked", "warn", "Notifications are blocked. Please enable in site settings.");
            chk.checked = false;
            this.enabled = false;
            localStorage.setItem("oi_sniper_notifications_v1", "false");
            return;
          }
          this.enabled = true;
          localStorage.setItem("oi_sniper_notifications_v1", "true");
          toast("Notifications enabled", "success", "Alerts active for trades and events.");
        } else {
          this.enabled = false;
          localStorage.setItem("oi_sniper_notifications_v1", "false");
        }
      };
    }
    this.initialized = true;
  },

  notify(title, body, tag = "") {
    if (!this.enabled || !("Notification" in window) || Notification.permission !== "granted") return;
    try {
      new Notification(`OI Sniper · ${title}`, {
        body,
        tag: tag || undefined,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="%230b1220"/><path d="M14 40l10-12 9 7 15-17" fill="none" stroke="%2316d39a" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      });
    } catch (e) {
      console.warn("[notification] Dispatch failed:", e);
    }
  },

  handlePositions(positions) {
    if (!Array.isArray(positions)) return;
    const currentIds = new Set();
    for (const pos of positions) {
      const id = String(pos.id || `${pos.symbol}-${pos.side}`);
      currentIds.add(id);
      if (this.initialized && this.knownOpenPositions.size > 0 && !this.knownOpenPositions.has(id)) {
        this.notify(
          "Trade Opened",
          `${pos.side.toUpperCase()} ${pos.symbol} @ $${pos.entryPrice} (${pos.leverage || 50}x) · Margin $${pos.margin}`,
          `open-${id}`
        );
      }
    }
    this.knownOpenPositions = currentIds;
  },

  handleTrades(trades) {
    if (!Array.isArray(trades)) return;
    if (this.initialized && this.lastClosedTradesCount > 0 && trades.length > this.lastClosedTradesCount) {
      const newTrades = trades.slice(0, trades.length - this.lastClosedTradesCount);
      for (const t of newTrades) {
        const pnl = t.netPnl ?? t.pnl ?? 0;
        const sign = pnl >= 0 ? "+" : "";
        const roeStr = t.roe ? ` (${t.roe > 0 ? "+" : ""}${round(t.roe, 1)}% ROE)` : "";
        this.notify(
          "Trade Closed",
          `${t.side.toUpperCase()} ${t.symbol} closed via ${t.reason || "Manual"} · PnL ${sign}$${round(pnl, 2)}${roeStr}`,
          `close-${t.id || Date.now()}`
        );
      }
    }
    this.lastClosedTradesCount = trades.length;
  },

  handleRunningState(running, stopReason) {
    const isRunning = Boolean(running);
    if (this.initialized && this.lastBotRunning === true && !isRunning) {
      this.notify("Bot Paused", `Trading stopped: ${stopReason || "Manual pause"}`, "bot-stopped");
    }
    this.lastBotRunning = isRunning;
  },

  handleStale(isStale, ageSec = 20) {
    if (isStale) {
      const nowTs = Date.now();
      if (nowTs - this.lastStaleNoticeAt > 60000) {
        this.lastStaleNoticeAt = nowTs;
        this.notify("Market Data Stale", `CoinGlass feed delayed (>${ageSec}s). New entries paused.`, "market-stale");
      }
    }
  },
};

/* ------------------------------------------------------------------ */
/* 3-Step First-Run Onboarding Controller                             */
export function setupSettingsToggle() {
  const btnToggle = $("#btnToggleSettings");
  const btnClose = $("#btnCloseSettings");
  const layout = $(".layout");
  if (!layout) return;

  const setCollapsed = (collapsed) => {
    layout.classList.toggle("settings-collapsed", collapsed);
    localStorage.setItem("oi_sniper_settings_closed", collapsed ? "1" : "0");
    if (btnToggle) {
      btnToggle.classList.toggle("active", !collapsed);
    }
  };

  btnToggle?.addEventListener("click", () => {
    setCollapsed(!layout.classList.contains("settings-collapsed"));
  });

  btnClose?.addEventListener("click", () => {
    setCollapsed(true);
  });

  const btnToggleAll = $("#btnToggleAllSettings");
  btnToggleAll?.addEventListener("click", () => {
    const groups = document.querySelectorAll(".settings-body details.setting-group");
    const anyClosed = [...groups].some((g) => !g.open);
    groups.forEach((g) => {
      g.open = anyClosed;
    });
    btnToggleAll.textContent = anyClosed ? "Collapse all" : "Expand all";
  });

  const saved = localStorage.getItem("oi_sniper_settings_closed");
  if (saved === "1" || (saved === null && window.innerWidth < 1400)) {
    layout.classList.add("settings-collapsed");
    btnToggle?.classList.remove("active");
  } else {
    layout.classList.remove("settings-collapsed");
    btnToggle?.classList.add("active");
  }
}

export function setupWorkspaceTabs() {
  const bar = $("#workspaceTabs");
  const content = $("main.content");
  if (!bar || !content) return;
  bar.addEventListener("click", (e) => {
    const tab = e.target.closest(".ws-tab");
    if (!tab) return;
    bar.querySelectorAll(".ws-tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    content.dataset.activeView = tab.dataset.view || "overview";
  });
}

export function setupOnboarding() {
  const modal = $("#onboardingModal");
  if (!modal) return;

  let currentStep = 1;
  const totalSteps = 3;

  const showStep = (step) => {
    currentStep = step;
    $$(".onboard-step").forEach((el) => {
      el.classList.toggle("active", el.dataset.step === String(step));
      el.classList.toggle("hidden", el.dataset.step !== String(step));
    });
    $$("#onboardDots .dot").forEach((dot, idx) => {
      dot.classList.toggle("active", idx === step - 1);
    });

    const titleEl = $("#onboardStepSubtitle");
    if (titleEl) {
      if (step === 1) titleEl.textContent = "Step 1 of 3: Strategy Preset";
      else if (step === 2) titleEl.textContent = "Step 2 of 3: Execution Mode (Paper Default)";
      else if (step === 3) titleEl.textContent = "Step 3 of 3: Connect Exchange & Start";
    }

    const btnPrev = $("#btnOnboardPrev");
    if (btnPrev) btnPrev.classList.toggle("hidden", step === 1);

    const btnNext = $("#btnOnboardNext");
    if (btnNext) btnNext.textContent = step === totalSteps ? "Get Started! 🚀" : "Next →";
  };

  const closeTour = () => {
    modal.classList.add("hidden");
    localStorage.setItem("oi_sniper_onboarded_v1", "true");
  };

  const openTour = () => {
    modal.classList.remove("hidden");
    showStep(1);
  };

  $("#btnCloseOnboarding")?.addEventListener("click", closeTour);
  $("#btnOpenTour")?.addEventListener("click", openTour);

  $("#btnOnboardPrev")?.addEventListener("click", () => {
    if (currentStep > 1) showStep(currentStep - 1);
  });

  $("#btnOnboardNext")?.addEventListener("click", () => {
    if (currentStep < totalSteps) {
      showStep(currentStep + 1);
    } else {
      closeTour();
      toast("Welcome!", "success", "OI Sniper is ready for trading.");
    }
  });

  // Step 1: Preset buttons
  $$(".btn-preset-choice").forEach((btn) => {
    btn.onclick = async () => {
      const presetKey = btn.dataset.preset;
      const presetData = PRESETS[presetKey];
      if (presetData && state.settings) {
        state.settings.profiles = state.settings.profiles || {};
        state.settings.profiles.long = deepMerge(state.settings.profiles.long || {}, presetData);
        state.settings.profiles.short = deepMerge(state.settings.profiles.short || {}, presetData);
        await api("/api/settings", { method: "POST", body: { settings: state.settings } });
        renderSettingsForm();
        toast("Preset applied", "success", `Loaded ${presetKey.toUpperCase()} profile baseline.`);
        showStep(2);
      }
    };
  });

  // Step 2: Paper vs Live cards (starts in Paper mode!)
  const paperCard = $("#onboardModePaperCard");
  const liveCard = $("#onboardModeLiveCard");
  if (paperCard && liveCard) {
    paperCard.onclick = () => {
      paperCard.classList.add("active");
      liveCard.classList.remove("active");
    };
    liveCard.onclick = () => {
      toast("Live mode requires exchange setup", "info", "You can connect keys in Step 3.");
      liveCard.classList.add("active");
      paperCard.classList.remove("active");
    };
  }

  // Step 3: Connect exchange button
  $("#btnOnboardConnectExchange")?.addEventListener("click", () => {
    closeTour();
    $("#btnExchangeConnect")?.click();
  });

  // First-run auto open
  const onboarded = localStorage.getItem("oi_sniper_onboarded_v1");
  if (onboarded !== "true") {
    openTour();
  }
}

function setupBackupUi() {
  const btnExport = $("#btnExportBackup");
  const chkExportKeys = $("#chkExportApiKeys");
  if (btnExport) {
    btnExport.onclick = async () => {
      try {
        const includeKeys = Boolean(chkExportKeys?.checked);
        const res = await api(`/api/backup/export?includeKeys=${includeKeys ? "true" : "false"}`);
        const blob = new Blob([JSON.stringify(res.backup, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = res.filename || "oi-sniper-backup.json";
        a.click();
        URL.revokeObjectURL(a.href);
        toast(
          "Backup exported",
          "success",
          includeKeys ? "Backup exported with API keys included." : "Backup exported (API keys stripped by default)."
        );
      } catch (err) {
        toast("Export failed", "error", err.message);
      }
    };
  }

  const btnCopyPreset = $("#btnCopyPreset");
  if (btnCopyPreset) {
    btnCopyPreset.onclick = async () => {
      try {
        const cleanSettings = collectSettings();
        const hash = createPresetHash(cleanSettings);
        const url = `${window.location.origin}${window.location.pathname}#preset=${hash}`;
        await navigator.clipboard.writeText(url);
        toast("Preset link copied", "success", "Sharable URL copied to clipboard (API keys stripped).");
      } catch (err) {
        toast("Copy failed", "error", err.message);
      }
    };
  }

  const btnImport = $("#btnImportBackup");
  const fileInput = $("#fileBackupInput");
  if (btnImport && fileInput) {
    btnImport.onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      if (
        !confirm(
          "Importing a backup will restore settings, trades, and logs into your database, replacing current unsaved state. Do you want to proceed?"
        )
      ) {
        fileInput.value = "";
        return;
      }
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const res = await api("/api/backup/import", { method: "POST", body: json });
        toast("Backup imported", "success", `Restored ${res.trades || 0} trades.`);
        await loadBootstrap();
      } catch (err) {
        toast("Import failed", "error", err.message);
      } finally {
        fileInput.value = "";
      }
    };
  }

  const btnImportLegacy = $("#btnImportLegacy");
  const fileLegacyInput = $("#fileLegacyInput");
  if (btnImportLegacy && fileLegacyInput) {
    btnImportLegacy.onclick = () => fileLegacyInput.click();
    fileLegacyInput.onchange = async () => {
      const file = fileLegacyInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        const res = await api("/api/backup/legacy", { method: "POST", body: json });
        toast("Legacy state imported", "success", "Migrated legacy state to IndexedDB.");
        await loadBootstrap();
      } catch (err) {
        toast("Legacy import failed", "error", err.message);
      } finally {
        fileLegacyInput.value = "";
      }
    };
  }
}

function renderModeState() {
  const isLive = state.settings?.mode === "live";
  const paperBtn = $("#btnModePaper");
  const liveBtn = $("#btnModeLive");
  if (paperBtn) paperBtn.classList.toggle("active", !isLive);
  if (liveBtn) liveBtn.classList.toggle("active", isLive);

  const subtitle = $("#engineSubtitle");
  if (subtitle) {
    subtitle.textContent = isLive
      ? "CoinGlass OI + Volume · LIVE ENGINE"
      : "CoinGlass OI + Volume · paper engine";
  }

  const panicBtn = $("#btnPanic");
  if (panicBtn) panicBtn.classList.toggle("hidden", !isLive);

  const rawEx = state.settings?.live?.exchange || "bybit";
  const activeEx = rawEx.toUpperCase();
  const exchangePill = $("#exchangePill");
  if (exchangePill) {
    $("#exchangePillText").textContent = `Exchange: ${activeEx}`;
  }
  const confirmExEl = $("#confirmExchangeName");
  if (confirmExEl) {
    confirmExEl.textContent = activeEx;
  }
  const exchangeSelect = $('[data-live-setting="exchange"]');
  if (exchangeSelect && exchangeSelect.value !== rawEx) {
    exchangeSelect.value = rawEx;
  }

  const killPill = $("#killSwitchPill");
  if (killPill) {
    killPill.classList.toggle("hidden", !state.killSwitchActive);
  }
}

let refreshExchangeCardsFn = null;

async function selectActiveExchange(venueId, { silent = false } = {}) {
  const targetVenue = String(venueId || "").toLowerCase().trim();
  if (!targetVenue) return;
  try {
    const res = await api("/api/exchange/select", {
      method: "POST",
      body: { venue: targetVenue },
    });
    const activeVenue = res.activeVenue || targetVenue;
    if (!state.settings) state.settings = {};
    if (!state.settings.live) state.settings.live = {};
    state.settings.live.exchange = activeVenue;
    if (res.mode) state.settings.mode = res.mode;
    try {
      localStorage.setItem("oiSniperSettings", JSON.stringify(state.settings));
    } catch {
      /* ignore quota errors */
    }
    renderModeState();
    if (refreshExchangeCardsFn && !$("#exchangeModal")?.classList.contains("hidden")) {
      await refreshExchangeCardsFn();
    }
    if (!silent) {
      const displayName = VENUE_NAMES[activeVenue] || activeVenue.toUpperCase();
      toast("Active exchange updated", "success", `Execution exchange set to ${displayName}.`);
    }
  } catch (err) {
    renderModeState();
    toast("Exchange selection failed", "error", err.message);
  }
}

function setupExchangeUi() {
  const btnModePaper = $("#btnModePaper");
  const btnModeLive = $("#btnModeLive");
  const liveConfirmModal = $("#liveConfirmModal");
  const exchangeModal = $("#exchangeModal");
  const btnExchangeConnect = $("#btnExchangeConnect");
  const exchangePill = $("#exchangePill");
  const btnCloseExchangeModal = $("#btnCloseExchangeModal");
  const btnCloseLiveConfirmModal = $("#btnCloseLiveConfirmModal");
  const btnCancelLiveConfirm = $("#btnCancelLiveConfirm");
  const btnActivateLive = $("#btnActivateLive");
  const inputLiveConfirm = $("#inputLiveConfirm");
  const btnKillSwitch = $("#btnKillSwitch");
  const btnPanic = $("#btnPanic");

  // Mode Switch
  if (btnModePaper) {
    btnModePaper.onclick = async () => {
      if (state.settings?.mode === "paper") return;
      try {
        const res = await api("/api/mode", { method: "POST", body: { mode: "paper" } });
        if (res.ok) {
          state.settings.mode = "paper";
          toast("Switched to Paper mode", "success", "Trading simulated without exchange orders.");
          renderModeState();
        }
      } catch (err) {
        toast("Mode switch failed", "error", err.message);
      }
    };
  }

  if (btnModeLive) {
    btnModeLive.onclick = () => {
      if (state.settings?.mode === "live") return;
      const activeEx = (state.settings?.live?.exchange || "bybit").toUpperCase();
      $("#confirmExchangeName").textContent = activeEx;
      const marginCap = state.settings?.live?.marginPerTrade || 0;
      $("#confirmMarginCap").textContent = marginCap > 0 ? `$${marginCap}` : "Strategy sizing (no cap)";
      const lossCap = state.settings?.live?.dailyLossCap || 0;
      $("#confirmLossCap").textContent = lossCap > 0 ? `$${lossCap} USDT` : "Disabled";
      if (inputLiveConfirm) inputLiveConfirm.value = "";
      if (btnActivateLive) btnActivateLive.disabled = true;
      if (liveConfirmModal) liveConfirmModal.classList.remove("hidden");
    };
  }

  if (inputLiveConfirm && btnActivateLive) {
    inputLiveConfirm.oninput = () => {
      btnActivateLive.disabled = inputLiveConfirm.value.trim() !== "I UNDERSTAND";
    };
  }

  if (btnActivateLive) {
    btnActivateLive.onclick = async () => {
      try {
        const res = await api("/api/mode", {
          method: "POST",
          body: { mode: "live", confirmation: "I UNDERSTAND" },
        });
        if (res.ok) {
          state.settings.mode = "live";
          toast("LIVE MODE ACTIVATED!", "error", "Real exchange orders enabled. Trade safely.");
          if (liveConfirmModal) liveConfirmModal.classList.add("hidden");
          renderModeState();
        }
      } catch (err) {
        toast("Cannot switch to Live", "error", err.message);
      }
    };
  }

  const closeLiveModal = () => liveConfirmModal?.classList.add("hidden");
  if (btnCloseLiveConfirmModal) btnCloseLiveConfirmModal.onclick = closeLiveModal;
  if (btnCancelLiveConfirm) btnCancelLiveConfirm.onclick = closeLiveModal;

  // Kill Switch & Panic
  if (btnKillSwitch) {
    btnKillSwitch.onclick = async () => {
      try {
        const res = await api("/api/kill-switch", { method: "POST" });
        state.killSwitchActive = res.active;
        toast(
          res.active ? "Kill switch ACTIVATED" : "Kill switch DEACTIVATED",
          res.active ? "error" : "success",
          res.active ? "All new position entries are stopped." : "Trading entries resumed."
        );
        renderModeState();
      } catch (err) {
        toast("Kill switch failed", "error", err.message);
      }
    };
  }

  if (btnPanic) {
    btnPanic.onclick = async () => {
      if (!confirm("PANIC: Close all positions and cancel all open orders immediately on the exchange?")) return;
      try {
        await api("/api/panic", { method: "POST" });
        toast("PANIC EXECUTED", "error", "Closed all positions and cancelled orders.");
        await refreshLive();
      } catch (err) {
        toast("Panic failed", "error", err.message);
      }
    };
  }

  // Exchange Connect Modal
  let selectedVenue = "bybit";
  const openExchangeModal = async () => {
    if (exchangeModal) exchangeModal.classList.remove("hidden");
    $("#wizardBox")?.classList.add("hidden");
    await renderExchangeCards();
  };

  if (btnExchangeConnect) btnExchangeConnect.onclick = openExchangeModal;
  if (exchangePill) exchangePill.onclick = openExchangeModal;
  if (btnCloseExchangeModal) btnCloseExchangeModal.onclick = () => exchangeModal?.classList.add("hidden");

  async function renderExchangeCards() {
    const grid = $("#exchangeGrid");
    if (!grid) return;
    grid.innerHTML = "<div class='modal-sub'>Loading exchange status…</div>";

    try {
      const res = await api("/api/exchange/status");
      const venues = res.venues || [];
      grid.innerHTML = "";

      for (const v of venues) {
        const card = document.createElement("div");
        card.className = `exchange-card ${v.isActive ? "active" : ""}`;

        let statusClass = "not-connected";
        let statusText = "Not connected";
        if (v.connected) {
          statusClass = "connected";
          statusText = "Connected";
        } else if (!v.liveSupported) {
          statusClass = "unavailable";
          statusText = v.tier.toUpperCase();
        }

        let selectBtn = "";
        if (v.isActive) {
          selectBtn = `<span class="exchange-active-badge">✓ Active</span>`;
        } else if (v.liveSupported) {
          selectBtn = `<button class="btn small ghost btn-select-exchange" data-venue="${v.id}" type="button">Set Active</button>`;
        } else {
          selectBtn = `<span></span>`;
        }

        let actionBtn = "";
        if (v.connected) {
          actionBtn = `<button class="btn small danger-ghost btn-disconnect" data-venue="${v.id}" type="button">Disconnect</button>`;
        } else if (v.liveSupported) {
          actionBtn = `<button class="btn small primary btn-connect" data-venue="${v.id}" type="button">Connect</button>`;
        } else {
          actionBtn = `<span class="modal-sub" style="font-size:11px;">Coming soon</span>`;
        }

        card.innerHTML = `
          <div class="exchange-card-head">
            <span class="exchange-title">${v.name}</span>
            <span class="exchange-status-pill ${statusClass}">${statusText}</span>
          </div>
          <div class="exchange-meta">
            ${v.connected ? `Key: <code>${v.maskedKey}</code>` : (v.liveSupported ? "USDT-M / Linear Futures" : "Adapter in development")}
          </div>
          <div class="exchange-card-actions">
            ${selectBtn}
            ${actionBtn}
          </div>
        `;

        grid.appendChild(card);
      }

      $$(".btn-select-exchange").forEach((btn) => {
        btn.onclick = () => selectActiveExchange(btn.dataset.venue);
      });
      $$(".btn-connect").forEach((btn) => {
        btn.onclick = () => openWizard(btn.dataset.venue);
      });
      $$(".btn-disconnect").forEach((btn) => {
        btn.onclick = async () => {
          if (!confirm(`Disconnect ${btn.dataset.venue.toUpperCase()} and remove saved keys?`)) return;
          try {
            await api("/api/exchange/disconnect", { method: "POST", body: { venue: btn.dataset.venue } });
            toast("Disconnected", "success", `Removed credentials for ${btn.dataset.venue}.`);
            await renderExchangeCards();
            renderModeState();
          } catch (err) {
            toast("Disconnect failed", "error", err.message);
          }
        };
      });
    } catch (err) {
      grid.innerHTML = `<div class="wizard-alert danger">Failed to load exchange status: ${err.message}</div>`;
    }
  }
  refreshExchangeCardsFn = renderExchangeCards;

  function openWizard(venueId) {
    selectedVenue = venueId;
    const wizard = $("#wizardBox");
    if (!wizard) return;
    wizard.classList.remove("hidden");

    $("#wizardApiKey").value = "";
    $("#wizardSecret").value = "";
    if ($("#wizardPassphrase")) $("#wizardPassphrase").value = "";
    $("#wizardTestFeedback").classList.add("hidden");
    $("#wizardPassphraseRow").classList.add("hidden");

    if (venueId === "binance") {
      $("#wizardTitle").textContent = "Connect Binance USDT-M Futures";
      $("#wizardInstructions").textContent = "Create an API Key on Binance with 'Enable Futures' checked. DO NOT check 'Enable Withdrawals'.";
    } else if (venueId === "bybit") {
      $("#wizardTitle").textContent = "Connect Bybit V5 Linear";
      $("#wizardInstructions").textContent = "Create an API Key on Bybit with Contract 'Orders & Positions' checked. Leave Withdrawals UNCHECKED. Note: Bybit API keys without IP binding expire after 3 months. For 24/7 bots, use a static/residential IP or remember to regenerate keys before expiration.";
    } else if (venueId === "gate") {
      $("#wizardTitle").textContent = "Connect Gate.io USDT Futures";
      $("#wizardInstructions").textContent = "Create an API Key on Gate.io with 'Futures trading' enabled. DO NOT check 'Withdraw' or 'Wallet' write permissions.";
      $("#wizardPassphraseRow").classList.add("hidden");
    } else if (venueId === "kucoin") {
      $("#wizardTitle").textContent = "Connect KuCoin Futures";
      $("#wizardInstructions").textContent = "Create an API Key on KuCoin with 'Futures Trading' enabled. DO NOT check 'Transfer' or 'Withdraw'. Enter your API Passphrase below.";
      $("#wizardPassphraseRow").classList.remove("hidden");
    } else if (venueId === "mexc") {
      $("#wizardTitle").textContent = "Connect MEXC Futures";
      $("#wizardInstructions").textContent = "Create an API Key on MEXC with Contract (Futures) trading enabled. Passphrase is not needed. NEVER enable withdrawal permissions on your MEXC API key.";
      $("#wizardPassphraseRow").classList.add("hidden");
    }
  }

  const wizardCancelBtn = $("#btnWizardCancel");
  if (wizardCancelBtn) wizardCancelBtn.onclick = () => $("#wizardBox")?.classList.add("hidden");

  const wizardTestBtn = $("#btnWizardTest");
  if (wizardTestBtn) {
    wizardTestBtn.onclick = async () => {
      const apiKey = $("#wizardApiKey").value.trim();
      const secret = $("#wizardSecret").value.trim();
      const passphrase = $("#wizardPassphrase")?.value.trim() || undefined;
      const feedback = $("#wizardTestFeedback");
      if (!apiKey || !secret) {
        toast("Missing fields", "error", "Please provide API Key and Secret.");
        return;
      }
      if (selectedVenue === "kucoin" && !passphrase) {
        toast("Missing passphrase", "error", "KuCoin requires an API Passphrase.");
        return;
      }

      feedback.classList.remove("hidden");
      feedback.innerHTML = "<span class='modal-sub'>Connecting to exchange & verifying permissions…</span>";

      try {
        const res = await api("/api/exchange/test", {
          method: "POST",
          body: { venue: selectedVenue, apiKey, secret, passphrase },
        });

        if (res.capabilities && !res.capabilities.trading) {
          feedback.innerHTML = `
            <div style="color:#f59e0b; font-weight:600;">⚠️ Futures order API unavailable at MEXC</div>
            <div style="font-size:12px; margin-top:2px; color:var(--muted);">${res.capabilities.reason || "Futures order API unavailable at MEXC"}. Trading will remain in Paper mode only.</div>
            <div style="margin-top:6px;">• Trading permissions: <strong>Verified</strong></div>
            <div>• Withdrawal permissions: <strong>Disabled (Safe)</strong></div>
            <div>• Available Balance: <strong>$${num(res.balance?.availableUsdt).toFixed(2)} USDT</strong></div>
            <div>• Tradable contracts: <strong>${res.instrumentsCount || 0}</strong></div>
          `;
        } else {
          const probeMsg = selectedVenue === "mexc"
            ? `<div style="color:#3ddc97; font-size:12px; margin-top:2px;">• Official Futures Order API: <strong>Operational (Live Ready)</strong></div>`
            : "";
          feedback.innerHTML = `
            <div style="color:#3ddc97; font-weight:600;">✓ Verification Passed</div>
            <div>• Trading permissions: <strong>Enabled</strong></div>
            <div>• Withdrawal permissions: <strong>Disabled (Safe)</strong></div>
            <div>• Available Balance: <strong>$${num(res.balance?.availableUsdt).toFixed(2)} USDT</strong></div>
            <div>• Tradable contracts: <strong>${res.instrumentsCount || 0}</strong></div>
            ${probeMsg}
          `;
        }
      } catch (err) {
        feedback.innerHTML = `
          <div style="color:#f87171; font-weight:600;">✕ Connection Test Failed</div>
          <div style="margin-top:2px; color:var(--fg);">${err.message}</div>
        `;
      }
    };
  }


  const wizardSaveBtn = $("#btnWizardSave");
  if (wizardSaveBtn) {
    wizardSaveBtn.onclick = async () => {
      const apiKey = $("#wizardApiKey").value.trim();
      const secret = $("#wizardSecret").value.trim();
      const passphrase = $("#wizardPassphrase")?.value.trim() || undefined;
      if (!apiKey || !secret) {
        toast("Missing fields", "error", "Please provide API Key and Secret.");
        return;
      }
      if (selectedVenue === "kucoin" && !passphrase) {
        toast("Missing passphrase", "error", "KuCoin requires an API Passphrase.");
        return;
      }

      try {
        const res = await api("/api/exchange/connect", {
          method: "POST",
          body: { venue: selectedVenue, apiKey, secret, passphrase },
        });

        const activeVenue = res.activeVenue || res.venue || selectedVenue;
        if (!state.settings) state.settings = {};
        if (!state.settings.live) state.settings.live = {};
        state.settings.live.exchange = activeVenue;
        try {
          localStorage.setItem("oiSniperSettings", JSON.stringify(state.settings));
        } catch {
          /* ignore quota errors */
        }

        toast(`Connected to ${activeVenue.toUpperCase()}`, "success", `Keys encrypted in WebCrypto vault (${res.maskedKey}).`);
        $("#wizardBox")?.classList.add("hidden");
        await renderExchangeCards();
        renderModeState();
      } catch (err) {
        toast("Connection failed", "error", err.message);
      }
    };
  }
}

// Live tick and status subscriptions
onLiveTick((tick) => {
  if (tick.coinglassStale) {
    setBanner("stale", { level: "warn", message: "CoinGlass data is older than 20s. New trade entries paused." });
    notificationManager.handleStale(true, 20);
  } else {
    clearBanner("stale");
  }

  if (tick.stopNewEntries) {
    setBanner("offline", { level: "warn", message: "CoinGlass feed offline. Stop-new-entries safety gate active." });
  } else {
    clearBanner("offline");
  }

  if (tick.exchangeError || state.exchangeError) {
    setBanner("exchange-error", {
      level: "danger",
      message: `Exchange error: ${tick.exchangeError || state.exchangeError}. Live entries paused.`,
    });
  } else {
    clearBanner("exchange-error");
  }

  const activeExchange = state.settings?.live?.exchange || state.settings?.exchange;
  if (state.settings?.mode === "live" && activeExchange === "mexc" && state.mexcUnavailable) {
    setBanner("mexc-unavailable", {
      level: "warn",
      message: "Futures order API unavailable at MEXC. Paper mode only.",
    });
  } else {
    clearBanner("mexc-unavailable");
  }

  notificationManager.handlePositions(tick.positions || state.positions);
  if (tick.running !== undefined) {
    if (state.meta) state.meta.running = tick.running;
    notificationManager.handleRunningState(tick.running, tick.meta?.stopReason || state.meta?.stopReason);
  }
  renderServerNotice();

  if (!isLeaderTab()) {
    if (tick.stats) state.stats = tick.stats;
    if (tick.positions) state.positions = tick.positions;
    if (tick.meta) state.meta = tick.meta;
    renderKpis();
    renderPositions();
  }
});

onStatusChange((status) => {
  if (status.kind === "secondary") {
    setBanner("secondary", {
      level: "warn",
      message: status.message || "Bot is actively running in another tab. This tab is in Read-Only mode.",
      kind: "secondary",
    });
  } else if (status.kind === "leader") {
    clearBanner("secondary");
    toast("Leader active", "success", "This tab is managing the trading engine.");
  } else if (status.kind === "tab-hidden") {
    setBanner("tab-hidden", {
      level: "warn",
      message: status.message || "Tab is running in background. Timers may be throttled; keep tab visible for optimal execution.",
    });
  } else if (status.kind === "tab-visible") {
    clearBanner("tab-hidden");
    clearBanner("throttled");
  } else if (status.kind === "throttled") {
    setBanner("throttled", {
      level: "warn",
      message: status.message || "Background tab throttling detected. Keep tab in focus for real-time order timing.",
    });
  } else if (status.kind === "kill-switch") {
    setBanner("kill-switch", {
      level: "danger",
      message: status.message || "Live trading is temporarily disabled by admin.",
    });
  } else if (status.kind === "kill-switch-cleared") {
    clearBanner("kill-switch");
  } else if (status.kind === "wake-lock-lost") {
    setBanner("wake-lock", {
      level: "warn",
      message: status.message || "Screen wake lock was released. Screen may sleep.",
    });
  } else if (status.kind === "wake-lock-rejected") {
    setBanner("wake-lock", {
      level: "warn",
      message: status.message || "Screen wake lock request was rejected. Keep tab in focus to prevent sleep.",
    });
  } else if (status.kind === "wake-lock-active") {
    clearBanner("wake-lock");
  } else if (status.kind === "update-required") {
    setBanner("update-required", {
      level: "warn",
      message: status.message,
    });
  } else if (status.kind === "worker-error") {
    setBanner("worker-error", {
      level: "danger",
      message: status.message,
    });
  }
});

initApi().then(() => {
  loadBootstrap().then(() => {
    notificationManager.init();
    setupSettingsToggle();
    setupWorkspaceTabs();
    setupOnboarding();
    setupBackupUi();
    setupExchangeUi();
    setInterval(tickClock, 1000);
    loop(refreshDashboard, 4000);
    loop(refreshTrades, 30000);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      refreshDashboard();
      renderServerNotice();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        $("#exchangeModal")?.classList.add("hidden");
        $("#liveConfirmModal")?.classList.add("hidden");
        $("#onboardingModal")?.classList.add("hidden");
      }
    });
  });
});
tickClock();
