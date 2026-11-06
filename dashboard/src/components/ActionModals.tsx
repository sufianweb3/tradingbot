import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AlertTriangle,
  Check,
  KeyRound,
  LockKeyhole,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../store/AppStore";
import { cn, usd } from "../lib/format";
import { Button, Field, Input, Pill, Switch } from "./ui";

function Backdrop({
  children,
  onClose,
  label,
}: {
  children: React.ReactNode;
  onClose: () => void;
  label: string;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      className="fixed inset-0 z-[110] flex items-center justify-center overflow-y-auto px-4 py-8"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
    >
      <button
        type="button"
        aria-label={`Close ${label}`}
        className="fixed inset-0 cursor-default bg-[var(--scrim)] backdrop-blur-[3px]"
        onClick={onClose}
      />
      {children}
    </motion.div>
  );
}

const modalMotion = {
  initial: { opacity: 0, y: 12, scale: 0.985 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 8, scale: 0.99 },
  transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] as const },
};

export function ModalShell({
  children,
  onClose,
  label,
  width = "max-w-[560px]",
}: {
  children: React.ReactNode;
  onClose: () => void;
  label: string;
  width?: string;
}) {
  return (
    <Backdrop onClose={onClose} label={label}>
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        {...modalMotion}
        className={cn(
          "relative my-auto w-full overflow-hidden rounded-[20px] border border-line bg-surface shadow-float",
          width,
        )}
      >
        {children}
      </motion.div>
    </Backdrop>
  );
}

/* Confirmation ------------------------------------------------------------ */

