# Desktop ↔ Runtime Integration Plan

> How the existing `desktop/` Electron app becomes the user-facing client of `basics-runtime`.
> Status: planning doc, not a contract yet. Phases 03+ implement what's mapped here.

## Mental model

The runtime repo (`/Users/aravb/Developer/basics/runtime/`) is the **cloud workflow execution backend**: Hono on Fargate, Browserbase-hosted Chromes, an audit log, an approval middleware, a check-function runner, and a Next.js web dashboard. Its `PROJECT.md` declares "Desktop pill integration" as v2 (line 70) and assumes a web-only client for v1. The strategy memo treats the desktop pill as the v2 differentiator.

The desktop repo (`/Users/aravb/Developer/basics/desktop/`) is the **already-shipped, fully-built Electron app**: a boring.notch-style pill overlay, a TanStack Router dashboard, a voice/Lens-aware overlay surface store, and a typed IPC registry that already speaks to the existing `agent/` cloud backend (see `agents:list-approvals` / `agents:decide-approval` in `src/features/agents/shared/channels.ts:319-329`). Its `WIRING.md` uses outdated terminology ("Phase 2 — Backend + real auth") — by 2026-05 the agent-runs path is in fact wired to a real backend with Supabase Realtime and Browserbase live-view (see `src/renderer/src/features/agents/components/tabs/activity-tab.tsx:144-148`).

**Position for v1 of runtime:** the desktop is *not* the only client — the Next.js dashboard at `app.trybasics.ai` ships first per `runtime/PROJECT.md` and `runtime/ROADMAP.md`. Desktop is the **second client we add**, taking advantage of three things that are already there: (a) the workspace-JWT gateway client at `src/main/gateway/`, (b) the overlay's approval prompt scaffolding at `src/renderer/src/overlay/overlay-surface-store.ts:252-273`, and (c) the Lens daemon HTTP client at `src/main/lens/`. Voice and Lens stay desktop-resident; runtime concerns (workflows, runs, approvals, contexts, take-over, trust ledger) get a new IPC namespace and a repointed gateway base URL.

**The terminology gap is real.** Runtime says "workflow + run + tool call + audit". Desktop says "agent + agent_run + agent_run_step + activity". They map cleanly enough that we should not rename either side in v1; instead, the runtime API exposes runtime-shaped names server-side and the desktop reads through a translator at the IPC seam.

## Concept mapping

| runtime concept | desktop concept | location | status |
|---|---|---|---|
| `runtime_workflow` (`runtime/ARCHITECTURE.md:253-264`) | `cloud_agents` row + `CloudAgent` type | `desktop/src/features/agents/shared/channels.ts:43-72` | extends — desktop has richer `identity_context` + `runtime_mode`; runtime workflow lacks those today |
| `runtime_run` (`ARCHITECTURE.md:267-284`) | `agent_runs` row + `AgentRun` type | `desktop/src/features/agents/shared/channels.ts:78-99` | matches — both carry `status`, `started_at`, `completed_at`, `live_view_url`, `browserbase_session_id`. Status enum differs (see Naming reconciliation) |
| `runtime_tool_calls` (audit log) | `agent_run_steps.kind='tool_execution'` + `agent_activity` rows | `desktop/src/features/agents/shared/channels.ts:191-208`, `216-227` | matches — both carry `params`/`payload`, `result`, screenshot key, latency. Runtime adds `cost_cents`, `screenshot_s3_key`, `approval_id`/`trust_grant_id` FKs |
| `runtime_approvals` | `pending_approvals` (already in agent backend) + `PendingApproval` | `desktop/src/features/agents/shared/channels.ts:251-266` | matches — both poll today (`agents:list-approvals` channel polled at 3s, `desktop/src/features/agents/main/ipc.ts:48-49`); both decide via `:id/decide` |
| `runtime_trust_grants` | none | — | **new** — desktop has zero "auto-approve this action with these params" UX. Phase 09 ships both backend + dashboard UI; desktop wiring lands later (see Open questions) |
| `runtime_check_results` | `agent_run_steps.check_passed` / `check_evidence` / `check_confidence` | `desktop/src/features/agents/shared/channels.ts:204-208` | matches — desktop already exposes per-step check fields; runtime's check function runner just needs to write into them (or runtime keeps a separate `runtime_check_results` table and we project) |
| `runtime_contexts` (Browserbase Context ID per workspace) | `chrome-import` profile → `profileId` on workspace | `desktop/src/main/gateway/client.ts:842-900`, `src/features/chrome-import/shared/channels.ts:19-66` | extends — the desktop already extracts cookies via headless Chrome + CDP and uploads to `agent/`'s `/v1/cookie-sync/upload`. Phase 07 of runtime is mostly: switch the upload endpoint to `/v1/runtime/contexts/sync` |
| Live-view iframe (`liveUrl`) | `RunLiveView` component embedding Browserbase debugger URL | `desktop/src/renderer/src/features/agents/components/tabs/run-live-view.tsx` | matches — desktop already iframes the Browserbase live-view inside the agent detail page |
| Take-over toggle (`POST /v1/runtime/runs/:id/takeover`) | `RunTakeOver` component → `agents:pause-run` / `agents:resume-run` | `desktop/src/renderer/src/features/agents/components/tabs/run-take-over.tsx` | matches — desktop already pauses/resumes runs; the iframe flips to interactive once Browserbase releases CDP. Runtime needs the same `POST /v1/runtime/runs/:id/{pause,resume}` endpoints |
| Approval prompt (overlay or dashboard) | `OverlayPrompt` with `kind: 'agent-approval'` | `desktop/src/renderer/src/overlay/overlay-surface-store.ts:252-273`, `OVERLAY_CHANNELS.enqueueAgentApproval` event | matches — overlay already has full approval-pill scaffolding with Approve/Reject buttons that POST `/v1/approvals/:id/decide` |
| Audit log surface | `/agents/$agentId` Activity tab + `agent_run_steps` Realtime subscription | `desktop/src/renderer/src/features/agents/hooks/use-agents-query.ts:151-189` | matches — desktop already streams steps via Supabase Realtime. Runtime audit log just needs to surface in the same tabular shape |
| Lens cookie sync | `chrome-import:run-sync` IPC + headless-Chrome CDP extractor | `desktop/src/main/chrome-import/cookies.ts:1-50` | extends — extractor exists today and ships cookies to `agent/`. **Important:** runtime ROADMAP P07 says the extractor lives in `basics-capture-v2/daemon/` (Rust). Desktop's existing TS extractor is a parallel path; we should pick one (see Open questions) |
| Voice credentials (`voiceCredentials`) | `OverlayVoiceChannels.credentialsRequest` invoke + Deepgram WSS | `desktop/src/features/overlay/shared/channels.ts:69-75, 176-187` | unchanged — voice stays a desktop+`agent/` concern, runtime is not in the voice path |
| Workflow library / scheduler UI | partial — agent detail page Settings tab + run-now button | `desktop/src/renderer/src/features/agents/components/tabs/settings-tab.tsx` | extends — runtime Phase 10 ships a workflow library; desktop already has agent grid + manual create flow. Cron schedule editor is the gap |

