import { defineTool } from "@basics/shared";
import { upload_file as harnessUploadFile } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

export const upload_file = defineTool({
  name: "upload_file",
  description: "Set a file <input> element's selected files. `paths` may be a single absolute path or array of paths. Files must exist inside /workspace.",
  params: z.object({
    selector: z.string().min(1),
    paths: z.union([z.string().min(1), z.array(z.string().min(1))]),
  }),
  mutating: true,
  cost: "low",
  execute: async ({ selector, paths }, ctx: WorkerToolContext) => {
    await harnessUploadFile(ctx.session, selector, paths);
    const count = Array.isArray(paths) ? paths.length : 1;
    return { kind: "text", text: `uploaded ${count} file(s) to ${selector}` };
  },
});
