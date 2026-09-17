/**
 * Runtime payload guards for inbound socket events (Phase 5 hardening).
 *
 * The Socket.io typed generics only constrain *our* code — a real client can send
 * anything over the wire. These guards validate every inbound payload's shape and
 * bound its size so malformed or oversized data is ignored, never crashing a handler.
 * The overall byte size is also capped by the server's `maxHttpBufferSize`; these
 * per-field caps (array lengths, string lengths) are the semantic backstop.
 *
 * Strip payloads stay FE-owned and relayed verbatim, so we validate only their
 * *structure* (types + bounds), never their domain values (layout/filter/color enums).
 */

import type {
  PeerAnnouncePayload,
  PeerMediaStatePayload,
  RetakePayload,
  StripConfigPayload,
  StripShotsPayload,
} from '../types/events.js'

/** Field-level size caps (the byte-level cap is `maxHttpBufferSize` in server.ts). */
export const LIMITS = {
  /** Room codes are 6 chars; allow slack for future formats, but keep it bounded. */
  roomIdLen: 64,
  /** PeerJS ids are uuid-ish; generous but bounded. */
  peerIdLen: 128,
  /** Socket ids (the `to` target on a directed relay). */
  socketIdLen: 64,
  /** Opaque strip labels (layout / color / filter). */
  labelLen: 128,
} as const

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isBoundedString = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max

export const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v)

/** `room:join` carries a raw code string. */
export const isValidRoomId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= LIMITS.roomIdLen

/** `session:end` carries an optional room code. */
export const isValidSessionEnd = (v: unknown): v is string | undefined =>
  v === undefined || isValidRoomId(v)

export const isRetakePayload = (v: unknown): v is RetakePayload =>
  isObject(v) && isFiniteNumber(v.slot)

export const isPeerAnnounce = (v: unknown): v is PeerAnnouncePayload =>
  isObject(v) &&
  typeof v.peerJsId === 'string' &&
  v.peerJsId.length > 0 &&
  v.peerJsId.length <= LIMITS.peerIdLen &&
  // `to` and `reply` are optional; `from` and `directed` are ignored here because the
  // server stamps both itself.
  (v.to === undefined || isBoundedString(v.to, LIMITS.socketIdLen)) &&
  (v.reply === undefined || typeof v.reply === 'boolean')

export const isPeerMediaState = (v: unknown): v is PeerMediaStatePayload =>
  isObject(v) && typeof v.cam === 'boolean' && typeof v.mic === 'boolean'

export const isStripConfig = (v: unknown): v is StripConfigPayload =>
  isObject(v) &&
  isBoundedString(v.layout, LIMITS.labelLen) &&
  (v.color === null || isBoundedString(v.color, LIMITS.labelLen)) &&
  typeof v.confirmed === 'boolean'

export const isStripShots = (v: unknown): v is StripShotsPayload =>
  isObject(v) && typeof v.hasShots === 'boolean'