## API contracts (initial sketch)

The runtime's API mounts at `api.trybasics.ai/v1/runtime/*` (per `runtime/PROJECT.md:20`). Today's `agent/` API mounts at `api.trybasics.ai/v1/*` and the desktop hits it via `process.env.BASICS_API_URL` (`desktop/src/main/startup-env.ts:11`, `src/main/index.ts:222`). Both surfaces share the workspace JWT (`X-Workspace-Token` header) issued by `agent/`'s `/v1/auth/token`. Switching the desktop to runtime is a **per-endpoint repoint**, not a base-URL flip — the desktop will hit both surfaces simultaneously during transition.

The desktop's gateway client is `desktop/src/main/gateway/client.ts` (~1000 LOC). It already encapsulates the patterns runtime needs:
- Workspace-JWT injection on every call (`authHeaders` at line 80)
- 401 → mint-retry once (the `Auth401` GatewayFailure tag + retry path)
- SSE consumption with `SSEParser` for streaming responses
- Layer-0 egress guard that asserts no capture-tier fields leak to the wire (`assertNoCaptureFields`)
- PII redact/restore for chat-style streams

Adding runtime endpoints means adding new functions to this client (or a new sibling client `runtime-client.ts`); the typed-IPC registry pattern means each function is a few lines and a Zod schema.

| Endpoint | Method | Purpose | Status |
|---|---|---|---|
| `/v1/auth/token` | POST | Mint workspace JWT from Supabase access token | ALREADY-LIFTED (lives in `agent/`, runtime is a verifier per `runtime/PROJECT.md:33`) |
| `/v1/llm/*` | GET (SSE) | Voice + chat streaming | ALREADY-LIFTED (stays in `agent/`) |
| `/v1/agents/*`, `/v1/agent-runs/*`, `/v1/agent-runs/:id/{pause,resume}`, `/v1/approvals`, `/v1/approvals/:id/decide` | various | Today's agents-runtime path | ALREADY-LIFTED in `agent/`. Runtime Phase 03 stands these up under `/v1/runtime/*` for the dashboard; desktop continues to read from `agent/` until Phase 13+ migration |
| `/v1/runtime/health` | GET | Liveness | PHASE_00 |
| `/v1/runtime/runs` | POST | Trigger a manual run | PHASE_01, refined PHASE_03 |
| `/v1/runtime/runs/:id` | GET | Single run row (status, live_url, browserbase session id) | PHASE_03 |
| `/v1/runtime/runs/:id/events` | GET (SSE) | Tool calls + reasoning + screenshots stream | PHASE_03 |
| `/v1/runtime/runs/:id/takeover` | POST | Toggle pause; iframe flips to interactive | PHASE_08 |
| `/v1/runtime/runs/:id/resume` | POST | End take-over, agent re-observes | PHASE_08 |
| `/v1/runtime/workflows` | GET / POST | List + create workflows | PHASE_10 |
| `/v1/runtime/workflows/:id/run-now` | POST | Manual trigger | PHASE_10 |
| `/v1/runtime/workflows/:id/schedule` | PATCH | Update cron | PHASE_10 |
| `/v1/runtime/approvals` | GET | List unresolved approvals (workspace-scoped) | PHASE_04. Mirror of `agent/`'s today-shape |
| `/v1/runtime/approvals/:id/decide` | POST | Approve/reject + optional `remember` flag → trust grant | PHASE_04 (decide) + PHASE_09 (`remember`) |
| `/v1/runtime/trust-grants` | GET / POST / DELETE | List + create + revoke trust grants | PHASE_09 |
| `/v1/runtime/contexts/sync` | POST | Encrypted cookie/localStorage blob from Lens | PHASE_07 |
| `/v1/runtime/contexts/:workspace_id` | GET | Browserbase Context metadata, last sync, domains | PHASE_07 |
| `/v1/runtime/audit/runs/:id/calls` | GET | Tool-call audit log for a run | PHASE_05. Today on desktop this is `agents:list-steps` — runtime needs the same shape |
| `/v1/runtime/checks/runs/:id` | GET | Check function results | PHASE_06. May fold into `/runs/:id` envelope |

