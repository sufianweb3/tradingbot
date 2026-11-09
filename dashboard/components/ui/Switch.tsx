"use client";

import React from "react";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  tone?: "accent" | "pos";
  className?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
  tone = "pos",
  className = "",
}: SwitchProps) {
  const activeBg = tone === "pos" ? "bg-emerald-500" : "bg-sky-500";

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors duration-200 cursor-pointer disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#070a0f] ${checked ? activeBg : "bg-[#192434]"} ${className}`}
    >
      <span
        className={`block h-[18px] w-[18px] rounded-full bg-slate-100 shadow-sm transition-transform duration-200 pointer-events-none ${checked ? "translate-x-[18px]" : "translate-x-[2px]"}`}
      />
    </button>
  );
}

export default Switch;
