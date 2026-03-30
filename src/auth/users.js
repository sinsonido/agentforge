/**
 * @file src/auth/users.js
 * @description In-memory user store for admin user management.
 *
 * Provides CRUD operations for user accounts with simple password hashing
 * using Node.js built-in crypto. Intended as a lightweight auth layer for
 * the AgentForge admin panel.
 *
 * GitHub issue #98
 */

import crypto from 'node:crypto';

/**
 * Hash a plaintext password using scrypt with a random salt.
 * Returns a string of the form "salt:hash".
 * @param {string} password
 * @returns {string}
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a stored "salt:hash" string.
 * Uses a timing-safe comparison to prevent timing attacks.
 * @param {string} password
 * @param {string} stored
 * @returns {boolean}
 */
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const derivedHash = crypto.scryptSync(password, salt, 64);
  const storedHash = Buffer.from(hash, 'hex');
  return crypto.timingSafeEqual(derivedHash, storedHash);
}

/**
 * Strip the password_hash field from a user record.
 * @param {Object} user
 * @returns {Object}
 */
function sanitize(user) {
  const { password_hash, ...rest } = user; // eslint-disable-line no-unused-vars
  return rest;
}

/**
 * In-memory user store.
 *
 * Users are stored in a plain Map keyed by id.
 * An initial admin user is created on construction if the store is empty.
 */
export class UserStore {
  constructor() {
    /** @type {Map<string, Object>} */
    this._users = new Map();
    this._nextId = 1;

    // Seed an initial admin so the panel is accessible out-of-the-box.
    this._seed();
  }

  _seed() {
    // Only seed a default admin account in dev/test environments or when
    // explicitly requested via AGENTFORGE_SEED_ADMIN=true.
    const env = process.env.NODE_ENV;
    const isDevLike = env === 'development' || env === 'test';
    const explicitSeed = process.env.AGENTFORGE_SEED_ADMIN === 'true';

    if (!isDevLike && !explicitSeed) return;

    const password = process.env.AGENTFORGE_ADMIN_PASSWORD || 'admin';
    this.create({
      username: 'admin',
      displayName: 'Administrator',
      role: 'admin',
      password,
    });
  }

  /**
   * Generate a unique id.
   * @returns {string}
   */
  _newId() {
    return String(this._nextId++);
  }

  /**
   * Create a new user.
   * @param {{ username: string, email?: string, displayName?: string, role: string, password: string }} data
   * @returns {Object} The created user (without password_hash).
   * @throws {Error} if username already exists.
   */
  create({ username, email, displayName, role, password }) {
    if (!username) throw new Error('username is required');
    if (!password) throw new Error('password is required');
    if (!role) throw new Error('role is required');

    for (const u of this._users.values()) {
      if (u.username === username) {
        const err = new Error(`Username '${username}' already exists`);
        err.code = 'DUPLICATE_USERNAME';
        throw err;
      }
    }

    const user = {
      id: this._newId(),
      username,
      email: email ?? null,
      displayName: displayName ?? null,
      role,
      isActive: true,
      password_hash: hashPassword(password),
      createdAt: Date.now(),
      lastLogin: null,
    };

    this._users.set(user.id, user);
    return sanitize(user);
  }

  /**
   * Return all users (without password_hash).
   * @returns {Object[]}
   */
  list() {
    return Array.from(this._users.values()).map(sanitize);
  }

  /**
   * Find a user by id.
   * @param {string} id
   * @returns {Object|null} User without password_hash, or null.
   */
  findById(id) {
    const u = this._users.get(String(id));
    return u ? sanitize(u) : null;
  }

  /**
   * Find a user by username (includes password_hash for auth).
   * @param {string} username
   * @returns {Object|null}
   */
  findByUsername(username) {
    for (const u of this._users.values()) {
      if (u.username === username) return { ...u };
    }
    return null;
  }

  /**
   * Update non-sensitive fields on a user.
   * @param {string} id
   * @param {{ role?: string, displayName?: string, isActive?: boolean }} patch
   * @returns {Object} Updated user without password_hash.
   * @throws {Error} if user not found.
   */
  update(id, patch) {
    const user = this._users.get(String(id));
    if (!user) {
      const err = new Error(`User '${id}' not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (patch.role !== undefined) user.role = patch.role;
    if (patch.displayName !== undefined) user.displayName = patch.displayName;
    if (patch.isActive !== undefined) user.isActive = patch.isActive;

    return sanitize(user);
  }

  /**
   * Set a new password for a user.
   * @param {string} id
   * @param {string} password
   * @throws {Error} if user not found.
   */
  resetPassword(id, password) {
    const user = this._users.get(String(id));
    if (!user) {
      const err = new Error(`User '${id}' not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (!password) throw new Error('password is required');
    user.password_hash = hashPassword(password);
  }

  /**
   * Delete a user by id.
   * @param {string} id
   * @throws {Error} if user not found.
   */
  delete(id) {
    if (!this._users.has(String(id))) {
      const err = new Error(`User '${id}' not found`);
      err.code = 'NOT_FOUND';
      throw err;
    }
    this._users.delete(String(id));
  }

  /**
   * Count active admin users.
   * @returns {number}
   */
  countAdmins() {
    let count = 0;
    for (const u of this._users.values()) {
      if (u.role === 'admin' && u.isActive) count++;
    }
    return count;
  }

  /**
   * Verify credentials and return the user (without password_hash) on success.
   * @param {string} username
   * @param {string} password
   * @returns {Object|null}
   */
  authenticate(username, password) {
    const user = this.findByUsername(username);
    if (!user) return null;
    if (!user.isActive) return null;
    if (!verifyPassword(password, user.password_hash)) return null;
    user.lastLogin = Date.now();
    this._users.get(user.id).lastLogin = user.lastLogin;
    return sanitize(user);
  }
}
