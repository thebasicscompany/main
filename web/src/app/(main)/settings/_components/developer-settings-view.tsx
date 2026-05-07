"use client";

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
import { useSettingsDeveloper } from "@/hooks/queries/use-settings-developer";
import { formatRelative } from "@/lib/format";

export function DeveloperSettingsView() {
  const { data, isLoading } = useSettingsDeveloper();

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Developer</h2>
        <p className="text-sm text-muted-foreground">
          API tokens and outbound webhooks for CI and ops hooks. Lens desktop tooling stays separate until v2 control-plane wiring.
        </p>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium text-sm">API tokens</h3>
          <Button type="button" size="sm">
            Create token
          </Button>
        </div>
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Label</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Last used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 2 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 4 }).map((_x, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-28" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (data?.tokens ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-20 text-center text-muted-foreground text-sm">
                    No tokens yet.
                  </TableCell>
                </TableRow>
              ) : (
                (data?.tokens ?? []).map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">{t.label}</TableCell>
                    <TableCell className="font-mono text-muted-foreground text-xs">{t.prefix}••••••••</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{formatDay(t.createdAt)}</TableCell>
                    <TableCell className="text-right text-muted-foreground text-sm">
                      {formatRelative(t.lastUsedAt)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium text-sm">Webhooks</h3>
          <Button type="button" variant="outline" size="sm">
            Add endpoint
          </Button>
        </div>
        <div className="overflow-hidden rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>URL</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 1 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 3 }).map((_x, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full max-w-[200px]" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (data?.webhooks ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="h-20 text-center text-muted-foreground text-sm">
                    No webhook endpoints configured.
                  </TableCell>
                </TableRow>
              ) : (
                (data?.webhooks ?? []).map((w) => (
                  <TableRow key={w.id}>
                    <TableCell className="max-w-[280px] truncate font-mono text-xs">{w.url}</TableCell>
                    <TableCell className="text-muted-foreground text-xs">{w.events.join(", ")}</TableCell>
                    <TableCell className="text-sm">{w.enabled ? "Active" : "Paused"}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </div>

      <Card size="sm" className="bg-muted/40">
        <CardHeader>
          <CardTitle className="text-base">Lens & desktop</CardTitle>
          <CardDescription>
            Cookie sync and capture daemon settings live in the Lens app for now — not duplicated here.
          </CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-xs">
          When runtime auth lands, this section will link workspace tokens for local development.
        </CardContent>
      </Card>
    </div>
  );
}

function formatDay(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
