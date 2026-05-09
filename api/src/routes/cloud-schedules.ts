/**
 * /v1/schedules — cloud-agent cron CRUD (Phase H follow-up).
 *
 * Each schedule fires the basics-cron-kicker Lambda, which mints a
 * fresh runId, INSERTs agent_runs, and SQS-sends to basics-runs.fifo.
 *
 *   POST   /v1/schedules                            — create / update
 *   GET    /v1/schedules/:cloudAgentId              — describe
 *   PATCH  /v1/schedules/:cloudAgentId              — update cron / payload
 *   DELETE /v1/schedules/:cloudAgentId              — remove
 *   POST   /v1/schedules/:cloudAgentId/test         — fire one-shot via SQS
 *
 * All routes require workspace JWT and verify cloud_agents.workspace_id
 * matches the token. Cross-workspace 404.
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import {
  SchedulerClient,
  CreateScheduleCommand,
  GetScheduleCommand,
  UpdateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  ConflictException,
} from '@aws-sdk/client-scheduler'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { db } from '../db/index.js'
import { getConfig } from '../config.js'
import type { WorkspaceToken } from '../lib/jwt.js'

type Vars = { requestId: string; workspace: WorkspaceToken }

export const cloudSchedulesRoute = new Hono<{ Variables: Vars }>()

const UUID_RE = /^[0-9a-fA-F-]{36}$/
const REGION = process.env.AWS_REGION ?? 'us-east-1'

let _scheduler: SchedulerClient | null = null
function schedulerClient(): SchedulerClient {
  if (!_scheduler) _scheduler = new SchedulerClient({ region: REGION })
  return _scheduler
}
let _sqs: SQSClient | null = null
function sqsClient(): SQSClient {
  if (!_sqs) _sqs = new SQSClient({ region: REGION })
  return _sqs
}

function scheduleName(cloudAgentId: string): string {
  return `agent-${cloudAgentId}`
}

interface CloudAgentRow {
  id: string
  workspace_id: string
  account_id: string
  agent_id: string
  definition: string
}

async function requireCloudAgent(workspaceId: string, cloudAgentId: string): Promise<CloudAgentRow | null> {
  const rows = (await db.execute(sql`
    SELECT id, workspace_id::text AS workspace_id, account_id::text AS account_id,
           agent_id, definition
      FROM public.cloud_agents
     WHERE id = ${cloudAgentId} AND workspace_id = ${workspaceId}
     LIMIT 1
  `)) as unknown as CloudAgentRow[]
  return rows[0] ?? null
}

const createBodySchema = z.object({
  cloudAgentId: z.string().regex(UUID_RE),
  cron: z.string().min(3).max(256),
  goal: z.string().min(1).max(8000).optional(),
  vars: z.record(z.string(), z.string()).optional(),
  model: z.string().optional(),
  laneId: z.string().regex(UUID_RE).optional(),
})

function buildKickerInput(
  agent: CloudAgentRow,
  body: z.infer<typeof createBodySchema>,
): string {
  return JSON.stringify({
    cloudAgentId: agent.id,
    workspaceId: agent.workspace_id,
    accountId: agent.account_id,
    goal: body.goal ?? agent.definition,
    ...(body.vars ? { vars: body.vars } : {}),
    ...(body.model ? { model: body.model } : {}),
    ...(body.laneId ? { laneId: body.laneId } : {}),
  })
}

cloudSchedulesRoute.post(
  '/',
  zValidator('json', createBodySchema),
  async (c) => {
    const ws = c.var.workspace.workspace_id
    const body = c.req.valid('json')
    const agent = await requireCloudAgent(ws, body.cloudAgentId)
    if (!agent) return c.json({ error: 'not_found' }, 404)

    const cfg = getConfig()
    if (!cfg.CRON_KICKER_LAMBDA_ARN || !cfg.SCHEDULER_INVOKE_ROLE_ARN) {
      return c.json({ error: 'scheduler_not_configured' }, 503)
    }

    const name = scheduleName(agent.id)
    const target = {
      Arn: cfg.CRON_KICKER_LAMBDA_ARN,
      RoleArn: cfg.SCHEDULER_INVOKE_ROLE_ARN,
      Input: buildKickerInput(agent, body),
    }
    const params = {
      Name: name,
      GroupName: 'default',
      ScheduleExpression: body.cron,
      State: 'ENABLED' as const,
      FlexibleTimeWindow: { Mode: 'OFF' as const },
      Target: target,
    }

    let scheduleArn: string | undefined
    try {
      const out = await schedulerClient().send(new CreateScheduleCommand(params))
      scheduleArn = out.ScheduleArn
    } catch (err) {
      if (err instanceof ConflictException) {
        // Already exists — update instead.
        await schedulerClient().send(new UpdateScheduleCommand(params))
        const got = await schedulerClient().send(new GetScheduleCommand({ Name: name, GroupName: 'default' }))
        scheduleArn = got.Arn
      } else {
        throw err
      }
    }
    if (!scheduleArn) return c.json({ error: 'scheduler_unknown' }, 502)

    await db.execute(sql`
      UPDATE public.cloud_agents
         SET schedule = ${body.cron},
             eventbridge_schedule_arn = ${scheduleArn},
             updated_at = now()
       WHERE id = ${agent.id} AND workspace_id = ${ws}
    `)
    return c.json({ scheduleArn, scheduleName: name, cron: body.cron }, 201)
  },
)

cloudSchedulesRoute.get('/:cloudAgentId', async (c) => {
  const cloudAgentId = c.req.param('cloudAgentId')
  if (!UUID_RE.test(cloudAgentId)) return c.json({ error: 'invalid_id' }, 400)
  const ws = c.var.workspace.workspace_id
  const agent = await requireCloudAgent(ws, cloudAgentId)
  if (!agent) return c.json({ error: 'not_found' }, 404)
  const name = scheduleName(cloudAgentId)
  try {
    const got = await schedulerClient().send(new GetScheduleCommand({ Name: name, GroupName: 'default' }))
    const persistedRows = (await db.execute(sql`
      SELECT eventbridge_schedule_arn AS arn, schedule
        FROM public.cloud_agents
       WHERE id = ${cloudAgentId} AND workspace_id = ${ws}
       LIMIT 1
    `)) as unknown as Array<{ arn: string | null; schedule: string }>
    return c.json({
      scheduleName: name,
      aws: {
        exists: true,
        state: got.State,
        expression: got.ScheduleExpression,
      },
      persistedArn: persistedRows[0]?.arn ?? null,
      persistedCron: persistedRows[0]?.schedule ?? null,
    })
  } catch (err) {
    if (err instanceof ResourceNotFoundException) {
      return c.json({ scheduleName: name, aws: { exists: false }, persistedArn: null }, 200)
    }
    throw err
  }
})

cloudSchedulesRoute.patch(
  '/:cloudAgentId',
  zValidator('json', z.object({
    cron: z.string().min(3).max(256).optional(),
    goal: z.string().min(1).max(8000).optional(),
    vars: z.record(z.string(), z.string()).optional(),
    model: z.string().optional(),
    laneId: z.string().regex(UUID_RE).optional(),
  })),
  async (c) => {
    const cloudAgentId = c.req.param('cloudAgentId')
    if (!UUID_RE.test(cloudAgentId)) return c.json({ error: 'invalid_id' }, 400)
    const ws = c.var.workspace.workspace_id
    const agent = await requireCloudAgent(ws, cloudAgentId)
    if (!agent) return c.json({ error: 'not_found' }, 404)

    const cfg = getConfig()
    if (!cfg.CRON_KICKER_LAMBDA_ARN || !cfg.SCHEDULER_INVOKE_ROLE_ARN) {
      return c.json({ error: 'scheduler_not_configured' }, 503)
    }

    const name = scheduleName(cloudAgentId)
    const persistedRows = (await db.execute(sql`
      SELECT schedule FROM public.cloud_agents
       WHERE id = ${cloudAgentId} AND workspace_id = ${ws}
       LIMIT 1
    `)) as unknown as Array<{ schedule: string }>
    const cron = c.req.valid('json').cron ?? persistedRows[0]?.schedule ?? 'rate(1 hour)'

    const fullBody = {
      cloudAgentId,
      cron,
      goal: c.req.valid('json').goal,
      vars: c.req.valid('json').vars,
      model: c.req.valid('json').model,
      laneId: c.req.valid('json').laneId,
    }
    await schedulerClient().send(new UpdateScheduleCommand({
      Name: name,
      GroupName: 'default',
      ScheduleExpression: cron,
      State: 'ENABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: cfg.CRON_KICKER_LAMBDA_ARN,
        RoleArn: cfg.SCHEDULER_INVOKE_ROLE_ARN,
        Input: buildKickerInput(agent, fullBody),
      },
    }))
    if (c.req.valid('json').cron) {
      await db.execute(sql`
        UPDATE public.cloud_agents
           SET schedule = ${cron}, updated_at = now()
         WHERE id = ${cloudAgentId} AND workspace_id = ${ws}
      `)
    }
    return c.json({ scheduleName: name, cron, updated: true })
  },
)

cloudSchedulesRoute.delete('/:cloudAgentId', async (c) => {
  const cloudAgentId = c.req.param('cloudAgentId')
  if (!UUID_RE.test(cloudAgentId)) return c.json({ error: 'invalid_id' }, 400)
  const ws = c.var.workspace.workspace_id
  const agent = await requireCloudAgent(ws, cloudAgentId)
  if (!agent) return c.json({ error: 'not_found' }, 404)
  const name = scheduleName(cloudAgentId)
  try {
    await schedulerClient().send(new DeleteScheduleCommand({ Name: name, GroupName: 'default' }))
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err
    // already gone — fall through to clear the persisted ARN
  }
  await db.execute(sql`
    UPDATE public.cloud_agents
       SET eventbridge_schedule_arn = NULL,
           updated_at = now()
     WHERE id = ${cloudAgentId} AND workspace_id = ${ws}
  `)
  return c.json({ scheduleName: name, deleted: true })
})

cloudSchedulesRoute.post(
  '/:cloudAgentId/test',
  zValidator('json', z.object({
    goal: z.string().min(1).max(8000).optional(),
    vars: z.record(z.string(), z.string()).optional(),
    model: z.string().optional(),
    laneId: z.string().regex(UUID_RE).optional(),
  })),
  async (c) => {
    const cloudAgentId = c.req.param('cloudAgentId')
    if (!UUID_RE.test(cloudAgentId)) return c.json({ error: 'invalid_id' }, 400)
    const ws = c.var.workspace.workspace_id
    const agent = await requireCloudAgent(ws, cloudAgentId)
    if (!agent) return c.json({ error: 'not_found' }, 404)
    const body = c.req.valid('json')

    const cfg = getConfig()
    if (!cfg.RUNS_QUEUE_URL) return c.json({ error: 'runs_queue_not_configured' }, 503)

    const runId = randomUUID()
    let goal = body.goal ?? agent.definition
    for (const [k, v] of Object.entries(body.vars ?? {})) {
      goal = goal.replaceAll(`{${k}}`, v)
    }
    await db.execute(sql`
      INSERT INTO public.cloud_runs
        (id, cloud_agent_id, workspace_id, account_id, status, run_mode)
      VALUES
        (${runId}, ${agent.id}, ${ws}, ${agent.account_id}, 'pending', 'live')
    `)
    await sqsClient().send(new SendMessageCommand({
      QueueUrl: cfg.RUNS_QUEUE_URL,
      MessageBody: JSON.stringify({
        runId, workspaceId: ws, accountId: agent.account_id,
        goal,
        ...(body.model ? { model: body.model } : {}),
      }),
      MessageGroupId: `${ws}:${body.laneId ?? 'default'}`,
      MessageDeduplicationId: runId,
    }))
    return c.json({ runId, status: 'pending', cloudAgentId }, 202)
  },
)
