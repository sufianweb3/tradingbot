import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  Check,
  KeyRound,
  Link2,
  LockKeyhole,
  Plug,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Unplug,
  Wallet,
} from "lucide-react";
import type { Exchange } from "../lib/data";
import { cn, usd } from "../lib/format";
import { useApp } from "../store/AppStore";
import {
  Button,
  Card,
  DataRow,
  Field,
  Input,
  PageHeader,
  Pill,
  SectionHead,
  Select,
  Switch,
} from "../components/ui";

const statusLabel: Record<Exchange["status"], string> = {
  connected: "Connected",
  available: "Available",
  paper: "Paper only",
  "price-feed": "Price feed",
};

const statusTone: Record<Exchange["status"], "pos" | "neutral" | "warn" | "accent"> = {
  connected: "pos",
  available: "neutral",
  paper: "warn",
  "price-feed": "accent",
};

function ExchangeCard({ exchange }: { exchange: Exchange }) {
  const {
    openExchangeWizard,
    setActiveExchange,
    disconnectExchange,
    requestConfirm,
    mode,
  } = useApp();
  const isActive = exchange.active;
  const canTradeLive = exchange.liveSupported && exchange.connected;

  return (
    <Card
      className={cn(
        "flex flex-col overflow-hidden transition-[border-color,box-shadow] duration-150",
        isActive && "border-accent/40 shadow-[0_0_0_3px_var(--accent-soft)]",
      )}
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] border text-[11px] font-semibold",
              isActive
                ? "border-accent/30 bg-accent-soft text-accent"
                : "border-line bg-surface-2 text-ink-2",
            )}
          >
            {exchange.shortName}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <p className="text-[13px] font-semibold leading-none text-ink">{exchange.name}</p>
              {isActive ? (
                <Pill tone="accent" className="h-5 px-1.5 text-[8.5px]">
                  Active
                </Pill>
              ) : null}
            </div>
            <p className="mt-1 text-[10px] text-muted">{exchange.tier}</p>
          </div>
        </div>
        <Pill tone={statusTone[exchange.status]} dot={exchange.status === "connected"} className="h-5 px-2 text-[9px]">
          {statusLabel[exchange.status]}
        </Pill>
      </div>

      <div className="mt-4 flex-1 px-5">
        {exchange.connected ? (
          <>
            <div className="flex items-center justify-between gap-3 rounded-[10px] border border-line bg-surface-2 px-3 py-2">
              <span className="flex items-center gap-1.5 text-[10px] text-muted">
                <KeyRound size={11} strokeWidth={1.9} aria-hidden="true" />
                API key
              </span>
              <span className="num text-[10.5px] font-medium text-ink">{exchange.maskedKey}</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <Pill tone="pos" className="h-5 px-2 text-[8.5px]">
                <Check size={9} strokeWidth={2.6} aria-hidden="true" />
                Trade enabled
              </Pill>
              <Pill tone="neutral" className="h-5 px-2 text-[8.5px]">
                <LockKeyhole size={9} strokeWidth={2} aria-hidden="true" />
                Withdrawals off
              </Pill>
            </div>
            <div className="mt-3 flex items-end justify-between border-t border-line pt-3">
              <div>
                <p className="text-[9px] text-faint">Available balance</p>
                <p className="num mt-1 text-[14px] font-semibold text-ink">{usd(exchange.balance)}</p>
              </div>
              <p className="num text-[9.5px] text-muted">{exchange.latency} ms</p>
            </div>
          </>
        ) : (
          <div className="rounded-[10px] border border-line bg-surface-2 px-3 py-3">
            <p className="text-[10px] leading-[1.5] text-muted">
              {exchange.note ??
                (exchange.readOnly
                  ? "Price discovery only. No API key required."
                  : "Connect a trade-only futures API key to route live orders.")}
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-[9.5px] text-faint">
              <ActivityGlyph />
              {exchange.readOnly ? "Public market feed" : "Futures adapter ready"}
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 px-5 pb-5">
        {exchange.connected ? (
          <>
            {!isActive && canTradeLive ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setActiveExchange(exchange.id)}
                icon={<Link2 size={12} strokeWidth={2} aria-hidden="true" />}
              >
                Set active
              </Button>
            ) : isActive ? (
              <Pill tone="accent" className="h-8 px-3 text-[9.5px]">
                {mode === "live" ? "Live routes here" : "Selected"}
              </Pill>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openExchangeWizard(exchange.id)}
              className="h-8"
            >
              Replace keys
            </Button>
            <Button
              variant="danger"
              size="sm"
              className="ml-auto h-8"
              onClick={() =>
                requestConfirm({
                  title: `Disconnect ${exchange.name}?`,
                  description:
                    "This removes the masked API key from this preview. Any live mode will return to paper for safety.",
                  confirmLabel: "Disconnect",
                  tone: "danger",
                  onConfirm: () => disconnectExchange(exchange.id),
                })
              }
              icon={<Unplug size={12} strokeWidth={2} aria-hidden="true" />}
            >
              Disconnect
            </Button>
          </>
        ) : exchange.liveSupported ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => openExchangeWizard(exchange.id)}
            icon={<Plug size={12} strokeWidth={2} aria-hidden="true" />}
          >
            Connect
          </Button>
        ) : (
          <Pill tone="neutral" className="h-8 px-3 text-[9.5px]">
            {exchange.readOnly ? "No keys needed" : "Paper execution only"}
          </Pill>
        )}
      </div>
    </Card>
  );
}