**Notes on shape compat.** Runtime uses snake_case (matches `agent/`). Runtime's `runtime_runs.status` enum is `pending|booting|running|paused|verifying|completed|failed|unverified` (`runtime/ARCHITECTURE.md:271`). Today's desktop reads `queued|pending|running|paused_for_approval|paused_by_user|completed|failed|skipped|killed` (`desktop/src/features/agents/shared/channels.ts:19-30`). The two are not subsets. Phase 03 must decide whether to (a) widen the runtime enum to be a superset of agent's, (b) translate at the API edge, or (c) translate at the desktop IPC seam. **Recommendation: (c)** — runtime stays clean; desktop's `gateway/client.ts` projects.

## IPC channels needed

The desktop already has a typed IPC registry in `src/features/<feature>/shared/channels.ts` per feature, composed in `src/preload/index.ts`. New runtime concerns get a new feature folder, **not** added to `agents/`, so the desktop can keep both `agent/` and runtime live during migration.

### Existing channels relevant to runtime (no changes needed)

| Channel | Defined at | Used for |
|---|---|---|
| `agents:list`, `agents:get`, `agents:list-runs`, `agents:list-steps` | `desktop/src/features/agents/shared/channels.ts:294-318` | Runtime's audit-log + run-detail pages can reuse the IPC shape verbatim if we point the gateway at `/v1/runtime/*` instead of `/v1/agents/*` |
| `agents:pause-run`, `agents:resume-run` | same file, lines 320-323 | Take-over and resume — already paired with the in-app webview going interactive |
| `agents:list-approvals`, `agents:decide-approval` | same file, lines 325-329 | First-responder approvals; desktop polls every 3s today (`desktop/src/features/agents/main/ipc.ts:49`) |
| `overlay:enqueue-agent-approval` (event) | `desktop/src/features/overlay/shared/channels.ts:154-157` | Main → overlay broadcast; overlay enqueues a prompt-pill keyed by `approvalId` |
| `chrome-import:run-sync`, `chrome-import:list-profiles`, `chrome-import:get-status` | `desktop/src/features/chrome-import/shared/channels.ts:54-66` | Cookie sync — currently uploads to `agent/`'s `/v1/cookie-sync/upload`; Phase 07 retargets to `/v1/runtime/contexts/sync` |
| `lens:*` (full session lifecycle, SSE consumer) | `desktop/src/features/lens/shared/channels.ts` | Lens daemon at 127.0.0.1:3030 — orthogonal to runtime today; the cookie extractor inside the daemon is the new part |

### New channels for runtime

Group by phase. All under a new feature folder `desktop/src/features/runtime/` (or fold into `agents/` if the team chooses; either is fine, but keeping them separate makes the dual-backend transition obvious).

#### Phase 03 — agent loop visible

- `runtime:run:list` — `(workspaceId)` → `RuntimeRun[]` — workspace-scoped runs newest first. Identical shape to `agents:list-runs` but reads from `/v1/runtime/runs`.
- `runtime:run:get` — `(runId)` → `RuntimeRun` — single run.
- `runtime:run:start` — `(workflowId, params)` → `{ runId }` — manual trigger. Maps to `agents:run-now` today.
- `runtime:run:subscribe-events` — stream — main opens SSE to `/v1/runtime/runs/:id/events`, fans tool-call + reasoning + screenshot frames to renderer. Today the analogous flow is Supabase Realtime on `agent_run_steps` (`desktop/src/renderer/src/features/agents/hooks/use-agents-query.ts:151-189`); runtime's SSE is a server-push alternative that doesn't require Realtime.

#### Phase 04 — approvals (mostly already wired)

- Reuse `agents:list-approvals` and `agents:decide-approval` and the existing 3s polling watcher (`desktop/src/features/agents/main/ipc.ts:150-191`). Repoint internal to `/v1/runtime/approvals` once that surface exists.
- Add `runtime:approvals:subscribe` — stream — to replace the 3s poll with an SSE event channel from runtime, if the runtime team adds one (the agent backend deferred SSE for approvals; runtime should not).

#### Phase 07 — cookie sync

