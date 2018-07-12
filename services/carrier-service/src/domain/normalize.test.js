'use strict';

var n = require('./normalize');
var States = n.States;
var Reasons = n.FailureReasons;

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

describe('AT&T', function () {
  it('maps the screaming snake statuses', function () {
    expect(n.fromAtt({ status: 'PREACTIVE' }).state).toBe(States.PRE_ACTIVE);
    expect(n.fromAtt({ status: 'ACTIVE' }).state).toBe(States.ACTIVE);
    expect(n.fromAtt({ status: 'DEACTIVATED' }).state).toBe(States.TERMINATED);
  });

  it('folds both suspension flavours to SUSPENDED but keeps who did it', function () {
    var byCarrier = n.fromAtt({ status: 'SUSPENDED_BY_CARRIER' });
    var byCustomer = n.fromAtt({ status: 'SUSPENDED_BY_CUSTOMER' });

    expect(byCarrier.state).toBe(States.SUSPENDED);
    expect(byCarrier.suspendedBy).toBe('CARRIER');

    expect(byCustomer.state).toBe(States.SUSPENDED);
    expect(byCustomer.suspendedBy).toBe('CUSTOMER');
  });

  it('leaves suspendedBy null when the SIM is not suspended', function () {
    expect(n.fromAtt({ status: 'ACTIVE' }).suspendedBy).toBeNull();
  });

  it('reads the offer code as our rate plan', function () {
    expect(n.fromAtt({ status: 'ACTIVE', offerCode: 'ATT_UNL_55' }).ratePlanId).toBe('ATT_UNL_55');
  });
});

describe('failureReason', function () {
  it('translates each carrier error vocabulary to ours', function () {
    expect(n.failureReason('bell', 'E512')).toBe(Reasons.INVALID_RATE_PLAN);
    expect(n.failureReason('vodafone', 'TAR-0002')).toBe(Reasons.INVALID_RATE_PLAN);
    expect(n.failureReason('att', 'INVALID_OFFER_CODE')).toBe(Reasons.INVALID_RATE_PLAN);
  });

  it('agrees across carriers about a delinquent account', function () {
    expect(n.failureReason('bell', 'E601')).toBe(Reasons.ACCOUNT_DELINQUENT);
    expect(n.failureReason('vodafone', 'BIL-0031')).toBe(Reasons.ACCOUNT_DELINQUENT);
    expect(n.failureReason('att', 'PAST_DUE_BALANCE')).toBe(Reasons.ACCOUNT_DELINQUENT);
  });

  it('prefers the carrier code over the HTTP status', function () {
    // Bell answer 500 for what is really a validation problem. Believing the
    // status code here would mean retrying something that can never succeed.
    expect(n.failureReason('bell', 'E512', 500)).toBe(Reasons.INVALID_RATE_PLAN);
  });

  it('falls back to the HTTP status when the code is unknown', function () {
    expect(n.failureReason('bell', 'E999', 404)).toBe(Reasons.SIM_NOT_FOUND);
    expect(n.failureReason('att', null, 429)).toBe(Reasons.RATE_LIMITED);
    expect(n.failureReason('vodafone', null, 503)).toBe(Reasons.CARRIER_UNAVAILABLE);
  });

  it('says UNKNOWN rather than inventing a reason', function () {
    expect(n.failureReason('bell', null, 418)).toBe(Reasons.UNKNOWN);
    expect(n.failureReason('threeuk', 'WHATEVER', 400)).toBe(Reasons.UNKNOWN);
  });
});

describe('isRetryable', function () {
  it('retries things that might resolve themselves', function () {
    expect(n.isRetryable(Reasons.CARRIER_UNAVAILABLE)).toBe(true);
    expect(n.isRetryable(Reasons.RATE_LIMITED)).toBe(true);
    expect(n.isRetryable(Reasons.NO_NUMBERS_AVAILABLE)).toBe(true);
  });

  it('does not retry things that will never succeed', function () {
    expect(n.isRetryable(Reasons.INVALID_RATE_PLAN)).toBe(false);
    expect(n.isRetryable(Reasons.SIM_NOT_FOUND)).toBe(false);
    expect(n.isRetryable(Reasons.SIM_ALREADY_ACTIVE)).toBe(false);
    expect(n.isRetryable(Reasons.ACCOUNT_DELINQUENT)).toBe(false);
    expect(n.isRetryable(Reasons.UNKNOWN)).toBe(false);
  });
});
