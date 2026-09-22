/**
 * The one Redis connection this service owns.
 *
 * Redis exists here for a single reason: **a redeploy must not end a live booth.** Room
 * state (`rooms/roomStore.ts`) and the session expiry timers live in process memory, so
 * today the process dying takes every room with it. Moving that state here is what lets
 * a reconnecting client land on a brand-new process and find its room still standing.
 * Scaling to N instances falls out of the same change, but it is not the goal.
 *
 * **Redis becomes a single point of failure, deliberately.** The trade is honest: a
 * Redis outage makes rooms unavailable, which is exactly today's behaviour on every
 * deploy — except restarts are rare and deploys are not. So the rule is **fail closed
 * and loud**: room operations reject, the error is logged, and the client sees what it
 * already sees during an outage (reconnect loader, then `unknown`). There is no runtime
 * fallback to the in-memory store, and there must never be one: two processes silently
 * holding different truths is worse than being down.
 *
 * `MemoryRoomStore` is still selected at *boot* when `REDIS_URL` is unset — that is
 * local development, not a failover. See `selectedRoomStore`.
 */
import { Redis } from 'ioredis'

import { env } from '../config/env.js'
import { logger } from './logger.js'

/** Whether this process was configured to use Redis at all. Decided once, at boot. */
export const redisEnabled = env.redisUrl !== null

/**
 * Which room store the current config selects — the boot-time decision, in one place,
 * so the store factory and `check:redis` can never disagree about it.
 */
export function selectedRoomStore(): 'redis' | 'memory' {
  return redisEnabled ? 'redis' : 'memory'
}

let client: Redis | null = null

/**
 * True once the connection has been established at least once.
 *
 * This is for `/healthz`, and the asymmetry is the point: a deployment that has never
 * reached Redis must **not** go Active (it would serve rooms it cannot store), but a
 * blip *after* boot must not flip the healthcheck either — otherwise the platform
 * restarts healthy instances in a loop for the duration of a Redis hiccup, turning a
 * two-second stall into an outage.
 */
let connectedOnce = false

export function redisHasConnected(): boolean {
  return connectedOnce
}

/** Live connection state, for logs and `check:redis` — not for the healthcheck. */
export function redisIsReady(): boolean {
  return client?.status === 'ready'
}

/**
 * The shared connection, created on first use.
 *
 * One connection for the whole process: room mutations are Lua scripts (atomic in a
 * single round trip), so nothing here needs a connection of its own. The Socket.io
 * Streams adapter is handed this same client and duplicates it internally for its
 * blocking `XREAD`s, so those never stall an app command.
 *
 * Throws when `REDIS_URL` is unset. Callers are expected to have branched on
 * `redisEnabled` at boot; reaching here without it is a wiring bug, not a runtime
 * condition to recover from.
 */
export function getRedis(): Redis {
  if (client) return client
  if (env.redisUrl === null) {
    throw new Error('getRedis() called with no REDIS_URL — check redisEnabled at boot')
  }

  client = new Redis(env.redisUrl, {
    // Resolve over IPv6 as well as IPv4. Railway's private network (`*.railway.internal`)
    // is IPv6-only, and the default IPv4-only lookup fails there with ENOTFOUND — the
    // same class of gotcha that made `momoto-notify` bind `::`.
    family: 0,
    // Bounded, not infinite. A command issued while Redis is unreachable should fail in
    // a couple of seconds so the handler can answer the client, rather than hanging a
    // socket event forever waiting for a service that isn't coming back.
    maxRetriesPerRequest: 2,
    // Cap the reconnect backoff so a long outage still recovers promptly once Redis
    // returns, instead of sitting out an ever-growing delay.
    retryStrategy: (times) => Math.min(times * 200, 2_000),
    // No `keyPrefix`: every key is written with its `mm:v1:` prefix explicitly, because
    // ioredis does not apply the prefix to `KEYS[]` inside Lua scripts. One prefix
    // applied in two different ways is a bug waiting for the first script that mixes them.
  })

  client.on('connect', () => logger.info('redis.connect'))
  client.on('ready', () => {
    connectedOnce = true
    logger.info('redis.ready')
  })
  // Errors arrive here as well as on the failing command. ioredis emits them on the
  // client, and an `error` event with no listener is an uncaught exception that would
  // end the process — so this handler is load-bearing, not just observability.
  client.on('error', (err: Error) => logger.error('redis.error', { err: err.message }))
  client.on('reconnecting', (delay: number) => logger.warn('redis.reconnecting', { delay }))
  client.on('end', () => logger.warn('redis.end'))

  return client
}

/**
 * Close the connection on shutdown. `quit()` finishes in-flight commands first; a
 * connection that is already gone is not an error worth failing a shutdown over.
 */
export async function closeRedis(): Promise<void> {
  if (!client) return
  try {
    await client.quit()
  } catch {
    client.disconnect()
  }
  client = null
}
