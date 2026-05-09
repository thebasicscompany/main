import { DeepgramClient } from '@deepgram/sdk'
import { getConfig } from '../config.js'
import { logger } from '../middleware/logger.js'
import {
  CredentialNotProvisionedError,
  resolveActiveCredential,
} from '../orchestrator/credential-resolver.js'
import { DatabaseUnavailableError, DeepgramUnavailableError } from './errors.js'

export interface DeepgramCredentials {
  deepgramToken: string
  sttUrl: string
  ttsUrl: string
  expiresIn: number
}

/**
 * Issue a short-lived Deepgram scoped token (1h ttl). Returns the token
 * plus the public STT WebSocket URL and Aura TTS HTTPS endpoint the
 * desktop overlay opens directly.
 *
 * Throws `DeepgramUnavailableError` if no workspace key resolves and
 * `DEEPGRAM_API_KEY` is unset so the caller can surface 503 without crashing on boot.
 */
export async function grantDeepgramToken(
  requestId?: string,
  workspaceId?: string,
): Promise<DeepgramCredentials> {
  let apiKey: string | undefined
  if (workspaceId) {
    try {
      const r = await resolveActiveCredential({ workspaceId, kind: 'deepgram' })
      apiKey = r.plaintext
    } catch (e) {
      if (
        !(e instanceof CredentialNotProvisionedError) &&
        !(e instanceof DatabaseUnavailableError)
      ) {
        throw e
      }
    }
  }
  if (!apiKey?.trim()) {
    apiKey = getConfig().DEEPGRAM_API_KEY
  }
  if (!apiKey || apiKey.trim().length === 0) {
    throw new DeepgramUnavailableError()
  }
  const client = new DeepgramClient({ apiKey })
  try {
    const result = await client.auth.v1.tokens.grant({ ttl_seconds: 3600 })
    if (typeof result.access_token !== 'string' || result.access_token.length === 0) {
      throw new Error('deepgram grant returned no access_token')
    }
    const expiresIn = result.expires_in ?? 3600
    logger.info({ requestId, expiresIn }, 'deepgram grant success')
    return {
      deepgramToken: result.access_token,
      sttUrl: 'wss://api.deepgram.com/v1/listen',
      ttsUrl: 'https://api.deepgram.com/v1/speak',
      expiresIn,
    }
  } catch (err) {
    // Never log the response body — would leak the token if request partially succeeded.
    const errObj = err as Error
    logger.error(
      { requestId, err: { name: errObj.name, message: errObj.message } },
      'deepgram grant failed',
    )
    throw err
  }
}
