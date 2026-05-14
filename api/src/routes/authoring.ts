/**
 * J.1 — Opencode-driven automation-authoring chat.
 *
 *   POST /v1/workspaces/:wsId/authoring/messages
 *   GET  /v1/workspaces/:wsId/authoring/events?runId=...
 *
 * The chat IS a long-lived `cloud_run` with `run_mode='authoring'`. First
 * user message creates the run + dispatches via SQS; the worker pool spins
 * up an opencode session (Opus 4.7), pumps the dynamically-built system
 * prompt + user message, streams events back via `cloud_activity`. When
 * the agent finishes its turn, `session.idle` flips the cloud_run to
 * `awaiting_user` (instead of completing — `worker/src/main.ts` short-
 * circuits for authoring runs). Next user message triggers a `continue`
 * NOTIFY routed to the same opencode session.
 *
 * Why not extend the gemini `managedAssistantRunner` chat? Because that
 * surface only exposes host-tool definitions; the worker tool registry
 * (propose_automation, activate_automation, browser_*) lives inside an
 * opencode session. Putting the chat ON opencode gives the agent the
 * full tool surface — Composio + browser + automation lifecycle — and
 * lets it iterate, then call propose_automation when ready.
 *
 * The system prompt enumerates:
 *   - Active Composio toolkits (from Composio entity = account_id)
 *   - Logged-in browser hosts (`workspace_browser_sites`)
 *   - Tools-to-connect catalog (so the agent knows what the dashboard
 *     can wire up if the user wants more)
 *   - Iteration rules (Composio first, browser fallback, propose, refine)
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { streamSSE } from 'hono/streaming'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs'
import { db } from '../db/index.js'
import { sql } from 'drizzle-orm'
import { getConfig } from '../config.js'
import { logger } from '../middleware/logger.js'
import type { WorkspaceToken } from '../lib/jwt.js'
import {
  ComposioClient,
  listExecutableComposioTools,
  type ExecutableComposioTool,
} from '../lib/composio.js'

type Vars = { requestId: string; workspace?: WorkspaceToken }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AUTHORING_MODEL = 'anthropic/claude-opus-4-7'
const KEEPALIVE_INTERVAL_MS = 25_000

let _sqsClient: SQSClient | null = null
function sqsClient(): SQSClient {
  if (!_sqsClient) {
    _sqsClient = new SQSClient({ region: process.env.AWS_REGION ?? 'us-east-1' })
  }
  return _sqsClient
}

const sendMessageSchema = z.object({
  content: z.string().min(1).max(64 * 1024),
})

interface BrowserSiteRow {
  host: string
  display_name: string | null
  captured_via: string | null
  last_verified_at: string | null
  expires_at: string | null
}

interface ActiveCloudRunRow {
  id: string
  status: string
  cloud_agent_id: string
}

interface ComposioToolkitSummary {
  slug: string
  connected: boolean
  toolCount: number
}

/**
 * Render the authoring system prompt for this workspace's current state.
 * Deterministic given the active connections + logged-in sites — re-running
 * with the same state produces the same prompt.
 */
