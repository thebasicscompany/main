// CLOUD-AGENT-PLAN section 14 + BUILD-LOOP E.5 - schedule lifecycle.
// The api control-plane (other team's surface per section 0.1) calls this
// service to attach/detach EventBridge Scheduler entries to cloud_agents
// rows. The service is a thin orchestrator: AwsSchedulerWrapper does the
// AWS work, cloud_agents.eventbridge_schedule_arn carries the resource id,
// cloud_agents.schedule holds the human-readable cron.

import postgres from "postgres";
import type { SchedulerWrapper, CreateScheduleInput } from "./eventbridge-scheduler.js";

export interface AttachScheduleInput {
  cloudAgentId: string;
  workspaceId: string;
  cron: string;
  timezone?: string;
  /** Optional override of the schedule name; default cloudAgentId. */
  scheduleName?: string;
  /** Run payload the SQS message body carries when the schedule fires. */
  payload: Record<string, unknown>;
  /** Lane id for the SQS group key; null falls back to the workspace default. */
  laneId?: string | null;
}

export interface ScheduleServiceOptions {
  wrapper: SchedulerWrapper;
  databaseUrl: string;
  /** SQS queue ARN the schedule fires into. */
  sqsQueueArn: string;
  /** IAM role EventBridge Scheduler assumes to invoke SQS. */
  invokeRoleArn: string;
}

export class CloudAgentNotFoundError extends Error {
  constructor(id: string) {
    super(`cloud_agent_not_found: ${id}`);
    this.name = "CloudAgentNotFoundError";
  }
}

function laneGroupKey(workspaceId: string, laneId: string | null | undefined): string {
  return `${workspaceId}:${laneId ?? "default"}`;
}

export class ScheduleService {
  private sql: ReturnType<typeof postgres>;
  constructor(private opts: ScheduleServiceOptions) {
    this.sql = postgres(opts.databaseUrl, { max: 1, prepare: false, idle_timeout: 5 });
  }

  /** Create or replace the schedule for a cloud_agent and persist the ARN. */
  async attach(input: AttachScheduleInput): Promise<{ scheduleArn: string; scheduleName: string }> {
    const name = input.scheduleName ?? input.cloudAgentId;
    const create: CreateScheduleInput = {
      name,
      cron: input.cron,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      sqsQueueArn: this.opts.sqsQueueArn,
      invokeRoleArn: this.opts.invokeRoleArn,
      payload: input.payload,
      messageGroupId: laneGroupKey(input.workspaceId, input.laneId),
    };

    // If a prior schedule exists for this cloud_agent, replace the row in
    // place via UpdateSchedule; otherwise create.
    const existing = await this.opts.wrapper.get(name);
    if (existing.exists) {
      await this.opts.wrapper.update(create);
    } else {
      await this.opts.wrapper.create(create);
    }
    // Re-fetch to capture the canonical ARN.
    const after = await this.opts.wrapper.get(name);
    if (!after.exists) {
      throw new Error(`schedule_attach_failed: ${name} did not appear after create/update`);
    }

    const rows = await this.sql<Array<{ id: string }>>`
      UPDATE public.cloud_agents
         SET schedule = ${input.cron},
             eventbridge_schedule_arn = ${`arn:aws:scheduler:::schedule/default/${name}`},
             updated_at = now()
       WHERE id = ${input.cloudAgentId} AND workspace_id = ${input.workspaceId}
       RETURNING id
    `;
    if (!rows[0]) throw new CloudAgentNotFoundError(input.cloudAgentId);

    return {
      scheduleArn: `arn:aws:scheduler:::schedule/default/${name}`,
      scheduleName: name,
    };
  }

  /** Tear down the schedule + clear the ARN on the cloud_agent row. */
  async detach(input: { cloudAgentId: string; workspaceId: string; scheduleName?: string }): Promise<void> {
    const name = input.scheduleName ?? input.cloudAgentId;
    await this.opts.wrapper.delete(name);
    await this.sql`
      UPDATE public.cloud_agents
         SET eventbridge_schedule_arn = NULL,
             updated_at = now()
       WHERE id = ${input.cloudAgentId} AND workspace_id = ${input.workspaceId}
    `;
  }

  /** Read-only — returns the live AWS state plus the persisted ARN, if any. */
  async describe(input: { cloudAgentId: string; workspaceId: string; scheduleName?: string }): Promise<{
    scheduleName: string;
    aws: { exists: boolean; state?: string; expression?: string };
    persistedArn: string | null;
  }> {
    const name = input.scheduleName ?? input.cloudAgentId;
    const aws = await this.opts.wrapper.get(name);
    const rows = await this.sql<Array<{ arn: string | null }>>`
      SELECT eventbridge_schedule_arn AS arn
        FROM public.cloud_agents
       WHERE id = ${input.cloudAgentId} AND workspace_id = ${input.workspaceId}
       LIMIT 1
    `;
    if (rows.length === 0) throw new CloudAgentNotFoundError(input.cloudAgentId);
    return { scheduleName: name, aws, persistedArn: rows[0]?.arn ?? null };
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
