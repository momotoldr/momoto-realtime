// FIRST, before any other import: populates process.env from .env.local + .env. See
// src/config/loadEnv.ts.
import './config/loadEnv.js'

import { createServer } from 'node:http'

import { env } from './config/env.js'
import { createApp } from './http/app.js'
import { sweepRoomCreateLimits } from './http/routes/rooms.js'
import { sweepTurnLimits } from './http/routes/turn.js'
import { logger } from './lib/logger.js'
import { getRedis, redisEnabled } from './lib/redis.js'
import { roomStore } from './rooms/roomStore.js'
import { sweepSocketLimits } from './socket/rateLimits.js'
import { createSocketServer } from './socket/server.js'

const app = createApp()
const httpServer = createServer(app)
createSocketServer(httpServer)

// Periodic GC: reclaim whatever the room store no longer needs (unjoined reservations
// and expired ended-room codes in memory; orphaned index entries once it is Redis) plus
// elapsed rate-limit windows, so nothing grows unbounded.
async function sweep(): Promise<void> {
  // A throw — or now a rejection — inside a timer callback has no caller to catch it,
  // and would surface as an uncaught exception and end the process. Contain it here.
  try {
    await roomStore.sweep()
    sweepSocketLimits()
    sweepRoomCreateLimits()
    sweepTurnLimits()
  } catch (err) {
    logger.error('sweep.failed', { err: String(err) })
  }
}

// `unref` so the timer never blocks shutdown.
const sweeper = setInterval(() => void sweep(), 30_000)
sweeper.unref()

// Open the Redis connection at boot when one is configured. Nothing reads it yet — the
// room store still lives in this process's memory — but connecting here is what turns a
// misconfiguration into a log line on deploy rather than a mystery during the first live
// session. It is also the hook `/healthz` will use once the drain lands: a deployment
// that has never reached Redis must not go Active.
//
// The IPv6 question is the one worth proving on staging: Railway's private network only
// resolves over IPv6, so `redis.ready` appearing in these logs is the evidence that
// `family: 0` does its job for `redis.railway.internal`.
if (redisEnabled) {
  getRedis()
} else if (process.env.NODE_ENV === 'production') {
  // Not fatal: one instance with in-memory rooms is a working server, just one where
  // every deploy still ends every live room. Loud, because that is rarely intended.
  logger.warn('redis.not_configured', {
    detail: 'REDIS_URL is unset in production — room state is in-process and dies with a deploy',
  })
}

httpServer.listen(env.port, () => {
  logger.info('server.listening', {
    port: env.port,
    corsOrigins: env.corsOrigins,
    roomCapacityMax: env.roomCapacityMax,
    redis: redisEnabled ? 'configured' : 'off',
    turn: env.cloudflareTurnKeyId ? 'cloudflare' : env.turnUrls.length > 0 ? 'coturn' : 'stun-only',
  })
})

function shutdown(signal: string): void {
  logger.info('server.shutdown', { signal })
  httpServer.close(() => process.exit(0))
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

// ── Last-resort process guards ───────────────────────────────────────────────
// This net catches anything that escapes a handler (a stray promise in a socket
// handler, a library's internal async work). Node's default for an unhandled rejection
// is to throw — which would end the process and drop every live room over one stray
// error, so we log and keep serving instead.
process.on('unhandledRejection', (reason) => {
  logger.error('process.unhandled_rejection', {
    err: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  })
})

// An uncaught exception is different: the process may be in an undefined state, so
// we log and let the platform restart us rather than serve from a corrupt process.
process.on('uncaughtException', (err) => {
  logger.error('process.uncaught_exception', { err: err.message, stack: err.stack })
  shutdown('uncaughtException')
  // Don't wait forever on in-flight connections to drain.
  setTimeout(() => process.exit(1), 5_000).unref()
})
