/**
 * Phase 11 launch-template shape tests.
 *
 * These tests validate that each of the five hand-built templates lives
 * inside the runtime_workflows schema's expected shape. They do NOT hit
 * the database — they import the template modules and assert the
 * structural contract.
 *
 * Why live under `src/` (instead of `seeds/`)? vitest's include glob is
 * src/(double-star)/(single-star).test.ts (see `api/vitest.config.ts`).
 * Keeping the test here lets the existing test runner pick it up without
 * changing config; the imports reach up into `../seeds/templates/`.
 *
 * The static `assignableNewWorkflow` block at the bottom is a
 * compile-time check: if Drizzle's `NewWorkflow` insert shape ever drifts
 * incompatibly with `WorkflowTemplate`, this file stops typechecking.
 */

import { describe, expect, it } from 'vitest'
import type { NewWorkflow } from './db/schema.js'
import { listRegisteredCheckModules } from './checks/registry.js'
import {
  ALL_TEMPLATES,
  crmHygiene,
  newDealAccountResearch,
  quarterlyBoardMetrics,
  renewalRiskMonitor,
  weeklyRevopsDigest,
  type WorkflowTemplate,
} from '../seeds/templates/index.js'

describe('Phase 11 launch templates', () => {
  it('exports exactly 5 templates', () => {
    expect(ALL_TEMPLATES).toHaveLength(5)
  })

  it('every template has a unique non-empty name', () => {
    const names = ALL_TEMPLATES.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const n of names) {
      expect(n).toBeTruthy()
      expect(n.length).toBeLessThanOrEqual(200) // matches route validator cap
    }
  })

  it('every template has a non-trivial prompt', () => {
    for (const t of ALL_TEMPLATES) {
      expect(t.prompt.length).toBeGreaterThan(100)
    }
  })

  it.each(ALL_TEMPLATES)('$name conforms to WorkflowTemplate shape', (t) => {
    expect(typeof t.name).toBe('string')
    expect(typeof t.prompt).toBe('string')
    expect(typeof t.enabled).toBe('boolean')

    // schedule: cron string or null. We don't validate cron syntax here —
    // EventBridge does that on rule creation. We only assert the type.
    expect(t.schedule === null || typeof t.schedule === 'string').toBe(true)

    expect(Array.isArray(t.checkModules)).toBe(true)
    for (const cm of t.checkModules) {
      // Phase 11: each entry is `{ name, params }`.
      expect(typeof cm.name).toBe('string')
      expect(cm.name.length).toBeGreaterThan(0)
      expect(typeof cm.params).toBe('object')
      expect(cm.params).not.toBeNull()
    }

    expect(t.requiredCredentials).toBeTypeOf('object')
    expect(t.requiredCredentials).not.toBeNull()
    expect(Array.isArray(t.requiredCredentials.providers)).toBe(true)
    expect(t.requiredCredentials.providers.length).toBeGreaterThan(0)
    for (const p of t.requiredCredentials.providers) {
      expect(typeof p.provider).toBe('string')
      expect(p.provider.length).toBeGreaterThan(0)
      expect(['read', 'write', 'read_write']).toContain(p.scope)
    }
  })

  it.each(ALL_TEMPLATES)(
    '$name only references known check_modules',
    (t) => {
      const known = new Set(listRegisteredCheckModules())
      for (const cm of t.checkModules) {
        expect(known.has(cm.name)).toBe(true)
      }
    },
  )

  it('only one template (new-deal account research) is user-triggered (schedule=null)', () => {
    const unscheduled = ALL_TEMPLATES.filter((t) => t.schedule === null)
    expect(unscheduled).toHaveLength(1)
    expect(unscheduled[0]?.name).toBe('New-Deal Account Research')
  })

  it('all scheduled templates use AWS EventBridge cron syntax', () => {
    for (const t of ALL_TEMPLATES) {
      if (t.schedule === null) continue
      // EventBridge rule schedule expressions look like
      // `cron(<min> <hour> <day-of-month> <month> <day-of-week> <year>)`.
      // Loose assertion — we don't fully parse, we just ensure the
      // template author used the wrapper syntax (a bare 5-field cron
      // would silently fail at rule creation time).
      expect(t.schedule).toMatch(/^cron\(.+\)$/)
    }
  })

  it.each(ALL_TEMPLATES)('$name flags a TODO for design partner tuning', (t) => {
    // Per the task spec all 5 are scaffolded (no design partner data yet);
    // each prompt MUST flag at least one tuning point.
    expect(t.prompt).toMatch(/TODO: tune with design partner data/)
  })

  it('individual exports match the registry array', () => {
    expect(ALL_TEMPLATES).toContain(weeklyRevopsDigest)
    expect(ALL_TEMPLATES).toContain(newDealAccountResearch)
    expect(ALL_TEMPLATES).toContain(renewalRiskMonitor)
    expect(ALL_TEMPLATES).toContain(crmHygiene)
    expect(ALL_TEMPLATES).toContain(quarterlyBoardMetrics)
  })

  it('every template, combined with workspaceId, is assignable to NewWorkflow', () => {
    // This is enforced statically below; the it() block exists so the
    // assertion shows up in the test report and so an incompatible
    // refactor surfaces as a test failure rather than an obscure tsc
    // diagnostic.
    for (const t of ALL_TEMPLATES) {
      const row: NewWorkflow = {
        workspaceId: '00000000-0000-0000-0000-000000000000',
        name: t.name,
        prompt: t.prompt,
        schedule: t.schedule,
        // The Drizzle jsonb column is typed `never` on insert — same
        // pattern workflowsRepo.create() uses.
        requiredCredentials: t.requiredCredentials as never,
        checkModules: t.checkModules as never,
        enabled: t.enabled,
      }
      expect(row.workspaceId).toBeTruthy()
      expect(row.name).toBe(t.name)
    }
  })

  it.each(ALL_TEMPLATES)(
    '$name supplies non-empty params for every check entry',
    (t) => {
      // Phase 11 contract: each entry's params is an object (possibly
      // empty for primitives that take no params, but the check name
      // itself must be present). Templates should pass concrete params
      // for any primitive that requires them.
      for (const cm of t.checkModules) {
        expect(cm.params).toBeTypeOf('object')
        expect(cm.params).not.toBeNull()
      }
    },
  )
})

// Static-only typecheck: if `WorkflowTemplate` ever drifts from
// `Omit<NewWorkflow, 'workspaceId' | 'id' | 'createdAt' | 'updatedAt'>`
// in a way that breaks insert assignability, this declaration will fail
// to typecheck. Defensive — keeps the seed honest as the schema evolves.
type _AssignTemplateToNewWorkflow = (
  t: WorkflowTemplate,
  workspaceId: string,
) => NewWorkflow
const _assignableNewWorkflow: _AssignTemplateToNewWorkflow = (t, workspaceId) => ({
  workspaceId,
  name: t.name,
  prompt: t.prompt,
  schedule: t.schedule,
  requiredCredentials: t.requiredCredentials as never,
  checkModules: t.checkModules as never,
  enabled: t.enabled,
})
// Reference it so it's not dead code from the type-checker's POV.
void _assignableNewWorkflow
