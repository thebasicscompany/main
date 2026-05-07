/**
 * Shared shape for the Phase 11 launch templates.
 *
 * Each template module exports one `WorkflowTemplate` value. The seed
 * script feeds these into `workflowsRepo.create()` (or its upsert
 * equivalent) which lands them in `runtime.runtime_workflows`.
 *
 * `WorkflowTemplate` mirrors the shape `runtime_workflows` accepts on
 * insert: `name`, `prompt`, `schedule`, `requiredCredentials`,
 * `checkModules`, `enabled`. It deliberately omits the row-managed
 * columns (`id`, `workspaceId`, `createdAt`, `updatedAt`) — those are
 * supplied by the seeder.
 *
 * The shape is also designed to be statically assignable to
 * `NewWorkflow` (the Drizzle insert type) when combined with a
 * workspaceId. Phase 11 unit tests assert this assignability so
 * future schema drifts that break templates surface at typecheck time.
 *
 * The `requiredCredentials` JSONB shape:
 *   {
 *     providers: Array<{
 *       provider: string,                  // e.g. 'salesforce' | 'slack'
 *       scope: 'read' | 'write' | 'read_write',
 *       optional?: boolean,                // default: false
 *       reason?: string                    // human note rendered in onboarding UI
 *     }>,
 *     notes?: string                       // free-form description for partner-facing setup docs
 *   }
 *
 * v1 stores this verbatim — no server-side validation. Phase 12
 * onboarding will key off `providers[].provider` to drive the
 * "connect your tools" flow.
 */

export type CredentialScope = 'read' | 'write' | 'read_write'

export interface CredentialRequirement {
  provider: string
  scope: CredentialScope
  optional?: boolean
  reason?: string
}

export interface RequiredCredentialsShape {
  providers: CredentialRequirement[]
  notes?: string
}

/**
 * Phase 11: each entry on a template's check schedule is `{ name, params }`.
 * `name` is a key from `api/src/checks/registry.ts`; `params` is the
 * free-form payload that primitive interprets (e.g. `{ url, contains }`
 * for `url_contains`, `{ url, selector, expected }` for `crm_field_equals`).
 */
export interface CheckModuleTemplateEntry {
  name: string
  params: Record<string, unknown>
}

export interface WorkflowTemplate {
  /** Stable slug used for upsert-by-(workspace_id, name) idempotency. */
  name: string
  /** LLM user-turn prompt. Second-person voice ("Navigate to X. Extract Y."). */
  prompt: string
  /** AWS EventBridge cron expression, or null for user-triggered templates. */
  schedule: string | null
  requiredCredentials: RequiredCredentialsShape
  /** Per-check entries (name + params) drawn from `api/src/checks/registry.ts`. */
  checkModules: CheckModuleTemplateEntry[]
  enabled: boolean
}
