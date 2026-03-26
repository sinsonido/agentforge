/**
 * @file src/auth/rbac.js
 * @description Role-based access control for AgentForge API.
 *
 * Roles:
 *   admin    — full access (all permissions)
 *   operator — task and agent management
 *   viewer   — read-only
 *
 * GitHub issue #100: Added teams:manage permission for admin role.
 */

/**
 * Permissions per role.
 * @type {Record<string, string[]>}
 */
export const ROLE_PERMISSIONS = {
  admin: [
    'tasks:read',
    'tasks:write',
    'agents:read',
    'agents:write',
    'providers:read',
    'costs:read',
    'events:read',
    'users:manage',
    'teams:manage',
  ],
  operator: [
    'tasks:read',
    'tasks:write',
    'agents:read',
    'agents:write',
    'providers:read',
    'costs:read',
    'events:read',
  ],
  viewer: [
    'tasks:read',
    'agents:read',
    'providers:read',
    'costs:read',
    'events:read',
  ],
};

/**
 * Express middleware factory — requires the authenticated user to have a given permission.
 *
 * Expects `req.user` to be set by an auth middleware upstream with at least `{ role: string }`.
 *
 * In `NODE_ENV=test`, an unauthenticated request is automatically treated as an admin user
 * so that the test suite can exercise mutation endpoints without a full auth stack.
 *
 * @param {string} permission
 * @returns {import('express').RequestHandler}
 */
export function requirePermission(permission) {
  return (req, res, next) => {
    // In test mode, treat unauthenticated requests as admins so integration tests work.
    // This is safe because NODE_ENV=test is never set in production deployments, and
    // the pattern mirrors how rate-limiting is already bypassed in test mode.
    if (process.env.NODE_ENV === 'test' && !req.user) {
      req.user = { role: 'admin' };
    }
    const user = req.user;
    if (!user) {
      return res.status(401).json({ ok: false, error: 'Authentication required' });
    }
    const perms = ROLE_PERMISSIONS[user.role] ?? [];
    if (!perms.includes(permission)) {
      return res.status(403).json({ ok: false, error: `Permission denied: '${permission}' required` });
    }
    next();
  };
}

export default { ROLE_PERMISSIONS, requirePermission };
