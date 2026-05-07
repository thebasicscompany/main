# Handoff: pick up at Phase 10.5 + 11

> Paste the contents below into a fresh Claude session to resume work.
> Phases 00–10 are all landed, 281 unit tests pass, deployed to AWS Fargate
> in production stage at the ALB DNS hostname listed below.
> Next: Phase 10.5 (EventBridge cron firing — small, technical) and
> Phase 11 (5 launch templates — content work, mostly hand-written
> playbooks). They are independent and parallelizable.

---

## You are continuing work on `basics-runtime`

**Project:** Cloud workflow runtime for B2B SaaS RevOps automation. Demonstrate-then-replicate pipeline:

1. User demonstrates a playbook (Salesforce report, CRM hygiene, etc.) — captured by the **Lens daemon** in `~/Developer/basics/basics-capture-v2/`.
2. Distillation pipeline (separate from runtime) turns demos into intent prompts.
3. **This runtime** executes those prompts in cloud Chromium via Browserbase, with live-view, take-over, approval gating, audit log, and outcome verification.
4. The **desktop Electron app** at `~/Developer/basics/desktop/` is the user-facing client (boring.notch pill + dashboard routes). Already shipping; runtime extends what's there.

Read first if you have not already:
- `~/Developer/basics/runtime/PROJECT.md`
- `~/Developer/basics/runtime/ARCHITECTURE.md`
- `~/Developer/basics/runtime/ROADMAP.md`
- `~/Developer/basics/runtime/docs/DESKTOP_INTEGRATION.md`

## Locked decisions (do NOT re-debate)

| Decision | Status |
|---|---|
| Backend: Node 22 + TypeScript + Hono on AWS Fargate | Locked |
| Package manager: pnpm 10.x with `pnpm-workspace.yaml` | Locked (we tried Bun runtime; reverted because of `chrome-remote-interface` issues) |
| Secrets: Doppler — project `backend`, configs `dev`/`stg`/`prd`. **SST secrets are SEPARATE** from Doppler — set via `sst secret set <Name> --stage <stage>` from Doppler values. | Locked |
| ORM: Drizzle (NOT Prisma, NOT TypeORM) | Locked. Multi-schema via `pgSchema('runtime')`, our migration tracker is `runtime.__drizzle_migrations` |
| LLM: raw `@anthropic-ai/sdk` (NOT Vercel AI SDK, NOT browser-use abstraction) | Locked. Computer-use is Anthropic-specific |
| Computer-use model: `claude-sonnet-4-5` + beta header `computer-use-2025-01-24` | Locked. `claude-sonnet-4-6` does NOT support `computer_20250124` (verified — API returns 400) |
| CDP client: `chrome-remote-interface` 0.34 with `local: true` | Locked. Without `local: true`, CRI hangs probing `/json/version` against Browserbase |
| Browser-level cookie injection uses `Storage.setCookies` (NOT `Network.setCookies`) | Locked. `Network.setCookies` is target-attached and fails on root client. Same for `DOMStorage.setDOMStorageItem` for localStorage. ARCHITECTURE.md still references the wrong methods — the code is canonical. |
| Voice infra (Deepgram STT/TTS, Gemini LLM proxy) lifted from `~/Developer/basics/agent/` | Locked. Don't import from `agent/` at runtime — code is duplicated/adapted in our `api/`. agent/ stays orphaned. |
| Approval surface: overlay-only (NO Slack adapter for v1) | Locked |
| Web dashboard: NONE for v1. Desktop app is the only client. | Locked |
| Naming: keep desktop's "agents" terminology in UI; runtime backend uses "workflow" + "run" | Locked, defer rename to v2 |
| Run status `paused_by_user` is distinct from `paused` (approval-pause) | Locked. Phase 08 chose this to match desktop's terminology in DESKTOP_INTEGRATION.md. |
| Take-over emits two SSE events: `takeover_started` and `takeover_ended` (not the single `takeover_active` ARCHITECTURE.md describes) | Locked. Mirrors existing `*_started`/`*_completed` pattern. ARCHITECTURE.md is stale here. |
| `public.workspaces.browserbase_profile_id` + `last_cookie_sync_at` REUSED for cookie sync — NO `runtime_contexts` table | Locked. ARCHITECTURE.md proposes runtime_contexts; that's stale. The HANDOFF supersedes. |
| Trust grants v1: created **only** via explicit `POST /v1/runtime/trust-grants` (or approval-resolve `remember=true`). The take-over post-resume hook emits `trust_grant_suggested` with `suggested_actions: []` — NO auto-grant writes. | Locked. CDP timeline access required for real suggestions; deferred to Phase 10+. |

