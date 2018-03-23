'use strict';

var lifecycle = require('./simLifecycle');
var States = lifecycle.States;
var Events = lifecycle.Events;

var AT = '2018-03-19T09:15:00.000Z';

function simIn(state, extra) {
  return Object.assign({
    iccid: '8913027201000024686',
    carrier: 'bell',
    state: state,
    msisdn: null
  }, extra || {});
}

describe('transition table', function () {
  it('allows the happy path from inventory to active', function () {
    expect(lifecycle.can(States.PRE_ACTIVE, Events.ACTIVATE_REQUESTED)).toBe(true);
    expect(lifecycle.can(States.ACTIVATING, Events.ACTIVATE_CONFIRMED)).toBe(true);
  });

  it('treats TERMINATED as final', function () {
    expect(lifecycle.allowedEvents(States.TERMINATED)).toEqual([]);
    expect(lifecycle.can(States.TERMINATED, Events.ACTIVATE_REQUESTED)).toBe(false);
  });

  it('will not suspend a SIM that was never activated', function () {
    expect(lifecycle.can(States.PRE_ACTIVE, Events.SUSPEND)).toBe(false);
  });

  it('reports nothing for an unknown state rather than throwing', function () {
    expect(lifecycle.can('BANANA', Events.SUSPEND)).toBe(false);
    expect(lifecycle.allowedEvents('BANANA')).toEqual([]);
  });
});

describe('applying events', function () {
  it('moves to ACTIVATING and records the rate plan', function () {
    var next = lifecycle.apply(simIn(States.PRE_ACTIVE), Events.ACTIVATE_REQUESTED, {
      ratePlanId: 'PLAN_5GB',
      occurredAt: AT
    });

    expect(next.state).toBe(States.ACTIVATING);
    expect(next.ratePlanId).toBe('PLAN_5GB');
  });

  it('records the MSISDN the carrier handed back on confirmation', function () {
    var next = lifecycle.apply(simIn(States.ACTIVATING), Events.ACTIVATE_CONFIRMED, {
      msisdn: '14165550142',
      occurredAt: AT
    });

    expect(next.state).toBe(States.ACTIVE);
    expect(next.msisdn).toBe('14165550142');
  });

  it('falls back to PRE_ACTIVE on failure so the SIM can be retried', function () {
    var next = lifecycle.apply(simIn(States.ACTIVATING, { ratePlanId: 'PLAN_5GB' }), Events.ACTIVATE_FAILED, {
      reason: 'NO_NUMBERS_AVAILABLE',
      occurredAt: AT
    });

    expect(next.state).toBe(States.PRE_ACTIVE);
    expect(next.ratePlanId).toBeNull();
  });

  it('releases the MSISDN on termination', function () {
    var next = lifecycle.apply(simIn(States.TERMINATING, { msisdn: '14165550142' }), Events.TERMINATE_CONFIRMED, {
      occurredAt: AT
    });

    expect(next.state).toBe(States.TERMINATED);
    expect(next.msisdn).toBeNull();
  });

  it('cannot resurrect a terminated SIM', function () {
    expect(function () {
      lifecycle.apply(simIn(States.TERMINATED), Events.ACTIVATE_REQUESTED, { ratePlanId: 'PLAN_5GB' });
    }).toThrow();
  });

  it('never mutates the SIM it was given', function () {
    var original = simIn(States.ACTIVE);
    var snapshot = JSON.stringify(original);

    lifecycle.apply(original, Events.SUSPEND, { occurredAt: AT });

    expect(JSON.stringify(original)).toBe(snapshot);
  });
});
