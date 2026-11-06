import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  BarChart3,
  ChevronRight,
  CircleHelp,
  Crosshair,
  History,
  Layers3,
  LayoutDashboard,
  Link2,
  Menu,
  Moon,
  Pause,
  Play,
  Power,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Shield,
  ShieldAlert,
  SlidersHorizontal,
  Sun,
  WalletCards,
  X,
} from "lucide-react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useApp } from "../store/AppStore";
import { ago, clockTime, cn, usd } from "../lib/format";
import { Button, Card, Kbd, Pill, Switch } from "./ui";
import { CommandPalette } from "./CommandPalette";
import { Toast } from "./Toast";
import {
  ConfirmDialog,
  ExchangeWizard,
  LiveConfirmModal,
  QuickGuideModal,
} from "./ActionModals";

const pageTitles: Record<string, string> = {
  "/": "Overview",
  "/scanner": "Live scanner",
  "/feed": "Market feed",
  "/positions": "Positions",
  "/performance": "Performance",
  "/history": "History",
  "/strategy": "Strategy",
  "/exchanges": "Exchanges",
  "/activity": "Activity",
  "/settings": "Settings",
};

const navGroups = [
  {
    label: "Trading",
    items: [
      { label: "Overview", path: "/", icon: LayoutDashboard },
      { label: "Live scanner", path: "/scanner", icon: Crosshair },
      { label: "Market feed", path: "/feed", icon: Radio },
      { label: "Positions", path: "/positions", icon: Layers3, count: true },
    ],
  },
  {
    label: "Analytics",
    items: [
      { label: "Performance", path: "/performance", icon: BarChart3 },
      { label: "History", path: "/history", icon: History },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Strategy", path: "/strategy", icon: SlidersHorizontal },
      { label: "Exchanges", path: "/exchanges", icon: Link2 },
      { label: "Activity", path: "/activity", icon: Activity },
      { label: "Settings", path: "/settings", icon: Settings2 },
    ],
  },
];

function Brand({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        "flex h-[64px] shrink-0 items-center gap-2.5 border-b border-line",
        collapsed ? "justify-center px-3" : "px-5",
      )}
    >
      <Link
        to="/"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-accent shadow-button"
        aria-label="OI Sniper home"
      >
        <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true">
          <path
            d="M7 22.2 13 15l4.2 3.2L25 9.5"
            fill="none"
            stroke="white"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="25" cy="9.5" r="1.9" fill="white" />
        </svg>
      </Link>
      {!collapsed ? (
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-semibold leading-none tracking-[-0.015em] text-ink">
            OI Sniper
          </p>
          <p className="mt-1 truncate text-[10px] leading-none text-muted">
            Execution workstation
          </p>
        </div>
      ) : null}
    </div>
  );
}

