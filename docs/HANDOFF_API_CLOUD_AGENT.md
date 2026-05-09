# Handoff — api control-plane for the v2 cloud agent

The v2 cloud-agent runtime (`docs/CLOUD-AGENT-PLAN.md`) shipped on
2026-05-09. The worker pool, dispatcher, EFS, SQS, EventBridge Scheduler
infra, kicker Lambda, plugin (32 Browserbase tools), per-session runtime
isolation, skill load + write, and SSE proxy all exist in production.
**What does NOT exist yet is the HTTP control-plane in the api service
that drives them.** This doc enumerates exactly what the api team needs
to build, in the shape the worker expects.

This is a contract doc, not a tutorial. Read `docs/CLOUD-AGENT-PLAN.md`
for the why; this is the what.

Owner: api team. Blocks: F.3-followup (legacy v1 source-file deletion).

---

## 0. What changed since the last revision

This doc was first written at the end of Phase F. Phases G + H + bug
fixes shipped after. Read these before §1:

- **`agent_runs.status` lifecycle is real.** Not just `'pending'` →
  the worker now writes `'running'` on dispatch and
  `'completed' | 'error'` on terminal, with `duration_seconds` and
  `completed_at` populated. UI can drive progress states off this.
- **`live_view_url` + `browserbase_session_id`** are written to
  `agent_runs` once Browserbase attaches. Desktop can iframe
  `live_view_url` to show the agent's browser in real time.
- **Multi-tenant pool architecture** (Phase H). The dispatcher no
  longer launches one ECS task per workspace; it routes to a pool with
  available slots via `pg_notify`. Side-tables are `opencode_pools`
  and `opencode_session_bindings`. **api does not need to interact
  with these tables** — they're internal — but they exist and the
  schema docs now mention them in §4.
- **Browserbase Context attach is automatic.** When the worker boots a
  Browserbase session for a run, it reads
  `workspaces.browserbase_profile_id` and attaches that Context
  (cookies + storage). The api does not need to wire this — but the
  api SHOULD provide a way for users to set/rotate the profile id.
- **Skills load + write is live.** Skills the agent learns land in
  `public.skills` with `pending_review = true`. The agent reuses
  `pending_review = false` skills on subsequent runs via the system
  prompt. **api needs a route to approve skills** (§1.9).
- **Cron schedules go through a kicker Lambda**, not directly through
  Scheduler→SQS. EventBridge Scheduler can't generate dynamic runIds
  per invocation, so we put `basics-cron-kicker` in front. §3 below
  has the exact payload shape api should send when creating a schedule.
- **EFS data is real now.** Per-workspace files at
  `/workspace/<workspaceId>/...` (skills bodies, helpers, run outputs)
  persist across runs. fs-policy enforces tenant isolation; cross-
  tenant attempts emit `cross_tenant_attempt` audit events.

---

## 1. Routes to add or refactor

All routes mount under `app.route('/v1/runs', …)`,
`app.route('/v1/schedules', …)`, or `app.route('/v1/skills', …)`. All
require workspace JWT (`X-Workspace-Token`) and must scope every DB
query by `workspace_id`. The auth middleware to use is the same one
already wrapping `/v1/runtime/*` — copy that wiring.

### 1.1 `POST /v1/runs` — refactor

**Today:** `api/src/orchestrator/run.ts:314` calls `runAgentLoop(...)`
in-process (the legacy v1 path).

**Should:** drop the `runAgentLoop` call. Insert an `agent_runs` row
(status `'pending'`), then send an SQS message to `basics-runs.fifo`
with the shape in §2.1. Return
`{ runId, status: 'pending', liveViewUrl: null }`. The worker picks
up the message, transitions the row to `'running'`, sets
`browserbase_session_id` + `live_view_url`, and writes events via
`agent_activity` as it executes. On terminal it sets
`status='completed' | 'error'`, `duration_seconds`, `completed_at`.

