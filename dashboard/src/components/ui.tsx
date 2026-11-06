import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/format";
import { useApp } from "../store/AppStore";

/* Button ------------------------------------------------------------------ */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dangerSolid" | "dark";
type ButtonSize = "sm" | "md" | "icon" | "icon-sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

const buttonVariants: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-[var(--on-accent)] hover:bg-accent-strong shadow-button rounded-full disabled:bg-surface-3 disabled:text-[var(--faint)] disabled:shadow-none",
  secondary:
    "bg-surface text-ink border border-line-strong hover:bg-surface-2 rounded-[10px]",
  ghost:
    "bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink rounded-[10px]",
  danger:
    "bg-transparent text-neg border border-line hover:bg-neg-soft rounded-[10px]",
  dangerSolid:
    "bg-neg text-[var(--on-accent)] hover:opacity-90 shadow-button rounded-full disabled:bg-surface-3 disabled:text-[var(--faint)] disabled:shadow-none",
  dark: "bg-engine-2 text-engine-ink border border-engine-line hover:bg-[var(--engine-line)] rounded-full",
};

const buttonSizes: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-[12px] gap-1.5",
  md: "h-9 px-4 text-[12.5px] gap-2",
  icon: "h-9 w-9 rounded-[10px]",
  "icon-sm": "h-7 w-7 rounded-lg",
};

export function Button({
  variant = "secondary",
  size = "md",
  icon,
  className,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex shrink-0 items-center justify-center font-medium transition-colors duration-150 disabled:opacity-40",
        buttonVariants[variant],
        buttonSizes[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

/* Surfaces ---------------------------------------------------------------- */

export function Card({
  children,
  className,
  tone = "surface",
}: {
  children: ReactNode;
  className?: string;
  tone?: "surface" | "engine";
}) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-[20px] border shadow-card",
        tone === "engine"
          ? "border-transparent bg-engine text-engine-ink"
          : "border-line bg-surface",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function SectionHead({
  title,
  subtitle,
  action,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 px-5 pt-5 sm:px-6",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-[14.5px] font-semibold tracking-[-0.015em] text-ink">
          {title}
        </h2>
        {subtitle ? (
          <p className="mt-0.5 text-[12px] leading-[1.4] text-muted">{subtitle}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  badge,
}: {
  title: string;
  subtitle: ReactNode;
  actions?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <h1 className="text-[26px] font-semibold leading-[1.08] tracking-[-0.03em] text-ink sm:text-[30px]">
            {title}
          </h1>
          {badge}
        </div>
        <p className="mt-1.5 text-[12.5px] leading-[1.4] text-muted">
          {subtitle}
        </p>
      </div>
      {actions ? (
        <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">{actions}</div>
      ) : null}
    </header>
  );
}

/* Pills ------------------------------------------------------------------- */

type PillTone = "neutral" | "accent" | "pos" | "neg" | "warn" | "dark";

const pillTones: Record<PillTone, string> = {
  neutral: "bg-surface-2 text-ink-2 border border-line",
  accent: "bg-accent-soft text-accent border border-transparent",
  pos: "bg-pos-soft text-pos border border-transparent",
  neg: "bg-neg-soft text-neg border border-transparent",
  warn: "bg-warn-soft text-warn border border-transparent",
  dark: "bg-[var(--engine-line)] text-engine-ink border border-transparent",
};

export function Pill({
  tone = "neutral",
  children,
  dot = false,
  pulse = false,
  className,
}: {
  tone?: PillTone;
  children: ReactNode;
  dot?: boolean;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-[11px] font-medium leading-none",
        pillTones[tone],
        className,
      )}
    >
      {dot ? (
        <span className={cn("status-dot", pulse && "is-pulsing")} aria-hidden="true" />
      ) : null}
      {children}
    </span>
  );
}

export function SidePill({ side }: { side: "long" | "short" }) {
  return (
    <Pill tone={side === "long" ? "pos" : "neg"} className="h-[22px] px-2 text-[10.5px]">
      {side === "long" ? "Long" : "Short"}
    </Pill>
  );
}

/* Segmented control ------------------------------------------------------- */

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  ariaLabel,
}: {
  options: Array<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full border border-line bg-surface-2 p-0.5",
        className,
      )}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[11.5px] font-medium transition-colors duration-150",
              active
                ? "bg-[var(--seg-active)] text-ink shadow-[0_1px_2px_rgba(0,0,0,0.07)]"
                : "text-muted hover:text-ink",
            )}
          >
            {option.label}
            {typeof option.count === "number" ? (
              <span
                className={cn(
                  "num text-[10px]",
                  active ? "text-muted" : "text-faint",
                )}
              >
                {option.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* Switch ------------------------------------------------------------------ */

export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-200 disabled:opacity-40",
        checked ? "bg-accent" : "bg-surface-3",
      )}
    >
      <span
        className={cn(
          "block h-[18px] w-[18px] rounded-full bg-[var(--switch-knob)] shadow-[0_1px_3px_rgba(0,0,0,0.24)] transition-transform duration-200",
          checked ? "translate-x-[18px]" : "translate-x-[2px]",
        )}
      />
    </button>
  );
}

