'use strict';

/**
 * Circuit breaker.
 *
 * Written rather than pulled from npm because the behaviour we need is
 * specific: carriers fail in bursts during their maintenance windows, and we
 * would rather fail fast for ninety seconds than queue up thousands of
 * requests against a box that is not answering. A generic breaker tuned for
 * millisecond web calls is the wrong shape for a partner API that routinely
 * takes eight seconds on a good day.
 *
 * The clock is injected. A breaker you cannot test without sleeping in the
 * test suite is a breaker nobody will write tests for.
 *
 *   CLOSED    - traffic flows, failures are counted
 *   OPEN      - traffic is rejected immediately, until resetTimeoutMs passes
 *   HALF_OPEN - one probe is allowed through to see if the carrier is back
 */

var State = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

function CircuitOpenError(name, retryAfterMs) {
  this.name = 'CircuitOpenError';
  this.code = 'CIRCUIT_OPEN';
  this.carrier = name;
  this.retryAfterMs = retryAfterMs;
  this.message = 'Circuit is open for ' + name + ', retry in ' + retryAfterMs + 'ms';
}
CircuitOpenError.prototype = Object.create(Error.prototype);
CircuitOpenError.prototype.constructor = CircuitOpenError;

function CircuitBreaker(options) {
  var opts = options || {};

  this.name = opts.name || 'unnamed';
  this.failureThreshold = opts.failureThreshold || 5;
  this.resetTimeoutMs = opts.resetTimeoutMs || 90000;
  this.now = opts.now || function () { return Date.now(); };

  // Which errors should trip the breaker. A 404 from a carrier means the SIM
  // is not there, which is a perfectly healthy answer to a bad question - it
  // should not count towards opening the circuit. Only genuine unavailability
  // does. Callers pass their own predicate because each carrier expresses
  // "I am unwell" differently.
  this.isFailure = opts.isFailure || function (err) {
    return !err || !err.status || err.status >= 500;
  };

  this.state = State.CLOSED;
  this.failureCount = 0;
  this.openedAt = null;
  this.listeners = [];
}

CircuitBreaker.prototype.onStateChange = function (fn) {
  this.listeners.push(fn);
};

CircuitBreaker.prototype._transition = function (to) {
  if (this.state === to) {
    return;
  }

  var from = this.state;
  this.state = to;

  for (var i = 0; i < this.listeners.length; i++) {
    // A listener blowing up must not take the breaker with it.
    try {
      this.listeners[i]({ carrier: this.name, from: from, to: to, at: this.now() });
    } catch (e) {
      // deliberately swallowed - metrics are not worth an outage
    }
  }
};

CircuitBreaker.prototype.currentState = function () {
  if (this.state === State.OPEN && this.now() - this.openedAt >= this.resetTimeoutMs) {
    this._transition(State.HALF_OPEN);
  }
  return this.state;
};

CircuitBreaker.prototype.retryAfterMs = function () {
  if (this.state !== State.OPEN) {
    return 0;
  }
  var remaining = this.resetTimeoutMs - (this.now() - this.openedAt);
  return remaining > 0 ? remaining : 0;
};

CircuitBreaker.prototype.recordSuccess = function () {
  this.failureCount = 0;
  this.openedAt = null;
  this._transition(State.CLOSED);
};

CircuitBreaker.prototype.recordFailure = function () {
  this.failureCount = this.failureCount + 1;

  // A probe that fails in HALF_OPEN puts us straight back to OPEN and
  // restarts the clock. No point letting a second probe through immediately.
  if (this.state === State.HALF_OPEN || this.failureCount >= this.failureThreshold) {
    this.openedAt = this.now();
    this._transition(State.OPEN);
  }
};

/**
 * Run `fn` (a function returning a promise) through the breaker.
 */
CircuitBreaker.prototype.run = function (fn) {
  var self = this;
  var state = this.currentState();

  if (state === State.OPEN) {
    return Promise.reject(new CircuitOpenError(this.name, this.retryAfterMs()));
  }

  return fn().then(
    function (result) {
      self.recordSuccess();
      return result;
    },
    function (err) {
      if (self.isFailure(err)) {
        self.recordFailure();
      } else {
        // A well-formed "no" still proves the carrier is up.
        self.recordSuccess();
      }
      throw err;
    }
  );
};

module.exports = {
  CircuitBreaker: CircuitBreaker,
  CircuitOpenError: CircuitOpenError,
  State: State
};