function buildAuthoringSystemPrompt(input: {
  toolkits: ComposioToolkitSummary[]
  browserSites: BrowserSiteRow[]
  composioConfigured: boolean
}): string {
  const connectedToolkits = input.toolkits.filter((t) => t.connected)
  const browserSites = input.browserSites

  // List of toolkits that are at least plausibly connect-able. Keep this
  // tight — the dashboard's "Add integration" surface is the source of
  // truth; this is just a hint to the agent so it doesn't suggest e.g.
  // "use Salesforce" when we don't actually support Salesforce.
  const ADVERTISED_TOOLKITS = [
    'gmail',
    'googlesheets',
    'googlecalendar',
    'googledrive',
    'slack',
    'notion',
    'linear',
    'github',
    'linkedin',
    'airtable',
  ]

  const connectedSet = new Set(connectedToolkits.map((t) => t.slug))
  const availableToConnect = ADVERTISED_TOOLKITS.filter((s) => !connectedSet.has(s))

  const connectedLine =
    connectedToolkits.length === 0
      ? '  (none — the user has not connected any Composio integrations yet)'
      : connectedToolkits
          .map((t) => `  - ${t.slug} (${t.toolCount} tools available)`)
          .join('\n')

  const availableLine =
    availableToConnect.length === 0
      ? '  (everything supported is already connected)'
      : availableToConnect.map((s) => `  - ${s}`).join('\n')

  const browserLine =
    browserSites.length === 0
      ? '  (no sites are pre-logged-in yet — see the onboarding section below if you need one)'
      : browserSites
          .map(
            (s) =>
              `  - ${s.host}${s.display_name ? ` — ${s.display_name}` : ''}` +
              (s.expires_at ? ` (cookies expire ${s.expires_at.split(' ')[0]})` : ''),
          )
          .join('\n')

  const composioNote = input.composioConfigured
    ? ''
    : '\n[NOTE: COMPOSIO_API_KEY is not configured on this deployment — `composio_*` tool calls will fail. Tell the user to contact support.]\n'

  return `You are the automation-authoring agent for the Basics workspace. The user is talking to you because they want to build (or modify) an automation. Your job is to design it WITH them, get the integrations wired up, propose a draft + dry-run, and then activate when they're happy.
${composioNote}
# Your tool surface

## 1. Composio tools — OAuth-connected SaaS APIs

Currently CONNECTED in this workspace (call \`composio_list_tools\` to see specific tool slugs and input schemas):
${connectedLine}

Available to connect via the dashboard (Settings → Integrations → "Connect <toolkit>" runs the OAuth flow):
${availableLine}

If the user asks for a flow that needs a Composio toolkit they haven't connected, **tell them**: "I need <toolkit> connected. Open Settings → Integrations and click Connect <toolkit>. It runs OAuth and the tool surface will refresh within a minute. Let me know when you're done." Don't try to work around missing OAuth — get it connected.

## 2. Browser tool — Browserbase remote Chrome

You can drive a real Chrome browser via the browser_* tools (goto_url, click, type, screenshot, etc.). Use this for anything Composio doesn't cover — most commonly: LinkedIn 2nd-degree connection traversal, scraping sites without API access, any custom flow on a logged-in dashboard.

Sites PRE-LOGGED-IN via captured cookies (you arrive on these already authenticated, no login wall):
${browserLine}

If you need to use the browser on a site that isn't pre-logged-in (say example.com), **tell the user**: "I need to be logged in to example.com to do that. Open Settings → Browser Sessions → Add example.com, sign in to the live view, and click Save. After that I can browse example.com as you on every run." The platform captures the cookies into a Browserbase Context the worker auto-attaches.

**Never** recommend external SaaS workarounds (Clay, Apollo, PhantomBuster, Sales Navigator, etc.) for things you can do with the browser tool on a logged-in session. If LinkedIn requires the user's logged-in network, ask for browser-cookies for linkedin.com — you don't need a third-party scraper.

### Composio tool-call conventions worth getting right the first time

- **Google Sheets A1 ranges**: when you call any GOOGLESHEETS_* tool with a \`range\` field, the sheet name MUST be single-quoted if it contains whitespace or punctuation. \`'LP Pipeline'!G2\` is correct; \`LP Pipeline!G2\` is not (Composio silently writes to column A of the next empty row instead of G2 — same class as J.10). Single-cell ranges are \`'Sheet'!G2\`; ranges are \`'Sheet'!G2:H5\`. The worker auto-quotes when it can detect the bug, but emit the right shape from the start.

## 3. Trigger discovery — composio_list_triggers (BEFORE proposing webhook triggers)

If the automation should fire on an EVENT (a Sheets row added, a Gmail message arriving, a Notion page changing, etc.), the trigger is a \`composio_webhook\` and you MUST discover the real Composio trigger slug + its required config schema BEFORE calling propose_automation.

Call \`composio_list_triggers({toolkit: '<slug>'})\` (e.g. \`{toolkit: 'googlesheets'}\`) to enumerate the trigger event types for that toolkit. Each entry has:
- \`slug\` — the event id you put in \`triggers[].event\`
- \`description\` — what it actually fires on (read carefully; multiple triggers may sound similar but have different semantics)
- \`configRequired\` — the fields you must supply in \`triggers[].filters\`
- \`configProperties\` — schemas for each filter field (with defaults)

Then call \`composio_list_triggers({slug: '<full_slug>'})\` for the one you picked to see the full payload schema. **Never guess slugs** — Composio rejects unknown slugs at activation time, and that's a silent-failure path today.

## 4. propose_automation — create a DRAFT + DRY RUN

When you have a coherent plan, call \`propose_automation\` with the spec (name, goal, triggers, outputs). It creates a DRAFT automation in the database AND immediately fires a DRY RUN against the user's real data. Every outbound side-effect (email send, SMS, Composio writes) is captured into a preview buffer instead of actually firing. The activity feed shows you what the dry-run did.

For each \`composio_webhook\` trigger, the platform validates your \`filters\` object against Composio's config schema (the one returned by composio_list_triggers). If a required field is missing or a value is the wrong type, propose_automation returns \`trigger_config_invalid\` with the failing field — fix and retry.

After the dry-run fires, **review its output**: did it find the right rows? Did it draft the right emails? If anything is off, refine the goal text and call propose_automation again with the same draftId.

## 4.5. Architecture rule: PREFER ONE BIG AUTOMATION over a chain of small ones

When the user describes a multi-step workflow, your default should be ONE automation whose goal text covers every step end-to-end (Steps 1 through N). Only split into multiple automations when steps run on **genuinely different cadences** (e.g. per-row processing every 2 min vs daily 8am digest), OR when steps need different trigger types (e.g. a row-added webhook vs a Gmail-inbound webhook). Even then, keep the count minimal.

WHY: every split creates a handoff between automations. Handoffs are state-machine fields in the source-of-truth (the sheet, usually) that one automation writes and another reads. Each handoff is fragile — a missed transition strands the pipeline and the user sees nothing happen. We've already seen this break end-to-end ("Drafter is a separate automation" but no automation actually creates the drafts → pipeline dead-ends after Step 4 silently).

If you DO split, you MUST:
- Draw the state machine in a comment block in the goal text of each automation: what state values flow between them, what produces each state, what consumes each state.
- Verify every state in the state machine has a producer AND a consumer. If a state has no producer (nothing ever sets it), the automation reading that state is dead code. Refuse to ship a pipeline with unproduced states.
- State this analysis explicitly in your reply to the user before calling propose_automation, so the user can catch the gap if you missed it.

## 4.6. End-of-run state verification (mandatory before final_answer)

Before you emit \`final_answer\` from a worker run, you MUST verify the row state matches what your pipeline was supposed to do. Concretely:

- If your pipeline processed a row, re-read that row from the sheet (don't trust your own narrative — read the actual cell values).
- Assert every column you intended to write actually contains the expected value.
- Assert every dependent side-effect (Gmail draft, calendar event, etc.) was actually created — query Gmail / Calendar / etc. to confirm.
- If ANY check fails, DO NOT emit final_answer with a success-style summary. Instead, surface the discrepancy explicitly: "I intended to write X but the cell contains Y. Investigating." — and either fix it or fail loudly.

This is to prevent the failure mode where the agent's internal narrative says "step 5 done" but the actual state shows step 5 was skipped — which broke the LP Mapper test (Step 5 skipped, Mutuals row stuck at Ping Status='Not pinged', agent emitted "completed successfully" anyway).

## 5. activate_automation — go live

Only call this after the user has reviewed the dry-run and explicitly confirmed. It flips the draft to active and registers triggers + schedules in production. Approval-gated; the system will surface an SMS approval prompt to the user.

# How to work

- Read the user's request. Identify the integrations + browser sites needed.
- Cross-reference against what's connected. If anything's missing, tell the user exactly what to do — don't guess workarounds.
- Once everything's connected, design the automation. Ask clarifying questions for anything ambiguous (sheet IDs, partner LinkedIn URLs, scoring weights, recipients, etc.).
- Call propose_automation when you have enough. Read the dry-run activity. Iterate.
- Call activate_automation when the user is happy.

Be direct. Don't pad responses with summaries of what was already discussed. If you're blocked on something the user needs to do, say so and stop — wait for them to come back.

The user's message follows. Respond.`
}

