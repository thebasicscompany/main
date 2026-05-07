"use client";

import type { VariantProps } from "class-variance-authority";

import { Badge, badgeVariants } from "@/components/ui/badge";
import { TextShimmer } from "@/components/text-shimmer";
import { cn } from "@/lib/utils";
import type { RunStatus } from "@/types/runs";

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

const STATUS_STYLES: Record<RunStatus, { label: string; variant: BadgeVariant; dot: string }> = {
  pending: { label: "Pending", variant: "secondary", dot: "bg-secondary-foreground/45" },
  booting: { label: "Booting", variant: "secondary", dot: "bg-secondary-foreground/45" },
  running: { label: "Running", variant: "default", dot: "bg-primary-foreground/75 animate-pulse" },
  paused: { label: "Paused", variant: "outline", dot: "bg-muted-foreground" },
  paused_by_user: { label: "Take-over", variant: "outline", dot: "bg-muted-foreground" },
  verifying: { label: "Verifying", variant: "secondary", dot: "bg-secondary-foreground/65 animate-pulse" },
  completed: { label: "Completed", variant: "secondary", dot: "bg-secondary-foreground/45" },
  failed: { label: "Failed", variant: "destructive", dot: "bg-destructive" },
  verified: { label: "Verified", variant: "default", dot: "bg-primary-foreground/75" },
  unverified: { label: "Unverified", variant: "outline", dot: "bg-muted-foreground" },
};

export const RUN_STATUS_OPTIONS: Array<{ value: RunStatus | "all"; label: string }> = [
  { value: "all", label: "All statuses" },
  { value: "running", label: "Running" },
  { value: "paused", label: "Paused" },
  { value: "verifying", label: "Verifying" },
  { value: "verified", label: "Verified" },
  { value: "unverified", label: "Unverified" },
  { value: "failed", label: "Failed" },
  { value: "completed", label: "Completed" },
];

export function StatusPill({ status }: { status: RunStatus }) {
  const cfg = STATUS_STYLES[status];
  return (
    <Badge variant={cfg.variant} className="h-auto min-h-5 gap-1.5 py-0.5">
      <span className={cn("size-1.5 shrink-0 rounded-full", cfg.dot)} aria-hidden />
      {status === "running" ? (
        <TextShimmer as="span" className="text-inherit leading-none" duration={2.2} spread={2.4}>
          {cfg.label}
        </TextShimmer>
      ) : (
        cfg.label
      )}
    </Badge>
  );
}
