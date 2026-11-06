/**
 * Local API Client & Multi-Tab Web Locks Coordinator
 *
 * Bridges the browser UI thread to the Web Worker via RPC postMessage,
 * manages single-tab exclusivity with Web Locks ('oi-sniper-worker-lock'),
 * synchronizes tabs via BroadcastChannel ('oi-sniper-bus'), and enforces
 * status.json kill switch & background throttling detection.
 */

export const APP_VERSION = "2.0.0";
const LOCK_NAME = "oi-sniper-worker-lock";
const BUS_NAME = "oi-sniper-bus";

let worker = null;
let reqId = 1;
const pending = new Map();
let isLeader = false;
let bus = null;
const tickListeners = new Set();
const statusListeners = new Set();
let wakeLock = null;
let botRunning = false;
let lockResolver = null;

export function isLeaderTab() {
  return isLeader;
}

export function onLiveTick(fn) {
  tickListeners.add(fn);
  return () => tickListeners.delete(fn);
}

export function onStatusChange(fn) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

function notifyStatus(status) {
  for (const fn of statusListeners) {
    try {
      fn(status);
    } catch {
      /* ignore */
    }
  }
}

function notifyTick(data) {
  for (const fn of tickListeners) {
    try {
      fn(data);
    } catch {
      /* ignore */
    }
  }
}

function checkBrowserSupport() {
  const missing = [];
  if (typeof Worker === "undefined") missing.push("Web Workers");
  if (typeof indexedDB === "undefined") missing.push("IndexedDB");
  if (typeof navigator?.locks === "undefined") missing.push("Web Locks API");
  if (typeof crypto?.subtle === "undefined") missing.push("WebCrypto API");
  return missing;
}

function spawnWorker() {
  if (worker) return worker;
  console.log("[api] Spawning dedicated Web Worker...");
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });

  worker.onmessage = (e) => {
    const msg = e.data;
    if (!msg) return;

    if (msg.type === "TICK") {
      if (msg.running !== undefined) setBotRunning(msg.running);
      notifyTick(msg);
      return;
    }

    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) resolve(msg);
      else reject(new Error(msg.error || `HTTP ${msg.status || 500}`));
    }
  };

  worker.onerror = (err) => {
    console.error("[api] Worker crashed:", err);
    notifyStatus({ kind: "worker-error", message: err.message || "Worker runtime error" });
  };

  return worker;
}

function stopWorker() {
  if (!worker) return;
  console.log("[api] Terminating local Web Worker...");
  try {
    worker.postMessage({ type: "FLUSH" });
  } catch {
    /* ignore */
  }
  worker.terminate();
  worker = null;
}

export async function takeOverEngine() {
  if (isLeader) return;
  console.log("[api] Requesting engine take over from active leader...");
  if (bus) {
    bus.postMessage({ type: "TAKEOVER_REQUEST" });
  }
}

export async function api(path, options = {}) {
  // If request is for status.json, fetch directly via window.fetch with no-store
  if (path === "/status.json" || path.startsWith("/status.json?")) {
    const res = await fetch(path, { cache: "no-store" });
    return res.json();
  }

  // If we are a secondary tab, route request via worker if leader, else proxy or alert
  if (!isLeader) {
    if (options.method === "POST") {
      throw new Error("This tab is in Read-Only mode. Click 'Take Over Engine' to make changes.");
    }
  }

  const w = spawnWorker();
  const id = ++reqId;
  const method = options.method || "GET";
  let body = {};
  if (options.body) {
    body = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`Request timeout for ${path}`));
      }
    }, 15000);

    pending.set(id, {
      resolve: (data) => {
        clearTimeout(timer);
        resolve(data);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    w.postMessage({ id, path, method, body });
  });
}

export function setBotRunning(running) {
  const next = Boolean(running);
  if (botRunning !== next) {
    botRunning = next;
    if (botRunning) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }
  }
}

export async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  if (!botRunning) return;
  if (wakeLock) return;

  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
      if (botRunning && document.visibilityState === "visible") {
        notifyStatus({
          kind: "wake-lock-lost",
          message: "Screen wake lock was released. Screen may sleep.",
        });
      }
    });
    notifyStatus({ kind: "wake-lock-active" });
  } catch {
    wakeLock = null;
    notifyStatus({
      kind: "wake-lock-rejected",
      message: "Screen wake lock request was rejected. Ensure tab remains in focus to prevent sleep.",
    });
  }
}

