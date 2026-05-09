# CLOUD-AGENT-PLAN

> **Status: SHIPPED (2026-05-09).** The v2 cloud-agent runtime described
> here is live in production. Phases A→F of the build loop completed; see
> `docs/BUILD-LOOP.md` history (`docs/.build-loop/state.json`) for the
> per-step iteration log and `docs/RETRO-CLOUD-AGENT-MIGRATION.md` for
> cost/duration actuals + lessons. The v1 `computer_20250124` path in
> `api/src/orchestrator/agentLoop.ts` is dormant (zero traffic; design
> partners on `runtime='v2'`) and slated for removal once the api
> control-plane refactors `POST /v1/runs` to dispatch via SQS to the v2
> worker. The exact route+SQS+IAM contract for that refactor is in
> `docs/HANDOFF_API_CLOUD_AGENT.md`; follow §0.1 ownership boundaries.

Detailed plan for moving the Basics runtime from a per-request, Anthropic-only,
`computer_20250124`-driven agent loop to a per-workspace, multi-provider,
self-improving cloud agent — bux-equivalent capability, multi-tenant safe,
without forcing users to bring a Claude Code session of their own.

This document supersedes the agent-loop sections of `ARCHITECTURE.md` and
extends `ROADMAP.md` phases P03 → P08. Where it conflicts with prior docs,
this one wins; old docs will be reconciled in a follow-up PR.

---

## 0. Scope (locked)

This plan delivers **exactly these twelve work items** — nothing else. Adjacent concerns (approvals, run kickoff API, workflows, BYOK storage, audit log, billing rollups, notification tools, take-over UI, replay UI) are owned by the **other team** working in parallel, not by this plan.

1. ECS Fargate cluster + Task Definition + EFS layout
2. `basics-worker` package (SQS pull, provider routing, budget enforcement)
3. opencode integration (pinned commit, sidecar)
4. Browserbase warm-session lifecycle + `browser-harness-js` sidecar
5. Multi-LLM router (Anthropic + Gemini + OpenAI per-turn)
6. Self-improving skills/helpers (EFS volume, skill-write policy, decay)
7. Multi-agent (lanes, sub-agents, inboxes — within a single workspace)
8. Run events stream (`run_events` table + Supabase Realtime fan-out)
9. Per-run cost lines + daily ceiling enforcement
10. Dispatcher Lambda + `workspace_active_tasks` tracker (Postgres, see §13)
11. SQS FIFO queue
12. EventBridge Scheduler integration (backend only — no schedule CRUD UI/API in this repo)

### 0.1 The other team

There is one other team working in parallel. Their entire scope:

> **Control plane** — auth, accounts, workspaces, members, routine promotion, BYOK storage, metering, S3 artifacts, all CRUD endpoints the desktop and extension speak to. Lives in `runtime/api/`.

That is the **complete** list of what they own. Everything else in this codebase is ours.

The four concrete seams between us:

| Seam | Their side | Our side |
|---|---|---|
| **Run kickoff** | `POST /v1/runtime/runs` writes the `runs` row and publishes the SQS message | Worker consumes SQS and runs |
| **Workflows** | Write `runtime.runtime_workflows` via routine promotion | Worker reads it (read-only) |
| **BYOK keys** | Store + encrypt at rest; expose internal decrypt endpoint to the worker | Worker calls the decrypt endpoint at run start, holds plaintext in memory only |
| **Cost data** | Aggregate `usage_events` into rollups + billing | Worker writes `usage_events` rows directly with `kind ∈ ('llm_tokens', 'browser_minutes', 'compute_seconds')` |

### 0.2 Existing repo concerns the worker integrates with (kept)

These already exist in `api/src/orchestrator/` and stay ours. The worker calls into them; it does not replace them.

- **Approvals** — `approvalsRepo.ts`, `approvalSignal.ts`, `gateToolCall` middleware. Mutating tool calls flow through this on the way to execution. The `requiresApproval` flag on tool defs (§7) drives gating.
- **Audit log** — `auditWriter.ts`. Worker writes `run_steps` and `tool_calls` rows.
- **Take-over** — `takeoverSignal.ts`. Worker pauses on `takeover_requested`, polls until released.
- **Trust ledger** — `trustLedger.ts`, `trustGrantsRepo.ts`. Per-workspace trust state used by the approval middleware.

### 0.3 Out of scope (not built; not promised)

- Cross-workspace messaging / `cross_agent_grants` — multi-agent is **intra-workspace only** (item 7).
- Third-party notification tools (Slack, email, SMS) — not built here.
- A web client of any kind — `web/` is retired; downstream UI is the desktop-app repo's concern.

---

## 1. North-star architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                               EDGE / API                                   │
│                                                                            │
│   Desktop app (separate repo, future)   CLI / extensions / API consumers   │
│        │                            │                                      │
│        └────────────┬───────────────┘                                      │
│                     ▼                                                      │
│            api.trybasics.ai (Lambda + ALB, hono)                           │
│              - auth, billing, run kickoff, status                          │
│              - SSE proxy (subscribes to Supabase Realtime)                 │
│              - approval webhook / Slack inbound                            │
│                     │                                                      │
└─────────────────────┼──────────────────────────────────────────────────────┘
                      │
       ┌──────────────┼──────────────┐
       ▼              ▼              ▼
   SQS FIFO        EventBridge    Postgres (Supabase)
   basics-runs     Scheduler        + Realtime channel `run_events`
       │              │              + workspace_active_tasks table
       │              │              ▲           ▲
       │              │              │           │
       ▼              ▼              │           │ (Lambda SSE proxy
┌──────────────┐                     │             subscribes here)
│  Dispatcher  │                     │
│  Lambda      │  reads SQS → reads Postgres workspace_active_tasks via
│  (via        │   Supavisor pooler → routes to existing task OR
│  Supavisor)  │   aws ecs run-task with overrides + UPSERTs the row
└──────┬───────┘                     │
       │                             │
       ▼                             │
