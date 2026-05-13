// B.6 — composio_list_tools tool.
//
// Two modes:
//   - `toolkit` provided  → return the cached tool list for that toolkit
//     (via B.4 PgComposioToolCache), shape:
//       { mode:'toolkit', toolkit, tools:[{slug,name,description,paramSchema}] }
//   - no toolkit          → return the slugs the workspace has connected
//     (via B.3 resolver), shape:
//       { mode:'toolkits', toolkits:[{slug, connectedAccountId}] }
//
// `query` filters by case-insensitive substring on slug + name + description.

import { defineTool } from "@basics/shared";
import { z } from "zod";
import type { ComposioTool } from "@basics/shared";
import type { WorkerToolContext } from "./context.js";

const ParamsSchema = z.object({
  toolkit: z.string().min(1).max(120).optional(),
  query: z.string().min(1).max(200).optional(),
});

interface ListedTool {
  slug: string;
  name?: string;
  description?: string;
  paramSchema?: unknown;
}

function shapeTool(t: ComposioTool): ListedTool {
  // Composio's /tools response has at least one of input_schema /
  // parameters / schema depending on the endpoint version — pick the
  // first non-empty in that order.
  const paramSchema = t.input_schema ?? t.parameters ?? t.schema ?? null;
  const out: ListedTool = { slug: t.slug };
  if (t.name) out.name = t.name;
  if (t.description) out.description = t.description;
  if (paramSchema !== null && paramSchema !== undefined) out.paramSchema = paramSchema;
  return out;
}

function matchesQuery(t: ListedTool, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    (t.slug ?? "").toLowerCase().includes(needle) ||
    (t.name ?? "").toLowerCase().includes(needle) ||
    (t.description ?? "").toLowerCase().includes(needle)
  );
}

export const composio_list_tools = defineTool({
  name: "composio_list_tools",
  description:
    "List Composio tools for the workspace. With `toolkit` set, returns that toolkit's tool catalogue (slug + name + description + paramSchema). Without `toolkit`, returns the toolkits the workspace has connected. `query` is an optional case-insensitive substring filter against slug/name/description. Tool results come from a 1-hour Postgres cache.",
  params: ParamsSchema,
  mutating: false,
  cost: "low",
  execute: async (input, ctx: WorkerToolContext) => {
    const { toolkit, query } = ParamsSchema.parse(input);

    if (!ctx.composio) {
      // The opencode-plugin populates ctx.composio at session boot. Missing
      // = the plugin didn't initialise (e.g. running in a stripped test
      // harness). Surface as a structured error, don't crash the run.
      return {
        kind: "json" as const,
        json: {
          ok: false,
          error: { code: "composio_unavailable", message: "Composio context not initialised" },
        },
      };
    }
    const { accountsByToolkit, cache } = ctx.composio;

    if (!toolkit) {
      const toolkits = Array.from(accountsByToolkit.entries())
        .map(([slug, acc]) => ({ slug, connectedAccountId: acc.id }))
        .sort((a, b) => a.slug.localeCompare(b.slug));
      return {
        kind: "json" as const,
        json: { mode: "toolkits", toolkits, count: toolkits.length },
      };
    }

    // Toolkit mode: require the cache. Slug comparison is case-insensitive
    // — Composio returns slugs lowercase but agents sometimes pass UPPER.
    if (!cache) {
      return {
        kind: "json" as const,
        json: {
          ok: false,
          error: { code: "cache_unavailable", message: "ctx.composio.cache missing" },
        },
      };
    }
    const normalizedToolkit = toolkit.toLowerCase();
    const rawTools = await cache.getCachedTools(
      ctx.workspaceId,
      normalizedToolkit,
    );
    const shaped = rawTools.map(shapeTool);
    const filtered = query ? shaped.filter((t) => matchesQuery(t, query)) : shaped;

    return {
      kind: "json" as const,
      json: {
        mode: "toolkit",
        toolkit: normalizedToolkit,
        count: filtered.length,
        totalBeforeFilter: shaped.length,
        tools: filtered,
      },
    };
  },
});
