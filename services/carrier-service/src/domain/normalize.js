'use strict';

/**
 * Carrier response normalisation.
 *
 * One canonical model, defined by us. Every carrier response is translated
 * into it here, in pure functions, so that nothing above this layer ever
 * sees a carrier's own vocabulary.
 *
 * Bell first, since they are the only carrier live today. Vodafone and AT&T
 * follow the same shape.
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

module.exports = {
  States: States,
  fromBell: fromBell
};
