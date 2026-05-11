import { normalizeComposioSkillPreferences, type ComposioSkillPreferences } from '@basics/shared'
import { getAssistantCompatRepo } from '../orchestrator/assistantCompatRepo.js'

export const COMPOSIO_SKILL_SETTINGS_SCOPE = 'skills.composio'

export type ComposioSkillPreferenceScope = {
  workspaceId: string
  accountId: string
  assistantId: string
}

export async function getComposioSkillPreferences(
  scope: ComposioSkillPreferenceScope,
): Promise<ComposioSkillPreferences> {
  const data = await getAssistantCompatRepo().getSetting(scope, COMPOSIO_SKILL_SETTINGS_SCOPE)
  return normalizeComposioSkillPreferences(data)
}

export async function setComposioSkillPreferences(
  scope: ComposioSkillPreferenceScope,
  preferences: ComposioSkillPreferences,
): Promise<ComposioSkillPreferences> {
  const normalized = normalizeComposioSkillPreferences(preferences)
  const data = await getAssistantCompatRepo().setSetting(scope, COMPOSIO_SKILL_SETTINGS_SCOPE, {
    disabledToolkitSlugs: normalized.disabledToolkitSlugs,
    disabledToolSlugs: normalized.disabledToolSlugs,
    connectedAccountIdsByToolkit: normalized.connectedAccountIdsByToolkit,
    ...(normalized.display ? { display: normalized.display } : {}),
  })
  return normalizeComposioSkillPreferences(data)
}

export async function patchComposioToolkitPreferences(
  scope: ComposioSkillPreferenceScope,
  toolkitSlug: string,
  patch: {
    enabled?: boolean
    disabledToolSlugs?: string[]
    selectedConnectedAccountId?: string | null
    display?: Record<string, unknown>
  },
): Promise<ComposioSkillPreferences> {
  const current = await getComposioSkillPreferences(scope)
  const disabledToolkitSlugs = new Set(current.disabledToolkitSlugs)
  if (patch.enabled === true) disabledToolkitSlugs.delete(toolkitSlug)
  if (patch.enabled === false) disabledToolkitSlugs.add(toolkitSlug)

  const disabledToolSlugs = new Set(current.disabledToolSlugs)
  if (patch.disabledToolSlugs) {
    for (const existing of [...disabledToolSlugs]) {
      if (existing.startsWith(`${toolkitSlug}_`)) disabledToolSlugs.delete(existing)
    }
    for (const slug of patch.disabledToolSlugs) disabledToolSlugs.add(slug)
  }

  const connectedAccountIdsByToolkit = { ...current.connectedAccountIdsByToolkit }
  if (patch.selectedConnectedAccountId === null) {
    delete connectedAccountIdsByToolkit[toolkitSlug]
  } else if (patch.selectedConnectedAccountId) {
    connectedAccountIdsByToolkit[toolkitSlug] = patch.selectedConnectedAccountId
  }

  return setComposioSkillPreferences(scope, {
    disabledToolkitSlugs: [...disabledToolkitSlugs].sort(),
    disabledToolSlugs: [...disabledToolSlugs].sort(),
    connectedAccountIdsByToolkit,
    ...(patch.display ?? current.display ? { display: patch.display ?? current.display } : {}),
  })
}

export async function clearComposioToolkitPreferences(
  scope: ComposioSkillPreferenceScope,
  toolkitSlug: string,
  connectedAccountId?: string,
): Promise<ComposioSkillPreferences> {
  const current = await getComposioSkillPreferences(scope)
  const connectedAccountIdsByToolkit = { ...current.connectedAccountIdsByToolkit }
  if (
    !connectedAccountId ||
    connectedAccountIdsByToolkit[toolkitSlug] === connectedAccountId
  ) {
    delete connectedAccountIdsByToolkit[toolkitSlug]
  }
  return setComposioSkillPreferences(scope, {
    disabledToolkitSlugs: current.disabledToolkitSlugs.filter((slug) => slug !== toolkitSlug),
    disabledToolSlugs: current.disabledToolSlugs.filter(
      (slug) => !slug.startsWith(`${toolkitSlug}_`),
    ),
    connectedAccountIdsByToolkit,
    ...(current.display ? { display: current.display } : {}),
  })
}
