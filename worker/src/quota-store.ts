// Per-workspace output-channel quota store. Backed by the
// `workspace_output_quotas` table + `increment_output_quota` SECURITY
// DEFINER function in Supabase (migration automations_a3_output_quotas).
//
// Send_email / send_sms / attach_artifact wrap their dispatch in
// `increment()`; a `false` return means the workspace has hit its
// daily cap and the tool should refuse without sending.

import type postgres from "postgres";

export type OutputChannel = "sms" | "email" | "artifact";

export interface QuotaStore {
  increment(
    workspaceId: string,
    channel: OutputChannel,
    cap: number,
  ): Promise<boolean>;
}

export class PgQuotaStore implements QuotaStore {
  constructor(private readonly sql: ReturnType<typeof postgres>) {}

  async increment(
    workspaceId: string,
    channel: OutputChannel,
    cap: number,
  ): Promise<boolean> {
    const rows = await this.sql<{ ok: boolean }[]>`
      SELECT public.increment_output_quota(${workspaceId}::uuid, ${channel}, ${cap}) AS ok
    `;
    return rows[0]?.ok === true;
  }
}

/** In-memory store for tests. cap defaults are per (workspace, channel). */
export class InMemoryQuotaStore implements QuotaStore {
  private counts = new Map<string, number>();

  reset(): void {
    this.counts.clear();
  }

  async increment(
    workspaceId: string,
    channel: OutputChannel,
    cap: number,
  ): Promise<boolean> {
    const key = `${workspaceId}:${channel}`;
    const current = this.counts.get(key) ?? 0;
    if (current >= cap) return false;
    this.counts.set(key, current + 1);
    return true;
  }
}