/**
 * J.4 — return the live authoring run only when its opencode session
 * is still alive on a worker pool. Otherwise mark the stale run cancelled
 * (so the next caller transparently starts a fresh session) and return
 * null. Detection: `cloud_session_bindings.ended_at IS NULL` for that run.
 *
 * The detected-dead run's full conversation transcript is preserved in
 * `cloud_activity` (`authoring_turn_complete` events + the initial goal
 * which carries the user's first message); the new run can replay that
 * history as prior-turn context. Callers signal "rehydrated" when the
 * old run id is non-null.
 */
async function findOrRehydrateAuthoringRun(
  workspaceId: string,
): Promise<{ run: ActiveCloudRunRow | null; rehydratedFromRunId: string | null }> {
  const rows = (await db.execute(sql`
    SELECT cr.id, cr.status, cr.cloud_agent_id,
           EXISTS (
             SELECT 1 FROM public.cloud_session_bindings b
              WHERE b.run_id = cr.id AND b.ended_at IS NULL
           ) AS binding_alive
      FROM public.cloud_runs cr
     WHERE cr.workspace_id = ${workspaceId}
       AND cr.run_mode = 'authoring'
       AND cr.status IN ('pending', 'running', 'awaiting_user')
     ORDER BY cr.created_at DESC
     LIMIT 1
  `)) as unknown as Array<ActiveCloudRunRow & { binding_alive: boolean }>

  const top = rows[0]
  if (!top) return { run: null, rehydratedFromRunId: null }
  if (top.binding_alive) {
    return { run: { id: top.id, status: top.status, cloud_agent_id: top.cloud_agent_id }, rehydratedFromRunId: null }
  }

  // Binding is dead (worker pool task that owned it has terminated). The
  // opencode session is gone but cloud_runs.status still says
  // 'awaiting_user'. Mark the orphan cancelled and signal the caller to
  // spawn a fresh authoring run with replayed history.
  await db.execute(sql`
    UPDATE public.cloud_runs
       SET status = 'cancelled',
           completed_at = now(),
           result_summary = 'authoring_session_orphaned_by_pool_restart'
     WHERE id = ${top.id} AND status IN ('pending', 'running', 'awaiting_user')
  `)
  logger.info(
    { workspace_id: workspaceId, orphaned_run_id: top.id },
    'authoring: orphaned run marked cancelled; will rehydrate fresh session with replayed history',
  )
  return { run: null, rehydratedFromRunId: top.id }
}

