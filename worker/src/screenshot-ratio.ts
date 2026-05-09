// CLOUD-AGENT-PLAN §9.5 + BUILD-LOOP D.5 — screenshot-ratio metric.
// Per-run ratio = (count of agent_activity rows where activity_type =
// 'screenshot' OR (activity_type = 'tool_call_start' AND
// payload->>'tool' = 'screenshot')) / (count of all tool_call_start rows).
// Workspace-rolling: average ratio over the last N runs ordered by
// agent_runs.started_at DESC.

import postgres from "postgres";

export interface RunRatio {
  runId: string;
  totalToolCalls: number;
  screenshotCalls: number;
  ratio: number; // 0..1
}

interface ActivityRowLike {
  agent_run_id: string;
  activity_type: string;
  payload?: { tool?: string };
}

export function computeRunRatio(
  runId: string,
  rows: ReadonlyArray<ActivityRowLike>,
): RunRatio {
  let total = 0;
  let screenshots = 0;
  for (const r of rows) {
    if (r.agent_run_id !== runId) continue;
    if (r.activity_type === "tool_call_start") {
      total++;
      if (r.payload?.tool === "screenshot") screenshots++;
    } else if (r.activity_type === "screenshot") {
      // Standalone screenshot event (the runner emits one per screenshot
      // tool call with the s3Key payload). Counted as a screenshot only —
      // not a tool call — to avoid double-counting.
    }
  }
  return {
    runId,
    totalToolCalls: total,
    screenshotCalls: screenshots,
    ratio: total === 0 ? 0 : screenshots / total,
  };
}

export interface ScreenshotRatioStore {
  forRun(runId: string): Promise<RunRatio>;
  forWorkspaceLastN(workspaceId: string, n: number): Promise<{
    runs: ReadonlyArray<RunRatio>;
    avg: number;
  }>;
}

export class PgScreenshotRatioStore implements ScreenshotRatioStore {
  private sql: ReturnType<typeof postgres>;
  constructor(opts: { databaseUrl: string }) {
    this.sql = postgres(opts.databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
  }

  async forRun(runId: string): Promise<RunRatio> {
    const rows = await this.sql<Array<{ total: number; screenshots: number }>>`
      SELECT
        COUNT(*) FILTER (WHERE activity_type = 'tool_call_start')::int AS total,
        COUNT(*) FILTER (
          WHERE activity_type = 'tool_call_start'
            AND payload->>'tool' = 'screenshot'
        )::int AS screenshots
      FROM public.agent_activity
      WHERE agent_run_id = ${runId}
    `;
    const r = rows[0]!;
    return {
      runId,
      totalToolCalls: r.total,
      screenshotCalls: r.screenshots,
      ratio: r.total === 0 ? 0 : r.screenshots / r.total,
    };
  }

  async forWorkspaceLastN(workspaceId: string, n: number): Promise<{
    runs: ReadonlyArray<RunRatio>;
    avg: number;
  }> {
    const rows = await this.sql<
      Array<{ run_id: string; total: number; screenshots: number }>
    >`
      WITH recent AS (
        SELECT id
          FROM public.agent_runs
         WHERE workspace_id = ${workspaceId}
           AND started_at IS NOT NULL
         ORDER BY started_at DESC
         LIMIT ${n}
      )
      SELECT
        a.agent_run_id AS run_id,
        COUNT(*) FILTER (WHERE a.activity_type = 'tool_call_start')::int AS total,
        COUNT(*) FILTER (
          WHERE a.activity_type = 'tool_call_start'
            AND a.payload->>'tool' = 'screenshot'
        )::int AS screenshots
      FROM public.agent_activity a
      JOIN recent r ON r.id = a.agent_run_id
      GROUP BY a.agent_run_id
    `;
    const runs = rows.map<RunRatio>((r) => ({
      runId: r.run_id,
      totalToolCalls: r.total,
      screenshotCalls: r.screenshots,
      ratio: r.total === 0 ? 0 : r.screenshots / r.total,
    }));
    const nonzero = runs.filter((r) => r.totalToolCalls > 0);
    const avg =
      nonzero.length === 0 ? 0 : nonzero.reduce((s, r) => s + r.ratio, 0) / nonzero.length;
    return { runs, avg };
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

/** D.5 verify helper — given two RunRatios, return the % drop from a→b. */
export function ratioDropPct(a: RunRatio, b: RunRatio): number {
  if (a.ratio === 0) return 0;
  return (a.ratio - b.ratio) / a.ratio;
}