/* Form controls ----------------------------------------------------------- */

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block min-w-0", className)}>
      <span className="mb-1.5 block text-[11.5px] font-medium leading-none text-muted">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1.5 block text-[10.5px] leading-[1.4] text-faint">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export function Input({
  suffix,
  leading,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  suffix?: ReactNode;
  leading?: ReactNode;
}) {
  return (
    <span className="relative block">
      {leading ? (
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[12px] text-faint">
          {leading}
        </span>
      ) : null}
      <input
        className={cn(
          "h-9 w-full rounded-[10px] border border-line bg-surface-2 px-3 text-[12.5px] text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-faint hover:border-line-strong focus:border-accent focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)]",
          leading ? "pl-7" : undefined,
          suffix ? "pr-10" : undefined,
          className,
        )}
        {...props}
      />
      {suffix ? (
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-faint">
          {suffix}
        </span>
      ) : null}
    </span>
  );
}

export function Select({
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select
        className={cn(
          "h-9 w-full appearance-none rounded-[10px] border border-line bg-surface-2 pl-3 pr-8 text-[12.5px] text-ink outline-none transition-[border-color,box-shadow] duration-150 hover:border-line-strong focus:border-accent focus:bg-surface focus:shadow-[0_0_0_3px_var(--accent-soft)]",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        size={13}
        strokeWidth={2}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-faint"
        aria-hidden="true"
      />
    </span>
  );
}

/* Progress ---------------------------------------------------------------- */

export function Progress({
  value,
  tone = "accent",
  className,
}: {
  value: number;
  tone?: "accent" | "pos" | "neg" | "warn";
  className?: string;
}) {
  const fill = {
    accent: "bg-accent",
    pos: "bg-pos",
    neg: "bg-neg",
    warn: "bg-warn",
  }[tone];
  return (
    <span
      className={cn(
        "block h-[3px] w-full overflow-hidden rounded-full bg-surface-3",
        className,
      )}
      role="progressbar"
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span
        className={cn("block h-full rounded-full", fill)}
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </span>
  );
}

/* Misc -------------------------------------------------------------------- */

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line bg-surface px-1 text-[10px] font-medium text-faint">
      {children}
    </kbd>
  );
}

export function CoinMark({
  symbol,
  size = "md",
}: {
  symbol: string;
  size?: "sm" | "md" | "lg";
}) {
  const sizes = {
    sm: "h-7 w-7 text-[9px]",
    md: "h-8 w-8 text-[9.5px]",
    lg: "h-10 w-10 text-[11px]",
  }[size];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full border border-line bg-surface-2 font-semibold tracking-[0.02em] text-ink-2",
        sizes,
      )}
      aria-hidden="true"
    >
      {symbol}
    </span>
  );
}

export function DataRow({
  label,
  value,
  tone = "default",
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  tone?: "default" | "pos" | "neg" | "muted";
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-4", className)}>
      <span className="text-[11.5px] text-muted">{label}</span>
      <span
        className={cn(
          "num text-right text-[12px] font-medium",
          tone === "pos" && "text-pos",
          tone === "neg" && "text-neg",
          tone === "muted" && "text-muted",
          tone === "default" && "text-ink",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon ? (
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-surface-2 text-muted">
          {icon}
        </div>
      ) : null}
      <p className="text-[13.5px] font-medium text-ink">{title}</p>
      <p className="mt-1 max-w-[320px] text-[12px] leading-[1.5] text-muted">
        {description}
      </p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/* Animated numerals ------------------------------------------------------- */

export function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number;
  format: (value: number) => string;
  className?: string;
}) {
  const { reduceMotion } = useApp();
  const [display, setDisplay] = useState(value);
  const current = useRef(value);

  useEffect(() => {
    current.current = display;
  }, [display]);

  useEffect(() => {
    if (reduceMotion) {
      setDisplay(value);
      return;
    }
    const from = current.current;
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / 480);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(from + (value - from) * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, reduceMotion]);

  return <span className={cn("num", className)}>{format(display)}</span>;
}
