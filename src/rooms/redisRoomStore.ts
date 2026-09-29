import type { Redis } from 'ioredis'

import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { generateRoomCode } from './roomCode.js'
import {
  ENDED_TTL_MS,
  GHOST_GRACE_MS,
  RESERVATION_TTL_MS,
  WINDOW_TTL_GRACE_MS,
  type JoinResult,
  type ReapedMember,
  type RoomStatus,
  type RoomStore,
  type SweepResult,
} from './roomStore.js'

/**
 * Room state in Redis, so a room outlives the process that created it.
 *
 * The rules are the ones written on the `RoomStore` interface; this file is only about
 * making them hold when two processes (an old deployment and its replacement) are both
 * serving the same rooms.
 *
 * **Every mutation is a Lua script.** `join`, `leave`, `startWindow`, `createRoom` and
 * `endSession` are all read-modify-write, and two sockets racing for the last seat must
 * produce exactly one `joined` and one `full`. Lua is atomic in one round trip and holds
 * no connection state — unlike `WATCH`/`MULTI`, which is scoped to the *connection*, and
 * this process shares one connection across every concurrent handler, so interleaved
 * watches would silently cancel each other.
 *
 * `now` is passed in from Node rather than read with Redis's `TIME`, so every timestamp
 * in the system keeps coming from the same clock it does today.
 */

/** Prefix every key, so a future shape change can deploy beside this one. */
const K = {
  room: (code: string) => `mm:v1:room:${code}`,
  ended: (code: string) => `mm:v1:ended:${code}`,
  live: 'mm:v1:rooms:live',
  occupied: 'mm:v1:rooms:occupied',
  expiry: 'mm:v1:rooms:expiry',
  node: (id: string) => `mm:v1:node:${id}`,
  reaperLock: 'mm:v1:lock:reaper',
} as const

/** `mm:v1:node:` — the prefix Lua builds node keys with. Must match `K.node`. */
const NODE_PREFIX = 'mm:v1:node:'

/**
 * Lua has no `null`, and `cjson` turns `nil` fields into missing ones, so the two
 * nullable timestamps travel as `-1`. Converted at the boundary, never leaked upward.
 */
const NONE = -1

interface StoredMember {
  socketId: string
  clientId: string | null
  /** Which process this seat was claimed on — see `reapGhosts`. */
  nodeId: string
  /** When this member was first seen with a dead node, if ever. */
  ghostSince?: number
}

interface StoredRoom {
  members: StoredMember[]
  capacity: number
  createdAt: number
  reservedUntil: number
  endsAt: number
}

/**
 * Shared prelude for the mutation scripts: decode, and repair the one `cjson` wrinkle
 * that will otherwise bite. An empty Lua table encodes as `{}` (an object), so a room
 * that has just emptied comes back with `members` as an object rather than an array.
 * Every script normalises it on the way in, and Node normalises again on the way out.
 */
const LUA_HELPERS = `
local function load_room(key)
  local raw = redis.call('GET', key)
  if not raw then return nil end
  local room = cjson.decode(raw)
  if room.members == nil or room.members == cjson.null then room.members = {} end
  return room
end

local function member_ids(room)
  local ids = {}
  for i, m in ipairs(room.members) do ids[i] = m.socketId end
  return ids
end

-- The room key's lifetime says what the room is: a reservation expires on its own, an
-- occupied lobby must not, and a running window outlives its end by a grace period so a
-- straggler still finds it before the sweeper does.
local function set_ttl(key, room, now, window_grace)
  if room.endsAt ~= -1 then
    redis.call('PEXPIRE', key, (room.endsAt - now) + window_grace)
  elseif #room.members > 0 then
    redis.call('PERSIST', key)
  end
end

local function save(key, room, now, window_grace)
  redis.call('SET', key, cjson.encode(room))
  set_ttl(key, room, now, window_grace)
end
`

