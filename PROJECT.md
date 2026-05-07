# Basics — Runtime

> The cloud workflow runtime. "Replicate it" for the demonstrate-then-replicate product. Pivot context lives in `../basics-capture-v2/STRATEGY-MEMO.md`.

## What this is

The runtime executes user playbooks against real SaaS tools in headless cloud Chromes, with live-view + take-over, approval gating, outcome verification, and audit logging. It is the cloud-side counterpart to the Lens daemon (`basics-capture-v2/`) which captures the demonstration. Runtime owns everything from "user clicks Run" to "playbook either succeeded or paused for human help."

It does **not** capture demonstrations (Lens does that), do voice (`agent/` does that), or run on the user's machine (Browserbase does the actual Chrome). It is a thin orchestration + tool surface + dashboard.

## Core value

A RevOps lead opens the dashboard, picks a workflow ("Weekly RevOps digest"), clicks Run. They watch it work in an embedded iframe. When the agent gets stuck on something, it pauses and asks via Slack DM or in-product. They take over, do the thing, click Resume. The workflow finishes, logs everything, and writes a row attesting the run actually achieved its outcome.

## Surfaces

| Surface | URL | Notes |
|---|---|---|
| Web dashboard | `app.trybasics.ai` | Run library, history, live-view (Browserbase `liveUrl` iframe), approvals, take-over, audit log. The `agent/` doc previously disallowed this hostname — the cloud-first pivot reverses that rule. |
| Browser extension | Chrome Web Store (Chromium for V1) | In-page approval prompts on SaaS tabs, run-status badge, demonstration recording UI, cookie + localStorage sync to runtime. **Replaces the desktop pill for V1.** See `EXTENSION-HANDOFF.md`. |
| Runtime API | `api.trybasics.ai/v1/runtime/*` | Mounted on the existing Hono surface via ALB path-based routing to a separate Fargate service. Reuses the workspace JWT (`X-Workspace-Token`) from `agent/`. |
| Marketing | `trybasics.ai` | Unchanged. |
| Auth | `trybasics.ai/login`, `/signup`, `/invite` | Unchanged. Reused. |
| Billing | `trybasics.ai/workspaces/:id/billing/*` | Unchanged. Reused. |

## Constraints

