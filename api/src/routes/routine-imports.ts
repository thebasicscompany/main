/**
 * /v1/runtime/routine-imports — Basics Cloud M1 (routine promotion).
 *
 *   POST   /                                       — create import (+ optional inline artifacts)
 *   GET    /:id                                   — import metadata
 *   POST   /:id/artifacts                         — add artifact (inline, presign, or finalize upload)
 *   GET    /:id/artifacts                         — list artifacts
 *   POST   /:id/promote                           — materialize workflow + version 1
 */

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  ConflictError,
  DatabaseUnavailableError,
  handleError,
  NotFoundError,
  ValidationError,
} from '../lib/errors.js'
import { presignPut } from '../lib/s3.js'
import { logger } from '../middleware/logger.js'
import type { AppVariables } from '../app.js'
import type { PromoteRoutineImportResult } from '../orchestrator/routineImportsRepo.js'
import * as routineImportsRepo from '../orchestrator/routineImportsRepo.js'

export const routineImportsRoute = new Hono<{ Variables: AppVariables }>()

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isUuid(s: string): boolean {
  return UUID_RE.test(s)
}

const artifactKindEnum = z.enum([
  'lens_summary',
  'distill_input',
  'distill_output',
  'screenshot',
  'dom_snapshot',
  'browser_events',
])

const createImportSchema = z
  .object({
    assistant_routine_id: z.string().min(1),
    source_assistant_id: z.string().optional(),
    lens_session_id: z.string().optional(),
    extension_recording_id: z.string().optional(),
    name: z.string().min(1),
    prompt: z.string().min(1),
    steps: z.array(z.unknown()).default([]),
    parameters: z.array(z.unknown()).default([]),
    checks: z.array(z.unknown()).default([]),
    artifacts: z
      .array(
        z.object({
          kind: artifactKindEnum,
          inline_json: z.unknown().optional(),
          storage_url: z.string().url().optional(),
          content_type: z.string().optional(),
          size_bytes: z.number().int().nonnegative().optional(),
        }),
      )
      .default([]),
  })
  .strict()

const promoteSchema = z
  .object({
    name: z.string().min(1),
    prompt: z.string().min(1),
    steps: z.array(z.unknown()).default([]),
    parameters: z.array(z.unknown()).default([]),
    checks: z.array(z.unknown()).default([]),
  })
  .strict()

const postArtifactSchema = z
  .object({
    kind: artifactKindEnum,
    inline_json: z.unknown().optional(),
    storage_url: z.string().url().optional(),
    content_type: z.string().min(1).optional(),
    size_bytes: z.number().int().nonnegative().optional(),
  })
  .strict()

routineImportsRoute.post('/', zValidator('json', createImportSchema), async (c) => {
  const body = c.req.valid('json')
  const ws = c.get('workspace')!
  try {
    const existing = await routineImportsRepo.findByWorkspaceAndAssistantRoutineId(
      ws.workspace_id,
      body.assistant_routine_id,
    )
    if (existing) {
      return c.json({ import_id: existing.id, status: existing.status }, 200)
    }
    const row = await routineImportsRepo.createWithArtifacts({
      workspaceId: ws.workspace_id,
      assistantRoutineId: body.assistant_routine_id,
      sourceAssistantId: body.source_assistant_id,
      lensSessionId: body.lens_session_id,
      extensionRecordingId: body.extension_recording_id,
      artifacts: body.artifacts.map((a) => ({
        kind: a.kind,
        storageUrl: a.storage_url ?? null,
        inlineJson: a.inline_json ?? null,
        contentType: a.content_type ?? null,
        sizeBytes: a.size_bytes ?? null,
      })),
    })
    return c.json({ import_id: row.id, status: row.status }, 201)
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      return handleError(c, err)
    }
    logger.error({ err }, 'routine-imports create failed')
    return handleError(c, err)
  }
})

