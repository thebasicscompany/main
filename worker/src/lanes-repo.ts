// CLOUD-AGENT-PLAN §10.2 + BUILD-LOOP E.1 — agent_lanes CRUD.
// Lanes are the multi-agent surface: a workspace can have lanes named
// 'ops' / 'research' / etc., each with its own opencode session and
// transcript. The dispatcher's SQS MessageGroupId is composed as
// `${workspaceId}:${laneId ?? 'default'}` so cross-lane traffic stays
// serialized within a lane but parallel across lanes.

import postgres from "postgres";

export interface Lane {
  id: string;
  workspaceId: string;
  name: string;
  defaultWorkflowId: string | null;
  defaultModel: string | null;
  status: "active" | "paused";
  createdAt: Date;
}

export interface CreateLaneInput {
  workspaceId: string;
  name: string;
  defaultWorkflowId?: string;
  defaultModel?: string;
}

export interface UpdateLaneInput {
  id: string;
  workspaceId: string;
  defaultWorkflowId?: string | null;
  defaultModel?: string | null;
  status?: "active" | "paused";
}

export class LaneNameTakenError extends Error {
  constructor(name: string) {
    super(`lane_name_taken: ${name}`);
    this.name = "LaneNameTakenError";
  }
}

export class LaneNotFoundError extends Error {
  constructor(id: string) {
    super(`lane_not_found: ${id}`);
    this.name = "LaneNotFoundError";
  }
}

export interface LanesRepo {
  create(input: CreateLaneInput): Promise<Lane>;
  list(workspaceId: string): Promise<Lane[]>;
  get(workspaceId: string, id: string): Promise<Lane | null>;
  update(input: UpdateLaneInput): Promise<Lane>;
  delete(workspaceId: string, id: string): Promise<void>;
}

/** Compose the SQS FIFO MessageGroupId per CLOUD-AGENT-PLAN §10.2. */
export function laneGroupKey(workspaceId: string, laneId: string | null | undefined): string {
  return `${workspaceId}:${laneId ?? "default"}`;
}

/** Tests + dry-runs. */
export class InMemoryLanesRepo implements LanesRepo {
  private rows = new Map<string, Lane>();
  private nextId = 1;

  async create(input: CreateLaneInput): Promise<Lane> {
    for (const r of this.rows.values()) {
      if (r.workspaceId === input.workspaceId && r.name === input.name) {
        throw new LaneNameTakenError(input.name);
      }
    }
    const id = `mem-${this.nextId++}`;
    const lane: Lane = {
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      defaultWorkflowId: input.defaultWorkflowId ?? null,
      defaultModel: input.defaultModel ?? null,
      status: "active",
      createdAt: new Date(),
    };
    this.rows.set(id, lane);
    return lane;
  }

  async list(workspaceId: string): Promise<Lane[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async get(workspaceId: string, id: string): Promise<Lane | null> {
    const lane = this.rows.get(id);
    if (!lane || lane.workspaceId !== workspaceId) return null;
    return lane;
  }

  async update(input: UpdateLaneInput): Promise<Lane> {
    const cur = this.rows.get(input.id);
    if (!cur || cur.workspaceId !== input.workspaceId) {
      throw new LaneNotFoundError(input.id);
    }
    const next: Lane = {
      ...cur,
      ...(input.defaultWorkflowId !== undefined ? { defaultWorkflowId: input.defaultWorkflowId } : {}),
      ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    };
    this.rows.set(input.id, next);
    return next;
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const cur = this.rows.get(id);
    if (!cur || cur.workspaceId !== workspaceId) {
      throw new LaneNotFoundError(id);
    }
    this.rows.delete(id);
  }
}

interface PgLaneRow {
  id: string;
  workspace_id: string;
  name: string;
  default_workflow_id: string | null;
  default_model: string | null;
  status: "active" | "paused";
  created_at: Date;
}

function toLane(r: PgLaneRow): Lane {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    name: r.name,
    defaultWorkflowId: r.default_workflow_id,
    defaultModel: r.default_model,
    status: r.status,
    createdAt: r.created_at,
  };
}

