"use client";

import { useMemo, useState } from "react";

import Link from "next/link";

import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowUpDown, Search } from "@/icons";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useRuns } from "@/hooks/queries/use-runs";
import { mockWorkflows } from "@/mocks/workflows";
import type { Run, RunStatus } from "@/types/runs";

import { LiveRunCard } from "./live-run-card";
import { RUN_STATUS_OPTIONS, StatusPill } from "./status-pill";

const LIVE_STATUSES = new Set<RunStatus>(["pending", "booting", "running", "paused", "paused_by_user", "verifying"]);

export function RunsTable() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<RunStatus | "all">("all");
  const [workflowId, setWorkflowId] = useState<string>("all");
  const [sorting, setSorting] = useState<SortingState>([{ id: "startedAt", desc: true }]);

  const { data, isLoading } = useRuns({
    status,
    workflowId: workflowId === "all" ? undefined : workflowId,
    search: search.trim() || undefined,
  });

  const liveRuns = useMemo(() => (data ?? []).filter((r) => LIVE_STATUSES.has(r.status)), [data]);
  const historyRuns = useMemo(() => (data ?? []).filter((r) => !LIVE_STATUSES.has(r.status)), [data]);

  const columns = useMemo<ColumnDef<Run>[]>(
    () => [
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => <StatusPill status={row.original.status} />,
      },
      {
        accessorKey: "workflowName",
        header: "Workflow",
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Link
              href={`/runs/${row.original.id}`}
              className="font-medium hover:underline underline-offset-2"
              prefetch={false}
            >
              {row.original.workflowName}
            </Link>
            <span className="font-mono text-muted-foreground text-xs">
              {row.original.id}
              {row.original.trigger !== "scheduled" && (
                <>
                  {" · "}
                  <span className="capitalize">{row.original.trigger}</span>
                  {row.original.triggeredBy ? ` · ${row.original.triggeredBy.name}` : ""}
                </>
              )}
            </span>
          </div>
        ),
      },
      {
        accessorKey: "stepCount",
        header: () => <span className="text-right">Steps</span>,
        cell: ({ row }) => <span className="tabular-nums text-sm">{row.original.stepCount}</span>,
      },
      {
        accessorKey: "costCents",
        header: "Cost",
        cell: ({ row }) =>
          row.original.costCents != null ? (
            <span className="tabular-nums text-sm">${(row.original.costCents / 100).toFixed(2)}</span>
          ) : (
            <span className="text-muted-foreground text-sm">—</span>
          ),
      },
      {
        accessorKey: "startedAt",
        header: ({ column }) => (
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-foreground"
            onClick={() => column.toggleSorting()}
          >
            Started
            <ArrowUpDown className="size-3.5" />
          </button>
        ),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="text-sm">{formatRelative(row.original.startedAt)}</span>
            <span className="text-muted-foreground text-xs">{formatDuration(row.original)}</span>
          </div>
        ),
      },
    ],
    [],
  );

  const table = useReactTable({
    data: historyRuns,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const totalCount = (data ?? []).length;

  return (
    <div className="space-y-6">
      {liveRuns.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="size-2 animate-pulse rounded-full bg-emerald-500" />
            <h2 className="font-semibold text-sm tracking-tight">
              Live now <span className="text-muted-foreground">· {liveRuns.length}</span>
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {liveRuns.map((run) => (
              <LiveRunCard key={run.id} run={run} />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold text-sm tracking-tight">
            History <span className="text-muted-foreground">· {historyRuns.length}</span>
          </h2>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search runs or workflow…"
                className="h-9 w-64 pl-8"
              />
            </div>
            <Select value={status} onValueChange={(v) => setStatus(v as RunStatus | "all")}>
              <SelectTrigger className="h-9 w-36">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                {RUN_STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={workflowId} onValueChange={setWorkflowId}>
              <SelectTrigger className="h-9 w-52">
                <SelectValue placeholder="Workflow" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All workflows</SelectItem>
                {mockWorkflows.map((wf) => (
                  <SelectItem key={wf.id} value={wf.id}>
                    {wf.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(search || status !== "all" || workflowId !== "all") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setStatus("all");
                  setWorkflowId("all");
                }}
              >
                Reset
              </Button>
            )}
          </div>
        </div>

        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((h) => (
                    <TableHead key={h.id}>
                      {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <TableRow key={i}>
                    {columns.map((_c, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : table.getRowModel().rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-32 text-center text-muted-foreground">
                    {totalCount === 0 ? "No runs match these filters." : "All matching runs are still live above."}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                    ))}
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

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function formatDuration(run: Run): string {
  if (!run.completedAt) return "—";
  const ms = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}
