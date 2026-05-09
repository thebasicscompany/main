import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms'
import { getConfig } from '../config.js'

let _client: KMSClient | null = null
function client(): KMSClient {
  if (!_client)
    _client = new KMSClient({ region: getConfig().AWS_REGION ?? 'us-east-1' })
  return _client
}

export function __resetKmsForTests(): void {
  _client = null
}

export interface EncryptResult {
  ciphertext: Buffer
  kmsKeyId: string
}

export async function encryptCredential(
  plaintext: string,
  alias?: string,
): Promise<EncryptResult> {
  const cfg = getConfig()
  const KeyId = alias ?? cfg.BYOK_KMS_KEY_ALIAS
  if (!KeyId || KeyId.trim().length === 0) {
    throw new Error('kms: BYOK_KMS_KEY_ALIAS is not configured')
  }
  const out = await client().send(
    new EncryptCommand({
      KeyId,
      Plaintext: Buffer.from(plaintext, 'utf8'),
      EncryptionContext: { purpose: 'workspace_credential' },
    }),
  )
  if (!out.CiphertextBlob || !out.KeyId) throw new Error('kms: encrypt returned empty')
  return { ciphertext: Buffer.from(out.CiphertextBlob), kmsKeyId: out.KeyId }
}

export async function decryptCredential(ciphertext: Buffer): Promise<string> {
  const out = await client().send(
    new DecryptCommand({
      CiphertextBlob: ciphertext,
      EncryptionContext: { purpose: 'workspace_credential' },
    }),
  )
  if (!out.Plaintext) throw new Error('kms: decrypt returned empty')
  return Buffer.from(out.Plaintext).toString('utf8')
}
