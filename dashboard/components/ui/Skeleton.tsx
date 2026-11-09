import React from "react";

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`skeleton-shimmer rounded ${className}`}
    />
  );
}

export function SkeletonLine({
  size = "md",
  width = "w-full",
  className = "",
}: {
  size?: "sm" | "md" | "lg";
  width?: "w-20" | "w-32" | "w-48" | "w-full" | string;
  className?: string;
}) {
  const heightClass = {
    sm: "h-2.5",
    md: "h-3.5",
    lg: "h-5",
  }[size];

  return (
    <div
      aria-hidden="true"
      className={`skeleton-shimmer rounded ${heightClass} ${width} ${className}`}
    />
  );
}

export function SkeletonPill({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`skeleton-shimmer rounded h-5 w-16 ${className}`}
    />
  );
}

export function SkeletonCard({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`p-3 bg-[#0c1119] border border-[#192434] rounded-lg flex flex-col gap-2 ${className}`}
    >
      <div className="flex items-center justify-between">
        <SkeletonLine size="sm" width="w-20" />
        <SkeletonPill />
      </div>
      <SkeletonLine size="lg" width="w-32" />
      <SkeletonLine size="sm" width="w-40" />
    </div>
  );
}

export function SkeletonTableRow({
  columns = 12,
  className = "",
}: {
  columns?: number;
  className?: string;
}) {
  return (
    <tr className={`border-b border-[#192434]/40 ${className}`} aria-hidden="true">
      <td className="p-2.5">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded-full skeleton-shimmer shrink-0" />
          <div className="flex flex-col gap-1 w-20">
            <SkeletonLine size="sm" width="w-16" />
            <SkeletonLine size="sm" width="w-10" />
          </div>
        </div>
      </td>
      {Array.from({ length: columns - 1 }).map((_, i) => (
        <td key={i} className="p-2.5 text-right">
          <SkeletonLine size="sm" width="w-12 ml-auto" />
        </td>
      ))}
    </tr>
  );
}

export default Skeleton;
