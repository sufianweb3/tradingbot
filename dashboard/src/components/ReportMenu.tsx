import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Download, FileJson, FileText, Table2 } from "lucide-react";
import { useApp } from "../store/AppStore";
import { downloadFile } from "../lib/download";
import { buildHtmlReport, buildJsonReport, buildTradesCsv } from "../lib/report";
import { Button } from "./ui";

export function ReportMenu({ compact = false }: { compact?: boolean }) {
  const {
    equity,
    series,
    stats,
    positions,
    trades,
    drawdown,
    mode,
    activeExchange,
    notify,
    initialFund,
  } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const payload = {
    equity,
    startFund: initialFund,
    stats,
    positions,
    trades,
    series,
    mode,
    exchange: activeExchange?.name ?? "None",
    drawdown,
  };

  const download = (format: "html" | "csv" | "json") => {
    const date = new Date().toISOString().slice(0, 10);
    if (format === "html") {
      downloadFile(`oi-sniper-report-${date}.html`, buildHtmlReport(payload), "text/html;charset=utf-8");
      notify("HTML report downloaded", "A self-contained report with the equity chart and trade history.", undefined, "success");
    } else if (format === "csv") {
      downloadFile(`oi-sniper-trades-${date}.csv`, buildTradesCsv(trades), "text/csv;charset=utf-8");
      notify("CSV downloaded", `${trades.length} closed trades exported.`, undefined, "success");
    } else {
      downloadFile(`oi-sniper-report-${date}.json`, buildJsonReport(payload), "application/json");
      notify("JSON snapshot downloaded", "Account summary, positions and trade history exported.", undefined, "success");
    }
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative">
      <Button
        variant="secondary"
        size={compact ? "sm" : "md"}
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        icon={<Download size={14} strokeWidth={1.9} aria-hidden="true" />}
      >
        {compact ? "Report" : "Export report"}
        <ChevronDown
          size={12}
          strokeWidth={2}
          className={open ? "rotate-180 transition-transform duration-150" : "transition-transform duration-150"}
          aria-hidden="true"
        />
      </Button>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -3, scale: 0.99 }}
            transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="absolute right-0 top-[38px] z-40 w-[220px] overflow-hidden rounded-[12px] border border-line bg-surface p-1.5 shadow-float"
            role="menu"
            aria-label="Export report"
          >
            {[
              {
                format: "html" as const,
                icon: FileText,
                label: "HTML report",
                hint: "Self-contained",
              },
              {
                format: "csv" as const,
                icon: Table2,
                label: "Trade CSV",
                hint: `${trades.length} rows`,
              },
              {
                format: "json" as const,
                icon: FileJson,
                label: "JSON snapshot",
                hint: "Full state",
              },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.format}
                  type="button"
                  role="menuitem"
                  onClick={() => download(item.format)}
                  className="flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors duration-150 hover:bg-surface-2"
                >
                  <Icon size={14} strokeWidth={1.8} className="text-muted" aria-hidden="true" />
                  <span className="flex-1 text-[11.5px] text-ink-2">{item.label}</span>
                  <span className="text-[9px] text-faint">{item.hint}</span>
                </button>
              );
            })}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
