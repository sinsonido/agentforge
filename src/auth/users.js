/**
 * @file src/auth/users.js
 * @description UserStore — high-level user management wrapping AgentForgeDB.
 */

import { randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from './password.js';

/**
 * Strip sensitive fields from a DB user row before returning to callers.
 * @param {object} row
 * @returns {object}
 */
function sanitize(row) {
  if (!row) return null;
  const { password_hash, ...rest } = row;
  void password_hash; // intentionally dropped
  return rest;
}

/**
 * A valid bcrypt hash used solely as a timing-safe dummy for non-existent
 * users so that `authenticate` always runs a full bcrypt comparison and does
 * not leak username existence via response-time differences.
 */
const DUMMY_HASH = '$2a$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW';

export class UserStore {
  /**
   * @param {import('../persistence/db.js').AgentForgeDB} db
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * Create a new user account.
   *
   * @param {{ username: string, email?: string, displayName?: string, role?: string, password: string }} opts
   * @returns {Promise<object>} created user (without passwordHash)
   */
  async create({ username, email = null, displayName = null, role = 'viewer', password }) {
    if (!username) throw new Error('username is required');
    if (username.length < 3) throw new Error('username must be at least 3 characters');
    if (!password) throw new Error('password is required');
    if (password.length < 8) throw new Error('password must be at least 8 characters');

    const id = randomUUID();
    const passwordHash = await hashPassword(password);

    this.db.createUser({ id, username, email, passwordHash, displayName, role });
    return sanitize(this.db.findUserById(id));
  }

  /**
   * Authenticate a user by username + password.
   * Updates last_login on success.
   *
   * @param {string} username
   * @param {string} password
   * @returns {Promise<object|null>} user without passwordHash, or null
   */
  async authenticate(username, password) {
    const row = this.db.findUserByUsername(username);

    // Always run bcrypt to avoid leaking username existence via timing differences.
    const hashToCheck = row?.password_hash ?? DUMMY_HASH;
    const ok = await verifyPassword(password, hashToCheck);

    if (!row || !row.is_active || !ok) return null;

    this.db.updateUserLastLogin(row.id);
    return sanitize(this.db.findUserById(row.id));
  }

  /**
   * Find a user by ID.
   * @param {string} id
   * @returns {object|null}
   */
  findById(id) {
    return sanitize(this.db.findUserById(id));
  }

  /**
   * List all users (without password hashes).
   * @returns {object[]}
   */
  list() {
    return this.db.listUsers().map(sanitize);
  }

  /**
   * Change a user's role.
   * @param {string} id
   * @param {string} role
   */
  updateRole(id, role) {
    this.db.updateUserRole(id, role);
  }

  /**
   * Deactivate a user account.
   * @param {string} id
   */
  deactivate(id) {
    this.db.deactivateUser(id);
  }

  /**
   * Count the number of active admin accounts.
   * Used to prevent lockout when demoting the last admin.
   * @returns {number}
   */
  countAdmins() {
    return this.db.listUsers().filter(u => u.role === 'admin' && u.is_active).length;
  }
}
