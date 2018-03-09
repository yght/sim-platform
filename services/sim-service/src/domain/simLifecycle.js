'use strict';

/**
 * SIM lifecycle state machine.
 *
 * Pure: no database, no HTTP. You hand it the current SIM and an event, it
 * hands you back the next state. Everything that talks to the outside world
 * lives in the service layer above this file.
 *
 * The reason this is a table and not a pile of if-statements is that the
 * carriers disagree about what is legal. Rather than inherit whichever
 * carrier we integrated first, we decide here what our platform considers
 * legal and translate at the adapter boundary.
 */

var States = {
  PRE_ACTIVE: 'PRE_ACTIVE',
  ACTIVATING: 'ACTIVATING',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
  TERMINATING: 'TERMINATING',
  TERMINATED: 'TERMINATED'
};

var Events = {
  ACTIVATE_REQUESTED: 'ACTIVATE_REQUESTED',
  ACTIVATE_CONFIRMED: 'ACTIVATE_CONFIRMED',
  ACTIVATE_FAILED: 'ACTIVATE_FAILED',
  SUSPEND: 'SUSPEND',
  RESUME: 'RESUME',
  TERMINATE_REQUESTED: 'TERMINATE_REQUESTED',
  TERMINATE_CONFIRMED: 'TERMINATE_CONFIRMED'
};

/**
 * from-state -> event -> to-state.
 *
 * TERMINATED is deliberately absent as a source state. Once a carrier has
 * released the MSISDN back into its pool the number is gone; pretending we
 * can bring it back is how you end up promising a customer their old number.
 */
var TRANSITIONS = {
  PRE_ACTIVE: {
    ACTIVATE_REQUESTED: States.ACTIVATING,
    TERMINATE_REQUESTED: States.TERMINATING
  },
  ACTIVATING: {
    ACTIVATE_CONFIRMED: States.ACTIVE,
    ACTIVATE_FAILED: States.PRE_ACTIVE
  },
  ACTIVE: {
    SUSPEND: States.SUSPENDED,
    TERMINATE_REQUESTED: States.TERMINATING
  },
  SUSPENDED: {
    RESUME: States.ACTIVE,
    TERMINATE_REQUESTED: States.TERMINATING
  },
  TERMINATING: {
    TERMINATE_CONFIRMED: States.TERMINATED
  },
  TERMINATED: {}
};

function TransitionError(code, message) {
  this.name = 'TransitionError';
  this.code = code;
  this.message = message;
}
TransitionError.prototype = Object.create(Error.prototype);
TransitionError.prototype.constructor = TransitionError;

function can(fromState, event) {
  var allowed = TRANSITIONS[fromState];
  if (!allowed) {
    return false;
  }
  return Object.prototype.hasOwnProperty.call(allowed, event);
}

function allowedEvents(fromState) {
  var allowed = TRANSITIONS[fromState];
  if (!allowed) {
    return [];
  }
  return Object.keys(allowed);
}

/**
 * Apply an event to a SIM. Returns a new object; the input is never mutated.
 */
function apply(sim, event, context) {
  var ctx = context || {};

  if (!sim || !sim.state) {
    throw new TransitionError('SIM_STATE_MISSING', 'SIM has no state');
  }

  if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, sim.state)) {
    throw new TransitionError('SIM_STATE_UNKNOWN', 'Unknown SIM state: ' + sim.state);
  }

  if (!can(sim.state, event)) {
    throw new TransitionError(
      'TRANSITION_NOT_ALLOWED',
      'Cannot ' + event + ' a SIM in state ' + sim.state
    );
  }

  var occurredAt = ctx.occurredAt || new Date().toISOString();

  var next = Object.assign({}, sim, {
    state: TRANSITIONS[sim.state][event],
    updatedAt: occurredAt
  });

  if (event === Events.ACTIVATE_REQUESTED) {
    next.ratePlanId = ctx.ratePlanId;
    next.activationRequestedAt = occurredAt;
  }

  if (event === Events.ACTIVATE_CONFIRMED) {
    next.msisdn = ctx.msisdn || sim.msisdn;
    next.activatedAt = occurredAt;
    next.activationRequestedAt = null;
  }

  if (event === Events.ACTIVATE_FAILED) {
    next.ratePlanId = null;
    next.activationRequestedAt = null;
    next.lastFailureReason = ctx.reason || 'UNKNOWN';
  }

  if (event === Events.SUSPEND) {
    next.suspendedAt = occurredAt;
  }

  if (event === Events.RESUME) {
    next.suspendedAt = null;
  }

  if (event === Events.TERMINATE_REQUESTED) {
    next.terminationRequestedAt = occurredAt;
  }

  if (event === Events.TERMINATE_CONFIRMED) {
    next.terminatedAt = occurredAt;
    next.terminationRequestedAt = null;
    // The carrier has taken the number back. Holding on to it in our records
    // implies we still control it, and we do not.
    next.msisdn = null;
  }

  return next;
}

module.exports = {
  States: States,
  Events: Events,
  TransitionError: TransitionError,
  can: can,
  allowedEvents: allowedEvents,
  apply: apply
};
