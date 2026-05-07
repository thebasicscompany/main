"use client";

import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { useApprovals } from "@/hooks/queries/use-approvals";

import { PendingCard } from "./pending-card";
import { ResolvedTable } from "./resolved-table";

export function ApprovalsView() {
  const { data, isLoading } = useApprovals();
  const pending = (data ?? []).filter((a) => a.status === "pending");
  const resolvedCount = (data ?? []).filter((a) => a.status !== "pending").length;

  return (
    <Tabs defaultValue="pending" className="space-y-4">
      <TabsList>
        <TabsTrigger value="pending" className="gap-2">
          Pending
          {pending.length > 0 && (
            <Badge variant="default" className="h-5 min-w-5 justify-center px-1.5 tabular-nums">
              {pending.length}
            </Badge>
          )}
        </TabsTrigger>
        <TabsTrigger value="resolved" className="gap-2">
          Resolved
          <span className="text-muted-foreground tabular-nums">{resolvedCount}</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="pending" className="space-y-3">
        {isLoading ? (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-44" />
            ))}
          </div>
        ) : pending.length === 0 ? (
          <div className="rounded-lg border bg-card p-12 text-center">
            <p className="font-medium text-sm">All caught up.</p>
            <p className="mt-1 text-muted-foreground text-sm">No agents are waiting on a human right now.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {pending.map((a) => (
              <PendingCard key={a.id} approval={a} />
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="resolved">
        <ResolvedTable />
      </TabsContent>
    </Tabs>
  );
}
