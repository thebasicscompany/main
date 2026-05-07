"use client";

import { useState } from "react";

import Link from "next/link";

import { Check, Clock, ExternalLink, X } from "@/icons";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Approval } from "@/types/runs";

export function PendingCard({ approval }: { approval: Approval }) {
  const [resolved, setResolved] = useState<"approved" | "rejected" | null>(null);
  const params = Object.entries(approval.params);

  return (
    <article
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-4 transition-opacity",
        resolved && "opacity-60",
      )}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{approval.action}</code>
            {resolved && (
              <Badge
                variant={resolved === "approved" ? "default" : "destructive"}
                className="h-auto min-h-5 gap-1 py-0.5 font-normal [&>svg]:!size-3"
              >
                {resolved === "approved" ? <Check /> : <X />}
                {resolved === "approved" ? "Approved" : "Rejected"}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-sm leading-snug">{approval.reason}</p>
        </div>
        <div className="flex items-center gap-1 text-muted-foreground text-xs">
          <Clock className="size-3" />
          {formatRelative(approval.requestedAt)}
        </div>
      </header>

      {params.length > 0 && (
        <dl className="space-y-1.5 rounded-md border bg-muted/30 p-3 text-xs">
          {params.map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <dt className="shrink-0 font-mono text-muted-foreground">{k}</dt>
              <dd className="min-w-0 flex-1 break-all">
                {typeof v === "string" ? v : <code className="font-mono">{JSON.stringify(v)}</code>}
              </dd>
            </div>
          ))}
        </dl>
      )}

      <footer className="flex items-center justify-between gap-2 border-t pt-3">
        <Link
          href={`/runs/${approval.runId}`}
          prefetch={false}
          className="inline-flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground"
        >
          <ExternalLink className="size-3" />
          <span className="font-mono">{approval.runId}</span>
        </Link>
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1.5"
            onClick={() => setResolved("rejected")}
            disabled={Boolean(resolved)}
          >
            <X className="size-3.5" />
            Reject
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => setResolved("approved")}
            disabled={Boolean(resolved)}
          >
            <Check className="size-3.5" />
            Approve
          </Button>
        </div>
      </footer>
    </article>
  );
}
