import { describe, expect, it } from 'vitest'
import { redactCredentialBody } from './redact-credential-log.js'

describe('redactCredentialBody', () => {
  it('replaces plaintext field', () => {
    expect(redactCredentialBody({ kind: 'anthropic', plaintext: 'sk-secret' })).toEqual({
      kind: 'anthropic',
      plaintext: '[REDACTED]',
    })
  })

  it('passes through primitives', () => {
    expect(redactCredentialBody(null)).toBe(null)
    expect(redactCredentialBody('x')).toBe('x')
  })
})