interface ConversationTurn {
  role: 'user' | 'assistant'
  text: string
}

/**
 * J.4 — pull the conversation transcript of an orphaned authoring run
 * out of cloud_activity so the new session can replay it as prior turns.
 *
 * Sources:
 *  - The user's first message is embedded in the `run_started` event's
 *    `goal` payload (after the "User:" delimiter the system prompt uses).
 *  - Each subsequent user message lives in the corresponding `continue`
 *    NOTIFY — we don't persist those to cloud_activity today, so the
 *    first version of rehydration replays only assistant turns + the
 *    first user message. (Storing all user turns in cloud_activity is
 *    a small follow-up; for now the agent re-reads the LATEST user
 *    message verbatim in the new prompt.)
 *  - Each assistant turn lives in `authoring_turn_complete` payload's
 *    `assistantText`.
 */
async function loadAuthoringTranscript(runId: string): Promise<ConversationTurn[]> {
  const rows = (await db.execute(sql`
    SELECT activity_type, payload, created_at
      FROM public.cloud_activity
     WHERE agent_run_id = ${runId}
       AND activity_type IN ('run_started', 'authoring_turn_complete')
     ORDER BY created_at ASC
  `)) as unknown as Array<{ activity_type: string; payload: Record<string, unknown> }>

  const turns: ConversationTurn[] = []
  for (const row of rows) {
    const p = (row.payload ?? {}) as Record<string, unknown>
    if (row.activity_type === 'run_started') {
      const goal = typeof p.goal === 'string' ? p.goal : ''
      const idx = goal.lastIndexOf('User:')
      const firstUserMsg = idx >= 0 ? goal.slice(idx + 'User:'.length).trim() : ''
      if (firstUserMsg) turns.push({ role: 'user', text: firstUserMsg })
    } else if (row.activity_type === 'authoring_turn_complete') {
      const text = typeof p.assistantText === 'string' ? p.assistantText : ''
      if (text) turns.push({ role: 'assistant', text })
    }
  }
  return turns
}

