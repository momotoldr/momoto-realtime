import { env } from '../config/env.js'
import { generateRoomCode } from './roomCode.js'

interface RoomMember {
  socketId: string
  /**
   * Stable per-tab id from the socket handshake (`auth.clientId`), or `null` from a
   * client that didn't send one. It is what lets a reconnecting client be recognised
   * as *itself* rather than as a third person arriving — see `join`.
   */
  clientId: string | null
}

interface RoomState {
  /** Members in join order — the first member is the host. */
  members: RoomMember[]
  /**
   * Seats this room was minted with, fixed for its lifetime. A property of the room
   * rather than a server-wide setting: Solo and Date rooms seat 2 and a group room
   * seats up to `env.roomCapacityMax`, and they coexist on one server.
   */
  capacity: number
  createdAt: number
  /**
   * Set when a code is minted via `POST /rooms` but not yet joined; the room is
   * swept if nobody joins before this instant. `null` once the room is active.
   */
  reservedUntil: number | null
  /**
   * Server timestamp (ms) when the timed session ends, or `null` before it starts.
   * The server is the single authority for this window (Phase 4).
   */
  endsAt: number | null
}

export type JoinResult =
  | { status: 'ended' }
  | { status: 'full' }
  | { status: 'not_found' }
  | {
      status: 'joined'
      members: string[]
      /**
       * Set when this join took over an existing member's slot (the same client
       * reconnecting): the socket id it replaced, which the caller drops.
       */
      replaced?: string
    }

/** A seat freed by the sweeper because the process holding it is gone. */
export interface ReapedMember {
  roomId: string
  socketId: string
  /** The room's remaining members, for the `room:members` that follows. */
  members: string[]
}

export interface SweepResult {
  /** Seats freed this pass. The caller announces them exactly like a normal leave. */
  reaped: ReapedMember[]
}

export interface RoomStatus {
  status: 'open' | 'full' | 'ended' | 'not_found'
  capacity: number | null
  members: number
}

/** How long a minted-but-unjoined room code stays reserved before GC. */
export const RESERVATION_TTL_MS = 60_000

/**
 * How long a room key outlives its own window in Redis.
 *
 * The window ending is not the room ending: `session:expired` still has to be delivered
 * and the room retired, and a straggler arriving a moment late should meet the closed
 * screen rather than a code that evaporated. A minute is far more than either needs.
 */
export const WINDOW_TTL_GRACE_MS = 60_000

/**
 * How long a seat is held for a member whose process has died before it is freed.
 *
 * The owner is almost always mid-reconnect — measured at well under a second on staging
 * — and reclaiming their own seat is the normal path. This grace only covers the client
 * that never comes back at all: the tab closed during a deploy, or a hard crash. Too
 * short and a slow network costs somebody their seat; too long and their friend stares
 * at a frozen tile.
 */
export const GHOST_GRACE_MS = 30_000

/**
 * Members that must be present before a session window may open, by room size.
 *
 * A two-seat room needs both people: one person is a selfie, not a booth. A **group
 * room needs three** — the mode exists for more than a pair, and starting one with two
 * present produces a date strip in a room everybody joined for something else. It is
 * still a floor rather than the room's own capacity, so a group of three whose fourth
 * never turns up is not stranded waiting for them.
 */
export const GROUP_MIN_MEMBERS = 3

export function minSessionMembers(capacity: number): number {
  return capacity > 2 ? GROUP_MIN_MEMBERS : 2
}

/**
 * How long an ended room code is remembered (to refuse rejoins with `room:ended`)
 * before it's forgotten. Long enough that stragglers still see the closed screen,
 * short enough that the set can't grow without bound. After this, the code is free
 * to be minted again.
 */
export const ENDED_TTL_MS = 10 * 60_000

/** The room's socket ids in join order — the shape the wire contract speaks. */
function socketIds(room: RoomState): string[] {
  return room.members.map((m) => m.socketId)
}

/**
 * The room registry: single source of truth for membership, host order and the session
 * window. Socket.io's own rooms are kept in sync by the handlers, for broadcasting.
 *
 * **This interface is the specification, not a type.** Two implementations answer to
 * it — `MemoryRoomStore` below, and the Redis-backed one that lets room state outlive
 * the process — and the rules written on each method are what both of them must do.
 * Where a rule looks arbitrary it is load-bearing; the reasoning is in the comment.
 *
 * Every method is async because the Redis implementation cannot be anything else. The
 * in-memory one answers immediately and simply satisfies the shape.
 */
