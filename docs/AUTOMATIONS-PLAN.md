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

- **do**: edit `sst.config.ts` worker container env block (currently at ~`sst.config.ts:585-598`) to inject `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SES_FROM_EMAIL` from the SST secrets declared in A.0 (already done — see `secrets.sendblue*` / `secrets.sesFromEmail`), plus `ARTIFACTS_S3_BUCKET` interpolated from `artifactsBucket.name`. Do NOT add `SENDBLUE_SIGNING_SECRET` (only needed by inbound-webhook handler on the API). Run `pnpm sst deploy --stage production`.
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

### Phase exit conditions

- **A complete** when all A.1–A.9 evidence files exist with `verify` passing.
- **B complete** when all B.1–B.9 evidence files exist with `verify` passing.
- **C complete** when all C.1–C.7 evidence files exist with `verify` passing.
- **D complete** when all D.1–D.9 evidence files exist with `verify` passing.
- **Plan complete** when D.9 passes — the LP automation has run end-to-end unattended.

The loop sets `state.completed = true` after D.9 passes and exits.

---

## 10. Non-goals (explicit out-of-scope for this plan)

These are real follow-ons but not in this plan's scope:

- **A separate planner agent.** The unified tool surface (§1) absorbs the planner's role. If we later find the executor needs explicit pre-run planning for very long workflows, we'll add it then.
- **Cross-workflow self-healing.** Tool-level self-healing via the `skills/` system covers most failure modes; workflow-level route-switching is a real future need but depends on having real production failure data to design against.
- **Multi-tenant marketplace of automations.** Sharing automations between workspaces (templates, public catalog) — useful eventually, not now.
- **Web-only / no-code automation builder UI.** The natural-language path (user describes, agent helps build the automation record) is the primary UX; a visual node-editor builder is a different product surface that can come later.
- **Real-time collaborative editing of automations.** Single-user editing with last-writer-wins is fine for now.
- **Cost-per-run optimizer.** No automatic route-switching to minimize cost; the agent picks the route that works, full stop.