- Reuse `chrome-import:run-sync` end-to-end. Internal change: `desktop/src/main/gateway/client.ts:uploadCookieSync` (line 877) gains a `target: 'agent' | 'runtime'` param or splits into two functions, one per surface. The renderer-facing IPC is unchanged.
- Add `runtime:contexts:status` — `(workspaceId)` → `{ lastSyncedAt, contextId, domainCount }` — surfaces in Settings.

#### Phase 08 — take-over (mostly already wired)

- Reuse `agents:pause-run` / `agents:resume-run`. Add a runtime-facing pair only if the runtime API ships separate endpoints from the dashboard's `POST /v1/runtime/runs/:id/takeover`.

#### Phase 09 — trust ledger (new UX)

- `runtime:trust:list` — `(workspaceId)` → `TrustGrant[]`
- `runtime:trust:create` — `(grant)` → `TrustGrant` — used by the take-over flow's "Auto-approve this next time?" dialog
- `runtime:trust:revoke` — `(grantId)` → `{ ok: true }`
- `overlay:enqueue-trust-suggestion` — event — when take-over ends, main broadcasts a "remember this?" prompt to the overlay, similar to today's approval-pill flow

## Mock-to-real swap points

`desktop/WIRING.md` lists mock-data files; many have already been wired to `agent/` since WIRING.md was written. Below tracks the *current* state (2026-05-06) and the runtime path.

| Mock file | Current state | Runtime endpoint | Phase | Shape mismatch |
|---|---|---|---|---|
| `desktop/src/renderer/src/data/agents.ts` | **deleted / replaced** — desktop now reads `CloudAgent[]` from `agents:list` IPC backed by `agent/`'s API. (`desktop/src/renderer/src/features/agents/hooks/use-agents-query.ts:32-72`) | `GET /v1/runtime/workflows` (Phase 10) | PHASE_10 | Runtime's "workflow" lacks desktop's `runtime_mode` and `identity_context.allowed_toolkits`; either widen runtime schema or keep a separate desktop-scoped Postgres view |
| `desktop/src/renderer/src/features/agent-runs/mock-data.ts` | **mock kept for `/agents/$agentId`'s legacy run-detail drawer.** Per `desktop/src/renderer/src/features/agent-runs/README.md:23`, only one consumer remains. The new run-detail UI in Phase 1.5 (post-Phase-1.5) reads `agent_runs` + `agent_run_steps` from agent/ in real time. | `GET /v1/runtime/runs/:id`, `GET /v1/runtime/audit/runs/:id/calls` | PHASE_03 (runs) + PHASE_05 (steps) | The legacy `RunStepKind = 'trigger'\|'fetch'\|'llm'\|'tool'\|'send'\|'output'` (`features/agent-runs/types.ts:1`) does not match the real `AgentRunStepKind = 'plan'\|'tool_execution'\|'approval_wait'\|'resume'` (`features/agents/shared/channels.ts:177-182`). Runtime can either adopt the real one or define its own; either way, the legacy mock file becomes stale once the legacy drawer is removed |
| `desktop/src/renderer/src/data/agent-documents.ts` | mock — 553 lines of seeded BlockNote docs | TBD — runtime ROADMAP does not specify a "documents" concept. The closest analog is `runtime_runs.result_summary` (text) or check-result evidence | TBD — runtime should explicitly decide whether agent runs produce structured documents. Today on desktop, "documents" are an agent-output surface; on runtime they could become "verification artifacts" |
| `desktop/src/renderer/src/data/agent-browser.ts` | mock — `BrowserActivity` per agent | Replaced by Browserbase live-view URL on `runtime_runs.live_url` | PHASE_03 (URL exposed) | The mock's `pageTitle` / `statusLine` / `body` shape has no runtime analog; remove on Phase 03 |
| `desktop/src/renderer/src/data/memory.ts` (referenced by WIRING but not in current `data/` dir) | likely deleted / moved into `features/memory/queries.ts` per `desktop/CLAUDE.md` | not a runtime concern — memory comes from `agent/` + Lens daemon | — | none |
| `desktop/src/renderer/src/data/conversations.ts` (also referenced) | not in the current `data/` dir; conversations are now backed by `features/conversations` | not a runtime concern | — | none |
| `desktop/src/renderer/src/data/connections.ts` (mocked OAuth) | TBD — not surveyed for this doc | not a runtime concern (Composio lives in `agent/`) | — | — |

**Net swap-list for runtime work:**
1. `agent-browser.ts` — delete when run-detail uses `liveRun.live_view_url` exclusively (already partially done in `activity-tab.tsx:144-148`).
2. `agent-runs/mock-data.ts` — delete when the legacy drawer is removed and Phase 1.5's run-detail page is the only consumer.
3. `agent-documents.ts` — keep until runtime decides on a documents/artifacts model.

## Overlay approval wiring

This is **already built** for the agent backend. Phase 04 of runtime is mostly: stand up the same surface server-side on `/v1/runtime/approvals`, repoint the watcher in `desktop/src/features/agents/main/ipc.ts:150-191`, and update Slack dispatch to come from runtime instead of (or in addition to) agent/.

The wired-today path:

