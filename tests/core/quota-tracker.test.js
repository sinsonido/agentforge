import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { QuotaManager, ProviderQuotaTracker } from '../../src/core/quota-tracker.js';
import eventBus from '../../src/core/event-bus.js';

describe('ProviderQuotaTracker', () => {
  let tracker;

  beforeEach(() => {
    tracker = new ProviderQuotaTracker('test-provider', {
      max_requests_per_minute: 10,
      max_tokens_per_minute: 10000,
    });
  });

  describe('canExecute()', () => {
    it('returns true when under request and token limits', () => {
      assert.equal(tracker.canExecute(500), true);
    });

    it('returns false when state is exhausted', () => {
      // Fill requests to >95% (10/10 = 100%)
      for (let i = 0; i < 10; i++) {
        tracker.recordUsage(100, 0);
      }
      assert.equal(tracker.state, 'exhausted');
      assert.equal(tracker.canExecute(0), false);
    });

    it('returns false when adding tokens would exceed token limit', () => {
      // Use 9600 tokens (96% of 10000 → > 95% → exhausted)
      tracker.recordUsage(9600, 0);
      // State becomes exhausted at > 95%
      assert.equal(tracker.state, 'exhausted');
      assert.equal(tracker.canExecute(0), false);
    });

    it('returns false when estimated tokens would push us over the limit even in non-exhausted state', () => {
      tracker.recordUsage(5000, 0);
      // 5000 + 6000 = 11000 >= 10000 → tokOk fails
      assert.equal(tracker.canExecute(6000), false);
    });

    it('returns true when estimated tokens would stay under the limit', () => {
      tracker.recordUsage(5000, 0);
      // 5000 + 4999 = 9999 < 10000
      assert.equal(tracker.canExecute(4999), true);
    });

    it('returns true when auto_pause is disabled regardless of usage', () => {
      const disabledTracker = new ProviderQuotaTracker('no-pause', {
        max_requests_per_minute: 1,
        max_tokens_per_minute: 1,
        auto_pause: false,
      });
      disabledTracker.recordUsage(9999, 0);
      assert.equal(disabledTracker.canExecute(999999), true);
    });
  });

  describe('recordUsage()', () => {
    it('increments request count on recordUsage', () => {
      tracker.recordUsage(1000, 0);
      const status = tracker.getStatus();
      assert.equal(status.requests.used, 1);
    });

    it('accumulates token usage', () => {
      tracker.recordUsage(3000, 0);
      tracker.recordUsage(2000, 0);
      const status = tracker.getStatus();
      assert.equal(status.tokens.used, 5000);
    });

    it('updates state to throttled when usage is between 70% and 95%', () => {
      // Use 8 of 10 requests = 80%
      for (let i = 0; i < 8; i++) {
        tracker.recordUsage(100, 0);
      }
      assert.equal(tracker.state, 'throttled');
    });

    it('updates state to exhausted when usage exceeds 95%', () => {
      // Use all 10 requests = 100%
      for (let i = 0; i < 10; i++) {
        tracker.recordUsage(100, 0);
      }
      assert.equal(tracker.state, 'exhausted');
    });
  });

  describe('tick()', () => {
    it('prunes old entries', () => {
      // Manually insert an old entry into the sliding window
      tracker.requests.entries.push({ timestamp: Date.now() - 120000, value: 1 });
      tracker.tokensIn.entries.push({ timestamp: Date.now() - 120000, value: 5000 });

      tracker.tick();

      assert.equal(tracker.requests.entries.length, 0);
      assert.equal(tracker.tokensIn.entries.length, 0);
    });

    it('resets state to available after entries expire', () => {
      // Record usage to trigger exhausted state
      for (let i = 0; i < 10; i++) {
        tracker.requests.entries.push({ timestamp: Date.now() - 120000, value: 1 });
      }
      tracker.tokensIn.entries.push({ timestamp: Date.now() - 120000, value: 9600 });
      // Manually set state to simulate prior exhaustion
      tracker.state = 'exhausted';
      tracker._prevState = 'exhausted';

      tracker.tick();

      // After pruning, all old entries are gone, usage is 0 → state goes back to available
      assert.equal(tracker.state, 'available');
    });
  });

  describe('state transitions and events', () => {
    it('emits quota.throttled when crossing 70% threshold', () => {
      let emitted = null;
      eventBus.once('quota.throttled', (data) => { emitted = data; });

      // 8/10 requests = 80% → throttled
      for (let i = 0; i < 8; i++) {
        tracker.recordUsage(100, 0);
      }

      assert.ok(emitted, 'quota.throttled should have been emitted');
      assert.equal(emitted.provider, 'test-provider');
    });

    it('emits quota.exhausted when crossing 95% threshold', () => {
      let emitted = null;
      eventBus.once('quota.exhausted', (data) => { emitted = data; });

      for (let i = 0; i < 10; i++) {
        tracker.recordUsage(100, 0);
      }

      assert.ok(emitted, 'quota.exhausted should have been emitted');
      assert.equal(emitted.provider, 'test-provider');
    });

    it('emits quota.reset when recovering from exhausted to available', () => {
      // Drive into exhausted state
      for (let i = 0; i < 10; i++) {
        tracker.requests.entries.push({ timestamp: Date.now() - 120000, value: 1 });
      }
      tracker.state = 'exhausted';
      tracker._prevState = 'exhausted';

      let resetEmitted = null;
      eventBus.once('quota.reset', (data) => { resetEmitted = data; });

      // Tick will prune old entries → state drops back to available
      tracker.tick();

      assert.ok(resetEmitted, 'quota.reset should have been emitted');
      assert.equal(resetEmitted.provider, 'test-provider');
    });

    it('transitions: available → throttled → exhausted', () => {
      assert.equal(tracker.state, 'available');

      // 8 requests → throttled
      for (let i = 0; i < 8; i++) {
        tracker.recordUsage(100, 0);
      }
      assert.equal(tracker.state, 'throttled');

      // 2 more → exhausted
      tracker.recordUsage(100, 0);
      tracker.recordUsage(100, 0);
      assert.equal(tracker.state, 'exhausted');
    });
  });

  describe('getStatus()', () => {
    it('returns provider, state, requests and tokens info', () => {
      tracker.recordUsage(2000, 500);
      const status = tracker.getStatus();

      assert.equal(status.provider, 'test-provider');
      assert.equal(status.state, 'available');
      assert.equal(status.requests.used, 1);
      assert.equal(status.requests.max, 10);
      assert.equal(status.tokens.used, 2000);
      assert.equal(status.tokens.max, 10000);
    });
  });
});