Once this lands, also delete `api/src/orchestrator/agentLoop.ts` and
`api/src/orchestrator/computerUseDispatcher.ts` (the source files
survived F.3 partial deletion only because of these call sites).
`api/src/agentHelloWorld.ts` also imports `runAgentLoop`; either
delete that file or refactor it to send an SQS message too.

### 1.2 `GET /v1/runs/:id/events` — add auth + filtering note

**Today:** `api/src/routes/cloud-runs.ts` exists and works. It is
**mounted publicly without auth**.

**Should:** wrap the existing route with the workspace JWT middleware
and verify the run's `workspace_id` matches the token's workspace
before subscribing. Reject with 403 otherwise. The Realtime
subscription uses the service-role key (server-side); the only
enforcement is at the api boundary.

**Filtering note**: the worker already drops high-volume noise events
(`oc.message.part.delta`, `oc.message.updated`, `oc.session.diff`,
`oc.session.status`, `oc.session.updated`) before INSERT, so the SSE
proxy stream is ~13% the volume of raw opencode output. The events
the desktop client SHOULD render are listed in `docs/CLOUD-AGENT-PLAN.md`
§11.1 plus the worker-emitted ones: `run_started`, `run_completed`,
`tool_call_start`, `tool_call_end`, `screenshot`, `final_answer`,
`browserbase_session_creating`, `browserbase_session_attached`,
`skills_loaded`, `skill_written`, `cross_tenant_attempt`, plus
`oc.message.part.updated` (assistant text deltas, kept) and
`oc.tool_use` (mirror of tool calls with model side detail).

### 1.3 `POST /v1/schedules` — add (uses cron-kicker)

Body: `{ cloudAgentId, cron, payload?, laneId?, model? }`.

**Behavior**:

1. Verify the `cloud_agents` row's `workspace_id` matches the token.
   Reject with 404 if not.
2. Resolve goal text — either from `cloud_agents.definition` or from
   the body's `payload.goal`. Whichever ends up in the kicker payload
   below.
3. Call `aws scheduler create-schedule`:
   ```
   {
     "Name": "agent-<cloudAgentId>",
     "GroupName": "default",
     "ScheduleExpression": "<cron from body>",
     "FlexibleTimeWindow": { "Mode": "OFF" },
     "State": "ENABLED",
     "Target": {
       "Arn": "<CronKickerLambdaArn from SST output>",
       "RoleArn": "<SchedulerInvokeRoleArn from SST output>",
       "Input": "<JSON-stringified kicker payload — see §3.1>"
     }
   }
   ```
4. `UPDATE cloud_agents SET schedule=<cron>, eventbridge_schedule_arn=<ScheduleArn>, updated_at=now() WHERE id=<cloudAgentId> AND workspace_id=<ws>` (RETURNING id; reject 404 if no row).
5. Return `{ scheduleArn, scheduleName, cron }`.

The api's task role already has the IAM perms (`scheduler:Create*` +
`iam:PassRole` on the invoke role) — added in F.3a.

**Do not target SQS directly.** EventBridge Scheduler can't generate
dynamic runIds per fire, so the kicker is required. See §3.1 for the
kicker payload shape.

### 1.4 `GET /v1/schedules/:cloudAgentId` — add

Wraps `aws scheduler get-schedule`. Returns
`{ scheduleName, aws: { exists, state, expression, target }, persistedArn }`.
Same workspace-scope enforcement as 1.3.

### 1.5 `PATCH /v1/schedules/:cloudAgentId` — add

Same shape as `POST` (body `{ cron?, payload?, laneId?, model? }`).
Calls `aws scheduler update-schedule` (which requires the full target
spec, so this re-composes it).

### 1.6 `DELETE /v1/schedules/:cloudAgentId` — add

Calls `aws scheduler delete-schedule` then `UPDATE cloud_agents SET eventbridge_schedule_arn = NULL` scoped to workspace. Idempotent — deleting a non-existent schedule is fine.

### 1.7 `POST /v1/schedules/:cloudAgentId/test` — add

