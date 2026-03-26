/**
 * @file src/auth/password.js
 * @description bcrypt password hashing and verification helpers.
 */

import bcrypt from 'bcryptjs';

const COST = 12;

/**
 * Hash a plaintext password with bcrypt.
 * @param {string} plain
 * @returns {Promise<string>} bcrypt hash
 */
export async function hashPassword(plain) {
  return bcrypt.hash(plain, COST);
}

/**
 * Verify a plaintext password against a bcrypt hash.
 * @param {string} plain
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