/** Production. */
export class PgLanesRepo implements LanesRepo {
  private sql: ReturnType<typeof postgres>;
  constructor(opts: { databaseUrl: string }) {
    this.sql = postgres(opts.databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
  }

  async create(input: CreateLaneInput): Promise<Lane> {
    try {
      const rows = await this.sql<PgLaneRow[]>`
        INSERT INTO public.cloud_lanes
          (workspace_id, name, default_workflow_id, default_model)
        VALUES
          (${input.workspaceId}, ${input.name},
           ${input.defaultWorkflowId ?? null},
           ${input.defaultModel ?? null})
        RETURNING id, workspace_id, name, default_workflow_id, default_model, status, created_at
      `;
      return toLane(rows[0]!);
    } catch (err) {
      // Unique violation on (workspace_id, name) → 23505.
      if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") {
        throw new LaneNameTakenError(input.name);
      }
      throw err;
    }
  }

  async list(workspaceId: string): Promise<Lane[]> {
    const rows = await this.sql<PgLaneRow[]>`
      SELECT id, workspace_id, name, default_workflow_id, default_model, status, created_at
        FROM public.cloud_lanes
       WHERE workspace_id = ${workspaceId}
       ORDER BY created_at ASC
    `;
    return rows.map(toLane);
  }

  async get(workspaceId: string, id: string): Promise<Lane | null> {
    const rows = await this.sql<PgLaneRow[]>`
      SELECT id, workspace_id, name, default_workflow_id, default_model, status, created_at
        FROM public.cloud_lanes
       WHERE workspace_id = ${workspaceId} AND id = ${id}
       LIMIT 1
    `;
    return rows[0] ? toLane(rows[0]) : null;
  }

  async update(input: UpdateLaneInput): Promise<Lane> {
    // Build a dynamic SET via two passes: collect non-undefined fields,
    // bail to a no-op SELECT if nothing changed.
    const sets: string[] = [];
    const values: unknown[] = [];
    if (input.defaultWorkflowId !== undefined) {
      sets.push("default_workflow_id");
      values.push(input.defaultWorkflowId);
    }
    if (input.defaultModel !== undefined) {
      sets.push("default_model");
      values.push(input.defaultModel);
    }
    if (input.status !== undefined) {
      sets.push("status");
      values.push(input.status);
    }
    let rows: PgLaneRow[];
    if (sets.length === 0) {
      rows = await this.sql<PgLaneRow[]>`
        SELECT id, workspace_id, name, default_workflow_id, default_model, status, created_at
          FROM public.cloud_lanes
         WHERE workspace_id = ${input.workspaceId} AND id = ${input.id}
         LIMIT 1
      `;
    } else if (sets.length === 1) {
      rows = await this.sql<PgLaneRow[]>`
        UPDATE public.cloud_lanes
           SET ${this.sql(sets[0]!)} = ${values[0] as never}
         WHERE workspace_id = ${input.workspaceId} AND id = ${input.id}
        RETURNING id, workspace_id, name, default_workflow_id, default_model, status, created_at
      `;
    } else {
      // Multi-field path — postgres-js's helper handles dynamic columns.
      const updates: Record<string, unknown> = {};
      sets.forEach((k, i) => { updates[k] = values[i]; });
      rows = await this.sql<PgLaneRow[]>`
        UPDATE public.cloud_lanes
           SET ${this.sql(updates)}
         WHERE workspace_id = ${input.workspaceId} AND id = ${input.id}
        RETURNING id, workspace_id, name, default_workflow_id, default_model, status, created_at
      `;
    }
    if (!rows[0]) throw new LaneNotFoundError(input.id);
    return toLane(rows[0]);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const rows = await this.sql<Array<{ id: string }>>`
      DELETE FROM public.cloud_lanes
       WHERE workspace_id = ${workspaceId} AND id = ${id}
       RETURNING id
    `;
    if (!rows[0]) throw new LaneNotFoundError(id);
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
