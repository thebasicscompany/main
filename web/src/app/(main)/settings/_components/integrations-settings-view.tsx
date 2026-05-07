"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSettingsIntegrations } from "@/hooks/queries/use-settings-integrations";
import type { IntegrationStatus } from "@/types/settings";

const STATUS_META: Record<
  IntegrationStatus,
  { label: string; variant: "default" | "secondary" | "outline" | "destructive" }
> = {
  connected: { label: "Connected", variant: "default" },
  disconnected: { label: "Not connected", variant: "outline" },
  expiring_soon: { label: "Expiring soon", variant: "secondary" },
  error: { label: "Error", variant: "destructive" },
};

export function IntegrationsSettingsView() {
  const { data, isLoading } = useSettingsIntegrations();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">Integrations</h2>
        <p className="text-sm text-muted-foreground">
          Slack, SaaS OAuth, and credential scopes used by workflows and checks.
        </p>
      </div>

      {isLoading ? (
        <div className="grid gap-3 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-36" />
          ))}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {(data ?? []).map((row) => {
            const meta = STATUS_META[row.status];
            return (
              <Card key={row.id} size="sm">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{row.name}</CardTitle>
                    <Badge variant={meta.variant}>{meta.label}</Badge>
                  </div>
                  <CardDescription>{row.description}</CardDescription>
                </CardHeader>
                {row.detail ? (
                  <CardContent className="text-muted-foreground text-xs">{row.detail}</CardContent>
                ) : null}
                <CardFooter className="justify-end gap-2 border-t-0 pt-0">
                  <Button type="button" variant="outline" size="sm">
                    {row.status === "connected" || row.status === "expiring_soon" ? "Manage" : "Connect"}
                  </Button>
                </CardFooter>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
