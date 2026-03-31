/**
 * @file tests/api/teams-api.test.js
 * @description Integration tests for the REST /api/teams endpoints.
 *
 * Uses an in-memory SQLite database and a minimal forge stub so that
 * no filesystem files are created.  Matches the makeForge() pattern used
 * in tests/api.test.js.
 *
 * GitHub issue #100.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { startServer } from '../../src/api/server.js';
import { TaskQueue } from '../../src/core/task-queue.js';
import { QuotaManager } from '../../src/core/quota-tracker.js';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const TEAMS_DDL = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    created_at INTEGER DEFAULT (unixepoch() * 1000)
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

/** Minimal forge stub that includes an in-memory SQLite DB for team tests. */
function makeForge() {
  const rawDb = new Database(':memory:');
  rawDb.exec(TEAMS_DDL);

  const taskQueue    = new TaskQueue();
  const quotaManager = new QuotaManager();
  const eventBus     = Object.assign(new EventEmitter(), {
    getRecentEvents: () => [],
  });
  const agentPool = {
    getAllStatuses() { return {}; },
    updateAgentConfig() { return false; },
  };
  const providerRegistry = {
    get() { return null; },
  };

  return {
    taskQueue,
    quotaManager,
    eventBus,
    agentPool,
    providerRegistry,
    orchestrator: { _running: false, start() {}, stop() {} },
    costTracker: null,
    // server.js accesses forge.db.db to get the raw better-sqlite3 handle for TeamStore.
    // The outer `db` key matches AgentForgeDB's position in the forge object; the inner
    // `.db` matches the property AgentForgeDB stores on itself (this.db = new Database(...)).
    db: { db: rawDb, _rawDb: rawDb },
  };
}

/** Make an HTTP request to the test server and return { status, body }. */
function req(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const opts = {
      hostname: '127.0.0.1',
      port: addr.port,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const r = http.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('GET /api/teams', () => {
  let server;
  let forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    forge.db._rawDb.close();
  });

  it('returns empty list when no teams exist', async () => {
    const { status, body } = await req(server, 'GET', '/api/teams');
    assert.equal(status, 200);
    assert.ok(body.ok);
    assert.deepEqual(body.teams, []);
  });
});

describe('POST /api/teams — create team', () => {
  let server;
  let forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    forge.db._rawDb.close();
  });

  it('creates a team and returns 201', async () => {
    const { status, body } = await req(server, 'POST', '/api/teams', { name: 'Alpha', description: 'First' });
    assert.equal(status, 201);
    assert.ok(body.ok);
    assert.equal(body.team.name, 'Alpha');
    assert.equal(body.team.description, 'First');
    assert.ok(body.team.id);
  });

  it('returns 400 when name is missing', async () => {
    const { status, body } = await req(server, 'POST', '/api/teams', { description: 'No name' });
    assert.equal(status, 400);
    assert.ok(!body.ok);
    assert.match(body.error, /name/i);
  });

  it('returns 409 on duplicate team name', async () => {
    await req(server, 'POST', '/api/teams', { name: 'Dup' });
    const { status, body } = await req(server, 'POST', '/api/teams', { name: 'Dup' });
    assert.equal(status, 409);
    assert.ok(!body.ok);
    assert.match(body.error, /already exists/i);
  });
});

describe('GET /api/teams/:id', () => {
  let server;
  let forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    forge.db._rawDb.close();
  });

  it('returns the team with members and projects', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Beta' });
    const id = created.team.id;

    const { status, body } = await req(server, 'GET', `/api/teams/${id}`);
    assert.equal(status, 200);
    assert.ok(body.ok);
    assert.equal(body.team.name, 'Beta');
    assert.deepEqual(body.team.members, []);
    assert.deepEqual(body.team.projects, []);
  });

  it('returns 404 for unknown team id', async () => {
    const { status, body } = await req(server, 'GET', '/api/teams/nonexistent-id');
    assert.equal(status, 404);
    assert.ok(!body.ok);
  });
});

