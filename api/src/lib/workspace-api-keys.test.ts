import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceApiKeyRow } from '../db/schema-public.js'

const TEST_JWT_SECRET = 'test-secret-very-long-please'

let rows: WorkspaceApiKeyRow[] = []

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    insert: () => ({
      values: (value: Partial<WorkspaceApiKeyRow>) => ({
        returning: async () => {
          const row = {
            id: `key-${rows.length + 1}`,
            workspaceId: value.workspaceId!,
            name: value.name!,
            prefix: value.prefix!,
            secretHash: value.secretHash!,
            scopes: value.scopes ?? [],
            status: value.status ?? 'active',
            createdByAccountId: value.createdByAccountId ?? null,
            createdAt: value.createdAt ?? new Date(),
            expiresAt: value.expiresAt ?? null,
            revokedAt: null,
            lastUsedAt: null,
            metadata: value.metadata ?? {},
          } satisfies WorkspaceApiKeyRow
          rows.push(row)
          return [row]
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => rows,
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<WorkspaceApiKeyRow>) => ({
        where: () => {
          const op = Promise.resolve().then(() => {
            rows = rows.map((row) => ({ ...row, ...patch }))
            return rows
          })
          return Object.assign(op, {
            returning: async () => {
              rows = rows.map((row) => ({ ...row, ...patch }))
              return rows.map((row) => ({ id: row.id }))
            },
          })
        },
      }),
    }),
  }),
}))

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.WORKSPACE_API_KEY_HASH_SECRET = 'test-api-key-hash-secret'
  process.env.GEMINI_API_KEY = 'test-gemini'
})

beforeEach(async () => {
  rows = []
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
})

describe('workspace API keys', () => {
  it('creates, authenticates, revokes, and rejects future use', async () => {
    const {
      authenticateWorkspaceApiKey,
      createWorkspaceApiKey,
      revokeWorkspaceApiKey,
      WorkspaceApiKeyForbiddenError,
    } = await import('./workspace-api-keys.js')

    const created = await createWorkspaceApiKey({
      workspaceId: 'a0000000-0000-4000-8000-000000000001',
      createdByAccountId: 'b0000000-0000-4000-8000-000000000002',
      name: 'Assistant key',
      scopes: ['llm:managed'],
      metadata: { kind: 'test' },
    })

    expect(created.key).toMatch(/^bas_live_/)
    expect(created.meta.prefix).toMatch(/^bas_live_/)
    expect(created.meta).not.toHaveProperty('secretHash')
    expect(rows[0]?.secretHash).not.toBe(created.key)

    const auth = await authenticateWorkspaceApiKey(created.key, 'llm:managed')
    expect(auth.workspace.workspace_id).toBe('a0000000-0000-4000-8000-000000000001')
    expect(auth.apiKey.id).toBe(created.meta.id)

    await expect(
      revokeWorkspaceApiKey({
        workspaceId: 'a0000000-0000-4000-8000-000000000001',
        apiKeyId: created.meta.id,
      }),
    ).resolves.toBe(true)

    await expect(
      authenticateWorkspaceApiKey(created.key, 'llm:managed'),
    ).rejects.toBeInstanceOf(WorkspaceApiKeyForbiddenError)
  })
})
