"use client";

import { Brain, Check, Eye, MousePointerClick, ShieldCheck, Wrench, X } from "@/icons";

import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { useRunSteps } from "@/hooks/queries/use-runs";
import { cn } from "@/lib/utils";
import type { RunStep } from "@/types/runs";

const KIND_META = {
  model_thinking: { icon: Brain, label: "Reasoning", tone: "text-violet-600 bg-violet-50 dark:bg-violet-950/40" },
  model_tool_use: { icon: Wrench, label: "Tool intent", tone: "text-amber-600 bg-amber-50 dark:bg-amber-950/40" },
  tool_call: { icon: MousePointerClick, label: "Tool call", tone: "text-blue-600 bg-blue-50 dark:bg-blue-950/40" },
  approval: { icon: ShieldCheck, label: "Approval", tone: "text-emerald-600 bg-emerald-50 dark:bg-emerald-950/40" },
  check: { icon: Check, label: "Check", tone: "text-primary bg-primary/10" },
  user_takeover: { icon: Eye, label: "Take-over", tone: "text-purple-600 bg-purple-50 dark:bg-purple-950/40" },
} as const;

export function Timeline({ runId }: { runId: string }) {
  const { data, isLoading } = useRunSteps(runId);

  if (isLoading) {
    return (
      <div className="space-y-3 p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return <div className="p-6 text-center text-muted-foreground text-sm">No timeline events yet.</div>;
  }

  return (
    <ScrollArea className="h-full">
      <ol className="relative space-y-3 px-4 py-4">
        <span aria-hidden className="absolute top-4 bottom-4 left-[27px] w-px bg-border" />
        {data.map((step) => (
          <TimelineRow key={step.id} step={step} />
        ))}
      </ol>
    </ScrollArea>
  );
}

function TimelineRow({ step }: { step: RunStep }) {
  const meta = KIND_META[step.kind];
  const Icon = meta.icon;
  return (
    <li className="relative flex gap-3">
      <div className={cn("relative z-10 flex size-9 shrink-0 items-center justify-center rounded-full ring-4 ring-background", meta.tone)}>
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1 rounded-md border bg-card px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-xs uppercase tracking-wide text-muted-foreground">{meta.label}</span>
          <span className="font-mono text-muted-foreground text-[10px]">#{step.stepIndex}</span>
        </div>
        <StepBody step={step} />
      </div>
    </li>
  );
}

function StepBody({ step }: { step: RunStep }) {
  const p = step.payload;
  switch (p.kind) {
    case "model_thinking":
      return <p className="mt-1 text-sm leading-snug">{p.text}</p>;
    case "model_tool_use":
      return (
        <p className="mt-1 text-sm leading-snug">
          Calling <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{p.toolName}</code> · {p.reasoning}
        </p>
      );
    case "tool_call":
      return (
        <div className="mt-1 space-y-1 text-sm">
          <div>
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{p.toolName}</code>{" "}
            <span className="text-muted-foreground text-xs tabular-nums">{p.durationMs}ms</span>
            {p.error && <X className="ml-1 inline size-3.5 text-red-600" />}
          </div>
          {paramsLine(p.params) && (
            <div className="truncate text-muted-foreground text-xs">{paramsLine(p.params)}</div>
          )}
          {p.error && <div className="text-red-600 text-xs">{p.error}</div>}
        </div>
      );
    case "approval":
      return (
        <p className="mt-1 text-sm leading-snug">
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{p.action}</code>{" "}
          <span className={cn("text-xs", p.status === "approved" ? "text-emerald-600" : p.status === "rejected" ? "text-red-600" : "text-amber-600")}>
            {p.status}
          </span>
        </p>
      );
    case "check":
      return (
        <p className="mt-1 flex items-center gap-1.5 text-sm leading-snug">
          {p.passed ? <Check className="size-3.5 text-emerald-600" /> : <X className="size-3.5 text-red-600" />}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{p.checkName}</code>
        </p>
      );
    case "user_takeover":
      return (
        <p className="mt-1 text-sm leading-snug">
          <span className="font-medium">{p.userName}</span> took over the session
          {p.reason ? ` — ${p.reason}` : "."}
        </p>
      );
    default:
      return null;
  }
}

function paramsLine(params: Record<string, unknown>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return "";
  return entries
    .map(([k, v]) => `${k}=${typeof v === "string" ? truncate(v, 40) : JSON.stringify(v)}`)
    .join(" · ");
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
