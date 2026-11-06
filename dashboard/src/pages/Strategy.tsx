import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  Gauge,
  Plus,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Zap,
} from "lucide-react";
import {
  START_FUND,
  defaultStrategy,
  venues as venueData,
  type FilterRow,
  type Side,
  type StrategyProfile,
} from "../lib/data";
import { cn, price, usd } from "../lib/format";
import { useApp, type LiveGuardrails } from "../store/AppStore";
import { decodePresetLink } from "../lib/report";
import {
  buildSettingsPatch,
  executionFromSettings,
  globalFromSettings,
  liveFromSettings,
  profilesFromSettings,
  venuesFromSettings,
} from "../lib/api";
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
import { Meter } from "../components/charts";

type StrategyTab = "profiles" | "execution" | "universe" | "live";

interface GlobalSettings {
  totalFund: number;
  riskMode: "roe" | "price";
  direction: "auto" | "long" | "short";
  minOiUsd: number;
  minVolUsd24h: number;
  excludeSymbols: string;
  allowCoinglassPrice: boolean;
  scanIntervalSec: number;
  priceRefreshMs: number;
  feePercent: number;
  slippagePercent: number;
  reenterEnabled: boolean;
  reenterDelayMin: number;
  autoStart: boolean;
  notifications: boolean;
}

interface ExecutionSettings {
  eqeEnabled: boolean;
  maxOneWayCostBps: number;
  maxSpreadBps: number;
  minDepthMultiple: number;
  autoSizeToLiquidity: boolean;
  entryOrderType: "ioc-limit" | "market";
  fundingGuard: boolean;
  routeMode: "auto" | "pinned";
  realismMode: "standard" | "conservative" | "stress" | "optimistic";
}

const defaultGlobal: GlobalSettings = {
  totalFund: START_FUND,
  riskMode: "roe",
  direction: "auto",
  minOiUsd: 0,
  minVolUsd24h: 0,
  excludeSymbols:
    "USDT,USDC,USDE,DAI,FDUSD,TUSD,USDP,PYUSD,BUSD,USDD,USTC,WBTC,WETH",
  allowCoinglassPrice: false,
  scanIntervalSec: 30,
  priceRefreshMs: 3000,
  feePercent: 0.05,
  slippagePercent: 0.02,
  reenterEnabled: false,
  reenterDelayMin: 30,
  autoStart: false,
  notifications: true,
};

const defaultExecution: ExecutionSettings = {
  eqeEnabled: true,
  maxOneWayCostBps: 18,
  maxSpreadBps: 12,
  minDepthMultiple: 3,
  autoSizeToLiquidity: true,
  entryOrderType: "ioc-limit",
  fundingGuard: true,
  routeMode: "auto",
  realismMode: "standard",
};

const defaultVenues: Record<string, boolean> = {
  binance: true,
  bybit: true,
  okx: true,
  gate: true,
  mexc: false,
};

const strategyPresets = {
  balanced: {
    label: "Balanced",
    note: "50× · 20% stop · 50% TP1",
    values: {
      allocation: 5,
      leverage: 50,
      stopLoss: 20,
      tp1: 50,
      tp1Close: 50,
      tpMax: 1000,
      trailing: true,
      trailingStart: "tp1" as const,
      trailDistance: 20,
    },
  },
  aggressive: {
    label: "Aggressive",
    note: "75× · 15% stop · immediate trail",
    values: {
      allocation: 8,
      leverage: 75,
      stopLoss: 15,
      tp1: 30,
      tp1Close: 50,
      tpMax: 500,
      trailing: true,
      trailingStart: "immediate" as const,
      trailDistance: 15,
    },
  },
  conservative: {
    label: "Conservative",
    note: "20× · 25% stop · wider trail",
    values: {
      allocation: 2.5,
      leverage: 20,
      stopLoss: 25,
      tp1: 60,
      tp1Close: 50,
      tpMax: 1000,
      trailing: true,
      trailingStart: "tp1" as const,
      trailDistance: 25,
    },
  },
};

const cloneProfile = (profile: StrategyProfile): StrategyProfile => ({
  ...profile,
  filters: profile.filters.map((filter) => ({ ...filter })),
});

const cloneDrafts = (drafts: Record<Side, StrategyProfile>) => ({
  long: cloneProfile(drafts.long),
  short: cloneProfile(drafts.short),
});

const oiTimeframes = [
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
];

const volumeTimeframes = [
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
];

