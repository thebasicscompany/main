import type { Context } from 'hono'

/**
 * Base application error. All HTTP-aware errors extend this.
 */
export class AppError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, 'unauthorized', message)
    this.name = 'AuthError'
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(403, 'forbidden', message)
    this.name = 'ForbiddenError'
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not Found') {
    super(404, 'not_found', message)
    this.name = 'NotFoundError'
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(409, code, message)
    this.name = 'ConflictError'
  }
}

export class ValidationError extends AppError {
  readonly details: unknown
  constructor(message = 'Validation failed', details?: unknown) {
    super(400, 'validation_error', message)
    this.name = 'ValidationError'
    this.details = details
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal Server Error') {
    super(500, 'internal_error', message)
    this.name = 'InternalError'
  }
}

/**
 * Service-unavailable / capability-gated errors. Used when an env var
 * tied to an optional feature is missing — the server still boots,
 * but the affected route returns 503 with a machine-readable code.
 */
export class ServiceUnavailableError extends AppError {
  constructor(code: string, message: string) {
    super(503, code, message)
    this.name = 'ServiceUnavailableError'
  }
}

export class DatabaseUnavailableError extends ServiceUnavailableError {
  constructor(message = 'DATABASE_URL is not configured') {
    super('database_unavailable', message)
    this.name = 'DatabaseUnavailableError'
  }
}

export class DeepgramUnavailableError extends ServiceUnavailableError {
  constructor(message = 'DEEPGRAM_API_KEY is not configured') {
    super('deepgram_unavailable', message)
    this.name = 'DeepgramUnavailableError'
  }
}

export class GeminiUnavailableError extends ServiceUnavailableError {
  constructor(message = 'GEMINI_API_KEY is not configured') {
    super('gemini_unavailable', message)
    this.name = 'GeminiUnavailableError'
  }
}

export class AnthropicUnavailableError extends ServiceUnavailableError {
  constructor(message = 'ANTHROPIC_API_KEY is not configured') {
    super('anthropic_unavailable', message)
    this.name = 'AnthropicUnavailableError'
  }
}

export class BrowserbaseUnavailableError extends ServiceUnavailableError {
  constructor(message = 'BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID is not configured') {
    super('browserbase_unavailable', message)
    this.name = 'BrowserbaseUnavailableError'
  }
}

export class RunNotFoundError extends NotFoundError {
  constructor(message = 'Run not found') {
    super(message)
    this.name = 'RunNotFoundError'
  }
}

export class RunAccessDeniedError extends ForbiddenError {
  constructor(message = 'Run not accessible to this workspace') {
    super(message)
    this.name = 'RunAccessDeniedError'
  }
}

interface ErrorBody {
  error: string
  message: string
  details?: unknown
}

/**
 * Map a thrown value to a Hono response. Opt-in — call from route handlers
 * that want consistent error shapes; the global onError still catches
 * anything that escapes and returns `{ error: 'internal_error' }`.
 */
export function handleError(c: Context, error: unknown): Response {
  if (error instanceof AppError) {
    const body: ErrorBody = { error: error.code, message: error.message }
    if (error instanceof ValidationError && error.details !== undefined) {
      body.details = error.details
    }
    return c.json(
      body,
      error.statusCode as 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503,
    )
  }
  const message = error instanceof Error ? error.message : 'Unknown error'
  return c.json({ error: 'internal_error', message }, 500)
}

/**
 * Assert a required env var is present. Throws a descriptive error if missing.
 */
export function requireEnv(name: string, value: string | undefined): string {
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`)
  }
  return value
}
