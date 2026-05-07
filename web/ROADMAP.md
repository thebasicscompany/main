# `web/` — Dashboard Roadmap

Local plan for the Next.js dashboard. The workspace-level phasing lives in `../ROADMAP.md`; this doc is just the "what pages, in what shape, in what order" for `runtime/web/`.

## Posture

Mock data first. Auth deferred. Ship a navigable shell with realistic content shapes so we can iterate on UX before any backend is wired. Lift visual primitives from `arhamkhnz/next-shadcn-admin-dashboard` (already cloned), conversation surface from assistant-ui's Grok example, and the OKLCH theme + a few feature components from `../desktop/`.

We deliberately diverge from `../desktop/`'s nav. Desktop is a voice-first pill companion (overview → agents → sessions → memory → conversations → profile → settings). Cloud dashboard is mission control: **the run is the central artifact**, not the conversation. Naming aligns to the API surfaces in `../PROJECT.md` (`runtime_runs`, `runtime_workflows`) so screens, routes, and DB tables share vocabulary.

## Information architecture

Primary nav (left sidebar, in this order):

| Route | Purpose | Replaces (in desktop) |
|---|---|---|
| `/` | Today's view: live runs, pending approvals, recent failures | `overview` |
| `/runs` | Central run history. Live runs pinned to top. Filter by workflow, status, verification. | `sessions` (renamed) |
| `/runs/[runId]` | Three-pane run detail: timeline ◂ liveUrl iframe ▸ outcome | `sessions/$id` |
| `/workflows` | Library of workspace playbooks. Schedule, last run, success rate. | `agents` (renamed) |
| `/workflows/[id]` | Workflow detail (V1 read-only since playbooks are TS modules) | `agents/$id` |
| `/approvals` | Pending queue + resolved log | (new — desktop has no equivalent) |
| `/context` | Browserbase Context inspector: which SaaS apps are logged in, last sync timestamps, force-resync | `context` (re-skinned) |
| `/audit` | Workspace-wide audit log, exportable | (new — was implicit in desktop) |
| `/assistant` | Grok-styled assistant-ui chat surface — ask about runs, draft workflows | repurposed from `conversations` |
| `/settings` | Sub-routes below | `settings`, `profile`, `dev` |

Settings sub-routes:

```
/settings/profile        — name, avatar, email
/settings/workspace      — members, billing
/settings/integrations   — Slack, SaaS credentials, OAuth grants
/settings/trust          — per-action auto-approval grants (the trust ledger UI)
/settings/schedules      — workspace cron overview
/settings/developer      — API tokens, webhooks, the desktop `dev` tooling
```

Auth shell (deferred, mocked for now): keep template's `/auth/v2/login` + `register` + add `forgot-password`, `update-password`, `auth/confirm`, `auth/error`. Wire to `/v1/auth/token` later per `agent/CLAUDE.md`.

## What we drop from desktop's nav

- **`memory`** — Lens/voice domain, not cloud-runtime concern.
- **`debug/voice`** — voice not in V1.
- **Standalone `profile` route** — folded into `/settings/profile`.
- **Standalone `dev` route** — folded into `/settings/developer`.
- **`conversations` as a list-of-voice-transcripts** — there are no voice transcripts on the cloud side. The route name lives on as `/assistant`, but the surface is a chat with the workspace agent (assistant-ui Grok), not a history viewer.

## Run detail — the only screen that needs a custom layout

Three-pane resizable (`react-resizable-panels` already in template):

```
┌─────────────────────────────────────────────────────────────────┐
│ Run header: workflow · status · started · duration · checks ✓ │
├──────────────┬───────────────────────────────────┬──────────────┤
│ Timeline     │ Live view (Browserbase iframe)    │ Outcome      │
│              │                                   │              │
│ ▶ Tool call  │ [iframe of liveUrl]               │ Checks       │
│   navigate   │                                   │  ✓ slack     │
│ ▶ Reasoning  │                                   │  ✓ field=foo │
│ ▶ Tool call  │ ┌─[Take over]─────────────────┐  │  ✗ count>0  │
│   click_at   │                                   │              │
│ …            │                                   │ Approvals    │
│              │                                   │  ▸ pending  │
│              │                                   │              │
│              │                                   │ Audit rows   │
└──────────────┴───────────────────────────────────┴──────────────┘
```

