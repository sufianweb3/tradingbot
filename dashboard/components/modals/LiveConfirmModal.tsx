"use client";

import React, { useState } from "react";
import { ModalShell } from "./ModalShell";
import { ShieldAlert } from "lucide-react";

export interface LiveConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeExchange: string;
  marginPerTrade: number;
  dailyLossCap: number;
  onConfirmLive: () => Promise<void>;
}

export function LiveConfirmModal({
  isOpen,
  onClose,
  activeExchange,
  marginPerTrade,
  dailyLossCap,
  onConfirmLive,
}: LiveConfirmModalProps) {
  const [typedConfirmation, setTypedConfirmation] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const isConfirmed = typedConfirmation.trim() === "LIVE" || acknowledged;

  const handleActivate = async () => {
    if (!isConfirmed) return;
    setSubmitting(true);
    try {
      await onConfirmLive();
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div id="liveConfirmModal">
      <ModalShell
        isOpen={isOpen}
        onClose={onClose}
        title="Switch to LIVE Trading?"
        subtitle="Real capital orders will be routed to your connected exchange."
        maxWidth="max-w-[460px]"
      >
        <div className="flex items-start gap-3 p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300">
          <ShieldAlert size={20} className="shrink-0 text-rose-400 mt-0.5" />
          <div className="text-xs leading-relaxed font-sans">
            Live execution submits binding perpetuals orders to the exchange. Monitor margin usage and ensure stops are verified.
          </div>
        </div>

        {/* Mandatory Verification Parameters */}
        <div className="mt-4 p-3 rounded-lg bg-[#070a0f] border border-[#192434] space-y-2 text-xs font-mono">
          <div className="flex justify-between items-center py-1 border-b border-[#192434]">
            <span className="text-slate-400">Active Exchange</span>
            <span id="confirmExchangeName" className="font-semibold text-slate-100 uppercase">
              {activeExchange}
            </span>
          </div>
          <div className="flex justify-between items-center py-1 border-b border-[#192434]">
            <span className="text-slate-400">Max Margin / Trade</span>
            <span id="confirmMarginCap" className="font-semibold text-slate-100 tabular-nums">
              {marginPerTrade > 0 ? `$${marginPerTrade.toFixed(2)}` : "Strategy sizing (no cap)"}
            </span>
          </div>
          <div className="flex justify-between items-center py-1">
            <span className="text-slate-400">Daily Loss Cap</span>
            <span id="confirmLossCap" className="font-semibold text-rose-400 tabular-nums">
              {dailyLossCap > 0 ? `$${dailyLossCap.toFixed(2)} USDT` : "Disabled"}
            </span>
          </div>
        </div>

        {/* Confirmation Mechanism (Typed 'LIVE' or Checkbox) */}
        <div className="mt-4 space-y-2">
          <label className="block text-xs font-mono text-slate-300">
            Type <strong className="text-rose-400 font-semibold font-mono">LIVE</strong> to confirm activation:
          </label>
          <input
            type="text"
            value={typedConfirmation}
            onChange={(e) => setTypedConfirmation(e.target.value.toUpperCase())}
            placeholder='Type "LIVE"'
            className="w-full px-3 py-2 text-xs font-mono bg-[#070a0f] border border-[#192434] rounded text-slate-100 uppercase tracking-widest focus:outline-none focus:border-rose-500"
          />

          <label className="flex items-start gap-2 pt-1 cursor-pointer">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 rounded border-[#192434] bg-[#070a0f] text-rose-500 focus:ring-0"
            />
            <span className="text-[11px] text-slate-400 leading-normal">
              I understand live risk guardrails and intend to submit real exchange orders.
            </span>
          </label>
        </div>

        {/* Action Buttons */}
        <div className="mt-5 pt-3 border-t border-[#192434] flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-mono text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            id="btnActivateLive"
            disabled={!isConfirmed || submitting}
            onClick={handleActivate}
            className="px-4 py-2 rounded-lg text-xs font-mono font-semibold bg-rose-600 hover:bg-rose-500 text-white disabled:opacity-40 transition-colors"
          >
            {submitting ? "Activating..." : "Switch to LIVE"}
          </button>
        </div>
      </ModalShell>
    </div>
  );
}

export default LiveConfirmModal;
