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
    if (!password) throw new Error('password is required');

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
    if (!row || !row.is_active) return null;

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) return null;

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
