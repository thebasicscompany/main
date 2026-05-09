# Handoff — api control-plane for the v2 cloud agent

The v2 cloud-agent runtime (`docs/CLOUD-AGENT-PLAN.md`) shipped on
2026-05-09. The worker, dispatcher, EFS, SQS, EventBridge Scheduler IAM
role, and SSE proxy all exist in production. **What does NOT exist yet
is the HTTP control-plane in the api service that drives them.** This
doc enumerates exactly what the api team needs to build, in the shape
the worker expects.

This is a contract doc, not a tutorial. Read `CLOUD-AGENT-PLAN.md` for
the why; this is the what.

Owner: api team. Blocks: F.3-followup (legacy v1 source-file deletion).

---

## 1. Routes to add or refactor

All routes mount under `app.route('/v1/runs', …)` or `app.route('/v1/schedules', …)`. All require workspace JWT (`X-Workspace-Token`) and must scope every DB query by `workspace_id`. The auth middleware to use is the same one already wrapping `/v1/runtime/*` — copy that wiring.

### 1.1 `POST /v1/runs` — refactor

**Today:** `api/src/orchestrator/run.ts:314` calls `runAgentLoop(...)` in-process.

**Should:** drop the `runAgentLoop` call. Insert an `agent_runs` row (status `'pending'`), then send an SQS message to `basics-runs.fifo` with the shape in §2.1. Return `{ runId, status: 'pending' }`. The worker picks up the message, transitions the row to `'running'`, and writes events via `agent_activity` as it executes.

Once this lands, also delete `api/src/orchestrator/agentLoop.ts` and `api/src/orchestrator/computerUseDispatcher.ts` (the source files survived F.3 partial deletion only because of these call sites). `api/src/agentHelloWorld.ts` also imports `runAgentLoop`; either delete that file or refactor it to send an SQS message too.

### 1.2 `GET /v1/runs/:id/events` — add auth

**Today:** `api/src/routes/cloud-runs.ts` exists and works (verified end-to-end in F.3b — both live `postgres_changes` path and backfill path return the §11.1 event sequence). It is **mounted publicly without auth**. The route comment explicitly notes "Production auth (workspace JWT + workspace_id check) lands when the desktop app starts consuming this endpoint."

**Should:** wrap the existing route with the workspace JWT middleware and verify the run's `workspace_id` matches the token's workspace before subscribing. Reject with 403 otherwise. The Realtime subscription itself uses the service-role key (server-side), so the only enforcement is at the api boundary.

### 1.3 `POST /v1/schedules` — add

Wraps `worker/src/schedule-service.ts` `attach()` semantics. Body: `{ cloudAgentId, cron, timezone?, payload, laneId? }`. Behavior:

1. Verify the `cloud_agents` row's `workspace_id` matches the token. Reject with 404 if not (don't leak existence across workspaces).
2. Compose `CreateScheduleInput` per `worker/src/eventbridge-scheduler.ts`: name = `cloudAgentId`, sqsQueueArn = `basics-runs.fifo` ARN, invokeRoleArn = output `SchedulerInvokeRoleArn`, messageGroupId = `<workspaceId>:<laneId|default>`.
3. `existing = AwsSchedulerWrapper.get(name)`; if exists → `update`, else → `create`.
4. `UPDATE cloud_agents SET schedule = <cron>, eventbridge_schedule_arn = 'arn:aws:scheduler:::schedule/default/<cloudAgentId>', updated_at = now() WHERE id = <cloudAgentId> AND workspace_id = <ws>` (RETURNING id; reject 404 if no row).
5. Return `{ scheduleArn, scheduleName, cron }`.

The api can either (a) import `worker/src/schedule-service.ts` directly (the worker package is in `pnpm-workspace.yaml`) or (b) re-implement using `@aws-sdk/client-scheduler` directly. (a) is the lowest-friction path — the service is dependency-light (postgres + the wrapper).

### 1.4 `GET /v1/schedules/:cloudAgentId` — add

Wraps `ScheduleService.describe()`. Returns `{ scheduleName, aws: { exists, state, expression }, persistedArn }`. Same workspace-scope enforcement as 1.3.

### 1.5 `PATCH /v1/schedules/:cloudAgentId` — add

