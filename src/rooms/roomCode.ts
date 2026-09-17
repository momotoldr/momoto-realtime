import { randomInt } from 'node:crypto'

// Unambiguous uppercase alphabet — no 0/O or 1/I/L — so shared codes are easy to
// read and type. Kept short and uppercase, compatible with the FE's join input.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const DEFAULT_LENGTH = 6

/** Crypto-strong, human-friendly room code (replaces the FE's `Math.random()`). */
export function generateRoomCode(length: number = DEFAULT_LENGTH): string {
  let code = ''
  for (let i = 0; i < length; i += 1) {
    code += ALPHABET[randomInt(ALPHABET.length)]
  }
  return code
}
