import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import type { AppSocket, IoServer } from '../socket/server.js'
import { SocketEvents } from '../types/events.js'
import { minSessionMembers, roomStore } from './roomStore.js'

/** Per-room expiry timers so we can retire a room exactly when its window ends. */
const expiryTimers = new Map<string, NodeJS.Timeout>()

function clearTimer(roomId: string): void {
  const timer = expiryTimers.get(roomId)
  if (timer) {
    clearTimeout(timer)
    expiryTimers.delete(roomId)
  }
}

function scheduleExpiry(io: IoServer, roomId: string, endsAt: number): void {
  clearTimer(roomId)
  const timer = setTimeout(
    () => {
      expiryTimers.delete(roomId)
      // Push the end to present members so they're kicked *immediately* and reliably —
      // not whenever their local 1s countdown tick happens to fire (which lags, drifts
      // with the clock offset, and is throttled to ~1/min in a backgrounded tab). This
      // is distinct from `room:ended` (which is the "joining a dead room" screen); a
      // present member sees the friendly "time's up" screen off its own `ended` flag.
      io.to(roomId).emit(SocketEvents.sessionExpired)
      // Retiring the code makes any future join refuse with `room:ended`. A timer
      // callback has no caller to catch a rejection, so it is handled here rather than
      // escaping as an unhandled rejection: the members have already been told the
      // window is over, and a store that refused the write will be reconciled by the
      // room's own TTL.
      void roomStore.endSession(roomId).then(
        () => logger.info('session.window.expired', { roomId }),
        (err: unknown) =>
          logger.error('session.window.expire_failed', { roomId, err: String(err) }),
      )
    },
    Math.max(0, endsAt - Date.now()),
  )
  timer.unref()
  expiryTimers.set(roomId, timer)
}

/** Start the window, tell the room, and arm its expiry. Callers have done the policy. */
async function openWindowNow(io: IoServer, roomId: string, trigger: string): Promise<boolean> {
  const endsAt = await roomStore.startWindow(roomId, env.sessionDurationMs)
  if (endsAt === null) return false
  io.to(roomId).emit(SocketEvents.sessionWindow, { endsAt })
  scheduleExpiry(io, roomId, endsAt)
  logger.info('session.window.start', { roomId, endsAt, trigger })
  return true
}

/**
 * On a successful join: resume the window for a returning member if one is already
 * running, or — in a two-seat room — start it once the second person arrives.
 *
 * **Auto-start is the two-seat rule only.** A Solo or Date room filling up *is* the
 * "everyone is here" moment, so starting the clock on it is right and this is exactly
 * the behaviour those rooms have always had. A room that seats more has no such moment:
 * waiting for the last seat would strand a group of three forever, and starting at two
 * would burn the window while people are still arriving. Those rooms wait for the host
 * to say so — `session:open`, below.
 */
export async function handleWindowOnJoin(
  io: IoServer,
  socket: AppSocket,
  roomId: string,
  memberCount: number,
): Promise<void> {
  const existing = await roomStore.getWindow(roomId)
  if (existing !== null) {
    socket.emit(SocketEvents.sessionWindow, { endsAt: existing }) // resume
    return
  }
  if ((await roomStore.getCapacity(roomId)) !== 2) return
  if (memberCount < 2) return

  await openWindowNow(io, roomId, 'capacity')
}

/**
 * Host-opened window (`session:open`) — the path for rooms that seat more than two.
 * Returns `null` on success, or a short reason it was refused, for the caller's log.
 *
 * Unlike the capture events in `syncHandlers` — which are deliberately open to every
 * member, because the UI offers Start and Retake to all of them and a server-side host
 * check would leave a guest's button inert — this one is host-only. It is a one-shot,
 * irreversible act on shared state that only the host has an affordance for, so the
 * check costs nothing and stops a stray client burning the group's five minutes before
 * everyone has arrived.
 */
export async function openWindow(
  io: IoServer,
  socket: AppSocket,
  roomId: string,
): Promise<string | null> {
  if ((await roomStore.getWindow(roomId)) !== null) return 'already_open'
  const members = await roomStore.getMembers(roomId)
  if (members[0] !== socket.id) return 'not_host'
  const capacity = (await roomStore.getCapacity(roomId)) ?? members.length
  if (members.length < minSessionMembers(capacity)) return 'not_enough_members'
  return (await openWindowNow(io, roomId, 'host')) ? null : 'refused'
}

/**
 * Explicit early end (client `session:end`): cancel the timer, retire the room, and
 * notify the other member so it drops to the "room closed" screen. Kept for contract
 * parity — the server-owned window is normally what ends a session.
 */
export async function endRoom(socket: AppSocket, roomId: string): Promise<void> {
  clearTimer(roomId)
  await roomStore.endSession(roomId)
  socket.to(roomId).emit(SocketEvents.roomEnded)
  logger.info('session.end', { roomId })
}
