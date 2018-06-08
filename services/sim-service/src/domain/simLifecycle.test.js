'use strict';

var lifecycle = require('./simLifecycle');
var States = lifecycle.States;
var Events = lifecycle.Events;
var Reasons = lifecycle.SuspensionReasons;

var AT = '2018-06-04T09:15:00.000Z';

function simIn(state, extra) {
  return Object.assign({
    iccid: '8913027201000024686',
    carrier: 'bell',
    state: state,
    msisdn: null
  }, extra || {});
}

function expectRejected(fn, code) {
  try {
    fn();
  } catch (err) {
    expect(err.name).toBe('TransitionError');
    expect(err.code).toBe(code);
    return;
  }
  throw new Error('expected a TransitionError with code ' + code + ', but nothing was thrown');
}

describe('transition table', function () {
  it('allows the happy path from inventory to active', function () {
    expect(lifecycle.can(States.PRE_ACTIVE, Events.ACTIVATE_REQUESTED)).toBe(true);
    expect(lifecycle.can(States.ACTIVATING, Events.ACTIVATE_CONFIRMED)).toBe(true);
  });

  it('treats TERMINATED as final', function () {
    expect(lifecycle.allowedEvents(States.TERMINATED)).toEqual([]);
    expect(lifecycle.can(States.TERMINATED, Events.ACTIVATE_REQUESTED)).toBe(false);
    expect(lifecycle.can(States.TERMINATED, Events.RESUME)).toBe(false);
  });

  it('will not suspend a SIM that was never activated', function () {
    expect(lifecycle.can(States.PRE_ACTIVE, Events.SUSPEND)).toBe(false);
  });

  it('reports nothing for an unknown state rather than throwing', function () {
    expect(lifecycle.can('BANANA', Events.SUSPEND)).toBe(false);
    expect(lifecycle.allowedEvents('BANANA')).toEqual([]);
  });
});

describe('activation', function () {
  it('moves to ACTIVATING and emits a request event', function () {
    var result = lifecycle.apply(simIn(States.PRE_ACTIVE), Events.ACTIVATE_REQUESTED, {
      ratePlanId: 'PLAN_5GB',
      occurredAt: AT
    });

    expect(result.sim.state).toBe(States.ACTIVATING);
    expect(result.sim.ratePlanId).toBe('PLAN_5GB');
    expect(result.events).toHaveLength(1);
    expect(result.events[0].type).toBe('sim.activation.requested');
    expect(result.events[0].ratePlanId).toBe('PLAN_5GB');
  });

  it('refuses to activate without a rate plan', function () {
    expectRejected(function () {
      lifecycle.apply(simIn(States.PRE_ACTIVE), Events.ACTIVATE_REQUESTED, {});
    }, 'RATE_PLAN_REQUIRED');
  });

  it('refuses to activate a SIM with no carrier assigned', function () {
    expectRejected(function () {
      lifecycle.apply(simIn(States.PRE_ACTIVE, { carrier: null }), Events.ACTIVATE_REQUESTED, {
        ratePlanId: 'PLAN_5GB'
      });
    }, 'CARRIER_REQUIRED');
  });

  it('records the MSISDN the carrier handed back on confirmation', function () {
    var result = lifecycle.apply(simIn(States.ACTIVATING), Events.ACTIVATE_CONFIRMED, {
      msisdn: '14165550142',
      occurredAt: AT
    });

    expect(result.sim.state).toBe(States.ACTIVE);
    expect(result.sim.msisdn).toBe('14165550142');
    expect(result.sim.activatedAt).toBe(AT);
    expect(result.events[0].type).toBe('sim.activated');
  });

  it('falls back to PRE_ACTIVE on failure so the SIM can be retried', function () {
    var result = lifecycle.apply(simIn(States.ACTIVATING, { ratePlanId: 'PLAN_5GB' }), Events.ACTIVATE_FAILED, {
      reason: 'NO_NUMBERS_AVAILABLE',
      occurredAt: AT
    });

    expect(result.sim.state).toBe(States.PRE_ACTIVE);
    expect(result.sim.lastFailureReason).toBe('NO_NUMBERS_AVAILABLE');
    // The rate plan is cleared - the next attempt re-supplies it, so a stale
    // plan cannot silently ride along into a retry.
    expect(result.sim.ratePlanId).toBeNull();
  });
});

