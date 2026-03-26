/**
 * @file src/auth/teams.js
 * @description TeamStore — manages teams, membership, and project associations.
 *
 * GitHub issue #100: Teams & multi-project support.
 */

import { randomUUID } from 'node:crypto';

export class TeamStore {
  /**
   * @param {import('better-sqlite3').Database} db - raw better-sqlite3 instance
   */
  constructor(db) {
    this.db = db;
  }

  // ─── Teams ────────────────────────────────────────────────────────────────

  /**
   * List all teams with member count.
   * @returns {{ id: string, name: string, description: string, created_at: number, member_count: number }[]}
   */
  listTeams() {
    return this.db.prepare(`
      SELECT t.id, t.name, t.description, t.created_at,
             COUNT(tm.user_id) AS member_count
      FROM teams t
      LEFT JOIN team_members tm ON tm.team_id = t.id
      GROUP BY t.id
      ORDER BY t.name
    `).all();
  }

  /**
   * Create a new team.
   * @param {{ name: string, description?: string }} opts
   * @returns {{ id: string, name: string, description: string, created_at: number }}
   */
  createTeam({ name, description = '' }) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new Error('Team name is required');
    }
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO teams (id, name, description) VALUES (?, ?, ?)'
    ).run(id, name.trim(), description || '');
    return this.getTeam(id);
  }

  /**
   * Get a team by id.
   * @param {string} id
   * @returns {{ id: string, name: string, description: string, created_at: number } | null}
   */
  getTeam(id) {
    return this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) ?? null;
  }

  /**
   * Update team name and/or description.
   * @param {string} id
   * @param {{ name?: string, description?: string }} patch
   * @returns {{ id: string, name: string, description: string, created_at: number } | null}
   */
  updateTeam(id, { name, description }) {
    const existing = this.getTeam(id);
    if (!existing) return null;
    const newName = name !== undefined ? name.trim() : existing.name;
    const newDesc = description !== undefined ? description : existing.description;
    this.db.prepare(
      'UPDATE teams SET name = ?, description = ? WHERE id = ?'
    ).run(newName, newDesc, id);
    return this.getTeam(id);
  }

  /**
   * Delete a team (cascades to members and projects).
   * @param {string} id
   * @returns {boolean}
   */
  deleteTeam(id) {
    const info = this.db.prepare('DELETE FROM teams WHERE id = ?').run(id);
    return info.changes > 0;
  }

  // ─── Members ─────────────────────────────────────────────────────────────

  /**
   * Add a user to a team.
   * @param {string} teamId
   * @param {string} userId
   * @param {'owner'|'member'} role
   * @throws if the user is already a member
   */
  addMember(teamId, userId, role = 'member') {
    const existing = this.db.prepare(
      'SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?'
    ).get(teamId, userId);
    if (existing) {
      throw new Error(`User '${userId}' is already a member of team '${teamId}'`);
    }
    this.db.prepare(
      'INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)'
    ).run(teamId, userId, role);
  }

  /**
   * Remove a user from a team.
   * @param {string} teamId
   * @param {string} userId
   * @returns {boolean}
   */
  removeMember(teamId, userId) {
    const info = this.db.prepare(
      'DELETE FROM team_members WHERE team_id = ? AND user_id = ?'
    ).run(teamId, userId);
    return info.changes > 0;
  }

  /**
   * List members of a team.
   * @param {string} teamId
   * @returns {{ userId: string, role: string }[]}
   */
  listMembers(teamId) {
    return this.db.prepare(
      'SELECT user_id AS userId, role FROM team_members WHERE team_id = ? ORDER BY role, userId'
    ).all(teamId);
  }

  /**
   * Set the role of a team member.
   * @param {string} teamId
   * @param {string} userId
   * @param {'owner'|'member'} role
   * @returns {boolean}
   */
  setMemberRole(teamId, userId, role) {
    const info = this.db.prepare(
      'UPDATE team_members SET role = ? WHERE team_id = ? AND user_id = ?'
    ).run(role, teamId, userId);
    return info.changes > 0;
  }

  // ─── Projects ─────────────────────────────────────────────────────────────

  /**
   * Associate a project with a team.
   * @param {string} teamId
   * @param {string} projectId
   */
  addProject(teamId, projectId) {
    this.db.prepare(
      'INSERT OR IGNORE INTO team_projects (team_id, project_id) VALUES (?, ?)'
    ).run(teamId, projectId);
  }

  /**
   * Remove a project association from a team.
   * @param {string} teamId
   * @param {string} projectId
   * @returns {boolean}
   */
  removeProject(teamId, projectId) {
    const info = this.db.prepare(
      'DELETE FROM team_projects WHERE team_id = ? AND project_id = ?'
    ).run(teamId, projectId);
    return info.changes > 0;
  }

  /**
   * List project ids for a team.
   * @param {string} teamId
   * @returns {string[]}
   */
  listProjects(teamId) {
    return this.db.prepare(
      'SELECT project_id FROM team_projects WHERE team_id = ? ORDER BY project_id'
    ).all(teamId).map(r => r.project_id);
  }
}

export default TeamStore;