┌─────────────────────────────────────┴─────────────────────────────────────┐
│                       WORKER PLANE (AWS ECS Fargate)                      │
│                                                                           │
│   ECS Cluster `basics-agent-<env>`                                        │
│   Task Definition `basics-worker:N`, fargate-spot eligible                │
│   On-demand tasks: one per active workspace, launched via RunTask         │
│   Max 4h task lifetime; 5-min idle → self-stop; cold-start ~30s           │
│                                                                           │
│   Per task:                                                               │
│   ┌────────────────────────────────────────────────────────────────────┐  │
│   │  /workspace      (EFS access point bound to                        │  │
│   │                   /workspaces/<workspaceId>/ on the shared FS)     │  │
│   │    ├── skills/<host>/*.md            agent-authored playbooks      │  │
│   │    ├── helpers/*.ts                  agent-authored helpers        │  │
│   │    ├── sessions/<runId>.json         resumable session state       │  │
│   │    ├── memory/*.md                   long-term workspace notes     │  │
│   │    └── transcripts/<runId>.jsonl     replayable model+tool log     │  │
│   │                                                                    │  │
│   │  Containers:                                                       │  │
│   │    ├── basics-worker (our shim, :8080)                             │  │
│   │    │       ├── pulls SQS messages routed to this taskArn           │  │
│   │    │       ├── owns provider routing + budgets                     │  │
│   │    │       ├── publishes events → INSERT INTO run_events           │  │
│   │    │       ├── acquires/refreshes Browserbase session for WS       │  │
│   │    │       └── enforces approval middleware                        │  │
│   │    ├── opencode (headless server, :7000) — sidecar container       │  │
│   │    └── browser-harness-js (Bun server, :9876) — sidecar container  │  │
│   └────────────────────────────────────────────────────────────────────┘  │
│                                                                           │
│   IAM task role: scoped to this workspace's S3 prefix, this WS's KMS      │
│   data key, the SQS queue, and the EFS access point.                      │
└───────────────────────────────────────────────────────────────────────────┘
       │                 │                       │
       ▼                 ▼                       ▼
 Anthropic / Gemini / OpenAI   Browserbase (warm CDP)   Postgres run_events
                                                              │ (Realtime)
                                                              ▼
                                              SSE proxy on api.trybasics.ai
                                                              │
                                                              ▼
                                                       Web dashboard
```

The single load-bearing change vs. today: **the agent loop moves from inside an
HTTP request on Lambda to a long-lived, per-workspace ECS Fargate task with an
EFS-backed persistent workspace volume.** Everything else (DB, approvals,
audit, browser provider) stays. Event distribution moves from "intra-Lambda
SSE" to "Postgres-backed Realtime channel" — same Postgres we already use for
all other state, no new infra to provision.

---

## 2. Tech stack — locked decisions

| Layer | Choice | Rationale |
|---|---|---|
| Edge HTTP | **Lambda + ALB + Hono** (existing) | Already in place. Scales to zero. Don't move. |
| Worker compute | **AWS ECS Fargate** (one task per active workspace, launched on demand) | All-AWS. Single estate, single IAM, single observability stack. ~30s cold start; mitigated by wake-on-message and an opt-in always-on tier (§3.3). |
| Worker IAC | **SST v3** (existing `sst.config.ts`) extended with the new resources | One IaC tool, one deploy story. |
| Agent runtime | **opencode** (sst/opencode), pinned commit, embedded as a server | Multi-provider, TS-native, server mode, MCP support, sub-agents, file/bash tools out of the box. |
| Worker shim | **`basics-worker`** (new pnpm package) — TS, Bun runtime | Owns SQS pull, provider routing, budget enforcement, approval middleware, Browserbase warm-session lifecycle. ~1k LOC target. |
| Browser CDP | **`@basics/harness`** (existing) + per-task **browser-harness-js** sidecar for `js()` heavy paths | Keep our typed helpers as the agent's primary tools; browser-harness-js available for raw CDP escape hatches. |
| Browser provider | **Browserbase** with warm-session-per-workspace heartbeat | Already integrated. Add session keeper. Third-party regardless — no AWS-native browser-as-a-service exists. |
| LLM providers | **Anthropic** (Sonnet 4.6 / Haiku 4.5 / Opus 4.7), **Google Gemini** (2.5 Pro / 2.5 Flash), **OpenAI** (GPT-5, GPT-5-mini) | Per-turn routing. See §6. |
| LLM client lib | **Vercel AI SDK** under opencode (already its default), plus our routing layer | Avoids reimplementing per-provider tool-call format quirks. |
| Queue | **SQS** FIFO queue (per-workspace ordering via MessageGroupId) | Existing AWS estate. |
| Scheduler | **EventBridge Scheduler** (one schedule per workflow rule, timezone-aware) | Native cron + TZ. No app-level dispatcher Lambda. |
| Persistent FS | **AWS EFS** (one file system per env; workspace paths under `/workspaces/<workspaceId>/`; mounted to Fargate tasks) | App-enforced isolation; standard POSIX semantics; works across task restarts. |
| Event bus | **Supabase Realtime** via `run_events` table + RLS | Postgres logical replication under the hood — no new infra to provision. SSE proxy on Lambda subscribes via Supabase Realtime client. Replay served from the same table (then archived to S3 on run completion). |
| Task dispatcher | **Lambda** consuming SQS → `ecs:RunTask` with overrides | Lambda checks `workspace_active_tasks` (Postgres) for an existing warm task; routes the message via SQS group key OR launches a new task. |
| Active-task tracker | **Postgres `workspace_active_tasks` table** (workspaceId PK → taskArn, lastActivity, status, expiresAt) | Same DB as everything else — one source of truth, one migration story, one query language. Lambda → Postgres connections via **Supavisor** (Supabase's transaction pooler) so we don't burn connections per invocation. PK point lookup is ~5–20ms — fast enough for the dispatcher path. Stale rows reaped by `pg_cron` every minute. |
| DB | **Postgres (Supabase)** — existing | All app state including the active-task tracker. Drizzle ORM. Lambda connects via Supavisor pooler URL; long-running workers connect direct. |
| Object store | **S3** (existing) for screenshots, transcripts, exports | Per-workspace prefix; KMS-encrypted. |
| Observability | **CloudWatch Logs + Metrics + X-Ray** (single AWS estate) | Container Insights for Fargate; structured JSON logs; X-Ray traces for the dispatcher Lambda → Fargate task path. Honeycomb / Datadog can be layered later if needed. |

---

## 3. Compute plane (AWS ECS Fargate)

### 3.1 Topology

- **One ECS cluster per env:** `basics-agent-stg`, `basics-agent-prd`. Region: `us-east-1` (matches existing SST stack).
- **One Task Definition** `basics-worker:N` (versioned, immutable). Three containers in the task:
  - `basics-worker` (main, port 8080, healthcheck `/healthz`)
  - `opencode` (sidecar, port 7000, internal-only)
  - `browser-harness-js` (sidecar, port 9876, internal-only)
- **One *active* task per workspace** (not per run, not per user).
  - First run for a workspace → Dispatcher Lambda calls `ecs:RunTask` with overrides (`environment` carries `WORKSPACE_ID`, EFS access point bound to `/workspaces/<workspaceId>/`).
  - Subsequent runs route to the same task: Dispatcher Lambda looks up `workspace_active_tasks` (Postgres, via Supavisor pooler) by `workspaceId`, finds the live `taskArn`, sends the message via SQS with `MessageGroupId = workspaceId` so the running task's SQS poller picks it up.
  - Task self-terminates after **5 minutes** of no SQS activity (worker watches its own poll loop and calls `ecs:StopTask` on itself).
  - Hard wall-clock cap: **4 hours**. Beyond that the task self-stops; in-flight run completes via the in-progress turn boundary, then exits cleanly.
- **Per-task concurrency:** configurable, default `MAX_CONCURRENT_RUNS_PER_WORKSPACE = 3`. Hard cap so one workspace's runaway agent can't OOM the task.
- **Task size:** 1 vCPU / 2048 MB / 20 GB ephemeral storage to start. EFS-mounted volume at `/workspace` (no size cost — pay per stored GB-month). Fargate-Spot eligible; on-demand fallback for tasks that fail to launch on Spot in <60s.
- **Networking:** tasks run in private subnets of the existing `RuntimeVpc` (defined in `sst.config.ts`). NAT egress to LLM providers, Browserbase, Supabase, S3 via VPC endpoint, EFS via mount target. No public IP.

### 3.2 Volume layout (per workspace)

EFS access point mounts the workspace's directory (`/workspaces/<workspaceId>/` on the shared file system) at `/workspace` inside the task container. Owned by `agent:agent` (uid/gid 1000), mode 0750. The access point's POSIX user/root-directory enforcement is the first line of isolation; the worker process's path-policy middleware (§9.3) is the second.

```
/workspace
├── .meta/
│   ├── workspace.json         { workspaceId, tz, locale, createdAt, schemaVersion }
│   ├── budget.json            running cost-today, last-reset-at, ceiling
│   └── opencode.config.json   per-workspace opencode config (provider keys, defaults)
├── skills/
│   └── <host>/                e.g. salesforce.com/, looker.com/
│       ├── INDEX.md           one-paragraph "what this folder knows"
│       ├── selectors.md       known stable selectors with last-verified date
│       ├── flows/<flow>.md    durable per-flow playbook
│       └── deprecated/        moved here when verification fails 3x in a row
├── helpers/
│   ├── INDEX.md               table of contents, one-line per helper
│   ├── salesforce.ts          agent-authored TS helper module (importable from tools)
│   └── ...
├── memory/
│   ├── workspace.md           long-term workspace facts (orgs, contacts, prefs)
│   └── people/<id>.md         per-person notes (opt-in)
├── sessions/
│   └── <runId>.json           opencode session state — resume / fork
├── transcripts/
│   └── <runId>.jsonl          full event log for replay + audit
└── tmp/
    └── <runId>/               scratch dir, cleaned at run end
```

**Hard rules** (enforced in `basics-worker`):

- Tools are sandboxed: file writes outside `/workspace` are rejected.
- `skills/` and `helpers/` are subject to the **skill-write policy** (§9).
- Per-workspace soft quota: 5 GB. The worker tracks usage via `du -sb /workspace` on a 60s ticker; a janitor job (§19) prunes old transcripts at 80% full.
- EFS supports point-in-time recovery via AWS Backup. Daily backups, 14-day retention. Workspace restore via a dashboard action that copies the last-known-good snapshot to a fresh access point and atomically swaps.

### 3.3 Wake / sleep / failure semantics

| Event | Behavior |
|---|---|
| First run for workspace (cold) | Dispatcher Lambda calls `RunTask`. Image pull (cached on warm pool) + container start ≈ **15–35s** total. SQS message stays in flight via Visibility Timeout = 6 min, extended in-flight if needed. |
| Subsequent run while warm | Dispatcher routes via SQS group key; in-task worker poll picks up in <500ms. |
| 5 min idle | Worker calls `ecs:StopTask` on self; pre-shutdown hook updates `workspace_active_tasks.status = 'stopping'` and the `pg_cron` reaper deletes the row within a minute. EFS data preserved. |
| Crash | ECS restarts the task per service or relaunches via `RunTask` retry; EFS data preserved; in-flight SQS message returns to queue after Visibility Timeout (6 min) and dispatcher launches a fresh task. |
| EFS corruption (rare) | AWS Backup PITR restore to a new access point; rebind in `workspace_active_tasks`; agent re-reads its own skills/helpers on next run. |
| Region outage | Stretch goal — secondary region (`us-west-2`) cluster + cross-region EFS replication. Out of scope for v1; we accept regional dependency on `us-east-1` to match the existing SST stack. |
| Always-on tier | Workspace flag `always_on: true` → Dispatcher creates a long-lived ECS service (`desiredCount: 1`) for that workspace instead of one-shot tasks. Cold start eliminated; cost ~$15–25/mo per workspace. |

### 3.4 Cost model

Rough per-workspace monthly cost at moderate use (10 runs/day, 5 min average):

| Component | Cost |
|---|---|
| Fargate-Spot compute (1 vCPU, 2 GB, ~25h active/mo incl. cold-start tax) | ~$1.30 |
| EFS storage (avg 0.5 GB used) | ~$0.15 |
| EFS Backup (daily, 14-day retention) | ~$0.10 |
| Dispatcher Lambda invocations (~300/mo) | ~$0.01 |
| Supabase Realtime + Postgres rows including `workspace_active_tasks` (existing plan; no incremental cost) | $0 |
| Browserbase session-minutes (~50h/mo) | ~$15–25 |
| LLM (mixed routing, ~$0.30 / run × 300 runs) | ~$90 |
| **Total** | **~$107 / workspace / mo** |

Idle workspaces: ~$0.15/mo (EFS storage only).

Compared to the prior Fly-based estimate ($108/mo), all-AWS lands at the same total — Fargate-Spot vs Fly Machines is a near-wash for this workload, and we save the Upstash line. Real savings come from a single estate (operations, not bill).

This is the **cost wall** we manage to. Provider routing (§6) and screenshot avoidance (§9) are the two big levers.

---

## 4. Edge plane (what stays on Lambda)

| Endpoint | Stays / moves | Notes |
|---|---|---|
| `POST /v1/runs` (kick off run) | **stays on Lambda** | Validates auth, writes `runs` row, sends SQS message, returns `runId`. |
| `GET /v1/runs/:id` | **stays on Lambda** | DB read. |
| `GET /v1/runs/:id/events` (SSE) | **stays on Lambda** | Subscribes to Supabase Realtime channel for the `run_events` table filtered by `run_id`, proxies events to the client. Lambda HTTP timeout is 15 min — for long runs the client reconnects with `Last-Event-ID`. |
| `POST /v1/approvals/:id/decide` | **stays on Lambda** | Writes decision; pokes worker via Redis pub/sub. |
| Slack interactivity | **stays on Lambda** | Same. |
| Webhooks (Stripe, Browserbase) | **stays on Lambda** | Same. |
| Cron dispatcher | **deleted** | EventBridge fires SQS directly. |
| The actual agent loop | **moves to ECS Fargate task** | This is the core change. |

**Hono route surface** is unchanged from today; only the dispatcher behind `POST /v1/runs` swaps from "spawn agent in-process" to "publish SQS message".

---

## 5. Run dispatch flow (end-to-end)

```
1. Client → POST /v1/runs { workflowId, inputs, idempotencyKey }
2. Lambda validates, inserts `runs` row (status=queued), enqueues:
     SQS basics-runs, MessageGroupId = workspaceId, body = { runId, workspaceId, workflowId, inputs }
3. The Dispatcher Lambda (SQS event source) consumes the message; if `workspace_active_tasks` has a live row for this workspace, the message is routed via SQS group key to the running task's poller; otherwise the dispatcher calls `ecs:RunTask` and the new task's worker long-polls (20s).
4. basics-worker:
   a. Acquires per-workspace lock (Redis, 30s TTL, renewed every 10s).
   b. Ensures Browserbase session is warm (heartbeat or create) → CDP wsUrl ready.
   c. Spawns an opencode session for runId, providing:
        - system prompt (workspace-pinned + run context, see §8)
        - tools (see §7)
        - provider config + routing (see §6)
        - mounted volume context (skills, helpers, memory)
   d. opencode runs the loop. Every event (model thought, tool call, screenshot)
      INSERTed into Postgres `run_events` (Realtime broadcasts to subscribed clients) AND appended to
      /workspace/transcripts/<runId>.jsonl AND inserted into `run_steps` rows.
   e. On approval-gated tool calls → middleware suspends, writes `approvals` row,
      publishes `approval_required` event. Worker awaits Redis pub/sub message
      `approval:<approvalId>` (timeout = 30 min, configurable).
   f. On completion → updates `runs.status`, publishes `run_completed`, ACKs SQS,
      releases lock, snapshots session.json for resume.
5. SSE clients on /v1/runs/:id/events get the live stream.
```

**Idempotency:** SQS dedup window 5 min on `idempotencyKey`. DB unique index on `(workspace_id, idempotency_key)`.

**Timeouts:** Default per-run wall-clock = 30 min, hard cap = 4h. Configurable per workflow.

**Cancellation:** `POST /v1/runs/:id/cancel` writes `runs.status=canceling`; worker checks per-turn; on next turn boundary, drops with `cancelled` status.

---

## 6. LLM provider routing

### 6.1 Models we use (canonical list)

| Provider | Model | Best for | Cost (rough $/1M tokens, in/out) |
|---|---|---|---|
| Anthropic | `claude-opus-4-7` | Hard reasoning, gnarly debugging, planning rare workflows | $15 / $75 |
| Anthropic | `claude-sonnet-4-6` | Default planner, complex tool use | $3 / $15 |
| Anthropic | `claude-haiku-4-5-20251001` | Cheap turns, classification, vision reads | $0.80 / $4 |
| Google | `gemini-2.5-pro` | Long-context summarization, image-heavy turns | ~$1.25 / $10 |
| Google | `gemini-2.5-flash` | Fastest cheap vision, OCR, classification | ~$0.30 / $2.50 |
| OpenAI | `gpt-5` | Structured outputs (strict JSON schema), tricky tool selection | comparable to Sonnet |
| OpenAI | `gpt-5-mini` | Cheap fallback when Anthropic / Gemini rate-limited | comparable to Haiku |

> Pricing in this table is indicative only — `basics-worker` reads live prices from `pricing.json` (refreshed daily by a CI job). The router never trusts hardcoded numbers.

**Provider credentials.** Default platform-wide keys (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, optionally `OPENAI_API_KEY`) are stored in **Doppler** (project `basics`, configs per environment: `dev`, `stg`, `prd`). Doppler is the source of truth; nothing else holds these keys at rest. See §20.4 for the injection mechanism. Per-workspace BYO keys are separate and stored encrypted in DB (§20.3).

### 6.2 Routing policy

`basics-worker` exposes a `selectModel(turnContext) → ModelHandle` that opencode calls before each turn. Inputs:

- `turnKind`: `plan` | `act` | `read` | `summarize` | `classify` | `recover`
- `payloadSize`: input tokens estimate
- `imageCount`: number of images in this turn
- `recentFailures`: provider error stats from the last 60s (rate limits, 5xx)
- `workspaceBudgetUsedPct`: 0.0–1.0
- `workspaceOverrides`: { preferredProvider?, forbiddenModels? }

Default routing matrix:

| turnKind | imageCount | Default | Failover order |
|---|---|---|---|
| plan | any | `claude-sonnet-4-6` | `gpt-5` → `gemini-2.5-pro` |
| act (tool call decisions) | 0 | `claude-sonnet-4-6` | `gpt-5` → `gemini-2.5-pro` |
| act | ≥1 | `claude-sonnet-4-6` | `gemini-2.5-pro` (cheaper for vision) |
| read (parse a page DOM the model just fetched via `js`) | 0 | `claude-haiku-4-5` | `gemini-2.5-flash` |
| classify (yes/no, label) | 0 | `gemini-2.5-flash` | `claude-haiku-4-5` |
| summarize, ≥50k tokens | 0 | `gemini-2.5-pro` | `claude-sonnet-4-6` |
| recover (after a tool error) | 0 | `claude-sonnet-4-6` | none — recovery uses one provider for stability |

Budget-aware overrides:

- `usedPct > 0.8`: downshift one tier (Sonnet → Haiku, Pro → Flash). Surface a `budget_warning` event.
- `usedPct > 1.0`: hard-stop new turns; existing turn finishes; run completes with `status=budget_exceeded`.

Workspace-level overrides:

- `workspace.preferredProvider = "anthropic" | "google" | "openai"` — pins planner.
- `workspace.forbiddenModels = ["claude-opus-4-7"]` — for compliance / cost lock.
- `workspace.byoApiKeys = { anthropic?, google?, openai? }` — **opt-in** BYO keys for workspaces that want to pay providers directly. **Default is platform keys** sourced from Doppler (§20.4); the vast majority of workspaces never set BYO. Tokens consumed are billed to the user as itemized `run_cost_lines` either way; BYO just changes who the provider invoices.

### 6.3 Failover

On provider error (rate limit, 5xx, timeout), `selectModel` rotates to the next entry in the failover list within the same `turnKind`. Up to 2 rotations per turn; if all fail, the run errors out with `provider_unavailable`. We do NOT silently downgrade quality without an event.

### 6.4 Caching

- Anthropic: prompt caching enabled on system prompt + tool definitions + skill files. 5-min TTL. Cache breakpoints inserted at the SKILL.md boundary and at each `<skill>` mount.
- Gemini: implicit cache via `cachedContents`; we mint one per workspace, refreshed nightly.
- OpenAI: GPT-5 prompt caching auto-applied; we order static blocks first.

---

## 7. Tool surface

We expose a fixed tool set to the model. Tools are uniformly typed, validated with Zod, and each declares:

- `name`
- `description` (model-facing)
- `params` (Zod)
- `mutating` (does it change external state?)
- `requiresApproval` (route through the existing `gateToolCall` middleware in `api/src/orchestrator/approvalSignal.ts`)
- `cost` (rough latency / cost class — used by the router to discourage expensive tools when cheaper ones suffice)

### 7.1 Browser tools (wrap `@basics/harness`)

| Tool | mutating | requiresApproval | Notes |
|---|---|---|---|
| `screenshot` | no | no | Returns base64 PNG. Token-expensive — model is prompted to skip when it has DOM. |
| `goto_url` | yes | yes (configurable per workflow) | Navigates active tab. |
| `new_tab` | yes | no | |
| `click_at_xy` | yes | yes | Coordinates from screenshot. |
| `type_text` | yes | yes | Inserts at current focus. |
| `fill_input` | yes | yes | Selector-based, framework-aware. |
| `press_key` | yes | yes | |
| `scroll` | yes | no | Read-only effectively. |
| `js` | depends on `{mutating}` arg | yes if `mutating: true` | Schema enforces the discriminator. |
| `wait_for_load` | no | no | |
| `wait_for_element` | no | no | |
| `wait_for_network_idle` | no | no | |
| `http_get` | no | no | Pure fetch, no browser. |
| `extract` | no | no | `{ schema: ZodLike, source: "page" \| "screenshot" \| string }` → typed object. Wraps `js()` + structured-output LLM call. |
| `cdp_raw` | yes | yes | Escape hatch. Always gated. |
| `ensure_real_tab` | no | no | Stale-target recovery. |
| `upload_file` | yes | yes | |
| `dispatch_key` | yes | yes | DOM-level synthetic. |

### 7.2 Filesystem tools (sandboxed to `/workspace`)

| Tool | mutating | requiresApproval | Notes |
|---|---|---|---|
| `read_file` | no | no | Path resolved against `/workspace`. |
| `write_file` | yes | no | Writes only allowed under `skills/`, `helpers/`, `memory/`, `tmp/`. Other paths rejected (skill-write policy, §9). |
| `edit_file` | yes | no | Diff-style edit; same write rules. |
| `glob` | no | no | |
| `grep` | no | no | |
| `delete_file` | yes | no | Soft-delete: moves to `skills/<host>/deprecated/` or `tmp/.trash/`. |

### 7.3 Plan / output tools

| Tool | mutating | requiresApproval | Notes |
|---|---|---|---|
| `update_plan` | no | no | `{ steps: [{ id, label, status: 'pending'|'in_progress'|'done'|'skipped' }] }`. Replaces previous plan (atomic). |
| `set_step_status` | no | no | `{ id, status, note? }`. |
| `report_finding` | no | no | `{ kind: 'evidence' \| 'note' \| 'risk', title, body, attachments? }`. |
| `final_answer` | no | no | Ends the run. `{ summary, links?, attachments? }`. Worker treats this as `end_turn`. |

### 7.4 Multi-agent tools (intra-workspace only)

| Tool | mutating | requiresApproval | Notes |
|---|---|---|---|
| `spawn_subagent` | yes | no | Sub-agent inside the same workspace. `{ role, prompt, tools: subset, maxTurns, model? }`. Returns transcript. |
| `send_to_agent` | yes | yes | Queue a message to another lane in **this workspace**. Body lands in the target's inbox. Cross-workspace is out of scope (§0.4). |

### 7.5 Tool registration

Tools live in `worker/src/tools/`. Each tool is a file:

```ts
// worker/src/tools/screenshot.ts
export const screenshot = defineTool({
  name: 'screenshot',
  description: '…',
  params: z.object({ full: z.boolean().optional() }),
  mutating: false,
  cost: 'medium',
  execute: async ({ full }, ctx) => {
    const r = await capture_screenshot(ctx.session, { full })
    await ctx.publish({ type: 'screenshot', runId: ctx.runId, b64: r.base64 })
    return { kind: 'image', b64: r.base64 }
  },
})
```

`defineTool` lives in `shared/tools/define.ts`. opencode adapter wraps it as the OC tool format.

**Out-of-scope tools (deliberately not built here):** `bash`, `schedule_run`, `cancel_schedule`, `send_slack_dm`, `send_email`, `send_sms`. EventBridge schedules are wired as backend infrastructure (item 12) but no tool surfaces them; the other team's runtime exposes scheduling to users.

---

## 8. System prompt and skill-loading protocol

The system prompt is **layered**, not monolithic:

```
[ Layer 1: Worker preamble        — invariant, ~600 tokens, cached ]
[ Layer 2: Workspace memory       — workspace.md, capped at 4k tokens ]
[ Layer 3: Host skill index       — only when run touches a known host ]
[ Layer 4: Loaded host skills     — at most 3 per host, on-demand via tool ]
[ Layer 5: Run context            — workflowId, inputs, current TZ, today's date ]
```

### 8.1 Layer 1: worker preamble (canonical, version-pinned)

Inlined in `basics-worker` as `WORKER_PREAMBLE_V1`. Prompts the agent with the bux/SKILL.md philosophy adapted for multi-tenant:

```
You are an automation agent operating inside one tenant's workspace. You have a
persistent filesystem (`/workspace`) that is *only* this tenant's, and a real
Chromium browser via the tool surface below. Default to this loop:

1. Plan: emit `update_plan({steps})` for any task with > 2 actions.
2. Inspect: prefer cheap, deterministic tools (`http_get`, `js({mutating:false})`)
   before screenshots.
3. Act: use coordinate clicks (`click_at_xy`) only when DOM-level interaction
   isn't reliable.
4. Verify: re-read state via `js` or `screenshot` to confirm an action took.
5. Persist: when you discover a non-obvious selector, URL pattern, or workflow
   step — write it to `skills/<host>/`. Future runs will find it.

Screenshots are token-expensive. Skip them when you have a working selector or
extractor.

This workspace's conventions are in `memory/workspace.md`. Read it before
starting a substantive task.

Today is {{today}} ({{tz}}). User's timezone is {{tz}}; render times in {{tz}}.
```

Hash of this layer is logged on every run for replay/debug.

### 8.2 Layer 2: workspace memory

`/workspace/memory/workspace.md` is mounted into the prompt verbatim, capped at 4k tokens. Agent owns this file (writable). Index of `memory/people/*.md` is included (filenames + first line); files themselves are read on-demand.

### 8.3 Layer 3 + 4: host skills

When the agent is about to navigate to a host, an automatic `skill_check(host)` tool fires (model-invisible — happens in middleware) and returns:

- `INDEX.md` body (one paragraph)
- list of `skills/<host>/**` filenames
- the most-recently-verified `selectors.md` and `flows/*.md` headings

If the agent reads any of those files, the bytes are added to the prompt for that turn (and re-cached). We cap at 3 files per host per turn to keep prompts bounded.

### 8.4 Layer 5: run context

Injected per run:

```
Run: {{runId}}
Workflow: {{workflowName}} ({{workflowId}})
Trigger: {{triggerKind}}   // user|cron|webhook|sub-agent
Started: {{isoStartedAt}}
Inputs: {{json inputs}}
Approval policy: {{auto|prompt|always}}
Cost budget remaining today: ${{remaining}} of ${{ceiling}}
```

---

## 9. Self-improvement: skill / helper persistence

This is the headline behavior we're chasing — runs get faster over time because the agent writes its own playbooks and helpers.

### 9.1 What the agent is prompted to write

- **`skills/<host>/INDEX.md`** — one paragraph: "what this folder knows about <host>".
- **`skills/<host>/selectors.md`** — table of `{label, selector, last_verified, last_failed}` rows.
- **`skills/<host>/flows/<flow>.md`** — durable per-flow playbook with steps, gotchas, fallbacks.
- **`helpers/<host>.ts`** — TS module exporting reusable functions, importable from `bash` tool runs (`bun run /workspace/helpers/<host>.ts -- ...`) OR callable from `js({ expr })` snippets (functions copied inline). We standardize on **TS only** for helpers; Python is not allowed (cuts complexity, our agent's filesystem doesn't ship Python).

### 9.2 What the agent must NOT write

- Pixel coordinates (break on layout changes — the `skills/` linter rejects PRs containing `\d+,\s*\d+\s*$` on a coordinate-shaped pattern).
- Secrets (rejected by a server-side regex pre-write check: `sk-`, `eyJ`, `whsec_`, etc. — turn fails and run is flagged).
- Cross-tenant info — sandbox makes this physically impossible, but we also lint for `mailto:` and `@`-domain patterns that don't match the workspace's known domains.
- Personal data about end-users without an explicit `memory.allowPII` workspace flag.

### 9.3 Skill-write middleware (server-side enforcement)

Before any `write_file` / `edit_file` lands on disk:

1. **Path policy** — must be under `skills/`, `helpers/`, `memory/`, or `tmp/`.
2. **Size cap** — single file ≤ 64 KB, total `skills/` ≤ 5 MB per workspace.
3. **Content scanners**:
   - secret regex (block + alert)
   - pixel-coordinate regex (block + suggest "use a selector instead")
   - PII heuristic (block unless `allowPII` flag)
   - "no executable shell" — `helpers/*.ts` is parsed; `child_process` / `import('node:fs')` outside of allow-listed APIs blocks the write.
4. **Verification stamp** — agent must include a `Last-verified: YYYY-MM-DD` frontmatter block in any `selectors.md` or `flows/*.md`. Stale (> 30 days unverified) entries are demoted out of the prompt automatically.

### 9.4 Skill decay / pruning

A nightly job per workspace:

- Read each `selectors.md` row's `last_verified` and `last_failed`.
- If `last_failed > last_verified` AND failure count ≥ 3 within 7 days → move row to `deprecated/` and tag the next time the agent visits the host: "this selector deprecated, re-derive."
- If a `flows/*.md` has not been read by any run in 90 days → archive to `tmp/.trash/`.
- Janitor compacts on volume reaching 80%.

### 9.5 Why screenshots get rare over time

The agent is prompted (Layer 1) to skip screenshots when it has a working selector. The first run on a new host screenshots heavily; by the time `skills/<host>/selectors.md` has rows, subsequent runs read the file and call `js`/`extract` instead. We measure this with a per-workspace `screenshot_ratio` metric (screenshots / total turns) and surface a chart in the dashboard.

---

## 10. Multi-agent collaboration

### 10.1 Sub-agents (within one workspace)

Implemented via `spawn_subagent`. Each sub-agent:

- Inherits volume access (`/workspace` is shared — read-only by default for sub-agents; parent must pass `writable: true`).
- Gets its own browser tab (`new_tab` is invoked at spawn).
- Runs with a tool subset (parent picks).
- Has a `maxTurns` cap (default 15).
- Returns a transcript + final answer to the parent.

Use cases:
- Planner spawns Executor (sub-agent with action tools) and Verifier (sub-agent read-only).
- Parallel research: parent spawns N subagents each on a different URL, awaits all, summarizes.

Implementation: opencode supports sub-agents natively (`agent` tool); we wire it through our tool registry so sub-agents see the same tool surface.

### 10.2 Lanes (parallel agents in one workspace)

A workspace can have multiple **lanes** — distinct, persistent agent identities running concurrently, each with its own SQS queue partition (`MessageGroupId = <workspaceId>:<laneId>`).

Use cases:
- Lane "ops" runs the Salesforce playbook every hour.
- Lane "research" responds to Slack ad-hoc.
- Lane "monitor" tails an inbox 24/7.

Lanes share the volume (so they share skills + helpers + memory) but each has its own session UUID and event stream. Inter-lane communication via §10.3.

### 10.3 Inter-agent messaging (intra-workspace only)

Table `agent_inboxes` (see §13). Tool `send_to_agent({ targetLaneId, body })`. Always within the same workspace. Messages are durable; on next wake the target lane reads its inbox, prepends to context.

Cross-workspace messaging and `cross_agent_grants` are **out of scope** for this plan (§0.2).

---

## 11. UI / UX

### 11.1 Event types on the `run_events` table (Realtime channel `run:<runId>`)

```ts
type RunEvent =
  | { type: 'run_started';     at: ISO; trigger: 'user' | 'cron' | 'webhook' | 'subagent' }
  | { type: 'plan_updated';    at: ISO; steps: PlanStep[] }
  | { type: 'step_status';     at: ISO; stepId: string; status: PlanStatus; note?: string }
  | { type: 'model_thinking';  at: ISO; text: string; provider: ProviderId; model: string }
  | { type: 'tool_call_start'; at: ISO; toolCallId: string; tool: string; params: Json }
  | { type: 'tool_call_end';   at: ISO; toolCallId: string; result: Json | { error: string }; latencyMs: number }
  | { type: 'screenshot';      at: ISO; toolCallId: string; s3Key: string; thumbS3Key: string }
  | { type: 'finding';         at: ISO; kind: 'evidence' | 'note' | 'risk'; title: string; body: string }
  | { type: 'approval_required'; at: ISO; approvalId: string; tool: string; params: Json; explanation: string }
  | { type: 'approval_resolved'; at: ISO; approvalId: string; decision: 'approve' | 'reject'; by: 'user' | 'auto' | 'timeout' }
  | { type: 'budget_warning';  at: ISO; usedPct: number; remaining: number }
  | { type: 'agent_message';   at: ISO; from: string; body: string }
  | { type: 'run_completed';   at: ISO; status: 'success' | 'error' | 'cancelled' | 'budget_exceeded'; summary: string; durationMs: number; cost: number }
```

Screenshots are uploaded to S3 (with a 256px thumbnail); only the keys are streamed. The downstream client fetches the image lazily from a presigned URL.

`approval_required` / `approval_resolved` are emitted by our existing approvals path (§0.2 / §18) — they're part of this plan's surface.

### 11.2 Client rendering — out of scope here

The `web/` package is **retired**. A separate desktop app repo will consume this API + SSE surface as a downstream concern; that work is not part of this plan and not part of the build loop's responsibility. What this plan owns is making the **server-side event surface clean and complete** so any client (desktop, CLI, future web rebuild, third-party) can render a faithful timeline with no server changes.

Concretely, the migration's UI obligation reduces to:

- The `run_events` table + Supabase Realtime publication exist (§13).
- Every event type in §11.1 is emitted by the worker with the exact field shape documented.
- The SSE proxy on `api.trybasics.ai/v1/runs/:id/events` is functional and tested via `curl` (no browser required).
- Screenshots upload to S3 with a presigned-URL endpoint the desktop app can fetch lazily.

When the desktop repo comes online, those four guarantees mean it can render `RunTimeline`, `PlanCard`, `ToolCallCard`, `ScreenshotCard`, `ApprovalPrompt`, etc. without backend changes. Markdown rendering, syntax highlighting, lightbox interactions — all client-side concerns we punt to that repo.

### 11.3 "Steps" semantics

The `update_plan` / `set_step_status` tools are first-class. Clients render the latest plan as a checklist with the active step highlighted. Interactive editing of plans by users is out of scope for this plan (the desktop app may add it on top of the existing event surface).

---

## 12. Timezones

### 12.1 Data model

- All timestamps in DB are `timestamptz`.
- `workspaces.timezone` is IANA (`America/Los_Angeles`).
- `users.timezone` overrides workspace if set.
- Schedules carry their own `timezone` (independent of user — "every Monday 9am Pacific" doesn't follow the user to Tokyo).

### 12.2 Display rules

- API returns ISO-8601 UTC. Web converts at render time.
- Web uses `Intl.DateTimeFormat` with the user's TZ (or workspace TZ as fallback).
- Agent prompt always carries today's date in the user's TZ + the IANA string.
- `report_finding` and `final_answer` outputs that mention times are linted: a regex pass adds `(PT)` / `(UTC)` etc. if the agent omitted a TZ label.

### 12.3 Schedule expressions

EventBridge supports `cron(0 9 * * ? *)` plus a per-rule timezone field. We store:

```ts
{
  cron: '0 9 * * MON-FRI *',
  timezone: 'America/Los_Angeles',
  nextFireUtc: …      // computed by us, mirror only
}
```

Validation: `cron-parser` with `tz` option in `basics-worker` and in API on insert.

### 12.4 DST

Non-issue because EventBridge handles DST per IANA. Our `nextFireUtc` is recomputed nightly to reflect DST boundaries.

---

## 13. Database schema (additions / changes)

> **Schema reconciliation (2026-05-08, locked):** the active Supabase project (`Basics`, ref `xihupmgkamnfbzacksja`) already has tables that semantically overlap with what an earlier draft of this plan proposed. Rather than introducing parallel schemas, the build-loop maps the plan onto what exists. Specifically:
>
> | Plan name (earlier draft) | Actual table used | Notes |
> |---|---|---|
> | `runs` | `agent_runs` | Same role; richer columns (browserbase, paused/resume state, prompt_snapshot). |
> | `run_steps` | `agent_run_steps` | Same role. |
> | `approvals` | `pending_approvals` | Same role; richer columns (decision_payload, cancel_window_seconds, expires_at). |
> | `run_events` | `agent_activity` | Same role; column names differ — `activity_type` (vs `type`), `agent_run_id` (vs `run_id`), `created_at` (vs `at`). The worker emits events using the *existing* column names; A.5 just adds `agent_activity` to the `supabase_realtime` publication. |
> | `agent_skills` (EFS-mirror table) | `skills` | The existing `skills` table stores skill **bodies in the database** (`body TEXT`) along with trust signals (`confidence`, `pending_review`, `superseded_by`, `source_run_ids`). The plan's earlier "EFS skills/<host>/INDEX.md + selectors.md + flows/<flow>.md tree mirrored into a metadata table" idea is **dropped**. Skills live in the `skills` table; the worker reads/writes them via DB, not via EFS files. The `/workspace/skills/` subtree in §3.2 is no longer used. |
> | `usage_events` (other team's table) | `usage_tracking` | Daily-aggregate cost rollup already exists; per-run line items (`run_cost_lines`) and running totals (`workspace_cost_ledger`) remain out of scope. |
>
> The four genuinely new tables added in A.5 are: `agent_helpers`, `agent_lanes`, `agent_inboxes`, `workspace_active_tasks`. Plus the `workspaces.agent_settings JSONB` column. Plus enabling `pg_cron` and adding `agent_activity` to the Realtime publication.

Existing tables (`agent_runs`, `agent_run_steps`, `pending_approvals`, `agent_activity`, `skills`, `workspaces`, `workspace_members`, `accounts`, `usage_tracking`, `cloud_agents`, `agent_autonomy`, `autonomy_ledger`, etc.) stay as-is. The additive migration:

```sql
-- (Existing `skills` table already covers what the earlier draft called
--  `agent_skills` — body in DB, with trust signals. No new table.)

-- New: per-workspace helper modules. Helpers are still on EFS at
-- /workspace/helpers/<name>.ts; this is the mirror so the API can list
-- them without booting the worker.
CREATE TABLE agent_helpers (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,                           -- 'salesforce' for helpers/salesforce.ts
  byte_size INT NOT NULL,
  last_modified_at TIMESTAMPTZ NOT NULL,
  last_imported_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('active','quarantined','archived')),
  UNIQUE (workspace_id, name)
);

-- New: lanes for multi-agent.
CREATE TABLE agent_lanes (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,                           -- 'ops', 'research', etc.
  default_workflow_id UUID,
  default_model TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','paused')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- New: inter-agent inbox.
CREATE TABLE agent_inboxes (
  id UUID PRIMARY KEY,
  to_workspace_id UUID NOT NULL REFERENCES workspaces(id),
  to_lane_id UUID REFERENCES agent_lanes(id),
  from_workspace_id UUID NOT NULL REFERENCES workspaces(id),
  from_lane_id UUID REFERENCES agent_lanes(id),
  body JSONB NOT NULL,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON agent_inboxes (to_workspace_id, to_lane_id, read_at);

-- (cross_agent_grants — out of scope, §0.2.)
-- (schedules table — out of scope; schedule CRUD is the other team's concern.
--  EventBridge schedules are wired as backend infrastructure (§14) but their
--  rules are owned by the other team's runtime, which calls EventBridge
--  Scheduler directly when promoting a routine.)

-- (workspace_cost_ledger — replaced by writing directly to the other team's
--  `usage_events` table per §0.1. We do not keep a parallel ledger.)

-- (Run event stream — REUSES existing `agent_activity` table, ~80% schema
--  match. The worker emits events with these existing column names:
--    agent_activity.id              UUID (gen_random_uuid; ordering via created_at)
--    agent_activity.agent_run_id    UUID FK → agent_runs(id)
--    agent_activity.workspace_id    UUID FK → workspaces(id)
--    agent_activity.account_id      UUID FK → accounts(id) (already required)
--    agent_activity.activity_type   TEXT  -- 'run_started','plan_updated',…
--    agent_activity.payload         JSONB
--    agent_activity.created_at      TIMESTAMPTZ
--    agent_activity.read_at         TIMESTAMPTZ (already present, used by inbox)
--    agent_activity.call_hash       TEXT (already present, used by dedup)
--  RLS is already enabled. A.5 adds the table to the supabase_realtime
--  publication so INSERTs broadcast to SSE proxy.)
ALTER PUBLICATION supabase_realtime ADD TABLE agent_activity;
-- Existing RLS policies stay in place; service-role INSERTs from the worker
-- bypass RLS. After run completes, archiver job (Phase D) moves rows older
-- than 24h to S3 + deletes; replay reads from S3, live reads from this table
-- via Realtime.

-- New: active-task tracker. Dispatcher Lambda reads/writes this on every
-- SQS message to decide whether a Fargate task is already running for the
-- workspace (route via SQS group key) or to launch a new one.
CREATE TABLE workspace_active_tasks (
  workspace_id UUID PRIMARY KEY REFERENCES workspaces(id),
  task_arn TEXT NOT NULL,
  cluster TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,                 -- start + 4h hard cap
  status TEXT NOT NULL CHECK (status IN ('starting','active','stopping','dead'))
);
CREATE INDEX ON workspace_active_tasks (last_activity_at);
CREATE INDEX ON workspace_active_tasks (expires_at);

-- pg_cron job (defined in the same migration) reaps stale rows every minute:
--   DELETE FROM workspace_active_tasks
--    WHERE (status = 'starting' AND last_activity_at < now() - interval '5 min')
--       OR (status = 'active'   AND last_activity_at < now() - interval '10 min')
--       OR (status = 'stopping' AND last_activity_at < now() - interval '2 min')
--       OR  expires_at < now();
-- The 10-min "active" threshold is intentionally 2× the worker's 5-min idle
-- self-stop window so a momentary heartbeat lapse doesn't cause a duplicate
-- RunTask. Workers update last_activity_at on every SQS poll.

-- (run_cost_lines — replaced by writing directly to the other team's
--  `usage_events` table with kind ∈ ('llm_tokens','browser_minutes','compute_seconds').
--  See §0.1 seam: one ledger, not two.)

-- Workspace settings extensions (use JSONB so we don't churn migrations).
-- This is OUR slice of workspace config; non-overlapping with the other team's columns.
ALTER TABLE workspaces
  ADD COLUMN agent_settings JSONB NOT NULL DEFAULT '{}';
-- agent_settings shape (only fields this plan reads/writes):
-- {
--   timezone: 'America/Los_Angeles',
--   preferredProvider?: 'anthropic'|'google'|'openai',
--   forbiddenModels?: ['claude-opus-4-7'],
--   dailyCostCeilingCents: 5000,
--   approvalPolicy: 'auto'|'prompt'|'always',
--   features: { allowPII }
-- }
-- BYOK keys are NOT in agent_settings — the other team owns key storage (§0.1).
-- The worker requests decrypted BYO keys from their endpoint at run start.
```

Migrations live in `api/drizzle/` numbered sequentially after the latest existing.

### 13.1 Postgres extension: `pg_cron`

`pg_cron` is enabled in the Supabase project (one-time `CREATE EXTENSION pg_cron;` migration). It owns the once-a-minute reaper for `workspace_active_tasks` (above) plus the nightly skill-decay and volume-janitor jobs (§19). All cron statements live in the same Drizzle migration as the table they touch — no out-of-band scheduler config to drift.

### 13.2 Lambda → Postgres connection strategy

Lambdas (the API edge, dispatcher, SSE proxy, cron) connect via **Supavisor** — Supabase's transaction-mode pgBouncer-compatible pooler. URL pattern: `postgresql://postgres.<ref>:<password>@aws-0-us-east-1.pooler.supabase.com:6543/postgres`. Stored in Doppler as `DATABASE_URL_POOLER`.

Why this matters: a cold-start Lambda creating a fresh Postgres connection per invocation would exhaust the database's connection limit at modest QPS. Supavisor multiplexes thousands of Lambda invocations onto a small backend-connection pool transparently. Long-running processes (the worker tasks) connect direct (`DATABASE_URL`) since they hold connections for minutes anyway.

There is no DynamoDB anywhere in the architecture.

---

## 14. Cron / 24-hour running

### 14.1 Patterns supported

| Pattern | Use case | Implementation |
|---|---|---|
| **Cron-triggered run** | "Every Monday 9am, run the weekly Salesforce report." | Control plane creates an EventBridge schedule → fires SQS message → dispatcher Lambda routes/launches ECS task → run executes → task self-stops on idle. |
| **Wake-on-message** | "Whenever Slack pings @bot, respond." | Slack Lambda → SQS message → same path as cron. Same Machine warm-cache benefit. |
| **Polling-as-cron** | "Watch this inbox every 5 minutes." | Schedule row at `*/5 * * * *` → fires a workflow that reads inbox + acts if changed. Cheaper than always-on. |
| **Always-on lane** | "Stay reachable for ad-hoc, sub-second TTFB." | Lane configured `always_on: true`; Machine has `auto_stop = "off"` and `min_machines_running = 1` for that workspace's app group. Costs ~$10–25/mo. |
| **Long single run** | "Crawl this site for 3 hours." | Single SQS message → Machine stays alive while run runs (per-run wall-clock cap is 4h). Heartbeats prevent SQS redelivery. |

### 14.2 24/7 reachability — yes, possible

Default model: **wake-on-message** with cold-start on the order of 1.5–3s. Looks 24/7 from the user's perspective; costs only when active.

If sub-second TTFB is required (e.g., live chat), workspace opts into **always-on** mode at $X/mo extra. Implementation: `min_machines_running = 1` for that workspace's process group.

### 14.3 Long-running session safety

For runs exceeding 30 min:

- Heartbeats every 30s extend SQS visibility.
- Browserbase session is auto-renewed every 4 hours (Browserbase has a 4h cap; we transparently rotate).
- If the run exceeds the workspace daily cost ceiling mid-flight, the **next turn** errors with `budget_exceeded` and the run completes gracefully (current turn is allowed to finish).

### 14.4 Schedule CRUD — control plane (theirs)

Schedule creation, edit, pause/resume, list, "test now" all live in the other team's control plane (`runtime/api/`) since they're CRUD endpoints the desktop/extension speak to. Per §0.3, we don't build those endpoints. What we own:

- The EventBridge Scheduler **integration** itself (item 12): when their control plane creates/updates/deletes a schedule, it calls `aws scheduler {create,update,delete}-schedule` directly, targeting our SQS queue. This requires only that we publish a stable target ARN + IAM role for them to attach.
- The execution side: when an EventBridge rule fires, the message lands in SQS, our dispatcher Lambda picks it up, and the run flows like any other.

---

## 15. Ownership boundary — what's on our side, what's on theirs

The other team's **control plane** lives in `runtime/api/`. It owns: auth, accounts, workspaces, members, routine promotion, BYOK storage, metering, S3 artifact CRUD, and every HTTP endpoint the desktop/extension speak to. We don't build those.

Our side owns the **execution / data plane**: the agent runtime, browser orchestration, event stream, dispatcher, multi-agent, and the in-repo HTTP that's already there for execution-plane reasons.

| Concern | Owner | Notes |
|---|---|---|
| `POST /v1/runtime/runs` (kickoff) | Control plane | They write the `runs` row + send the SQS message. Our worker consumes. |
| `GET /v1/runtime/runs/:id` (read) | Control plane | DB read; CRUD for the desktop. |
| `GET /v1/runtime/runs/:id/events` (SSE) | Control plane | Subscribes to Supabase Realtime on the `run_events` table we populate. |
| `POST /v1/runtime/approvals/:id/decide` | Control plane | CRUD endpoint the desktop's approval prompt POSTs to. |
| Workflow CRUD / routine promotion | Control plane | They write `runtime.runtime_workflows`. We read it. |
| Schedule CRUD | Control plane | They write to AWS Scheduler directly (against our SQS target). |
| BYOK storage + decryption endpoint | Control plane | We call their internal endpoint at run start to fetch decrypted BYO keys. |
| Metering / `usage_events` aggregation | Control plane | We write rows to `usage_events`; they aggregate to `usage_rollups` / billing. |
| S3 artifact CRUD (uploads + presigned URLs) | Control plane | We upload via the task IAM role; presigned URL minting for the desktop is on their side. |
| Stripe / billing webhooks | Control plane | Not our concern. |
| **Dispatcher Lambda** (SQS → ECS RunTask) | **Us** | Internal; no HTTP. |
| **Worker** (`basics-worker` package) | **Us** | The agent loop. |
| **Run events table writes** (`run_events` INSERTs) | **Us** | The worker populates; their SSE proxy reads. |
| **`workspace_active_tasks` reads/writes** | **Us** | Dispatcher + worker only. |
| **Approvals path inside the worker** (`gateToolCall`, polling for resolution) | **Us** | Existing code in `api/src/orchestrator/approvalsRepo.ts` etc. The `approvals` table is in shared Postgres — we write pending rows; their decide endpoint resolves them. |
| **Audit log writers** (`run_steps`, `tool_calls`, `auditWriter`) | **Us** | Worker writes per step; their control plane reads for the audit UI. |
| **Take-over signal** (`takeoverSignal`) | **Us** | Worker pauses on signal; the desktop's "take over" button (control plane endpoint) sets the signal. |
| **Trust ledger writes from the worker** | **Us** | Existing code; worker reads policy + writes ledger entries on grants/revocations triggered by tool calls. |
| **EventBridge Scheduler IAM role + SQS target** | **Us** | Provisioned via `sst.config.ts`. They call `aws scheduler create-schedule` against our queue ARN. |
| **The agent loop** (today: `api/src/orchestrator/agentLoop.ts` & `computerUseDispatcher.ts`) | **Us → moves to ECS Fargate** | Replaced by the new `worker/` package; legacy code deleted in Phase F. |
- Browserbase session lifecycle (acquire, heartbeat, release).
- Skill / helper file IO.
- Sub-agent spawning.

What gets deleted:

- `computer_20250124` reliance — replaced by the explicit tool surface (§7). Keep the file (`agentLoop.ts`) for ~one release as a fallback path behind a feature flag, then remove.
- The cron-dispatcher Lambda (replaced by EventBridge → SQS direct).

---

## 16. Worker process anatomy (`basics-worker`)

New package at `worker/` (sibling of `api/` and `harness/`).

### 16.1 Entry point

```ts
// worker/src/main.ts
async function main() {
  await bootTask()                 // mount /workspace (EFS), load secrets via task IAM role + Doppler, write opencode config
  await ensureSidecars()           // sidecars are separate containers in the task; just verify health
  await registerWithDynamo()       // upsert workspace_active_tasks { workspaceId, taskArn, startedAt, lastActivity }
  await connectSupabaseRealtime()  // publish auth: service-role JWT for INSERTs into run_events
  await registerHealthcheck()      // /healthz on :8080 for ECS container check
  startIdleWatchdog()              // every 30s: if (now - lastActivity) > 5min, ecs.StopTask(self)
  await loop()
}