## Where the code is

```
~/Developer/basics/runtime/
├── api/                                          ← Hono service (Node)
│   ├── src/
│   │   ├── index.ts                              ← @hono/node-server entrypoint
│   │   ├── app.ts                                ← Hono composition (mounts all routes)
│   │   ├── config.ts                             ← Zod env loader (validates GEMINI_API_KEY, NOT GOOGLE_GENERATIVE_AI_API_KEY)
│   │   ├── db/
│   │   │   ├── index.ts                          ← postgres-js + drizzle
│   │   │   ├── schema.ts                         ← pgSchema('runtime') with 7 tables (see Postgres state below)
│   │   │   └── workspaces.ts                     ← Drizzle binding for public.workspaces (kept OUTSIDE schema.ts so drizzle-kit never proposes ALTERs on the agent-owned table)
│   │   ├── lib/
│   │   │   ├── anthropic.ts                      ← computer-use SDK wrapper
│   │   │   ├── browserbase.ts                    ← raw fetch (no SDK dep) + createContext + createSessionWithContext
│   │   │   ├── contextSync.ts                    ← Phase 07 cookie/localStorage CDP injection (Storage.setCookies + DOMStorage.setDOMStorageItem)
│   │   │   ├── deepgram.ts, supabase.ts, jwt.ts, errors.ts
│   │   ├── middleware/
│   │   │   ├── jwt.ts                            ← requireWorkspaceJwt (HS256)
│   │   │   ├── approval.ts                       ← gateToolCall — internal middleware (writes audit row on create)
│   │   │   └── logger.ts, requestId.ts
│   │   ├── orchestrator/
│   │   │   ├── run.ts                            ← startRun + detached fiber, supports built-in (hello-world, agent-helloworld) AND DB-driven workflows
│   │   │   ├── runState.ts                       ← Drizzle-backed repo + memory repo, with list() for /v1/runtime/runs
│   │   │   ├── workflowsRepo.ts                  ← Phase 10 — workflows CRUD
│   │   │   ├── eventbus.ts                       ← in-memory pub/sub, RunEventType includes takeover_started/ended, trust_grant_suggested, check_started/completed
│   │   │   ├── auditWriter.ts                    ← Phase 05 — recordStepStart/end, recordToolCallStart/end, nextStepIndex/resetStepIndex
│   │   │   ├── approvalsRepo.ts                  ← Phase 04
│   │   │   ├── trustLedger.ts                    ← Phase 09 — extended with list/get/create/findMatching/revoke
│   │   │   ├── checkRunner.ts                    ← Phase 06 — runs scheduled checks, flips to verified|unverified|completed
│   │   │   ├── checkResultsRepo.ts               ← Phase 06
│   │   │   ├── workspaceContextRepo.ts           ← Phase 07 — for public.workspaces context columns
│   │   │   ├── takeoverSignal.ts                 ← Phase 08 — Promise-based gate per run
│   │   │   ├── computerUseDispatcher.ts          ← Anthropic actions → harness, writes audit rows
│   │   │   ├── agentLoop.ts                      ← raw SDK loop, audit-aware, takeover-aware, emits trust_grant_suggested on resume
│   │   │   └── workflows/
│   │   │       ├── helloWorld.ts                 ← non-LLM (navigate+screenshot)
│   │   │       └── agentHelloWorld.ts            ← LLM-driven (computer-use)
│   │   ├── checks/
│   │   │   ├── types.ts                          ← CheckContext, CheckResult, CheckFn, ScheduledCheck
│   │   │   ├── registry.ts                       ← Phase 10 — name → primitive mapping for DB workflows
│   │   │   └── primitives/
│   │   │       ├── url_contains.ts               ← real impl
│   │   │       ├── crm_field_equals.ts           ← stub (Phase 09 deps)
│   │   │       ├── record_count_changed.ts       ← stub
│   │   │       └── slack_message_posted.ts       ← stub
│   │   └── routes/
│   │       ├── auth.ts                           ← POST /v1/auth/token
│   │       ├── voice.ts                          ← POST /v1/voice/credentials
│   │       ├── llm.ts                            ← POST /v1/llm (Gemini SSE proxy)
│   │       ├── health.ts
│   │       ├── runs.ts                           ← POST /v1/runtime/runs, GET /:id, GET /:id/events (SSE), GET /:id/steps, GET /:id/tool-calls, ?include=steps,tool_calls, POST /:id/takeover, POST /:id/resume, POST /:id/approvals/:id/resolve
│   │       ├── contexts.ts                       ← Phase 07 — POST /v1/runtime/contexts/sync, GET /v1/runtime/contexts/me
│   │       ├── trust-grants.ts                   ← Phase 09 — GET/POST/DELETE /v1/runtime/trust-grants
│   │       └── workflows.ts                      ← Phase 10 — full CRUD + POST /:id/run-now
│   ├── drizzle/                                  ← migrations 0000, 0001 (check_results), 0002 (workflows)
│   ├── drizzle.config.ts
│   ├── Dockerfile                                ← node:22-alpine multi-stage
│   ├── tsconfig.json, tsconfig.build.json, vitest.config.ts
│   ├── staging-smoke.mjs                         ← cloud smoke against ALB URL (kept in repo)
│   └── package.json
├── harness/                                      ← TS port of browser-harness
│   ├── src/                                      ← helpers.ts, session.ts, types.ts, internal.ts, helpers.test.ts
│   └── reference/python-original/                ← do NOT delete
├── docs/
│   ├── DESKTOP_INTEGRATION.md
│   └── HANDOFF.md                                ← (this file)
├── infra/
│   └── README.md
├── sst.config.ts                                 ← Custom domain + ACM cert TEMPORARILY DISABLED for staging deploy (HTTP-only on ALB DNS). Re-enable when DNS cuts over.
├── pnpm-workspace.yaml, package.json, tsconfig.base.json, .env.example, .gitignore
└── PROJECT.md, ROADMAP.md, ARCHITECTURE.md
```

