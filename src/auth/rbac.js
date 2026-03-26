/**
 * @file src/auth/rbac.js
 * @description Role-based access control for AgentForge API.
 *
 * Three roles: admin > operator > viewer.
 * Each role has a set of permission strings. Routes are guarded with
 * requirePermission(permission) middleware.
 *
 * GitHub issue #97
 */

// ---------------------------------------------------------------------------
// Permissions map
// ---------------------------------------------------------------------------

/**
 * Permissions assigned to each role.
 * @type {Record<string, string[]>}
 */
export const ROLE_PERMISSIONS = {
  admin: [
    'tasks:read',    'tasks:write',
    'agents:read',   'agents:write',
    'control:start', 'control:stop',
    'review:approve',
    'costs:read',
    'providers:read', 'providers:write',
    'users:read',    'users:write',
    'audit:read',
  ],
  operator: [
    'tasks:read',    'tasks:write',
    'agents:read',   'agents:write',
    'control:start', 'control:stop',
    'review:approve',
    'costs:read',
    'providers:read',
  ],
  viewer: [
    'tasks:read',
    'agents:read',
    'costs:read',
    'providers:read',
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Return the permission list for a role (empty array for unknown roles).
 *
 * @param {string} role
 * @returns {string[]}
 */
export function getPermissions(role) {
  return ROLE_PERMISSIONS[role] ?? [];
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Build an Express middleware that enforces a required permission.
 *
 * Rules:
 *   - req.user is null/undefined → next() always
 *       Covers: auth disabled, test mode, static API key (full-admin sentinel),
 *       and any other "no role restrictions" context.
 *   - req.user.role not in ROLE_PERMISSIONS → 403
 *   - ROLE_PERMISSIONS[role] does not include permission → 403
 *   - Otherwise → next()
 *
 * @param {string} permission  e.g. 'tasks:write'
 * @returns {import('express').RequestHandler}
 */
export function requirePermission(permission) {
  return function rbacMiddleware(req, res, next) {
    // Null/undefined user = auth disabled, test mode, or static API key.
    // No role restrictions apply in any of these cases.
    if (req.user == null) return next();

    const { role } = req.user;
    const perms = ROLE_PERMISSIONS[role];

    if (!perms || !perms.includes(permission)) {
      return res.status(403).json({ ok: false, error: 'Forbidden', required: permission });
    }

    next();
  };
}
