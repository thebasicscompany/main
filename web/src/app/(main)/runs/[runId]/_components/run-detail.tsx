"use client";

import { useState } from "react";

import { useRouter } from "next/navigation";

import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { OrbitRing } from "@/components/ui/orbit-ring";
import { useRun } from "@/hooks/queries/use-runs";

import { LiveView } from "./live-view";
import { RunHeader } from "./run-header";
import { Timeline } from "./timeline";
import { VerificationStrip } from "./verification-strip";

export function RunDetail({ runId }: { runId: string }) {
  const router = useRouter();
  const { data: run, isLoading } = useRun(runId);
  const [takeover, setTakeover] = useState(false);
  const [paused, setPaused] = useState(false);

  if (isLoading) {
    return (
      <div className="flex h-[60vh] items-center justify-center text-muted-foreground">
        <OrbitRing className="mr-2" />
        Loading run…
      </div>
    );
  }

  if (!run) {
    return (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
        <h2 className="font-semibold text-lg">Run not found</h2>
        <p className="text-muted-foreground text-sm">This run id doesn't match anything in your workspace.</p>
        <button
          type="button"
          className="text-primary text-sm hover:underline"
          onClick={() => router.push("/runs")}
        >
          ← Back to runs
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <RunHeader
        run={run}
        takeover={takeover}
        onToggleTakeover={() => setTakeover((v) => !v)}
        paused={paused}
        onTogglePause={() => setPaused((v) => !v)}
      />

      {takeover ? (
        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="h-[calc(100vh-12rem)]">
            <LiveView run={run} takeover fullBleed onToggleTakeover={() => setTakeover(false)} />
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <ResizablePanelGroup orientation="horizontal" className="h-[calc(100vh-18rem)] min-h-[520px]">
            <ResizablePanel defaultSize={36} minSize={24}>
              <Timeline runId={run.id} />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={64} minSize={40}>
              <div className="flex h-full flex-col">
                <div className="min-h-0 flex-1">
                  <LiveView run={run} takeover={false} onToggleTakeover={() => setTakeover(true)} />
                </div>
                <VerificationStrip run={run} />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      )}
    </div>
  );
}
