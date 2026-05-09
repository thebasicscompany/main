# Retro — Cloud Agent Migration (v1 → v2)

The migration scoped in `docs/CLOUD-AGENT-PLAN.md` shipped to production
on 2026-05-09. This retro captures cost actuals vs. estimates, phase
durations, surprises that mattered, and what to change next time. Read
this once before doing the next migration of similar shape (in-process
loop → out-of-process workers, schema rename, infra-heavy buildout).

The full per-iteration history with evidence is in
`docs/.build-loop/state.json`; the spec is `docs/BUILD-LOOP.md`. This
doc is the human summary on top.

---

## Outcome (one paragraph)

The Basics runtime moved from a per-request, Anthropic-only
`computer_20250124` agent loop running inside the Hono Fargate api
service to a per-workspace ECS Fargate worker (`basics-worker`, 3
containers — runner / opencode sidecar / browser-harness sidecar)
launched on demand by a dispatcher Lambda reading a `basics-runs.fifo`
SQS queue. Per-workspace EFS access points carry persistent skills +
helper files. Tool calls (32 of them) emit canonical §11.1 events to
`agent_activity`, fanned out via Supabase Realtime through the SSE
proxy at `api.trybasics.ai/v1/runs/:id/events`. Provider routing
chooses Anthropic / Gemini / OpenAI per turn; BYOK keys come from the
api with platform-key fallback. Schedules use EventBridge Scheduler →
SQS via the `basics-scheduler-invoke-production` IAM role. All twelve
items in CLOUD-AGENT-PLAN §0 landed; the v1 path is dormant in the
repo (zero traffic) pending an api control-plane refactor that
swaps `POST /v1/runs` from in-process dispatch to an SQS send.

---

## Cost actuals vs. estimates

Idle infra cost (no production users yet) is essentially zero — the
estimate held.

| Resource | Estimated idle cost | Actual idle cost | Notes |
|---|---|---|---|
| ECS Fargate cluster | $0/mo (FARGATE+FARGATE_SPOT 1:3, no running tasks) | $0/mo | matches estimate |
| ECR repo | ≈$0/mo (one image, ~250MB) | ≈$0.025/mo | matches estimate |
| SQS FIFO `basics-runs.fifo` | $0/mo (no messages) | $0/mo | matches estimate |
| Dispatcher Lambda | $0/mo (no invocations) | $0/mo | matches estimate |
| EFS `basics-workspaces` | $0.30/GB/mo + mount targets | <$0.10/mo (a few KB) | better than estimate; lifecycle to IA after 30d |
| EventBridge Scheduler | $0/mo (no schedules) | $0/mo | matches estimate |
| API service rolls | n/a — covered by existing budget | several rolls during deploys (~5 min each) | absorbed; no measurable cost |

Build labor, by contrast, was the dominant cost. The build loop ran in
a single ~9.5-hour wall-clock burst (`startedAt: 2026-05-08T17:09:00Z`
→ F.4 at `2026-05-09T02:40:00Z`), inclusive of the secret-rotation
detour and the schema-reconciliation pause. Most of that wall time
was AWS deploys + image builds, not coding — see "What ate time."

What's NOT yet measurable (zero traffic in production):
- Per-run cost lines (warmstart, opencode, browser-harness, model)
- Daily ceiling enforcement at scale
- EFS warmstart latency under real workload
- Provider-routing actual win-rate vs. anthropic-only
- Skill-decay behavior under production write rates

These should be measured once the api control-plane lands SQS-dispatch
and design partners run their playbooks. Pin this section as a TODO
when that traffic exists.

---

## Phase durations

Wall-clock from the build-loop history (single-session burst,
post-restart):

| Phase | What it was | Start | End | Duration |
|---|---|---|---|---|
| A | Foundations (ECS/ECR/SQS/Lambda/EFS/Supavisor/runtime) | 17:25 | 23:55 | ~6.5h |
| B | Tool surface (32 tools, ~6 sub-steps) | included in A.9 | included in A.9 | most landed during A |
| C | Provider routing + budgets | included | included | landed alongside |
| D | Skills + helpers + ratio | included | included | landed alongside |
| E | Multi-agent + scheduling | early E.4/E.5 | 04:00 | ~4h (most of E was already-done plumbing in earlier phases) |
| F | Deprecation + retro | 04:05 | 02:40 (next day) | ~22h with the followup work* |

*The ~22h F figure includes a long pause between F.2 and the F.3 bundle
(the build loop waited for a user prompt about deferred items). Active
time inside F was ~1h.

Phases bled into each other heavily because the per-step work in
Phases B–D (build a tool, register it, test it, bump the registry size
constant) was small and could be batched as the worker bundle was
already in flight in A. The phase boundary as written in
`BUILD-LOOP.md` was a planning convenience, not a real serial
dependency.

---

## Surprises that mattered

These are the ones a future operator should expect. Each cost time and
none were predicted by the spec.

### 1. `sst secret list` dumps every secret in plaintext