## Current Postgres state (Supabase, shared with agent/)

`runtime` schema has 7 tables, applied via Drizzle:
- `runtime_runs` — run lifecycle records
- `runtime_run_steps` — typed step events (kind: model_thinking | model_tool_use | tool_call | approval | check | user_takeover)
- `runtime_tool_calls` — every tool call (audit log)
- `runtime_approvals` — pending/approved/rejected/timeout
- `runtime_trust_grants` — auto-approve rules. **Schema is a superset of ROADMAP description**: has `created_at` (not `granted_at`), plus `revoked_at` + `revoked_by` for soft-delete.
- `runtime_check_results` — Phase 06
- `runtime_workflows` — Phase 10. Columns: id, workspace_id, name, prompt, schedule (cron string, nullable, NOT validated server-side), required_credentials jsonb, check_modules text[], enabled, created_at, updated_at. Index on `(workspace_id, enabled)`.

Migration tracker: `runtime.__drizzle_migrations` (3 entries: 0000_dashing_chamber, 0001_elite_sphinx, 0002_fine_thunderbolts). Agent/'s tracker `drizzle.__drizzle_migrations` is untouched.

`public.workspaces` already has `browserbase_profile_id` and `last_cookie_sync_at` columns from agent/ — Phase 07 reuses these.

