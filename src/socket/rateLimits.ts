/**
 * Per-socket rate limits (Phase 5). Bounds abuse without impeding normal use:
 *  - `room:join` — a handful of legitimate joins/rejoins; 20 / 10s is generous.
 *  - `strip:shots` — fires on a round finishing and on membership change, so a small
 *    budget is ample. It kept its limiter through the loss of the live design relay it
 *    was sized for (`strip:arrange`, 100 / 1s, when sticker drags crossed the wire):
 *    the event is cheap to flood and nothing is gained by taking the bound off.
 *  - `peer:announce` — was one message per room; in a mesh every join costs an announce
 *    plus a directed reply from each member, so it is no longer naturally rare. 30 / 10s
 *    is far above a real room's churn (four people reconnecting repeatedly).
 * Other relays are naturally low-frequency and rely on validation + `maxHttpBufferSize`.
 */
import { RateLimiter } from '../lib/rateLimiter.js'
import type { AppSocket } from './server.js'

export const joinLimiter = new RateLimiter(20, 10_000)
export const shotsLimiter = new RateLimiter(30, 10_000)
export const announceLimiter = new RateLimiter(30, 10_000)

/**
 * The identity a socket's limits are counted against.
 *
 * Deliberately **not** `socket.id`: that is regenerated on every connection, so an
 * abuser only has to reconnect to be handed a fresh budget — which makes a per-socket
 * limit no limit at all. The handshake authenticates the user, so count against the
 * account and make reconnecting pointless. (The `??` is unreachable while `io.use()`
 * rejects tokenless handshakes; it exists so a future public namespace degrades to
 * per-socket limiting rather than to one shared bucket.)
 */
export function limitKey(socket: AppSocket): string {
  return socket.data.userId ?? socket.id
}

/**
 * All socket limiters, for periodic sweeping.
 *
 * Note there is no disconnect-time reset. Clearing a key when its socket goes away
 * would hand back the whole budget on reconnect — the same bypass keying by account
 * is meant to close. The windows here are seconds long and the periodic sweep
 * reclaims them, so nothing accumulates.
 */
const socketLimiters = [joinLimiter, shotsLimiter, announceLimiter]

/** Reclaim expired windows across all socket limiters. */
export function sweepSocketLimits(now: number = Date.now()): void {
  for (const limiter of socketLimiters) limiter.sweep(now)
}
