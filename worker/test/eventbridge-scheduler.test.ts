// BUILD-LOOP E.4 — EventBridge Scheduler wrapper tests.

import { describe, expect, it } from "vitest";
import {
  AwsSchedulerWrapper,
  cronToAws,
} from "../src/eventbridge-scheduler.js";

describe("cronToAws", () => {
  it("converts 5-field '*/2 * * * *' to AWS 6-field with DOW=? (AWS convention when DOM is *)", () => {
    expect(cronToAws("*/2 * * * *")).toBe("*/2 * * * ? *");
  });

  it("disambiguates DOM-and-DOW-both-specified by stubbing DOW to ?", () => {
    expect(cronToAws("0 9 1 * 1")).toBe("0 9 1 * ? *");
  });

  it("DOM specified, DOW * -> DOW becomes ?", () => {
    expect(cronToAws("0 9 1 * *")).toBe("0 9 1 * ? *");
  });

  it("DOW specified, DOM * -> DOM becomes ?", () => {
    expect(cronToAws("0 9 * * 1")).toBe("0 9 ? * 1 *");
  });

  it("preserves an already-AWS-shaped 6-field input", () => {
    expect(cronToAws("0 9 ? * MON *")).toBe("0 9 ? * MON *");
  });

  it("throws on invalid field count", () => {
    expect(() => cronToAws("0 9 1 *")).toThrow(/invalid_cron/);
    expect(() => cronToAws("0 9 1 * * * *")).toThrow(/invalid_cron/);
  });
});

describe("AwsSchedulerWrapper — argv shape", () => {
  // Stub SchedulerClient so we capture the argv without hitting AWS.
  type SentCommand = { constructor: { name: string }; input: Record<string, unknown> };
  const stubClient = (
    behavior: (cmd: SentCommand) => unknown = () => ({}),
  ) => {
    const sent: SentCommand[] = [];
    const client = {
      send: async (cmd: SentCommand) => {
        sent.push(cmd);
        return behavior(cmd);
      },
    } as unknown as ConstructorParameters<typeof AwsSchedulerWrapper>[0]["client"];
    return { client, sent };
  };

  it("create issues a CreateScheduleCommand with cron(...) expression + SQS target + group key", async () => {
    const { client, sent } = stubClient(() => ({ ScheduleArn: "arn:aws:scheduler:us-east-1:1:schedule/default/foo" }));
    const w = new AwsSchedulerWrapper({ region: "us-east-1", client: client! });
    const r = await w.create({
      name: "ws-foo-every-2",
      cron: "*/2 * * * *",
      sqsQueueArn: "arn:aws:sqs:us-east-1:1:basics-runs.fifo",
      invokeRoleArn: "arn:aws:iam::1:role/basics-scheduler-invoke",
      payload: { runId: "abc", workspaceId: "ws-foo" },
      messageGroupId: "ws-foo:default",
    });
    expect(r.scheduleArn).toContain("schedule/default/foo");
    expect(sent).toHaveLength(1);
    const c = sent[0]!;
    expect(c.constructor.name).toBe("CreateScheduleCommand");
    expect(c.input.Name).toBe("ws-foo-every-2");
    expect(c.input.GroupName).toBe("default");
    expect(c.input.ScheduleExpression).toBe("cron(*/2 * * * ? *)");
    expect(c.input.ScheduleExpressionTimezone).toBe("UTC");
    expect(c.input.State).toBe("ENABLED");
    expect((c.input.FlexibleTimeWindow as { Mode: string }).Mode).toBe("OFF");
    const target = c.input.Target as Record<string, unknown>;
    expect(target.Arn).toBe("arn:aws:sqs:us-east-1:1:basics-runs.fifo");
    expect(target.RoleArn).toBe("arn:aws:iam::1:role/basics-scheduler-invoke");
    expect(JSON.parse(target.Input as string)).toEqual({ runId: "abc", workspaceId: "ws-foo" });
    expect((target.SqsParameters as { MessageGroupId: string }).MessageGroupId).toBe("ws-foo:default");
  });

  it("create rejects names that don't match the AWS Scheduler regex", async () => {
    const { client } = stubClient();
    const w = new AwsSchedulerWrapper({ region: "us-east-1", client: client! });
    await expect(
      w.create({
        name: "has spaces",
        cron: "*/2 * * * *",
        sqsQueueArn: "arn",
        invokeRoleArn: "arn",
        payload: {},
        messageGroupId: "g",
      }),
    ).rejects.toThrow(/invalid_schedule_name/);
  });

  it("custom timezone is forwarded", async () => {
    const { client, sent } = stubClient();
    const w = new AwsSchedulerWrapper({ region: "us-east-1", client: client! });
    await w.create({
      name: "tz-test",
      cron: "0 9 * * *",
      timezone: "America/Los_Angeles",
      sqsQueueArn: "arn",
      invokeRoleArn: "arn",
      payload: {},
      messageGroupId: "g",
    });
    expect(sent[0]?.input.ScheduleExpressionTimezone).toBe("America/Los_Angeles");
  });

  it("get returns {exists: false} when ResourceNotFoundException thrown", async () => {
    const { client } = stubClient(() => {
      const e = new Error("missing");
      (e as { name?: string }).name = "ResourceNotFoundException";
      throw e;
    });
    const w = new AwsSchedulerWrapper({ region: "us-east-1", client: client! });
    expect(await w.get("missing")).toEqual({ exists: false });
  });

  it("get returns state + expression on success", async () => {
    const { client } = stubClient(() => ({
      State: "ENABLED",
      ScheduleExpression: "cron(*/5 * * ? * *)",
    }));
    const w = new AwsSchedulerWrapper({ region: "us-east-1", client: client! });
    expect(await w.get("present")).toEqual({
      exists: true,
      state: "ENABLED",
      expression: "cron(*/5 * * ? * *)",
    });
  });

  it("delete is idempotent on ResourceNotFoundException", async () => {
    const { client } = stubClient(() => {
      const e = new Error("missing");
      (e as { name?: string }).name = "ResourceNotFoundException";
      throw e;
    });
    const w = new AwsSchedulerWrapper({ region: "us-east-1", client: client! });
    await expect(w.delete("missing")).resolves.toBeUndefined();
  });

  it("delete rethrows non-not-found errors", async () => {
    const { client } = stubClient(() => {
      const e = new Error("AccessDenied");
      (e as { name?: string }).name = "AccessDeniedException";
      throw e;
    });
    const w = new AwsSchedulerWrapper({ region: "us-east-1", client: client! });
    await expect(w.delete("forbidden")).rejects.toThrow(/AccessDenied/);
  });

  it("update issues UpdateScheduleCommand with the new shape", async () => {
    const { client, sent } = stubClient();
    const w = new AwsSchedulerWrapper({ region: "us-east-1", client: client! });
    await w.update({
      name: "u",
      cron: "0 12 * * *",
      sqsQueueArn: "arn",
      invokeRoleArn: "arn",
      payload: { v: 2 },
      messageGroupId: "g",
    });
    expect(sent[0]?.constructor.name).toBe("UpdateScheduleCommand");
    expect(sent[0]?.input.ScheduleExpression).toBe("cron(0 12 * * ? *)");
  });
});
