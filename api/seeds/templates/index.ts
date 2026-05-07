/**
 * Phase 11 launch templates — registry.
 *
 * Each entry is one row inserted into `runtime.runtime_workflows` by
 * `seeds/seed.ts`. The `name` is the upsert key (combined with
 * `workspace_id`) so re-running the seed is idempotent.
 *
 * Order is intentional: the first one (Weekly RevOps Digest) is the
 * canonical demo. The four after it round out the strategy memo's
 * five-wedge claim.
 */

import { crmHygiene } from './crm-hygiene.js'
import { newDealAccountResearch } from './new-deal-account-research.js'
import { quarterlyBoardMetrics } from './quarterly-board-metrics.js'
import { renewalRiskMonitor } from './renewal-risk-monitor.js'
import type { WorkflowTemplate } from './types.js'
import { weeklyRevopsDigest } from './weekly-revops-digest.js'

export const ALL_TEMPLATES: readonly WorkflowTemplate[] = [
  weeklyRevopsDigest,
  newDealAccountResearch,
  renewalRiskMonitor,
  crmHygiene,
  quarterlyBoardMetrics,
] as const

export {
  crmHygiene,
  newDealAccountResearch,
  quarterlyBoardMetrics,
  renewalRiskMonitor,
  weeklyRevopsDigest,
}
export type { WorkflowTemplate } from './types.js'
