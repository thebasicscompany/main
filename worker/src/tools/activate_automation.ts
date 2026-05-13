// E.9 — `activate_automation` worker tool.
//
// Flips a draft → active. Registering Composio webhook subscriptions
// and EventBridge schedules is a real production side-effect, so the
// tool carries an approval gate: any automation with `sms` or `email`
// outputs forces an approval prompt (operator must say YES before the
// agent flips the switch). Automations with only in-app activity
// (no outbound channels) can activate without approval — but they
// still register Composio triggers + schedules, so we err toward
// asking when the agent isn't sure.

import { defineTool } from "@basics/shared";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";
import { signWorkerWorkspaceJwt } from "../authoring/jwt.js";

const ParamsSchema = z.object({
  automationId: z.string().uuid(),
});

interface ActivateAutomationDeps {
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  jwtSecret?: string;
}

let injectedDeps: ActivateAutomationDeps | null = null;
export function setActivateAutomationDeps(deps: ActivateAutomationDeps | null) {
  injectedDeps = deps;
}

function defaultDeps(): Required<ActivateAutomationDeps> {
  const apiBaseUrl = injectedDeps?.apiBaseUrl ?? process.env.API_BASE_URL;
  const jwtSecret = injectedDeps?.jwtSecret ?? process.env.WORKSPACE_JWT_SECRET;
  if (!apiBaseUrl) throw new Error("activate_automation: API_BASE_URL not configured");
  if (!jwtSecret) throw new Error("activate_automation: WORKSPACE_JWT_SECRET not configured");
  return {
    fetch: injectedDeps?.fetch ?? fetch,
    apiBaseUrl,
    jwtSecret,
  };
}

/**
 * Approval inspector. Conservative: require approval whenever the
 * agent is about to flip a switch — the activation registers real
 * triggers and is the moment of no-return for the operator's "is this
 * automation safe to run unattended?" decision. Caller can short-
 * circuit by registering a per-automation approval_rule (D.9 remember
 * path) so subsequent activations of the SAME automation don't ask
 * again.
 */
export function activateAutomationApproval(_: z.infer<typeof ParamsSchema>) {
  return {
    required: true,
    reason:
      "Activating an automation registers its triggers + schedules in production. Once active, it will run unattended on every fire.",
    expiresInSeconds: 30 * 60,
  } as const;
}

export const activate_automation = defineTool({
  name: "activate_automation",
  description:
    "Activate a previously-drafted automation. Flips status from 'draft' → 'active' and registers its Composio webhooks + EventBridge schedules in production. Requires operator approval (the activation itself is gated). Use only after the user has reviewed the dry-run preview and explicitly confirmed.",
  params: ParamsSchema,
  mutating: true,
  approval: activateAutomationApproval,
  cost: "low",
  execute: async ({ automationId }, ctx: WorkerToolContext) => {
    const deps = defaultDeps();
    const token = signWorkerWorkspaceJwt(deps.jwtSecret, {
      workspaceId: ctx.workspaceId,
      accountId: ctx.accountId,
    });
    const res = await deps.fetch(
      `${deps.apiBaseUrl}/v1/automations/${automationId}/activate`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{}",
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
          error: { code: "activate_failed", status: res.status, body: parsed },
        },
      };
    }
    return { kind: "json" as const, json: { ok: true, ...(parsed as Record<string, unknown>) } };
  },
});
