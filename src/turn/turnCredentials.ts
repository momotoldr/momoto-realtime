import { createHmac } from 'node:crypto'

import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'

import { fetchCloudflareIceServers } from './cloudflareTurn.js'

/**
 * An ICE server entry, shaped to match the browser's `RTCIceServer` so the FE can
 * pass the array straight into `RTCPeerConnection` / PeerJS `config.iceServers`.
 */
export interface IceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

/**
 * Build the ICE server list for a client, minting **time-limited TURN credentials**
 * using the coturn "TURN REST API" (a.k.a. `use-auth-secret`) scheme:
 *
 *   username   = `<unix-expiry>:<label>`
 *   credential = base64( HMAC-SHA1( sharedSecret, username ) )
 *
 * The TURN server derives the same HMAC from its shared secret and accepts the
 * credential until the embedded expiry — so no per-user secret is ever stored or
 * shipped, and a leaked credential stops working within `turnCredentialTtlSeconds`.
 * The shared secret lives only in server env (`TURN_STATIC_AUTH_SECRET`) and never
 * leaves this process.
 *
 * STUN is always included; TURN is added only when both a TURN URL and the shared
 * secret are configured (otherwise the FE still gets STUN and falls back gracefully).
 */
export function buildIceServers(now: number = Date.now()): {
  iceServers: IceServer[]
  ttl: number
} {
  const ttl = env.turnCredentialTtlSeconds
  const iceServers: IceServer[] = []

  if (env.stunUrls.length > 0) {
    iceServers.push({ urls: env.stunUrls })
  }

  if (env.turnUrls.length > 0 && env.turnStaticAuthSecret) {
    const expiry = Math.floor(now / 1000) + ttl
    const username = `${expiry}:momoto`
    const credential = createHmac('sha1', env.turnStaticAuthSecret)
      .update(username)
      .digest('base64')
    iceServers.push({ urls: env.turnUrls, username, credential })
  }

  return { iceServers, ttl }
}

/**
 * Resolve the ICE servers to hand the FE, picking the configured TURN provider:
 *
 * 1. **Cloudflare Realtime TURN** when its keys are set — managed, anycast relays.
 * 2. **coturn** (`use-auth-secret` HMAC) otherwise, if a TURN URL + secret are set.
 * 3. **STUN only** if neither is configured.
 *
 * Cloudflare is an async API call; if it fails (unreachable/misconfigured) we fall
 * back to the synchronous STUN/coturn path so a P2P-friendly network still connects
 * rather than the whole endpoint erroring.
 */
export async function resolveIceServers(
  now: number = Date.now(),
): Promise<{ iceServers: IceServer[]; ttl: number }> {
  if (env.cloudflareTurnKeyId && env.cloudflareTurnApiToken) {
    try {
      return await fetchCloudflareIceServers(now)
    } catch (error) {
      logger.warn('turn.cloudflare.failed', { error: (error as Error).message })
      // Fall through to STUN (+ coturn if configured) so video still attempts to connect.
    }
  }
  return buildIceServers(now)
}
