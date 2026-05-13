// A.8 — run-completion output dispatcher.
//
// Reads an automation's `outputs[]` config, filters by `when` (`on_complete`,
// `on_failure`, `always`) against the run's final status, and routes each
// matching entry to send_email or send_sms. Aggregates errors so one
// failing channel doesn't block the others, then emits a single
// `output_dispatch_summary` event into the run's activity stream.

import { send_email } from "./tools/send_email.js";
import { send_sms } from "./tools/send_sms.js";
import type { WorkerToolContext } from "./tools/context.js";

export type OutputChannel = "sms" | "email" | "artifact";
export type OutputWhen = "on_complete" | "on_failure" | "always";

/** One declarative output entry on an automation row. */
export interface AutomationOutput {
  channel: OutputChannel;
  /** E.164 phone for sms, RFC-5322 email for email, ignored for artifact. */
  to: string;
  /** Email subject. Optional; falls back to automation.name. */
  subject?: string;
  /** When true and runResult.artifacts is non-empty, attach them via send_email's s3Key route. */
  includeArtifacts?: boolean;
  /** Override body type for email; otherwise autodetected by send_email. */
  bodyType?: "text" | "html";
  when: OutputWhen;
}

export interface Automation {
  id: string;
  /** Human-readable label used in default subjects / summaries. */
  name?: string;
  outputs: AutomationOutput[];
}

/** Worker-internal mapping of the run's terminal status. */
export type RunFinalStatus = "completed" | "failed";

/** Maps the worker's local 'success'/'error' status onto the plan's terms. */
export function normalizeRunStatus(s: string): RunFinalStatus {
  return s === "success" || s === "completed" ? "completed" : "failed";
}

export interface RunResult {
  status: RunFinalStatus;
  /** Free-form summary; becomes the email/SMS body. */
  summary?: string;
  /** Artifacts attached during the run (from attach_artifact). */
  artifacts?: Array<{ s3Key: string; filename?: string }>;
}

export interface PerOutputResult {
  channel: OutputChannel;
  to: string;
  when: OutputWhen;
  status: "ok" | "error" | "skipped";
  error?: { code: string; message: string };
  detail?: Record<string, unknown>;
}

export interface DispatchOutputsResult {
  automationId: string;
  runStatus: RunFinalStatus;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  perChannel: PerOutputResult[];
}

function matchesWhen(when: OutputWhen, status: RunFinalStatus): boolean {
  if (when === "always") return true;
  if (when === "on_complete") return status === "completed";
  if (when === "on_failure") return status === "failed";
  return false;
}

function defaultSubject(
  automation: Automation,
  runResult: RunResult,
): string {
  const label = automation.name ?? automation.id;
  return runResult.status === "completed"
    ? `Automation done: ${label}`
    : `Automation failed: ${label}`;
}

export async function dispatchOutputs(
  ctx: WorkerToolContext,
  automation: Automation,
  runResult: RunResult,
): Promise<DispatchOutputsResult> {
  const perChannel: PerOutputResult[] = [];

  for (const out of automation.outputs) {
    const base = { channel: out.channel, to: out.to, when: out.when };
    if (!matchesWhen(out.when, runResult.status)) {
      perChannel.push({ ...base, status: "skipped" });
      continue;
    }

    try {
      if (out.channel === "email") {
        const attachments =
          out.includeArtifacts && runResult.artifacts && runResult.artifacts.length > 0
            ? runResult.artifacts.map((a) => ({
                s3Key: a.s3Key,
                ...(a.filename ? { filename: a.filename } : {}),
              }))
            : undefined;
        const result = await send_email.execute(
          {
            to: out.to,
            subject: out.subject ?? defaultSubject(automation, runResult),
            body: runResult.summary ?? "",
            ...(out.bodyType ? { bodyType: out.bodyType } : {}),
            ...(attachments ? { attachments } : {}),
          },
          ctx,
        );
        const detail = (result as { kind: "json"; json: Record<string, unknown> })
          .json;
        perChannel.push({ ...base, status: "ok", detail });
      } else if (out.channel === "sms") {
        const result = await send_sms.execute(
          { to: out.to, body: runResult.summary ?? "" },
          ctx,
        );
        const detail = (result as { kind: "json"; json: Record<string, unknown> })
          .json;
        perChannel.push({ ...base, status: "ok", detail });
      } else {
        // `artifact` is for mid-run agent calls (attach_artifact), not an
        // end-of-run dispatch channel. Mark skipped rather than fail.
        perChannel.push({ ...base, status: "skipped" });
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      perChannel.push({
        ...base,
        status: "error",
        error: {
          code: e.code ?? e.name ?? "unknown",
          message: e.message ?? "unknown",
        },
      });
    }
  }

  const succeeded = perChannel.filter((r) => r.status === "ok").length;
  const failed = perChannel.filter((r) => r.status === "error").length;
  const skipped = perChannel.filter((r) => r.status === "skipped").length;

  try {
    await ctx.publish({
      type: "output_dispatch_summary",
      payload: {
        kind: "output_dispatch_summary",
        automation_id: automation.id,
        run_status: runResult.status,
        total: automation.outputs.length,
        succeeded,
        failed,
        skipped,
        results: perChannel,
      },
    });
  } catch (e) {
    // Don't fail the whole dispatch on a summary-publish error; the per-channel
    // results are still useful to the caller, and DB hiccups here are common
    // during shutdown.
    console.error("dispatchOutputs: output_dispatch_summary emit failed", e);
  }

  return {
    automationId: automation.id,
    runStatus: runResult.status,
    total: automation.outputs.length,
    succeeded,
    failed,
    skipped,
    perChannel,
  };
}
