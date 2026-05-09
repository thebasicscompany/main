import { defineTool } from "@basics/shared";
import { capture_screenshot } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const screenshot = defineTool({
  name: "screenshot",
  description:
    "Capture a PNG screenshot of the current tab. Set `full: true` to capture beyond the viewport.",
  params: z.object({
    full: z.boolean().optional(),
  }),
  mutating: false,
  cost: "medium",
  execute: async ({ full }, ctx: WorkerToolContext) => {
    const r = await capture_screenshot(ctx.session, { full });
    // Approximate byte size from the base64 length so we don't ship the
    // image bytes through agent_activity (the payload column is a JSONB
    // pointer, not an image store — the worker writes the actual bytes
    // to S3 elsewhere).
    // The runner emits tool_call_start/end + screenshot lifecycle events;
    // the tool itself doesn't double-publish. (`ctx.publish` is wired so
    // the plan tools can emit their canonical §11.1 event types.)
    return { kind: "image", b64: r.base64, mimeType: `image/${r.format}` };
  },
});
