/**
 * Exercise the room rules against a running server and say which one broke.
 *
 *   npm run check:rooms                 # boots a local server on a spare port
 *   npm run check:rooms -- --target https://realtime-staging.momotoldr.com \
 *                          --origin https://staging.momotoldr.com
 *   npm run check:rooms -- --slow       # also waits out a whole session window
 *
 * **This is the regression net for the room store.** The rules it asserts — join
 * ordering, host order, seat reclaim, the capacity valve, retirement — are written on
 * the `RoomStore` interface, and both implementations have to obey them: the in-memory
 * one today, the Redis one that lets rooms outlive a deploy. Run it against a local
 * server while changing the store, and against staging after deploying one.
 *
 * It only speaks the public interface (HTTP + socket events), so it proves the same
 * things a browser would, and proves them identically whichever store is running.
 *
 * Two halves. The first is the room store — join ordering, seats, windows, retirement.
 * The second is everything else a live booth depends on: the synchronized capture
 * events, the peer and strip relays, and the membership guard that keeps a relay inside
 * its room. Both halves run over the same socket surface a browser uses, which is the
 * only way to be sure a change under the store did not quietly alter the booth.
 *
 * `--slow` adds the checks that wait for a real session window to expire. Skipped by
 * default because staging's window is five minutes.
 */
import { spawn, type ChildProcess } from 'node:child_process'

import { io, type Socket } from 'socket.io-client'

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const failures: string[] = []
let checks = 0

function ok(label: string, passed: boolean, detail = ''): void {
  checks += 1
  const mark = passed ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
  console.log(`${mark} ${label}${detail ? ` ${DIM}— ${detail}${RESET}` : ''}`)
  if (!passed) failures.push(label)
}

