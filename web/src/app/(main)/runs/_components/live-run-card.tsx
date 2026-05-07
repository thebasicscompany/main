"use client";

import { useEffect, useState } from "react";

import Link from "next/link";

import { Maximize2, Pause } from "@/icons";

import { Button } from "@/components/ui/button";
import { useRunSteps } from "@/hooks/queries/use-runs";
import { cn } from "@/lib/utils";
import type { Run, RunStep } from "@/types/runs";

import { StatusPill } from "./status-pill";

export function LiveRunCard({ run }: { run: Run }) {
  const { data: steps } = useRunSteps(run.id);
  const elapsed = useElapsed(run.startedAt);
  const last = steps?.at(-1);

  return (
    <Link
      href={`/runs/${run.id}`}
      prefetch={false}
      className={cn(
        "group flex min-w-[320px] flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:border-primary/40",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-sm">{run.workflowName}</div>
          <div className="font-mono text-muted-foreground text-xs">{run.id}</div>
        </div>
        <StatusPill status={run.status} />
      </div>

      <div className="flex items-baseline gap-1.5">
        <span className="font-semibold text-3xl tabular-nums tracking-tight">{elapsed}</span>
        <span className="text-muted-foreground text-xs">elapsed</span>
      </div>

      <div className="flex items-center gap-2 text-muted-foreground text-xs">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />
        <span className="truncate">{lastStepLine(last)}</span>
      </div>

      <div className="mt-auto flex items-center justify-between border-t pt-3 text-muted-foreground text-xs">
        <span>{run.stepCount} step{run.stepCount === 1 ? "" : "s"}</span>
        <div
          className="flex items-center gap-1"
          onClick={(e) => e.preventDefault()}
          role="presentation"
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <Pause className="size-3" />
            Pause
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          >
            <Maximize2 className="size-3" />
            Take over
          </Button>
        </div>
      </div>
    </Link>
  );
}

function useElapsed(startedAt: string): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const sec = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function lastStepLine(step: RunStep | undefined): string {
  if (!step) return "Booting Browserbase session…";
  const p = step.payload;
  switch (p.kind) {
    case "model_thinking":
      return p.text;
    case "model_tool_use":
      return `Calling ${p.toolName} — ${p.reasoning}`;
    case "tool_call":
      return `${p.toolName}(${Object.keys(p.params).join(", ")})`;
    case "approval":
      return `Awaiting approval: ${p.action}`;
    case "check":
      return `Check: ${p.checkName}`;
    case "user_takeover":
      return `${p.userName} took over`;
    default:
      return "Working…";
  }
}
