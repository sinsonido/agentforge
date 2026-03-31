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

const MAX_SANITIZE_DEPTH = 5;
const MAX_SANITIZE_KEYS = 1000;

/**
 * Recursively redact sensitive fields from a value.
 * Handles nested objects and arrays up to MAX_SANITIZE_DEPTH levels deep.
 * Stops recursing into object keys once MAX_SANITIZE_KEYS total keys have
 * been processed, leaving remaining values as-is.
 *
 * @param {unknown} value
 * @param {number} depth
 * @param {{ count: number }} state
 * @returns {unknown}
 */
function sanitizeValue(value, depth, state) {
  if (depth > MAX_SANITIZE_DEPTH) return value;
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1, state));
  }
  const cleaned = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_FIELDS.has(key)) continue;
    state.count += 1;
    if (state.count > MAX_SANITIZE_KEYS) {
      cleaned[key] = val;
      continue;
    }
    cleaned[key] = sanitizeValue(val, depth + 1, state);
  }
  return cleaned;
}

/**
 * Strip sensitive fields from a request body object, recursively.
 * Non-object values (null, undefined, arrays) are returned as-is.
 *
 * @param {unknown} body
 * @returns {unknown}
 */
export function sanitizePayload(body) {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body)) return body;
  const state = { count: 0 };
  return sanitizeValue(body, 0, state);
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

        // TODO: req.user is not populated by the API server (no auth middleware
        // is wired up), so all audit rows are currently attributed to 'system'.
        // Wire up JWT/session authentication middleware and populate req.user to
        // enable per-user attribution in the audit log.
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
