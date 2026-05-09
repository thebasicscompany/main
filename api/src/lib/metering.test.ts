import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DatabaseUnavailableError } from './errors.js'

const values = vi.fn().mockResolvedValue(undefined)
const insert = vi.fn(() => ({ values }))
const getDbMock = vi.fn(() => ({ insert }))

vi.mock('../db/index.js', () => ({
  getDb: () => getDbMock(),
}))

import { usageEvents } from '../db/schema.js'
import { recordLlmProxyUsage, recordUsage } from './metering.js'

beforeEach(() => {
  values.mockClear()
  insert.mockClear()
  getDbMock.mockImplementation(() => ({ insert }))
})

describe('recordUsage', () => {
  it('inserts quantity as numeric string', async () => {
    await recordUsage({
      workspaceId: 'a0000000-0000-4000-8000-000000000001',
      accountId: 'b0000000-0000-4000-8000-000000000002',
      kind: 'llm_input_tokens',
      quantity: 42,
      unit: 'tokens',
      provider: 'google',
      model: 'gemini-2.5-flash',
    })
    expect(insert).toHaveBeenCalledWith(usageEvents)
    expect(values).toHaveBeenCalledTimes(1)
    const row = values.mock.calls[0]?.[0] as Record<string, unknown>
    expect(row?.kind).toBe('llm_input_tokens')
    expect(row?.quantity).toBe('42')
    expect(row?.unit).toBe('tokens')
  })

  it('returns without throwing when database is unavailable', async () => {
    getDbMock.mockImplementation(() => {
      throw new DatabaseUnavailableError()
    })
    await expect(
      recordUsage({
        workspaceId: 'a0000000-0000-4000-8000-000000000001',
        kind: 'compute_seconds',
        quantity: 1,
        unit: 'seconds',
      }),
    ).resolves.toBeUndefined()
    expect(insert).not.toHaveBeenCalled()
  })
})

describe('recordLlmProxyUsage', () => {
  it('writes input and output rows when both token counts are positive', async () => {
    await recordLlmProxyUsage({
      workspaceId: 'a0000000-0000-4000-8000-000000000001',
      accountId: 'b0000000-0000-4000-8000-000000000002',
      model: 'gemini-2.5-flash',
      tokensInput: 10,
      tokensOutput: 20,
      requestId: 'req-1',
    })
    expect(values).toHaveBeenCalledTimes(2)
    const kinds = values.mock.calls.map(
      (c) => (c[0] as { kind: string }).kind,
    )
    expect(kinds).toContain('llm_input_tokens')
    expect(kinds).toContain('llm_output_tokens')
  })

  it('writes nothing when both counts are zero', async () => {
    await recordLlmProxyUsage({
      workspaceId: 'a0000000-0000-4000-8000-000000000001',
      accountId: 'b0000000-0000-4000-8000-000000000002',
      model: 'gemini-2.5-flash',
      tokensInput: 0,
      tokensOutput: 0,
    })
    expect(values).not.toHaveBeenCalled()
  })
})
