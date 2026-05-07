# ROADMAP

12-week phased plan for the runtime, aligned to the strategy-memo timeline ("Months 1-3 — pivot positioning + 5 design partners"). Read this once for the through-line; then work from individual phase docs in `phases/`.

## North star

**Within 12 weeks, two B2B SaaS RevOps design partners are running a hand-built weekly playbook on Basics Runtime, in cloud Chrome, with live-view + take-over + approval gating + audit log + outcome verification, paying $499/mo as design-partner pricing.**

That's the proof point that says the wedge is real and the runtime is buildable. Everything in this roadmap is in service of that.

## The arc

```
   Week 1-2     Week 3-4      Week 5-6      Week 7-8      Week 9-10     Week 11-12
┌──────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌────────────┐
│ Scaffold │ │ Harness +  │ │ Approvals  │ │ Lens cookie│ │ Workflow │ │ Design     │
│ + first  │→│ agent loop │→│ + audit +  │→│ sync +     │→│ library  │→│ partner    │
│ run      │ │ + dashboard│ │ checks     │ │ take-over  │ │ + 5 tpls │ │ onboarding │
│ end-to-  │ │ skeleton   │ │ middleware │ │ UX         │ │          │ │            │
│ end      │ │            │ │            │ │            │ │          │ │            │
└──────────┘ └────────────┘ └────────────┘ └────────────┘ └──────────┘ └────────────┘
   P00-P01     P02-P03         P04-P06        P07-P08        P09-P10     P11-P12
```

The path is mostly sequential because:
- Can't do approvals before there's a loop (P02 → P04)
- Can't do take-over before live-view is wired (P03 → P08)
- Can't do cookie sync before workspace Contexts exist (P02 → P07)
- Can't onboard design partners before checks + audit are real (P05/P06 → P12)

Parallelism opportunities:
- **P02 + P03**: harness port and dashboard skeleton are independent.
- **P05 + P06**: audit log writer and check function runner are independent.
- **P07 + P08**: Lens-side cookie extractor (Rust) and dashboard take-over UX (web) don't share code.

## Phase-by-phase

### [Phase 00 — Scaffold](./phases/00-scaffold.md) — Week 1

pnpm workspace. `api/`, `web/`, `harness/`, `shared/`. SST config for Fargate + ALB. Drizzle migration scaffold against the shared Supabase Postgres (`runtime_*` schema namespace). Decide hostnames (`app.trybasics.ai` vs alternative; reverses the `agent/` rule), wire ALB to runtime API at `api.trybasics.ai/v1/runtime/*`. Workspace JWT verifier middleware copied from `agent/`. Output: `pnpm dev` boots api + web; `/v1/runtime/health` returns 200 with a verified workspace token.

### [Phase 01 — First end-to-end run](./phases/01-first-run.md) — Week 2

The thinnest possible vertical slice: a hardcoded "open example.com and screenshot" workflow runs against a real Browserbase session, results stream via SSE, dashboard shows the live-view iframe and the screenshot. No agent loop yet — just CDP → Browserbase → SSE → React. Output: end-to-end pipe is real, watchable in a browser.

### [Phase 02 — Harness fork (TS port)](./phases/02-harness-port.md) — Week 3

Port `browser-harness`'s helper surface to TypeScript in `harness/`: `click_at_xy`, `capture_screenshot`, `js`, `new_tab`, `wait_for_load`, `wait_for_network_idle`, `ensure_real_tab`, `http_get`, `cdp` raw escape hatch. Drop the daemon and CLI patterns. Each helper is a pure function over a CDP session handle. Unit tests against `chrome-headless-shell`; integration tests against a Browserbase session. Output: 100% of the upstream helpers we plan to use, ported, tested, ~500 LOC.

### [Phase 03 — Agent loop + dashboard skeleton](./phases/03-agent-loop.md) — Week 4

Vercel AI SDK loop with multi-tool registration: Anthropic's `computer_20250124` for visual actions + our own tools (`navigate`, `js`, `extract`, `wait_for_load`, `http_get`, `cdp_raw`) registered alongside. SSE streams tool calls + reasoning + screenshots to the dashboard. Dashboard renders the run timeline. First non-trivial test: agent navigates GitHub, reads a PR title, returns it. Output: an LLM driving the harness through Browserbase, watchable live, with full reasoning visible.

### [Phase 04 — Approval gating middleware](./phases/04-approvals.md) — Week 5

`approvals` table. Tools declare `requiresApproval` in their schema. Middleware intercepts before execution, persists pending row, dispatches to two surfaces: in-product (SSE event → dashboard prompt) and Slack DM (Bolt for JS). First responder wins. Approve → resume. Reject → tool returns an error to the model, which decides what to do. 30-min timeout default. Output: agent pauses on a flagged action, both surfaces show the prompt, user clicks approve in either, agent continues.

### [Phase 05 — Audit log](./phases/05-audit.md) — Week 6

`runtime_runs`, `runtime_run_steps`, `runtime_tool_calls` tables. Every tool call writes a row: tool name, params, result-or-error, screenshot, timestamp, model latency, browser latency, cost. Run history page in dashboard renders this. Filterable, exportable. Output: a CFO can audit any run end-to-end.

### [Phase 06 — Check functions](./phases/06-checks.md) — Week 6 (parallel with P05)

