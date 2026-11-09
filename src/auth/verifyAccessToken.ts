import jwt from 'jsonwebtoken'

import { env } from '../config/env.js'

/**
 * Verification only. Access tokens are minted by `momoto-core` (`auth/tokens.ts`), which
 * also owns refresh rotation and revocation against Postgres. This service just checks
 * the signature on the socket handshake — no database, no TTLs.
 *
 * Each algorithm is tied to its own key and only allowed when that key is configured, so
 * removing `JWT_SECRET` is what finishes the move to `JWT_PUBLIC_KEY`.
 */

/** Verified access-token claims we rely on. */
export interface AccessClaims {
  /** User id. */
  sub: string
}

/** Verifies an access JWT, returning its claims. Throws if invalid/expired. */
export function verifyAccessToken(token: string): AccessClaims {
  const algorithm = jwt.decode(token, { complete: true })?.header.alg
  let payload: string | jwt.JwtPayload
  if (algorithm === 'ES256' && env.jwtPublicKey) {
    payload = jwt.verify(token, env.jwtPublicKey, { algorithms: ['ES256'] })
  } else if (algorithm === 'HS256' && env.jwtSecret) {
    payload = jwt.verify(token, env.jwtSecret, { algorithms: ['HS256'] })
  } else {
    throw new Error('unexpected token algorithm')
  }
  if (typeof payload === 'string' || typeof payload.sub !== 'string') {
    throw new Error('malformed access token')
  }
  return { sub: payload.sub }
}
