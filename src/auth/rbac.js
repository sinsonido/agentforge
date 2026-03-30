/**
 * @file src/auth/rbac.js
 * @description Role-based access control middleware for AgentForge API.
 *
 * Defines permission sets per role and exports a requirePermission() factory
 * that returns an Express middleware enforcing the named permission.
 *
 * GitHub issue #98
 */

/**
 * The set of valid role names.
 * Used for role validation in both RBAC and API endpoints.
 * @type {Set<string>}
 */
export const VALID_ROLES = new Set(['admin', 'operator', 'viewer']);

/**
 * Permission sets per role.
 * @type {Record<string, Set<string>>}
 */
const ROLE_PERMISSIONS = {
  admin: new Set(['users:read', 'users:write', 'tasks:read', 'tasks:write', 'system:read', 'system:write']),
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
 * In test mode (NODE_ENV === 'test'), permission checks are bypassed so
 * tests can run without a full auth stack. In all other environments,
 * the request must have an authenticated user and the required permission.
 *
 * @param {string} permission
 * @returns {import('express').RequestHandler}
 */
/**
 * Express middleware factory.
 *
 * In test mode (NODE_ENV === 'test') permission checks are bypassed unless
 * `enforce` is explicitly set to true, so that tests can run without a full
 * auth stack while still allowing RBAC-enforcement tests to opt in.
 *
 * @param {string} permission
 * @param {{ enforce?: boolean }} [opts]
 * @returns {import('express').RequestHandler}
 */
export function requirePermission(permission, { enforce = false } = {}) {
  return (req, res, next) => {
    // Skip RBAC checks in test mode unless enforcement is explicitly requested.
    if (!enforce && process.env.NODE_ENV === 'test') {
      return next();
    }

    // In non-test environments (or when enforce=true), missing auth is unauthorized.
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    if (!hasPermission(req.user.role, permission)) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    next();
  };
}
