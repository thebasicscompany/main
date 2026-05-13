import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { getConfig } from '../config.js'
import { db } from '../db/index.js'
import type { WorkspaceToken } from './jwt.js'

export const UUID_RE = /^[0-9a-fA-F-]{36}$/

let _sqs: SQSClient | null = null

function sqsClient(): SQSClient {
  if (!_sqs) _sqs = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
  return _sqs
}

export type DispatchCloudRunInput = {
  workspace: WorkspaceToken
  goal: string
  cloudAgentId?: string
  laneId?: string
  model?: string
  adHocDefinition?: string
}

export type DispatchCloudRunResult = {
  runId: string
  status: 'pending'
  cloudAgentId: string
  liveViewUrl: null
  eventsUrl: string
}

async function resolveCloudAgentId(input: {
  workspace: WorkspaceToken
  cloudAgentId?: string
  adHocDefinition: string
}): Promise<string | null> {
  const ws = input.workspace.workspace_id
  const acc = input.workspace.account_id

  if (input.cloudAgentId) {
    const rows = (await db.execute(sql`
      SELECT id FROM public.cloud_agents
       WHERE id = ${input.cloudAgentId} AND workspace_id = ${ws}
       LIMIT 1
    `)) as unknown as Array<{ id: string }>
    return rows[0]?.id ?? null
  }

  const existing = (await db.execute(sql`
    SELECT id FROM public.cloud_agents
     WHERE workspace_id = ${ws} AND agent_id = 'ad-hoc'
     LIMIT 1
  `)) as unknown as Array<{ id: string }>
  if (existing[0]) return existing[0].id

  const created = (await db.execute(sql`
    INSERT INTO public.cloud_agents
      (workspace_id, account_id, agent_id, definition, schedule, status, composio_user_id, runtime_mode)
    VALUES
      (${ws}, ${acc}, 'ad-hoc', ${input.adHocDefinition},
       'manual', 'active', ${ws}, 'harness')
    RETURNING id
  `)) as unknown as Array<{ id: string }>
  return created[0]!.id
}

export async function dispatchCloudRun(
  input: DispatchCloudRunInput,
): Promise<DispatchCloudRunResult | null> {
  const ws = input.workspace.workspace_id
  const acc = input.workspace.account_id
  const cloudAgentId = await resolveCloudAgentId({
    workspace: input.workspace,
    cloudAgentId: input.cloudAgentId,
    adHocDefinition:
      input.adHocDefinition ?? 'One-shot runs dispatched via POST /v1/runs',
  })
  if (!cloudAgentId) return null

  const runId = randomUUID()
  await db.execute(sql`
    INSERT INTO public.cloud_runs
      (id, cloud_agent_id, workspace_id, account_id, status, run_mode)
    VALUES
      (${runId}, ${cloudAgentId}, ${ws}, ${acc}, 'pending', 'live')
  `)

  const queueUrl = getConfig().RUNS_QUEUE_URL
  if (!queueUrl) {
    throw new Error('runs_queue_not_configured')
  }

  const groupId = `${ws}:${input.laneId ?? 'default'}`
  await sqsClient().send(new SendMessageCommand({
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({
      runId,
      workspaceId: ws,
      accountId: acc,
      goal: input.goal,
      ...(input.model ? { model: input.model } : {}),
    }),
    MessageGroupId: groupId,
    MessageDeduplicationId: runId,
  }))

  return {
    runId,
    status: 'pending',
    cloudAgentId,
    liveViewUrl: null,
    eventsUrl: `/v1/runs/${runId}/events`,
  }
}
