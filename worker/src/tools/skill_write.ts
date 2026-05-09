// `skill_write` — the canonical "I learned something durable" tool.
// CLOUD-AGENT-PLAN §13 reconciliation: skills go directly to the DB
// `skills` table (no EFS skills/ subtree). Reuses the D.1 validator
// (validateSkillWrite) before any DB write.
//
// The store is injected via WorkerToolContext.skillStore (set by the
// runner from a PgSkillStore in production, InMemorySkillStore in tests).

import { defineTool } from "@basics/shared";
import { z } from "zod";
import { validateSkillWrite, SkillWriteBlockedError } from "../middleware/skill-write-policy.js";
import type { WorkerToolContext } from "./context.js";

export const skill_write = defineTool({
  name: "skill_write",
  description:
    "Persist a learned skill (selectors, flow playbook, gotcha) for this workspace. Auto-flagged pending_review until the operator approves. Body must include a 'Last-verified: YYYY-MM-DD' line for selectors / flow docs and pass the §9.3 content scanners (no secrets, no pixel coords, no PII without allowPII).",
  params: z.object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(500),
    body: z.string().min(1).max(64 * 1024),
    host: z.string().min(1).max(120).optional(),
    /** Synthetic skill-path used by the validator (e.g. "skills/example.com/selectors.md"). */
    syntheticPath: z.string().min(1).optional(),
    scope: z.enum(["personal", "workspace", "shared"]).optional(),
    requiresIntegrations: z.array(z.string().min(1)).max(20).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  // Skill writes ARE mutating (creates a durable DB row), but we don't
  // require approval — pending_review=true on the row IS the approval
  // gate, surfaced through the operator's review UI rather than a
  // synchronous pause.
  mutating: true,
  requiresApproval: false,
  cost: "low",
  execute: async (
    { name, description, body, host, syntheticPath, scope, requiresIntegrations, confidence },
    ctx: WorkerToolContext,
  ) => {
    // For policy purposes treat the skill as if it were
    // skills/<host>/<name>.md — that matches the §9.3 path policy and
    // verification-stamp rule (selectors / flows in the path require it).
    const policyPath = syntheticPath
      ?? (host ? `skills/${host}/${name}.md` : `skills/${name}.md`);
    const verdict = validateSkillWrite(policyPath, body);
    if (!verdict.ok) {
      await ctx.publish({
        type: "skill_write_blocked",
        payload: {
          path: policyPath,
          code: verdict.code,
          message: verdict.message,
          byteLength: Buffer.byteLength(body, "utf8"),
        },
      });
      throw new SkillWriteBlockedError(verdict);
    }

    if (!ctx.skillStore) {
      throw new Error("skill_write_unavailable: ctx.skillStore is not configured for this run");
    }

    const row = await ctx.skillStore.insert({
      workspaceId: ctx.workspaceId,
      name,
      description,
      body,
      ...(host ? { host } : {}),
      ...(scope ? { scope } : {}),
      ...(requiresIntegrations ? { requiresIntegrations } : {}),
      sourceRunId: ctx.runId,
      ...(confidence !== undefined ? { confidence } : {}),
    });

    await ctx.publish({
      type: "skill_written",
      payload: {
        skillId: row.id,
        name: row.name,
        host: row.host,
        scope: row.scope,
        pendingReview: row.pendingReview,
      },
    });

    return {
      kind: "json",
      json: { skillId: row.id, pendingReview: row.pendingReview },
    };
  },
});