## Active gotchas / lessons learned

1. **`chrome-remote-interface` MUST use `local: true`** when targeting Browserbase. Without it, CRI tries to fetch `/json/version` over HTTP from the wss host, which doesn't speak HTTP. Symptom: `socket hang up` (Node) or silent hang (Bun).
2. **`claude-sonnet-4-6` does NOT support computer-use.** Use `claude-sonnet-4-5` until Anthropic ships it on a newer Sonnet. Verify before bumping by checking Anthropic's API response.
3. **`@hono/node-server` 's default request timeout is fine for SSE** unlike Bun's 10s default. Don't preemptively configure it.
4. **In dev, the api needs `DATABASE_URL=$SUPABASE_DATABASE_URL`.** Doppler's default `DATABASE_URL` points at local Docker Postgres (port 5433) which doesn't have our `runtime` schema. Workaround in dev: `doppler run -- sh -c 'DATABASE_URL="$SUPABASE_DATABASE_URL" pnpm --filter @basics/api dev'`. Production uses SSM secrets so this is dev-only. **Same for migrations** — `pnpm db:migrate` against Supabase needs the same override.
5. **Workspace JWT shape:** the verifier requires `issued_at` AND `expires_at` as ISO-string claims (custom), in addition to standard `iat`/`exp` lifetime claims. See `api/src/lib/jwt.ts`.
6. **Run state:** in-memory eventbus replay buffer + Drizzle-backed runState repo. The fiber is fire-and-forget with `.catch()`; failures emit `run_failed` event + flip status to `failed`.
7. **CDP cookie injection** uses `Storage.setCookies` (browser-level, what Browserbase Contexts persist), NOT `Network.setCookies` (target-attached, "method not found" on root client). Same for `DOMStorage.setDOMStorageItem` for localStorage. **Caught in cloud smoke this session.**
8. **SST env var name must match `api/src/config.ts`'s Zod schema.** The schema validates `GEMINI_API_KEY`; SST originally injected `GOOGLE_GENERATIVE_AI_API_KEY`. Container exit-code-1 on every cold start. **Caught in cloud smoke this session.** The SST secret name remains `GoogleGenerativeAiApiKey` for legacy reasons but the `environment:` block in sst.config.ts maps it to `GEMINI_API_KEY`.
9. **EventBridge API destinations require HTTPS** (Phase 10.5). The current ALB listener is HTTP-only because the ACM cert is temporarily disabled (see deployment-state notes). Cron firing will fail until either (a) HTTPS is restored on the ALB, OR (b) the operator leaves `EVENTBRIDGE_API_DESTINATION_ARN` empty so the runtime stays in cron no-op mode. See `docs/CRON_DEPLOY.md`.
10. **Two-pass cron deploy** (Phase 10.5). The API destination ARN is circular w.r.t. `apiService.url` — first deploy creates the EventBridge resources, operator copies the output ARNs into env, second deploy injects them into the API task. In no-op mode (env vars empty) workflow rows can be created with schedules but no rules fire. See `docs/CRON_DEPLOY.md`.
11. **Schedule field uses AWS EventBridge syntax, not Linux cron** (Phase 10.5). Valid forms: `cron(min hour day month day-of-week year)` (six fields) or `rate(N unit)`. Bare 5-field cron strings like `0 9 * * 1` are now rejected at the route layer with a 400 (was previously stored unvalidated; tests adjusted accordingly).

## Deployment state

