/**
 * @file src/auth/auth.js
 * @description Static Bearer-token authentication middleware for AgentForge.
 *
 * GitHub issue #93
 */

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create an Express middleware that enforces Bearer-token authentication.
 *
 * Behaviour:
 * - If `authConfig.enabled` is falsy → calls `next()` immediately (auth off).
 * - If `NODE_ENV === 'test'` → calls `next()` immediately (test bypass).
 * - Exempts `GET /api/status` so load-balancers can perform health checks
 *   without a token.
 * - Reads the `Authorization: Bearer <token>` header and compares it to
 *   `authConfig.secret` using a constant-time comparison.
 * - Returns `401 { ok: false, error: "Unauthorized" }` if the token is
 *   missing or incorrect.
 *
 * @param {{ enabled?: boolean, secret?: string }} authConfig
 * @returns {import('express').RequestHandler}
 *
 * @example
 * import { createAuthMiddleware } from '../auth/auth.js';
 * app.use('/api', createAuthMiddleware(forge.config?.server?.auth ?? {}));
 */
export function createAuthMiddleware(authConfig = {}) {
  return function authMiddleware(req, res, next) {
    // Bypass in test environment
    if (process.env.NODE_ENV === 'test') {
      return next();
    }

    // Bypass when auth is disabled
    if (!authConfig.enabled) {
      return next();
    }

    // Health-check exemption — always allow GET /api/status
    if (req.method === 'GET' && req.path === '/status') {
      return next();
    }

    // Extract Bearer token from Authorization header
    const authHeader = req.headers['authorization'] ?? '';
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
    const token = match ? match[1] : null;

    if (!token || token !== authConfig.secret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    return next();
  };
}