describe('PUT /api/teams/:id — update team', () => {
  let server;
  let forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    forge.db._rawDb.close();
  });

  it('updates team name and description', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Gamma', description: 'Old' });
    const id = created.team.id;

    const { status, body } = await req(server, 'PUT', `/api/teams/${id}`, { name: 'Gamma Updated', description: 'New' });
    assert.equal(status, 200);
    assert.ok(body.ok);
    assert.equal(body.team.name, 'Gamma Updated');
    assert.equal(body.team.description, 'New');
  });

  it('returns 404 for unknown team id', async () => {
    const { status, body } = await req(server, 'PUT', '/api/teams/nonexistent-id', { name: 'X' });
    assert.equal(status, 404);
    assert.ok(!body.ok);
  });
});

describe('DELETE /api/teams/:id', () => {
  let server;
  let forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    forge.db._rawDb.close();
  });

  it('deletes an existing team', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Delta' });
    const id = created.team.id;

    const { status, body } = await req(server, 'DELETE', `/api/teams/${id}`);
    assert.equal(status, 200);
    assert.ok(body.ok);

    const { status: s2 } = await req(server, 'GET', `/api/teams/${id}`);
    assert.equal(s2, 404);
  });

  it('returns 404 for unknown team id', async () => {
    const { status, body } = await req(server, 'DELETE', '/api/teams/nonexistent-id');
    assert.equal(status, 404);
    assert.ok(!body.ok);
  });
});

describe('POST /api/teams/:id/members — add member', () => {
  let server;
  let forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    forge.db._rawDb.close();
  });

  it('adds a member with default role', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Epsilon' });
    const id = created.team.id;

    const { status, body } = await req(server, 'POST', `/api/teams/${id}/members`, { userId: 'user-1' });
    assert.equal(status, 201);
    assert.ok(body.ok);

    const { body: detail } = await req(server, 'GET', `/api/teams/${id}`);
    assert.equal(detail.team.members.length, 1);
    assert.equal(detail.team.members[0].userId, 'user-1');
    assert.equal(detail.team.members[0].role, 'member');
  });

  it('adds a member with role "owner"', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Epsilon-owner' });
    const id = created.team.id;

    const { status } = await req(server, 'POST', `/api/teams/${id}/members`, { userId: 'owner-1', role: 'owner' });
    assert.equal(status, 201);

    const { body: detail } = await req(server, 'GET', `/api/teams/${id}`);
    assert.equal(detail.team.members[0].role, 'owner');
  });

  it('returns 400 when userId is missing', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Epsilon-noid' });
    const id = created.team.id;

    const { status, body } = await req(server, 'POST', `/api/teams/${id}/members`, {});
    assert.equal(status, 400);
    assert.ok(!body.ok);
    assert.match(body.error, /userId/i);
  });

  it('returns 400 for an invalid role', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Epsilon-badrole' });
    const id = created.team.id;

    const { status, body } = await req(server, 'POST', `/api/teams/${id}/members`, { userId: 'u1', role: 'superadmin' });
    assert.equal(status, 400);
    assert.ok(!body.ok);
    assert.match(body.error, /[Ii]nvalid role/);
  });

  it('returns 400 when adding an existing member', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Epsilon-dup' });
    const id = created.team.id;

    await req(server, 'POST', `/api/teams/${id}/members`, { userId: 'u2' });
    const { status, body } = await req(server, 'POST', `/api/teams/${id}/members`, { userId: 'u2' });
    assert.equal(status, 400);
    assert.ok(!body.ok);
    assert.match(body.error, /already a member/i);
  });

  it('returns 404 when team does not exist', async () => {
    const { status } = await req(server, 'POST', '/api/teams/nonexistent/members', { userId: 'u3' });
    assert.equal(status, 404);
  });
});

describe('DELETE /api/teams/:id/members/:uid — remove member', () => {
  let server;
  let forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    forge.db._rawDb.close();
  });

  it('removes a member', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Zeta' });
    const id = created.team.id;

    await req(server, 'POST', `/api/teams/${id}/members`, { userId: 'u10' });
    const { status, body } = await req(server, 'DELETE', `/api/teams/${id}/members/u10`);
    assert.equal(status, 200);
    assert.ok(body.ok);
  });

  it('returns 404 when member not found', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Zeta-404' });
    const id = created.team.id;

    const { status } = await req(server, 'DELETE', `/api/teams/${id}/members/ghost`);
    assert.equal(status, 404);
  });
});