/** KEYS: room, ended, live · ARGV: code, json, now, reservationTtl */
const LUA_CREATE = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'PX', tonumber(ARGV[4]))
redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[1])
return 1
`

/** KEYS: room, ended, occupied · ARGV: code, socketId, clientId, nodeId, now, windowGrace */
const LUA_JOIN =
  LUA_HELPERS +
  `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return cjson.encode({ status = 'ended' })
end

local room = load_room(KEYS[1])
if not room then return cjson.encode({ status = 'not_found' }) end

local socket_id, client_id, node_id = ARGV[2], ARGV[3], ARGV[4]
local now, window_grace = tonumber(ARGV[5]), tonumber(ARGV[6])

-- Ordering is the contract: ended → not_found → reconnect → full → add. The reconnect
-- step runs before the capacity check, so a member returning to a full room reclaims
-- its own seat in place rather than being refused as a newcomer.
if client_id ~= '' then
  for _, m in ipairs(room.members) do
    if m.clientId == client_id then
      room.reservedUntil = -1
      m.ghostSince = nil
      if m.socketId == socket_id then
        save(KEYS[1], room, now, window_grace)
        return cjson.encode({ status = 'joined', members = member_ids(room) })
      end
      local replaced = m.socketId
      m.socketId = socket_id
      m.nodeId = node_id
      save(KEYS[1], room, now, window_grace)
      return cjson.encode({ status = 'joined', members = member_ids(room), replaced = replaced })
    end
  end
end

if #room.members >= room.capacity then return cjson.encode({ status = 'full' }) end

local entry = { socketId = socket_id, nodeId = node_id }
if client_id ~= '' then entry.clientId = client_id end
table.insert(room.members, entry)
room.reservedUntil = -1
redis.call('SADD', KEYS[3], ARGV[1])
save(KEYS[1], room, now, window_grace)
return cjson.encode({ status = 'joined', members = member_ids(room) })
`

/** KEYS: room, occupied · ARGV: code, socketId, now, reservationTtl, windowGrace */
const LUA_LEAVE =
  LUA_HELPERS +
  `
local room = load_room(KEYS[1])
if not room then return cjson.encode({ removed = false }) end

local socket_id = ARGV[2]
local now, reservation_ttl, window_grace = tonumber(ARGV[3]), tonumber(ARGV[4]), tonumber(ARGV[5])

local index = nil
for i, m in ipairs(room.members) do
  if m.socketId == socket_id then index = i break end
end
if not index then return cjson.encode({ removed = false }) end
table.remove(room.members, index)

if #room.members == 0 then
  redis.call('SREM', KEYS[2], ARGV[1])
  -- A running window keeps the room alive so a rejoin resumes the remaining time. A
  -- lobby that empties before the window is held briefly *reserved* instead, so a host
  -- who refreshed comes back to the same code.
  if room.endsAt == -1 then
    room.reservedUntil = now + reservation_ttl
    redis.call('SET', KEYS[1], cjson.encode(room))
    redis.call('PEXPIRE', KEYS[1], reservation_ttl)
    return cjson.encode({ removed = true, members = {} })
  end
end

save(KEYS[1], room, now, window_grace)
return cjson.encode({ removed = true, members = member_ids(room) })
`

/** KEYS: room, expiry · ARGV: code, durationMs, now, windowGrace */
const LUA_START_WINDOW =
  LUA_HELPERS +
  `
local room = load_room(KEYS[1])
if not room then return -1 end
if room.endsAt ~= -1 then return -1 end

-- The floor comes from the room's own size, never from the caller.
local floor = 2
if room.capacity > 2 then floor = 3 end
if #room.members < floor then return -1 end