export interface RoomStore {
  /**
   * Mint a fresh code guaranteed to be neither an active nor an ended room, and
   * reserve it briefly so it stays authoritative until the creator joins.
   *
   * `capacity` is clamped to `2..env.roomCapacityMax` as a backstop; the HTTP route
   * *rejects* an out-of-range request rather than reaching here with one, because a
   * client that asked for four seats and silently got two would open a group booth in
   * a room whose third person is refused at the join.
   */
  createRoom(capacity?: number): Promise<string>

  /** Whether this code has been retired. A retired code must never reopen. */
  isEnded(roomId: string): Promise<boolean>

  /**
   * Joinability of a code, for a pre-join check (`GET /rooms/:id`). Mirrors the
   * `join()` ordering (ended → full → open) plus `not_found` for a code that was
   * never minted — the case that lets a typo'd code silently spawn a lonely room if
   * unchecked. A reserved-but-unjoined code counts as `open` (the host is arriving).
   *
   * `capacity` rides along because the joiner needs it *before* entering: a 4-seat code
   * has to open the booth in group mode, and a client that guessed 2 would shoot
   * two-camera cuts while everyone else in the room shot four. It is `null` for a code
   * with no live room behind it. `members` is the current occupancy — no more than
   * `full`/`open` already tells a caller with the capacity in hand.
   */
  getStatus(roomId: string): Promise<RoomStatus>

  /** This room's seat count, or `null` if there's no live room on that code. */
  getCapacity(roomId: string): Promise<number | null>

  /** The room's socket ids in join order (`[0]` is the host), or `[]` if unknown. */
  getMembers(roomId: string): Promise<string[]>

  /**
   * Attempt to add a socket to a room.
   * Order: ended → not_found → **reconnect** → full → add.
   *
   * The `clientId` step reclaims a seat for a client that is already in this room.
   * When a connection drops abruptly the server keeps the dead socket until its ping
   * times out (~20s), while the client is back in about a second — long enough to be
   * refused as a newcomer and lose a session it never really left. Matching the
   * handshake id hands that client its own seat back *in place*, so join order (and
   * therefore who is host) is unchanged.
   *
   * **It runs before the capacity check, not only when the room is full.** It used to
   * be gated on fullness, to guard against a client id that was not as unique as it
   * looked: the id lived in sessionStorage, which a browser copies into a duplicated
   * tab, so two live tabs could share one id and evict each other. That hazard is gone
   * — the frontend now mints the id per page load and never stores it (see
   * `momoto-fe/src/utils/socket.ts`), so one id means one live connection. Keeping the
   * gate would break rooms that seat more than two: a member reconnecting into a
   * 3-of-4 room is not refused, so they would take a *fresh* seat beside their own
   * dead socket — the room shows a frozen tile, the seat count is wrong, and if they
   * were the host they silently stop being it.
   *
   * Concurrency is the implementation's problem, not the caller's: two sockets racing
   * for the last seat must produce exactly one `joined` and one `full`.
   */
  join(roomId: string, socketId: string, clientId?: string | null): Promise<JoinResult>

  /**
   * Remove a socket from its room. Returns the remaining members, or `null` if the
   * socket wasn't in that room — which is also how a *superseded* socket reports
   * itself: once a reconnect has taken over its slot (see `join`), its late
   * disconnect must not be mistaken for the member leaving.
   */
  leave(roomId: string, socketId: string): Promise<{ members: string[] } | null>

  /**
   * Start the session window if enough members are present and none is running yet.
   * Returns the new `endsAt`, or `null` if it wasn't started (already running, or too
   * few members).
   *
   * The floor comes from the room's own size (`minSessionMembers`), not its capacity: a
   * 4-seat room whose fourth person never arrives must still be able to run, but a group
   * room does need three. Deriving it here rather than trusting the caller means no
   * future path can open a window under-strength. *Whether* to start at the floor is
   * still the caller's policy — a 2-seat room starts automatically when it fills, a
   * larger one waits for the host to say so (see `sessionManager`).
   */
  startWindow(roomId: string, durationMs: number): Promise<number | null>

  /** The room's active window end (server ms), or `null` if none/unknown. */
  getWindow(roomId: string): Promise<number | null>

  /** Retire a room: mark its code dead (timestamped) and drop its live state. */
  endSession(roomId: string): Promise<void>

