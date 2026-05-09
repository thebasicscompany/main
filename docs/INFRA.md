# INFRA — what's running in AWS, what each piece does, how to operate it

This doc is for humans onboarding to the cloud-agent stack AND for
LLM agents (Claude Code etc.) that pick up ops work. It is the
"map of the territory": every AWS resource we provision, what it
does, how the parts fit together, and the AWS CLI / SQL incantations
to inspect and modify them.

If you only read one section, read **§7 Common ops** — it has the
day-to-day commands.

If a new LLM agent picks up this stack, it should read this doc + the
CloudFormation-equivalent definitions in `sst.config.ts` + the
`worker/` package's `main.ts` and `dispatcher/handler.ts` before
making any change.

> **Authoritative source of truth: `sst.config.ts` (Pulumi via SST v3).**
> Don't change AWS resources via the console. Edit `sst.config.ts` +
> `sst deploy`. The console is read-only for this stack except in
> emergencies (and even then, follow up with `sst refresh` to sync
> Pulumi state).

---

## Table of contents

1. The 30-second mental model
2. Resource inventory (with IDs)
3. Data flows (one-shot run, cron run, cookies, files)
4. Postgres tables — what lives where
5. Cost model
6. Deployment + day-1 ops
7. Common ops cheatsheet (commands)
8. Protected resources + how to override
9. Gotchas + known pitfalls
10. For LLM agents: starting points + scripts

---

## 1. The 30-second mental model

```
┌─────────────────┐    POST /v1/runs       ┌──────────────────┐
│ Desktop client  │──── POST /v1/schedules ├─→│  api (Hono)    │
└─────────────────┘    (workspace JWT)        │  api.trybasics  │
                                              └────┬─────────────┘
                                                   │ aws sqs   │ aws scheduler
                                                   │ send      │ create-schedule
                                                   ▼            ▼
                                       ┌──────────────────────────────────┐
                                       │ basics-runs.fifo (SQS)           │
                                       │   ←── Scheduler→cron-kicker→SQS  │
                                       └──────────┬───────────────────────┘
                                                  │ event source mapping
                                                  ▼
                                       ┌──────────────────────────────────┐
                                       │ basics-dispatcher (Lambda)       │
                                       │  pickAvailablePool() → pg_notify │
                                       └──────────┬───────────────────────┘
                                                  │ pg_notify pool_<id>
                                                  ▼
                                       ┌──────────────────────────────────┐
                                       │ ECS Fargate task: basics-worker  │
                                       │  ├─ container: opencode serve    │
                                       │  ├─ container: browser-harness   │
                                       │  └─ container: basics-worker     │
                                       │     ├─ pool host (LISTEN)        │
                                       │     └─ plugin (32 tools)         │
                                       │  ├─ EFS at /workspace            │
                                       │  └─ Browserbase CDP via internet │
                                       └──────────┬───────────────────────┘
                                                  │ INSERT
                                                  ▼
                                       ┌──────────────────────────────────┐
                                       │ Supabase Postgres (agent_*)      │
                                       │  ├─ agent_runs / agent_activity  │
                                       │  ├─ skills / agent_helpers       │
                                       │  ├─ cloud_agents / workspaces    │
                                       │  └─ opencode_pools / _bindings   │
                                       └──────────────────────────────────┘
                                                  ▲
                                                  │ Realtime postgres_changes
                                                  ▼
                                       ┌──────────────────────────────────┐
                                       │ /v1/runs/:id/events (SSE proxy)  │
                                       │ → desktop client tails events    │
                                       └──────────────────────────────────┘
```

One ECS task hosts an `opencode serve` HTTP API + our plugin. Many
opencode sessions (one per run) share that task. When the pool fills
to `slots_max`, the dispatcher launches a new task. When all sessions
go idle for 15 min, the task exits.

---

## 2. Resource inventory

All in `us-east-1`. Account `635649352555`. SST stage `production`.
SST app `basics-runtime`.

### 2.1 Compute

