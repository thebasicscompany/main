import { getDb } from '../db/index.js'
import { usageEvents } from '../db/schema.js'
import { DatabaseUnavailableError } from './errors.js'
import { logger } from '../middleware/logger.js'

export type RecordUsageArgs = {
  workspaceId: string
  accountId?: string | null
  kind: string
  quantity: number
  unit: string
  cents?: number | null
  provider?: string | null
  model?: string | null
  runId?: string | null
  metadata?: unknown
  occurredAt?: Date
}

/**
 * Append one usage row. Swallows DB-unavailable; logs insert failures without throwing
 * so callers (e.g. SSE LLM proxy) never fail the user response after a successful upstream call.
 */
export async function recordUsage(args: RecordUsageArgs): Promise<void> {
  let db
  try {
    db = getDb()
  } catch (e) {
    if (e instanceof DatabaseUnavailableError) {
      logger.warn(
        { kind: args.kind, workspace_id: args.workspaceId },
        'recordUsage skipped: database unavailable',
      )
      return
    }
    throw e
  }

  const occurredAt = args.occurredAt ?? new Date()
  const qStr = Number.isFinite(args.quantity) ? String(args.quantity) : '0'

  try {
    await db.insert(usageEvents).values({
      workspaceId: args.workspaceId,
      accountId: args.accountId ?? null,
      kind: args.kind,
      quantity: qStr,
      unit: args.unit,
      cents:
        args.cents !== undefined && args.cents !== null
          ? String(args.cents)
          : null,
      provider: args.provider ?? null,
      model: args.model ?? null,
      runId: args.runId ?? null,
      metadata: (args.metadata === undefined ? null : args.metadata) as never,
      occurredAt,
    })
  } catch (err) {
    logger.error(
      {
        err,
        kind: args.kind,
        workspace_id: args.workspaceId,
      },
      'recordUsage insert failed',
    )
  }
}

/** One Gemini `/v1/llm` completion → up to two rows (input / output token counts). */
export async function recordLlmProxyUsage(args: {
  workspaceId: string
  accountId: string
  model: string
  tokensInput: number
  tokensOutput: number
  requestId?: string
  credentialMetadata?: Record<string, unknown>
}): Promise<void> {
  const occurredAt = new Date()
  const metadata =
    args.requestId || args.credentialMetadata
      ? {
          ...(args.requestId ? { request_id: args.requestId } : {}),
          ...args.credentialMetadata,
        }
      : undefined

  if (args.tokensInput > 0) {
    await recordUsage({
      workspaceId: args.workspaceId,
      accountId: args.accountId,
      kind: 'llm_input_tokens',
      quantity: args.tokensInput,
      unit: 'tokens',
      provider: 'google',
      model: args.model,
      metadata,
      occurredAt,
    })
  }
  if (args.tokensOutput > 0) {
    await recordUsage({
      workspaceId: args.workspaceId,
      accountId: args.accountId,
      kind: 'llm_output_tokens',
      quantity: args.tokensOutput,
      unit: 'tokens',
      provider: 'google',
      model: args.model,
      metadata,
      occurredAt,
    })
  }
}