- **AWS account:** `635649352555` (root credentials — see security note below)
- **Region:** `us-east-1`
- **SST stage:** `production` (the only configured stage)
- **ALB DNS:** `http://RuntimeApiLoadB-bcrrshuc-339479703.us-east-1.elb.amazonaws.com` — HTTP only, no custom domain
- **Cluster:** `basics-runtime-production`
- **Service:** `basics-runtime-api-production` (ECS Fargate, 1 vCPU / 2 GB, arm64)
- **S3 bucket:** `basics-runtime-screenshots` (90-day TTL on objects)
- **VPC:** `vpc-0904f3df3b1b69970`
- **EventBridge cron firing (Phase 10.5):** infra in sst.config.ts (connection + API destination + IAM role + per-workflow rule prefix). Not yet deployed at time of writing — pending operator deploy round-trip + ACM cert restoration (HTTPS required for API destinations). See `docs/CRON_DEPLOY.md`. The placeholder `RuntimeWorkflowSchedulerRule` from Phase 10 has been removed.
- **Cost:** ~$50–80/mo standing (NAT $32, ALB $20, Fargate task ~$20). `sst remove --stage production` will **NOT** tear down — `removal: input?.stage === "production" ? "retain" : "remove"`. To actually remove: edit the config to flip retain→remove or use `pulumi destroy` directly.

**Disabled in current deploy** (sst.config.ts):
- ACM cert for `api.trybasics.ai`
- Custom domain on the ALB
- HTTPS listener (uses HTTP/80)

**To re-enable custom domain (Phase 12 cutover):**
1. Restore the ACM cert + cert-validation blocks in `sst.config.ts` (the comment block at line ~109 explains).
2. Restore `loadBalancer.ports[0]` to `listen: "443/https", cert: apiCertValidation.certificateArn`.
3. Restore the `domain: { name: "api.trybasics.ai", dns: false }` block.
4. Add the validation CNAME at Vercel when ACM emits it.
5. Re-deploy. Then flip Vercel's `api.trybasics.ai` CNAME from agent/'s ALB to runtime/'s.

**Security note:** AWS deploy used root credentials (`arn:aws:iam::635649352555:root`). This is bad practice — use a least-privilege IAM role for future deploys. Not blocking but flag for security follow-up.

## Boot a local dev API

```bash
cd ~/Developer/basics/runtime
doppler run --project backend --config dev -- sh -c 'DATABASE_URL="$SUPABASE_DATABASE_URL" pnpm --filter @basics/api dev'
```

Listens on `http://127.0.0.1:3001`. tsx-watch hot-reloads.

## Run the cloud smoke

```bash
cd ~/Developer/basics/runtime
URL="http://RuntimeApiLoadB-bcrrshuc-339479703.us-east-1.elb.amazonaws.com"
doppler run --project backend --config dev -- node api/staging-smoke.mjs "$URL"
```

This exercises phases 00–07 against deployed cloud infra. Real Browserbase, real Anthropic, real Supabase. Browserbase **free tier is exhausted** (we hit 402 mid-session in this session) — to get green on the cookie-injection step or to run `agent-helloworld`, upgrade Browserbase. The hello-world workflow uses ~1 browser minute and works inside what's left of free tier.

The smoke script does not currently probe Phase 09 / 10 endpoints — they're tested manually with curl in the smoke session but worth adding to `staging-smoke.mjs` if you re-run.

## Real test JWT (workspace from agent/'s Supabase)

```
workspace_id = 139e7cdc-7060-49c8-a04f-2afffddbd708
account_id   = aa9dd140-def8-4e8e-9955-4acc04e11fea
plan         = free
seat_status  = active
```

Mint with HS256, claims: `{ workspace_id, account_id, plan, seat_status, issued_at (ISO), expires_at (ISO) }`, signed with `WORKSPACE_JWT_SECRET` from Doppler dev. See `api/staging-smoke.mjs` for canonical mint code.

## Phase status (12 phases per ROADMAP)

