import { useMemo, useState } from "react";
import {
  ArrowLeftRight,
  Download,
  Radar,
  Settings2,
  ShieldAlert,
} from "lucide-react";
import type { ActivityItem, ActivityType } from "../lib/data";
import { cn, clockTime, dateTime, shortDate } from "../lib/format";
import { downloadFile } from "../lib/download";
import { useApp } from "../store/AppStore";
import {
  Button,
  Card,
  DataRow,
  EmptyState,
  PageHeader,
  Pill,
  SectionHead,
  Segmented,
} from "../components/ui";

type Filter = "all" | ActivityType;

const iconMap: Record<ActivityType, typeof Radar> = {
  trade: ArrowLeftRight,
  scan: Radar,
  risk: ShieldAlert,
  system: Settings2,
};

const toneMap: Record<ActivityType, string> = {
  trade: "bg-accent-soft text-accent",
  scan: "bg-pos-soft text-pos",
  risk: "bg-warn-soft text-warn",
  system: "bg-surface-2 text-muted",
};

const labelMap: Record<ActivityType, string> = {
  trade: "Trade",
  scan: "Scan",
  risk: "Risk",
  system: "System",
};

function dayKey(date: Date) {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return shortDate(date);
}

export default function ActivityPage() {
  const { activity, notify, running, lastScan, updatedAt, positions, clearActivity } = useApp();
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = activity.filter(
    (item) => filter === "all" || item.type === filter,
  );

  const groups = useMemo(() => {
    const map = new Map<string, ActivityItem[]>();
    for (const item of filtered) {
      const key = dayKey(item.at);
      const current = map.get(key) ?? [];
      current.push(item);
      map.set(key, current);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const downloadLogs = () => {
    const lines = activity.map((item) =>
      JSON.stringify({
        at: item.at.toISOString(),
        type: item.type,
        title: item.title,
        detail: item.detail,
      }),
    );
    downloadFile(
      `oi-sniper-activity-${new Date().toISOString().slice(0, 10)}.jsonl`,
      lines.join("\n"),
      "application/x-ndjson",
    );
    notify("Logs exported", `${activity.length} activity entries downloaded as JSONL.`);
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        title="Activity"
        subtitle="Every scan, fill, risk check and system event in the paper engine, newest first."
        actions={
          <>
            <Button
              variant="ghost"
              size="md"
              onClick={clearActivity}
              disabled={activity.length === 0}
            >
              Clear view
            </Button>
            <Button
              variant="secondary"
              size="md"
              onClick={downloadLogs}
              icon={<Download size={14} strokeWidth={1.9} aria-hidden="true" />}
            >
              Download logs
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-12 items-start gap-4 lg:gap-5">
        <Card className="col-span-12 overflow-hidden xl:col-span-8">
          <div className="flex flex-wrap items-center gap-3 px-5 pt-5 sm:px-6">
            <div className="max-w-full overflow-x-auto no-scrollbar">
              <Segmented
                options={[
                  { value: "all", label: "All", count: activity.length },
                  { value: "trade", label: "Trades", count: activity.filter((item) => item.type === "trade").length },
                  { value: "scan", label: "Scans", count: activity.filter((item) => item.type === "scan").length },
                  { value: "risk", label: "Risk", count: activity.filter((item) => item.type === "risk").length },
                  { value: "system", label: "System", count: activity.filter((item) => item.type === "system").length },
                ]}
                value={filter}
                onChange={setFilter}
                ariaLabel="Filter activity"
              />
            </div>
            <p className="ml-auto text-[10px] text-faint">Newest first</p>
          </div>

          <div className="px-5 pb-4 pt-4 sm:px-6">
            {groups.length ? (
              groups.map(([day, items]) => (
                <div key={day} className="mb-5 last:mb-0">
                  <p className="mb-2 text-[10px] font-medium text-faint">{day}</p>
                  <div className="relative">
                    <span className="absolute bottom-2 left-[15px] top-2 w-px bg-line" aria-hidden="true" />
                    {items.map((item, index) => {
                      const Icon = iconMap[item.type];
                      return (
                        <div key={item.id} className="relative flex gap-3 pb-4 last:pb-0">
                          <span
                            className={cn(
                              "relative z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line",
                              toneMap[item.type],
                            )}
                          >
                            <Icon size={13} strokeWidth={1.9} aria-hidden="true" />
                          </span>
                          <div className="min-w-0 flex-1 rounded-[10px] px-2 py-1 transition-colors duration-150 hover:bg-surface-2">
                            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                              <p className="text-[12px] font-medium text-ink">{item.title}</p>
                              <span className="num text-[9.5px] text-faint">{clockTime(item.at)}</span>
                            </div>
                            <p className="mt-0.5 text-[10.5px] leading-[1.5] text-muted">{item.detail}</p>
                            <div className="mt-1 flex items-center gap-2">
                              <Pill tone="neutral" className="h-5 px-1.5 text-[9px]">
                                {labelMap[item.type]}
                              </Pill>
                              {index === 0 && day === "Today" ? (
                                <span className="text-[9px] text-faint">Most recent</span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))
            ) : (
              <EmptyState
                icon={<Settings2 size={17} aria-hidden="true" />}
                title="Nothing in this view"
                description="No events match the selected filter yet. Try another category."
                action={
                  <Button variant="secondary" size="sm" onClick={() => setFilter("all")}>
                    Show all activity
                  </Button>
                }
              />
            )}
          </div>
        </Card>

        <div className="col-span-12 grid gap-4 sm:grid-cols-2 xl:col-span-4 xl:sticky xl:top-[80px] xl:grid-cols-1 lg:gap-5">
          <Card>
            <SectionHead title="Feed status" subtitle="CoinGlass browser feed" />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <div className="flex items-center justify-between">
                <Pill tone={running ? "pos" : "warn"} dot pulse={running}>
                  {running ? "Connected" : "Paused"}
                </Pill>
                <span className="num text-[10px] text-faint">190 ms data age</span>
              </div>
              <div className="mt-4 space-y-2.5 border-t border-line pt-4">
                <DataRow label="Last scan" value={clockTime(lastScan)} />
                <DataRow label="Last update" value={clockTime(updatedAt)} />
                <DataRow label="Universe" value="412 coins" />
                <DataRow label="Open positions" value={String(positions.length)} />
                <DataRow label="Venues available" value="5 of 5" />
              </div>
              <p className="mt-4 text-[10px] leading-[1.5] text-faint">
                The preview tab keeps the device feed warm while it is visible.
                Hidden tabs refresh less often.
              </p>
            </div>
          </Card>

          <Card>
            <SectionHead title="Log retention" subtitle="Local to this paper run" />
            <div className="px-5 pb-5 pt-5 sm:px-6">
              <p className="text-[11px] leading-[1.6] text-muted">
                Activity is kept in memory for the current preview session.
                Download a copy as JSONL before reloading if you want to keep it.
              </p>
              <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
                <span className="text-[10px] text-faint">{activity.length} entries</span>
                <Button variant="secondary" size="sm" onClick={downloadLogs} className="h-8">
                  Download
                </Button>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <p className="px-1 text-[10px] leading-[1.5] text-faint">
        Latest entry {dateTime(activity[0]?.at ?? new Date())}. Events are simulated
        in this preview.
      </p>
    </div>
  );
}
