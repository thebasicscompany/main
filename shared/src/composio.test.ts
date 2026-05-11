import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildComposioExecutePayload,
  ComposioClient,
  listExecutableComposioTools,
  listComposioManagedSkills,
  normalizeConnectLink,
  normalizeItems,
  resetComposioConnectionStateForTests,
} from './composio.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('Composio shared helpers', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetComposioConnectionStateForTests()
  })

  it('normalizes array and { items } response shapes', () => {
    expect(normalizeItems<string>(['a', 'b'])).toEqual(['a', 'b'])
    expect(normalizeItems<string>({ items: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(normalizeItems<string>({ data: ['a'] })).toEqual([])
  })

  it('normalizes connect links and builds execute payloads', () => {
    expect(
      normalizeConnectLink({
        redirect_url: 'https://connect.example/link',
        connected_account_id: 'conn-123',
        expires_at: '2026-05-11T12:00:00.000Z',
      }),
    ).toMatchObject({
      redirectUrl: 'https://connect.example/link',
      connectedAccountId: 'conn-123',
      expiresAt: '2026-05-11T12:00:00.000Z',
    })

    expect(
      buildComposioExecutePayload({
        userId: 'acct-123',
        connectedAccountId: 'conn-123',
        arguments: { title: 'Hello' },
      }),
    ).toEqual({
      user_id: 'acct-123',
      connected_account_id: 'conn-123',
      arguments: { title: 'Hello' },
      text: undefined,
    })
  })

  it('posts execute payloads through the configured Composio project', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ ok: true }))
    const client = new ComposioClient({
      apiKey: 'test-key',
      baseUrl: 'https://composio.example.test/api/',
    })

    await expect(
      client.executeTool('github_create_issue', {
        userId: 'acct-123',
        arguments: { title: 'Hello' },
      }),
    ).resolves.toEqual({ ok: true })

    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://composio.example.test/api/tools/execute/github_create_issue',
    )
    expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      user_id: 'acct-123',
      arguments: { title: 'Hello' },
    })
  })

  it('marks connected managed Composio skills as installed for existing clients', async () => {
    const client = {
      listToolkits: vi.fn(async () => [{ slug: 'github', name: 'GitHub' }]),
      listAuthConfigs: vi.fn(async () => [
        { id: 'auth-github', name: 'GitHub', toolkit: { slug: 'github' } },
      ]),
      listConnectedAccounts: vi.fn(async () => [
        { id: 'conn-github', status: 'ACTIVE', auth_config: { id: 'auth-github' } },
      ]),
      createConnectLink: vi.fn(),
    }

    await expect(listComposioManagedSkills('acct-123', client)).resolves.toContainEqual(
      expect.objectContaining({
        id: 'composio-github',
        kind: 'installed',
        status: 'enabled',
        connectionStatus: 'connected',
        connectedAccountId: 'conn-github',
        removable: true,
        configurable: true,
      }),
    )
    expect(client.createConnectLink).not.toHaveBeenCalled()
  })

  it('marks connected managed Composio skills disabled from preferences', async () => {
    const client = {
      listToolkits: vi.fn(async () => [{ slug: 'github', name: 'GitHub' }]),
      listAuthConfigs: vi.fn(async () => [
        { id: 'auth-github', name: 'GitHub', toolkit: { slug: 'github' } },
      ]),
      listConnectedAccounts: vi.fn(async () => [
        { id: 'conn-github', status: 'ACTIVE', auth_config: { id: 'auth-github' } },
      ]),
      createConnectLink: vi.fn(),
      listTools: vi.fn(async () => [
        { slug: 'github_create_issue', toolkit: { slug: 'github' } },
        { slug: 'github_list_repos', toolkit: { slug: 'github' } },
      ]),
    }

    await expect(
      listComposioManagedSkills(
        'acct-123',
        client,
        undefined,
        {
          disabledToolkitSlugs: ['github'],
          disabledToolSlugs: ['github_create_issue'],
          connectedAccountIdsByToolkit: {},
        },
        { includeTools: true },
      ),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: 'composio-github',
        kind: 'installed',
        status: 'disabled',
        enabledToolCount: 0,
        disabledToolCount: 2,
        tools: expect.arrayContaining([
          expect.objectContaining({ slug: 'github_create_issue', enabled: false }),
        ]),
      }),
    )
  })

  it('lists executable tools only for enabled auth configs with active accounts', async () => {
    const client = {
      listAuthConfigs: vi.fn(async () => [
        { id: 'auth-github', status: 'ENABLED', toolkit: { slug: 'github' } },
        { id: 'auth-slack', status: 'DISABLED', toolkit: { slug: 'slack' } },
        { id: 'auth-gmail', status: 'ENABLED', toolkit: { slug: 'gmail' } },
      ]),
      listConnectedAccounts: vi.fn(async () => [
        { id: 'conn-github', status: 'ACTIVE', auth_config: { id: 'auth-github' } },
        { id: 'conn-gmail', status: 'EXPIRED', auth_config: { id: 'auth-gmail' } },
      ]),
      listTools: vi.fn(async () => [
        { slug: 'github_create_issue', toolkit: { slug: 'github' } },
        { slug: 'gmail_send_email', toolkit: { slug: 'gmail' } },
      ]),
    }

    await expect(
      listExecutableComposioTools('acct-123', client, {
        disabledToolkitSlugs: [],
        disabledToolSlugs: ['github_delete_repo'],
        connectedAccountIdsByToolkit: {},
      }),
    ).resolves.toEqual([
      {
        tool: { slug: 'github_create_issue', toolkit: { slug: 'github' } },
        authConfig: { id: 'auth-github', status: 'ENABLED', toolkit: { slug: 'github' } },
        connectedAccount: {
          id: 'conn-github',
          status: 'ACTIVE',
          auth_config: { id: 'auth-github' },
        },
      },
    ])
    expect(client.listTools).toHaveBeenCalledWith({ authConfigIds: 'auth-github' })
  })
})