function renderTranscriptBlock(turns: ConversationTurn[]): string {
  if (turns.length === 0) return ''
  const formatted = turns
    .map((t) => `${t.role === 'user' ? '## User' : '## You (assistant)'}\n${t.text}`)
    .join('\n\n')
  return `\n\n# Prior conversation in this authoring session (rehydrated after worker pool restart)

The previous opencode session on the worker pool was terminated (pool task restart). The transcript below is the conversation you had with the user so far. Continue from where you left off — don't recap, don't re-introduce yourself, don't redo earlier work. Respond to the user's NEW message at the end.

${formatted}

# End of prior conversation. The user's new message follows.`
}

/**
 * Resolve / lazy-create the workspace's ad-hoc cloud_agent (same pattern
 * used by /draft-from-chat + /dry-run).
 */
async function ensureAdHocCloudAgent(
  workspaceId: string,
  accountId: string,
): Promise<string> {
  const existing = (await db.execute(sql`
    SELECT id FROM public.cloud_agents
     WHERE workspace_id = ${workspaceId} AND agent_id = 'ad-hoc'
     LIMIT 1
  `)) as unknown as Array<{ id: string }>
  if (existing[0]) return existing[0].id
  const created = (await db.execute(sql`
    INSERT INTO public.cloud_agents
      (workspace_id, account_id, agent_id, definition, schedule, status, composio_user_id, runtime_mode)
    VALUES
      (${workspaceId}, ${accountId}, 'ad-hoc', 'Manual + automation-triggered runs',
       'manual', 'active', ${workspaceId}, 'harness')
    RETURNING id
  `)) as unknown as Array<{ id: string }>
  return created[0]!.id
}

async function loadBrowserSites(workspaceId: string): Promise<BrowserSiteRow[]> {
  const rows = (await db.execute(sql`
    SELECT host,
           display_name,
           captured_via,
           last_verified_at::text AS last_verified_at,
           expires_at::text AS expires_at
      FROM public.workspace_browser_sites
     WHERE workspace_id = ${workspaceId}
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY host
  `)) as unknown as Array<BrowserSiteRow>
  return rows
}

async function loadConnectedComposioToolkits(
  composioUserId: string,
): Promise<ComposioToolkitSummary[]> {
  try {
    const client = new ComposioClient()
    const tools = await listExecutableComposioTools(composioUserId, client)
    const byToolkit = new Map<string, number>()
    for (const t of tools as ExecutableComposioTool[]) {
      const slug = t.tool.toolkit?.slug ?? t.authConfig.toolkit?.slug
      if (!slug) continue
      byToolkit.set(slug, (byToolkit.get(slug) ?? 0) + 1)
    }
    const summaries: ComposioToolkitSummary[] = []
    for (const [slug, count] of byToolkit.entries()) {
      summaries.push({ slug, connected: true, toolCount: count })
    }
    summaries.sort((a, b) => a.slug.localeCompare(b.slug))
    return summaries
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'authoring: composio toolkit discovery failed; rendering prompt with empty connected list',
    )
    return []
  }
}

/** Dispatch a NEW authoring run via SQS. */
async function dispatchNewAuthoringRun(input: {
  workspaceId: string
  accountId: string
  userMessage: string
  systemPrompt: string
  /** J.4 — when set, prior turns replayed into the system prompt so the
   *  rehydrated session picks up where the dead one left off. */
  transcriptBlock?: string
}): Promise<{ runId: string; cloudAgentId: string }> {
  const cloudAgentId = await ensureAdHocCloudAgent(input.workspaceId, input.accountId)
  const runId = randomUUID()
  const transcript = input.transcriptBlock ?? ''
  const combinedGoal = `${input.systemPrompt}${transcript}\n\n---\n\nUser:\n${input.userMessage}`
  await db.execute(sql`
    INSERT INTO public.cloud_runs
      (id, cloud_agent_id, workspace_id, account_id, status, run_mode,
       triggered_by, inputs)
    VALUES
      (${runId}, ${cloudAgentId}, ${input.workspaceId}, ${input.accountId},
       'pending', 'authoring', 'manual', '{}'::jsonb)
  `)
  const cfg = getConfig()
  const queueUrl = cfg.RUNS_QUEUE_URL
  if (!queueUrl) throw new Error('runs_queue_not_configured')
  await sqsClient().send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify({
        runId,
        workspaceId: input.workspaceId,
        accountId: input.accountId,
        goal: combinedGoal,
        runMode: 'authoring',
        model: AUTHORING_MODEL,
      }),
      MessageGroupId: input.workspaceId,
      MessageDeduplicationId: runId,
    }),
  )
  return { runId, cloudAgentId }
}

