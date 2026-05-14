# Automations Plan

End-to-end plan for shipping user-defined automations that run autonomously on the cloud-agent runtime. The goal is a system where a workflow defined as a database record executes on a trigger (schedule, webhook, manual) using a unified tool surface (browser-harness + Composio + filesystem + control), and delivers results to any combination of output channels (activity stream, SMS, email, attached artifacts).

**Scope of this plan: backend, API, and cloud infrastructure only.** No frontend or dashboard work is included. Where this plan emits events or exposes endpoints that a client (dashboard, CLI, third-party integration) would consume, those API contracts are spelled out so a client can be built against them, but building any client is out of scope.

This document supersedes the implicit plan that scoped Composio as an API-side concern and the agent as a chat-only consumer. The architectural shift is: **Composio becomes a worker-side tool family alongside `@basics/harness`, and the executing agent picks routes per-step from a unified toolbelt.** Self-healing applies uniformly across all tool families via the existing `skills/` system.

---

## 1. Architecture overview

### 1.1 Unified tool surface

The worker tool registry (`worker/src/tools/`) becomes the single source of truth for what the agent can do. Today it carries ~32 tools across four categories:

- Browser primitives (harness-backed): `click_at_xy`, `goto_url`, `js`, `extract`, `capture_screenshot`, etc.
- Filesystem (EFS-scoped, fs-policy-guarded): `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `bash`.
- Agent control: `update_plan`, `set_step_status`, `report_finding`, `final_answer`, `skill_write`, `spawn_subagent`, `send_to_agent`.
- Raw escape hatches: `cdp_raw`, `http_get`.

We add two new families:

- **Output channels** (`send_sms`, `send_email`, `attach_artifact`) — for delivering results outside the in-app activity stream.
- **Composio** (`composio_list_tools`, `composio_call`) — for invoking any toolkit the workspace has connected through Composio.

The agent sees a single unified toolbelt at session boot and makes routing decisions per-step at runtime based on what's available, what's in `skills/`, and what the workspace has authorized.

### 1.2 Self-healing remains uniform

The §9 `skills/<host>/` + `helpers/*.ts` pattern already handles tool-level learning for browser-harness. By making Composio a tool family in the same registry, the same skill files cover both:

```
skills/
  linkedin.com/
    flows/
      find_mutuals.md         # browser-harness flow
    selectors.md
  composio/
    gmail/
      flows/
        find_lp_thread.md     # composio_call flow
      tool_slugs.md           # cached toolSlug → param shape map
helpers/
  research_lp.ts              # composes harness + composio calls in one helper
```

When a step fails (selector drift OR Composio auth expiry), the same fallback-and-rewrite pattern updates the corresponding skill.

### 1.3 No separate planner agent

The original plan included a separate planner that would pre-decide routes and surface a plan for user approval. With a unified tool surface, the planner collapses into the executor — the same agent that runs the workflow also picks routes per-step. User control comes from the approvals gate (§4), not pre-run plan review.

---

## 2. Workstream — Output channel tools

### 2.1 Goal

Let the agent deliver results to any channel (in-app SSE, SMS via Sendblue, email via Amazon SES, file attachments via S3) as a normal tool call from inside a run.

### 2.2 Current state

- `final_answer` tool returns text into the SSE stream.
- **Sendblue secrets are wired.** `SendblueApiKey`, `SendblueApiSecret`, `SendblueSigningSecret` declared as SST secrets in `sst.config.ts` and injected into the API service env. Values populated in SSM Parameter Store for the production stage. Will also need to be added to the worker task def env block as part of this workstream.
- **Amazon SES is production-ready.** `trybasics.ai` domain identity verified in `us-east-1`, production access enabled (out of sandbox), 50,000/day quota with 14/sec rate limit, account health status HEALTHY. `SesFromEmail` declared as SST secret with `notifications@trybasics.ai` (or whichever sender chosen) as the value. The only remaining setup: declare `aws.sesv2.EmailIdentity` and `aws.sns.Topic` (bounce/complaint) resources in `sst.config.ts` to codify the identity reproducibly, and grant `ses:SendEmail`/`ses:SendRawEmail` to the worker task role.
- **Composio webhook secret is wired.** `ComposioWebhookSecret` populated in SSM; `/webhooks/composio` will start accepting verified events on next deploy. Three event types subscribed in Composio dashboard: `composio.trigger.message`, `composio.connected_account.expired`, `composio.trigger.disabled`. All three match `SUPPORTED_COMPOSIO_WEBHOOK_EVENTS` in `api/src/lib/composio.ts`.
- `basics-runtime-artifacts-*` S3 bucket exists and the worker task role already has `s3:GetObject/PutObject/DeleteObject` against `workspaces/*` prefix (`sst.config.ts:282-284`).
- Nothing on the agent side exposes any of this — no worker tools call Sendblue, SES, or the artifacts bucket yet.

### 2.3 Target state

Three new tools in `worker/src/tools/`:

- `send_sms(to, body, mediaUrl?)` — POST to Sendblue. Caller provides E.164 phone; tool returns delivery status.
- `send_email(to, subject, body, attachments?, bodyType?)` — SES `SendEmail` / `SendRawEmail` via `@aws-sdk/client-ses`. Supports `text` and `html` body types. `attachments` is an array of S3 keys; tool fetches and inlines via SendRawEmail.
- `attach_artifact(name, payload, contentType?)` — uploads to `basics-runtime-artifacts-*/workspaces/<workspaceId>/runs/<runId>/<name>`, returns a 7-day signed URL. Used to attach screenshots/exports to messages.

Each tool emits an `output_dispatched` activity event capturing what went where, and an `output_failed` event with a retry hint on transient failures. Both events are typed in `@basics/shared` so any consumer of the SSE stream can react to them.

### 2.4 Per-automation outputs schema

To let users declaratively say "send the result of this automation to my phone," automations get an `outputs` field:

```ts
outputs: [
  { channel: 'sms',   to: '+15551234567', includeArtifacts: true,  when: 'on_complete' },
  { channel: 'email', to: 'foo@bar.com', subject: 'LP mapping done', when: 'on_complete' },
  { channel: 'email', to: 'foo@bar.com', when: 'on_failure' },
]
```

A small dispatcher in the worker (`worker/src/outputs.ts`) reads this at run end and fires the appropriate tools. The agent can also call these tools directly mid-run for streaming notifications ("starting LP mapping for Acme Capital…").

### 2.5 Open design decisions + recommendations

- **SMS length / media handling.** Sendblue iMessage supports media URLs and long-form; SMS fallback hard-truncates. Recommendation: send full body and let Sendblue decide; for SMS-only carriers, also generate a 140-char summary via a one-line prompt and use that. Surface delivery channel back to the agent so it knows whether the recipient saw the full payload.
- **Email format.** Recommendation: default to plaintext for short outputs, HTML for outputs containing tables/images. The tool autodetects from body content (if `<` appears in first 200 chars, treat as HTML). Override via `bodyType` param.
- **Attachment size.** Recommendation: anything > 100 KB goes as an S3 signed URL inline in body, not as a MIME attachment. Lets recipients view in browser without downloading 5 MB screenshots.
- **PII in logs.** `send_email` body could contain anything. Recommendation: do not log message bodies into `cloud_activity`; log only `{to, subject, channel, status}` and a content hash. Full body lives in S3 for audit (90-day retention, same lifecycle as screenshots).
- **Rate limits.** Sendblue (~1 msg/sec per number); SES (sandbox = 1 msg/sec, production = much higher). Recommendation: per-workspace token bucket in Postgres (`workspace_output_quotas`) reset daily; exceeding returns a hard error to the agent which can retry or surface.

### 2.6 Concrete deliverables

- `worker/src/tools/send_sms.ts`
- `worker/src/tools/send_email.ts`
- `worker/src/tools/attach_artifact.ts`
- `worker/src/outputs.ts` — dispatcher that reads `automation.outputs` at run completion
- New activity event types: `output_dispatched`, `output_failed`
- New table: `workspace_output_quotas` (workspace_id, channel, count_today, reset_at)
- Worker env additions (`sst.config.ts` worker task def env block — the API service already has them):
  - `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET` (signing-secret stays API-only since it's for verifying inbound webhooks)
  - `SES_FROM_EMAIL`
  - `ARTIFACTS_BUCKET_NAME` (interpolated from `artifactsBucket.name`)
- **SES infrastructure-as-code**: declare `aws.sesv2.EmailIdentity` for `trybasics.ai` in `sst.config.ts` so the verified domain is reproducible across stages; add a bounce/complaint SNS topic with a subscription that logs to CloudWatch (so deliverability problems surface).
- Worker task role IAM additions in `sst.config.ts`: `ses:SendEmail`, `ses:SendRawEmail` scoped to the verified sender identity ARN.
- Tests: vitest unit tests for each tool with mocked Sendblue/SES/S3 clients.
- E2E: `send_sms` to your own number, `send_email` to your own inbox, verify delivery.

---

## 3. Workstream — Composio worker unification

### 3.1 Goal

Make every Composio-connected toolkit the workspace has authorized available to the agent as a callable tool, executed from inside the worker container, learned-on via the same `skills/` system as browser flows.

### 3.2 Current state

- `shared/src/composio.ts` — typed `ComposioClient` against `https://backend.composio.dev/api/v3.1`, supports `listToolkits`, `listAuthConfigs`, `listConnectedAccounts`, `listTools`, `createConnectLink`, `deleteConnectedAccount`, `executeTool`, `markComposioConnectedAccountExpired`.
- `api/src/routes/composio.ts` — HTTP surface at `/v1/skills/composio/*` and `/webhooks/composio` for client-driven OAuth and tool execution.
- `api/src/lib/composio-skill-preferences.ts` — per-workspace toggles for which toolkits/tools are enabled.
- `COMPOSIO_API_KEY` and `COMPOSIO_WEBHOOK_SECRET` are SST secrets with production values populated, injected into the RuntimeApi service env. The webhook endpoint at `/webhooks/composio` is HMAC-verifying inbound deliveries; subscribed events in Composio dashboard: `composio.trigger.message`, `composio.connected_account.expired`, `composio.trigger.disabled`.
- The agent (worker) has no direct knowledge of Composio — `COMPOSIO_API_KEY` is not in the worker task def env block yet.

### 3.3 Target state

#### 3.3.1 Composio API key in the worker

Add to the worker task definition env block in `sst.config.ts` (currently lines 578-588 — alongside `DATABASE_URL_POOLER`, `BROWSERBASE_API_KEY`, etc.):

```ts
{ name: "COMPOSIO_API_KEY", value: secrets.composioApiKey.value },
```

This is the only infrastructure change.

#### 3.3.2 Tool surface design — generic, not per-action

A workspace with Gmail + Sheets + Calendar + Slack + LinkedIn connected has ~80-120 Composio tools available. Registering each as an individual opencode tool blows past the ~30-50 LLM tool-selection sweet spot and degrades accuracy on all tools, not just Composio ones.

Recommendation: **one generic family, two tools**:

```ts
composio_list_tools(toolkit?, query?) -> { tools: [{ slug, name, description, paramSchema }] }
composio_call(toolSlug, params) -> { ok, result, error? }
```

The agent calls `composio_list_tools` for discovery on first use of a toolkit, then `composio_call` for execution. The `skills/composio/<toolkit>/tool_slugs.md` file becomes the durable cache — once the agent has used `GMAIL_SEND_EMAIL` successfully, the skill file records the slug + param shape so subsequent runs skip the discovery roundtrip.

This pattern scales to the entire Composio catalog without overwhelming the LLM context.

#### 3.3.3 Workspace connection lookup at session boot

The opencode plugin (`worker/src/opencode-plugin/index.ts`) already resolves `sessionID → {workspaceId, runId, accountId}` via `cloud_session_bindings`. Extend `WorkerToolContext` to also carry the workspace's Composio connection map:

```ts
interface WorkerToolContext {
  // existing fields...
  composio?: {
    accountsByToolkit: Map<string, ComposioConnectedAccount>
    // toolkitSlug -> connectedAccountId resolution
  }
}
```

Populated at session boot via `ComposioClient.listConnectedAccounts({ status: 'ACTIVE' })`. Refreshed if `composio_call` returns a "no connection" error.

#### 3.3.4 Auth refresh + error handling

Composio handles token refresh server-side for most providers, but expired connections still surface as failures. The `composio_call` wrapper:

1. Calls `ComposioClient.executeTool(toolSlug, connectedAccountId, params)`.
2. On 401/403 or `error.code === 'CONNECTION_EXPIRED'`: emit `connection_expired` event with `toolkitSlug`, mark the connection inactive in the workspace's `composio.accountsByToolkit` map, return a structured error to the agent. The agent can `report_finding` to the user that they need to reconnect.
3. On 429 / rate limit: emit `external_rate_limit` event, return retry hint to the agent.
4. On other errors: emit `tool_call_failed`, return raw error.

#### 3.3.5 Toolkit discovery cost

`listTools` returns the full schema for every tool in a toolkit and can be slow (multiple hundred ms per toolkit). With 5-10 toolkits connected per workspace, naive at-boot discovery would add seconds to cold start.

Recommendation: **lazy + cached**. The agent only calls `composio_list_tools` when it needs to. Results cached in Postgres `composio_tool_cache` table with `(workspace_id, toolkit_slug, tools_json, fetched_at)` and a 1-hour TTL. `composio_call` itself does not require pre-discovery — the agent can call any toolSlug directly if it knows it (read from skill files).

#### 3.3.6 Audit trail for external actions

Every `composio_call` mutates external state (sends emails, modifies sheets, posts messages). These need a clean audit log.

Recommendation: emit `external_action` activity event with `{ toolSlug, toolkitSlug, paramsHash, paramsPreview, resultStatus }`. `paramsPreview` is the params object with values for keys matching `/email|body|content|message|password|token|secret/i` replaced by `<redacted>`. Full params logged to a separate `external_action_audit` table with shorter retention (30 days) for incident response.

### 3.4 Open design decisions + recommendations

- **Per-workspace tool denylist.** Some Composio tools are destructive (`GMAIL_DELETE_THREAD`, `GITHUB_DELETE_REPO`). Recommendation: surface a `agent_settings.composio_denylist` array per workspace; default-deny actions matching `/delete|remove|drop|purge|wipe/i` unless user opts in. The agent sees these tools but `composio_call` rejects them with a clear "denied by workspace policy" error.
- **Where Composio tools execute (worker vs API).** Recommendation: **worker, directly.** Avoids an extra network hop, keeps the agent's tool surface uniform, and the worker already has IAM/secret access. The existing API routes (`/v1/skills/composio/*`) remain for client-driven connect-toolkit flows and direct programmatic users, but the agent path bypasses them.
- **Versioning of toolSlug schemas.** Composio occasionally changes a tool's param shape. Recommendation: store `schema_version` alongside cached schemas; on `composio_call` failure due to schema mismatch, invalidate the cache for that tool and retry once with fresh discovery.
- **Concurrent calls.** Some toolkits (Gmail) tolerate parallelism; others (Calendar mutations on the same event) don't. Recommendation: per-toolkit concurrency cap in the worker (default 3, configurable via `composio.toolkit_concurrency` agent setting), enforced by a simple semaphore in the worker process.

### 3.5 Concrete deliverables

- `worker/src/tools/composio_list_tools.ts`
- `worker/src/tools/composio_call.ts`
- `worker/src/composio/connection-resolver.ts` — workspace → connected-accounts map at session boot
- `worker/src/composio/audit.ts` — `external_action` event emitter + PII scrubber
- `worker/src/composio/cache.ts` — Postgres-backed schema cache with 1-hour TTL
- New tables:
  - `composio_tool_cache` (workspace_id, toolkit_slug, tools_json, fetched_at)
  - `external_action_audit` (id, workspace_id, run_id, tool_slug, params_full, result, created_at, expires_at)
- New activity event types: `external_action`, `connection_expired`, `external_rate_limit`
- `sst.config.ts` — add `COMPOSIO_API_KEY` to worker env block
- First batch of "mixed-mode" skill files demonstrating browser + Composio composition (LP automation as the testbed; see §6)
- Tests: vitest with a mocked Composio client; one E2E that runs `composio_call("GMAIL_SEND_EMAIL", {to: ..., subject: ..., body: ...})` against a real test connection and asserts delivery

---

## 4. Workstream — Approvals gate

### 4.1 Goal

Replace pre-run plan review with per-tool approval pauses, so the user keeps control over expensive or destructive actions without blocking the agent on every call.

### 4.2 Current state

- §18 of `docs/CLOUD-AGENT-PLAN.md` specs an approvals mechanism. No implementation yet.
- The agent has no concept of "pause and wait for user."
- No API surface exists for clients to fetch or decide pending approvals.

### 4.3 Target state

#### 4.3.1 Tool annotations

Each tool definition in `worker/src/tools/` gains an optional `approval` field:

```ts
defineTool({
  name: 'composio_call',
  approval: (args) => {
    if (mutatingToolSlugs.has(args.toolSlug)) return { required: true, reason: 'mutates external state' }
    return { required: false }
  },
  // ...
})
```

`approval` is a function so it can inspect args — `composio_call("GMAIL_SEND_EMAIL", {to: ["a@b.com"]})` might not require approval for single-recipient, but a 50-recipient blast does.