const note = (msg: string): void => console.log(`  ${DIM}${msg}${RESET}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const target = flag('target')
const origin = flag('origin') ?? 'http://localhost:5173'
const slow = process.argv.includes('--slow')

/** A local server, so the default run needs nothing prepared. */
const LOCAL_PORT = 3994
/** Short enough that `--slow` is bearable locally; staging keeps its own 5 minutes. */
const LOCAL_WINDOW_MS = 8_000

interface Joined {
  roomId: string
  selfId: string
  members: string[]
  capacity: number
}

async function main(): Promise<number> {
  let server: ChildProcess | null = null
  const url = target ?? `http://127.0.0.1:${LOCAL_PORT}`

  console.log('')
  console.log('Room rules')
  console.log('──────────')
  note(`target: ${url}${target ? '' : '  (local server, started by this script)'}`)

  if (!target) {
    server = spawn('npx', ['tsx', 'src/index.ts'], {
      env: {
        ...process.env,
        PORT: String(LOCAL_PORT),
        ROOM_CAPACITY_MAX: '4',
        SESSION_DURATION_MS: String(LOCAL_WINDOW_MS),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
  }

  const sockets: Socket[] = []
  const connect = (clientId: string): Promise<Socket> =>
    new Promise((resolve, reject) => {
      const socket = io(url, {
        transports: ['websocket'],
        reconnection: false,
        auth: { token: '', clientId },
      })
      sockets.push(socket)
      socket.on('connect', () => resolve(socket))
      socket.on('connect_error', reject)
    })

  /** Resolve with the event's payload, or `null` if it never arrives. */
  const expect = <T = unknown>(socket: Socket, event: string, ms = 4_000): Promise<T | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms)
      socket.once(event, (payload: T) => {
        clearTimeout(timer)
        resolve(payload ?? (true as T))
      })
    })

  const createRoom = async (capacity: number): Promise<string> => {
    const res = await fetch(`${url}/rooms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ capacity }),
    })
    const body = (await res.json()) as { roomId?: string }
    if (!body.roomId) throw new Error(`POST /rooms answered ${res.status}`)
    return body.roomId
  }

  const lookup = async (roomId: string): Promise<{ status: string; capacity: number | null }> =>
    (await (await fetch(`${url}/rooms/${roomId}`, { headers: { origin } })).json()) as {
      status: string
      capacity: number | null
    }

  try {
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(`${url}/healthz`)).ok) break
      } catch {
        /* not up yet */
      }
      await sleep(250)
    }

    // ── A date room, from mint to full ───────────────────────────────────────
    const room = await createRoom(2)
    ok('POST /rooms mints a code', /^[A-Z0-9]{6}$/.test(room), room)

    const host = await connect('check-host')
    const hostJoin = expect<Joined>(host, 'room:joined')
    host.emit('room:join', room)
    const hostJoined = await hostJoin
    ok('host joins an empty room', hostJoined?.members.length === 1)
    ok('capacity travels with the join', hostJoined?.capacity === 2)

    const guest = await connect('check-guest')
    const hostSeesPeer = expect(host, 'room:peer-joined')
    const windowOpens = expect<{ endsAt: number }>(host, 'session:window')
    const guestJoin = expect<Joined>(guest, 'room:joined')
    guest.emit('room:join', room)
    const guestJoined = await guestJoin
    ok('guest joins, both members listed', guestJoined?.members.length === 2)
    ok('host is told about the guest', (await hostSeesPeer) !== null)

    const firstWindow = await windowOpens
    ok('window opens when a two-seat room fills', firstWindow !== null)

    const full = await lookup(room)
    ok('pre-join lookup reports full', full.status === 'full', JSON.stringify(full))

    const extra = await connect('check-extra')
    const refused = expect(extra, 'room:full')
    extra.emit('room:join', room)
    ok('a third client is refused', (await refused) !== null)

    // ── The reconnect takeover ───────────────────────────────────────────────
    // The subtlest rule in the store, and the one a deploy leans on hardest: the same
    // client coming back takes its own seat *in place* rather than arriving as a
    // stranger, so host order survives and the peer never sees its friend leave.
    const returning = await connect('check-guest')
    const oldSocketDropped = new Promise<boolean>((resolve) => {
      guest.once('disconnect', () => resolve(true))
    })
    const phantomLeave = expect(host, 'room:peer-left', 2_000)
    const rejoin = expect<Joined>(returning, 'room:joined')
    const resumed = expect<{ endsAt: number }>(returning, 'session:window')
    returning.emit('room:join', room)

    const rejoined = await rejoin
    ok('returning client reclaims its seat', rejoined?.members.length === 2)
    ok('host order is unchanged', rejoined?.members[0] === hostJoined?.members[0])
    ok(
      'superseded socket is disconnected',
      (await Promise.race([oldSocketDropped, sleep(3_000).then(() => false)])) === true,
    )
    ok('no phantom peer-left reaches the host', (await phantomLeave) === null)
    ok(
      'window resumes with the same endsAt',
      (await resumed)?.endsAt === firstWindow?.endsAt,
      `endsAt=${firstWindow?.endsAt}`,
    )

    // ── Codes that should not let you in ─────────────────────────────────────
    const stray = await connect('check-stray')
    const notFound = expect(stray, 'room:not-found')
    stray.emit('room:join', 'ZZZZZZ')
    ok('an unminted code is refused, not created', (await notFound) !== null)

    const ended = expect(returning, 'room:ended')
    host.emit('session:end', room)
    ok('the peer is told when the host ends it', (await ended) !== null)
    await sleep(400)
    const retired = await lookup(room)
    ok('the code is retired', retired.status === 'ended', JSON.stringify(retired))

    const late = await connect('check-late')
    const lateRefused = expect(late, 'room:ended')
    late.emit('room:join', room)
    ok('a straggler gets the closed screen, not a fresh room', (await lateRefused) !== null)

    // ── Group rooms have their own floor ─────────────────────────────────────
    const group = await createRoom(4)
    const g1 = await connect('check-g1')
    const g2 = await connect('check-g2')
    const g1Join = expect<Joined>(g1, 'room:joined')
    g1.emit('room:join', group)
    await g1Join
    const g2Join = expect<Joined>(g2, 'room:joined')
    g2.emit('room:join', group)
    await g2Join
    ok(
      'a group room does not auto-start at two',
      (await expect(g1, 'session:window', 1_500)) === null,
    )

    g2.emit('session:open')
    ok('a non-host cannot open the window', (await expect(g1, 'session:window', 1_500)) === null)
    g1.emit('session:open')
    ok(
      'the host cannot open it under the floor',
      (await expect(g1, 'session:window', 1_500)) === null,
    )

    const g3 = await connect('check-g3')
    const g3Join = expect<Joined>(g3, 'room:joined')
    g3.emit('room:join', group)
    await g3Join
    const groupWindow = expect(g1, 'session:window', 3_000)
    g1.emit('session:open')
    ok('the host opens it once three are present', (await groupWindow) !== null)
    g1.emit('session:end', group)

    // ── A live booth: capture sync, relays, and the membership guard ─────────
    // Everything above is the store. Everything here is what two people actually do
    // once they are in a room together, and it all flows through the same handlers the
    // store refactor touched.
    const booth = await createRoom(2)
    const alice = await connect('check-alice')
    const bob = await connect('check-bob')
    const aliceJoin = expect<Joined>(alice, 'room:joined')
    alice.emit('room:join', booth)
    const aliceJoined = await aliceJoin
    const bobJoin = expect<Joined>(bob, 'room:joined')
    bob.emit('room:join', booth)
    await bobJoin
    const aliceId = aliceJoined?.selfId ?? ''

    // The clock handshake every client runs before it can schedule anything.
    const t0 = Date.now()
    const echo = expect<{ t0: number; t1: number }>(alice, 'time:sync:res', 3_000)
    alice.emit('time:sync', t0)
    const clock = await echo
    ok(
      'time:sync echoes the client stamp with the server clock',
      clock?.t0 === t0 && typeof clock.t1 === 'number',
    )

    // A synchronized countdown: one instant, sent to everyone including the sender.
    const aliceCountdown = expect<{ startAt: number }>(alice, 'session:countdown-start', 3_000)
    const bobCountdown = expect<{ startAt: number }>(bob, 'session:countdown-start', 3_000)
    alice.emit('session:start')
    const [aStart, bStart] = [await aliceCountdown, await bobCountdown]
    ok('session:start reaches both members', aStart !== null && bStart !== null)
    ok(
      'both are given the same start instant',
      aStart?.startAt === bStart?.startAt,
      `startAt=${aStart?.startAt}`,
    )

    // A single-slot retake, likewise synced to both.
    const aliceRetake = expect<{ slot: number; startAt: number }>(
      alice,
      'session:retake-start',
      3_000,
    )
    const bobRetake = expect<{ slot: number; startAt: number }>(bob, 'session:retake-start', 3_000)
    bob.emit('session:retake', { slot: 2 })
    const [aRetake, bRetake] = [await aliceRetake, await bobRetake]
    ok('session:retake syncs the slot to both', aRetake?.slot === 2 && bRetake?.slot === 2)
    ok(
      'a guest may drive capture, not only the host',
      aRetake !== null,
      'the UI offers Retake to both',
    )

    // "Retake all" is the one capture event that must NOT come back to its sender.
    const bobReset = expect(bob, 'session:reset', 3_000)
    const aliceReset = expect(alice, 'session:reset', 1_500)
    alice.emit('session:reset')
    ok('session:reset reaches the other member', (await bobReset) !== null)
    ok('session:reset does not echo to its sender', (await aliceReset) === null)

    // Peer discovery: the broadcast announce, with `from` stamped by the server.
    const bobAnnounce = expect<{ peerJsId: string; from: string; directed: boolean }>(
      bob,
      'peer:announce',
      3_000,
    )
    alice.emit('peer:announce', { peerJsId: 'peerjs-alice' })
    const announced = await bobAnnounce
    ok('peer:announce is relayed to the room', announced?.peerJsId === 'peerjs-alice')
    ok('the server stamps `from` from the connection', announced?.from === aliceId)
    ok('a broadcast announce is marked undirected', announced?.directed === false)

    // The directed announce, which is the path that consults room membership.
    const directed = expect<{ directed: boolean; from: string }>(bob, 'peer:announce', 3_000)
    alice.emit('peer:announce', { peerJsId: 'peerjs-alice', to: (await bobJoin)?.selfId ?? '' })
    ok('a directed announce reaches its target', (await directed)?.directed === true)

    // …and the guard behind it: a socket outside the room is not a valid target.
    const outsider = await connect('check-outsider')
    const leaked = expect(outsider, 'peer:announce', 1_500)
    alice.emit('peer:announce', { peerJsId: 'peerjs-alice', to: outsider.id })
    ok('an announce cannot be aimed at a socket outside the room', (await leaked) === null)

    // Media state and the strip relays, forwarded verbatim.
    const mediaState = expect<{ cam: boolean; mic: boolean; from: string }>(
      bob,
      'peer:media-state',
      3_000,
    )
    alice.emit('peer:media-state', { cam: false, mic: true })
    const media = await mediaState
    ok(
      'peer:media-state is relayed with `from`',
      media?.cam === false && media.mic === true && media.from === aliceId,
    )

    const config = expect<{ layout: string; color: string | null; confirmed: boolean }>(
      bob,
      'strip:config',
      3_000,
    )
    alice.emit('strip:config', { layout: 'ribbon-4x1', color: 'cream', confirmed: true })
    const relayedConfig = await config
    ok(
      'strip:config is relayed verbatim',
      relayedConfig?.layout === 'ribbon-4x1' && relayedConfig.color === 'cream',
    )

    const shots = expect<{ hasShots: boolean }>(bob, 'strip:shots', 3_000)
    alice.emit('strip:shots', { hasShots: true })
    ok('strip:shots is relayed', (await shots)?.hasShots === true)

    const createdStrip = expect<{ from: string }>(bob, 'strip:created', 3_000)
    alice.emit('strip:created')
    ok('strip:created names who finalized it', (await createdStrip)?.from === aliceId)

    // Malformed payloads are dropped rather than relayed.
    const badConfig = expect(bob, 'strip:config', 1_500)
    alice.emit('strip:config', { layout: 42, color: 'cream', confirmed: 'yes' })
    ok('a malformed strip:config is not relayed', (await badConfig) === null)

    // And a socket cannot retire a room it never joined.
    const strangerEnd = await connect('check-stranger')
    const wrongfulEnd = expect(bob, 'room:ended', 1_500)
    strangerEnd.emit('session:end', booth)
    ok("a stranger cannot end someone else's session", (await wrongfulEnd) === null)

    alice.emit('session:end', booth)
    await sleep(300)

    // TURN credentials: not part of the store, but the booth cannot hold a call without
    // them, so a green room suite that hid a broken TURN route would be misleading.
    const turn = await fetch(`${url}/turn-credentials`, { headers: { origin } })
    const turnBody = (await turn.json()) as {
      iceServers?: { urls?: string | string[]; credential?: string }[]
    }
    const iceUrls = (turnBody.iceServers ?? []).flatMap((entry) =>
      Array.isArray(entry.urls) ? entry.urls : entry.urls ? [entry.urls] : [],
    )
    const relayUrls = iceUrls.filter((u) => u.startsWith('turn:') || u.startsWith('turns:'))
    const credentialed = (turnBody.iceServers ?? []).some(
      (entry) => typeof entry.credential === 'string' && entry.credential.length > 0,
    )
    ok(
      'ICE servers are served',
      turn.ok && iceUrls.length > 0,
      `${turn.status}, ${iceUrls.length} url(s)`,
    )
    if (relayUrls.length > 0) {
      // A TURN url with no credential is the silent failure worth catching: the browser
      // accepts the config, never authenticates, and falls back to STUN — so a call
      // works on an open network and fails behind a symmetric NAT, which is exactly the
      // case TURN exists for.
      ok('TURN relay is offered with a credential', credentialed, relayUrls.join(', '))
    } else {
      note('no TURN relay configured on this target — STUN only (expected locally)')
    }

    // ── Expiry (only with --slow: staging's window is five minutes) ───────────
    if (slow) {
      const timed = await createRoom(2)
      const t1 = await connect('check-t1')
      const t2 = await connect('check-t2')
      const t1Join = expect<Joined>(t1, 'room:joined')
      t1.emit('room:join', timed)
      await t1Join
      const window2 = expect<{ endsAt: number }>(t1, 'session:window', 5_000)
      const t2Join = expect<Joined>(t2, 'room:joined')
      t2.emit('room:join', timed)
      await t2Join
      const opened = await window2
      const remaining = Math.max(0, (opened?.endsAt ?? Date.now()) - Date.now())
      note(`waiting ${Math.round(remaining / 1000)}s for the window to expire…`)
      ok(
        'session:expired arrives when the window ends',
        (await expect(t1, 'session:expired', remaining + 15_000)) !== null,
      )
      await sleep(500)
      const afterExpiry = await lookup(timed)
      ok('an expired room is retired', afterExpiry.status === 'ended', JSON.stringify(afterExpiry))
    } else {
      note('skipping window-expiry checks (pass --slow to include them)')
    }
  } catch (err) {
    ok('the suite ran without throwing', false, err instanceof Error ? err.message : String(err))
  } finally {
    for (const socket of sockets) socket.close()
    if (server) {
      server.kill('SIGTERM')
      await sleep(400)
      server.kill('SIGKILL')
    }
  }

  console.log('')
  if (failures.length === 0) {
    console.log(`${GREEN}✓${RESET} all ${checks} room rules hold`)
    console.log('')
    return 0
  }
  console.log(`${RED}✗${RESET} ${failures.length} of ${checks} failed:`)
  for (const failure of failures) console.log(`  ${RED}·${RESET} ${failure}`)
  console.log('')
  return 1
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err)
    process.exit(1)
  },
)
