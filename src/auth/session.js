/**
 * @file src/auth/session.js
 * @description JWT session management — sign, verify, revoke.
 *
 * The JWT secret is stored in db_settings('jwt_secret'). On first use it is
 * randomly generated, persisted, and reused across restarts.
 */

import jwt from 'jsonwebtoken';
import { randomBytes, randomUUID } from 'node:crypto';

const JWT_EXPIRY = '24h';
/** Expiry in seconds used when storing revoked jti in the DB */
const JWT_EXPIRY_SECONDS = 24 * 60 * 60;

/**
 * Per-DB in-process cache so we hit SQLite once per DB instance, not per
 * request.  WeakMap ensures the entry is released when the DB instance is GC'd
 * (important for test isolation where each test suite creates its own DB).
 * @type {WeakMap<object, string>}
 */
const _secretCache = new WeakMap();

/**
 * Return the JWT secret from the database, generating and persisting one if
 * it does not yet exist.  Result is cached in module scope after the first
 * read to avoid a SQLite round-trip on every authenticated request.
 *
 * @param {import('../persistence/db.js').AgentForgeDB} db
 * @returns {string}
 */
export function getJwtSecret(db) {
  if (_secretCache.has(db)) return _secretCache.get(db);
  let secret = db.getSetting('jwt_secret');
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    db.setSetting('jwt_secret', secret);
  }
  _secretCache.set(db, secret);
  return secret;
}

/**
 * Sign a JWT for the given user payload.
 *
 * @param {import('../persistence/db.js').AgentForgeDB} db
 * @param {{ userId: string, username: string, role: string }} payload
 * @returns {string} signed JWT
 */
export function signToken(db, { userId, username, role }) {
  const secret = getJwtSecret(db);
  const jti = randomUUID();
  return jwt.sign({ sub: userId, username, role, jti }, secret, {
    expiresIn: JWT_EXPIRY,
    algorithm: 'HS256',
  });
}

/**
 * Verify a JWT and return its decoded payload, or null if invalid/revoked.
 *
 * @param {import('../persistence/db.js').AgentForgeDB} db
 * @param {string} token
 * @returns {{ userId: string, username: string, role: string, jti: string, exp: number } | null}
 */
export function verifyToken(db, token) {
  try {
    const secret = getJwtSecret(db);
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    const jti = decoded.jti;
    if (!jti) return null;
    if (db.isTokenRevoked(jti)) return null;
    return {
      userId: decoded.sub,
      username: decoded.username,
      role: decoded.role,
      jti,
      exp: decoded.exp,
    };
  } catch {
    return null;
  }
}

/**
 * Revoke a JWT by storing its jti in the database.
 *
 * @param {import('../persistence/db.js').AgentForgeDB} db
 * @param {string} jti
 * @param {number} [expiresAt] - Unix timestamp (seconds). Defaults to now + 24h.
 */
export function revokeToken(db, jti, expiresAt) {
  const exp = expiresAt ?? Math.floor(Date.now() / 1000) + JWT_EXPIRY_SECONDS;
  db.revokeToken(jti, exp);
}
