"use client";

import type { VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";

import Link from "next/link";

import { Check, Clock, X } from "@/icons";

import { Badge, badgeVariants } from "@/components/ui/badge";
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
import { formatRelative } from "@/lib/format";
import type { ApprovalStatus } from "@/types/runs";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

const STATUS_META: Record<
  Exclude<ApprovalStatus, "pending">,
  { label: string; variant: BadgeVariant; icon: ReactNode }
> = {
  approved: {
    label: "Approved",
    variant: "default",
    icon: <Check />,
  },
  rejected: {
    label: "Rejected",
    variant: "destructive",
    icon: <X />,
  },
  timeout: {
    label: "Timeout",
    variant: "secondary",
    icon: <Clock />,
  },
};

export function ResolvedTable() {
  const { data, isLoading } = useApprovals();
  const resolved = (data ?? [])
    .filter((a) => a.status !== "pending")
    .slice()
    .sort((a, b) => (b.resolvedAt ?? b.requestedAt).localeCompare(a.resolvedAt ?? a.requestedAt));

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Outcome</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Run</TableHead>
            <TableHead>Resolved by</TableHead>
            <TableHead className="text-right">Resolved</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <TableRow key={i}>
                {Array.from({ length: 5 }).map((_x, j) => (
                  <TableCell key={j}>
                    <Skeleton className="h-4 w-20" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : resolved.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="h-24 text-center text-muted-foreground text-sm">
                No resolved approvals yet.
              </TableCell>
            </TableRow>
          ) : (
            resolved.map((a) => {
              const meta = STATUS_META[a.status as Exclude<ApprovalStatus, "pending">];
              return (
                <TableRow key={a.id}>
                  <TableCell>
                    <Badge variant={meta.variant} className="h-auto min-h-5 gap-1 py-0.5 font-normal [&>svg]:!size-3">
                      {meta.icon}
                      {meta.label}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{a.action}</code>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/runs/${a.runId}`}
                      className="font-mono text-muted-foreground text-xs hover:text-foreground hover:underline underline-offset-2"
                      prefetch={false}
                    >
                      {a.runId}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {a.resolvedBy?.name ?? <span className="italic">—</span>}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground text-sm">
                    {formatRelative(a.resolvedAt ?? a.requestedAt)}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
