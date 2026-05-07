"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useWorkflows } from "@/hooks/queries/use-workflows";
import { formatCron } from "@/lib/format";

export function SchedulesSettingsView() {
  const { data, isLoading } = useWorkflows();
  const rows = (data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Schedules</h2>
        <p className="text-sm text-muted-foreground">
          Cron expressions drive EventBridge triggers in production. Editing stays on the workflow detail page for now.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead>Schedule</TableHead>
              <TableHead>Cron</TableHead>
              <TableHead className="text-right"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 4 }).map((_x, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full max-w-[160px]" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground text-sm">
                  No workflows yet.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((wf) => (
                <TableRow key={wf.id}>
                  <TableCell className="font-medium">{wf.name}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">{formatCron(wf.schedule)}</TableCell>
                  <TableCell className="font-mono text-muted-foreground text-xs">{wf.schedule ?? "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-2">
                      <Badge variant={wf.enabled ? "default" : "secondary"}>{wf.enabled ? "On" : "Off"}</Badge>
                      <Button type="button" variant="outline" size="sm" asChild>
                        <Link href={`/workflows/${wf.id}`}>Open</Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
