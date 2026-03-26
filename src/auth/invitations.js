/**
 * @file src/auth/invitations.js
 * @description InvitationStore — manages email invitations for user onboarding.
 *
 * GitHub issue #101: Invitation system.
 */

import { randomUUID, randomBytes } from 'node:crypto';

export class InvitationStore {
  /**
   * @param {import('better-sqlite3').Database} db - raw better-sqlite3 instance
   */
  constructor(db) {
    this.db = db;
  }

  // ─── Create ───────────────────────────────────────────────────────────────

  /**
   * Create a new invitation.
   *
   * @param {{ email: string, role?: string, teamId?: string, invitedBy: string, expiresInHours?: number }} opts
   * @returns {{ id: string, email: string, role: string, teamId: string|null, token: string, invitedBy: string, createdAt: number, expiresAt: number, usedAt: null, status: string }}
   */
  createInvitation({ email, role = 'viewer', teamId = null, invitedBy, expiresInHours = 72 }) {
    if (!email) throw new Error('email is required');
    if (!invitedBy) throw new Error('invitedBy is required');

    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + expiresInHours * 3600;

    this.db.prepare(`
      INSERT INTO invitations (id, email, role, team_id, token, invited_by, created_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `).run(id, email, role, teamId ?? null, token, invitedBy, now, expiresAt);

    return this._format(this.db.prepare('SELECT * FROM invitations WHERE id = ?').get(id));
  }

  // ─── Read ─────────────────────────────────────────────────────────────────

  /**
   * Find an invitation by token.
   * @param {string} token
   * @returns {object|null}
   */
  getByToken(token) {
    const row = this.db.prepare('SELECT * FROM invitations WHERE token = ?').get(token);
    return row ? this._format(row) : null;
  }

  /**
   * Find an invitation by id.
   * @param {string} id
   * @returns {object|null}
   */
  getById(id) {
    const row = this.db.prepare('SELECT * FROM invitations WHERE id = ?').get(id);
    return row ? this._format(row) : null;
  }

  /**
   * List all invitations, optionally filtered by status.
   * @param {{ status?: string }} [opts]
   * @returns {object[]}
   */
  listInvitations({ status } = {}) {
    if (status) {
      return this.db.prepare(
        'SELECT * FROM invitations WHERE status = ? ORDER BY created_at DESC'
      ).all(status).map(r => this._format(r));
    }
    return this.db.prepare(
      'SELECT * FROM invitations ORDER BY created_at DESC'
    ).all().map(r => this._format(r));
  }

  // ─── Mutations ────────────────────────────────────────────────────────────

  /**
   * Accept an invitation by token. Marks used_at and status='accepted'.
   * @param {string} token
   * @returns {object|null} updated invitation, or null if not found / not pending
   */
  acceptInvitation(token) {
    const row = this.db.prepare('SELECT * FROM invitations WHERE token = ?').get(token);
    if (!row) return null;
    if (row.status !== 'pending') return null;

    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(
      `UPDATE invitations SET used_at = ?, status = 'accepted' WHERE token = ?`
    ).run(now, token);

    return this._format(this.db.prepare('SELECT * FROM invitations WHERE token = ?').get(token));
  }

  /**
   * Revoke an invitation by id.
   * @param {string} id
   * @returns {boolean}
   */
  revokeInvitation(id) {
    const info = this.db.prepare(
      `UPDATE invitations SET status = 'revoked' WHERE id = ? AND status = 'pending'`
    ).run(id);
    return info.changes > 0;
  }

  /**
   * Mark all past-expiry pending invitations as 'expired'.
   * Should be called periodically.
   * @returns {number} number of invitations expired
   */
  expireStale() {
    const now = Math.floor(Date.now() / 1000);
    const info = this.db.prepare(
      `UPDATE invitations SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`
    ).run(now);
    return info.changes;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  /**
   * Normalize a DB row to camelCase keys.
   * @param {object} row
   * @returns {object}
   */
  _format(row) {
    return {
      id: row.id,
      email: row.email,
      role: row.role,
      teamId: row.team_id ?? null,
      token: row.token,
      invitedBy: row.invited_by,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      usedAt: row.used_at ?? null,
      status: row.status,
    };
  }
}

export default InvitationStore;
