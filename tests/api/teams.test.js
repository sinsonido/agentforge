/**
 * @file tests/api/teams.test.js
 * @description Unit tests for TeamStore (teams, members, projects).
 *
 * Uses an in-memory SQLite database so no files are created.
 * GitHub issue #100.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { TeamStore } from '../../src/auth/teams.js';

// We need the schema from AgentForgeDB.  Rather than importing the full class
// (which mkdirSync's a directory) we inline just the teams-related DDL here.
const TEAMS_DDL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    PRIMARY KEY (team_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS team_projects (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL,
    PRIMARY KEY (team_id, project_id)
  );
`;

describe('TeamStore', () => {
  /** @type {import('better-sqlite3').Database} */
  let rawDb;
  /** @type {TeamStore} */
  let store;

  before(() => {
    rawDb = new Database(':memory:');
    rawDb.exec(TEAMS_DDL);
    store = new TeamStore(rawDb);
  });

  after(() => {
    rawDb.close();
  });

  beforeEach(() => {
    // Wipe tables between tests for isolation
    rawDb.exec('DELETE FROM team_projects; DELETE FROM team_members; DELETE FROM teams;');
  });

  // ─── List teams ────────────────────────────────────────────────────────────

  describe('listTeams()', () => {
    it('returns empty array when no teams exist', () => {
      const teams = store.listTeams();
      assert.deepEqual(teams, []);
    });

    it('returns all teams with member_count', () => {
      const t = store.createTeam({ name: 'Alpha', description: 'First team' });
      store.addMember(t.id, 'user-1');
      store.addMember(t.id, 'user-2');

      const teams = store.listTeams();
      assert.equal(teams.length, 1);
      assert.equal(teams[0].name, 'Alpha');
      assert.equal(teams[0].member_count, 2);
    });
  });

  // ─── Create team ───────────────────────────────────────────────────────────

  describe('createTeam()', () => {
    it('creates a team and returns it', () => {
      const team = store.createTeam({ name: 'Beta', description: 'Second team' });
      assert.ok(team.id);
      assert.equal(team.name, 'Beta');
      assert.equal(team.description, 'Second team');
      assert.ok(typeof team.created_at === 'number');
    });

    it('creates a team with empty description when not provided', () => {
      const team = store.createTeam({ name: 'Gamma' });
      assert.equal(team.description, '');
    });

    it('throws on missing name', () => {
      assert.throws(() => store.createTeam({ name: '' }), /required/i);
    });

    it('throws on duplicate team name (SQLite UNIQUE constraint)', () => {
      store.createTeam({ name: 'Delta' });
      assert.throws(() => store.createTeam({ name: 'Delta' }), /UNIQUE/);
    });
  });

  // ─── Get team ──────────────────────────────────────────────────────────────

  describe('getTeam()', () => {
    it('returns the team by id', () => {
      const created = store.createTeam({ name: 'Epsilon' });
      const fetched = store.getTeam(created.id);
      assert.ok(fetched);
      assert.equal(fetched.id, created.id);
      assert.equal(fetched.name, 'Epsilon');
    });

    it('returns null for unknown id', () => {
      assert.equal(store.getTeam('non-existent-uuid'), null);
    });
  });

  // ─── Update team ───────────────────────────────────────────────────────────

  describe('updateTeam()', () => {
    it('updates name and description', () => {
      const team = store.createTeam({ name: 'Zeta', description: 'Old desc' });
      const updated = store.updateTeam(team.id, { name: 'Zeta Updated', description: 'New desc' });
      assert.ok(updated);
      assert.equal(updated.name, 'Zeta Updated');
      assert.equal(updated.description, 'New desc');
    });

    it('returns null when team not found', () => {
      assert.equal(store.updateTeam('no-such-id', { name: 'X' }), null);
    });

    it('preserves existing values when fields are not provided', () => {
      const team = store.createTeam({ name: 'Eta', description: 'Keep me' });
      const updated = store.updateTeam(team.id, {});
      assert.equal(updated.description, 'Keep me');
    });

    it('throws when updating with an empty name', () => {
      const team = store.createTeam({ name: 'Eta-empty' });
      assert.throws(() => store.updateTeam(team.id, { name: '   ' }), /required/i);
    });

    it('throws when updating with a non-string name', () => {
      const team = store.createTeam({ name: 'Eta-type' });
      assert.throws(() => store.updateTeam(team.id, { name: 42 }), /required/i);
    });

    it('normalises null description to empty string', () => {
      const team = store.createTeam({ name: 'Eta-null-desc', description: 'something' });
      const updated = store.updateTeam(team.id, { description: null });
      assert.equal(updated.description, '');
    });
  });

  // ─── Delete team ───────────────────────────────────────────────────────────

  describe('deleteTeam()', () => {
    it('deletes an existing team and returns true', () => {
      const team = store.createTeam({ name: 'Theta' });
      const result = store.deleteTeam(team.id);
      assert.equal(result, true);
      assert.equal(store.getTeam(team.id), null);
    });

    it('returns false when team not found', () => {
      assert.equal(store.deleteTeam('ghost-id'), false);
    });

    it('cascades to members and projects on delete', () => {
      const team = store.createTeam({ name: 'Iota' });
      store.addMember(team.id, 'u1');
      store.addProject(team.id, 'proj-1');
      store.deleteTeam(team.id);
      // Members and projects should no longer exist
      assert.deepEqual(store.listMembers(team.id), []);
      assert.deepEqual(store.listProjects(team.id), []);
    });
  });

  // ─── Members ───────────────────────────────────────────────────────────────

  describe('addMember() / removeMember()', () => {
    it('adds a member with default role "member"', () => {
      const team = store.createTeam({ name: 'Kappa' });
      store.addMember(team.id, 'user-42');
      const members = store.listMembers(team.id);
      assert.equal(members.length, 1);
      assert.equal(members[0].userId, 'user-42');
      assert.equal(members[0].role, 'member');
    });

    it('adds a member with role "owner"', () => {
      const team = store.createTeam({ name: 'Lambda' });
      store.addMember(team.id, 'owner-1', 'owner');
      const [m] = store.listMembers(team.id);
      assert.equal(m.role, 'owner');
    });

    it('throws when adding a duplicate member', () => {
      const team = store.createTeam({ name: 'Mu' });
      store.addMember(team.id, 'u1');
      assert.throws(() => store.addMember(team.id, 'u1'), /already a member/);
    });

    it('removes a member and returns true', () => {
      const team = store.createTeam({ name: 'Nu' });
      store.addMember(team.id, 'u2');
      assert.equal(store.removeMember(team.id, 'u2'), true);
      assert.deepEqual(store.listMembers(team.id), []);
    });

    it('returns false when member not found on remove', () => {
      const team = store.createTeam({ name: 'Xi' });
      assert.equal(store.removeMember(team.id, 'ghost'), false);
    });

    it('throws when adding a member with an invalid role', () => {
      const team = store.createTeam({ name: 'Lambda-invalid-role' });
      assert.throws(() => store.addMember(team.id, 'user-x', 'admin'), /[Ii]nvalid role/);
    });
  });

  describe('setMemberRole()', () => {
    it('updates the role for an existing member', () => {
      const team = store.createTeam({ name: 'Omicron' });
      store.addMember(team.id, 'u3', 'member');
      const result = store.setMemberRole(team.id, 'u3', 'owner');
      assert.equal(result, true);
      const [m] = store.listMembers(team.id);
      assert.equal(m.role, 'owner');
    });

    it('returns false when member not found', () => {
      const team = store.createTeam({ name: 'Pi' });
      assert.equal(store.setMemberRole(team.id, 'nobody', 'owner'), false);
    });

    it('throws when setting an invalid role', () => {
      const team = store.createTeam({ name: 'Pi-invalid-role' });
      store.addMember(team.id, 'u4', 'member');
      assert.throws(() => store.setMemberRole(team.id, 'u4', 'superuser'), /[Ii]nvalid role/);
    });
  });

  // ─── Projects ──────────────────────────────────────────────────────────────

  describe('addProject() / removeProject() / listProjects()', () => {
    it('adds a project and lists it', () => {
      const team = store.createTeam({ name: 'Rho' });
      store.addProject(team.id, 'project-alpha');
      const projects = store.listProjects(team.id);
      assert.deepEqual(projects, ['project-alpha']);
    });

    it('is idempotent — adding same project twice does not throw', () => {
      const team = store.createTeam({ name: 'Sigma' });
      store.addProject(team.id, 'proj-x');
      assert.doesNotThrow(() => store.addProject(team.id, 'proj-x'));
      assert.equal(store.listProjects(team.id).length, 1);
    });

    it('removes a project and returns true', () => {
      const team = store.createTeam({ name: 'Tau' });
      store.addProject(team.id, 'proj-y');
      assert.equal(store.removeProject(team.id, 'proj-y'), true);
      assert.deepEqual(store.listProjects(team.id), []);
    });

    it('returns false when project association not found', () => {
      const team = store.createTeam({ name: 'Upsilon' });
      assert.equal(store.removeProject(team.id, 'ghost-proj'), false);
    });

    it('returns empty array when team has no projects', () => {
      const team = store.createTeam({ name: 'Phi' });
      assert.deepEqual(store.listProjects(team.id), []);
    });
  });
});
