# 2. Normalise carrier differences at the adapter boundary

Date: 2018-03-12
Status: Accepted

## Context

We integrate three carriers. They disagree about almost everything:

| | Bell | Vodafone | AT&T |
|---|---|---|---|
| Status vocabulary | `AC`, `SU`, `DE` | `active`, `suspended` | `ACTIVE`, `SUSPENDED_BY_CARRIER` |
| Activation | synchronous | asynchronous, callback | synchronous |
| Errors | `E512` in a 500 | error envelope in a 200 | proper 4xx |
| MSISDN format | `1-416-555-0142` | `+447700900142` | `4165550142` |
| ICCID | space separated | clean | trailing `F` |

The first version of this system had the Bell vocabulary in the database,
because Bell were the first carrier we integrated. When Vodafone arrived we
wrote `if (carrier === 'vodafone')` in fourteen places, including in the
portal's front end. Adding AT&T would have meant doing it a third time.

## Decision

One canonical model, defined by us. Every carrier response is translated into
it at the edge of `carrier-service`, in pure functions in `normalize.js`.
Nothing above that layer ever sees a carrier's own vocabulary.

Where a carrier makes a distinction we don't have, we either fold it in
(Vodafone's `assigned` becomes `PRE_ACTIVE`) or lift it into a separate field
(AT&T's suspension source becomes `suspendedBy`). What we never do is add a
state to the canonical model that only one carrier can produce.

Where a carrier is ambiguous, we resolve it with context we already have.
Bell's `PD` means either activating or terminating; we know which because we
know what we asked for.

## Consequences

Good:

- Adding a carrier is one adapter, one entry in each mapping table, and one
  test file. It does not touch the domain, the database, or the portal.
- Every quirk is a pure function, so every quirk is a unit test with the real
  response body pasted in. When Bell changed their padding in 2019 the test
  told us in seconds.
- The portal and the support tools got much simpler — they know six states.

Bad:

- The translation layer can drift from reality without anyone noticing, since
  our tests assert against captured responses rather than live carriers. We
  mitigate this with a nightly contract test against each carrier's sandbox,
  which is the only part of the suite that needs the network.
- Folding `assigned` into `PRE_ACTIVE` loses information. So far nobody has
  needed it. If they do, it becomes a separate field, not a new state.
