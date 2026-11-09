"use client";

import React, { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";

export interface ModalShellProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  maxWidth?: string;
  badge?: React.ReactNode;
}

export function Backdrop({
  children,
  onClose,
  label,
}: {
  children: React.ReactNode;
  onClose: () => void;
  label: string;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <motion.div
      className="fixed inset-0 z-[120] flex items-center justify-center overflow-y-auto p-4 sm:p-6"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.16 }}
    >
      <button
        type="button"
        aria-label={`Close ${label}`}
        className="fixed inset-0 cursor-default bg-[#070a0f]/80 backdrop-blur-sm"
        onClick={onClose}
      />
      {children}
    </motion.div>
  );
}

export function ModalShell({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  maxWidth = "max-w-[580px]",
  badge,
}: ModalShellProps) {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  return (
    <AnimatePresence>
      {isOpen && (
        <Backdrop onClose={onClose} label={title}>
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="modal-title"
            initial={{ opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className={`relative my-auto w-full overflow-hidden rounded-xl border border-[#192434] bg-[#0c1119] shadow-2xl ${maxWidth}`}
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-4 border-b border-[#192434] px-5 py-4 sm:px-6">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2
                    id="modal-title"
                    className="font-mono text-base font-semibold tracking-tight text-slate-100"
                  >
                    {title}
                  </h2>
                  {badge}
                </div>
                {subtitle && (
                  <p className="mt-0.5 text-xs text-slate-400 font-mono">{subtitle}</p>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close dialog"
                className="-mr-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 hover:bg-[#192434] hover:text-slate-100 transition-colors"
              >
                <X size={16} aria-hidden="true" />
              </button>
            </div>

            {/* Content */}
            <div className="max-h-[75vh] overflow-y-auto px-5 py-4 sm:px-6 font-sans">
              {children}
            </div>
          </motion.div>
        </Backdrop>
      )}
    </AnimatePresence>
  );
}

export default ModalShell;
