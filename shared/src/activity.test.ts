import { describe, expect, it } from 'vitest'
import {
  OutputActivityEventSchema,
  OutputChannelSchema,
  OutputDispatchedEventSchema,
  OutputFailedEventSchema,
} from './activity.js'

describe('OutputChannelSchema', () => {
  it('accepts the three allowed channels', () => {
    for (const c of ['sms', 'email', 'artifact'] as const) {
      expect(OutputChannelSchema.parse(c)).toBe(c)
    }
  })

  it('rejects unknown channels', () => {
    expect(() => OutputChannelSchema.parse('push')).toThrow()
  })
})

describe('OutputDispatchedEventSchema', () => {
  it('parses a valid dispatched event', () => {
    const parsed = OutputDispatchedEventSchema.parse({
      kind: 'output_dispatched',
      channel: 'email',
      recipient_or_key: 'foo@example.com',
      content_hash: 'sha256-abc',
      attempt: 1,
      latency_ms: 420,
    })
    expect(parsed.channel).toBe('email')
  })

  it('rejects negative attempt / latency', () => {
    const base = {
      kind: 'output_dispatched' as const,
      channel: 'sms' as const,
      recipient_or_key: '+15551234567',
      content_hash: 'h',
      attempt: 0,
      latency_ms: 0,
    }
    expect(() =>
      OutputDispatchedEventSchema.parse({ ...base, attempt: -1 }),
    ).toThrow()
    expect(() =>
      OutputDispatchedEventSchema.parse({ ...base, latency_ms: -10 }),
    ).toThrow()
  })

  it('rejects empty recipient_or_key / content_hash', () => {
    expect(() =>
      OutputDispatchedEventSchema.parse({
        kind: 'output_dispatched',
        channel: 'artifact',
        recipient_or_key: '',
        content_hash: 'h',
        attempt: 0,
        latency_ms: 0,
      }),
    ).toThrow()
  })
})

describe('OutputFailedEventSchema', () => {
  it('parses a valid failure event', () => {
    const parsed = OutputFailedEventSchema.parse({
      kind: 'output_failed',
      channel: 'sms',
      error: { code: 'sendblue_5xx', message: 'upstream timeout' },
      retriable: true,
    })
    expect(parsed.retriable).toBe(true)
  })

  it('requires error.code and error.message', () => {
    expect(() =>
      OutputFailedEventSchema.parse({
        kind: 'output_failed',
        channel: 'email',
        error: { code: '', message: 'x' },
        retriable: false,
      }),
    ).toThrow()
  })
})

describe('OutputActivityEventSchema', () => {
  it('discriminates by kind', () => {
    const ok = OutputActivityEventSchema.parse({
      kind: 'output_dispatched',
      channel: 'artifact',
      recipient_or_key: 'workspaces/x/runs/y/z.json',
      content_hash: 'sha256-z',
      attempt: 0,
      latency_ms: 5,
    })
    expect(ok.kind).toBe('output_dispatched')

    const fail = OutputActivityEventSchema.parse({
      kind: 'output_failed',
      channel: 'email',
      error: { code: 'ses_throttle', message: 'rate-limited' },
      retriable: true,
    })
    expect(fail.kind).toBe('output_failed')
  })

  it('rejects unknown kind', () => {
    expect(() =>
      OutputActivityEventSchema.parse({
        kind: 'something_else',
        channel: 'sms',
      } as unknown),
    ).toThrow()
  })
})
