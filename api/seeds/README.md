# Phase 11 — Launch Templates

Hand-built workflow seeds for the strategy memo's five wedge use cases. Each template lands as one row in `runtime.runtime_workflows`. They are the bootstrap content: a fresh workspace can pick any of them and have a working playbook in minutes (after credential setup + per-partner tuning).

## Layout

```
seeds/
├── seed.ts                       # idempotent CLI: connects via DATABASE_URL, upserts 5 rows by (workspace_id, name)
├── templates/
│   ├── types.ts                  # WorkflowTemplate + RequiredCredentialsShape
│   ├── index.ts                  # ALL_TEMPLATES registry
│   ├── weekly-revops-digest.ts
│   ├── new-deal-account-research.ts
│   ├── renewal-risk-monitor.ts
│   ├── crm-hygiene.ts
│   └── quarterly-board-metrics.ts
└── README.md                     # this file
```

The shape contract is in [`templates/types.ts`](./templates/types.ts). Static-typecheck assertions live in [`../src/seeds-templates.test.ts`](../src/seeds-templates.test.ts) — that test fails if a template ever drifts from the `runtime_workflows` insert shape.

## How to apply the seed

```bash
cd ~/Developer/basics/runtime
doppler run --project backend --config dev -- sh -c \
  'DATABASE_URL="$SUPABASE_DATABASE_URL" pnpm --filter @basics/api seed:templates'
```

Optional env:

- `SEED_WORKSPACE_ID` — defaults to the test workspace from `docs/HANDOFF.md` (`139e7cdc-7060-49c8-a04f-2afffddbd708`). Override to seed any workspace.
- `SEED_DISABLE_OUTPUT=1` — silence the per-row log line.

## Idempotency

The seeder upserts by `(workspace_id, name)`:

1. For each template, look up an existing row with the same name in the target workspace.
2. If found → UPDATE the prompt / schedule / required_credentials / check_modules / enabled.
3. If not → INSERT a fresh row.

There is **no** UNIQUE constraint on `(workspace_id, name)` in the schema — display name is a UI label, not a slug. The seeder enforces uniqueness only for its own rows. If a hand-created workflow shares a name with a template, the seeder will overwrite the first match (DB ordering is non-deterministic; expect to handle this only if a partner manually duplicates a template name).

## Reversibility

To undo a seed:

```sql
DELETE FROM runtime.runtime_workflows
 WHERE workspace_id = '<workspace_id>'
   AND name IN (
     'Weekly RevOps Digest',
     'New-Deal Account Research',
     'Renewal Risk Monitor',
     'CRM Hygiene Sweep',
     'Quarterly Board Metrics'
   );
```

The seeder logs each row's id; for surgical undo of a single seed run, capture stdout and DELETE by id.

## Verification

After seeding, verify against the API:

```bash
curl -s -H "X-Workspace-Token: $JWT" \
  http://127.0.0.1:3001/v1/runtime/workflows | jq '.workflows[].name'
```

Should list all five names. Or run the existing test to confirm the templates' shape is intact:

```bash
pnpm --filter @basics/api test src/seeds-templates.test.ts
```

## Required credentials shape (JSONB)

The `required_credentials` column is JSONB, free-form per the Phase 10 schema. Phase 11 settles on:

```ts
{
  providers: Array<{
    provider: string;             // 'salesforce' | 'slack' | 'linkedin' | 'looker' | …
    scope: 'read' | 'write' | 'read_write';
    optional?: boolean;           // default false
    reason?: string;              // human-readable note shown in onboarding UI
  }>;
  notes?: string;                 // free-form description for partner-facing setup docs
}
```

This shape is not yet validated server-side. Phase 12 onboarding will key off `providers[].provider` to drive the "connect your tools" UI.

## Check primitives — what works today

Phase 11 lifted all four primitives to real implementations. They run inside the agent's already-attached Browserbase session (no API tokens, auth via Phase 07 cookie sync) and read DOM to produce structured evidence:

