/**
 * EventBridge schedule lifecycle helpers — Phase 10.5.
 *
 * Each `runtime_workflows` row with a non-null `schedule` is mirrored as
 * a per-workflow EventBridge rule that targets a single API destination
 * (the runtime's POST /v1/runtime/workflows/:id/run-now endpoint). The
 * SST infra block (sst.config.ts) provisions:
 *
 *   - the connection (carries X-Cron-Secret as a custom header),
 *   - the API destination (the runtime's run-now URL template),
 *   - the IAM role EventBridge assumes to invoke the destination.
 *
 * The runtime API process is responsible for the *per-workflow* rules —
 * created on workflow create, updated on schedule change, deleted on
 * workflow delete. This module encapsulates that responsibility.
 *
 * No-op mode:
 *   When `EVENTBRIDGE_RULE_PREFIX` is unset (dev / test / local), all
 *   helpers short-circuit and return without touching the AWS SDK. This
 *   keeps unit tests hermetic and lets developers run the full API
 *   locally without AWS creds.
 *
 * Cron validation:
 *   AWS EventBridge accepts either `cron(min hour day month day-of-week year)`
 *   (six fields, with `?` substituting day-of-week or day) or `rate(N unit)`.
 *   We reject anything else at the route layer so PutRule never fails
 *   server-side with a cryptic ValidationException.
 */

import {
  DeleteRuleCommand,
  EventBridgeClient,
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
} from '@aws-sdk/client-eventbridge'
import { logger } from '../middleware/logger.js'

// =============================================================================
// Schedule string validation.
//
// EventBridge's accepted forms (we surface a 400 to the route on bad input
// so the user sees a descriptive error instead of a runtime PutRule fail).
// =============================================================================

const CRON_PATTERN = /^cron\(\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*\)$/
const RATE_PATTERN =
  /^rate\(\s*\d+\s+(minute|minutes|hour|hours|day|days)\s*\)$/

/**
 * Returns null if the schedule is a valid AWS EventBridge expression,
 * otherwise an error string explaining the rejection.
 *
 * Permissive on purpose — we don't reproduce the entire cron grammar
 * here (5/6-field validation, ranges, step values, day-of-week aliases).
 * AWS's PutRule call is the source of truth for grammar; this guard
 * catches the obvious "user typed a regular cron string in the schedule
 * field" mistake which would otherwise stay silent until rule creation.
 */
export function validateScheduleExpression(value: string): string | null {
  const v = value.trim()
  if (v.length === 0) return 'schedule must be non-empty'
  if (CRON_PATTERN.test(v)) return null
  if (RATE_PATTERN.test(v)) return null
  return (
    'schedule must be an AWS EventBridge expression: ' +
    'cron(min hour day month day-of-week year) or rate(N unit). ' +
    'Got: ' + JSON.stringify(value)
  )
}

// =============================================================================
// Rule naming.
// =============================================================================

/**
 * Build the deterministic rule name for a workflow. AWS rule names must
 * be ≤64 chars, alphanumeric + `_-.` only — workflow UUIDs satisfy this
 * after the dashes-to-underscores swap is unnecessary (AWS allows `-`).
 */
export function ruleNameFor(workflowId: string, prefix: string): string {
  return `${prefix}-${workflowId}`
}

// =============================================================================
// Module-level state.
// =============================================================================

interface EventBridgeConfig {
  rulePrefix: string
  apiDestinationArn: string
  roleArn: string
  region: string
}

let cachedClient: EventBridgeClient | null = null
let clientFactoryOverride:
  | ((cfg: EventBridgeConfig) => EventBridgeClient)
  | null = null

/**
 * Read EventBridge config from env. Returns null if disabled (no rule
 * prefix). The other env vars are required when prefix is set; we throw
 * a descriptive error so misconfiguration in production fails loudly
 * instead of silently no-op'ing.
 */
function readConfig(): EventBridgeConfig | null {
  const rulePrefix = process.env.EVENTBRIDGE_RULE_PREFIX
  if (!rulePrefix) return null
  const apiDestinationArn = process.env.EVENTBRIDGE_API_DESTINATION_ARN
  const roleArn = process.env.EVENTBRIDGE_TARGET_ROLE_ARN
  const region = process.env.AWS_REGION ?? 'us-east-1'
  if (!apiDestinationArn || !roleArn) {
    throw new Error(
      'EVENTBRIDGE_RULE_PREFIX is set but ' +
        'EVENTBRIDGE_API_DESTINATION_ARN and/or EVENTBRIDGE_TARGET_ROLE_ARN ' +
        'are missing — refusing to silently skip rule management.',
    )
  }
  return { rulePrefix, apiDestinationArn, roleArn, region }
}

function getClient(cfg: EventBridgeConfig): EventBridgeClient {
  if (clientFactoryOverride) return clientFactoryOverride(cfg)
  if (!cachedClient) {
    cachedClient = new EventBridgeClient({ region: cfg.region })
  }
  return cachedClient
}

