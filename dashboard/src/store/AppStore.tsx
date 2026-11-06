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
  maxDrawdown,
  openPnl,
  positionMetrics,
  realisedPnl,
  tradeStats,
} from "../lib/metrics";
import { usd } from "../lib/format";

export type ThemeMode = "light" | "dark" | "system";
export type TradeMode = "paper" | "live";

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
  }) => void;
  disconnectExchange: (id: string) => void;
  exchangeWizardVenue: string | null;
  openExchangeWizard: (venue: string) => void;
  closeExchangeWizard: () => void;
  liveGuardrails: LiveGuardrails;
  updateLiveGuardrails: (patch: Partial<LiveGuardrails>) => void;
  killSwitch: boolean;
  setKillSwitch: (value: boolean) => void;
  requestConfirm: (request: ConfirmRequest) => void;
  confirmRequest: ConfirmRequest | null;
  resolveConfirm: (confirmed: boolean) => void;
  telemetry: typeof seedTelemetry;
}


const AppContext = createContext<AppContextValue | null>(null);

const clonePositions = () =>
  seedPositions.map((position) => ({
    ...position,
    openedAt: new Date(position.openedAt),
    spark: [...position.spark],
  }));

const cloneTrades = () =>
  seedTrades.map((trade) => ({
    ...trade,
    openedAt: new Date(trade.openedAt),
    closedAt: new Date(trade.closedAt),
  }));

const cloneActivity = () =>
  seedActivity.map((item) => ({ ...item, at: new Date(item.at) }));

const cloneCoins = () =>
  seedCoins.map((coin) => ({ ...coin, spark: [...coin.spark] }));

function storedTheme(): ThemeMode {
  const stored = localStorage.getItem("oi-theme");
  return stored === "light" || stored === "dark" || stored === "system"
    ? stored
    : "system";
}

const initialOpenPnl = openPnl(seedPositions);
const initialEquity = START_FUND + realisedPnl(seedTrades) + initialOpenPnl;

