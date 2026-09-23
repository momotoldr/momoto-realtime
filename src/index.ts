// FIRST, before any other import: populates process.env from .env.local + .env. See
// src/config/loadEnv.ts.
import './config/loadEnv.js'

import { createServer } from 'node:http'

import { env } from './config/env.js'
import { createApp } from './http/app.js'
import { sweepRoomCreateLimits } from './http/routes/rooms.js'
import { sweepTurnLimits } from './http/routes/turn.js'
import { beginDraining } from './lifecycle.js'
import { closeRedis, redisEnabled } from './lib/redis.js'
import { logger } from './lib/logger.js'
import { startExpiryPoller } from './rooms/sessionManager.js'
import { nodeId, redisRoomStore, roomStore, roomStoreKind } from './rooms/store.js'
import { sweepSocketLimits } from './socket/rateLimits.js'
import { createSocketServer } from './socket/server.js'
import { SocketEvents } from './types/events.js'

/** How long a seat outlives the process holding it before the sweeper may free it. */
const NODE_TTL_MS = 15_000
/** Refreshed well inside the TTL, so one slow write is not mistaken for a dead node. */
const HEARTBEAT_MS = 5_000
/** How long the drain spreads socket closes over, so reconnects don't arrive as one spike. */
const DRAIN_WINDOW_MS = 5_000
/** Backstop: stop waiting on a drain that isn't finishing and go. */
const DRAIN_HARD_STOP_MS = 20_000

const app = createApp()
const httpServer = createServer(app)
const io = createSocketServer(httpServer)

// Windows are retired by polling the store rather than by a timer per room, so a
// session survives the process that opened it. Every instance polls; the store hands
// each expiry to exactly one of them.
const stopExpiryPoller = startExpiryPoller(io)

/**
 * This process's heartbeat.
 *
 * `join` stamps the node id on every seat it claims, and this key is how the sweeper
 * tells "their process is gone" from "they are mid-reconnect". Only meaningful with
 * Redis: with the in-memory store, the process and the room state die together.
 */
const beating = redisRoomStore
const heartbeat = beating
  ? setInterval(() => {
      void beating.heartbeat(NODE_TTL_MS).catch((err: unknown) => {
        logger.error('node.heartbeat.failed', {
          err: err instanceof Error ? err.message : String(err),
        })
      })
    }, HEARTBEAT_MS)
  : null
heartbeat?.unref()
void redisRoomStore?.heartbeat(NODE_TTL_MS)

// Periodic GC: reclaim whatever the room store no longer needs (unjoined reservations
// and expired ended-room codes in memory; orphaned index entries and seats belonging to
// dead processes in Redis) plus elapsed rate-limit windows, so nothing grows unbounded.
async function sweep(): Promise<void> {
  // A throw — or now a rejection — inside a timer callback has no caller to catch it,
  // and would surface as an uncaught exception and end the process. Contain it here.
  try {
    const { reaped } = await roomStore.sweep()
    // A seat freed because its process died is announced exactly like an ordinary
    // leave: the people still in the room get the same two events they would have got
    // had that person closed their tab in front of us.
    for (const { roomId, socketId, members } of reaped) {
      io.to(roomId).emit(SocketEvents.peerLeft, { peerId: socketId })
      io.to(roomId).emit(SocketEvents.roomMembers, { members })
    }
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

if (!redisEnabled && process.env.NODE_ENV === 'production') {
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
    roomStore: roomStoreKind,
    nodeId,
    turn: env.cloudflareTurnKeyId ? 'cloudflare' : env.turnUrls.length > 0 ? 'coturn' : 'stun-only',
  })
})

let shuttingDown = false

/**
 * Hand the room back before this process goes.
 *
 * The old shutdown waited on `httpServer.close()`, which waits for every connection to
 * end — and a WebSocket held open by someone sitting in a booth never ends on its own.
 * With the platform's drain window it got killed mid-wait, so none of this ran.
 *
 * The order matters. Stop being routed to, then close the sockets **in batches with
 * jitter** so the replacement doesn't take every reconnect handshake in the same
 * millisecond, then release this node's claim on its seats. The disconnect handler sees
 * `draining` and deliberately does not `leave` (see `lifecycle.ts`): these clients are
 * coming back to the new instance to reclaim exactly the seats they hold now.
 */
function shutdown(signal: string): void {
  if (shuttingDown) return
  shuttingDown = true
  beginDraining() // `/healthz` starts answering 503 immediately
  logger.info('server.shutdown', { signal, nodeId })

  // Not awaited: its callback fires once the sockets below are gone.
  httpServer.close()
  stopExpiryPoller()
  if (heartbeat) clearInterval(heartbeat)
  clearInterval(sweeper)

  void (async () => {
    try {
      // Close the **transport**, not the namespace.
      //
      // `socket.disconnect()` hands the client the reason `io server disconnect`, which
      // socket.io treats as deliberate: the client does not reconnect on its own, and
      // `useRoom` explicitly agrees with it (a server kick is not a dropped connection).
      // A drain is the opposite of a kick — everyone should come straight back — so the
      // connection is dropped underneath instead, which reads as `transport close` and
      // reconnects automatically, exactly like a flaky network.
      //
      // Only local sockets: these are the ones this process is responsible for, and the
      // replacement keeps serving its own.
      const sockets = [...io.sockets.sockets.values()]
      const spacing = DRAIN_WINDOW_MS / Math.max(1, Math.ceil(sockets.length / 25))
      for (let i = 0; i < sockets.length; i++) {
        sockets[i]?.conn.close()
        if ((i + 1) % 25 === 0) {
          await new Promise((resolve) => setTimeout(resolve, spacing + Math.random() * 100))
        }
      }
      logger.info('server.drained', { sockets: sockets.length })

      // Drop the heartbeat rather than leaving the sweeper to wait out its TTL: a seat
      // whose owner never returns is then freed a full TTL sooner.
      await redisRoomStore?.clearHeartbeat()
      await closeRedis()
    } catch (err) {
      logger.error('server.drain.failed', { err: err instanceof Error ? err.message : String(err) })
    } finally {
      process.exit(0)
    }
  })()

  // If any of that stalls, leave anyway. Non-zero so an unfinished drain is visible in
  // the logs rather than looking like a clean stop.
  setTimeout(() => process.exit(1), DRAIN_HARD_STOP_MS).unref()
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
})
