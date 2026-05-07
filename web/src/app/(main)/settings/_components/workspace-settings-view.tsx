"use client";

import { Badge } from "@/components/ui/badge";
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
import { useSettingsWorkspace } from "@/hooks/queries/use-settings-workspace";
import type { WorkspaceRole } from "@/types/settings";

const ROLE_VARIANT: Record<WorkspaceRole, "default" | "secondary" | "outline"> = {
  owner: "default",
  admin: "secondary",
  member: "outline",
};

export function WorkspaceSettingsView() {
  const { data, isLoading } = useSettingsWorkspace();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Workspace</h2>
        <p className="text-sm text-muted-foreground">
          Members and billing for this cloud runtime workspace. Invite flows ship with auth wiring.
        </p>
      </div>

      {isLoading || !data ? (
        <div className="space-y-4">
          <Skeleton className="h-36 w-full max-w-xl" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : (
        <>
          <Card size="sm" className="max-w-xl">
            <CardHeader className="border-b">
              <CardTitle>{data.workspace.name}</CardTitle>
              <CardDescription>
                Slug <span className="font-mono text-foreground">{data.workspace.slug}</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 pt-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground text-sm">Plan</span>
                <Badge variant="secondary">{data.workspace.billing.planName}</Badge>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground text-sm">Seats</span>
                <span className="text-sm tabular-nums">
                  {data.workspace.billing.seatsUsed} / {data.workspace.billing.seatsIncluded} used
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground text-sm">Renews</span>
                <span className="text-sm">{formatDay(data.workspace.billing.renewsAt)}</span>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground text-sm">Payment</span>
                <span className="text-sm">{data.workspace.billing.paymentMethodSummary}</span>
              </div>
              <Button type="button" variant="outline" size="sm" className="mt-1 w-fit">
                Manage billing
              </Button>
            </CardContent>
          </Card>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-medium text-sm">Members</h3>
              <Button type="button" variant="outline" size="sm">
                Invite member
              </Button>
            </div>
            <div className="overflow-hidden rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead className="text-right">Joined</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.members.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="font-medium">{m.displayName}</TableCell>
                      <TableCell className="text-muted-foreground">{m.email}</TableCell>
                      <TableCell>
                        <Badge variant={ROLE_VARIANT[m.role]}>{m.role}</Badge>
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground text-sm tabular-nums">
                        {formatDay(m.joinedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