| Resource | ID / ARN | Purpose |
|---|---|---|
| ECS cluster (api) | `basics-runtime-production` | api Hono service runs here. Not where workers run. |
| ECS cluster (workers) | `basics-agent` | Where pool worker tasks run. |
| ECR repo | `635649352555.dkr.ecr.us-east-1.amazonaws.com/basics-worker` | Worker container image (`:latest` is the production tag). |
| ECS task definition | family `basics-worker`, current rev 6 | 3 containers: `basics-worker`, `opencode`, `browser-harness-js`. X86_64. 1 vCPU / 2 GB. EFS mount at `/workspace`. |
| Worker SG | `sg-06b8bbc396f213681` | Outbound only — workers reach Browserbase, Anthropic, Supabase, AWS APIs via NAT. |
| Worker task role | `arn:aws:iam::…:role/basics-worker-task-role` | EFS ClientMount/Write, SQS receive (legacy from G.5), DescribeTasks. |
| Worker execution role | `arn:aws:iam::…:role/basics-worker-execution-role` | ECR pull + CloudWatch logs. |
| CloudWatch log group | `/aws/ecs/basics-worker` | Worker stdout/stderr. Streams: `main/basics-worker/<task-id>` for runner; `opencode/...` and `browser-harness-js/...` for the sidecars. |

### 2.2 Networking

| Resource | ID | Purpose |
|---|---|---|
| VPC | `vpc-0904f3df3b1b69970` | Shared with the api Service. |
| Private subnets | `subnet-068bf509f00c3ede2`, `subnet-06d88807c454bff0d` | Workers + EFS mount targets land here. NAT egress. |
| EFS SG | `sg-0b3d0ea4aedecc84d` | NFS port 2049 from VPC CIDR `10.0.0.0/16`. |

### 2.3 Storage + queues

| Resource | ID / Name | Purpose |
|---|---|---|
| EFS file system | `fs-04a265d569529f6de` (Name: `basics-workspaces`) | Per-workspace persistent files. **`protect: true`** — Pulumi refuses to delete. |
| EFS access point | `BasicsWorkspacesAccessPoint` | Single shared, root path `/workspaces`, posixUser 1000:1000, perms 0755. **`protect: true`**. Per-workspace dirs are subpaths under `/workspace/<workspaceId>/...`. |
| EFS mount targets | one per private subnet | NFS endpoints. **`protect: true`**. |
| SQS queue | `basics-runs.fifo` (ARN `arn:aws:sqs:us-east-1:635649352555:basics-runs.fifo`) | FIFO, 4-day retention, 360s visibility timeout, `MessageGroupId = "<workspaceId>:<lane>"`. **`protect: true`**. |
| S3 bucket | `basics-runtime-screenshots` | Phase 05 audit screenshots (90-day TTL). Not currently used by the worker; reserved for §11.1 `screenshot.s3Key` once the upload path lands. |

### 2.4 Lambdas