Listing SST secrets to figure out which were already set printed every
value to the transcript. Required a full rotation pass (Doppler →
Supabase service role → Anthropic key → Browserbase keys → JWT
secret). Memory captured: never run that command. Use
`sst secret get <Name>` for targeted reads, or list names via the
Pulumi state without values.

**Lesson:** treat any "list everything" command in IaC tooling as a
secret-exfil risk until proven otherwise. Same pattern likely applies
to `pulumi config` and `terraform output -json` — audit these before
the next migration.

### 2. ARM64 Fargate + corepack = exec-format-error during build

The first task definition was ARM64 (cheaper). The Dockerfile used
`corepack` to install pnpm; under QEMU the corepack binary failed
with "exec format error". Switching the task def + image to X86_64
fixed it. ARM64 Fargate with multi-arch images is doable, but
corepack inside QEMU is not.

**Lesson:** if the runtime container ships through Docker Buildx with
emulation, smoke-test the entrypoint before pushing the task def.
Cheaper-architecture choices are not free.

### 3. Distroless "no users found" on container init

The first runtime base was `oven/bun:distroless`. Container failed at
init because EFS mount + bubblewrap need a `nobody` user that
distroless doesn't ship. Switched to `oven/bun:1.1.38-alpine`.

**Lesson:** distroless is right for stateless API images, wrong for
anything with sandboxing, mount-as-user, or shell out to system
binaries. The worker has all three.

### 4. Supavisor pooler hostname is `aws-1-…`, not `aws-0-…`

The Supabase docs example showed `aws-0-us-east-2.pooler.supabase.com`.
For the `Basics` project the actual host was `aws-1-…`. Took a round of
"Tenant or user not found" errors to discover. The hostname is per-
tenant and isn't necessarily `-0`.

**Lesson:** always retrieve the pooler hostname from the project
dashboard (or the `mcp__supabase__get_project` MCP tool) instead of
copying from a generic example.

### 5. `Bun.serve` blocks process exit

The healthcheck server in `worker/src/main.ts` (`Bun.serve` listening
on :8080) kept the worker alive forever after `runOnce` finished.
Required explicit `health.stop()` + `process.exit(0)` in the cleanup
path. SQS visibility-timeout would have eventually surfaced this as
a stuck-task pile-up.

**Lesson:** any background server in a one-shot script must be
explicitly stopped, AND the process must explicitly exit. Don't trust
"node will exit when the event loop is empty" — a TCP listener keeps
it non-empty.

### 6. pnpm symlinks + Windows junctions break SST esbuild

The dispatcher Lambda fail-bundled with "Incorrect function" because
SST's esbuild followed pnpm's symlink graph through Windows
directory junctions. Workaround: tell SST `nodejs.install: ["…"]`
to install via npm into the bundle workdir instead of resolving
through `worker/node_modules`.

**Lesson:** pnpm + Windows + Pulumi-style asset packagers is a
known-problematic triangle. Either bundle on Linux/macOS in CI or use
the npm-install escape hatch.

### 7. `*/2` inside a JSDoc comment terminates the `/* */` block

A code sample showing a cron string inside a JSDoc comment included
the literal `*/`, which closed the comment block early and left the
rest of the comment as a syntax error. Trivial to fix once spotted,
costly to find. Affected `worker/src/eventbridge-scheduler.ts`.

**Lesson:** never paste raw cron expressions into block comments. Use
single-line `//` comments for crons, or escape the slash, or replace
with a placeholder.

### 8. Schema overlap with the existing API surface (A.5)

The plan called for a fresh `run_events`/`runs`/`run_steps`/`approvals`
schema. The existing api had `agent_runs`/`agent_run_steps`/
`pending_approvals`/`run_events` already in place. Three options:
(a) drop+rename, (b) shim layer, (c) adopt existing names + extend.
Chose (c). The plan-side names `run_events` → `agent_activity` was
folded back into the spec. This is the kind of conflict that's
invisible until you start writing migrations.

**Lesson:** at the start of any "fresh schema" migration, dump the
target database's existing tables and grep for collisions before
writing the migration. The pre-flight check is 5 minutes; the recovery
from doing it during step 5 is 30+ minutes.

### 9. EventBridge Scheduler needs a separate invoke role

E.4/E.5 shipped the wrapper + service code without provisioning the
`scheduler.amazonaws.com` trust role. The code worked in tests
(mocked wrapper) but couldn't actually fire a schedule against
production AWS. Caught + fixed in F.3a (when the user explicitly
asked about deferrals across phases). Without that question this
would have shipped as a latent gap.

**Lesson:** when a worker-side primitive depends on cloud trust + IAM
that lives in IaC, write the IaC slice in the same iteration as the
code. "Tests pass" + "code is merged" is not the bar for done.

### 10. `*/N` cron with non-divisor N gives uneven gaps

Not encountered in this migration but called out in the loop spec
itself: `*/7 * * * *` runs at :00, :07, …, :49, :56, then jumps to
:00 of the next hour with only a 4-minute gap. Documented as a future
trap for any operator scheduling something on an "every 7 minutes"
cadence.

