/**
 * @file src/auth/auth.js
 * @description Authentication middleware for AgentForge API.
 *
 * Provides a simple Bearer-token-based auth middleware that populates
 * req.user from the UserStore when a valid token is presented.
 *
 * In development / test mode the middleware is a no-op so that the rest of
 * the API stack remains accessible without credentials.
 *
 * GitHub issue #98
 */

/**
 * Build an auth middleware bound to the given UserStore.
 *
 * The current implementation uses a trivially simple "username:password"
 * Base64 scheme (HTTP Basic-style) for ease of testing without a full JWT
 * stack.  Replace with a proper JWT implementation for production use.
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