1. **Backend approval middleware** inserts `pending_approvals` row server-side. (Runtime Phase 04 builds the same against `runtime_approvals`.)
2. **Desktop main process** polls `GET /v1/approvals` every 3s. SSE not used today; runtime should ship one to drop the poll. (`desktop/src/features/agents/main/ipc.ts:48-49, 150-191`)
3. **Main forwards via IPC event** to overlay window using `OverlayChannels.enqueueAgentApproval` (`desktop/src/features/overlay/shared/channels.ts:154-157`). Payload is `{ approvalId, actionName, previewText, agentName }`.
4. **Overlay receives the event**, calls `promptForAgentApproval(payload)` from `desktop/src/renderer/src/overlay/overlay-surface-store.ts:252-273`. The store enqueues an `OverlayPrompt` with `kind: 'agent-approval'`, the `approvalId` is the prompt id (so re-enqueues dedupe).
5. **Pill renders the prompt** via the `NotificationSurface` component (`desktop/src/renderer/src/overlay/surfaces/NotificationSurface.tsx`). Buttons read "Approve" / "Reject".
6. **User clicks Approve/Reject.** `acceptPrompt` / `denyPrompt` (`overlay-surface-store.ts:310-362`) calls `window.api.agents.decideApproval({ approvalId, decision })`.
7. **Renderer → main → POST** `/v1/approvals/:id/decide` via `gatewayClient.decideApproval`.
8. **Server returns** `{ status: 'scheduled' }` or `{ status: 'already_resolved' }` (the discriminated union at `desktop/src/features/agents/shared/channels.ts:281-289`). The next 3s poll's `seen` set drops resolved ids and re-pills if a new approval lands.

**What changes for runtime Phase 04:**
- Server-side: a new `runtime_approvals` table + middleware (per `runtime/ARCHITECTURE.md:84-92, 154-177`) and a new `GET /v1/runtime/approvals` + `POST /v1/runtime/approvals/:id/decide` pair.
- Desktop-side: gateway functions `listUnresolvedApprovals` (`gateway/client.ts`) and `decideApproval` need to handle two surfaces — by reading from both `agent/` and runtime endpoints during transition, or by routing on workspace setting. Simpler path: the runtime API also exposes the `agent/`-shaped endpoint as an alias and we just flip `BASICS_API_URL` for runtime-only customers.
- Slack: today Slack DMs go from `agent/`. Runtime adds Slack via Bolt for JS (`runtime/PROJECT.md:57`). First-responder logic is server-side; both surfaces should converge on a single approval row with `resolved_via: 'slack' | 'dashboard' | 'overlay'`.

**What does NOT change:** the overlay's prompt-pill rendering. The overlay treats `agent-approval` prompts opaquely; it doesn't know whether they came from agent/ or runtime/.

### Reasons this is the cheapest phase to ship

Of all the runtime↔desktop integration work, approval wiring is the most "already done" — every renderer-side piece exists, has tests, and is in production. The components involved:

- `OverlayPromptPayloadSchema` and `OverlayAgentApprovalPayloadSchema` (`desktop/src/features/overlay/shared/channels.ts:20-42`) — Zod schemas, validated at the IPC seam.
- `enqueueAgentApproval` event (`desktop/src/features/overlay/shared/channels.ts:154-157`) — main broadcasts via `sendEvent(...)`.
- `promptForAgentApproval` action (`desktop/src/renderer/src/overlay/overlay-surface-store.ts:252-273`) — enqueues the prompt with the `approvalId` as the prompt id (idempotent re-enqueues).
- `acceptPrompt` / `denyPrompt` (`desktop/src/renderer/src/overlay/overlay-surface-store.ts:310-362`) — both branch on `kind === 'agent-approval'` and call `window.api.agents.decideApproval`.
- `humanizeApprovalTitle` (`desktop/src/renderer/src/overlay/overlay-surface-store.ts:275-285`) — strips `gmail.send_email` to "Send email", appends agent slug as parens.
- `NotificationSurface` component (`desktop/src/renderer/src/overlay/surfaces/NotificationSurface.tsx`) — renders the Approve/Reject pill with motion springs.
- `AgentsService.startApprovalsWatcher` (`desktop/src/features/agents/main/ipc.ts:150-191`) — the 3s polling loop with seen-set deduplication.

Phase 04 of runtime adds **server-side** plumbing only: `runtime_approvals` table, the middleware that intercepts tool calls before execution and persists pending rows, the dispatch to Slack DMs via Bolt, and the SSE channel on `/v1/runtime/runs/:id/events` that emits approval events. The desktop side is a one-line URL repoint in `gateway/client.ts`.

## Live-view & take-over

**Already built**, against the agent backend. Files of record:

- `desktop/src/renderer/src/features/agents/components/tabs/run-live-view.tsx` — `<iframe>`-style embed of Browserbase's debugger-fullscreen URL. Read-only when the agent loop is running (CSS `pointer-events: none`); becomes interactive when take-over flips.
- `desktop/src/renderer/src/features/agents/components/tabs/run-take-over.tsx` — the "Take Over" / "Resume" button pair. Wires to `agents:pause-run` / `agents:resume-run`.
- `desktop/src/renderer/src/features/agents/components/tabs/remote-browser.tsx` — the `<webview>` wrapper that handles the `pointer-events` gate.
- The route is `/agents/$agentId` (`desktop/src/renderer/src/routes/_dashboard.agents_.$agentId.tsx`), Activity tab.

