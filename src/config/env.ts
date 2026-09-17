// Side-effect import: reads .env.local + .env into process.env. Must stay above every
// other import here, and `src/index.ts` imports it first of all for the same reason.
import './loadEnv.js'

import { logger } from '../lib/logger.js'

export interface Env {
  port: number
  corsOrigins: string[]
  /** How many reverse-proxy hops sit in front of us (Express `trust proxy`). */
  trustProxy: number
  sessionDurationMs: number
  startDelayMs: number
  /**
   * Seats a room is minted with when the creator doesn't ask for a number — every
   * Solo and Date room. Effectively always 2.
   */
  roomCapacityDefault: number
  /**
   * The most seats any one room may be minted with (`POST /rooms { capacity }`).
   *
   * This is the **enforcement half of the frontend's group-mode flag**. `VITE_*` values
   * are inlined into the public bundle, so `VITE_GROUP_MODE_ENABLED` only governs what
   * the client offers; this is what actually admits or refuses the third person. It
   * defaults to 2, which makes a group room impossible on the server whatever a client
   * believes — raise it to 4 in the same change that turns the frontend flag on, or the
   * Group card mints rooms nobody can be the third person in.
   */
  roomCapacityMax: number
  /**
   * Ceiling on live rooms held in memory at once.
   *
   * A safety valve, not a capacity plan. Measured headroom is far higher — the server
   * carries only signalling, since media is peer-to-peer — but `rooms` is an in-memory
   * `Map` with no upper bound, and this process has no redundancy: an out-of-memory
   * kill would end *every* session in flight, not just the ones over the line. The cap
   * turns that into a polite refusal for new rooms while everyone already shooting
   * carries on.
   *
   * Only `POST /rooms` is gated. Joining an existing room is always allowed, so a cap
   * reached mid-session never separates a pair.
   */
  roomsMaxActive: number
  redisUrl: string | null
  stunUrls: string[]
  turnUrls: string[]
  turnStaticAuthSecret: string | null
  turnCredentialTtlSeconds: number
  /** Cloudflare Realtime TURN key id. When set with the API token, Cloudflare is the
   *  TURN provider (takes precedence over coturn). */
  cloudflareTurnKeyId: string | null
  /** Cloudflare Realtime TURN API token (secret). Mints short-lived credentials. */
  cloudflareTurnApiToken: string | null
  /**
   * Verifies the access tokens `momoto-core` signs. This service never mints one, so it
   * needs no TTLs — but the value must be **identical** to core's, or every signed-in
   * socket handshake is refused as `unauthorized`.
   */
  jwtSecret: string
}

const DEFAULT_DEV_ORIGIN = 'http://localhost:5173'
const DEFAULT_STUN_URL = 'stun:stun.l.google.com:19302'

function parseCsv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseOrigins(raw: string | undefined): string[] {
  const origins = parseCsv(raw)

  if (origins.length === 0) {
    // No allowlist configured — fall back to the Vite dev origin so local dev works,
    // but make it loud: production MUST set CORS_ORIGINS explicitly.
    logger.warn('config.cors.default', {
      msg: 'CORS_ORIGINS not set; defaulting to the dev origin. Set it in production.',
      origin: DEFAULT_DEV_ORIGIN,
    })
    return [DEFAULT_DEV_ORIGIN]
  }
  return origins
}

function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${name}: "${raw}" (expected a positive integer)`)
  }
  return n
}

function nonNegativeInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid ${name}: "${raw}" (expected a non-negative integer)`)
  }
  return n
}

/** Require a non-empty secret from the environment (never hardcode secrets). */
function requiredSecret(name: string, raw: string | undefined): string {
  const value = raw?.trim()
  if (!value) {
    throw new Error(`Missing ${name}: set it in the environment (see .env.example).`)
  }
  return value
}

