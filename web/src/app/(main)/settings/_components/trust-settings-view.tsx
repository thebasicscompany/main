"use client";

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
import { useSettingsTrustGrants } from "@/hooks/queries/use-settings-trust";
import type { TrustGrantScope } from "@/types/settings";

const SCOPE_VARIANT: Record<TrustGrantScope, "secondary" | "outline"> = {
  workspace: "secondary",
  workflow: "outline",
};

export function TrustSettingsView() {
  const { data, isLoading } = useSettingsTrustGrants();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Trust</h2>
        <p className="text-sm text-muted-foreground">
          Auto-approval grants narrow by action pattern and params. Approval middleware checks here before humans see a prompt.
        </p>
      </div>

      <div className="overflow-hidden rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Action</TableHead>
              <TableHead>Constraint</TableHead>
              <TableHead>Scope</TableHead>
              <TableHead>Granted</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="text-right w-[100px]"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 6 }).map((_x, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full max-w-[140px]" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (data ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground text-sm">
                  No trust grants yet. Grants appear after take-over or explicit approval shortcuts.
                </TableCell>
              </TableRow>
            ) : (
              (data ?? []).map((g) => (
                <TableRow key={g.id}>
                  <TableCell className="font-mono text-xs">{g.actionPattern}</TableCell>
                  <TableCell className="max-w-[220px] text-muted-foreground text-xs">{g.paramsConstraint}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <Badge variant={SCOPE_VARIANT[g.scope]}>{g.scope}</Badge>
                      {g.workflowName ? (
                        <span className="text-muted-foreground text-xs">{g.workflowName}</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                    {g.grantedByName}
                    <span className="block text-xs">{formatDay(g.grantedAt)}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                    {g.expiresAt ? formatDay(g.expiresAt) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button type="button" variant="ghost" size="sm">
                      Revoke
                    </Button>
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

function formatDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
