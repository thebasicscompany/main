# Handoff: Phase 10.5 → 11 → 11.5 (browser-based checks) shipped

> Pick up here. The 12-phase roadmap is technically complete and live in
> production at `https://api.trybasics.ai`. This doc captures everything
> that landed in the most recent session, what to test, and the followups
> the next engineer should triage before the first design partner.

## TL;DR

| What | Status |
|---|---|
| Phase 10.5 — EventBridge cron firing | ✅ live |
| Phase 11 — 5 launch templates seeded | ✅ live in test workspace |
| Phase 11.5 — browser-based check primitives | ✅ live |
| Bug: runs created with `workflow_id = 'unknown'` | ✅ fixed |
| Old `agent/` AWS stack | ✅ fully torn down |
| DNS cutover at Vercel | ✅ flipped, propagated |
| Tests | 363 api + 67 harness, all green |
| Production URL | `https://api.trybasics.ai` (HTTPS, ACM cert valid through Nov 2026) |

## Production state

- **AWS account:** `635649352555` (still root creds — see followups)
- **Region:** `us-east-1`, stage `production`
- **Cluster / Service:** `basics-runtime-production` / `basics-runtime-api-production`
- **ALB DNS (CNAME target):** `RuntimeApiLoadB-bcrrshuc-339479703.us-east-1.elb.amazonaws.com`
- **Custom domain:** `api.trybasics.ai` — ACM cert + ALB listener at 443/HTTPS, Vercel CNAME points at the ALB
- **EventBridge:** API destination + connection + invoker role provisioned. Per-workflow rules created at runtime by the API process. ARNs:
  - `EVENTBRIDGE_API_DESTINATION_ARN=arn:aws:events:us-east-1:635649352555:api-destination/runtime-cron-runnow-production/fed1a05e-d5f8-4c94-8563-10550f4a651d`
  - `EVENTBRIDGE_TARGET_ROLE_ARN=arn:aws:iam::635649352555:role/runtime-cron-invoker-production`
  - These must be set as env vars at deploy time (see "Two-pass deploy" gotcha below)
- **Secrets set via SST:**
  - `RuntimeCronSecret` (random hex, used in EventBridge X-Cron-Secret header)
  - All other Phase 0–10 secrets unchanged

## What landed this session (file-level diff against the prior handoff)

### Phase 10.5 — EventBridge cron firing

Branch deploy of the previous parallel agent's work, end-to-end verified live.

- `api/src/lib/eventbridge.ts` — `upsertWorkflowSchedule(workflow)` / `deleteWorkflowSchedule(workflowId)` / `validateScheduleExpression(...)`. No-ops when `EVENTBRIDGE_RULE_PREFIX` env var is unset (dev/test).
- `api/src/middleware/cronAuth.ts` — `requireCronOrWorkspaceJwt`. Accepts a workspace JWT OR an `X-Cron-Secret` header. Cron path resolves `workspace_id` from the workflow row.
- `api/src/routes/workflows.ts` — schedule validation via `superRefine`, lifecycle hooks (create→upsert, patch→upsert, delete→delete), run-now uses the new auth middleware.
- `api/src/orchestrator/workflowsRepo.ts` — `getById(workflowId)` for cron lookup.
- `api/src/app.ts` — removed prefix-wide JWT guard on `/v1/runtime/workflows/*`; per-route auth now. Added `X-Cron-Secret` to CORS.
- `sst.config.ts` — replaced placeholder rule with EventBridge connection + API destination + invoker role + task-role policy + cron secret.
- `docs/CRON_DEPLOY.md` — deploy round-trip recipe.

### Phase 11 — 5 launch templates

- `api/seeds/templates/{weekly-revops-digest,new-deal-account-research,renewal-risk-monitor,crm-hygiene,quarterly-board-metrics}.ts`
- `api/seeds/templates/{types,index}.ts`
- `api/seeds/seed.ts` — idempotent CLI seeder, upserts by `(workspace_id, name)`. Default workspace overridable via `SEED_WORKSPACE_ID`.
- `api/seeds/README.md`
- `api/src/seeds-templates.test.ts` — 22 shape tests asserting each template is assignable to `NewWorkflow`.
- `api/package.json` — `seed:templates` script wired.
- `api/tsconfig.json` — `seeds/**/*.ts` included for typecheck; `tsconfig.build.json` excludes `seeds` from the production bundle.