/**
 * The most seats the booth is *built* for, regardless of configuration.
 *
 * Four is not an arbitrary default, it is the design: the cut compositor lays cameras
 * out in grids that stop making sense past a 2x2 (five would be six cells with a hole in
 * it), and the mesh sends one upload per other member, so an eight-seat room asks each
 * phone for seven. Raising `ROOM_CAPACITY_MAX` past this would mint rooms the app cannot
 * actually run, so it is refused at boot rather than discovered by whoever joins sixth.
 */
const ROOM_CAPACITY_CEILING = 4

// Room seat counts, resolved together so the pair can be checked against each other. A
// max below the default is not a smaller room, it is a contradiction: every mint would
// be clamped under the number the operator set as normal. Refuse to boot rather than
// serve rooms nobody asked for — this is config, so it fails loudly once at startup
// instead of quietly at every `POST /rooms`.
const roomCapacityDefault = positiveInt('ROOM_CAPACITY', process.env.ROOM_CAPACITY, 2)
const roomCapacityMax = positiveInt('ROOM_CAPACITY_MAX', process.env.ROOM_CAPACITY_MAX, 2)
if (roomCapacityMax > ROOM_CAPACITY_CEILING) {
  throw new Error(
    `Invalid ROOM_CAPACITY_MAX: ${roomCapacityMax} exceeds the ${ROOM_CAPACITY_CEILING} seats the booth supports.`,
  )
}
if (roomCapacityMax < roomCapacityDefault) {
  throw new Error(
    `Invalid ROOM_CAPACITY_MAX: ${roomCapacityMax} is below ROOM_CAPACITY (${roomCapacityDefault}).`,
  )
}
if (roomCapacityDefault < 2) {
  throw new Error(`Invalid ROOM_CAPACITY: ${roomCapacityDefault} (a room seats at least 2).`)
}

export const env: Env = {
  // 3003 locally: momoto-core keeps 3001 and momoto-notify holds 3002.
  port: positiveInt('PORT', process.env.PORT, 3003),
  corsOrigins: parseOrigins(process.env.CORS_ORIGINS),
  // Number of proxies between the client and us. Getting this wrong silently breaks
  // every per-IP rate limit: too low and `req.ip` is a proxy address shared by all
  // users (one bucket for everyone); too high and a client can spoof `X-Forwarded-For`
  // to mint unlimited buckets. One platform proxy = 1. Behind a proxying Cloudflare
  // ("orange cloud") = 2. Verify after deploy by logging `req.ip`.
  trustProxy: nonNegativeInt('TRUST_PROXY', process.env.TRUST_PROXY, 1),
  // Keep in step with the frontend's SESSION_SECONDS (store/useSessionStore), which
  // is the same window for solo rooms — solo never connects, so it can't be told by
  // the server and the two values have to be set to match by hand.
  sessionDurationMs: positiveInt('SESSION_DURATION_MS', process.env.SESSION_DURATION_MS, 300_000),
  startDelayMs: positiveInt('START_DELAY_MS', process.env.START_DELAY_MS, 1_000),
  roomCapacityDefault,
  roomCapacityMax,
  roomsMaxActive: positiveInt('ROOMS_MAX_ACTIVE', process.env.ROOMS_MAX_ACTIVE, 5_000),
  redisUrl: process.env.REDIS_URL?.trim() || null,
  stunUrls: (() => {
    const urls = parseCsv(process.env.STUN_URLS)
    return urls.length > 0 ? urls : [DEFAULT_STUN_URL]
  })(),
  turnUrls: parseCsv(process.env.TURN_URLS),
  turnStaticAuthSecret: process.env.TURN_STATIC_AUTH_SECRET?.trim() || null,
  turnCredentialTtlSeconds: positiveInt(
    'TURN_CREDENTIAL_TTL_SECONDS',
    process.env.TURN_CREDENTIAL_TTL_SECONDS,
    3600,
  ),
  cloudflareTurnKeyId: process.env.CLOUDFLARE_TURN_KEY_ID?.trim() || null,
  cloudflareTurnApiToken: process.env.CLOUDFLARE_TURN_API_TOKEN?.trim() || null,
  jwtSecret: requiredSecret('JWT_SECRET', process.env.JWT_SECRET),
}
