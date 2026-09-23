/**
 * Whether this process is on its way out.
 *
 * One boolean, in its own module because two very different places need it and neither
 * should own it: `/healthz` answers 503 while it is set, so nothing new is routed here,
 * and the socket `disconnect` handler uses it to tell a **drain** apart from a **leave**.
 *
 * That second use is the subtle one. When this process closes its sockets on the way
 * out, every client is about to reconnect to the replacement and reclaim its seat. If
 * the disconnect handler ran the usual `leave`, the room would lose a member and the
 * other person would be told their friend left — a second before that friend reappears.
 * So a drain deliberately leaves the seats occupied, and the seats of anyone who never
 * comes back are freed by the sweeper instead (see `GHOST_GRACE_MS`).
 */
let draining = false

export function isDraining(): boolean {
  return draining
}

export function beginDraining(): void {
  draining = true
}