### Phase 11.5 — browser-based check primitives (this session's biggest piece)

Three "not implemented" stubs replaced with real implementations that navigate within the agent's authenticated Browserbase session via Phase 07 cookie sync. **No new env vars / API tokens** — all auth via Chrome cookies.

- `api/src/checks/types.ts` — `CheckContext.session?: CdpSession` and `CheckContext.workflowId?: string` added.
- `api/src/checks/primitives/crm_field_equals.ts` — opens new tab, navigates to record URL, reads selector text, compares against `expected` (string or `{regex}`).
- `api/src/checks/primitives/record_count_changed.ts` — same browser flow, parses count via selector, queries prior `runtime_check_results` rows for baseline scoped to `(workspace_id, workflow_id, check_name)`, supports `expectChange: 'increase'|'decrease'|'any'` + `minDelta`.
- `api/src/checks/primitives/slack_message_posted.ts` — navigates `https://slack.com/archives/{channel}`, detects auth (final URL heuristic), waits 5s for SPA hydration, reads `document.body.innerText`, substring-matches.
- `api/src/checks/registry.ts` — reads per-check `params` from the new workflow row shape.
- `api/src/orchestrator/checkRunner.ts` — `RunChecksInput` now carries `session` and `workflowId`; passes through into `CheckContext`.
- `api/src/orchestrator/run.ts` — `runFiber` passes `session` + `workflowId` into `runChecks(...)` (called BEFORE `detach`/`stopBrowserbaseSession` in the lifecycle).
- Test files added: `api/src/checks/primitives/{crm_field_equals,record_count_changed,slack_message_posted}.test.ts` — mock `CdpSession` + harness, cover pass/fail/timeout/no-session paths.

### Schema migration: `runtime_workflows.check_modules` → JSONB

