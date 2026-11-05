/* OI Sniper dashboard — vanilla JS, no build step. */

import { fetchCoinMarkets, fetchTopMarkets, mergeTopRows } from "./cg-browser.js";
import { initApi, api as localApi, takeOverEngine, onLiveTick, onStatusChange, isLeaderTab, APP_VERSION } from "./web/api.js";

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
const TAB_LABELS = { qualified: "qualified", near: "near-miss", all: "coins" };

const state = {
  settings: null,
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
  if (!x) return "—";
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
  if (!t) return "—";
  try {
    return new Date(t).toLocaleTimeString("en-GB", { hour12: false });
  } catch {
    return "—";
  }
};
const dateTime = (t) => {
  if (!t) return "—";
  try {
    return new Date(t).toLocaleString("en-GB", {
      month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
  } catch {
    return "—";
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
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "—";
  const s = Math.max(0, Math.round(Number(ms) / 1000));
  if (s < 1) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
};

let activeNotice = null;

function setNotice(notice) {
  activeNotice = notice;
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
  if (!activeNotice) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.classList.remove("hidden");
  if (activeNotice.kind === "secondary") {
    el.innerHTML = `<span style="display:inline-flex; align-items:center; gap:10px;">${esc(activeNotice.message)} <button id="btnTakeOverNotice" class="btn" style="padding:2px 8px; font-size:12px; cursor:pointer;">Take Over Engine</button></span>`;
    const btn = $("#btnTakeOverNotice");
    if (btn) {
      btn.onclick = async () => {
        btn.disabled = true;
        btn.textContent = "Taking over...";
        await takeOverEngine();
      };
    }
    return;
  }
  el.innerHTML = `<span>${esc(activeNotice.message)}</span>`;
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
  container.innerHTML = list
    .map((f) => {
      const label = group === "oi" ? OI_LABELS[f.key] || f.key : VOL_LABELS[f.key] || f.key;
      const off = f.enabled && f.threshold !== null && f.threshold !== "" ? "" : "off";
      return `<div class="filter-row ${off}" data-key="${f.key}" data-group="${group}">
        <label class="switch"><input type="checkbox" data-f="enabled" ${f.enabled ? "checked" : ""}><i></i></label>
        <span class="filter-name">${esc(label)}</span>
        <select data-f="op">
          <option value=">=" ${f.op !== "<=" ? "selected" : ""}>≥</option>
          <option value="<=" ${f.op === "<=" ? "selected" : ""}>≤</option>
        </select>
        <input type="number" step="0.01" data-f="threshold" value="${f.threshold ?? ""}" placeholder="—">
        <span class="cur" data-cur="${group}.${f.key}">–</span>
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

function renderSettingsForm() {
  if (!state.settings) return;
  $$("[data-setting]").forEach((el) => setSettingValue(el, state.settings[el.dataset.setting]));
  buildFilterRows($("#oiFilters"), state.settings.oiFilters || [], "oi");
  buildFilterRows($("#volFilters"), state.settings.volFilters || [], "vol");
  buildVenueToggles();
  updateVisibility();
  updateDerived();
  renderCgKeyState();
  setDirty(false);
}

function collectFilters(selector, previous) {
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
  out.oiFilters = collectFilters("#oiFilters", out.oiFilters);
  out.volFilters = collectFilters("#volFilters", out.volFilters);
  out.venues = $$(".venue-chip input:checked").map((el) => el.value);
  return out;
}

function setDirty(dirty) {
  state.dirty = dirty;
  $("#dirtyBadge").classList.toggle("hidden", !dirty);
}

function updateVisibility() {
  const mode = $('[data-setting="sizingMode"]').value;
  $$("[data-show]").forEach((el) => {
    el.classList.toggle("hidden", el.dataset.show !== mode);
  });
}

function updateDerived() {
  const lev = Math.max(1, num($('[data-setting="leverage"]').value, 1));
  const fund = num($('[data-setting="totalFund"]').value, 0);
  const mode = $('[data-setting="sizingMode"]').value;
  const allocPct = num($('[data-setting="allocationPercent"]').value, 50);
  const fixedMargin = num($('[data-setting="fixedMargin"]').value, 0);
  const fixedQty = num($('[data-setting="fixedQty"]').value, 0);
  const riskMode = $('[data-setting="riskMode"]').value;
  const sl = num($('[data-setting="slPercent"]').value, 0);
  const tp1 = num($('[data-setting="tp1Percent"]').value, 0);
  const tpMax = num($('[data-setting="tpMaxPercent"]').value, 0);

  let margin = 0;
  if (mode === "allocation") margin = (fund * allocPct) / 100;
  else if (mode === "fixedMargin") margin = fixedMargin;
  else margin = (fixedQty * 1) / lev;

  const note = $("#sizingNote");
  if (mode === "fixedQty") {
    note.textContent = `Each trade buys ${fixedQty || 0} coins. Margin = notional ÷ leverage.`;
  } else {
    note.textContent = `Each trade uses ${money(margin)} margin → ${money(margin * lev)} notional at ${lev}x.`;
  }
  note.classList.toggle("neg", mode !== "fixedQty" && margin > fund + 0.001);

  const reenterEl = $("#reenterHint");
  if (reenterEl) {
    const on = Boolean($('[data-setting="reenterEnabled"]')?.checked);
    const mins = Math.max(0, num($('[data-setting="reenterDelayMin"]')?.value, 0));
    reenterEl.classList.remove("neg");
    if (!on) {
      reenterEl.textContent = "Off — coins can re-enter immediately after a close.";
    } else if (mins <= 0) {
      reenterEl.textContent = "Delay 0 = immediately after a close.";
    } else {
      reenterEl.textContent = `= no same-coin trade for ${humanDuration(mins * 60)} after a close.`;
      if (mins > 1440) {
        reenterEl.classList.add("neg");
        reenterEl.textContent += " — very long block";
      }
    }
  }

  const hint = $('[data-setting="riskMode"]').closest(".setting-group").querySelector(".hint");
  if (riskMode === "roe") {
    hint.textContent = `${sl}% ROE stop = ${(sl / lev).toFixed(2)}% price move at ${lev}x`;
  } else {
    hint.textContent = `Stop = ${sl}% price move; at ${lev}x that is ${(sl * lev).toFixed(1)}% ROE`;
  }
  if (tpMax && tp1 && tpMax < tp1) hint.textContent += " · TP max < TP1";
}

function markDirty() {
  setDirty(true);
  updateDerived();
}

SETTINGS_ROOT.addEventListener("input", (e) => {
  if (e.target.matches("[data-setting], [data-f]")) {
    if (e.target.matches('[data-setting="sizingMode"]')) updateVisibility();
    if (e.target.matches('[data-f="enabled"]')) {
      const row = e.target.closest(".filter-row");
      row.classList.toggle("off", !e.target.checked);
    }
    markDirty();
  }
});
SETTINGS_ROOT.addEventListener("change", (e) => {
  if (e.target.matches("[data-setting], [data-f]")) {
    if (e.target.matches('[data-setting="sizingMode"]')) updateVisibility();
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
    : "—";
  renderBanner();
  renderCountdown();
}

/* ------------------------------------------------------------------ */
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
          "Waiting for this browser to feed data — keep this tab open, or add an official API key.";
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
      ? "API key saved — using the official CoinGlass API."
      : "API key saved — waiting for the next refresh.";
  } else {
    el.textContent = "No API key — scraping the public website.";
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
    body.innerHTML = `<tr><td colspan="3" class="empty-row"><b>Waiting for CoinGlass data…</b>The bot is contacting capi.coinglass.com.</td></tr>`;
    if (foot) foot.textContent = "No rows yet";
  } else if (!shown.length) {
    body.innerHTML = `<tr><td colspan="3" class="empty-row"><b>No matching coins</b>Try a different search.</td></tr>`;
    if (foot) foot.textContent = `0 of ${rows.length} coins`;
  } else {
    body.innerHTML = shown
      .map((m) => {
        const oi = m.oi?.["5m"];
        const vol = m.vol?.["1h"];
        return `<tr>
          <td><div class="coin-cell"><div class="coin-name">${esc(m.symbol)}<small>${esc(m.name || "")}</small></div></div></td>
          <td class="num ${oi === null || oi === undefined ? "" : cls(oi)}">${oi === null || oi === undefined ? "—" : pct(oi)}</td>
          <td class="num ${vol === null || vol === undefined ? "" : cls(vol)}">${vol === null || vol === undefined ? "—" : pct(vol)}</td>
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
  let text = "";
  let warn = false;
  if (m.stopReason === "max-trades") {
    text = `Max trades reached (${m.maxTrades}). Download the report, then reset the strategy to run another batch.`;
    warn = true;
  } else if (!m.filtersConfigured && state.loaded) {
    text = "No filter is configured. Enable at least one OI or Volume row and enter a threshold to start scanning.";
  } else if (m.marketError) {
    text = `CoinGlass feed error: ${m.marketError}`;
    warn = true;
  } else if (m.marketAgeMs && m.marketAgeMs > 180000) {
    text = "Market data is more than 3 minutes old. New trades are paused until the feed recovers.";
    warn = true;
  } else if (m.running && s.available !== undefined && s.available < 1 && s.openTrades > 0) {
    text = "No free margin left. New signals will wait until a position closes.";
  }
  $("#banner").classList.toggle("hidden", !text);
  $("#banner").classList.toggle("warn", warn);
  $("#bannerText").textContent = text;
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
    ? (s.grossProfit > 0 ? "∞" : "—")
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
      const logo = p.symbol
        ? `<span class="coin-fallback">${esc(p.symbol.slice(0, 2))}</span>`
        : "";
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
    return `<td class="num"><span class="val na">—</span></td>`;
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
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter(
      (m) => m.symbol.toLowerCase().includes(q) || String(m.name || "").toLowerCase().includes(q)
    );
  }
  list = [...list].sort((a, b) => {
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    if (num(a.passCount) !== num(b.passCount)) return num(b.passCount) - num(a.passCount);
    if (num(a.score) !== num(b.score)) return num(b.score) - num(a.score);
    return num(b.oiUsd) - num(a.oiUsd);
  });

  const limit = 140;
  const shown = list.slice(0, limit);
  renderMarketTabs();

  if (!all.length) {
    tbody.innerHTML = `<tr><td colspan="12" class="empty-row"><b>Loading CoinGlass data…</b>The first scan downloads the full market table.</td></tr>`;
    $("#marketFoot").textContent = "—";
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
    tbody.innerHTML = `<tr><td colspan="12" class="empty-row"><b>Nothing here yet</b>${esc(msg)}</td></tr>`;
  } else {
    tbody.innerHTML = shown
      .map((m) => {
        const logo = m.logo
          ? `<img class="coin-logo" src="${esc(m.logo)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'"><span class="coin-fallback" style="display:none">${esc(m.symbol.slice(0, 2))}</span>`
          : `<span class="coin-fallback">${esc(m.symbol.slice(0, 2))}</span>`;
        const openCount = num(m.openCount, m.open ? 1 : 0);
        const perCoin = Math.max(1, num(m.maxPerCoin, 1));
        const roomForMore = openCount < perCoin;
        const coolLeft = Math.max(0, num(m.coolingRemainingSec, 0));
        let signal = `<span class="pass-pill no">off</span>`;
        if (openCount > 0 && !roomForMore) {
          signal = `<span class="pass-pill ready">OPEN${openCount > 1 ? ` ×${openCount}` : ""}</span>`;
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
        const canTrade = m.qualified && roomForMore && m.tradable && !m.excluded && !m.cooling && !m.stale;
        let blockShort = "";
        let blockText = "";
        if (m.qualified && !canTrade) {
          if (m.stale) {
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
          ? `<button class="btn small primary row-trade" data-open="${esc(m.symbol)}" type="button">Trade</button>`
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
      el.textContent = "–";
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
    tbody.innerHTML = `<tr><td colspan="12" class="empty-row"><b>No closed trades yet</b>A trade appears here after it hits SL, TP or you close it manually.</td></tr>`;
    $("#tradesFoot").textContent = "—";
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
        <td><span class="venue-tag" title="${parts} partial exit(s)">${esc(t.exitReason || "—")}${parts > 1 ? ` · ${parts}` : ""}</span></td>
        <td class="num subtle">${duration(t.durationMs)}</td>
        <td class="subtle">${esc(t.venueName || t.venue || "—")}</td>
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

/* ------------------------------------------------------------------ */
/* Device feed — this browser scrapes CoinGlass and pushes it up       */
/* ------------------------------------------------------------------ */
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
  // Called on page load and on Start — never stack duplicate scrape loops.
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
    toast(res.reset ? "Settings saved — account reset" : "Settings saved", "success", res.reset ? "Total fund changed, so paper history was cleared." : "New trades use the new rules immediately.");
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

async function manualOpen(symbol, button) {
  if (button) button.disabled = true;
  try {
    const res = await api("/api/trade/open", { method: "POST", body: { symbol, force: true } });
    const p = res.position;
    toast(`Opened ${p.side.toUpperCase()} ${p.symbol}`, "success", `@ ${price(p.entryPrice)} · ${money(p.margin)} margin`);
    await refreshLive();
    await refreshMarkets();
  } catch (err) {
    const payload = err.payload || {};
    const map = {
      "cannot-open": "Not enough free margin, max positions reached, or a position is already open.",
      "already-open": "This coin already has the maximum number of open positions (see Max positions per coin).",
      "coin-not-found": "Coin is not in the current CoinGlass table.",
      "no-price-feed": "No exchange price feed available for this coin.",
      "max-open": "Max open positions reached.",
      "cooling": `Re-entry delay: ${humanDuration(payload.remainingSec)} left. Turn "Re-enter trade" off or lower the delay to re-enter immediately.`,
    };
    let sub = map[err.message] || err.message;
    if (err.message === "cannot-open" && payload.reason) {
      const reasons = {
        "no-margin": `Not enough free margin — needs ${money(payload.requiredMargin || 0)}, ${money(payload.available || 0)} available.`,
        "coin-cap": "Max positions per coin already open.",
        "max-open": "Max open positions reached.",
        "cooling": "Still in the re-entry delay.",
        "no-feed": "No exchange price feed for this coin.",
        "stale": "CoinGlass data is stale.",
        "no-size": "Position size rounds to zero — check the sizing settings.",
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
  if (btn) manualOpen(btn.dataset.open, btn);
});
$("#positionsBody").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-close]");
  if (btn) closePosition(btn.dataset.close, btn);
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
 * Same as loop() but keeps running in a hidden tab. The browser throttles
 * background timers, so this cannot guarantee a rate — it just does not stop
 * on purpose. The engine accepts a device feed up to 90s old for this reason.
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

function setupBackupUi() {
  const btnExport = $("#btnExportBackup");
  if (btnExport) {
    btnExport.onclick = async () => {
      try {
        const res = await api("/api/backup/export");
        const blob = new Blob([JSON.stringify(res.backup, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = res.filename || "oi-sniper-backup.json";
        a.click();
        URL.revokeObjectURL(a.href);
        toast("Backup exported", "success", "All settings, trades, and history saved.");
      } catch (err) {
        toast("Export failed", "error", err.message);
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

// Live tick and status subscriptions
onLiveTick((tick) => {
  if (tick.coinglassStale) {
    setNotice({ kind: "stale", message: "CoinGlass data is older than 20s. New entries paused." });
  } else if (tick.stopNewEntries) {
    setNotice({ kind: "offline", message: "CoinGlass feed offline. Stop-new-entries safety gate active." });
  } else if (isLeaderTab()) {
    if (activeNotice?.kind === "stale" || activeNotice?.kind === "offline") {
      setNotice(null);
    }
  }

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
    setNotice(status);
  } else if (status.kind === "leader") {
    if (activeNotice?.kind === "secondary") setNotice(null);
    toast("Leader active", "success", "This tab is managing the trading engine.");
  } else if (["throttled", "unsupported-browser", "update-required", "kill-switch", "worker-error"].includes(status.kind)) {
    setNotice(status);
  }
});

initApi().then(() => {
  loadBootstrap().then(() => {
    setupBackupUi();
    setInterval(tickClock, 1000);
    loop(refreshDashboard, 4000);
    loop(refreshTrades, 30000);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      refreshDashboard();
      renderServerNotice();
    });
  });
});
tickClock();
