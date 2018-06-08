'use strict';

/**
 * SIM lifecycle state machine.
 *
 * Pure: no database, no HTTP, no clock of its own. You hand it the current
 * SIM and an event, it hands you back the next state plus the domain events
 * that should be published. Everything that talks to the outside world lives
 * in the service layer above this file.
 *
 * The reason this is a table and not a pile of if-statements is that the
 * carriers disagree about what is legal. Vodafone will happily suspend an
 * already-suspended line and return 200; AT&T returns a 409. Rather than
 * inherit whichever carrier we integrated first, we decide here what our
 * platform considers legal and translate at the adapter boundary.
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

/**
 * Suspension reasons we accept. NON_PAYMENT is set by billing, FRAUD by the
 * risk team, CUSTOMER_REQUEST by a human in the support tool. We keep them
 * apart because resuming a FRAUD suspension needs a second pair of eyes and
 * the reason is what the approval workflow keys off.
 */
var SuspensionReasons = {
  NON_PAYMENT: 'NON_PAYMENT',
  FRAUD: 'FRAUD',
  CUSTOMER_REQUEST: 'CUSTOMER_REQUEST',
  LOST_OR_STOLEN: 'LOST_OR_STOLEN'
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
 * Guards that go beyond "is this edge in the table".
 * Returns null when the transition is permitted, or a TransitionError.
 */
function guard(sim, event, context) {
  var ctx = context || {};

  if (event === Events.ACTIVATE_REQUESTED) {
    if (!sim.carrier) {
      return new TransitionError('CARRIER_REQUIRED', 'Cannot activate a SIM with no carrier assigned');
    }
    if (!ctx.ratePlanId) {
      return new TransitionError('RATE_PLAN_REQUIRED', 'Activation requires a rate plan');
    }
  }

  if (event === Events.SUSPEND) {
    if (!ctx.reason) {
      return new TransitionError('SUSPENSION_REASON_REQUIRED', 'Suspension requires a reason');
    }
    if (!Object.prototype.hasOwnProperty.call(SuspensionReasons, ctx.reason)) {
      return new TransitionError('SUSPENSION_REASON_UNKNOWN', 'Unknown suspension reason: ' + ctx.reason);
    }
  }

  if (event === Events.RESUME) {
    // A line suspended for fraud does not come back because a customer
    // clicked a button in the portal. Someone signs off, and that sign-off
    // is carried on the context.
    if (sim.suspensionReason === SuspensionReasons.FRAUD && !ctx.approvedBy) {
      return new TransitionError('FRAUD_RESUME_NEEDS_APPROVAL', 'Resuming a fraud suspension requires an approver');
    }
  }

  return null;
}

/**
 * Apply an event to a SIM.
 *
 * Returns { sim, events } where `sim` is a new object (the input is never
 * mutated) and `events` is what the caller should publish once it has
 * durably written the new state. Deciding and publishing are separate on
 * purpose - see docs/adr/0003-outbox-for-provisioning.md.
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

  var guardError = guard(sim, event, ctx);
  if (guardError) {
    throw guardError;
  }

  var nextState = TRANSITIONS[sim.state][event];
  var occurredAt = ctx.occurredAt || new Date().toISOString();

  var next = Object.assign({}, sim, {
    state: nextState,
    updatedAt: occurredAt
  });

  var emitted = [];

  if (event === Events.ACTIVATE_REQUESTED) {
    next.ratePlanId = ctx.ratePlanId;
    next.activationRequestedAt = occurredAt;
    emitted.push({
      type: 'sim.activation.requested',
      iccid: sim.iccid,
      carrier: sim.carrier,
      ratePlanId: ctx.ratePlanId,
      occurredAt: occurredAt
    });
  }

  if (event === Events.ACTIVATE_CONFIRMED) {
    next.msisdn = ctx.msisdn || sim.msisdn;
    next.activatedAt = occurredAt;
    next.activationRequestedAt = null;
    emitted.push({
      type: 'sim.activated',
      iccid: sim.iccid,
      carrier: sim.carrier,
      msisdn: next.msisdn,
      occurredAt: occurredAt
    });
  }

  if (event === Events.ACTIVATE_FAILED) {
    next.ratePlanId = null;
    next.activationRequestedAt = null;
    next.lastFailureReason = ctx.reason || 'UNKNOWN';
    emitted.push({
      type: 'sim.activation.failed',
      iccid: sim.iccid,
      carrier: sim.carrier,
      reason: next.lastFailureReason,
      occurredAt: occurredAt
    });
  }

  if (event === Events.SUSPEND) {
    next.suspensionReason = ctx.reason;
    next.suspendedAt = occurredAt;
    emitted.push({
      type: 'sim.suspended',
      iccid: sim.iccid,
      carrier: sim.carrier,
      reason: ctx.reason,
      occurredAt: occurredAt
    });
  }

  if (event === Events.RESUME) {
    next.suspensionReason = null;
    next.suspendedAt = null;
    emitted.push({
      type: 'sim.resumed',
      iccid: sim.iccid,
      carrier: sim.carrier,
      approvedBy: ctx.approvedBy || null,
      occurredAt: occurredAt
    });
  }

  if (event === Events.TERMINATE_REQUESTED) {
    next.terminationRequestedAt = occurredAt;
    emitted.push({
      type: 'sim.termination.requested',
      iccid: sim.iccid,
      carrier: sim.carrier,
      occurredAt: occurredAt
    });
  }

  if (event === Events.TERMINATE_CONFIRMED) {
    next.terminatedAt = occurredAt;
    next.terminationRequestedAt = null;
    // The carrier has taken the number back. Holding on to it in our records
    // implies we still control it, and we do not.
    next.msisdn = null;
    emitted.push({
      type: 'sim.terminated',
      iccid: sim.iccid,
      carrier: sim.carrier,
      occurredAt: occurredAt
    });
  }

  return { sim: next, events: emitted };
}

module.exports = {
  States: States,
  Events: Events,
  SuspensionReasons: SuspensionReasons,
  TransitionError: TransitionError,
  can: can,
  allowedEvents: allowedEvents,
  apply: apply
};
