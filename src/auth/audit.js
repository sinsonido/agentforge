/**
 * @file src/auth/audit.js
 * @description Audit middleware factory — logs state-changing API actions to the
 * persistent audit_log table after each successful (< 400) response.
 *
 * GitHub issue #99
 */

const SENSITIVE_FIELDS = new Set([
  'password',
  'password_hash',
  'token',
  'secret',
  'currentPassword',
  'newPassword',
]);

/**
 * Strip sensitive fields from a request body object.
 * Returns a shallow copy with sensitive keys removed.
 *
 * @param {Record<string, unknown>} body
 * @returns {Record<string, unknown>}
 */
export function sanitizePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const cleaned = {};
  for (const [key, value] of Object.entries(body)) {
    if (!SENSITIVE_FIELDS.has(key)) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

/**
 * Create a bound audit middleware factory for the given db instance.
 *
 * @param {import('../persistence/db.js').AgentForgeDB | null} db
 * @returns {(action: string, getResource?: (req: import('express').Request) => string | null) => import('express').RequestHandler}
 */
export function createAuditMiddleware(db) {
  // No-op when db is unavailable (test mode / missing DB)
  if (!db) {
    return (_action, _getResource = () => null) => (req, res, next) => next();
  }

  return function auditMiddleware(action, getResource = () => null) {
    return (req, res, next) => {
      res.on('finish', () => {
        // Only log successful mutations
        if (res.statusCode >= 400) return;

        const userId = req.user?.userId ?? 'system';
        const username = req.user?.username ?? 'system';

        try {
          db.logAudit({
            userId,
            username,
            action,
            resource: getResource(req) ?? null,
            payload: req.body && Object.keys(req.body).length
              ? JSON.stringify(sanitizePayload(req.body))
              : null,
            ip: req.ip ?? null,
          });
        } catch {
          // Audit failures must never crash the request
        }
      });
      next();
    };
  };
}