export async function releaseWakeLock() {
  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch {
      /* ignore */
    }
    wakeLock = null;
  }
}

function setupBackgroundDriftMonitor() {
  let lastTime = performance.now();
  setInterval(() => {
    const nowTime = performance.now();
    const elapsed = nowTime - lastTime;
    lastTime = nowTime;

    // Check if background throttling slowed 1s timer to > 2.5s
    if (document.hidden && elapsed > 2500) {
      notifyStatus({
        kind: "throttled",
        message: "Background tab throttling detected. Keep tab in focus for real-time order timing.",
      });
    }
  }, 1000);
}

async function pollStatusFile() {
  try {
    const status = await api("/status.json");
    if (!status) return;

    if (status.minVersion && status.minVersion > APP_VERSION) {
      notifyStatus({
        kind: "update-required",
        message: `App update required (version ${status.minVersion} is available). Please reload.`,
      });
    }
    if (status.liveEnabled === false) {
      notifyStatus({
        kind: "kill-switch",
        message: status.message || "Live trading is temporarily disabled by admin.",
      });
    } else {
      notifyStatus({ kind: "kill-switch-cleared" });
    }

    if (isLeader) {
      api("/api/status-config", {
        method: "POST",
        body: { liveEnabled: status.liveEnabled !== false, message: status.message || "" },
      }).catch(() => {});
    }
  } catch {
    /* status file polling is non-blocking */
  }
}

export async function initApi() {
  // Check browser capabilities
  const missing = checkBrowserSupport();
  if (missing.length > 0) {
    notifyStatus({
      kind: "unsupported-browser",
      message: `Your browser is missing required features: ${missing.join(", ")}. Please use modern Chrome, Edge, or Firefox.`,
    });
    return;
  }

  // Setup BroadcastChannel
  try {
    bus = new BroadcastChannel(BUS_NAME);
    bus.onmessage = (e) => {
      const msg = e.data;
      if (!msg) return;

      if (msg.type === "TICK") {
        if (msg.running !== undefined) setBotRunning(msg.running);
        notifyTick(msg);
      } else if (msg.type === "TAKEOVER_REQUEST" && isLeader) {
        console.log("[api] Received takeover request, flushing and releasing lock...");
        stopWorker();
        if (lockResolver) {
          lockResolver();
          lockResolver = null;
        }
      }
    };
  } catch (err) {
    console.warn("[api] BroadcastChannel setup error:", err);
  }

  // Storage persistence
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // Drift monitoring
  setupBackgroundDriftMonitor();

  // Flush on pagehide / visibilitychange
  const flush = () => {
    if (worker) {
      try {
        worker.postMessage({ type: "FLUSH" });
      } catch {
        /* ignore */
      }
    }
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flush();
      notifyStatus({
        kind: "tab-hidden",
        message: "Tab is in background. Timers may be throttled; keep tab visible for optimal execution.",
      });
    } else {
      notifyStatus({ kind: "tab-visible" });
      if (botRunning) {
        requestWakeLock();
      }
    }
  });

  // Start status.json check
  pollStatusFile();
  setInterval(pollStatusFile, 60000);

  // Web Locks coordination
  if (navigator.locks) {
    navigator.locks.request(LOCK_NAME, async () => {
      console.log("[api] Acquired exclusive worker lock -> Tab promoted to Leader.");
      isLeader = true;
      notifyStatus({ kind: "leader", message: "" });
      spawnWorker();

      return new Promise((resolve) => {
        lockResolver = resolve;
      });
    }).catch((err) => {
      console.warn("[api] Lock request ended:", err);
    });

    // Initial check: if lock isn't granted quickly, signal secondary mode
    setTimeout(() => {
      if (!isLeader) {
        console.log("[api] Running as Secondary Tab (Read-Only Mode).");
        notifyStatus({
          kind: "secondary",
          message: "Bot is actively running in another tab. This tab is in Read-Only mode.",
        });
      }
    }, 300);
  } else {
    // Fallback if locks unavailable
    isLeader = true;
    spawnWorker();
  }
}