  /**
   * Claim the rooms whose session window has elapsed, and return their codes.
   *
   * **Claiming is the point.** The caller announces `session:expired` and retires the
   * room, and that must happen exactly once even when several processes are polling the
   * same state — so a room may be returned to one caller only, ever.
   *
   * Polling rather than a timer per room is what lets the window survive the process
   * that opened it: a `setTimeout` in a process that is being replaced never fires, and
   * the room would run forever. Clients count down locally from `endsAt` and never wait
   * on this, so a few hundred milliseconds of slack costs nothing — the push only
   * exists to kick a backgrounded tab.
   */
  claimExpired(now?: number, limit?: number): Promise<string[]>

  /**
   * Periodic maintenance, called from the server's sweeper. What it reclaims is the
   * implementation's business — expired reservations and ended codes here, orphaned
   * index entries and seats belonging to dead processes in the Redis one — but it must
   * be safe to call on a schedule and must never throw at the caller.
   */
  sweep(now?: number): Promise<SweepResult>

  /**
   * Live rooms right now, including codes minted but not yet joined — a reservation
   * holds memory the same as an occupied room, and counting only occupied ones would
   * let a flood of unjoined codes past the cap that exists to bound exactly that.
   */
  activeCount(): Promise<number>

  /**
   * Rooms with somebody actually in them — what a "live session" means to a person.
   * Deliberately *not* `activeCount`: that one counts minted-but-unjoined reservations
   * too, because it guards memory, and a visitor-facing number inflated by codes nobody
   * opened would be a lie in the other direction.
   *
   * Solo booths never reach the server (they keep a local code and stay offline), so
   * they are invisible here — this counts shared sessions only.
   */
  occupiedCount(): Promise<number>

  /** True when a new room would exceed `ROOMS_MAX_ACTIVE`. Joins are never gated. */
  atCapacity(): Promise<boolean>
}

/**
 * Rooms held in this process's memory.
 *
 * Correct for a single instance, and the reason a deploy currently ends every live
 * room: this state dies with the process. It stays as the local-development store
 * (selected when `REDIS_URL` is unset) and as the reference implementation of the
 * rules above — **not** as a runtime fallback. Falling back to it while Redis is down
 * would leave two instances holding different truths about the same room, which is
 * worse than being unavailable.
 */