local now, window_grace = tonumber(ARGV[3]), tonumber(ARGV[4])
room.endsAt = now + tonumber(ARGV[2])
redis.call('ZADD', KEYS[2], room.endsAt, ARGV[1])
save(KEYS[1], room, now, window_grace)
return room.endsAt
`

/** KEYS: room, ended, occupied, live, expiry · ARGV: code, now, endedTtl */
const LUA_END_SESSION = `
redis.call('SET', KEYS[2], ARGV[2], 'PX', tonumber(ARGV[3]))
redis.call('DEL', KEYS[1])
redis.call('SREM', KEYS[3], ARGV[1])
redis.call('ZREM', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[5], ARGV[1])
return 1
`

/**
 * KEYS: room, occupied · ARGV: code, now, grace, windowGrace
 *
 * Frees seats whose owning process is gone. It reads `mm:v1:node:*` keys that are not
 * in KEYS, which is safe here because this deployment talks to a single Redis, never a
 * cluster — a cluster would need the node ids passed in as arguments instead.
 */
const LUA_REAP =
  LUA_HELPERS +
  `
local room = load_room(KEYS[1])
if not room then return cjson.encode({ removed = {} }) end

local now, grace, window_grace = tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local removed, kept = {}, {}

for _, m in ipairs(room.members) do
  local alive = redis.call('EXISTS', '${NODE_PREFIX}' .. (m.nodeId or '')) == 1
  if alive then
    m.ghostSince = nil
    table.insert(kept, m)
  elseif m.ghostSince == nil then
    -- First sighting. The owner is almost always mid-reconnect, so start the clock
    -- rather than taking the seat away from someone who is coming straight back.
    m.ghostSince = now
    table.insert(kept, m)
  elseif (now - m.ghostSince) < grace then
    table.insert(kept, m)
  else
    table.insert(removed, m.socketId)
  end
end

if #removed == 0 then
  room.members = kept
  save(KEYS[1], room, now, window_grace)
  return cjson.encode({ removed = {} })
end

