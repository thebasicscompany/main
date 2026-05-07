import { z } from 'zod'

export const RecordingTimestampSchema = z.object({
  epochMs: z.number().finite(),
  timeOriginMs: z.number().finite().optional(),
  performanceNowMs: z.number().finite().optional(),
})

export type RecordingTimestamp = z.infer<typeof RecordingTimestampSchema>

export const RecordingTargetSchema = z.object({
  selector: z.string().min(1),
  text: z.string().optional(),
  accessibleName: z.string().optional(),
  tagName: z.string().optional(),
})

export type RecordingTarget = z.infer<typeof RecordingTargetSchema>

export const RecordingStepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('navigate'),
    url: z.string().url(),
    ts: RecordingTimestampSchema,
  }),
  z.object({
    kind: z.literal('click'),
    selector: z.string().min(1),
    text: z.string().optional(),
    accessibleName: z.string().optional(),
    coords: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
    }),
    ts: RecordingTimestampSchema,
  }),
  z.object({
    kind: z.literal('type'),
    selector: z.string().min(1),
    value: z.string(),
    masked: z.boolean().optional(),
    ts: RecordingTimestampSchema,
  }),
  z.object({
    kind: z.literal('keydown'),
    key: z.string().min(1),
    selector: z.string().min(1).optional(),
    ts: RecordingTimestampSchema,
  }),
  z.object({
    kind: z.literal('scroll'),
    x: z.number().finite(),
    y: z.number().finite(),
    selector: z.string().min(1).optional(),
    ts: RecordingTimestampSchema,
  }),
  z.object({
    kind: z.literal('wait'),
    ms: z.number().int().nonnegative(),
    reason: z.enum(['idle', 'navigation', 'manual', 'network']).optional(),
    ts: RecordingTimestampSchema,
  }),
  z.object({
    kind: z.literal('extract'),
    selector: z.string().min(1),
    as: z.string().min(1),
    ts: RecordingTimestampSchema,
  }),
])

export type RecordingStep = z.infer<typeof RecordingStepSchema>

export const RecordingPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1).max(200).optional(),
  origin: z.string().url(),
  startedAt: z.string().datetime(),
  stoppedAt: z.string().datetime(),
  clock: z.object({
    source: z.literal('performance.timeOrigin+performance.now'),
    timeOriginMs: z.number().finite(),
  }),
  rrwebEvents: z.array(z.unknown()),
  steps: z.array(RecordingStepSchema),
  redaction: z.object({
    maskedSelectors: z.array(z.string()),
    defaultMaskedPasswordInputs: z.literal(true),
  }),
})

export type RecordingPayload = z.infer<typeof RecordingPayloadSchema>

