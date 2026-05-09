/**
 * Strip sensitive credential fields before logging or analytics.
 */
export function redactCredentialBody(body: unknown): unknown {
  if (body === null || body === undefined) return body
  if (typeof body !== 'object' || Array.isArray(body)) return body
  const o = { ...(body as Record<string, unknown>) }
  if ('plaintext' in o) o.plaintext = '[REDACTED]'
  return o
}
