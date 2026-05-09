import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getConfig } from '../config.js'
import { ServiceUnavailableError } from './errors.js'

function artifactsBucket(): string {
  const b = getConfig().ARTIFACTS_S3_BUCKET
  if (!b?.trim()) {
    throw new ServiceUnavailableError(
      'artifacts_unavailable',
      'ARTIFACTS_S3_BUCKET is not configured',
    )
  }
  return b
}

function client(): S3Client {
  const cfg = getConfig()
  return new S3Client({ region: cfg.AWS_REGION ?? 'us-east-1' })
}

export async function presignPut(args: {
  workspaceId: string
  importId: string
  filename: string
  contentType: string
  sizeBytes: number
}) {
  const bucket = artifactsBucket()
  const key = `workspaces/${args.workspaceId}/imports/${args.importId}/${args.filename}`
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: args.contentType,
    ContentLength: args.sizeBytes,
  })
  const uploadUrl = await getSignedUrl(client(), cmd, { expiresIn: 600 })
  const storageUrl = `s3://${bucket}/${key}`
  return { uploadUrl, storageUrl }
}

export async function presignGet(storageUrl: string) {
  const m = storageUrl.match(/^s3:\/\/([^/]+)\/(.+)$/)
  if (!m) throw new Error('invalid storage_url')
  const cmd = new GetObjectCommand({ Bucket: m[1], Key: m[2] })
  return await getSignedUrl(client(), cmd, { expiresIn: 600 })
}
