# 3. Transactional outbox for provisioning jobs

Date: 2018-05-28
Status: Accepted

## Context

Activating a SIM is two writes that must agree: move the SIM to `ACTIVATING`
in our database, and tell the provisioning worker to go and call the carrier.

Doing them naively — write the row, then publish to RabbitMQ — has a window.
If the process dies between the two, the SIM sits in `ACTIVATING` forever and
no worker knows it exists. We found three of these by hand in the first month,
each one a customer whose SIM never came up and whose support ticket said
"nothing is happening".

Publishing first and writing second is worse: the worker can call the carrier
before the SIM row says it should.

Two-phase commit across Postgres and RabbitMQ was considered for about ten
minutes.

## Decision

Transactional outbox. In one database transaction we write the new SIM state
and an `outbox` row describing the message. A separate poller reads unsent
outbox rows, publishes them, and marks them sent.

This is why `simLifecycle.apply()` returns `{ sim, events }` rather than
publishing anything itself. It decides; the caller writes both halves in one
transaction; the poller publishes. The domain layer never touches the broker.

Delivery is therefore at-least-once, so every consumer has to be idempotent.
The state machine gives us most of that for free: a duplicate
`ACTIVATE_CONFIRMED` against a SIM that is already `ACTIVE` is rejected as an
illegal transition rather than applied twice.

## Consequences

Good:

- No lost provisioning jobs. The failure mode became "the message goes out
  late", which is visible and recoverable, instead of "the message never goes
  out", which is invisible.
- The outbox table doubles as an audit log of everything the system decided.

Bad:

- Added latency: a job waits for the next poll rather than going out
  instantly. At a 200ms poll interval nobody has noticed.
- The outbox table grows and needs pruning. Sent rows older than 30 days are
  archived nightly.
- At-least-once means idempotency is now a permanent obligation on every
  consumer we ever write. This is a real ongoing cost and worth being honest
  about.
