import { logger } from '../../lib/logger.js'
import { roomStore } from '../../rooms/roomStore.js'
import { SocketEvents } from '../../types/events.js'
import { runSocketOp } from '../guard.js'
import type { AppSocket } from '../server.js'
import { announceLimiter, limitKey, shotsLimiter } from '../rateLimits.js'
import { isPeerAnnounce, isPeerMediaState, isStripConfig, isStripShots } from '../validate.js'

/** Broadcast target = the other member(s) of this socket's room, or null if none. */
function toPeer(socket: AppSocket) {
  const roomId = socket.data.roomId
  return roomId ? socket.to(roomId) : null
}

/**
 * Deliver to one member of this socket's room, by socket id — Socket.io keeps a room
 * per socket, so addressing that id addresses that socket alone.
 *
 * The membership check is what keeps it a *room* relay: without it any connected client
 * could push an announce at any other, and a client that answered it would hand its
 * camera to a stranger. The frontend refuses ids it didn't learn through the room too;
 * this is the half that doesn't depend on every client being well-behaved.
 */
async function toMember(socket: AppSocket, target: string) {
  const roomId = socket.data.roomId
  if (!roomId) return null
  if (!(await roomStore.getMembers(roomId)).includes(target)) {
    logger.warn('relay.directed.outsider', { socketId: socket.id, roomId, target })
    return null
  }
  return socket.to(target)
}

/**
 * Thin "relay to the other member" events, forwarded verbatim (the server never
 * interprets their payloads):
 *  - WebRTC coordination: `peer:announce`, `peer:media-state`
 *  - Host strip design: `strip:config`, `strip:arrange`, `strip:created`
 *
 * Late-join catch-up needs no server state: the host re-emits its current design on
 * `room:peer-joined`, and these relays forward it to the freshly-joined guest.
 */
export function registerRelayHandlers(socket: AppSocket): void {
  socket.on(SocketEvents.peerAnnounce, (payload) => {
    // A mesh makes this O(members) per join rather than a one-off, so it is limited
    // before it is validated, like the other relay that can arrive in bursts.
    if (!announceLimiter.allow(limitKey(socket))) {
      logger.warn('peer.announce.ratelimited', { socketId: socket.id })
      return
    }
    if (!isPeerAnnounce(payload)) return
    // `from` is stamped here and nowhere else. It is the only link between a PeerJS id
    // and a person in the room — the receiver files their stream, camera and mic state
    // under it — so it is taken from the connection, never from the message.
    // Addressed to one member (an introduction aimed at someone specific) or broadcast
    // (the newcomer's own announce, which everyone needs).
    //
    // `directed` is forwarded because the receiver's reply decision depends on it: a
    // directed announce is a *request* for our id and must always be answered, while a
    // broadcast must not be, or every pair would answer each other forever.
    const out = {
      peerJsId: payload.peerJsId,
      from: socket.id,
      directed: Boolean(payload.to),
      // Forwarded from the client, not derived: only the sender knows whether this
      // announce is an answer to one it received. Nothing is trusted to it — the worst
      // a forged `reply` can do is suppress a reply the forger asked for.
      reply: Boolean(payload.reply),
    }
    // The broadcast case needs no store lookup — `socket.to(room)` is membership by
    // construction. Only a directed announce has to prove the target is in this room,
    // which is the one path here that can fail, so it is the only one guarded.
    const to = payload.to
    if (!to) {
      toPeer(socket)?.emit(SocketEvents.peerAnnounce, out)
      return
    }
    runSocketOp(SocketEvents.peerAnnounce, socket, async () => {
      const target = await toMember(socket, to)
      target?.emit(SocketEvents.peerAnnounce, out)
    })
  })

  socket.on(SocketEvents.peerMediaState, (payload) => {
    if (!isPeerMediaState(payload)) return
    toPeer(socket)?.emit(SocketEvents.peerMediaState, {
      cam: payload.cam,
      mic: payload.mic,
      from: socket.id,
    })
  })

  socket.on(SocketEvents.stripConfig, (payload) => {
    if (!isStripConfig(payload)) return
    toPeer(socket)?.emit(SocketEvents.stripConfig, payload)
  })

  socket.on(SocketEvents.stripShots, (payload) => {
    if (!shotsLimiter.allow(limitKey(socket))) {
      logger.warn('strip.shots.ratelimited', { socketId: socket.id })
      return
    }
    if (!isStripShots(payload)) return
    toPeer(socket)?.emit(SocketEvents.stripShots, payload)
  })

  socket.on(SocketEvents.stripCreated, () => {
    // Stamped too: with more than one other person in the room, "someone finalized a
    // strip" has to say *who*, or a single peer leaving would clear everyone's flag.
    toPeer(socket)?.emit(SocketEvents.stripCreated, { from: socket.id })
  })
}
