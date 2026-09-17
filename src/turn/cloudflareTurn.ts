import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'

import type { IceServer } from './turnCredentials.js'

/**
 * Cloudflare Realtime TURN adapter.
 *
 * Cloudflare runs the relays on its anycast edge (nearest PoP per peer, plus a
 * `turns:` endpoint on 443 that punches through restrictive networks). Unlike the
 * coturn `use-auth-secret` path, Cloudflare mints credentials through its own API:
 * we POST our TURN key id + API token and get back a short-lived `{ urls, username,
 * credential }`. The API token is a **secret** and never leaves this process — only
 * the minted, expiring credential reaches the browser.
 *
 * Credentials are cached and reused until shortly before they expire, so a burst of
 * peer connections doesn't hammer the Cloudflare API (a single credential is valid
 * for any client for its whole TTL).
 *
 * @see https://developers.cloudflare.com/realtime/turn/
 */

const CF_API_BASE = 'https://rtc.live.cloudflare.com/v1/turn/keys'
const REQUEST_TIMEOUT_MS = 5_000

/** Shape of the Cloudflare credential-generation response (fields we rely on). */
interface CloudflareCredentialsResponse {
  iceServers?: {
    urls?: string | string[]
    username?: string
    credential?: string
  }
}

interface CachedCredentials {
  iceServers: IceServer[]
  /** Absolute epoch-ms when the minted credential stops being valid. */
  expiresAt: number
}

let cache: CachedCredentials | null = null
/** Dedupe concurrent refreshes so N simultaneous callers make one API call. */
let inFlight: Promise<CachedCredentials> | null = null

/**
 * Refresh this far before the real expiry so a cached credential is never handed to a
 * client on the edge of validity (a call started now must outlive the credential).
 * The larger of 60s or 10% of the TTL.
 */
function refreshMarginMs(ttlSeconds: number): number {
  return Math.max(60_000, ttlSeconds * 100)
}

async function requestCredentials(ttlSeconds: number): Promise<CachedCredentials> {
  const url = `${CF_API_BASE}/${encodeURIComponent(env.cloudflareTurnKeyId as string)}/credentials/generate`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.cloudflareTurnApiToken as string}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ttl: ttlSeconds }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw new Error(`cloudflare turn responded ${res.status}`)
  }

  const data = (await res.json()) as CloudflareCredentialsResponse
  const cf = data.iceServers
  if (!cf?.urls || !cf.username || !cf.credential) {
    throw new Error('cloudflare turn returned a malformed credential body')
  }

  return {
    // Cloudflare's single entry already bundles STUN + TURN (udp/tcp/tls) urls.
    iceServers: [{ urls: cf.urls, username: cf.username, credential: cf.credential }],
    expiresAt: Date.now() + ttlSeconds * 1000,
  }
}

/**
 * ICE servers backed by Cloudflare TURN. Serves a cached credential when one is still
 * comfortably valid; otherwise mints a fresh one (deduping concurrent callers). Throws
 * if Cloudflare is unreachable/misconfigured so the caller can fall back to STUN/coturn.
 */
export async function fetchCloudflareIceServers(
  now: number = Date.now(),
): Promise<{ iceServers: IceServer[]; ttl: number }> {
  const ttlSeconds = env.turnCredentialTtlSeconds

  if (cache && now < cache.expiresAt - refreshMarginMs(ttlSeconds)) {
    const remaining = Math.max(1, Math.floor((cache.expiresAt - now) / 1000))
    return { iceServers: cache.iceServers, ttl: remaining }
  }

  inFlight ??= requestCredentials(ttlSeconds)
    .then((fresh) => {
      cache = fresh
      logger.info('turn.cloudflare.minted', { ttl: ttlSeconds })
      return fresh
    })
    .finally(() => {
      inFlight = null
    })

  const fresh = await inFlight
  return { iceServers: fresh.iceServers, ttl: ttlSeconds }
}
