import { Router } from 'express'

import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import { roomStore } from '../../rooms/roomStore.js'

export const roomsRouter = Router()

/**
 * Rooms are open: unauthenticated users can create and join a date room so they can try
 * the booth before signing up (the socket handshake likewise accepts anonymous
 * connections). A room is just an ephemeral, code-keyed session of 2 to
 * `ROOM_CAPACITY_MAX` seats — the code is the access control. No route here reads an
 * account, so the limits below key on the caller IP alone. (Solo mode never reaches here:
 * it keeps its own local code and stays offline.)
 */

/**
 * Per-caller cap on room-code minting (Phase 5) — a burst of `POST /rooms` from one
 * client would otherwise churn codes. 30 / minute is far above any real "create a room"
 * cadence. Keyed on the caller IP.
 */
const createLimiter = new RateLimiter(30, 60_000)

/** Per-caller cap on the read-only pre-join lookup — cheap, but bound enumeration. */
const lookupLimiter = new RateLimiter(60, 60_000)

/** Reclaim expired HTTP rate windows (wired into the periodic sweep). */
export function sweepRoomCreateLimits(now: number = Date.now()): number {
  return createLimiter.sweep(now) + lookupLimiter.sweep(now)
}

/**
 * Mint a fresh, unique room code for the FE's "Create a room" (date and group modes).
 * The server guarantees the code is neither active nor ended — replacing the FE's
 * client-side `Math.random()`. Solo mode keeps its own local code (stays offline).
 *
 * `capacity` is optional and defaults to two. An out-of-range request is **rejected,
 * not clamped**: a client that asked for four seats and silently received two would
 * open a group booth on a room whose third person is refused at the join — the failure
 * would surface minutes later, to the wrong person, as "room full". A 400 here surfaces
 * it immediately, to the person who pressed the button. This is also what a frontend
 * with group mode enabled meets when the server has not raised `ROOM_CAPACITY_MAX`.
 */
roomsRouter.post('/', (req, res) => {
  const key = req.ip ?? 'unknown'
  if (!createLimiter.allow(key)) {
    logger.warn('room.create.ratelimited', { ip: req.ip })
    res.status(429).json({ error: 'too_many_requests' })
    return
  }

  const requested: unknown = (req.body as { capacity?: unknown } | undefined)?.capacity
  if (
    requested !== undefined &&
    (typeof requested !== 'number' ||
      !Number.isInteger(requested) ||
      requested < 2 ||
      requested > env.roomCapacityMax)
  ) {
    logger.warn('room.create.invalid_capacity', { ip: req.ip, requested })
    res.status(400).json({ error: 'invalid_capacity', maxCapacity: env.roomCapacityMax })
    return
  }

  // Checked after validation and before minting: a refused request must not consume a
  // code, and the sweeper runs on its own schedule, so a caller that retries in a minute
  // may well get in. 503 rather than 429 — nothing is wrong with *this* client's rate,
  // the booth is simply full, and `Retry-After` says so in the way a proxy understands.
  if (roomStore.atCapacity()) {
    logger.warn('room.create.atCapacity', { active: roomStore.activeCount() })
    res.setHeader('Retry-After', '60')
    res.status(503).json({ error: 'booth_busy' })
    return
  }

  const roomId = roomStore.createRoom(requested)
  logger.info('room.created', { roomId, capacity: requested ?? env.roomCapacityDefault })
  res.status(201).json({ roomId })
})

/**
 * Read-only pre-join check for the FE's "join by code" form. Returns the code's
 * joinability so a typo (or a never-minted code) is caught with a clear message
 * instead of the socket `room:join` silently spawning a lonely single-member room.
 * The socket flow still backstops full/ended at actual join time.
 *
 * `capacity` and `members` ride along (both `null`/`0` for a code with no live room).
 * The joiner needs the seat count *before* entering to open the booth in the right
 * mode; `status` alone is unchanged, so an older client reading only that keeps working.
 */
roomsRouter.get('/:id', (req, res) => {
  const key = req.ip ?? 'unknown'
  if (!lookupLimiter.allow(key)) {
    logger.warn('room.lookup.ratelimited', { ip: req.ip })
    res.status(429).json({ error: 'too_many_requests' })
    return
  }
  res.json(roomStore.getStatus(req.params.id))
})
