"use client";

import React, { useState } from "react";
import { ModalShell } from "./ModalShell";
import { Lock } from "lucide-react";

export interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (token: string) => void;
}

export function AuthModal({ isOpen, onClose, onSuccess }: AuthModalProps) {
  const [token, setToken] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanToken = token.trim();
    if (!cleanToken) return;

    setVerifying(true);
    setError(null);
    try {
      const res = await fetch("/api/bootstrap", {
        headers: { authorization: `Bearer ${cleanToken}` },
      });
      if (res.status === 401) {
        setError("Invalid ADMIN_SECRET Bearer token.");
        return;
      }
      if (!res.ok) {
        setError(`Authentication error: HTTP ${res.status}`);
        return;
      }
      try {
        localStorage.setItem("oi_edge_token", cleanToken);
        sessionStorage.setItem("oi_admin_secret", cleanToken);
      } catch {
        // ignore
      }
      onSuccess(cleanToken);
      onClose();
    } catch (err: any) {
      setError(err.message || "Failed to reach backend edge.");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div id="authModal">
      <ModalShell
        isOpen={isOpen}
        onClose={onClose}
        title="Admin Secret Authentication"
        subtitle="Edge runtime requires authorization to access trading controls and exchange vault."
        maxWidth="max-w-[440px]"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex items-start gap-2.5 p-3 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-300 text-xs font-sans">
            <Lock size={16} className="shrink-0 mt-0.5 text-sky-400" />
            <span>
              Enter your configured <code className="font-mono text-slate-100">ADMIN_SECRET</code> to interact with the Koyeb runtime and exchange adapters.
            </span>
          </div>

          <div>
            <label className="block text-xs font-mono text-slate-400 mb-1">ADMIN SECRET TOKEN</label>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Enter token..."
              autoFocus
              className="w-full px-3 py-2 text-xs font-mono bg-[#070a0f] border border-[#192434] rounded text-slate-100 focus:outline-none focus:border-sky-500"
            />
          </div>

          {error && (
            <div className="p-2.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs font-mono">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#192434]">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs font-mono text-slate-400 hover:text-slate-200"
            >
              Cancel (Sample Mode)
            </button>
            <button
              type="submit"
              disabled={!token.trim() || verifying}
              className="px-4 py-1.5 text-xs font-mono font-semibold rounded bg-sky-500 hover:bg-sky-400 text-slate-950 disabled:opacity-40"
            >
              {verifying ? "Verifying..." : "Authenticate"}
            </button>
          </div>
        </form>
      </ModalShell>
    </div>
  );
}

export default AuthModal;
