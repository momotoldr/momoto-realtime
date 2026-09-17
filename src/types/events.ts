/**
 * Socket.io wire contract.
 *
 * This MUST stay byte-compatible with the frontend's contract at
 * `../momoto/src/types/events.ts` — event names, payload field names, and shapes.
 * Any change lands in both repos in lockstep.
 *
 * Strip design payloads (layout / color / filter / stickers) are FE-owned and
 * relayed **verbatim** by this server; it never interprets them, so their enum-like
 * fields are typed permissively here (the FE holds the authoritative unions).
 */

/** Socket.io event names — the client/server contract. */
export const SocketEvents = {
  timeSync: 'time:sync',
  timeSyncRes: 'time:sync:res',
  roomJoin: 'room:join',
  roomJoined: 'room:joined',
  roomFull: 'room:full',
  /** Server → client: the room's session already ended; joining is refused. */
  roomEnded: 'room:ended',
  /** Server → client: no such room (unknown/typo'd code, e.g. a hand-typed URL). */
  roomNotFound: 'room:not-found',
  peerJoined: 'room:peer-joined',
  peerLeft: 'room:peer-left',
  /**
   * Server → everyone: the room's full membership, in join order, after any change.
   *
   * The authoritative presence signal. `peer-joined` / `peer-left` are deltas, which
   * are safe to fold when there is exactly one other person and drift the moment there
   * are three — and they can't answer "who is the host now", since that is `members[0]`
   * and only a list knows the order.
   */
  roomMembers: 'room:members',
  /**
   * Host → server: open the session window now (rooms that seat more than two, where
   * there is no "everyone has arrived" moment to start on). Refused for anyone but
   * `members[0]`, below two members, or once a window is already running.
   */
  sessionOpen: 'session:open',
  sessionStart: 'session:start',
  /** Client → server: this room's timed session has ended (close it to new joins). */
  sessionEnd: 'session:end',
  /** Host → guest: discard the strip and go back to the pre-capture booth ("Retake all"). */
  sessionReset: 'session:reset',
  countdownStart: 'session:countdown-start',
  /** Server → both: the room's session window; clients drive their countdown from `endsAt`. */
  sessionWindow: 'session:window',
  /** Server → both present members: the window elapsed — end the session now (immediate,
   * server-authoritative kick that doesn't wait on each client's local countdown tick). */
  sessionExpired: 'session:expired',
  /** Host → server: re-shoot a single slot; server broadcasts `retake-start` to both. */
  sessionRetake: 'session:retake',
  /** Server → both: begin a synced single-shot retake of `slot` at `startAt`. */
  sessionRetakeStart: 'session:retake-start',
  peerAnnounce: 'peer:announce',
  peerMediaState: 'peer:media-state',
  stripConfig: 'strip:config',
  stripShots: 'strip:shots',
  /** A member finalized their strip ("Create strip") — the peer notes it. */
  stripCreated: 'strip:created',
} as const

// --- FE-owned types, relayed verbatim (permissive on the backend) ---
export type StripLayout = string
export type StripColor = string

// --- Payloads ---

export interface RoomJoinedPayload {
  roomId: string
  selfId: string
  members: string[]
  /**
   * Seats this room was minted with. Sent because the client cannot infer it: the
   * creator only gets a code back from `POST /rooms`, and "3 of 4 here" — and the rule
   * for when the host may start — both need the total.
   */
  capacity: number
}

export interface RoomMembersPayload {
  /** Socket ids in join order; `[0]` is the host. */
  members: string[]
}

export interface PeerPayload {
  peerId: string
}

export interface CountdownStartPayload {
  /** Server timestamp (ms) at which the countdown should begin. */
  startAt: number
}

export interface RetakePayload {
  /** Strip slot to re-shoot. */
  slot: number
}

export interface RetakeStartPayload {
  slot: number
  startAt: number
}

export interface SessionWindowPayload {
  /** Server timestamp (ms) at which the session ends. */
  endsAt: number
}

export interface TimeSyncResPayload {
  t0: number
  t1: number
}

