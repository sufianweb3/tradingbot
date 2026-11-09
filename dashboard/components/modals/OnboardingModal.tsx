"use client";

import React, { useState } from "react";
import { ModalShell } from "./ModalShell";
import { Shield, Zap, Sparkles } from "lucide-react";

export type OnboardingStep = "PRESET_SELECTION" | "MODE_SELECTION" | "EXCHANGE_SETUP";

export interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectPreset: (preset: "conservative" | "balanced" | "aggressive") => void;
  onOpenExchangeModal: () => void;
}

export function OnboardingModal({
  isOpen,
  onClose,
  onSelectPreset,
  onOpenExchangeModal,
}: OnboardingModalProps) {
  const [stepIndex, setStepIndex] = useState<number>(0);
  const steps: OnboardingStep[] = ["PRESET_SELECTION", "MODE_SELECTION", "EXCHANGE_SETUP"];

  const currentStep = steps[stepIndex];

  const handleFinish = () => {
    try {
      localStorage.setItem("oi_sniper_onboarded_v1", "true");
    } catch {
      // ignore
    }
    onClose();
  };

  return (
    <div id="onboardingModal">
      <ModalShell
        isOpen={isOpen}
        onClose={handleFinish}
        title="Welcome to OI Sniper"
        subtitle={`Step ${stepIndex + 1} of 3: ${
          currentStep === "PRESET_SELECTION"
            ? "Strategy Baseline"
            : currentStep === "MODE_SELECTION"
            ? "Execution Mode"
            : "Exchange Setup"
        }`}
        maxWidth="max-w-[540px]"
      >
        {/* Step 1: PRESET_SELECTION */}
        {currentStep === "PRESET_SELECTION" && (
          <div className="space-y-3">
            <p className="text-xs text-slate-400 font-sans leading-relaxed">
              Select a quantitative risk baseline. Presets configure leverage, stop loss, and Open Interest entry filters.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
              {[
                {
                  id: "conservative",
                  name: "Conservative",
                  lev: "20x",
                  sl: "25% SL",
                  tp: "50% TP1",
                  icon: Shield,
                },
                {
                  id: "balanced",
                  name: "Balanced",
                  lev: "50x",
                  sl: "20% SL",
                  tp: "40% TP1",
                  icon: Sparkles,
                  recommended: true,
                },
                {
                  id: "aggressive",
                  name: "Aggressive",
                  lev: "75x",
                  sl: "15% SL",
                  tp: "35% TP1",
                  icon: Zap,
                },
              ].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    onSelectPreset(p.id as any);
                    setStepIndex(1);
                  }}
                  className={`p-3 rounded-lg border text-left transition-all ${
                    p.recommended
                      ? "bg-sky-500/10 border-sky-500/40 hover:border-sky-500"
                      : "bg-[#070a0f] border-[#192434] hover:border-slate-600"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-xs font-semibold text-slate-100">{p.name}</span>
                    {p.recommended && (
                      <span className="text-[9px] font-mono text-sky-400 bg-sky-500/20 px-1 py-0.2 rounded">
                        BEST
                      </span>
                    )}
                  </div>
                  <div className="mt-2 text-[11px] font-mono text-slate-400 space-y-0.5">
                    <div>{p.lev} Leverage</div>
                    <div>{p.sl}</div>
                    <div>{p.tp}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 2: MODE_SELECTION */}
        {currentStep === "MODE_SELECTION" && (
          <div className="space-y-3">
            <p className="text-xs text-slate-400 font-sans leading-relaxed">
              Choose your initial operating mode. We strongly recommend testing new strategies in Paper Trading mode first.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
              <div className="p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/40">
                <span className="font-mono text-xs font-semibold text-emerald-400 uppercase">
                  Paper Trading (Default)
                </span>
                <p className="mt-1 text-xs text-slate-300 font-sans leading-relaxed">
                  Simulated execution with realistic slippage and order-book depth walks. Zero capital risk.
                </p>
              </div>
              <div className="p-4 rounded-lg bg-[#070a0f] border border-[#192434]">
                <span className="font-mono text-xs font-semibold text-slate-300 uppercase">
                  Live Trading
                </span>
                <p className="mt-1 text-xs text-slate-400 font-sans leading-relaxed">
                  Connect your API keys in Step 3 and arm live execution with exchange guardrails.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Step 3: EXCHANGE_SETUP */}
        {currentStep === "EXCHANGE_SETUP" && (
          <div className="space-y-3">
            <p className="text-xs text-slate-400 font-sans leading-relaxed">
              Connect an exchange key vault or jump right into Paper trading simulation.
            </p>
            <div className="p-4 rounded-lg bg-[#070a0f] border border-[#192434] space-y-2">
              <span className="font-mono text-xs font-semibold text-slate-200">
                Supported Venues: Binance, Bybit, Gate.io, KuCoin, MEXC
              </span>
              <p className="text-xs text-slate-400">
                Keys are stored in your browser session with WebCrypto encryption. Withdrawals must remain disabled.
              </p>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => {
                    handleFinish();
                    onOpenExchangeModal();
                  }}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-mono font-semibold bg-sky-500 hover:bg-sky-400 text-slate-950"
                >
                  Connect Exchange Keys
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Stepper Footer */}
        <div className="mt-5 pt-3 border-t border-[#192434] flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {steps.map((s, idx) => (
              <span
                key={s}
                className={`h-1.5 rounded-full transition-all ${
                  idx === stepIndex ? "w-6 bg-sky-400" : "w-2 bg-slate-700"
                }`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={() => setStepIndex(stepIndex - 1)}
                className="px-3 py-1.5 text-xs font-mono text-slate-400 hover:text-slate-200"
              >
                Back
              </button>
            )}
            {stepIndex < steps.length - 1 ? (
              <button
                type="button"
                onClick={() => setStepIndex(stepIndex + 1)}
                className="px-3.5 py-1.5 rounded text-xs font-mono font-medium bg-slate-800 hover:bg-slate-700 text-slate-200"
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                onClick={handleFinish}
                className="px-4 py-1.5 rounded text-xs font-mono font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950"
              >
                Get Started
              </button>
            )}
          </div>
        </div>
      </ModalShell>
    </div>
  );
}

export default OnboardingModal;