room.members = kept
if #kept == 0 then redis.call('SREM', KEYS[2], ARGV[1]) end
save(KEYS[1], room, now, window_grace)
return cjson.encode({ removed = removed, members = member_ids(room) })
`

/** The scripts, as ioredis attaches them to the client. */
interface RoomScripts {
  mmCreateRoom(
    room: string,
    ended: string,
    live: string,
    code: string,
    json: string,
    now: string,
    ttl: string,
  ): Promise<number>
  mmJoin(
    room: string,
    ended: string,
    occupied: string,
    code: string,
    socketId: string,
    clientId: string,
    nodeId: string,
    now: string,
    windowGrace: string,
  ): Promise<string>
  mmLeave(
    room: string,
    occupied: string,
    code: string,
    socketId: string,
    now: string,
    reservationTtl: string,
    windowGrace: string,
  ): Promise<string>
  mmStartWindow(
    room: string,
    expiry: string,
    code: string,
    durationMs: string,
    now: string,
    windowGrace: string,
  ): Promise<number>
  mmEndSession(
    room: string,
    ended: string,
    occupied: string,
    live: string,
    expiry: string,
    code: string,
    now: string,
    endedTtl: string,
  ): Promise<number>
  mmReap(
    room: string,
    occupied: string,
    code: string,
    now: string,
    grace: string,
    windowGrace: string,
  ): Promise<string>
}

type ScriptedRedis = Redis & RoomScripts

function defineScripts(redis: Redis): ScriptedRedis {
  redis.defineCommand('mmCreateRoom', { numberOfKeys: 3, lua: LUA_CREATE })
  redis.defineCommand('mmJoin', { numberOfKeys: 3, lua: LUA_JOIN })
  redis.defineCommand('mmLeave', { numberOfKeys: 2, lua: LUA_LEAVE })
  redis.defineCommand('mmStartWindow', { numberOfKeys: 2, lua: LUA_START_WINDOW })
  redis.defineCommand('mmEndSession', { numberOfKeys: 5, lua: LUA_END_SESSION })
  redis.defineCommand('mmReap', { numberOfKeys: 2, lua: LUA_REAP })
  return redis as ScriptedRedis
}

/** `members` may arrive as `{}` from cjson when the array is empty. */
function memberIds(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : []
}

function parseRoom(raw: string | null): StoredRoom | null {
  if (!raw) return null
  const room = JSON.parse(raw) as StoredRoom
  if (!Array.isArray(room.members)) room.members = []
  return room
}

export class RedisRoomStore implements RoomStore {
  private readonly redis: ScriptedRedis

  constructor(
    redis: Redis,
    /** This process's id, stamped on every seat it claims. */
    private readonly nodeId: string,
  ) {
    this.redis = defineScripts(redis)
  }

  async createRoom(capacity: number = env.roomCapacityDefault): Promise<string> {
    const seats = Math.min(Math.max(Math.trunc(capacity), 2), env.roomCapacityMax)
    const now = Date.now()
    // Retry on collision exactly as the in-memory store's loop does — the script
    // refuses a code that is live or retired, so the check and the write are atomic.
    for (let attempt = 0; attempt < 12; attempt++) {
      const code = generateRoomCode()
      const room: StoredRoom = {
        members: [],
        capacity: seats,
        createdAt: now,
        reservedUntil: now + RESERVATION_TTL_MS,
        endsAt: NONE,
      }
      const created = await this.redis.mmCreateRoom(
        K.room(code),
        K.ended(code),
        K.live,
        code,
        JSON.stringify(room),
        String(now),
        String(RESERVATION_TTL_MS),
      )
      if (created === 1) return code
    }
    throw new Error('could not mint a free room code')
  }

  async isEnded(roomId: string): Promise<boolean> {
    return (await this.redis.exists(K.ended(roomId))) === 1
  }

  async getStatus(roomId: string): Promise<RoomStatus> {
    const [endedRaw, roomRaw] = await this.redis.mget(K.ended(roomId), K.room(roomId))
    if (endedRaw != null) return { status: 'ended', capacity: null, members: 0 }
    const room = parseRoom(roomRaw ?? null)
    if (!room) return { status: 'not_found', capacity: null, members: 0 }
    const shape = { capacity: room.capacity, members: room.members.length }
    return room.members.length >= room.capacity
      ? { status: 'full', ...shape }
      : { status: 'open', ...shape }
  }

  async getCapacity(roomId: string): Promise<number | null> {
    const room = parseRoom(await this.redis.get(K.room(roomId)))
    return room?.capacity ?? null
  }

  async getMembers(roomId: string): Promise<string[]> {
    const room = parseRoom(await this.redis.get(K.room(roomId)))
    return room ? room.members.map((m) => m.socketId) : []
  }

  async join(
    roomId: string,
    socketId: string,
    clientId: string | null = null,
  ): Promise<JoinResult> {
    const raw = await this.redis.mmJoin(
      K.room(roomId),
      K.ended(roomId),
      K.occupied,
      roomId,
      socketId,
      clientId ?? '',
      this.nodeId,
      String(Date.now()),
      String(WINDOW_TTL_GRACE_MS),
    )
    const result = JSON.parse(raw) as {
      status: JoinResult['status']
      members?: unknown
      replaced?: string
    }
    if (result.status !== 'joined') return { status: result.status } as JoinResult
    return result.replaced
      ? { status: 'joined', members: memberIds(result.members), replaced: result.replaced }
      : { status: 'joined', members: memberIds(result.members) }
  }

  async leave(roomId: string, socketId: string): Promise<{ members: string[] } | null> {
    const raw = await this.redis.mmLeave(
      K.room(roomId),
      K.occupied,
      roomId,
      socketId,
      String(Date.now()),
      String(RESERVATION_TTL_MS),
      String(WINDOW_TTL_GRACE_MS),
    )
    const result = JSON.parse(raw) as { removed: boolean; members?: unknown }
    return result.removed ? { members: memberIds(result.members) } : null
  }

  async startWindow(roomId: string, durationMs: number): Promise<number | null> {
    const endsAt = await this.redis.mmStartWindow(
      K.room(roomId),
      K.expiry,
      roomId,
      String(durationMs),
      String(Date.now()),
      String(WINDOW_TTL_GRACE_MS),
    )
    return endsAt === NONE ? null : endsAt
  }

  async getWindow(roomId: string): Promise<number | null> {
    const room = parseRoom(await this.redis.get(K.room(roomId)))
    if (!room || room.endsAt === NONE) return null
    return room.endsAt
  }

  async endSession(roomId: string): Promise<void> {
    await this.redis.mmEndSession(
      K.room(roomId),
      K.ended(roomId),
      K.occupied,
      K.live,
      K.expiry,
      roomId,
      String(Date.now()),
      String(ENDED_TTL_MS),
    )
  }

  /**
   * Claim the rooms whose window has elapsed.
   *
   * Every instance polls, so the `ZREM` is the claim: only the one whose removal
   * returned 1 acts on that room, and `session:expired` fires exactly once no matter
   * how many processes are running.
   */
  async claimExpired(now: number = Date.now(), limit = 50): Promise<string[]> {
    const due = await this.redis.zrangebyscore(
      K.expiry,
      '-inf',
      String(now),
      'LIMIT',
      '0',
      String(limit),
    )
    if (due.length === 0) return []
    const claimed: string[] = []
    for (const roomId of due) {
      if ((await this.redis.zrem(K.expiry, roomId)) === 1) claimed.push(roomId)
    }
    return claimed
  }

  /**
   * Housekeeping, run by one instance at a time.
   *
   * Key TTLs already retire reservations and ended codes, so this only has to do what
   * TTLs cannot: forget index entries whose room is gone, and free seats belonging to a
   * process that died without a chance to release them.
   */
  async sweep(now: number = Date.now()): Promise<SweepResult> {
    // A short lock, well under the 30s sweep interval: if a holder dies mid-sweep the
    // next one picks up rather than the work stopping forever.
    const acquired = await this.redis.set(K.reaperLock, this.nodeId, 'PX', String(25_000), 'NX')
    if (acquired !== 'OK') return { reaped: [] }

    const live = await this.redis.zrange(K.live, '0', '-1')
    if (live.length > 0) {
      const pipeline = this.redis.pipeline()
      for (const code of live) pipeline.exists(K.room(code))
      const results = await pipeline.exec()
      const gone = live.filter((_, i) => results?.[i]?.[1] === 0)
      if (gone.length > 0) await this.redis.zrem(K.live, ...gone)
    }

    const reaped: ReapedMember[] = []
    for (const roomId of await this.redis.smembers(K.occupied)) {
      const raw = await this.redis.mmReap(
        K.room(roomId),
        K.occupied,
        roomId,
        String(now),
        String(GHOST_GRACE_MS),
        String(WINDOW_TTL_GRACE_MS),
      )
      const result = JSON.parse(raw) as { removed: unknown; members?: unknown }
      const removed = memberIds(result.removed)
      if (removed.length === 0) continue
      const members = memberIds(result.members)
      for (const socketId of removed) {
        logger.info('room.ghost.reaped', { roomId, socketId })
        reaped.push({ roomId, socketId, members })
      }
    }
    return { reaped }
  }

  async activeCount(): Promise<number> {
    return this.redis.zcard(K.live)
  }

  async occupiedCount(): Promise<number> {
    return this.redis.scard(K.occupied)
  }

  async atCapacity(): Promise<boolean> {
    return (await this.redis.zcard(K.live)) >= env.roomsMaxActive
  }

  /** Publish this process's heartbeat; a seat outlives its node only by this TTL. */
  async heartbeat(ttlMs: number): Promise<void> {
    await this.redis.set(K.node(this.nodeId), '1', 'PX', ttlMs)
  }

  /** Drop the heartbeat on the way out, so nothing waits on a TTL to learn we are gone. */
  async clearHeartbeat(): Promise<void> {
    await this.redis.del(K.node(this.nodeId))
  }
}
