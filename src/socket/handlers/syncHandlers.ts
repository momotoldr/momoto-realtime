import { env } from '../../config/env.js'
import { logger } from '../../lib/logger.js'
import { SocketEvents } from '../../types/events.js'
import type { AppSocket, IoServer } from '../server.js'
import { isFiniteNumber, isRetakePayload } from '../validate.js'

/**
 * The room this socket is in, or null if it hasn't joined one.
 *
 * Membership is the whole authorization check here, and it's enough: a room holds
 * exactly two people who are already in a video call together. These events are
 * *documented* as host-driven, but the UI deliberately offers "Start session" and
 * "Retake all" to both members, so the server must not restrict them to the host —
 * that would leave the guest's button inert. What matters is that `roomId` comes
 * from the socket's own joined state and never from the client's payload.
 */
function memberRoom(socket: AppSocket): string | null {
  return socket.data.roomId ?? null
}

/**
 * Clock handshake + synchronized capture events. Scheduled events carry an absolute
 * server timestamp (`startAt = now + START_DELAY_MS`); each client fires at that
 * instant adjusted by its own clock offset, so both peers act together.
 */
export function registerSyncHandlers(io: IoServer, socket: AppSocket): void {
  // Clock-offset handshake: echo the client's timestamp alongside the server's.
  socket.on(SocketEvents.timeSync, (t0) => {
    if (!isFiniteNumber(t0)) return
    socket.emit(SocketEvents.timeSyncRes, { t0, t1: Date.now() })
  })

  // Host starts the synchronized capture: one shared start instant to ALL members.
  socket.on(SocketEvents.sessionStart, () => {
    const roomId = memberRoom(socket)
    if (!roomId) return
    const startAt = Date.now() + env.startDelayMs
    io.to(roomId).emit(SocketEvents.countdownStart, { startAt })
    logger.info('session.start', { roomId, startAt })
  })

  // Host re-shoots a single slot: synced retake start to ALL members (both re-shoot).
  socket.on(SocketEvents.sessionRetake, (payload) => {
    const roomId = memberRoom(socket)
    if (!roomId || !isRetakePayload(payload)) return
    const startAt = Date.now() + env.startDelayMs
    io.to(roomId).emit(SocketEvents.sessionRetakeStart, { slot: payload.slot, startAt })
    logger.info('session.retake', { roomId, slot: payload.slot, startAt })
  })

  // Host "Retake all": relay to the OTHER member only (the sender resets locally).
  socket.on(SocketEvents.sessionReset, () => {
    const roomId = memberRoom(socket)
    if (roomId) socket.to(roomId).emit(SocketEvents.sessionReset)
  })
}
