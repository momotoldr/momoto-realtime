import { Router } from 'express'

import { logger } from '../../lib/logger.js'
import { RateLimiter } from '../../lib/rateLimiter.js'
import { resolveIceServers } from '../../turn/turnCredentials.js'

export const turnRouter = Router()

/**
 * Open, but rate-limited per caller IP. Rooms are open (guests can try a date session
 * before signing up), and a guest↔guest call across a restrictive NAT needs a TURN relay
 * to connect — so this can't require auth. The tradeoff: TURN relays are billed by the
 * gigabyte, the platform's largest running cost, so an open endpoint hands out hour-long
 * credentials to anonymous callers. The per-IP cap below is the guardrail against farming;
 * the shared TURN secret still never leaves the server (only a short-lived HMAC does).
 */

/** Per-caller cap on credential minting — cheap (an HMAC), but bound farming. */
const turnLimiter = new RateLimiter(60, 60_000)

/** Reclaim expired HTTP rate windows (wired into the periodic sweep). */
export function sweepTurnLimits(now: number = Date.now()): number {
  return turnLimiter.sweep(now)
}

/**
 * Mint fresh, time-limited ICE servers (STUN + ephemeral TURN credentials) for the
 * FE's WebRTC connection. The FE fetches this just before establishing the peer call;
 * see `momoto-fe/src/hooks/usePeerConnection.ts`. Never returns the shared TURN secret —
 * only a short-lived HMAC credential derived from it.
 */
turnRouter.get('/', async (req, res) => {
  const key = req.ip ?? 'unknown'
  if (!turnLimiter.allow(key)) {
    logger.warn('turn.credentials.ratelimited', { ip: req.ip })
    res.status(429).json({ error: 'too_many_requests' })
    return
  }
  // `resolveIceServers` never rejects — the Cloudflare path falls back to STUN/coturn
  // internally — so the response always carries a usable ICE server list.
  const { iceServers, ttl } = await resolveIceServers()
  res.json({ iceServers, ttl })
})
