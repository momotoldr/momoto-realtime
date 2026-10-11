import { RateLimiter } from '../lib/rateLimiter.js'

/**
 * Failed room-code lookups per address — the brake on guessing codes.
 *
 * A room's code is its only access control, so finding a live one by trial means walking
 * into a stranger's video call. The request-rate limits don't bound that on their own:
 * codes can be tried both by `GET /rooms/:id` and by the socket's `room:join`, and a
 * guest's socket can reconnect for a fresh socket. This counts only *misses* (codes with
 * no room behind them), per address (`rateLimitKey`), across both paths — someone
 * mistyping a code their friend sent misses a handful of times; a guesser misses on
 * nearly every try.
 *
 * Gate with `peek` before the lookup and spend a hit with `allow` on a miss. Once the
 * budget is spent, every code reads as not found (a 429 over HTTP) until the window
 * passes, so further guesses learn nothing.
 *
 * At 30 per 10 minutes one address can try ~4,300 codes a day, against ~887 M possible
 * six-character codes.
 */
export const codeGuessLimiter = new RateLimiter(30, 10 * 60_000)

/** Reclaim expired windows (wired into the periodic sweep). */
export function sweepCodeGuessLimits(now: number = Date.now()): number {
  return codeGuessLimiter.sweep(now)
}