function SidebarNav({
  collapsed,
  onNavigate,
}: {
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const { positions } = useApp();
  return (
    <nav className={cn("flex-1 overflow-y-auto py-4", collapsed ? "px-2.5" : "px-3")}>
      {navGroups.map((group) => (
        <div key={group.label} className="mb-5 last:mb-0">
          {!collapsed ? (
            <p className="mb-1.5 px-2.5 text-[10px] font-medium text-faint">
              {group.label}
            </p>
          ) : null}
          <div className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = item.icon;
              const count = item.count ? positions.length : null;
              return (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === "/"}
                  onClick={onNavigate}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    cn(
                      "group relative flex h-9 items-center rounded-[9px] text-[12.5px] font-medium transition-colors duration-150",
                      collapsed ? "justify-center px-0" : "gap-2.5 px-2.5",
                      isActive
                        ? "bg-accent-soft text-accent"
                        : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        size={16}
                        strokeWidth={isActive ? 2 : 1.8}
                        className={cn("shrink-0", isActive ? "text-accent" : "text-muted group-hover:text-ink-2")}
                        aria-hidden="true"
                      />
                      {!collapsed ? (
                        <>
                          <span className="min-w-0 flex-1 truncate">{item.label}</span>
                          {count ? (
                            <span
                              className={cn(
                                "num rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold leading-none",
                                isActive
                                  ? "bg-accent-soft-2 text-accent"
                                  : "bg-surface-2 text-muted",
                              )}
                            >
                              {count}
                            </span>
                          ) : null}
                        </>
                      ) : count ? (
                        <span className="absolute ml-4 -mt-4 h-1.5 w-1.5 rounded-full bg-accent" />
                      ) : null}
                    </>
                  )}
                </NavLink>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

function AccountCard({ collapsed }: { collapsed: boolean }) {
  const { equity, mode, activeExchange } = useApp();
  const live = mode === "live";
  const accountValue = live ? activeExchange.balance : equity;
  const accountLink = live ? "/exchanges" : "/settings";

  if (collapsed) {
    return (
      <div className="border-t border-line p-2.5">
        <Link
          to={accountLink}
          title={live ? "Live account" : "Paper account"}
          className="flex h-10 items-center justify-center rounded-[10px] border border-line bg-surface text-muted transition-colors duration-150 hover:text-ink"
        >
          <WalletCards size={17} strokeWidth={1.8} aria-hidden="true" />
        </Link>
      </div>
    );
  }

  return (
    <div className="border-t border-line p-3">
      <Card className="p-3.5 shadow-none">
        <Link to={accountLink} className="flex items-center gap-2">
          <span
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-full",
              live ? "bg-neg-soft text-neg" : "bg-accent-soft text-accent",
            )}
          >
            <WalletCards size={14} strokeWidth={1.9} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11.5px] font-medium leading-none text-ink">
              {live ? "Live account" : "Paper account"}
              {live ? (
                <span className="text-[8.5px] font-semibold text-neg">Live</span>
              ) : null}
            </p>
            <p className="mt-1 truncate text-[9.5px] leading-none text-muted">
              {live
                ? `${activeExchange.name}, ${activeExchange.connected ? "connected" : "not connected"}`
                : "Simulated balance"}
            </p>
          </div>
        </Link>
        <p className="num mt-3 text-[19px] font-semibold tracking-[-0.02em] text-ink">
          {usd(accountValue)}
        </p>
        <div className="mt-2.5 flex items-center justify-between border-t border-line pt-2.5">
          <span className="flex items-center gap-1.5 text-[10px] text-muted">
            <span className="status-dot text-pos" aria-hidden="true" />
            CoinGlass feed
          </span>
          <span className="num text-[10px] text-faint">190 ms</span>
        </div>
      </Card>
      <Link
        to={accountLink}
        className="mt-2 flex h-8 items-center justify-center gap-1.5 rounded-[9px] text-[10.5px] font-medium text-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
      >
        {live ? "Exchange settings" : "Account settings"}
        <ChevronRight size={11} aria-hidden="true" />
      </Link>
    </div>
  );
}

function ModeSwitch() {
  const { mode, setMode, openLiveConfirm } = useApp();
  return (
    <div
      className="hidden h-8 items-center gap-0.5 rounded-full border border-line bg-surface-2 p-0.5 sm:inline-flex"
      role="group"
      aria-label="Execution mode"
    >
      <button
        type="button"
        aria-pressed={mode === "paper"}
        title="Use paper execution"
        onClick={() => mode === "live" && setMode("paper")}
        className={cn(
          "h-7 rounded-full px-2.5 text-[10.5px] font-semibold transition-colors duration-150",
          mode === "paper"
            ? "bg-[var(--seg-active)] text-ink shadow-[0_1px_2px_rgba(0,0,0,0.07)]"
            : "text-muted hover:text-ink",
        )}
      >
        Paper
      </button>
      <button
        type="button"
        aria-pressed={mode === "live"}
        title="Switch to live execution"
        onClick={() => mode !== "live" && openLiveConfirm()}
        className={cn(
          "h-7 rounded-full px-2.5 text-[10.5px] font-semibold transition-colors duration-150",
          mode === "live"
            ? "bg-neg text-[var(--on-accent)] shadow-[0_1px_2px_rgba(0,0,0,0.12)]"
            : "text-muted hover:text-ink",
        )}
      >
        Live
      </button>
    </div>
  );
}

function ExchangePill() {
  const { activeExchange, mode } = useApp();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate("/exchanges")}
      title="Manage exchange connections"
      className={cn(
        "hidden h-8 items-center gap-1.5 rounded-full border px-2.5 text-[10.5px] font-medium transition-colors duration-150 min-[1400px]:inline-flex",
        mode === "live"
          ? "border-neg/30 bg-neg-soft text-neg hover:bg-neg-soft"
          : "border-line bg-surface text-ink-2 hover:border-line-strong hover:text-ink",
      )}
    >
      <Link2 size={12} strokeWidth={1.9} aria-hidden="true" />
      {activeExchange?.name ?? "Exchanges"}
      <span
        className={cn(
          "status-dot",
          activeExchange?.connected ? "text-pos" : "text-faint",
        )}
        aria-hidden="true"
      />
    </button>
  );
}

