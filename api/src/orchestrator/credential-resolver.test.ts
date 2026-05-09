import { beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  vi.resetModules()
})

describe('resolveGatewayCredential', () => {
  it('falls back to pooled key when credential DB lookup is unavailable', async () => {
    vi.doMock('../db/index.js', () => ({
      getDb: () => ({
        insert: () => ({
          values: () => ({
            onConflictDoNothing: async () => {
              throw new Error(
                'Failed query: insert into "workspace_credentials" ... ECONNREFUSED',
              )
            },
          }),
        }),
      }),
    }))

    const { resolveGatewayCredential } = await import('./credential-resolver.js')

    await expect(
      resolveGatewayCredential({
        workspaceId: 'ws-1',
        kind: 'anthropic',
        pooledKey: 'sk-pooled',
      }),
    ).resolves.toEqual({
      plaintext: 'sk-pooled',
      credentialId: null,
      usageTag: 'basics_managed_pooled',
    })
  })

  it('surfaces DB lookup failures when no pooled key is configured', async () => {
    vi.doMock('../db/index.js', () => ({
      getDb: () => ({
        insert: () => ({
          values: () => ({
            onConflictDoNothing: async () => {
              throw new Error(
                'Failed query: insert into "workspace_credentials" ... ECONNREFUSED',
              )
            },
          }),
        }),
      }),
    }))

    const { resolveGatewayCredential } = await import('./credential-resolver.js')

    await expect(
      resolveGatewayCredential({
        workspaceId: 'ws-1',
        kind: 'anthropic',
        pooledKey: undefined,
      }),
    ).rejects.toThrow('Failed query')
  })
})