const priceTimeframes = [
  { value: "5m", label: "5 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "4h", label: "4 hours" },
];

const timeframesFor = (kind: FilterRow["kind"]) =>
  kind === "oi" ? oiTimeframes : kind === "volume" ? volumeTimeframes : priceTimeframes;

function FiltersEditor({
  profile,
  side,
  updateFilter,
  removeFilter,
  addFilter,
}: {
  profile: StrategyProfile;
  side: Side;
  updateFilter: (id: string, patch: Partial<FilterRow>) => void;
  removeFilter: (id: string) => void;
  addFilter: () => void;
}) {
  return (
    <Card>
      <SectionHead
        title="Entry filters"
        subtitle="Every enabled row must pass. Blank rows are ignored."
        action={
          <Button
            variant="secondary"
            size="sm"
            onClick={addFilter}
            icon={<Plus size={12} strokeWidth={2.2} aria-hidden="true" />}
          >
            Add filter
          </Button>
        }
      />
      <div className="mt-4 px-5 pb-5 sm:px-6">
        <div className="hidden overflow-x-auto md:block">
          <div className="min-w-[680px]">
            <div className="grid grid-cols-[38px_minmax(0,1.2fr)_112px_64px_104px_28px] items-center gap-2 border-y border-line py-2 text-[9.5px] text-faint">
              <span>On</span>
              <span>Metric</span>
              <span>Window</span>
              <span>Operator</span>
              <span>Threshold</span>
              <span />
            </div>
            {profile.filters.map((filter) => (
              <div
                key={filter.id}
                className="grid grid-cols-[38px_minmax(0,1.2fr)_112px_64px_104px_28px] items-center gap-2 border-b border-line py-2.5 last:border-0"
              >
                <Switch
                  checked={filter.enabled}
                  onChange={(value) => updateFilter(filter.id, { enabled: value })}
                  label={`Enable ${filter.kind} ${filter.timeframe} filter`}
                />
                <Select
                  value={filter.kind}
                  aria-label="Filter metric"
                  onChange={(event) => {
                    const kind = event.target.value as FilterRow["kind"];
                    const nextTimeframes = timeframesFor(kind);
                    updateFilter(filter.id, {
                      kind,
                      timeframe: nextTimeframes.some(
                        (option) => option.value === filter.timeframe,
                      )
                        ? filter.timeframe
                        : nextTimeframes[0].value,
                    });
                  }}
                  className="h-8 text-[11px]"
                >
                  <option value="oi">Open interest</option>
                  <option value="volume">Volume</option>
                  <option value="price">Price change</option>
                </Select>
                <Select
                  value={filter.timeframe}
                  aria-label="Filter timeframe"
                  onChange={(event) => updateFilter(filter.id, { timeframe: event.target.value })}
                  className="h-8 text-[11px]"
                >
                  {timeframesFor(filter.kind).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                <Select
                  value={filter.operator}
                  aria-label="Filter operator"
                  onChange={(event) =>
                    updateFilter(filter.id, {
                      operator: event.target.value as FilterRow["operator"],
                    })
                  }
                  className="h-8 text-[11px]"
                >
                  <option value="≥">≥</option>
                  <option value="≤">≤</option>
                </Select>
                <Input
                  type="number"
                  step={0.1}
                  value={filter.value}
                  aria-label="Filter threshold"
                  onChange={(event) => updateFilter(filter.id, { value: Number(event.target.value) })}
                  suffix="%"
                  className="h-8 text-[11px]"
                  disabled={!filter.enabled}
                />
                <button
                  type="button"
                  onClick={() => removeFilter(filter.id)}
                  aria-label="Remove filter"
                  className="flex h-7 w-7 items-center justify-center rounded-[8px] text-faint transition-colors duration-150 hover:bg-neg-soft hover:text-neg"
                >
                  <Trash2 size={12} strokeWidth={1.9} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="md:hidden">
          {profile.filters.map((filter) => (
            <div key={filter.id} className="border-b border-line py-3 last:border-0">
              <div className="flex items-center gap-2.5">
                <Switch
                  checked={filter.enabled}
                  onChange={(value) => updateFilter(filter.id, { enabled: value })}
                  label={`Enable ${filter.kind} ${filter.timeframe} filter`}
                />
                <div className="min-w-0 flex-1">
                  <Select
                    value={filter.kind}
                    aria-label="Filter metric"
                    onChange={(event) => {
                      const kind = event.target.value as FilterRow["kind"];
                      const nextTimeframes = timeframesFor(kind);
                      updateFilter(filter.id, {
                        kind,
                        timeframe: nextTimeframes.some(
                          (option) => option.value === filter.timeframe,
                        )
                          ? filter.timeframe
                          : nextTimeframes[0].value,
                      });
                    }}
                    className="h-8 text-[11px]"
                  >
                    <option value="oi">Open interest</option>
                    <option value="volume">Volume</option>
                    <option value="price">Price change</option>
                  </Select>
                </div>
                <button
                  type="button"
                  onClick={() => removeFilter(filter.id)}
                  aria-label="Remove filter"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] text-faint transition-colors duration-150 hover:bg-neg-soft hover:text-neg"
                >
                  <Trash2 size={12} strokeWidth={1.9} aria-hidden="true" />
                </button>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 pl-[46px]">
                <label className="block">
                  <span className="mb-1 block text-[9px] text-faint">Window</span>
                  <Select
                    value={filter.timeframe}
                    aria-label="Filter timeframe"
                    onChange={(event) => updateFilter(filter.id, { timeframe: event.target.value })}
                    className="h-8 text-[11px]"
                  >
                    {timeframesFor(filter.kind).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[9px] text-faint">Operator</span>
                  <Select
                    value={filter.operator}
                    aria-label="Filter operator"
                    onChange={(event) =>
                      updateFilter(filter.id, {
                        operator: event.target.value as FilterRow["operator"],
                      })
                    }
                    className="h-8 text-[11px]"
                  >
                    <option value="≥">≥</option>
                    <option value="≤">≤</option>
                  </Select>
                </label>
                <label className="col-span-2 block">
                  <span className="mb-1 block text-[9px] text-faint">Threshold</span>
                  <Input
                    type="number"
                    step={0.1}
                    value={filter.value}
                    aria-label="Filter threshold"
                    onChange={(event) => updateFilter(filter.id, { value: Number(event.target.value) })}
                    suffix="%"
                    className="h-8 text-[11px]"
                    disabled={!filter.enabled}
                  />
                </label>
              </div>
            </div>
          ))}
        </div>

        <p className="mt-3 text-[10px] leading-[1.5] text-faint">
          Direction is inferred when every enabled open-interest row shares one operator.
          Mixed operators require an explicit direction. Price filters are optional.
        </p>
      </div>
    </Card>
  );
}

export default function StrategyPage() {
  const {
    equity,
    coins,
    notify,
    requestConfirm,
    liveGuardrails,
    exchanges,
    activeExchange,
    mode,
    setMode,
    openLiveConfirm,
    killSwitch,
    setKillSwitch,
    saveLiveGuardrails,
    settings,
    saveSettings,
  } = useApp();

  const [tab, setTab] = useState<StrategyTab>("profiles");
  const [side, setSide] = useState<Side>("long");
  const [drafts, setDrafts] = useState<Record<Side, StrategyProfile>>(() => ({
    long: cloneProfile(defaultStrategy.long),
    short: cloneProfile(defaultStrategy.short),
  }));
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>(defaultGlobal);
  const [executionSettings, setExecutionSettings] = useState<ExecutionSettings>(defaultExecution);
  const [venuesOn, setVenuesOn] = useState<Record<string, boolean>>(defaultVenues);
  const [liveDraft, setLiveDraft] = useState<LiveGuardrails>(liveGuardrails);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setLiveDraft(liveGuardrails);
  }, [liveGuardrails]);

  useEffect(() => {
    const parsed = decodePresetLink(window.location.hash);
    if (!parsed) return;
    if (parsed.profiles?.long || parsed.profiles?.short) {
      setDrafts((current) => ({
        long: { ...current.long, ...(parsed.profiles?.long ?? {}) },
        short: { ...current.short, ...(parsed.profiles?.short ?? {}) },
      }));
      setDirty(true);
    }
    if (parsed.eqe) {
      setExecutionSettings((current) => ({
        ...current,
        eqeEnabled: parsed.eqe.enabled ?? current.eqeEnabled,
        maxOneWayCostBps: parsed.eqe.maxOneWayCostBps ?? current.maxOneWayCostBps,
        maxSpreadBps: parsed.eqe.maxSpreadBps ?? current.maxSpreadBps,
        minDepthMultiple: parsed.eqe.minDepthMultiple ?? current.minDepthMultiple,
      }));
      setDirty(true);
    }
    notify(
      "Preset link loaded",
      "Review both profiles and save to apply. Credentials are never included.",
      undefined,
      "info",
    );
    history.replaceState(null, "", window.location.pathname);
  }, []);

  const savedRef = useRef({
    drafts: cloneDrafts(drafts),
    global: { ...defaultGlobal },
    execution: { ...defaultExecution },
    venues: { ...defaultVenues },
  });
  const dirtyRef = useRef(false);

  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

  // Hydrate the editable drafts from the bot's saved settings. Never clobber
  // edits the operator has already made on this screen.
  useEffect(() => {
    if (!settings || dirtyRef.current) return;
    const profiles = profilesFromSettings(settings);
    const global = globalFromSettings(settings);
    const execution = executionFromSettings(settings);
    const venues = venuesFromSettings(settings);
    if (profiles) {
      setDrafts({
        long: cloneProfile(profiles.long),
        short: cloneProfile(profiles.short),
      });
    }
    setGlobalSettings(global);
    setExecutionSettings(execution);
    setVenuesOn(venues);
    setLiveDraft(liveFromSettings(settings));
    savedRef.current = {
      drafts: cloneDrafts(profiles ?? drafts),
      global: { ...global },
      execution: { ...execution },
      venues: { ...venues },
    };
  }, [settings]);

  const profile = drafts[side];
  const reference = coins.find((coin) => coin.symbol === "BTC") ?? coins[0];
  const entry = reference?.price ?? 0;
  const safeLeverage = profile.leverage || 1;

  const markDirty = () => setDirty(true);

  const patchProfile = <K extends keyof StrategyProfile>(key: K, value: StrategyProfile[K]) => {
    setDrafts((current) => ({
      ...current,
      [side]: { ...current[side], [key]: value },
    }));
    markDirty();
  };

  const updateFilter = (id: string, patch: Partial<FilterRow>) => {
    setDrafts((current) => ({
      ...current,
      [side]: {
        ...current[side],
        filters: current[side].filters.map((filter) =>
          filter.id === id ? { ...filter, ...patch } : filter,
        ),
      },
    }));
    markDirty();
  };

  const addFilter = () => {
    const filter: FilterRow = {
      id: `f_${Date.now()}`,
      kind: "oi",
      timeframe: "5m",
      operator: "≥",
      value: 1,
      enabled: true,
    };
    setDrafts((current) => ({
      ...current,
      [side]: { ...current[side], filters: [...current[side].filters, filter] },
    }));
    markDirty();
  };

  const removeFilter = (id: string) => {
    setDrafts((current) => ({
      ...current,
      [side]: {
        ...current[side],
        filters: current[side].filters.filter((filter) => filter.id !== id),
      },
    }));
    markDirty();
  };

  const patchGlobal = <K extends keyof GlobalSettings>(key: K, value: GlobalSettings[K]) => {
    setGlobalSettings((current) => ({ ...current, [key]: value }));
    markDirty();
  };

  const patchExecution = <K extends keyof ExecutionSettings>(
    key: K,
    value: ExecutionSettings[K],
  ) => {
    setExecutionSettings((current) => ({ ...current, [key]: value }));
    markDirty();
  };

  const patchVenue = (key: string, value: boolean) => {
    setVenuesOn((current) => ({ ...current, [key]: value }));
    markDirty();
  };

  const patchLive = <K extends keyof LiveGuardrails>(key: K, value: LiveGuardrails[K]) => {
    setLiveDraft((current) => ({ ...current, [key]: value }));
    markDirty();
  };

  const applyPreset = (key: keyof typeof strategyPresets) => {
    const preset = strategyPresets[key];
    setDrafts((current) => ({
      ...current,
      [side]: { ...current[side], ...preset.values },
    }));
    markDirty();
    notify(`${preset.label} profile applied`, preset.note, undefined, "info");
  };

  const save = async () => {
    const patch = buildSettingsPatch({
      profiles: drafts,
      global: globalSettings,
      execution: executionSettings,
      venues: venuesOn,
      live: liveDraft,
    });
    const ok = await saveSettings(patch);
    if (!ok) return;
    savedRef.current = {
      drafts: cloneDrafts(drafts),
      global: { ...globalSettings },
      execution: { ...executionSettings },
      venues: { ...venuesOn },
    };
    setDirty(false);
    notify(
      "Strategy saved",
      `${drafts.long.filters.filter((filter) => filter.enabled).length + drafts.short.filters.filter((filter) => filter.enabled).length} filters applied. Execution gate and live guardrails are active.`,
      undefined,
      "success",
    );
  };

  const discard = () => {
    setDrafts(cloneDrafts(savedRef.current.drafts));
    setGlobalSettings({ ...savedRef.current.global });
    setExecutionSettings({ ...savedRef.current.execution });
    setVenuesOn({ ...savedRef.current.venues });
    setLiveDraft(liveGuardrails);
    setDirty(false);
    notify("Changes discarded", "The saved strategy is unchanged.", undefined, "info");
  };

  const resetStrategy = () => {
    requestConfirm({
      title: "Reset the strategy?",
      description:
        "Both profiles, execution gate, universe filters and cadence settings return to their defaults. Save or apply afterward to keep the reset.",
      confirmLabel: "Reset strategy",
      tone: "danger",
      onConfirm: () => {
        setDrafts({
          long: cloneProfile(defaultStrategy.long),
          short: cloneProfile(defaultStrategy.short),
        });
        setGlobalSettings({ ...defaultGlobal });
        setExecutionSettings({ ...defaultExecution });
        setVenuesOn({ ...defaultVenues });
        setLiveDraft(liveGuardrails);
        setDirty(true);
        notify("Strategy defaults restored", "Review the values, then save and apply.", undefined, "warn");
      },
    });
  };

  const baseFund =
    profile.allocationBase === "initial" ? globalSettings.totalFund : equity;
  let margin = 0;
  let notional = 0;
  if (profile.sizingMode === "fixedQty") {
    notional = profile.fixedQty * entry;
    margin = notional / safeLeverage;
  } else if (profile.sizingMode === "fixedMargin") {
    margin = profile.fixedMargin;
    notional = margin * safeLeverage;
  } else {
    margin = (baseFund * profile.allocation) / 100;
    notional = margin * safeLeverage;
  }
  const priceMove = (value: number, mode: "roe" | "price" = globalSettings.riskMode) =>
    mode === "roe" ? value / safeLeverage / 100 : value / 100;
  const isLong = side === "long";
  const stopPrice = isLong
    ? entry * (1 - priceMove(profile.stopLoss))
    : entry * (1 + priceMove(profile.stopLoss));
  const tp1Price = isLong
    ? entry * (1 + priceMove(profile.tp1))
    : entry * (1 - priceMove(profile.tp1));
  const tpMaxPrice = isLong
    ? entry * (1 + priceMove(profile.tpMax))
    : entry * (1 - priceMove(profile.tpMax));
  const riskAtStop =
    globalSettings.riskMode === "roe"
      ? (margin * profile.stopLoss) / 100
      : (notional * profile.stopLoss) / 100;
  const feeBps = globalSettings.feePercent * 100;
  const slipBps = globalSettings.slippagePercent * 100;
  const roundTripBps = Math.max(0.5, 2 * (feeBps + slipBps));
  const minMovePct = roundTripBps / 100;
  const tp1MoveBps =
    globalSettings.riskMode === "roe"
      ? (profile.tp1 / safeLeverage) * 100
      : profile.tp1 * 100;
  const edgeMultiple = roundTripBps > 0 ? tp1MoveBps / roundTripBps : 99;
  const haircut =
    executionSettings.realismMode === "standard"
      ? 25
      : executionSettings.realismMode === "conservative"
        ? 35
        : executionSettings.realismMode === "stress"
          ? 50
          : 18;

  const oiOperators = profile.filters
    .filter((filter) => filter.enabled && filter.kind === "oi")
    .map((filter) => filter.operator);
  const inferredDirection =
    globalSettings.direction !== "auto"
      ? globalSettings.direction === "long"
        ? "Long"
        : "Short"
      : oiOperators.length > 0 && oiOperators.every((operator) => operator === oiOperators[0])
        ? oiOperators[0] === "≥"
          ? "Long"
          : "Short"
        : "Mixed";
  const activeFilters = profile.filters.filter((filter) => filter.enabled).length;
  const connectedExchange = exchanges.find((exchange) => exchange.connected);

  const ladderValues = [stopPrice, entry, tp1Price, tpMaxPrice];
  const ladderMin = Math.min(...ladderValues);
  const ladderMax = Math.max(...ladderValues);
  const ladderAt = (value: number) =>
    ladderMax === ladderMin ? 50 : ((value - ladderMin) / (ladderMax - ladderMin)) * 100;
  const zone = (a: number, b: number) => ({
    left: `${Math.min(ladderAt(a), ladderAt(b))}%`,
    width: `${Math.abs(ladderAt(a) - ladderAt(b))}%`,
  });

  const profileTabs = (
    <>
      <Segmented
        options={[
          { value: "long", label: "Long profile", count: drafts.long.filters.filter((f) => f.enabled).length },
          { value: "short", label: "Short profile", count: drafts.short.filters.filter((f) => f.enabled).length },
        ]}
        value={side}
        onChange={setSide}
        ariaLabel="Strategy profile"
      />
      <div className="flex h-9 items-center gap-2.5 rounded-full border border-line bg-surface px-3.5">
        <span className="text-[11px] font-medium text-muted">
          {profile.enabled ? `${side === "long" ? "Long" : "Short"} entries on` : "Profile disabled"}
        </span>
        <Switch
          checked={profile.enabled}
          onChange={(value) => patchProfile("enabled", value)}
          label={`Enable ${side} profile`}
        />
      </div>
    </>
  );

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="Strategy"
        subtitle="Sizing, execution quality, universe filters and live guardrails for both paper profiles."
        badge={dirty ? <Pill tone="warn">Unsaved</Pill> : null}
        actions={
          <>
            <Button variant="ghost" size="md" onClick={discard} disabled={!dirty}>
              Discard
            </Button>
            <Button
              variant="primary"
              size="md"
              onClick={save}
              disabled={!dirty}
              icon={<Save size={14} strokeWidth={2} aria-hidden="true" />}
            >
              Save &amp; apply
            </Button>
          </>
        }
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="max-w-full overflow-x-auto no-scrollbar">
          <Segmented
            options={[
              { value: "profiles", label: "Profiles" },
              { value: "execution", label: "Execution" },
              { value: "universe", label: "Universe" },
              { value: "live", label: "Live" },
            ]}
            value={tab}
            onChange={setTab}
            ariaLabel="Strategy section"
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Pill tone={inferredDirection === "Mixed" ? "warn" : "neutral"}>
            Direction: {inferredDirection}
          </Pill>
          <Pill tone="neutral">{activeFilters} filters</Pill>
          {executionSettings.eqeEnabled ? (
            <Pill tone="accent">EQE gate on</Pill>
          ) : (
            <Pill tone="warn">EQE gate off</Pill>
          )}
        </div>
      </div>

      {tab !== "live" ? (
        <div className="flex flex-wrap items-center gap-3">
          {profileTabs}
          {tab === "profiles" ? (
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <span className="text-[9.5px] text-faint">Preset</span>
              {(Object.keys(strategyPresets) as Array<keyof typeof strategyPresets>).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyPreset(key)}
                  className="h-7 rounded-full border border-line bg-surface-2 px-2.5 text-[9.5px] font-medium text-ink-2 transition-colors duration-150 hover:border-line-strong hover:text-ink"
                >
                  {strategyPresets[key].label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid grid-cols-12 items-start gap-4 lg:gap-5">
        <div className="col-span-12 min-w-0 space-y-4 sm:space-y-5 xl:col-span-8">
          {tab === "profiles" ? (
            <>
              <Card>
                <SectionHead
                  title="Shared capital"
                  subtitle="Fund, risk unit and direction apply across both profiles."
                />
                <div className="grid gap-4 px-5 pb-5 pt-5 sm:grid-cols-3 sm:px-6">
                  <Field label="Total fund" hint="Changing the fund resets the paper account.">
                    <Input
                      type="number"
                      min={1}
                      step={100}
                      value={globalSettings.totalFund}
                      onChange={(event) => patchGlobal("totalFund", Number(event.target.value))}
                      leading="$"
                    />
                  </Field>
                  <Field label="Risk unit">
                    <Select
                      value={globalSettings.riskMode}
                      onChange={(event) =>
                        patchGlobal("riskMode", event.target.value as GlobalSettings["riskMode"])
                      }
                    >
                      <option value="roe">ROE (% of margin)</option>
                      <option value="price">Price (% of coin)</option>
                    </Select>
                  </Field>
                  <Field label="Trade direction">
                    <Select
                      value={globalSettings.direction}
                      onChange={(event) =>
                        patchGlobal("direction", event.target.value as GlobalSettings["direction"])
                      }
                    >
                      <option value="auto">Auto from filters</option>
                      <option value="long">Long only</option>
                      <option value="short">Short only</option>
                    </Select>
                  </Field>
                </div>
              </Card>

              <Card>
                <SectionHead
                  title="Position sizing"
                  subtitle="Margin and leverage for each new entry in this profile."
                />
                <div className="grid gap-4 px-5 pb-5 pt-5 sm:grid-cols-2 sm:px-6">
                  <Field label="Sizing mode">
                    <Select
                      value={profile.sizingMode}
                      onChange={(event) =>
                        patchProfile(
                          "sizingMode",
                          event.target.value as StrategyProfile["sizingMode"],
                        )
                      }
                    >
                      <option value="allocation">Percent of fund</option>
                      <option value="fixedMargin">Fixed margin</option>
                      <option value="fixedQty">Fixed quantity</option>
                    </Select>
                  </Field>
                  <Field label="Leverage">
                    <Input
                      type="number"
                      min={1}
                      max={200}
                      value={profile.leverage}
                      onChange={(event) => patchProfile("leverage", Number(event.target.value))}
                      suffix="×"
                    />
                  </Field>
                  {profile.sizingMode === "allocation" ? (
                    <>
                      <Field label="Per trade">
                        <Input
                          type="number"
                          min={0.1}
                          max={100}
                          step={0.1}
                          value={profile.allocation}
                          onChange={(event) => patchProfile("allocation", Number(event.target.value))}
                          suffix="% of fund"
                        />
                      </Field>
                      <Field label="Allocation base">
                        <Select
                          value={profile.allocationBase}
                          onChange={(event) =>
                            patchProfile(
                              "allocationBase",
                              event.target.value as StrategyProfile["allocationBase"],
                            )
                          }
                        >
                          <option value="initial">Initial fund</option>
                          <option value="equity">Current equity</option>
                        </Select>
                      </Field>
                    </>
                  ) : profile.sizingMode === "fixedMargin" ? (
                    <Field label="Margin per trade">
                      <Input
                        type="number"
                        min={1}
                        step={10}
                        value={profile.fixedMargin}
                        onChange={(event) => patchProfile("fixedMargin", Number(event.target.value))}
                        leading="$"
                      />
                    </Field>
                  ) : (
                    <Field label="Quantity per trade">
                      <Input
                        type="number"
                        min={0.00000001}
                        step={0.1}
                        value={profile.fixedQty}
                        onChange={(event) => patchProfile("fixedQty", Number(event.target.value))}
                        suffix="coins"
                      />
                    </Field>
                  )}
                  <div className="sm:col-span-2">
                    <p className="text-[10.5px] leading-[1.5] text-faint">
                      Each entry uses {usd(margin, 0)} margin, or {usd(notional, 0)} notional
                      at {profile.leverage}×. Free margin still caps how many can open.
                    </p>
                  </div>
                </div>
              </Card>

              <Card>
                <SectionHead
                  title="Exit plan"
                  subtitle={`Percentages use ${globalSettings.riskMode === "roe" ? "return on margin" : "coin price"} as the risk unit.`}
                />
                <div className="grid gap-4 px-5 pb-5 pt-5 sm:grid-cols-2 lg:grid-cols-3 sm:px-6">
                  <Field label="Stop loss" hint="Closes the remaining position.">
                    <Input
                      type="number"
                      min={0.1}
                      step={0.5}
                      value={profile.stopLoss}
                      onChange={(event) => patchProfile("stopLoss", Number(event.target.value))}
                      suffix={globalSettings.riskMode === "roe" ? "% ROE" : "% price"}
                    />
                  </Field>
                  <Field label="TP1" hint="First partial take-profit.">
                    <Input
                      type="number"
                      min={0.1}
                      step={1}
                      value={profile.tp1}
                      onChange={(event) => patchProfile("tp1", Number(event.target.value))}
                      suffix={globalSettings.riskMode === "roe" ? "% ROE" : "% price"}
                    />
                  </Field>
                  <Field label="TP1 close" hint="Portion closed at TP1.">
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={profile.tp1Close}
                      onChange={(event) => patchProfile("tp1Close", Number(event.target.value))}
                      suffix="%"
                    />
                  </Field>
                  <Field label="Max TP" hint="Closes the runner.">
                    <Input
                      type="number"
                      min={1}
                      step={10}
                      value={profile.tpMax}
                      onChange={(event) => patchProfile("tpMax", Number(event.target.value))}
                      suffix={globalSettings.riskMode === "roe" ? "% ROE" : "% price"}
                    />
                  </Field>
                  <Field label="Trailing distance" hint="Trail from the peak.">
                    <Input
                      type="number"
                      min={0.1}
                      step={0.5}
                      value={profile.trailDistance}
                      onChange={(event) => patchProfile("trailDistance", Number(event.target.value))}
                      suffix={globalSettings.riskMode === "roe" ? "% ROE" : "% price"}
                      disabled={!profile.trailing}
                    />
                  </Field>
                  <Field label="Trail starts">
                    <Select
                      value={profile.trailingStart}
                      onChange={(event) =>
                        patchProfile(
                          "trailingStart",
                          event.target.value as StrategyProfile["trailingStart"],
                        )
                      }
                      disabled={!profile.trailing}
                    >
                      <option value="tp1">After TP1</option>
                      <option value="immediate">Immediately</option>
                    </Select>
                  </Field>
                  <div className="flex flex-col justify-end gap-2">
                    <div className="flex items-center justify-between rounded-[10px] border border-line bg-surface-2 px-3 py-2">
                      <span className="text-[11px] font-medium text-ink-2">Trailing stop</span>
                      <Switch
                        checked={profile.trailing}
                        onChange={(value) => patchProfile("trailing", value)}
                        label="Trailing stop"
                      />
                    </div>
                    <p className="text-[9.5px] leading-[1.4] text-faint">
                      A {profile.stopLoss}% {globalSettings.riskMode === "roe" ? "ROE" : "price"} stop is a{" "}
                      {(globalSettings.riskMode === "roe" ? profile.stopLoss / safeLeverage : profile.stopLoss).toFixed(2)}%
                      price move at {profile.leverage}×.
                    </p>
                  </div>
                </div>
              </Card>

              <FiltersEditor
                profile={profile}
                side={side}
                updateFilter={updateFilter}
                removeFilter={removeFilter}
                addFilter={addFilter}
              />

              <Card>
                <SectionHead
                  title="Profile limits"
                  subtitle="Caps that apply only to this profile."
                />
                <div className="grid gap-4 px-5 pb-5 pt-5 sm:grid-cols-3 sm:px-6">
                  <Field label="Max trades" hint="0 means unlimited.">
                    <Input
                      type="number"
                      min={0}
                      value={profile.maxTrades}
                      onChange={(event) => patchProfile("maxTrades", Number(event.target.value))}
                    />
                  </Field>
                  <Field label="Max open positions" hint="0 means no cap.">
                    <Input
                      type="number"
                      min={0}
                      value={profile.maxOpenPositions}
                      onChange={(event) =>
                        patchProfile("maxOpenPositions", Number(event.target.value))
                      }
                    />
                  </Field>
                  <Field label="Max per coin" hint="Stack entries in the same move.">
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={profile.maxPositionsPerCoin}
                      onChange={(event) =>
                        patchProfile("maxPositionsPerCoin", Number(event.target.value))
                      }
                    />
                  </Field>
                </div>
              </Card>
            </>
          ) : null}

          {tab === "execution" ? (
            <>
              <Card>
                <SectionHead
                  title="Execution quality gate"
                  subtitle="Reject or scale an entry before it reaches the router."
                  action={
                    <Pill tone={executionSettings.eqeEnabled ? "accent" : "warn"}>
                      {executionSettings.eqeEnabled ? "Enabled" : "Off"}
                    </Pill>
                  }
                />
                <div className="grid gap-4 px-5 pb-5 pt-5 sm:grid-cols-2 sm:px-6">
                  <Field label="Max 1-way cost" hint="Fee, spread and impact combined.">
                    <Input
                      type="number"
                      min={1}
                      value={executionSettings.maxOneWayCostBps}
                      onChange={(event) =>
                        patchExecution("maxOneWayCostBps", Number(event.target.value))
                      }
                      suffix="bps"
                    />
                  </Field>
                  <Field label="Max spread">
                    <Input
                      type="number"
                      min={0}
                      value={executionSettings.maxSpreadBps}
                      onChange={(event) => patchExecution("maxSpreadBps", Number(event.target.value))}
                      suffix="bps"
                    />
                  </Field>
                  <Field label="Min depth multiple" hint="Book depth over requested notional.">
                    <Input
                      type="number"
                      min={1}
                      step={0.5}
                      value={executionSettings.minDepthMultiple}
                      onChange={(event) =>
                        patchExecution("minDepthMultiple", Number(event.target.value))
                      }
                      suffix="×"
                    />
                  </Field>
                  <Field label="Entry order type">
                    <Select
                      value={executionSettings.entryOrderType}
                      onChange={(event) =>
                        patchExecution(
                          "entryOrderType",
                          event.target.value as ExecutionSettings["entryOrderType"],
                        )
                      }
                    >
                      <option value="ioc-limit">IOC limit, slippage protected</option>
                      <option value="market">Market order</option>
                    </Select>
                  </Field>
                  <div className="sm:col-span-2 space-y-3 border-t border-line pt-4">
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-[11.5px] font-medium text-ink">Enable EQE gate</p>
                        <p className="mt-0.5 text-[9.5px] text-muted">
                          Gate entries on spread, depth and market impact.
                        </p>
                      </div>
                      <Switch
                        checked={executionSettings.eqeEnabled}
                        onChange={(value) => patchExecution("eqeEnabled", value)}
                        label="Enable EQE gate"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-[11.5px] font-medium text-ink">Auto-size to liquidity</p>
                        <p className="mt-0.5 text-[9.5px] text-muted">
                          Scale the entry down when the book is thinner than requested.
                        </p>
                      </div>
                      <Switch
                        checked={executionSettings.autoSizeToLiquidity}
                        onChange={(value) => patchExecution("autoSizeToLiquidity", value)}
                        label="Auto-size to liquidity"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <div>
                        <p className="text-[11.5px] font-medium text-ink">Funding boundary guard</p>
                        <p className="mt-0.5 text-[9.5px] text-muted">
                          Block adverse entries close to the next funding payment.
                        </p>
                      </div>
                      <Switch
                        checked={executionSettings.fundingGuard}
                        onChange={(value) => patchExecution("fundingGuard", value)}
                        label="Funding boundary guard"
                      />
                    </div>
                  </div>
                </div>
              </Card>

              <Card>
                <SectionHead
                  title="Routing & simulator"
                  subtitle="Venue selection and paper fill assumptions."
                />
                <div className="grid gap-4 px-5 pb-5 pt-5 sm:grid-cols-2 sm:px-6">
                  <Field label="Routing mode">
                    <Select
                      value={executionSettings.routeMode}
                      onChange={(event) =>
                        patchExecution("routeMode", event.target.value as ExecutionSettings["routeMode"])
                      }
                    >
                      <option value="auto">Auto, best executable venue</option>
                      <option value="pinned">Pinned to active exchange</option>
                    </Select>
                  </Field>
                  <Field label="Simulator realism">
                    <Select
                      value={executionSettings.realismMode}
                      onChange={(event) =>
                        patchExecution(
                          "realismMode",
                          event.target.value as ExecutionSettings["realismMode"],
                        )
                      }
                    >
                      <option value="standard">Standard, order book + latency</option>
                      <option value="conservative">Conservative, adverse selection</option>
                      <option value="stress">Stress, 2× impact + thin book</option>
                      <option value="optimistic">Optimistic, mid + static slip</option>
                    </Select>
                  </Field>
                  <div className="sm:col-span-2 flex items-center justify-between gap-4 border-t border-line pt-4">
                    <div>
                      <p className="text-[11.5px] font-medium text-ink">Simulation haircut</p>
                      <p className="mt-0.5 text-[9.5px] text-muted">
                        Displayed paper PnL is reduced to reflect execution drag.
                      </p>
                    </div>
                    <Pill tone="neutral">{haircut}% haircut</Pill>
                  </div>
                </div>
              </Card>

              <Card>
                <SectionHead
                  title="Cadence & costs"
                  subtitle="Scan loop, price polling, fees and re-entry."
                />
                <div className="grid gap-4 px-5 pb-5 pt-5 sm:grid-cols-2 lg:grid-cols-3 sm:px-6">
                  <Field label="Scan interval">
                    <Input
                      type="number"
                      min={10}
                      max={3600}
                      step={5}
                      value={globalSettings.scanIntervalSec}
                      onChange={(event) =>
                        patchGlobal("scanIntervalSec", Number(event.target.value))
                      }
                      suffix="sec"
                    />
                  </Field>
                  <Field label="Price refresh">
                    <Input
                      type="number"
                      min={500}
                      max={60000}
                      step={500}
                      value={globalSettings.priceRefreshMs}
                      onChange={(event) =>
                        patchGlobal("priceRefreshMs", Number(event.target.value))
                      }
                      suffix="ms"
                    />
                  </Field>
                  <Field label="Taker fee">
                    <Input
                      type="number"
                      min={0}
                      step={0.005}
                      value={globalSettings.feePercent}
                      onChange={(event) => patchGlobal("feePercent", Number(event.target.value))}
                      suffix="% / side"
                    />
                  </Field>
                  <Field label="Slippage">
                    <Input
                      type="number"
                      min={0}
                      step={0.005}
                      value={globalSettings.slippagePercent}
                      onChange={(event) =>
                        patchGlobal("slippagePercent", Number(event.target.value))
                      }
                      suffix="% / side"
                    />
                  </Field>
                  <Field label="Re-entry delay">
                    <Input
                      type="number"
                      min={0}
                      step={5}
                      value={globalSettings.reenterDelayMin}
                      onChange={(event) =>
                        patchGlobal("reenterDelayMin", Number(event.target.value))
                      }
                      suffix="min"
                      disabled={!globalSettings.reenterEnabled}
                    />
                  </Field>
                  <div className="flex flex-col justify-end gap-2">
                    <div className="flex items-center justify-between rounded-[10px] border border-line bg-surface-2 px-3 py-2">
                      <span className="text-[11px] font-medium text-ink-2">Block same-coin re-entry</span>
                      <Switch
                        checked={globalSettings.reenterEnabled}
                        onChange={(value) => patchGlobal("reenterEnabled", value)}
                        label="Block same-coin re-entry"
                      />
                    </div>
                  </div>
                  <div className="sm:col-span-2 lg:col-span-3 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-4">
                      <label className="flex items-center gap-2 text-[10.5px] text-muted">
                        <Switch
                          checked={globalSettings.autoStart}
                          onChange={(value) => patchGlobal("autoStart", value)}
                          label="Auto-start engine"
                        />
                        Auto-start engine
                      </label>
                      <label className="flex items-center gap-2 text-[10.5px] text-muted">
                        <Switch
                          checked={globalSettings.notifications}
                          onChange={(value) => patchGlobal("notifications", value)}
                          label="Browser notifications"
                        />
                        Browser notifications
                      </label>
                    </div>
                    <Link to="/exchanges" className="text-[10.5px] font-medium text-accent">
                      Manage exchange keys
                    </Link>
                  </div>
                </div>
              </Card>

              <Card>
                <SectionHead
                  title="Price venues"
                  subtitle="At least one venue must stay enabled."
                  action={<Pill tone="neutral">{Object.values(venuesOn).filter(Boolean).length} on</Pill>}
                />
                <div className="px-5 pb-5 pt-5 sm:px-6">
                  <div className="grid gap-1 sm:grid-cols-2">
                    {venueData.map((venue) => (
                      <div
                        key={venue.key}
                        className="flex items-center justify-between gap-3 rounded-[10px] px-1.5 py-2 transition-colors duration-150 hover:bg-surface-2"
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            className={cn(
                              "status-dot",
                              venue.status === "healthy" ? "text-pos" : "text-warn",
                            )}
                            aria-hidden="true"
                          />
                          <span className="text-[11.5px] font-medium text-ink">{venue.name}</span>
                          <span className="num text-[9.5px] text-faint">{venue.latency} ms</span>
                        </div>
                        <Switch
                          checked={Boolean(venuesOn[venue.key])}
                          onChange={(value) => patchVenue(venue.key, value)}
                          label={`Enable ${venue.name}`}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
            </>
          ) : null}

          {tab === "universe" ? (
            <>
              <Card>
                <SectionHead
                  title="Universe filters"
                  subtitle="Which coins can produce a signal."
                  action={<Pill tone="accent">412 eligible</Pill>}
                />
                <div className="grid gap-4 px-5 pb-5 pt-5 sm:grid-cols-2 sm:px-6">
                  <Field label="Minimum open interest" hint="USD value across the market.">
                    <Input
                      type="number"
                      min={0}
                      step={100000}
                      value={globalSettings.minOiUsd}
                      onChange={(event) => patchGlobal("minOiUsd", Number(event.target.value))}
                      leading="$"
                    />
                  </Field>
                  <Field label="Minimum 24h volume" hint="USD value across the market.">
                    <Input
                      type="number"
                      min={0}
                      step={100000}
                      value={globalSettings.minVolUsd24h}
                      onChange={(event) => patchGlobal("minVolUsd24h", Number(event.target.value))}
                      leading="$"
                    />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field
                      label="Excluded symbols"
                      hint="Comma separated. Stablecoins and wrapped majors are excluded by default."
                    >
                      <Input
                        value={globalSettings.excludeSymbols}
                        onChange={(event) =>
                          patchGlobal("excludeSymbols", event.target.value.toUpperCase())
                        }
                      />
                    </Field>
                  </div>
                  <div className="sm:col-span-2 flex items-center justify-between gap-4 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
                    <div>
                      <p className="text-[11px] font-medium text-ink">Use CoinGlass price fallback</p>
                      <p className="mt-0.5 text-[9.5px] text-muted">
                        Allow coins without a public exchange feed to remain tradable.
                      </p>
                    </div>
                    <Switch
                      checked={globalSettings.allowCoinglassPrice}
                      onChange={(value) => patchGlobal("allowCoinglassPrice", value)}
                      label="Use CoinGlass price fallback"
                    />
                  </div>
                </div>
              </Card>

              <Card>
                <SectionHead
                  title="Universe snapshot"
                  subtitle="Current eligibility before the next scan."
                />
                <div className="grid grid-cols-2 gap-px overflow-hidden border-t border-line bg-line sm:grid-cols-4">
                  {[
                    { label: "Scanned", value: "412" },
                    { label: "Qualified", value: String(coins.filter((coin) => coin.status === "qualified").length) },
                    { label: "Near miss", value: String(coins.filter((coin) => coin.status === "near").length) },
                    { label: "Excluded", value: "34" },
                  ].map((item) => (
                    <div key={item.label} className="bg-surface px-5 py-4">
                      <p className="text-[9.5px] text-faint">{item.label}</p>
                      <p className="num mt-1 text-[16px] font-semibold text-ink">{item.value}</p>
                    </div>
                  ))}
                </div>
                <div className="px-5 py-4 sm:px-6">
                  <p className="text-[10px] leading-[1.5] text-faint">
                    A coin is tradable when at least one enabled price venue lists it and it
                    passes every active filter. Use the scanner to inspect the live gate.
                  </p>
                  <Link
                    to="/scanner"
                    className="mt-3 inline-flex items-center gap-1 text-[10.5px] font-medium text-accent"
                  >
                    Open live scanner
                    <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
                  </Link>
                </div>
              </Card>
            </>
          ) : null}

          {tab === "live" ? (
            <>
              <Card>
                <SectionHead
                  title="Execution mode"
                  subtitle="Live orders route through the active exchange."
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
                            ? `${activeExchange.name} is connected with a trade-only key.`
                            : "Connect an exchange before arming live mode."}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Link to="/exchanges">
                        <Button variant="ghost" size="sm">
                          Exchanges
                        </Button>
                      </Link>
                      {mode === "live" ? (
                        <Button variant="secondary" size="sm" onClick={() => setMode("paper")}>
                          Return to paper
                        </Button>
                      ) : (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={openLiveConfirm}
                          disabled={!connectedExchange}
                        >
                          Arm live mode
                        </Button>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 flex items-center justify-between gap-4 rounded-[10px] border border-line px-3 py-2.5">
                    <div>
                      <p className="text-[11px] font-medium text-ink">Kill switch</p>
                      <p className="mt-0.5 text-[9.5px] text-muted">
                        Block all new entries without touching open positions.
                      </p>
                    </div>
                    <Switch
                      checked={killSwitch}
                      onChange={setKillSwitch}
                      label="Kill switch"
                    />
                  </div>

                  <div className="mt-3 flex items-start gap-2.5 rounded-[10px] border border-warn/30 bg-warn-soft px-3 py-2.5">
                    <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
                    <p className="text-[9.5px] leading-[1.5] text-warn">
                      This is a preview. No live order is submitted by this interface. The
                      connected bot will route orders to {activeExchange?.name ?? "the active exchange"}.
                    </p>
                  </div>
                </div>
              </Card>

              <Card>
                <SectionHead
                  title="Live guardrails"
                  subtitle="Hard caps applied before any live order."
                  action={<Pill tone="neutral">{exchanges.filter((exchange) => exchange.connected).length} connected</Pill>}
                />
                <div className="grid gap-4 px-5 pb-5 pt-5 sm:grid-cols-2 sm:px-6">
                  <Field label="Execution exchange">
                    <Select
                      value={liveDraft.exchange || activeExchange?.id || "bybit"}
                      onChange={(event) => patchLive("exchange", event.target.value)}
                    >
                      {exchanges.map((exchange) => (
                        <option key={exchange.id} value={exchange.id}>
                          {exchange.name}
                          {exchange.liveSupported ? "" : " (paper only)"}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Max margin per trade" hint="0 means strategy sizing.">
                    <Input
                      type="number"
                      min={0}
                      step={50}
                      value={liveDraft.marginPerTrade}
                      onChange={(event) => patchLive("marginPerTrade", Number(event.target.value))}
                      leading="$"
                    />
                  </Field>
                  <Field label="Daily loss cap" hint="0 means no cap.">
                    <Input
                      type="number"
                      min={0}
                      step={50}
                      value={liveDraft.dailyLossCap}
                      onChange={(event) => patchLive("dailyLossCap", Number(event.target.value))}
                      leading="$"
                    />
                  </Field>
                  <Field label="Max live open positions" hint="0 means no cap.">
                    <Input
                      type="number"
                      min={0}
                      max={50}
                      value={liveDraft.maxOpenPositions}
                      onChange={(event) => patchLive("maxOpenPositions", Number(event.target.value))}
                    />
                  </Field>
                  <div className="sm:col-span-2 flex items-center justify-between gap-4 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
                    <div>
                      <p className="text-[11px] font-medium text-ink">Clamp leverage</p>
                      <p className="mt-0.5 text-[9.5px] text-muted">
                        Limit leverage to each symbol&apos;s exchange maximum.
                      </p>
                    </div>
                    <Switch
                      checked={liveDraft.clampLeverage}
                      onChange={(value) => patchLive("clampLeverage", value)}
                      label="Clamp leverage"
                    />
                  </div>
                  <div className="sm:col-span-2 flex items-center gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        const ok = await saveLiveGuardrails(liveDraft);
                        if (!ok) return;
                        notify("Live guardrails saved", "The guardrails are active for the next live order.", undefined, "success");
                      }}
                    >
                      Save guardrails
                    </Button>
                    <span className="text-[9.5px] text-faint">
                      {liveDraft.marginPerTrade > 0 ? `${usd(liveDraft.marginPerTrade, 0)} max margin` : "Strategy sizing"}
                    </span>
                  </div>
                </div>
              </Card>

              <Card>
                <SectionHead
                  title="Before you arm"
                  subtitle="A live execution sanity check."
                  action={<Pill tone="neutral">{connectedExchange ? "Ready" : "Needs keys"}</Pill>}
                />
                <div className="space-y-2.5 px-5 pb-5 pt-5 sm:px-6">
                  {[
                    "Trade-only API key with withdrawals disabled",
                    "Margin cap and daily loss cap configured",
                    "Kill switch reachable from every screen",
                    "Open positions and protection stops reconciled",
                  ].map((item) => (
                    <div key={item} className="flex items-start gap-2.5 text-[10.5px] leading-[1.5] text-muted">
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-pos-soft text-pos">
                        <Check size={9} strokeWidth={2.6} aria-hidden="true" />
                      </span>
                      {item}
                    </div>
                  ))}
                  <Link
                    to="/exchanges"
                    className="mt-3 inline-flex items-center gap-1 border-t border-line pt-3 text-[10.5px] font-medium text-accent"
                  >
                    Review exchange vault
                    <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
                  </Link>
                </div>
              </Card>
            </>
          ) : null}
        </div>

        <aside className="col-span-12 min-w-0 space-y-4 sm:space-y-5 xl:sticky xl:top-[80px] xl:col-span-4">
          <Card className="overflow-hidden">
            <div className="flex items-center justify-between px-5 pt-5 sm:px-6">
              <div>
                <p className="text-[10px] text-muted">Plan preview</p>
                <p className="mt-0.5 text-[13px] font-semibold text-ink">
                  {side === "long" ? "Long profile" : "Short profile"}
                </p>
              </div>
              <Pill tone={profile.enabled ? "accent" : "warn"}>
                {profile.enabled ? "Enabled" : "Off"}
              </Pill>
            </div>
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <div className="flex items-baseline gap-2">
                <p className="num text-[30px] font-semibold leading-none tracking-[-0.03em] text-ink">
                  {usd(margin, 0)}
                </p>
                <span className="text-[10.5px] text-muted">margin</span>
              </div>
              <p className="mt-1 text-[10.5px] text-muted">
                {usd(notional, 0)} notional at {profile.leverage}×
              </p>

              <div className="relative mt-6 h-2 rounded-full bg-surface-2">
                <span className="absolute inset-y-0 rounded-full bg-neg-soft" style={zone(entry, stopPrice)} />
                <span className="absolute inset-y-0 rounded-full bg-pos-soft" style={zone(entry, tp1Price)} />
                <span className="absolute inset-y-0 rounded-full bg-accent-soft-2" style={zone(tp1Price, tpMaxPrice)} />
                <span
                  className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink shadow-[0_0_0_2px_var(--surface)]"
                  style={{ left: `${ladderAt(entry)}%` }}
                />
              </div>
              <div className="mt-2 flex justify-between text-[9px] text-faint">
                {side === "long" ? (
                  <>
                    <span>Stop</span>
                    <span>Entry</span>
                    <span>TP1</span>
                    <span>Max</span>
                  </>
                ) : (
                  <>
                    <span>Max</span>
                    <span>TP1</span>
                    <span>Entry</span>
                    <span>Stop</span>
                  </>
                )}
              </div>

              <div className="mt-5 space-y-2.5 border-t border-line pt-4">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[10.5px] text-muted">Reference</span>
                  <span className="num text-[11px] font-medium text-ink">
                    {reference?.symbol ?? "BTC"} {price(entry)}
                  </span>
                </div>
                <DataRow label="Stop price" value={price(stopPrice)} tone="neg" />
                <DataRow label="TP1 price" value={price(tp1Price)} tone="pos" />
                <DataRow label="Max TP price" value={price(tpMaxPrice)} />
                <div className="flex items-center justify-between gap-4 border-t border-line pt-2.5">
                  <span className="text-[10.5px] text-muted">Risk at stop</span>
                  <span className="num text-[11px] font-medium text-neg">{usd(riskAtStop)}</span>
                </div>
              </div>

              <div className="mt-4 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
                <p className="text-[9.5px] leading-[1.5] text-muted">
                  {profile.tp1Close}% closes at TP1.{" "}
                  {profile.trailing
                    ? `The runner trails ${profile.trailDistance}% ${globalSettings.riskMode === "roe" ? "ROE" : "price"} from the peak.`
                    : "The runner exits at the fixed max TP."}
                </p>
              </div>

              <Button
                variant="secondary"
                size="sm"
                className="mt-4 w-full"
                icon={<RotateCcw size={12} strokeWidth={2} aria-hidden="true" />}
                onClick={() => {
                  setDrafts((current) => ({
                    ...current,
                    [side]: cloneProfile(defaultStrategy[side]),
                  }));
                  markDirty();
                  notify("Profile restored", "The current profile is back to its defaults.", undefined, "info");
                }}
              >
                Restore this profile
              </Button>
            </div>
          </Card>

          <Card>
            <SectionHead title="Execution cost" subtitle="Estimated round-trip drag" />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <div className="flex items-center justify-between">
                <p className="num text-[24px] font-semibold tracking-[-0.03em] text-ink">
                  {roundTripBps.toFixed(1)} <span className="text-[11px] font-normal text-muted">bps</span>
                </p>
                <Pill tone={edgeMultiple >= 1.5 ? "pos" : edgeMultiple >= 1 ? "warn" : "neg"}>
                  {edgeMultiple >= 1.5 ? "Edge OK" : edgeMultiple >= 1 ? "Thin edge" : "Below cost"}
                </Pill>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
                {[
                  { label: "Min breakeven", value: `${minMovePct.toFixed(2)}%` },
                  { label: "Net edge", value: `${edgeMultiple.toFixed(1)}×` },
                  { label: "Sim haircut", value: `${haircut}%` },
                  { label: "TP1 move", value: `${tp1MoveBps.toFixed(0)} bps` },
                ].map((item) => (
                  <div key={item.label}>
                    <p className="text-[9px] text-faint">{item.label}</p>
                    <p className="num mt-0.5 text-[11px] font-medium text-ink">{item.value}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 border-t border-line pt-3">
                <div className="flex items-center justify-between text-[9.5px] text-faint">
                  <span>Execution gate</span>
                  <span>{executionSettings.maxOneWayCostBps} bps cap</span>
                </div>
                <Meter
                  value={Math.min(100, Math.max(0, (roundTripBps / 2 / Math.max(1, executionSettings.maxOneWayCostBps)) * 100))}
                  className="mt-2"
                />
              </div>
            </div>
          </Card>

          <Card>
            <SectionHead title="Live readiness" subtitle="Active execution path" />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <div className="space-y-2.5">
                <DataRow label="Mode" value={mode === "live" ? "Live" : "Paper"} />
                <DataRow label="Exchange" value={activeExchange?.name ?? "None"} />
                <DataRow label="Connection" value={activeExchange?.connected ? "Verified" : "Not connected"} tone={activeExchange?.connected ? "pos" : "neg"} />
                <DataRow label="Kill switch" value={killSwitch ? "Active" : "Clear"} tone={killSwitch ? "neg" : "default"} />
              </div>
              <Link
                to="/exchanges"
                className="mt-4 inline-flex items-center gap-1 border-t border-line pt-3 text-[10.5px] font-medium text-accent"
              >
                Open exchange vault
                <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
              </Link>
            </div>
          </Card>

          <div className="flex items-center gap-2 px-1">
            <Button variant="danger" size="sm" onClick={resetStrategy} className="w-full">
              Reset strategy
            </Button>
          </div>
          <p className="px-1 text-[9.5px] leading-[1.5] text-faint">
            Saving applies both profiles, execution settings and live guardrails.
            The paper account keeps its positions and history.
          </p>
        </aside>
      </div>
    </div>
  );
}