/** Send a `continue` NOTIFY to the worker pool that owns this run. */
async function dispatchContinueNotify(input: {
  runId: string
  message: string
}): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT pool_id
      FROM public.cloud_session_bindings
     WHERE run_id = ${input.runId}
       AND ended_at IS NULL
     LIMIT 1
  `)) as unknown as Array<{ pool_id: string }>
  const poolId = rows[0]?.pool_id
  if (!poolId) {
    // The run claims to be alive but we lost the binding. Fall through;
    // the worker that emits session.deleted will sweep this up via the
    // existing terminal handler. Surface as 503 so the client retries.
    throw new Error('authoring_run_pool_unknown')
  }
  const channel = `pool_${poolId.replace(/-/g, '_')}`
  const payload = JSON.stringify({
    kind: 'continue',
    runId: input.runId,
    message: input.message,
  })
  await db.execute(sql`SELECT pg_notify(${channel}, ${payload})`)
}

export const authoringRoute = new Hono<{ Variables: Vars }>()

authoringRoute.post(
  '/:wsId/authoring/messages',
  zValidator('json', sendMessageSchema),
  async (c) => {
    const pathWs = c.req.param('wsId')
    const jwtWs = c.var.workspace?.workspace_id
    const acc = c.var.workspace?.account_id
    if (!UUID_RE.test(pathWs)) return c.json({ error: 'invalid_workspace_id' }, 400)
    if (!jwtWs || pathWs !== jwtWs) return c.json({ error: 'forbidden' }, 403)
    if (!acc) return c.json({ error: 'forbidden' }, 403)

    const body = c.req.valid('json')
    const userMessage = body.content.trim()
    if (userMessage.length === 0) {
      return c.json({ error: 'empty_content' }, 400)
    }

    const { run: existing, rehydratedFromRunId } = await findOrRehydrateAuthoringRun(pathWs)
    if (existing) {
      try {
        await dispatchContinueNotify({ runId: existing.id, message: userMessage })
      } catch (err) {
        const msg = (err as Error).message
        if (msg === 'authoring_run_pool_unknown') {
          // Should be unreachable thanks to the binding_alive precheck in
          // findOrRehydrateAuthoringRun, but if a race lands us here
          // (pool died between the precheck and the NOTIFY), surface a
          // 503 so the client retries (which will rehydrate fresh).
          return c.json({ error: 'authoring_run_unreachable', runId: existing.id }, 503)
        }
        throw err
      }
      return c.json({
        runId: existing.id,
        status: 'continuing',
        action: 'continue_existing',
      })
    }

    // No live run — either brand-new session OR we just marked an
    // orphaned one cancelled and need to rehydrate it. In both cases
    // we build a fresh authoring run; for rehydration we additionally
    // replay prior conversation history into the system prompt so the
    // agent picks up exactly where it left off.
    const [browserSites, toolkits, transcript] = await Promise.all([
      loadBrowserSites(pathWs),
      loadConnectedComposioToolkits(acc),
      rehydratedFromRunId ? loadAuthoringTranscript(rehydratedFromRunId) : Promise.resolve([] as ConversationTurn[]),
    ])
    const cfg = getConfig()
    const systemPrompt = buildAuthoringSystemPrompt({
      toolkits,
      browserSites,
      composioConfigured: Boolean(cfg.COMPOSIO_API_KEY),
    })
    const transcriptBlock = renderTranscriptBlock(transcript)
    const dispatched = await dispatchNewAuthoringRun({
      workspaceId: pathWs,
      accountId: acc,
      userMessage,
      systemPrompt,
      transcriptBlock,
    })
    logger.info(
      {
        workspace_id: pathWs,
        run_id: dispatched.runId,
        toolkits_connected: toolkits.length,
        browser_sites: browserSites.length,
        system_prompt_chars: systemPrompt.length,
        rehydrated_from: rehydratedFromRunId,
        replayed_turns: transcript.length,
      },
      rehydratedFromRunId ? 'authoring: rehydrated run dispatched' : 'authoring: new run dispatched',
    )
    return c.json(
      {
        runId: dispatched.runId,
        status: 'started',
        action: rehydratedFromRunId ? 'rehydrated' : 'new_session',
        ...(rehydratedFromRunId
          ? { rehydratedFromRunId, replayedTurns: transcript.length }
          : {}),
        toolSurfaceSnapshot: {
          composioToolkitsConnected: toolkits.map((t) => t.slug),
          browserSites: browserSites.map((s) => s.host),
        },
      },
      201,
    )
  },
)

/** Test seam — let tests substitute a mock Supabase client. */
let _supabaseFactoryForAuthoringTests: (() => SupabaseClient | null) | null = null
export function setSupabaseFactoryForAuthoringTests(
  fn: (() => SupabaseClient | null) | null,
): void {
  _supabaseFactoryForAuthoringTests = fn
}

const AUTHORING_FORWARDED_ACTIVITY_TYPES = new Set([
  'run_started',
  'authoring_turn_complete',
  'oc.message.part.updated',
  'oc.message.updated',
  'oc.tool.use.start',
  'oc.tool.use.end',
  'final_answer',
  'screenshot',
  'browserbase_session_attached',
  'composio_resolved',
  'dry_run_action',
  'dry_run_summary',
  'run_paused_awaiting_approval',
  'approval_granted',
  'approval_denied',
  'run_completed',
  'run_cancelled',
])

authoringRoute.get('/:wsId/authoring/events', async (c) => {
  const pathWs = c.req.param('wsId')
  const jwtWs = c.var.workspace?.workspace_id
  if (!jwtWs || pathWs !== jwtWs) return c.json({ error: 'forbidden' }, 403)
  const runIdFilter = c.req.query('runId') ?? undefined

  c.header('Cache-Control', 'no-cache')
  c.header('Connection', 'keep-alive')
  c.header('X-Accel-Buffering', 'no')

  return streamSSE(c, async (stream) => {
    const cfg = getConfig()
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) {
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: 'supabase_not_configured' }),
      })
      return
    }
    const supabase: SupabaseClient = _supabaseFactoryForAuthoringTests
      ? (_supabaseFactoryForAuthoringTests() as SupabaseClient)
      : createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
          realtime: { params: { eventsPerSecond: 50 } },
        })

    let closed = false

    async function emit(row: {
      id?: string
      agent_run_id?: string
      activity_type?: string
      payload?: Record<string, unknown> | null
      created_at?: string
    }): Promise<void> {
      if (closed) return
      if (!row.activity_type || !AUTHORING_FORWARDED_ACTIVITY_TYPES.has(row.activity_type)) return
      if (runIdFilter && row.agent_run_id !== runIdFilter) return
      const frame = {
        runId: row.agent_run_id,
        kind: row.activity_type,
        payload: row.payload ?? {},
        at: row.created_at,
      }
      await stream.writeSSE({
        id: row.id,
        event: 'authoring_event',
        data: JSON.stringify(frame),
      })
    }

    const channel = supabase
      .channel(`authoring:${pathWs}`)
      .on(
        'postgres_changes' as never,
        {
          event: 'INSERT',
          schema: 'public',
          table: 'cloud_activity',
          filter: `workspace_id=eq.${pathWs}`,
        },
        async (payload: { new: Record<string, unknown> }) => emit(payload.new as never),
      )
      .subscribe()

    await stream.writeSSE({
      event: 'ready',
      data: JSON.stringify({ workspaceId: pathWs, runIdFilter: runIdFilter ?? null }),
    })

    await new Promise<void>((resolve) => {
      stream.onAbort(() => {
        closed = true
        supabase.removeChannel(channel).catch(() => undefined)
        resolve()
      })
      const keepalive = setInterval(async () => {
        if (closed) {
          clearInterval(keepalive)
          return
        }
        try {
          await stream.write(': keep-alive\n\n')
        } catch (e) {
          logger.warn({ wsId: pathWs, err: (e as Error).message }, 'authoring-sse keep-alive failed')
          closed = true
          clearInterval(keepalive)
          supabase.removeChannel(channel).catch(() => undefined)
          resolve()
        }
      }, KEEPALIVE_INTERVAL_MS)
    })
  })
})

// Exported for tests + the prompt-preview endpoint.
export { buildAuthoringSystemPrompt, loadBrowserSites, loadConnectedComposioToolkits }