describe('suspension', function () {
  it('requires a reason', function () {
    expectRejected(function () {
      lifecycle.apply(simIn(States.ACTIVE), Events.SUSPEND, {});
    }, 'SUSPENSION_REASON_REQUIRED');
  });

  it('rejects a reason that is not in our vocabulary', function () {
    expectRejected(function () {
      lifecycle.apply(simIn(States.ACTIVE), Events.SUSPEND, { reason: 'BECAUSE_I_SAID_SO' });
    }, 'SUSPENSION_REASON_UNKNOWN');
  });

  it('carries the reason onto the SIM and the event', function () {
    var result = lifecycle.apply(simIn(States.ACTIVE), Events.SUSPEND, {
      reason: Reasons.NON_PAYMENT,
      occurredAt: AT
    });

    expect(result.sim.state).toBe(States.SUSPENDED);
    expect(result.sim.suspensionReason).toBe(Reasons.NON_PAYMENT);
    expect(result.events[0].reason).toBe(Reasons.NON_PAYMENT);
  });

  it('resumes a non-payment suspension without ceremony', function () {
    var suspended = simIn(States.SUSPENDED, { suspensionReason: Reasons.NON_PAYMENT });
    var result = lifecycle.apply(suspended, Events.RESUME, { occurredAt: AT });

    expect(result.sim.state).toBe(States.ACTIVE);
    expect(result.sim.suspensionReason).toBeNull();
  });

  it('will not resume a fraud suspension without an approver', function () {
    var frozen = simIn(States.SUSPENDED, { suspensionReason: Reasons.FRAUD });

    expectRejected(function () {
      lifecycle.apply(frozen, Events.RESUME, {});
    }, 'FRAUD_RESUME_NEEDS_APPROVAL');
  });

  it('resumes a fraud suspension when an approver signed off', function () {
    var frozen = simIn(States.SUSPENDED, { suspensionReason: Reasons.FRAUD });
    var result = lifecycle.apply(frozen, Events.RESUME, { approvedBy: 'risk-team:hsalehi', occurredAt: AT });

    expect(result.sim.state).toBe(States.ACTIVE);
    expect(result.events[0].approvedBy).toBe('risk-team:hsalehi');
  });
});

describe('termination', function () {
  it('can be reached from inventory, active and suspended', function () {
    [States.PRE_ACTIVE, States.ACTIVE, States.SUSPENDED].forEach(function (from) {
      var result = lifecycle.apply(simIn(from, { suspensionReason: null }), Events.TERMINATE_REQUESTED, {
        occurredAt: AT
      });
      expect(result.sim.state).toBe(States.TERMINATING);
    });
  });

  it('releases the MSISDN on confirmation because the carrier has taken it back', function () {
    var terminating = simIn(States.TERMINATING, { msisdn: '14165550142' });
    var result = lifecycle.apply(terminating, Events.TERMINATE_CONFIRMED, { occurredAt: AT });

    expect(result.sim.state).toBe(States.TERMINATED);
    expect(result.sim.msisdn).toBeNull();
    expect(result.sim.terminatedAt).toBe(AT);
  });

  it('cannot resurrect a terminated SIM', function () {
    expectRejected(function () {
      lifecycle.apply(simIn(States.TERMINATED), Events.ACTIVATE_REQUESTED, { ratePlanId: 'PLAN_5GB' });
    }, 'TRANSITION_NOT_ALLOWED');
  });
});

describe('purity', function () {
  it('never mutates the SIM it was given', function () {
    var original = simIn(States.ACTIVE);
    var snapshot = JSON.stringify(original);

    lifecycle.apply(original, Events.SUSPEND, { reason: Reasons.LOST_OR_STOLEN, occurredAt: AT });

    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it('is deterministic when given an explicit occurredAt', function () {
    var sim = simIn(States.ACTIVE);
    var a = lifecycle.apply(sim, Events.SUSPEND, { reason: Reasons.FRAUD, occurredAt: AT });
    var b = lifecycle.apply(sim, Events.SUSPEND, { reason: Reasons.FRAUD, occurredAt: AT });

    expect(a).toEqual(b);
  });

  it('rejects a SIM with no state at all', function () {
    expectRejected(function () {
      lifecycle.apply({ iccid: '891302' }, Events.SUSPEND, { reason: Reasons.FRAUD });
    }, 'SIM_STATE_MISSING');
  });

  it('rejects a state it does not recognise', function () {
    expectRejected(function () {
      lifecycle.apply(simIn('HALF_ON'), Events.SUSPEND, { reason: Reasons.FRAUD });
    }, 'SIM_STATE_UNKNOWN');
  });
});
