// agent_activity writer for the worker. CLOUD-AGENT-PLAN §13 reconciliation:
// `agent_activity` is the table the earlier draft called `run_events`.
// Worker uses the existing column names (activity_type / agent_run_id /
// created_at) — RLS lets the service role bypass; runs in-task via the
// task IAM role's DATABASE_URL_POOLER credential.

import postgres from "postgres";

interface PublisherOptions {
  databaseUrl: string;
  runId: string;
  workspaceId: string;
  accountId: string;
}

export interface RunEventBody {
  type: string;
  payload?: Record<string, unknown>;
  callHash?: string;
}

export class Publisher {
  private sql: ReturnType<typeof postgres>;
  constructor(private opts: PublisherOptions) {
    this.sql = postgres(opts.databaseUrl, {
      max: 1,
      prepare: false,
      idle_timeout: 5,
    });
  }

  async emit(event: RunEventBody): Promise<void> {
    // postgres-js's `sql.json` typing wants its narrow `JSONValue`; we
    // accept `Record<string, unknown>` from callers and trust them not
    // to put non-JSON values inside. Cast through `unknown` is fine.
    const payload = this.sql.json(
      (event.payload ?? {}) as unknown as Parameters<typeof this.sql.json>[0],
    );
    await this.sql`
      INSERT INTO public.cloud_activity
        (agent_run_id, workspace_id, account_id, activity_type, payload, call_hash)
      VALUES
        (${this.opts.runId},
         ${this.opts.workspaceId},
         ${this.opts.accountId},
         ${event.type},
         ${payload},
         ${event.callHash ?? null})
    `;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