export function ConfirmDialog() {
  const { confirmRequest, resolveConfirm, reduceMotion } = useApp();
  const danger = confirmRequest?.tone !== "primary";

  return (
    <AnimatePresence>
      {confirmRequest ? (
        <Backdrop onClose={() => resolveConfirm(false)} label={confirmRequest.title}>
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-label={confirmRequest.title}
            initial={reduceMotion ? false : modalMotion.initial}
            animate={modalMotion.animate}
            exit={reduceMotion ? { opacity: 0 } : modalMotion.exit}
            transition={modalMotion.transition}
            className="relative w-full max-w-[440px] overflow-hidden rounded-[20px] border border-line bg-surface shadow-float"
          >
            <div className="flex items-start gap-3 px-5 pt-5 sm:px-6">
              <span
                className={cn(
                  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                  danger ? "bg-neg-soft text-neg" : "bg-accent-soft text-accent",
                )}
              >
                {danger ? (
                  <AlertTriangle size={17} strokeWidth={1.9} aria-hidden="true" />
                ) : (
                  <ShieldCheck size={17} strokeWidth={1.9} aria-hidden="true" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold tracking-[-0.015em] text-ink">
                  {confirmRequest.title}
                </h2>
                <p className="mt-1.5 text-[11.5px] leading-[1.55] text-muted">
                  {confirmRequest.description}
                </p>
              </div>
              <button
                type="button"
                onClick={() => resolveConfirm(false)}
                aria-label="Close dialog"
                className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-faint hover:bg-surface-2 hover:text-ink"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <div className="mt-5 flex justify-end gap-2 border-t border-line px-5 py-4 sm:px-6">
              <Button variant="ghost" size="sm" onClick={() => resolveConfirm(false)}>
                Cancel
              </Button>
              <Button
                variant={danger ? "dangerSolid" : "primary"}
                size="sm"
                onClick={() => resolveConfirm(true)}
              >
                {confirmRequest.confirmLabel}
              </Button>
            </div>
          </motion.div>
        </Backdrop>
      ) : null}
    </AnimatePresence>
  );
}

/* Live confirmation ------------------------------------------------------- */

export function LiveConfirmModal() {
  const {
    liveConfirmOpen,
    closeLiveConfirm,
    activateLive,
    activeExchange,
    liveGuardrails,
    mode,
    setMode,
    openExchangeWizard,
    reduceMotion,
  } = useApp();
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (liveConfirmOpen) setAcknowledged(false);
  }, [liveConfirmOpen]);

  const ready = Boolean(
    activeExchange?.connected && activeExchange?.liveSupported && acknowledged,
  );

  return (
    <AnimatePresence>
      {liveConfirmOpen ? (
        <Backdrop onClose={closeLiveConfirm} label="Live trading confirmation">
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-label="Live trading confirmation"
            initial={reduceMotion ? false : modalMotion.initial}
            animate={modalMotion.animate}
            exit={reduceMotion ? { opacity: 0 } : modalMotion.exit}
            transition={modalMotion.transition}
            className="relative w-full max-w-[500px] overflow-hidden rounded-[20px] border border-line bg-surface shadow-float"
          >
            <div className="flex items-start gap-3 border-b border-line px-5 py-5 sm:px-6">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-neg-soft text-neg">
                <ShieldAlert size={19} strokeWidth={1.9} aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-ink">
                  {mode === "live" ? "Live execution is armed" : "Switch to live trading?"}
                </h2>
                <p className="mt-1 text-[11.5px] leading-[1.5] text-muted">
                  {mode === "live"
                    ? "Orders are routed to the exchange. Return to paper when you are done."
                    : "This changes execution from simulated fills to exchange orders."}
                </p>
              </div>
              <button
                type="button"
                onClick={closeLiveConfirm}
                aria-label="Close dialog"
                className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-faint hover:bg-surface-2 hover:text-ink"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>

            <div className="px-5 py-5 sm:px-6">
              <div className="rounded-[12px] border border-line bg-surface-2 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[10.5px] text-muted">Execution exchange</span>
                  <span className="flex items-center gap-2 text-[11.5px] font-medium text-ink">
                    {activeExchange?.name ?? "None"}
                    <Pill tone={activeExchange?.connected ? "pos" : "neg"} className="h-5 px-2 text-[9px]">
                      {activeExchange?.connected ? "Connected" : "Not connected"}
                    </Pill>
                  </span>
                </div>
                <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-line pt-2.5">
                  {[
                    {
                      label: "Max margin",
                      value:
                        liveGuardrails.marginPerTrade > 0
                          ? usd(liveGuardrails.marginPerTrade, 0)
                          : "Strategy sizing",
                    },
                    {
                      label: "Daily loss cap",
                      value:
                        liveGuardrails.dailyLossCap > 0
                          ? usd(liveGuardrails.dailyLossCap, 0)
                          : "Disabled",
                    },
                    {
                      label: "Max live positions",
                      value:
                        liveGuardrails.maxOpenPositions > 0
                          ? String(liveGuardrails.maxOpenPositions)
                          : "No cap",
                    },
                    {
                      label: "Leverage clamp",
                      value: liveGuardrails.clampLeverage ? "Enabled" : "Off",
                    },
                  ].map((item) => (
                    <div key={item.label}>
                      <p className="text-[9.5px] text-faint">{item.label}</p>
                      <p className="mt-0.5 text-[10.5px] font-medium text-ink">{item.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-4 flex items-start gap-2.5 rounded-[10px] border border-warn/30 bg-warn-soft px-3 py-2.5">
                <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warn" aria-hidden="true" />
                <p className="text-[10px] leading-[1.5] text-warn">
                  This is a UI preview. No real orders are submitted. In the connected bot,
                  this arms the live executor and routes orders to {activeExchange?.name ?? "the exchange"}.
                </p>
              </div>

              {!activeExchange?.connected || !activeExchange?.liveSupported ? (
                <div className="mt-4 rounded-[10px] border border-line bg-surface-2 px-3 py-3">
                  <p className="text-[11px] font-medium text-ink">No live exchange connected</p>
                  <p className="mt-0.5 text-[10px] leading-[1.5] text-muted">
                    Connect a futures API key before arming live execution.
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    onClick={() => {
                      closeLiveConfirm();
                      openExchangeWizard("bybit");
                    }}
                  >
                    Connect exchange
                  </Button>
                </div>
              ) : null}

              <button
                type="button"
                role="checkbox"
                aria-checked={acknowledged}
                onClick={() => setAcknowledged((value) => !value)}
                className="mt-4 flex w-full items-start gap-2.5 rounded-[10px] border border-line px-3 py-3 text-left transition-colors duration-150 hover:bg-surface-2"
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border",
                    acknowledged
                      ? "border-accent bg-accent text-[var(--on-accent)]"
                      : "border-line-strong bg-surface",
                  )}
                >
                  {acknowledged ? <Check size={11} strokeWidth={3} aria-hidden="true" /> : null}
                </span>
                <span className="text-[10.5px] leading-[1.5] text-muted">
                  I understand these guardrails and want to arm live execution. The kill
                  switch remains available at all times.
                </span>
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-4 sm:px-6">
              <Button variant="ghost" size="sm" onClick={closeLiveConfirm}>
                Cancel
              </Button>
              {mode === "live" ? (
                <Button variant="secondary" size="sm" onClick={() => { setMode("paper"); closeLiveConfirm(); }}>
                  Return to paper
                </Button>
              ) : (
                <Button
                  variant="dangerSolid"
                  size="sm"
                  disabled={!ready}
                  onClick={activateLive}
                  icon={<ShieldAlert size={13} strokeWidth={2} aria-hidden="true" />}
                >
                  Activate live trading
                </Button>
              )}
            </div>
          </motion.div>
        </Backdrop>
      ) : null}
    </AnimatePresence>
  );
}

/* Exchange key wizard ----------------------------------------------------- */

const venueInstructions: Record<string, string> = {
  binance:
    "Create an API key on Binance with Enable Futures checked. Leave Enable Withdrawals unchecked.",
  bybit:
    "Create a Bybit key with Contract Orders and Positions enabled. Leave Withdrawals unchecked. IP-bound keys are recommended.",
  gate:
    "Create a Gate.io key with Futures trading enabled. Do not enable Withdraw or Wallet write permissions.",
  kucoin:
    "Create a KuCoin Futures key with Futures Trading enabled. Enter the API passphrase below.",
  mexc:
    "MEXC futures order APIs are unavailable. Connect for read-only data or use paper mode.",
};

export function ExchangeWizard() {
  const {
    exchangeWizardVenue,
    closeExchangeWizard,
    exchanges,
    connectExchange,
    testExchange,
    activeExchange,
    reduceMotion,
    notify,
    dataSource,
  } = useApp();
  const venue = exchanges.find((item) => item.id === exchangeWizardVenue);
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [testnet, setTestnet] = useState(true);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testedBalance, setTestedBalance] = useState(0);

  useEffect(() => {
    if (!exchangeWizardVenue) return;
    setApiKey("");
    setSecret("");
    setPassphrase("");
    setTestnet(true);
    setTesting(false);
    setTested(false);
    setSaving(false);
    setTestedBalance(0);
  }, [exchangeWizardVenue]);

  const requiresPassphrase = exchangeWizardVenue === "kucoin";
  const canSubmit =
    apiKey.trim().length > 6 &&
    secret.trim().length > 6 &&
    (!requiresPassphrase || passphrase.trim().length > 2);

  const runTest = async () => {
    if (!venue || !canSubmit) {
      notify("Missing credentials", "Enter the API key, secret and passphrase first.", undefined, "danger");
      return;
    }
    setTesting(true);
    setTested(false);
    const result = await testExchange({
      venue: venue.id,
      apiKey: apiKey.trim(),
      secret: secret.trim(),
      passphrase: passphrase.trim() || undefined,
    });
    setTesting(false);
    if (!result.ok) {
      notify("Connection test failed", result.error, undefined, "danger");
      return;
    }
    setTested(true);
    setTestedBalance(result.balance ?? 0);
  };

  const save = async () => {
    if (!venue || !canSubmit) {
      notify("Missing credentials", "Enter the API key and secret first.", undefined, "danger");
      return;
    }
    setSaving(true);
    const ok = await connectExchange({
      venue: venue.id,
      apiKey: apiKey.trim(),
      secret: secret.trim(),
      passphrase: passphrase.trim() || undefined,
      testnet,
    });
    setSaving(false);
    if (!ok) {
      // The store already reported the failure. Keep the wizard open.
      return;
    }
  };

  return (
    <AnimatePresence>
      {venue ? (
        <Backdrop onClose={closeExchangeWizard} label={`Connect ${venue.name}`}>
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label={`Connect ${venue.name}`}
            initial={reduceMotion ? false : modalMotion.initial}
            animate={modalMotion.animate}
            exit={reduceMotion ? { opacity: 0 } : modalMotion.exit}
            transition={modalMotion.transition}
            className="relative w-full max-w-[540px] overflow-hidden rounded-[20px] border border-line bg-surface shadow-float"
          >
            <div className="flex items-start gap-3 border-b border-line px-5 py-5 sm:px-6">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[11px] bg-accent-soft text-[14px] font-semibold text-accent">
                {venue.shortName}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[16px] font-semibold tracking-[-0.02em] text-ink">
                  Connect {venue.name}
                </h2>
                <p className="mt-1 text-[11px] leading-[1.5] text-muted">{venue.tier}</p>
              </div>
              <Pill tone={venue.connected ? "pos" : "neutral"} className="shrink-0">
                {venue.connected ? "Connected" : "New connection"}
              </Pill>
              <button
                type="button"
                onClick={closeExchangeWizard}
                aria-label="Close dialog"
                className="-mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-faint hover:bg-surface-2 hover:text-ink"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>

            <div className="px-5 py-5 sm:px-6">
              <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
                <LockKeyhole size={14} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
                <div>
                  <p className="text-[10.5px] font-medium text-ink">Trade-only permissions</p>
                  <p className="mt-0.5 text-[10px] leading-[1.5] text-muted">
                    {venueInstructions[venue.id] ?? "Use a trade-only API key. Never enable withdrawals."}
                  </p>
                </div>
              </div>

              <div className="mt-4 space-y-3.5">
                <Field label="API key">
                  <Input
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="Paste API key"
                    autoComplete="off"
                    leading={<KeyRound size={12} strokeWidth={1.9} aria-hidden="true" />}
                  />
                </Field>
                <Field label="Secret key">
                  <Input
                    type="password"
                    value={secret}
                    onChange={(event) => setSecret(event.target.value)}
                    placeholder="Paste secret"
                    autoComplete="off"
                    leading={<LockKeyhole size={12} strokeWidth={1.9} aria-hidden="true" />}
                  />
                </Field>
                {requiresPassphrase ? (
                  <Field label="API passphrase">
                    <Input
                      type="password"
                      value={passphrase}
                      onChange={(event) => setPassphrase(event.target.value)}
                      placeholder="KuCoin passphrase"
                      autoComplete="off"
                      leading={<LockKeyhole size={12} strokeWidth={1.9} aria-hidden="true" />}
                    />
                  </Field>
                ) : null}
                {dataSource === "live" ? (
                  <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
                    <ShieldCheck size={14} className="mt-0.5 shrink-0 text-pos" aria-hidden="true" />
                    <div>
                      <p className="text-[10.5px] font-medium text-ink">Validated by the bot</p>
                      <p className="mt-0.5 text-[10px] leading-[1.5] text-muted">
                        The key is tested against the venue and stored in the bot vault. Withdrawals
                        must be disabled on the exchange before saving.
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-4 rounded-[10px] border border-line px-3 py-2.5">
                    <div>
                      <p className="text-[11px] font-medium text-ink">Use testnet</p>
                      <p className="mt-0.5 text-[9.5px] text-muted">Recommended for the first connection.</p>
                    </div>
                    <Switch checked={testnet} onChange={setTestnet} label="Use testnet" />
                  </div>
                )}
              </div>

              {tested ? (
                <div className="mt-4 rounded-[10px] border border-pos/25 bg-pos-soft px-3 py-2.5">
                  <p className="flex items-center gap-1.5 text-[10.5px] font-semibold text-pos">
                    <Check size={12} strokeWidth={2.6} aria-hidden="true" />
                    Verification passed
                  </p>
                  <p className="mt-1 text-[10px] leading-[1.5] text-muted">
                    Trading permissions enabled, withdrawals disabled. Available balance{" "}
                    <span className="num font-medium text-ink">{usd(testedBalance)}</span>.
                  </p>
                </div>
              ) : null}

              <p className="mt-4 flex items-start gap-2 text-[9.5px] leading-[1.5] text-faint">
                <ShieldCheck size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                {dataSource === "live"
                  ? "Credentials are sent only to the bot API on this origin. They are stored in its local vault, never committed to the repository and never exposed back to the browser."
                  : "Sample mode. Keys stay in this browser session, are not committed and are never sent to an exchange."}
              </p>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-4 sm:px-6">
              <Button variant="ghost" size="sm" onClick={closeExchangeWizard}>
                Cancel
              </Button>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={runTest}
                  disabled={!canSubmit || testing || saving}
                >
                  {testing ? "Testing…" : "Test connection"}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={save}
                  disabled={!canSubmit || saving}
                  icon={<ShieldCheck size={13} strokeWidth={2} aria-hidden="true" />}
                >
                  {saving ? "Connecting…" : "Save & connect"}
                </Button>
              </div>
            </div>
          </motion.div>
        </Backdrop>
      ) : null}
    </AnimatePresence>
  );
}

/* Quick guide ------------------------------------------------------------- */

export function QuickGuideModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    mode,
    setMode,
    openLiveConfirm,
    exchanges,
    activeExchange,
    reduceMotion,
  } = useApp();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (open) setStep(0);
  }, [open]);

  const steps = [
    {
      title: "Start with paper",
      body: "The engine opens and manages simulated positions. Use the scanner to inspect signals and the strategy page to tune filters.",
      action: (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-3">
            {["Balanced", "Aggressive", "Conservative"].map((preset) => (
              <div key={preset} className="rounded-[10px] border border-line bg-surface-2 px-3 py-2.5">
                <p className="text-[11px] font-medium text-ink">{preset}</p>
                <p className="mt-0.5 text-[9px] text-muted">
                  {preset === "Balanced"
                    ? "50× · 20% stop"
                    : preset === "Aggressive"
                      ? "75× · 15% stop"
                      : "20× · 25% stop"}
                </p>
              </div>
            ))}
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onClose();
              navigate("/strategy");
            }}
          >
            Open strategy
          </Button>
        </div>
      ),
    },
    {
      title: "Connect an execution venue",
      body: "Use a trade-only API key with withdrawals disabled. The active exchange is used for routing and live execution.",
      action: (
        <div className="space-y-3">
          <div className="rounded-[10px] border border-line bg-surface-2 p-3">
            <p className="text-[10.5px] text-muted">Active exchange</p>
            <p className="mt-1 text-[12px] font-medium text-ink">
              {activeExchange?.name ?? "None"}
              <span className="ml-2 text-[10px] font-normal text-muted">
                {activeExchange?.connected ? "Connected" : "Not connected"}
              </span>
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onClose();
              navigate("/exchanges");
            }}
          >
            Open exchange vault
          </Button>
        </div>
      ),
    },
    {
      title: "Arm live mode deliberately",
      body: "Live mode routes orders to the exchange. Keep the kill switch and guardrails close at hand.",
      action:
        mode === "live" ? (
          <Button variant="secondary" size="sm" onClick={() => setMode("paper")}>
            Return to paper
          </Button>
        ) : (
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              onClose();
              openLiveConfirm();
            }}
          >
            Review live mode
          </Button>
        ),
    },
  ];

  const current = steps[step];
  const connected = exchanges.filter((exchange) => exchange.connected).length;

  return (
    <AnimatePresence>
      {open ? (
        <Backdrop onClose={onClose} label="Quick guide">
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Quick guide"
            initial={reduceMotion ? false : modalMotion.initial}
            animate={modalMotion.animate}
            exit={reduceMotion ? { opacity: 0 } : modalMotion.exit}
            transition={modalMotion.transition}
            className="relative w-full max-w-[500px] overflow-hidden rounded-[20px] border border-line bg-surface shadow-float"
          >
            <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-5 sm:px-6">
              <div>
                <p className="text-[10px] font-medium text-muted">Quick guide</p>
                <h2 className="mt-1 text-[16px] font-semibold tracking-[-0.02em] text-ink">
                  {current.title}
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close dialog"
                className="-mr-1 flex h-7 w-7 items-center justify-center rounded-full text-faint hover:bg-surface-2 hover:text-ink"
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <div className="px-5 py-5 sm:px-6">
              <p className="text-[11.5px] leading-[1.6] text-muted">{current.body}</p>
              <div className="mt-4">{current.action}</div>
              <div className="mt-5 flex items-center gap-2">
                {steps.map((item, index) => (
                  <button
                    key={item.title}
                    type="button"
                    aria-label={`Step ${index + 1}`}
                    onClick={() => setStep(index)}
                    className={cn(
                      "h-1.5 rounded-full transition-[width,background-color] duration-150",
                      index === step ? "w-6 bg-accent" : "w-1.5 bg-surface-3",
                    )}
                  />
                ))}
                <span className="ml-auto text-[9.5px] text-faint">
                  {connected} exchange{connected === 1 ? "" : "s"} connected
                </span>
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-line px-5 py-4 sm:px-6">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={step === 0}
                  onClick={() => setStep((value) => Math.max(0, value - 1))}
                >
                  Back
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() =>
                    step === steps.length - 1 ? onClose() : setStep((value) => value + 1)
                  }
                >
                  {step === steps.length - 1 ? "Done" : "Next"}
                </Button>
              </div>
            </div>
          </motion.div>
        </Backdrop>
      ) : null}
    </AnimatePresence>
  );
}