Same shape as `POST` (body `{ cron, timezone?, payload, laneId? }`). Idempotent — calls `attach()` which handles update-or-create.

### 1.6 `DELETE /v1/schedules/:cloudAgentId` — add

Wraps `ScheduleService.detach()`. Calls `AwsSchedulerWrapper.delete(name)` then `UPDATE cloud_agents SET eventbridge_schedule_arn = NULL` scoped to workspace. Idempotent — deleting a non-existent schedule is fine.

### 1.7 `POST /v1/schedules/:cloudAgentId/test` — add

Fires a one-shot run for this schedule WITHOUT going through EventBridge. Just send an SQS message to `basics-runs.fifo` directly with the same payload + group key the schedule would use. Returns `{ runId }`. Used by the dashboard's "Test schedule" button.

### 1.8 Workspace creation — set `runtime='v2'` default

Wherever new `workspaces` rows are inserted, set `agent_settings = '{"runtime":"v2"}'::jsonb` at insert time. F.1 flipped the design-partner workspaces to v2 manually; new workspaces should default there.

---

## 1.bis Pool-routing internals (Phase H, 2026-05-09)

The dispatcher Lambda's behavior changed in Phase H. It used to RunTask a fresh ECS task per workspace. Now:

- It picks an existing **opencode pool** (one ECS Fargate task running `opencode serve` + the plugin) with available capacity (`slots_used < slots_max`, default 5/pool).
- It posts the run job to the pool via Postgres `pg_notify` on channel `pool_<poolId>` (Supavisor session-mode port :5432 needed).
- The pool host (`worker/src/main.ts`) calls `POST /session` against its own `localhost:4096`, INSERTs into `opencode_session_bindings(session_id, workspace_id, run_id, account_id, pool_id)`, then `POST /session/:id/prompt_async` with the goal.
- The plugin (`worker/src/opencode-plugin/index.ts`) keeps a `Map<sessionID, Runtime>` so multiple concurrent sessions in the same opencode process get isolated Browserbase sessions, publishers, EFS workspaceRoots, and skill contexts. Resolution order for run-identity is `opencode_session_bindings` → process.env fallback.
- Tenant isolation: every fs tool resolves through `realpathInsideWorkspace(/workspace/<workspaceId>)`. Cross-tenant attempts emit a `cross_tenant_attempt` audit event in `agent_activity`.
- Cold-start fallback: if no pool has capacity, dispatcher RunTasks a fresh pool and throws so SQS redelivers the message; the next dispatch picks the new pool.

This is invisible to the api control-plane — keep posting run JSON to SQS as documented in §2.1. The Lambda hides the routing.

## 2. SQS contract

### 2.1 Message body (JSON)

The dispatcher Lambda parses this verbatim — see `worker/dispatcher/handler.ts:25`:

```json
{
  "runId":       "<uuid, must already exist in agent_runs>",
  "workspaceId": "<uuid>",
  "accountId":   "<uuid, optional>",
  "workflowId":  "<uuid, optional>",
  "inputs":      { "...": "any json passed through to the worker as WORKSPACE_INPUTS env" }
}
```

Required: `runId`, `workspaceId`. Everything else optional.

### 2.2 SendMessage attributes

- `MessageGroupId`: `<workspaceId>:<laneId|"default">`. FIFO ordering is per-group; same workspace + same lane = serialized.
- `MessageDeduplicationId`: the run id is fine — runs are unique by id.

### 2.3 Queue identifiers

- Queue name: `basics-runs.fifo`
- ARN: `arn:aws:sqs:us-east-1:635649352555:basics-runs.fifo`
- URL: `https://sqs.us-east-1.amazonaws.com/635649352555/basics-runs.fifo`

The api task role does NOT yet have `sqs:SendMessage` on this queue. **Add a policy in `sst.config.ts`** alongside `BasicsApiSchedulerPolicy` (added in F.3a) granting `sqs:SendMessage` + `sqs:GetQueueAttributes` on the queue ARN.

---

## 3. EventBridge Scheduler details

The api task role already has `scheduler:CreateSchedule | UpdateSchedule | DeleteSchedule | GetSchedule | ListSchedules` on `arn:aws:scheduler:*:*:schedule/default/*` plus `iam:PassRole` on the invoke role (added in F.3a). No additional IAM work needed for schedule CRUD.

