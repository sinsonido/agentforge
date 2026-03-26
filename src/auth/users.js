/**
 * @file src/auth/users.js
 * @description In-memory UserStore for AgentForge.
 *
 * Stores users with hashed passwords and roles.
 * In production this would be backed by the SQLite DB, but for the
 * initial auth layer a seeded in-memory store is sufficient.
 *
 * Roles: 'admin' | 'operator' | 'viewer'
 */

import { createHash, randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashPassword(password) {
  // SHA-256 hash — in production use bcrypt/argon2.
  return createHash('sha256').update(password).digest('hex');
}

// ---------------------------------------------------------------------------
// UserStore
// ---------------------------------------------------------------------------

export class UserStore {
  constructor() {
    /** @type {Map<string, { id: string, username: string, passwordHash: string, role: string }>} */
    this._byId       = new Map();
    /** @type {Map<string, string>} username → id */
    this._byUsername = new Map();

    // Seed a default admin so the system is usable out of the box.
    // Override via AGENTFORGE_ADMIN_PASSWORD env var.
    const adminPassword = process.env.AGENTFORGE_ADMIN_PASSWORD ?? 'admin';
    this._seed('admin', adminPassword, 'admin');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _seed(username, password, role) {
    const id = randomUUID();
    const user = { id, username, passwordHash: hashPassword(password), role };
    this._byId.set(id, user);
    this._byUsername.set(username, id);
    return user;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Create a new user.
   * @param {{ username: string, password: string, role?: string }} opts
   * @returns {{ id: string, username: string, role: string }}
   */
  create({ username, password, role = 'viewer' }) {
    if (!username || !password) throw new Error('username and password are required');
    if (this._byUsername.has(username)) throw new Error(`User '${username}' already exists`);
    const validRoles = ['admin', 'operator', 'viewer'];
    if (!validRoles.includes(role)) throw new Error(`Invalid role '${role}'`);
    const user = this._seed(username, password, role);
    return this._safe(user);
  }

  /**
   * Find a user by ID.
   * @param {string} id
   * @returns {{ id: string, username: string, role: string } | null}
   */
  getById(id) {
    const u = this._byId.get(id);
    return u ? this._safe(u) : null;
  }

  /**
   * Authenticate with username + password.
   * @param {string} username
   * @param {string} password
   * @returns {{ id: string, username: string, role: string } | null}
   */
  authenticate(username, password) {
    const id = this._byUsername.get(username);
    if (!id) return null;
    const user = this._byId.get(id);
    if (!user) return null;
    if (user.passwordHash !== hashPassword(password)) return null;
    return this._safe(user);
  }

  /**
   * List all users (without password hashes).
   * @returns {Array<{ id: string, username: string, role: string }>}
   */
  list() {
    return [...this._byId.values()].map(u => this._safe(u));
  }

  /**
   * Update a user's role.
   * @param {string} id
   * @param {string} role
   * @returns {{ id: string, username: string, role: string } | null}
   */
  updateRole(id, role) {
    const validRoles = ['admin', 'operator', 'viewer'];
    if (!validRoles.includes(role)) throw new Error(`Invalid role '${role}'`);
    const user = this._byId.get(id);
    if (!user) return null;
    user.role = role;
    return this._safe(user);
  }

  // Strip passwordHash before returning to callers.
  _safe({ id, username, role }) {
    return { id, username, role };
  }
}