routineImportsRoute.post(
  '/:id/artifacts',
  zValidator('json', postArtifactSchema),
  async (c) => {
    const ws = c.get('workspace')!
    const importId = c.req.param('id')
    const body = c.req.valid('json')
    if (!isUuid(importId)) {
      return handleError(c, new NotFoundError('Import not found'))
    }

    const hasInline = body.inline_json !== undefined
    const wantsPresign =
      body.content_type !== undefined && body.size_bytes !== undefined
    const wantsFinalize = body.storage_url !== undefined

    const modeCount =
      (hasInline ? 1 : 0) + (wantsPresign ? 1 : 0) + (wantsFinalize ? 1 : 0)
    if (modeCount !== 1) {
      return handleError(
        c,
        new ValidationError(
          'Exactly one of inline_json, (content_type + size_bytes), or storage_url must be set',
        ),
      )
    }

    try {
      const imp = await routineImportsRepo.getById(ws.workspace_id, importId)
      if (!imp) {
        return handleError(c, new NotFoundError('Import not found'))
      }
      if (imp.status !== 'importing') {
        return handleError(
          c,
          new ValidationError('Artifacts can only be added while status is importing'),
        )
      }

      if (wantsPresign) {
        const filename = randomUUID()
        const { uploadUrl, storageUrl } = await presignPut({
          workspaceId: ws.workspace_id,
          importId,
          filename,
          contentType: body.content_type!,
          sizeBytes: body.size_bytes!,
        })
        return c.json({ upload_url: uploadUrl, storage_url: storageUrl })
      }

      if (wantsFinalize) {
        const row = await routineImportsRepo.insertArtifact({
          workspaceId: ws.workspace_id,
          importId,
          kind: body.kind,
          storageUrl: body.storage_url!,
        })
        return c.json({
          artifact_id: row.id,
          kind: row.kind,
          storage_url: row.storageUrl,
        })
      }

      const row = await routineImportsRepo.insertArtifact({
        workspaceId: ws.workspace_id,
        importId,
        kind: body.kind,
        inlineJson: body.inline_json,
      })
      return c.json({
        artifact_id: row.id,
        kind: row.kind,
        inline_json: row.inlineJson,
      })
    } catch (err) {
      if (err instanceof DatabaseUnavailableError) {
        return handleError(c, err)
      }
      logger.error({ err }, 'routine-imports artifact failed')
      return handleError(c, err)
    }
  },
)

routineImportsRoute.get('/:id/artifacts', async (c) => {
  const ws = c.get('workspace')!
  const importId = c.req.param('id')
  if (!isUuid(importId)) {
    return handleError(c, new NotFoundError('Import not found'))
  }
  try {
    const imp = await routineImportsRepo.getById(ws.workspace_id, importId)
    if (!imp) {
      return handleError(c, new NotFoundError('Import not found'))
    }
    const rows = await routineImportsRepo.listArtifacts(ws.workspace_id, importId)
    return c.json({
      artifacts: rows.map((r) => ({
        artifact_id: r.id,
        kind: r.kind,
        storage_url: r.storageUrl,
        inline_json: r.inlineJson,
        content_type: r.contentType,
        size_bytes: r.sizeBytes,
        created_at: r.createdAt.toISOString(),
      })),
    })
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      return handleError(c, err)
    }
    logger.error({ err }, 'routine-imports list artifacts failed')
    return handleError(c, err)
  }
})

routineImportsRoute.post(
  '/:id/promote',
  zValidator('json', promoteSchema),
  async (c) => {
    const ws = c.get('workspace')!
    const importId = c.req.param('id')
    const body = c.req.valid('json')
    if (!isUuid(importId)) {
      return handleError(c, new NotFoundError('Import not found'))
    }
    try {
      let result: PromoteRoutineImportResult
      try {
        result = await routineImportsRepo.promote({
          workspaceId: ws.workspace_id,
          importId,
          accountId: ws.account_id,
          name: body.name,
          prompt: body.prompt,
          steps: body.steps,
          parameters: body.parameters,
          checks: body.checks,
        })
      } catch (e) {
        if (e instanceof Error) {
          if (e.message === 'not_found') {
            return handleError(c, new NotFoundError('Import not found'))
          }
          if (e.message === 'already_promoted') {
            return handleError(
              c,
              new ConflictError(
                'already_promoted',
                'This import was already promoted',
              ),
            )
          }
          if (e.message === 'failed_import') {
            return handleError(
              c,
              new ValidationError('Cannot promote an import in failed status'),
            )
          }
        }
        throw e
      }
      return c.json({
        import_id: result.importId,
        workflow_id: result.workflowId,
        version: result.version,
        status: result.status,
      })
    } catch (err) {
      if (err instanceof DatabaseUnavailableError) {
        return handleError(c, err)
      }
      logger.error({ err }, 'routine-imports promote failed')
      return handleError(c, err)
    }
  },
)

routineImportsRoute.get('/:id', async (c) => {
  const ws = c.get('workspace')!
  const id = c.req.param('id')
  if (!isUuid(id)) {
    return handleError(c, new NotFoundError('Import not found'))
  }
  try {
    const row = await routineImportsRepo.getById(ws.workspace_id, id)
    if (!row) {
      return handleError(c, new NotFoundError('Import not found'))
    }
    return c.json({
      import_id: row.id,
      workspace_id: row.workspaceId,
      assistant_routine_id: row.assistantRoutineId,
      source_assistant_id: row.sourceAssistantId,
      lens_session_id: row.lensSessionId,
      extension_recording_id: row.extensionRecordingId,
      workflow_id: row.workflowId,
      status: row.status,
      error: row.error,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
    })
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      return handleError(c, err)
    }
    logger.error({ err }, 'routine-imports get failed')
    return handleError(c, err)
  }
})
