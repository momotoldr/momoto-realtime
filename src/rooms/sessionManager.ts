import { env } from '../config/env.js'
import { logger } from '../lib/logger.js'
import type { AppSocket, IoServer } from '../socket/server.js'
import { SocketEvents } from '../types/events.js'
import { minSessionMembers } from './roomStore.js'
import { roomStore } from './store.js'

/**
 * How often each instance looks for windows that have elapsed.
 *
 * Half a second of slack is invisible: clients run their own countdown from `endsAt`
 * and never wait on the server to reach zero. This push exists to kick a backgrounded
 * tab, whose local timer a browser throttles to about once a minute.
 */
const EXPIRY_POLL_MS = 500

/** How many rooms one poll may retire, so a backlog can't monopolise the loop. */
const EXPIRY_BATCH = 50

/** Start the window, tell the room, and record it as due. Callers have done the policy. */
async function openWindowNow(io: IoServer, roomId: string, trigger: string): Promise<boolean> {
  const endsAt = await roomStore.startWindow(roomId, env.sessionDurationMs)
  if (endsAt === null) return false
  io.to(roomId).emit(SocketEvents.sessionWindow, { endsAt })
  logger.info('session.window.start', { roomId, endsAt, trigger })
  return true
}

/**
 * Retire the windows that have run out.
 *
 * **Polling, not a timer per room.** A `setTimeout` lives in one process, and the whole
 * point of this work is that the process can go away mid-session: its timer would never
 * fire and the room would run forever. Asking the store instead means any instance can
 * finish a window that another one started.
 *
 * The store hands each room to exactly one caller (`claimExpired`), so `session:expired`
 * is emitted once even with several instances polling — and the emit goes through the
 * adapter, so it reaches members on every node, not just this one.
 */
export function startExpiryPoller(io: IoServer): () => void {
  let running = false

  const tick = async (): Promise<void> => {
    // Skip rather than overlap: a slow Redis would otherwise stack polls on top of
    // each other and turn a hiccup into a pile-up.
    if (running) return
    running = true
    try {
      for (const roomId of await roomStore.claimExpired(Date.now(), EXPIRY_BATCH)) {
        // Push the end to present members so they're kicked *immediately* and reliably —
        // not whenever their local countdown tick happens to fire. This is distinct from
        // `room:ended` (the "joining a dead room" screen); a present member sees the
        // friendly "time's up" screen off its own `ended` flag.
        io.to(roomId).emit(SocketEvents.sessionExpired)
        await roomStore.endSession(roomId)
        // Retiring the code makes any future join refuse with `room:ended`.
        logger.info('session.window.expired', { roomId })
      }
    } catch (err) {
      logger.error('session.expiry.failed', { err: err instanceof Error ? err.message : String(err) })
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => void tick(), EXPIRY_POLL_MS)
  timer.unref()
  return () => clearInterval(timer)
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
 * Explicit early end (client `session:end`): retire the room and notify the other
 * member so it drops to the "room closed" screen. The store drops the room from the
 * expiry index as it retires it, so the poller finds nothing later.
 */
export async function endRoom(socket: AppSocket, roomId: string): Promise<void> {
  await roomStore.endSession(roomId)
  socket.to(roomId).emit(SocketEvents.roomEnded)
  logger.info('session.end', { roomId })
}