| name                    | status                                  | notes                                                                                                                              |
| ----------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `url_contains`          | **real** (Phase 06)                     | Plain `fetch` against a URL with substring assertion on the body. No browser needed.                                              |
| `crm_field_equals`      | **real** (Phase 11, browser-based)      | Opens a new tab on the agent's session, waits for the selector, reads `innerText`/`value`, compares to expected (string or regex). |
| `record_count_changed`  | **real** (Phase 11, browser-based)      | Same flow, parses an integer out of the matched element, compares to the previous run's `passed=true` baseline (auto-establishes on first run). |
| `slack_message_posted`  | **real** (Phase 11, browser-based)      | Navigates to `slack.com/archives/<channel>`. If the final URL bounces to login → fails with `not_authenticated`. Otherwise checks for an optional `contains` substring in the body. |

### Per-check param shape

Each entry on the workflow row is `{ name, params }`. The `params` shape per primitive:

```ts
url_contains:          { url: string, contains: string, timeoutMs?: number }
crm_field_equals:      { url: string, selector: string, expected: string | { regex: string }, timeoutMs?: number }
record_count_changed:  { url: string, selector: string, expectChange?: 'increase'|'decrease'|'any', minDelta?: number, timeoutMs?: number }
slack_message_posted:  { channel: string, contains?: string, timeoutMs?: number }
```

When a primitive fails it returns structured evidence, never throws. The current failure reasons are:

- `no_session`         — the orchestrator didn't pass a CdpSession (test paths only).
- `navigation_failed`  — `new_tab` / `wait_for_load` errored or timed out.
- `selector_not_found` — element didn't appear within the timeout.
- `value_mismatch`     — `crm_field_equals` only — actual differs from expected.
- `parse_failed`       — `record_count_changed` only — element text had no parseable integer.
- `count_unchanged`    — `record_count_changed` only — delta didn't satisfy expectChange/minDelta.
- `not_authenticated`  — `slack_message_posted` only — final URL bounced to a login page.
- `substring_not_found`— `slack_message_posted` only — `contains` was set but the body didn't include it.
- `read_error`         — JS evaluation threw inside the page.

### Partner tuning

The five seeded templates carry placeholder params (`TODO_REPORT_URL`, `C_REVOPS_TODO`, etc.) so it's obvious where partner-specific data needs to be filled in. Update the template file (or PATCH the workflow row in the DB) to drop in real channel ids, report URLs, and Lightning record selectors during onboarding.

## Per-template

### 1. Weekly RevOps Digest

**Intent.** Every Monday at 13:00 UTC, summarise last week's CRM activity (open pipeline, new opps, stage transitions, top deals) and post the digest into a designated Slack channel. Replaces the manual "screenshot Salesforce → paste into Slack" Monday ritual.

**What the partner customizes.**

- The Salesforce report URL (Reports → "Weekly Pipeline Movement" — every partner has a different report id).
- The KPI list (some partners want logo retention or lead velocity instead of pipeline movement).
- The Slack channel id (`#revops` is a placeholder).

**Credentials.** Salesforce (read), Slack (write).

**Schedule.** `cron(0 13 ? * MON *)` — every Monday 13:00 UTC.

**How to test.** Trigger via `POST /v1/runtime/workflows/<id>/run-now`. Watch the live URL, confirm the Slack message lands. With both checks: `slack_message_posted` will fail until Phase 09; `url_contains` works today (asserts the Salesforce login page is reachable).

### 2. New-Deal Account Research

**Intent.** When a new opportunity is created, gather public-facing context about the prospect company (homepage, LinkedIn, recent news) and write a tight brief back to the opportunity's Description field. Saves 30–45 minutes of pre-call research per AE per deal.

**What the partner customizes.**

- The Salesforce My Domain pattern (`https://acme.lightning.force.com/lightning/r/Opportunity/<id>/view`) — the placeholder uses `login.salesforce.com`.
- Whether to include the optional LinkedIn step.
- The format of the brief (some partners want bullet points, others want narrative).

**Credentials.** Salesforce (read_write), LinkedIn (read, optional).

**Schedule.** `null` — user-triggered. v1 doesn't have CRM-event triggers; the AE clicks Run after the opp is created. Phase 12+ will add event-driven triggers.

