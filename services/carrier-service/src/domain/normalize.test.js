'use strict';

var n = require('./normalize');
var States = n.States;

describe('Bell', function () {
  it('maps the mainframe two letter codes', function () {
    expect(n.fromBell({ STATUS: 'IN' }).state).toBe(States.PRE_ACTIVE);
    expect(n.fromBell({ STATUS: 'AC' }).state).toBe(States.ACTIVE);
    expect(n.fromBell({ STATUS: 'SU' }).state).toBe(States.SUSPENDED);
    expect(n.fromBell({ STATUS: 'DE' }).state).toBe(States.TERMINATED);
  });

  it('copes with the space padding they put on every field', function () {
    expect(n.fromBell({ STATUS: '  AC  ' }).state).toBe(States.ACTIVE);
  });

  it('strips the dashes and leading country code off an MSISDN', function () {
    expect(n.fromBell({ STATUS: 'AC', MSISDN: '1-416-555-0142' }).msisdn).toBe('14165550142');
  });

  it('flags a status it has never seen instead of guessing', function () {
    var result = n.fromBell({ STATUS: 'XX' });

    expect(result.recognised).toBe(false);
    expect(result.state).toBeNull();
    expect(result.rawStatus).toBe('XX');
  });

  it('does not fall over on an empty body', function () {
    var result = n.fromBell(null);

    expect(result.recognised).toBe(false);
    expect(result.msisdn).toBeNull();
  });
});

describe('Vodafone', function () {
  it('reads the nested subscriber envelope', function () {
    var payload = { subscriber: { status: 'active', msisdn: '+447700900142', tariff_code: 'VF_5GB' } };
    var result = n.fromVodafone(payload);

    expect(result.state).toBe(States.ACTIVE);
    expect(result.msisdn).toBe('447700900142');
    expect(result.ratePlanId).toBe('VF_5GB');
  });

  it('folds "assigned" into PRE_ACTIVE, since it carries no traffic either', function () {
    expect(n.fromVodafone({ subscriber: { status: 'assigned' } }).state).toBe(States.PRE_ACTIVE);
    expect(n.fromVodafone({ subscriber: { status: 'stock' } }).state).toBe(States.PRE_ACTIVE);
  });

  it('distinguishes the two in-progress states', function () {
    expect(n.fromVodafone({ subscriber: { status: 'activation_in_progress' } }).state).toBe(States.ACTIVATING);
    expect(n.fromVodafone({ subscriber: { status: 'deactivation_in_progress' } }).state).toBe(States.TERMINATING);
  });

  it('is case and whitespace insensitive', function () {
    expect(n.fromVodafone({ subscriber: { status: ' ACTIVE ' } }).state).toBe(States.ACTIVE);
  });

  it('survives a missing subscriber envelope', function () {
    expect(n.fromVodafone({}).recognised).toBe(false);
  });
});