describe('QuotaManager', () => {
  let qm;

  beforeEach(() => {
    qm = new QuotaManager();
  });

  describe('canExecute()', () => {
    it('returns true when provider is under quota', () => {
      qm.addProvider('anthropic', { max_requests_per_minute: 100, max_tokens_per_minute: 100000 });
      assert.equal(qm.canExecute('anthropic', 1000), true);
    });

    it('returns false when provider quota is exhausted', () => {
      qm.addProvider('test', { max_requests_per_minute: 2, max_tokens_per_minute: 1000 });

      qm.recordUsage('test', 500, 0);
      qm.recordUsage('test', 500, 0);

      // 2/2 requests = 100% > 95% → exhausted
      assert.equal(qm.canExecute('test', 0), false);
    });

    it('returns true for unknown providers (no limits configured)', () => {
      assert.equal(qm.canExecute('unknown-provider', 999999), true);
    });
  });

  describe('recordUsage()', () => {
    it('updates usage counts for a known provider', () => {
      qm.addProvider('google', { max_requests_per_minute: 60, max_tokens_per_minute: 400000 });
      qm.recordUsage('google', 5000, 1000);

      const status = qm.getStatus('google');
      assert.equal(status.requests.used, 1);
      assert.equal(status.tokens.used, 5000);
    });

    it('does nothing for unknown providers', () => {
      // Should not throw
      assert.doesNotThrow(() => qm.recordUsage('unknown', 1000, 200));
    });
  });

  describe('getStatus()', () => {
    it('returns status for a known provider', () => {
      qm.addProvider('deepseek', { max_requests_per_minute: 120, max_tokens_per_minute: 400000 });
      qm.recordUsage('deepseek', 5000, 1000);

      const status = qm.getStatus('deepseek');
      assert.equal(status.provider, 'deepseek');
      assert.equal(status.requests.used, 1);
      assert.equal(status.tokens.used, 5000);
    });

    it('returns null for an unknown provider', () => {
      assert.equal(qm.getStatus('not-registered'), null);
    });
  });

  describe('getAllStatuses()', () => {
    it('returns statuses for all registered providers', () => {
      qm.addProvider('p1', { max_requests_per_minute: 10, max_tokens_per_minute: 1000 });
      qm.addProvider('p2', { max_requests_per_minute: 20, max_tokens_per_minute: 2000 });

      const all = qm.getAllStatuses();
      assert.ok('p1' in all);
      assert.ok('p2' in all);
      assert.equal(all.p1.provider, 'p1');
      assert.equal(all.p2.provider, 'p2');
    });
  });

  describe('startWatcher() / stopWatcher()', () => {
    it('starts and stops the tick interval without throwing', () => {
      assert.doesNotThrow(() => qm.startWatcher(50));
      assert.doesNotThrow(() => qm.stopWatcher());
    });

    it('stopWatcher() is idempotent', () => {
      qm.stopWatcher(); // should not throw even when not started
      assert.doesNotThrow(() => qm.stopWatcher());
    });
  });
});
