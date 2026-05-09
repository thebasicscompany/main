import { GoogleGenAI } from '@google/genai'
import { getConfig } from '../config.js'
import { DatabaseUnavailableError } from './errors.js'
import { logger } from '../middleware/logger.js'
import {
  CredentialNotProvisionedError,
  resolveActiveCredential,
} from '../orchestrator/credential-resolver.js'

/** Drizzle often surfaces missing BYOK table as `Failed query: ... workspace_credentials ...` without a walkable `cause`. */
function isWorkspaceCredentialStoreQueryFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const m = err.message
  return m.includes('workspace_credentials') && m.includes('Failed query')
}

export interface GeminiHandle {
  genai: GoogleGenAI
  credentialId: string | null
  provenance: 'basics_managed' | 'customer_byok' | 'env_fallback'
}

export async function getGeminiClientForWorkspace(workspaceId: string): Promise<GeminiHandle> {
  try {
    const resolved = await resolveActiveCredential({ workspaceId, kind: 'gemini' })
    return {
      genai: new GoogleGenAI({ apiKey: resolved.plaintext }),
      credentialId: resolved.credentialId,
      provenance: resolved.provenance as 'basics_managed' | 'customer_byok',
    }
  } catch (e) {
    if (
      !(e instanceof CredentialNotProvisionedError) &&
      !(e instanceof DatabaseUnavailableError) &&
      !isWorkspaceCredentialStoreQueryFailure(e)
    ) {
      throw e
    }
    if (
      !(e instanceof CredentialNotProvisionedError) &&
      !(e instanceof DatabaseUnavailableError)
    ) {
      logger.warn(
        { workspace_id: workspaceId, kind: 'gemini' },
        'gemini: workspace_credentials query failed — env GEMINI fallback',
      )
    }
  }
  const key = getConfig().GEMINI_API_KEY
  return {
    genai: new GoogleGenAI({ apiKey: key }),
    credentialId: null,
    provenance: 'env_fallback',
  }
}
