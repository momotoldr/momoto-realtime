# Momoto Realtime — rooms, signaling & session sync

The live half of Momoto's backend. It mints room codes, relays WebRTC coordination and
strip events between room members, synchronizes the capture countdown, owns each
session's window and end-of-life, and mints TURN credentials.

It holds **no database, no object storage, and no payment or mail credentials** — all of
that is `../momoto-core`. The one secret the two share is `JWT_SECRET`: core signs access
tokens, this service only verifies them on the socket handshake.

It does **no** media or image processing — camera, WebRTC video, Canvas capture, strip
composition and downloads all live in the browser (`../momoto-fe`). WebRTC SDP/ICE goes
through the PeerJS broker (`../momoto-peer`), not here.

> **Solo mode** never connects to this service; it runs fully offline in the browser.

## Features

- **Rooms** — server-minted 6-char codes (`POST /rooms`), 2–`ROOM_CAPACITY_MAX` seats,
  host derivation (first member), presence broadcasts, seat reclaim on reconnect, and
  empty-room cleanup.
- **Clock sync & synchronized capture** — a `time:sync` clock-offset handshake plus a
  shared absolute `startAt`, so every client fires the countdown/retake together
  (measured **< 50 ms** receive-time variance).
- **Relays** — WebRTC coordination (`peer:announce`, `peer:media-state`) and room strip
  state forwarded to the other members, with sender ids stamped by the server.
- **Authoritative session window** — the server sets `endsAt`, broadcasts
  `session:window`, retires the room at expiry, and **resumes** (not restarts) the
  remaining time on rejoin. "Time's up" is server-driven.
- **Ephemeral TURN credentials** — see below.
- **Hardened** — runtime payload validation, size caps, rate limiting, structured logging
  (no PII/secrets), and a periodic sweep so no in-memory state grows unbounded.

## Stack

Node.js (≥20) · TypeScript (ESM, strict) · Express · Socket.io · in-memory room state
(optional Redis scale path, see `../PLAN-redis.md`). Tooling: `tsx` (dev), ESLint (flat)
+ Prettier. No Prisma.

## Getting started

```bash
npm install
cp .env.example .env      # set JWT_SECRET to exactly momoto-core's value
npm run dev               # tsx watch on http://localhost:3003
```

> `JWT_SECRET` is **required** — the server refuses to boot without it — and it must equal
> `momoto-core`'s. A mismatch does *not* fail at boot: guests still connect, but every
> signed-in socket handshake is refused as `unauthorized`.

The frontend reaches this service through `VITE_REALTIME_URL` (default
`http://localhost:3003`); everything else it calls goes to `VITE_API_URL` (core, `:3001`).

### Scripts

| Script | Purpose |
| :--- | :--- |
| `npm run dev` | Dev server with reload (`tsx watch`). |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm start` | Run the compiled server (`node dist/index.js`). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | ESLint. |
| `npm run format` / `format:check` | Prettier write / check. |

## Configuration

All configuration is via environment variables. Full notes in `.env.example`.

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `3003` | HTTP/Socket.io listen port. |
| `TRUST_PROXY` | `1` | Reverse-proxy hops in front of the app; every per-IP rate limit depends on it. |
| `CORS_ORIGINS` | `http://localhost:5173` | Comma-separated FE origins, for HTTP and the socket handshake. **Set explicitly in production.** |
| `JWT_SECRET` | _(required)_ | Verifies access JWTs. **Must equal `momoto-core`'s.** |
| `SESSION_DURATION_MS` | `300000` | Length of a photobooth session (5 min). Must match the frontend's `SESSION_SECONDS`. |
| `START_DELAY_MS` | `1000` | Buffer before a synchronized countdown fires. |
| `ROOM_CAPACITY` | `2` | Seats a room is minted with by default. |
| `ROOM_CAPACITY_MAX` | `2` | Largest capacity `POST /rooms` accepts (ceiling 4). The enforcement half of the FE's `VITE_GROUP_MODE_ENABLED`. |
| `ROOMS_MAX_ACTIVE` | `5000` | Live-room safety valve; new rooms get `503 booth_busy` above it, joins never gated. |
| `REDIS_URL` | _(unset)_ | Reserved for the multi-instance scale path. |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Comma-separated STUN URLs served via `/turn-credentials`. |
| `TURN_URLS` | _(unset)_ | Comma-separated TURN URLs. Set with `TURN_STATIC_AUTH_SECRET` to enable coturn-style TURN. |
| `TURN_STATIC_AUTH_SECRET` | _(unset)_ | Shared secret for HMAC TURN credentials. Never sent to clients. |
| `TURN_CREDENTIAL_TTL_SECONDS` | `3600` | Lifetime of a minted TURN credential. |
| `CLOUDFLARE_TURN_KEY_ID` / `CLOUDFLARE_TURN_API_TOKEN` | _(unset)_ | Cloudflare Realtime TURN; takes precedence over coturn when both are set. |

