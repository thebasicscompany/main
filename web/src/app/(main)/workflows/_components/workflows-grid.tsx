"use client";

import Link from "next/link";

import { CalendarClock, ChevronRight, KeyRound, Pause, Play } from "@/icons";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkflows } from "@/hooks/queries/use-workflows";
import { credentialLabel, formatCron, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { WorkflowSummary } from "@/types/runs";

import { StatusPill } from "../../runs/_components/status-pill";

export function WorkflowsGrid() {
  const { data, isLoading } = useWorkflows();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-44" />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground text-sm">
        No workflows yet. Define one in <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">api/seeds/templates/</code>.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {data.map((wf) => (
        <WorkflowCard key={wf.id} workflow={wf} />
      ))}
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: WorkflowSummary }) {
  const successPct = workflow.successRate == null ? null : Math.round(workflow.successRate * 100);
  const successTone =
    successPct == null
      ? "text-muted-foreground"
      : successPct >= 95
        ? "text-emerald-600"
        : successPct >= 80
          ? "text-amber-600"
          : "text-red-600";

  return (
    <Link
      href={`/workflows/${workflow.id}`}
      prefetch={false}
      className={cn(
        "group flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40",
        !workflow.enabled && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold text-base">{workflow.name}</h3>
            {workflow.enabled ? (
              <Badge variant="default" className="h-auto min-h-5 shrink-0 gap-1 py-0.5">
                <Play data-icon="inline-start" />
                Active
              </Badge>
            ) : (
              <Badge variant="secondary" className="h-auto min-h-5 shrink-0 gap-1 py-0.5">
                <Pause data-icon="inline-start" />
                Paused
              </Badge>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-muted-foreground text-sm">{workflow.prompt}</p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
      </div>

      <div className="grid grid-cols-3 gap-2 border-t pt-3 text-sm">
        <Metric
          label="Success"
          value={successPct == null ? "—" : `${successPct}%`}
          valueClass={successTone}
        />
        <Metric label="Runs · 7d" value={workflow.runsLast7d.toString()} />
        <Metric
          label="Last run"
          value={workflow.lastRun ? formatRelative(workflow.lastRun.startedAt) : "—"}
        >
          {workflow.lastRun && <StatusPill status={workflow.lastRun.status} />}
        </Metric>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
        <span className="inline-flex items-center gap-1">
          <CalendarClock className="size-3.5" />
          {formatCron(workflow.schedule)}
        </span>
        <span className="inline-flex items-center gap-1">
          <KeyRound className="size-3.5" />
          {workflow.requiredCredentials.map(credentialLabel).join(", ")}
        </span>
      </div>
    </Link>
  );
}

function Metric({
  label,
  value,
  valueClass,
  children,
}: {
  label: string;
  value: string;
  valueClass?: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-muted-foreground text-xs uppercase tracking-wide">{label}</div>
      <div className="flex items-center gap-2">
        <span className={cn("font-semibold tabular-nums text-sm", valueClass)}>{value}</span>
        {children}
      </div>
    </div>
  );
}
