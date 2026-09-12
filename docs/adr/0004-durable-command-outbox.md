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
shared database, per-SIM ordering, bounded retries, monitoring and a consumer
idempotency contract. A lease token fences database updates, not external calls.
