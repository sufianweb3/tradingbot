import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  Crosshair,
  History,
  Layers3,
  LayoutDashboard,
  Link2,
  Moon,
  Pause,
  Play,
  Plus,
  Power,
  Radio,
  RefreshCw,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Sun,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { cn } from "../lib/format";
import { useApp } from "../store/AppStore";
import { Kbd } from "./ui";

const pages = [
  { label: "Overview", path: "/", icon: LayoutDashboard },
  { label: "Live scanner", path: "/scanner", icon: Crosshair },
  { label: "Market feed", path: "/feed", icon: Radio },
  { label: "Positions", path: "/positions", icon: Layers3 },
  { label: "Performance", path: "/performance", icon: BarChart3 },
  { label: "History", path: "/history", icon: History },
  { label: "Strategy", path: "/strategy", icon: SlidersHorizontal },
  { label: "Exchanges", path: "/exchanges", icon: Link2 },
  { label: "Activity", path: "/activity", icon: Activity },
  { label: "Settings", path: "/settings", icon: Settings2 },
];

export function CommandPalette() {
  const {
    paletteOpen,
    setPaletteOpen,
    running,
    toggleRunning,
    scanNow,
    resolvedTheme,
    setThemeMode,
    reduceMotion,
    killSwitch,
    setKillSwitch,
    openLiveConfirm,
    mode,
    closeAll,
    requestConfirm,
  } = useApp();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const actions = [
      {
        id: "toggle-engine",
        label: running ? "Pause engine" : "Start engine",
        hint: "Engine",
        icon: running ? Pause : Play,
        action: toggleRunning,
      },
      {
        id: "scan-now",
        label: "Run a manual scan",
        hint: "Scanner",
        icon: RefreshCw,
        action: scanNow,
      },
      {
        id: "toggle-theme",
        label: resolvedTheme === "dark" ? "Switch to light appearance" : "Switch to dark appearance",
        hint: "Appearance",
        icon: resolvedTheme === "dark" ? Sun : Moon,
        action: () => setThemeMode(resolvedTheme === "dark" ? "light" : "dark"),
      },
      {
        id: "kill-switch",
        label: killSwitch ? "Release kill switch" : "Activate kill switch",
        hint: "Safety",
        icon: Power,
        action: () => setKillSwitch(!killSwitch),
      },
      {
        id: "close-all",
        label: "Close all positions",
        hint: "Safety",
        icon: Layers3,
        action: () =>
          requestConfirm({
            title: "Close every open position?",
            description:
              "All positions close at the current mark. The engine keeps running unless the kill switch is on.",
            confirmLabel: "Close all positions",
            tone: "danger",
            onConfirm: closeAll,
          }),
      },
      ...(mode === "live"
        ? []
        : [
            {
              id: "arm-live",
              label: "Review live execution",
              hint: "Mode",
              icon: ShieldAlert,
              action: openLiveConfirm,
            },
          ]),
    ];
    const pageItems = pages.map((page) => ({
      id: page.path,
      label: page.label,
      hint: "Go to",
      icon: page.icon,
      action: () => navigate(page.path),
    }));
    return [...actions, ...pageItems];
  }, [
    closeAll,
    killSwitch,
    mode,
    navigate,
    openLiveConfirm,
    requestConfirm,
    resolvedTheme,
    running,
    scanNow,
    setKillSwitch,
    setThemeMode,
    toggleRunning,
  ]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return items;
    return items.filter((item) =>
      `${item.label} ${item.hint}`.toLowerCase().includes(normalized),
    );
  }, [items, query]);

  useEffect(() => {
    if (!paletteOpen) return;
    setQuery("");
    setActive(0);
    const timeout = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(timeout);
  }, [paletteOpen]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    if (!paletteOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPaletteOpen(false);
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActive((current) => Math.min(filtered.length - 1, current + 1));
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActive((current) => Math.max(0, current - 1));
      }
      if (event.key === "Enter" && filtered[active]) {
        event.preventDefault();
        filtered[active].action();
        setPaletteOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, filtered, paletteOpen, setPaletteOpen]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${active}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <AnimatePresence>
      {paletteOpen ? (
        <motion.div
          className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[14vh]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduceMotion ? 0 : 0.16 }}
        >
          <button
            type="button"
            aria-label="Close command menu"
            className="absolute inset-0 cursor-default bg-[var(--scrim)] backdrop-blur-[2px]"
            onClick={() => setPaletteOpen(false)}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command menu"
            initial={reduceMotion ? false : { opacity: 0, y: -8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -6, scale: 0.99 }}
            transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="relative w-full max-w-[560px] overflow-hidden rounded-[18px] border border-line bg-surface shadow-float"
          >
            <div className="flex h-[54px] items-center gap-3 border-b border-line px-4">
              <SearchGlyph />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search pages and actions"
                aria-label="Search pages and actions"
                className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-faint"
              />
              <Kbd>esc</Kbd>
            </div>
            <div ref={listRef} className="max-h-[340px] overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <div className="px-4 py-10 text-center">
                  <p className="text-[13px] font-medium text-ink">No matches</p>
                  <p className="mt-1 text-[11.5px] text-muted">
                    Try a page name or an action.
                  </p>
                </div>
              ) : (
                filtered.map((item, index) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-index={index}
                      onMouseEnter={() => setActive(index)}
                      onClick={() => {
                        item.action();
                        setPaletteOpen(false);
                      }}
                      className={cn(
                        "flex h-10 w-full items-center gap-3 rounded-[10px] px-3 text-left text-[12.5px] transition-colors duration-100",
                        index === active
                          ? "bg-surface-2 text-ink"
                          : "text-ink-2 hover:bg-surface-2",
                      )}
                    >
                      <Icon
                        size={15}
                        strokeWidth={1.8}
                        className={index === active ? "text-accent" : "text-muted"}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      <span className="text-[10.5px] text-faint">{item.hint}</span>
                      {index === active ? (
                        <ArrowUpRight size={13} className="text-faint" aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
            <div className="flex h-9 items-center gap-4 border-t border-line px-4 text-[10px] text-faint">
              <span className="flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd>
                navigate
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd>
                open
              </span>
              <span className="ml-auto">⌘K</span>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function SearchGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      className="shrink-0 text-faint"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </svg>
  );
}
