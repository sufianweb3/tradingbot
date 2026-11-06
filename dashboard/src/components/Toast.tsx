import { AnimatePresence, motion } from "motion/react";
import { AlertTriangle, Check, Info, X, XCircle } from "lucide-react";
import { cn } from "../lib/format";
import { useApp } from "../store/AppStore";

const toneIcon = {
  success: { Icon: Check, className: "text-[var(--engine-pos)]" },
  danger: { Icon: XCircle, className: "text-[var(--toast-danger)]" },
  warn: { Icon: AlertTriangle, className: "text-[var(--toast-warn)]" },
  info: { Icon: Info, className: "text-[var(--toast-info)]" },
} as const;

export function Toast() {
  const { toast, dismissToast, reduceMotion } = useApp();
  const tone = toast?.tone ?? "success";
  const { Icon, className: iconClass } = toneIcon[tone];

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[120] flex justify-center px-4">
      <AnimatePresence>
        {toast ? (
          <motion.div
            key={toast.id}
            role="status"
            aria-live="polite"
            initial={reduceMotion ? false : { opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", bounce: 0.18, duration: 0.45 }}
            className="pointer-events-auto flex w-full max-w-[440px] items-start gap-3 rounded-[16px] border border-[var(--engine-line)] bg-engine px-4 py-3.5 shadow-float"
          >
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--engine-line)]">
              <Icon size={13} strokeWidth={2.3} className={iconClass} aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[12.5px] font-medium leading-[1.35] text-engine-ink">
                {toast.title}
              </p>
              {toast.description ? (
                <p className="mt-0.5 text-[11px] leading-[1.45] text-engine-muted">
                  {toast.description}
                </p>
              ) : null}
            </div>
            {toast.action ? (
              <button
                type="button"
                onClick={toast.action.onClick}
                className="h-7 shrink-0 rounded-full border border-[var(--engine-line)] px-3 text-[10.5px] font-semibold text-[var(--engine-pos)] transition-colors duration-150 hover:bg-[var(--engine-line)]"
              >
                {toast.action.label}
              </button>
            ) : null}
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={dismissToast}
              className="-mr-1 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-engine-muted transition-colors duration-150 hover:bg-[var(--engine-line)] hover:text-engine-ink"
            >
              <X size={13} strokeWidth={2} aria-hidden="true" />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