| Phase | Status |
|---|---|
| 00 Scaffold | ✅ |
| 00.5 Doppler integration (Bun was tried + reverted) | ✅ |
| 01 First end-to-end run | ✅ |
| 02 Harness fork (TS port from Python) | ✅ |
| 03 Agent loop (raw Anthropic SDK + computer-use) | ✅ |
| 04 Approval gating (overlay-only) | ✅ — backend done; desktop wire is desktop-side work |
| 05 Audit log | ✅ — auditWriter, list/get endpoints, screenshots inline (S3 cutover deferred to 05.5) |
| 06 Check functions | ✅ — checkRunner, url_contains real + 3 stubs, verified/unverified terminal status |
| 07 Lens cookie sync | ✅ — runtime endpoint shipped, mirrors agent/'s `/v1/cookie-sync/upload` payload exactly so desktop is a one-line URL repoint |
| 08 Take-over UX | ✅ — pause gate + screenshot+resume turn injection, takeover/resume endpoints, `paused_by_user` status |
| 09 Trust ledger | ✅ — list/create/revoke endpoints, take-over `trust_grant_suggested` event hook (suggested_actions: [] for v1) |
| 10 Workflow library | ✅ — runtime_workflows table + CRUD + run-now, run.ts supports DB-driven workflows alongside built-ins |
| 10.5 EventBridge cron firing | ✅ — connection + API destination + IAM roles in sst.config.ts; per-workflow rule lifecycle in api/src/lib/eventbridge.ts; cron-secret auth on /run-now via api/src/middleware/cronAuth.ts. **Deploy round-trip not yet executed — see docs/CRON_DEPLOY.md.** No-op mode when EVENTBRIDGE_RULE_PREFIX is unset (dev/test default). |
| **11 First 5 launch templates** | parallel with 10.5 — content work, hand-written playbooks per strategy memo |
| 12 Design partner onboarding | sequential after 11 — operational |

## Test count baseline

```bash
cd ~/Developer/basics/runtime
pnpm typecheck    # both api + harness must be clean
pnpm test         # 281 api tests + 67 harness tests, all green
```

If you add tests, the new baseline is `previous + your_count`.

---

## YOUR TASK: Phase 10.5 + Phase 11 in parallel

### Phase 10.5 — EventBridge cron firing

**Goal:** workflows with `schedule` set actually fire. Today the column is stored but EventBridge wiring is stubbed. Per the comment block in `sst.config.ts` near `RuntimeWorkflowSchedulerRule`:
1. Replace the static placeholder rule with a per-workflow rule managed dynamically.
2. Target the API's `POST /v1/runtime/workflows/:id/run-now` via EventBridge **API destination** (not direct invoke — API destinations call HTTPS endpoints).
3. IAM role for EventBridge to call the ALB endpoint with a workspace JWT (mint a service-account JWT, or use a separate cron-only auth header that bypasses the workspace-JWT requirement for cron-fired calls).
4. **Lifecycle hook**: when a workflow row's `schedule` is PATCHed, create/update/delete the corresponding EventBridge rule. When the workflow is deleted, remove the rule.

This is mostly SST + IAM work. Most of the runtime code is already in place; the missing piece is the bridge between "workflow has a cron string" and "EventBridge fires the API call."

**Read first:**
- `sst.config.ts` — the placeholder block at the bottom
- `api/src/routes/workflows.ts` — the run-now endpoint
- `api/src/orchestrator/run.ts` — `resolveWorkflow` is the integration point
- ARCHITECTURE.md — the cron-firing flow

**Open question to flag for the user before writing code:** how should EventBridge authenticate to the ALB? Options:
- (a) Service-account JWT minted at startup, embedded in the EventBridge target's HTTP headers (simplest, but JWT lifetime is 24h — needs rotation).
- (b) A separate `RUNTIME_CRON_SECRET` env var checked by the run-now endpoint when called by EventBridge (header-based bypass; simpler but bypasses workspace-JWT semantics).
- (c) Per-workspace cron tokens stored in a new table.

