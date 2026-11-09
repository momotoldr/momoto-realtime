/**
 * Minimal structured JSON logger. Keep log entries free of PII and secrets.
 *
 * A live room's code is what lets someone in, so `roomId` is cut to its first characters
 * everywhere, here, in one place. That is still enough to find a room's lines in the logs.
 */
type Level = 'info' | 'warn' | 'error'

function maskRoomId(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof meta?.roomId !== 'string') return meta
  return { ...meta, roomId: `${meta.roomId.slice(0, 3)}***` }
}

function emit(level: Level, event: string, meta?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...maskRoomId(meta),
  })
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

export const logger = {
  info: (event: string, meta?: Record<string, unknown>) => emit('info', event, meta),
  warn: (event: string, meta?: Record<string, unknown>) => emit('warn', event, meta),
  error: (event: string, meta?: Record<string, unknown>) => emit('error', event, meta),
}
