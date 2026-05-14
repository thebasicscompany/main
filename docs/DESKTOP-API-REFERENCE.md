# Desktop → Basics API Reference

> **Status:** Current as of 2026-05-14. Reflects everything actually deployed on `https://api.trybasics.ai/` (the `basics-runtime-production-RuntimeApi` ECS service).
> **Audience:** the desktop Electron app team. This doc supersedes `DESKTOP_INTEGRATION.md` (which was a planning doc from before the build; it predates the auth/approvals/automations/authoring/helpers work and references endpoints that never shipped).

## 1. Base URL & auth

- **Base URL:** `https://api.trybasics.ai/`
- All write endpoints require a **workspace JWT** in `Authorization: Bearer <jwt>` (or `X-Workspace-Token: <jwt>` on legacy paths). Mint it via `POST /v1/auth/token`.
- JWT is HS256, claims include `workspace_id`, `account_id`, optional `role`. Signed with `WORKSPACE_JWT_SECRET`.
- Token TTL is 24 h; on 401 re-mint and retry once. The api also rotates JWTs on each successful auth call.
- Workspace API keys (durable, server-to-server) live separately at `/v1/workspaces/:wsId/api-keys` — for desktop, you almost always want JWTs (per-user, short-lived) instead.

## 2. Quick map by purpose

| You want to… | Hit |
|---|---|
| Sign in / mint workspace JWT | `POST /v1/auth/token` (Supabase access token → workspace JWT) |
| Authoring chat for building automations | `POST /v1/workspaces/:wsId/authoring/messages` + SSE `GET /v1/workspaces/:wsId/authoring/events` |
| List / create / edit automations | `/v1/automations/*` |
| Dispatch a manual run | `POST /v1/automations/:id/run` or `POST /v1/runs` |
| Watch a run live | `GET /v1/runs/:id/events` (SSE) |
| List + decide approvals | `GET /v1/workspaces/:wsId/approvals` + `POST /v1/approvals/:id` (or `POST /v1/runs/:id/approvals/:apId`) |
| Stream approvals to overlay | `GET /v1/workspaces/:wsId/approvals/stream` (SSE) |
| Stream automation outputs to overlay | `GET /v1/workspaces/:wsId/outputs/stream` (SSE) |
| Upload Chrome cookies for a logged-in site | `POST /v1/workspaces/:wsId/browser-sites/:host/connect` then `/finalize` |
| Connect a Composio toolkit (Gmail, Sheets, etc.) | `POST /v1/skills/composio/connect` (returns OAuth URL) |
| List / approve / supersede skills + helpers | `/v1/skills/*` |
| Schedule a cron-fired automation | encoded in `automations[].triggers[]` (type:'schedule'); standalone schedules: `/v1/schedules/*` |
| Get / set workspace credentials (BYOK) | `/v1/workspaces/:wsId/credentials/*` |
| LLM proxy (chat completion / vision / embedding) | `POST /v1/llm/completions` |
| Voice transcription / call dispatch | `/v1/voice/*` |

---

## 3. Auth (`/v1/auth`)

### `POST /v1/auth/token`
Mint a workspace JWT from a Supabase access token.

