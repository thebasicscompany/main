// CLOUD-AGENT-PLAN §9.4 + BUILD-LOOP D.4 — skill decay job.
// Once-a-day cron that demotes stale skills (last_edited_at older than
// `unverifiedAfterDays`) by setting active=false; the loader (D.3) already
// filters on active=true, so demoted rows stop appearing in the prompt.
//
// "Archived unread > 90 day flows" from the spec is deferred — we don't
// track per-skill read counts yet (would need a join against agent_activity
// payload->>'skillId'); see deviations.

import postgres from "postgres";

export interface DecayResult {
  demoted: number;
  /** Reserved — currently 0; archive-by-unread lands when read counts ship. */
  archived: number;
}

export interface SkillDecayJob {
  runOnce(input: { workspaceId?: string; now?: Date }): Promise<DecayResult>;
}

export interface SkillDecayOptions {
  /** Skills last edited > this many days ago get active=false. Default 30. */
  unverifiedAfterDays?: number;
}

const DEFAULT_UNVERIFIED_DAYS = 30;

/** Production — UPDATE against public.skills. */
export class PgSkillDecayJob implements SkillDecayJob {
  private sql: ReturnType<typeof postgres>;
  private threshold: number;
  constructor(opts: { databaseUrl: string } & SkillDecayOptions) {
    this.sql = postgres(opts.databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
    this.threshold = opts.unverifiedAfterDays ?? DEFAULT_UNVERIFIED_DAYS;
  }

  async runOnce(input: { workspaceId?: string; now?: Date } = {}): Promise<DecayResult> {
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - this.threshold * 24 * 60 * 60 * 1000);
    // last_edited_at is nullable on the existing schema → fall back to created_at.
    if (input.workspaceId) {
      const rows = await this.sql<Array<{ id: string }>>`
        UPDATE public.skills
           SET active = false,
               updated_at = ${now}
         WHERE workspace_id = ${input.workspaceId}
           AND active = true
           AND pending_review = false
           AND coalesce(last_edited_at, created_at) < ${cutoff}
         RETURNING id
      `;
      return { demoted: rows.length, archived: 0 };
    }
    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE public.skills
         SET active = false,
             updated_at = ${now}
       WHERE active = true
         AND pending_review = false
         AND coalesce(last_edited_at, created_at) < ${cutoff}
       RETURNING id
    `;
    return { demoted: rows.length, archived: 0 };
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

interface InMemoryDecayRow {
  id: string;
  workspaceId: string;
  active: boolean;
  pendingReview: boolean;
  lastEditedAt: Date | null;
  createdAt: Date;
}

/** Tests + dry-runs. */
export class InMemorySkillDecayJob implements SkillDecayJob {
  readonly rows: InMemoryDecayRow[] = [];
  private threshold: number;
  constructor(opts: SkillDecayOptions = {}) {
    this.threshold = opts.unverifiedAfterDays ?? DEFAULT_UNVERIFIED_DAYS;
  }

  add(row: {
    id: string;
    workspaceId: string;
    active?: boolean;
    pendingReview?: boolean;
    lastEditedAt?: Date | null;
    createdAt?: Date;
  }): void {
    this.rows.push({
      active: row.active ?? true,
      pendingReview: row.pendingReview ?? false,
      lastEditedAt: row.lastEditedAt ?? null,
      createdAt: row.createdAt ?? new Date(),
      ...row,
    });
  }

  async runOnce(input: { workspaceId?: string; now?: Date } = {}): Promise<DecayResult> {
    const now = input.now ?? new Date();
    const cutoff = new Date(now.getTime() - this.threshold * 24 * 60 * 60 * 1000);
    let demoted = 0;
    for (const r of this.rows) {
      if (input.workspaceId && r.workspaceId !== input.workspaceId) continue;
      if (!r.active || r.pendingReview) continue;
      const stamp = r.lastEditedAt ?? r.createdAt;
      if (stamp < cutoff) {
        r.active = false;
        demoted++;
      }
    }
    return { demoted, archived: 0 };
  }
}