- **Backend language**: Node 22 / TypeScript. Hono. One service (`basics-runtime`) on AWS Fargate. No Python anywhere — the harness fork is ported to TS.
- **Frontend**: Next.js 16 (App Router) + React Compiler, React 19, deployed on Vercel. Scaffolded from `arhamkhnz/next-shadcn-admin-dashboard` (MIT) — same stack we already pinned, with auth shells, sidebar/layout, and theme presets pre-built. Trim legacy + unused dashboards as the runs/workflows/approvals surfaces get fleshed out.
- **Browser extension**: Manifest V3, TypeScript. Build framework chosen at extension Phase 0 (default recommendation: WXT — see `EXTENSION-HANDOFF.md`). Recording substrate forked from rrweb (MIT), with our own step-extraction pass distilling raw events into a `navigate | click | type | wait | extract` playbook. Workspace JWT for auth (verifier/holder, never issuer).
- **Package manager**: pnpm 10.x. Workspace with `api/`, `web/`, `extension/`, `harness/`, `shared/`.
- **Database**: same Supabase Postgres instance as `agent/`. New schema namespace (`runtime_*` tables). Schema owned by `basics-runtime`.
- **DB driver**: `postgres-js` with `max: 5, prepare: false`. Mirrors `agent/`'s pattern.
- **Migrations**: Drizzle Kit. Pre-deploy step.
- **Auth**: workspace JWT (`X-Workspace-Token`) issued by `agent/`'s existing `/v1/auth/token`. Runtime is a verifier, not an issuer.
- **LLM (primary)**: Anthropic Claude Sonnet 4.6 with the `computer_20250124` tool spec (or latest stable revision at Phase 0). Vercel AI SDK is the loop wrapper.
- **LLM (fallback)**: Gemini 2.5 Flash and OpenAI GPT-5 via AI SDK provider swap. Same playbook, different model — for cost A/B and resilience.
- **Cloud Chrome**: Browserbase. One project for us, workspace ID in session metadata. Sessions reference per-workspace Contexts for persistent state.
- **Take-over UX**: Browserbase `liveUrl` iframed in the dashboard. Pause/resume = backend toggle on whether the agent loop sends CDP commands.
- **Streaming protocol**: SSE for run output (matches AI SDK + `agent/`'s pattern).
- **Container base**: `node:22-alpine` multi-stage.
- **Testing**: Vitest. Integration tests use a real Browserbase test session against a stable target page (the runtime team will host one).

## Tech stack (pinned at Phase 0 — placeholders shown)

| Layer | Choice | Why |
|---|---|---|
| Backend framework | **Hono** | Matches `agent/`. Tiny, fast, edge-portable. |
| Agent loop | **Vercel AI SDK v5** | Multi-tool registration, multi-provider, streaming, first-class TS. |
| Browser tool surface | **Forked from `browser-use/browser-harness`** | Coordinate-click-first, screenshot-default. Ported to TS in `harness/`. ~500 LOC. We own the fork; Python upstream is reference. |
| CDP client | **`chrome-remote-interface`** | Canonical Node CDP. Used inside `harness/` to talk to Browserbase WS endpoints. |
| Cloud Chrome | **`@browserbasehq/sdk`** | Session lifecycle, Contexts, liveUrl. We do not use Stagehand — selector-driven, wrong philosophy for SF/Looker. |
| LLM clients | **`@ai-sdk/anthropic`**, **`@ai-sdk/google`**, **`@ai-sdk/openai`** | Provider-swap via AI SDK. |
| Database | **Supabase Postgres** (shared) + **Drizzle ORM** + **postgres-js** | Mirrors `agent/`. |
| Schema | New tables prefixed `runtime_` | Avoids collision with agent/voice/auth tables. |
| Frontend | **Next.js 16 + React 19 + React Compiler** | App Router, RSC where it helps. Hosted on Vercel. Initial scaffold from `arhamkhnz/next-shadcn-admin-dashboard`. |
| Frontend data | **TanStack Query v5** | Matches `desktop/`. SSE for run streams via `EventSource`. |
| Frontend UI | **shadcn/ui + Tailwind v4 + OKLCH theme** | Matches `desktop/` so we can lift components when the Electron pill comes back as v2. |
| Extension build | **TBD at extension Phase 0** (Plasmo / WXT / CRXJS+Vite) | All three target MV3 + TS-native. Default recommendation: WXT — pure Vite, less magic than Plasmo, more ergonomic than CRXJS. |
| Extension capture | **rrweb (MIT)** as substrate + our step-extraction pass | DOM-mutation + click + input capture is solved. The "compress raw events into a `navigate \| click \| type \| wait` playbook" layer is our work. Powers Sentry session replay + PostHog in production. |
| Slack | **Bolt for JS** | Approval DMs, take-over notifications. |
| Cron | **AWS EventBridge** → workflow trigger endpoint | Each scheduled run is a POST to the runtime API. No in-process scheduling. |
| Logging | **Pino** → CloudWatch | Matches AWS-native; structured. |
| Testing | **Vitest** + **Playwright** for E2E | Playwright drives a real Browserbase session for the integration suite. |

## What's explicitly out of scope (v1)

- **Demonstration → playbook synthesis.** Lens captures, but the synthesis pipeline (Phase D in the strategy memo) is not in this milestone. Hand-build playbooks for the first 2–5 design partners.
- **Workflow marketplace / template library UI.** Phase 11 puts the first 5 templates in code. The marketplace shipping surface is post-v1.
- **Drift detection / agent self-pause.** Strategy memo Phase 09. Browserbase + Claude already do this passably; revisit after design partners.
- **Multi-region.** Single AWS region (us-east-1) until paying customers ask.
- **SOC 2.** Months 6-9 per the strategy memo. Not v1.
- **Per-workspace Browserbase projects.** One project for now (`#5` decision). Cuts over later if enterprise demands hard isolation.
- **Desktop pill integration.** The Electron pill returns as the agent control plane in v2 (per `desktop/FULL-VISION.md`). V1 ships as web dashboard + browser extension; the pill's status / approval / take-over surfaces are absorbed into the extension for now.
- **Voice ("run the digest" via voice command).** `agent/` exists but won't wire to runtime in v1.

## Folder structure (target)

```
runtime/
├── PROJECT.md              # this file
├── ROADMAP.md              # phased plan
├── ARCHITECTURE.md         # diagrams, request shapes, schema
├── pnpm-workspace.yaml
├── api/                    # Hono service — runtime API + agent loop
│   ├── src/
│   │   ├── index.ts        # Hono entry
│   │   ├── routes/         # /v1/runtime/runs, /approvals, /workflows, /contexts
│   │   ├── orchestrator/   # run lifecycle: schedule → boot → execute → verify → close
│   │   ├── loop/           # Vercel AI SDK loop, tool registration
│   │   ├── tools/          # tool definitions matching computer_20250124 + ours
│   │   ├── middleware/     # approval gating, audit log, trust ledger
│   │   ├── checks/         # post-run verification primitives
│   │   ├── slack/          # approval/take-over DMs
│   │   ├── browserbase/    # session lifecycle, Context CRUD
│   │   └── db/             # Drizzle schema + queries
│   └── tests/
├── harness/                # the TS port of browser-harness's tool surface
│   ├── src/
│   │   ├── helpers.ts      # click_at_xy, screenshot, js, wait_for_load, etc.
│   │   ├── cdp.ts          # CDP client wrapper
│   │   └── types.ts
│   └── tests/
├── web/                    # Next.js dashboard
│   ├── app/
│   │   ├── (workspace)/    # workspace-scoped routes
│   │   │   ├── runs/
│   │   │   ├── workflows/
│   │   │   └── approvals/
│   │   └── api/            # server actions / route handlers
│   └── components/
├── extension/              # Chromium MV3 extension — replaces desktop pill for V1
│   ├── src/
│   │   ├── background/     # service worker — auth, SSE subscription, cookie sync
│   │   ├── content/        # content scripts — recording overlay, in-page approvals
│   │   ├── popup/          # toolbar popup — workspace status, recording controls
│   │   ├── recording/      # rrweb fork + step-extraction pass
│   │   └── lib/            # API client (consumes runtime/shared types)
│   ├── manifest.json
│   └── tests/
├── shared/                 # shared types: tool schemas, run states, approval shapes, recording step schema
└── infra/
    ├── sst.config.ts       # SST for Fargate + ALB + EventBridge
    └── migrations/
```

## Conventions

- **Default to no comments.** Only annotate non-obvious WHY (a hidden invariant, a CDP quirk, a Browserbase API gotcha).
- **Tools are pure functions over a CDP session handle.** No global state in `harness/`. The session handle is passed explicitly so concurrency is by construction.
- **Every tool call writes an audit row.** Even cheap reads. The audit log IS the product surface for "did the agent actually do the thing." Don't optimize this away.
- **Approvals are first-class.** Tools that require approval declare it in their schema (`requiresApproval: true | (params) => boolean`). The middleware intercepts before execution.
- **Trust grants narrow, never widen.** A grant says "auto-approve THIS action with THESE params in THIS scope." Defaulting to broader scope is a bug.
- **Streaming everywhere.** Run output streams via SSE. The dashboard never polls.
- **Cookies are state, not config.** The Browserbase Context is the canonical store. The extension-side `chrome.cookies` reader pushes into it; runtime never duplicates the cookie blob.

## Reference material

- `../basics-capture-v2/STRATEGY-MEMO.md` — pivot rationale, wedge, six-capability moat
- `../basics-capture-v2/PROJECT.md` — Lens daemon (the capture side)
- `../desktop/PROJECT.md` — the Electron pill (returns as v2 control plane)
- `../agent/CLAUDE.md` — voice infra + JWT auth source-of-truth
- `../reference/browser-harness/` — Python upstream we forked from. Read `daemon.py` + `helpers.py` for the original CDP patterns.
- Anthropic computer-use docs — https://docs.anthropic.com/en/docs/build-with-claude/computer-use
- Browserbase docs — https://docs.browserbase.com (Sessions, Contexts, liveUrl)
- Vercel AI SDK — https://ai-sdk.dev (multi-tool registration, streamText)
- rrweb — https://www.rrweb.io / https://github.com/rrweb-io/rrweb (extension recording substrate)
- Chrome MV3 docs — https://developer.chrome.com/docs/extensions/mv3
- Chrome DevTools Recorder schema — https://developer.chrome.com/docs/devtools/recorder (reference for step-list shape)

## Working with this codebase

- `pnpm install` — install deps for all workspaces
- `pnpm -F api dev` — Hono dev server with reload
- `pnpm -F web dev` — Next.js dev server
- `pnpm -F extension dev` — extension dev build (load unpacked via `chrome://extensions`)
- `pnpm -F harness test` — harness unit tests
- `pnpm -F api test:integration` — Browserbase-backed integration tests (requires `BROWSERBASE_API_KEY`)
- `pnpm typecheck` — TS across all workspaces
- `pnpm lint` — oxlint
