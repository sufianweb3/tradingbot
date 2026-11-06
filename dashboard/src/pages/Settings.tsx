import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Laptop,
  Link2,
  Moon,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Upload,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useApp, type ThemeMode } from "../store/AppStore";
import { cn, clockTime, usd } from "../lib/format";
import { downloadFile } from "../lib/download";
import { buildPresetLink } from "../lib/report";
import { QuickGuideModal } from "../components/ActionModals";
import { ReportMenu } from "../components/ReportMenu";
import {
  Button,
  Card,
  DataRow,
  Field,
  Input,
  PageHeader,
  Pill,
  SectionHead,
  Segmented,
  Select,
  Switch,
} from "../components/ui";

const themeOptions: Array<{
  value: ThemeMode;
  label: string;
  icon: typeof Sun;
}> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Laptop },
];

export default function SettingsPage() {
  const {
    themeMode,
    setThemeMode,
    reduceMotion,
    setReduceMotion,
    notify,
    resetSample,
    updatedAt,
    positions,
    mode,
    setMode,
    activeExchange,
    exchanges,
    openLiveConfirm,
    killSwitch,
    setKillSwitch,
    liveGuardrails,
    updateLiveGuardrails,
    openExchangeWizard,
    dataSource,
    settings,
    setCoinglassKey,
    exportBackup: exportBackupApi,
    importBackup: importBackupApi,
  } = useApp();
  const [apiKey, setApiKey] = useState("");
  const [source, setSource] = useState("scrape");
  const [fillAlerts, setFillAlerts] = useState(true);
  const [signalAlerts, setSignalAlerts] = useState(true);
  const [dailyReport, setDailyReport] = useState(false);
  const [browserNotifications, setBrowserNotifications] = useState(false);
  const [includeKeys, setIncludeKeys] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [quickGuideOpen, setQuickGuideOpen] = useState(false);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const legacyInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!settings) return;
    setSource(settings.coinglassKeySet ? "api" : "scrape");
  }, [settings]);

  const saveKey = async () => {
    if (!apiKey.trim()) {
      notify("No key entered", "Paste a CoinGlass API key first, or clear the field.");
      return;
    }
    const ok = await setCoinglassKey(apiKey);
    if (!ok) return;
    setApiKey("");
    if (dataSource !== "live") {
      notify(
        "API key saved in this preview",
        "The key stays in this browser session and is never sent by the interface.",
      );
    }
  };

  const exportBackup = async () => {
    if (dataSource === "live") {
      const result = await exportBackupApi(includeKeys);
      if (!result) return;
      downloadFile(
        result.filename ?? `oi-sniper-backup-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(result.backup, null, 2),
        "application/json",
      );
      return;
    }
    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      app: "OI Sniper",
      themeMode,
      reduceMotion,
      mode: "paper",
      activeExchange: activeExchange?.id ?? null,
      guardrails: liveGuardrails,
      exchanges: exchanges.map((exchange) => ({
        id: exchange.id,
        connected: exchange.connected,
        maskedKey: exchange.connected ? exchange.maskedKey : "",
        balance: exchange.balance,
      })),
      includeKeys,
    };
    downloadFile(
      `oi-sniper-backup-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(backup, null, 2),
      "application/json",
    );
    notify(
      "Backup exported",
      includeKeys
        ? "Masked connection state included. API secrets are never stored in this preview."
        : "Settings and masked connection state exported.",
      undefined,
      "success",
    );
  };

  const importBackup = async (file: File) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await file.text()) as Record<string, unknown>;
    } catch {
      notify("Could not import backup", "The file is not valid JSON.", undefined, "danger");
      return;
    }
    if (dataSource === "live") {
      await importBackupApi(parsed);
      return;
    }
    if (parsed.themeMode && ["light", "dark", "system"].includes(String(parsed.themeMode))) {
      setThemeMode(parsed.themeMode as ThemeMode);
    }
    if (typeof parsed.reduceMotion === "boolean") setReduceMotion(parsed.reduceMotion);
    if (parsed.guardrails && typeof parsed.guardrails === "object") {
      updateLiveGuardrails(parsed.guardrails as Partial<typeof liveGuardrails>);
    }
    setMode("paper");
    notify(
      "Backup imported",
      "Appearance and live guardrails were restored. Live mode defaults to paper for safety.",
      undefined,
      "success",
    );
  };

  const importLegacy = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      notify(
        "Legacy state recognised",
        `Found ${Array.isArray(parsed.trades) ? parsed.trades.length : 0} trades and ${
          Array.isArray(parsed.positions) ? parsed.positions.length : 0
        } positions. Full migration requires the bot API.`,
        undefined,
        "info",
      );
    } catch {
      notify("Could not read state", "The legacy file is not valid JSON.", undefined, "danger");
    }
  };

  const copyPreset = async () => {
    try {
      await navigator.clipboard.writeText(buildPresetLink());
      notify(
        "Preset link copied",
        "A sanitized strategy link is on the clipboard. Keys are stripped.",
        undefined,
        "success",
      );
    } catch {
      notify(
        "Clipboard unavailable",
        "Copy the URL from the browser address bar after generating a preset.",
        undefined,
        "warn",
      );
    }
  };

  const toggleBrowserNotifications = async (next: boolean) => {
    setBrowserNotifications(next);
    if (!next) {
      notify("Browser notifications off", "Alerts stay inside the dashboard.", undefined, "info");
      return;
    }
    try {
      if ("Notification" in window && Notification.permission === "default") {
        await Notification.requestPermission();
      }
      notify("Browser notifications on", "Alerts will use the operating system notification centre.", undefined, "success");
    } catch {
      notify("Notifications unavailable", "The browser blocked the permission request.", undefined, "warn");
    }
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="Settings"
        subtitle="Appearance, exchange mode, data sources and backup for the OI Sniper dashboard."
        actions={
          <Button
            variant="secondary"
            size="md"
            onClick={() => openExchangeWizard("bybit")}
            icon={<Link2 size={14} strokeWidth={1.9} aria-hidden="true" />}
          >
            Connect exchange
          </Button>
        }
      />

      <div className="grid grid-cols-12 items-start gap-4 lg:gap-5">
        <div className="col-span-12 space-y-4 sm:space-y-5 xl:col-span-8">
          <Card>
            <SectionHead
              title="Appearance"
              subtitle="The interface follows the system by default."
            />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <div className="grid grid-cols-3 gap-2.5">
                {themeOptions.map((option) => {
                  const Icon = option.icon;
                  const active = themeMode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setThemeMode(option.value)}
                      aria-pressed={active}
                      className={cn(
                        "group rounded-[12px] border p-2 text-left transition-[border-color,box-shadow] duration-150",
                        active
                          ? "border-accent shadow-[0_0_0_3px_var(--accent-soft)]"
                          : "border-line hover:border-line-strong",
                      )}
                    >
                      <span
                        className={cn(
                          "block h-[58px] overflow-hidden rounded-[8px] border border-line",
                          option.value === "system" ? "bg-[linear-gradient(90deg,#f5f5f7_0%,#f5f5f7_50%,#141416_50%,#141416_100%)]" : "",
                          option.value === "light" && "bg-[var(--canvas)]",
                          option.value === "dark" && "bg-[#141416]",
                        )}
                      >
                        <span className="flex h-full flex-col justify-center gap-1.5 px-3">
                          <span
                            className={cn(
                              "block h-1.5 w-9 rounded-full",
                              option.value === "dark" || option.value === "system" ? "bg-white/20" : "bg-black/10",
                            )}
                          />
                          <span
                            className={cn(
                              "block h-1.5 w-14 rounded-full",
                              option.value === "dark" ? "bg-white/25" : "bg-black/15",
                            )}
                          />
                          <span
                            className={cn(
                              "block h-1.5 w-7 rounded-full",
                              option.value === "dark" ? "bg-white/15" : "bg-black/10",
                            )}
                          />
                        </span>
                      </span>
                      <span className="mt-2 flex items-center gap-1.5 px-0.5 text-[11px] font-medium text-ink-2">
                        <Icon size={12} strokeWidth={1.9} aria-hidden="true" />
                        {option.label}
                        {active ? (
                          <Check size={11} strokeWidth={2.4} className="ml-auto text-accent" aria-hidden="true" />
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="mt-5 flex items-center justify-between gap-4 border-t border-line pt-4">
                <div>
                  <p className="text-[11.5px] font-medium text-ink">Reduce motion</p>
                  <p className="mt-0.5 text-[10px] leading-[1.4] text-muted">
                    Removes page transitions, number rolls and toast springs.
                  </p>
                </div>
                <Switch
                  checked={reduceMotion}
                  onChange={setReduceMotion}
                  label="Reduce motion"
                />
              </div>
            </div>
          </Card>

          <Card>
            <SectionHead
              title="Execution mode"
              subtitle="Paper is the safe default. Live routes through the exchange."
              action={
                <Pill tone={mode === "live" ? "neg" : "neutral"} dot pulse={mode === "live"}>
                  {mode === "live" ? "Live" : "Paper"}
                </Pill>
              }
            />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-line bg-surface-2 px-4 py-3.5">
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "flex h-9 w-9 items-center justify-center rounded-full",
                      mode === "live" ? "bg-neg-soft text-neg" : "bg-accent-soft text-accent",
                    )}
                  >
                    <ShieldAlert size={17} strokeWidth={1.9} aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-[12px] font-medium text-ink">
                      {mode === "live" ? `Live on ${activeExchange?.name ?? "no exchange"}` : "Paper execution"}
                    </p>
                    <p className="mt-0.5 text-[10px] text-muted">
                      {activeExchange?.connected
                        ? `${activeExchange.name} connected · ${usd(activeExchange.balance)} available`
                        : "No exchange connected"}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    options={[
                      { value: "paper", label: "Paper" },
                      { value: "live", label: "Live" },
                    ]}
                    value={mode}
                    onChange={(next) => {
                      if (next === "live") openLiveConfirm();
                      else setMode("paper");
                    }}
                    ariaLabel="Execution mode"
                  />
                  <Link
                    to="/exchanges"
                    className="text-[10.5px] font-medium text-accent hover:text-accent-strong"
                  >
                    Manage exchanges
                  </Link>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-[11px] font-medium text-ink">Kill switch</p>
                  <p className="mt-0.5 text-[9.5px] text-muted">
                    Block new entries without touching open positions.
                  </p>
                </div>
                <Switch checked={killSwitch} onChange={setKillSwitch} label="Kill switch" />
              </div>
              <div className="mt-4 space-y-2 border-t border-line pt-4">
                <DataRow label="Connected venues" value={`${exchanges.filter((exchange) => exchange.connected).length} of ${exchanges.length}`} />
                <DataRow label="Live margin cap" value={liveGuardrails.marginPerTrade > 0 ? usd(liveGuardrails.marginPerTrade, 0) : "Strategy sizing"} />
                <DataRow label="Daily loss cap" value={liveGuardrails.dailyLossCap > 0 ? usd(liveGuardrails.dailyLossCap, 0) : "Disabled"} />
              </div>
            </div>
          </Card>

          <Card>
            <SectionHead
              title="CoinGlass connection"
              subtitle="Signals come from the browser feed or the official API."
              action={
                <Pill tone="pos" dot pulse>
                  Connected
                </Pill>
              }
            />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Data source">
                  <Select
                    value={source}
                    onChange={(event) => setSource(event.target.value)}
                  >
                    <option value="scrape">Browser feed</option>
                    <option value="api">Official API</option>
                  </Select>
                </Field>
                <Field label="Last successful scrape">
                  <div className="flex h-9 items-center rounded-[10px] border border-line bg-surface-2 px-3">
                    <span className="num text-[12px] text-ink">{clockTime(updatedAt)}</span>
                  </div>
                </Field>
              </div>

              <div className="mt-4 space-y-2.5 border-t border-line pt-4">
                <DataRow label="Feed age" value="190 ms" />
                <DataRow label="Coins in view" value="412" />
                <DataRow label="Scrape cadence" value="Every 30 seconds" />
                <DataRow label="Source" value={source === "api" ? "CoinGlass API" : "Browser feed"} />
              </div>

              <div className="mt-5 border-t border-line pt-4">
                <Field
                  label="CoinGlass API key"
                  hint="Optional. Leave empty to keep using the browser feed."
                >
                  <Input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Paste an API key"
                    autoComplete="off"
                    leading={<KeyRound size={12} strokeWidth={1.9} aria-hidden="true" />}
                  />
                </Field>
                <div className="mt-2.5 flex items-center gap-2">
                  <Button variant="secondary" size="sm" onClick={saveKey}>
                    Save key
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      setApiKey("");
                      const ok = await setCoinglassKey("");
                      if (ok && dataSource !== "live") {
                        notify("API key cleared", "The preview will keep using the browser feed.");
                      }
                    }}
                  >
                    Clear key
                  </Button>
                </div>
              </div>

              <div className="mt-4 flex items-start gap-2.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
                <ShieldCheck size={14} strokeWidth={1.8} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                <p className="text-[10px] leading-[1.5] text-muted">
                  {dataSource === "live"
                    ? "The key is stored in the bot vault on this host. It is never sent back to the browser and is not committed to the repository."
                    : "This preview runs on local sample data. No key, order or account detail leaves the browser."}
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <SectionHead
              title="Notifications"
              subtitle="What the interface surfaces while the engine runs."
            />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <div className="space-y-3.5">
                {[
                  {
                    label: "Browser notifications",
                    description: "Use the OS notification centre for fills and alerts.",
                    value: browserNotifications,
                    onChange: toggleBrowserNotifications,
                  },
                  {
                    label: "Trade fills",
                    description: "Entry, TP1 and exit confirmations.",
                    value: fillAlerts,
                    onChange: setFillAlerts,
                  },
                  {
                    label: "Signal alerts",
                    description: "When a coin passes every enabled filter.",
                    value: signalAlerts,
                    onChange: setSignalAlerts,
                  },
                  {
                    label: "Daily report",
                    description: "A summary when the paper session rolls over.",
                    value: dailyReport,
                    onChange: setDailyReport,
                  },
                ].map((item) => (
                  <div key={item.label} className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-[11.5px] font-medium text-ink">{item.label}</p>
                      <p className="mt-0.5 text-[10px] text-muted">{item.description}</p>
                    </div>
                    <Switch
                      checked={item.value}
                      onChange={item.onChange}
                      label={item.label}
                    />
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Card>
            <SectionHead
              title="Data &amp; backup"
              subtitle="Export settings, share a preset or migrate storage."
            />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <div className="grid gap-2 sm:grid-cols-2">
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8"
                  onClick={exportBackup}
                  icon={<Download size={12} strokeWidth={2} aria-hidden="true" />}
                >
                  Export backup
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8"
                  onClick={() => backupInputRef.current?.click()}
                  icon={<Upload size={12} strokeWidth={2} aria-hidden="true" />}
                >
                  Import backup
                </Button>
                <input
                  ref={backupInputRef}
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importBackup(file);
                    event.target.value = "";
                  }}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  className="h-8"
                  onClick={copyPreset}
                  icon={<Copy size={12} strokeWidth={2} aria-hidden="true" />}
                >
                  Copy preset link
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  onClick={() => legacyInputRef.current?.click()}
                  icon={<Upload size={12} strokeWidth={2} aria-hidden="true" />}
                >
                  Import legacy state
                </Button>
                <input
                  ref={legacyInputRef}
                  type="file"
                  accept=".json"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importLegacy(file);
                    event.target.value = "";
                  }}
                />
              </div>
              <div className="mt-4 flex items-center justify-between gap-4 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
                <div>
                  <p className="text-[10.5px] font-medium text-ink">Include connection state</p>
                  <p className="mt-0.5 text-[9px] text-muted">
                    Masked keys only. Secrets are never exported by this preview.
                  </p>
                </div>
                <Switch
                  checked={includeKeys}
                  onChange={setIncludeKeys}
                  label="Include connection state"
                />
              </div>
              <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
                <div>
                  <p className="text-[10.5px] font-medium text-ink">Reports</p>
                  <p className="mt-0.5 text-[9px] text-muted">
                    HTML, CSV or a JSON snapshot.
                  </p>
                </div>
                <ReportMenu compact />
              </div>
            </div>
          </Card>
        </div>

        <div className="col-span-12 space-y-4 sm:space-y-5 xl:col-span-4 xl:sticky xl:top-[80px]">
          <Card>
            <SectionHead title="Workspace" subtitle="This preview build" />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-accent">
                  <svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true">
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
                <div>
                  <p className="text-[13px] font-semibold text-ink">OI Sniper</p>
                  <p className="mt-0.5 text-[10px] text-muted">Paper execution workstation</p>
                </div>
              </div>
              <div className="mt-4 space-y-2.5 border-t border-line pt-4">
                <DataRow label="Version" value="1.0.0 preview" />
                <DataRow label="Mode" value={mode === "live" ? "Live" : "Paper"} />
                <DataRow label="Exchange" value={activeExchange?.name ?? "None"} />
                <DataRow label="Kill switch" value={killSwitch ? "Active" : "Clear"} tone={killSwitch ? "neg" : "default"} />
                <DataRow label="Data" value={dataSource === "live" ? "Bot API" : "Sample state"} />
                <DataRow label="Storage" value={dataSource === "live" ? "Bot vault" : "Local only"} />
                <DataRow label="Open positions" value={String(positions.length)} />
              </div>
            </div>
          </Card>

          <Card>
            <SectionHead
              title={dataSource === "live" ? "Account reset" : "Sample data"}
              subtitle={
                dataSource === "live"
                  ? "Clear trades, positions and the equity curve on the bot."
                  : "Reset the preview back to its opening state."
              }
            />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <p className="text-[10.5px] leading-[1.55] text-muted">
                {dataSource === "live"
                  ? "Resetting clears the bot's paper account and equity curve. Strategy settings are kept."
                  : "Resetting restores the sample positions, trades and activity. It does not touch the strategy settings."}
              </p>
              {confirmReset ? (
                <div className="mt-4 rounded-[10px] border border-line bg-neg-soft p-3">
                  <p className="text-[11px] font-medium text-ink">
                    {dataSource === "live" ? "Reset the bot account?" : "Reset the sample account?"}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted">
                    Open positions and trade history will be replaced.
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => {
                        resetSample();
                        setConfirmReset(false);
                      }}
                    >
                      Reset
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setConfirmReset(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  className="mt-4"
                  onClick={() => setConfirmReset(true)}
                  icon={<RotateCcw size={12} strokeWidth={2} aria-hidden="true" />}
                >
                  {dataSource === "live" ? "Reset bot account" : "Reset sample data"}
                </Button>
              )}
            </div>
          </Card>

          <Card>
            <SectionHead title="Shortcuts" subtitle="Move without the pointer." />
            <div className="space-y-2.5 px-5 pb-5 pt-5 sm:px-6">
              {[
                { label: "Command menu", keys: "⌘ K" },
                { label: "Close menu", keys: "esc" },
                { label: "Move selection", keys: "↑ ↓" },
                { label: "Open selection", keys: "↵" },
              ].map((item) => (
                <div key={item.label} className="flex items-center justify-between text-[10.5px]">
                  <span className="text-muted">{item.label}</span>
                  <span className="num rounded-[5px] border border-line bg-surface-2 px-1.5 py-0.5 text-[9.5px] text-faint">
                    {item.keys}
                  </span>
                </div>
              ))}
              <Button
                variant="secondary"
                size="sm"
                className="mt-3 w-full"
                onClick={() => setQuickGuideOpen(true)}
              >
                Open quick guide
              </Button>
            </div>
          </Card>
        </div>
      </div>

      <QuickGuideModal open={quickGuideOpen} onClose={() => setQuickGuideOpen(false)} />
    </div>
  );
}