describe('PUT /api/teams/:id/members/:uid — set role', () => {
  let server;
  let forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    forge.db._rawDb.close();
  });

  it('updates a member role', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Eta' });
    const id = created.team.id;

    await req(server, 'POST', `/api/teams/${id}/members`, { userId: 'u20', role: 'member' });
    const { status, body } = await req(server, 'PUT', `/api/teams/${id}/members/u20`, { role: 'owner' });
    assert.equal(status, 200);
    assert.ok(body.ok);

    const { body: detail } = await req(server, 'GET', `/api/teams/${id}`);
    assert.equal(detail.team.members[0].role, 'owner');
  });

  it('returns 400 when role is invalid', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Eta-badrole' });
    const id = created.team.id;

    await req(server, 'POST', `/api/teams/${id}/members`, { userId: 'u21' });
    const { status, body } = await req(server, 'PUT', `/api/teams/${id}/members/u21`, { role: 'god' });
    assert.equal(status, 400);
    assert.ok(!body.ok);
    assert.match(body.error, /[Ii]nvalid role/);
  });

  it('returns 400 when role is missing', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Eta-norole' });
    const id = created.team.id;

    await req(server, 'POST', `/api/teams/${id}/members`, { userId: 'u22' });
    const { status, body } = await req(server, 'PUT', `/api/teams/${id}/members/u22`, {});
    assert.equal(status, 400);
    assert.ok(!body.ok);
  });

  it('returns 404 when member not found', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Eta-ghost' });
    const id = created.team.id;

    const { status } = await req(server, 'PUT', `/api/teams/${id}/members/nobody`, { role: 'owner' });
    assert.equal(status, 404);
  });
});

describe('POST /api/teams/:id/projects — add project', () => {
  let server;
  let forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    forge.db._rawDb.close();
  });

  it('adds a project association and returns 201', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Theta' });
    const id = created.team.id;

    const { status, body } = await req(server, 'POST', `/api/teams/${id}/projects`, { projectId: 'proj-1' });
    assert.equal(status, 201);
    assert.ok(body.ok);

    const { body: detail } = await req(server, 'GET', `/api/teams/${id}`);
    assert.deepEqual(detail.team.projects, ['proj-1']);
  });

  it('returns 400 when projectId is missing', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Theta-noprojid' });
    const id = created.team.id;

    const { status, body } = await req(server, 'POST', `/api/teams/${id}/projects`, {});
    assert.equal(status, 400);
    assert.ok(!body.ok);
    assert.match(body.error, /projectId/i);
  });

  it('returns 404 when team does not exist', async () => {
    const { status } = await req(server, 'POST', '/api/teams/nonexistent/projects', { projectId: 'p1' });
    assert.equal(status, 404);
  });
});

describe('DELETE /api/teams/:id/projects/:pid — remove project', () => {
  let server;
  let forge;

  before(async () => {
    forge = makeForge();
    server = startServer(forge, 0);
    await new Promise(r => server.once('listening', r));
  });

  after(async () => {
    await new Promise(r => server.close(r));
    forge.db._rawDb.close();
  });

  it('removes a project association', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Iota' });
    const id = created.team.id;

    await req(server, 'POST', `/api/teams/${id}/projects`, { projectId: 'proj-2' });
    const { status, body } = await req(server, 'DELETE', `/api/teams/${id}/projects/proj-2`);
    assert.equal(status, 200);
    assert.ok(body.ok);

    const { body: detail } = await req(server, 'GET', `/api/teams/${id}`);
    assert.deepEqual(detail.team.projects, []);
  });

  it('returns 404 when project association not found', async () => {
    const { body: created } = await req(server, 'POST', '/api/teams', { name: 'Iota-ghost' });
    const id = created.team.id;

    const { status } = await req(server, 'DELETE', `/api/teams/${id}/projects/nonexistent`);
    assert.equal(status, 404);
  });
});
