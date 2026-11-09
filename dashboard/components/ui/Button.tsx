import React, { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dangerSolid" | "dark";
export type ButtonSize = "sm" | "md" | "icon" | "icon-sm";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  primary:
    "bg-sky-500 text-slate-950 font-semibold hover:bg-sky-400 focus-visible:ring-2 focus-visible:ring-sky-400 disabled:bg-slate-800 disabled:text-slate-500",
  secondary:
    "bg-[#111823] text-slate-200 border border-[#192434] hover:bg-[#16202e] hover:border-slate-700 focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-40",
  ghost:
    "bg-transparent text-slate-400 hover:bg-[#111823] hover:text-slate-200 focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-40",
  danger:
    "bg-transparent text-rose-400 border border-rose-500/30 hover:bg-rose-500/10 focus-visible:ring-2 focus-visible:ring-rose-400 disabled:opacity-40",
  dangerSolid:
    "bg-rose-600 text-white font-semibold hover:bg-rose-500 focus-visible:ring-2 focus-visible:ring-rose-400 disabled:opacity-40 shadow-sm",
  dark:
    "bg-[#080d14] text-slate-300 border border-[#192434] hover:bg-[#0c1119] focus-visible:ring-2 focus-visible:ring-slate-500 disabled:opacity-40",
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[11px] gap-1.5 rounded",
  md: "h-8 px-3 text-xs gap-2 rounded-md",
  icon: "h-8 w-8 rounded-md p-0 flex items-center justify-center",
  "icon-sm": "h-7 w-7 rounded p-0 flex items-center justify-center",
};

export function Button({
  variant = "secondary",
  size = "md",
  isLoading = false,
  disabled = false,
  icon,
  className = "",
  children,
  type = "button",
  ...props
}: ButtonProps) {
  const isActuallyDisabled = disabled || isLoading;

  return (
    <button
      type={type}
      disabled={isActuallyDisabled}
      aria-busy={isLoading}
      className={`btn inline-flex shrink-0 items-center justify-center font-mono font-medium transition-colors duration-150 cursor-pointer disabled:cursor-not-allowed select-none ${variantStyles[variant]} ${sizeStyles[size]} ${isLoading ? "is-loading pointer-events-none opacity-80" : ""} ${className}`}
      {...props}
    >
      {!isLoading && icon && <span className="shrink-0">{icon}</span>}
      {children}
    </button>
  );
}

export default Button;
