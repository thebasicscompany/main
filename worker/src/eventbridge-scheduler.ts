// CLOUD-AGENT-PLAN section 14 + BUILD-LOOP E.4 - EventBridge Scheduler wrapper.
// Per-workspace cron entries that fire run payloads into the basics-runs.fifo
// SQS queue. The control-plane api owns CRUD; this module is the consumer
// that creates / deletes the AWS Scheduler schedules.
//
// Schedule expression: cron(<min> <hr> <dom> <month> <dow> <year>) - note
// AWS Scheduler cron is NOT standard cron (6 fields, year required, dow
// uses ?, etc.). cronToAws() converts a 5-field expression to the AWS
// shape; pass-through if the input already includes 6 fields.

import {
  SchedulerClient,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  GetScheduleCommand,
  UpdateScheduleCommand,
  type GetScheduleCommandOutput,
} from "@aws-sdk/client-scheduler";

export interface CreateScheduleInput {
  /** Schedule name. Must match [A-Za-z0-9_.-]{1,64}. */
  name: string;
  /** 5-field cron expression (every-2-min etc.) OR AWS 6-field. */
  cron: string;
  /** IANA TZ. Default UTC. */
  timezone?: string;
  /** SQS queue ARN the run payload fires into. */
  sqsQueueArn: string;
  /** IAM role EventBridge Scheduler assumes to invoke SQS. */
  invokeRoleArn: string;
  /** SQS message body - typically the run job JSON. */
  payload: Record<string, unknown>;
  /** SQS FIFO MessageGroupId (FIFO queues require it). */
  messageGroupId: string;
}

const NAME_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

/**
 * Convert a 5-field standard cron (e.g. "* * * * *") to AWS's 6-field
 * form ("min hr day-of-month month day-of-week year"). AWS requires
 * exactly one of dom or dow to be a literal "?" (not both specific).
 */
export function cronToAws(input: string): string {
  const parts = input.trim().split(/\s+/);
  if (parts.length === 6) return input.trim();
  if (parts.length !== 5) {
    throw new Error(`invalid_cron: expected 5 fields, got ${parts.length}`);
  }
  let [min, hr, dom, month, dow] = parts as [string, string, string, string, string];
  if (dom === "*" && dow === "*") {
    dow = "?";
  } else if (dom !== "*" && dow !== "*") {
    dow = "?";
  } else if (dow === "*") {
    dow = "?";
  } else if (dom === "*") {
    dom = "?";
  }
  return `${min} ${hr} ${dom} ${month} ${dow} *`;
}

export interface SchedulerWrapper {
  create(input: CreateScheduleInput): Promise<{ scheduleArn: string }>;
  get(name: string): Promise<{ exists: boolean; state?: string; expression?: string }>;
  update(input: CreateScheduleInput): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface AwsSchedulerWrapperOptions {
  region: string;
  groupName?: string;
  client?: SchedulerClient;
}

const DEFAULT_GROUP = "default";

export class AwsSchedulerWrapper implements SchedulerWrapper {
  private client: SchedulerClient;
  private group: string;

  constructor(opts: AwsSchedulerWrapperOptions) {
    this.client = opts.client ?? new SchedulerClient({ region: opts.region });
    this.group = opts.groupName ?? DEFAULT_GROUP;
  }

  async create(input: CreateScheduleInput): Promise<{ scheduleArn: string }> {
    if (!NAME_RE.test(input.name)) {
      throw new Error(`invalid_schedule_name: ${input.name}`);
    }
    const expression = `cron(${cronToAws(input.cron)})`;
    const result = await this.client.send(
      new CreateScheduleCommand({
        Name: input.name,
        GroupName: this.group,
        ScheduleExpression: expression,
        ScheduleExpressionTimezone: input.timezone ?? "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        State: "ENABLED",
        Target: {
          Arn: input.sqsQueueArn,
          RoleArn: input.invokeRoleArn,
          Input: JSON.stringify(input.payload),
          SqsParameters: { MessageGroupId: input.messageGroupId },
        },
      }),
    );
    return { scheduleArn: result.ScheduleArn ?? "" };
  }

  async get(name: string): Promise<{ exists: boolean; state?: string; expression?: string }> {
    try {
      const r: GetScheduleCommandOutput = await this.client.send(
        new GetScheduleCommand({ Name: name, GroupName: this.group }),
      );
      return {
        exists: true,
        ...(r.State ? { state: r.State } : {}),
        ...(r.ScheduleExpression ? { expression: r.ScheduleExpression } : {}),
      };
    } catch (err) {
      if ((err as { name?: string }).name === "ResourceNotFoundException") {
        return { exists: false };
      }
      throw err;
    }
  }

  async update(input: CreateScheduleInput): Promise<void> {
    if (!NAME_RE.test(input.name)) {
      throw new Error(`invalid_schedule_name: ${input.name}`);
    }
    const expression = `cron(${cronToAws(input.cron)})`;
    await this.client.send(
      new UpdateScheduleCommand({
        Name: input.name,
        GroupName: this.group,
        ScheduleExpression: expression,
        ScheduleExpressionTimezone: input.timezone ?? "UTC",
        FlexibleTimeWindow: { Mode: "OFF" },
        State: "ENABLED",
        Target: {
          Arn: input.sqsQueueArn,
          RoleArn: input.invokeRoleArn,
          Input: JSON.stringify(input.payload),
          SqsParameters: { MessageGroupId: input.messageGroupId },
        },
      }),
    );
  }

  async delete(name: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteScheduleCommand({ Name: name, GroupName: this.group }),
      );
    } catch (err) {
      // Idempotent delete - ignore not-found.
      if ((err as { name?: string }).name !== "ResourceNotFoundException") throw err;
    }
  }
}
