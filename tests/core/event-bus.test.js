import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * AgentForgeEventBus is a singleton, so we import it directly.
 * Each test clears the log by draining it to avoid cross-test contamination.
 */
import eventBus from '../../src/core/event-bus.js';

describe('AgentForgeEventBus', () => {
  beforeEach(() => {
    // Clear the internal log before each test by splicing out all entries
    eventBus._log.splice(0, eventBus._log.length);
  });

  describe('emit()', () => {
    it('stores emitted events in the log', () => {
      eventBus.emit('test.event', { value: 42 });

      const log = eventBus._log;
      assert.equal(log.length, 1);
      assert.equal(log[0].event, 'test.event');
      assert.deepEqual(log[0].data, { value: 42 });
    });

    it('stores a timestamp with each event', () => {
      const before = Date.now();
      eventBus.emit('test.timestamp', {});
      const after = Date.now();

      const entry = eventBus._log[0];
      assert.ok(entry.timestamp >= before);
      assert.ok(entry.timestamp <= after);
    });

    it('stores multiple events in order', () => {
      eventBus.emit('event.one', { n: 1 });
      eventBus.emit('event.two', { n: 2 });
      eventBus.emit('event.three', { n: 3 });

      assert.equal(eventBus._log.length, 3);
      assert.equal(eventBus._log[0].event, 'event.one');
      assert.equal(eventBus._log[1].event, 'event.two');
      assert.equal(eventBus._log[2].event, 'event.three');
    });

    it('still notifies listeners via EventEmitter', (t, done) => {
      eventBus.once('test.listener', (data) => {
        assert.equal(data.ping, 'pong');
        done();
      });
      eventBus.emit('test.listener', { ping: 'pong' });
    });
  });

  describe('getRecentEvents()', () => {
    it('returns the last N events', () => {
      for (let i = 0; i < 10; i++) {
        eventBus.emit('seq.event', { i });
      }

      const recent = eventBus.getRecentEvents(3);
      assert.equal(recent.length, 3);
      assert.equal(recent[0].data.i, 7);
      assert.equal(recent[1].data.i, 8);
      assert.equal(recent[2].data.i, 9);
    });

    it('returns all events when N exceeds log length', () => {
      eventBus.emit('only.one', {});
      const recent = eventBus.getRecentEvents(50);
      assert.equal(recent.length, 1);
    });

    it('defaults to returning last 50 events', () => {
      for (let i = 0; i < 60; i++) {
        eventBus.emit('batch.event', { i });
      }
      const recent = eventBus.getRecentEvents();
      assert.equal(recent.length, 50);
    });

    it('returns empty array when log is empty', () => {
      const recent = eventBus.getRecentEvents(10);
      assert.deepEqual(recent, []);
    });
  });

  describe('log cap at 1000 entries', () => {
    it('keeps log length at 1000 after exceeding it', () => {
      // Fill to exactly 1000
      for (let i = 0; i < 1000; i++) {
        eventBus.emit('fill.event', { i });
      }
      assert.equal(eventBus._log.length, 1000);

      // Add one more — should drop the oldest
      eventBus.emit('overflow.event', { i: 1000 });
      assert.equal(eventBus._log.length, 1000);
    });

    it('drops oldest entries when log is full', () => {
      for (let i = 0; i < 1001; i++) {
        eventBus.emit('drop.event', { i });
      }

      // The first entry should now be i=1 (i=0 was dropped)
      assert.equal(eventBus._log[0].data.i, 1);
      // The last entry should be i=1000
      assert.equal(eventBus._log[999].data.i, 1000);
    });
  });
});