Recommend (b) for simplicity. Get user signoff before implementing.

### Phase 11 — First 5 launch templates

**Goal:** five hand-written workflow rows demonstrating the strategy memo's 5 wedge use cases:
1. Weekly RevOps digest
2. New-deal account research
3. Renewal risk monitor
4. CRM hygiene
5. Quarterly board metrics

**Each template:** workflow row with `name`, `prompt`, `schedule` (cron), `required_credentials` shape, `check_modules` array. Two of these get tuned with the first design partner's data; three are scaffolded. Per ROADMAP this is content work, not code — write the prompts, decide the credential shapes, decide the check primitives.

**Read first:**
- `~/Developer/basics/runtime/PROJECT.md` strategy section
- `~/Developer/basics/runtime/ROADMAP.md` Phase 11 description
- The 5 use cases in the strategy memo (if accessible) — otherwise infer from `PROJECT.md`
- Existing `runtime_workflows` schema for column shapes
- `api/src/checks/primitives/` for what check_modules are available (just `url_contains` is real today; the others are stubs that return `{ passed: false, evidence: {reason: 'not implemented'} }` — Phase 11 templates can reference them but they'll fail until Phase 09 deps land)

**Deliverable:** a `seeds/` directory or migration that inserts the 5 workflow rows for the test workspace, plus markdown describing each template's intent + how a partner customizes it.

### Constraints for both streams

- **Both run as background `general-purpose` agents in a single message** so they run in parallel.
- **Don't modify** anything in `desktop/`, `agent/`, `basics-capture-v2/`, `reference/`. Runtime-only.
- **Don't break existing tests.** All ~281 api + 67 harness tests must still pass.
- **Don't deploy** without explicit user signoff. SST changes (Phase 10.5) need a deploy round-trip to verify.
- Use the **Doppler-wrapped scripts** for any DB operations (`pnpm db:generate`, `pnpm db:migrate`, `pnpm test`).

### Verification before declaring each stream done

```bash
cd ~/Developer/basics/runtime
pnpm typecheck                                          # must be clean
pnpm test                                               # 281 + new tests
doppler run --project backend --config dev -- sh -c 'DATABASE_URL="$SUPABASE_DATABASE_URL" pnpm --filter @basics/api db:migrate'   # idempotent if any migration added
```

For Phase 10.5: a manual test where you `pnpm db:migrate`, create a workflow with `schedule: 'cron(* * * * ? *)'`, deploy, observe a fired run within 1 minute. Document the IAM permissions added.

For Phase 11: `seeds/seed.ts` (or equivalent) inserts the 5 templates. Manually run, then `GET /v1/runtime/workflows` returns all 5.

---

## When you finish 10.5 + 11

Phase 12 (design partner onboarding) is operational, not technical. The runtime is essentially feature-complete for v1 once 10.5 + 11 land. The remaining tech-debt items:

- **Browserbase quota:** free tier is exhausted. Upgrade or expect cookie-sync injection + agent-helloworld runs to 402.
- **AWS root credentials:** swap to least-privilege IAM role.
- **Custom domain:** restore `api.trybasics.ai` cert + listener when ready to cut DNS over from agent/.
- **Phase 05.5:** S3 cutover for screenshots (currently inline base64 in tool_calls.result and SSE).
- **agent-helloworld smoke:** the smoke doesn't auto-resolve approvals, so the LLM-driven workflow hangs. Either auto-approve in smoke OR connect a real client (overlay/dashboard).
- **Anthropic API key rotation** for production.
- **ARCHITECTURE.md staleness:** several sections describe behaviors that the locked decisions table has since superseded (e.g. `Storage.setStorageItems`, single `takeover_active` event, `runtime_contexts` table). Worth a docs pass before onboarding partners.
