"use client";

import { CheckCircle2, ShieldCheck, XCircle } from "@/icons";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunChecks } from "@/hooks/queries/use-runs";
import { findWorkflow } from "@/mocks/workflows";
import type { Run } from "@/types/runs";

const LIVE_STATUSES = new Set(["pending", "booting", "running", "paused", "paused_by_user", "verifying"]);

export function VerificationStrip({ run }: { run: Run }) {
  const { data: checks, isLoading } = useRunChecks(run.id);
  const workflow = findWorkflow(run.workflowId);
  const isLive = LIVE_STATUSES.has(run.status);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 border-t bg-muted/30 px-4 py-3">
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-7 w-32" />
      </div>
    );
  }

  if ((!checks || checks.length === 0) && workflow?.checkModules?.length) {
    return (
      <div className="flex items-center gap-2 border-t bg-muted/30 px-4 py-2.5 text-muted-foreground text-xs">
        <ShieldCheck className="size-3.5" />
        {isLive ? "Will run" : "Pending"} {workflow.checkModules.length} check
        {workflow.checkModules.length === 1 ? "" : "s"} after this run completes.
      </div>
    );
  }

  if (!checks || checks.length === 0) {
    return (
      <div className="flex items-center gap-2 border-t bg-muted/30 px-4 py-2.5 text-muted-foreground text-xs">
        <ShieldCheck className="size-3.5" />
        No checks configured for this workflow.
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t bg-muted/30 px-4 py-2.5">
      <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs uppercase tracking-wide">
        <ShieldCheck className="size-3.5" />
        Verification
      </span>
      {checks.map((c) => (
        <Badge
          key={c.name}
          title={c.message}
          variant={c.passed ? "secondary" : "destructive"}
          className="h-auto min-h-5 gap-1.5 py-1 font-normal [&>svg]:!size-3.5"
        >
          {c.passed ? <CheckCircle2 /> : <XCircle />}
          <code className="font-mono text-[11px]">{c.name}</code>
        </Badge>
      ))}
    </div>
  );
}
