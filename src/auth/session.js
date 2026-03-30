/**
 * @file src/auth/session.js
 * @description Minimal JWT-like session utilities for AgentForge.
 *
 * Uses a simple HMAC-SHA256 signed token format:
 *   base64(header).base64(payload).base64(signature)
 *
 * The JWT payload includes: { sub, username, role, iat, exp }
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Secret used to sign tokens — in production set AUTH_SECRET env var.
const SECRET = process.env.AUTH_SECRET ?? 'agentforge-dev-secret-change-in-production';

/** Token lifetime in seconds (default 24 h). */
const _rawTTL = parseInt(process.env.AUTH_TOKEN_TTL ?? '86400', 10);
if (!Number.isFinite(_rawTTL) || _rawTTL <= 0) {
  throw new Error(`AUTH_TOKEN_TTL must be a positive integer; got '${process.env.AUTH_TOKEN_TTL}'`);
}
const TOKEN_TTL = _rawTTL;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

function b64url(str) {
  return Buffer.from(str).toString('base64url');
}

function fromB64url(str) {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function sign(data) {
  return createHmac('sha256', SECRET).update(data).digest('base64url');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a signed JWT-style token for a user.
 *
 * @param {{ id: string, username: string, role: string }} user
 * @returns {string} signed token
 */
export function createToken(user) {
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    sub:      user.id,
    username: user.username,
    role:     user.role,
    iat:      Math.floor(Date.now() / 1000),
    exp:      Math.floor(Date.now() / 1000) + TOKEN_TTL,
  }));
  const sig = sign(`${header}.${payload}`);
  return `${header}.${payload}.${sig}`;
}

/**
 * Verify and decode a token.
 *
 * @param {string} token
 * @returns {{ sub: string, username: string, role: string, iat: number, exp: number } | null}
 */
export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;

  // Timing-safe signature comparison to prevent timing attacks.
  const expected = sign(`${header}.${payload}`);
  const sigBuf = Buffer.from(sig, 'base64url');
  const expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const data = JSON.parse(fromB64url(payload));
    // Require exp to be a finite positive number; tokens without a valid exp are rejected.
    if (!Number.isFinite(data.exp) || data.exp <= 0) return null;
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Generate a random static API token (for non-user machine access).
 * @returns {string}
 */
export function generateStaticToken() {
  return randomBytes(32).toString('hex');
}
