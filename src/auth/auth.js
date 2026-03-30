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
        // Optionally ensure the user still exists and is active.
        let userIsActive = true;

        if (typeof db.getUserById === 'function' && payload.userId != null) {
          try {
            const dbUser = db.getUserById(payload.userId);

            if (!dbUser || dbUser.is_active === 0 || dbUser.is_active === false) {
              userIsActive = false;
            }
          } catch (e) {
            // On DB lookup failure, err on the side of denying access.
            userIsActive = false;
          }
        }

        if (!userIsActive) {
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
