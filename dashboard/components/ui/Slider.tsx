"use client";

import React, { ChangeEvent } from "react";

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
  className?: string;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = "",
  disabled = false,
  onChange,
  className = "",
}: SliderProps) {
  const percentage = Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    onChange(Number(e.target.value));
  };

  return (
    <div className={`flex flex-col gap-1.5 font-mono ${className}`}>
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400 font-medium">{label}</span>
        <span className="text-slate-100 font-semibold tabular-nums">
          {value}{unit}
        </span>
      </div>

      <div className="relative flex items-center h-5 w-full">
        {/* Visual Track */}
        <div className="absolute inset-x-0 h-1.5 rounded-full bg-[#192434] overflow-hidden">
          <div
            className="h-full bg-sky-500 rounded-full transition-all duration-75"
            style={{ width: `${percentage}%` }}
          />
        </div>

        {/* Real Range Input */}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={handleChange}
          aria-label={label}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed z-10"
        />

        {/* Visual Thumb Marker */}
        <div
          className="pointer-events-none absolute w-3.5 h-3.5 rounded-full bg-white border-2 border-sky-500 shadow -translate-x-1/2"
          style={{ left: `${percentage}%` }}
        />
      </div>

      <div className="flex justify-between text-[10px] text-slate-500 tabular-nums">
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  );
}

export default Slider;
