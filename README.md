# sim-platform

A multi-carrier SIM lifecycle platform. One API for activating, suspending and
terminating SIMs that actually live on Bell, Vodafone or AT&T, with Auth0 in
front of it.

> **About this repository.** This is a sanitised reconstruction of a system I
> built in 2018. The original runs against real carrier endpoints and carries
> production credentials and customer data, so it cannot be published. The
> architecture, the carrier quirks and the domain rules here are the real
> ones; the code was rewritten from scratch against fake endpoints so that it
> could be shared. I'm happy to walk through the original in a screen share.

## New: runnable Node.js 24 outbox — Yousof

The [modern outbox example](modern/outbox/README.md) implements the persistence
boundary described in the architecture: SIM state, command receipt and events are
saved in one SQLite transaction. A separate relay uses leases, stable event IDs
and retry backoff. The demo uses a console carrier stub.

```bash
npm ci
npm run test:ci
npm run demo:outbox
```

Use Node.js 24. The full suite combines 103 existing domain tests with 13 real
SQLite outbox tests. Start with [the store](modern/outbox/store.mjs),
[the relay](modern/outbox/relay.mjs) and [the failure-path tests](modern/outbox/outbox.test.mjs).

This addition demonstrates durable retries, transactional rollback, restart
recovery and stale-worker fencing. External delivery is at least once; consumers
must deduplicate. It adds a runnable persistence example, not the full carrier
service deployment. [Read the trade-offs](docs/adr/0004-durable-command-outbox.md).

## What I want to demonstrate

I want to show how I turn inconsistent external systems into a domain model that application teams and support staff can understand.

- **Backend design:** explicit SIM lifecycle transitions and carrier-specific adapters.
- **Reliability:** error classification, retry decisions and a circuit breaker.
- **Customer impact:** consistent SIM operations across carriers, so support agents can focus on resolving the customer's problem.
- **Engineering judgment:** domain logic that can be tested independently, with architecture decisions and their trade-offs documented.

**Start here:** [carrier normalisation](services/carrier-service/src/domain/normalize.js), [SIM lifecycle](services/sim-service/src/domain/simLifecycle.js), then [design decisions](docs/adr/).

**Scope:** this repository contains domain modules and tests. The architecture diagram describes the wider system. The modern directory adds SQLite persistence and an outbox relay; production HTTP services, broker wiring and real carrier integrations remain outside this public sample.

## The problem

A reseller sells SIMs. The SIMs come from three carriers. Each carrier has its
own API, its own vocabulary for what a SIM is doing, its own idea of what
counts as an error, and its own opinion about whether provisioning is
synchronous. The reseller's support team should not have to know or care which
carrier a given SIM sits on.

So the job is: one consistent API and one consistent state model over three
inconsistent partners, without the inconsistencies leaking upwards.

Some of what that means in practice:

- Bell speak in two-letter mainframe codes, pad every field with spaces, and
  use one code (`PD`) for both "activating" and "terminating".
- Vodafone are asynchronous. You POST an activation, get a `202`, and the real
  answer arrives on a callback several minutes later.
- AT&T are synchronous, return `409` on anything they consider illegal, and
  leave the `F` padding nibble on the end of ICCIDs.
- All three return `200` with an error in the body for at least some failures,
  so trusting HTTP status codes gets you retrying things that will never work.

## Architecture

```
                    ┌──────────────┐
   portal / M2M ───▶│   gateway    │  Auth0 JWT, scopes, tenant isolation
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
      ┌─────────────┐ ┌─────────┐ ┌───────────┐
      │ sim-service │ │ carrier │ │   usage   │
      │  lifecycle  │ │ service │ │  service  │
      └──────┬──────┘ └────┬────┘ └───────────┘
             │             │
             │ outbox      │ breaker per carrier
             ▼             ▼
       ┌──────────┐  ┌──────────────────────┐
       │ RabbitMQ │  │  Bell / VF / AT&T    │
       └────┬─────┘  └──────────────────────┘
            │               ▲
            ▼               │
    ┌───────────────┐       │
    │ provisioning  │───────┘
    │    worker     │  retries, backoff, dead letter
    └───────────────┘
```

The shape that matters: **every service has a pure domain core with no I/O in
it.** The state machine, the carrier normalisation, the circuit breaker and
the retry policy are all plain functions over plain objects. Databases, HTTP
and queues live in a thin shell around them.