Take-over expands the iframe full-bleed. Timeline is scrubbable (think of it as a video timeline keyed by tool-call timestamp). Reasoning/tool calls hydrate from SSE in production; from a local JSON fixture during mock phase.

## Component sourcing

| Need | Source | Notes |
|---|---|---|
| Sidebar shell, breadcrumbs, theme switcher | template (`arhamkhnz`) | Already cloned. Strip legacy + unused dashboards once routes are wired. |
| OKLCH theme presets | template + lift `../desktop/` palette | Template ships Tangerine/Brutalist/Soft Pop. Add a `Basics` preset matching desktop's. |
| Data tables (runs list, workflows list, approvals queue, audit log) | template's TanStack Table patterns | Template's CRM/Productivity dashboards have the table primitives we want; lift, drop the rest. |
| Chat (`/assistant`) | assistant-ui Grok example | `npx assistant-ui add thread` then graft the Grok skin from <https://www.assistant-ui.com/examples/grok>. |
| Markdown rendering inside chat | `@assistant-ui/react-markdown` (already used in desktop) | Lift `desktop/src/renderer/src/components/assistant-ui/markdown-text.tsx`. |
| Resizable panes (run detail) | `react-resizable-panels` | Already in template. |
| Charts (run trends on `/`, success rate on `/workflows`) | `recharts` | Already in template. |

## Mock data plan

A single `web/src/mocks/` folder with realistic fixtures:

```
mocks/
├── runs.ts          — 30-50 runs across statuses (running, succeeded, failed, verified, takeover)
├── workflows.ts     — 5 workflows matching PROJECT.md's launch templates
├── approvals.ts     — 3 pending + 20 resolved
├── audit.ts         — 200 rows from a synthesized 7-day window
├── context.ts       — 4 SaaS domains, mixed sync states
├── assistant.ts     — sample chat threads
└── workspace.ts     — fake user, fake workspace
```

All page components read from a hook (`useRuns()`, `useWorkflow(id)`, etc.) that today returns the mock. When the API exists, swap the hook impl to `fetch` + TanStack Query — pages don't change.

## Phased delivery (web-local)

Sized so each lands a self-contained PR.

### W1 — shell + nav

- Update template's sidebar to the IA above.
- Replace template logo + brand strings.
- Wire empty route stubs for every primary nav entry (rendering "coming soon" placeholders).
- Drop legacy `(legacy)` dashboards. Keep auth screens as-is, do not wire.
- Lift OKLCH palette from desktop, add `Basics` theme preset, set as default.

**Deliverable:** clickable shell, every primary nav entry navigates, branding looks like ours.

### W2 — runs list + run detail

- `/runs` table with realistic mock data, filters, status pills.
- `/runs/[runId]` three-pane layout. Iframe shows a placeholder image (Browserbase liveUrl is server-issued; mock is fine). Timeline rendered from fixture JSON.
- Take-over and Pause/Resume buttons render but only toggle local state.

**Deliverable:** demo-able run experience end-to-end against fixtures.

### W3 — workflows + approvals + assistant

- `/workflows` list + detail (read-only).
- `/approvals` queue + resolved log.
- `/assistant` Grok-style chat, reads/writes a local fixture for now (no LLM wired).

**Deliverable:** the four high-traffic surfaces all functional against mocks.

### W4 — context + audit + settings

- `/context` SaaS sync inspector.
- `/audit` exportable log.
- `/settings/*` sub-routes — at least Profile, Workspace, Integrations, Trust render with mock data; Developer + Schedules can be stubs.

**Deliverable:** every primary nav entry has real shape, the dashboard is screenshot-ready for design partner conversations.

### Later — wire to API

Replace each mock hook with TanStack Query against `api.trybasics.ai/v1/runtime/*`. SSE for live run updates. Auth via `/v1/auth/token`. This is downstream of `../api/`'s phases P00–P05.

## Conventions

- **Default to no comments.** Match `../PROJECT.md` line 116.
- **Routes named after API resources** (`runs`, `workflows`, `approvals`) — never invent UI-only vocabulary.
- **One mock fixture per nav entry.** No shared "mock everything" file — keeps swap-to-API atomic.
- **TanStack Query for all data, even mocks.** So the hook signature is identical when we cut over.
- **No premature abstractions.** Three near-duplicate table pages are fine until they're not.