- `api/drizzle/0003_rainy_the_fallen.sql` — hand-edited (Drizzle's auto-output drops names without backfill). Idempotent. Adds `check_modules_v2 jsonb`, backfills from `text[]`, drops old, renames new.
- `api/src/db/schema.ts` — `checkModules: jsonb('check_modules').$type<{name: string, params: Record<string, unknown>}[]>()`
- `api/src/routes/workflows.ts` — route schema accepts the new entry shape.
- All 5 seeded templates updated with concrete `params` (TODO placeholders for partner-specific values).

### Bug fix: `runs.workflow_id` was hard-coded `'unknown'`

Pre-existing bug. Found while verifying cron firing — `GET /v1/runtime/runs?workflow_id=X` always returned empty.

- `api/src/orchestrator/runState.ts` — added `workflowId` to `RunRecord`, plumbed through `register`, `update`, `rowToRecord`, both memory and Drizzle impls. Memory `list()` filter now honors `workflowId`.
- `api/src/orchestrator/run.ts:191` — `register({ ..., workflowId: resolved.id })`.
- `api/src/routes/runs.ts` — exposes `workflow_id` in list + snapshot responses.
- 30 test fixtures updated.

**Pre-existing runs (created before this fix) still have `workflow_id = 'unknown'`.** Backfill SQL if you care about historical filterability — see followups.

## What to test

### 1. Smoke

```bash
curl https://api.trybasics.ai/health
# expects: {"ok":true,"ts":"..."}
```

### 2. Full smoke (Phase 00–08 against deployed cloud)

```bash
cd ~/Developer/basics/runtime
doppler run --project backend --config dev -- \
  node api/staging-smoke.mjs https://api.trybasics.ai
```

Browserbase quota is now paid tier — full suite should run including the cookie-injection step that previously 402'd.

### 3. Cron firing end-to-end

(The cron-verify script was deleted at session end — re-create as needed, or use the canonical recipe.)

```bash
# Mint workspace JWT (same pattern as staging-smoke.mjs)
TOKEN=...

# Create a test workflow with every-minute schedule
curl -X POST https://api.trybasics.ai/v1/runtime/workflows \
  -H "X-Workspace-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"cron-test","prompt":"Navigate to https://example.com","schedule":"cron(* * * * ? *)","required_credentials":{},"check_modules":[],"enabled":true}'
# capture the returned id

# Verify EventBridge rule was created
aws events describe-rule --name "runtime-workflow-production-<id>"
# expects: state=ENABLED, ScheduleExpression=cron(* * * * ? *)

# Wait 1-2 min, query runs
curl -H "X-Workspace-Token: $TOKEN" \
  "https://api.trybasics.ai/v1/runtime/runs?workflow_id=<id>"
# expects: at least one run with trigger=cron (in DB; trigger field not in response shape today, but workflow_id will be)

# DELETE workflow
curl -X DELETE -H "X-Workspace-Token: $TOKEN" \
  https://api.trybasics.ai/v1/runtime/workflows/<id>

# Confirm rule deleted
aws events describe-rule --name "runtime-workflow-production-<id>"
# expects: ResourceNotFoundException
```

End-to-end was verified live this session — fired in 122s, run record retrievable via `?workflow_id=` filter.

### 4. Browser-based check primitives

Each primitive needs a workflow that:
- Has a `prompt` directing the agent to do something verifiable
- Has `check_modules` referencing the primitive with concrete params

The seeded templates have TODO placeholders. To fully test against a real partner CRM:

1. Pick the simplest template (`new-deal-account-research`) and tune its `check_modules[0].params` to a live Salesforce/HubSpot Lightning URL + a stable selector.
2. Trigger via `POST /v1/runtime/workflows/:id/run-now` (workspace JWT auth, manual trigger).
3. Watch the run via SSE: `GET /v1/runtime/runs/:id/events`. You'll see `tool_call_started`/`completed` for the agent, then `check_started`/`completed` events.
4. Inspect `runtime_check_results` for evidence rows (`SELECT * FROM runtime.runtime_check_results WHERE run_id = ...`).

A check evidence row looks like:
```json
{
  "url": "https://...",
  "selector": "[data-aura-class='...']",
  "actual": "Closed Won",
  "expected": "Closed Won",
  "matched": true,
  "timing_ms": 4231
}
```

For `slack_message_posted`, the partner needs to be logged into Slack web in the Chrome instance whose cookies are synced via Phase 07. The check navigates to `slack.com/archives/{channel}` and relies on the cookies for auth.

### 5. Template inventory

```bash
curl -H "X-Workspace-Token: $TOKEN" https://api.trybasics.ai/v1/runtime/workflows
# expects: 5 workflows in test workspace 139e7cdc-7060-49c8-a04f-2afffddbd708
```

Template ids:
- Weekly RevOps Digest: `73e42d0c-fc7e-4873-a422-d3d190cc2ff6`
- New-Deal Account Research: `1e63bcf8-7854-4213-ba25-a152b39163ce`
- Renewal Risk Monitor: `48c3f424-8c64-42c5-b549-5c261bfa7019`
- CRM Hygiene Sweep: `18b84ff7-0653-43a4-9c55-b9a25dad87c3`
- Quarterly Board Metrics: `4f7ed9db-6a50-4580-8043-3ba8f3f4c48f`

## Active gotchas (NEW or UPDATED this session)

1. **SST cache-export must be disabled.** `pnpm sst deploy` hangs silently on slow ECR uploads when buildkit's `cacheTo` is set to `mode: "max"`. We patched `.sst/platform/src/components/aws/fargate.ts:1063` to `cacheTo: []`. **This patch lives in a generated SST artifact and gets clobbered by `sst update` or `pnpm install` on a fresh checkout.** If a deploy hangs at "exporting cache to registry", re-apply the patch:
   ```diff
   -              cacheTo: [
   -                {
   -                  registry: {
   -                    ref: interpolate`${bootstrapData.assetEcrUrl}:${container.name}-cache`,
   -                    imageManifest: true,
   -                    ociMediaTypes: true,
   -                    mode: "max",
   -                  },
   -                },
   -              ],
   +              cacheTo: [],
   ```
   Worth a feature request to SST for an option to disable cache export (or moving to a vendored config).

2. **Two-pass deploy.** Phase 10.5's EventBridge ARNs are circular w.r.t. `apiService.url` — first deploy creates connection/destination/role and outputs ARNs, second deploy injects them as env vars on the API task. Documented in `docs/CRON_DEPLOY.md`. Routine deploys should pass them via env (the `pnpm sst deploy` command in this session prefixed both `EVENTBRIDGE_API_DESTINATION_ARN` and `EVENTBRIDGE_TARGET_ROLE_ARN`).

3. **`required_credentials` schema is `z.record(z.string(), z.unknown())`** — partner credentials shape is `{ providers: [...] }` (object), not `[...]` (array). The seeded templates use the right shape; manual API consumers (curl) frequently get this wrong.

4. **`agent/` AWS stack is fully torn down.** All Lambdas, API Gateway, VPC, NAT, ECR, IAM roles, log groups, ACM cert (agent's), EventBridge schedules — gone. The stack files in `~/Developer/basics/agent/` still exist as a code copy. The `removal: "remove"` flag in `agent/sst.config.ts` was edited from `"retain"` for this teardown — uncommitted.

5. **agent's S3 buckets retained** (BasicsBrainArchive, BasicsDeployments) — they had data in them. Manually empty + delete if you want them gone. Cost is negligible.

6. **`runtime_runs` rows from before the workflow_id fix have `workflow_id = 'unknown'`**. New runs get the real ID. To backfill historical rows, you'd need to correlate by Browserbase session timestamp or just leave them be.

## Followups for the next engineer

Roughly ordered by priority:

### Before first design partner

1. **Tune the 5 templates with partner data.** Each has `TODO_*` placeholders for Salesforce report URLs, Slack channel ids, KPI selectors. Replace with real values once the partner is identified.
2. **ARCHITECTURE.md staleness pass.** Several sections describe behaviors superseded by locked decisions (`Storage.setStorageItems`, single `takeover_active` event, `runtime_contexts` table). Audit + rewrite.
3. **Soft-delete for workflows.** Currently `DELETE /v1/runtime/workflows/:id` is a hard delete. The `runs.workflow_id` text reference becomes a dangling pointer. Add `deleted_at` column + tombstone, exclude from list/get by default.
4. **Backfill `runtime_runs.workflow_id = 'unknown'`** if historical run filtering matters. Otherwise leave.

### Operational hygiene

5. **AWS root credentials.** All deploys this session and prior used `arn:aws:iam::635649352555:root`. Switch to a least-privilege IAM role (probably `basics-runtime-deployer`) before onboarding contractors.
6. **SST cacheTo patch.** Either:
   - Vendor the SST `fargate.ts` change as a post-install script
   - Open a feature request for an `image.cacheTo: 'none'` option
   - Switch to building images outside SST and passing the image tag in
7. **Phase 05.5 — S3 cutover for screenshots.** Today screenshots are inline base64 in `tool_calls.result` and SSE events. Move to S3 (`basics-runtime-screenshots` bucket already exists with 90-day TTL).
8. **Anthropic API key rotation.** Set fresh keys in Doppler + SST secrets, then redeploy.

### Code quality

9. **`agent-helloworld` smoke** doesn't auto-resolve approvals, so the LLM-driven workflow hangs at the approval gate. Either auto-approve in smoke OR connect a real overlay client during smoke.
10. **Schedule validation is permissive.** `cron(99 99 99 99 99 99)` passes the route validator but fails at `events:PutRule`. Either tighten the regex or accept this as fail-fast at deploy time.
11. **Stale `EVENTBRIDGE_API_DESTINATION_ARN` documentation in `sst.config.ts`** — comments still mention "FAIL on PutTargets" because of HTTP-only — outdated, we have HTTPS now. Cosmetic.
12. **Phase 11 README links** in `api/seeds/README.md` reference primitives that are now real (not stubs). Update the "real today vs stubbed" table.
13. **The `cron-verify.mjs` test script** lived inside `api/` for a moment — was deleted at session end. If the team wants ongoing cron verification, add it to `staging-smoke.mjs` instead.

### Git state

14. **The repo has zero commits.** Everything is untracked. Worth a one-time `git add -A && git commit -m "Initial runtime drop"` or a more granular commit history before partner onboarding. The previous handoff also flagged this.

## Boot a local dev API

```bash
cd ~/Developer/basics/runtime
doppler run --project backend --config dev -- sh -c \
  'DATABASE_URL="$SUPABASE_DATABASE_URL" pnpm --filter @basics/api dev'
```

Listens on `http://127.0.0.1:3001`. tsx watches for changes.

## Re-deploy

```bash
cd ~/Developer/basics/runtime
EVENTBRIDGE_API_DESTINATION_ARN="arn:aws:events:us-east-1:635649352555:api-destination/runtime-cron-runnow-production/fed1a05e-d5f8-4c94-8563-10550f4a651d" \
EVENTBRIDGE_TARGET_ROLE_ARN="arn:aws:iam::635649352555:role/runtime-cron-invoker-production" \
pnpm sst deploy --stage production
```

Verify the cacheTo patch is in place first (see gotcha #1) — otherwise the deploy hangs at "exporting cache to registry."
