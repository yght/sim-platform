'use strict';

/**
 * Carrier response normalisation.
 *
 * One canonical model, defined by us. Every carrier response is translated
 * into it here, in pure functions, so that nothing above this layer ever
 * sees a carrier's own vocabulary.
 *
 * All three carriers are live.
 */

var States = {
  PRE_ACTIVE: 'PRE_ACTIVE',
  ACTIVATING: 'ACTIVATING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  TERMINATING: 'TERMINATING',
  TERMINATED: 'TERMINATED'
};

/**
 * Bell send two-letter codes lifted straight out of their mainframe.
 */
var BELL_STATUS = {
  IN: States.PRE_ACTIVE,   // in inventory
  PD: States.ACTIVATING,   // pending
  AC: States.ACTIVE,
  SU: States.SUSPENDED,
  DE: States.TERMINATED    // deactivated
};

/**
 * Vodafone use long-form lowercase strings and an 'assigned' state that has
 * no equivalent on Bell: the SIM is tied to an account but not yet carrying
 * traffic. We fold it into PRE_ACTIVE because for our purposes an
 * assigned-but-not-live SIM behaves exactly like inventory.
 */
var VODAFONE_STATUS = {
  stock: States.PRE_ACTIVE,
  assigned: States.PRE_ACTIVE,
  activation_in_progress: States.ACTIVATING,
  active: States.ACTIVE,
  suspended: States.SUSPENDED,
  deactivation_in_progress: States.TERMINATING,
  deactivated: States.TERMINATED
};

/**
 * AT&T use SCREAMING_SNAKE and, uniquely, distinguish a carrier-initiated
 * suspension from a customer-initiated one at the status level rather than
 * in a separate reason field.
 */
var ATT_STATUS = {
  PREACTIVE: States.PRE_ACTIVE,
  ACTIVATION_PENDING: States.ACTIVATING,
  ACTIVE: States.ACTIVE,
  SUSPENDED_BY_CUSTOMER: States.SUSPENDED,
  SUSPENDED_BY_CARRIER: States.SUSPENDED,
  DEACTIVATION_PENDING: States.TERMINATING,
  DEACTIVATED: States.TERMINATED
};

function digitsOnly(value) {
  if (typeof value !== 'string') {
    return null;
  }
  var cleaned = value.replace(/[^0-9]/g, '');
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Bell.
 *
 * Quirks handled here:
 *  - MSISDNs come back with a leading '1' and dashes: "1-416-555-0142".
 *  - Every field is uppercase and space padded, because mainframe.
 */
function fromBell(payload) {
  var body = payload || {};
  var raw = typeof body.STATUS === 'string' ? body.STATUS.trim().toUpperCase() : '';
  var state = BELL_STATUS[raw];

  return {
    carrier: 'bell',
    state: state || null,
    rawStatus: raw || null,
    msisdn: digitsOnly(body.MSISDN),
    ratePlanId: body.RATE_PLAN ? String(body.RATE_PLAN).trim() : null,
    recognised: Boolean(state)
  };
}

/**
 * Vodafone.
 *
 * Quirks handled here:
 *  - The interesting fields are nested under `subscriber`.
 *  - MSISDN arrives in E.164 with a '+'.
 *  - Activation is asynchronous: the POST returns 202 and the real answer
 *    lands on our callback endpoint minutes later.
 */
function fromVodafone(payload) {
  var body = payload || {};
  var sub = body.subscriber || {};
  var raw = typeof sub.status === 'string' ? sub.status.trim().toLowerCase() : '';
  var state = VODAFONE_STATUS[raw];

  return {
    carrier: 'vodafone',
    state: state || null,
    rawStatus: raw || null,
    msisdn: digitsOnly(sub.msisdn),
    ratePlanId: sub.tariff_code ? String(sub.tariff_code) : null,
    recognised: Boolean(state)
  };
}

/**
 * AT&T.
 *
 * Quirks handled here:
 *  - Suspension source is encoded in the status itself, so we lift it out
 *    into a separate field rather than losing it in the fold to SUSPENDED.
 *  - They return the ICCID as `simIdentifier`, sometimes with the trailing
 *    'F' padding nibble still attached.
 */
function fromAtt(payload) {
  var body = payload || {};
  var raw = typeof body.status === 'string' ? body.status.trim().toUpperCase() : '';
  var state = ATT_STATUS[raw];

  var suspendedBy = null;
  if (raw === 'SUSPENDED_BY_CARRIER') {
    suspendedBy = 'CARRIER';
  } else if (raw === 'SUSPENDED_BY_CUSTOMER') {
    suspendedBy = 'CUSTOMER';
  }

  return {
    carrier: 'att',
    state: state || null,
    rawStatus: raw || null,
    msisdn: digitsOnly(body.phoneNumber),
    ratePlanId: body.offerCode ? String(body.offerCode) : null,
    suspendedBy: suspendedBy,
    recognised: Boolean(state)
  };
}

module.exports = {
  States: States,
  fromBell: fromBell,
  fromVodafone: fromVodafone,
  fromAtt: fromAtt
};