export interface PeerAnnouncePayload {
  /** The sender's PeerJS id (for placing/answering the WebRTC call). */
  peerJsId: string
  /**
   * Sender's socket id, **stamped by the server** — never trusted from the client.
   * It is what ties a PeerJS id (and the stream that follows) to a person in the room,
   * so a forged one would file someone else's camera under the wrong tile.
   */
  from?: string
  /**
   * Target socket id: send this to one member instead of the whole room. Used for the
   * reply to a newcomer's announce — broadcasting every reply would make each join cost
   * a message from every member to every member.
   */
  to?: string
  /**
   * Set by the server on a **directed** announce (one that carried `to`), so the
   * receiver can tell "someone is asking me for my id" from "someone is answering the
   * ask I already made".
   *
   * Without it the two are indistinguishable once `to` is stripped, and the receiver
   * has to guess. Replying to everything ping-pongs forever; replying only when the
   * sender's PeerJS id is *new* goes silent exactly when it matters most — a peer whose
   * socket id changed on reconnect re-announces with the same PeerJS id, so the reply
   * that would carry our id back is the one that gets suppressed.
   */
  directed?: boolean
  /**
   * Set by the sender when this announce is itself an answer to a directed one, and
   * forwarded verbatim. It terminates the exchange: a reply is directed too, so without
   * it "always answer a directed announce" would ping-pong indefinitely.
   */
  reply?: boolean
}

export interface PeerMediaStatePayload {
  cam: boolean
  mic: boolean
  /** Sender's socket id, stamped by the server — which tile this cam/mic state is for. */
  from?: string
}

export interface StripCreatedPayload {
  /** Sender's socket id, stamped by the server — whose strip was finalized. */
  from?: string
}

export interface StripConfigPayload {
  layout: StripLayout
  color: StripColor | null
  confirmed: boolean
}

/**
 * Host → room: has a capture round already produced shots in this booth?
 *
 * What is left of the old `strip:arrange`. Strip design (template, filter, stickers,
 * slot order) no longer crosses the wire at all: every client composites the room's
 * cameras in its own order and only mirrors itself, so members' frames hold different
 * faces in different cells and one member's coordinates never described another's strip.
 * Design is theirs alone now; this flag is the one thing a late arrival can't see.
 */
export interface StripShotsPayload {
  hasShots: boolean
}

// --- Socket.io typed event maps (server generics) ---

export interface ClientToServerEvents {
  [SocketEvents.timeSync]: (t0: number) => void
  [SocketEvents.roomJoin]: (roomId: string) => void
  [SocketEvents.sessionOpen]: () => void
  [SocketEvents.sessionStart]: () => void
  [SocketEvents.sessionEnd]: (roomId?: string) => void
  [SocketEvents.sessionReset]: () => void
  [SocketEvents.sessionRetake]: (payload: RetakePayload) => void
  [SocketEvents.peerAnnounce]: (payload: PeerAnnouncePayload) => void
  [SocketEvents.peerMediaState]: (payload: PeerMediaStatePayload) => void
  [SocketEvents.stripConfig]: (payload: StripConfigPayload) => void
  [SocketEvents.stripShots]: (payload: StripShotsPayload) => void
  [SocketEvents.stripCreated]: () => void
}

export interface ServerToClientEvents {
  [SocketEvents.timeSyncRes]: (payload: TimeSyncResPayload) => void
  [SocketEvents.roomJoined]: (payload: RoomJoinedPayload) => void
  [SocketEvents.roomFull]: () => void
  [SocketEvents.roomEnded]: () => void
  [SocketEvents.roomNotFound]: () => void
  [SocketEvents.peerJoined]: (payload: PeerPayload) => void
  [SocketEvents.peerLeft]: (payload: PeerPayload) => void
  [SocketEvents.roomMembers]: (payload: RoomMembersPayload) => void
  [SocketEvents.countdownStart]: (payload: CountdownStartPayload) => void
  [SocketEvents.sessionWindow]: (payload: SessionWindowPayload) => void
  [SocketEvents.sessionExpired]: () => void
  [SocketEvents.sessionRetakeStart]: (payload: RetakeStartPayload) => void
  [SocketEvents.sessionReset]: () => void
  [SocketEvents.peerAnnounce]: (payload: PeerAnnouncePayload) => void
  [SocketEvents.peerMediaState]: (payload: PeerMediaStatePayload) => void
  [SocketEvents.stripConfig]: (payload: StripConfigPayload) => void
  [SocketEvents.stripShots]: (payload: StripShotsPayload) => void
  [SocketEvents.stripCreated]: (payload: StripCreatedPayload) => void
}

export type InterServerEvents = Record<string, never>

export interface SocketData {
  roomId?: string
  /** Stable per-tab client id from the handshake — see the socket auth guard. */
  clientId?: string
  /** Set by the handshake auth guard — the authenticated user's id. */
  userId?: string
}