Fires a one-shot run for this schedule WITHOUT going through
EventBridge. INSERT a fresh `agent_runs` row, then send an SQS
message directly with the schedule's payload + group key. Returns
`{ runId }`.

### 1.8 Workspace creation — set `runtime='v2'` default

Wherever new `workspaces` rows are inserted, set
`agent_settings = '{"runtime":"v2"}'::jsonb` at insert time. F.1
flipped the design-partner workspaces to v2 manually; new workspaces
should default there.

### 1.9 `POST /v1/skills/:id/approve` — add (NEW in this revision)

When the agent writes a skill via `skill_write`, the row lands with
`pending_review = true`. The agent's loader filters those out, so
they're invisible until approved. The api needs:

```
POST   /v1/skills/:id/approve   → { id, pending_review: false }
POST   /v1/skills/:id/reject    → { id, active: false }       (optional)
GET    /v1/skills?pending=true  → list of skills awaiting review
PATCH  /v1/skills/:id           → body {description?, body?, confidence?}
DELETE /v1/skills/:id           → soft-delete (active=false)
```

All scoped to workspace_id. The desktop "Skills" panel reads via
GET, the operator reviews + approves. **Until approved, skills are
written but never re-injected into runs.**

### 1.10 `GET /v1/runs?cloudAgentId=...&limit=&since=` — add (NEW)

For the schedule-history view: list past runs for an agent.
Returns `[{ id, status, started_at, completed_at, duration_seconds, summary, browserbase_session_id, live_view_url }]`.
Useful state: `running` (currently in-flight; show live UI),
`completed` (show summary + replay), `error` (show error +
optionally re-run).

### 1.11 `POST /v1/cloud-agents/:id/browserbase-context/sync` — clarify (existing)

Cookies attach automatically when the worker boots a session — the
worker reads `workspaces.browserbase_profile_id`. The api should
already have an endpoint for the desktop / extension to update
that profile id (existing pre-Phase-G). Just confirm it's wired and
the desktop pushes there before scheduling runs.

---

## 2. SQS contract

### 2.1 Message body (JSON)

The dispatcher Lambda parses this verbatim — see
`worker/dispatcher/handler.ts`:

```json
{
  "runId":       "<uuid, must already exist in agent_runs>",
  "workspaceId": "<uuid>",
  "accountId":   "<uuid>",
  "goal":        "<natural-language instruction for the agent>",
  "model":       "anthropic/claude-sonnet-4-5"   // optional
}
```

Required: `runId`, `workspaceId`, `accountId`, `goal`. The
`{cloudAgentId, workflowId, inputs}` fields from older docs are not
read by the dispatcher anymore — pass the goal directly.

### 2.2 SendMessage attributes

- `MessageGroupId`: `<workspaceId>:<laneId|"default">`. FIFO ordering
  is per-group.
- `MessageDeduplicationId`: the run id is fine — runs are unique by id.

### 2.3 Queue identifiers

- Queue name: `basics-runs.fifo`
- ARN: `arn:aws:sqs:us-east-1:635649352555:basics-runs.fifo`
- URL: `https://sqs.us-east-1.amazonaws.com/635649352555/basics-runs.fifo`
- **`protect: true`** — Pulumi will refuse to delete or replace the
  queue. If you need to recreate it, explicitly remove the protect
  flag in `sst.config.ts` first.

The api task role does NOT yet have `sqs:SendMessage` on this queue.
**Add a policy in `sst.config.ts`** alongside `BasicsApiSchedulerPolicy`
granting `sqs:SendMessage` + `sqs:GetQueueAttributes` on the queue ARN.

---

## 3. EventBridge Scheduler + cron-kicker

### 3.1 Kicker payload shape

When you `aws scheduler create-schedule`, the `Target.Input` field is
a JSON-stringified payload that EventBridge passes to the kicker
Lambda on each fire. The kicker (`worker/cron-kicker/handler.ts`)
generates a fresh runId, INSERTs `agent_runs`, and sends to SQS.

