'use strict';

/**
 * Retry policy for carrier provisioning jobs.
 *
 * Pure: given an attempt number it tells you how long to wait and whether to
 * give up. The randomness is injected so the tests are deterministic.
 *
 * Jitter matters more here than it looks. Bell's maintenance window is
 * 02:00-04:00 Eastern every Sunday, and without jitter every job that failed
 * during it wakes up at exactly the same millisecond afterwards and knocks
 * the API straight back over. We learned that the interesting way.
 */

var normalize = require('../../carrier-service/src/domain/normalize');

var DEFAULTS = {
  baseDelayMs: 2000,
  maxDelayMs: 900000,   // 15 minutes - past this a human should look at it
  maxAttempts: 8,
  jitterRatio: 0.3      // +/- 30%
};

/**
 * Exponential backoff with full-width jitter, capped.
 *
 * attempt is 1-based: the delay before the *second* try is backoffFor(1).
 */
function backoffFor(attempt, options) {
  var opts = Object.assign({}, DEFAULTS, options || {});
  var random = opts.random || Math.random;

  if (attempt < 1) {
    return 0;
  }

  var exponential = opts.baseDelayMs * Math.pow(2, attempt - 1);
  var capped = Math.min(exponential, opts.maxDelayMs);

  // random() in [0,1) maps to a multiplier in [1 - r, 1 + r)
  var multiplier = 1 - opts.jitterRatio + (random() * opts.jitterRatio * 2);
  var jittered = Math.round(capped * multiplier);

  return jittered < 0 ? 0 : jittered;
}

/**
 * Should this job be tried again?
 *
 * Two independent reasons to stop: the failure is one that will never
 * succeed (a bad rate plan stays bad), or we have simply tried enough times.
 */
function shouldRetry(failureReason, attempt, options) {
  var opts = Object.assign({}, DEFAULTS, options || {});

  if (!normalize.isRetryable(failureReason)) {
    return { retry: false, reason: 'NOT_RETRYABLE' };
  }

  if (attempt >= opts.maxAttempts) {
    return { retry: false, reason: 'MAX_ATTEMPTS_EXHAUSTED' };
  }

  return { retry: true, reason: null };
}

/**
 * Work out what to do with a job that just failed.
 * Returns either a scheduled retry or a move to the dead letter queue.
 */
function nextAction(job, failureReason, options) {
  var opts = Object.assign({}, DEFAULTS, options || {});
  var now = opts.now ? opts.now() : Date.now();
  var attempt = job.attempts || 0;

  var decision = shouldRetry(failureReason, attempt, opts);

  if (!decision.retry) {
    return {
      action: 'DEAD_LETTER',
      reason: decision.reason,
      failureReason: failureReason,
      attempts: attempt
    };
  }

  var delay = backoffFor(attempt, opts);

  return {
    action: 'RETRY',
    delayMs: delay,
    nextAttemptAt: new Date(now + delay).toISOString(),
    attempts: attempt + 1,
    failureReason: failureReason
  };
}

module.exports = {
  DEFAULTS: DEFAULTS,
  backoffFor: backoffFor,
  shouldRetry: shouldRetry,
  nextAction: nextAction
};