async function loop() {
  while (!shuttingDown) {
    const msg = await sqs.receiveMessage({ WaitTimeSeconds: 20 })
    if (!msg) continue
    lastActivity = Date.now()
    extendVisibility(msg)          // heartbeat every 30s while in flight
    const job = parseRunJob(msg)
    runJob(job).catch(reportFatal)
  }
}
```

Secrets injection: the task IAM role grants read on the workspace's KMS data key (BYO) and on the env's Doppler-synced Secrets Manager secret (`basics/<env>/api`). The Doppler-managed values are loaded into env at task boot via `aws secretsmanager get-secret-value`; BYO keys are fetched per-run and never persisted to disk.

### 16.2 `runJob(job)`

```
1. Acquire workspace lock (Postgres advisory lock keyed by hash(workspaceId)).
2. Load workspace settings, decrypt BYO keys (if any) via KMS Decrypt.
3. Resolve / warm Browserbase session (heartbeat or create).
4. Open opencode session: provide system prompt (§8), tool registry (§7),
   provider router (§6), volume mount.
5. Stream loop:
     for each event from opencode:
       INSERT INTO run_events (run_id, workspace_id, type, payload, at)
         (Supabase Realtime broadcasts to subscribers automatically)
       persist (run_steps, tool_calls, run_cost_lines)
       enforce middleware (approval, skill-write policy, budget)
