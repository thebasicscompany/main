import { beforeAll, describe, expect, it } from 'vitest'
import { presignGet } from './s3.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'
  process.env.SUPABASE_JWT_SECRET = 'j'
  process.env.WORKSPACE_JWT_SECRET = 'test-secret-very-long-please'
  process.env.GEMINI_API_KEY = 'g'
})

describe('presignGet', () => {
  it('rejects non-s3 storage_url', async () => {
    await expect(presignGet('https://example.com/x')).rejects.toThrow(
      'invalid storage_url',
    )
  })
})