That is not architectural purity for its own sake. It is why there are 103
unit tests in here that run in under a quarter of a second with no mocks, no
containers and no fixtures — and why every carrier quirk we ever got burned by
is pinned down by a test with the offending response body pasted into it.

## What's in here

| Path | What it is |
|---|---|
| `services/sim-service/src/domain/simLifecycle.js` | The state machine. Six states, explicit transition table, guards. |
| `services/sim-service/src/domain/iccid.js` | ICCID validation, including the Luhn check digit. |
| `services/carrier-service/src/domain/normalize.js` | Three carrier vocabularies folded into one. The heart of the system. |
| `services/carrier-service/src/domain/circuitBreaker.js` | Per-carrier breaker with an injectable clock. |
| `services/provisioning-worker/src/retryPolicy.js` | Exponential backoff with jitter, and the decision to give up. |
| `packages/common/src/scopes.js` | Auth0 scope checks and tenant isolation. |
| `docs/adr/` | Why things are the way they are. |

## Decisions worth arguing about

Three that took the most discussion at the time, written up in `docs/adr/`:

1. **[Normalise at the adapter boundary](docs/adr/0002-carrier-adapter-abstraction.md)**
   rather than letting each carrier's vocabulary reach the domain. The cost is
   a translation layer that has to be kept honest; the benefit is that adding
   a fourth carrier touches one directory.
2. **[Outbox for provisioning](docs/adr/0003-outbox-for-provisioning.md)** —
   state change and message publish in one transaction, worker publishes
   after. Without it, a crash between "SIM is ACTIVATING" and "message sent"
   leaves a SIM stuck forever.
3. **[Auth0 rather than our own identity](docs/adr/0001-auth0-as-identity.md)**.
   Resellers wanted SSO against their own directories, and building SAML
   federation was not the business we were in.

## Running it

```bash
npm install
npm test          # 103 tests, about 0.2s, no external services needed
```

The domain layer has no runtime dependencies, which is why the suite needs no
database, no broker, no containers and no network.

### What is not in this cut

The HTTP and queue shell around these modules — the Express services, the
Mongo repositories, the RabbitMQ wiring and the Dockerfiles — is not included
here. It is the thinnest part of the system, the part most specific to the
original deployment, and the part the credentials lived in. `.env.example`
documents the configuration it expected, with every value replaced by a stub.

There are no credentials in this repository and none of the endpoints in it
are real.

## What I'd do differently now

- **The breaker should be shared state, not per-process.** With four instances
  of carrier-service, Bell has to fail twenty times before all four agree to
  open. Redis-backed, or push it into the mesh.
- **Vodafone's callback needs to be idempotent by construction.** Today it
  leans on the state machine rejecting a duplicate `ACTIVATE_CONFIRMED`, which
  works but is implicit. A dedup key on the callback would say what it means.
- **`normalize.js` is doing two jobs** — status mapping and error mapping.
  They change for different reasons and should be separate modules.
- **Typed.** This was 2018 and we were on plain Node; the carrier payloads are
  exactly the kind of thing where TypeScript would have earned its keep.

## Notes on the reconstruction

The runtime code is written in the 2018 idiom deliberately — CommonJS, `var`,
promises rather than `async` in the domain layer, no optional chaining. The
dev tooling is current, because a repository that cannot be cloned and tested
today is not much of a portfolio piece.

## Engineering practices

[Contribution and verification guide](CONTRIBUTING.md) · [Review template](.github/pull_request_template.md)

The demo uses a stub carrier. Passing it does not validate a live carrier integration or external exactly-once delivery.

## Recovering repeatedly failing events

The modern relay now quarantines an event as `dead` after a failed publish reaches `maxAttempts` (default 5). Other events remain eligible for delivery. The transition uses the current lease token so an obsolete worker cannot quarantine another worker's event.

After investigating and fixing the cause, a trusted operator can call `store.requeue(eventId, tenant)`. This only changes a matching dead event, resets its attempt counter and preserves the original event ID for consumer deduplication. No public recovery endpoint is exposed.

The limit applies when publishing returns an error; crashed or indefinitely hung publishers still rely on lease expiry and may exceed this count. Quarantine is not confirmed non-delivery: a remote service may accept a request before its response is lost. Consumer idempotency remains required. Dead events need operator monitoring; retention and an admin UI remain outside this sample.

Run `npm run test:outbox` for failure exhaustion, tenant-scoped replay and stale-worker fencing tests.
