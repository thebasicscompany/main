// E.9 — `propose_automation` worker tool.
//
// Chat-driven authoring. The agent, mid-conversation, decides what an
// automation should look like (name + goal + triggers + outputs) and
// calls this tool. Under the hood we POST to the API's
// /v1/workspaces/:wsId/automations/draft-from-chat endpoint, which
// CREATES (or PUTs) a `status='draft'` automation row AND immediately
// fires a dry-run so the operator can preview the side-effects WITHOUT
// any real email / SMS / Composio write going out.
//
// The tool returns the draft id + the dry-run runId + the preview poll
// URL. The agent can then call `dry-run-preview` (or just describe the
// outcome to the user from the buffered actions). When the user
// confirms, the agent calls the sibling `activate_automation` tool.

import { defineTool } from "@basics/shared";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";
import { signWorkerWorkspaceJwt } from "../authoring/jwt.js";

const ManualTrigger = z.object({ type: z.literal("manual") });
const RecurringSchedule = z.object({
  type: z.literal("schedule"),
  cron: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64),
});
const OneShotSchedule = z.object({
  type: z.literal("schedule"),
  at: z.string().datetime(),
});
const ComposioWebhook = z.object({
  type: z.literal("composio_webhook"),
  toolkit: z.string().min(1).max(64),
  event: z.string().min(1).max(128),
  filters: z.record(z.string(), z.unknown()).optional(),
});
const Trigger = z.union([ManualTrigger, RecurringSchedule, OneShotSchedule, ComposioWebhook]);

const SmsOutput = z.object({
  channel: z.literal("sms"),
  to: z.string().regex(/^\+[1-9]\d{6,14}$/),
  when: z.enum(["on_complete", "on_failure"]),
  includeArtifacts: z.boolean().optional(),
});
const EmailOutput = z.object({
  channel: z.literal("email"),
  to: z.union([z.string().email(), z.array(z.string().email()).min(1).max(50)]),
  subject: z.string().max(200).optional(),
  when: z.enum(["on_complete", "on_failure"]),
  includeArtifacts: z.boolean().optional(),
  bodyType: z.enum(["text", "html"]).optional(),
});
const Output = z.union([SmsOutput, EmailOutput]);

const SpecSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  goal: z.string().min(1).max(64 * 1024),
  triggers: z.array(Trigger).max(20).optional(),
  outputs: z.array(Output).max(10).optional(),
});

const ParamsSchema = z.object({
  /** When set + a draft was already created in this chat session, PUTs
   *  the same row instead of creating a new one. The agent should
   *  remember this id between iterations within the conversation. */
  draftId: z.string().uuid().optional(),
  spec: SpecSchema,
});

interface ProposeAutomationDeps {
  /** Test seam — defaults to global fetch. */
  fetch?: typeof fetch;
  /** Test seam — defaults to env-driven values. */
  apiBaseUrl?: string;
  jwtSecret?: string;
}

let injectedDeps: ProposeAutomationDeps | null = null;
export function setProposeAutomationDeps(deps: ProposeAutomationDeps | null) {
  injectedDeps = deps;
}

function defaultDeps(): Required<ProposeAutomationDeps> {
  const apiBaseUrl = injectedDeps?.apiBaseUrl ?? process.env.API_BASE_URL;
  const jwtSecret = injectedDeps?.jwtSecret ?? process.env.WORKSPACE_JWT_SECRET;
  if (!apiBaseUrl) throw new Error("propose_automation: API_BASE_URL not configured");
  if (!jwtSecret) throw new Error("propose_automation: WORKSPACE_JWT_SECRET not configured");
  return {
    fetch: injectedDeps?.fetch ?? fetch,
    apiBaseUrl,
    jwtSecret,
  };
}

export const propose_automation = defineTool({
  name: "propose_automation",
  description:
    "Author or revise a DRAFT automation and immediately fire a DRY-RUN so the user can preview every email / SMS / Composio write the automation WOULD make — none of those side-effects actually fire. Returns { automationId, draftRunId, previewPollUrl }. The agent should then summarize what's in the dry_run_actions buffer to the user, iterate on the spec if they want changes (re-call with the same draftId), and finally call activate_automation when the user confirms.",
  params: ParamsSchema,
  mutating: false, // read-only side: drafts don't fire real triggers
  cost: "medium",
  execute: async ({ draftId, spec }, ctx: WorkerToolContext) => {
    const deps = defaultDeps();
    const token = signWorkerWorkspaceJwt(deps.jwtSecret, {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
    });
    const body = {
      ...(draftId ? { draftId } : {}),
      sessionId: ctx.runId, // correlate the chat session via cloud_runs.id
      draft: spec,
    };
    const res = await deps.fetch(
      `${deps.apiBaseUrl}/v1/workspaces/${ctx.workspaceId}/automations/draft-from-chat`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (!res.ok) {
      return {
        kind: "json" as const,
        json: {
          ok: false,
          error: {
            code: "draft_from_chat_failed",
            status: res.status,
            body: parsed,
          },
        },
      };
    }
    return { kind: "json" as const, json: { ok: true, ...(parsed as Record<string, unknown>) } };
  },
});
