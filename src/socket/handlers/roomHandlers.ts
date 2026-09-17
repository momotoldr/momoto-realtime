import { logger } from '../../lib/logger.js'
import { roomStore } from '../../rooms/roomStore.js'
import { endRoom, handleWindowOnJoin, openWindow } from '../../rooms/sessionManager.js'
import { SocketEvents } from '../../types/events.js'
import type { AppSocket, IoServer } from '../server.js'
import { joinLimiter, limitKey } from '../rateLimits.js'
import { isValidRoomId, isValidSessionEnd } from '../validate.js'

/**
 * Room lifecycle for one socket: join (ended → full → add), presence broadcasts,
 * the session window, and disconnect cleanup. The FE derives host = first member.
 */
export function registerRoomHandlers(io: IoServer, socket: AppSocket): void {
  socket.on(SocketEvents.roomJoin, (roomId) => {
    if (!isValidRoomId(roomId)) {
      logger.warn('room.join.invalid', { socketId: socket.id })
      return
    }
    if (!joinLimiter.allow(limitKey(socket))) {
      logger.warn('room.join.ratelimited', { socketId: socket.id })
      return
    }

    const result = roomStore.join(roomId, socket.id, socket.data.clientId ?? null)

    if (result.status === 'ended') {
      socket.emit(SocketEvents.roomEnded)
      logger.info('room.join.refused', { socketId: socket.id, roomId, reason: 'ended' })
      return
    }
    if (result.status === 'full') {
      socket.emit(SocketEvents.roomFull)
      logger.info('room.join.refused', { socketId: socket.id, roomId, reason: 'full' })
      return
    }
    if (result.status === 'not_found') {
      socket.emit(SocketEvents.roomNotFound)
      logger.info('room.join.refused', { socketId: socket.id, roomId, reason: 'not_found' })
      return
    }

    // This join took over the slot of one of this client's own earlier sockets (a
    // reconnect after a dropped connection, or a reload). Drop the superseded socket
    // so it can't linger in the room; the store already forgot it, so its disconnect
    // stays silent (see below) and the peer never sees a phantom leave.
    if (result.replaced) {
      io.sockets.sockets.get(result.replaced)?.disconnect(true)
      logger.info('room.rejoin', { socketId: socket.id, roomId, replaced: result.replaced })
    }

    socket.join(roomId)
    socket.data.roomId = roomId
    socket.emit(SocketEvents.roomJoined, {
      roomId,
      selfId: socket.id,
      members: result.members,
      capacity: roomStore.getCapacity(roomId) ?? result.members.length,
    })
    // Also sent on a reconnect: the peer's record of us is keyed on the socket id,
    // so it has to learn the new one to see us as present again.
    socket.to(roomId).emit(SocketEvents.peerJoined, { peerId: socket.id })
    // And the authoritative list, to everyone including the joiner. `peer-joined` above
    // is a delta — fine for a toast, not enough to hold presence for three other people
    // or to say who `members[0]` is now.
    io.to(roomId).emit(SocketEvents.roomMembers, { members: result.members })
    // Resume the window for a returning member, or start it once both are present.
    handleWindowOnJoin(io, socket, roomId, result.members.length)
    logger.info('room.join', { socketId: socket.id, roomId, members: result.members.length })
  })

  // Host opens the session window. The room lifecycle lives here rather than in
  // `syncHandlers` (which owns the capture events) because this decides when the
  // room's clock starts, not what happens inside it.
  socket.on(SocketEvents.sessionOpen, () => {
    const roomId = socket.data.roomId
    if (typeof roomId !== 'string' || roomId.length === 0) return
    const refused = openWindow(io, socket, roomId)
    if (refused) logger.warn('session.open.refused', { socketId: socket.id, roomId, refused })
  })

  // Explicit early end (rarely needed now the server owns the window) — kept for
  // contract parity. `roomId` falls back to the socket's current room.
  socket.on(SocketEvents.sessionEnd, (roomId) => {
    if (!isValidSessionEnd(roomId)) return
    const room = roomId ?? socket.data.roomId
    if (typeof room !== 'string' || room.length === 0) return
    // The room code arrives from the client, so it must be checked against the room
    // this socket actually joined. Without this, any connected client could retire
    // someone else's session just by naming its code.
    if (room !== socket.data.roomId) {
      logger.warn('session.end.forbidden', { socketId: socket.id, roomId: room })
      return
    }
    endRoom(socket, room)
  })

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId
    if (!roomId) return
    // `null` means this socket was no longer a member — its slot was already taken
    // over by the same client reconnecting. Announcing a leave here would tell the
    // peer their friend left moments after they came back.
    const remaining = roomStore.leave(roomId, socket.id)
    if (remaining === null) {
      logger.info('room.leave.superseded', { socketId: socket.id, roomId })
      return
    }
    socket.to(roomId).emit(SocketEvents.peerLeft, { peerId: socket.id })
    // `io.to` rather than `socket.to`: this socket has already left the Socket.io room
    // by the time `disconnect` fires, so the two reach the same people — but only one
    // of them says so.
    io.to(roomId).emit(SocketEvents.roomMembers, { members: remaining.members })
    logger.info('room.leave', { socketId: socket.id, roomId })
  })
}
