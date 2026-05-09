import { defineTool } from "@basics/shared";
import { press_key as harnessPressKey, Modifiers } from "@basics/harness";
import { z } from "zod";
import type { WorkerToolContext } from "./context.js";

const MODIFIER_NAMES = ["alt", "ctrl", "meta", "shift"] as const;

export const press_key = defineTool({
  name: "press_key",
  description: "Press a single key (e.g. 'Enter', 'a', 'ArrowDown') with optional modifier flags. For typing strings, prefer type_text.",
  params: z.object({
    key: z.string().min(1),
    modifiers: z.array(z.enum(MODIFIER_NAMES)).optional(),
  }),
  mutating: true,
  cost: "low",
  execute: async ({ key, modifiers }, ctx: WorkerToolContext) => {
    let mask = 0;
    for (const m of modifiers ?? []) {
      if (m === "alt") mask |= Modifiers.Alt;
      else if (m === "ctrl") mask |= Modifiers.Ctrl;
      else if (m === "meta") mask |= Modifiers.Meta;
      else if (m === "shift") mask |= Modifiers.Shift;
    }
    await harnessPressKey(ctx.session, key, mask);
    return { kind: "text", text: `pressed ${key}` };
  },
});
