# Extension Roadmap

This roadmap turns `EXTENSION-HANDOFF.md` into build phases for `runtime/extension/`. V1 target is Chromium MV3, TypeScript, WXT, rrweb for raw capture, and shared contracts from `@basics/shared`.

## Phase 00 — Scaffold and Contracts

Goal: make the extension a real workspace package and lock the API contracts before behavior lands.

Deliverables:
- Register `extension/` and `shared/` in `pnpm-workspace.yaml`.
- WXT package scaffold with MV3 permissions: `storage`, `cookies`, `tabs`, `notifications`, `alarms`, runtime API host permission, and optional SaaS host permissions.
- `@basics/shared/recording` exports the V1 recording payload schema and distilled step union.
- Document timestamp invariant: use `performance.timeOrigin + performance.now()` for merge with Lens.

Acceptance:
- `pnpm -F @basics/shared typecheck` passes.
- `pnpm -F @basics/extension typecheck` passes.
- No extension code logs cookie values, localStorage values, JWTs, or typed input values marked masked.

## Phase 01 — Auth and Workspace State

Goal: let the extension become an authenticated holder of the existing workspace JWT.

Deliverables:
- Popup shell showing signed-in workspace state, context sync status, and record button disabled until auth succeeds.
- Dashboard OAuth handoff opens from the extension and returns the workspace JWT through the existing `/v1/auth/token` flow.
- Store token and workspace metadata in `chrome.storage.local`.
- API client wrapper adds `X-Workspace-Token` and handles token-missing, token-expired, and network-failed states.

Acceptance:
- Signing in requires no new auth primitive.
- Clearing extension storage fully signs the extension out.
- API client tests cover missing token and 401 response handling.

## Phase 02 — Include-Domain Permissions

Goal: make cookie/localStorage scope explicit and user-controlled.

Deliverables:
- Fetch workspace include-domain list from runtime API or dashboard-provided config.
- Request `optional_host_permissions` only for included SaaS origins.
- UI shows which domains are enabled, pending permission, or denied.
- Domain matcher handles leading-dot cookie domains and subdomains consistently with runtime filtering.

Acceptance:
- Extension cannot read cookies for domains outside the granted include list.
- Permission denial is visible and does not break other domains.
- Domain matching mirrors `api/src/lib/contextSync.ts`.

## Phase 03 — Cookie Sync

Goal: replace the Lens-side Chrome profile decryption path for V1 browser state.

Deliverables:
- Background sync reads cookies via `chrome.cookies.getAll` for each granted domain.
- Normalize Chrome cookie shape to the existing `/v1/runtime/contexts/sync` contract.
- Trigger sync manually from popup, on alarm, and before run when stale.
- Send `profile_label`, `domains`, and cookie array to runtime API.

Acceptance:
- Sync succeeds against `/v1/runtime/contexts/sync` without changing runtime route shape.
- Cookie values are never persisted in extension logs or console output.
- Large-cookie guardrails respect the runtime route cap.

## Phase 04 — localStorage and sessionStorage Sync

Goal: add origin-scoped web storage capture where SaaS auth depends on it.

Deliverables:
- Content script reads `localStorage` and `sessionStorage` only on granted origins.
- Background validates origin and merges entries into the sync payload.
- Send localStorage entries using `{ securityOrigin, key, value }`.
- Decide whether sessionStorage is omitted, captured best-effort, or stored in a separate field after runtime support is explicit.

Acceptance:
- localStorage sync works for a stable test origin.
- Extension does not collect storage from non-included domains.
- Runtime response shows nonzero `local_storage_count` when entries are injected.

## Phase 05 — Recording Substrate

Goal: capture raw browser demonstrations with rrweb while enforcing redaction from day one.

Deliverables:
- Content script starts/stops rrweb recording on the active SaaS tab.
- Visible in-page recording indicator and stop control.
- Default mask password inputs and respect `.rr-mask`, `.rr-ignore`, and `.rr-block`.
- Buffer events locally during recording and POST on stop.

Acceptance:
- Password input values are masked in raw rrweb events and distilled steps.
- Five-minute demo remains within practical memory and payload limits.
- Recording can be canceled without POSTing events.

## Phase 06 — Step Extraction

Goal: distill raw rrweb events into an agent-readable V1 step list.

Deliverables:
- Selector scoring: prefer stable ids, labels, roles, accessible names, data attributes, then CSS fallback.
- Collapse repeated input changes into final `type` steps.
- Emit `navigate`, `click`, `type`, `keydown`, `scroll`, `wait`, and `extract` candidates using `@basics/shared/recording`.
- Preserve raw rrweb events alongside distilled steps.

Acceptance:
- Distilled output validates with `RecordingPayloadSchema`.
- A basic SaaS-like form demo produces a readable step list without duplicate keystroke noise.
- Masked inputs produce `{ masked: true, value: "" }` or another documented redacted value.

## Phase 07 — Recording Upload API

Goal: store demonstrations in runtime for hand-tuning and future synthesis.

Deliverables:
- Add runtime API route `POST /v1/runtime/recordings`.
- Persist recording metadata, raw rrweb event blob, and distilled steps.
- Dashboard can list recordings for a workspace or workflow.
- Extension retries upload safely or marks local draft as failed.

Acceptance:
- Upload is idempotent using a client-generated recording id.
- Runtime validates payload with shared schema.
- Failed upload does not lose the local recording until user discards it.

## Phase 08 — Approval Surface

Goal: surface pending approvals inside the user's active SaaS context when possible.

Deliverables:
- Background subscribes to runtime run events when workspace is signed in.
- Match approval domain to currently open tabs.
- Inject inline approval prompt into matching SaaS tab.
- Fallback to `chrome.notifications`; click opens dashboard approval view.

Acceptance:
- Approval resolution still goes through runtime API; extension is never authoritative.
- If no matching tab is open, notification fallback works.
- Reconnect behavior survives MV3 service worker suspension.

## Phase 09 — Hardening and Store Readiness

Goal: make the extension safe enough for design partners and Chrome Web Store review.

Deliverables:
- Permission copy and privacy disclosure for cookies, storage, and page recording.
- Redaction regression tests.
- Manual test matrix: Salesforce-like app, HubSpot-like app, Looker-like app, Notion-like app, generic test fixture.
- Production build, zip, and install instructions.

Acceptance:
- No broad host permission without user-initiated grant.
- No telemetry SDK added.
- Store package contains only required assets and compiled files.

## Phase 10 — V1 Design Partner Loop

Goal: use real recordings and synced contexts to hand-build the first partner workflows.

Deliverables:
- Record two complete partner demonstrations.
- Sync context and verify Browserbase session starts logged in.
- Hand-tune playbook prompts from distilled steps.
- Capture gaps as synthesis backlog, not extension scope creep.

Acceptance:
- At least one workflow can be recorded locally, replayed in cloud Chrome with existing auth state, and turned into a hand-built playbook.
- Take-over and approval flows remain runtime/dashboard-owned where appropriate.

