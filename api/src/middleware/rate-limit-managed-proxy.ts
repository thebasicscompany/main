import Redis from 'ioredis'
import { createMiddleware } from 'hono/factory'
import type { Context } from 'hono'
import { getConfig } from '../config.js'
import type { WorkspaceToken } from '../lib/jwt.js'
import type { AuthenticatedWorkspaceApiKey } from '../lib/workspace-api-keys.js'

type Bucket = { count: number; resetAt: number }
type RateLimitResult = {
  allowed: boolean
  limit: number
  remaining: number
  resetAt: number
}

const inMemoryBuckets = new Map<string, Bucket>()
let redisClient: Redis | null = null

async function incrementInMemory(
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = Date.now()
  let bucket = inMemoryBuckets.get(key)
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs }
    inMemoryBuckets.set(key, bucket)
  }
  bucket.count += 1
  return {
    allowed: bucket.count <= limit,
    limit,
    remaining: Math.max(0, limit - bucket.count),
    resetAt: bucket.resetAt,
  }
}

function getRedis(url: string): Redis {
  if (!redisClient) {
    redisClient = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
  }
  return redisClient
}

async function incrementRedis(
  url: string,
  key: string,
  limit: number,
  windowMs: number,
): Promise<RateLimitResult> {
  const now = Date.now()
  const windowId = Math.floor(now / windowMs)
  const resetAt = (windowId + 1) * windowMs
  const redisKey = `basics:rate-limit:${key}:${windowId}`
  const redis = getRedis(url)
  if (redis.status === 'wait') await redis.connect()
  const count = await redis.incr(redisKey)
  if (count === 1) {
    await redis.pexpire(redisKey, Math.max(1, resetAt - now))
  }
  return {
    allowed: count <= limit,
    limit,
    remaining: Math.max(0, limit - count),
    resetAt,
  }
}

function setRateLimitHeaders(c: Context, result: RateLimitResult) {
  c.header('X-RateLimit-Limit', String(result.limit))
  c.header('X-RateLimit-Remaining', String(result.remaining))
  c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)))
  if (!result.allowed) {
    c.header('Retry-After', String(Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000))))
  }
}

export function rateLimitManagedProxy(windowMs = 60_000) {
  const cfg = getConfig()

  return createMiddleware<{
    Variables: { workspace: WorkspaceToken; apiKey?: AuthenticatedWorkspaceApiKey }
  }>(async (c, next) => {
    const ws = c.var.workspace.workspace_id
    const apiKey = c.var.apiKey
    const checks: Array<{ key: string; limit: number }> = [
      {
        key: `workspace:${ws}:managed-gateway`,
        limit: cfg.MANAGED_GATEWAY_RPM_PER_WORKSPACE,
      },
    ]
    if (apiKey) {
      checks.push({
        key: `api-key:${apiKey.id}:managed-gateway`,
        limit: cfg.MANAGED_GATEWAY_RPM_PER_API_KEY,
      })
    }

    try {
      let mostConstrained: RateLimitResult | null = null
      for (const check of checks) {
        const result = cfg.MANAGED_GATEWAY_RATE_LIMIT_REDIS_URL
          ? await incrementRedis(cfg.MANAGED_GATEWAY_RATE_LIMIT_REDIS_URL, check.key, check.limit, windowMs)
          : await incrementInMemory(check.key, check.limit, windowMs)
        if (!mostConstrained || result.remaining < mostConstrained.remaining) {
          mostConstrained = result
        }
        if (!result.allowed) {
          setRateLimitHeaders(c, result)
          return c.json({ error: 'rate_limited', reason: 'managed_proxy_quota' }, 429)
        }
      }
      if (mostConstrained) setRateLimitHeaders(c, mostConstrained)
    } catch {
      let mostConstrained: RateLimitResult | null = null
      for (const check of checks) {
        const result = await incrementInMemory(check.key, check.limit, windowMs)
        if (!mostConstrained || result.remaining < mostConstrained.remaining) {
          mostConstrained = result
        }
        if (!result.allowed) {
          setRateLimitHeaders(c, result)
          return c.json({ error: 'rate_limited', reason: 'managed_proxy_quota' }, 429)
        }
      }
      if (mostConstrained) setRateLimitHeaders(c, mostConstrained)
    }

    await next()
  })
}

export function __resetManagedProxyRateLimitsForTests(): void {
  inMemoryBuckets.clear()
}
