// B.4 — Postgres-backed schema-discovery cache for Composio toolkits.
//
// Composio's /tools endpoint is rate-limited and slow (~500ms+ per
// toolkit). Persist the result per (workspaceId, toolkitSlug) into
// `composio_tool_cache` (created in B.2) with a 1-hour TTL. Cache miss
// or expired entry triggers a write-through refresh.
//
// `invalidateCache` is called by composio_call (B.7) when Composio
// returns a schema-mismatch error — the cached schema is stale, drop it
// and refetch on the next read.

import type postgres from "postgres";
import { ComposioClient, type ComposioTool } from "@basics/shared";

export const CACHE_TTL_MS = 60 * 60 * 1000;

/**
 * Exposed only for tests — the production opencode-plugin instantiates
 * `new PgComposioToolCache({ sql: quotaSql })` directly.
 */
export interface ComposioToolCacheDeps {
  sql: ReturnType<typeof postgres>;
  /** Test seam. In production a real ComposioClient is constructed lazily. */
  client?: Pick<ComposioClient, "listTools">;
  /** Test seam for TTL / age math. */
  now?: () => number;
}

interface CacheRow {
  tools_json: ComposioTool[];
  fetched_at: Date | string;
}

export class PgComposioToolCache {
  constructor(private readonly deps: ComposioToolCacheDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private buildClient(): Pick<ComposioClient, "listTools"> {
    return this.deps.client ?? new ComposioClient();
  }

  /**
   * Cache-hit returns within-TTL rows from composio_tool_cache.
   * Miss/expired triggers refreshCache() which writes through.
   */
  async getCachedTools(
    workspaceId: string,
    toolkitSlug: string,
  ): Promise<ComposioTool[]> {
    const rows = await this.deps.sql<CacheRow[]>`
      SELECT tools_json, fetched_at
        FROM public.composio_tool_cache
       WHERE workspace_id = ${workspaceId} AND toolkit_slug = ${toolkitSlug}
       LIMIT 1
    `;
    const row = rows[0];
    if (row) {
      const fetchedMs = new Date(row.fetched_at).getTime();
      if (this.now() - fetchedMs < CACHE_TTL_MS) {
        return Array.isArray(row.tools_json) ? row.tools_json : [];
      }
    }
    return this.refreshCache(workspaceId, toolkitSlug);
  }

  /** Force-refresh: always calls Composio and writes through. */
  async refreshCache(
    workspaceId: string,
    toolkitSlug: string,
  ): Promise<ComposioTool[]> {
    const tools = await this.buildClient().listTools({ toolkitSlug });
    // postgres-js: use `sql.json(value)` for jsonb columns. The earlier
    // `${JSON.stringify(value)}::jsonb` pattern double-encodes because
    // postgres-js stringifies the bound string parameter ONCE before the
    // cast, leaving a JSONB-typed string scalar instead of an array.
    await this.deps.sql`
      INSERT INTO public.composio_tool_cache
        (workspace_id, toolkit_slug, tools_json, schema_version, fetched_at)
      VALUES (
        ${workspaceId},
        ${toolkitSlug},
        ${this.deps.sql.json(tools as unknown as Parameters<typeof this.deps.sql.json>[0])},
        1,
        now()
      )
      ON CONFLICT (workspace_id, toolkit_slug) DO UPDATE
        SET tools_json     = EXCLUDED.tools_json,
            schema_version = EXCLUDED.schema_version,
            fetched_at     = now()
    `;
    return tools;
  }

  /** Drop a cached entry — used on schema-mismatch errors from composio_call. */
  async invalidateCache(
    workspaceId: string,
    toolkitSlug: string,
  ): Promise<void> {
    await this.deps.sql`
      DELETE FROM public.composio_tool_cache
       WHERE workspace_id = ${workspaceId} AND toolkit_slug = ${toolkitSlug}
    `;
  }
}
