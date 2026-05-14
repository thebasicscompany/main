import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import { sql } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { getConfig } from '../config.js'
import { db } from '../db/index.js'
import type { WorkspaceToken } from './jwt.js'

export const UUID_RE = /^[0-9a-fA-F-]{36}$/

/**
 * J.2 — wrap an automation's goal text for a worker dispatch so the
 * agent EXECUTES the pipeline once instead of re-interpreting the spec
 * as a new authoring task.
 *
 * Background: automation goal text is typically written as a pipeline
 * description ("For each LP row in the sheet, do X then Y..."). Without
 * explicit framing, the worker agent treats it as a fresh design request
 * and either (a) calls propose_automation again (creating duplicates),
 * (b) lectures the user about tool limitations, or (c) refuses to act.
 * Surfaced on the J.1 LP-mapping live test: dry-run 84b72c5a recursed,
 * manual run 75000832 refused-with-limitations summary.
 *
 * `mode='dry'`  — every mutating outbound call is captured by the dry-run
 *                  interceptor; tells the agent that's expected.
 * `mode='live'` — mutating calls fire for real; tells the agent to be
 *                  careful and to follow approval prompts.
 *
 * Apply this wrap at EVERY dispatch site that sends `goal: automation.goal`
 * to SQS: manual /:id/run, /:id/dry-run, /draft-from-chat dry-run,
 * composio-webhook-triggered runs (D.5), schedule-fired runs (D.6).
 */
export function wrapAutomationGoal(
  automationName: string,
  goal: string,
  inputs: Record<string, unknown> | unknown,
  mode: 'dry' | 'live',
  triggeredBy?: string,
): string {
  const inputsJson = JSON.stringify(inputs ?? {}, null, 2)
  const header =
    mode === 'dry'
      ? `DRY RUN — execute the automation "${automationName}" defined below ONE TIME. The automation is already drafted in the database; you are testing what one pass through its pipeline would do.`
      : `EXECUTING automation "${automationName}" — the trigger fired (${triggeredBy ?? 'manual'}); make ONE pass through the pipeline below. The automation is already active in the database; do NOT re-author it.`

  const rules =
    mode === 'dry'
      ? `DRY-RUN RULES (the runtime enforces these — don't fight them):
- Do NOT call propose_automation. The draft already exists; calling it again creates duplicates.
- Do NOT call activate_automation.
- Do NOT recurse into a fresh authoring session, do not iterate the pipeline more than once.
- Every mutating outbound call (Gmail send, SMS, Composio writes that create/update/delete rows) is silently captured by the dry-run interceptor — they will NOT actually fire. That's expected; do the work normally.
- After one pipeline pass, emit a single final-answer message summarizing what the pipeline did (or would have done) and stop.`
      : `LIVE-RUN RULES:
- Do NOT call propose_automation or activate_automation. This is an EXECUTION of an already-active automation, not authoring.
- Do NOT lecture the user about tool capabilities, do not refuse, do not ask for clarification mid-run. The user already approved this pipeline at activation time. Just run it.
- Mutating outbound calls (Gmail send, SMS, Composio create/update/delete) WILL fire for real. The runtime gates risky ones via approval prompts to the user; trust the approval system.
- Use the browser tool (you have logged-in cookies for the workspace's pre-loaded sites) for anything Composio doesn't cover. Do not recommend external SaaS.
- Make exactly one pass through the pipeline for whatever input row/event triggered this run. Then emit a final-answer summary and stop.

END-OF-RUN STATE VERIFICATION (J.16, mandatory):
- After your last mutating write, re-read the affected row(s) from the source sheet (or whatever state-of-truth your pipeline writes to) and confirm every column you intended to write actually contains the expected value.
- If your pipeline involves Gmail/Calendar/other side-effects, query the side-effect (list drafts / list events / etc.) and confirm what you intended got created.
- If ANY check fails (a cell has the wrong value, a draft you tried to create doesn't exist, a mutual you scored isn't in the Mutuals tab), DO NOT emit final_answer with a success summary. Instead, surface the exact discrepancy and either retry the failing write or fail loud. Never narrate "I did X" without confirming X is actually in the state-of-truth.
- This is to catch a failure class where Composio returns ok:true on a write that silently landed in the wrong cell (param-shape footgun), or where you tried to call a tool that ended up no-oping. Verify before declaring success.

GOOGLESHEETS PARAM CONVENTION (J.10/J.17, follow strictly):
- For any GOOGLESHEETS_* tool with a \`range\` field, always single-quote the sheet name in A1 notation when it contains whitespace or punctuation: \`'LP Pipeline'!G2\`, not \`LP Pipeline!G2\` (silently misroutes writes).
- Stick to GOOGLESHEETS_VALUES_UPDATE for single-cell or single-range writes and GOOGLESHEETS_BATCH_UPDATE for multi-range writes. Don't bounce between slug variants on retry — if a write fails, fix the input shape, don't try a different slug name.

PER-WRITE VERIFICATION (J.14, mandatory for mutating Composio calls):
- After every GOOGLESHEETS_VALUES_UPDATE / GOOGLESHEETS_BATCH_UPDATE / similar mutating call, IMMEDIATELY follow with a GOOGLESHEETS_BATCH_GET on the same range and assert the cell values match what you intended to write.
- If the read-back shows a different value (e.g. you wrote 'Mapping' to G2 but the read-back returns 'Mapping' in A3 — known param-shape footgun), the write went to the wrong cell. DO NOT retry with a different slug name — that's a retry-storm pattern that fills the sheet with garbage. Instead, surface the drift and either correct the parameters (single-quote the sheet name, drop conflicting sheet_name+range combo, etc.) or fail loud.
- Same pattern for GMAIL_CREATE_EMAIL_DRAFT: after the call, GMAIL_LIST_DRAFTS or GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID with the returned draft id and confirm the To/Subject/Body match what you sent.
- Verification reads are cheap (~100ms) compared to the cost of pipelines silently writing to wrong cells and humans hunting down phantom state.`

  const tailHint =
    `If the automation's trigger normally fires on a specific row/event and the pre-resolved inputs below don't carry one, pick the first concrete candidate yourself by reading the relevant data source (e.g. fetch the first matching row from the trigger's source sheet). Don't ask the user — pick.`

  return `${header}

${rules}

${tailHint}

============== AUTOMATION GOAL (the pipeline to execute) ==============
${goal}
============== END AUTOMATION GOAL ==============

Pre-resolved inputs from the trigger config:
\`\`\`json
${inputsJson}
\`\`\`

Now execute one pass through the pipeline. Then stop.`
}

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