```json
{
  "cloudAgentId": "<uuid>",
  "workspaceId":  "<uuid>",
  "accountId":    "<uuid>",
  "goal":         "<goal text — supports {VAR} substitution>",
  "vars":         { "VIDEO_ID": "abc123" },     // optional, inlined into goal
  "model":        "anthropic/claude-sonnet-4-5", // optional
  "laneId":       "<lane uuid>"                  // optional
}
```

The kicker substitutes `{VAR}` tokens in `goal` from the `vars` map
before sending to SQS. This lets a single kicker payload be
parameterized — e.g., a YouTube-stats agent's goal includes
`{VIDEO_ID}` and `vars.VIDEO_ID = "dQw4w9WgXcQ"`.

### 3.2 Identifiers

- Kicker Lambda ARN: `arn:aws:lambda:us-east-1:635649352555:function:basics-cron-kicker`
  (SST output `CronKickerLambdaArn`)
- Invoke role ARN: `arn:aws:iam::635649352555:role/basics-scheduler-invoke-production`
  (SST output `SchedulerInvokeRoleArn`)
- Group: `default` (no need to create per-workspace groups; the SQS
  group key carries the multi-tenant boundary)

### 3.3 IAM already wired

The api task role already has `scheduler:CreateSchedule | UpdateSchedule | DeleteSchedule | GetSchedule | ListSchedules` on `arn:aws:scheduler:*:*:schedule/default/*` plus `iam:PassRole` on the invoke role. The invoke role's trust policy already lists Lambda invocation perms on the kicker ARN.

---

## 4. Database tables involved

All in the `public` schema. Worker writes; api reads + writes.

