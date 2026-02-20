import eventBus from './event-bus.js';

const STATES = {
  AVAILABLE: 'available',
  THROTTLED: 'throttled',
  EXHAUSTED: 'exhausted',
};

/**
 * Sliding window rate limiter for a single provider.
 * Tracks requests and tokens within a rolling time window.
 */
class SlidingWindow {
  constructor(windowMs, maxValue) {
    this.windowMs = windowMs;
    this.maxValue = maxValue;
    this.entries = []; // { timestamp, value }
  }

  add(value) {
    this.entries.push({ timestamp: Date.now(), value });
  }

  prune() {
    const cutoff = Date.now() - this.windowMs;
    this.entries = this.entries.filter(e => e.timestamp > cutoff);
  }

  sum() {
    this.prune();
    return this.entries.reduce((s, e) => s + e.value, 0);
  }

  count() {
    this.prune();
    return this.entries.length;
  }

  usagePct() {
    if (this.maxValue <= 0 || this.maxValue === Infinity) return 0;
    return this.sum() / this.maxValue;
  }
}

/**
 * Per-provider quota tracker.
 * Manages sliding windows for requests and tokens.
 * Emits events when state changes (throttled, exhausted, reset).
 */
export class ProviderQuotaTracker {
  constructor(providerId, config = {}) {
    this.providerId = providerId;
    this.state = STATES.AVAILABLE;
    this.enabled = config.auto_pause !== false;

    const windowMs = (config.window_minutes || 1) * 60 * 1000;

    this.requests = new SlidingWindow(windowMs, config.max_requests_per_minute || Infinity);
    this.tokensIn = new SlidingWindow(windowMs, config.max_tokens_per_minute || Infinity);

    this._prevState = STATES.AVAILABLE;
  }

  /**
   * Check if we can execute a request with estimated token count.
   * Does NOT record usage — call recordUsage() after execution.
   */
  canExecute(estimatedTokens = 0) {
    if (!this.enabled) return true;
    if (this.state === STATES.EXHAUSTED) return false;

    const reqOk = this.requests.count() < this.requests.maxValue;
    const tokOk = this.tokensIn.sum() + estimatedTokens < this.tokensIn.maxValue;
    return reqOk && tokOk;
  }

  /**
   * Record actual usage after a successful execution.
   * Updates state and emits events if state changed.
   */
  recordUsage(tokensIn, tokensOut = 0) {
    this.requests.add(1);
    this.tokensIn.add(tokensIn);
    this._updateState();
  }

  /**
   * Get current state with details.
   */
  getStatus() {
    return {
      provider: this.providerId,
      state: this.state,
      requests: {
        used: this.requests.count(),
        max: this.requests.maxValue,
        pct: this.requests.count() / (this.requests.maxValue || 1),
      },
      tokens: {
        used: this.tokensIn.sum(),
        max: this.tokensIn.maxValue,
        pct: this.tokensIn.usagePct(),
      },
      estimatedResetMs: this._estimateReset(),
    };
  }

  /**
   * Called periodically (every ~1s) to prune windows and check for resets.
   */
  tick() {
    this.requests.prune();
    this.tokensIn.prune();
    this._updateState();
  }

  _updateState() {
    if (!this.enabled) return;

    const reqPct = this.requests.maxValue === Infinity ? 0 : this.requests.count() / this.requests.maxValue;
    const tokPct = this.tokensIn.usagePct();
    const maxPct = Math.max(reqPct, tokPct);

    let newState;
    if (maxPct > 0.95) newState = STATES.EXHAUSTED;
    else if (maxPct > 0.70) newState = STATES.THROTTLED;
    else newState = STATES.AVAILABLE;

    if (newState !== this._prevState) {
      this.state = newState;
      if (newState === STATES.EXHAUSTED) {
        eventBus.emit('quota.exhausted', { provider: this.providerId });
      } else if (newState === STATES.THROTTLED) {
        eventBus.emit('quota.throttled', { provider: this.providerId, pct: maxPct });
      } else if (this._prevState === STATES.EXHAUSTED && newState === STATES.AVAILABLE) {
        eventBus.emit('quota.reset', { provider: this.providerId });
      }
      this._prevState = newState;
    }
  }

  _estimateReset() {
    if (this.state !== STATES.EXHAUSTED) return 0;
    const oldest = this.requests.entries[0]?.timestamp || Date.now();
    return Math.max(0, oldest + this.requests.windowMs - Date.now());
  }
}

/**
 * Manages QuotaTrackers for all configured providers.
 */
export class QuotaManager {
  constructor() {
    this.trackers = new Map();
    this._tickInterval = null;
  }

  addProvider(providerId, quotaConfig) {
    this.trackers.set(providerId, new ProviderQuotaTracker(providerId, quotaConfig));
  }

  canExecute(providerId, estimatedTokens = 0) {
    const tracker = this.trackers.get(providerId);
    if (!tracker) return true; // Unknown provider = no limits
    return tracker.canExecute(estimatedTokens);
  }

  recordUsage(providerId, tokensIn, tokensOut = 0) {
    const tracker = this.trackers.get(providerId);
    if (tracker) tracker.recordUsage(tokensIn, tokensOut);
  }

  getStatus(providerId) {
    const tracker = this.trackers.get(providerId);
    return tracker ? tracker.getStatus() : null;
  }

  getAllStatuses() {
    const result = {};
    for (const [id, tracker] of this.trackers) {
      result[id] = tracker.getStatus();
    }
    return result;
  }

  /**
   * Start the tick timer that prunes windows and detects resets.
   */
  startWatcher(intervalMs = 1000) {
    this.stopWatcher();
    this._tickInterval = setInterval(() => {
      for (const tracker of this.trackers.values()) {
        tracker.tick();
      }
    }, intervalMs);
  }

  stopWatcher() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
  }
}

export default QuotaManager;
