/**
 * The deploy drill: does a live booth survive a redeploy of this service?
 *
 *   npm run drill:deploy -- --target https://realtime-staging.momotoldr.com \
 *                           --origin https://staging.momotoldr.com
 *   npm run drill:deploy -- --expect lose      # assert the pre-Redis behaviour instead
 *   npm run drill:deploy -- --slow             # also wait out the window on the far side
 *
 * This is the acceptance test for the Redis room store (`docs/PLAN-redis.md`). It holds
 * a real two-person session open, waits for the operator to redeploy the service, and
 * then asks the only question that matters: **did the same room, with the same host and
 * the same `endsAt`, still exist on the other side?**
 *
 * Run it *before* the Redis store lands with `--expect lose` — that is the bug, recorded
 * as a passing test. Run it with the default `--expect survive` afterwards, and it is
 * the gate that says the work is done.
 *
 * What it deliberately does not do is trigger the deploy itself. Doing that would mean
 * carrying Railway credentials and a service id inside the repo, for a script whose
 * whole job is to watch from the outside — so it waits for the disconnect instead and
 * tells the operator when to press the button.
 *
 * `--slow` adds the other half of the promise, and the one that only a poll can keep: it
 * waits for the session window — opened by the process that is now gone — to run out,
 * and checks that the *replacement* ends it. A timer would have died with the old
 * process and the room would simply run forever.
 *
 * It also reports how long the reconnect took, which is the number the capture path
 * lives or dies by: a gap longer than `OFFLINE_CAPTURE_GRACE_MS` (4s in the frontend)
 * discards a countdown in progress, so a technically-surviving room can still cost a
 * shot.
 */
import { io, type Socket } from 'socket.io-client'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/** The frontend's budget for a disconnect that must not cost a countdown. */
const CAPTURE_GRACE_MS = 4_000