**Three options for surfacing runtime live-views:**

1. **Reuse the existing route.** When desktop reads `liveRun.live_view_url` (`activity-tab.tsx:144-148`) it does not know whether the URL came from agent/ or runtime/. If runtime writes the same column or surfaces the same shape via `/v1/runtime/runs`, this works zero-touch.
2. **Dedicated route.** Add `/runs/$runId` for runtime runs, paralleling `/agents/$agentId`. Justified only if runtime runs have a fundamentally different rendering model from agent runs (they don't, today).
3. **Separate BrowserWindow.** Open the live-view iframe in its own always-on-top window so the user can keep watching while doing other work. The desktop already has multi-window infrastructure (`desktop/src/main/window/`). This is a UX upgrade, not a v1 requirement.

**Recommendation: option 1 for v1, option 3 for v2.** Treat the activity tab as the canonical live-view surface. Add the spawn-its-own-window button later as a quality-of-life upgrade.

**Take-over write-back:** today's `pauseAgentRun` posts to `/v1/agent-runs/:id/pause`. Runtime's analog per ARCHITECTURE.md:185 is `POST /v1/runtime/runs/:id/takeover`. The desktop side change is one function in `gateway/client.ts`.

### Run picker logic

The activity-tab picks the "current" run via `pickLiveViewRun(runs)` (`activity-tab.tsx:271-277`):

1. First a run with `status === 'running' && live_view_url` (the agent is actively driving).
2. Fall back to `status === 'paused_by_user' && live_view_url` (user is mid-take-over).
3. Fall back to `status === 'paused_for_approval' && live_view_url` (waiting on an approval that the overlay will surface).

Runtime should preserve this priority ordering. The `paused_for_approval` case is interesting because it implies the live-view shows the page state at the moment the agent paused — a critical UX cue for the approver.

### What stays read-only vs interactive

`RunLiveView`'s `interactive` prop drives a CSS `pointer-events` toggle on the embedded iframe (`run-live-view.tsx:30, 47`). The Browserbase debugger URL is the same in both modes; what changes is whether the desktop allows clicks to pass through. This is the key insight that lets the same URL work for "watch" and "drive" — Browserbase releases CDP write access automatically when no other CDP consumer is attached, which the runner achieves by halting its tool dispatch loop on pause.

If runtime's pause semantics differ (e.g., the orchestrator keeps the CDP socket open but stops sending commands per `runtime/ARCHITECTURE.md:188-189`), this should still work — but worth confirming during Phase 08 that Browserbase's "release on idle" timing matches the runtime fiber's behavior.

## Lens cookie sync (Phase 07 path)

There is a **conflict between two existing approaches**:

**Approach A (already shipping in desktop):** Electron main process spawns headless Chrome, attaches via CDP, extracts cookies + localStorage, and uploads to `agent/`'s `/v1/cookie-sync/upload`. Code lives in:
- `desktop/src/main/chrome-import/cookies.ts` — extractor
- `desktop/src/main/chrome-import/profiles.ts` — Chrome profile enumeration
- `desktop/src/main/gateway/client.ts:837-915` — `uploadCookieSync` and `getCookieSyncStatus`
- IPC: `chrome-import:run-sync`, `chrome-import:list-profiles`, `chrome-import:get-status`

This is forked from `browser-use/desktop` (per the header at `cookies.ts:1-9`), it is tested, and it works.

**Approach B (per `runtime/ROADMAP.md:67-72`):** Lens daemon (`basics-capture-v2/daemon/`) gains a Rust module that reads Chrome cookies via the SQLite + Keychain decrypt path, encrypts the blob, and POSTs to `api.trybasics.ai/v1/runtime/contexts/sync`. The runtime API decrypts, looks up the workspace's Browserbase Context, boots a short-lived session, calls `Network.setCookies` + `Storage.setStorageItems`, closes cleanly so the Context persists.

**Recommendation: keep Approach A on the desktop side; runtime's `/v1/runtime/contexts/sync` should accept the same payload the desktop already sends.** The Lens daemon's Rust extractor is a duplicative effort against a working TS one. The argument for doing it in Lens is "Lens is always-on, the desktop pill might not be" — but the desktop is the only client today that triggers cookie sync, and the user has to be running it to even know cookie sync exists.

**Concrete changes for Phase 07:**
1. Runtime API ships `POST /v1/runtime/contexts/sync` accepting the same body shape as `agent/`'s `/v1/cookie-sync/upload` (cookies array + profile metadata).
2. Runtime API creates/updates `runtime_contexts` row keyed by workspace; injects via short-lived Browserbase session.
3. Desktop `gateway/client.ts:uploadCookieSync` either swaps URL (single backend) or becomes `uploadCookieSyncToRuntime` and is called instead of the agent/ variant when the workspace is a runtime workspace.
4. **No desktop renderer change.** The `chrome-import:run-sync` IPC and the Settings UI continue to work.

If Phase 07 *does* land the Rust extractor (basics-capture-v2 ROADMAP), the desktop can keep the TS one as a fallback path and the Rust one becomes the always-on path. The runtime API endpoint is the same in both cases.

## Naming reconciliation

| Runtime says | Desktop says | Recommendation |
|---|---|---|
| workflow | agent (`cloud_agents` table, `CloudAgent` type) | Keep desktop terminology in the desktop code. Runtime API can expose `/v1/runtime/workflows` server-side; desktop gateway translates `workflow` ↔ `agent` at the seam. Renaming the desktop `agents/` feature folder is a multi-day refactor and not justified for v1. |
| run | agent_run | Keep both. They mean the same thing; the prefix `agent_` is desktop-historical. |
| tool call | agent_run_step (`kind = 'tool_execution'`) + agent_activity row | Keep both. Map at the IPC seam: when runtime returns a `runtime_tool_calls` row, project to `AgentRunStep`. |
| approval | pending_approval | Already aligned (both sides say "approval" everywhere user-facing; only the table is `pending_approvals`). |
| trust grant | (no desktop term yet) | Adopt "trust grant" verbatim when the UX lands. |
| audit log | activity / steps timeline | UX-facing copy should say "Activity" (matches the existing tab name). The data shape is `runtime_tool_calls` rows. |
| context | (no desktop term — uses "Browserbase profile" via chrome-import) | The desktop's `chrome-import` term is fine for the action; the *thing* synced is a "profile" / "Browserbase context". Be consistent with `runtime_contexts` server-side. |
| take-over | take over (already used) | Aligned. |

**Where the runtime API needs to expose both names:** the only one that actually matters is `workflow` ↔ `agent`. Runtime can expose `GET /v1/runtime/workflows` *and* an alias `GET /v1/runtime/agents`. The desktop gateway calls the alias and the dashboard calls the canonical name. Not a big lift; saves a rename later.

## Open questions

1. **Cookie extractor: TS-in-desktop vs Rust-in-Lens?** The desktop already ships a TS extractor (`src/main/chrome-import/cookies.ts`) that is forked from browser-use/desktop and uploads to `agent/`. `runtime/ROADMAP.md:67-72` proposes a Rust extractor in `basics-capture-v2/daemon/`. Doing both is redundant. Need a decision: (a) keep TS-in-desktop, runtime API accepts the same shape; (b) port to Rust-in-Lens, decommission the TS one; (c) both, with the Lens one as the always-on path. Rec: (a) for v1; (c) once Lens shipping. See also `desktop/LENS-INTEGRATION.md` open gap #6 (TCC cannot be bypassed for tests) — that gap doesn't apply to the TS extractor.

2. **Migration cutover for the agent backend.** Today's desktop reads `agent_runs`, `agent_run_steps`, `pending_approvals` etc. from `agent/`'s API and via Supabase Realtime. Runtime Phase 03+ creates `runtime_runs`, `runtime_run_steps`, `runtime_approvals` in the same Supabase Postgres (`runtime/PROJECT.md:30`). Until v2 (when desktop becomes the agent control plane per `runtime/PROJECT.md:70`), do desktop runs flow through agent/'s tables or runtime/'s? **No clear answer.** Probably: existing desktop-originated agents keep using `agent/`; new runtime-only workflows (the dashboard's "weekly RevOps digest" template) use runtime/'s tables; the desktop's agent-detail page has to query both surfaces if the user mixes. Phase 03 has to make this call.

3. **Trust ledger UX surface.** Where does the user manage trust grants? Options: a Settings tab inside the dashboard, a Settings tab inside the desktop agent detail page, or a dedicated route. The desktop has no UX for this today. `desktop/src/renderer/src/features/agents/components/tabs/settings-tab.tsx` is one obvious extension point. Phase 09 has to design this.

4. **Document/artifact model.** `desktop/src/renderer/src/data/agent-documents.ts` (553 lines) is a rich BlockNote document model that doesn't exist in runtime. Runtime's closest analog is `runtime_runs.result_summary` (string) and `runtime_check_results.evidence` (jsonb). If runtime workflows should produce documents, that's a runtime schema change. If they shouldn't, the desktop documents path is agent-only. Untouched in v1; flag for v2.

5. **SSE for approvals vs polling.** Desktop polls `/v1/approvals` every 3s today (`agents/main/ipc.ts:48-49`); the comment says "No SSE channel exists for approvals as of Phase 07." Runtime should ship SSE (matches the streaming-everywhere convention in `runtime/PROJECT.md:121`). Easy enough; low priority.

6. **Workspace JWT lifecycle.** Runtime is a verifier of agent/-issued JWTs. If a desktop user is on runtime-only (no agent/ subscription), the JWT mint endpoint is still in agent/. `runtime/PROJECT.md:33` says this; the implication is agent/ has to keep running for runtime to authenticate. Not blocking, but worth confirming the runtime team agrees.

7. **Multi-window live-view.** Should "Watch live" open in its own BrowserWindow? The infra is there (`src/main/window/`). Untouched in this doc; flag for Phase 08+.

## Phasing summary (desktop-side work, mapped to runtime ROADMAP)

A condensed view of the desktop-side work per runtime phase. Numbers reference the runtime ROADMAP phases, not desktop phases.

| Runtime phase | Desktop work | Net new desktop LOC (estimate) |
|---|---|---|
| **P00 Scaffold** | None — runtime stands itself up; desktop is unaware. | 0 |
| **P01 First end-to-end run** | None — runtime tests against the dashboard, not the desktop. | 0 |
| **P02 Harness fork** | None. | 0 |
| **P03 Agent loop + dashboard** | Optional: add a `runtime` IPC namespace mirroring `agents/`, pointed at `/v1/runtime/*`. Useful only if a desktop tester wants to watch a runtime run inside the existing `/agents/$agentId` activity tab. | ~200 if pursued |
| **P04 Approval gating** | Repoint approvals watcher (`desktop/src/features/agents/main/ipc.ts:150-191`) to also poll `/v1/runtime/approvals`. Or: leave it on the agent backend if approvals are unified server-side. | ~30 if dual-poll, 0 if unified |
| **P05 Audit log** | None — `agent_run_steps` already drives the activity timeline. Runtime audit log can be projected into the same shape. | 0 |
| **P06 Check functions** | None — `agent_run_steps.check_passed` etc. already exist on the desktop schema. | 0 |
| **P07 Lens cookie sync** | Either repoint `uploadCookieSync` URL or add a parallel `uploadCookieSyncToRuntime` (~20 LOC). The renderer-facing `chrome-import:run-sync` IPC is unchanged. | ~20–50 |
| **P08 Take-over UX** | None — `RunTakeOver` and `RunLiveView` are already shipping. Repoint `pause-run` / `resume-run` URL once runtime ships those. | 0 |
| **P09 Trust ledger** | New: trust-grants list/create/revoke IPC, settings UI, and the take-over "remember this?" prompt. Largest desktop task in this plan. | ~500–800 |
| **P10 Workflow library** | New: schedule editor (cron) inside `settings-tab.tsx`. Workflow listing already exists as the agents grid. | ~200 |
| **P11 Templates** | None — templates are server-side. Desktop's create-agent flow already supports them. | 0 |
| **P12 Onboarding** | None on desktop; onboarding is an in-person workflow. | 0 |

**Total estimated desktop work for full runtime integration: ~750–1100 net new LOC**, dominated by trust-ledger UX. Most other phases are URL repoints or zero-touch because the desktop already implements the flow against `agent/`.

## What this doc is NOT

- Not a finalized API contract — Phase 03+ refines.
- Not a UI design doc — visuals come later.
- Not a delete-list for desktop — we're extending, not replacing.
- Not a commitment to ship desktop-runtime integration in v1 — `runtime/PROJECT.md:70` explicitly defers it. This doc is the v2 plan, written early so v1's runtime API doesn't paint itself into a corner.

## Key file references

For future agents working through this plan, the most load-bearing desktop files are:

**Backend gateway (where API repoints land):**
- `desktop/src/main/gateway/client.ts` — workspace JWT, all HTTP/SSE calls
- `desktop/src/main/gateway/config.ts` — base URL setter
- `desktop/src/main/gateway/workspace-token.ts` — JWT cache + refresh
- `desktop/src/main/startup-env.ts` — `BASICS_API_URL` env var assertion

**IPC seam (where new namespaces or re-pointed handlers go):**
- `desktop/src/preload/index.ts` — composes feature APIs onto `window.api`
- `desktop/src/features/agents/shared/channels.ts` — IPC schema for agents/runs/approvals
- `desktop/src/features/agents/main/ipc.ts` — main-side handlers + approval polling watcher
- `desktop/src/features/overlay/shared/channels.ts` — overlay events including `enqueueAgentApproval`
- `desktop/src/features/chrome-import/shared/channels.ts` — cookie sync IPC

**Renderer surfaces (the UI that runs against runtime data):**
- `desktop/src/renderer/src/routes/_dashboard.agents_.$agentId.tsx` — agent detail route
- `desktop/src/renderer/src/features/agents/components/tabs/activity-tab.tsx` — live preview + run picker
- `desktop/src/renderer/src/features/agents/components/tabs/run-live-view.tsx` — Browserbase iframe
- `desktop/src/renderer/src/features/agents/components/tabs/run-take-over.tsx` — pause/resume buttons
- `desktop/src/renderer/src/features/agents/hooks/use-agents-query.ts` — TanStack Query + Supabase Realtime
- `desktop/src/renderer/src/overlay/overlay-surface-store.ts` — overlay prompt store + approval handlers
- `desktop/src/renderer/src/overlay/surfaces/NotificationSurface.tsx` — approval pill UI

**Lens daemon integration (separate process at 127.0.0.1:3030):**
- `desktop/src/main/lens/client.ts` — daemon HTTP client
- `desktop/src/main/lens/auth.ts` — bearer token reader
- `desktop/src/main/lens/lifecycle.ts` — daemon discovery + LaunchAgent management
- `desktop/src/main/chrome-import/cookies.ts` — TS cookie extractor (forked from browser-use/desktop)

**Reference docs (read these before changes):**
- `desktop/PROJECT.md`, `desktop/ROADMAP.md`, `desktop/WIRING.md`, `desktop/SESSIONS.md`, `desktop/LENS-INTEGRATION.md`
- `runtime/PROJECT.md`, `runtime/ARCHITECTURE.md`, `runtime/ROADMAP.md`
