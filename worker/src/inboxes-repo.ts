// CLOUD-AGENT-PLAN §10.3 + BUILD-LOOP E.3 — agent_inboxes CRUD.
// Intra-workspace messaging between lanes. The send_to_agent tool inserts
// into agent_inboxes; the receiving lane's worker reads unread on each
// poll tick and injects them into the next prompt context.

import postgres from "postgres";

export interface InboxMessage {
  id: string;
  toWorkspaceId: string;
  toLaneId: string | null;
  fromWorkspaceId: string;
  fromLaneId: string | null;
  body: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

export interface SendInput {
  toWorkspaceId: string;
  toLaneId?: string | null;
  fromWorkspaceId: string;
  fromLaneId?: string | null;
  body: Record<string, unknown>;
}

export class CrossWorkspaceMessageError extends Error {
  constructor() {
    super("cross_workspace_message_blocked: agent_inboxes is intra-workspace only (§10.3)");
    this.name = "CrossWorkspaceMessageError";
  }
}

export interface InboxesRepo {
  send(input: SendInput): Promise<InboxMessage>;
  listUnreadFor(input: { workspaceId: string; laneId?: string | null; limit?: number }): Promise<InboxMessage[]>;
  markRead(messageId: string): Promise<void>;
}

const DEFAULT_LIMIT = 50;

/** Tests + dry-runs. */
export class InMemoryInboxesRepo implements InboxesRepo {
  private rows: InboxMessage[] = [];
  private nextId = 1;

  async send(input: SendInput): Promise<InboxMessage> {
    if (input.fromWorkspaceId !== input.toWorkspaceId) {
      throw new CrossWorkspaceMessageError();
    }
    const msg: InboxMessage = {
      id: `mem-${this.nextId++}`,
      toWorkspaceId: input.toWorkspaceId,
      toLaneId: input.toLaneId ?? null,
      fromWorkspaceId: input.fromWorkspaceId,
      fromLaneId: input.fromLaneId ?? null,
      body: input.body,
      readAt: null,
      createdAt: new Date(),
    };
    this.rows.push(msg);
    return msg;
  }

  async listUnreadFor(input: {
    workspaceId: string;
    laneId?: string | null;
    limit?: number;
  }): Promise<InboxMessage[]> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const wanted = input.laneId ?? null;
    return this.rows
      .filter(
        (r) =>
          r.toWorkspaceId === input.workspaceId &&
          r.readAt === null &&
          // null laneId means "the workspace's default inbox"; only match
          // exactly to avoid cross-lane bleed.
          r.toLaneId === wanted,
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
  }

  async markRead(messageId: string): Promise<void> {
    const r = this.rows.find((r) => r.id === messageId);
    if (r && r.readAt === null) r.readAt = new Date();
  }
}

interface PgInboxRow {
  id: string;
  to_workspace_id: string;
  to_lane_id: string | null;
  from_workspace_id: string;
  from_lane_id: string | null;
  body: Record<string, unknown>;
  read_at: Date | null;
  created_at: Date;
}

function toMsg(r: PgInboxRow): InboxMessage {
  return {
    id: r.id,
    toWorkspaceId: r.to_workspace_id,
    toLaneId: r.to_lane_id,
    fromWorkspaceId: r.from_workspace_id,
    fromLaneId: r.from_lane_id,
    body: r.body,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

/** Production. */
export class PgInboxesRepo implements InboxesRepo {
  private sql: ReturnType<typeof postgres>;
  constructor(opts: { databaseUrl: string }) {
    this.sql = postgres(opts.databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
  }

  async send(input: SendInput): Promise<InboxMessage> {
    if (input.fromWorkspaceId !== input.toWorkspaceId) {
      throw new CrossWorkspaceMessageError();
    }
    const rows = await this.sql<PgInboxRow[]>`
      INSERT INTO public.cloud_inboxes
        (to_workspace_id, to_lane_id, from_workspace_id, from_lane_id, body)
      VALUES
        (${input.toWorkspaceId},
         ${input.toLaneId ?? null},
         ${input.fromWorkspaceId},
         ${input.fromLaneId ?? null},
         ${this.sql.json(input.body as unknown as Parameters<typeof this.sql.json>[0])})
      RETURNING id, to_workspace_id, to_lane_id, from_workspace_id, from_lane_id, body, read_at, created_at
    `;
    return toMsg(rows[0]!);
  }

  async listUnreadFor(input: {
    workspaceId: string;
    laneId?: string | null;
    limit?: number;
  }): Promise<InboxMessage[]> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const lane = input.laneId ?? null;
    const rows = await this.sql<PgInboxRow[]>`
      SELECT id, to_workspace_id, to_lane_id, from_workspace_id, from_lane_id, body, read_at, created_at
        FROM public.cloud_inboxes
       WHERE to_workspace_id = ${input.workspaceId}
         AND read_at IS NULL
         AND ${lane === null
           ? this.sql`to_lane_id IS NULL`
           : this.sql`to_lane_id = ${lane}`}
       ORDER BY created_at ASC
       LIMIT ${limit}
    `;
    return rows.map(toMsg);
  }

  async markRead(messageId: string): Promise<void> {
    await this.sql`
      UPDATE public.cloud_inboxes
         SET read_at = now()
       WHERE id = ${messageId} AND read_at IS NULL
    `;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