---

## What we'd do differently next time

In rough order of expected payoff:

1. **Pre-flight schema diff.** Run a `list_tables` + grep for collision
   names against the migration's expected new names BEFORE the first
   step that touches DDL. Surprise #8 ate an iteration.
2. **Bake the IAM trust path into the same iteration as the worker
   code that consumes it.** Surprise #9. The Scheduler invoke role
   should have been step E.4, not F.3a.
3. **Run secret-list once on a throwaway transcript** to verify it
   doesn't dump values, before using it in a real session. Or just
   don't use list-style secret tooling.
4. **Test the entrypoint on the target architecture before bumping
   the task def revision.** Surprise #2.
5. **Use Linux CI for any Pulumi/SST bundle that includes pnpm
   workspaces.** Surprise #6 and the related "Incorrect function"
   spiral.
6. **Plan phases with parallelism explicitly, not as a chain.** B–D
   bled into A because the work was small and the worker bundle was
   already being built. Future plans should mark "can run alongside"
   explicitly so the loop can batch.
7. **Treat "verify only via unit tests" as half a verify.** Surprise
   #9 again. For anything that touches AWS / external services,
   verify against the real surface in the same iteration even if the
   reviewer cycle is skipped. The Supabase MCP + AWS CLI verify
   pattern that landed mid-build worked well; it should be the
   default from step 1.
8. **Don't paste cron strings into block comments.** Surprise #7.
9. **Document distroless vs. alpine choice with a one-line decision
   rule** in the project's container runbook: stateless API → distroless;
   anything with mount/sandbox/shell-out → alpine.
10. **Soak phases need a real "no traffic" check.** F.2 was a no-op
    because production has no users. With users, the soak observable
    must be a CloudWatch metric that exists before the soak starts —
    `legacy_runs_per_day` was specced but never wired (D.4 deferral).
    Wire metrics first, soak second.

---

## What stayed deferred (and why)

These are not bugs — they're work bounded out of the migration's scope.

- **Full v1 source-file deletion** (`agentLoop.ts` + `computerUseDispatcher.ts`).
  Blocked on api control-plane refactoring `POST /v1/runs` to dispatch
  via SQS. F.3 did the partial deletion (orphan tests). The full
  deletion is option (c) in the F.3 deviation note. The exact contract
  the api team needs is in `docs/HANDOFF_API_CLOUD_AGENT.md`.
- **`legacy_runs_per_day` CloudWatch metric.** Cosmetic given zero v1
  traffic; a real soak with users would need it.
- **api `/v1/schedules` HTTP routes.** Out-of-scope per
  CLOUD-AGENT-PLAN §0.1 (other team).
- **Default `runtime='v2'` for new workspaces in api.** Same reason.
- **Desktop client SSE consumer wiring.** Same reason.
- **7-day F.2 soak.** Skipped per stage policy; production has no
  users yet.

---

## Build-loop pattern review

The `/loop`-driven build worked. Specifically:

- Per-iteration history entries in `state.json` made it easy to resume
  after the secret-rotation pause without losing context.
- The "skipped reviewer cycle" pattern (recorded explicitly in each
  history entry's `reviewerVerdict`) kept the loop moving on
  small/orchestration steps without sacrificing audit trail.
- Live verification via Supabase MCP + AWS CLI — adopted mid-build —
  was strictly better than unit tests for anything cloud-side.
- The 60s minimum wakeup avoided burning the prompt cache; the
  no-staging-only-production policy avoided a stg→prod cutover dance
  that would have doubled deploy time for no operational benefit.

What didn't work as well:

- The "phase advances" stop condition in /loop was wrong for a
  multi-phase migration — captured in the
  `feedback_build_loop_dont_stop_on_phase_advance.md` memory.
- The plan called for a 7-day F.2 soak that, given no users, was
  a no-op — see "What we'd do differently" #10.
- F was specced as "deletion" but ended up bundling deferral cleanup
  + docs + retro. Future plans should split phase F more granularly
  if there's a known set of deferrals to sweep.

---

## Runbook updates

- Operator runbook should grow a "common traps" section that
  references the surprises numbered above. Suggested filename:
  `docs/RUNBOOK.md` (does not exist as of writing — F.5's spec
  mentions updating the runbook but the runbook is the next team's
  to author).
- Memory file `feedback_use_supabase_mcp_for_e2e.md` should be
  promoted into the runbook as the canonical "how to verify DB
  side-effects in production" pattern.

---

## Sign-off

Migration scope per CLOUD-AGENT-PLAN §0: 12 items, all shipped.
Production has no live users yet; all observable infra (cluster,
queue, EFS, scheduler role, SSE proxy) is verified end-to-end against
real AWS + Supabase. v1 source-file deletion is scoped as a
follow-up (option c in F.3 history). Loop self-pauses with
`completed: true` after F.5 lands.