Default-require approval for:
- `send_email` to more than 1 recipient
- `send_sms` (always)
- `composio_call` for any tool slug matching the mutating-action denylist regex
- `bash` for commands matching destructive patterns (`rm -rf`, `mv`, `chmod`)

User can override per-workspace via `agent_settings.approval_overrides`.

#### 4.3.2 Approval flow

When a tool with `approval.required = true` is about to execute:

1. Worker emits `approval_requested` event with `{ run_id, tool_call_id, tool_name, args_preview, reason, expires_at, access_token_hash }`. Expiry default = 4 hours.
2. Worker writes a row to the `approvals` table with `status='pending'`.
3. Worker run pauses on this step (the rest of opencode keeps the session alive — this is not a full task stop). Pause is implemented by the worker awaiting a Postgres NOTIFY on a per-approval channel.
4. For unattended runs (where `automation.approval_channel = 'sms' | 'email'`), the worker fires `send_sms` or `send_email` with a one-line summary and a signed approval link that resolves to a client URL. The link's token is single-use, 4-hour-expiry, stored hashed in `approvals.access_token_hash`.
5. A client decides via `POST /v1/approvals/:id` with `{ decision: 'approve' | 'deny', remember?: boolean }`. The endpoint validates the caller (session auth OR the signed token from the SMS/email link) and the approval expiry.
6. API updates the `approvals` row, emits a Postgres NOTIFY to the worker's pool channel.
7. Worker resumes: tool executes (approve) or returns a structured "denied" result the agent can handle (deny).
8. If approval expires before a decision: API marks the row `status='expired'`, emits an `approval_expired` event, worker's `approval_requested` await rejects with a timeout, and the agent gets a structured "approval timed out" tool result to react to (typically via `report_finding`).

#### 4.3.3 "Approve and don't ask again" rules

When the user approves with that option, a rule is persisted to `approval_rules`:

```ts
{
  workspace_id,
  tool_name,
  args_pattern,    // e.g., { toolSlug: 'GMAIL_SEND_EMAIL', to: 'foo@bar.com' }
  expires_at,      // default 30 days
}
```

The approval check looks at rules first; if a rule matches, skip approval. Rules visible/editable in workspace settings.

### 4.4 Open design decisions + recommendations

- **What if the user doesn't respond before expiry?** Recommendation: emit a `run_paused_awaiting_approval` terminal-ish event, mark the run as `awaiting_approval` (not `failed`), end the worker task. When the user eventually approves, a new worker task spawns and resumes from the approved tool call (using opencode's session resumption). This avoids burning compute on a paused run.
- **Approval authorization scope.** Multi-user workspaces: who can approve? Recommendation: anyone with the workspace's `member` or `owner` role; the approval payload includes the agent identity (which automation, which run) so the approving user can see context. Authorization enforced in the API endpoint, not the worker.
- **Bulk approvals.** Long-running automations might queue 20 approvals in a row. Recommendation: support `POST /v1/runs/:run_id/approvals/bulk` with `{ decision }` to decide all pending approvals for a run atomically; emit a `bulk_approval` event so the audit log shows it as one operation.
- **Approval as a tool the agent calls.** Recommendation: don't expose `request_approval` as a callable tool. Approvals are gates on already-decided tool calls; making them agent-callable creates a path for the agent to "preemptively request approval" which adds latency without value.

### 4.5 Concrete deliverables

- `worker/src/approvals.ts` — pause/resume logic, Postgres notify integration
- Update `defineTool` shape in `@basics/shared` to support `approval` field
- API routes:
  - `POST /v1/approvals/:id` — `{ decision: 'approve' | 'deny', remember?: boolean }`. Accepts session auth OR signed token (from SMS/email link).
  - `GET /v1/approvals/:id` — fetch a pending approval (used by signed-token link resolution).
  - `GET /v1/workspaces/:id/approvals?status=pending` — list pending approvals for a workspace.
  - `POST /v1/runs/:run_id/approvals/bulk` — bulk decide.
- New tables:
  - `approvals` (id, run_id, workspace_id, tool_name, args_preview, args_hash, reason, status, decided_by, decided_at, expires_at, access_token_hash, created_at)
  - `approval_rules` (id, workspace_id, tool_name, args_pattern_json, created_by, expires_at, created_at)
- New activity event types: `approval_requested`, `approval_granted`, `approval_denied`, `approval_expired`, `bulk_approval`, `run_paused_awaiting_approval`
- Notification path: when approval requested AND `automation.approval_channel = 'sms' | 'email'`, fire `send_sms` / `send_email` with a one-line summary + signed token link
- Tests: vitest covering the pause/notify/resume cycle with a fake worker; integration test that POSTs to `/v1/approvals/:id` with both session-auth and signed-token-auth paths and asserts the worker resumes correctly

---

## 5. Workstream — Trigger infrastructure

### 5.1 Goal

Let automations run on their own — fired by Composio webhooks, scheduled cron, or manual REST call — not just when a user types into chat.

### 5.2 Current state

- `/webhooks/composio` endpoint exists and verifies HMAC (`api/src/lib/composio.ts`).
- The body of that endpoint is partially wired but doesn't route to any specific automation today (it's plumbing without destination).
- EventBridge + cron-kicker Lambda exist (referenced in `sst.config.ts`) for the existing scheduled-runs feature, but they fire arbitrary goals, not user-defined automations.
- Manual runs work through `POST /v1/runs` (existing).
- There's no `automations` table — automations don't exist as a persistent entity yet.

### 5.3 Target state

#### 5.3.1 Automations as first-class entities

New table:

```sql
CREATE TABLE automations (
  id              UUID PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  goal            TEXT NOT NULL,         -- the agent's prompt / objective
  context         JSONB,                 -- structured inputs (e.g., sheet schema)
  outputs         JSONB NOT NULL,        -- the outputs schema from §2.4
  triggers        JSONB NOT NULL,        -- the triggers schema from §5.3.2
  approval_policy JSONB,                 -- workspace-level override hints for §4
  version         INT NOT NULL DEFAULT 1,
  created_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at     TIMESTAMPTZ
);
```

Versioning is a simple `version` counter; on edit, increment + write a snapshot to `automation_versions` (id, automation_id, version, snapshot_json, created_at) so historical runs can be replayed against the version that was active at the time. `cloud_runs` gets a nullable `automation_id` + `automation_version` foreign key.

#### 5.3.2 Trigger schema

```ts
triggers: [
  { type: 'manual' },                                                                    // fired by POST /v1/automations/:id/run
  { type: 'schedule', cron: '0 9 * * MON-FRI', timezone: 'America/Los_Angeles' },        // recurring
  { type: 'schedule', at: '2026-06-01T09:00:00Z' },                                      // one-shot
  { type: 'composio_webhook', toolkit: 'GOOGLE_SHEETS', event: 'row_added',
    filters: { spreadsheet_id: 'abc123', sheet_name: 'LP_Pipeline' } },
  { type: 'composio_webhook', toolkit: 'GMAIL', event: 'message_received',
    filters: { from_pattern: '*@portfolioco.com' } },
]
```

