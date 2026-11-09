"use client";

import React, { useState } from "react";
import { ModalShell } from "./ModalShell";
import { ShieldAlert, CheckCircle2, Eye, EyeOff } from "lucide-react";

export interface ExchangeCardItem {
  id: "binance" | "bybit" | "gate" | "kucoin" | "mexc" | string;
  name: string;
  tier?: string;
  connected: boolean;
  isActive: boolean;
  maskedKey?: string;
  liveSupported?: boolean;
}

export interface ExchangeModalProps {
  isOpen: boolean;
  onClose: () => void;
  exchanges: ExchangeCardItem[];
  onSelectActive: (venue: string) => void;
  onConnect: (venue: string, creds: { apiKey: string; secret: string; passphrase?: string }) => Promise<boolean>;
  onDisconnect: (venue: string) => void;
}

export function ExchangeModal({
  isOpen,
  onClose,
  exchanges,
  onSelectActive,
  onConnect,
  onDisconnect,
}: ExchangeModalProps) {
  const [selectedVenue, setSelectedVenue] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; balance?: number; error?: string } | null>(null);

  const handleTestConnection = async () => {
    if (!selectedVenue || !apiKey || !secret) return;
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/exchange/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ venue: selectedVenue, apiKey, secret, passphrase: passphrase || undefined }),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        setTestResult({ ok: false, error: data.error || "Connection test failed." });
      } else {
        setTestResult({ ok: true, balance: data.balance?.availableUsdt || 0 });
      }
    } catch (err: any) {
      setTestResult({ ok: false, error: err.message || "Network error." });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!selectedVenue || !apiKey || !secret) return;
    const ok = await onConnect(selectedVenue, { apiKey, secret, passphrase: passphrase || undefined });
    if (ok) {
      setSelectedVenue(null);
      setApiKey("");
      setSecret("");
      setPassphrase("");
      setTestResult(null);
    }
  };

  return (
    <div id="exchangeModal">
      <ModalShell
        isOpen={isOpen}
        onClose={onClose}
        title="Exchange Connect & Key Vault"
        subtitle="WebCrypto credential vault · stored encrypted in browser memory · keys never leave Worker memory"
        maxWidth="max-w-[640px]"
      >
        {/* Strict Withdrawal Permission Security Barrier */}
        <div className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-300">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="text-xs leading-relaxed font-sans">
            <strong className="font-semibold text-amber-200">Crucial Security Invariant:</strong> Do NOT enable
            Withdrawal permissions when creating exchange API keys. Keys with withdrawal permissions are
            automatically rejected by the vault for your security.
          </div>
        </div>

        {/* 5-Exchange Cards Grid */}
        <div className="exchange-grid mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {exchanges.map((ex) => (
            <div
              key={ex.id}
              className={`exchange-card p-3 rounded-lg border transition-all ${
                ex.isActive
                  ? "bg-[#0c1626] border-sky-500/50 shadow-[0_0_12px_rgba(56,189,248,0.15)]"
                  : "bg-[#070a0f] border-[#192434]"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-semibold text-slate-100">{ex.name}</span>
                <span
                  className={`px-1.5 py-0.5 text-[9px] font-mono rounded ${
                    ex.connected
                      ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                      : "bg-slate-800 text-slate-400"
                  }`}
                >
                  {ex.connected ? "CONNECTED" : "NOT CONNECTED"}
                </span>
              </div>

              <div className="mt-1.5 flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span>{ex.tier || "Perpetuals"}</span>
                {ex.connected && ex.maskedKey && (
                  <span className="text-slate-300 font-mono">{ex.maskedKey}</span>
                )}
              </div>

              <div className="mt-3 pt-2 border-t border-[#192434]/50 flex items-center justify-between gap-2">
                {ex.isActive ? (
                  <span className="exchange-active-badge text-[10px] font-mono text-sky-400 font-semibold flex items-center gap-1">
                    <CheckCircle2 size={12} /> ACTIVE VENUE
                  </span>
                ) : ex.liveSupported !== false ? (
                  <button
                    type="button"
                    onClick={() => onSelectActive(ex.id)}
                    className="btn-select-exchange px-2 py-1 text-[10px] font-mono rounded bg-slate-800 hover:bg-slate-700 text-slate-300"
                  >
                    Set Active
                  </button>
                ) : (
                  <span className="text-[10px] font-mono text-slate-500">Paper Only</span>
                )}

                {ex.connected ? (
                  <button
                    type="button"
                    onClick={() => onDisconnect(ex.id)}
                    className="px-2 py-1 text-[10px] font-mono rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/20"
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedVenue(ex.id);
                      setTestResult(null);
                    }}
                    className="px-2.5 py-1 text-[10px] font-mono font-medium rounded bg-sky-500 hover:bg-sky-400 text-slate-950 font-semibold"
                  >
                    Connect
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Guided Wizard Box */}
        {selectedVenue && (
          <div id="wizardBox" className="mt-4 p-4 rounded-xl border border-sky-500/30 bg-[#070a0f] space-y-3">
            <div className="flex items-center justify-between border-b border-[#192434] pb-2">
              <span className="font-mono text-xs font-semibold text-sky-300 uppercase">
                Connect {selectedVenue.toUpperCase()}
              </span>
              <button
                type="button"
                onClick={() => setSelectedVenue(null)}
                className="text-xs font-mono text-slate-400 hover:text-slate-200"
              >
                Cancel
              </button>
            </div>

            <div className="space-y-2">
              <div>
                <label className="block text-[10px] font-mono text-slate-400 mb-1">API KEY</label>
                <input
                  type="text"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Paste API Key..."
                  className="w-full px-3 py-1.5 text-xs font-mono bg-[#0c1119] border border-[#192434] rounded text-slate-100 focus:outline-none focus:border-sky-500"
                />
              </div>
              <div>
                <label className="block text-[10px] font-mono text-slate-400 mb-1">API SECRET</label>
                <div className="relative">
                  <input
                    type={showSecret ? "text" : "password"}
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="Paste API Secret..."
                    className="w-full px-3 py-1.5 pr-8 text-xs font-mono bg-[#0c1119] border border-[#192434] rounded text-slate-100 focus:outline-none focus:border-sky-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowSecret(!showSecret)}
                    className="absolute right-2 top-2 text-slate-400 hover:text-slate-200"
                  >
                    {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>
              {selectedVenue === "kucoin" && (
                <div>
                  <label className="block text-[10px] font-mono text-slate-400 mb-1">PASSPHRASE</label>
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    placeholder="KuCoin API Passphrase..."
                    className="w-full px-3 py-1.5 text-xs font-mono bg-[#0c1119] border border-[#192434] rounded text-slate-100 focus:outline-none focus:border-sky-500"
                  />
                </div>
              )}
            </div>

            {/* Test Feedback */}
            {testResult && (
              <div
                className={`p-2.5 rounded text-xs font-mono ${
                  testResult.ok
                    ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
                    : "bg-rose-500/10 text-rose-300 border border-rose-500/20"
                }`}
              >
                {testResult.ok ? (
                  <div>
                    <div className="font-semibold">✓ Verification Passed</div>
                    <div className="text-[11px] text-slate-300 mt-0.5">
                      Trading enabled · Withdrawals disabled (Safe) · Balance: ${testResult.balance?.toFixed(2)} USDT
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="font-semibold">✕ Connection Failed</div>
                    <div className="text-[11px] text-rose-200 mt-0.5">{testResult.error}</div>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                disabled={!apiKey || !secret || testing}
                onClick={handleTestConnection}
                className="px-3 py-1.5 text-xs font-mono rounded bg-slate-800 hover:bg-slate-700 text-slate-200 disabled:opacity-50"
              >
                {testing ? "Testing..." : "Test Connection"}
              </button>
              <button
                type="button"
                disabled={!apiKey || !secret}
                onClick={handleSave}
                className="px-3.5 py-1.5 text-xs font-mono font-semibold rounded bg-emerald-500 hover:bg-emerald-400 text-slate-950 disabled:opacity-50"
              >
                Save & Connect
              </button>
            </div>
          </div>
        )}
      </ModalShell>
    </div>
  );
}

export default ExchangeModal;
