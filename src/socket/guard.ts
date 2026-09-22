import { logger } from '../lib/logger.js'
import type { AppSocket } from './server.js'

/**
 * Run a store-backed operation for one socket event.
 *
 * Handlers talk to a room store that can fail — once room state lives in Redis, an
 * outage or a blip turns any of those calls into a rejected promise. A socket listener
 * has no caller to catch that, so without this the rejection escapes as an unhandled
 * rejection and is logged a long way from the event that caused it.
 *
 * Failing quietly is the deliberate choice. The client's own reconnect and re-join are
 * the recovery path, and inventing a wire event for "the server's store is unwell"
 * would only give the frontend another state to mishandle.
 */
export function runSocketOp(event: string, socket: AppSocket, op: () => Promise<void>): void {
  void op().catch((err: unknown) => {
    logger.error('socket.op.failed', {
      event,
      socketId: socket.id,
      roomId: socket.data.roomId,
      err: err instanceof Error ? err.message : String(err),
    })
  })
}
