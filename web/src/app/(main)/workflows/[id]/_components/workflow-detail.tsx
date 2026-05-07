"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";

import { CalendarClock, ChevronRight, FileCheck2, KeyRound, Lock, Pause, Play } from "@/icons";

import { Badge } from "@/components/ui/badge";
import { OrbitRing } from "@/components/ui/orbit-ring";
import { useWorkflow } from "@/hooks/queries/use-workflows";
import { credentialLabel, formatCron, formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

import { StatusPill } from "../../../runs/_components/status-pill";
import { RecentRuns } from "./recent-runs";

export function WorkflowDetail({ id }: { id: string }) {
  const router = useRouter();
  const { data, isLoading } = useWorkflow(id);

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
        <OrbitRing className="mr-2" />
        Loading workflow…
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <h2 className="font-semibold text-lg">Workflow not found</h2>
        <button type="button" className="text-primary text-sm hover:underline" onClick={() => router.push("/workflows")}>
          ← Back to workflows
        </button>
      </div>
    );
  }

  const { workflow } = data;
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
    <div className="space-y-6">
      <header className="space-y-3">
        <nav className="flex items-center gap-1 text-muted-foreground text-sm">
          <Link href="/workflows" prefetch={false} className="hover:text-foreground">
            Workflows
          </Link>
          <ChevronRight className="size-3.5" />
          <span className="truncate text-foreground">{workflow.name}</span>
        </nav>

        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate font-semibold text-2xl tracking-tight">{workflow.name}</h1>
              {workflow.enabled ? (
                <Badge variant="default" className="h-auto min-h-5 gap-1 py-0.5">
                  <Play data-icon="inline-start" />
                  Active
                </Badge>
              ) : (
                <Badge variant="secondary" className="h-auto min-h-5 gap-1 py-0.5">
                  <Pause data-icon="inline-start" />
                  Paused
                </Badge>
              )}
              <Badge variant="outline" className="h-auto min-h-5 gap-1 py-0.5">
                <Lock data-icon="inline-start" />
                Read-only
              </Badge>
            </div>
            <p className="font-mono text-muted-foreground text-xs">{workflow.id}</p>
          </div>
        </div>

        <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2 rounded-lg border bg-card px-4 py-3 text-sm">
          <Stat label="Schedule" value={formatCron(workflow.schedule)} />
          <Stat
            label="Success · 7d"
            value={successPct == null ? "—" : `${successPct}%`}
            valueClass={successTone}
          />
          <Stat label="Runs · 7d" value={workflow.runsLast7d.toString()} />
          {workflow.lastRun && (
            <div className="flex items-baseline gap-2">
              <dt className="text-muted-foreground text-xs uppercase tracking-wide">Last run</dt>
              <dd className="flex items-center gap-2">
                <StatusPill status={workflow.lastRun.status} />
                <Link
                  href={`/runs/${workflow.lastRun.id}`}
                  className="text-sm hover:underline underline-offset-2"
                  prefetch={false}
                >
                  {formatRelative(workflow.lastRun.startedAt)}
                </Link>
              </dd>
            </div>
          )}
        </dl>
      </header>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="space-y-3">
          <h2 className="font-semibold text-sm tracking-tight">Prompt</h2>
          <div className="whitespace-pre-wrap rounded-lg border bg-card p-4 text-sm leading-relaxed">
            {workflow.prompt}
          </div>

          <h2 className="pt-2 font-semibold text-sm tracking-tight">Recent runs</h2>
          <RecentRuns workflowId={workflow.id} />
        </section>

        <aside className="space-y-4">
          <ConfigBlock
            icon={<KeyRound className="size-4" />}
            title="Credentials"
            description="OAuth grants required for this workflow to run."
          >
            <div className="flex flex-wrap gap-1.5">
              {workflow.requiredCredentials.length === 0 ? (
                <span className="text-muted-foreground text-sm">None required.</span>
              ) : (
                workflow.requiredCredentials.map((c) => (
                  <Badge key={c} variant="secondary" className="h-auto min-h-5 py-0.5 font-medium">
                    {credentialLabel(c)}
                  </Badge>
                ))
              )}
            </div>
          </ConfigBlock>

          <ConfigBlock
            icon={<FileCheck2 className="size-4" />}
            title="Verification checks"
            description="Run after each completion. Pass = run is verified."
          >
            <div className="flex flex-wrap gap-1.5">
              {workflow.checkModules.length === 0 ? (
                <span className="text-muted-foreground text-sm">No checks.</span>
              ) : (
                workflow.checkModules.map((m) => (
                  <Badge key={m} variant="outline" className="h-auto min-h-5 py-0.5 font-mono text-[11px] font-normal">
                    {m}
                  </Badge>
                ))
              )}
            </div>
          </ConfigBlock>

          <ConfigBlock
            icon={<CalendarClock className="size-4" />}
            title="Schedule"
            description={workflow.schedule ? "Cron expression in workspace timezone." : "Triggered on demand only."}
          >
            <div className="space-y-1">
              <div className="text-sm">{formatCron(workflow.schedule)}</div>
              {workflow.schedule && (
                <code className="font-mono text-muted-foreground text-xs">{workflow.schedule}</code>
              )}
            </div>
          </ConfigBlock>
        </aside>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-muted-foreground text-xs uppercase tracking-wide">{label}</dt>
      <dd className={cn("font-medium tabular-nums", valueClass)}>{value}</dd>
    </div>
  );
}

function ConfigBlock({
  icon,
  title,
  description,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border bg-card p-4">
      <header className="mb-3 flex items-start gap-2">
        <span className="mt-0.5 text-muted-foreground">{icon}</span>
        <div className="flex-1">
          <h3 className="font-semibold text-sm">{title}</h3>
          <p className="text-muted-foreground text-xs">{description}</p>
        </div>
      </header>
      {children}
    </section>
  );
}
