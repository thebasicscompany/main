/**
 * Workflows repo — Phase 10 unit tests.
 *
 * Covers the in-memory impl correctness:
 *  - create / get round-trip
 *  - cross-workspace get returns null
 *  - list filters (workspace, enabled, pagination)
 *  - update applies partial patches
 *  - delete is idempotent and workspace-scoped
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
})

let repo: ReturnType<
  typeof import('./workflowsRepo.js').createMemoryRepo
>

beforeEach(async () => {
  const mod = await import('./workflowsRepo.js')
  repo = mod.createMemoryRepo()
})

describe('workflowsRepo (memory)', () => {
  it('create + get round-trip with default fields', async () => {
    const w = await repo.create({
      workspaceId: 'ws-1',
      name: 'Weekly digest',
      prompt: 'Generate a weekly RevOps digest.',
    })
    expect(w.id).toMatch(/^wf-/)
    expect(w.workspaceId).toBe('ws-1')
    expect(w.name).toBe('Weekly digest')
    expect(w.prompt).toBe('Generate a weekly RevOps digest.')
    expect(w.schedule).toBeNull()
    expect(w.requiredCredentials).toEqual({})
    expect(w.checkModules).toEqual([])
    expect(w.enabled).toBe(true)

    const got = await repo.get('ws-1', w.id)
    expect(got).not.toBeNull()
    expect(got!.id).toBe(w.id)
  })

  it('get returns null for cross-workspace lookup', async () => {
    const w = await repo.create({
      workspaceId: 'ws-1',
      name: 'A',
      prompt: 'p',
    })
    expect(await repo.get('ws-2', w.id)).toBeNull()
  })

  it('get returns null for unknown id', async () => {
    expect(await repo.get('ws-1', 'no-such-id')).toBeNull()
  })

  it('list scopes by workspace, newest first', async () => {
    await repo.create({ workspaceId: 'ws-1', name: 'A', prompt: 'p' })
    // Force ordering by spacing wall-clock writes.
    await new Promise((r) => setTimeout(r, 5))
    await repo.create({ workspaceId: 'ws-1', name: 'B', prompt: 'p' })
    await new Promise((r) => setTimeout(r, 5))
    await repo.create({ workspaceId: 'ws-other', name: 'X', prompt: 'p' })

    const out = await repo.list({ workspaceId: 'ws-1' })
    expect(out.map((w) => w.name)).toEqual(['B', 'A'])
  })

  it('list filters by enabled', async () => {
    const a = await repo.create({
      workspaceId: 'ws-1',
      name: 'A',
      prompt: 'p',
    })
    await repo.create({
      workspaceId: 'ws-1',
      name: 'B',
      prompt: 'p',
      enabled: false,
    })
    const enabled = await repo.list({ workspaceId: 'ws-1', enabled: true })
    expect(enabled.map((w) => w.id)).toEqual([a.id])

    const disabled = await repo.list({
      workspaceId: 'ws-1',
      enabled: false,
    })
    expect(disabled.map((w) => w.name)).toEqual(['B'])
  })

  it('list respects limit + offset', async () => {
    for (let i = 0; i < 5; i++) {
      await repo.create({
        workspaceId: 'ws-1',
        name: `n${i}`,
        prompt: 'p',
      })
      await new Promise((r) => setTimeout(r, 2))
    }
    const page = await repo.list({
      workspaceId: 'ws-1',
      limit: 2,
      offset: 1,
    })
    expect(page).toHaveLength(2)
  })

  it('update applies partial patch', async () => {
    const w = await repo.create({
      workspaceId: 'ws-1',
      name: 'A',
      prompt: 'p',
    })
    const updated = await repo.update('ws-1', w.id, {
      name: 'A2',
      schedule: '0 9 * * 1',
      checkModules: [
        {
          name: 'url_contains',
          params: { url: 'https://example.com', contains: 'Example' },
        },
      ],
    })
    expect(updated).not.toBeNull()
    expect(updated!.name).toBe('A2')
    expect(updated!.prompt).toBe('p')
    expect(updated!.schedule).toBe('0 9 * * 1')
    expect(updated!.checkModules).toEqual([
      {
        name: 'url_contains',
        params: { url: 'https://example.com', contains: 'Example' },
      },
    ])
  })

  it('update can null-out schedule', async () => {
    const w = await repo.create({
      workspaceId: 'ws-1',
      name: 'A',
      prompt: 'p',
      schedule: '0 9 * * 1',
    })
    const updated = await repo.update('ws-1', w.id, { schedule: null })
    expect(updated!.schedule).toBeNull()
  })

  it('update returns null cross-workspace', async () => {
    const w = await repo.create({
      workspaceId: 'ws-1',
      name: 'A',
      prompt: 'p',
    })
    const got = await repo.update('ws-2', w.id, { name: 'X' })
    expect(got).toBeNull()
  })

  it('update returns null for unknown id', async () => {
    const got = await repo.update('ws-1', 'nope', { name: 'X' })
    expect(got).toBeNull()
  })

  it('delete returns deleted=true on hit', async () => {
    const w = await repo.create({
      workspaceId: 'ws-1',
      name: 'A',
      prompt: 'p',
    })
    expect(await repo.delete('ws-1', w.id)).toEqual({ deleted: true })
    expect(await repo.get('ws-1', w.id)).toBeNull()
  })

  it('delete returns deleted=false cross-workspace', async () => {
    const w = await repo.create({
      workspaceId: 'ws-1',
      name: 'A',
      prompt: 'p',
    })
    expect(await repo.delete('ws-other', w.id)).toEqual({ deleted: false })
    // Original row untouched.
    expect(await repo.get('ws-1', w.id)).not.toBeNull()
  })

  it('delete is idempotent (second call returns deleted=false)', async () => {
    const w = await repo.create({
      workspaceId: 'ws-1',
      name: 'A',
      prompt: 'p',
    })
    expect(await repo.delete('ws-1', w.id)).toEqual({ deleted: true })
    expect(await repo.delete('ws-1', w.id)).toEqual({ deleted: false })
  })
})
