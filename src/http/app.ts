import cors from 'cors'
import express, { type Express } from 'express'
import helmet from 'helmet'

import { env } from '../config/env.js'
import { isDraining } from '../lifecycle.js'
import { redisEnabled, redisHasConnected } from '../lib/redis.js'
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js'
import { roomsRouter } from './routes/rooms.js'
import { turnRouter } from './routes/turn.js'

/**
 * Builds the Express app for the realtime surface: health, room-code minting and the
 * pre-join lookup, and TURN credentials. Socket.io attaches to the same HTTP server in
 * `index.ts`. Everything that touches accounts or storage lives in `momoto-core`.
 *
 * **The PeerJS broker is deliberately not here.** It's a separate deployable
 * (`momoto-peer`). Do not mount `ExpressPeerServer` on this app: once room state moves
 * to Redis, realtime redeploys stop dropping live rooms, and an embedded broker would
 * put that disconnect right back. This app relays PeerJS *ids* between room members
 * (`peer:announce`) — the SDP/ICE negotiation those ids enable belongs to the broker.
 */
export function createApp(): Express {
  const app = express()

  // In production we sit behind a reverse proxy, which puts the real client IP in
  // `X-Forwarded-For`. Without this, `req.ip` is the proxy's address for every request,
  // so the per-IP rate limits (rooms, TURN) would throttle all users as if they were
  // one. The hop count is env-driven because it depends on the deploy topology — see
  // `TRUST_PROXY` in config/env.ts.
  app.set('trust proxy', env.trustProxy)

  // Baseline response headers (nosniff, HSTS, referrer policy, frame denial). This is
  // a JSON API that renders nothing, so the CSP and the cross-origin resource policy
  // that helmet enables by default would only get in the way of the browser fetching
  // us cross-origin from the frontend; the frontend ships its own CSP in `_headers`.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  )

  // `credentials: true` to match momoto-core: the frontend's shared axios client sends
  // `withCredentials` on every call, and a CORS response without this is refused.
  app.use(cors({ origin: env.corsOrigins, credentials: true }))
  // Only `POST /rooms { capacity }` has a body here, and it's a single number.
  app.use(express.json({ limit: '1kb' }))

  /**
   * Readiness, not liveness — the platform routes on this and decides when it is safe
   * to stop the previous deployment, so it answers for exactly two situations.
   *
   * **Draining:** 503 the moment SIGTERM arrives, so nothing new is sent to a process
   * that is closing its sockets.
   *
   * **Redis not yet reached:** 503 until the connection has succeeded *once*, so a
   * deployment that cannot see Redis never goes Active and never becomes the instance
   * serving rooms it has nowhere to store. Deliberately asymmetric: after that first
   * success a Redis blip must **not** flip this, or the platform would restart healthy
   * instances in a loop for the duration of a hiccup — turning a two-second stall into
   * an outage of our own making.
   */
  app.get('/healthz', (_req, res) => {
    if (isDraining()) {
      res.status(503).json({ status: 'draining', uptime: process.uptime() })
      return
    }
    if (redisEnabled && !redisHasConnected()) {
      res.status(503).json({ status: 'starting', detail: 'redis not reached yet' })
      return
    }
    res.json({ status: 'ok', uptime: process.uptime() })
  })

  app.use('/rooms', roomsRouter)
  app.use('/turn-credentials', turnRouter)

  // Must stay last: `notFoundHandler` catches unmatched paths, and `errorHandler` is
  // the sink for anything a route throws.
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
