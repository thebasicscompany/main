import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const encryptSend = vi.fn()
const decryptSend = vi.fn()

vi.mock('@aws-sdk/client-kms', () => {
  class EncryptCommand {
    readonly input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  }
  class DecryptCommand {
    readonly input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  }
  class KMSClient {
    send(cmd: unknown) {
      if (cmd instanceof EncryptCommand) return encryptSend(cmd)
      if (cmd instanceof DecryptCommand) return decryptSend(cmd)
      throw new Error('unexpected kms command')
    }
  }
  return { KMSClient, EncryptCommand, DecryptCommand }
})

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.SUPABASE_URL = 'https://example.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'x'
  process.env.SUPABASE_JWT_SECRET = 'x'
  process.env.WORKSPACE_JWT_SECRET = 'test-secret-very-long-please'
  process.env.GEMINI_API_KEY = 'gk'
})

beforeEach(async () => {
  const { __resetConfigForTests } = await import('../config.js')
  const { __resetKmsForTests } = await import('./kms.js')
  __resetConfigForTests()
  __resetKmsForTests()
  encryptSend.mockReset()
  decryptSend.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('encryptCredential / decryptCredential', () => {
  it('encrypt returns ciphertext + kmsKeyId; decrypt round-trips', async () => {
    process.env.BYOK_KMS_KEY_ALIAS = 'alias/test-byok'
    const cipher = Buffer.from('encrypted-bytes')
    encryptSend.mockResolvedValueOnce({
      CiphertextBlob: cipher,
      KeyId: 'arn:aws:kms:us-east-1:123:key/abc',
    })
    decryptSend.mockResolvedValueOnce({
      Plaintext: Buffer.from('secret-api-key', 'utf8'),
    })

    const { encryptCredential, decryptCredential } = await import('./kms.js')
    const enc = await encryptCredential('secret-api-key')
    expect(enc.ciphertext.equals(cipher)).toBe(true)
    expect(enc.kmsKeyId).toContain('kms')

    const plain = await decryptCredential(enc.ciphertext)
    expect(plain).toBe('secret-api-key')

    const decryptCmd = decryptSend.mock.calls[0]![0] as {
      input: { EncryptionContext?: Record<string, string> }
    }
    expect(decryptCmd.input.EncryptionContext?.purpose).toBe('workspace_credential')
  })

  it('throws when BYOK_KMS_KEY_ALIAS is unset', async () => {
    delete process.env.BYOK_KMS_KEY_ALIAS
    const { encryptCredential } = await import('./kms.js')
    await expect(encryptCredential('x')).rejects.toThrow(/BYOK_KMS_KEY_ALIAS/)
  })

  it('decrypt fails when encryption context mismatches (KMS rejects)', async () => {
    decryptSend.mockRejectedValueOnce(new Error('InvalidCiphertextException'))
    const { decryptCredential } = await import('./kms.js')
    await expect(decryptCredential(Buffer.from('x'))).rejects.toThrow()
  })
})