Each trigger type has a typed input mapper that produces a `RunInputs` object the agent reads at run start (e.g., for `composio_webhook GOOGLE_SHEETS row_added`, the row's column-keyed object).

#### 5.3.3 Composio webhook routing

`/webhooks/composio` body handler:

1. Verify HMAC (existing).
2. Parse event payload, extract `{ toolkit, event_type, trigger_id, payload }`.
3. Look up `composio_triggers` table by `composio_trigger_id` to find the (workspace, automation) pair this trigger is bound to.
4. Build `RunInputs` from the payload using the trigger's input mapper.
5. Insert a `cloud_runs` row with `automation_id`, `automation_version`, `triggered_by: 'composio_webhook'`, `status: 'pending'`, `inputs: RunInputs`.
6. Publish to `basics-runs.fifo` SQS — dispatcher picks it up as it does manual runs.

For this to work, the automation must register a trigger with Composio. When a user creates an automation with a `composio_webhook` trigger:

1. API calls `ComposioClient.createTrigger({ toolkit, event_type, callback_url, filters })`.
2. Composio returns a `trigger_id`.
3. API persists `{ automation_id, composio_trigger_id }` into `composio_triggers` table.
4. On automation delete: call `ComposioClient.deleteTrigger(composio_trigger_id)` and remove the row.

#### 5.3.4 Scheduled triggers

EventBridge cron rules fire on the cron expression. The cron-kicker Lambda receives the event with the trigger ID, looks up the automation, builds an empty `RunInputs` (or a context-derived one), and dispatches to SQS like any other trigger.

One EventBridge rule per active schedule (created/deleted as automations are saved/archived). For one-shot `at` triggers, the rule is deleted after firing.

Recommendation: cap at 100 active scheduled automations per workspace (soft limit, enforced at the create/update endpoint and exposed in `GET /v1/workspaces/:id/quotas`); EventBridge has account-wide quotas but they're high enough not to worry.

#### 5.3.5 Manual triggers

`POST /v1/automations/:id/run` with optional `{ inputs?: object }` to override the default empty inputs. Dispatches to SQS like the others.

### 5.4 Open design decisions + recommendations

- **Polling-based triggers.** Some sources (calendar checks, "every 4 hours look for new GitHub stars") have no webhook. Recommendation: model these as `schedule` triggers — the agent itself polls the source as the first step of its run. Simpler than a dedicated polling subsystem.
- **Trigger debouncing.** A flurry of webhook events (e.g., 20 sheet rows added in 5 seconds) shouldn't spawn 20 simultaneous runs. Recommendation: per-automation debounce window in `triggers[].debounce_ms` (default 30 s), enforced at the webhook handler using a Postgres advisory lock keyed on automation_id.
- **Trigger failure isolation.** If one trigger handler crashes, the others shouldn't be affected. Recommendation: each trigger fires into SQS independently; the webhook handler is dumb and only routes. Errors during run execution surface via the existing `run_failed` event path and don't disable the trigger.
- **Trigger testing.** Users need a way to dry-run a trigger to see what `RunInputs` look like. Recommendation: add `POST /v1/automations/:id/triggers/:trigger_index/test` that simulates the trigger with a synthetic payload and returns the would-be `RunInputs` without spawning a run.
- **Sensitive payload data.** A Gmail trigger fires with full email body in the webhook payload. Recommendation: store webhook payloads in a `trigger_event_log` table with 7-day retention (not in `cloud_runs.inputs` permanently); `cloud_runs.inputs` stores only a digest + a reference to the event log entry.

### 5.5 Concrete deliverables

- New tables:
  - `automations`
  - `automation_versions`
  - `composio_triggers` (automation_id, composio_trigger_id, toolkit, event_type, filters)
  - `trigger_event_log` (id, automation_id, trigger_index, payload, received_at, expires_at)
- Schema updates:
  - `cloud_runs` gets `automation_id`, `automation_version`, `triggered_by`, `inputs` columns
- API routes:
  - `POST /v1/automations` — create
  - `GET /v1/automations` / `GET /v1/automations/:id` — list/get
  - `PUT /v1/automations/:id` — update (increments version)
  - `DELETE /v1/automations/:id` — archive
  - `POST /v1/automations/:id/run` — manual trigger
  - `POST /v1/automations/:id/triggers/:trigger_index/test` — dry-run
- Trigger registration/deregistration on automation create/update/delete (Composio API calls for `composio_webhook`, EventBridge rules for `schedule`)
- Webhook routing logic in `/webhooks/composio` body handler
- Trigger input mappers per trigger type
- Tests: per-trigger-type unit tests; one E2E that creates an automation with a `composio_webhook GOOGLE_SHEETS row_added` trigger, simulates a Composio webhook delivery, and verifies the run spawns with correct `RunInputs`

---

## 6. Cross-cutting

### 6.1 The LP-mapping automation as the testbed

The end-to-end LP automation described in `promp.txt` becomes the integration test for all four workstreams:

- **Trigger** (§5): `composio_webhook GOOGLE_SHEETS row_added` filtered to the LP pipeline sheet.
- **Run** uses unified tools:
  - `composio_call` with `GOOGLE_SHEETS_*` to read the row data into `RunInputs`.
  - Browser-harness + `skills/linkedin.com/flows/find_mutuals.md` for the 2nd-degree mapping (the part Composio can't do).
  - `composio_call("GMAIL_SEARCH", ...)` for relationship-strength signal from past email history.
  - `composio_call("GOOGLE_CALENDAR_LIST_EVENTS", ...)` for meeting history.
  - `composio_call("GOOGLE_SHEETS_APPEND_VALUES", ...)` to write ranked mutuals back.
  - `composio_call("GMAIL_CREATE_DRAFT", ...)` for outreach drafts.
- **Approvals** (§4): drafts of outreach emails require approval before being created (even as drafts) when the recipient count > 5. Sheet writes do not require approval (low-risk).
- **Outputs** (§2): on completion, `send_sms` to the partner with a one-line summary + signed link to the sheet; on failure, `send_email` to the partner with the error and which step failed.

This single automation exercises every workstream. If it works end-to-end, the system works.

### 6.2 Observability

Every activity emitted during a run goes to `cloud_activity` (existing) and gets fanned out via Supabase Realtime. New event types from the above workstreams (`output_dispatched`, `external_action`, `approval_requested`, etc.) need:

- TypeScript types in `@basics/shared` (the source of truth — any client consuming the SSE stream imports from there).
- Inclusion in the existing run-summary email/SMS when a run completes (the digest, generated server-side, needs to mention "3 emails drafted, 5 sheet rows updated" not just "run completed").
- CloudWatch structured logs for each event type so operational issues can be queried/alerted on without touching the application database.

### 6.3 Security

- **Webhook origin verification.** `/webhooks/composio` already HMAC-verifies; do not relax this.
- **Approval-link tokens.** SMS approval links use signed, single-use, 4-hour-expiry tokens. Token stored hashed in `approvals.access_token_hash`; never logged.
- **Output channel injection.** A malicious automation goal could try to use `send_email` to spam. Defense: per-workspace quotas (§2.5), per-workspace denylist of recipients matching abuse patterns (default: deny sends to disposable-email domains unless workspace explicitly allows).
- **External_action_audit retention.** PII surfaces in tool params. Recommendation: 30-day retention, encrypted at rest (RDS default), workspace-scoped read access only.
- **Approval bypass via tool name aliasing.** An agent that has somehow learned a tool name's args-pattern could try to construct a call that doesn't match the approval rule. Recommendation: approval check uses the *canonical* tool name + args after schema validation, not the agent's claimed name.

### 6.4 Client API contract (consumed by any future UI / CLI / third-party)

Out of scope to build any client, but listing the endpoints + events this plan exposes so a client can be built later against a stable contract:

**REST endpoints introduced by this plan:**

- `POST /v1/automations` — create
- `GET /v1/automations` / `GET /v1/automations/:id` — list/get
- `PUT /v1/automations/:id` — update (increments version)
- `DELETE /v1/automations/:id` — archive
- `POST /v1/automations/:id/run` — manual trigger
- `POST /v1/automations/:id/triggers/:trigger_index/test` — dry-run trigger
- `GET /v1/automations/:id/versions` — version history
- `POST /v1/approvals/:id` — decide a single approval
- `GET /v1/approvals/:id` — fetch a pending approval (signed-token-link target)
- `GET /v1/workspaces/:id/approvals?status=pending` — list pending approvals
- `POST /v1/runs/:run_id/approvals/bulk` — bulk decide
- `GET /v1/workspaces/:id/quotas` — output quotas + scheduled-automation count

**Activity event types introduced by this plan** (all typed in `@basics/shared`):

- `output_dispatched`, `output_failed`
- `external_action`, `connection_expired`, `external_rate_limit`
- `approval_requested`, `approval_granted`, `approval_denied`, `approval_expired`, `bulk_approval`, `run_paused_awaiting_approval`

All endpoints follow the existing auth + workspace-scoping patterns in `api/src/middleware/`.

---

## 7. Data model summary

New tables introduced by this plan:

- `automations` — user-defined workflows
- `automation_versions` — historical snapshots for replay/audit
- `composio_triggers` — Composio trigger registrations linked to automations
- `trigger_event_log` — webhook payloads with short retention
- `approvals` — per-tool approval requests
- `approval_rules` — "don't ask again" persistence
- `composio_tool_cache` — per-workspace per-toolkit Composio tool schemas, 1-hour TTL
- `external_action_audit` — full params log for external mutating actions, 30-day retention
- `workspace_output_quotas` — per-channel daily counters

Schema changes to existing tables:

- `cloud_runs` gets `automation_id`, `automation_version`, `triggered_by`, `inputs`

All migrations land in `api/drizzle/` as numbered SQL files, atomic per workstream.

---

## 8. Order of execution

Workstreams are ordered by dependency, not effort:

1. **Output channel tools** — no dependencies; lands first; unlocks manual A/B testing of the LP automation today (user types into chat, agent delivers to phone).
2. **Composio worker unification** — depends on nothing from §3 onwards; unlocks the agent doing real Gmail/Sheets/Calendar work autonomously.
3. **Approvals gate** — depends on §3 (so we have mutating tools to gate); makes §3 safe to enable for production workspaces.
4. **Trigger infrastructure** — depends on §3 (Composio webhooks) and §2 (outputs schema) and §4 (approval policy field on automations). Final workstream because it's what makes automations run without a human in the chat.

The LP-mapping automation (§6.1) is the acceptance test for the whole plan. Until that automation runs end-to-end on a real schedule, the plan isn't done.

---

## 9. Execution (loop-readable phases)

This section is the **program counter** for the autonomous build loop. The loop runner (driven by the `/loop` prompt) reads this section + `docs/.automation-loop/state.json` each iteration, picks the next pending step, runs its `do` block against real infrastructure, captures `evidence` to `docs/.automation-loop/artifacts/<phase>/<step>/`, and runs the `verify` block to confirm the step actually worked.

The runner's protocol (state file schema, gate rules, retry caps, adversarial-review trigger conditions) lives in the `/loop` invocation prompt — this doc only defines *what to build* and *how to prove it built correctly*. Step `kind` controls whether the adversarial reviewer is spawned: `code` steps go through review; `infra` and `verify-only` steps do not.

> **Stage policy (carried over from BUILD-LOOP §A intro):** all AWS deploys go to `--stage production`. The production stage has no real users yet, so the stg→prd cutover is collapsed. Supabase migrations land against the single project `Basics` (ref `xihupmgkamnfbzacksja`). Doppler `dev`/`stg`/`prd` configs are unrelated to AWS stages.

### How to run it

```
/loop <paste contents of promp.txt>
```

`/loop` without an interval lets the model self-pace via `ScheduleWakeup`. To pause: write `"paused": true` into `state.json`. To resume: re-issue `/loop`. To abort: delete `docs/.automation-loop/state.json` and start over.

---

### Phase A — Output channels

**Goal**: `send_sms`, `send_email`, `attach_artifact` tools live in the worker tool registry; SES is provisioned via IaC; per-workspace output quotas enforce daily caps; a chat-driven run can deliver results to SMS, email, and signed S3 URLs.

#### A.1 — Wire output secrets into the worker task definition

- **do**: edit `sst.config.ts` worker container env block (currently at ~`sst.config.ts:585-598`) to inject `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SES_FROM_EMAIL` from the SST secrets already declared in `sst.config.ts` (`secrets.sendblueApiKey`, `secrets.sendblueApiSecret`, `secrets.sesFromEmail` — values populated in SSM under the production stage), plus `ARTIFACTS_S3_BUCKET` interpolated from `artifactsBucket.name`. Do NOT add `SENDBLUE_SIGNING_SECRET` (only needed by the inbound-webhook handler on the API service, already wired there). Run `pnpm sst deploy --stage production`.
- **verify**: `aws ecs describe-task-definition --task-definition basics-worker --query 'taskDefinition.containerDefinitions[0].environment[?name==\`SENDBLUE_API_KEY\` || name==\`SES_FROM_EMAIL\` || name==\`ARTIFACTS_S3_BUCKET\`]'` returns three rows.
- **evidence**: `task-def-after.json`, `sst-deploy.log`.
- **gates**: `sst deploy --stage production` auto-granted.
- **kind**: infra.

#### A.2 — Codify SES sender identity + bounce/complaint SNS topic in IaC

- **do**: extend `sst.config.ts` with `aws.sesv2.EmailIdentity` for the `trybasics.ai` domain (DKIM enabled, MAIL FROM `bounces.trybasics.ai`), an `aws.sesv2.ConfigurationSet` named `basics-runtime-outbound`, an `aws.sns.Topic` named `basics-ses-events`, and an `aws.sesv2.ConfigurationSetEventDestination` routing `BOUNCE` + `COMPLAINT` + `DELIVERY` events to that topic. Add an `aws.sns.TopicSubscription` to a CloudWatch Logs delivery stream so events are queryable. Grant the worker task role `ses:SendEmail`, `ses:SendRawEmail` scoped to the EmailIdentity ARN. Run `pnpm sst deploy --stage production`.
- **verify**: `aws sesv2 get-email-identity --email-identity trybasics.ai` shows `VerifiedForSendingStatus: true` and `DkimAttributes.Status: SUCCESS`. `aws sns list-topics` includes the `basics-ses-events` topic. `aws iam get-role-policy --role-name basics-worker-task-role --policy-name basics-worker-ses-policy` (or whatever name SST picks) contains `ses:SendEmail` and `ses:SendRawEmail` with the EmailIdentity ARN.
- **evidence**: `ses-identity.json`, `sns-topic.json`, `worker-role-policy.json`, `sst-deploy.log`.
- **gates**: `sst deploy --stage production` auto-granted.
- **kind**: infra.

#### A.3 — Migration: `workspace_output_quotas` table

- **do**: apply migration via Supabase MCP `apply_migration` named `automations_a3_output_quotas`. Schema: `workspace_output_quotas (workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, channel TEXT NOT NULL, count_today INT NOT NULL DEFAULT 0, reset_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '1 day'), PRIMARY KEY (workspace_id, channel))`. RLS enabled with workspace-scoped policy matching existing convention. Add a helper SQL function `increment_output_quota(workspace_id uuid, channel text, cap int)` returning bool (true if within cap, false if exceeded; resets `count_today` when `now() >= reset_at`).
- **verify**: MCP `list_tables` includes `workspace_output_quotas`. MCP `execute_sql` inserts a fixture row for the test workspace, calls `increment_output_quota` three times in a row with cap=2 (expect two trues then a false), deletes the row. `SELECT proname FROM pg_proc WHERE proname = 'increment_output_quota'` returns one row.
- **evidence**: `migration.sql`, `list-tables.json`, `fixture-quota.json`.
- **gates**: `apply_migration` auto-granted (additive).
- **kind**: infra.

#### A.4 — Shared types: output activity events

- **do**: in `shared/src` add `output_dispatched` and `output_failed` activity event variants with Zod schemas. Shape: `{ kind: 'output_dispatched', channel: 'sms' | 'email' | 'artifact', recipient_or_key: string, content_hash: string, attempt: number, latency_ms: number }` and `{ kind: 'output_failed', channel: ..., error: { code: string, message: string }, retriable: boolean }`. Export from `shared/src/index.ts`. Bump shared package types.
- **verify**: `pnpm -F @basics/shared build` succeeds, `pnpm -F @basics/shared test` passes, `pnpm -F @basics/shared exec tsc --noEmit` clean. `grep -E "output_dispatched|output_failed" shared/dist/index.d.ts` returns matches.
- **evidence**: `build.log`, `test.log`, `exports.txt`.
- **gates**: none.
- **kind**: code.

#### A.5 — Implement `attach_artifact` tool

- **do**: create `worker/src/tools/attach_artifact.ts` using `defineTool`. Tool params: `{ name: string (max 200 chars), payload: string (base64 OR utf8), contentType?: string }`. Body: writes to `s3://{ARTIFACTS_S3_BUCKET}/workspaces/{ctx.workspaceId}/runs/{ctx.runId}/{name}`, returns `{ s3Key, signedUrl }` with a 7-day signed URL via `@aws-sdk/s3-request-presigner`. Emits `output_dispatched` with `channel: 'artifact'`. Register in `worker/src/tools/index.ts`.
- **verify**: `pnpm -F @basics/worker test src/tools/attach_artifact.test.ts` covers happy path (1KB upload), oversized payload rejection, name sanitization (no `..`). Live test from a worker shell: invoke the tool, `curl` the signed URL, body matches.
- **evidence**: `test.log`, `e2e-fetch.log`.
- **gates**: none.
- **kind**: code.

#### A.6 — Implement `send_email` tool

- **do**: create `worker/src/tools/send_email.ts` using `defineTool`. Params: `{ to: string | string[], subject: string, body: string, bodyType?: 'text' | 'html' (autodetect: 'html' if first 200 chars contain '<'), attachments?: Array<{ s3Key: string; filename?: string }> }`. Uses `@aws-sdk/client-ses`'s `SendRawEmailCommand` for attachments; `SendEmailCommand` otherwise. Sender = `process.env.SES_FROM_EMAIL`. Attachments > 100 KB inlined as signed-URL links in body, not MIME-attached. Wraps with `increment_output_quota('email', cap=200)`; throws structured `quota_exceeded` error if false. Emits `output_dispatched` on success, `output_failed` on SES error.
- **verify**: vitest unit tests (mocked SES client) cover all branches. Live E2E: invoke the tool from a worker shell with `to = SES_FROM_EMAIL` (loopback), assert SES `MessageId` returned and email arrives within 30 s.
- **evidence**: `test.log`, `e2e-send.log`, `inbox-screenshot.png` (or message-id resolution via SES events topic).
- **gates**: none.
- **kind**: code.

#### A.7 — Implement `send_sms` tool

- **do**: create `worker/src/tools/send_sms.ts` using `defineTool`. Params: `{ to: string (E.164), body: string, mediaUrl?: string }`. POSTs to `https://api.sendblue.co/api/send-message` with HMAC headers built from `SENDBLUE_API_KEY` + `SENDBLUE_API_SECRET`. On SMS-fallback delivery (response indicates not-iMessage), also generate a 140-char summary via a lightweight prompt and resend if `body.length > 160` — return both message IDs. Wraps with `increment_output_quota('sms', cap=50)`. Emits `output_dispatched`.
- **verify**: vitest unit tests (mocked fetch) for iMessage path, SMS-fallback path, quota-exceeded path. Live E2E: invoke from worker shell with `to` = operator's phone, assert delivery via Sendblue API GET `/api/messages/:id`.
- **evidence**: `test.log`, `e2e-send.log`, `sendblue-delivery.json`.
- **gates**: none.
- **kind**: code.

#### A.8 — Output dispatcher (`worker/src/outputs.ts`)

- **do**: create `worker/src/outputs.ts` exporting `dispatchOutputs(ctx, automation, runResult)`. Reads `automation.outputs[]`, filters by `when` (`on_complete` vs `on_failure` vs `always`), invokes the corresponding tool wrapper for each. Aggregates errors and writes a single `output_dispatch_summary` activity event. Called from the worker's run-completion path in `worker/src/main.ts`.
- **verify**: vitest unit tests cover: (a) `on_complete` filter skips when `runResult.status='failed'`, (b) `on_failure` does the opposite, (c) one channel failing doesn't block the others, (d) `output_dispatch_summary` emits with the correct per-channel results.
- **evidence**: `test.log`.
- **gates**: none.
- **kind**: code.

#### A.9 — Smoke E2E: tools work end-to-end in a real run

- **do**: open a chat session against the production API for the operator's workspace; instruct the agent to (a) `attach_artifact` a 1KB JSON blob named "test.json", (b) `send_email` to `SES_FROM_EMAIL` with subject "Phase A smoke", (c) `send_sms` to the operator's phone with body "Phase A smoke". Capture the SSE stream.
- **verify**: SSE shows three `output_dispatched` events with correct channels. Operator's inbox shows the email. Operator's phone shows the SMS. Signed URL from `attach_artifact` resolves to the JSON content. `SELECT * FROM cloud_activity WHERE run_id = ... AND kind = 'output_dispatched'` returns three rows.
- **evidence**: `sse-stream.txt`, `cloud-activity-rows.json`, `signed-url-fetch.json`, `inbox-screenshot.png`, `phone-screenshot.png`.
- **gates**: none.
- **kind**: verify-only.

---

### Phase B — Composio worker unification

**Goal**: the agent has `composio_list_tools` and `composio_call` in its worker tool registry, invoking Composio directly from the worker container with per-workspace connected-account resolution, cached schema discovery, audit logging, and graceful auth-expiry handling.

#### B.1 — Wire `COMPOSIO_API_KEY` into the worker task definition

- **do**: edit `sst.config.ts` worker container env block to inject `COMPOSIO_API_KEY` from the existing `secrets.composioApiKey`. Run `pnpm sst deploy --stage production`.
- **verify**: `aws ecs describe-task-definition --task-definition basics-worker --query 'taskDefinition.containerDefinitions[0].environment[?name==\`COMPOSIO_API_KEY\`]'` returns one row (name only; value never printed).
- **evidence**: `task-def-after.json`, `sst-deploy.log`.
- **gates**: `sst deploy --stage production` auto-granted.
- **kind**: infra.

#### B.2 — Migration: `composio_tool_cache` + `external_action_audit`

- **do**: apply migration `automations_b2_composio_tables` adding `composio_tool_cache (workspace_id UUID, toolkit_slug TEXT, tools_json JSONB NOT NULL, schema_version INT NOT NULL DEFAULT 1, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id, toolkit_slug))` and `external_action_audit (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, workspace_id UUID NOT NULL, run_id UUID NOT NULL, tool_slug TEXT NOT NULL, params_full JSONB NOT NULL, result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'))`. Add pg_cron job `reap-external-action-audit` deleting rows where `expires_at < now()` nightly.
- **verify**: MCP `list_tables` includes both. Fixture: insert one row in each, query back, delete. `SELECT jobname FROM cron.job WHERE jobname = 'reap-external-action-audit'` returns one row.
- **evidence**: `migration.sql`, `list-tables.json`, `fixture.json`, `pg-cron-jobs.txt`.
- **gates**: `apply_migration` auto-granted.
- **kind**: infra.

#### B.3 — Connection resolver at session boot

- **do**: create `worker/src/composio/connection-resolver.ts` exporting `resolveConnectedAccounts(workspaceId): Promise<Map<toolkitSlug, ComposioConnectedAccount>>`. Calls `ComposioClient.listConnectedAccounts({ workspaceId, status: 'ACTIVE' })`, builds the map. Extend `WorkerToolContext` in `worker/src/tools/context.ts` with optional `composio?: { accountsByToolkit: Map<string, ComposioConnectedAccount> }`. Populate it in `worker/src/opencode-plugin/index.ts` at session boot (after the existing `resolveBinding` call). On failure (Composio API down): log and continue with `accountsByToolkit` empty — tools will return `no_connection` errors instead of crashing the run.
- **verify**: vitest with a mocked `ComposioClient` covers happy path and Composio-down path. Live test: spawn a worker session in a workspace with a real Composio connection (e.g., Gmail); `console.log` the resolver output (NOT the full account object — only `Array.from(map.keys())`) and confirm the toolkit slug appears.
- **evidence**: `test.log`, `e2e-resolver-keys.txt` (only toolkit slugs, no auth tokens).
- **gates**: none.
- **kind**: code.

#### B.4 — Postgres-cached schema discovery

- **do**: create `worker/src/composio/cache.ts` exporting `getCachedTools(workspaceId, toolkitSlug)` and `refreshCache(workspaceId, toolkitSlug)`. Cache hit (TTL 1 hour) returns rows from `composio_tool_cache`; miss/expired calls `ComposioClient.listTools({ toolkitSlug })`, writes through. Invalidation: `invalidateCache(workspaceId, toolkitSlug)` called by `composio_call` on schema-mismatch errors.
- **verify**: vitest unit tests for hit/miss/expiry/invalidate. Integration test against real Composio sandbox: call `getCachedTools(testWorkspace, 'GMAIL')` twice within 1 minute, confirm second call hits cache (no second API call observed), then advance `fetched_at` by 2 hours, third call refreshes.
- **evidence**: `test.log`, `e2e-cache.log`, `cache-row.json`.
- **gates**: none.
- **kind**: code.

#### B.5 — Audit emitter with PII scrubber

- **do**: create `worker/src/composio/audit.ts` exporting `emitExternalAction(ctx, toolSlug, paramsFull, result)`. Computes `paramsPreview` by deep-cloning `paramsFull` and replacing string values whose keys match `/^(email|body|content|message|password|token|secret|api_key|auth)$/i` with `<redacted>` (recursive). Emits `external_action` activity event with `paramsPreview`. Writes full audit row to `external_action_audit`.
- **verify**: vitest unit tests cover redaction against fixtures with nested PII (`{ message: { to: 'foo', body: 'secret' } }` → `body` redacted, `to` preserved). Integration: invoke the function, confirm `cloud_activity` has the event with redacted preview AND `external_action_audit` has the row with full params.
- **evidence**: `test.log`, `e2e-audit.log`, `activity-row.json`, `audit-row.json`.
- **gates**: none.
- **kind**: code.

#### B.6 — Implement `composio_list_tools` tool

- **do**: create `worker/src/tools/composio_list_tools.ts` using `defineTool`. Params: `{ toolkit?: string, query?: string }`. If `toolkit` provided: returns cached tool list for that toolkit (via B.4). Else: returns list of toolkit slugs the workspace has connected (from B.3 resolver). `query` filters by substring match against `name` + `description`. Tool result shape: `{ tools: [{ slug, name, description, paramSchema }] }`. Register in `worker/src/tools/index.ts`.
- **verify**: vitest mocked-cache tests cover both modes. E2E: from a real session in a workspace with Gmail connected, agent invokes `composio_list_tools({ toolkit: 'GMAIL' })`, response includes `GMAIL_SEND_EMAIL` and other Gmail tools.
- **evidence**: `test.log`, `e2e-list.log`.
- **gates**: none.
- **kind**: code.

#### B.7 — Implement `composio_call` tool

- **do**: create `worker/src/tools/composio_call.ts` using `defineTool`. Params: `{ toolSlug: string, params: Record<string, unknown> }`. Behavior: (a) resolve `connectedAccountId` for the toolkit (from B.3 resolver); if missing emit `connection_expired` event and return `{ ok: false, error: { code: 'no_connection', toolkitSlug } }`. (b) call `ComposioClient.executeTool(toolSlug, connectedAccountId, params)`. (c) on 401/403 or `CONNECTION_EXPIRED`: emit `connection_expired`, invalidate connection in context, return structured error. (d) on 429: emit `external_rate_limit`, return structured retry hint. (e) on schema-mismatch error: call `invalidateCache`, retry once with fresh schema. (f) always emit `external_action` via B.5 audit, return `{ ok: true, result }`. Apply per-toolkit semaphore (default 3 concurrent) keyed on `toolSlug.split('_')[0]`.
- **verify**: vitest with mocked ComposioClient covers all 6 branches (a-f). E2E happy path against real Composio: `composio_call("GMAIL_LIST_THREADS", { max_results: 1 })` from a session in a workspace with Gmail connected, response includes `result.threads`. `SELECT * FROM external_action_audit WHERE tool_slug = 'GMAIL_LIST_THREADS' ORDER BY created_at DESC LIMIT 1` returns the row.
- **evidence**: `test.log`, `e2e-call.log`, `audit-row.json`.
- **gates**: none.
- **kind**: code.

#### B.8 — Per-workspace mutating-action denylist

- **do**: extend `composio_call` (or add `worker/src/composio/denylist.ts`) to consult `workspaces.agent_settings.composio_denylist` (array of tool-slug regex patterns) before executing. Default denylist (auto-applied unless workspace opts out): `[/_DELETE_/, /_REMOVE_/, /_DROP_/, /_PURGE_/, /_WIPE_/]`. Match → return `{ ok: false, error: { code: 'denied_by_policy', toolSlug } }` without making the API call.
- **verify**: vitest tests cover default denylist match, workspace-override opt-out, custom denylist addition. E2E: attempt `composio_call("GMAIL_DELETE_THREAD", ...)` from a default workspace, expect `denied_by_policy`. Update workspace agent_settings to remove `GMAIL_DELETE_THREAD` from effective denylist, retry, expect attempted execution.
- **evidence**: `test.log`, `e2e-denylist.log`.
- **gates**: none.
- **kind**: code.

#### B.9 — Smoke E2E: agent uses Composio + browser-harness in one run

- **do**: chat session in a workspace with Gmail connected (via the existing dashboard OAuth path). Prompt: "Search my Gmail for the most recent email from anyone at trybasics.ai and reply with a summary of its subject and first 200 chars of body."
- **verify**: SSE stream shows the agent calling `composio_call("GMAIL_LIST_THREADS", ...)` then `composio_call("GMAIL_GET_THREAD", ...)`, then producing a `final_answer` with the summary. `cloud_activity` rows for `external_action` events show the calls. `external_action_audit` rows persisted. No `connection_expired` or `denied_by_policy` errors.
- **evidence**: `sse-stream.txt`, `external-action-rows.json`, `audit-rows.json`, `final-answer.txt`.
- **gates**: none.
- **kind**: verify-only.

---

### Phase C — Approvals gate

**Goal**: tools annotated with `approval` pause execution and emit an `approval_requested` event; the API exposes endpoints for decisions; a worker run resumes on approve, gracefully fails on deny, and times out cleanly on expiry.

#### C.1 — Migration: `approvals` + `approval_rules`

- **do**: apply migration `automations_c1_approvals_tables`. Schema: `approvals (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, run_id UUID NOT NULL REFERENCES cloud_runs(id) ON DELETE CASCADE, workspace_id UUID NOT NULL, tool_name TEXT NOT NULL, tool_call_id TEXT NOT NULL, args_preview JSONB NOT NULL, args_hash TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired')), decided_by UUID REFERENCES users(id), decided_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL, access_token_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())` and `approval_rules (id UUID DEFAULT gen_random_uuid() PRIMARY KEY, workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, tool_name TEXT NOT NULL, args_pattern_json JSONB NOT NULL, created_by UUID NOT NULL REFERENCES users(id), expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'), created_at TIMESTAMPTZ NOT NULL DEFAULT now())`. RLS on both. Index `approvals(run_id, status)`, `approval_rules(workspace_id, tool_name)`. pg_cron `reap-expired-approvals` every minute setting `status='expired'` where `now() >= expires_at AND status='pending'` and emitting an `approval_expired` event into `cloud_activity` (via trigger).
- **verify**: MCP `list_tables` includes both. Fixture insert/delete roundtrip on each. `SELECT jobname FROM cron.job WHERE jobname = 'reap-expired-approvals'` returns one row.
- **evidence**: `migration.sql`, `list-tables.json`, `fixture.json`, `pg-cron-jobs.txt`.
- **gates**: `apply_migration` auto-granted.
- **kind**: infra.

#### C.2 — Extend `defineTool` shape with `approval` field

- **do**: in `shared/src/tools/define.ts` (or wherever `defineTool` lives) add optional `approval?: (args: T) => { required: boolean; reason?: string; expiresInSeconds?: number }` field to the tool definition shape. Export new type `ToolApprovalDecision`. No behavior change to tool execution path yet — wiring lands in C.4.
- **verify**: `pnpm -F @basics/shared build`, `pnpm -F @basics/shared test`, `tsc --noEmit` all pass. `grep -E "approval\\?" shared/dist/index.d.ts` returns the new field.
- **evidence**: `build.log`, `test.log`, `type-extract.txt`.
- **gates**: none.
- **kind**: code.

#### C.3 — Annotate sensitive tools with default `approval` policies

- **do**: edit `send_email`, `send_sms`, `composio_call`, `bash` tool files to add `approval` functions per §4.3.1 defaults: email requires approval when `to.length > 1`; SMS always requires; composio_call requires when `toolSlug` matches the default mutating-action regex set; bash requires when command matches destructive patterns (`/^\\s*(rm\\s+-rf|mv\\s+|chmod\\s+777|chown\\s+|dd\\s+|mkfs)/`). Also implement the rule lookup: before returning `required: true`, check `approval_rules` for a matching row; if found, return `required: false`.
- **verify**: vitest unit tests for each tool's approval function across representative args. Rule lookup tests verify a rule match short-circuits the default policy. Integration test: insert an approval rule for `send_email to=foo@bar.com`, call the approval function, expect `required: false`.
- **evidence**: `test.log`.
- **gates**: none.
- **kind**: code.

#### C.4 — Worker pause/resume on approval

- **do**: create `worker/src/approvals.ts` exporting `awaitApproval(ctx, tool, args, approvalSpec): Promise<'approved' | 'denied' | 'expired'>`. Body: (a) generate signed access token, hash it, (b) insert `approvals` row with `status='pending'`, (c) emit `approval_requested` event with `args_preview` (PII-scrubbed via B.5 helper), reason, expires_at, (d) `LISTEN approval_<approval_id>` on Postgres, (e) await NOTIFY with timeout = `expires_at`, (f) on NOTIFY: re-query `approvals` for final status, return decision string. Wrap tool execution in `worker/src/tools/index.ts`: if `tool.approval(args).required && !ruleMatches`, call `awaitApproval`; on `'approved'` proceed; on `'denied'` return structured deny result; on `'expired'` emit `run_paused_awaiting_approval`, throw a `RunPausedError` that the worker main loop catches and uses to end the task cleanly (run row stays in `awaiting_approval` status).
- **verify**: vitest with a fake Postgres NOTIFY layer covers approved, denied, expired paths. Integration test: trigger an approval, SQL-INSERT decision via `mcp__supabase__execute_sql`, NOTIFY manually, worker resumes within 2 s.
- **evidence**: `test.log`, `e2e-pause-resume.log`.
- **gates**: none.
- **kind**: code.

#### C.5 — API: approval endpoints

- **do**: create `api/src/routes/approvals.ts` with: `POST /v1/approvals/:id` (auth: session JWT OR signed token query param), `GET /v1/approvals/:id`, `GET /v1/workspaces/:id/approvals?status=pending`, `POST /v1/runs/:run_id/approvals/bulk`. On `POST /v1/approvals/:id` with `{ decision, remember? }`: validate expiry, update `approvals.status` + `decided_by` + `decided_at`, on `remember=true` insert into `approval_rules` (key off `tool_name` + `args_hash` pattern), emit `approval_granted` or `approval_denied` activity event, `pg_notify('approval_<id>', '...')`. Mount routes in `api/src/app.ts`.
- **verify**: vitest covers each endpoint (auth, expiry, decision recorded, NOTIFY sent). Live integration: from a curl session, decide a pending approval, confirm worker resumes (verify via SSE + `cloud_runs.status` transition).
- **evidence**: `test.log`, `e2e-decide.log`, `notify-trace.log`.
- **gates**: none.
- **kind**: code.

#### C.6 — Notification path for unattended approvals

- **do**: in `worker/src/approvals.ts`, after emitting `approval_requested`, check `automation.approval_channel`. If `'sms'`, build a 140-char summary including a signed approval link (`https://app.trybasics.ai/approvals/<id>?token=<signed>`) and invoke `send_sms` tool internally. If `'email'`, invoke `send_email`. Sign the token with `WORKSPACE_JWT_SECRET`, 4-hour expiry, single-use (hash stored in `approvals.access_token_hash`). API endpoint (C.5) verifies the token against the hash.
- **verify**: integration test creates an automation with `approval_channel: 'sms'`, triggers an approval, asserts the operator's phone receives the message and the link, follows the link, posts decision via signed-token auth, confirms run resumes.
- **evidence**: `test.log`, `e2e-sms-approval.log`, `phone-screenshot.png`.
- **gates**: none.
- **kind**: code.

#### C.7 — Smoke E2E: approval round-trip with both decisions

- **do**: two chat sessions. Session 1: prompt agent to `send_email` to a list of 3 recipients; expect approval pause; POST `/v1/approvals/:id` with `approve`; expect run resumes and emails are sent. Session 2: same prompt; POST with `deny`; expect `final_answer` indicating the agent gracefully handled the denial.
- **verify**: For session 1: `cloud_activity` shows `approval_requested` → `approval_granted` → `output_dispatched` × 3. For session 2: `cloud_activity` shows `approval_requested` → `approval_denied` → `report_finding` describing the denial. `approvals` table has both rows with correct `status`.
- **evidence**: `sse-session-1.txt`, `sse-session-2.txt`, `approvals-rows.json`, `activity-rows.json`.
- **gates**: none.
- **kind**: verify-only.

---

### Phase D — Trigger infrastructure

**Goal**: automations are first-class records; triggers fire from manual REST calls, scheduled cron, and Composio webhooks; the LP-mapping automation runs end-to-end unattended.

#### D.1 — Migration: `automations` + `automation_versions` + `composio_triggers` + `trigger_event_log` + `cloud_runs` column additions

- **do**: apply migration `automations_d1_core`. Schemas per §7 data-model summary and §5.3 trigger schema. Notable details: `automations.triggers JSONB NOT NULL DEFAULT '[]'`; `cloud_runs.automation_id UUID REFERENCES automations(id)`, `cloud_runs.automation_version INT`, `cloud_runs.triggered_by TEXT CHECK (triggered_by IN ('manual','schedule','composio_webhook'))`, `cloud_runs.inputs JSONB DEFAULT '{}'`. Index `composio_triggers(composio_trigger_id)`. `trigger_event_log.expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')` with a pg_cron reaper.
- **verify**: MCP `list_tables` shows all new tables. `information_schema.columns` query confirms the four new `cloud_runs` columns. Fixture insert/delete on each new table. Reaper job present.
- **evidence**: `migration.sql`, `list-tables.json`, `cloud-runs-columns.json`, `fixture.json`, `pg-cron-jobs.txt`.
- **gates**: `apply_migration` auto-granted.
- **kind**: infra.

#### D.2 — API: automations CRUD

- **do**: create `api/src/routes/automations.ts` with `POST /v1/automations`, `GET /v1/automations`, `GET /v1/automations/:id`, `PUT /v1/automations/:id` (increments `version`, snapshots prior to `automation_versions`), `DELETE /v1/automations/:id` (soft delete via `archived_at`), `GET /v1/automations/:id/versions`. Workspace-scoped auth. Zod-validate `triggers` and `outputs` against the schemas from §5.3.2 and §2.4. Mount in `api/src/app.ts`.
- **verify**: vitest covers all endpoints with auth + invalid-body cases. Integration test: create automation, GET, PUT (verify version 2 + snapshot row), DELETE (verify `archived_at`), GET-after-delete returns 404.
- **evidence**: `test.log`, `e2e-crud.log`.
- **gates**: none.
- **kind**: code.

#### D.3 — Manual trigger endpoint

- **do**: add `POST /v1/automations/:id/run` to `api/src/routes/automations.ts`. Body: `{ inputs?: object }`. Behavior: insert `cloud_runs` row with `automation_id`, `automation_version`, `triggered_by: 'manual'`, `inputs`, `status: 'pending'`. Publish to `basics-runs.fifo` SQS with the run id as `MessageGroupId` (workspace_id).
- **verify**: vitest unit covers auth + payload validation. Integration: POST, observe SQS message via `aws sqs receive-message`, confirm dispatcher Lambda picks up and worker boots with the right inputs (check `cloud_runs.inputs`).
- **evidence**: `test.log`, `e2e-manual-trigger.log`, `sqs-receive.json`.
- **gates**: none.
- **kind**: code.

#### D.4 — Trigger registration on create / update / delete

- **do**: in the automation CRUD path (D.2), when `triggers[]` contains `composio_webhook`: call `ComposioClient.createTrigger({ toolkit, event_type, callback_url: 'https://api.trybasics.ai/webhooks/composio', filters })`, persist `composio_triggers (automation_id, composio_trigger_id, toolkit, event_type, filters)`. When the trigger entry is removed or automation deleted: call `ComposioClient.deleteTrigger(composio_trigger_id)` and delete the row. For `schedule` triggers: create an `aws.scheduler.Schedule` (EventBridge Scheduler — finer-grained than `cron`) via the AWS SDK at the API layer, tagged with `automation_id`. On delete: delete the schedule.
- **verify**: integration test creates an automation with both a `composio_webhook` trigger and a `schedule` trigger. Verify: Composio API GET trigger returns the row; `aws scheduler list-schedules` includes the new schedule. Delete the automation; both are removed.
- **evidence**: `test.log`, `e2e-registration.log`, `composio-trigger.json`, `eventbridge-schedules.json`.
- **gates**: none.
- **kind**: code.

#### D.5 — Composio webhook routing into runs

- **do**: extend `/webhooks/composio` body handler (currently in `api/src/routes/composio.ts`) so on event type `composio.trigger.message`: (a) look up `composio_triggers` by `composio_trigger_id` from the event payload, (b) load the automation, (c) build `RunInputs` using a per-toolkit input mapper (e.g., Sheets `row_added` → `{ row: { ...columnValues } }`), (d) insert `trigger_event_log` row with full payload + automation_id, (e) insert `cloud_runs` row with `triggered_by: 'composio_webhook'`, `inputs`, (f) publish to SQS. Also handle `composio.connected_account.expired` (mark connection inactive, emit `connection_expired` activity event into latest open run for that workspace) and `composio.trigger.disabled` (mark the `composio_triggers` row inactive, alert via output channel if automation has one).
- **verify**: integration test posts a synthetic Composio `trigger.message` event for a test sheet trigger with a valid HMAC sig; confirms run spawns with expected `RunInputs`, `trigger_event_log` row exists, dispatcher picks up. Posts an `account.expired` event; confirms connection marked inactive and event surfaces.
- **evidence**: `test.log`, `e2e-webhook-flow.log`, `trigger-event-log-row.json`, `run-row.json`.
- **gates**: none.
- **kind**: code.

#### D.6 — Scheduled trigger execution

- **do**: the EventBridge Scheduler schedules from D.4 target the existing cron-kicker Lambda. Extend the cron-kicker handler in `worker/cron-kicker/handler.ts` to recognize an `automation_id` in the event payload, look up the automation, build empty `RunInputs` (or context-derived), insert `cloud_runs`, publish to SQS — same path as D.3 manual trigger.
- **verify**: integration test: create an automation with a 1-minute-future one-shot schedule trigger, wait for fire, confirm run spawns. OR: invoke the EventBridge target manually via `aws scheduler get-schedule` + manual invocation, confirm run.
- **evidence**: `test.log`, `e2e-schedule-fire.log`, `cron-kicker-log.json`, `run-row.json`.
- **gates**: none.
- **kind**: code.

#### D.7 — Trigger debouncing

- **do**: in the Composio webhook handler (D.5) and cron-kicker (D.6), before dispatching to SQS, acquire a Postgres advisory lock keyed on `hashtext(automation_id::text)` with a `pg_try_advisory_xact_lock` and check `cloud_runs` for any run created in the last `triggers[i].debounce_ms` (default 30 s); if found, skip dispatch and emit a `trigger_debounced` activity event into the latest run.
- **verify**: integration test fires 5 webhook events within 5 s; confirm only the first spawns a run and 4 `trigger_debounced` rows land in the latest run's activity.
- **evidence**: `test.log`, `e2e-debounce.log`, `debounced-events.json`.
- **gates**: none.
- **kind**: code.

#### D.8 — Trigger dry-run endpoint

- **do**: add `POST /v1/automations/:id/triggers/:trigger_index/test` to `api/src/routes/automations.ts`. Body: `{ synthetic_payload?: object }`. Runs the trigger's input mapper against either the synthetic payload or a canned default per trigger type, returns the resulting `RunInputs` without dispatching.
- **verify**: vitest covers each trigger type. Integration: dry-run a Sheets trigger with a synthetic row payload, confirm response shape; verify no SQS message produced.
- **evidence**: `test.log`, `e2e-dry-run.log`, `sqs-quiet.txt`.
- **gates**: none.
- **kind**: code.

#### D.9 — LP-mapping acceptance E2E

- **do**: through the API (`POST /v1/automations`), create the LP-mapping automation per §6.1 spec. Triggers: `composio_webhook GOOGLE_SHEETS row_added` filtered to a test LP pipeline sheet. Outputs: SMS to operator on completion, email on failure. Approval policy: `GMAIL_CREATE_DRAFT` requires approval when `to` count > 5 (won't trigger here since drafts are 1:1 with mutuals). In the test Google Sheet, add a row with one LP whose LinkedIn URL is known and at least one mutual exists (use a controlled fixture LP whose mutuals you can verify by hand). Wait up to 15 minutes for the trigger to fire and the run to complete.
- **verify**: `cloud_runs` row appears with `triggered_by: 'composio_webhook'`, status transitions to `completed`. `cloud_activity` stream shows: at least one `external_action` for Gmail/Sheets/Calendar, at least one `tool_call` for browser-harness on LinkedIn, at least one `external_action` for `GMAIL_CREATE_DRAFT`, one `external_action` for the Sheets writeback, finally `output_dispatched` with `channel: 'sms'`. Inspect the Google Sheet — the LP row has populated Mutual columns. Operator's phone shows the completion SMS. No `approval_requested` events fired (since draft count ≤ 5). External_action_audit shows the run's full audit trail with PII-scrubbed previews and full params in the audit table.
- **evidence**: `lp-run.log`, `cloud-runs-row.json`, `activity-stream.json`, `sheet-after-screenshot.png`, `phone-sms-screenshot.png`, `audit-rows.json`.
- **gates**: none.
- **kind**: verify-only.

---

### Phase E — Browser session credentials + authoring dry-run

**Goal**: two workstreams shipped together. (1) Any workflow that needs a logged-in browser session works without LinkedIn-style anti-bot gating, via a generic per-host saved browser context (one-time user login, reused across runs). (2) Automations are authorable end-to-end as drafts that can be **dry-run** with the agent — same code path as production runs, but mutating outbound tools (`send_email`, `send_sms`, mutating `composio_call`) are intercepted at the tool layer and recorded into a preview buffer instead of dispatching. Triggers only get registered when the operator explicitly activates a draft.

#### E.1 — Migration: `workspace_browser_sites` + reaper

- **do**: apply migration `automations_e1_browser_sites` via Supabase MCP. Schema: `workspace_browser_sites (workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, host TEXT NOT NULL, display_name TEXT, storage_state_json JSONB NOT NULL, captured_via TEXT NOT NULL CHECK (captured_via IN ('browserbase_liveview','sync_local_profile','manual_upload')), last_verified_at TIMESTAMPTZ, expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '60 days'), created_by UUID REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id, host))`. RLS enabled with workspace-scoped policy matching existing convention. pg_cron job `reap-expired-browser-sites` runs daily at 03:30 UTC, DELETEs rows where `expires_at < now()` and emits a `browser_session_expired` activity event into the latest open run for that workspace (so the agent or operator gets notified). Mirror to `api/drizzle/0025_browser_sites.sql` + journal idx 25.
- **verify**: MCP `list_tables` includes `workspace_browser_sites`. `SELECT jobname FROM cron.job WHERE jobname = 'reap-expired-browser-sites'` returns one row. Fixture round-trip: INSERT one row with the operator workspace + host `linkedin.com` + a placeholder `storage_state_json='{}'::jsonb` + `expires_at = now() - interval '1 minute'`, manually `SELECT cron.job_run_details ORDER BY start_time DESC LIMIT 1` or call the reaper function inline, confirm the row is gone and the `browser_session_expired` event landed (if any open run exists; otherwise the trigger no-ops cleanly). Clean up.
- **evidence**: `migration.sql`, `list-tables.json`, `fixture.json`, `pg-cron-jobs.txt`.
- **gates**: `apply_migration` auto-granted (additive).
- **kind**: infra.

#### E.2 — Worker: browser context loader (`browser-sites/loader.ts`)

- **do**: create `worker/src/browser-sites/loader.ts` exporting `loadStorageStateForUrl(sql, workspaceId, url): Promise<{ host: string; storageState: object } | null>` and `markBrowserSiteVerified(sql, workspaceId, host)`. The loader extracts the host from the URL (registrable domain — `www.linkedin.com` and `linkedin.com` both match `linkedin.com`), SELECTs the matching row from `workspace_browser_sites`, returns its `storage_state_json`. Extend `WorkerToolContext` in `worker/src/tools/context.ts` with optional `browserSites?: { sql: Sql; workspaceId: string }`. Wire it in `worker/src/opencode-plugin/index.ts` at session boot. In the existing browser-harness tool integration path (`worker/src/tools/goto_url.ts` / wherever the harness session is initialized), call `loadStorageStateForUrl` before the first navigation; if a state is found, pass it to the harness session-create call as `browserbaseContextStorageState`. Browserbase-side: extend the harness daemon's session-create options to accept a `storageState` blob and pass it through to `browserbase.sessions.create({ context: { storageState } })`. Schema migration to `browser-harness` is OUT of scope here — if the harness daemon doesn't yet support the option we surface a `browser_session_storage_state_not_supported` warning and continue without it (existing behavior unchanged for any host without a saved state). On every successful first navigation that does NOT hit a sign-in wall (E.3 detector returns negative), call `markBrowserSiteVerified` to bump `last_verified_at`.
- **verify**: vitest unit tests cover (a) URL → host extraction (`https://www.linkedin.com/in/foo` → `linkedin.com`), (b) loader returns null when no row exists, (c) loader returns storage state when a matching row exists, (d) `markBrowserSiteVerified` updates `last_verified_at`. `pnpm -F @basics/worker test src/browser-sites/loader.test.ts` green. `pnpm -F @basics/worker exec tsc --noEmit` clean.
- **evidence**: `test.log`, `tsc.log`.
- **gates**: none.
- **kind**: code.

#### E.3 — Worker: sign-in wall detector + `browser_login_required` event

- **do**: create `worker/src/browser-sites/detector.ts` exporting `detectSignInWall(pageTextOrHtml, currentUrl): { gated: boolean; signal?: string }`. Heuristics (ordered): URL contains `/login`/`/signin`/`/auth/`/`/sso/`/`/sign-in`; page text matches case-insensitive `/sign in to continue|please log in|join linkedin|create an account to view|members can only|requires you to log in/`; common login form selectors detected via the harness's existing DOM probe. Wire into the worker's screenshot/extract pipeline: after each navigation in the agent's harness tool (`goto_url`, `click_at_xy` if it caused navigation, `capture_screenshot` post-step), the loader-aware path calls `detectSignInWall` against the captured text. On `gated: true` for a host with NO saved session: emit `browser_login_required` activity event `{ kind: 'browser_login_required', host, current_url, signal }` into `cloud_activity` AND return a structured error to the tool caller so the agent sees `{ ok: false, error: { code: 'browser_login_required', host } }` rather than getting confused by a login page. On `gated: true` for a host WITH a saved session that has just expired: ALSO emit `browser_session_expired` (refines the generic expired event from E.1) so the API/UI can prompt re-connect. Add it to the existing `worker/src/activity/events.ts` typing (or wherever `connection_expired` already lives).
- **verify**: vitest unit covers each detector branch (URL match, text match, both, neither). Integration sub-test: a fake page object returning a LinkedIn sign-in HTML triggers `gated: true`; a normal LP page returns `gated: false`. `pnpm -F @basics/worker test src/browser-sites/detector.test.ts` green. Shared schema rebuild: `pnpm -F @basics/shared build && pnpm -F @basics/worker exec tsc --noEmit`.
- **evidence**: `test.log`, `tsc.log`.
- **gates**: none.
- **kind**: code.

#### E.4 — API: connect / list / disconnect endpoints for browser sites

- **do**: create `api/src/routes/browser-sites.ts` with the following endpoints (workspace-scoped auth, mounted in `api/src/app.ts`):
  - `POST /v1/workspaces/:workspaceId/browser-sites/:host/connect` — spawns a Browserbase session targeted at a sensible default URL for the host (e.g., `https://www.linkedin.com/`), returns `{ sessionId, liveViewUrl, expiresAt }`. Body optional: `{ initialUrl?: string, displayName?: string }`. Persist a pending row keyed by `(workspaceId, host)` with empty storage_state and `captured_via='browserbase_liveview'`.
  - `POST /v1/workspaces/:workspaceId/browser-sites/:host/finalize` — body `{ sessionId }`. Calls Browserbase's session API to fetch `storageState` (cookies + localStorage), upserts into `workspace_browser_sites` setting `storage_state_json`, `last_verified_at = now()`, `expires_at = now() + 60d`. Optionally calls the Browserbase stop endpoint to release the session. Returns `{ ok: true, host, expiresAt, sizeBytes }` (NEVER returns the storage state itself in the response).
  - `GET /v1/workspaces/:workspaceId/browser-sites` — lists `{ host, displayName, lastVerifiedAt, expiresAt, capturedVia, status: 'active' | 'expiring' | 'expired' }` (with `'expiring'` when `expires_at < now() + interval '7 days'`). Excludes the storage state blob.
  - `DELETE /v1/workspaces/:workspaceId/browser-sites/:host` — deletes the row.
  
  All endpoints require a workspace JWT (no signed-token path here — connect must be operator-driven). Browserbase API calls use the existing `BROWSERBASE_API_KEY` already wired (confirm it's in the api task env; if not, add via `sst.config.ts` and deploy). All endpoint handlers Zod-validate inputs; reject hosts that contain `/`, `?`, `#`, `..`, or anything else that isn't a valid hostname (regex `^[a-z0-9.-]+$`).
- **verify**: vitest covers each endpoint with auth + invalid-body cases (16+ tests). Live e2e: from a curl session against production API with a freshly-minted workspace JWT, POST connect for `linkedin.com`, receive `liveViewUrl` (do NOT actually open it in the verify — the live operator-driven E.6 smoke covers that), GET list shows the pending row, DELETE removes it. Confirm zero secrets logged in artifacts.
- **evidence**: `test.log`, `e2e-crud.log`, `review-1.json`, `sst-deploy.log`.
- **gates**: none.
- **kind**: code.

#### E.5 — Live operator-driven E2E: connect LinkedIn, automation reads gated profile

- **do**: deploy E.1–E.4 to production (worker + api images via `pnpm sst deploy --stage production`). Operator-driven smoke: (a) from this loop's curl session, POST connect for `linkedin.com` in the operator's workspace, surface the `liveViewUrl` to the operator inline (via a clear instruction line; the operator opens it on their device, signs in to LinkedIn manually, then tells the loop "done"). (b) Loop posts `finalize` to capture storage state. (c) Loop creates a one-shot test automation: trigger = manual, goal = "Visit `https://www.linkedin.com/in/satyanadella/` (or any well-known public LP profile), capture the title and current company, return both via `final_answer`", outputs = SMS to operator on complete. (d) Loop POSTs `/v1/automations/:id/run`, waits for completion, captures `cloud_runs.final_answer` + `cloud_activity` stream.
- **verify**: `cloud_runs.status = 'completed'`. `cloud_activity` contains screenshot events from the LinkedIn profile page. ZERO `browser_login_required` events for `linkedin.com` (the saved storageState prevented the gate). `final_answer` contains a non-empty title/company string drawn from the live page (not the sign-in page). Operator phone receives the completion SMS. `workspace_browser_sites.last_verified_at` is bumped relative to the connect timestamp. As a control negative test: DELETE the linkedin.com browser-site row, re-run the same automation, confirm `browser_login_required` event fires and `final_answer` reflects the gated outcome (proving the loader is what unblocked it). Cleanup: DELETE the test automation; preserve the connected browser-site row (operator likely wants it long-term).
- **evidence**: `verify.log`, `cloud-runs-rows.json`, `activity-stream.json`, `browser-sites-row.json`, `phone-sms-screenshot.png`.
- **gates**: requires operator-in-the-loop for the manual LinkedIn login step. The loop pauses and surfaces the liveViewUrl + "tell me 'done' when signed in"; this is operator input, not approval.
- **kind**: verify-only.

#### E.6 — Migration: draft status + dry-run columns

- **do**: apply migration `automations_e6_dry_run` via Supabase MCP. Changes: (a) add `automations.status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived'))` (back-fill existing rows to `'active'`); rename the existing `archived_at` soft-delete to NOT change behavior — `status='archived'` is set alongside `archived_at` when DELETE fires (transition is idempotent). Add a partial index `WHERE status = 'draft'` on `(workspace_id, created_at DESC)` for listing drafts. (b) add `cloud_runs.dry_run BOOLEAN NOT NULL DEFAULT false` and `cloud_runs.dry_run_actions JSONB NOT NULL DEFAULT '[]'::jsonb`. (c) The `triggered_by` CHECK constraint expands to include `'dry_run'`. Mirror to `api/drizzle/0026_dry_run.sql` + journal idx 26.
- **verify**: MCP `list_tables` shape check via `information_schema.columns` confirms (status, dry_run, dry_run_actions). Fixture round-trip: insert a draft automation, list with `status='draft'` filter, transition to `'active'`, query partial index via `EXPLAIN`. Insert a `cloud_runs` row with `dry_run=true` + `triggered_by='dry_run'` + a sample `dry_run_actions` array of 2 elements, query it back, confirm JSONB shape preserved.
- **evidence**: `migration.sql`, `list-tables.json`, `cloud-runs-columns.json`, `fixture.json`.
- **gates**: `apply_migration` auto-granted.
- **kind**: infra.

#### E.7 — Worker: tool-layer dry-run gate

- **do**: introduce a tool-layer `DryRunInterceptor` in `worker/src/dry-run/interceptor.ts`. Wraps the existing tool execution path (where `awaitApproval` already wraps tools per C.4 — same hook point). On a `cloud_runs.dry_run = true` run: any tool with `defineTool(...).effects` marked `'mutating-outbound'` (a new tag we add to `send_email`, `send_sms`, and `composio_call` when the called Composio toolSlug matches the mutating-action regex set from B.8) is intercepted — instead of executing, the interceptor appends an entry `{ tool, args, intended_at, hypothetical_result: 'dry_run_simulated' }` to a per-run in-memory buffer AND emits a `dry_run_action` activity event with the PII-scrubbed preview. At run completion (in `worker/src/main.ts`'s completion path, alongside the existing `output_dispatch_summary` emit), the buffer is flushed into `cloud_runs.dry_run_actions` via UPDATE. Read-only tools (Gmail list, Sheets read, browser screenshots, `composio_call` for non-mutating slugs) execute normally — the preview is meaningless without real reads. The dry-run interceptor also short-circuits the `worker/src/outputs.ts` per-automation outputs dispatcher (D.3 wiring): on `dry_run=true`, dispatcher records intended outputs into the buffer instead of invoking the channel tools. Approval gates (Phase C) are bypassed entirely in dry-run mode — all gated tools auto-approve into the buffer.
- **verify**: vitest covers (a) mutating-outbound tool intercepted on dry-run, real tool not called; (b) read-only tool executes normally; (c) buffer flushed to `cloud_runs.dry_run_actions` at run end; (d) approval gate auto-bypasses; (e) outputs dispatcher recorded not dispatched; (f) `dry_run_action` activity event has scrubbed preview. Worker integration test: spin up a fake run with `dry_run=true`, invoke `send_email` directly, confirm SES SDK is NOT called (mock the SES client to throw if invoked), confirm `dry_run_actions` populated. 379+ existing worker tests still pass.
- **evidence**: `test.log`, `tsc.log`.
- **gates**: none.
- **kind**: code.

#### E.8 — API: dry-run dispatch + preview retrieval

- **do**: add to `api/src/routes/automations.ts`:
  - `POST /v1/automations/:id/dry-run` — body `{ inputs?: object, triggerIndex?: number, synthetic_payload?: object }`. If `triggerIndex` is set, runs that trigger's input mapper (reusing D.8's existing logic) to build `inputs` from `synthetic_payload`; otherwise `inputs` is used verbatim. Inserts `cloud_runs` with `dry_run=true`, `triggered_by='dry_run'`, dispatches to SQS. Returns `{ runId, status: 'pending' }`.
  - `GET /v1/runs/:runId/dry-run-preview` — returns `{ status, dry_run_actions, activity: [{ kind, ... }] }` where `activity` is the `cloud_activity` rows scrubbed for client display. 404 if `dry_run=false`.
  - Modify existing `POST /v1/automations` and `PUT /v1/automations/:id`: when body sets `status='draft'`, DO NOT call `reconcileTriggers` (skip Composio + EventBridge registration). When transitioning from `'draft'` to `'active'` via PUT, DO call `reconcileTriggers`. CREATE defaults `status='draft'` if not provided in body — making drafts the default authoring state. Existing automations are unaffected (backfilled to `'active'`).
  - New `POST /v1/automations/:id/activate` — flips `status` from `'draft'` to `'active'`, calls `reconcileTriggers`, returns the updated automation. Idempotent on already-active rows.
  - DELETE behavior unchanged: soft-deletes via `archived_at` + `status='archived'`, tears down triggers.
- **verify**: vitest covers each new endpoint + the status-transition behavior in CRUD (drafts don't register triggers, activate registers them, PUT-on-draft-staying-draft doesn't register, archive tears down). Live e2e on prod: (a) POST create draft with composio_webhook trigger — confirm Composio API has NO trigger registered (`aws scheduler list-schedules` for schedule triggers shows empty); (b) POST dry-run with synthetic_payload, poll the dry-run-preview, confirm `dry_run_actions` includes any intended SMS/email/mutating-composio calls and `status='completed'`; (c) POST activate, confirm Composio trigger now appears; (d) DELETE, confirm trigger torn down.
- **evidence**: `test.log`, `e2e-dry-run.log`, `review-1.json`, `sst-deploy.log`.
- **gates**: none.
- **kind**: code.

#### E.9 — Authoring lifecycle: chat-driven draft + dry-run feedback

- **do**: add a thin chat-bridge endpoint `POST /v1/workspaces/:id/automations/draft-from-chat` that takes `{ sessionId, draft: AutomationSpec }` and either CREATEs or PUTs the draft (the chat agent — running in any existing cloud_session — will call this when it's ready to propose an automation). Behavior: validates the spec with the existing Zod CRUD validators, persists with `status='draft'`, auto-fires a dry-run with the spec's first trigger's canned default payload (or `inputs={}` for manual triggers), and returns `{ automationId, draftRunId, previewPollUrl }`. The agent then polls the preview URL and surfaces the preview to the user in the chat. Add an `automations/spec-from-prompt` helper to the existing chat tool registry (worker side) — a new worker tool `propose_automation(spec)` that under the hood POSTs to `draft-from-chat`, awaits the dry-run, and returns the preview as its tool result. The agent uses this tool when the user asks for an automation; it shows the preview, asks for changes, iterates by re-calling `propose_automation` with the revised spec, and on user confirmation calls a sibling tool `activate_automation(automationId)` that POSTs to `/v1/automations/:id/activate`. Both tools are tagged with appropriate approval gates (`activate_automation` should require approval if the automation has any outputs going to channels with cost — SMS, email — so a careless agent can't auto-enable a high-volume sender).
- **verify**: worker vitest covers the two new tools. API vitest covers `draft-from-chat`. Integration: from a real chat session in the operator's workspace, prompt "build me an automation that sends me an SMS every weekday morning with my calendar agenda"; agent should call `propose_automation`, surface the preview (which shows an intended SMS body with no actual send), user replies "looks good but make it shorter", agent revises and re-calls, user replies "perfect", agent calls `activate_automation` (approval gate fires — operator approves via SMS reply per C.6), schedule trigger registers, the schedule fires on its next cadence and a real SMS arrives.
- **evidence**: `test.log`, `e2e-authoring-chat.log`, `review-1.json`, `sse-stream.txt`, `sst-deploy.log`.
- **gates**: none.
- **kind**: code.

#### E.10 — Smoke E2E: full authoring lifecycle, no real side effects until activate

- **do**: live end-to-end against production, no mocks. (Step 1) Operator-supplied test inputs: connect a `gmail` Composio account in the workspace if not already connected (verified via `composio_resolved` event from B.3 — re-run the existing E.5 connect flow style on the Composio dashboard if missing). (Step 2) Open a fresh chat session, prompt: "Make me an automation that watches my LP pipeline Google Sheet for new rows, and for each new LP sends me an SMS with the LP name and any past meeting count from my calendar. Let's test it before going live." (Step 3) Agent calls `propose_automation` with a draft spec including the `googlesheets_new_rows` trigger + `send_sms` output. The dry-run fires; preview shows the **simulated** SMS body the agent would have sent for a canned test row, with `cloud_runs.dry_run_actions` capturing the intended send. ZERO SMS hits the operator phone, ZERO Composio trigger registered yet, ZERO EventBridge schedule. (Step 4) Operator-in-chat replies: "include the LP's company name in the SMS". Agent revises and re-fires `propose_automation`; new dry-run preview reflects the change. (Step 5) Operator replies: "ok activate it". Agent calls `activate_automation`; the approval gate fires (because of the `send_sms` output); operator replies "YES ALWAYS" via SMS (per D.9 remember path) to approve activation and remember activation-style approvals for this automation. Composio trigger registers. (Step 6) Operator manually adds a real row to their test sheet; the Composio trigger fires; a real cloud_run starts (dry_run=false this time); agent processes the row; real SMS arrives on operator phone.
- **verify**: walk the full event chain via Supabase MCP. Confirm: (a) two `dry_run` cloud_runs exist (one per `propose_automation` iteration), both `completed`, both with non-empty `dry_run_actions` and ZERO entries in `external_action_audit` for outbound mutating tools during dry-run phase; (b) ZERO `composio_triggers` rows for this automation while it was a draft, ONE row after activation; (c) ZERO `aws scheduler` schedules during draft, registered after activation if the spec had a schedule trigger; (d) the post-activation real run has `dry_run=false`, `triggered_by='composio_webhook'`, and a corresponding `external_action_audit` row for the real `send_sms`; (e) operator phone received exactly ONE SMS in the entire flow (the post-activation real one — NOT during dry-runs); (f) the `approval_rules` row for the activation auto-approval was inserted (per D.9 remember). Cleanup: archive the test automation (`DELETE /v1/automations/:id`); preserve the LinkedIn `workspace_browser_sites` row from E.5.
- **evidence**: `verify.log`, `dry-run-rows.json`, `activity-stream.json`, `composio-triggers-before-after.json`, `approval-rules-row.json`, `phone-sms-screenshot.png`, `sheet-row-screenshot.png`.
- **gates**: requires operator-in-the-loop for the chat interactions and the final approval reply. Same pattern as E.5 — operator input, not gate approval.
- **kind**: verify-only.

---

### Phase F — Self-hosted polling for managed-auth Composio triggers

**Goal**: Composio's managed-auth polling worker enforces a **15-minute minimum interval** (March 11, 2026 changelog), and during our E.10 verify it also exhibited >15-min stalls after the baseline poll — making the operator-facing latency for sheet/gmail/calendar new-event automations unacceptable for the LP-pipeline use case. Phase F keeps Composio for managed OAuth + `composio_call` tools, but **replaces just their polling worker** with our own running on the existing `worker/cron-kicker/handler.ts`. Push-type triggers (Slack, Linear, Asana, GitHub-webhook, Notion real-time, etc.) continue going through Composio's webhook delivery into `/webhooks/composio` — those have no polling and are unaffected.

At registration time, `api/src/lib/automation-trigger-registry.ts` decides per-trigger:
- `type: "webhook"` → register a Composio webhook subscription (unchanged from D.4).
- `type: "poll"` AND we have an adapter → INSERT into our new `composio_poll_state` table + skip Composio's `createTrigger`. Cron-kicker handles polling on a 2-min cadence.
- `type: "poll"` AND no adapter for that toolkit → fall through to Composio's polling (accept 15-min latency, log a warning so we know to add the adapter).

Both paths converge in `api/src/lib/composio-trigger-router.ts:routeTriggerMessage` (D.5). The router doesn't care if the payload came from Composio's poller or ours — same `inputs` mapping, same `cloud_runs` INSERT, same D.7 debounce, same E.7 dry-run gating. F is a swap-out of one upstream producer; the rest of the chain is untouched.

#### F.1 — Migration: `composio_poll_state` + adapter routing column

- **do**: apply `automations_f1_poll_state` via Supabase MCP. New table `composio_poll_state (id uuid PK DEFAULT gen_random_uuid(), automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE, trigger_index int NOT NULL, toolkit text NOT NULL, event text NOT NULL, filters jsonb NOT NULL DEFAULT '{}'::jsonb, state jsonb NOT NULL DEFAULT '{}'::jsonb, composio_user_id text NOT NULL, connected_account_id text NOT NULL, last_polled_at timestamptz, next_poll_at timestamptz NOT NULL DEFAULT now(), consecutive_failures int NOT NULL DEFAULT 0, paused_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (automation_id, trigger_index))`. Index on `(next_poll_at) WHERE paused_at IS NULL` for the kicker's "next due" scan. RLS enabled with workspace-scoped SELECT via `automations.workspace_id` JOIN. Mirror to `api/drizzle/0027_composio_poll_state.sql` + journal idx 27.
- **verify**: MCP `list_tables` includes `composio_poll_state`. Constraint + index present. Fixture INSERT + SELECT round-trip green (insert a row scoped to a real workspace via the operator workspace; query back; DELETE). RLS policy returns rows when authed as workspace member, none otherwise.
- **evidence**: `migration.sql`, `list-tables.json`, `fixture.json`.
- **gates**: `apply_migration` auto-granted (additive).
- **kind**: infra.

#### F.2 — Adapter framework + cron-kicker routing scaffold

- **do**: create `worker/src/poll-adapters/index.ts` exporting `PollAdapter` interface:
  ```ts
  interface PollAdapter {
    toolkit: string;
    events: string[];                                 // trigger slugs handled
    initialState(args): Promise<State>;               // called once on registration
    poll(args, lastState): Promise<{ newEvents: Array<{ payload: Record<string, unknown> }>; nextState: State }>;
  }
  ```
  Plus a registry `getAdapter(toolkit, event): PollAdapter | null`. Extend `worker/cron-kicker/handler.ts` with a new entry point `pollComposioTriggers(now)` that: (a) `SELECT … FROM composio_poll_state WHERE next_poll_at <= now() AND paused_at IS NULL ORDER BY next_poll_at LIMIT 50`; (b) for each row, look up the adapter; (c) call `adapter.poll()`; (d) for each `newEvent`, build a Composio-shaped payload and call `routeTriggerMessage` directly (in-process, no HTTP round-trip); (e) UPDATE `composio_poll_state` with `state = nextState`, `last_polled_at = now()`, `next_poll_at = now() + interval '2 minutes'`. On adapter throw: `consecutive_failures++`; pause when ≥5 (`paused_at = now()`), emit a `composio_poll_paused` activity event into the latest open run for the workspace.
  Add an EventBridge schedule `basics-cron-kicker-poll` running every minute that invokes the kicker with `{ kind: 'poll_composio_triggers' }`; sst.config.ts wires it.
- **verify**: vitest covers (a) framework dispatches to the right adapter, (b) `routeTriggerMessage` called once per `newEvent`, (c) state advances on success, (d) failure increments counter, (e) 5th failure pauses + emits event. No real adapters yet (use a stub adapter for the framework tests). `pnpm -F @basics/worker exec tsc --noEmit` clean.
- **evidence**: `test.log`, `tsc.log`.
- **gates**: none.
- **kind**: code.

#### F.3 — Adapter: `googlesheets.NEW_ROWS_TRIGGER`

- **do**: create `worker/src/poll-adapters/googlesheets.ts` exporting an adapter handling `GOOGLESHEETS_NEW_ROWS_TRIGGER`. `initialState`: call `composio_call("GOOGLESHEETS_BATCH_GET", { spreadsheet_id, ranges: ['<sheet_name>!A<start_row>:Z'] })`, count non-empty rows, return `{ last_row_count: N, header_row?: <row 1> }`. `poll`: same read; if `current_count > last_row_count`, emit one `newEvent` per row from `last_row_count+1` to `current_count` with payload shape exactly matching Composio's `GOOGLESHEETS_NEW_ROWS_TRIGGER` payload (`{ row_number, row_data, sheet_name, spreadsheet_id, detected_at }`) so the existing input mapper in D.5 works unchanged.
- **verify**: vitest with a mocked `composio_call` covers initial-baseline, no-change, single-new-row, multi-new-row, sheet-shrank (no-op + log warning). LIVE e2e in F.10.
- **evidence**: `test.log`.
- **gates**: none.
- **kind**: code.

#### F.4 — Adapter: `gmail.NEW_GMAIL_MESSAGE`

- **do**: create `worker/src/poll-adapters/gmail.ts`. Gmail has a native `historyId` API for incremental sync, which makes this efficient (no full inbox scan per poll). `initialState`: call `composio_call("GMAIL_FETCH_USER_PROFILE", {})` → grab `historyId` → return `{ start_history_id: H }`. `poll`: call `composio_call("GMAIL_LIST_HISTORY", { start_history_id })` for messages added since `start_history_id`; for each new message, optionally fetch full thread via `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` if the trigger config asks for body; emit `newEvent` per message with payload shape matching Composio's `GMAIL_NEW_GMAIL_MESSAGE` (`{ messageId, threadId, from, subject, snippet, labelIds, ... }`). Update state to the latest `historyId`. Optional label/sender filter from `trigger_config.filters`.
- **verify**: vitest covers initial baseline, no-history-changes, single new message, multiple new messages, history pagination, history-ID-too-old → fall back to `GMAIL_LIST_THREADS` since-timestamp.
- **evidence**: `test.log`.
- **gates**: none.
- **kind**: code.

#### F.5 — Adapter: `googlecalendar` event-created / event-updated

- **do**: create `worker/src/poll-adapters/googlecalendar.ts` handling `GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER` + `GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_UPDATED_TRIGGER`. Both use the same underlying read: `composio_call("GOOGLECALENDAR_EVENTS_LIST", { calendar_id, updated_min: <last_seen> })`. State: `{ last_seen_updated: ISO }`. Emit `newEvent` per event with payload `{ event, calendar_id, change_kind: 'created' | 'updated' }` (detect created via `event.created === event.updated`).
- **verify**: vitest covers initial baseline, no changes, single new event, single updated event, mixed batch, multi-page response.
- **evidence**: `test.log`.
- **gates**: none.
- **kind**: code.

#### F.6 — Adapter: `googledrive` new-file / new-file-matching-query

- **do**: create `worker/src/poll-adapters/googledrive.ts` handling `GOOGLEDRIVE_FILE_CREATED_TRIGGER` + `GOOGLEDRIVE_NEW_FILE_MATCHING_QUERY_TRIGGER`. Use `composio_call("GOOGLEDRIVE_LIST_FILES", { q, page_size, fields })` with `q` built from the trigger's filters (`mimeType`, `parents`, freeform `query`) plus `modifiedTime > <last_seen>`. State: `{ last_seen_modified: ISO }`. Emit `newEvent` per file.
- **verify**: vitest covers baseline, no changes, single new file, query filter applied, mixed mime types.
- **evidence**: `test.log`.
- **gates**: none.
- **kind**: code.

#### F.7 — Adapter: `notion` page-added + comments-added

- **do**: create `worker/src/poll-adapters/notion.ts` handling `NOTION_PAGE_ADDED_TRIGGER` + `NOTION_PAGE_ADDED_TO_DATABASE` + `NOTION_COMMENTS_ADDED_TRIGGER`. For page-added: `composio_call("NOTION_SEARCH", { filter: { property: 'object', value: 'page' }, sort: { direction: 'descending', timestamp: 'last_edited_time' }, page_size: 50 })`. For database variant: `composio_call("NOTION_QUERY_DATABASE", { database_id, sorts, page_size })` + filter for pages created after `last_seen`. For comments: `composio_call("NOTION_LIST_COMMENTS", { block_id })` per watched page. State: `{ last_seen_created: ISO }` or per-page `{ last_comment_id }` for comments.
- **verify**: vitest covers each of the three trigger slugs, baseline, deltas, no-change.
- **evidence**: `test.log`.
- **gates**: none.
- **kind**: code.

#### F.8 — Adapter: `airtable` (the one users actually want)

- **do**: create `worker/src/poll-adapters/airtable.ts` handling whichever Airtable trigger is most actionable today (Composio's airtable polling triggers are mostly metadata; the practical one is "new record in view" which Composio exposes indirectly). Best path: `composio_call("AIRTABLE_LIST_RECORDS", { baseId, tableId, viewId, filterByFormula })` with `sort = [{field: 'Created', direction: 'desc'}]`. State: `{ last_seen_record_id }`. Emit `newEvent` per record with payload `{ record, base_id, table_id, view_id }`. If Airtable's most-actionable Composio trigger turns out to require a non-LIST_RECORDS path, document it inline and skip; ship just the new-record adapter.
- **verify**: vitest covers baseline, no changes, single new record, multi-new in same poll.
- **evidence**: `test.log`.
- **gates**: none.
- **kind**: code.

#### F.9 — Registry routing: webhook vs poll, skip Composio for poll types

- **do**: extend `api/src/lib/automation-trigger-registry.ts:reconcileTriggers`. At registration time, look up the trigger's `type` from Composio (cached in `composio_tool_cache` or in-memory): `GET /api/v3/triggers_types/{slug}`. Branch:
  - `type: 'webhook'` → `createTrigger(...)` as today (D.4 unchanged).
  - `type: 'poll'` AND `getAdapter(toolkit, event)` returns non-null → INSERT into `composio_poll_state` with `connected_account_id` resolved from the existing toolkit map; **do not** call `createTrigger`. Call `adapter.initialState(...)` and store into the `state` column up front.
  - `type: 'poll'` AND no adapter → fall through to `createTrigger(...)` (legacy behavior, accept 15-min latency, add `warnings: [{ message: 'no_self_hosted_adapter_for_toolkit', toolkit, event }]`).
  - On teardown: DELETE from `composio_poll_state` for self-hosted; `deleteTrigger` for Composio-hosted.
  Update `composio_triggers` schema: drop NOT NULL on `composio_trigger_id` (poll-adapter rows don't have one) OR add a separate `kind` column distinguishing self-hosted from Composio-hosted. Simpler: keep `composio_triggers` for Composio-hosted ONLY and use `composio_poll_state` exclusively for self-hosted — no schema change to `composio_triggers` needed.
- **verify**: vitest covers the four branches above (push happy, poll-with-adapter, poll-fallback, teardown). Live verify: create an automation with a `googlesheets` trigger → `composio_poll_state` row inserted, ZERO `composio_triggers` row added, ZERO Composio API call to `createTrigger`. Delete → `composio_poll_state` row gone.
- **evidence**: `test.log`, `e2e-routing.log`.
- **gates**: none.
- **kind**: code.

#### F.10 — Smoke E2E: sheets + gmail under 2-min latency on a single chat-authored automation

- **do**: live, no mocks. (Step 1) operator-supplied: confirm gmail + googlesheets Composio connections are ACTIVE in the workspace. (Step 2) deploy F.1–F.9 (api + worker images via `pnpm sst deploy --stage production` + worker docker build). (Step 3) operator opens a chat session, prompts: "Make me an automation that watches my LP pipeline sheet for new rows AND watches my Gmail for new mail from anyone @firstround.com — whichever fires first, SMS me." Agent calls `propose_automation` → dry-run preview shows both intended notifications → operator approves → `activate_automation` → both triggers register in `composio_poll_state` (NOT in `composio_triggers`). (Step 4) operator adds a row to the sheet AND sends themselves an email from a different account matching the filter. (Step 5) wait ≤ 2 minutes per trigger.
- **verify**: BOTH triggers fire within 2 minutes of their respective events. `cloud_runs` rows appear with `triggered_by='composio_webhook'` (same as D.9/E.10 — the router doesn't change the value), `dry_run=false`, distinct `inputs` (one with `inputs.row`, one with `inputs.email`). Operator phone receives TWO SMS within the 2-min window. ZERO `composio_triggers` rows created for this automation (both went into `composio_poll_state`). ZERO Composio polling calls made for these triggers (verify via `GET /api/v3/trigger_instances/active?triggers_ids=…` — should return empty since we never registered). Cleanup: archive the automation; `composio_poll_state` rows DELETE on cascade via the FK.
- **evidence**: `verify.log`, `poll-state-rows.json`, `cloud-runs-rows.json`, `activity-stream.json`, `phone-sms-screenshots.png`.
- **gates**: requires operator-in-the-loop for the gmail sender + sheet row + chat interaction.
- **kind**: verify-only.

---

## Phase G — Desktop routing for approvals + outputs

After F.10 we still bounce every approval prompt and every automation output through SMS/email only. The desktop app already runs (it consumes `/v1/runs/:id/events` SSE), but it can't render pending approvals or notify on outputs without subscribing per-run, and approving on desktop doesn't cancel the parallel SMS prompt. Phase G fixes both — approvals + outputs become first-class desktop events, and the SMS path becomes a fallback that bows out when desktop wins.

#### G.1 — Workspace-scoped pending-approvals SSE stream

- **do**: create `api/src/routes/approvals-sse.ts` exposing `GET /v1/workspaces/:wsId/approvals/stream` over SSE. Authenticate via `requireWorkspaceJwt`. On connect: emit one `event: hydrate` with the current list of `status='pending'` approvals scoped to the workspace, then subscribe to Supabase Realtime on `public.approvals` filtered to the workspace's automations. Forward INSERT (new pending), UPDATE (decided/expired), and DELETE events as SSE `event: approval` frames. Keep-alive every 25s.
- **verify**: vitest covers (a) JWT mismatch → 403, (b) initial hydrate frame contains pending rows only, (c) INSERT → frame delivered, (d) UPDATE status=granted → frame delivered. Live: open the stream with curl `-N`, INSERT a fixture approval, confirm the frame arrives within 1s.
- **evidence**: `test.log`, `e2e-sse.log`.
- **gates**: none.
- **kind**: code.

#### G.2 — `decided_via='desktop'` writeback + SMS-thread cancellation

- **do**: extend `POST /v1/approvals/:id` (the existing manual-decide endpoint) to accept an optional `decided_via: 'desktop' | 'sms' | 'manual'` body field (default `'manual'`). Persist into `approvals.decided_via`. When the resolved value is `'desktop'` AND the approval had `notify_channel='sms'` (i.e., we sent the operator an SMS prompt earlier), POST to Sendblue's `/api/send-message` with a "✓ Approved via desktop — ignore the prompt" follow-up to the same `to`+`from_number`. Sendblue inbound webhook (`sendblue-inbound.ts`) ALREADY rejects late replies (`status !== 'pending'` → "no pending approvals") so there's nothing to remove on the inbound side; G.2 just adds the explicit follow-up so the operator's phone isn't left with a stale prompt.
- **verify**: vitest covers (a) `decided_via='desktop'` + sms-notified → confirmation POST fires with expected payload, (b) `decided_via='sms'` → NO follow-up (already inline), (c) approval not previously sms-notified → NO follow-up. Live: register an approval-required run, get the SMS, hit `POST /v1/approvals/:id` with `decided_via='desktop'`, confirm the second SMS arrives on the operator phone.
- **evidence**: `test.log`, `e2e-desktop-cancel.log`.
- **gates**: requires operator-in-the-loop for live verify (SMS receipt).
- **kind**: code.

#### G.3 — Workspace-scoped outputs SSE stream

- **do**: create `api/src/routes/outputs-sse.ts` exposing `GET /v1/workspaces/:wsId/outputs/stream` over SSE. Same auth pattern as G.1. Subscribe to Supabase Realtime on `public.cloud_activity` filtered to `activity_type IN ('output_dispatched','output_failed')` for runs in this workspace. Forward each as SSE `event: output` with payload `{ run_id, channel, to, subject?, status, dispatched_at }`. The desktop renders these as toast notifications independent of any specific run view.
- **verify**: vitest covers connect + INSERT-fires-event. Live: trigger an automation with an SMS output, open the stream, confirm the event arrives the moment the worker's `output_dispatched` activity row lands.
- **evidence**: `test.log`, `e2e-outputs-sse.log`.
- **gates**: none.
- **kind**: code.

#### G.4 — Combined live e2e: dual-channel approval, desktop wins

- **do**: operator opens the desktop app (or a local SSE client that mirrors what the desktop would do). Loop creates an approval-required automation, fires it, and observes BOTH (a) the SMS prompt arriving on the operator phone AND (b) the SSE frame arriving on the desktop stream. Operator clicks "approve" in the desktop (we simulate via curl `POST /v1/approvals/:id` with `decided_via='desktop'`). Loop verifies: (1) the SMS-cancel follow-up arrives on the operator phone, (2) the worker resumes within 1s (pg_notify path unchanged), (3) the run completes, (4) any output is also visible on the outputs SSE stream. If the operator replies "YES" to the original SMS AFTER decision via desktop, verify Sendblue inbound returns the "no pending approvals" branch.
- **verify**: end-to-end as above.
- **evidence**: `verify.log`, `phone-sms-screenshots.png` (or operator-confirmed), `sse-frames.log`.
- **gates**: requires operator-in-the-loop.
- **kind**: verify-only.

---

## Phase H — Polling scale-up

F.10's live verify confirmed the polling pipeline works for the operator's two-trigger smoke test. F.10's scalability analysis flagged a ceiling around 150–200 concurrent triggers and several correctness gaps (no row locking, no per-row timeout, no workspace fairness, single-key Composio rate posture) that will bite as soon as real usage starts. Phase H closes those gaps now, before the system hits them.

#### H.1 — Row-level locking via `FOR UPDATE SKIP LOCKED`

- **do**: wrap the `pollComposioTriggers` SELECT-then-UPDATE in a single transaction. Change the SELECT to `SELECT … FROM public.composio_poll_state WHERE next_poll_at <= now() AND paused_at IS NULL ORDER BY next_poll_at ASC LIMIT 50 FOR UPDATE SKIP LOCKED`. Inside the same transaction, immediately UPDATE all locked rows' `next_poll_at = now() + interval '5 minutes'` (a "tentative lease" — gets refined to the real next_poll_at when the adapter call returns). On adapter completion, UPDATE the real next_poll_at, replacing the tentative lease. This makes two concurrent EventBridge invocations or two parallel sweeps mutually exclusive on the same rows.
- **verify**: vitest with two concurrent `pollComposioTriggers()` invocations against an in-memory pg adapter — assert each row is processed by EXACTLY one invocation. Live: cron-kicker self-invokes itself rapidly via SQS to simulate overlap, verify no duplicate cloud_runs.
- **evidence**: `test.log`, `e2e-locking.log`.
- **gates**: none.
- **kind**: code.

#### H.2 — Per-adapter timeout + per-row error isolation

- **do**: wrap each `adapter.poll(args, lastState)` call in `Promise.race([adapter.poll(...), timeout(15s)])`. On timeout: throw a `PollTimeoutError`, count it as one consecutive failure (so exponential backoff applies), and continue the batch loop — DO NOT let a single slow Composio response block the other 49 rows. Same shape for `adapter.initialState` (called at G.1 / F.9 registration time, less critical). Cap total per-row wall-time at 20s including the timeout's race overhead. Wrap the entire `for (const row of due)` body in its own try/catch (in addition to the existing one inside) so a bug that throws BEFORE the existing try/catch (e.g., a getAdapter throw) doesn't sink the batch.
- **verify**: vitest covers (a) adapter that hangs 20s → row marked failed within 15s, sweep continues, (b) adapter that throws synchronously → caught + row marked failed, (c) sequence of 5 rows where row 3 times out — rows 4-5 still process.
- **evidence**: `test.log`.
- **gates**: none.
- **kind**: code.

#### H.3 — Per-workspace fairness in the due-rows SELECT

- **do**: replace the plain `ORDER BY next_poll_at ASC LIMIT 50` with a workspace-fair interleave: `SELECT … FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY automation_id-derived-workspace ORDER BY next_poll_at) AS rn FROM composio_poll_state WHERE next_poll_at <= now() AND paused_at IS NULL) sub WHERE rn <= 5 ORDER BY next_poll_at LIMIT 50`. The "5 per workspace" cap keeps one busy workspace from monopolizing the 50-row sweep window. Join through `automations.workspace_id` since composio_poll_state doesn't carry workspace_id directly — OR add a `workspace_id` column to composio_poll_state via a small additive migration (`automations_h3_poll_state_workspace_id`) for index efficiency. (Choose the migration if the JOIN-based version costs >2× planner time.)
- **verify**: vitest covers (a) workspace A has 100 due rows + workspace B has 1 due row → workspace B's row IS in the next sweep, (b) 10 workspaces × 10 rows each → all 10 workspaces represented in the 50-row sweep. Live: load the table with synthetic fixtures, confirm the EXPLAIN plan + actual scan order.
- **evidence**: `test.log`, `e2e-fairness.log`, (optional) `api/drizzle/0028_h3_poll_state_workspace_id.sql`.
- **gates**: none.
- **kind**: code.

#### H.4 — Throughput: larger batch + self-invocation chain

- **do**: bump `POLL_BATCH_SIZE` default to 100 (keep env-var override). After each sweep, if `scanned === POLL_BATCH_SIZE` (suggesting more rows are due), self-invoke the kicker with `aws-sdk InvokeCommand` for the same `{kind:'poll_composio_triggers'}` payload, async (non-blocking). Cap the self-invocation chain at 5 hops per minute (counter passed in the event payload — `chainDepth: number`, default 0, refuse if ≥5). This lets one 1-minute EB tick scale from 50 to ~500 polls per minute when there's actual demand.
- **verify**: vitest covers (a) scanned < BATCH_SIZE → no self-invoke, (b) scanned === BATCH_SIZE → invokes once with chainDepth+1, (c) chainDepth=5 → refuses, logs. Live: load 200 synthetic poll-state rows with next_poll_at <= now(), trigger one EB tick, confirm all 200 process within 30 seconds via the chain.
- **evidence**: `test.log`, `e2e-chain.log`.
- **gates**: none.
- **kind**: code.

#### H.5 — Per-workspace Composio rate-limit guard

- **do**: add a simple in-memory token bucket inside the kicker (per-invocation, not durable — refreshes on Lambda cold start). Track Composio HTTP calls per workspace within the current sweep; if a workspace exceeds N (default 30) calls in the sweep, skip remaining rows for that workspace, bump their `next_poll_at` by 1 minute, and emit a `workspace_throttled` activity event into the workspace's latest open run for observability. This is a soft guard against one workspace burning the global Composio API key budget; durable rate-limit tracking can wait until we see Composio actually rate-limit us.
- **verify**: vitest covers a 50-row sweep where 31 rows are for workspace A — first 30 process, row 31+ deferred. Live: skip (waits on F.10-style operator setup).
- **evidence**: `test.log`.
- **gates**: none.
- **kind**: code.

#### H.6 — Lambda config bump + observability

- **do**: bump cron-kicker memory from 256 MB → 512 MB (better cold-start headroom; CPU scales with memory in Lambda). Add `reservedConcurrentExecutions: 10` so the self-invocation chain can run parallel sweeps without unbounded scaling. Add CloudWatch metrics: emit `kicker.scanned`, `kicker.dispatched`, `kicker.paused`, `kicker.failed`, `kicker.duration_ms`, `kicker.chain_depth` as embedded-metrics-format JSON log lines (free metrics via EMF). Add a CloudWatch alarm on `kicker.failed > 10 in 5 min` and on `kicker.duration_ms > 240000` (timeout warning).
- **verify**: deploy, wait one sweep, confirm metrics appear in CloudWatch under namespace `Basics/CronKicker`. Hit the alarm threshold artificially (set POLL_MAX_CONSECUTIVE_FAILURES=1 + a deliberately-broken adapter, let 11 sweeps run) and confirm the alarm fires.
- **evidence**: `sst-deploy.log`, `verify.log`, `cloudwatch-screenshot.png` (or `aws logs describe-metric-filters` output).
- **gates**: none.
- **kind**: infra (no adversarial review).

#### H.7 — Live load test: 100 synthetic triggers, drained in 1 min

- **do**: write a one-shot script `scripts/poll-load-test.ts` that (1) creates a fixture automation with 100 composio_poll_state rows pointing at a stub HTTP endpoint that returns canned `valueRanges` with a varying row count, (2) waits one minute, (3) queries cloud_runs created from these rows + verifies all 100 fired within the minute (chain + locking + fairness all work), (4) tears down fixtures. Run against production with `STUB_BASE_URL` pointing at a temp endpoint we control (or a localhost loopback test deployment).
- **verify**: load test passes — 100 fixture rows → 100 cloud_runs within 60s, all UPDATEs landed, no double-polls (verified by stub endpoint hit count == 100, not 200).
- **evidence**: `verify.log`, `stub-hits.json`.
- **gates**: operator-grants the production load test (since it spins up 100 throwaway cloud_runs). Cleanup mandatory.
- **kind**: verify-only.

---

## Phase I — Opus authoring

H.7 closed Phase H with the polling pipeline carrying ~1200 concurrent triggers. The remaining gap before "I want this automation" → working automation is **authoring quality**: today the chat agent that drafts automations (E.9's `propose_automation` / `activate_automation` flow) runs on the same Sonnet model as the runtime worker. Architecture decisions ("is this browser-only? Composio-only? hybrid?", "what filter shape does the googlesheets trigger need?", "should the goal text mention the dry-run output format?") are judgment-heavy and benefit from a larger model. We want Opus 4.7 for the authoring chat, Sonnet for runtime execution.

(The non-OAuth-site cookie onboarding gap — LinkedIn etc. — was originally scoped here as a Chrome extension. Decision: scrap the extension, port `browser-use/desktop`'s chrome-import pattern into our desktop app instead. The api side is already built (`POST /v1/runtime/contexts/sync` in `api/src/routes/contexts.ts`). See `docs/DESKTOP-COOKIE-IMPORT.md` for the desktop-app integration spec — that's a deliverable for the desktop team, not part of this plan's loop.)

#### I.1 — Opus 4.7 for the authoring chat

- **do**: thread a `model` override through E.9's `propose_automation` tool path so the authoring chat session runs on `anthropic/claude-opus-4-7` instead of the default Sonnet. The runtime worker (per-run execution agent) stays on Sonnet 4.6 — it's instruction-following, not architecture-deciding. Two changes:
  1. `worker/src/tools/propose_automation.ts` (and the activate path): include `model: 'anthropic/claude-opus-4-7'` when invoking the chat session OR when minting the worker JWT for the draft-from-chat run. The chat session in `api/src/orchestrator/managedAssistantRunner.ts` already accepts a model override.
  2. `api/src/routes/automations.ts` `draftFromChatRoute`: when the request body carries `model: 'anthropic/claude-opus-4-7'`, pass it through to the dry-run dispatch (currently the dry-run uses whatever default the worker pool has). If the route already has a `model` field on the schema (E.8 / E.9 added it for `dryRun`), reuse it.
  - **Model ID convention.** Opencode's model registry expects `provider/model` format (verified live in the voice e2e: `claude-opus-4-7` returned `Model not found: claude-opus-4-7/.`; `anthropic/claude-opus-4-7` worked). Use the fully-qualified string everywhere we pass model overrides.
- **verify**: unit tests assert that (a) propose_automation tool emits a session-init payload with model='anthropic/claude-opus-4-7', (b) the api draftFromChatRoute forwards the model into the SQS dispatch. Live verify: drive a sample automation through the chat ("watch my sheet, send me an SMS") with the live api + observe the cloud_runs row's model field shows Opus. No regression in Sonnet-driven runs (existing E.8 tests still pass).
- **evidence**: `test.log`, `live-authoring.log`.
- **gates**: none.
- **kind**: code.

---

## Phase J — Worker pool durability

The autonomous LP-mapping live test on 2026-05-14 hit one hard failure and one recovered-by-retry: worker pools die ~17 minutes into long runs. The first Mapper run for Jim Joyal hung at exactly that mark and required a manual cancel + re-add. The Watcher / Digest / second Mapper attempt all completed cleanly because they each ran <5 min. Any pipeline with >~15 minutes of real work (dozens of LP rows, browser-heavy LinkedIn flows, paginated Composio reads) hits this. Phase J fixes durability so a run survives pool death.

Background: the dispatcher binds a `cloud_runs` row to a `cloud_pools` row via `cloud_session_bindings`. The J.4-era binding-alive check (added during the chat-tracked J.4 work in May) reads `cloud_session_bindings.ended_at IS NULL` and rehydrates if set. It races: the pool can be dying (ECS killing the task, opencode session crashed, last_activity_at stale) without `ended_at` written yet. The rehydration also rebuilds the chat transcript but does not re-dispatch in-flight execution runs.

#### J.1 — Diagnose worker pool death root cause

- **do**: Pull CloudWatch logs for `basics-worker` ECS tasks that died within 24h around the LP runs (run ids `03040a63`, prior hung Jim Joyal run id from the J.12 incident). Cross-reference ECS task stopReason, exit code, container memory metrics, opencode session lifecycle events (`session.created`, `session.idle`, `session.disposed`). Goal is one of three verdicts: (a) ECS task autoscale-down evicted the task with active session, (b) opencode subprocess crashed for a specific reason, (c) container OOM. Write the finding into `docs/.automation-loop/artifacts/J/1/diagnosis.md` with log excerpts. No code changes this step.
- **verify**: diagnosis doc identifies exactly one root cause backed by concrete log lines + an ECS or CloudWatch metric pointing to the same conclusion.
- **evidence**: `diagnosis.md`, `task-stop-events.json`, `oc-session-lifecycle.json`.
- **gates**: none.
- **kind**: verify-only.

#### J.2 — Fix root cause from J.1

- **do**: Apply the targeted fix for the root cause J.1 identified. Examples by verdict: (a) ECS autoscale → set min in-service capacity or scale-in protection while sessions are bound; (b) opencode crash → patch the specific subprocess crash (memory leak, stuck child process, etc.); (c) OOM → raise container memory. The fix MUST be the minimum change that addresses the root cause — do not rewrite the pool architecture.
- **verify**: trigger a synthetic long-running test goal (e.g. a 25-minute opencode session that loops `sleep 30 + bash echo` to keep the session active) and confirm the worker stays alive past the 17-minute death mark with no exit. Re-deploy via `pnpm sst deploy --stage production`, dispatch via `POST /v1/runs`, watch cloud_runs until completion.
- **evidence**: `synthetic-long-run.log`, `cloud_runs-final-status.json` showing status=completed at >18min elapsed.
- **gates**: none.
- **kind**: code.

#### J.3 — Tighten binding-alive check + auto-redispatch

- **do**: Two changes. (1) In the dispatcher's binding-alive query, AND-in `cloud_pools.status='active' AND cloud_pools.last_activity_at > now() - interval '2 minutes'` so a dying-but-not-yet-marked-ended pool fails the check fast. (2) Add an orphan-run sweep: a Lambda or scheduled job that polls `cloud_runs WHERE status='running' AND last_progress_at < now() - interval '5 minutes'`, marks the orphan as `pending` (and `triggered_by_redispatch=true` for telemetry), and re-enqueues to SQS. Cap re-dispatches at 2 per run to avoid retry storms; on 3rd attempt mark `status='failed_orphaned'`.
- **verify**: synthetic test — dispatch a run, manually kill the worker task mid-run via `aws ecs stop-task`, observe that within 5 minutes the orphan sweep re-dispatches and the run completes on a fresh pool. Assert final `cloud_runs.triggered_by_redispatch=true` and `result_summary` is set.
- **evidence**: `orphan-sweep.log`, `redispatched-run.json`.
- **gates**: none.
- **kind**: code.

#### J.4 — Long-run LP pipeline live verify

- **do**: Run the LP Mapper against a 30-row LP Pipeline (any 30 real LinkedIn URLs the operator drops in — synthetic-looking ones are fine, just need the browser flow to take real time). Pipeline must complete without operator intervention. If a worker death happens mid-run, J.3's redispatch must catch it.
- **verify**: all 30 rows reach `Mapping Status='Mapped'` OR `'Needs Human Confirm'` within 60 minutes wall time, Mutuals tab is populated for the mapped rows, J.16 end-of-run state-verify passes. No operator messages required mid-run.
- **evidence**: `lp-30row-run.log`, `final-sheet-snapshot.json`.
- **gates**: operator approves the live test (real Sheets writes, real Gmail drafts to real mutuals).
- **kind**: verify-only.

---

## Phase K — Agent-authored helpers (token-decay architecture)

The architecture today is "LLM on every fire." Every Mapper invocation re-engages Sonnet for ~40 round-trips to do deterministic plumbing — read sheet, search LinkedIn, score mutual, write sheet, draft Gmail. Phase K changes this to the browser-harness pattern: the LLM is the **orchestrator**, but its job at trigger-fire time becomes "decide which helper to call" (or fall back to manual tool calls on novelty/drift). Helpers are TS modules the agent itself writes during dry-run or after consistent successful runs, stored durably per workspace, registered as opencode tools at session boot.

Outcome: a workflow that's been run 3+ times the same way decays to ~0–2 LLM round-trips per fire; LLM only re-engages on throws (selector drift, schema change, novel input).

This phase also formalizes two adjacent gaps the chat-J work surfaced: **(a)** `skill_write` is registered in the worker tool set but is NOT surfaced in the authoring chat agent's tool surface (so the authoring agent can't capture lessons it learns during dry-runs), and **(b)** the dispatcher has no fast-path — it always spins up a full opencode session even when a deterministic helper is available.

#### K.1 — Schema: cloud_helpers table + cloud_skills.kind column

- **do**: Migration adds (a) `cloud_skills.kind TEXT NOT NULL DEFAULT 'doc' CHECK (kind IN ('doc','playbook','helper_ref'))` so playbooks (markdown-the-LLM-reads) are distinguishable from doc-skills, and (b) new table `cloud_helpers (id UUID PK, workspace_id UUID, automation_id UUID NULL, name TEXT, args_schema JSONB, body TEXT, version INT, active BOOL, superseded_by UUID NULL, source_run_id UUID NULL, created_at, updated_at)` with `UNIQUE (workspace_id, name, version)` and an index on `(workspace_id, name) WHERE active=true`. Land via Supabase MCP `apply_migration` AND mirror to `api/drizzle/0032_helpers.sql` with `_journal.json` entry (project_drizzle_is_canonical_migration_history memory).
- **verify**: `list_tables` shows `cloud_helpers` with the constraints; insert/select a fixture row roundtrips; `cloud_skills.kind` defaults to 'doc' for existing rows.
- **evidence**: `migration.sql`, `list_tables.json`, `roundtrip.log`.
- **gates**: none.
- **kind**: infra.

#### K.2 — Worker tool `helper_write`

- **do**: New `worker/src/tools/helper_write.ts` mirroring `skill_write.ts`. Params: `{ name, description, args_schema (JSON schema), body (TS source), automation_id?, supersedes_helper_id? }`. Validation: (1) body parses as TypeScript via TS compiler API and exports `async function run(args, ctx)`; (2) body ≤ 64KB; (3) no `process`, no `eval`, no `import('child_process')`, no network-via-node — must only call ctx-injected APIs; (4) re-use `validateSkillWrite` content scanner for secrets/PII. Writes to `cloud_helpers` with `active=true`, `version=COALESCE(prior.version,0)+1`, deactivates prior version of same name. Register in `worker/src/tools/index.ts`.
- **verify**: unit tests cover happy path, AST rejection of forbidden APIs, version-bump on supersede, scanner blocks for embedded secret. Live test: dispatch a goal that ends in calling `helper_write` for a trivial `add_two_numbers` helper; query `cloud_helpers` and confirm the row.
- **evidence**: `test.log`, `cloud_helpers-after-write.json`.
- **gates**: none.
- **kind**: code.

#### K.3 — Surface `skill_write` + `helper_write` in the authoring agent

- **do**: The authoring chat agent (opencode-driven, defined in `api/src/routes/authoring.ts`) currently doesn't expose `skill_write` or the new `helper_write` in its tool surface. Add both to the authoring agent's tool registry. Update `buildAuthoringSystemPrompt` to teach the authoring agent about both: "during a dry-run, if you discovered a selector / param shape / heuristic you don't want to re-derive, call skill_write. If the pipeline you just dry-ran is deterministic enough to compile, call helper_write so future fires skip the LLM."
- **verify**: drive the authoring agent through a sample automation creation; verify the system prompt's `<tools>` section lists both; trigger a successful dry-run; assert at least one of `skill_write` / `helper_write` was called and the row exists in DB.
- **evidence**: `authoring-tools.log`, `skill-or-helper-row.json`.
- **gates**: none.
- **kind**: code.

#### K.4 — Worker boot dynamic helper registration

- **do**: On worker session boot (`worker/src/opencode-plugin/index.ts` or wherever the tool set is assembled for a run), query `cloud_helpers WHERE workspace_id=$1 AND (automation_id IS NULL OR automation_id=$2) AND active=true`. For each row, dynamically register an opencode tool with `name=helper.name`, `description="(agent-authored helper) " + first line of body`, `params=z.object(helper.args_schema)`, and an `execute` that calls the K.5 sandbox runtime. Helpers SHADOW system tools with the same name (operator can override). Skills with `kind='playbook'` and matching automation_id get injected into the system prompt.
- **verify**: with one fixture helper named `lp_score_mutual` written into DB, dispatch a run; assert the run's `session.tools` activity event includes `lp_score_mutual`; LLM successfully calls it once with valid args.
- **evidence**: `session-tools.json`, `helper-call-trace.log`.
- **gates**: none.
- **kind**: code.

#### K.5 — Helper sandbox runtime

- **do**: Pick the sandbox model — `isolated-vm` (V8 isolate, no Node APIs, fastest) is the default choice; fall back to `vm2` if isolated-vm install fails on Lambda. Build `worker/src/helper-runtime/sandbox.ts` that takes `(body, args, ctx)`, compiles body once per worker boot, and invokes the exported `run(args, ctx)` with a frozen `ctx` exposing exactly: `ctx.composio(slug, params)`, `ctx.browser` (subset of harness API), `ctx.fetch` (workspace-scoped URL allowlist), `ctx.sql_read` (read-only SQL on workspace tables), `ctx.log`. No `process`, `fs`, `child_process`, `require`. Helper timeouts at 5 minutes; on timeout, throw a typed `HelperTimeoutError` so the dispatcher fast-path can fall back.
- **verify**: unit tests — sandbox refuses `require('fs')`, refuses raw fetch to disallowed origin, surfaces typed throw on timeout. Live: helper that calls Composio and writes a sheet row works end-to-end.
- **evidence**: `sandbox-test.log`, `live-helper-sheet-write.json`.
- **gates**: none.
- **kind**: code.

#### K.6 — System prompt: prefer helpers + emit after consistent runs

- **do**: Update both the live-run system prompt (in `api/src/lib/cloud-run-dispatch.ts:wrapAutomationGoal`'s `live` mode AND the cron-kicker mirror) AND the authoring chat prompt. New rules: (1) "You have the following workspace helpers registered: `<list>`. Prefer them over manual tool sequences when the input shape matches." (2) "After a successful run where every step was deterministic and no helper of the same name exists yet, call `helper_write` to compile this pipeline body so future fires can skip the LLM." (3) "If you call a helper and it throws, do NOT retry it — call its constituent tools manually and after the run, call `helper_write` to supersede the broken helper." Don't push too hard — the existing prompt is already long; this needs ≤ 600 tokens of additions.
- **verify**: run the LP Mapper a 4th time after K.2-K.5 are live. Assert: (a) the system prompt shows the helper list, (b) the run calls the helper, (c) the run completes in <30s (vs ~10min for LLM-from-scratch), (d) `result_summary` shows the helper was used.
- **evidence**: `helper-fast-path-run.log`, `cost-comparison.json` (this run vs the 2026-05-14 LLM-from-scratch run).
- **gates**: none.
- **kind**: code.

#### K.7 — Dispatcher fast-path

- **do**: In the dispatcher (worker/dispatcher/handler.ts) AND the cron-kicker, BEFORE enqueuing to SQS for opencode session boot, check: does the automation have an active `cloud_helpers` row named `${automation_slug}_run_once` (convention) and does the trigger payload match the helper's `args_schema`? If yes, execute the helper directly in the dispatcher Lambda (using the K.5 sandbox), write `cloud_runs` row as completed, skip SQS entirely. If the helper throws, fall back to the existing SQS path with the original goal text — LLM gets the throw context in its system prompt and patches the helper.
- **verify**: live LP run with helper present completes in <10s wall time (sub-Lambda-cold-start); helper-throw scenario falls back correctly and final state shows LLM-patched-and-rewrote-helper.
- **evidence**: `fast-path-success.log`, `fast-path-throw-fallback.log`.
- **gates**: none.
- **kind**: code.

#### K.8 — Token-decay live e2e

- **do**: Reset the operator's LP Mapper automation: delete any cloud_helpers row, archive any auto-written playbook skill. Drive the full LP pipeline from scratch via the authoring chat for one LP row. Then add 3 more rows and let the trigger fire each — observe that after row 2 a helper is written, and rows 3-4 use the fast-path. Capture token/cost totals per run.
- **verify**: Per-run cost goes from N tokens (row 1, all LLM) → ~N/2 (row 2, helper-write decision) → ~N/20 (row 3, fast-path) → ~N/20 (row 4). Final state: 4 LP rows fully mapped, ≥1 helper in `cloud_helpers`, ≥1 playbook skill in `cloud_skills`.
- **evidence**: `4-row-cost-trace.json`, `helpers-and-skills-final.json`, `sheet-final-snapshot.json`.
- **gates**: operator approves the live test.
- **kind**: verify-only.

---

### Phase exit conditions

- **A complete** when all A.1–A.9 evidence files exist with `verify` passing.
- **B complete** when all B.1–B.9 evidence files exist with `verify` passing.
- **C complete** when all C.1–C.7 evidence files exist with `verify` passing.
- **D complete** when all D.1–D.9 evidence files exist with `verify` passing.
- **E complete** when all E.1–E.10 evidence files exist with `verify` passing.
- **F complete** when all F.1–F.10 evidence files exist with `verify` passing.
- **G complete** when G.1–G.4 evidence files exist — pending approvals stream live to desktop, approvals decided on desktop cancel the parallel SMS prompt, outputs stream live to desktop.
- **H complete** when H.1–H.7 evidence files exist — polling is correct under concurrency (locking + isolation + fairness) and proven at 100-trigger throughput.
- **I complete** when I.1 evidence files exist — Opus-driven authoring picks the right architecture (browser vs Composio vs hybrid). The non-OAuth-site cookie onboarding gap moved out of this plan into the desktop integration doc (`docs/DESKTOP-COOKIE-IMPORT.md`).
- **J complete** when J.1–J.4 evidence files exist — worker pool deaths during long runs are diagnosed, fixed at the root, and recovered via orphan-redispatch when they do happen.
- **K complete** when K.1–K.8 evidence files exist — agent-authored TS helpers + dispatcher fast-path + skill_write surfaced in authoring chat, demonstrably decaying token cost per run for repeated workflows.
- **Plan complete** when K.8 passes.

The loop sets `state.completed = true` after K.8 passes and exits.

---

## 10. Non-goals (explicit out-of-scope for this plan)

These are real follow-ons but not in this plan's scope:

- **A separate planner agent.** The unified tool surface (§1) absorbs the planner's role. If we later find the executor needs explicit pre-run planning for very long workflows, we'll add it then.
- **Cross-workflow self-healing.** Tool-level self-healing via the `skills/` system covers most failure modes; workflow-level route-switching is a real future need but depends on having real production failure data to design against.
- **Multi-tenant marketplace of automations.** Sharing automations between workspaces (templates, public catalog) — useful eventually, not now.
- **Web-only / no-code automation builder UI.** The natural-language path (user describes, agent helps build the automation record) is the primary UX; a visual node-editor builder is a different product surface that can come later.
- **Real-time collaborative editing of automations.** Single-user editing with last-writer-wins is fine for now.
- **Cost-per-run optimizer.** No automatic route-switching to minimize cost; the agent picks the route that works, full stop.