export function AppProvider({ children }: { children: ReactNode }) {
  const [running, setRunning] = useState(true);
  const [positions, setPositions] = useState<Position[]>(clonePositions);
  const [coins, setCoins] = useState<Coin[]>(cloneCoins);
  const [trades, setTrades] = useState<Trade[]>(cloneTrades);
  const [activity, setActivity] = useState<ActivityItem[]>(cloneActivity);
  const [lastScan, setLastScan] = useState(new Date(Date.now() - 11_000));
  const [updatedAt, setUpdatedAt] = useState(new Date());
  const [scanCount, setScanCount] = useState(0);
  const [baseSeries] = useState(() =>
    buildEquitySeries(START_FUND, initialEquity),
  );
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => {
    try {
      return storedTheme();
    } catch {
      return "system";
    }
  });
  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const [reduceMotion, setReduceMotionState] = useState(() => {
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
    seedExchanges.map((exchange) => ({ ...exchange })),
  );
  const [exchangeWizardVenue, setExchangeWizardVenue] = useState<string | null>(
    null,
  );
  const [liveGuardrails, setLiveGuardrails] = useState<LiveGuardrails>({
    exchange: "bybit",
    marginPerTrade: 500,
    dailyLossCap: 250,
    maxOpenPositions: 4,
    clampLeverage: true,
  });
  const [killSwitch, setKillSwitchState] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(
    null,
  );
  const [telemetry, setTelemetry] = useState(seedTelemetry);
  const toastId = useRef(0);

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

  useEffect(() => {
    if (!running) return;
    const interval = window.setInterval(() => {
      setPositions((current) =>
        current.map((position) => {
          const volatility = position.leverage >= 40 ? 0.00055 : 0.001;
          const move = (Math.random() - 0.48) * volatility;
          const mark = position.mark * (1 + move);
          return {
            ...position,
            mark,
            spark: [...position.spark.slice(1), mark],
          };
        }),
      );
      setCoins((current) =>
        current.map((coin) => {
          const move = (Math.random() - 0.5) * 0.0016;
          const next = coin.price * (1 + move);
          return {
            ...coin,
            price: next,
            spark: [...coin.spark.slice(1), next],
          };
        }),
      );
      setUpdatedAt(new Date());
      setTelemetry((current) => ({
        ...current,
        signalP50: 34 + Math.round(Math.random() * 18),
        signalP95: 96 + Math.round(Math.random() * 42),
        scrapeAge: 150 + Math.round(Math.random() * 90),
        bookAge: 60 + Math.round(Math.random() * 60),
        loopLag: 6 + Math.round(Math.random() * 14),
      }));
    }, 2600);
    return () => window.clearInterval(interval);
  }, [running]);

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
      // Local preview — persistence is optional.
    }
  }, []);

  const setReduceMotion = useCallback((value: boolean) => {
    setReduceMotionState(value);
    try {
      localStorage.setItem("oi-reduce-motion", String(value));
    } catch {
      // Local preview — persistence is optional.
    }
  }, []);

  const activeExchange = useMemo(
    () =>
      exchanges.find((exchange) => exchange.active) ??
      exchanges.find((exchange) => exchange.connected) ??
      exchanges[0],
    [exchanges],
  );

  const setMode = useCallback(
    (next: TradeMode) => {
      setModeState(next);
      if (next === "paper") {
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
    [addActivity, notify],
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
  }, [activeExchange, addActivity, liveGuardrails, notify]);

  const setActiveExchange = useCallback(
    (id: string) => {
      const exchange = exchanges.find((item) => item.id === id);
      if (!exchange) return;
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
    [addActivity, exchanges, notify],
  );

  const connectExchange = useCallback(
    ({
      venue,
      apiKey,
      secret,
      passphrase,
      testnet,
    }: {
      venue: string;
      apiKey: string;
      secret: string;
      passphrase?: string;
      testnet: boolean;
    }) => {
      const exchange = exchanges.find((item) => item.id === venue);
      if (!exchange) return;
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
        detail: `${testnet ? "Testnet" : "Mainnet"} key ${maskedKey} verified. Trade permission enabled, withdrawals disabled.`,
      });
      notify(
        `Connected ${exchange.name}`,
        `${testnet ? "Testnet" : "Mainnet"} key verified. Balance ${usd(balance)}.`,
        {
          label: "Set active",
          onClick: () => setActiveExchange(venue),
        },
      );
    },
    [addActivity, exchanges, notify, setActiveExchange],
  );

  const disconnectExchange = useCallback(
    (id: string) => {
      const exchange = exchanges.find((item) => item.id === id);
      if (!exchange) return;
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
    [activeExchange.id, addActivity, exchanges, mode, notify],
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

  const setKillSwitch = useCallback(
    (value: boolean) => {
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
    [addActivity, notify],
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
  }, [addActivity, notify]);


  const toggleRunning = useCallback(() => {
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
  }, [addActivity, notify]);

  const scanNow = useCallback(() => {
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
  }, [addActivity, coins, notify, running]);

  const autoScan = useCallback(() => {
    setLastScan(new Date());
    setUpdatedAt(new Date());
    setScanCount((count) => count + 1);
  }, []);

  const closePosition = useCallback(    (id: string) => {
      const position = positions.find((item) => item.id === id);
      if (!position) return;
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
    [addActivity, dismissToast, notify, positions],
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
        detail: `$${margin} margin at ${leverage}× on ${activeExchange.name}, entry ${coin.price.toLocaleString("en-US", { maximumFractionDigits: 4 })}, signal score ${coin.score}`,
      });
      notify(
        `${mode === "live" ? "Live order preview" : "Opened"} ${coin.symbol} ${direction}`,
        `$${margin} margin at ${leverage}× on ${activeExchange.name}, TP1 ${tp1.toLocaleString("en-US", { maximumFractionDigits: 4 })}`,
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
      dismissToast,
      killSwitch,
      liveGuardrails.marginPerTrade,
      mode,
      notify,
    ],
  );

  const closeAll = useCallback(() => {
    if (!positions.length) {
      notify("Nothing to close", "There are no open positions.", undefined, "info");
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
  }, [addActivity, dismissToast, notify, positions]);

  const panicAll = useCallback(() => {
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
  }, [addActivity, closeAll, notify]);

  const resetSample = useCallback(() => {
    setPositions(clonePositions());
    setTrades(cloneTrades());
    setActivity(cloneActivity());
    setCoins(cloneCoins());
    setLastScan(new Date(Date.now() - 11_000));
    setUpdatedAt(new Date());
    setScanCount(0);
    notify(
      "Sample data reset",
      "The paper account is back to its preview state.",
      undefined,
      "info",
    );
  }, [notify]);

  const clearActivity = useCallback(() => {
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
    return {
      equity: START_FUND + realisedValue + open,
      openPnlValue: open,
      realised: realisedValue,
      deployedMargin: deployed,
      freeMargin: START_FUND + realisedValue - deployed,
    };
  }, [positions, trades]);

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
    disconnectExchange,
    exchangeWizardVenue,
    openExchangeWizard: setExchangeWizardVenue,
    closeExchangeWizard: () => setExchangeWizardVenue(null),
    liveGuardrails,
    updateLiveGuardrails,
    killSwitch,
    setKillSwitch,
    requestConfirm,
    confirmRequest,
    resolveConfirm,
    telemetry,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error("useApp must be used inside AppProvider");
  return context;
}