- **Headers:** `Authorization: Bearer <supabase_access_token>`
- **Body:** `{ workspace_id: uuid }` (optional; defaults to the user's primary workspace)
- **Response 200:** `{ token: string, expires_at: ISO, workspace_id: uuid, account_id: uuid, role: 'owner' | 'admin' | 'member' }`
- **When desktop calls it:** at sign-in (after Supabase auth), on workspace switch, and on any 401 from the api.

### `POST /v1/auth/refresh`
Refresh the workspace JWT before expiry without a new Supabase round-trip.

- **Headers:** `Authorization: Bearer <expiring_workspace_jwt>`
- **Response 200:** same shape as `/token`.

---

## 4. Authoring chat (`/v1/workspaces/:wsId/authoring`)

The **opencode-driven automation-authoring agent** — runs Opus 4.7, has the full worker tool registry (browser, Composio, propose_automation, activate_automation, skill_write, helper_write). This is the surface the user types into to describe and build an automation.

### `POST /v1/workspaces/:wsId/authoring/messages`
Send a message to the authoring chat. Idempotent on `client_message_id`.

- **Body:** `{ message: string, client_message_id: uuid, conversation_id?: uuid, model?: 'anthropic/claude-opus-4-7' }`
- **Response 200:** `{ run_id: uuid, conversation_id: uuid, session_id: string, status: 'pending' | 'awaiting_user' }`
- **Side effects:** on first message creates a `cloud_runs` row with `run_mode:'authoring'`. Subsequent messages continue the same opencode session (rehydrate-on-dead-binding handled server-side).
- **When desktop calls it:** every time the user hits send in the automation-builder chat panel.

### `GET /v1/workspaces/:wsId/authoring/events`
SSE stream of authoring agent activity (tool calls, message parts, helper writes, status flips). Open one per active conversation.

- **Query:** `conversation_id=<uuid>` (required) `last_event_id=<int>` (optional, for resume)
- **Events:** `agent_message_part`, `tool_call_start`, `tool_call_end`, `external_action`, `helper_written`, `skill_written`, `propose_automation`, `activate_automation`, `authoring_turn_complete`, `awaiting_user`, `run_completed`, `error`
- Heartbeat every 15s; reconnect on close.

---

## 5. Automations (`/v1/automations`)

Automations are the persistent workflow definitions. Lifecycle: `draft` → (dry-run) → `active` → `archived`.

### `POST /v1/automations`
Create a draft automation directly (skip the chat).

- **Body:**
  ```json
  {
    "name": "LP Mapper",
    "description": "Map LP rows to mutuals + score + draft outreach",
    "goal": "Multi-line natural-language goal text the worker executes.",
    "context": { /* opaque jsonb */ },
    "outputs": [{ "kind": "gmail_draft" }],
    "triggers": [
      { "type": "composio_webhook", "toolkit": "googlesheets", "event": "GOOGLESHEETS_NEW_ROWS_TRIGGER", "filters": {"spreadsheet_id": "...", "sheet_name": "LP Pipeline"} },
      { "type": "schedule", "cron": "0 8 * * *", "timezone": "America/New_York" }
    ],
    "approval_policy": { /* optional */ },
    "status": "draft"
  }
  ```
- **Response 200:** the full automation row including `id`, `version: 1`, `created_at`.

### `GET /v1/automations?status=active&limit=50`
List automations in the caller's workspace. Query params: `status`, `limit`, `cursor`.

### `GET /v1/automations/:id`
Get one automation.

### `PUT /v1/automations/:id`
Update fields (`name`, `description`, `goal`, `context`, `outputs`, `triggers`, `approval_policy`). Bumps `version`. Triggers re-registered atomically.

### `DELETE /v1/automations/:id`
Soft-delete (sets `archived_at`). Tears down registered Composio webhooks + EventBridge schedules.

### `GET /v1/automations/:id/versions`
List version history (`automation_versions` rows). Each version snapshots the full record at write time.

### `POST /v1/automations/:id/dry-run`
Force a dry-run with the current draft. Captures every mutating outbound call into a preview buffer instead of firing.

- **Body:** `{ inputs?: object, model?: string }`
- **Response 200:** `{ run_id }`. Watch via `GET /v1/runs/:run_id/dry-run-preview` once complete.

### `POST /v1/automations/:id/activate`
Flip draft → active. Validates trigger filters against Composio's schema FIRST; rolls back to draft on registration failure (unless `acceptFailedTriggers:true`). Approval-gated — surfaces to the user via SMS+desktop simultaneously.

- **Body:** `{ acceptFailedTriggers?: boolean }`
- **Response 200:** `{ status: 'active', triggers: { added: [...], warnings: [...] } }` or **422** `{ code: 'trigger_registration_failed', failures: [...] }`.

### `POST /v1/automations/:id/run`
Manual fire of an already-active automation.

- **Body:** `{ inputs?: object, lane_id?: string }`
- **Response 200:** `{ run_id }`. The dispatcher routes to a worker pool; watch via `/v1/runs/:run_id/events`.

### `POST /v1/workspaces/:wsId/automations/draft-from-chat`
(Internal — called by the authoring agent's `propose_automation` tool. Desktop generally won't call this directly.)

### `GET /v1/runs/:runId/dry-run-preview`
Preview the captured mutating calls from a dry-run.

- **Response 200:** `{ run_id, captured_actions: [{ kind, toolSlug, params, redactedPreview, would_have_fired_at }] }`

---

## 6. Runs (`/v1/runs`)

Runs are individual executions of an automation OR ad-hoc dispatches. Stored in `cloud_runs`.

### `POST /v1/runs`
Ad-hoc one-shot dispatch (no automation). Useful for the desktop to run a free-form goal without persisting it.

- **Body:** `{ goal: string, cloud_agent_id?: uuid, lane_id?: string, model?: string, ad_hoc_definition?: string }`
- **Response 200:** `{ run_id, status: 'pending', cloud_agent_id, live_view_url: null, events_url: '/v1/runs/<run_id>/events' }`

### `GET /v1/runs/:id`
Single run row with status, started_at, completed_at, duration_seconds, result_summary, browserbase_session_id, live_view_url, recording_url, redispatch_attempts, last_progress_at.

### `GET /v1/runs/:id/events`
**Server-Sent Events stream of run activity.** This is the primary live-view source for the desktop's run-detail view.

- **Event types:**
  - `run_started` — payload includes `goal` (truncated), `worker`, `poolId`, `sessionId`
  - `tool_call_start` / `tool_call_end` — every tool the worker calls
  - `external_action` — PII-redacted preview of Composio writes
  - `screenshot` — Browserbase screenshot uploaded to S3 (`s3Key`, `thumbS3Key`, `byteLength`)
  - `approval_requested` — server has paused the run waiting for an approval decision
  - `composio_resolved`, `composio_params_normalized`, `helpers_loaded`, `skills_loaded` — boot telemetry
  - `helper_call_start` / `helper_call_end` — K-phase agent-authored helper invocations
  - `final_answer`, `run_completed`, `run_failed`, `run_cancelled`
  - `pool_dying`, `binding_rehydrated` — durability events
- **Resume:** `?last_event_id=<int>` to replay from a point.
- **Connection:** Hono SSE, 15s heartbeats. Reconnect with backoff on close.

### `POST /v1/runs/:id/cancel`
Force-cancel a running run. Worker receives a `cancel` NOTIFY and aborts the opencode session; cloud_runs.status flips to `cancelled`.

---

## 7. Approvals (`/v1/approvals` + `/v1/workspaces/:wsId/approvals` + `/v1/runs/:runId/approvals`)

Approvals pause a run on a mutating tool call. They surface simultaneously over SMS (Sendblue) and desktop SSE; first responder wins, the other channel auto-resolves.

### `GET /v1/workspaces/:wsId/approvals?status=pending&limit=50`
List approvals scoped to a workspace.

- **Response:** `{ approvals: [{ id, run_id, automation_id?, tool_name, args_pattern, preview_text, requested_at, expires_at, status: 'pending' | 'approved' | 'denied' | 'expired' }] }`
- The desktop's overlay polls this OR subscribes via the SSE stream below.

### `GET /v1/workspaces/:wsId/approvals/stream` (SSE)
Live stream of approval events for the workspace. Replaces the 3s poll the desktop currently does.

- **Events:** `approval_pending`, `approval_resolved` (with `decision: 'approved'|'denied'|'expired'|'cancelled'`, `decided_via: 'sms'|'desktop'|'web'`).
- This is wired through Supabase Realtime on `approvals` table + a publication. Open one stream per workspace.

### `GET /v1/approvals/:id`
Single approval detail (includes the un-redacted `args` for the desktop's confirm modal).

### `POST /v1/approvals/:id?token=<sms_token>`
Decide an approval. SMS path uses `?token=`; desktop uses Bearer JWT.

- **Body:** `{ decision: 'approved' | 'denied', remember?: boolean }`
- **`remember: true`** writes an approval rule (per-workspace, per-toolSlug, optionally per-automation) so future matching calls auto-approve.
- **Response 200:** `{ status: 'scheduled' | 'already_resolved', remember_applied?: boolean }`

### `POST /v1/runs/:runId/approvals/:approvalId`
Alternative path used by the desktop when scoped to a known run (validates the approval belongs to that run).

---

## 8. Outputs SSE (`/v1/workspaces/:wsId/outputs/stream`)

Live stream of automation outputs (Gmail drafts created, SMS sent, sheet rows written, file artifacts uploaded). Used by the desktop's overlay to show toast notifications when an automation produces something.

- **Events:** `output_created`, `output_updated`. Payload: `{ run_id, automation_id, kind: 'gmail_draft' | 'sms' | 'sheet_write' | 'artifact', summary, target, at }`.
- Heartbeat every 15s.

---

## 9. Browser sites (`/v1/workspaces/:wsId/browser-sites`)

For non-OAuth sites (LinkedIn, custom dashboards). Workflow: desktop opens a Browserbase session in the user's view, user logs in, desktop calls `/finalize` to capture cookies into a persistent Browserbase Context.

### `POST /v1/workspaces/:wsId/browser-sites/:host/connect`
Start the connect flow. Creates a Browserbase Context + interactive session. Returns the live-view URL.

- **Body:** `{ ttl_minutes?: number (default 30) }`
- **Response 200:** `{ session_id, context_id, live_view_url, expires_at }`
- The desktop iframes the live-view URL for the user to sign in.

### `POST /v1/workspaces/:wsId/browser-sites/:host/finalize`
Finalize the connect flow. Persists the cookies + localStorage from the Browserbase Context into `workspace_browser_sites`. Pending row flips to `active`.

- **Body:** `{ session_id }`
- **Response 200:** `{ host, status: 'active', expires_at, stored_at }`

### `GET /v1/workspaces/:wsId/browser-sites`
List active browser sites.

- **Response:** `{ sites: [{ host, status, expires_at, last_used_at, source: 'browserbase' | 'desktop_import' }] }`

### `DELETE /v1/workspaces/:wsId/browser-sites/:host`
Disconnect a site (drops the row + revokes the Browserbase Context).

### `POST /v1/runtime/contexts/sync`
**Desktop Chrome-import path** — alternative to the Browserbase interactive flow. The desktop's headless-Chrome cookie extractor encrypts cookies + localStorage and uploads here. Server stores them in `workspace_browser_sites` keyed by host.

- **Body:** `{ workspace_id, encrypted_blob: base64, host_count: number, encryption_key_id: string }`
- **Response 200:** `{ accepted_hosts: number, rejected_hosts: [{host, reason}] }`
- See `docs/DESKTOP-COOKIE-IMPORT.md` for the encryption protocol.

### `GET /v1/runtime/contexts/me`
Get the caller's most recent context-sync metadata (last_synced_at, host count, encryption key id).

---

## 10. Composio toolkits + webhooks (`/v1/skills/composio` + `/webhooks/composio`)

### `GET /v1/skills/composio/connections`
List the workspace's connected Composio accounts.

- **Response:** `{ connections: [{ id, toolkit, account_name, connected_at, status: 'active' | 'expired' }] }`

### `POST /v1/skills/composio/connect`
Initiate Composio OAuth for a toolkit.

- **Body:** `{ toolkit: 'gmail' | 'googlesheets' | 'googlecalendar' | 'notion' | 'airtable' | ... }`
- **Response 200:** `{ oauth_url, connect_request_id }`. The desktop opens the URL in a system browser; Composio redirects back to the api which finalizes the connection.

### `DELETE /v1/skills/composio/connections/:connectedAccountId`
Revoke a Composio connection.

### `POST /v1/skills/composio/refresh`
Force-refresh the cached toolkit catalog (clears `composio_tool_cache`). Useful if Composio shipped new tools mid-session.

### `POST /webhooks/composio`
**Inbound Composio webhook.** Composio POSTs trigger events here; the router resolves the matching automation + dispatches a run. Signature verified via `COMPOSIO_WEBHOOK_SECRET`.

- Desktop doesn't call this — it's a public webhook receiver for Composio's outbound traffic. Documented here for reference.

---

## 11. Skills + helpers (`/v1/skills`)

Two artifact types:
- **Skills** (`cloud_skills.kind = 'doc' | 'playbook'`) — markdown instructions the LLM reads as part of its system prompt
- **Helpers** (`cloud_agent_helpers`) — TypeScript modules the agent compiles and executes in a sandbox

### `GET /v1/skills?workspace_id=<wsid>&status=active`
List skills.

- **Response:** `{ skills: [{ id, name, description, scope, kind, host, requires_integrations, confidence, active, pending_review, created_at }] }`

### `POST /v1/skills/:id/approve`
Approve a `pending_review:true` skill (unblocks the LLM from using it on future runs).

### `POST /v1/skills/:id/reject`
Reject + delete a pending skill.

### `PATCH /v1/skills/:id`
Edit body / description / scope. Bumps `last_edited_at`. Stays under workspace ownership.

### `DELETE /v1/skills/:id`
Soft-delete the skill.

### Helpers
Helpers (`cloud_agent_helpers`) don't currently expose a dedicated route — they're created by the worker via the `helper_write` tool during run execution. To inspect helpers from the desktop, query the table directly via Supabase Realtime or extend the api with a helpers-list route if needed.

---

## 12. Schedules (`/v1/schedules`) — legacy

Predates the automation-trigger model. Used for free-form scheduled goal dispatches that aren't tied to an automation.

### `POST /v1/schedules`
Create a schedule for a cloud_agent.

- **Body:** `{ cloud_agent_id, cron, goal, timezone?, vars? }`
- Creates an EventBridge schedule that invokes the cron-kicker Lambda.

### `GET /v1/schedules/:cloudAgentId`
List schedules for a cloud_agent.

### `PATCH /v1/schedules/:cloudAgentId/:scheduleId`
Update cron / enabled.

### `DELETE /v1/schedules/:cloudAgentId/:scheduleId`
Delete schedule.

### `POST /v1/schedules/:cloudAgentId/:scheduleId/run-now`
Force-fire a scheduled goal immediately.

**Note:** for new development, prefer `automations[].triggers[].type='schedule'` over this surface — it integrates with the J.16 verification + helper fast-path + version snapshotting that schedules don't have.

---

## 13. Credentials (`/v1/workspaces/:wsId`)

BYOK + workspace API keys. Admin-only writes.

### `GET /v1/workspaces/:wsId/api-keys`
List durable API keys (server-to-server access tokens — distinct from JWTs).

### `POST /v1/workspaces/:wsId/api-keys`
Mint a new API key. Returns the plaintext **once** — store it server-side or show-and-forget.

### `DELETE /v1/workspaces/:wsId/api-keys/:id`
Revoke an API key.

### `GET /v1/workspaces/:wsId/credentials`
List configured BYOK credentials (Anthropic, OpenAI, Composio, Browserbase, etc.). Values are hashed; only metadata returned.

### `POST /v1/workspaces/:wsId/credentials`
Set / rotate a credential. Body: `{ kind: string, value: string }`. Value is encrypted at rest.

### `PATCH /v1/workspaces/:wsId/credentials/:id`
Update credential (e.g., toggle active).

### `DELETE /v1/workspaces/:wsId/credentials/:id`
Delete credential.

---

## 14. LLM proxy (`/v1/llm`)

### `POST /v1/llm/completions`
Single entry point for chat/embedding/vision. Routes to the right provider based on `model`.

- **Body:** OpenAI-compatible chat-completion shape. `model` can be any of: `claude-opus-4-7`, `anthropic/claude-sonnet-4-6`, `gpt-4-turbo`, `gemini-2.5-pro`, `text-embedding-3-large`, etc.
- **Response 200:** OpenAI-compatible. SSE if `stream:true`.
- **Streaming:** when `stream:true`, returns SSE with `data:` framed chunks. Heartbeat every 15s.

---

## 15. Voice (`/v1/voice`)

### `POST /v1/voice/runs`
Dispatch a voice-driven workflow run. Body includes the audio transcript + intent. The api mints a worker run with the appropriate goal-wrapping.

### `GET /v1/voice/runs/:id/events`
SSE for voice run progress (separate from `/v1/runs/:id/events` because voice runs have additional transcript / speaker-diarization events).

### `POST /v1/voice/transcribe`
Single transcription pass (Deepgram). Body: `{ audio_url | audio_base64 }`. Response: `{ transcript, words[], confidence }`.

---

## 16. Desktop-specific (`/v1/desktop`)

### `POST /v1/desktop/telemetry`
Receives desktop telemetry (overlay opens, prompt latencies, crash counts). PII-stripped server-side.

---

## 17. Webhooks (inbound)

These accept traffic from external services. Desktop doesn't call them but should know they exist.

| Path | Source | Purpose |
|---|---|---|
| `POST /webhooks/composio` | Composio | trigger events fire runs |
| `POST /webhooks/sendblue` | Sendblue | inbound SMS — used for SMS approval responses, follow-up messages, voice replies |

---

## 18. Health (`/health`, `/v1/runtime/health`)

### `GET /health`
Liveness for the api itself. Returns `{ ok: true, ts }`.

### `GET /v1/runtime/health`
Liveness for the runtime ECS service. Used by ALB target group.

---

## 19. Error envelope

All error responses share this shape:

```json
{
  "error": {
    "code": "string",
    "message": "human-readable",
    "details": { /* optional */ }
  }
}
```

Common codes the desktop should handle:

| Code | HTTP | Meaning | Recovery |
|---|---|---|---|
| `unauthorized` | 401 | JWT missing / expired / wrong workspace | Re-mint via `/v1/auth/token` and retry once |
| `forbidden` | 403 | Token valid but workspace role insufficient | Surface "ask an admin" |
| `not_found` | 404 | Resource doesn't exist or not in caller's workspace | Refresh list view |
| `validation_failed` | 400 | Zod validation failed | Show field-level errors from `details` |
| `quota_exceeded` | 429 | Per-workspace daily cap hit (email/SMS/etc) | Surface upgrade prompt |
| `composio_unavailable` | 503 | Composio is down | Retry with backoff |
| `trigger_registration_failed` | 422 | Activation hit a Composio schema error | Show `details.failures` so the user can fix the filter |
| `denied_by_policy` | 403 | Workspace denylist blocked a Composio call | Surface the matched pattern |
| `approval_required` | 202 | Run paused for approval | Open overlay prompt; resolve via `/v1/approvals/:id` |

---

## 20. SSE event reference (cross-cutting)

The desktop consumes three SSE surfaces. All use Hono's streaming response, send `: heartbeat` every 15s, support `?last_event_id=` resume, and emit `data: {"type": "...", "payload": ..., "id": <int>}` per event.

| Stream | Path | Primary consumer |
|---|---|---|
| Run events | `GET /v1/runs/:id/events` | run-detail page |
| Approvals | `GET /v1/workspaces/:wsId/approvals/stream` | overlay pill, approvals tab |
| Outputs | `GET /v1/workspaces/:wsId/outputs/stream` | toast notifications |
| Authoring | `GET /v1/workspaces/:wsId/authoring/events` | authoring chat view |

Reconnect strategy: on close, wait exponential 1s → 2s → 4s → 8s, cap 30s, include `last_event_id` on reconnect.

---

## 21. Workspace concept mapping

The desktop's `agent` terminology maps to the api's `cloud_agents` + `automations` model. Quick decoder:

| Desktop term | API table / concept | Notes |
|---|---|---|
| `CloudAgent` | `cloud_agents` row | One per workspace + agent_id; backing record for automations |
| `agent_runs` | `cloud_runs` rows | Single execution; `run_mode` ∈ `live` / `test` / `authoring` |
| `agent_run_steps` | `cloud_activity` rows | One per tool call / message part / event |
| Pending approval | `approvals` row | New: `approval_rules` table holds "remember" decisions |
| Skill | `cloud_skills` row | `kind` distinguishes doc / playbook / helper_ref |
| Helper (new K-phase) | `cloud_agent_helpers` row | Agent-authored TS, executed in K.5 sandbox |
| Cron schedule | `automations[].triggers[].type='schedule'` OR legacy `cloud_schedules` | Prefer the former |
| Browser cookies / context | `workspace_browser_sites` row | Per-host; `source` flags origin (browserbase / desktop_import) |

---

## 22. Things that no longer exist (delete from desktop if referenced)

The planning doc `DESKTOP_INTEGRATION.md` mentioned the following — none of these shipped:

- `/v1/runtime/runs/*` — the `/v1/runtime/*` namespace only carries `/health` and `/contexts/*`. Runs live at `/v1/runs/*`. Use those.
- `/v1/runtime/workflows` — workflows are `automations` now; surface is `/v1/automations`.
- `/v1/runtime/approvals` — approvals are at `/v1/approvals` and `/v1/workspaces/:wsId/approvals`.
- `runtime_runs`, `runtime_workflows`, `runtime_approvals`, `runtime_trust_grants` tables — table names are `cloud_runs`, `automations`, `approvals`, `approval_rules`.
- "Trust grants" — closest equivalent is the `remember:true` flag on `/v1/approvals/:id` which writes an `approval_rules` row. No separate `/v1/trust-grants` API.
- "Take-over" endpoints — `/v1/runs/:id/cancel` exists; pause/resume mid-run is not currently supported.

---

## 23. Realtime (Supabase) tables to subscribe directly

The api emits to `cloud_activity`, `approvals`, `automation_outputs`, and `cloud_runs` on every write. The desktop can subscribe to these via the Supabase Realtime client (publication: `supabase_realtime`) for ultra-low-latency UI updates without going through the api's SSE proxies.

| Table | Use case |
|---|---|
| `cloud_activity` | Tool-call timeline on run-detail page (alternative to `/v1/runs/:id/events`) |
| `approvals` | Approval prompts (alternative to SSE stream) |
| `automation_outputs` | Output toasts (alternative to outputs/stream) |
| `cloud_runs` | Run status flips (status, completed_at, redispatch_attempts) |

SSE is the simpler option (auth via JWT, no Realtime client config). Realtime is the lower-latency option if you already have the Supabase client wired.

---

## 24. Versioning + compatibility

- The api is unversioned in path; breaking changes ship behind workspace-level feature flags configured per environment.
- All current endpoints are stable. Future breaking changes will be announced via a `Deprecation: <date>` response header for one release cycle before removal.

---

## 25. Open items for the desktop side

1. **Migrate the authoring chat path.** Desktop currently posts to `/v1/assistants/:id/messages` (legacy `assistant-compat`). New path is `/v1/workspaces/:wsId/authoring/messages` + SSE. The legacy path still works but doesn't get Opus 4.7 + browser + helper_write surfaced.
2. **Add a helpers list view.** No api route yet — the desktop can subscribe to `cloud_agent_helpers` via Realtime, or we add `GET /v1/workspaces/:wsId/helpers` if needed.
3. **Replace the 3s approval poll.** Switch to `/v1/workspaces/:wsId/approvals/stream` SSE.
4. **Wire `/v1/runtime/contexts/sync` for Chrome-import.** The path exists; the desktop's chrome-import feature needs to repoint from the old `/v1/cookie-sync/upload` (which lived on the legacy agent backend).
5. **Hook outputs/stream into the overlay.** Show toast when an automation drafts a Gmail / writes a sheet row / sends an SMS.
