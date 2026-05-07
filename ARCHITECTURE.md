# ARCHITECTURE

How the runtime fits together. Read after `PROJECT.md`. The "why" lives in `../basics-capture-v2/STRATEGY-MEMO.md`.

## Block diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Web dashboard  (app.trybasics.ai — Next.js 16 on Vercel)       │
│                                                                  │
│  ─ Run library, history, schedule editor                         │
│  ─ Live-view: <iframe src={browserbaseSession.liveUrl} />        │
│  ─ Take-over button → POST /v1/runtime/runs/:id/takeover         │
│  ─ Approval prompts via SSE                                      │
│  ─ Trust-grant management UI                                     │
└──────────────────┬──────────────────────────────────────────────┘
                   │ HTTPS (REST + SSE)
                   │ Auth: workspace JWT (X-Workspace-Token)
┌──────────────────▼──────────────────────────────────────────────┐
│  Runtime API  (api.trybasics.ai/v1/runtime/* — Hono on Fargate) │
│                                                                  │
│  ┌─ Orchestrator (one async fiber per running workflow)         │
│  │   ─ Boot Browserbase session w/ workspace Context            │
│  │   ─ Vercel AI SDK loop                                       │
│  │   ─ Model: Claude Sonnet 4.6 (computer_20250124)             │
│  │   ─ Tools: visual (Anthropic spec) + ours (js, cdp, ...)     │
│  │                                                               │
│  ├─ Tool surface  (forked from browser-harness, ported to TS)   │
│  │   click_at_xy, capture_screenshot, js, navigate,             │
│  │   wait_for_load, http_get, ensure_real_tab, raw cdp(...)     │
│  │                                                               │
│  ├─ Approval middleware                                          │
│  │   ─ Check trust ledger first                                 │
│  │   ─ Persist pending row, dispatch (Slack + dashboard SSE)    │
│  │   ─ Wait for resolution, then resume or fail tool            │
│  │                                                               │
│  ├─ Audit log writer       — every tool call → runtime_tool_calls │
│  ├─ Check function runner  — post-execution outcome verification  │
│  ├─ Trust ledger           — runtime_trust_grants                │
│  ├─ Cookie sync endpoint   — extension → Browserbase Context     │
│  ├─ Recording endpoint     — extension → rrweb log + step list   │
│  └─ Slack adapter (Bolt)   — approval DMs, run notifications     │
└──────────┬─────────────────────┬────────────────────────────────┘
           │ CDP WS (one per run)│ Postgres (Drizzle)
           │                     │
┌──────────▼──────────┐  ┌───────▼─────────────────────────────────┐
│  Browserbase        │  │  Supabase Postgres (shared with agent/) │
│                     │  │                                          │
│  ─ One Session per  │  │  runtime_workflows                      │
│    running workflow │  │  runtime_runs                           │
│  ─ Per-workspace    │  │  runtime_run_steps                      │
│    Contexts         │  │  runtime_tool_calls (audit log)         │
│  ─ liveUrl iframe   │  │  runtime_approvals                      │
│  ─ Stealth + proxy  │  │  runtime_trust_grants                   │
│  ─ Captcha solving  │  │  runtime_check_results                  │
│                     │  │  runtime_contexts (Browserbase ID map)  │
└─────────────────────┘  └─────────────────────────────────────────┘
            ▲                                       ▲
            │ encrypted state blob                  │ SSE: approvals,
            │ POST /v1/runtime/contexts/sync        │ run status
            │ recording payloads                    │
            │ POST /v1/runtime/recordings           │
            │                                       │
┌───────────┴────────────────────────┐  ┌───────────┴──────────────────┐
│  Browser extension (Chromium MV3)  │  │  Lens daemon (macOS)         │
│  runtime/extension/                │  │  basics-capture-v2/          │
│                                    │  │                              │
│  ─ Cookie/localStorage sync via    │  │  ─ Screen OCR                 │
│    chrome.cookies + content script │  │  ─ System audio + microphone  │
│  ─ Recording overlay (rrweb fork)  │  │  ─ Whisper transcription      │
│  ─ Step-extraction pass            │  │  ─ Accessibility-tree events  │
│  ─ In-page approval prompts (SSE)  │  │                              │
│  ─ Run-status badge                │  │  Always-on. Captures the      │
│  ─ Workspace JWT in                │  │  cross-app context the        │
│    chrome.storage.local            │  │  extension can't see.         │
└────────────────────────────────────┘  └──────────────────────────────┘
```

## Component responsibilities

### Orchestrator
Single owner of a run. Lifecycle: `pending → booting → running → (paused) → verifying → completed | failed`. Holds one CDP WebSocket. On crash, marks the run `failed` and tears down the Browserbase session. No retry by default — playbooks decide their own retry semantics.

### Tool surface (`harness/`)
Pure functions over a CDP session handle. No globals. Each function:
- Sends one or more CDP messages
- Returns a strongly-typed result
- Throws on protocol errors (orchestrator catches)
- Does NOT retry, log, or audit (middleware does that)

### Approval middleware
Sits between the AI SDK tool dispatcher and the tool function. Decision tree:
1. Tool's schema declares `requiresApproval`? → check trust ledger
2. Trust ledger has matching active grant? → auto-approve, audit, run
3. No grant? → persist pending approval, dispatch to surfaces, await resolution
4. Approved → audit, run
5. Rejected → return synthetic error to model ("user rejected: <reason>"), let model adapt
6. Timeout (30 min default) → mark run `paused`, notify

### Audit log writer
Every tool call writes a row before AND after execution. Pre-row captures intent (tool, params); post-row updates with result, screenshot S3 key, latency. Pre/post are the same row (UPDATE), so partial failures leave a forensic trail.

### Check function runner
Runs post-tool-execution. A check is a TS module:

```ts
export async function check(ctx: RunContext): Promise<CheckResult> {
  // call Salesforce REST API, query Postgres, fetch a Slack thread, etc.
  return { passed: true, evidence: { ... } };
}
```

Multiple checks per playbook. All-pass = run `verified`. Any-fail = `unverified` (still completed, but not verified — pricing decision lives downstream).

### Trust ledger
Append-only. Grants are narrow by default. Schema:

```sql
runtime_trust_grants (
  id uuid pk,
  workspace_id uuid,
  granted_by uuid,        -- user_id
  action_pattern text,    -- e.g. "salesforce.update_opportunity"
  params_constraint jsonb,-- e.g. {"stage": {"$in": ["Qualified","Discovery"]}}
  scope text,             -- "workflow:<id>" | "workspace"
  expires_at timestamptz,
  revoked_at timestamptz
)
```

Match check: action_pattern matches AND params satisfy params_constraint AND scope contains current workflow AND not expired AND not revoked.

### Browser extension (`runtime/extension/`)
Chromium MV3. Three jobs in V1:

1. **Cookie + localStorage sync.** `chrome.cookies.getAll({ domain })` for each include-domain, plus localStorage via content-script `Object.entries(localStorage)` shipped back via `chrome.runtime.sendMessage`. Encrypt with workspace key, POST to `/v1/runtime/contexts/sync` with `X-Workspace-Token`. **Replaces the Lens-side Chrome-profile decryption pipeline entirely** — no more `~/Library/Application Support/Google/Chrome/Default/Cookies` SQLite parsing or Keychain "Chrome Safe Storage" decryption.
2. **Demonstration recording.** Content script overlays a recording UI on SaaS tabs. Capture substrate is rrweb (forked into `extension/src/recording/`) — MIT, used in production by Sentry session replay and PostHog. On stop, a step-extraction pass distills the rrweb event stream into a `navigate | click | type | wait | extract` playbook the agent can replay. Both layers POST to `/v1/runtime/recordings`: raw rrweb events for replay-debugging and the v2 synthesis pipeline; distilled steps as the seed for v1 hand-tuning.
3. **In-page approval surface.** Background service worker holds an SSE connection to `/v1/runtime/runs/:id/events`. When a pending-approval event names a domain the user has open, the relevant tab gets an inline prompt. Otherwise `chrome.notifications` → click opens dashboard.

Auth: extension opens dashboard's existing OAuth flow → receives workspace JWT → stores in `chrome.storage.local`. Verifier/holder, not issuer.

## Cron firing (Phase 10.5)

EventBridge fires scheduled workflows by calling the runtime API
directly. The path is:

```
EventBridge per-workflow rule
  ─ schedule expression: cron(...) | rate(...)
  ─ target: API destination → POST /v1/runtime/workflows/{id}/run-now
  ─ headers: X-Cron-Secret (carried via EventBridge Connection)
       │
       ▼
Runtime API
  ─ requireCronOrWorkspaceJwt: validates X-Cron-Secret
  ─ resolves workflow_id → workspace_id from runtime_workflows row
  ─ startRun() — same path as a user-initiated run
```

Per-workflow rules are managed by the API process at workflow
create/patch/delete time (see `api/src/lib/eventbridge.ts`). The
*infrastructure* (connection, API destination, IAM role) lives in
`sst.config.ts`. When `EVENTBRIDGE_RULE_PREFIX` is unset (dev / test),
the lifecycle helpers no-op so the API runs without AWS creds.

## Run lifecycle (sequence)

```
1.  Cron (EventBridge → /v1/runtime/workflows/:id/run-now) or user
                              ← { runId, status: "running" }
2.  Orchestrator picks up run, INSERT runtime_runs row
3.  Orchestrator → Browserbase: create session w/ workspace Context, metadata={workspace_id, run_id}
                              ← { sessionId, liveUrl, cdpUrl }
4.  Orchestrator → Postgres: UPDATE runtime_runs SET status="running", live_url, browserbase_session_id
5.  Dashboard subscribes via SSE → /v1/runtime/runs/:id/events
6.  AI SDK loop:
    a. Take screenshot via harness
    b. Send to Claude with history
    c. Claude returns tool call
    d. Approval middleware checks trust ledger
       ─ Match → continue
       ─ No match → write runtime_approvals row, dispatch Slack + SSE, block fiber
    e. Audit row created
    f. Tool function executes
    g. Audit row updated with result + screenshot
    h. Result returned to model
    i. Repeat until model emits final answer or hits step limit
7.  Orchestrator runs check functions
8.  UPDATE runtime_runs SET status="completed"|"failed"|"unverified", verified_at
9.  PATCH Browserbase session → stop (Context persists)
10. SSE channel closes
```

## Approval flow

```
Tool dispatcher
      │
      ▼
Approval middleware ── trust ledger match? ──► auto-approve
      │ no match
      ▼
INSERT runtime_approvals (status="pending", run_id, tool, params)
      │
      ├─► Slack DM via Bolt   (interactive buttons: Approve / Reject)
      └─► SSE event to dashboard (renders prompt component)

      ▼
First responder writes resolution
      │
      ├─ approved + "remember this" checked? → INSERT runtime_trust_grants
      ▼
UPDATE runtime_approvals (status="approved"|"rejected", resolved_by, resolved_at)
      │
      ▼
Orchestrator fiber unblocks → tool runs (or returns rejection error to model)
```

## Take-over flow

```
User clicks "Take over"
      │
      ▼
POST /v1/runtime/runs/:id/takeover
      │
      ▼
Orchestrator: set run.takeover_active = true
              (loop checks this flag between tool calls — does not send new CDP commands)
      │
      ▼
SSE event: {type: "takeover_active"} → dashboard expands iframe full-bleed
      │
      ▼
User drives the iframe directly (Browserbase's liveUrl is interactive)
      │
      ▼
User clicks "Resume" → POST /v1/runtime/runs/:id/resume
      │
      ▼
Orchestrator:
  - Take fresh screenshot via harness
  - Inject "you were paused; user did <recent CDP events from Browserbase log>; here is the current state" into model context
  - Surface "Auto-approve <last few user actions> next time?" → potential trust grants
  - Set takeover_active = false
  - Resume loop
```

## Cookie sync flow (Extension → Browserbase Context)

V1 moves cookie/state extraction off the Lens daemon and into the browser extension. The Chrome-profile decryption gymnastics — copy profile dir, parse the `Cookies` SQLite, decrypt via Keychain "Chrome Safe Storage", read LevelDB for localStorage — are gone. `chrome.cookies` returns the same data with three lines and one permission prompt.

```
User installs extension + signs in (one OAuth round-trip via dashboard)
      │
      │  scheduled (every N hours), on-demand from dashboard,
      │  or pre-run if Context is stale
      ▼
Extension service worker:
  - For each domain in workspace include_domains:
      chrome.cookies.getAll({ domain })
  - Content-script per active tab:
      Object.entries(localStorage), Object.entries(sessionStorage)
      → chrome.runtime.sendMessage to background
      │
      ▼
Encrypt blob (workspace key from chrome.storage.local)
      │
      ▼
POST /v1/runtime/contexts/sync   with X-Workspace-Token
      │
      ▼
Runtime API: decrypt, look up workspace's Browserbase Context ID
              (create if first sync — INSERT runtime_contexts)
      │
      ▼
Boot a short-lived Browserbase session pointed at the Context
      │
      ▼
Via CDP on that session:
  - Network.setCookies(...filtered cookies)
  - Storage.setStorageItems(...localStorage entries)
      │
      ▼
PATCH /browsers/{id} {"action": "stop"}  ← clean close persists Context
      │
      ▼
Future runs boot sessions w/ this Context → already logged in
```

Lens still owns screen capture, audio, Whisper, and accessibility-tree events — the things a browser extension fundamentally can't do. The two surfaces merge server-side keyed by timestamp.

## Recording flow (demonstration → playbook)

```
User opens a SaaS tab, clicks the extension's "Record" in the popup
      │
      ▼
Content script injects rrweb recorder + an overlay UI
      │
      │  user performs the workflow
      ▼
rrweb captures:
  - DOM mutations (MutationObserver)
  - Click coordinates + targeted nodes
  - Input events (rr-mask on [type=password] + any flagged element)
  - Navigation, scroll, viewport changes
      │
      ▼
User clicks "Stop"
      │
      ▼
Step-extraction pass (extension-side) walks the rrweb event stream:
  - rrweb click on <button>X         → { kind: 'click', selector, text, coords }
  - rrweb input on <input>           → { kind: 'type', selector, value (redacted if masked) }
  - location change                  → { kind: 'navigate', url }
  - long idle                        → { kind: 'wait', reason: 'idle' }
      │
      ▼
POST /v1/runtime/recordings
  { events: [...rrweb raw], steps: [...distilled] }
  with X-Workspace-Token
      │
      ▼
Runtime API stores both:
  - raw rrweb event log (replay/debug + v2 synthesis pipeline)
  - distilled step list (seed for the agent's playbook prompt)
      │
      ▼
(v1) Engineer hand-tunes the agent prompt from the distilled steps
(v2) Synthesis pipeline turns distilled steps + rrweb context
     into a playbook prompt automatically
```

The step schema lives in `runtime/shared/recording.ts` and is roughly aligned with [Chrome DevTools Recorder](https://developer.chrome.com/docs/devtools/recorder) so we get free `@puppeteer/replay` interop later if useful.

## Database schema (sketch — Drizzle definitions live in `api/src/db/schema.ts`)

```sql
-- Workflows owned by a workspace
runtime_workflows (
  id uuid pk,
  workspace_id uuid fk,
  name text,
  schedule text,             -- cron, nullable for manual
  prompt text,               -- the playbook prompt sent to Claude
  required_credentials jsonb,
  check_modules text[],      -- names of TS check modules
  enabled bool default true,
  created_at timestamptz,
  updated_at timestamptz
)

-- One row per execution
runtime_runs (
  id uuid pk,
  workflow_id uuid fk,
  workspace_id uuid fk,
  status text,               -- pending|booting|running|paused|verifying|completed|failed|unverified
  trigger text,              -- cron|manual|api
  triggered_by uuid,         -- user_id, nullable
  browserbase_session_id text,
  context_id text,           -- Browserbase Context ID
  live_url text,
  takeover_active bool default false,
  started_at timestamptz,
  completed_at timestamptz,
  verified_at timestamptz,
  cost_cents int,            -- Browserbase + LLM tally
  step_count int,
  error_summary text         -- on failure
)

-- Each tool call (audit log)
runtime_tool_calls (
  id uuid pk,
  run_id uuid fk,
  step_index int,
  tool_name text,
  params jsonb,
  result jsonb,
  error text,
  screenshot_s3_key text,
  approval_id uuid fk,       -- if gated
  trust_grant_id uuid fk,    -- if auto-approved via grant
  model_latency_ms int,
  browser_latency_ms int,
  cost_cents int,
  started_at timestamptz,
  completed_at timestamptz
)

-- Approval events
runtime_approvals (
  id uuid pk,
  run_id uuid fk,
  tool_name text,
  params jsonb,
  status text,               -- pending|approved|rejected|timeout
  resolved_by uuid,          -- user_id
  resolved_at timestamptz,
  resolved_via text,         -- slack|dashboard
  remember bool,             -- created a trust_grant?
  expires_at timestamptz,    -- pending timeout
  created_at timestamptz
)

-- Trust grants (auto-approve rules)
runtime_trust_grants (
  id uuid pk,
  workspace_id uuid fk,
  granted_by uuid fk,
  action_pattern text,       -- e.g. "salesforce.update_opportunity"
  params_constraint jsonb,   -- jsonpath / equality constraints
  scope text,                -- workflow:<id> | workspace
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  created_at timestamptz
)

-- Check function results
runtime_check_results (
  id uuid pk,
  run_id uuid fk,
  check_name text,
  passed bool,
  evidence jsonb,
  ran_at timestamptz
)

-- Mapping workspace → Browserbase Context
runtime_contexts (
  id uuid pk,
  workspace_id uuid fk unique,
  browserbase_context_id text unique,
  last_synced_at timestamptz,
  cookie_domain_count int,
  created_at timestamptz
)
```

## Tool surface (registered with the AI SDK loop)

| Tool | Source | Purpose |
|---|---|---|
| `computer` (Anthropic `computer_20250124`) | Anthropic spec | All visual mouse + keyboard + screenshot ops. Claude is trained on this. |
| `navigate` | Ours | Go to a URL. Wraps `Page.navigate` + auto-`wait_for_load`. |
| `new_tab` | Ours | Open a fresh tab. CDP `Target.createTarget`. |
| `wait_for_load` | Ours | Block until `Page.loadEventFired`. |
| `wait_for_network_idle` | Ours | Block until N seconds of <K in-flight requests. |
| `js` | Ours | Execute JS in page context. Returns serialized result. |
| `extract` | Ours | Schema-constrained extraction: pass a Zod schema, get typed data back. Wraps `js` + a structured-output LLM pass. |
| `http_get` | Ours | The bulk-HTTP shortcut from upstream. No browser for static pages. |
| `cdp_raw` | Ours | Escape hatch. `cdp_raw("Domain.method", params)`. Used when nothing else works. |
| `ensure_real_tab` | Ours | Re-attach to a real page if current target is stale (omnibox popups, internal pages). |

Tools that mutate external state (`computer.left_click`, `js`, `cdp_raw`) flow through the approval middleware. Read-only tools (`screenshot`, `wait_for_load`, `http_get`) bypass approval.

## What this architecture deliberately does NOT do

- **Run agents on the user's local machine.** Cloud-only by design. Users with 10+ concurrent workflows shouldn't pay in their CPU.
- **Decrypt the Chrome profile to get cookies.** That was the original Lens-daemon plan. The extension owns cookies + localStorage via `chrome.cookies` and content-script localStorage reads. Lens stays out of that pipeline entirely.
- **Ship a desktop pill in V1.** The Electron pill returns in v2 (per `desktop/FULL-VISION.md`). V1 absorbs status / approvals / recording into the browser extension because the work lives in the browser anyway.
- **Let agents edit a shared playbook file.** The upstream `agent_helpers.py` self-editing pattern is great for solo developers, dangerous for multi-tenant. Playbooks are owned data.
- **Use Stagehand or other selector-driven AI wrappers.** Pixel clicks > selectors for the SF/Looker target stack. Worth the philosophical fight.
- **Use Browser Use Cloud.** Browserbase is the substrate. Browser-harness's profile-sync is replaced by our extension-side cookie sync + Browserbase Contexts.
- **Couple cost to user count.** Outcome-based pricing means we charge for verified runs, not seats. Architecture must keep cost-per-run measurable per run, not amortized.