function FeedStatusPill() {
  const { lastScan } = useApp();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate("/feed")}
      title={`CoinGlass browser feed · 190 ms · last scan ${lastScan.toLocaleTimeString("en-US")}`}
      className="hidden h-8 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-[10px] font-medium text-ink-2 transition-colors duration-150 hover:border-line-strong hover:text-ink min-[1400px]:inline-flex"
    >
      <span className="status-dot text-pos" aria-hidden="true" />
      Feed
      <span className="num text-[9px] text-faint">190 ms</span>
    </button>
  );
}

function SafetyMenu({ onOpenGuide }: { onOpenGuide: () => void }) {
  const {
    mode,
    killSwitch,
    setKillSwitch,
    closeAll,
    panicAll,
    resetSample,
    reconcile,
    requestConfirm,
    activeExchange,
  } = useApp();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = (action: () => void) => {
    setOpen(false);
    action();
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        aria-label="Safety controls"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-[9px] transition-colors duration-150",
          killSwitch
            ? "bg-neg-soft text-neg"
            : "text-ink-2 hover:bg-surface-2 hover:text-ink",
        )}
      >
        <Shield size={17} strokeWidth={1.8} aria-hidden="true" />
        {killSwitch ? (
          <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-neg" aria-hidden="true" />
        ) : null}
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -3, scale: 0.99 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 top-[44px] z-50 w-[262px] overflow-hidden rounded-[14px] border border-line bg-surface p-1.5 shadow-float"
            role="menu"
            aria-label="Safety controls"
          >
            <div className="flex items-center justify-between px-2.5 pb-2 pt-1.5">
              <span className="text-[10px] font-medium text-faint">Safety</span>
              <Pill tone={mode === "live" ? "neg" : "neutral"} className="h-5 px-2 text-[9px]">
                {mode === "live" ? `Live · ${activeExchange?.name ?? ""}` : "Paper"}
              </Pill>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-[9px] px-2.5 py-2 hover:bg-surface-2">
              <span className="flex items-center gap-2.5 text-[11.5px] text-ink-2">
                <Power size={14} strokeWidth={1.8} className={killSwitch ? "text-neg" : "text-muted"} aria-hidden="true" />
                Kill switch
              </span>
              <Switch
                checked={killSwitch}
                onChange={setKillSwitch}
                label="Kill switch"
              />
            </div>

            <div className="my-1 h-px bg-line" />

            <button
              type="button"
              role="menuitem"
              onClick={() =>
                run(() =>
                  requestConfirm({
                    title: "Close every open position?",
                    description:
                      "All positions close at the current mark. The engine keeps running and can open new signals unless the kill switch is on.",
                    confirmLabel: "Close all positions",
                    tone: "danger",
                    onConfirm: closeAll,
                  }),
                )
              }
              className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[11.5px] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
            >
              <Layers3 size={14} strokeWidth={1.8} className="text-muted" aria-hidden="true" />
              Close all positions
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => run(reconcile)}
              className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[11.5px] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
            >
              <RefreshCw size={14} strokeWidth={1.8} className="text-muted" aria-hidden="true" />
              Reconcile venues
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                run(() =>
                  requestConfirm({
                    title: "Reset the paper account?",
                    description:
                      "This clears trades, PnL, the equity curve and activity history. Strategy settings are kept.",
                    confirmLabel: "Reset account",
                    tone: "danger",
                    onConfirm: resetSample,
                  }),
                )
              }
              className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[11.5px] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
            >
              <RotateCcw size={14} strokeWidth={1.8} className="text-muted" aria-hidden="true" />
              Reset paper account
            </button>

            {mode === "live" ? (
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  run(() =>
                    requestConfirm({
                      title: "Panic close everything?",
                      description:
                        "Close all positions and cancel outstanding orders, then activate the kill switch. This is the emergency stop.",
                      confirmLabel: "Panic close all",
                      tone: "danger",
                      onConfirm: panicAll,
                    }),
                  )
                }
                className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[11.5px] text-neg transition-colors duration-150 hover:bg-neg-soft"
              >
                <ShieldAlert size={14} strokeWidth={1.8} aria-hidden="true" />
                Panic close all
              </button>
            ) : null}

            <div className="my-1 h-px bg-line" />

            <button
              type="button"
              role="menuitem"
              onClick={() => run(() => navigate("/exchanges"))}
              className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[11.5px] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
            >
              <Link2 size={14} strokeWidth={1.8} className="text-muted" aria-hidden="true" />
              Manage exchanges
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => run(onOpenGuide)}
              className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left text-[11.5px] text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink"
            >
              <CircleHelp size={14} strokeWidth={1.8} className="text-muted" aria-hidden="true" />
              Quick guide
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Topbar({
  collapsed,
  onToggleCollapsed,
  onOpenGuide,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenGuide: () => void;
}) {
  const {
    running,
    toggleRunning,
    resolvedTheme,
    setThemeMode,
    setPaletteOpen,
    setMobileNavOpen,
    updatedAt,
    mode,
  } = useApp();
  const location = useLocation();
  const title = pageTitles[location.pathname] ?? "Overview";
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-30 h-[60px] border-b glass",
        mode === "live" ? "border-neg/25" : "border-line",
      )}
    >
      <div className="flex h-full items-center gap-2 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          aria-label="Open navigation"
          onClick={() => setMobileNavOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-[9px] text-ink-2 hover:bg-surface-2 lg:hidden"
        >
          <Menu size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>

        <div className="hidden items-center gap-1.5 text-[11.5px] md:flex">
          <span className="text-faint">Workspace</span>
          <ChevronRight size={11} className="text-faint" aria-hidden="true" />
          <span className="font-medium text-ink">{title}</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="hidden h-8 w-[224px] items-center gap-2 rounded-full border border-line bg-surface-2 px-3 text-left text-[11.5px] text-faint transition-colors duration-150 hover:border-line-strong hover:text-muted sm:flex"
          >
            <Search size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="flex-1">Search</span>
            <Kbd>⌘K</Kbd>
          </button>
          <button
            type="button"
            aria-label="Open search"
            onClick={() => setPaletteOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-[9px] text-ink-2 hover:bg-surface-2 sm:hidden"
          >
            <Search size={17} strokeWidth={1.8} aria-hidden="true" />
          </button>

          <span className="hidden items-center gap-1.5 px-1 text-[10px] text-faint min-[1400px]:flex">
            <span className={cn("status-dot", running ? "text-pos is-pulsing" : "text-faint")} aria-hidden="true" />
            Updated {ago(updatedAt)}
          </span>
          <span className="num hidden text-[10px] text-faint min-[1400px]:inline">
            {clockTime(now)}
          </span>

          <span className="mx-1 hidden h-5 w-px bg-line sm:block" />

          <ModeSwitch />
          <ExchangePill />
          <FeedStatusPill />

          <SafetyMenu onOpenGuide={onOpenGuide} />

          <Button
            variant="ghost"
            size="icon"
            aria-label={
              resolvedTheme === "dark"
                ? "Switch to light appearance"
                : "Switch to dark appearance"
            }
            title={
              resolvedTheme === "dark"
                ? "Switch to light appearance"
                : "Switch to dark appearance"
            }
            onClick={() => setThemeMode(resolvedTheme === "dark" ? "light" : "dark")}
            icon={
              resolvedTheme === "dark" ? (
                <Sun size={17} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Moon size={17} strokeWidth={1.8} aria-hidden="true" />
              )
            }
          />

          <button
            type="button"
            onClick={onToggleCollapsed}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="hidden h-9 w-9 items-center justify-center rounded-[9px] text-ink-2 hover:bg-surface-2 xl:flex"
          >
            <PanelGlyph collapsed={collapsed} />
          </button>

          <Button
            variant={running ? "secondary" : "primary"}
            size="sm"
            onClick={toggleRunning}
            icon={
              running ? (
                <Pause size={13} strokeWidth={2} aria-hidden="true" />
              ) : (
                <Play size={13} strokeWidth={2} aria-hidden="true" />
              )
            }
            className="h-8 pl-3 pr-3.5"
            aria-label={running ? "Pause engine" : "Start engine"}
          >
            <span className="hidden sm:inline">{running ? "Pause" : "Start bot"}</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

function PanelGlyph({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="2.5" y="3.5" width="15" height="13" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.5 3.5v13" stroke="currentColor" strokeWidth="1.5" />
      {collapsed ? (
        <path d="m12 8 2 2-2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <path d="m14 8-2 2 2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export function AppShell() {
  const {
    setPaletteOpen,
    paletteOpen,
    mobileNavOpen,
    setMobileNavOpen,
    reduceMotion,
    mode,
    activeExchange,
    killSwitch,
    setMode,
    setKillSwitch,
    openLiveConfirm,
  } = useApp();
  const [quickGuideOpen, setQuickGuideOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem("oi-sidebar") === "collapsed";
    } catch {
      return false;
    }
  });
  const location = useLocation();

  useEffect(() => {
    document.title = `OI Sniper — ${pageTitles[location.pathname] ?? "Overview"}`;
  }, [location.pathname]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(!paletteOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [paletteOpen, setPaletteOpen]);

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        localStorage.setItem("oi-sidebar", next ? "collapsed" : "expanded");
      } catch {
        // Local preview — persistence is optional.
      }
      return next;
    });
  };

  return (
    <div className="min-h-[100dvh] bg-canvas">
      <aside
        className={cn(
          "sidebar-material fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-line lg:flex",
          collapsed ? "w-[76px]" : "w-[244px]",
        )}
        aria-label="Sidebar"
      >
        <Brand collapsed={collapsed} />
        <SidebarNav collapsed={collapsed} />
        <AccountCard collapsed={collapsed} />
      </aside>

      <AnimatePresence>
        {mobileNavOpen ? (
          <motion.div className="fixed inset-0 z-50 lg:hidden">
            <motion.button
              type="button"
              aria-label="Close navigation"
              className="absolute inset-0 bg-[var(--scrim)]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.18 }}
              onClick={() => setMobileNavOpen(false)}
            />
            <motion.aside
              className="absolute inset-y-0 left-0 flex w-[282px] flex-col border-r border-line bg-surface shadow-float"
              initial={reduceMotion ? false : { x: -24, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { x: -24, opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
              aria-label="Navigation"
            >
              <div className="flex h-[64px] items-center justify-between border-b border-line px-5">
                <Link
                  to="/"
                  className="flex items-center gap-2.5"
                  onClick={() => setMobileNavOpen(false)}
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-accent">
                    <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true">
                      <path
                        d="M7 22.2 13 15l4.2 3.2L25 9.5"
                        fill="none"
                        stroke="white"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                  <span>
                    <span className="block text-[13.5px] font-semibold leading-none tracking-[-0.015em] text-ink">
                      OI Sniper
                    </span>
                    <span className="mt-1 block text-[10px] leading-none text-muted">
                      Execution workstation
                    </span>
                  </span>
                </Link>
                <button
                  type="button"
                  aria-label="Close navigation"
                  onClick={() => setMobileNavOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </div>
              <SidebarNav collapsed={false} onNavigate={() => setMobileNavOpen(false)} />
              <AccountCard collapsed={false} />
            </motion.aside>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className={cn("min-h-[100dvh]", collapsed ? "lg:pl-[76px]" : "lg:pl-[244px]")}>
        <Topbar
          collapsed={collapsed}
          onToggleCollapsed={toggleCollapsed}
          onOpenGuide={() => setQuickGuideOpen(true)}
        />

        {mode === "live" ? (
          <div className="border-b border-neg/25 bg-neg-soft">
            <div className="mx-auto flex w-full max-w-[1520px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 sm:px-6 lg:px-8">
              <ShieldAlert size={14} strokeWidth={2} className="text-neg" aria-hidden="true" />
              <p className="text-[10.5px] leading-[1.4] text-neg">
                <span className="font-semibold">Live execution armed</span> on{" "}
                {activeExchange?.name ?? "no exchange"}. Orders route to the exchange in the
                connected bot. This preview does not submit real orders.
              </p>
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={openLiveConfirm}
                  className="h-6 rounded-full border border-neg/25 px-2.5 text-[9.5px] font-medium text-neg hover:bg-neg-soft"
                >
                  Guardrails
                </button>
                <button
                  type="button"
                  onClick={() => setMode("paper")}
                  className="h-6 rounded-full bg-neg px-2.5 text-[9.5px] font-semibold text-[var(--on-accent)]"
                >
                  Return to paper
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {killSwitch ? (
          <div className="border-b border-warn/25 bg-warn-soft">
            <div className="mx-auto flex w-full max-w-[1520px] flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 sm:px-6 lg:px-8">
              <Power size={14} strokeWidth={2} className="text-warn" aria-hidden="true" />
              <p className="text-[10.5px] leading-[1.4] text-warn">
                <span className="font-semibold">Kill switch is active.</span> New entries are
                blocked while open positions continue to be managed.
              </p>
              <button
                type="button"
                onClick={() => setKillSwitch(false)}
                className="ml-auto h-6 rounded-full border border-warn/25 px-2.5 text-[9.5px] font-medium text-warn hover:bg-warn-soft"
              >
                Release kill switch
              </button>
            </div>
          </div>
        ) : null}

        <main className="px-4 pb-16 pt-6 sm:px-6 sm:pt-7 lg:px-8">
          <div className="mx-auto w-full max-w-[1520px]">
            <motion.div
              key={location.pathname}
              initial={reduceMotion ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
            >
              <Outlet />
            </motion.div>
          </div>
        </main>
      </div>

      <CommandPalette />
      <Toast />
      <ConfirmDialog />
      <LiveConfirmModal />
      <ExchangeWizard />
      <QuickGuideModal open={quickGuideOpen} onClose={() => setQuickGuideOpen(false)} />
    </div>
  );
}