const failures: string[] = []
function ok(label: string, passed: boolean, detail = ''): void {
  const mark = passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
  console.log(`${mark} ${label}${detail ? ` ${DIM}— ${detail}${RESET}` : ''}`)
  if (!passed) failures.push(label)
}
const note = (msg: string): void => console.log(`  ${DIM}${msg}${RESET}`)
const loud = (msg: string): void => console.log(`${YELLOW}➜${RESET} ${msg}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const url = flag('target') ?? 'http://127.0.0.1:3003'
const origin = flag('origin') ?? 'http://localhost:5173'
const expectSurvive = (flag('expect') ?? 'survive') !== 'lose'
const slow = process.argv.includes('--slow')
/** How long to wait for the operator to start the deploy. */
const PATIENCE_MS = Number(flag('patience') ?? 420_000)

interface Joined {
  roomId: string
  selfId: string
  members: string[]
  capacity: number
}

/** One participant: a socket that reconnects and re-joins exactly like the frontend. */
class Participant {
  readonly socket: Socket
  /** Terminal events are recorded rather than awaited — any of them is a failed drill. */
  sawEnded = false
  sawNotFound = false
  sawPeerLeft = false
  sawExpired = false
  droppedAt: number | null = null
  reconnectedAt: number | null = null
  /**
   * The last window and join payloads, recorded as they arrive.
   *
   * Not awaited after the fact: the re-join fires the instant the socket reconnects, so
   * a listener attached later than that misses it and reports a healthy room as broken.
   */
  lastWindow: { endsAt: number } | null = null
  lastJoined: Joined | null = null

  constructor(
    readonly name: string,
    clientId: string,
    readonly roomId: string,
  ) {
    this.socket = io(url, {
      transports: ['websocket'],
      auth: { token: '', clientId },
      reconnectionDelay: 500,
      reconnectionDelayMax: 2_000,
    })
    this.socket.on('session:window', (payload: { endsAt: number }) => (this.lastWindow = payload))
    this.socket.on('room:joined', (payload: Joined) => (this.lastJoined = payload))
    this.socket.on('room:ended', () => (this.sawEnded = true))
    this.socket.on('room:not-found', () => (this.sawNotFound = true))
    this.socket.on('room:peer-left', () => (this.sawPeerLeft = true))
    this.socket.on('session:expired', () => (this.sawExpired = true))
    this.socket.on('disconnect', () => {
      this.droppedAt ??= Date.now()
    })
    this.socket.on('connect', () => {
      if (this.droppedAt !== null && this.reconnectedAt === null) {
        this.reconnectedAt = Date.now()
        // Exactly what `useRoom` does on every (re)connect.
        this.socket.emit('room:join', this.roomId)
      }
    })
  }

  join(): Promise<Joined | null> {
    const joined = this.next<Joined>('room:joined')
    this.socket.emit('room:join', this.roomId)
    return joined
  }

  next<T>(event: string, ms = 5_000): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms)
      this.socket.once(event, (payload: T) => {
        clearTimeout(timer)
        resolve(payload ?? (true as T))
      })
    })
  }

  get gapMs(): number | null {
    return this.droppedAt !== null && this.reconnectedAt !== null
      ? this.reconnectedAt - this.droppedAt
      : null
  }
}

async function main(): Promise<number> {
  console.log('')
  console.log('Deploy drill')
  console.log('────────────')
  note(`target: ${url}`)
  note(`expecting the room to ${expectSurvive ? 'SURVIVE' : 'be LOST'} the redeploy`)
  console.log('')

  const created = await fetch(`${url}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ capacity: 2 }),
  })
  const { roomId } = (await created.json()) as { roomId: string }
  ok('a room was minted', typeof roomId === 'string', roomId)

  const host = new Participant('host', 'drill-host', roomId)
  const guest = new Participant('guest', 'drill-guest', roomId)

  const hostJoined = await host.join()
  const windowOpens = host.next<{ endsAt: number }>('session:window')
  const guestJoined = await guest.join()
  const before = await windowOpens

  ok('both people are in the room', guestJoined?.members.length === 2)
  ok('the session window is running', before !== null, `endsAt=${before?.endsAt}`)
  if (!hostJoined || !guestJoined || !before) {
    note('the room never reached a live state — nothing to drill')
    return 1
  }

  console.log('')
  loud(`Redeploy the service now. Room ${roomId} is live with two people in it.`)
  note(`waiting up to ${Math.round(PATIENCE_MS / 60_000)} minutes for the disconnect…`)
  console.log('')

  const deadline = Date.now() + PATIENCE_MS
  while (Date.now() < deadline && host.droppedAt === null && guest.droppedAt === null) {
    await sleep(500)
  }
  if (host.droppedAt === null && guest.droppedAt === null) {
    ok('a redeploy happened', false, 'no disconnect seen before the deadline')
    return 1
  }
  ok('the connection dropped, as a redeploy does', true)

  // Give both sides time to reconnect and re-join before judging anything.
  const settleBy = Date.now() + 30_000
  while (Date.now() < settleBy && (host.reconnectedAt === null || guest.reconnectedAt === null)) {
    await sleep(250)
  }
  await sleep(1_500)

  const hostGap = host.gapMs
  const guestGap = guest.gapMs
  ok(
    'both clients reconnected',
    hostGap !== null && guestGap !== null,
    `host=${hostGap}ms guest=${guestGap}ms`,
  )
  ok(
    `the gap stayed inside the ${CAPTURE_GRACE_MS}ms capture budget`,
    (hostGap ?? Infinity) < CAPTURE_GRACE_MS && (guestGap ?? Infinity) < CAPTURE_GRACE_MS,
    'a longer gap discards a countdown in progress',
  )

  // The verdict: is the room still the same room?
  const status = (await (
    await fetch(`${url}/rooms/${roomId}`, { headers: { origin } })
  ).json()) as {
    status: string
    members: number
  }
  const survived = status.status === 'full' || status.status === 'open'

  console.log('')
  console.log('After the redeploy')
  console.log('──────────────────')
  ok('the room still exists', survived, JSON.stringify(status))
  ok('nobody was told the room ended', !host.sawEnded && !guest.sawEnded)
  ok('nobody was told the room was not found', !host.sawNotFound && !guest.sawNotFound)
  ok('neither saw their friend leave', !host.sawPeerLeft && !guest.sawPeerLeft)

  if (survived) {
    ok(
      'the window resumed with the same endsAt',
      host.lastWindow?.endsAt === before.endsAt,
      `before=${before.endsAt} after=${host.lastWindow?.endsAt ?? 'none'}`,
    )
    ok(
      'both were readmitted to the room',
      host.lastJoined?.members.length === 2 && guest.lastJoined?.members.length === 2,
      `host sees ${host.lastJoined?.members.length ?? 0}, guest sees ${guest.lastJoined?.members.length ?? 0}`,
    )
    ok(
      'host order survived',
      host.lastJoined?.members[0] === host.lastJoined?.selfId,
      'the first member is still the host',
    )

    if (slow) {
      // The window was opened by a process that no longer exists. Nothing is counting
      // it down but the replacement's poll of shared state — which is the whole reason
      // expiry stopped being a per-room timer.
      const remaining = Math.max(0, before.endsAt - Date.now())
      console.log('')
      note(`waiting ${Math.round(remaining / 1000)}s for the inherited window to run out…`)
      const deadline = Date.now() + remaining + 20_000
      while (Date.now() < deadline && !(host.sawExpired && guest.sawExpired)) {
        await sleep(500)
      }
      ok(
        'the replacement ended a window it did not start',
        host.sawExpired && guest.sawExpired,
        `host=${host.sawExpired} guest=${guest.sawExpired}`,
      )
      await sleep(1_000)
      const retired = (await (
        await fetch(`${url}/rooms/${roomId}`, { headers: { origin } })
      ).json()) as { status: string }
      ok('and retired the room', retired.status === 'ended', JSON.stringify(retired))
    }
  }

  host.socket.close()
  guest.socket.close()

  console.log('')
  if (expectSurvive) {
    if (failures.length === 0) {
      console.log(`${GREEN}✓${RESET} the booth survived a redeploy — this is what Redis is for`)
      console.log('')
      return 0
    }
    console.log(`${RED}✗${RESET} the booth did not survive:`)
    for (const failure of failures) console.log(`  ${RED}·${RESET} ${failure}`)
    if (!survived) {
      note('If the Redis room store is not wired yet, this is the expected result —')
      note('re-run with `--expect lose` to record it as the baseline.')
    }
    console.log('')
    return 1
  }

  // `--expect lose`: the pre-Redis baseline. The room *should* be gone.
  console.log(
    survived
      ? `${RED}✗${RESET} the room survived, which --expect lose says it should not have`
      : `${GREEN}✓${RESET} the room was lost, exactly as it is before the Redis store lands`,
  )
  console.log('')
  return survived ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)
