// CLOUD-AGENT-PLAN §13 reconciliation — skills live in the DB `skills` table
// (existing schema). The skill_write tool inserts via this store.
//
// Existing schema (from list_tables verbose):
//   id, workspace_id, learned_by_agent_id, name, description, body,
//   requires_integrations text[], scope text default 'personal',
//   confidence numeric default 0.5, active bool default true,
//   pending_review bool default true, superseded_by uuid,
//   source_run_ids uuid[] default '{}', negative_example_run_ids uuid[],
//   created_by, last_edited_by, last_edited_at, created_at, updated_at, host

import postgres from "postgres";

export interface SkillInsert {
  workspaceId: string;
  name: string;
  description: string;
  body: string;
  host?: string;
  scope?: "personal" | "workspace" | "shared";
  requiresIntegrations?: ReadonlyArray<string>;
  sourceRunId?: string;
  /** Override pending_review default. Tests use false to mark approved upfront. */
  pendingReview?: boolean;
  confidence?: number;
}

export interface SkillRow {
  id: string;
  workspaceId: string;
  name: string;
  pendingReview: boolean;
  scope: string;
  host: string | null;
}

export interface SkillStore {
  insert(input: SkillInsert): Promise<SkillRow>;
}

/** Tests + dry-runs. */
export class InMemorySkillStore implements SkillStore {
  readonly rows: SkillRow[] = [];
  private nextId = 1;

  async insert(input: SkillInsert): Promise<SkillRow> {
    const id = `mem-${this.nextId++}`;
    const row: SkillRow = {
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      pendingReview: input.pendingReview ?? true,
      scope: input.scope ?? "personal",
      host: input.host ?? null,
    };
    this.rows.push(row);
    return row;
  }
}

/** Production INSERT into skills. */
export class PgSkillStore implements SkillStore {
  private sql: ReturnType<typeof postgres>;
  constructor(opts: { databaseUrl: string }) {
    this.sql = postgres(opts.databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
  }

  async insert(input: SkillInsert): Promise<SkillRow> {
    const rows = await this.sql<
      Array<{ id: string; workspace_id: string; name: string; pending_review: boolean; scope: string; host: string | null }>
    >`
      INSERT INTO public.cloud_skills
        (workspace_id, name, description, body, host, scope,
         requires_integrations, source_run_ids, pending_review, confidence)
      VALUES
        (${input.workspaceId},
         ${input.name},
         ${input.description},
         ${input.body},
         ${input.host ?? null},
         ${input.scope ?? "personal"},
         ${input.requiresIntegrations ?? []},
         ${input.sourceRunId ? [input.sourceRunId] : []},
         ${input.pendingReview ?? true},
         ${input.confidence ?? 0.5})
      RETURNING id, workspace_id, name, pending_review, scope, host
    `;
    const r = rows[0]!;
    return {
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      pendingReview: r.pending_review,
      scope: r.scope,
      host: r.host,
    };
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
