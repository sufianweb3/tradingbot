"use client";

import { ErrorState } from "../components/ui";

export default function RouteError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl p-6">
      <ErrorState
        title="The workstation crashed"
        description={error.message || "Unexpected error while rendering."}
        action={{ label: "Reload workstation", onClick: reset }}
      />
    </div>
  );
}
