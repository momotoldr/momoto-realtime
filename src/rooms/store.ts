import { randomUUID } from 'node:crypto'

import { logger } from '../lib/logger.js'
import { getRedis, redisEnabled } from '../lib/redis.js'
import { RedisRoomStore } from './redisRoomStore.js'
import { MemoryRoomStore, type RoomStore } from './roomStore.js'

/**
 * Which room store this process runs, decided once at boot.
 *
 * Redis when `REDIS_URL` is set, memory otherwise. The choice is made **here and only
 * here**, and never revisited: falling back to memory because Redis went away would
 * leave two instances holding different truths about the same room, which is worse than
 * being unavailable. A Redis outage fails room operations loudly instead (see
 * `lib/redis.ts`).
 *
 * The selection lives in its own module so the interface and the in-memory
 * implementation stay free of any Redis import.
 */

/**
 * This process's identity, minted fresh at boot.
 *
 * It is what makes a seat traceable to the process that claimed it: `join` stamps it on
 * the member, a heartbeat key keeps it alive, and when that key disappears the sweeper
 * knows those seats belong to a process that is gone. Deliberately not stable across
 * restarts — a new process is a new node, even on the same machine.
 */
export const nodeId = randomUUID().slice(0, 8)

/** The Redis-backed store, when that is what is running — for the heartbeat wiring. */
export const redisRoomStore = redisEnabled ? new RedisRoomStore(getRedis(), nodeId) : null

export const roomStore: RoomStore = redisRoomStore ?? new MemoryRoomStore()

export const roomStoreKind: 'memory' | 'redis' = redisRoomStore ? 'redis' : 'memory'

logger.info('room.store.selected', { kind: roomStoreKind, nodeId })