function ActivityGlyph() {
  return (
    <span className="relative flex h-3 w-3 items-center justify-center">
      <span className="h-1.5 w-1.5 rounded-full bg-pos" />
      <span className="absolute inset-0 rounded-full border border-pos/30" />
    </span>
  );
}

export default function ExchangesPage() {
  const {
    exchanges,
    activeExchange,
    mode,
    liveGuardrails,
    openLiveConfirm,
    setMode,
    reconcile,
    notify,
    requestConfirm,
    closeAll,
    openExchangeWizard,
    saveLiveGuardrails,
  } = useApp();
  const [draft, setDraft] = useState(liveGuardrails);

  useEffect(() => {
    setDraft(liveGuardrails);
  }, [liveGuardrails]);

  const connected = exchanges.filter((exchange) => exchange.connected);
  const availableBalance = connected.reduce(
    (sum, exchange) => sum + exchange.balance,
    0,
  );
  const liveReady = exchanges.some(
    (exchange) => exchange.connected && exchange.liveSupported,
  );

  const saveGuardrails = async () => {
    const ok = await saveLiveGuardrails(draft);
    if (!ok) return;
    notify(
      "Live guardrails saved",
      `Max margin ${draft.marginPerTrade > 0 ? usd(draft.marginPerTrade, 0) : "strategy sizing"}, daily loss cap ${
        draft.dailyLossCap > 0 ? usd(draft.dailyLossCap, 0) : "disabled"
      }.`,
      undefined,
      "success",
    );
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="Exchanges"
        subtitle="Connect trade-only API keys, choose the active execution venue and set live guardrails."
        actions={
          <>
            <Button
              variant="ghost"
              size="md"
              onClick={() => openExchangeWizard("bybit")}
              icon={<KeyRound size={14} strokeWidth={1.9} aria-hidden="true" />}
            >
              Add keys
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={reconcile}
              icon={<RefreshCw size={14} strokeWidth={1.9} aria-hidden="true" />}
            >
              Reconcile
            </Button>
            {mode === "live" ? (
              <Button
                variant="secondary"
                size="md"
                onClick={() => setMode("paper")}
                icon={<ShieldAlert size={14} strokeWidth={1.9} aria-hidden="true" />}
              >
                Return to paper
              </Button>
            ) : (
              <Button
                variant="primary"
                size="md"
                disabled={!liveReady}
                onClick={openLiveConfirm}
                icon={<ShieldAlert size={14} strokeWidth={2} aria-hidden="true" />}
              >
                Arm live mode
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[16px] border border-line bg-line sm:grid-cols-3 xl:grid-cols-5">
        {[
          {
            label: "Active exchange",
            value: activeExchange?.name ?? "None",
            hint: activeExchange?.tier ?? "Connect a venue",
          },
          {
            label: "Execution mode",
            value: mode === "live" ? "Live" : "Paper",
            hint: mode === "live" ? "Orders route to exchange" : "Simulated fills",
          },
          {
            label: "Connected",
            value: `${connected.length} of ${exchanges.length}`,
            hint: "venues with keys",
          },
          {
            label: "Available balance",
            value: usd(availableBalance),
            hint: "across connected venues",
          },
          {
            label: "Leverage clamp",
            value: liveGuardrails.clampLeverage ? "Clamp on" : "Clamp off",
            hint: `max ${liveGuardrails.maxOpenPositions || "∞"} live positions`,
          },
        ].map((item, index) => (
          <div
            key={item.label}
            className={cn(
              "bg-surface px-4 py-4 sm:px-5",
              index === 4 && "col-span-2 sm:col-span-2 xl:col-span-1",
            )}
          >
            <p className="text-[10px] text-muted">{item.label}</p>
            <p className="mt-1.5 text-[16px] font-semibold tracking-[-0.02em] text-ink">
              {item.value}
            </p>
            <p className="mt-0.5 text-[9.5px] text-faint">{item.hint}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink">
            Connection vault
          </h2>
          <p className="mt-0.5 text-[11px] text-muted">
            Trade-only keys. Withdrawals stay disabled.
          </p>
        </div>
        <Pill tone={mode === "live" ? "neg" : "neutral"} dot pulse={mode === "live"}>
          {mode === "live" ? `Live · ${activeExchange?.name ?? ""}` : "Paper execution"}
        </Pill>
      </div>

      <div className="grid grid-cols-12 gap-4 lg:gap-5">
        <div className="col-span-12 grid gap-4 sm:grid-cols-2 xl:col-span-8 lg:gap-5">
          {exchanges.map((exchange) => (
            <ExchangeCard key={exchange.id} exchange={exchange} />
          ))}
        </div>

        <div className="col-span-12 space-y-4 sm:space-y-5 xl:col-span-4">
          <Card>
            <SectionHead
              title="Live guardrails"
              subtitle="Hard caps applied before any live order."
              action={
                <Pill tone={mode === "live" ? "neg" : "neutral"}>
                  {mode === "live" ? "Armed" : "Paper"}
                </Pill>
              }
            />
            <div className="space-y-4 px-5 pb-5 pt-5 sm:px-6">
              <Field label="Execution exchange">
                <Select
                  value={draft.exchange || activeExchange?.id || "bybit"}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, exchange: event.target.value }))
                  }
                >
                  {exchanges.map((exchange) => (
                    <option key={exchange.id} value={exchange.id}>
                      {exchange.name}
                      {exchange.liveSupported ? "" : " (paper only)"}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Max margin">
                  <Input
                    type="number"
                    min={0}
                    step={50}
                    value={draft.marginPerTrade}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        marginPerTrade: Number(event.target.value),
                      }))
                    }
                    leading="$"
                  />
                </Field>
                <Field label="Daily loss cap">
                  <Input
                    type="number"
                    min={0}
                    step={50}
                    value={draft.dailyLossCap}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        dailyLossCap: Number(event.target.value),
                      }))
                    }
                    leading="$"
                  />
                </Field>
              </div>
              <Field label="Max live open positions">
                <Input
                  type="number"
                  min={0}
                  max={50}
                  value={draft.maxOpenPositions}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      maxOpenPositions: Number(event.target.value),
                    }))
                  }
                />
              </Field>
              <div className="flex items-start justify-between gap-4 border-t border-line pt-4">
                <div>
                  <p className="text-[11px] font-medium text-ink">Clamp leverage</p>
                  <p className="mt-0.5 text-[9.5px] leading-[1.4] text-muted">
                    Limit leverage to each symbol&apos;s exchange maximum.
                  </p>
                </div>
                <Switch
                  checked={draft.clampLeverage}
                  onChange={(value) =>
                    setDraft((current) => ({ ...current, clampLeverage: value }))
                  }
                  label="Clamp leverage"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" onClick={saveGuardrails}>
                  Save guardrails
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraft(liveGuardrails)}
                >
                  Reset
                </Button>
              </div>
            </div>
          </Card>

          <Card>
            <SectionHead
              title="Safety checklist"
              subtitle="Before arming live execution"
            />
            <div className="space-y-2.5 px-5 pb-5 pt-5 sm:px-6">
              {[
                "API key has Futures trading enabled",
                "Withdrawal permission is disabled",
                "Daily loss cap and margin cap are set",
                "Kill switch is reachable from every screen",
              ].map((item) => (
                <div key={item} className="flex items-start gap-2.5 text-[10.5px] leading-[1.5] text-muted">
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-pos-soft text-pos">
                    <Check size={9} strokeWidth={2.6} aria-hidden="true" />
                  </span>
                  {item}
                </div>
              ))}
              <div className="mt-4 flex items-start gap-2.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
                <LockKeyhole size={13} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                <p className="text-[9.5px] leading-[1.5] text-muted">
                  This preview stores only a masked key in memory. Nothing is sent to an exchange.
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <SectionHead title="Routing" subtitle="Execution quality gate" />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <div className="space-y-2.5">
                <DataRow label="Route mode" value="Auto, best executable" />
                <DataRow label="Simulator" value="Order-book + latency" />
                <DataRow label="Max 1-way cost" value="18 bps" />
                <DataRow label="Leverage clamp" value={liveGuardrails.clampLeverage ? "Enabled" : "Off"} />
              </div>
              <Link
                to="/strategy"
                className="mt-4 inline-flex items-center gap-1 border-t border-line pt-3 text-[10.5px] font-medium text-accent hover:text-accent-strong"
              >
                Open execution settings
                <ArrowUpRight size={12} strokeWidth={2} aria-hidden="true" />
              </Link>
            </div>
          </Card>

          <div className="flex items-center gap-2 rounded-[12px] border border-line bg-surface px-4 py-3">
            <Wallet size={14} className="text-muted" aria-hidden="true" />
            <p className="text-[10px] leading-[1.4] text-muted">
              Live orders remain simulated in this UI preview.
            </p>
            {mode === "live" ? (
              <button
                type="button"
                className="ml-auto shrink-0 text-[9.5px] font-medium text-neg"
                onClick={() =>
                  requestConfirm({
                    title: "Close all live positions?",
                    description: "Stop the engine and close every open position at the current mark.",
                    confirmLabel: "Close all",
                    tone: "danger",
                    onConfirm: closeAll,
                  })
                }
              >
                Close all
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
