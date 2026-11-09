"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  START_FUND,
  buildEquitySeries,
  defaultStrategy,
  seedActivity,
  seedCoins,
  seedExchanges,
  seedPositions,
  seedTelemetry,
  seedTrades,
  type ActivityItem,
  type Coin,
  type EquityPoint,
  type Exchange,
  type Position,
  type Side,
  type Trade,
} from "../lib/data";
import {
  api,
  liveGuardrailsPatch,
  liveFromSettings,
  mapCoins,
  mapEquity,
  mapExchanges,
  mapLogs,
  mapPositions,
  mapTelemetry,
  mapTrades,
  metaTimestamp,
  readableError,
  type BotBootstrap,
  type BotDashboard,
  type BotExchangeStatus,
  type BotSettings,
} from "../lib/api";
import {
  maxDrawdown,
  openPnl,
  positionMetrics,
  realisedPnl,
  tradeStats,
} from "../lib/metrics";
import { usd } from "../lib/format";

export type ThemeMode = "light" | "dark" | "system";
export type TradeMode = "paper" | "live";
export type DataSource = "loading" | "live" | "offline";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export type ToastTone = "success" | "danger" | "warn" | "info";

export interface Toast {
  id: number;
  title: string;
  description?: string;
  action?: ToastAction;
  tone?: ToastTone;
}

export interface LiveGuardrails {
  exchange: string;
  marginPerTrade: number;
  dailyLossCap: number;
  maxOpenPositions: number;
  clampLeverage: boolean;
}

export interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "danger" | "primary";
  onConfirm: () => void;
}

export interface ExchangeTestResult {
  ok: boolean;
  balance?: number;
  error?: string;
}

export interface BackupPayload {
  backup: unknown;
  filename?: string;
}

interface AppContextValue {
  running: boolean;
  toggleRunning: () => void;
  scanNow: () => void;
  autoScan: () => void;
  lastScan: Date;
  updatedAt: Date;
  scanCount: number;
  positions: Position[];
  coins: Coin[];
  trades: Trade[];
  activity: ActivityItem[];
  closePosition: (id: string) => void;
  closeAll: () => void;
  panicAll: () => void;
  clearActivity: () => void;
  openTrade: (coin: Coin, side?: Side) => void;
  resetSample: () => void;
  reconcile: () => void;
  equity: number;
  openPnlValue: number;
  realised: number;
  deployedMargin: number;
  freeMargin: number;
  initialFund: number;
  series: EquityPoint[];
  stats: ReturnType<typeof tradeStats>;
  drawdown: number;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  resolvedTheme: "light" | "dark";
  reduceMotion: boolean;
  setReduceMotion: (value: boolean) => void;
  toast: Toast | null;
  notify: (
    title: string,
    description?: string,
    action?: ToastAction,
    tone?: ToastTone,
  ) => void;
  dismissToast: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
  mode: TradeMode;
  setMode: (mode: TradeMode) => void;
  openLiveConfirm: () => void;
  closeLiveConfirm: () => void;
  liveConfirmOpen: boolean;
  activateLive: () => void;
  exchanges: Exchange[];
  activeExchange: Exchange;
  setActiveExchange: (id: string) => void;
  connectExchange: (data: {
    venue: string;
    apiKey: string;
    secret: string;
    passphrase?: string;
    testnet: boolean;
  }) => Promise<boolean>;
  testExchange: (data: {
    venue: string;
    apiKey: string;
    secret: string;
    passphrase?: string;
  }) => Promise<ExchangeTestResult>;
  disconnectExchange: (id: string) => void;
  exchangeWizardVenue: string | null;
  openExchangeWizard: (venue: string) => void;
  closeExchangeWizard: () => void;
  liveGuardrails: LiveGuardrails;
  updateLiveGuardrails: (patch: Partial<LiveGuardrails>) => void;
  saveLiveGuardrails: (next: LiveGuardrails) => Promise<boolean>;
  killSwitch: boolean;
  setKillSwitch: (value: boolean) => void;
  requestConfirm: (request: ConfirmRequest) => void;
  confirmRequest: ConfirmRequest | null;
  resolveConfirm: (confirmed: boolean) => void;
  telemetry: typeof emptyTelemetry;
  dataSource: DataSource;
  apiError: string | null;
  settings: BotSettings | null;
  refresh: () => Promise<void>;
  saveSettings: (patch: Record<string, unknown>) => Promise<boolean>;
  setCoinglassKey: (key: string) => Promise<boolean>;
  exportBackup: (includeKeys: boolean) => Promise<BackupPayload | null>;
  importBackup: (backup: unknown) => Promise<boolean>;
}

const AppContext = createContext<AppContextValue | null>(null);

const emptyTelemetry = { signalP50: 0, signalP95: 0, scrapeAge: 0, bookAge: 0, loopLag: 0 };

// Venue catalogue only: connection state, keys and balances come from the bot API.
const catalogExchanges = (): Exchange[] =>
  seedExchanges.map((exchange) => ({
    ...exchange,
    connected: false,
    active: false,
    maskedKey: "",
    balance: 0,
    latency: 0,
    status: exchange.liveSupported ? "available" : "price-feed",
  }));

const optionalNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function storedTheme(): ThemeMode {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return "dark";
  try {
    const stored = localStorage.getItem("oi-theme");
    return stored === "light" || stored === "dark" || stored === "system"
      ? stored
      : "dark";
  } catch {
    return "dark";
  }
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [running, setRunning] = useState(true);
  const [positions, setPositions] = useState<Position[]>([]);
  const [coins, setCoins] = useState<Coin[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [lastScan, setLastScan] = useState(new Date());
  const [updatedAt, setUpdatedAt] = useState(new Date());
  const [scanCount, setScanCount] = useState(0);
  const [baseSeries, setBaseSeries] = useState<EquityPoint[]>([]);
  const [initialFund, setInitialFund] = useState(START_FUND);
  const [serverEquity, setServerEquity] = useState<number | null>(null);
  const [serverAvailable, setServerAvailable] = useState<number | null>(null);
  const [dataSource, setDataSource] = useState<DataSource>("loading");
  const [apiError, setApiError] = useState<string | null>(null);
  const [settings, setSettings] = useState<BotSettings | null>(defaultStrategy);
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    try {
      return storedTheme();
    } catch {
      return "dark";
    }
  });
  const [systemDark, setSystemDark] = useState(() => {
    if (typeof window === "undefined" || !window.matchMedia) return true;
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
      return true;
    }
  });
  const [reduceMotion, setReduceMotionState] = useState(() => {
    if (typeof window === "undefined" || typeof localStorage === "undefined") return false;
    try {
      return localStorage.getItem("oi-reduce-motion") === "true";
    } catch {
      return false;
    }
  });
  const [toast, setToast] = useState<Toast | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [mode, setModeState] = useState<TradeMode>("paper");
  const [liveConfirmOpen, setLiveConfirmOpen] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>(() =>
    catalogExchanges(),
  );
  const [exchangeWizardVenue, setExchangeWizardVenue] = useState<string | null>(
    null,
  );
  const [liveGuardrails, setLiveGuardrails] = useState<LiveGuardrails>({
    exchange: "bybit",
    marginPerTrade: 0,
    dailyLossCap: 0,
    maxOpenPositions: 0,
    clampLeverage: true,
  });
  const [killSwitch, setKillSwitchState] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(
    null,
  );
  const [telemetry, setTelemetry] = useState(emptyTelemetry);
  const toastId = useRef(0);
  const dataSourceRef = useRef<DataSource>("loading");
  const initialFundRef = useRef(START_FUND);
  const coinsRef = useRef<Coin[]>(coins);
  const activityClearedRef = useRef(0);

  useEffect(() => {
    dataSourceRef.current = dataSource;
  }, [dataSource]);

  useEffect(() => {
    initialFundRef.current = initialFund;
  }, [initialFund]);

  useEffect(() => {
    coinsRef.current = coins;
  }, [coins]);

  const resolvedTheme: "light" | "dark" =
    themeMode === "system" ? (systemDark ? "dark" : "light") : themeMode;

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
    document.documentElement.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  useEffect(() => {
    document.documentElement.classList.toggle("reduce-motion", reduceMotion);
  }, [reduceMotion]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 6200);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const notify = useCallback(
    (
      title: string,
      description?: string,
      action?: ToastAction,
      tone: ToastTone = "success",
    ) => {
      toastId.current += 1;
      setToast({ id: toastId.current, title, description, action, tone });
    },
    [],
  );

  const dismissToast = useCallback(() => setToast(null), []);

  const addActivity = useCallback((item: Omit<ActivityItem, "id" | "at">) => {
    setActivity((current) => [
      {
        ...item,
        id: `act_${Date.now()}_${Math.round(Math.random() * 1000)}`,
        at: new Date(),
      },
      ...current,
    ]);
  }, []);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setThemeModeState(mode);
    try {
      localStorage.setItem("oi-theme", mode);
    } catch {
      // Persistence is optional.
    }
  }, []);

  const setReduceMotion = useCallback((value: boolean) => {
    setReduceMotionState(value);
    try {
      localStorage.setItem("oi-reduce-motion", String(value));
    } catch {
      // Persistence is optional.
    }
  }, []);

  /* --------------------------------------------------------------------- */
  /* Bot API hydration                                                     */
  /* --------------------------------------------------------------------- */

  const applySettings = useCallback((next: BotSettings | null | undefined) => {
    if (!next) return;
    setSettings(next);
    setModeState(next.mode === "live" ? "live" : "paper");
    const guardrails = liveFromSettings(next);
    setLiveGuardrails((current) => ({ ...current, ...guardrails }));
  }, []);

  const applyExchangeStatus = useCallback((status: BotExchangeStatus | null) => {
    setExchanges((current) => mapExchanges(status, current));
    if (status?.mode) setModeState(status.mode === "live" ? "live" : "paper");
    if (status?.activeVenue) {
      setLiveGuardrails((current) => ({ ...current, exchange: status.activeVenue ?? current.exchange }));
    }
  }, []);

  const applyBootstrap = useCallback(
    (boot: BotBootstrap) => {
      const markets = mapCoins(boot.markets);
      const names = new Map(markets.map((coin) => [coin.symbol, coin.name]));
      const fund = Number(boot.initialFund ?? boot.settings?.totalFund ?? START_FUND);
      const safeFund = Number.isFinite(fund) && fund > 0 ? fund : START_FUND;
      initialFundRef.current = safeFund;
      setInitialFund(safeFund);
      setCoins(markets);
      setPositions(mapPositions(boot.positions, names));
      setTrades(mapTrades(boot.trades, names));
      setActivity(mapLogs(boot.logs, activityClearedRef.current));
      setBaseSeries(mapEquity(boot.equityCurve, safeFund, boot.stats?.equity));
      setServerEquity(optionalNumber(boot.stats?.equity));
      setServerAvailable(optionalNumber(boot.stats?.available));
      applySettings(boot.settings);
      setRunning(Boolean(boot.meta?.running));
      setKillSwitchState(Boolean(boot.meta?.killSwitch));
      setTelemetry(mapTelemetry(boot.speed));
      setLastScan(metaTimestamp(boot.meta));
      setUpdatedAt(new Date(boot.serverTime ?? Date.now()));
      setScanCount(Number(boot.meta?.scanCount ?? 0));
    },
    [applySettings],
  );

  const applyDashboard = useCallback((dash: BotDashboard) => {
    const markets = mapCoins(dash.markets);
    const names = new Map(markets.map((coin) => [coin.symbol, coin.name]));
    const nextFund = optionalNumber(dash.stats?.initialFund);
    const fund = nextFund && nextFund > 0 ? nextFund : initialFundRef.current;
    if (fund !== initialFundRef.current) {
      initialFundRef.current = fund;
      setInitialFund(fund);
    }
    setCoins(markets);
    setPositions(mapPositions(dash.positions, names));
    setActivity(mapLogs(dash.logs, activityClearedRef.current));
    setBaseSeries((current) => {
      const next = mapEquity(dash.equityCurve, fund, dash.stats?.equity);
      return next.length ? next : current;
    });
    setServerEquity(optionalNumber(dash.stats?.equity));
    setServerAvailable(optionalNumber(dash.stats?.available));
    setRunning(Boolean(dash.meta?.running));
    setKillSwitchState(Boolean(dash.meta?.killSwitch));
    setTelemetry(mapTelemetry(dash.speed));
    setLastScan(metaTimestamp(dash.meta));
    setUpdatedAt(new Date(dash.serverTime ?? Date.now()));
    setScanCount(Number(dash.meta?.scanCount ?? 0));
  }, []);

  const refresh = useCallback(async () => {
    if (dataSourceRef.current !== "live") return;
    try {
      const [dashboard, status] = await Promise.all([
        api.dashboard(),
        api.exchangeStatus().catch(() => null),
      ]);
      applyDashboard(dashboard);
      if (status) applyExchangeStatus(status);
      setApiError(null);
    } catch (error) {
      setApiError(readableError(error));
    }
  }, [applyDashboard, applyExchangeStatus]);

  const refreshTrades = useCallback(async () => {
    if (dataSourceRef.current !== "live") return;
    try {
      const response = await api.trades(200);
      const names = new Map(coinsRef.current.map((coin) => [coin.symbol, coin.name]));
      setTrades(mapTrades(response.trades, names));
    } catch {
      // Trade history is refreshed on the next tick.
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const boot = await api.bootstrap();
        if (cancelled) return;
        applyBootstrap(boot);
        setDataSource("live");
        dataSourceRef.current = "live";
        setApiError(null);
        try {
          const status = await api.exchangeStatus();
          if (!cancelled) applyExchangeStatus(status);
        } catch {
          // Exchange status is optional during boot.
        }
      } catch (error) {
        if (cancelled) return;
        setDataSource("offline");
        dataSourceRef.current = "offline";
        setApiError(readableError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applyBootstrap, applyExchangeStatus]);

  const wsOpenRef = useRef(false);

  useEffect(() => {
    if (dataSource !== "live") return;
    const base = api.baseUrl();
    if (!base || typeof WebSocket === "undefined") return;
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let closed = false;
    const connect = () => {
      const token = window.localStorage.getItem("oi_admin_token");
      const wsUrl = base.replace(/^http/, "ws") + "/ws" + (token ? `?token=${encodeURIComponent(token)}` : "");
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        wsOpenRef.current = true;
      };
      socket.onmessage = (event) => {
        try {
          applyDashboard(JSON.parse(event.data));
          setApiError(null);
        } catch {
          /* ignore malformed frame */
        }
      };
      socket.onclose = () => {
        wsOpenRef.current = false;
        if (!closed) retry = window.setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      wsOpenRef.current = false;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [dataSource, applyDashboard]);

  useEffect(() => {
    if (dataSource !== "live") return;
    const tick = () => {
      if (document.visibilityState === "visible" && !wsOpenRef.current) void refresh();
    };
    const interval = window.setInterval(tick, 4000);
    return () => window.clearInterval(interval);
  }, [dataSource, refresh]);

  useEffect(() => {
    if (dataSource !== "live") return;
    const tick = () => {
      if (document.visibilityState === "visible") void refreshTrades();
    };
    const interval = window.setInterval(tick, 15000);
    return () => window.clearInterval(interval);
  }, [dataSource, refreshTrades]);

  const refreshNow = useCallback(async () => {
    if (dataSourceRef.current !== "live") {
      notify("Bot offline", "The bot API is not connected. Check the backend and your admin token.", undefined, "info");
      return;
    }
    await refresh();
    await refreshTrades();
    notify("Data refreshed", "Account, positions, scanner and activity are up to date.", undefined, "info");
  }, [notify, refresh, refreshTrades]);

  /* --------------------------------------------------------------------- */
  /* Sample-only market ticker                                             */
  /* --------------------------------------------------------------------- */

  const activeExchange = useMemo(
    () =>
      exchanges.find((exchange) => exchange.active) ??
      exchanges.find((exchange) => exchange.connected) ??
      exchanges[0],
    [exchanges],
  );

  const setMode = useCallback(
    (next: TradeMode) => {
      if (next === "paper") {
        if (dataSource === "live") {
          void (async () => {
            try {
              await api.mode("paper");
              setModeState("paper");
              addActivity({
                type: "system",
                title: "Switched to paper mode",
                detail: "All fills and PnL are simulated. No exchange orders are sent.",
              });
              notify(
                "Paper trading active",
                "Positions and fills are simulated locally.",
                undefined,
                "info",
              );
              await refresh();
            } catch (error) {
              notify("Could not switch to paper", readableError(error), undefined, "danger");
            }
          })();
          return;
        }
        setModeState(next);
        addActivity({
          type: "system",
          title: "Switched to paper mode",
          detail: "All fills and PnL are simulated. No exchange orders are sent.",
        });
        notify(
          "Paper trading active",
          "Positions and fills are simulated locally.",
          undefined,
          "info",
        );
      }
    },
    [addActivity, dataSource, notify, refresh],
  );

  const openLiveConfirm = useCallback(() => setLiveConfirmOpen(true), []);
  const closeLiveConfirm = useCallback(() => setLiveConfirmOpen(false), []);

  const activateLive = useCallback(() => {
    if (!activeExchange || !activeExchange.connected || !activeExchange.liveSupported) {
      notify(
        "Connect an exchange first",
        "Live mode needs a connected exchange with futures trading enabled.",
        undefined,
        "danger",
      );
      return;
    }
    if (dataSource === "live") {
      void (async () => {
        try {
          await api.mode("live");
          setModeState("live");
          setLiveConfirmOpen(false);
          addActivity({
            type: "system",
            title: "Live execution armed",
            detail: `${activeExchange.name} selected. Guardrails: $${liveGuardrails.marginPerTrade} max margin, $${liveGuardrails.dailyLossCap} daily loss cap.`,
          });
          notify(
            "Live mode armed",
            `${activeExchange.name} will receive orders. The kill switch and guardrails are active.`,
            undefined,
            "danger",
          );
          await refresh();
        } catch (error) {
          notify("Live mode blocked", readableError(error), undefined, "danger");
        }
      })();
      return;
    }
    setModeState("live");
    setLiveConfirmOpen(false);
    addActivity({
      type: "system",
      title: "Live execution armed",
      detail: `${activeExchange.name} selected. Guardrails: $${liveGuardrails.marginPerTrade} max margin, $${liveGuardrails.dailyLossCap} daily loss cap.`,
    });
    notify(
      "Live mode armed",
      `${activeExchange.name} will receive orders. This preview does not send real orders.`,
      undefined,
      "danger",
    );
  }, [activeExchange, addActivity, dataSource, liveGuardrails, notify, refresh]);

  const setActiveExchange = useCallback(
    (id: string) => {
      const exchange = exchanges.find((item) => item.id === id);
      if (!exchange) return;
      if (dataSource === "live") {
        void (async () => {
          try {
            await api.exchangeSelect(id);
            setExchanges((current) =>
              current.map((item) => ({ ...item, active: item.id === id })),
            );
            setLiveGuardrails((current) => ({ ...current, exchange: id }));
            addActivity({
              type: "system",
              title: `Active exchange: ${exchange.name}`,
              detail: exchange.connected
                ? `Execution routes to ${exchange.name} (${exchange.tier}).`
                : `${exchange.name} selected. Connect API keys before going live.`,
            });
            notify(`Active exchange: ${exchange.name}`, exchange.tier, undefined, "info");
            await refresh();
          } catch (error) {
            notify("Could not switch exchange", readableError(error), undefined, "danger");
          }
        })();
        return;
      }
      setExchanges((current) =>
        current.map((item) => ({ ...item, active: item.id === id })),
      );
      setLiveGuardrails((current) => ({ ...current, exchange: id }));
      addActivity({
        type: "system",
        title: `Active exchange: ${exchange.name}`,
        detail: exchange.connected
          ? `Execution routes to ${exchange.name} (${exchange.tier}).`
          : `${exchange.name} selected. Connect API keys before going live.`,
      });
      notify(`Active exchange: ${exchange.name}`, exchange.tier, undefined, "info");
    },
    [addActivity, dataSource, exchanges, notify, refresh],
  );

  const testExchange = useCallback(
    async ({
      venue,
      apiKey,
      secret,
      passphrase,
    }: {
      venue: string;
      apiKey: string;
      secret: string;
      passphrase?: string;
    }): Promise<ExchangeTestResult> => {
      if (dataSource !== "live") {
        await new Promise((resolve) => window.setTimeout(resolve, 900));
        return { ok: true, balance: Math.round((500 + Math.random() * 2_200) * 100) / 100 };
      }
      try {
        const result = await api.exchangeTest({ venue, apiKey, secret, passphrase });
        return {
          ok: true,
          balance: Number(result.balance?.equityUsdt ?? result.balance?.availableUsdt ?? 0),
        };
      } catch (error) {
        return { ok: false, error: readableError(error) };
      }
    },
    [dataSource],
  );

  const connectExchange = useCallback(
    async ({
      venue,
      apiKey,
      secret,
      passphrase,
    }: {
      venue: string;
      apiKey: string;
      secret: string;
      passphrase?: string;
      testnet: boolean;
    }): Promise<boolean> => {
      const exchange = exchanges.find((item) => item.id === venue);
      if (!exchange) return false;

      if (dataSource !== "live") {
        const maskedKey = `•••• ${apiKey.slice(-4).padStart(4, "0")}`;
        const balance = Math.round((500 + Math.random() * 2_200) * 100) / 100;
        setExchanges((current) =>
          current.map((item) =>
            item.id === venue
              ? {
                  ...item,
                  connected: true,
                  active: true,
                  status: "connected",
                  maskedKey,
                  balance,
                }
              : { ...item, active: false },
          ),
        );
        setLiveGuardrails((current) => ({ ...current, exchange: venue }));
        setExchangeWizardVenue(null);
        addActivity({
          type: "system",
          title: `Connected ${exchange.name}`,
          detail: `Key ${maskedKey} verified. Trade permission enabled, withdrawals disabled.`,
        });
        notify(
          `Connected ${exchange.name}`,
          `Key verified. Balance ${usd(balance)}.`,
          { label: "Set active", onClick: () => setActiveExchange(venue) },
        );
        return true;
      }

      try {
        const test = await api.exchangeTest({ venue, apiKey, secret, passphrase });
        const balance = Number(test.balance?.equityUsdt ?? test.balance?.availableUsdt ?? 0);
        const result = await api.exchangeConnect({ venue, apiKey, secret, passphrase });
        const maskedKey = result.maskedKey ?? `•••• ${apiKey.slice(-4)}`;
        setExchanges((current) =>
          current.map((item) =>
            item.id === venue
              ? {
                  ...item,
                  connected: true,
                  active: true,
                  status: "connected",
                  maskedKey,
                  balance,
                }
              : { ...item, active: false },
          ),
        );
        setLiveGuardrails((current) => ({ ...current, exchange: venue }));
        setExchangeWizardVenue(null);
        if (result.settings) applySettings(result.settings);
        addActivity({
          type: "system",
          title: `Connected ${exchange.name}`,
          detail: `Key ${maskedKey} verified. Trade permission enabled, withdrawals disabled.`,
        });
        notify(
          `Connected ${exchange.name}`,
          `Key verified and stored in the bot vault. Balance ${usd(balance)}.`,
          { label: "Set active", onClick: () => setActiveExchange(venue) },
        );
        await refresh();
        return true;
      } catch (error) {
        notify(
          `Could not connect ${exchange.name}`,
          readableError(error),
          undefined,
          "danger",
        );
        return false;
      }
    },
    [addActivity, applySettings, dataSource, exchanges, notify, refresh, setActiveExchange],
  );

  const disconnectExchange = useCallback(
    (id: string) => {
      const exchange = exchanges.find((item) => item.id === id);
      if (!exchange) return;
      if (dataSource === "live") {
        void (async () => {
          try {
            await api.exchangeDisconnect(id);
            setExchanges((current) =>
              current.map((item) =>
                item.id === id
                  ? {
                      ...item,
                      connected: false,
                      active: false,
                      status: item.readOnly ? "price-feed" : item.liveSupported ? "available" : "paper",
                      maskedKey: "",
                      balance: 0,
                    }
                  : item,
              ),
            );
            if (activeExchange.id === id) {
              setLiveGuardrails((current) => ({ ...current, exchange: "" }));
            }
            addActivity({
              type: "system",
              title: `Disconnected ${exchange.name}`,
              detail: "API keys removed from the bot vault.",
            });
            notify(
              `Disconnected ${exchange.name}`,
              "Keys were removed from the bot vault.",
              undefined,
              "warn",
            );
            await refresh();
          } catch (error) {
            notify("Could not disconnect", readableError(error), undefined, "danger");
          }
        })();
        return;
      }
      setExchanges((current) =>
        current.map((item) =>
          item.id === id
            ? {
                ...item,
                connected: false,
                active: false,
                status: item.readOnly ? "price-feed" : item.liveSupported ? "available" : "paper",
                maskedKey: "",
                balance: 0,
              }
            : item,
        ),
      );
      if (activeExchange.id === id) {
        if (mode === "live") setModeState("paper");
        setLiveGuardrails((current) => ({ ...current, exchange: "" }));
      }
      addActivity({
        type: "system",
        title: `Disconnected ${exchange.name}`,
        detail: "API keys removed from the local vault.",
      });
      notify(
        `Disconnected ${exchange.name}`,
        mode === "live"
          ? "Live mode was returned to paper for safety."
          : "Keys were removed from this preview.",
        undefined,
        "warn",
      );
    },
    [activeExchange.id, addActivity, dataSource, exchanges, mode, notify, refresh],
  );

  const updateLiveGuardrails = useCallback(
    (patch: Partial<LiveGuardrails>) => {
      setLiveGuardrails((current) => ({ ...current, ...patch }));
      if (patch.exchange) {
        setExchanges((current) =>
          current.map((item) => ({ ...item, active: item.id === patch.exchange })),
        );
      }
    },
    [],
  );

  const saveLiveGuardrails = useCallback(
    async (next: LiveGuardrails) => {
      setLiveGuardrails(next);
      if (dataSource !== "live") return true;
      try {
        const result = await api.saveSettings(liveGuardrailsPatch(next));
        if (result.settings) applySettings(result.settings);
        return true;
      } catch (error) {
        notify("Could not save guardrails", readableError(error), undefined, "danger");
        return false;
      }
    },
    [applySettings, dataSource, notify],
  );

  const saveSettings = useCallback(
    async (patch: Record<string, unknown>) => {
      if (patch && typeof patch === "object" && patch.live) {
        setLiveGuardrails((current) => ({
          ...current,
          ...(patch.live as Partial<LiveGuardrails>),
        }));
      }
      if (dataSource !== "live") return true;
      try {
        const result = await api.saveSettings(patch);
        if (result.settings) applySettings(result.settings);
        if (result.reset) {
          await refresh();
          await refreshTrades();
        }
        return true;
      } catch (error) {
        notify("Could not save settings", readableError(error), undefined, "danger");
        return false;
      }
    },
    [applySettings, dataSource, notify, refresh, refreshTrades],
  );

  const setCoinglassKey = useCallback(
    async (key: string) => {
      if (dataSource !== "live") return true;
      try {
        const result = await api.coinglassKey(key.trim() || null);
        if (result.settings) applySettings(result.settings);
        notify(
          key.trim() ? "CoinGlass key saved" : "CoinGlass key cleared",
          key.trim()
            ? "The bot will use the official API on the next market refresh."
            : "The bot will fall back to website scraping.",
          undefined,
          "success",
        );
        await refresh();
        return true;
      } catch (error) {
        notify("Could not save the CoinGlass key", readableError(error), undefined, "danger");
        return false;
      }
    },
    [applySettings, dataSource, notify, refresh],
  );

  const exportBackup = useCallback(
    async (includeKeys: boolean): Promise<BackupPayload | null> => {
      if (dataSource !== "live") return null;
      try {
        const result = await api.backupExport(includeKeys);
        return { backup: result.backup, filename: result.filename };
      } catch (error) {
        notify("Backup failed", readableError(error), undefined, "danger");
        return null;
      }
    },
    [dataSource, notify],
  );

  const importBackup = useCallback(
    async (backup: unknown) => {
      if (dataSource !== "live") return false;
      try {
        await api.backupImport(backup);
        await refresh();
        await refreshTrades();
        notify("Backup imported", "State, settings and history were restored on the bot.", undefined, "success");
        return true;
      } catch (error) {
        notify("Import failed", readableError(error), undefined, "danger");
        return false;
      }
    },
    [dataSource, notify, refresh, refreshTrades],
  );

  const setKillSwitch = useCallback(
    (value: boolean) => {
      if (dataSource === "live") {
        void (async () => {
          try {
            await api.killSwitch(value);
            setKillSwitchState(value);
            addActivity({
              type: "risk",
              title: value ? "Kill switch activated" : "Kill switch released",
              detail: value
                ? "All new entries are blocked. Open positions continue to be managed."
                : "New entries are allowed again on the next qualified signal.",
            });
            notify(
              value ? "Kill switch active" : "Kill switch released",
              value
                ? "New entries are blocked. Existing positions stay managed."
                : "New entries can reopen on the next scan.",
              undefined,
              value ? "danger" : "success",
            );
            await refresh();
          } catch (error) {
            notify("Kill switch request failed", readableError(error), undefined, "danger");
          }
        })();
        return;
      }
      setKillSwitchState(value);
      addActivity({
        type: "risk",
        title: value ? "Kill switch activated" : "Kill switch released",
        detail: value
          ? "All new entries are blocked. Open positions continue to be managed."
          : "New entries are allowed again on the next qualified signal.",
      });
      notify(
        value ? "Kill switch active" : "Kill switch released",
        value
          ? "New entries are blocked. Existing positions stay managed."
          : "New entries can reopen on the next scan.",
        undefined,
        value ? "danger" : "success",
      );
    },
    [addActivity, dataSource, notify, refresh],
  );

  const requestConfirm = useCallback((request: ConfirmRequest) => {
    setConfirmRequest(request);
  }, []);

  const resolveConfirm = useCallback(
    (confirmed: boolean) => {
      const request = confirmRequest;
      setConfirmRequest(null);
      if (confirmed) request?.onConfirm();
    },
    [confirmRequest],
  );

  const reconcile = useCallback(() => {
    if (dataSource === "live") {
      void (async () => {
        try {
          const result = await api.reconcile();
          addActivity({
            type: "system",
            title: "Exchange state reconciled",
            detail: "Open positions, protection stops and balances verified across connected venues.",
          });
          notify(
            "Reconciliation complete",
            typeof result.message === "string"
              ? result.message
              : "Positions, stops and balances match the exchange snapshot.",
            undefined,
            "success",
          );
          await refresh();
        } catch (error) {
          notify("Reconciliation failed", readableError(error), undefined, "danger");
        }
      })();
      return;
    }
    addActivity({
      type: "system",
      title: "Exchange state reconciled",
      detail: "Open positions, protection stops and balances verified across connected venues.",
    });
    notify(
      "Reconciliation complete",
      "Positions, stops and balances match the exchange snapshot.",
      undefined,
      "success",
    );
  }, [addActivity, dataSource, notify, refresh]);

  const toggleRunning = useCallback(() => {
    if (dataSource === "live") {
      const next = !running;
      void (async () => {
        try {
          await api.control(next ? "start" : "pause");
          setRunning(next);
          notify(
            next ? "Engine running" : "Engine paused",
            next
              ? "Scanning the CoinGlass universe on the configured cadence."
              : "Open positions stay marked. No new entries will open.",
          );
          addActivity({
            type: "system",
            title: next ? "Engine started" : "Engine paused",
            detail: next
              ? "Scan loop resumed"
              : "Scan loop halted by the operator, positions remain open",
          });
          await refresh();
        } catch (error) {
          notify("Engine control failed", readableError(error), undefined, "danger");
        }
      })();
      return;
    }
    setRunning((current) => {
      const next = !current;
      notify(
        next ? "Engine running" : "Engine paused",
        next
          ? "Scanning the CoinGlass universe on a 30-second cadence."
          : "Open positions stay marked. No new entries will open.",
      );
      addActivity({
        type: "system",
        title: next ? "Engine started" : "Engine paused",
        detail: next
          ? "Scan loop resumed, paper account only"
          : "Scan loop halted by the operator, positions remain open",
      });
      return next;
    });
  }, [addActivity, dataSource, notify, refresh, running]);

  const scanNow = useCallback(() => {
    if (dataSource === "live") {
      void (async () => {
        try {
          const result = await api.scan();
          await refresh();
          await refreshTrades();
          const qualified = Number(result.qualified ?? 0);
          const opened = Number(result.opened ?? 0);
          const total = Number(result.total ?? 0);
          notify(
            "Scan complete",
            `${total} coins scanned, ${qualified} qualified, ${opened} position${opened === 1 ? "" : "s"} opened.`,
            undefined,
            "success",
          );
        } catch (error) {
          notify("Scan failed", readableError(error), undefined, "danger");
        }
      })();
      return;
    }
    const qualified = coins.filter((coin) => coin.status === "qualified").length;
    const scanned = 412 + Math.round(Math.random() * 6);
    setLastScan(new Date());
    setUpdatedAt(new Date());
    setScanCount((count) => count + 1);
    addActivity({
      type: "scan",
      title: "Manual scan complete",
      detail: `${scanned} coins scanned, ${qualified} qualified, manual pass`,
    });
    notify(
      "Scan complete",
      `${qualified} qualified signals. ${running ? "The engine evaluates entries on the next pass." : "Dry run while paused."}`,
    );
  }, [addActivity, coins, dataSource, notify, refresh, refreshTrades, running]);

  const autoScan = useCallback(() => {
    setLastScan(new Date());
    setUpdatedAt(new Date());
    setScanCount((count) => count + 1);
  }, []);

  const closePosition = useCallback(
    (id: string) => {
      const position = positions.find((item) => item.id === id);
      if (!position) return;
      if (dataSource === "live") {
        void (async () => {
          try {
            await api.closeTrade(id);
            await refresh();
            await refreshTrades();
            notify(
              `Closed ${position.symbol} ${position.side}`,
              "The exchange position and its protection orders were closed.",
              undefined,
              "success",
            );
          } catch (error) {
            notify("Close failed", readableError(error), undefined, "danger");
          }
        })();
        return;
      }
      const metrics = positionMetrics(position);
      const closed: Trade = {
        id: `trade_${Date.now()}`,
        symbol: position.symbol,
        name: position.name,
        side: position.side,
        margin: position.margin,
        leverage: position.leverage,
        entry: position.entry,
        exit: position.mark,
        pnl: metrics.pnl,
        roe: metrics.roe,
        fees: Number((metrics.notional * 0.001).toFixed(2)),
        openedAt: position.openedAt,
        closedAt: new Date(),
        reason: "Manual",
      };
      setPositions((current) => current.filter((item) => item.id !== id));
      setTrades((current) => [closed, ...current]);
      addActivity({
        type: "trade",
        title: `Closed ${position.symbol} ${position.side}`,
        detail: `Manual exit at ${position.mark.toLocaleString("en-US", { maximumFractionDigits: 4 })}, ${metrics.pnl >= 0 ? "realised +" : "realised "}$${Math.abs(metrics.pnl).toFixed(2)}`,
      });
      notify(
        `Closed ${position.symbol} ${position.side}`,
        `${metrics.pnl >= 0 ? "+" : "-"}$${Math.abs(metrics.pnl).toFixed(2)} realised, ${metrics.roe >= 0 ? "+" : ""}${metrics.roe.toFixed(1)}% ROE`,
        {
          label: "Undo",
          onClick: () => {
            setPositions((current) => [position, ...current]);
            setTrades((current) => current.filter((trade) => trade.id !== closed.id));
            dismissToast();
          },
        },
      );
    },
    [addActivity, dataSource, dismissToast, notify, positions, refresh, refreshTrades],
  );

  const openTrade = useCallback(
    (coin: Coin, side?: Side) => {
      if (killSwitch) {
        notify(
          "Kill switch is active",
          "Disable the kill switch before opening a new position.",
          undefined,
          "danger",
        );
        return;
      }
      if (mode === "live" && (!activeExchange.connected || !activeExchange.liveSupported)) {
        notify(
          "No live exchange connected",
          "Connect an exchange with futures trading enabled before routing live orders.",
          undefined,
          "danger",
        );
        return;
      }
      if (dataSource === "live") {
        const direction = side ?? coin.direction;
        void (async () => {
          try {
            await api.openTrade(coin.symbol, direction);
            await refresh();
            await refreshTrades();
            notify(
              `Opened ${coin.symbol} ${direction}`,
              `The bot submitted the position on ${activeExchange.name} with its protection ladder.`,
              undefined,
              mode === "live" ? "warn" : "success",
            );
          } catch (error) {
            notify(`Could not open ${coin.symbol}`, readableError(error), undefined, "danger");
          }
        })();
        return;
      }
      const direction = side ?? coin.direction;
      const leverage = direction === "long" ? 50 : 25;
      const margin =
        liveGuardrails.marginPerTrade > 0
          ? Math.min(500, liveGuardrails.marginPerTrade)
          : 500;
      const entry = coin.price;
      const tp1 =
        direction === "long" ? entry * 1.01 : entry * 0.99;
      const tpMax =
        direction === "long" ? entry * 1.2 : entry * 0.8;
      const stop =
        direction === "long" ? entry * 0.996 : entry * 1.004;
      const id = `pos_${coin.symbol}_${Date.now()}`;
      const position: Position = {
        id,
        symbol: coin.symbol,
        name: coin.name,
        side: direction,
        leverage,
        margin,
        entry,
        mark: entry,
        tp1,
        tpMax,
        stop,
        openedAt: new Date(),
        spark: [...coin.spark],
        trailingArmed: false,
        venue: activeExchange.name,
        routeBps:
          Math.round(
            (activeExchange.feeBps / 2 + (100 - coin.score) * 0.08 + 1.4) * 10,
          ) / 10,
        exitLiquidity: coin.status === "qualified" ? "OK" : "Thin",
      };
      setPositions((current) => [position, ...current]);
      setLastScan(new Date());
      addActivity({
        type: "trade",
        title: `${mode === "live" ? "Live" : "Opened"} ${coin.symbol} ${direction}`,
        detail: `$${margin} margin at ${leverage}A- on ${activeExchange.name}, entry ${coin.price.toLocaleString("en-US", { maximumFractionDigits: 4 })}, signal score ${coin.score}`,
      });
      notify(
        `${mode === "live" ? "Live order preview" : "Opened"} ${coin.symbol} ${direction}`,
        `$${margin} margin at ${leverage}A- on ${activeExchange.name}, TP1 ${tp1.toLocaleString("en-US", { maximumFractionDigits: 4 })}`,
        {
          label: "Undo",
          onClick: () => {
            setPositions((current) => current.filter((item) => item.id !== id));
            dismissToast();
          },
        },
        mode === "live" ? "warn" : "success",
      );
    },
    [
      activeExchange,
      addActivity,
      dataSource,
      dismissToast,
      killSwitch,
      liveGuardrails.marginPerTrade,
      mode,
      notify,
      refresh,
      refreshTrades,
    ],
  );

  const closeAll = useCallback(() => {
    if (!positions.length) {
      notify("Nothing to close", "There are no open positions.", undefined, "info");
      return;
    }
    if (dataSource === "live") {
      void (async () => {
        try {
          await api.control("close-all");
          await refresh();
          await refreshTrades();
          notify(
            `Closed ${positions.length} position${positions.length === 1 ? "" : "s"}`,
            "All open positions were closed and their protection orders cancelled.",
            undefined,
            "warn",
          );
        } catch (error) {
          notify("Close all failed", readableError(error), undefined, "danger");
        }
      })();
      return;
    }
    const closed = positions.map((position, index) => {
      const metrics = positionMetrics(position);
      return {
        id: `trade_all_${Date.now()}_${index}`,
        symbol: position.symbol,
        name: position.name,
        side: position.side,
        margin: position.margin,
        leverage: position.leverage,
        entry: position.entry,
        exit: position.mark,
        pnl: metrics.pnl,
        roe: metrics.roe,
        fees: Number((metrics.notional * 0.001).toFixed(2)),
        openedAt: position.openedAt,
        closedAt: new Date(),
        reason: "Manual" as const,
      };
    });
    const ids = new Set(closed.map((trade) => trade.id));
    setPositions([]);
    setTrades((current) => [...closed, ...current]);
    addActivity({
      type: "trade",
      title: `Closed all ${positions.length} positions`,
      detail: "Every open paper position was closed at the current mark.",
    });
    notify(
      `Closed ${positions.length} positions`,
      "All open positions are flat. The entry engine is unchanged.",
      {
        label: "Undo",
        onClick: () => {
          setPositions((current) => [...positions, ...current]);
          setTrades((current) =>
            current.filter((trade) => !ids.has(trade.id)),
          );
          dismissToast();
        },
      },
      "warn",
    );
  }, [addActivity, dataSource, dismissToast, notify, positions, refresh, refreshTrades]);

  const panicAll = useCallback(() => {
    if (dataSource === "live") {
      void (async () => {
        try {
          await api.panic();
          await api.killSwitch(true);
          setKillSwitchState(true);
          await refresh();
          await refreshTrades();
          addActivity({
            type: "risk",
            title: "Panic executed",
            detail: "All positions closed and the kill switch was activated.",
          });
          notify(
            "Panic executed",
            "All positions are closed and the kill switch is on. Live routing is stopped.",
            undefined,
            "danger",
          );
        } catch (error) {
          notify("Panic request failed", readableError(error), undefined, "danger");
        }
      })();
      return;
    }
    closeAll();
    setKillSwitchState(true);
    addActivity({
      type: "risk",
      title: "Panic executed",
      detail: "All positions closed and the kill switch was activated.",
    });
    notify(
      "Panic executed",
      "All positions are closed and the kill switch is on. Live routing is stopped.",
      undefined,
      "danger",
    );
  }, [addActivity, closeAll, dataSource, notify, refresh, refreshTrades]);

  const resetSample = useCallback(() => {
    if (dataSource === "live") {
      void (async () => {
        try {
          await api.control("reset");
          await refresh();
          await refreshTrades();
          notify(
            "Account reset",
            "Trades, positions, logs and the equity curve were cleared on the bot.",
            undefined,
            "warn",
          );
        } catch (error) {
          notify("Reset failed", readableError(error), undefined, "danger");
        }
      })();
      return;
    }
    notify("Bot offline", "Reset needs a connection to the bot API.", undefined, "info");
  }, [dataSource, notify, refresh, refreshTrades]);

  const clearActivity = useCallback(() => {
    activityClearedRef.current = Date.now();
    setActivity([]);
    notify("Activity cleared", "The live event view is empty. Settings and trades are unchanged.", undefined, "info");
  }, [notify]);

  const { equity, openPnlValue, realised, deployedMargin, freeMargin } = useMemo(() => {
    const open = openPnl(positions);
    const realisedValue = realisedPnl(trades);
    const deployed = positions.reduce(
      (sum, position) => sum + position.margin,
      0,
    );
    if (dataSource === "live" && serverEquity !== null) {
      return {
        equity: serverEquity,
        openPnlValue: open,
        realised: realisedValue,
        deployedMargin: deployed,
        freeMargin: serverAvailable ?? serverEquity - deployed,
      };
    }
    return {
      equity: initialFund + realisedValue + open,
      openPnlValue: open,
      realised: realisedValue,
      deployedMargin: deployed,
      freeMargin: initialFund + realisedValue - deployed,
    };
  }, [dataSource, initialFund, positions, serverAvailable, serverEquity, trades]);

  const series = useMemo<EquityPoint[]>(() => {
    if (baseSeries.length === 0) return baseSeries;
    return [
      ...baseSeries.slice(0, -1),
      { at: updatedAt, value: equity },
    ];
  }, [baseSeries, equity, updatedAt]);

  const stats = useMemo(() => tradeStats(trades), [trades]);
  const drawdown = useMemo(() => maxDrawdown(series), [series]);

  const value: AppContextValue = {
    running,
    toggleRunning,
    scanNow,
    autoScan,
    lastScan,
    updatedAt,
    scanCount,
    positions,
    coins,
    trades,
    activity,
    closePosition,
    closeAll,
    panicAll,
    clearActivity,
    openTrade,
    resetSample,
    reconcile,
    equity,
    openPnlValue,
    realised,
    deployedMargin,
    freeMargin,
    initialFund,
    series,
    stats,
    drawdown,
    themeMode,
    setThemeMode,
    resolvedTheme,
    reduceMotion,
    setReduceMotion,
    toast,
    notify,
    dismissToast,
    paletteOpen,
    setPaletteOpen,
    mobileNavOpen,
    setMobileNavOpen,
    mode,
    setMode,
    openLiveConfirm,
    closeLiveConfirm,
    liveConfirmOpen,
    activateLive,
    exchanges,
    activeExchange,
    setActiveExchange,
    connectExchange,
    testExchange,
    disconnectExchange,
    exchangeWizardVenue,
    openExchangeWizard: setExchangeWizardVenue,
    closeExchangeWizard: () => setExchangeWizardVenue(null),
    liveGuardrails,
    updateLiveGuardrails,
    saveLiveGuardrails,
    killSwitch,
    setKillSwitch,
    requestConfirm,
    confirmRequest,
    resolveConfirm,
    telemetry,
    dataSource,
    apiError,
    settings,
    refresh: refreshNow,
    saveSettings,
    setCoinglassKey,
    exportBackup,
    importBackup,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}

export const useAppStore = useApp;
