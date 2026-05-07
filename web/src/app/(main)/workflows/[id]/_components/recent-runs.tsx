"use client";

import Link from "next/link";

import { Skeleton } from "@/components/ui/skeleton";
import { useRuns } from "@/hooks/queries/use-runs";
import { formatDuration, formatRelative } from "@/lib/format";

import { StatusPill } from "../../../runs/_components/status-pill";

export function RecentRuns({ workflowId }: { workflowId: string }) {
  const { data, isLoading } = useRuns({ workflowId });

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-12" />
        ))}
      </div>
    );
  }

  const sorted = (data ?? [])
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 12);

  if (sorted.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">No runs yet for this workflow.</p>
    );
  }

  return (
    <ul className="divide-y rounded-lg border bg-card">
      {sorted.map((run) => (
        <li key={run.id}>
          <Link
            href={`/runs/${run.id}`}
            prefetch={false}
            className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
          >
            <div className="flex items-center gap-3">
              <StatusPill status={run.status} />
              <span className="font-mono text-muted-foreground text-xs">{run.id}</span>
            </div>
            <div className="flex items-center gap-4 text-muted-foreground text-xs">
              <span className="tabular-nums">{run.stepCount} steps</span>
              <span>{formatDuration(run.startedAt, run.completedAt)}</span>
              <span>{formatRelative(run.startedAt)}</span>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
