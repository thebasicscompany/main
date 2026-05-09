import { describe, expect, it } from 'vitest'
import { HEADER_KEYS, RESPONSE_HEADER_KEYS } from '../../globals.js'
import { ResponseService } from './responseService.js'

function service() {
  return new ResponseService(
    {
      index: 3,
      traceId: 'trace-test',
      provider: 'anthropic',
    } as never,
    {} as never,
  )
}

describe('ResponseService', () => {
  it('returns the rewrapped response with gateway headers attached', async () => {
    const original = new Response('ok', {
      status: 200,
      headers: { 'content-length': '2' },
    })

    const response = service().updateHeaders(original, 'MISS', 2)

    expect(response.headers.get(RESPONSE_HEADER_KEYS.LAST_USED_OPTION_INDEX)).toBe('3')
    expect(response.headers.get(RESPONSE_HEADER_KEYS.TRACE_ID)).toBe('trace-test')
    expect(response.headers.get(RESPONSE_HEADER_KEYS.RETRY_ATTEMPT_COUNT)).toBe('2')
    expect(response.headers.get(RESPONSE_HEADER_KEYS.CACHE_STATUS)).toBe('MISS')
    expect(response.headers.get(HEADER_KEYS.PROVIDER)).toBe('anthropic')
    expect(response.headers.get('content-length')).toBeNull()
    expect(await response.text()).toBe('ok')
  })

  it('create returns the rewrapped response for already-mapped provider responses', async () => {
    const { response } = await service().create({
      response: new Response('ok', { status: 200 }),
      responseTransformer: undefined,
      isResponseAlreadyMapped: true,
      cache: {
        isCacheHit: false,
        cacheStatus: undefined,
        cacheKey: undefined,
      },
      retryAttempt: 0,
    })

    expect(response.headers.get(RESPONSE_HEADER_KEYS.TRACE_ID)).toBe('trace-test')
    expect(await response.text()).toBe('ok')
  })
})
