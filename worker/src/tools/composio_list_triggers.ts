// J.5 — composio_list_triggers tool.
//
// Mirrors composio_list_tools but queries Composio's /triggers_types
// endpoint (trigger event catalog) rather than /tools (action catalog).
// The authoring agent calls this when building a draft automation whose
// trigger is a `composio_webhook` — without it, the agent has to guess
// trigger slugs from training-time knowledge and gets them wrong (see
// J.5/J.6/J.7 incidents on the LP Mapper authoring flow).
//
// Two modes:
//   - `toolkit` provided → returns trigger event types for that toolkit
//     with their slug + name + description + config schema (required
//     fields + property schemas) + payload schema (so the agent knows
//     what fields are emitted when the trigger fires).
//   - `slug` provided → returns full schema for a specific trigger.
//
// Hits Composio's API directly (uncached for now — the catalog is small).

import { defineTool } from "@basics/shared";
import { z } from "zod";
import { ComposioClient } from "@basics/shared";
import type { ComposioTriggerType } from "@basics/shared";
import type { WorkerToolContext } from "./context.js";

const ParamsSchema = z.object({
  toolkit: z.string().min(1).max(120).optional(),
  query: z.string().min(1).max(200).optional(),
  slug: z.string().min(1).max(200).optional(),
});

interface ListedTriggerType {
  slug: string;
  name?: string;
  description?: string;
  type?: string;
  toolkit?: string;
  configRequired?: string[];
  configProperties?: Record<string, unknown>;
  payloadProperties?: Record<string, unknown>;
}

function shape(t: ComposioTriggerType): ListedTriggerType {
  const out: ListedTriggerType = { slug: t.slug };
  if (t.name) out.name = t.name;
  if (t.description) out.description = t.description;
  if (t.type) out.type = t.type;
  if (t.toolkit?.slug) out.toolkit = t.toolkit.slug;
  if (t.config?.required) out.configRequired = t.config.required;
  if (t.config?.properties) out.configProperties = t.config.properties;
  if (t.payload?.properties) out.payloadProperties = t.payload.properties;
  return out;
}

function matchesQuery(t: ListedTriggerType, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    t.slug.toLowerCase().includes(needle) ||
    (t.name ?? "").toLowerCase().includes(needle) ||
    (t.description ?? "").toLowerCase().includes(needle)
  );
}

export const composio_list_triggers = defineTool({
  name: "composio_list_triggers",
  description:
    "List Composio trigger event types (DIFFERENT from composio_list_tools, which lists actions). Use this when building an automation whose `triggers[]` includes a `composio_webhook` — call this FIRST to discover the real trigger slug + the required config fields, then pass them as `filters` in propose_automation. With `toolkit` set, lists all trigger types for that toolkit. With `slug` set, returns the full schema (config + payload) for one trigger. `query` is an optional substring filter on slug/name/description.",
  params: ParamsSchema,
  mutating: false,
  cost: "low",
  execute: async (input, _ctx: WorkerToolContext) => {
    const { toolkit, query, slug } = ParamsSchema.parse(input);
    const client = new ComposioClient();

    if (slug) {
      const { raw } = await client.getTriggerType(slug);
      if (!raw) {
        return {
          kind: "json" as const,
          json: {
            ok: false,
            error: {
              code: "trigger_type_not_found",
              message: `Composio has no trigger type with slug "${slug}". Use the toolkit-mode call (composio_list_triggers with {toolkit:'...'} ) to discover real slugs.`,
              slug,
            },
          },
        };
      }
      return {
        kind: "json" as const,
        json: { mode: "single", trigger: shape(raw) },
      };
    }

    if (!toolkit) {
      return {
        kind: "json" as const,
        json: {
          ok: false,
          error: {
            code: "missing_argument",
            message: "Pass either {toolkit:'<slug>'} to list all trigger types for a toolkit, or {slug:'<full_slug>'} to get a single one.",
          },
        },
      };
    }

    const normalized = toolkit.toLowerCase();
    const types = await client.listTriggerTypes({ toolkitSlug: normalized });
    const shaped = types.map(shape);
    const filtered = query ? shaped.filter((t) => matchesQuery(t, query)) : shaped;
    return {
      kind: "json" as const,
      json: {
        mode: "toolkit",
        toolkit: normalized,
        count: filtered.length,
        totalBeforeFilter: shaped.length,
        triggers: filtered,
      },
    };
  },
});
