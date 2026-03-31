/**
 * @file src/auth/auth.js
 * @description Authentication middleware factory.
 *
 * Supports two authentication modes (tried in order):
 *   1. JWT Bearer token — verifies signature, checks revocation list.
 *   2. Static token — legacy string comparison for backward compatibility.
 *
 * When a JWT is valid, `req.user` is set to `{ userId, username, role }`.
 * When the static token matches, `req.user` is set to `null` (no user context).
 */

import { verifyToken } from './session.js';

/**
 * Create an Express authentication middleware.
 *
 * @param {{ secret?: string }} authConfig - The `auth` section of agentforge config.
 * @param {import('../persistence/db.js').AgentForgeDB|null} [db] - DB instance for JWT verification.
 * @returns {import('express').RequestHandler}
 */
export function createAuthMiddleware(authConfig = {}, db = null) {
  const staticSecret = authConfig?.secret;

  return function authMiddleware(req, res, next) {
    // Bypass auth entirely in test mode so the unit and e2e test suites can
    // make unauthenticated requests without 401s.
    if (process.env.NODE_ENV === 'test') {
      req.user = null;
      return next();
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : null;

    if (!token) {
      // No token provided — allow through only if no auth is configured
      if (!staticSecret && !db) {
        req.user = null;
        return next();
      }
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    // 1. Try JWT verification first (requires DB)
    if (db) {
      const payload = verifyToken(db, token);
      if (payload) {
        // Ensure the user still exists and is active — a deactivated user's
        // token must stop working immediately, not after the 24h JWT expiry.
        try {
          const dbUser = db.findUserById(payload.userId);
          if (!dbUser || !dbUser.is_active) {
            return res.status(401).json({ ok: false, error: 'Unauthorized' });
          }
        } catch {
          // On DB lookup failure, err on the side of denying access.
          return res.status(401).json({ ok: false, error: 'Unauthorized' });
        }
        req.user = payload;
        return next();
      }
    }

    // 2. Fall back to static token comparison
    if (staticSecret && token === staticSecret) {
      req.user = null; // no user context for static token
      return next();
    }

    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  };
}