| Function | ARN | Trigger | Purpose |
|---|---|---|---|
| `basics-dispatcher` | `arn:aws:lambda:us-east-1:635649352555:function:basics-dispatcher` | SQS event source on `basics-runs.fifo` | Picks an available pool via `pickAvailablePool()` (slot count + ECS DescribeTasks), pg_notify's the run JSON to channel `pool_<poolId>`. Falls through to `ecs:RunTask` (launch new pool) when no pool has capacity. |
| `basics-cron-kicker` | `arn:aws:lambda:us-east-1:635649352555:function:basics-cron-kicker` | EventBridge Scheduler (per schedule) | Mints fresh runId, INSERTs `agent_runs`, sends to SQS with substituted `vars`. The bridge between Scheduler (which can't generate dynamic IDs) and our SQS-driven flow. |

Both Lambdas run nodejs22.x in the VPC's default Lambda config (no
custom VPC attach — Lambda → AWS APIs goes via the public AWS endpoints
since these Lambdas don't talk to private VPC resources directly).

### 2.5 Schedules + scheduler IAM

| Resource | ID | Purpose |
|---|---|---|
| Scheduler invoke role | `arn:aws:iam::…:role/basics-scheduler-invoke-production` | EventBridge Scheduler assumes this to invoke targets (currently the cron-kicker Lambda + SQS). |
| Schedule group | `default` | All schedules live here. The SQS FIFO group key carries the multi-tenant boundary, so we don't need per-workspace groups. |
| Per-cloud-agent schedules | `arn:aws:scheduler:us-east-1:635649352555:schedule/default/agent-<cloudAgentId>` | Created by api `POST /v1/schedules`. Target = cron-kicker Lambda. |

### 2.6 SST outputs

`pnpm sst deploy --stage production` returns these — the api can
consume them at deploy time:

```
ApiUrl                       https://api.trybasics.ai/
WorkerEcrRepoUrl             635649352555.dkr.ecr.us-east-1.amazonaws.com/basics-worker
WorkerTaskDefinitionArn      arn:aws:ecs:us-east-1:…:task-definition/basics-worker:6
WorkerTaskRoleArn            arn:aws:iam::…:role/basics-worker-task-role
WorkerTaskSecurityGroupId    sg-06b8bbc396f213681
WorkspacesEfsId              fs-04a265d569529f6de
WorkspacesEfsArn             arn:aws:elasticfilesystem:us-east-1:…:file-system/fs-…
WorkspacesEfsSecurityGroupId sg-0b3d0ea4aedecc84d
RunsQueueArn                 arn:aws:sqs:us-east-1:…:basics-runs.fifo
RunsQueueUrl                 https://sqs.us-east-1.amazonaws.com/…/basics-runs.fifo
DispatcherLambdaArn          arn:aws:lambda:us-east-1:…:function:basics-dispatcher
CronKickerLambdaArn          arn:aws:lambda:us-east-1:…:function:basics-cron-kicker
SchedulerInvokeRoleArn       arn:aws:iam::…:role/basics-scheduler-invoke-production
ClusterName                  basics-runtime-production    (NOT the worker cluster — that's hard-coded `basics-agent`)
```

---

## 3. Data flows

### 3.1 One-shot run (`POST /v1/runs`)

```
1. desktop POST /v1/runs { goal, workspaceId } (JWT)
2. api inserts agent_runs row (status=pending)
3. api sends SQS msg { runId, workspaceId, accountId, goal } to basics-runs.fifo
   MessageGroupId = "<wsId>:default"
4. dispatcher Lambda fires (event source mapping)
5. dispatcher picks pool with slots_used < slots_max + ECS task alive
6. dispatcher INCREMENT pool.slots_used, pg_notify(pool_<poolId>, msg)
7. pool host (basics-worker container) receives NOTIFY
8. pool host POST localhost:4096/session, INSERT opencode_session_bindings,
   UPDATE agent_runs.status=running, POST /session/:id/prompt_async
9. opencode-serve drives the model loop, plugin handles tool calls
10. agent_activity rows accumulate, SSE proxy streams to desktop
11. session.idle → worker emits run_completed, UPDATE agent_runs status=completed
    + duration_seconds + completed_at, decrement slots
```

If step 5 finds no pool: dispatcher `ecs:RunTask`s a new pool, throws,
SQS redelivers in ~6 min, next dispatcher invocation finds the pool
ready.

### 3.2 Cron run (`POST /v1/schedules` + cron fire)

```
api POST /v1/schedules:
  aws scheduler create-schedule {
    Target.Arn = CronKickerLambdaArn
    Target.RoleArn = SchedulerInvokeRoleArn
    Target.Input = JSON {
      cloudAgentId, workspaceId, accountId, goal, vars?, model?
    }
  }

every cron fire:
  1. EventBridge Scheduler invokes basics-cron-kicker with the Input
  2. kicker mints fresh runId, INSERTs agent_runs, substitutes {VAR}
     in goal from vars{}, sends to SQS basics-runs.fifo
  3. → identical to one-shot from step 4
```

### 3.3 Cookie attach (Browserbase Context)

```
Once at workspace setup:
  desktop extension reads cookies from logged-in browser →
  POST /v1/runtime/contexts/sync to api → api creates Browserbase
  Context (or updates) → UPDATE workspaces.browserbase_profile_id

Each run:
  worker reads workspaces.browserbase_profile_id →
  Browserbase POST /v1/sessions { browserSettings.context.id, persist:true } →
  CDP attach → cookies are already loaded in the cloud Chrome
```

### 3.4 File persistence (EFS)

```
worker plugin sets ctx.workspaceRoot = /workspace/<workspaceId>
agent calls write_file("notes.md", "...") → fs-policy resolves to
  /workspace/<wsId>/notes.md (rejects /etc/... or ../../..) →
  fs.writeFile (real EFS write through the access point)

next run for the same workspace mounts the same EFS, sees the same file.
```

### 3.5 Skill learning + reuse

```
discovery run:
  agent takes screenshots, finds selectors, writes a skill_write
    tool call → plugin validateSkillWrite (PII/path/secrets) →
    INSERT public.skills { name, body, host, pending_review=true }

operator approves:
  api POST /v1/skills/:id/approve → UPDATE pending_review=false

next run for the same workspace:
  worker plugin loadAll(workspaceId) → composeSkillContext →
  experimental.chat.system.transform hook prepends the <skills>
  fragment to the LLM's system prompt → agent reads the skill +
  uses the stored selectors, skips screenshots
```

---

## 4. Postgres tables — quick map

Schema: `public`. Project `xihupmgkamnfbzacksja` (Supabase `Basics`).

| Table | Owner | Phase | Purpose |
|---|---|---|---|
| `workspaces` | api | (existing) | Workspace identity. `browserbase_profile_id` carries the Context id. `agent_settings` jsonb holds `runtime`, `dailyCostCeilingCents`, `allowPII`. |
| `cloud_agents` | api | A.5 | Agent definitions. `schedule` (cron), `eventbridge_schedule_arn`, `runtime_mode`. |
| `agent_runs` | api inserts; worker UPDATEs | A.5 | Run row. Status lifecycle pending→running→completed/error. `browserbase_session_id`, `live_view_url`, `duration_seconds`, `completed_at`. |
| `agent_activity` | worker | A.5 | §11.1 events. Realtime publication enabled. |
| `agent_run_steps` | worker | A.5 | Per-step audit (used less now that `agent_activity` carries the granular events). |
| `pending_approvals` | both | (existing) | Tool-gate approval queue. |
| `skills` | worker INSERTs (`pending_review=true`); api UPDATEs review state | D.x | Learned skills with `body`, `host`, `confidence`. Loader filters `pending_review=false AND active=true AND superseded_by IS NULL`. |
| `agent_helpers` | worker | D.x | Per-workspace TS helper modules — file metadata, body lives on EFS. |
| `usage_tracking` | worker | C.x | Per-day cost rollups. `(workspace_id, account_id, date)` PK. |
| `opencode_pools` | worker writes, dispatcher reads | H.3 | **Internal**. Pool registry — pool_id, task_arn, host, port, slots_used, slots_max, status. |
| `opencode_session_bindings` | worker writes; plugin reads | H.2 | **Internal**. opencode session_id → workspace/run/account binding. |
| `workspace_active_tasks` | (legacy, G.5; superseded by `opencode_pools`) | — | Slated for drop. |

---

## 5. Cost model

**At rest (no traffic):**

| Item | Monthly |
|---|---|
| ECS cluster (no tasks) | $0 |
| ECR repo storage (~250 MB image) | <$0.025 |
| SQS queue (no messages) | $0 |
| Lambda functions (no invocations) | $0 |
| EFS file system (a few KB initial) | <$0.10 |
| EFS mount targets | $0 (charged per GB-mo on the FS, not per MT) |
| ALB (api) | included in api stack |
| **Total idle** | **<$0.15/mo for the worker stack** |

**Per cron-driven workflow (e.g., the YouTube-stats agent):**

| Item | Per-fire | Per-day @ hourly |
|---|---|---|
| Anthropic Claude Sonnet 4.5 (12k cached system prompt) | ~$0.05 | ~$1.20 |
| Browserbase session (~30s) | ~$0.05 | ~$1.20 |
| Fargate (warm pool, idle stop after 15min) | ~$0.04/hour × 24h | ~$0.96 |
| EventBridge Scheduler invocations (1440/mo @ hourly) | $0 (free tier covers) | $0 |
| SQS + Lambda invocations | <$0.001 | <$0.03 |
| **Total per workflow** | | **~$3.40/day = ~$100/mo** |

Most of the cost is LLM + Browserbase. Infra overhead (Fargate idle,
Lambda, SQS) is ~$1/day even with 24/7 hourly cron.

**Pool sharing** (Phase H): if you run 5 workflows in the same
workspace at hourly cadence, they share one Fargate task (slots_max=5),
so the $30/mo Fargate cost is amortized. Total = ~5 × $70 LLM/BB
+ $30 = ~$380/mo for 5 hourly workflows in one workspace.

---

## 6. Deployment + day-1 ops

### 6.1 First-time setup on a new machine

```bash
# 1. Clone, install
git clone https://github.com/thebasicscompany/main
cd main
pnpm install

# 2. Doppler (secrets manager)
doppler login
doppler setup --project backend --config dev

# 3. AWS — use an IAM user, NOT root. Configure profile:
aws configure --profile basics-prod
# AWS_PROFILE=basics-prod for all subsequent commands

# 4. Sync Pulumi state in case AWS drifted
pnpm sst refresh --stage production
```

### 6.2 Deploying a code change

```bash
# Worker source change (most common): build + push image, then
# pool tasks pick it up on their NEXT launch (existing tasks keep
# running the old image until they idle out).
docker buildx build --platform linux/amd64 \
  -f worker/Dockerfile \
  -t 635649352555.dkr.ecr.us-east-1.amazonaws.com/basics-worker:latest \
  --push .

# IaC change (sst.config.ts, new IAM, new Lambda, new Pulumi resource)
pnpm sst deploy --stage production

# Lambda code change (worker/dispatcher, worker/cron-kicker) →
# also requires sst deploy (Pulumi rebundles)
pnpm sst deploy --stage production

# Just the api Service code → docker push picked up by sst deploy
pnpm sst deploy --stage production
```

### 6.3 What requires a deploy vs not

See `docs/HANDOFF_API_CLOUD_AGENT.md` for the full table. Summary:

- **No deploy**: send a one-shot run, edit a skill, adjust a cron's
  goal text via DB, change `cloud_agents.schedule`.
- **Docker push only**: worker source code (but pool tasks need to
  recycle).
- **`sst deploy`**: any IaC change (new IAM, new Lambda, env on task
  def, etc.).

---

## 7. Common ops cheatsheet

These are commands you'll actually run. Set
`MSYS_NO_PATHCONV=1` on Git Bash (Windows) to avoid path mangling.

### 7.1 Inspect the running pool

```sql
-- which pools are alive
SELECT pool_id, host, port, slots_used, slots_max, status,
       EXTRACT(EPOCH FROM (now() - last_activity_at)) AS hb_age_s
  FROM public.opencode_pools
 ORDER BY started_at DESC;

-- which sessions are bound to which pool
SELECT s.session_id, s.workspace_id, s.run_id, s.pool_id, s.created_at
  FROM public.opencode_session_bindings s
 ORDER BY s.created_at DESC LIMIT 20;
```

```bash
# ECS-side
aws ecs list-tasks --cluster basics-agent --region us-east-1
aws ecs describe-tasks --cluster basics-agent \
  --tasks <task-id> --region us-east-1 \
  --query 'tasks[0].[lastStatus,stoppedReason,containers[*].[name,exitCode]]'
```

### 7.2 Tail worker logs

```bash
TASK=<task-id>
aws logs tail /aws/ecs/basics-worker \
  --log-stream-names "main/basics-worker/$TASK" \
  --follow --region us-east-1
```

### 7.3 Send a one-shot run (manual, no api)

```bash
# 1. INSERT agent_runs via Supabase MCP or psql
# 2. Send SQS message
BODY='{"runId":"<uuid>","workspaceId":"<ws>","accountId":"<acc>",
       "goal":"open https://example.com and call final_answer with the H1"}'
aws sqs send-message \
  --queue-url https://sqs.us-east-1.amazonaws.com/635649352555/basics-runs.fifo \
  --message-body "$BODY" \
  --message-group-id "<ws>:default" \
  --message-deduplication-id "manual-$(date +%s)" \
  --region us-east-1
```

### 7.4 Launch a pool task manually (for testing without cron)

```bash
aws ecs run-task \
  --cluster basics-agent \
  --task-definition basics-worker \
  --capacity-provider-strategy 'capacityProvider=FARGATE,weight=1,base=0' \
  --network-configuration 'awsvpcConfiguration={
    subnets=[subnet-068bf509f00c3ede2,subnet-06d88807c454bff0d],
    securityGroups=[sg-06b8bbc396f213681],
    assignPublicIp=DISABLED}' \
  --overrides '{"containerOverrides":[{"name":"basics-worker",
    "environment":[{"name":"POOL_HOST","value":"true"}]}]}' \
  --region us-east-1
```

### 7.5 Stop a pool task

```bash
# Graceful — task receives SIGTERM, plugin tears down BB sessions,
# heartbeat stops, pool row goes to status=dead
aws ecs stop-task --cluster basics-agent --task <task-id> \
  --reason 'manual-stop' --region us-east-1
```

### 7.6 Create a cron schedule

```bash
# Compose the kicker payload (see docs/HANDOFF_API_CLOUD_AGENT.md §3.1)
INPUT_JSON='<json string of {cloudAgentId,workspaceId,accountId,goal,vars}>'
cat > /tmp/target.json <<EOF
{
  "Arn": "arn:aws:lambda:us-east-1:635649352555:function:basics-cron-kicker",
  "RoleArn": "arn:aws:iam::635649352555:role/basics-scheduler-invoke-production",
  "Input": $INPUT_JSON
}
EOF

aws scheduler create-schedule \
  --name "agent-<cloudAgentId>" \
  --group-name default \
  --schedule-expression 'rate(2 minutes)' \
  --state ENABLED \
  --flexible-time-window 'Mode=OFF' \
  --target file:///tmp/target.json \
  --region us-east-1
```

### 7.7 Inspect agent_activity events for a run

```sql
SELECT activity_type, payload, created_at
  FROM public.agent_activity
 WHERE agent_run_id = '<run-uuid>'
 ORDER BY created_at;
```

Or stream live:

```bash
curl -N https://api.trybasics.ai/v1/runs/<run-uuid>/events
```

### 7.8 Reset stuck pool / binding state

```sql
-- when something's wedged and you want a clean slate (CAREFUL)
DELETE FROM public.opencode_session_bindings;
UPDATE public.opencode_pools SET status='dead' WHERE status='active';
-- then aws ecs stop-task on any straggler tasks
```

### 7.9 Clear an SQS backlog

```bash
aws sqs purge-queue \
  --queue-url https://sqs.us-east-1.amazonaws.com/635649352555/basics-runs.fifo \
  --region us-east-1
# 60-second cooldown before next purge
```

### 7.10 Drop a misbehaving schedule

```bash
aws scheduler delete-schedule \
  --name "agent-<cloudAgentId>" --group-name default \
  --region us-east-1
```

---

## 8. Protected resources + how to override

`sst.config.ts` has `{ protect: true }` on:

- `BasicsWorkspacesEfs` — the EFS file system itself
- `BasicsWorkspacesAccessPoint`
- `BasicsWorkspacesEfsMtA` + `BasicsWorkspacesEfsMtB` (mount targets)
- `BasicsRunsQueue` (SQS)

Pulumi will refuse `delete` and `replace` on these. To intentionally
recreate one (only do this if you know what you're doing — recreating
EFS loses all skill bodies, helpers, and run files):

1. Edit `sst.config.ts` → remove the `{ protect: true }` arg from
   the resource constructor
2. `pnpm sst deploy --stage production` — this records the unprotect
3. Make whatever change requires the recreate
4. `pnpm sst deploy --stage production` again — performs the recreate
5. Re-add `{ protect: true }` and deploy a third time

The protect flag was added 2026-05-09 after a Pulumi op from another
machine (root user, macOS) deleted the EFS + many other resources.
Don't remove it without explicit business justification.

---

## 9. Gotchas + known pitfalls

These are real problems we hit. Read before debugging:

1. **Never use AWS root user for ops.** CloudTrail showed a root
   user from `71.105.74.78` deleted production EFS via Pulumi on
   2026-05-09. Lock down root: enable MFA, move credentials offline,
   never put root keys on a laptop. All ops should go through an IAM
   user with least-privilege policies.
2. **`sst refresh` if state drifts.** If AWS resources exist that
   Pulumi state doesn't know about (or vice versa), run `sst refresh`
   to sync. This happens after manual console changes or after
   deletions from another machine.
3. **Supavisor pooler ports**: `:6543` is transaction-mode (drops
   LISTEN state); `:5432` on the same hostname is session-mode. The
   worker's pool LISTEN connection must use `:5432`. `worker/src/main.ts`
   does this swap automatically (`databaseUrl.replace(/:6543\b/, ":5432")`).
4. **opencode model defaults to amazon-bedrock**, not anthropic.
   Always pass `model: { providerID: "anthropic", modelID: "claude-…" }`
   in `POST /session/:id/prompt_async`. We don't have Bedrock auth
   configured.
5. **Postgres NOTIFY can't be parameterized** — use
   `SELECT pg_notify($1, $2)` (function call), not
   `NOTIFY $1, $2` (statement, fails with syntax error).
6. **ECS DescribeTasks IAM** — the resource ARN format for
   `ecs:DescribeTasks` is `task/<cluster>/<task-id>`, NOT
   `task-definition/...`. Using the wrong shape gets `AccessDeniedException`.
7. **Skills land `pending_review=true`**. Until an operator approves
   them, the loader filters them out — they exist but the LLM never
   sees them. Approve via api `POST /v1/skills/:id/approve` (route
   forthcoming) or `UPDATE public.skills SET pending_review=false`.
8. **PII regex on skill bodies**: phones, emails, SSNs are blocked
   unless `workspaces.agent_settings.allowPII = true`. The phone
   regex requires separators (`-`, `.`, space) so bare 10-digit
   numbers (view counts, IDs) don't false-match.
9. **opencode-serve event volume**: `/event` SSE emits ~13× more
   events than what's useful (token-by-token deltas). The worker
   filters drop `message.part.delta`, `message.part.updated`,
   `message.updated`, `session.status`, `session.updated`, `session.diff`
   before INSERTing into `agent_activity`.
10. **Idle-stop is 15 min** by default (`IDLE_STOP_MS=900000` in the
    task def env). After that, the pool task exits gracefully and
    `opencode_pools.status` flips to `dead`. The next run pays the
    cold-start cost (~30-50s).
11. **EFS data is real and cheap** ($0.30/GB/mo) but EFS reads/writes
    DO incur per-op latency (~5-20ms vs ~0.1ms for ephemeral storage).
    Don't write thousands of tiny files in a tight loop.

---

## 10. For LLM agents picking up this stack

If you're an LLM agent (Claude Code, etc.) starting work on this
codebase, here's the orientation:

### 10.1 Read first

1. `docs/CLOUD-AGENT-PLAN.md` — the spec for the v2 cloud agent
2. This doc (`docs/INFRA.md`) — what's deployed
3. `docs/HANDOFF_API_CLOUD_AGENT.md` — what the api team still owes
4. `docs/RETRO-CLOUD-AGENT-MIGRATION.md` — what surprises hit during
   the migration so you can avoid the same ones
5. `sst.config.ts` — the IaC source of truth

### 10.2 Key file paths

| Concern | Path |
|---|---|
| Worker entry point | `worker/src/main.ts` (pool host + LISTEN loop + SSE consumer) |
| Plugin | `worker/src/opencode-plugin/index.ts` (32 tools, per-session runtime) |
| Tool definitions | `worker/src/tools/*.ts` (32 files, `defineTool` shape) |
| Browserbase | `worker/src/browserbase.ts` |
| Skills | `worker/src/skill-loader.ts`, `skill-store.ts` |
| Skill policy | `worker/src/middleware/skill-write-policy.ts` |
| Dispatcher Lambda | `worker/dispatcher/handler.ts` |
| Cron kicker Lambda | `worker/cron-kicker/handler.ts` |
| api SSE proxy | `api/src/routes/cloud-runs.ts` |
| Drizzle migrations | `api/drizzle/00*.sql` |
| Operator memory (Claude global rules) | `~/.claude/CLAUDE.md` |

### 10.3 Conventions

- **TypeScript strict**, target Node 22, ESM only.
- **Errors thrown, not returned**. Tool errors caught at the plugin
  boundary and converted to `tool_call_end` payloads.
- **All file writes go through `fs-policy.ts`** (`realpathInsideWorkspace`)
  so cross-tenant attempts can't slip through.
- **Tool definitions use Zod 4** for params validation. The OC
  adapter converts to JSON Schema for opencode's tools API.
- **Vitest** for unit tests. Run with `pnpm -F @basics/worker test`.
- **Don't reference `process.cwd()` in tools** — the plugin sets
  `ctx.workspaceRoot` per session; honor that.

### 10.4 Verifying changes (operator's CLAUDE.md rule)

Per the operator's global memory, **every code change ships with a
verify against real infrastructure** — no mocks for verification.
That means:

- Schema change → run a query via Supabase MCP, confirm rows look right
- Worker change → push image, launch a pool, send an SQS message,
  watch the logs
- Lambda change → `sst deploy`, invoke, check CloudWatch logs
- IaC change → `sst diff` first, then deploy

Don't claim work is done until you've seen a live run succeed.

### 10.5 When you're confused

- `git log --oneline | head -20` — recent changes
- `docs/.build-loop/state.json` — per-iteration history of what was
  shipped (if you're continuing a build loop)
- Check `feedback_*.md` files in `~/.claude/projects/.../memory/` for
  operator-set rules (60s wakeup minimums, no `sst secret list`, etc.)
- Ask. Don't guess on destructive ops.

---

*Last updated: 2026-05-09. Update this doc when you change AWS
infrastructure — don't let it drift.*
