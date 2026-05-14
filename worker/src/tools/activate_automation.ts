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
  /**
   * J.6 — explicit "activate even if some triggers fail to register"
   * override. Default: false (strict). When false and any trigger
   * registration fails, the api leaves the automation in DRAFT and
   * returns 422 with structured failures the agent can fix and retry.
   * Only pass true if the user has reviewed the failures and explicitly
   * confirms they want partial activation.
   */
  acceptFailedTriggers: z.boolean().optional(),
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
  execute: async ({ automationId, acceptFailedTriggers }, ctx: WorkerToolContext) => {
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
        body: JSON.stringify(
          acceptFailedTriggers === true ? { acceptFailedTriggers: true } : {},
        ),
      },
    );
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    if (!res.ok) {
      // J.6 — when the api returns 422 trigger_registration_failed,
      // surface the structured failure shape so the agent sees exactly
      // which trigger broke + why. The automation stays in DRAFT; the
      // agent should fix the trigger config and re-call propose then
      // activate.
      const body = parsed as { error?: string; failures?: unknown[] } | undefined;
      if (res.status === 422 && body?.error === "trigger_registration_failed") {
        return {
          kind: "json" as const,
          json: {
            ok: false,
            error: {
              code: "trigger_registration_failed",
              message:
                "Composio / EventBridge rejected one or more triggers. The automation is still in DRAFT. Inspect `failures`, fix the trigger config via propose_automation (use composio_list_triggers to discover correct slugs + schemas), and retry activation.",
              failures: body.failures ?? [],
            },
          },
        };
      }
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
