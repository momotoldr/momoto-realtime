// FIRST, before any other import: populates process.env from .env.local + .env. See
// src/config/loadEnv.ts.
import './config/loadEnv.js'

import { createServer } from 'node:http'

import { env } from './config/env.js'
import { createApp } from './http/app.js'
import { sweepRoomCreateLimits } from './http/routes/rooms.js'
import { sweepTurnLimits } from './http/routes/turn.js'
import { logger } from './lib/logger.js'
import { roomStore } from './rooms/roomStore.js'
import { sweepSocketLimits } from './socket/rateLimits.js'
import { createSocketServer } from './socket/server.js'

const app = createApp()
const httpServer = createServer(app)
createSocketServer(httpServer)

// Periodic GC: reclaim unjoined reservations, expired ended-room codes, and elapsed
// rate-limit windows so no in-memory map grows unbounded. `unref` so the timer never
// blocks shutdown.
const sweeper = setInterval(() => {
  // A throw inside a timer callback has no caller to catch it — it would surface as
  // an uncaught exception and end the process. Contain it here.
  try {
    roomStore.sweepReservations()
    roomStore.sweepEndedRooms()
    sweepSocketLimits()
    sweepRoomCreateLimits()
    sweepTurnLimits()
  } catch (err) {
    logger.error('sweep.failed', { err: String(err) })
  }
}, 30_000)
sweeper.unref()

httpServer.listen(env.port, () => {
  logger.info('server.listening', {
    port: env.port,
    corsOrigins: env.corsOrigins,
    roomCapacityMax: env.roomCapacityMax,
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
