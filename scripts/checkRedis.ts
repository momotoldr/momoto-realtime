/**
 * Verify this service can actually use Redis, and say precisely what's wrong when it
 * can't.
 *
 *   npm run check:redis                  # against REDIS_URL from .env / .env.local
 *   railway run npm run check:redis      # against the real thing, from inside the network
 *
 * **Run it from the service's own environment** when checking a deployed Redis: Railway's
 * Redis listens on the private network (`redis.railway.internal`), which does not resolve
 * from a laptop. A laptop run against a local Redis still proves the code path.
 *
 * It answers four questions, in the order they can break:
 *   1. Is a connection possible at all (DNS, IPv6, auth)?
 *   2. Do ordinary commands round-trip?
 *   3. Is `EVAL` allowed? Every room mutation is a Lua script (`PLAN-redis.md` §2b), so a
 *      Redis that refuses scripts is useless to us even though it answers `PING`.
 *   4. Can the Socket.io Streams adapter carry a packet between two servers? That is the
 *      part a deploy depends on: during the overlap window the host may sit on the old
 *      instance and the guest on the new one.
 */
import { createAdapter } from '@socket.io/redis-streams-adapter'
import { Server } from 'socket.io'

import { env } from '../src/config/env.js'
import { closeRedis, getRedis, redisEnabled, selectedRoomStore } from '../src/lib/redis.js'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const ok = (msg: string): void => console.log(`${GREEN}✓${RESET} ${msg}`)
const bad = (msg: string): void => console.log(`${RED}✗${RESET} ${msg}`)
const warn = (msg: string): void => console.log(`${YELLOW}!${RESET} ${msg}`)
const hint = (msg: string): void => console.log(`  ${DIM}${msg}${RESET}`)

/** Host and port only — the URL carries a password. */
function safeTarget(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port || '6379'}${u.password ? ' (with password)' : ' (no password)'}`
  } catch {
    return '(unparseable REDIS_URL)'
  }
}

/** Names the actual problem rather than echoing a stack trace. */
function explain(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  const code = (err as NodeJS.ErrnoException | undefined)?.code

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    bad(`Hostname does not resolve (${code}).`)
    hint('From a laptop this is expected for a *.railway.internal address — that name')
    hint('only exists inside the private network. Use `railway run` instead.')
    hint('From inside Railway it usually means the service name in REDIS_URL is wrong.')
    return
  }
  if (code === 'ECONNREFUSED') {
    bad('Connection refused — something resolved, nothing is listening there.')
    hint('Locally: is Redis running? `redis-server` or `docker run -p 6379:6379 redis`.')
    return
  }
  if (message.includes('WRONGPASS') || message.includes('NOAUTH')) {
    bad('Authentication failed.')
    hint('REDIS_URL is missing or carrying the wrong password.')
    return
  }
  bad(`Redis error: ${message}`)
}

async function main(): Promise<number> {
  console.log('')
  console.log('Redis check')
  console.log('───────────')

  if (!redisEnabled) {
    warn('REDIS_URL is not set.')
    hint(`Room state would use the in-memory store (selected: ${selectedRoomStore()}).`)
    hint('That is correct for local development — a single process, no deploy safety.')
    hint('In production it means every deploy still ends every live room.')
    console.log('')
    return 0
  }

  ok(`REDIS_URL → ${safeTarget(env.redisUrl as string)}`)
  hint(`Room store this config selects: ${selectedRoomStore()}`)

  const redis = getRedis()

  // 1. Connectivity.
  try {
    const started = Date.now()
    await redis.ping()
    ok(`PING answered in ${Date.now() - started}ms`)
  } catch (err) {
    explain(err)
    return 1
  }

  // Version and eviction policy. A Redis configured to evict keys under memory pressure
  // would silently drop live rooms, which looks exactly like the bug this whole plan
  // exists to fix — so it is worth knowing before it happens.
  try {
    const info = await redis.info('server')
    const version = /redis_version:([^\r\n]+)/.exec(info)?.[1] ?? 'unknown'
    ok(`Server version ${version}`)
    const policy = await redis.config('GET', 'maxmemory-policy')
    const value = Array.isArray(policy) ? String(policy[1]) : 'unknown'
    if (value === 'noeviction') ok('Eviction policy is noeviction — room keys cannot be evicted')
    else warn(`Eviction policy is ${value} — under memory pressure live rooms could be evicted`)
  } catch {
    hint('Server INFO/CONFIG not permitted — skipped (managed Redis often restricts these).')
  }

  // 2. Ordinary commands round-trip, including the TTL every room key relies on.
  const probe = `mm:v1:check:${Date.now()}`
  try {
    await redis.set(probe, 'ok', 'PX', 5_000)
    const read = await redis.get(probe)
    const ttl = await redis.pttl(probe)
    await redis.del(probe)
    if (read !== 'ok') {
      bad(`Round trip returned ${String(read)} instead of "ok".`)
      return 1
    }
    ok(`SET/GET/DEL round-trips, TTL honoured (${ttl}ms left)`)
  } catch (err) {
    explain(err)
    return 1
  }

  // 3. Lua. Every room mutation is a script, so this is not optional.
  try {
    const sum = await redis.eval('return tonumber(ARGV[1]) + tonumber(ARGV[2])', 0, '2', '3')
    if (sum !== 5) {
      bad(`EVAL returned ${String(sum)} instead of 5.`)
      return 1
    }
    ok('EVAL works — Lua room mutations are supported here')
  } catch (err) {
    bad('EVAL is not permitted on this Redis.')
    hint('Room mutations are Lua scripts; without EVAL the Redis room store cannot work.')
    explain(err)
    return 1
  }

  // 4. The Streams adapter, end to end: two servers, one stream, a packet across.
  //    `serverSideEmit` is the same path a cross-instance broadcast takes, so if this
  //    arrives, a countdown started on one instance reaches a guest on the other.
  const alpha = new Server({ adapter: createAdapter(redis) })
  const beta = new Server({ adapter: createAdapter(redis) })
  try {
    const token = `probe-${Date.now()}`
    const delivered = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('no packet arrived within 5s')),
        5_000,
      ).unref()
      beta.on('mm:check' as never, ((value: string) => {
        clearTimeout(timer)
        resolve(value)
      }) as never)
    })

    // Both adapters have to be reading the stream before the packet is written,
    // otherwise it is published into a stream nobody is following yet.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const started = Date.now()
    alpha.serverSideEmit('mm:check' as never, token as never)

    const received = await delivered
    if (received !== token) {
      bad(`Adapter delivered "${received}" instead of "${token}".`)
      return 1
    }
    ok(`Streams adapter carried a packet between two servers in ${Date.now() - started}ms`)
  } catch (err) {
    bad('The Streams adapter could not carry a packet between two servers.')
    hint('Ordinary commands work, so this is about XADD/XREAD rather than connectivity.')
    hint('A managed Redis with streams disabled, or a very old server (<5.0), does this.')
    explain(err)
    return 1
  } finally {
    // Not `Server.close()`: that closes `this.engine`, which only exists once a Server
    // has been attached to an HTTP server, and these two never were. Closing the
    // namespace adapters is what actually stops the stream readers.
    await Promise.allSettled([alpha.of('/').adapter.close?.(), beta.of('/').adapter.close?.()])
  }

  console.log('')
  ok('Redis is ready for the room store and the Socket.io adapter.')
  console.log('')
  return 0
}

main()
  .then(async (code) => {
    await closeRedis()
    process.exit(code)
  })
  .catch(async (err: unknown) => {
    bad(`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`)
    await closeRedis()
    process.exit(1)
  })
