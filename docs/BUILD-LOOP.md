# BUILD-LOOP

Self-paced build orchestrator for the cloud-agent migration laid out in
[CLOUD-AGENT-PLAN.md](./CLOUD-AGENT-PLAN.md).

This is **not** a piece of cloud infrastructure. It is a markdown spec that an
LLM reads each iteration, executes the next step against the real
infrastructure (AWS CLI, Supabase MCP, SST, browser tests), updates state,
and exits. The user fires it with `/loop` in their Claude Code session and it
self-paces through Phase A → Phase F, asking for human approval only on the
high-blast-radius steps it is explicitly required to gate on.

The doc is the program. The state file is the program counter.

---

## 0. How to run it

In a Claude Code session at the repo root:

```
/loop Read docs/BUILD-LOOP.md and docs/.build-loop/state.json. Execute the next step per the per-iteration protocol in §3. Update state. Stop when the phase advances, blocks on approval, or completes the migration.
```

That single line is the whole invocation. `/loop` without an interval lets the model self-pace via `ScheduleWakeup` between iterations.

To pause: kill the loop in the Claude Code UI, or write `"paused": true` into `state.json`.
To resume: re-issue the `/loop` line above.
To restart a phase: edit `state.json` (set `currentPhase`, clear `lastFailure`, reset `attempt` to 1).
To abort: delete `docs/.build-loop/state.json`. Next `/loop` will reinitialize from Phase A step 1.

---

## 1. Operating principles

The loop must follow these rules without exception. Violating any of them ends the iteration with `status: blocked, reason: <rule violation>` and pings the user.