export class MemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, RoomState>()
  /** Ended room code → the instant it ended, so old entries can be swept. */
  private readonly endedRooms = new Map<string, number>()
  /**
   * Windows already handed to a caller by `claimExpired`. One process, but the poll
   * interval is shorter than the work that follows a claim, so without this a room
   * could be claimed twice before the first claim finished retiring it.
   */
  private readonly claimedExpiries = new Set<string>()

  createRoom(capacity: number = env.roomCapacityDefault): Promise<string> {
    let code = generateRoomCode()
    while (this.rooms.has(code) || this.endedRooms.has(code)) {
      code = generateRoomCode()
    }
    this.rooms.set(code, {
      members: [],
      capacity: Math.min(Math.max(Math.trunc(capacity), 2), env.roomCapacityMax),
      createdAt: Date.now(),
      reservedUntil: Date.now() + RESERVATION_TTL_MS,
      endsAt: null,
    })
    return Promise.resolve(code)
  }

  isEnded(roomId: string): Promise<boolean> {
    return Promise.resolve(this.endedRooms.has(roomId))
  }

  getStatus(roomId: string): Promise<RoomStatus> {
    if (this.endedRooms.has(roomId)) {
      return Promise.resolve({ status: 'ended', capacity: null, members: 0 })
    }
    const room = this.rooms.get(roomId)
    if (!room) return Promise.resolve({ status: 'not_found', capacity: null, members: 0 })
    const shape = { capacity: room.capacity, members: room.members.length }
    if (room.members.length >= room.capacity) {
      return Promise.resolve({ status: 'full', ...shape })
    }
    return Promise.resolve({ status: 'open', ...shape })
  }

  getCapacity(roomId: string): Promise<number | null> {
    return Promise.resolve(this.rooms.get(roomId)?.capacity ?? null)
  }

  getMembers(roomId: string): Promise<string[]> {
    const room = this.rooms.get(roomId)
    return Promise.resolve(room ? socketIds(room) : [])
  }

  join(roomId: string, socketId: string, clientId: string | null = null): Promise<JoinResult> {
    if (this.endedRooms.has(roomId)) return Promise.resolve({ status: 'ended' })

    const room = this.rooms.get(roomId)
    // A room only exists once minted via `POST /rooms` (or briefly re-reserved after
    // being emptied — see `leave`). An unknown code is a typo or a hand-typed URL like
    // `/room/adad`; refuse it rather than silently spawning a lonely one-member room.
    if (!room) return Promise.resolve({ status: 'not_found' })

    // Already in this room under this client id — that seat is still theirs.
    const returning = clientId ? room.members.find((m) => m.clientId === clientId) : undefined
    if (returning) {
      room.reservedUntil = null
      // The *same live socket* re-joining (a duplicate `room:join`, which the client
      // sends on every reconnect and the server can also see replayed). Nothing was
      // superseded, and reporting one would be worse than a no-op: the caller
      // disconnects whatever `replaced` names, which here is this very socket.
      if (returning.socketId === socketId) {
        return Promise.resolve({ status: 'joined', members: socketIds(room) })
      }
      const replaced = returning.socketId
      returning.socketId = socketId
      return Promise.resolve({ status: 'joined', members: socketIds(room), replaced })
    }

    if (room.members.length >= room.capacity) return Promise.resolve({ status: 'full' })

    room.members.push({ socketId, clientId })
    room.reservedUntil = null
    return Promise.resolve({ status: 'joined', members: socketIds(room) })
  }

  leave(roomId: string, socketId: string): Promise<{ members: string[] } | null> {
    const room = this.rooms.get(roomId)
    if (!room) return Promise.resolve(null)
    const before = room.members.length
    room.members = room.members.filter((m) => m.socketId !== socketId)
    if (room.members.length === before) return Promise.resolve(null)
    if (room.members.length === 0) {
      // An active session window keeps the room alive so a rejoin before expiry
      // resumes the remaining time; its expiry timer will retire it. A pre-window
      // lobby that empties (e.g. the host refreshed before the guest arrived) is kept
      // briefly *reserved* so an immediate rejoin resumes the same code — the sweeper
      // GCs it if it stays abandoned. This is what lets a host refresh survive now
      // that `join` no longer auto-creates unknown codes.
      if (room.endsAt === null) room.reservedUntil = Date.now() + RESERVATION_TTL_MS
      return Promise.resolve({ members: [] })
    }
    return Promise.resolve({ members: socketIds(room) })
  }

  startWindow(roomId: string, durationMs: number): Promise<number | null> {
    const room = this.rooms.get(roomId)
    if (!room || room.endsAt !== null) return Promise.resolve(null)
    if (room.members.length < minSessionMembers(room.capacity)) return Promise.resolve(null)
    room.endsAt = Date.now() + durationMs
    return Promise.resolve(room.endsAt)
  }

  getWindow(roomId: string): Promise<number | null> {
    return Promise.resolve(this.rooms.get(roomId)?.endsAt ?? null)
  }

  endSession(roomId: string): Promise<void> {
    this.endedRooms.set(roomId, Date.now())
    this.rooms.delete(roomId)
    this.claimedExpiries.delete(roomId)
    return Promise.resolve()
  }

  claimExpired(now: number = Date.now(), limit = 50): Promise<string[]> {
    const claimed: string[] = []
    for (const [code, room] of this.rooms) {
      if (claimed.length >= limit) break
      if (room.endsAt === null || room.endsAt > now) continue
      if (this.claimedExpiries.has(code)) continue
      this.claimedExpiries.add(code)
      claimed.push(code)
    }
    return Promise.resolve(claimed)
  }

  /**
   * Reclaim minted-but-unjoined reservations and ended codes past their TTL.
   *
   * Both maps would otherwise grow without bound. The Redis store needs neither pass —
   * key TTLs do this work there — which is why the interface exposes one `sweep` rather
   * than the two specific ones this class happens to need.
   */
  sweep(now: number = Date.now()): Promise<SweepResult> {
    for (const [code, room] of this.rooms) {
      if (room.members.length === 0 && room.reservedUntil !== null && room.reservedUntil <= now) {
        this.rooms.delete(code)
      }
    }
    for (const [code, endedAt] of this.endedRooms) {
      if (endedAt + ENDED_TTL_MS <= now) this.endedRooms.delete(code)
    }
    // Nothing to reap: a seat here cannot outlive the process that holds it, because
    // the process *is* the store.
    return Promise.resolve({ reaped: [] })
  }

  activeCount(): Promise<number> {
    return Promise.resolve(this.rooms.size)
  }

  occupiedCount(): Promise<number> {
    let total = 0
    for (const room of this.rooms.values()) {
      if (room.members.length > 0) total += 1
    }
    return Promise.resolve(total)
  }

  atCapacity(): Promise<boolean> {
    return Promise.resolve(this.rooms.size >= env.roomsMaxActive)
  }
}
