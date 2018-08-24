'use strict';

var policy = require('./retryPolicy');
var Reasons = require('../../carrier-service/src/domain/normalize').FailureReasons;

// Injected randomness: 0.5 lands exactly in the middle of the jitter band,
// which makes the expected delay the plain exponential value.
var noJitter = { random: function () { return 0.5; } };

describe('backoffFor', function () {
  it('doubles each attempt', function () {
    expect(policy.backoffFor(1, noJitter)).toBe(2000);
    expect(policy.backoffFor(2, noJitter)).toBe(4000);
    expect(policy.backoffFor(3, noJitter)).toBe(8000);
    expect(policy.backoffFor(4, noJitter)).toBe(16000);
  });

  it('caps at the ceiling instead of growing forever', function () {
    expect(policy.backoffFor(20, noJitter)).toBe(900000);
  });

  it('stays inside the jitter band at both extremes', function () {
    var low = policy.backoffFor(3, { random: function () { return 0; } });
    var high = policy.backoffFor(3, { random: function () { return 0.999999; } });

    expect(low).toBe(5600);    // 8000 * 0.7
    expect(high).toBeLessThanOrEqual(10400);   // 8000 * 1.3
    expect(high).toBeGreaterThan(10390);
  });

  it('actually spreads jobs out, which is the entire point', function () {
    var delays = {};
    for (var i = 0; i < 200; i++) {
      delays[policy.backoffFor(5, {})] = true;
    }
    // With real randomness 200 jobs should not collapse onto a handful of
    // wake-up times.
    expect(Object.keys(delays).length).toBeGreaterThan(100);
  });

  it('returns 0 for a nonsensical attempt number', function () {
    expect(policy.backoffFor(0, noJitter)).toBe(0);
    expect(policy.backoffFor(-3, noJitter)).toBe(0);
  });
});

describe('shouldRetry', function () {
  it('retries a carrier that is simply down', function () {
    expect(policy.shouldRetry(Reasons.CARRIER_UNAVAILABLE, 1).retry).toBe(true);
  });

  it('retries rate limiting', function () {
    expect(policy.shouldRetry(Reasons.RATE_LIMITED, 1).retry).toBe(true);
  });

  it('does not retry a bad rate plan, which will be just as bad next time', function () {
    var result = policy.shouldRetry(Reasons.INVALID_RATE_PLAN, 1);

    expect(result.retry).toBe(false);
    expect(result.reason).toBe('NOT_RETRYABLE');
  });

  it('does not retry an already active SIM', function () {
    expect(policy.shouldRetry(Reasons.SIM_ALREADY_ACTIVE, 1).retry).toBe(false);
  });

  it('gives up after the attempt limit even on a retryable failure', function () {
    var result = policy.shouldRetry(Reasons.CARRIER_UNAVAILABLE, 8);

    expect(result.retry).toBe(false);
    expect(result.reason).toBe('MAX_ATTEMPTS_EXHAUSTED');
  });
});

describe('nextAction', function () {
  var clock = { now: function () { return Date.parse('2018-09-16T02:30:00.000Z'); } };

  it('schedules a retry with a concrete wake-up time', function () {
    var action = policy.nextAction(
      { attempts: 2 },
      Reasons.CARRIER_UNAVAILABLE,
      Object.assign({}, noJitter, clock)
    );

    expect(action.action).toBe('RETRY');
    expect(action.delayMs).toBe(4000);
    expect(action.nextAttemptAt).toBe('2018-09-16T02:30:04.000Z');
    expect(action.attempts).toBe(3);
  });

  it('dead letters a permanent failure on the first attempt', function () {
    var action = policy.nextAction({ attempts: 1 }, Reasons.INVALID_RATE_PLAN, clock);

    expect(action.action).toBe('DEAD_LETTER');
    expect(action.reason).toBe('NOT_RETRYABLE');
    expect(action.failureReason).toBe(Reasons.INVALID_RATE_PLAN);
  });

  it('dead letters once the attempts run out', function () {
    var action = policy.nextAction({ attempts: 8 }, Reasons.CARRIER_UNAVAILABLE, clock);

    expect(action.action).toBe('DEAD_LETTER');
    expect(action.reason).toBe('MAX_ATTEMPTS_EXHAUSTED');
  });

  it('treats a job with no attempt count as brand new', function () {
    var action = policy.nextAction({}, Reasons.RATE_LIMITED, Object.assign({}, noJitter, clock));

    expect(action.action).toBe('RETRY');
    expect(action.attempts).toBe(1);
  });
});