1. **Read state first, write state last.** Every iteration begins by reading `state.json` and ends by writing it. No partial state.
2. **Respect approval gates.** §4 lists the actions that require explicit "yes" from the user in chat before executing. Never assume approval from a previous turn — each gated action gets its own approval.
3. **Real verification only.** Never declare a step passed because "the code looks right" or "the build compiled." Pass = the §6 evidence command for that step ran and produced the expected output. Mocked passes are a bug.
4. **Preflight before verification.** Run the env preflight from `~/.claude/CLAUDE.md` (the user's E2E verification doc) before any verification step that hits real infra. Missing env vars do NOT count against the per-step retry limit.
5. **One step per iteration when steps are non-trivial.** Don't chain four mutating steps in one iteration. The user should be able to interject between steps.
6. **Cheap reads any time.** Pure reads (DB list-tables, AWS describe, file glob) can chain freely within an iteration.
7. **Evidence is mandatory.** Every passed step writes an artifact to `docs/.build-loop/artifacts/<phase>/<step>/`. No artifact, no pass.
8. **Retries are bounded.** Per step: 3 attempts. Per phase: 10 total attempts across all steps. Beyond that → `blocked`, await human.
9. **Budget caps.** Soft warn at $50 of LLM spend on the build itself; hard stop at $150. Tracked in `state.json.budget`.
10. **Never bypass the safety rails in `~/.claude/CLAUDE.md`** — secret printing, hook skipping, force-pushes to main, destructive git operations, etc.

---

## 2. State file: `docs/.build-loop/state.json`

Append-only history, current cursor, retry counters, budget, blockers. Schema:

```json
{
  "schemaVersion": 1,
  "startedAt": "2026-05-08T17:00:00Z",
  "lastIterationAt": "2026-05-08T19:42:13Z",
  "paused": false,
  "currentPhase": "A",
  "currentStep": 3,
  "attempt": 1,
  "phaseAttemptsTotal": 4,
  "budget": {
    "softCapUsd": 50,
    "hardCapUsd": 150,
    "spentUsd": 12.40
  },
  "approvals": {
    "pending": null,
    "granted": [
      { "phase": "A", "step": 2, "action": "sst deploy --stage production (ECS cluster + task def)", "at": "2026-05-08T17:32:00Z", "autoGranted": true }
    ]
  },
  "lastFailure": null,
  "blocked": null,
  "history": [
    {
      "phase": "A",
      "step": 1,
      "attempt": 1,
      "status": "passed",
      "at": "2026-05-08T17:14:02Z",
      "evidence": "docs/.build-loop/artifacts/A/01/build.log",
      "summary": "worker/ scaffold added; pnpm -F @basics/worker build OK"
    }
  ],
  "completed": false
}
```

`history` is append-only — never rewrite past entries. Mistakes get a new entry with `status: 'corrected'` referencing the prior id.

If the state file does not exist when the loop fires, initialize with `currentPhase: "A", currentStep: 1, attempt: 1`, otherwise leave the file untouched on read.

---

## 3. Per-iteration protocol

Run this sequence on every fire of `/loop`:

1. **Read state.** Load `docs/.build-loop/state.json`.
2. **Check `paused`** — if true, exit immediately with a one-line status to the user.
3. **Check `blocked`** — if set, print the blocker and exit. Do NOT auto-resume; the user must clear it.
4. **Check `killSwitch`** in `config.json` — if `paused: true` or `emergencyHalt: true`, exit with a one-line status. Do not proceed.
5. **Check `approvals.pending`** — if set:
   - If the most recent user message in this Claude Code session contains an explicit approval (`approve`, `yes proceed`, `lgtm`, or similar) AND it's referencing this pending action, grant: append to `approvals.granted` with `autoGranted: false`, clear `pending`, proceed to the originally-blocked action.
   - Otherwise re-print the approval request and exit.
6. **Pick the next step** from §6 using `currentPhase` and `currentStep`. If `currentStep` exceeds the phase's step count, advance `currentPhase` and reset `currentStep` to 1.
7. **Discovery pass** — if any value listed in `config.json._discovery` is still null and is needed by this step, run the discovery command, write the resolved value back into `config.json`, and continue.
8. **Preflight** (per `~/.claude/CLAUDE.md` Step 0). Failures here don't count against `attempt`. Exception: missing Doppler secret values surface a one-time chat message asking the operator to set them in Doppler, then exit until next iteration.
9. **Gate decision**:
   - If the step requires a §4.0 catastrophic action: always set `approvals.pending` and exit awaiting chat `yes`. No autonomy override.
   - If the step requires a §4.1 action AND `mode === "autonomous"`: auto-grant — append to `approvals.granted` with `autoGranted: true` and proceed.
   - If the step requires a §4.1 action AND `mode === "supervised"`: set `approvals.pending` and exit awaiting chat `yes`.
   - If the step is §4.2 (ungated): proceed.
10. **Plan-revision check.** If `state.planRevision` is set AND `history[]` contains an entry for this `currentPhase`+`currentStep` with `status: 'superseded'`:
    - Read the on-disk artifacts the prior run created (use the `evidence` path + your knowledge of what files §6 says this step produces).
    - Compare against the current §6 spec for this step.
    - If they already match — append a new `status: 're-verified'` history entry, run the §6 verification anyway (cheap, no harm), advance on pass. Do NOT re-do destructive work that would clobber correct files.
    - If they diverge — edit the on-disk files to match the current spec (treat the divergence as a focused refactor, not a from-scratch rebuild), then run the §6 verification, then append `status: 'passed'` (or `'failed'`) on the new attempt.
    - Once every superseded entry in this phase has been re-verified or fixed, the loop may clear `state.planRevision` (or leave it for forensic value — it's idempotent).
11. **Execute the step.** Capture stdout/stderr to `docs/.build-loop/artifacts/<phase>/<step>/exec.log`.
12. **Adversarial review** (only when `step.kind === 'code'` per §3.5). Spawn the Reviewer subagent. If it returns blockers, address them and re-spawn (max 2 review cycles). Skip entirely for `infra` and `verify-only` steps. See §3.5 for the full contract.
13. **Run verification** for the step (§6 lists the command and expected). Capture to `verify.log`.
14. **On pass**: append history entry with `status: 'passed'` (or `'re-verified'` if step 10 short-circuited), advance `currentStep` (or `currentPhase` if step was the last), reset `attempt` to 1, write state. Exit with a one-line status to the user.
15. **On fail**: append history entry with `status: 'failed'` and the failure summary. Increment `attempt` and `phaseAttemptsTotal`.
    - If `attempt < 3` and `phaseAttemptsTotal < 10`: keep `currentStep`, write state, exit with a one-line plan for the next attempt. Next iteration will retry with the failure context in `lastFailure`.
    - Otherwise: set `blocked = { phase, step, reason, lastFailure }`, write state, ping the user with a clear summary of what was tried and what to do.
16. **Self-pace.** Use `ScheduleWakeup` to fire the next iteration. Delay heuristic:
    - If a build / deploy / wait was kicked off in the background: 270s (cache stays warm).
    - If the next step is cheap (file edits, DB queries): 60s.
    - If awaiting approval or blocked: do not schedule.

The iteration's user-facing output is **one short status line** (≤ 200 chars): "Phase A step 1 passed (worker package builds). Next: provision ECS cluster via sst deploy." Spinner-level, not blog-level.

---

## 3.5 Adversarial reviewer (Opus 4.7) — code steps only

Every step in §6 carries a `kind` classification (`code` | `infra` | `verify-only`). When `kind === 'code'`, the loop spawns an adversarial reviewer subagent **after implementation, before §6 verification**, to catch issues that compile-and-typecheck wouldn't surface.

### 3.5.1 Step classification

| kind | Triggers reviewer? | Examples |
|---|---|---|
| `code` | **yes** | A.1, A.5, A.6, A.7, A.8, B.1–B.5, C.1–C.4, D.1–D.5, E.1–E.5 (server logic), F.3, F.4 |
| `infra` | no | A.2 (sst deploy ECS), A.3 (EFS), A.4 (SQS) — pure resource provisioning whose correctness is fully captured by the §6 `verify` command (`aws describe-*` shape match) |
| `verify-only` | no | A.9 (smoke test), F.1 (flag flips), F.2 (soak observation), F.5 (retro doc only) |

If a step's classification is ambiguous, default to `code` (err toward more review).

### 3.5.2 Reviewer invocation contract

**When**: between protocol step 11 (execute) and step 13 (verification), only on `code` kind.

**How**: spawn via the `Agent` tool with `subagent_type: general-purpose`, `model: opus`. Foreground (synchronous) — the loop blocks on the review.

**Prompt shape** (the loop constructs this):

```
You are an adversarial code reviewer for a single step in an autonomous build.

Step spec (from BUILD-LOOP.md §6):
<verbatim copy of the step's `do` + `verify` + `evidence` blocks>

Diff to review:
<output of `git diff --no-color` since the start of this iteration; if too
large for context, file-by-file with `git diff --no-color -- <file>`>

Relevant existing files (for cross-reference):
<paths the implementer touched, plus any closely-related files in the same
directory the loop deems relevant — capped at ~30 files / ~50k tokens>

Repo conventions (load these before reviewing):
- ARCHITECTURE.md
- docs/CLOUD-AGENT-PLAN.md (§§ relevant to this step)
- ~/.claude/CLAUDE.md (E2E verification rules)

Your job: find what's wrong. Be hostile. Look for:
- Edge cases the implementer didn't handle
- Cross-tenant safety regressions (RLS gaps, IAM over-grants, EFS path leaks)
- Concurrency issues (locking, ordering, race conditions)
- Secret-handling regressions (logging, persistence, env exposure)
- Convention violations (naming, error handling, file layout vs the rest of the repo)
- Schema correctness (FKs, constraints, indexes, migrations applied to wrong stage)
- Adjacent-code regressions (something else now broken because of this change)
- Type-correct but semantically wrong code

Do NOT comment on style preferences, formatting, or things the linter catches.
Do NOT suggest features or refactors beyond fixing what's actually wrong here.

Return JSON only:
{
  "blockers": [{ "file": "...", "lines": "L12-L18", "issue": "...", "fix": "..." }],
  "nits":     [{ "file": "...", "lines": "L42",     "issue": "...", "fix": "..." }],
  "verdict":  "ship" | "fix-blockers" | "rewrite"
}

`blockers` are issues that MUST be addressed before ship.
`nits` are minor — logged but not blocking.
`verdict: rewrite` is reserved for catastrophic design errors (rare).
```

**Loop's handling of the result**:

- `verdict === 'ship'` → proceed to step 13 (verification). Append nits to `state.json.history[].reviewerNits` for forensics; do not address.
- `verdict === 'fix-blockers'` → loop addresses each blocker via Edit/Write, then re-spawns the reviewer with the new diff. **Max 2 review cycles per step.** If still blocking after 2: append `lastFailure: { kind: 'review_blockers_unresolved', blockers: [...] }`, treat as a step failure (protocol step 15), retry counters increment.
- `verdict === 'rewrite'` → treat as a step failure immediately. Set `lastFailure` with the reviewer's reasoning. Next attempt re-plans from scratch.

**Budget**: ~60k input + ~10k output per review × max 3 reviews per step (initial + 2 fix cycles) = 240k tokens worst case. At Opus 4.7 rates that's ~$5 worst case per code step, ~$100 across the full build.

**Logging**: the full review JSON is saved to `docs/.build-loop/artifacts/<phase>/<step>/review-<attempt>.json`. The summary line in `state.json.history` includes `reviewerVerdict` for the final attempt.

**Skip rule**: if the step is `infra` or `verify-only`, the loop skips this entire section. The §6 verification commands for those steps are objective enough (`aws describe-*` returns the expected shape, `pg_stat_activity` shows pooling, etc.) that adversarial review adds no signal.

---

## 4. Approval gates

There are two modes, set by `docs/.build-loop/config.json.mode`:

- **`autonomous`** (default): the loop runs without chat approvals **except** for the catastrophic-operations list in §4.0. Set this when the operator wants the migration to complete without supervision.
- **`supervised`**: every action in §4.1 requires explicit "yes" in chat before the loop executes it. Set this when the operator wants to babysit.

The `killSwitch` in `config.json` (`paused`, `emergencyHalt`) wins over `mode` regardless. The operator can flip either to true at any time and the loop will halt at the next iteration boundary.

### 4.0 — Catastrophic operations (ALWAYS gated, even in autonomous mode)

These actions are irreversible at a scale that no amount of operator pre-approval covers. They always require an explicit, action-specific `yes` in chat at the moment of execution. There are exactly five:

| Action | Why it's never auto-grantable |
|---|---|
| `aws ecs delete-cluster` (any), `aws ecs delete-task-definition` for `basics-worker:*`, `aws efs delete-file-system` | Tears down the agent infra wholesale. EFS deletion is irreversible (no undelete) and takes the workspace volumes with it. |
| `aws s3 rb` (any non-empty bucket), `aws kms schedule-key-deletion` | Loses audit logs / loses key material; KMS keys have a max 30-day recovery window before permanent loss. |
| `sst remove --stage production` | Tears down the prod stack (VPC, ALB, ECS service, secrets links). Recovery is hours of redeploy with risk of downtime cascading to design partners. |
| Any SQL against the **prod Supabase project** that is `DROP DATABASE`, `DROP SCHEMA … CASCADE`, `TRUNCATE` on a non-empty table, or `DELETE` without a `WHERE` clause | Data loss against live workspaces. |
| `git push --force` to `origin/main` | History rewrite on shared mainline; not recoverable for collaborators who already pulled. |

If the loop ever finds itself about to run one of these as part of a step, it MUST set `approvals.pending` in `state.json` with the full command, blast radius, and rollback plan, and exit awaiting an explicit chat `yes`. No `mode === "autonomous"` shortcut for these.

### 4.1 — Operator-gated (only in `supervised` mode; auto-granted in `autonomous`)

These are mutating, real-cost, real-cloud actions. In `autonomous` they auto-grant and the loop logs the grant in `state.json.approvals.granted` for audit. In `supervised` they require a chat `yes` per occurrence.

| Action |
|---|
| `aws` CLI mutating commands against production (resource creation, IAM updates, EventBridge rules, etc.) |
| `sst deploy --stage production` |
| `aws ecr put-image` to a fresh image tag (initial pushes are routine; replacing `:latest` on the prod repo is gated) |
| `doppler secrets set` (rotation / setting new values) |
| Supabase MCP `apply_migration` against the **prod** project (staging migrations are ungated even in supervised mode) |
| `gh pr merge` from a feature branch into main |
| `git push origin main` (direct, non-PR) |
| `aws kms create-key` |
| `aws scheduler create-schedule` against prod |

### 4.2 — Always ungated (free for the loop to run)

File edits in the repo. `pnpm install / test / build / typecheck`. `tsc --noEmit`. `gh pr create` for feature branches. `git commit`. `git push origin <feature-branch>`. `aws ... describe-* | get-* | list-*`. Supabase MCP `list_tables`, `list_migrations`, `list_projects`, `execute_sql` (read-only), `apply_migration` against the **staging** project, `get_logs`, `get_advisors`. `flyctl status`, `flyctl logs`, `flyctl auth whoami`. `sst dev` (local). `doppler secrets` (read), `doppler run`. `redis-cli` reads against staging Redis. `curl` for health checks.

### 4.3 — Approval message format (when a gate fires)

When the loop has to wait on the user (a §4.0 catastrophic action, or any §4.1 in supervised mode), it sets `approvals.pending` and emits a chat message containing:

- **action** — the exact command or migration that will run, copy-pasteable
- **blast radius** — what it touches and what's reversible
- **rollback** — how to undo if it goes wrong
- **why now** — what step needs it

Example: "Approval needed: `aws s3 rb s3://basics-runtime-screenshots --force`. Blast radius: deletes the production screenshots bucket and ~2,400 stored objects (audit logs from prior tests). Rollback: not possible — bucket contents are not versioned. Needed for Phase F.3 (legacy resource cleanup). Reply `yes` to proceed."

### 4.4 — How the loop handles autonomous-grants in audit

Every auto-granted §4.1 action appends an entry to `state.json.approvals.granted` with `{ phase, step, action, blastRadius, at, autoGranted: true }`. Treat this list as the audit log. If something goes wrong, this is what the post-mortem reads.

---

## 5. Tool surface available to the loop

This loop has full Claude Code tools, plus MCP servers configured in this repo:

- **Bash** — for `aws`, `sst`, `docker`, `pnpm`, `git`, `gh`, `curl`, `doppler`, `bun`. Use `dangerouslyDisableSandbox: false` (default) for everything; the user's shell already has the right perms.

  **AWS CLI is already authenticated and configured on this host.** Default region is `us-east-1` (matches `config.json.awsRegion` and `sst.config.ts`). The loop must:
  - Use `aws` CLI directly for any AWS work (creating SQS queues, EventBridge schedules, KMS keys, S3 buckets, IAM roles, etc.) — do **not** ask the operator to run AWS commands themselves.
  - Discover the account ID once via `aws sts get-caller-identity --query Account --output text` on first iteration that needs it, write back to `config.json.awsAccountId`, and reuse thereafter.
  - Prefer SST resources (`sst.config.ts` definitions) over standalone `aws` CLI calls when the resource will outlive this build (managed lifecycle, IAM linking). Use `aws` CLI directly for one-shot operations and verifications.
  - Never run `aws configure` — credentials are already set; touching them would break the host.
- **Read / Write / Edit / Glob / Grep** — for repo edits.
- **Agent (subagent_type: Explore)** — when a verification needs broad codebase grokking ("does anything else depend on `agentLoop.ts`?"). Don't spawn for small lookups.
- **Agent (subagent_type: general-purpose)** — for parallel verification (e.g. "run the ECS describe checks while I run the Supabase MCP checks"). Always with `run_in_background: true` when truly independent.
- **mcp__supabase__\*** — `list_tables`, `execute_sql`, `apply_migration`, `list_migrations`, `get_logs`, `get_advisors`, `list_branches`, `create_branch`, `merge_branch`. Use the **staging** branch for verification by default; only touch prod when an approval gate has been granted for that step.
- **WebFetch / WebSearch** — for upstream doc lookups (AWS docs, opencode docs, Supabase Realtime docs) when stuck.

The loop must NOT spawn parallel mutating bash commands. Reads can parallelize; mutations are serialized.

---

## 6. Phases

Each phase is a numbered step list. Each step has:

- **do** — what to actually run / write
- **verify** — the *real-infrastructure* command(s) that prove it worked
- **evidence** — files to drop into `docs/.build-loop/artifacts/<phase>/<step>/`
- **gates** — which §4 approvals apply

A step is "passed" only when `verify` succeeds AND `evidence` is on disk.

The loop reads only its current phase + step on each iteration; it doesn't have to load all phases at once.

---

### Phase A — Foundations

**Goal**: an ECS Fargate task launches on demand, opencode + browser-harness-js + basics-worker run in the task's three containers, the first 3 tools (`screenshot`, `goto_url`, `js`) execute against a real Browserbase session, events insert into the `run_events` table, web SSE shows them via Supabase Realtime.

> **Stage policy:** all AWS deploys in this build-loop go to `--stage production`. The existing `production` stage currently has no real users (only the api Hono service from prior commits), so the staging→prod cutover dance is collapsed into a single stage. Supabase staging branches and Doppler `stg`/`prd` configs are unrelated and unaffected.

#### A.1 — Scaffold `worker/` package

- **do**: create `worker/` as a pnpm workspace package: `package.json` (name `@basics/worker`, type `module`, `bun` runtime), `tsconfig.json` (extends repo base), `src/main.ts` with the §16.1 entry-point skeleton (placeholder OK), `Dockerfile` (Bun-on-distroless base image). Add to `pnpm-workspace.yaml`.
- **verify**: `pnpm install` succeeds; `pnpm -F @basics/worker build` compiles cleanly; `pnpm -F @basics/worker tsc --noEmit` passes.
- **evidence**: `build.log`, `tsc.log`.
- **gates**: none.

#### A.2 — Provision ECS cluster + Task Definition + Dispatcher Lambda (production)

- **do**: extend `sst.config.ts` with:
  - `aws.ecs.Cluster` named `basics-agent`, Fargate-Spot + Fargate capacity providers (1:3 ratio, Spot preferred).
  - `aws.ecs.TaskDefinition` `basics-worker:1` with three containers (main, opencode sidecar, browser-harness-js sidecar). 1 vCPU / 2048 MB / 20 GB ephemeral. `awslogs` driver to a per-env CloudWatch group.
  - IAM task role with the §22 scoped permissions (S3 prefix, KMS data key, SQS, EFS access point). No DynamoDB grant — `workspace_active_tasks` lives in Postgres (auth via service-role JWT).
  - Dispatcher `aws.Function` `basics-dispatcher` triggered by SQS event source mapping; calls `ecs.runTask` with workspace overrides; reads/writes `workspace_active_tasks` in Postgres via Supavisor pooler (`DATABASE_URL_POOLER`, wired in A.6).
  - ECR repository `basics-worker` for the container image. Build + push the worker image as part of `sst deploy`.
- Run `sst deploy --stage production`.
- **verify**:
  - `aws ecs describe-clusters --clusters basics-agent --region us-east-1` returns `status: ACTIVE`.
  - `aws ecs describe-task-definition --task-definition basics-worker --region us-east-1` returns the 3-container definition with the expected ports and IAM role ARN.
  - `aws lambda get-function --function-name basics-dispatcher --region us-east-1` returns the deployed function with the SQS event source mapping enabled.
  - `aws ecr describe-repositories --repository-names basics-worker` lists the repo and the pushed image tag matches the `taskDefinition.containerDefinitions[0].image` digest.
- **evidence**: `ecs-cluster.json`, `task-definition.json`, `dispatcher-lambda.json`, `ecr-image.json`, `sst-deploy-output.txt`.
- **gates**: `sst deploy --stage production` is auto-granted in autonomous mode (§4.1).

#### A.3 — Create EFS file system + access point class

- **do**: extend `sst.config.ts` with:
  - `aws.efs.FileSystem` named `basics-workspaces`, encryption-at-rest enabled (AWS-managed CMK), throughput mode `bursting`, lifecycle policy `AFTER_30_DAYS → IA`.
  - Mount targets in each private subnet of `RuntimeVpc`.
  - A reusable Pulumi component `WorkspaceAccessPoint(workspaceId)` that creates an `aws.efs.AccessPoint` bound to `/workspaces/<workspaceId>/` with `posixUser: { uid: 1000, gid: 1000 }`. Document but do not pre-create access points — the dispatcher creates them on first run for a workspace.
  - Wire EFS into the Task Definition via `volumes` + `mountPoints`. Access point ID is passed as an override at `RunTask` time.
- Run `sst deploy --stage production`.
- **verify**:
  - `aws efs describe-file-systems --region us-east-1 --query 'FileSystems[?Name==\`basics-workspaces\`]'` returns one file system with `LifeCycleState: available` and mount targets in 2 AZs.
  - `aws efs describe-mount-targets --file-system-id <fs-id>` confirms the mount targets are `available`.
  - The dispatcher's first-run code path can call `aws efs create-access-point` for a fixture `workspaceId = 139e7cdc-7060-49c8-a04f-2afffddbd708` (the existing test workspace from `staging-smoke.mjs`); access point reports `LifeCycleState: available`.
- **evidence**: `efs-fs.json`, `efs-mount-targets.json`, `efs-fixture-access-point.json`.
- **gates**: `sst deploy --stage production` auto-granted; `aws efs create-access-point` (ad-hoc, ungated as a §4.2 read/probe sibling — it's small and reversible via `delete-access-point`).

#### A.4 — Provision SQS FIFO queue (production)

- **do**: add SQS resource to `sst.config.ts`: queue `basics-runs.fifo`, FIFO, content-based dedup off, message retention 4 days, visibility timeout 360s (long enough for cold-start + a hello-world run with margin). Wire as event source for `basics-dispatcher`. Run `sst deploy --stage production`.
- **verify**: `aws sqs get-queue-url --queue-name basics-runs.fifo --region us-east-1`; `aws sqs get-queue-attributes --queue-url <url> --attribute-names All` confirms `FifoQueue=true, VisibilityTimeout=360`.
- **evidence**: `sqs-attrs.json`, `sst-deploy-output.txt`.
- **gates**: auto-granted in autonomous mode.

#### A.5 — DB migrations: new Postgres tables + `pg_cron` + Realtime publication

> **Scope revised 2026-05-08** to map onto the existing schema in the active Supabase project (`Basics`, ref `xihupmgkamnfbzacksja`) — see CLOUD-AGENT-PLAN.md §13's reconciliation table. Net effect: **4 new tables + 1 column + 1 extension + 1 cron job + 1 publication add**, fully additive (no DROPs, no destructive changes).

- **do**: apply via Supabase MCP `apply_migration` (one migration named `cloud_agent_a5`) against the resolved Supabase project (`config.json.stagingSupabaseProjectRef`):
  - **NEW tables**: `agent_helpers`, `agent_lanes`, `agent_inboxes`, `workspace_active_tasks` (4 total). RLS enabled on each, with workspace-scoped `SELECT` policy via `workspace_members.account_id = auth.uid()` to match this DB's existing convention.
  - **REUSED tables** (no migration needed):
    - `agent_runs` ↔ plan's `runs` (FK target for `agent_activity.agent_run_id`)
    - `agent_run_steps` ↔ plan's `run_steps`
    - `pending_approvals` ↔ plan's `approvals`
    - `agent_activity` ↔ plan's `run_events` (worker emits events with the existing column names: `activity_type`, `agent_run_id`, `created_at`)
    - `skills` ↔ plan's `agent_skills` (skill bodies stored in DB; the EFS skills/ subtree from §3.2 is dropped — see plan §13 reconciliation)
  - **Column add**: `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS agent_settings JSONB NOT NULL DEFAULT '{}'`.
  - **Extension**: `CREATE EXTENSION IF NOT EXISTS pg_cron`.
  - **pg_cron job**: schedule `reap-workspace-active-tasks` every minute, DELETEing stale rows by the §13 predicate (status+last_activity_at thresholds + expires_at).
  - **Realtime publication**: `ALTER PUBLICATION supabase_realtime ADD TABLE agent_activity` so worker INSERTs broadcast to SSE clients.
- **verify**:
  - MCP `list_tables` shows the 4 new tables (agent_helpers, agent_lanes, agent_inboxes, workspace_active_tasks).
  - For each new table, MCP `execute_sql` inserts a fixture row (workspace_id = `139e7cdc-7060-49c8-a04f-2afffddbd708`) then deletes — confirms FKs/types/RLS-bypass for service role.
  - `SELECT extname FROM pg_extension WHERE extname = 'pg_cron'` returns one row.
  - `SELECT jobname FROM cron.job WHERE jobname = 'reap-workspace-active-tasks'` returns one row.
  - `SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'agent_activity'` returns one row.
  - `SELECT column_name FROM information_schema.columns WHERE table_name = 'workspaces' AND column_name = 'agent_settings'` returns one row.
  - Realtime end-to-end (deferred to A.9 smoke test where the worker actually emits events): noted in evidence but not blocking A.5.
- **evidence**: `migration.sql`, `list_tables.json`, `fixture-insert-delete.json`, `pg_cron-jobs.txt`, `realtime-pub.txt`, `agent_settings-col.txt`.
- **gates**: this is the active prod-equivalent Supabase project; per the stage policy (production has no users), `apply_migration` against it is auto-granted in autonomous mode. The migration is additive-only — no DROPs, no DELETEs against existing rows.

#### A.6 — Wire Lambda → Postgres via Supavisor

- **do**: in `sst.config.ts`, add a new `sst.Secret("DatabaseUrlPooler")` and bind it to the dispatcher Lambda + the API Lambda. Set its value with `doppler secrets set DATABASE_URL_POOLER=postgresql://postgres.<ref>:<pw>@aws-0-us-east-1.pooler.supabase.com:6543/postgres --config stg --project backend`. Update `api/src/db/client.ts` (or the shared client) to read `DATABASE_URL_POOLER` from env when invoked from Lambda (detect via `process.env.AWS_LAMBDA_FUNCTION_NAME`); fall back to direct `DATABASE_URL` for long-running workers.
- **verify**: a one-shot Lambda probe (`pnpm tsx scripts/probe-pooler.ts`) connects via the pooler URL, runs `SELECT now()`, returns. Run it 50 times in parallel and confirm the Supabase project's `pg_stat_activity` shows ≤ ~10 backend connections — proving multiplexing.
- **evidence**: `pooler-probe.txt`, `pg_stat_activity.json`.
- **gates**: `doppler secrets set` is §4.1 (auto-granted in autonomous mode).

#### A.7 — Tool framework `shared/tools/define.ts`

- **do**: `shared/tools/define.ts` exports `defineTool({ name, description, params, mutating, requiresApproval, cost, execute })`. Adapter `worker/src/tools/oc-adapter.ts` converts a defineTool to opencode tool format.
- **verify**: vitest unit test in `shared/tools/define.test.ts` registers two fake tools; the OC adapter emits expected JSON.
- **evidence**: `vitest.log`.
- **gates**: none.

#### A.8 — Port `screenshot`, `goto_url`, `js` tools

- **do**: `worker/src/tools/screenshot.ts`, `goto_url.ts`, `js.ts` each wraps the harness function and uses `defineTool`. Each tool's `publish` hook INSERTs into `run_events` instead of pushing to Redis. Register in `worker/src/tools/index.ts`.
- **verify**: a vitest integration test in `worker/test/tools.int.test.ts` opens a real Browserbase session (via `BROWSERBASE_API_KEY` from Doppler), calls each tool through the OC adapter, asserts: screenshot returns base64 of length > 1000, `goto_url` returns a frame id, `js` returns `document.title === "Example Domain"`. Also verifies a `run_events` row was inserted per call.
- **evidence**: `vitest-int.log`, `screenshot-thumb.png`, `run_events-rows.json`.
- **gates**: none.

#### A.9 — Smoke-test end-to-end (image build → ECS task → tool execution → SSE)

- **do**: build and push the worker image (`docker build` → `aws ecr get-login-password | docker login` → `docker push <ecr-uri>:latest`). Send a fake SQS message tagged with the test workspace's id and a hello-world run payload. Watch the dispatcher launch the task; watch the task execute the run.
- **verify**:
  1. `aws ecs list-tasks --cluster basics-agent` shows ≥1 task in `RUNNING` state within 60s of the SQS message.
  2. `aws ecs describe-tasks --cluster basics-agent --tasks <arn>` shows all 3 containers `HEALTHY`.
  3. The fake SQS message is consumed (queue depth → 0) within 90s.
  4. SQL `SELECT type, at FROM run_events WHERE run_id = '<runId>' ORDER BY id` shows `run_started`, ≥1 `tool_call_start`, ≥1 `tool_call_end`, `screenshot`, `run_completed`.
  5. SSE endpoint `https://api.trybasics.ai/v1/runs/<runId>/events` (curled with a workspace JWT minted from the test workspace) streams the same events live (i.e. start the curl BEFORE the SQS send and confirm events arrive in order during the run).
  6. After 5 min idle, `aws ecs list-tasks --cluster basics-agent --desired-status RUNNING` returns empty (task self-stopped).
  7. MCP `execute_sql` `SELECT * FROM workspace_active_tasks WHERE workspace_id = '<id>'` returns no row (or `status = 'stopping'` and `last_activity_at < now() - interval '5 min'` so the next pg_cron tick deletes it).
- **evidence**: `ecs-tasks.json`, `task-describe.json`, `sqs-trace.txt`, `run_events.json`, `sse-curl.txt`, `idle-stop.txt`, `active-tasks-after-idle.json`.
- **gates**: `docker push` and `aws ecs run-task` are auto-granted in autonomous mode (§4.1).

**Phase A exit criteria**: A.1–A.9 all `passed`. `state.json.history` has 9 entries for phase A. Cold-start TTFB measured during A.9 verification step 1 ≤ 60s; warm TTFB (a second SQS message within 5 min) ≤ 5s.

---

### Phase B — Tool surface

**Goal**: full §7 tool set live. Approval middleware gates mutating tools. Plan tools render in web.

#### B.1 — Port remaining browser tools

`new_tab`, `click_at_xy`, `type_text`, `fill_input`, `press_key`, `scroll`, `wait_for_load`, `wait_for_element`, `wait_for_network_idle`, `http_get`, `extract`, `cdp_raw`, `ensure_real_tab`, `upload_file`, `dispatch_key`.

- **verify**: integration tests in `worker/test/tools.int.test.ts` cover each. Each tool exercised against `https://example.com` or a known fixture page.
- **evidence**: `vitest-tools.log`.
- **gates**: none.

#### B.2 — Filesystem tools (sandboxed)

`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `delete_file`. All resolve paths against `/workspace`; reject anything else.

- **verify**: a unit test attempts to write to `/etc/passwd`, asserts the tool throws `path_outside_sandbox`. Another writes a file under `skills/example.com/selectors.md` and reads it back.
- **evidence**: `vitest-fs.log`.
- **gates**: none.

#### B.3 — `bash` tool with bwrap sandbox

- **verify**: `bash({ cmd: "echo hello" })` returns `"hello\n"`. `bash({ cmd: "cat /etc/passwd" })` is rejected by bwrap. Network egress: `curl https://api.anthropic.com/v1/...` succeeds; `curl https://evil.example.com` is blocked by allow-list.
- **evidence**: `vitest-bash.log`.
- **gates**: none.

#### B.4 — Approval middleware integration

Wire the tool framework's `requiresApproval` into the existing `gateToolCall` middleware. Mutating tools without an approval grant return `approval_required` to the model.

- **verify**: a run that calls `click_at_xy` without an approval grant emits an `approval_required` row in `run_events`; resolving the approval (POST to API) lets the tool execute.
- **evidence**: `approval-flow.json`.
- **gates**: none.

#### B.5 — Plan tools end-to-end

`update_plan`, `set_step_status`, `report_finding`, `final_answer`. These are server-side tools; the desktop-app repo will render them when it comes online. The migration's job is making sure events are emitted with the right shape.

- **verify**: a hello-world run that calls `update_plan` with 3 steps, then `set_step_status` for each. `curl -N` the SSE endpoint and capture the stream; assert the captured events contain (in order) `plan_updated` with 3 steps, then 3 × `step_status` with the expected statuses. Then `SELECT type, payload->>'stepId', payload->>'status' FROM run_events WHERE run_id = '<runId>' AND type IN ('plan_updated','step_status') ORDER BY id` confirms the same shape from the source-of-truth table.
- **evidence**: `sse-curl.txt`, `run_events-plan.json`.
- **gates**: none.

**Phase B exit criteria**: all §7 tools merged, integration tests green, SSE + `run_events` rows for a multi-step run match the §11.1 event-shape spec.

---

### Phase C — Provider routing + budgets

**Goal**: `selectModel` routes per turn; cost ledger is accurate; daily ceiling enforced.

#### C.1 — `selectModel` router

- **do**: `worker/src/router/selectModel.ts` implements the §6.2 matrix. Reads providers from Doppler-injected env. Pricing from `worker/pricing.json` refreshed by a CI job.
- **verify**: unit tests pass for every cell in the §6.2 matrix. Failover on simulated 429.
- **evidence**: `vitest-router.log`.
- **gates**: none.

#### C.2 — Cost ledger writes per turn

- **do**: every LLM call records a `run_cost_lines` row with provider, model, tokens, cents. `workspace_cost_ledger` increments on each row.
- **verify**: run a known workflow (10 turns mixed). Sum `run_cost_lines.cents` for the run; compare to the actual provider responses' `usage` fields. Drift ≤ 1%.
- **evidence**: `cost-reconciliation.csv`.
- **gates**: none.

#### C.3 — Daily ceiling enforcement

- **do**: turn-loop checks ceiling pre-call. Soft warn at 80%, hard stop at 100%. Emits `budget_warning` / `run.status = 'budget_exceeded'`.
- **verify**: set a workspace's ceiling to $0.10. Trigger a run that would exceed it. Confirm `budget_warning` event fires and the next turn errors `budget_exceeded`.
- **evidence**: `budget-test-trace.json`.
- **gates**: none.

#### C.4 — BYO key flow round-trip

- **do**: workspace settings UI lets user paste a key. Encrypted via KMS; stored in `workspaces.agent_settings.byoApiKeys`.
- **verify**: paste a Gemini key into a staging workspace. Run a workflow. Confirm via Anthropic / Gemini dashboard logs that the call hit the BYO account, not the platform account.
- **evidence**: `byo-trace.txt`, redacted screenshot of provider dashboard.
- **gates**: none.

**Phase C exit criteria**: a workspace runs entirely on Gemini for a 24h soak; cost-ledger reconciles to within 1% of the provider's daily invoice line.

---

### Phase D — Self-improvement (skills + helpers)

**Goal**: 10th run on the same workflow uses ≥40% fewer screenshots than the 1st run.

#### D.1 — Skill-write middleware

- **do**: `worker/src/middleware/skillWrite.ts` enforces §9.3 (path policy, size, secret regex, pixel-coord regex, PII heuristic, verification stamp).
- **verify**: unit tests for each rule. A `write_file` with `sk-ant-…` in the body is rejected and emits a `skill_write_blocked` event.
- **evidence**: `vitest-skillwrite.log`.
- **gates**: none.

#### D.2 — `agent_skills` mirror via FS watcher

- **do**: a per-Machine watcher (`chokidar`) syncs `/workspace/skills/**` and `/workspace/helpers/**` mtime/size/hash into the DB.
- **verify**: write a file via the `write_file` tool; within 5s the corresponding `agent_skills` row exists.
- **evidence**: `mirror-trace.txt`.
- **gates**: none.

#### D.3 — Skill loader middleware

- **do**: when the model is about to call a tool that touches a host (`goto_url`, `js`), middleware injects the `skills/<host>/INDEX.md` body and the file list into the next prompt turn.
- **verify**: write a fake skill for `example.com`. Run a workflow targeting that host. Capture the prompt; confirm the INDEX.md text appears in the system message of the model call.
- **evidence**: `prompt-snapshot.json`.
- **gates**: none.

#### D.4 — Skill decay nightly job

- **do**: scheduled job demotes unverified > 30 day entries; archives unread > 90 day flows.
- **verify**: backdate a skill row; run job; confirm row moves to `deprecated` status.
- **evidence**: `decay-trace.txt`.
- **gates**: none.

#### D.5 — Screenshot ratio measurement

- **do**: per-run, count `screenshot` events / total tool events; expose on `/runs/<id>` and as a workspace-rolling metric.
- **verify**: run the same hello-world workflow 10 times back-to-back. The 10th run's `screenshot_ratio` is ≥40% lower than the 1st. Skills accumulate in `/workspace/skills/example.com/` between runs.
- **evidence**: `ratio-chart.png`, `runs-1-and-10-skill-diff.diff`.
- **gates**: none.

**Phase D exit criteria**: D.5 metric proves the speed-up. Without this, the migration's headline benefit is unproven and we do not advance.

---

### Phase E — Multi-agent + scheduling

**Goal**: 2 lanes per workspace exchange messages; cron-triggered runs work end-to-end.

#### E.1 — `agent_lanes` + `agent_inboxes`

- **do**: API endpoints to CRUD lanes; SQS group key includes lane id; worker routes to the lane's session.
- **verify**: create lanes `ops` and `research`. Trigger one run on each. Confirm both run in the same Machine but different opencode sessions; transcripts kept separate.
- **evidence**: `lane-trace.json`.
- **gates**: none.

#### E.2 — `spawn_subagent`

- **do**: subagent tool spawns an inner opencode session with restricted tools and a `maxTurns` cap. Returns transcript + final answer.
- **verify**: a parent agent spawns a verifier subagent that uses only read-only tools. Confirm the subagent's transcript appears nested in the parent's run timeline.
- **evidence**: `subagent-trace.json`.
- **gates**: none.

#### E.3 — `send_to_agent` + cross-agent grants

- **do**: tool inserts into `agent_inboxes`. Worker checks inbox each loop tick.
- **verify**: lane `research` sends a message to lane `ops`. Within 30s, lane `ops` receives the message in its next run's prompt context.
- **evidence**: `inbox-trace.json`.
- **gates**: none.

#### E.4 — EventBridge Scheduler integration

- **do**: API endpoint to CRUD schedules; on create, calls `aws scheduler create-schedule` with the cron expression and TZ. Target = SQS queue with the run payload.
- **verify**: create a schedule for `*/2 * * * *` (every 2 min) bound to a staging workflow. Wait 5 minutes. Confirm at least 2 runs were triggered with the right payload.
- **evidence**: `schedule-fires.json`.
- **gates**: `aws scheduler create-schedule` is gated for prod; ungated for staging.

#### E.5 — Schedules API surface (no UI in this repo)

- **do**: API endpoints `POST /v1/schedules`, `GET /v1/schedules`, `GET /v1/schedules/:id`, `PATCH /v1/schedules/:id` (pause/resume/edit cron), `POST /v1/schedules/:id/test`, `DELETE /v1/schedules/:id`. Each maps onto the EventBridge Scheduler operations from E.4. Validate cron + IANA TZ on insert/update; persist to the `schedules` table from §13.
- **verify**: `curl` end-to-end with a workspace JWT — create a schedule, list it, fetch it (response includes `nextFireUtc` and `nextFireLocal` formatted in workspace TZ), POST `/test` and confirm a run lands in `runs` within 5s, PATCH the cron and confirm `nextFireUtc` updates, DELETE and confirm `aws scheduler get-schedule` 404s. **No web UI check** — `web/` is retired. The desktop-app repo will build its own schedules page on top of this API.
- **evidence**: `schedules-api-trace.txt`, `eventbridge-after-delete.json`.
- **gates**: none (staging only; AWS Scheduler mutations on staging are §4.2-style routine).

**Phase E exit criteria**: 2 lanes scheduled and exchanging messages for a 24h soak with no missed fires (within 5 min of expected) and no lost inbox messages.

---

### Phase F — Deprecation of `computer_20250124` path

**Goal**: zero traffic on the legacy `agentLoop.ts` path for 7 consecutive days, then deletion.

#### F.1 — Migrate design-partner workspaces via flag flip

- **do**: `workspaces.agent_settings.runtime = 'v2'` on each design-partner workspace. Reverse-flag is `'v1-legacy'`. Default for new workspaces: `v2`.
- **verify**: dashboard shows all design partners on v2. CloudWatch metric `legacy_runs_per_day` drops to 0 within 24h.
- **evidence**: `migration-trace.json`, CloudWatch screenshot.
- **gates**: prod flag flip is gated **per workspace** — one approval per design partner.

#### F.2 — Soak for 7 days

- **do**: nothing. Loop should *not* fire during this period — set `paused: true` automatically and emit a `phase_F_soak_started` history entry with the wakeup time. The `/loop` invocation that detects `paused: true` and `phase_F_soak_until` reschedules itself for the soak end.
- **verify**: at the 7-day mark, query `legacy_runs_per_day` for the last 7 days. All zero.
- **evidence**: `soak-metrics.json`.
- **gates**: none — passive observation.

#### F.3 — Delete legacy code

- **do**: delete `api/src/orchestrator/agentLoop.ts`, `computerUseDispatcher.ts`, the `computer_20250124` registration in `runMessages`. Keep `harness/` untouched (tools wrap it). Remove the `runtime` flag and migrate everyone implicitly to v2 schema.
- **verify**: `grep -rn 'computer_20250124' .` → only references in this doc, `CLOUD-AGENT-PLAN.md`, and old commit history. `pnpm test` and `pnpm typecheck` pass.
- **evidence**: `grep-output.txt`, `vitest.log`, `tsc.log`.
- **gates**: PR creation is fine; merging the PR is gated (the merge to main is gated per §4).

#### F.4 — Update docs

- **do**: edit `ARCHITECTURE.md`, `ROADMAP.md` to reflect v2 as the only path. `CLOUD-AGENT-PLAN.md` gets a "Status: SHIPPED" banner at the top.
- **verify**: `pnpm md-lint` (or a `markdownlint` invocation) passes; cross-link checker (`lychee` or `markdown-link-check`) reports no broken links between the edited docs.
- **evidence**: `mdlint.log`, `linkcheck.log`.
- **gates**: none.

#### F.5 — Final retro

- **do**: write `docs/RETRO-CLOUD-AGENT-MIGRATION.md`. Include cost actuals vs estimates, phase durations, surprises, what to do differently next time. Update the team's runbook.
- **verify**: the file exists, is non-trivial (≥ 100 lines), and is referenced from `ROADMAP.md`.
- **evidence**: `retro.md`.
- **gates**: none.

**Phase F exit criteria**: legacy code deleted, retro written, `state.json.completed = true`. Loop emits a final "Migration complete." status and self-pauses permanently.

---

### Phase G — Bridge from infra to a runnable agent (post-migration)

**Context**: Phases A→F shipped infra + a 32-tool registry + skill/lane/router/budget primitives, but `worker/src/runner.ts` still runs the slice-2 hardcoded `HELLO_WORLD_SCRIPT`. There is no LLM loop, no goal/prompt env var, no Browserbase Context attach (so cookies don't load), no EFS mount on the task (so files don't persist), and no `live_view_url` written. Phase G is the bridge from "infra is built" to "an actual agent run with cookies + skills + screenshots + files works end-to-end."

This phase is post-migration ("the migration shipped" was the right call — the infra is solid; G is its first real workload). State.json's `completed` flag flips back to `false` until G's exit criteria are met.

**Phase G exit criteria**: a real ad-hoc workflow run (e.g. "open YouTube, list the first 3 videos in my subscriptions") completes end-to-end with the worker driving an LLM loop, cookies loaded, screenshots in S3, at least one skill loaded from the workspace's EFS, the operator able to watch the browser via Browserbase liveUrl AND the §11.1 event stream via SSE simultaneously.

#### G.1 — LLM-driven runner

- **do**: Replace `HELLO_WORLD_SCRIPT` in `worker/src/runner.ts` with an Anthropic SDK loop. Plumb a `GOAL` env var through the dispatcher's `containerOverrides.environment` and `worker/src/main.ts` into the runner. Use `@anthropic-ai/sdk` (matches api lock-in per `docs/HANDOFF.md`); register the 32-tool registry via the existing OC adapter (the tool shape — `name`, `description`, `input_schema` derived from zod — is wire-compatible with Anthropic's `tools` field). Each turn: `messages.create({...tools, messages, system})` → for each `tool_use` block, find the tool, invoke it (preserving the runner's existing `tool_call_start`/`tool_call_end` wrapping + approval gate), append the `tool_result` to messages, loop. Stop when `stop_reason='end_turn'`, the model emits `final_answer`, or a `maxTurns` ceiling (default 32). Wire the existing `selectModel` router (still pin Claude Sonnet 4.6 as primary; downshift via budget gate). Read BYOK key via `byok-resolver.ts`, fall back to platform env. Budget gate (`StatefulBudgetGate`) is consulted on each turn before calling the model.
- **verify**: end-to-end via Supabase MCP + SSE: insert `agent_runs` row with `status='pending'`, send SQS message `{ runId, workspaceId, accountId, goal: "open https://example.com and report the h1 text" }`, watch SSE stream — should see `run_started` → `tool_call_start(goto_url)` → `tool_call_end` → `tool_call_start(extract)` → `tool_call_end` → `final_answer{text: "Example Domain"}` → `run_completed`. Stop reason `final_answer`. Cost row appears in `usage_tracking`.
- **evidence**: `sse-transcript.txt` (full event stream), `usage-row.json`.
- **gates**: none for the code; a real model call costs <$0.05/run on Sonnet 4.6 — within budget.

#### G.2 — Browserbase Context attach + liveUrl persisted

- **do**: In `worker/src/browserbase.ts` `createBrowserbaseSession`, accept an optional `contextId` and pass it as `browserSettings.context.id` (Browserbase API). Look up `workspaces.browserbase_profile_id` in the runner's start-up phase; if set, use it. After session create, fetch `GET https://api.browserbase.com/v1/sessions/:id` to read the `liveUrl` field, then `UPDATE agent_runs SET live_view_url = ?, browserbase_session_id = ? WHERE id = ?` so any subscriber can iframe it.
- **verify**: pick a workspace with `browserbase_profile_id` set + cookies for a test domain (e.g. youtube.com if pre-seeded; else stage one quickly). Trigger a goal "navigate to youtube.com and screenshot." Open `live_view_url` from `agent_runs` in a real browser — confirm the agent's view is visible AND that the page is logged in (cookie-derived UI visible).
- **evidence**: `liveurl.txt`, screenshot of operator's browser viewing the liveUrl page.
- **gates**: none.

#### G.3 — EFS volume mount + path-policy isolation

- **do**: Decision: single shared access point + path-policy isolation (per CLOUD-AGENT-PLAN §22, "first line of defense is path policy"). In `sst.config.ts`, add an `aws.efs.AccessPoint` for the workspaces filesystem with `posixUser: { uid: 1000, gid: 1000 }` and `rootDirectory: { path: '/workspaces', creationInfo: { ownerUid: 1000, ownerGid: 1000, permissions: '0755' } }`, then declare a `volumes` block on the worker task definition referencing the access point + a `mountPoints` block in the basics-worker container at `/workspace`. Worker's `WORKSPACE_ROOT` env stays `/workspace`; the runner constructs `/workspace/<workspaceId>/...` for all writes. `skill-write-policy.ts` already enforces the workspace-id boundary on writes; add a runtime assert in the runner that bails if a tool tries to write outside `/workspace/<workspaceId>/`.
- **verify**: send a goal "create a file `notes.md` in your workspace with the text 'hello G.3'". Confirm via MCP-driven SQL `SELECT body FROM skills WHERE workspace_id=...` (skills are DB-tracked) AND by exec-into-task during a second run that reads the file: `bash` tool result should contain `hello G.3`. Multi-workspace: run two concurrent tasks for different workspaces, each tries to read the OTHER's file via absolute path; assert both fail (path-policy reject).
- **evidence**: `efs-write-readback.txt`, `cross-workspace-reject.txt`.
- **gates**: SST deploy required (task def revision bump). Auto-grant per the no-staging-only-production policy.

#### G.4 — Skill load on run start + skill_write end-to-end

- **do**: At runner start, after `Publisher` init and before the LLM loop, call `PgSkillLoader.list()` for the workspace, run `composeSkillContext(skills)` per `skill-loader.ts:141`, and prepend the result to the Anthropic `system` prompt under the `<skills>` fragment from §8.3. Wire `skill_write` tool's storage hook to write the body file to `/workspace/<workspaceId>/skills/<id>/SKILL.md` (G.3 EFS) AND insert the row into `public.skills` via `PgSkillStore`. The `skill-write-policy.ts` middleware should reject writes that violate any of its 7 rules (path/size/secret-scan/etc.).
- **verify**: pre-seed one skill row for a test workspace ("when on youtube.com, prefer keyboard shortcut 's' to open search"). Send goal "search youtube for 'cats'." SSE should show the skill being applied via tool choice (the model uses the keyboard shortcut path). Then send a second-turn goal "write a skill capturing what you learned." Confirm new `skills` row appears + body file exists on EFS (via bash readback).
- **evidence**: `skill-applied-trace.txt`, `skill-write-trace.txt`.
- **gates**: none.

**Phase G exit criteria**: end-to-end demo run with cookies + skill load + skill write + screenshot + file create + liveUrl observable in real time. Set `phaseGCompletedAt` in state.json.

---

### Phase H — Multi-tenant opencode pool (cost + parallel-agents win)

**Context**: Today's architecture is 1 ECS task per workspace. At 100 active workspaces ≈ 100 vCPU running warm. Multiple agents in the same workspace also serialize through the FIFO group key. opencode has first-class session support — `opencode serve` + `opencode run --attach` is the documented pattern for running many sessions in one server. Phase H switches the worker container from "single-tenant warm worker" to "multi-tenant opencode pool" — many workspaces' runs share one Fargate task, capped by `slots_max`. When a pool fills, a new pool spins up. Cost projection at 100 workspaces with 5 slots/pool: 20 vCPU instead of 100 (~5x cheaper).

**Research findings (H.1 spike, 2026-05-09):**
- `opencode serve --port 4096` exposes an HTTP API. Confirmed endpoints by hitting the local binary:
  - `POST /session` → `{ id, slug, projectID, directory, title, time }`. `id` matches `^ses_[a-z0-9]+$`. ONLY mutable field is `title`; no custom metadata channel.
  - `POST /session/:id/message` (sync) and `POST /session/:id/prompt_async` (fire-and-forget, returns 204). Body: `{ messageID?, model?, agent?, noReply?, system?, tools?, parts }`.
  - `POST /session/:id/shell`, `/command` — for non-LLM scripted operations.
  - `GET /event` — SSE stream of all session events (assistant text, tool calls, step finishes, etc.). One stream per server, multiplexes all sessions.
- Plugin process-wide singleton problem: `Plugin: (input) => Promise<Hooks>` is called once at server boot. Plugin's tool `execute(args, ToolContext)` gets `ToolContext.sessionID` per call. Per-session state belongs in `Map<sessionID, Runtime>`.
- Per-session metadata: bind workspaceId/runId via a side-table `opencode_session_bindings(session_id, workspace_id, run_id, account_id, created_at)`. Plugin reads on first tool-call per session, caches.
- Parallelism: docs silent, no evidence of cross-session locking. Assume parallel; verify by stress test in H.4.
- Custom agents: `/agent` endpoint shows config-defined agents. Cannot dynamically register agents per call via HTTP — confirms side-table is the right channel for per-session workspace identity.
- **Reversal of G.5's NOTIFY routing**: pool tasks are HTTP-fronted on port 4096. Dispatcher posts new runs via `POST /session` + `POST /session/:id/prompt_async`. Postgres LISTEN drops out. The Supavisor :5432 fix from G.5 stays for any other LISTEN consumers (none today).

**Phase H exit criteria**: a single ECS task hosting `opencode serve` runs ≥3 concurrent sessions for ≥2 different workspaces; per-session BB / publisher / file paths are isolated; dispatcher routes by available capacity; pool drains cleanly on idle. Cost-per-warm-workspace at least 3x lower than G.5 baseline. Update `phaseHCompletedAt` and flip `completed` = true.

#### H.1 — Spike + plan ratification (DONE 2026-05-09)

Findings above. The original 1-2 hour spike landed: opencode session lifecycle is real, plugin SDK supports per-session ctx via sessionID, side-table is the metadata bridge. State.json captures the spike under `_noteH1`.

#### H.2 — Per-session plugin runtime

- **do**: Refactor `worker/src/opencode-plugin/index.ts` from singleton `runtimePromise` to `Map<sessionID, Runtime>`. First tool-call per session: `SELECT * FROM opencode_session_bindings WHERE session_id = $1` to learn workspaceId/runId/accountId; create per-session BB session + Publisher + CDP attach; cache. On session end (via `/event` SSE filter), tear down. The current pinned-env path (RUN_ID/WORKSPACE_ID via process.env) becomes the fallback when no binding row exists, preserving G.1b behavior for 1:1 mode.
- **verify**: unit test the `Map<sessionID, Runtime>` lifecycle (create, double-create returns cached, teardown clears). Live: in 1:1 mode, agent_activity row sequence still matches G.1b's reference; no behavior regression.
- **gates**: none.

#### H.3 — Pool host worker + dispatcher rewrite

- **do**: 
  - Apply migration `0005_opencode_pool.sql` adding `opencode_pools(pool_id PK, task_arn, host, port, started_at, last_activity_at, slots_used INT, slots_max INT, status)` and `opencode_session_bindings(session_id PK, pool_id, workspace_id UUID, run_id UUID, account_id UUID, created_at)`. Drop or ignore `workspace_active_tasks` (orphan from G.5).
  - Rewrite `worker/src/main.ts` to spawn `opencode serve --port 4096 --hostname 0.0.0.0` as a long-lived child; on startup INSERT into `opencode_pools` with task_arn + private IP from ECS metadata + slots_max=5.
  - Rewrite `worker/dispatcher/handler.ts`: pick first pool with `slots_used < slots_max AND status='active' AND ECS task live`. If found, create session via `POST http://{pool.host}:4096/session`, INSERT `opencode_session_bindings`, increment slots, then `POST /session/:id/prompt_async` with the goal. If none, `RunTask` a fresh pool and retry once.
  - Worker SG inbound 4096 from dispatcher Lambda SG (new SST rule).
  - Worker subscribes to local `/event` SSE; on `session.end` for any session, DELETE binding + decrement slots + cleanup runtime.
- **verify**: dispatch 3 runs across 2 workspaces; only 1 ECS task launches. CloudWatch shows all events flowing; agent_activity for both workspaces is correctly attributed.
- **evidence**: `pool-events.txt`, `agent_activity-cross-workspace.csv`.
- **gates**: SST deploy.

#### H.4 — Tenant isolation hardening + crash recovery

- **do**: Add path-policy assert in plugin tool execute: every file write resolves to `/workspace/<sessionWorkspaceId>/...`; reject + emit `cross_tenant_attempt` audit event otherwise. Wrap each session's tool dispatch with try/catch so one session's exception can't take down the pool. Add a heartbeat from plugin to `opencode_pools.last_activity_at` so dead pools get reaped. Supervised opencode-serve via `bun --watch` or a thin wrapper that restarts on exit (with a max-restarts cap).
- **verify**: stress-test by launching 5 sessions across 5 workspaces; have one session intentionally throw mid-run; confirm the other 4 finish. Cross-tenant test: try to write `/workspace/<otherWorkspaceId>/secret.md` from a sessionA tool — confirm rejection + audit event.
- **evidence**: `tenant-isolation.txt`.
- **gates**: none.

#### H.5 — Migration + soak

- **do**: Roll the pool architecture to production. `slots_max=5` initial. Set CloudWatch alarms on pool slot saturation (≥80% for 5 min → page) and pool crash rate. Update `docs/HANDOFF_API_CLOUD_AGENT.md` to reflect that the api control-plane should dispatch by POSTing run JSON to the dispatcher Lambda's URL (no behavior change there) — the Lambda hides the pool routing.
- **verify**: 24-hour soak with synthetic traffic at 3 RPS across 5 workspaces. No tenant cross-contamination, no orphaned sessions, average warm-route latency ≤ 2x of G.5 (allowing for pool-resolve hop).
- **evidence**: `h5-soak.csv`.
- **gates**: production deploy auto-grant per stage policy.

---

## 7. Common verification primitives

The phases reference these. Implement each as a one-line bash invocation the loop can run verbatim.

| Primitive | Command |
|---|---|
| Doppler env loaded? | `doppler secrets --config <stg\|prd> --project backend` (count, never print values) |
| ECS cluster exists? | `aws ecs describe-clusters --clusters <name> --region us-east-1` |
| ECS Task Definition registered? | `aws ecs describe-task-definition --task-definition <name> --region us-east-1` |
| ECS task running for workspace? | `aws ecs list-tasks --cluster <cluster> --region us-east-1` then `describe-tasks` |
| Container healthy? | In `describe-tasks` output: `containers[].healthStatus == "HEALTHY"` |
| EFS file system available? | `aws efs describe-file-systems --region us-east-1 --query 'FileSystems[?Name==\`<name>\`]'` |
| EFS access point available? | `aws efs describe-access-points --file-system-id <fs-id>` |
| SQS queue exists? | `aws sqs get-queue-url --queue-name <name> --region us-east-1` |
| SQS attributes correct? | `aws sqs get-queue-attributes --queue-url <url> --attribute-names All` |
| Active task for workspace? | MCP `execute_sql` `SELECT * FROM workspace_active_tasks WHERE workspace_id = '<id>'` |
| `pg_cron` reaper scheduled? | MCP `execute_sql` `SELECT * FROM cron.job WHERE jobname LIKE 'workspace_active_tasks%'` |
| Lambda exists / triggered? | `aws lambda get-function --function-name <name>`; `aws lambda list-event-source-mappings --function-name <name>` |
| Supabase table exists? | MCP `list_tables` then check name in result |
| Migration applied? | MCP `list_migrations` |
| `run_events` Realtime publication includes table? | MCP `execute_sql` `SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'run_events'` |
| EventBridge schedule active? | `aws scheduler get-schedule --name <name>` and check `State == "ENABLED"` |
| SSE stream tails events? | `curl -N -H "Authorization: Bearer $JWT" https://api.trybasics.ai/v1/runs/<id>/events` |
| SSE replay correct? | `curl -N -H "Authorization: Bearer $JWT" https://api.trybasics.ai/v1/runs/<id>/events` and grep for the expected event types in order |

---

## 8. Failure recovery

Common failure shapes the loop should recognize and handle without bothering the user:

| Failure | Auto-action |
|---|---|
| `pnpm install` non-zero | Capture log; rerun once with `--frozen-lockfile=false`; if still fails, retry counts. |
| `aws ecs run-task` returns 0 tasks (capacity / Spot interruption) | Retry once with `--launch-type FARGATE` (skip Spot). If still fails, count as failure. |
| `aws ecs describe-tasks` shows `stoppedReason: ResourceInitializationError` | Inspect `containers[].reason`; common cause is image pull failure — re-push and retry. |
| `aws ... ThrottlingException` | Exponential backoff 5s/15s/45s, then count as a real failure. |
| Supabase MCP `connection_terminated` | Retry once. If still fails, surface as blocked. |
| Browserbase session creation 500 | Retry once with new session. |
| `tsc` errors | Try to fix mechanically (unused imports, missing types). If non-trivial, count as a failure. |
| Vitest test failure | If the test was just added in this iteration, the implementation is the fix path; count as failure but don't retry blindly — re-plan first. |

Failures the loop must **never** auto-handle (always escalate to the user):

- Any `aws` ACCESS_DENIED — could indicate IAM regression.
- Any prod database error.
- Any unexpected `git status` dirty state at iteration start (could be the user's WIP).
- Any `git push` rejection (force-push could overwrite work).
- Any unanticipated cost ledger entry > $5 (could indicate runaway).

---

## 9. Operator UX cheatsheet

Single commands, no GUI:

```sh
# Start / resume
/loop Read docs/BUILD-LOOP.md and docs/.build-loop/state.json. Execute the next step per the per-iteration protocol in §3. Update state. Stop when the phase advances, blocks on approval, or completes the migration.

# Status
cat docs/.build-loop/state.json | jq '{phase: .currentPhase, step: .currentStep, blocked, completed, last: .history[-1]}'

# Pause
jq '.paused = true' docs/.build-loop/state.json | sponge docs/.build-loop/state.json

# Resume
jq '.paused = false' docs/.build-loop/state.json | sponge docs/.build-loop/state.json

# Restart current phase from step 1
jq '.currentStep = 1 | .attempt = 1 | .phaseAttemptsTotal = 0 | .lastFailure = null | .blocked = null' docs/.build-loop/state.json | sponge docs/.build-loop/state.json

# Hard reset (start over from Phase A)
rm -rf docs/.build-loop/state.json docs/.build-loop/artifacts
```

---

## 10. What this loop is not

- **Not** a CI replacement. CI runs on every PR; this loop runs the *initial migration* once.
- **Not** a forever-on agent. It self-completes at end of Phase F.
- **Not** the cloud-agent runtime. The cloud-agent runtime is what this loop builds. Don't confuse the two.
- **Not** an excuse to skip review. Every PR the loop opens still goes through normal code review before merge — `gh pr merge` is in §4 (gated).

---

## 11. Operator pre-flight (already done)

`docs/.build-loop/config.json` and `docs/.build-loop/state.json` exist. Mode is `autonomous`. All values that can be inferred are filled in; values that need runtime detection (AWS account ID, Supabase project refs) are marked `null` with a `_discovery` block telling the loop how to resolve them on first need. The `flyOrg` field is vestigial and may be present in older config copies — the loop ignores it.

If you need to change anything:

- **Switch to supervised mode** (force chat approval on every §4.1 action): set `mode: "supervised"` in `config.json`.
- **Pause the loop**: set `killSwitch.paused: true` in `config.json`.
- **Hard-halt the loop**: set `killSwitch.emergencyHalt: true` in `config.json`. The loop will exit at the next iteration boundary and refuse to resume until cleared.
- **Tighten budget**: edit `budget.softCapUsd` / `budget.hardCapUsd`.
- **Add design partners later**: append UUIDs to `designPartnerWorkspaceIds`.

The loop never edits `config.json` except to fill in the `_discovery`-resolved values (e.g., once it learns the AWS account ID via `aws sts get-caller-identity`, it caches it back).

---

*Last updated: 2026-05-08. Owner: runtime team. The state file in `docs/.build-loop/` is the single source of truth for build progress; this doc is the spec the loop reads each iteration.*
