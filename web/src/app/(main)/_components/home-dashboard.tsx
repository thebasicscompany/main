"use client";

import Link from "next/link";
import type { ComponentType } from "react";
import { useMemo } from "react";

import { ChevronRight, Hand, Play, TriangleAlertIcon } from "@/icons";

import { PendingCard } from "@/app/(main)/approvals/_components/pending-card";
import { LiveRunCard } from "@/app/(main)/runs/_components/live-run-card";
import { StatusPill } from "@/app/(main)/runs/_components/status-pill";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApprovals } from "@/hooks/queries/use-approvals";
import { useRuns } from "@/hooks/queries/use-runs";
import { formatRelative } from "@/lib/format";
import type { Run, RunStatus } from "@/types/runs";

const LIVE_STATUSES = new Set<RunStatus>(["pending", "booting", "running", "paused", "paused_by_user", "verifying"]);

function needsAttention(run: Run): boolean {
  return run.status === "failed" || run.status === "unverified";
}

export function HomeDashboard() {
  const { data: runs, isLoading: runsLoading } = useRuns({});
  const { data: approvals, isLoading: approvalsLoading } = useApprovals({});

  const liveRuns = useMemo(
    () => (runs ?? []).filter((r) => LIVE_STATUSES.has(r.status)).slice().sort(sortByStartedDesc),
    [runs],
  );

  const pendingApprovals = useMemo(
    () => (approvals ?? []).filter((a) => a.status === "pending").slice().sort(sortByRequestedDesc),
    [approvals],
  );

  const attentionRuns = useMemo(() => {
    const rows = (runs ?? []).filter(needsAttention).slice().sort(sortByStartedDesc);
    return rows.slice(0, 6);
  }, [runs]);

  const loading = runsLoading || approvalsLoading;

  return (
    <div className="space-y-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Today</h1>
        <p className="text-muted-foreground text-sm">
          Live runs, approvals waiting on you, and anything that needs a second look — mock data for layout review.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
        ) : (
          <>
            <StatCard
              href="/runs"
              title="Live now"
              subtitle="runs in flight"
              value={liveRuns.length}
              icon={Play}
            />
            <StatCard
              href="/approvals"
              title="Awaiting you"
              subtitle="pending approvals"
              value={pendingApprovals.length}
              icon={Hand}
            />
            <StatCard
              href="/runs"
              title="Needs attention"
              subtitle="failed or check misses"
              value={attentionRuns.length}
              icon={TriangleAlertIcon}
            />
          </>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-semibold text-lg tracking-tight">Live runs</h2>
            <p className="text-muted-foreground text-sm">Pinned while status is active — same cards as Runs.</p>
          </div>
          <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground" asChild>
            <Link href="/runs" prefetch={false}>
              View all
              <ChevronRight className="size-4" />
            </Link>
          </Button>
        </div>
        {runsLoading ? (
          <div className="flex gap-4 overflow-hidden pb-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-44 min-w-[320px] shrink-0 rounded-xl" />
            ))}
          </div>
        ) : liveRuns.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center justify-center py-12 text-center">
              <p className="font-medium text-sm">Nothing running right now.</p>
              <p className="mt-1 max-w-sm text-muted-foreground text-sm">
                Scheduled workflows will show here when they boot. Kick one off from Workflows.
              </p>
              <Button className="mt-4" variant="outline" size="sm" asChild>
                <Link href="/workflows" prefetch={false}>
                  Browse workflows
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="-mx-1 flex gap-4 overflow-x-auto px-1 pb-2 md:grid md:grid-cols-2 md:overflow-visible lg:grid-cols-3">
            {liveRuns.map((run) => (
              <LiveRunCard key={run.id} run={run} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-semibold text-lg tracking-tight">Approvals</h2>
            <p className="text-muted-foreground text-sm">First responder wins — same queue as the Approvals page.</p>
          </div>
          <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground" asChild>
            <Link href="/approvals" prefetch={false}>
              Open queue
              <ChevronRight className="size-4" />
            </Link>
          </Button>
        </div>
        {approvalsLoading ? (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-52 rounded-xl" />
            ))}
          </div>
        ) : pendingApprovals.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="py-10 text-center">
              <p className="font-medium text-sm">All caught up.</p>
              <p className="mt-1 text-muted-foreground text-sm">No agents are waiting on a human.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {pendingApprovals.slice(0, 6).map((a) => (
              <PendingCard key={a.id} approval={a} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-semibold text-lg tracking-tight">Needs attention</h2>
            <p className="text-muted-foreground text-sm">
              Recent outcomes that are not clean success — dig into the run or checks.
            </p>
          </div>
          <Button variant="ghost" size="sm" className="gap-1 text-muted-foreground" asChild>
            <Link href="/runs" prefetch={false}>
              Full history
              <ChevronRight className="size-4" />
            </Link>
          </Button>
        </div>
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Last activity</TableHead>
                <TableHead className="hidden md:table-cell">Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runsLoading ? (
                Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 4 }).map((_x, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full max-w-[180px]" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : attentionRuns.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground text-sm">
                    No flagged runs in the mock set.
                  </TableCell>
                </TableRow>
              ) : (
                attentionRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <Link
                        href={`/runs/${run.id}`}
                        prefetch={false}
                        className="font-medium hover:underline underline-offset-2"
                      >
                        {run.workflowName}
                      </Link>
                      <div className="font-mono text-muted-foreground text-xs">{run.id}</div>
                    </TableCell>
                    <TableCell>
                      <StatusPill status={run.status} />
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground text-sm sm:table-cell">
                      {formatRelative(run.completedAt ?? run.startedAt)}
                    </TableCell>
                    <TableCell className="hidden max-w-[280px] truncate text-muted-foreground text-sm md:table-cell">
                      {run.errorSummary ?? "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </div>
  );
}

function StatCard({
  href,
  title,
  subtitle,
  value,
  icon: Icon,
}: {
  href: string;
  title: string;
  subtitle: string;
  value: number;
  icon: ComponentType<{ className?: string }>;
}) {
  return (
    <Link href={href} prefetch={false} className="group block">
      <Card className="h-full transition-colors hover:border-primary/35">
        <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
          <CardTitle className="font-medium text-muted-foreground text-sm">{title}</CardTitle>
          <Icon className="size-4 text-muted-foreground transition-colors group-hover:text-primary" />
        </CardHeader>
        <CardContent>
          <div className="font-semibold text-3xl tabular-nums">{value}</div>
          <CardDescription className="mt-1">{subtitle}</CardDescription>
        </CardContent>
      </Card>
    </Link>
  );
}

function sortByStartedDesc(a: Run, b: Run): number {
  return b.startedAt.localeCompare(a.startedAt);
}

function sortByRequestedDesc(a: { requestedAt: string }, b: { requestedAt: string }): number {
  return b.requestedAt.localeCompare(a.requestedAt);
}
