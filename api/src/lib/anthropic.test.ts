import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const TEST_JWT_SECRET = 'test-secret-very-long-please'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key'
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt'
  process.env.WORKSPACE_JWT_SECRET = TEST_JWT_SECRET
  process.env.GEMINI_API_KEY = 'test-gemini'
})

beforeEach(async () => {
  delete process.env.ANTHROPIC_API_KEY
  const { __resetConfigForTests } = await import('../config.js')
  __resetConfigForTests()
  const { __resetAnthropicClientForTests } = await import('./anthropic.js')
  __resetAnthropicClientForTests(null)
})

afterEach(async () => {
  const { __resetAnthropicClientForTests } = await import('./anthropic.js')
  __resetAnthropicClientForTests(null)
})

describe('getAnthropicClient', () => {
  it('throws AnthropicUnavailableError when ANTHROPIC_API_KEY is missing', async () => {
    const { getAnthropicClient } = await import('./anthropic.js')
    const { AnthropicUnavailableError } = await import('./errors.js')
    expect(() => getAnthropicClient()).toThrow(AnthropicUnavailableError)
  })

  it('throws AnthropicUnavailableError when ANTHROPIC_API_KEY is whitespace', async () => {
    process.env.ANTHROPIC_API_KEY = '   '
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const { getAnthropicClient } = await import('./anthropic.js')
    const { AnthropicUnavailableError } = await import('./errors.js')
    expect(() => getAnthropicClient()).toThrow(AnthropicUnavailableError)
  })

  it('constructs a client when the key is present', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key'
    const { __resetConfigForTests } = await import('../config.js')
    __resetConfigForTests()
    const { getAnthropicClient } = await import('./anthropic.js')
    const client = getAnthropicClient()
    expect(client).toBeTruthy()
    // Calling again returns the same lazy-cached instance.
    expect(getAnthropicClient()).toBe(client)
  })
})

describe('AnthropicUnavailableError', () => {
  it('has the documented HTTP code shape', async () => {
    const { AnthropicUnavailableError } = await import('./errors.js')
    const err = new AnthropicUnavailableError()
    expect(err.statusCode).toBe(503)
    expect(err.code).toBe('anthropic_unavailable')
    expect(err.name).toBe('AnthropicUnavailableError')
  })
})
