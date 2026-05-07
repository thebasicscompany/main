import { serve } from '@hono/node-server'
import { app } from './app.js'
import { logger } from './middleware/logger.js'
import { getConfig } from './config.js'

const cfg = getConfig()

const server = serve({ fetch: app.fetch, port: cfg.PORT }, (info) => {
  logger.info({ port: info.port, nodeEnv: cfg.NODE_ENV }, 'basics-runtime listening')
})

function shutdown(signal: string): void {
  logger.info({ signal }, 'basics-runtime shutting down')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