6. On end: snapshot session.json, upload transcript to S3, ACK SQS,
   release advisory lock, update workspace_active_tasks.last_activity_at.
```

### 16.3 Sidecars — task-level process model

ECS Fargate runs each container in the task definition as a separate process tree; ECS handles supervision. Three containers:

- `basics-worker` — main, port 8080. Healthcheck `curl -f http://localhost:8080/healthz`. Essential = true; if it dies, the task dies and the dispatcher will relaunch.
- `opencode` — sidecar, port 7000 (internal). Healthcheck `curl -f http://localhost:7000/healthz`. Essential = true.
- `browser-harness-js` — sidecar, port 9876 (internal). Healthcheck `curl -f http://localhost:9876/health`. Essential = true.

All three share the EFS mount at `/workspace` and the same task IAM role. Inter-container communication uses the loopback network (Fargate awsvpc mode networks all containers on `127.0.0.1`).

ECS replaces the task on container failure via the dispatcher's retry path; we do not need an in-task supervisor.

### 16.4 Memory profile

- Typical idle: ~250 MB across all three containers (Bun + opencode warm).
- Per-run peak: +200–400 MB (model context, image buffers).
- 2048 MB task handles up to 3 concurrent runs comfortably; promote to 4096 MB for workspaces hitting OOM.

