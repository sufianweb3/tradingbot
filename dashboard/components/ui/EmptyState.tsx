import React from "react";

interface StateProps {
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ title, description, action, className = "" }: StateProps) {
  return (
    <div className={`p-8 text-center text-xs text-slate-500 ${className}`}>
      <b className="text-slate-400 font-semibold block mb-1">{title}</b>
      {description && <span>{description}</span>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-3 px-3 py-1 rounded border border-[#192434] text-slate-300 hover:text-slate-100 hover:border-sky-500/40"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}

export function ErrorState({ title, description, action, className = "" }: StateProps) {
  return (
    <div
      role="alert"
      className={`p-8 text-center text-xs border border-rose-500/30 bg-rose-500/5 rounded-lg ${className}`}
    >
      <b className="text-rose-300 font-semibold block mb-1">{title}</b>
      {description && <span className="text-slate-400 break-words">{description}</span>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-3 px-3 py-1 rounded border border-rose-400/40 text-rose-200 hover:bg-rose-500/20"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