Post-run verifier. A check function is a TS module that takes the run context + the workspace's tool credentials, queries the target system (e.g. Salesforce REST API), and returns `{ passed: bool, evidence }`. Built-in primitives: `crm_field_equals`, `slack_message_posted`, `record_count_changed`, `url_contains`. Run lifecycle: tool execution → checks → mark run `verified` or `unverified`. **This is the outcome-based-pricing weapon.** Output: a run row attests not just "the agent finished" but "the agent achieved what the playbook said it would."

### [Phase 07 — Lens cookie/state sync](./phases/07-cookie-sync.md) — Week 7-8

Two halves, independent:
- **Lens side** (`basics-capture-v2/daemon/`): Rust module that reads Chrome cookies (encrypted SQLite at `~/Library/Application Support/Google/Chrome/Default/Cookies`, decrypted via macOS Keychain entry "Chrome Safe Storage") and localStorage (LevelDB). `profile-use`'s approach (copy profile dir to temp first so Chrome can stay open) is the working reference. Filtered by include-domains list. Pushes encrypted blob to `api.trybasics.ai/v1/runtime/contexts/sync`.
- **Runtime side** (`api/src/browserbase/`): receives the blob, creates or updates a per-workspace Browserbase Context. Inject pattern: boot a session pointed at the Context, run CDP `Network.setCookies` + `Storage.setStorageItems`, close cleanly so the Context persists. Subsequent sessions inherit state.

Output: design partner records a demonstration in their browser → 5 minutes later, a cloud Chrome can replay the playbook already logged in to Salesforce/HubSpot/Looker/Notion.

### [Phase 08 — Take-over UX](./phases/08-takeover.md) — Week 8

Dashboard "Take over" button. Clicking it: backend pauses the agent loop (stops sending CDP commands), surfaces the iframe full-bleed, user drives the cloud Chrome directly. "Resume" sends a screenshot + a "you're back" turn to the agent, which resumes from current state. Per-action trust ledger: when user takes over to do action X, surface "Auto-approve action X here next time?" Output: agent gets stuck → user takes over → agent learns the new branch.

### [Phase 09 — Trust ledger](./phases/09-trust-ledger.md) — Week 9

`runtime_trust_grants` table. Schema: `(workspace_id, action_pattern, params_constraint, scope, granted_at, granted_by, expires_at)`. Approval middleware checks the ledger first; matching grants auto-approve and audit. Take-over UX writes grants. Per-workflow vs per-workspace scopes. Time-limited grants. UI for reviewing/revoking. Output: trust accrues at the action level, not the workflow level — the moat the strategy memo named.

### [Phase 10 — Workflow library + editor](./phases/10-workflow-library.md) — Week 10

Workflows-as-code in v1: each playbook is a TS module exporting `{ id, name, schedule, prompt, checks, requiredCredentials }`. Library page in dashboard lists them per workspace. Run-now button. Schedule editor (cron). No visual editor yet — that's post-v1. Output: a workspace owner can browse their workflows, see status, schedule, kick off ad-hoc runs.

### [Phase 11 — First 5 launch templates](./phases/11-templates.md) — Week 11

Hand-written playbooks for the five workflows from the strategy memo: weekly RevOps digest, new-deal account research, renewal risk monitor, CRM hygiene, quarterly board metrics. Each ships with: prompt, tool credential schema, check functions, expected duration. Two of these are tuned with the first design partner's data; three are scaffolded. Output: a new workspace can pick a template and have a working playbook in <30 minutes.

### [Phase 12 — Design partner onboarding](./phases/12-onboarding.md) — Week 12

Pick 2 partners from the design-partner shortlist. Onboard them in person: install Lens, sync cookies, customize one template, schedule it, run it three times with us watching, hand off. Slack channel for feedback. $499/mo design-partner pricing. **Goal: each partner runs their playbook 3 weeks consecutively with <2 take-overs/run by week 3.** Output: two paying design partners, real evidence of the wedge.

## Decision gates between phases

- **After P01** — does the basic pipe work in a 50ms-RTT cloud setup? If Browserbase latency is unworkable, escalate before building more on it.
- **After P03** — is Claude's computer-use spec a clean fit for our tool surface? If we're fighting the tool schema, reconsider matching it (the question we resolved with the user, but reverify with real runs).
- **After P06** — are check functions actually catching false-success runs? If not, the outcome-based pricing claim is hollow.
- **After P08** — does take-over feel like one product or two products jammed together? If it's the latter, redesign before P12.
- **After P12** — do the design partners renew at $799/mo (the priced tier)? That's the wedge validation.

## What's deferred to v2

- Demonstration → playbook synthesis pipeline (the eventual moat; needs P11 templates + ~10 partners to generate enough training signal first)
- Workflow marketplace UI
- Visual workflow editor
- Drift detection / self-pause
- Per-workspace Browserbase projects
- Multi-region
- SOC 2
- Desktop pill integration as agent control plane (the v2 differentiator from the strategy memo)
- Voice commands to runs
- Anthropic Claude as primary model swap with cheap Gemini for boilerplate steps (cost optimization, not table stakes)

## What absolutely must NOT slip

1. **Audit log** — the CFO-defensible artifact. Without it, take-over and approval are theater.
2. **Check functions** — outcome pricing is the Clay-killer pitch. Skipping these undoes the differentiator.
3. **Cookie/state sync from Lens** — without it, demonstration is a dead end and the product reads as "yet another browser agent."
4. **Take-over UX** — the most undervalued moat per the strategy memo. The marketing video is "watch the agent get confused, the analyst takes over, agent learns." That video doesn't exist if this phase slips.
5. **Trust ledger** — without per-action trust, every run pings the user; the product feels like babysitting, not delegation.
