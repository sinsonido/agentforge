import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentForgeDB, EVENT_STRING_MAX, TASK_EVENTS_CAP, TASK_EVENTS_PAGE } from '../../src/persistence/db.js';

describe('task events store', () => {
  let dir;
  let db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'af-task-events-'));
    db = new AgentForgeDB(join(dir, 'data.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('numbers each task its own seq from 1 and replays in order', () => {
    const a1 = db.appendTaskEvent('a', { type: 'text', text: 'hello' }, 100);
    db.appendTaskEvent('b', { type: 'text', text: 'other task' });
    const a2 = db.appendTaskEvent('a', { type: 'tool_use', name: 'Bash', input: { command: 'ls' } });

    assert.deepEqual([a1.seq, a2.seq], [1, 2]);
    assert.deepEqual(db.taskEventsAfter('a'), {
      events: [
        { seq: 1, at: 100, event: { type: 'text', text: 'hello' } },
        { seq: 2, at: a2.at, event: { type: 'tool_use', name: 'Bash', input: { command: 'ls' } } },
      ],
      more: false,
    });
    assert.deepEqual(db.taskEventsAfter('a', 1).events.map((e) => e.seq), [2]);
    assert.deepEqual(db.taskEventsAfter('b').events.map((e) => e.seq), [1]);
    assert.deepEqual(db.taskEventsAfter('nobody'), { events: [], more: false });
  });

  it('keeps counting after a restart', () => {
    db.appendTaskEvent('a', { type: 'text', text: 'one' });
    db.close();
    db = new AgentForgeDB(join(dir, 'data.db'));
    assert.equal(db.appendTaskEvent('a', { type: 'text', text: 'two' }).seq, 2);
  });

  it('clips long strings anywhere in the event and stores what it returns', () => {
    const content = 'x'.repeat(EVENT_STRING_MAX + 10);
    const stored = db.appendTaskEvent('a', { type: 'tool_use', name: 'Write', input: { file_path: 'f.js', content }, tags: [content] });

    assert.equal(stored.event.input.file_path, 'f.js');
    assert.equal(stored.event.input.content, `${'x'.repeat(EVENT_STRING_MAX)}… [clipped 10 chars]`);
    assert.equal(stored.event.tags[0], stored.event.input.content);
    assert.deepEqual(db.taskEventsAfter('a').events[0].event, stored.event);
  });

  it('pages replay and says when more follows', () => {
    for (let i = 0; i < TASK_EVENTS_PAGE + 3; i++) db.appendTaskEvent('a', { type: 'text', text: String(i) });

    const first = db.taskEventsAfter('a', 0);
    assert.equal(first.events.length, TASK_EVENTS_PAGE);
    assert.equal(first.more, true);
    const second = db.taskEventsAfter('a', first.events.at(-1).seq);
    assert.deepEqual(second.events.map((e) => e.seq), [TASK_EVENTS_PAGE + 1, TASK_EVENTS_PAGE + 2, TASK_EVENTS_PAGE + 3]);
    assert.equal(second.more, false);
  });

  it(`keeps only the newest ${TASK_EVENTS_CAP} events of a task`, () => {
    const insert = db.db.prepare("INSERT INTO task_events (task_id, seq, at, event) VALUES ('a', ?, 0, '{}')");
    db.db.transaction(() => { for (let s = 1; s <= TASK_EVENTS_CAP; s++) insert.run(s); })();

    const last = db.appendTaskEvent('a', { type: 'result', subtype: 'success' });

    assert.equal(last.seq, TASK_EVENTS_CAP + 1);
    const { n, first } = db.db.prepare("SELECT COUNT(*) AS n, MIN(seq) AS first FROM task_events WHERE task_id = 'a'").get();
    assert.equal(n, TASK_EVENTS_CAP);
    assert.equal(first, 2);
  });
});
