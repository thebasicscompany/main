import { defineTool } from "@basics/shared";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const send_to_agent = defineTool({
  name: "send_to_agent",
  description:
    "Send a message to another lane in this workspace. Receiving lane's worker reads the inbox on each poll tick and includes the message in the next prompt context. Intra-workspace only — cross-tenant messaging is blocked at the SQL layer (§10.3).",
  params: z.object({
    toLaneId: z.string().min(1).optional(),
    body: z.record(z.string(), z.unknown()),
  }),
  // Sending a message is a tenant-internal mutation — record it on the
  // sender's run timeline; recipient lanes already see it via inbox poll.
  // Not approval-gated: it's just an inter-lane note, not a credential
  // grant. (Cross-agent grants get their own §10.3 tool, deferred.)
  mutating: true,
  requiresApproval: false,
  cost: "low",
  execute: async ({ toLaneId, body }, ctx: WorkerToolContext) => {
    if (!ctx.inboxesRepo) {
      throw new Error("send_to_agent_unavailable: ctx.inboxesRepo is not configured for this run");
    }
    const msg = await ctx.inboxesRepo.send({
      toWorkspaceId: ctx.workspaceId,
      toLaneId: toLaneId ?? null,
      fromWorkspaceId: ctx.workspaceId,
      fromLaneId: ctx.laneId ?? null,
      body,
    });
    await ctx.publish({
      type: "agent_message",
      payload: {
        messageId: msg.id,
        from: ctx.laneId ?? "default",
        to: toLaneId ?? "default",
        body,
      },
    });
    return { kind: "json", json: { messageId: msg.id, sentAt: msg.createdAt.toISOString() } };
  },
});
