import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Reserved Postgres schema namespace for runtime-owned tables.
 *
 * All runtime tables live under `runtime.*` so they stay clearly separated
 * from Supabase auth tables and the legacy `agent/`-side `public.*` tables
 * sharing the same database. The migration tracker also lives under this
 * schema (`runtime.__drizzle_migrations`) so drizzle-kit doesn't collide
 * with `agent/`'s own `drizzle.__drizzle_migrations` tracker.
 */
export const runtime = pgSchema('runtime')

/**
 * Workflow library — Phase 10.
 *
 * Per-workspace playbook definitions. Stored as DB rows (not TS modules)
 * so the desktop / API can CRUD them without code deploys. Two workflow
 * IDs are reserved as built-in bootstrap names (`hello-world`,
 * `agent-helloworld`) and resolved without a DB lookup; everything else
 * is matched against rows in this table by UUID.
 *
 * `prompt` becomes the LLM system prompt when the run dispatches via the
 * agent loop. `check_modules` is an array of names the runner maps to
 * Phase 06 check primitives (e.g. `'url_contains'`).
 *
 * `schedule` is a cron expression stored as plain text — Phase 10 ships
 * the column + CRUD; Phase 10.5 wires EventBridge to actually fire runs.
 * `required_credentials` is a free-form jsonb — Phase 11 lands the
 * credential schema shape.
 *
 * `workspace_id` is intentionally NOT a FK: `public.workspaces` is owned
 * by the agent/ codebase and runtime treats it as opaque (matches the
 * pattern in `runtime_runs`, `runtime_approvals`, etc.).
 */
export const workflows = runtime.table(
  'runtime_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    name: text('name').notNull(),
    prompt: text('prompt').notNull(),
    schedule: text('schedule'),
    requiredCredentials: jsonb('required_credentials').notNull().default({}),
    /**
     * Per-workflow check schedule. Each entry is `{ name, params }` where
     * `name` is a primitive id from `api/src/checks/registry.ts` and
     * `params` is a free-form object the primitive interprets (e.g.
     * `{ url, selector, expected }` for `crm_field_equals`).
     *
     * Stored as `jsonb` (not `jsonb[]`) so Drizzle/Postgres treat the
     * whole array atomically — Postgres' typed-array `jsonb[]` paths are
     * awkward with Drizzle's runtime.
     */
    checkModules: jsonb('check_modules')
      .$type<Array<{ name: string; params: Record<string, unknown> }>>()
      .notNull()
      .default([]),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('runtime_workflows_workspace_id_enabled_idx').on(
      t.workspaceId,
      t.enabled,
    ),
  ],
)

/**
 * One row per workflow execution.
 *
 * Status lifecycle: pending → booting → running → (paused) → verifying →
 * completed | failed | unverified. Most transitions land via `RunStateRepo.update`.
 */
export const runs = runtime.table('runtime_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowId: text('workflow_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  status: text('status').notNull(),
  trigger: text('trigger').notNull().default('manual'),
  triggeredBy: uuid('triggered_by'),
  browserbaseSessionId: text('browserbase_session_id'),
  contextId: text('context_id'),
  liveUrl: text('live_url'),
  takeoverActive: boolean('takeover_active').notNull().default(false),
  startedAt: timestamp('started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  costCents: integer('cost_cents'),
  stepCount: integer('step_count').notNull().default(0),
  errorSummary: text('error_summary'),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
})

/**
 * Per-run timeline rows: model thoughts, tool calls, approvals, checks,
 * user takeovers. The `(run_id, step_index)` pair is unique so the
 * orchestrator can replay history deterministically.
 */
export const runSteps = runtime.table(
  'runtime_run_steps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    stepIndex: integer('step_index').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('runtime_run_steps_run_id_step_index_key').on(
      t.runId,
      t.stepIndex,
    ),
  ],
)

/**
 * Audit log: one row per tool invocation. Pre/post execution share the
 * same row (UPDATE) so partial failures still leave a forensic trail.
 *
 * `approval_id` and `trust_grant_id` are soft FKs (no FK constraint) to
 * avoid a circular dep with `runtime_approvals` / `runtime_trust_grants`.
 */
export const toolCalls = runtime.table('runtime_tool_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id')
    .notNull()
    .references(() => runs.id, { onDelete: 'cascade' }),
  stepIndex: integer('step_index').notNull(),
  toolName: text('tool_name').notNull(),
  params: jsonb('params').notNull(),
  result: jsonb('result'),
  error: text('error'),
  screenshotS3Key: text('screenshot_s3_key'),
  approvalId: uuid('approval_id'),
  trustGrantId: uuid('trust_grant_id'),
  modelLatencyMs: integer('model_latency_ms'),
  browserLatencyMs: integer('browser_latency_ms'),
  costCents: integer('cost_cents'),
  startedAt: timestamp('started_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
})

/**
 * Approval queue. `workspace_id` is denormalized off `runtime_runs` so the
 * trust-ledger lookup on every gated tool call doesn't need a join.
 */
export const approvals = runtime.table(
  'runtime_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    toolName: text('tool_name').notNull(),
    params: jsonb('params').notNull(),
    status: text('status').notNull().default('pending'),
    resolvedBy: uuid('resolved_by'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedVia: text('resolved_via'),
    remember: boolean('remember').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('runtime_approvals_run_id_status_idx').on(t.runId, t.status),
  ],
)

/**
 * Append-only trust ledger. Match check: `action_pattern` matches AND
 * params satisfy `params_constraint` AND scope contains current workflow
 * AND not expired AND not revoked.
 */
export const trustGrants = runtime.table(
  'runtime_trust_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    grantedBy: uuid('granted_by').notNull(),
    actionPattern: text('action_pattern').notNull(),
    paramsConstraint: jsonb('params_constraint')
      .notNull()
      .default({}),
    scope: text('scope').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('runtime_trust_grants_workspace_id_action_pattern_idx').on(
      t.workspaceId,
      t.actionPattern,
    ),
  ],
)

/**
 * Post-run outcome verification — Phase 06.
 *
 * One row per check function invocation at run-end. `passed=true` for all
 * rows of a run flips `runtime_runs.status` to `verified`; any `false`
 * flips it to `unverified`. `evidence` is the structured payload the check
 * produced (URL fetched, body excerpt, CRM record snapshot, etc.) so the
 * audit trail attests not just "the agent finished" but "the agent
 * achieved what the playbook said it would."
 */
export const checkResults = runtime.table(
  'runtime_check_results',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .notNull()
      .references(() => runs.id, { onDelete: 'cascade' }),
    checkName: text('check_name').notNull(),
    passed: boolean('passed').notNull(),
    evidence: jsonb('evidence'),
    ranAt: timestamp('ran_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('runtime_check_results_run_id_ran_at_idx').on(t.runId, t.ranAt),
  ],
)

export type Run = typeof runs.$inferSelect
export type NewRun = typeof runs.$inferInsert
export type RunStep = typeof runSteps.$inferSelect
export type NewRunStep = typeof runSteps.$inferInsert
export type ToolCall = typeof toolCalls.$inferSelect
export type NewToolCall = typeof toolCalls.$inferInsert
export type Approval = typeof approvals.$inferSelect
export type NewApproval = typeof approvals.$inferInsert
export type TrustGrant = typeof trustGrants.$inferSelect
export type NewTrustGrant = typeof trustGrants.$inferInsert
export type CheckResult = typeof checkResults.$inferSelect
export type NewCheckResult = typeof checkResults.$inferInsert
export type Workflow = typeof workflows.$inferSelect
export type NewWorkflow = typeof workflows.$inferInsert
