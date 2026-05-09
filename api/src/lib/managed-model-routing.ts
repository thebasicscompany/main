/**
 * When `provenance === 'basics_managed'`, orchestrator may rewrite the model.
 * Never rewrite for BYOK customers (§6.3).
 */
/** Anthropic `agent` matches `COMPUTER_USE_MODEL` — newer IDs may reject computer-use betas. */
export const MANAGED_MODELS = {
  anthropic: { agent: 'claude-sonnet-4-5', utility: 'claude-haiku-4-5' },
  openai: { agent: 'gpt-5', utility: 'gpt-5-mini' },
  gemini: { agent: 'gemini-2.5-pro', utility: 'gemini-2.5-flash' },
} as const

export function pickManagedModel(
  kind: string,
  workload: 'agent' | 'utility' | 'embed' = 'agent',
): string {
  const row = MANAGED_MODELS[kind as keyof typeof MANAGED_MODELS]
  if (!row) return MANAGED_MODELS.anthropic.agent
  if (workload === 'embed') return row.utility
  return row[workload]
}
