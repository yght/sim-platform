# Durable commands and a leased outbox

Author: Yousof

## Problem

Saving a SIM transition and publishing its event in separate operations can lose
the event after a crash. Retrying the command can also repeat provisioning work.
The earlier outbox ADR described the design; the modern sample makes it executable.

## Decision

In one SQLite transaction, save the updated SIM, a command receipt and the event.
Replay identical commands from the receipt. Reject a reused command ID if its
payload changed. Scope both SIM lookup and receipt identity by tenant.

A separate relay claims an event with a time-limited token, publishes outside the
transaction, and acknowledges only that token. Consumer deduplication uses the
stable event ID. The transaction covers local state, not the carrier's system.

## Consequences

The sample can reproduce rollback, crash recovery and stale-worker behaviour with
a local database. SQLite is a deliberate demo dependency; its synchronous writes
and single-writer model limit throughput. A distributed deployment would need a
shared database, per-SIM ordering, monitoring and a consumer
idempotency contract. A lease token fences database updates, not external calls.

## Failure recovery update

A failed publish at the configured attempt limit now moves the event to durable
quarantine using its lease token. Tenant-scoped operator replay retains the event
ID and resets the attempt count. Crash-only retries are not bounded by this
mechanism. Operators must inspect quarantined events and consumers must still
deduplicate ambiguous deliveries.

Existing tables accept the new status without a schema migration. Do not roll
back to an older relay until dead events are inspected and explicitly requeued;
older code leaves them untouched.
