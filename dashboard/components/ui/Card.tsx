import React, { ReactNode } from "react";

export interface CardProps {
  children: ReactNode;
  tone?: "surface" | "elevated" | "canvas";
  className?: string;
}

export function Card({ children, tone = "surface", className = "" }: CardProps) {
  const toneClasses = {
    surface: "bg-[#0c1119] border-[#192434]",
    elevated: "bg-[#111823] border-[#223247]",
    canvas: "bg-[#070a0f] border-[#192434]",
  }[tone];

  return (
    <section className={`border rounded-lg ${toneClasses} ${className}`}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
  className = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 px-4 py-3 border-b border-[#192434] ${className}`}>
      <div className="min-w-0">
        <h2 className="text-xs font-mono font-semibold text-slate-200 tracking-wider uppercase">
          {title}
        </h2>
        {subtitle && (
          <p className="mt-0.5 text-[11px] font-mono text-slate-400">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function CardContent({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`p-4 ${className}`}>{children}</div>;
}

export function KpiCard({
  id,
  label,
  value,
  sub,
  isHero = false,
  valueTone = "default",
  className = "",
}: {
  id?: string;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  isHero?: boolean;
  valueTone?: "default" | "pos" | "neg" | "warn" | "accent";
  className?: string;
}) {
  const toneColor = {
    default: isHero ? "text-white" : "text-slate-100",
    pos: "text-emerald-400",
    neg: "text-rose-400",
    warn: "text-amber-400",
    accent: "text-sky-400",
  }[valueTone];

  return (
    <div
      className={`p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col justify-between ${className}`}
    >
      <div className="kpi-head">
        <span className="kpi-label text-[10px] font-mono uppercase tracking-wider text-slate-400 font-bold">
          {label}
        </span>
      </div>
      <div
        id={id ? `${id}Value` : undefined}
        className={`kpi-value ${isHero ? "hero-val text-[23px]" : "text-[20px]"} font-mono font-bold tracking-tight tabular-nums my-1 leading-tight ${toneColor}`}
      >
        {value}
      </div>
      {sub && (
        <div
          id={id ? `${id}Sub` : undefined}
          className="kpi-sub text-[11px] font-mono text-slate-400 tabular-nums w-full break-words leading-tight"
        >
          {sub}
        </div>
      )}
    </div>
  );
}

export default Card;
