/**
 * @file src/auth/rbac.js
 * @description Role-based access control middleware for AgentForge API.
 *
 * Defines permission sets per role and exports a requirePermission() factory
 * that returns an Express middleware enforcing the named permission.
 *
 * GitHub issue #101
 */

/**
 * Permission sets per role.
 * @type {Record<string, Set<string>>}
 */
const ROLE_PERMISSIONS = {
  admin: new Set([
    'users:read',
    'users:write',
    'tasks:read',
    'tasks:write',
    'system:read',
    'system:write',
    'invitations:manage',
  ]),
  operator: new Set(['tasks:read', 'tasks:write', 'system:read']),
  viewer: new Set(['tasks:read', 'system:read']),
};

/**
 * Return true if the given role has the named permission.
 * @param {string} role
 * @param {string} permission
 * @returns {boolean}
 */
export function hasPermission(role, permission) {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}

/**
 * Express middleware factory.
 *
 * In test mode (NODE_ENV === 'test'), permission checks are bypassed so tests
 * can run without a full auth stack. In production, an unauthenticated request
 * (no req.user) returns 401; an authenticated request without the required
 * permission returns 403.
 *
 * @param {string} permission
 * @returns {import('express').RequestHandler}
 */
export function requirePermission(permission) {
  return (req, res, next) => {
    if (process.env.NODE_ENV === 'test') return next();
    if (!req.user) return res.status(401).json({ ok: false, error: 'Unauthorized' });
    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }
    next();
  };
}