---

## 17. Browser layer

### 17.1 Default: Browserbase with warm sessions

Today, every run creates a fresh Browserbase session. We add a **warm-session keeper**:

- One Browserbase session per active workspace.
- Heartbeat every 60s (a no-op CDP call) to keep alive.
- TTL: 4h (Browserbase's max). On TTL approach, rotate: open new session, attach context, swap atomically; close old after 60s grace.
- Cookies / localStorage persist via Browserbase **Contexts** (existing).
- New tab per run; tabs cleaned on run end. Context survives.

### 17.2 Fallback: Browser Use Cloud

If a workspace explicitly opts in (`agent_settings.browserProvider = 'browser-use'`):

- `browser_keeper`-style rotation (mirrors bux's `browser_keeper.py` behavior).
- BU profile bound to workspace.
- Pricier but profile state is more durable.

### 17.3 Self-hosted Chromium (rejected for v1)

Out of scope. Re-evaluate when monthly Browserbase spend > $5k/mo.

### 17.4 Live view

For the user-takeover flow, Browserbase live URL is fetched on-demand and streamed via the existing `live_view` event type. No change from today.

---

## 18. Approvals

### 18.1 Flow

1. Tool call hits `requiresApproval: true`.
2. Worker writes `approvals` row, publishes `approval_required` event, awaits Redis pub/sub `approval:<id>` with timeout (default 30 min, max 24h).
3. User receives:
   - In-product banner via SSE.
   - Slack DM (if connected) with Approve / Reject buttons.
   - Optional Telegram message (if subscribed).
4. First responder wins. Decision posted via `POST /v1/approvals/:id/decide` from any of the surfaces. Lambda writes the decision and publishes `approval:<id>`.
5. Worker resumes; tool runs (or returns rejection-error to model).

### 18.2 Auto-approval rules

`approvalPolicy = 'auto'` (per workspace) skips all gates — used by trusted tenants. `'prompt'` (default) gates mutating tools. `'always'` gates everything including reads — used in highly regulated tenants.

Per-tool overrides in `workflow.config.toolOverrides` for cases like "this workflow auto-approves clicks but always prompts for `send_email`".

### 18.3 Take-over

User can click "take over" from the live-view UI. Sends `takeover_requested` event; worker pauses (doesn't issue tool calls), keeps the session alive, polls for `takeover_released`. Existing `takeoverSignal.ts` machinery is reused.

---

## 19. Background jobs (cron, on this side)

| Job | Cadence | Owner |
|---|---|---|
| Skill decay / pruning | nightly 03:00 UTC | basics-worker (one-shot, woken by EventBridge) |
| Volume janitor (delete > 30d transcripts, > 90d unused skills) | nightly 03:30 UTC | basics-worker |
| Pricing.json refresh | hourly | Lambda |
| Daily cost-ceiling reset | 00:00 in workspace TZ | EventBridge per workspace |
| Browserbase warm-session reaper (kill sessions for workspaces with no runs in 24h) | every 15 min | Lambda |
| Backup EFS via AWS Backup → S3 (cross-region copy) | daily | AWS Backup vault + Lambda for restore drills |
| Workspace activity report | weekly Monday | basics-worker |

---

## 20. Auth + isolation

### 20.1 Per-workspace isolation

- One ECS Fargate task per workspace; EFS access point bound to `/workspaces/<workspaceId>/`, no cross-workspace path traversal.
- Worker process drops privileges to uid 1000 before running tools.
- `bash` sandboxed via `bwrap` to `/workspace`.
- Network egress allow-list (LLM, Browserbase, S3, github.com, npm, pypi, configured webhook destinations).
- Secrets injected as env at Machine boot from AWS Secrets Manager; not on disk.

### 20.2 Tool-call auth

Every tool call carries a `runContext` with `workspaceId`, `userId`, `runId`. Tools that hit external services (Slack, email) re-authenticate using the workspace's stored OAuth tokens — never the user's personal credentials.

### 20.3 BYO API keys

Stored in `workspaces.agent_settings.byoApiKeys`, encrypted at rest with AWS KMS using a workspace-scoped data key. Decrypted in-Machine just-in-time, kept in memory only, never logged. The router prefers BYO keys over platform keys when present.

### 20.4 Platform secrets via Doppler

All platform-default secrets (LLM provider keys, Browserbase, Supabase service role, Stripe, etc.) come from **Doppler**, not from a hand-managed AWS Secrets Manager bucket. Two delivery paths:

1. **Lambda / API edge**: Doppler → AWS Secrets Manager **sync integration** writes to a `basics/<env>/api` secret on every Doppler change. SST reads from Secrets Manager at build time and binds them as Lambda env vars. No code changes when a secret rotates — Doppler push triggers a webhook → Secrets Manager update → Lambda picks up on next cold start (or via `forceVersionUpdate` for hot rotation of critical keys).

2. **ECS Fargate tasks (worker)**: Doppler → AWS Secrets Manager sync writes `basics/<env>/worker`. The Task Definition references the secret ARN under `secrets[]` (ECS injects values as env vars at task start). Rotating a secret in Doppler triggers the sync; the next launched task picks up the new value automatically. For mid-run rotation of long-lived tasks, the worker watches `/proc/self/environ` poll-via-mtime is unreliable on ECS — instead, the worker re-reads the secret via `aws secretsmanager get-secret-value` once per hour using the task IAM role.

Concrete name mapping (Doppler → process env):

| Doppler key | Used by | Env name in process |
|---|---|---|
| `ANTHROPIC_API_KEY` | worker, orchestrator | `ANTHROPIC_API_KEY` |
| `GEMINI_API_KEY` | worker, orchestrator | `GOOGLE_GENERATIVE_AI_API_KEY` (Vercel AI SDK conv.) and `GEMINI_API_KEY` (raw access) |
| `OPENAI_API_KEY` | worker, orchestrator (optional) | `OPENAI_API_KEY` |
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | worker | same |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | api, worker | same |
| `WORKSPACE_JWT_SECRET` | api | same |
| `AWS_REGION`, `AWS_ACCOUNT_ID` | orchestrator | same (orchestrator's IAM role provides creds) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | api | same |
| `SENDBLUE_*`, `DEEPGRAM_API_KEY`, `COMPOSIO_API_KEY` | api | same |

What is **not** in Doppler: per-workspace BYO keys (DB + KMS only), per-run credentials minted just-in-time (e.g., signed Browserbase live URLs). Doppler holds platform secrets; tenant secrets stay tenant-scoped.

**Local dev**: developers run `doppler run --config dev -- pnpm dev`; no `.env` files committed. CI uses a Doppler service token bound to the `dev` config.

---

## 21. Observability

### 21.1 Metrics (per workspace, per run, per tool)

- run_duration_ms
- run_cost_cents (broken down: llm, browser, compute)
- turns_count
- screenshot_ratio (screenshots / total tool calls)
- tool_call_p50/p95/p99 latency
- provider_failover_count
- approval_latency_p50/p95
- skill_hit_count (skills loaded into prompt this run)
- helper_import_count

### 21.2 Tracing

OTel spans:

- `run` (root)
  - `turn` (one per model round-trip)
    - `llm.completion` (provider, model, in/out tokens, cost)
    - `tool.call` (one per tool)
      - `cdp.<method>` (raw CDP)
      - `s3.upload` (screenshots)
- `approval.wait`
- `browserbase.session.acquire`

### 21.3 Logs

Structured JSON, per-line: `{ ts, level, runId, workspaceId, laneId, event, ... }`. CloudWatch Insights queries pre-built for: "show me all approvals waiting > 10 min in last 24h", "top 10 most expensive runs today", etc.

### 21.4 Replay

Every run produces `transcripts/<runId>.jsonl` on the volume; on completion, copied to `s3://basics-runs/<workspaceId>/<runId>.jsonl.gz`. Replay UI reads from S3.

---

## 22. Security checklist

- [ ] Workspace JWT auth on all API endpoints.
- [ ] Tool sandbox: `bash` via `bwrap`, FS writes path-restricted.
- [ ] Secret-scanning pre-write on `write_file` / `edit_file`.
- [ ] Outbound network: Fargate task in private subnets; egress via VPC endpoints (S3, KMS, Secrets Manager) where available, NAT for the rest. Security group egress allow-list pinned to LLM-provider domains, Browserbase, Supabase (incl. Supavisor pooler hostname), github.com, raw.githubusercontent.com, npm, pypi.
- [ ] EFS access points enforce `Path: /workspaces/<workspaceId>/` and `PosixUser: { Uid: 1000, Gid: 1000 }` — the task cannot mount paths outside its own workspace's directory.
- [ ] IAM task role scoped to the workspace's S3 prefix (`s3://basics-runs-<env>/<workspaceId>/*`), the workspace's KMS data key, the SQS queue, and the EFS access point. Postgres access uses workspace-scoped JWT (RLS) — no IAM grant needed.
- [ ] Platform secrets via Doppler only — no `.env` files in repo, no plaintext secrets in CI logs (Doppler service tokens are themselves stored as repo secrets).
- [ ] BYO keys encrypted with workspace-scoped KMS data keys.
- [ ] Audit log immutable (S3 with object lock, retention 1 year).
- [ ] Volume snapshots encrypted at rest.
- [ ] Cross-tenant message blocked at SQS level (FIFO group key = workspaceId).
- [ ] No global skills directory; skill access is workspace-scoped.
- [ ] Approval timeouts default to *reject* on missing decision (fail-safe).
- [ ] Rate limit on `spawn_subagent` (max 4 per turn, max 16 deep).
- [ ] PII heuristic on writes; tenant `allowPII` flag required to bypass.
- [ ] CSP headers on web; SSE responses include `X-Content-Type-Options: nosniff`.
- [ ] Live-view URLs are short-lived (15 min), one-time, signed.

---

## 23. Migration plan from current code

The migration is staged; old and new paths run side-by-side behind feature flags until the new path is proven on design partners.

### Phase A — Foundations (week 1–2)

1. New package `worker/` scaffolded with `bun`, opencode pinned, sidecar layout.
2. ECS cluster `basics-agent-stg`, Task Definition `basics-worker:1` (3 containers — main + opencode + browser-harness-js), Fargate-Spot capacity provider configured, in `sst.config.ts`.
3. EFS file system + access point class created; mount target in the existing `RuntimeVpc` private subnets.
4. SQS FIFO queue `basics-runs-stg.fifo` provisioned; per-workspace `MessageGroupId`.
5. DB migrations for new tables (§13), including `run_events` (with RLS + Realtime publication), `workspace_active_tasks`, and `pg_cron` extension + reaper job.
6. Dispatcher Lambda (consumes SQS, calls `ecs:RunTask` or routes via SQS group key, reads/writes `workspace_active_tasks` via Supavisor) wired in `sst.config.ts`.
8. Tool-definition framework `shared/tools/define.ts`; first 3 tools ported (`screenshot`, `goto_url`, `js`).

**Exit criteria:** an ECS Fargate task boots (3 containers healthy), opencode runs, the 3 tools execute against a Browserbase session, events INSERT into `run_events` and Supabase Realtime broadcasts them; SSE replay verified via `curl`.

### Phase B — Tool surface (week 3)

8. Port the rest of §7 tools.
9. Approval middleware integrated with the new tool framework (mostly reuse `gateToolCall`).
10. Skill-write policy (§9.3) implemented and unit-tested.
11. Plan tools (`update_plan`, `set_step_status`) end-to-end. Verification = events emitted into `run_events` with correct shape; SSE replay via `curl` shows the full sequence. Client rendering is deferred to the desktop-app repo.

**Exit criteria:** a multi-step workflow runs end-to-end on the new path; old `agentLoop.ts` still default for unflagged workspaces.

### Phase C — Provider routing + budgets (week 4)

12. `selectModel` router with full matrix (§6.2).
13. Cost ledger + per-run `run_cost_lines`.
14. Daily ceiling enforcement.
15. BYO key flow.

**Exit criteria:** a single workspace runs entirely on Gemini for a week; cost ledger matches provider invoices to within 1%.

### Phase D — Self-improvement (week 5)

16. Skill / helper file IO + scanners.
17. `agent_skills` mirror table populated by FS watcher.
18. Skill loader middleware (§8.3).
19. Skill decay job.
20. `screenshot_ratio` metric exposed in dashboard.

**Exit criteria:** on a fixed test workflow, the 10th run uses ≥40% fewer screenshots than the 1st run.

### Phase E — Multi-agent + scheduling (week 6)

21. `agent_lanes` + `agent_inboxes`.
22. `spawn_subagent`, `send_to_agent`.
23. EventBridge Scheduler integration.
24. Schedule UI in web.

**Exit criteria:** a workspace has 2 lanes (ops + research) running on schedule, exchanging messages.

### Phase F — Deprecation (week 7–8)

25. Migrate all design-partner workspaces to new path via flag flip.
26. Monitor for 7 days at 100% traffic.
27. Delete `computer_20250124` path, `agentLoop.ts`, `computerUseDispatcher.ts`. Keep `harness/` (tools wrap it now).
28. Post-mortem + cost review; update ROADMAP.

**Exit criteria:** zero traffic on legacy path for 7 consecutive days.

---

## 24. Open decisions, locked here

These were left ambiguous in prior conversation. Locking them now:

| Decision | Choice | Why |
|---|---|---|
| Roll our own loop vs. use a framework | **Adopt opencode** | Already TS, multi-provider, MCP, sub-agents, server mode. Fork only if upstream blocks us. |
| Compute platform | **AWS ECS Fargate (Spot eligible) + EFS** | Single AWS estate; no multi-cloud seam. ~30s cold start accepted (mitigated by warm-pool for opt-in always-on workspaces). Reverses earlier Fly recommendation per operator preference for all-AWS consistency. |
| Per-task granularity | **One ECS task per workspace** | Cleanest isolation, simplest mental model. Concurrency within is bounded. Task lifecycle: Dispatcher Lambda calls `RunTask` on cold start; worker self-stops on 5 min idle. |
| Event distribution | **Supabase Realtime via `run_events` table** | Postgres logical replication; no new infra; native RLS; SSE proxy on Lambda subscribes through Supabase Realtime client. Replaces Redis Streams from the earlier draft. |
| Active-task tracking | **Postgres `workspace_active_tasks` table** | Same DB as everything else; no fourth state store. Lambda → Postgres via Supavisor pooler (no connection storms); `pg_cron` reaps stale rows. ~5–20ms PK lookup is fast enough for the dispatcher path. Reverses an earlier draft that used DynamoDB. |
| Browser provider | **Browserbase + warm sessions** | Already integrated; warm sessions get most of the bux benefit without a provider switch. |
| Helper language | **TypeScript only** | Already our stack. Python adds an interpreter to ship. Bun runs TS natively. |
| Skill governance model | **Per-workspace, never shared** | `ARCHITECTURE.md:465` is correct. No cross-tenant playbooks. |
| Default approval policy | **Prompt** for mutating tools | Trusted workspaces can opt to `auto`; regulated to `always`. |
| Provider mix | **Anthropic + Google + OpenAI** | Three is enough; more adds router complexity without proportional benefit. |
| Bash execution | **Allowed, sandboxed via bwrap, default-gated** | The agent will need `bun run helpers/foo.ts`; `bash` is the cleanest plumb. |
| Default model | **`claude-sonnet-4-6`** | Best planner-tier price/quality at our cutoff. |
| Cron implementation | **EventBridge Scheduler, one rule per schedule** | Native TZ + DST; no app-level dispatcher. |
| Always-on lanes | **Opt-in, $X/mo extra** | Default is wake-on-message; sub-second TTFB users pay for it. |
| Replay storage | **S3 with 90-day retention** | Cheap; satisfies audit. |
| Cross-workspace messaging | **Off by default; explicit grant only** | Multi-tenant safety. |
| Live-view URL lifetime | **15 min, signed, one-time** | Bux's URL-share UX is fine; we re-issue on demand. |
| Budget enforcement | **Soft warn at 80%, hard stop at 100%** | Predictable, no surprise overages. |
| Identifier scheme | **UUIDv7** | Time-sortable, no central counter. |

---

## 25. Risks and mitigations

| Risk | Mitigation |
|---|---|
| opencode upstream churn breaks our pin | Pin a specific commit; mirror the repo to our org; CI runs against pinned version; bump quarterly. |
| Provider-format drift (e.g. Anthropic changes tool format) | Vercel AI SDK absorbs this; we own a thin adapter layer that gets a regression test per provider. |
| Skill files drift / poison the prompt | Verification stamps + decay job; manual "clear skills for host X" button. |
| `us-east-1` ECS / EFS outage takes down all workers | SQS messages return to queue automatically (visibility timeout). For prolonged outages, declare a stretch goal of `us-west-2` failover with cross-region EFS replication; not built v1. Out-of-region EventBridge schedules continue to fire, queue depth absorbs the lag. |
| BYO key leak | KMS-encrypted at rest; in-process memory only; never logged; rotation reminder at 90d. |
| Runaway agent burns through budget | Budget ceiling enforced per-turn; per-run wall-clock cap; turn-iteration cap. |
| Browserbase 4h session cap mid-run | Auto-rotation with context handoff (already designed). |
| Multi-tenant skill exfiltration | Volume per workspace; no shared FS; secret regex pre-write; PII heuristic. |
| EventBridge schedule misfire on DST | Use IANA TZ field on schedule; test suite covers DST boundary days. |
| Sub-agent infinite recursion | Max depth 16; max breadth 4; max total subagents per run = 64. |
| Approval timeout default-reject confuses users | Surface a clear "rejected by timeout" event; user can retry. |
| Cost-ledger drift vs. provider invoices | Daily reconciliation Lambda; alert if drift > 2%. |

---

## 26. What this plan deliberately does NOT cover (scoped out for v1)

- A native mobile app (web is responsive enough; bux's Telegram UX covers phones).
- An on-premise / self-hosted deployment of the runtime (one-tenant SaaS only for v1).
- Voice input/output (deferred; we have Deepgram in the stack but not wired to the new agent).
- A general MCP server marketplace inside the runtime (bring your own MCP via opencode's existing MCP support; no curated catalog).
- A "no-code workflow builder" — workflows remain code/YAML for v1.
- Outcome-based pricing / billing (existing Stripe model continues).
- Mobile push notifications (rely on Telegram / SMS / email channels).

---

## 27. Single-page reading order for new contributors

1. `ARCHITECTURE.md` — what the runtime is and why.
2. **This doc** — the agent plane (compute, loop, providers, skills, multi-agent).
3. `harness/README.md` — the CDP helper layer the agent uses.
4. `worker/README.md` (to be written in Phase A).
5. `docs/BUILD-LOOP.md` — the `/loop`-driven orchestrator that *executes* the §23 migration plan against real infra (Doppler, AWS CLI, Supabase MCP, SST). Read this when you're about to actually run the migration; not before.

The `web/` package is retired; the future desktop-app repo (separate codebase) will subscribe to the same SSE/Realtime surface this plan ships and render its own UI. That client work is out of scope here.

---

*Last updated: 2026-05-08. Owner: runtime team. Lock-in level: high — material changes require an ADR and a runtime-team PR review.*