- Invoke role ARN: `arn:aws:iam::635649352555:role/basics-scheduler-invoke-production` (SST output `SchedulerInvokeRoleArn`)
- Group: `default` (no need to create per-workspace groups; the SQS group key carries the multi-tenant boundary)
- Cron format: AWS uses 6-field crons with DOW=`?` convention. `worker/src/eventbridge-scheduler.ts` `cronToAws()` converts standard 5-field crons.

---

## 4. Database tables involved

All in the `public` schema. Worker writes; api reads + writes.

| Table | Owner of writes | Purpose |
|---|---|---|
| `agent_runs` | api inserts (status=`pending`); worker updates (status, started_at, completed_at, result_summary) | Run row keyed by `id` |
| `agent_run_steps` | worker only | Per-step audit |
| `agent_activity` | worker only | §11.1 events; SSE proxy reads + Realtime fans out on INSERT |
| `cloud_agents` | api owns (CRUD); worker reads | Agent definitions; `schedule` (cron string) + `eventbridge_schedule_arn` |
| `pending_approvals` | api inserts on tool gate; worker reads + updates on resolution | Approval queue |
| `workspaces.agent_settings` (jsonb) | api owns | `{ runtime: 'v1-legacy' | 'v2', dailyCostCeilingCents?: number }` |
| `workspace_active_tasks` | dispatcher Lambda manages | Tracker for running ECS tasks per workspace |
| `usage_tracking` | worker writes (UPSERT) | Per-day cost rollups |

The `supabase_realtime` publication includes `agent_activity` (added in migration `0004_cloud_agent_a5.sql`). The SSE proxy (1.2) consumes this.

---

## 5. Auth

Reuse the workspace JWT middleware that already protects `/v1/runtime/*`. Every route in §1 must:

1. Parse + verify `X-Workspace-Token`.
2. Scope every DB query by `workspace_id = <token.workspace_id>`. Cross-workspace reads must 404, not 403, to avoid existence leaks.
3. For SSE: check the run's workspace before subscribing. Hard-coding the run id is not enough.

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

Don't leak AWS or Postgres error messages — wrap them.

---

## 7. Testing checklist for the api team

Before declaring done, verify these end-to-end against production (the same way F.3b verified the SSE proxy):

- [ ] `POST /v1/runs` → SQS receives a message → dispatcher launches worker → worker writes to `agent_activity` → SSE consumer (curl) sees the §11.1 event sequence.
- [ ] `POST /v1/schedules` → AWS `get-schedule` returns the expected target (RoleArn = `basics-scheduler-invoke-production`, Arn = the SQS FIFO, MessageGroupId = `<ws>:<lane>`).
- [ ] EventBridge fires the schedule → SQS receives → worker runs.
- [ ] `DELETE /v1/schedules/:id` → AWS `get-schedule` returns 404 → `cloud_agents.eventbridge_schedule_arn` is NULL.
- [ ] Cross-workspace request to any of the routes → 404, not 403.
- [ ] `POST /v1/schedules/:id/test` → run lands in `agent_runs` within 5s.

---

## 8. Once this lands

1. F.3-followup: delete `api/src/orchestrator/agentLoop.ts` + `computerUseDispatcher.ts` + the `computer_20250124` registration in `runMessages`.
2. Update `ARCHITECTURE.md` block diagram + Component-responsibilities text to describe the v2 path (the legacy diagram lives there now only because the legacy source still does).
3. Flip `state.json` history with a final F.3-followup entry (or just commit + note in the retro that legacy deletion is done).

---

## 9. Things explicitly NOT in this handoff

- Desktop client wiring of the SSE consumer — owned by the desktop team.
- Run cancellation / takeover — exists in v1 path; v2 worker has the hooks (`paused_at`, `resume_token` on `agent_runs`) but the api routes for it are out of scope here.
- Replay UI for completed runs — same.
- Per-workspace Browserbase project per CLOUD-AGENT-PLAN §0 deferred items.
- BYOK key CRUD — the worker reads via `/v1/runtime/byo-keys` (already exists). No new routes needed.
- Approval surface evolution beyond the existing `pending_approvals` table.

If a route or table comes up that's not in §1 or §4, surface it back to the agent team before building.
