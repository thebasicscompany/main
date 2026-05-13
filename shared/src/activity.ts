import { z } from 'zod'

export const OutputChannelSchema = z.enum(['sms', 'email', 'artifact'])
export type OutputChannel = z.infer<typeof OutputChannelSchema>

export const OutputDispatchedEventSchema = z.object({
  kind: z.literal('output_dispatched'),
  channel: OutputChannelSchema,
  recipient_or_key: z.string().min(1),
  content_hash: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  latency_ms: z.number().nonnegative(),
})
export type OutputDispatchedEvent = z.infer<typeof OutputDispatchedEventSchema>

export const OutputFailedEventSchema = z.object({
  kind: z.literal('output_failed'),
  channel: OutputChannelSchema,
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
  }),
  retriable: z.boolean(),
})
export type OutputFailedEvent = z.infer<typeof OutputFailedEventSchema>

export const OutputActivityEventSchema = z.discriminatedUnion('kind', [
  OutputDispatchedEventSchema,
  OutputFailedEventSchema,
])
export type OutputActivityEvent = z.infer<typeof OutputActivityEventSchema>