**How to test.** Pass a real opportunity id (this template assumes the orchestrator can take per-run params; v1 takes none, so the prompt currently uses a placeholder URL). Until Phase 12 wires per-run params, partners will hard-code the opp id during the demo. Both checks: `crm_field_equals` (stub) + `url_contains` (real — verifies the company homepage is reachable).

### 3. Renewal Risk Monitor

**Intent.** Every Tuesday at 14:00 UTC, sweep accounts whose contract renews in the next 90 days and flag ones showing risk signals (no-touch in 30+ days, declining usage, support escalations). Tags risky accounts in Salesforce and posts the digest to the CS channel.

**What the partner customizes.**

- Salesforce report URL ("Upcoming Renewals — 90d").
- The risk definition (no-touch threshold, usage-drop %, ticket counts).
- The usage dashboard URL (Looker / Mixpanel / Amplitude — varies).
- The CS Slack channel.

**Credentials.** Salesforce (read_write), Slack (write), Looker (read, optional).

**Schedule.** `cron(0 14 ? * TUE *)` — every Tuesday 14:00 UTC.

**How to test.** Same as Weekly Digest. `record_count_changed` is a stub today (Phase 09); `slack_message_posted` is a stub. Until Phase 09 lands, the run will complete but checks will surface "not implemented" evidence.

### 4. CRM Hygiene Sweep

**Intent.** Every Friday at 18:00 UTC, sweep open opportunities for missing required fields (Next Step, Close Date, Amount, Primary Contact) and stale records (no update in 14 days). Posts a Chatter note on each violator and DMs the owning rep a personalised cleanup checklist.

**What the partner customizes.**

- The "required fields" list and staleness threshold.
- Whether to DM individual reps (some prefer a single channel post in `#revops-hygiene`).
- The Salesforce report URL ("Open Opportunities — All Reps").

**Credentials.** Salesforce (read_write), Slack (write — needs `im:write` for DMs).

**Schedule.** `cron(0 18 ? * FRI *)` — every Friday 18:00 UTC.

**How to test.** Same flow. Both checks (`record_count_changed`, `slack_message_posted`) are Phase 09 stubs.

### 5. Quarterly Board Metrics

**Intent.** On the first day of each quarter at 09:00 UTC, pull pipeline + ARR + retention metrics for the previous quarter and compose a board-ready summary doc (Looker board / Notion page / Google Doc — partner choice). Posts the link to `#board` for the founder to review before the meeting.

**What the partner customizes.**

- Destination doc tool (Looker / Notion / Google Docs).
- The metric list (ARR / NRR / GRR / CAC payback / magic number / burn multiple).
- The board Slack channel.

**Credentials.** Salesforce (read), Looker (read_write), Slack (write).

**Schedule.** `cron(0 9 1 1,4,7,10 ? *)` — Jan 1 / Apr 1 / Jul 1 / Oct 1 at 09:00 UTC.

**How to test.** Trigger ad-hoc via `run-now`. `url_contains` (real) can verify the published doc URL renders; `slack_message_posted` (stub) verifies the channel post.

## Followups / TODOs flagged in the templates

Each prompt contains `// TODO: tune with design partner data` markers at every place a partner-specific detail (URL, channel id, KPI list, threshold) needs to be filled in. The shape test asserts every template carries at least one such marker — so the seeder is not accidentally promoted to "production-ready" before the data lands.

Cross-template TODOs that need broader runtime work:

- **Per-run params on `run-now`.** New-deal research wants the opportunity id passed in. Phase 12 enhancement.
- **Cron firing.** `schedule` is stored but EventBridge wiring is Phase 10.5. Until 10.5 lands, scheduled templates only fire via manual `run-now`.
- **`crm_field_equals` / `record_count_changed` / `slack_message_posted` primitives.** Phase 09 dependency. Templates reference them already so they auto-light-up when the primitives ship.
- **Credential vault.** `required_credentials` is currently advisory JSONB. Phase 09 stores the actual OAuth tokens; the onboarding UI keys off this column.
