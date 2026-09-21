import type { Server as HttpServer } from 'node:http'

import { Server, type Socket } from 'socket.io'

import { verifyAccessToken } from '../auth/verifyAccessToken.js'
import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import { registerRelayHandlers } from './handlers/relayHandlers.js'
import { registerRoomHandlers } from './handlers/roomHandlers.js'
import { registerSyncHandlers } from './handlers/syncHandlers.js'
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from '../types/events.js'

export type IoServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>

export type AppSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>

/**
 * Creates the Socket.io server bound to the given HTTP server, with the CORS
 * allowlist applied. Event handlers (rooms, sync, relays) are registered in the
 * later phases; Phase 0 just proves the connection lifecycle works.
 */
export function createSocketServer(httpServer: HttpServer): IoServer {
  const io: IoServer = new Server(httpServer, {
    cors: { origin: env.corsOrigins, methods: ['GET', 'POST'], credentials: true },
    // WebSocket only — no HTTP long-polling fallback.
    //
    // Polling is a *sequence* of requests, and it only works if every one of them lands
    // on the same process. Railway has no sticky sessions, so the moment a deploy (or a
    // second replica) puts two processes behind one hostname, a polling handshake that
    // switches instances mid-sequence gets a 400 and the client never connects. The
    // fallback exists for networks that block WebSockets — the same networks that can't
    // hold the WebRTC call this app is built around, so there is nothing here for those
    // clients to fall back *to*.
    //
    // The client sets the matching option (`momoto-fe/src/utils/socket.ts`). Both sides
    // must agree: a client that still offers polling first would just fail its first
    // attempt and retry over WebSocket.
    transports: ['websocket'],
    // Hard byte cap on any single inbound message (Phase 5). This is a
    // signaling/sync server — no payload is large; strip design is relayed as
    // compact JSON. Per-field caps live in `validate.ts`; this stops oversized
    // frames before they're even parsed. Default is 1MB; 128KB is ample here.
    maxHttpBufferSize: 128 * 1024,
  })

  // Handshake auth is optional: rooms are open so a guest can try the booth before
  // signing up. The client passes its access token via `io(url, { auth: { token } })`;
  // a signed-in user sends a real token (we verify it and stash the user id), a guest
  // sends an empty one and connects anonymously (`userId` stays undefined). A token that
  // is present but invalid is still rejected — that's an expired session, and the client
  // recovers by refreshing and reconnecting. (Solo mode never connects, so it's
  // unaffected.) Room mechanics are keyed on the socket id, not the user id.
  io.use((socket, next) => {
    // Stable per-tab id the client keeps across reconnects and reloads. It carries no
    // authority — it only lets `roomStore.join` tell "the same client coming back"
    // from "a third person arriving", so a dropped connection can reclaim its own
    // seat instead of being refused as full. Bounded because it is client-supplied.
    const clientId = socket.handshake.auth?.clientId
    if (typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 64) {
      socket.data.clientId = clientId
    }

    const token = socket.handshake.auth?.token
    if (typeof token !== 'string' || !token) {
      next()
      return
    }
    try {
      socket.data.userId = verifyAccessToken(token).sub
      next()
    } catch {
      next(new Error('unauthorized'))
    }
  })

  io.on('connection', (socket) => {
    logger.info('socket.connected', { socketId: socket.id, userId: socket.data.userId })
    registerRoomHandlers(io, socket)
    registerSyncHandlers(io, socket)
    registerRelayHandlers(socket)

    socket.on('disconnect', (reason) => {
      logger.info('socket.disconnected', { socketId: socket.id, reason })
    })
  })

  return io
}
