/**
 * @file src/auth/auth.js
 * @description Authentication middleware for AgentForge API.
 *
 * Reads the Authorization header and populates req.user:
 *   - "Bearer <jwt>"        → verifies JWT, sets req.user = { id, username, role }
 *   - "Bearer <static-key>" → matches AGENTFORGE_API_KEY, sets req.user to an
 *                             admin-role sentinel so RBAC passes all permission checks
 *   - No header (test mode) → req.user = null (RBAC is bypassed in test mode)
 *   - Invalid/expired JWT   → 401
 *
 * Auth is disabled entirely when NODE_ENV === 'test' and no AUTH_ENABLED env
 * var is set, to preserve E2E test compatibility.
 */

import { verifyToken } from './session.js';

// Auth is bypassed in test mode unless explicitly enabled.
const isTestEnv   = process.env.NODE_ENV === 'test';
const authEnabled = process.env.AUTH_ENABLED === 'true';

// Static API key (machine-to-machine access — bypasses RBAC).
const STATIC_API_KEY = process.env.AGENTFORGE_API_KEY ?? null;

/**
 * Express middleware that authenticates requests.
 *
 * On success: sets req.user (object or null) and calls next().
 * On failure: responds 401 and does NOT call next().
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function authMiddleware(req, res, next) {
  // In test mode without AUTH_ENABLED, skip all auth — req.user stays undefined/null.
  if (isTestEnv && !authEnabled) {
    req.user = null;
    return next();
  }

  const authHeader = req.headers.authorization ?? '';

  // No header → unauthenticated.
  if (!authHeader) {
    req.user = null;
    // If auth is enabled, reject unauthenticated requests.
    if (authEnabled) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    return next();
  }

  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ ok: false, error: 'Invalid authorization scheme — use Bearer' });
  }

  const token = authHeader.slice(7);

  // Static API key — grants full admin-level access (bypasses RBAC role checks).
  if (STATIC_API_KEY && token === STATIC_API_KEY) {
    req.user = { id: 'static-api-key', username: '__api_key__', role: 'admin' };
    return next();
  }

  // JWT token.
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired token' });
  }

  req.user = { id: payload.sub, username: payload.username, role: payload.role };
  next();
}
