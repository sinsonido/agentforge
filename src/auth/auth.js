/**
 * @file src/auth/auth.js
 * @description Authentication middleware for AgentForge API.
 *
 * Provides a simple Bearer-token-based auth middleware that populates
 * req.user from the UserStore when valid credentials are presented.
 *
 * The current implementation uses a Base64-encoded "username:password"
 * scheme (HTTP Basic-style) for ease of development and testing.
 * Replace with a proper JWT or session-based implementation for production.
 *
 * GitHub issue #98
 */

/**
 * Build an auth middleware bound to the given UserStore.
 *
 * Expects an Authorization header of the form:
 *   Authorization: Bearer base64(username:password)
 *
 * On success, sets req.user to { userId, username, role }.
 * On failure or missing header, req.user remains undefined and the
 * next middleware (e.g. requirePermission) is responsible for rejecting
 * unauthenticated requests.
 *
 * @param {import('./users.js').UserStore} userStore
 * @returns {import('express').RequestHandler}
 */
export function buildAuthMiddleware(userStore) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization ?? '';

    if (!authHeader.startsWith('Bearer ')) {
      // No credentials — req.user stays undefined; downstream middleware
      // decides whether to reject (requirePermission) or allow (test bypass).
      return next();
    }

    try {
      const token = authHeader.slice(7);
      const decoded = Buffer.from(token, 'base64').toString('utf8');
      const colonIdx = decoded.indexOf(':');
      if (colonIdx === -1) return next();

      const username = decoded.slice(0, colonIdx);
      const password = decoded.slice(colonIdx + 1);

      const user = userStore.authenticate(username, password);
      if (user) {
        req.user = { userId: user.id, username: user.username, role: user.role };
      }
    } catch {
      // Malformed token — silently ignore, req.user stays undefined
    }

    next();
  };
}