## HTTP surface

| Method | Path | Response | Notes |
| :--- | :--- | :--- | :--- |
| `GET` | `/healthz` | `{ status, uptime }` | Liveness/readiness. |
| `POST` | `/rooms` | `201 { roomId }` | Body `{ capacity? }`. Out-of-range capacity → `400 invalid_capacity`; over `ROOMS_MAX_ACTIVE` → `503 booth_busy`. Rate-limited 30 / min / IP. |
| `GET` | `/rooms/:id` | `{ status, capacity, members }` | Pre-join check: `open` \| `full` \| `ended` \| `not_found`. Rate-limited 60 / min / IP. |
| `GET` | `/turn-credentials` | `{ iceServers, ttl }` | STUN + ephemeral TURN credentials. Rate-limited 60 / min / IP. |

Everything else is the Socket.io endpoint.

### Ephemeral TURN credentials

`GET /turn-credentials` mints **time-limited** TURN credentials. With coturn it uses the
"TURN REST API" (`use-auth-secret`) scheme — `username = <unix-expiry>:momoto`,
`credential = base64(HMAC-SHA1(secret, username))` — and the TURN server must be
configured with the **same** secret. Cloudflare Realtime TURN takes precedence when its
key and token are set. The shared secret is **never** sent to a client, and with no TURN
configured the response is STUN-only and the FE degrades gracefully.

## Wire contract (Socket.io)

`src/types/events.ts` is the authoritative contract, mirrored by
`../momoto-fe/src/types/events.ts`; the two change **in lockstep**. The full event list
with payloads is in `../TRD.md` §4.1.

The handshake is optional auth: pass `io(url, { auth: { token, clientId } })`. An empty
token connects as a guest; a present-but-invalid one is refused as `unauthorized`, which
the client recovers from by refreshing against core and reconnecting. `clientId` is a
stable per-tab id that lets a dropped connection reclaim its own seat.

## Hardening & ops

- **Validation** — every inbound payload is shape/size checked (`src/socket/validate.ts`);
  malformed data is logged and ignored, never crashing a handler or reaching a peer.
- **Size caps** — Socket.io `maxHttpBufferSize` = 128 KB; HTTP bodies 1 KB.
- **Rate limits** — per socket: `room:join` 20 / 10 s, `strip:shots` 30 / 10 s,
  `peer:announce` 30 / 10 s. Per IP: the HTTP limits above.
- **GC** — minted-but-unjoined reservations, ended-room codes and rate-limit windows are
  reclaimed by a 30 s sweep.
- **Logging** — structured JSON, no PII or secrets.

## Deployment

1. `npm ci && npm run build`
2. Set env vars — at minimum `CORS_ORIGINS` and `JWT_SECRET` (by reference to core's).
3. `npm start` behind a TLS-terminating proxy that forwards WebSocket upgrades. Point the
   FE's `VITE_REALTIME_URL` at the public URL.
4. `GET /healthz` for liveness/readiness probes.

**A redeploy ends every in-flight room** — room state is in process memory. Always-on
hosting is required; a tier that spins down drops live rooms on every cold start.
`../PLAN-redis.md` is the path to deploys that don't.

## Project structure

```
src/
  auth/verifyAccessToken.ts  JWT verification only (core mints)
  config/env.ts              validated env loader — refuses to boot on bad config
  config/loadEnv.ts          .env.local + .env loading
  http/app.ts                Express app (helmet, CORS, /healthz)
  http/routes/rooms.ts       POST /rooms, GET /rooms/:id
  http/routes/turn.ts        GET /turn-credentials
  http/middleware/           404 + terminal error handler
  lib/logger.ts              structured JSON logger
  lib/rateLimiter.ts         fixed-window rate limiter
  rooms/roomCode.ts          crypto-strong room-code minting
  rooms/roomStore.ts         in-memory rooms + endedRooms + GC
  rooms/sessionManager.ts    authoritative session window
  socket/server.ts           typed Socket.io server + handshake auth
  socket/validate.ts         inbound payload guards
  socket/rateLimits.ts       per-socket rate limits
  socket/handlers/           room / sync / relay event handlers
  turn/                      coturn HMAC + Cloudflare TURN minting
  types/events.ts            wire contract (mirrors the FE)
  index.ts                   entry: HTTP + Socket.io + sweep + shutdown
```

This service was split out of the old `momoto-be` on 2026-09-16.
