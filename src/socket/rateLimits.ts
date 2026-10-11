/**
 * Socket rate limits (Phase 5). Bounds abuse without impeding normal use:
 *  - `room:join` — a handful of legitimate joins/rejoins; 20 / 10s is generous. Counted
 *    per account or, for a guest, per address (`joinKey`).
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
 * The identity the in-room relay limits (`strip:shots`, `peer:announce`) count against:
 * the account, or the socket for a guest.
 *
 * Guests connect without a token, so for them this is `socket.id`, which a reconnect
 * renews. That is acceptable here: these relays only ever reach the sender's own room,
 * so the most a reconnecting flooder can do is pester people already in a call with it.
 * Not keyed on the address, because up to four guests in one group room can share one
 * (a household's Wi-Fi), and a mesh reconnect would spend their shared budget together.
 * `room:join` is different — see `joinKey`.
 */
export function limitKey(socket: AppSocket): string {
  return socket.data.userId ?? socket.id
}

/**
 * The identity `room:join` counts against: the account, or the connection's address for
 * a guest.
 *
 * Joining is how a code gets tried over the socket, so a budget a guest could renew by
 * reconnecting would make guessing codes unlimited. The address can't be renewed that
 * way (`rateLimitKey` folds an IPv6 /64 into one), and twenty joins per ten seconds is
 * still far beyond what everyone behind one address does at once. Failed guesses have
 * their own, tighter budget on top (`codeGuessLimiter`).
 */
export function joinKey(socket: AppSocket): string {
  if (socket.data.userId) return socket.data.userId
  return `ip:${socket.data.ipKey ?? socket.id}`
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
