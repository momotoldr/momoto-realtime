import { logger } from '../lib/logger.js'

const EVENT_BUDGET = 200
const EVENT_WINDOW_MS = 10_000

/**
 * A ceiling on all events from one socket, for `socket.use`. Most events have no limit of
 * their own, and several (`session:start`, for one) fan out through Redis to the room, so
 * an unbounded socket costs far more than its own messages. Far above what a real client
 * sends: over budget, events are dropped and the connection stays up.
 */
export function eventBudget(socketId: string): (packet: unknown, next: () => void) => void {
  let windowStart = Date.now()
  let count = 0
  return (_packet, next) => {
    const now = Date.now()
    if (now - windowStart >= EVENT_WINDOW_MS) {
      windowStart = now
      count = 0
    }
    count += 1
    if (count <= EVENT_BUDGET) {
      next()
      return
    }
    // Once per window, however long the flood lasts.
    if (count === EVENT_BUDGET + 1) logger.warn('socket.event_budget_exceeded', { socketId })
  }
}

/**
 * Open sockets per address, so one source can't hold the whole server.
 *
 * The handshake is open to guests by design, and the request-rate limits only count what a
 * connection does once it's up, so nothing else bounds how many a script keeps open. Counts
 * live sockets rather than a rate: the budget comes back only when one closes, which a
 * reconnect can't get around.
 *
 * Per process, so N replicas allow N times this. That's fine for a limit meant to stop one
 * address taking everything, and it needs no Redis round trip per connection.
 */
export class ConnectionLimit {
  private readonly open = new Map<string, number>()

  constructor(private readonly max: number) {}

  /** Claims a slot for `key`. False when it already holds the maximum. */
  acquire(key: string): boolean {
    const count = this.open.get(key) ?? 0
    if (count >= this.max) return false
    this.open.set(key, count + 1)
    return true
  }

  /** Gives back a slot claimed by `acquire`. */
  release(key: string): void {
    const left = (this.open.get(key) ?? 1) - 1
    if (left > 0) this.open.set(key, left)
    else this.open.delete(key)
  }
}