// =============================================================================
// Public API.
// =============================================================================

export interface WorkflowScheduleRecord {
  id: string
  workspaceId: string
  schedule: string | null
  enabled: boolean
}

/**
 * Create / update / delete the per-workflow EventBridge rule to match
 * the workflow's schedule + enabled state.
 *
 * - `schedule == null` → rule deleted if it exists (idempotent).
 * - `enabled == false` → rule put in DISABLED state (preserves history
 *   so re-enabling doesn't recreate from scratch — and prevents fires
 *   while the workflow is paused).
 * - otherwise → rule upserted in ENABLED state.
 */
export async function upsertWorkflowSchedule(
  workflow: WorkflowScheduleRecord,
): Promise<void> {
  const cfg = readConfig()
  if (!cfg) return // No-op mode (dev / test / not yet wired).

  const ruleName = ruleNameFor(workflow.id, cfg.rulePrefix)

  if (!workflow.schedule) {
    // Schedule cleared — make sure no stale rule lingers.
    await deleteWorkflowSchedule(workflow.id)
    return
  }

  const client = getClient(cfg)

  await client.send(
    new PutRuleCommand({
      Name: ruleName,
      ScheduleExpression: workflow.schedule,
      State: workflow.enabled ? 'ENABLED' : 'DISABLED',
      Description: `runtime workflow schedule (${workflow.id})`,
    }),
  )

  // Always re-put the target — Put is idempotent. The Input field is the
  // event payload posted (after EventBridge wraps it in its own envelope).
  // We pass a minimal body identifying the workspace + workflow so the
  // route handler can resolve workspace ownership server-side without
  // trusting EventBridge to send the right header twice.
  await client.send(
    new PutTargetsCommand({
      Rule: ruleName,
      Targets: [
        {
          Id: 'runtime-api-destination',
          Arn: cfg.apiDestinationArn,
          RoleArn: cfg.roleArn,
          // Path parameter the API destination URL template substitutes
          // into `/v1/runtime/workflows/*/run-now`.
          HttpParameters: {
            PathParameterValues: [workflow.id],
          },
          Input: JSON.stringify({
            workflow_id: workflow.id,
            workspace_id: workflow.workspaceId,
            source: 'eventbridge',
          }),
        },
      ],
    }),
  )

  logger.info(
    {
      workflow_id: workflow.id,
      workspace_id: workflow.workspaceId,
      rule_name: ruleName,
      schedule: workflow.schedule,
      state: workflow.enabled ? 'ENABLED' : 'DISABLED',
    },
    'eventbridge: rule upserted',
  )
}

/**
 * Remove the per-workflow rule. Idempotent: missing-rule errors are
 * swallowed because the workflow may never have had a schedule.
 */
export async function deleteWorkflowSchedule(
  workflowId: string,
): Promise<void> {
  const cfg = readConfig()
  if (!cfg) return

  const ruleName = ruleNameFor(workflowId, cfg.rulePrefix)
  const client = getClient(cfg)

  // Targets must be removed before the rule itself.
  try {
    await client.send(
      new RemoveTargetsCommand({
        Rule: ruleName,
        Ids: ['runtime-api-destination'],
      }),
    )
  } catch (err) {
    if (!isResourceNotFoundError(err)) {
      logger.warn(
        {
          workflow_id: workflowId,
          rule_name: ruleName,
          err: { name: (err as Error).name, message: (err as Error).message },
        },
        'eventbridge: RemoveTargets failed (continuing to DeleteRule)',
      )
    }
  }

  try {
    await client.send(new DeleteRuleCommand({ Name: ruleName }))
    logger.info(
      { workflow_id: workflowId, rule_name: ruleName },
      'eventbridge: rule deleted',
    )
  } catch (err) {
    if (isResourceNotFoundError(err)) return
    logger.warn(
      {
        workflow_id: workflowId,
        rule_name: ruleName,
        err: { name: (err as Error).name, message: (err as Error).message },
      },
      'eventbridge: DeleteRule failed',
    )
    throw err
  }
}

function isResourceNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const name = (err as { name?: string }).name
  return name === 'ResourceNotFoundException'
}

// =============================================================================
// Test hooks.
// =============================================================================

/**
 * Returns whether the module is in no-op mode (no rule prefix configured).
 * Useful for skipping AWS-dependent assertions in tests + for the route
 * layer to log when cron management is disabled.
 */
export function isEventBridgeEnabled(): boolean {
  return Boolean(process.env.EVENTBRIDGE_RULE_PREFIX)
}

/** Test-only: install a custom client factory to capture SDK calls. */
export function __setEventBridgeClientFactoryForTests(
  factory: ((cfg: EventBridgeConfig) => EventBridgeClient) | null,
): void {
  clientFactoryOverride = factory
  cachedClient = null
}

/** Test-only: reset cached client. */
export function __resetForTests(): void {
  cachedClient = null
  clientFactoryOverride = null
}