| Table | Owner of writes | Purpose |
|---|---|---|
| `agent_runs` | api inserts (status=`pending`); worker UPDATEs (status `running` → `completed`/`error`, `started_at`, `completed_at`, `duration_seconds`, `browserbase_session_id`, `live_view_url`, `result_summary`, `error_message`) | Run row keyed by `id` |
| `agent_run_steps` | worker only | Per-step audit |
| `agent_activity` | worker only | §11.1 events; SSE proxy reads + Realtime fans out on INSERT. Token-level streaming events are filtered out by the worker before INSERT. |
| `cloud_agents` | api owns (CRUD); worker reads | Agent definitions; `schedule` (cron string) + `eventbridge_schedule_arn` |
| `pending_approvals` | api inserts on tool gate; worker reads + updates on resolution | Approval queue |
| `workspaces.agent_settings` (jsonb) | api owns | `{ runtime: 'v1-legacy' \| 'v2', dailyCostCeilingCents?: number, allowPII?: boolean }` |
| `workspaces.browserbase_profile_id` | api owns (set by extension cookie sync) | Browserbase Context id; worker reads to attach cookies/state |
| `skills` | worker INSERTs (`pending_review=true`); **api UPDATEs `pending_review`, `active`, `confidence`** | Learned playbooks. `description`, `body`, `host`, `scope`. |
| `agent_helpers` | worker writes (file create/update); reflected in `last_modified_at` | Per-workspace TS helper modules on EFS |
| `usage_tracking` | worker writes (UPSERT) | Per-day cost rollups; api reads for billing/quota UI |
| `opencode_pools` | worker writes; dispatcher reads | **Internal**. Pool registry — api shouldn't query directly. |
| `opencode_session_bindings` | worker writes; plugin reads | **Internal**. Session→workspace mapping for the plugin's per-session ctx. |
| `workspace_active_tasks` | (legacy from G.5; superseded by `opencode_pools`. Don't reference. ) | Will be dropped in a future cleanup. |

The `supabase_realtime` publication includes `agent_activity` (added in
migration `0004_cloud_agent_a5.sql`). The SSE proxy (1.2) consumes this.

---

## 5. Auth

Reuse the workspace JWT middleware that already protects `/v1/runtime/*`. Every route in §1 must:

1. Parse + verify `X-Workspace-Token`.
2. Scope every DB query by `workspace_id = <token.workspace_id>`. Cross-workspace reads must 404, not 403, to avoid existence leaks.
3. For SSE: check the run's workspace before subscribing. Hard-coding the run id is not enough.
4. For skill approval: scope by workspace AND verify the skill's `learned_by_agent_id`'s `cloud_agents.workspace_id` also matches.

---

## 6. Error contracts

For consistency with the existing `/v1/runtime/*` surface:

| Condition | HTTP | Body |
|---|---|---|
| Token missing/invalid | 401 | `{ error: 'unauthorized' }` |
| Resource not found OR cross-workspace access | 404 | `{ error: 'not_found' }` |
| Validation failure | 400 | `{ error: 'invalid_<field>' }` |
| AWS call failed | 502 | `{ error: 'upstream_failed', detail: <safe message> }` |
| Daily cost ceiling exceeded | 429 | `{ error: 'budget_exceeded' }` (optional — worker also enforces this; api can short-circuit) |
| Skill content rejected by policy | 400 | `{ error: 'skill_rejected', code: 'pii_detected'\|'pixel_coords'\|... }` (only relevant if api ever proxies skill_write — typically the worker handles this) |

Don't leak AWS or Postgres error messages — wrap them.

---

## 7. Testing checklist for the api team

Before declaring done, verify these end-to-end against production:

- [ ] `POST /v1/runs` → SQS receives a message → dispatcher pg_notify's a pool → worker writes to `agent_activity` → SSE consumer (curl) sees the §11.1 event sequence → `agent_runs.status` cycles `pending` → `running` → `completed` → `duration_seconds` populated.
- [ ] `POST /v1/schedules` → AWS `get-schedule` returns the expected target (Arn = kicker Lambda, RoleArn = scheduler-invoke-production).
- [ ] EventBridge fires the schedule (≥2 fires) → kicker Lambda inserts agent_runs → SQS receives → worker runs each.
- [ ] Each cron fire generates a UNIQUE runId (no collisions in agent_runs.id).
- [ ] `DELETE /v1/schedules/:id` → AWS `get-schedule` returns 404 → `cloud_agents.eventbridge_schedule_arn` is NULL.
- [ ] Cross-workspace request to any of the routes → 404, not 403.
- [ ] `POST /v1/schedules/:id/test` → run lands in `agent_runs` within 5s.
- [ ] `POST /v1/skills/:id/approve` → row's `pending_review=false` → next run for the same workspace shows the skill in the `skills_loaded` event.
- [ ] `GET /v1/runs/:id/events` rejects requests for a run in another workspace with 403.
- [ ] `live_view_url` on `agent_runs` (after a cold-start ~5-10s) is iframe-able and shows the agent's browser.

---

## 8. Once this lands

1. F.3-followup: delete `api/src/orchestrator/agentLoop.ts` + `computerUseDispatcher.ts` + the `computer_20250124` registration in `runMessages`.
2. Update `ARCHITECTURE.md` block diagram + Component-responsibilities text to describe the v2 path (the legacy diagram lives there now only because the legacy source still does).
3. Drop `public.workspace_active_tasks` (table is unused after Phase H — `opencode_pools` replaced it).
4. Flip `state.json` history with a final F.3-followup entry.

---

## 9. Things explicitly NOT in this handoff

- Desktop client wiring of the SSE consumer — owned by the desktop team.
- Run cancellation / takeover — `agent_runs.paused_at` + `resume_token` columns exist; worker has nothing implementing pause yet. Out of scope here.
- Replay UI for completed runs — same. agent_activity has the timeline; UI is the desktop team's call.
- Per-workspace Browserbase project per CLOUD-AGENT-PLAN §0 deferred items.
- BYOK key CRUD — the worker reads via `/v1/runtime/byo-keys` (already exists). No new routes needed.
- Approval surface evolution beyond the existing `pending_approvals` table.
- Pool size tuning UI — `opencode_pools.slots_max` is set at SST deploy time (default 5). If you want to expose this per-workspace, that's a future enhancement.

If a route or table comes up that's not in §1 or §4, surface it back to the agent team before building.
