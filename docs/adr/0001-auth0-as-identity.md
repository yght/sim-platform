# 1. Auth0 as the identity provider

Date: 2018-02-05
Status: Accepted

## Context

Three groups need to call this platform:

- Support staff, through the internal portal.
- Reseller staff, through the same portal, seeing only their own SIMs.
- Reseller machines, calling the API directly for bulk activation.

Several of the larger resellers required SSO against their own Active
Directory as a condition of the contract. At least one wanted SAML
specifically.

## Decision

Auth0, with the API registered as a resource server issuing RS256 JWTs.

- Human logins go through Authorization Code with PKCE.
- Machine clients use Client Credentials.
- Permissions are Auth0 scopes (`read:sims`, `terminate:sims`, ...).
- Tenant identity rides on a custom claim, `https://simplatform.io/org`, set
  by an Auth0 rule at token issue time.

Services verify tokens against the JWKS endpoint with a cached key set. No
service holds a shared secret and no service can mint a token.

## Consequences

Good:

- Reseller SSO became a configuration exercise rather than a project. The
  first AD federation took under a day.
- We do not store passwords. Given what this platform can do to a phone line,
  that is a meaningful reduction in what we can get wrong.
- Scope checks are pure functions over a decoded token, so authorisation logic
  is exhaustively unit tested — see `packages/common/test/scopes.test.js`.

Bad:

- Auth0 is now in the critical path for every request. Their outage is our
  outage. Mitigated with a long JWKS cache and by not calling Auth0 per
  request, but not eliminated.
- Per-active-user pricing means the bulk M2M clients need watching, since a
  misconfigured client that requests a token per call gets expensive.
- The org claim is set by an Auth0 rule, which is JavaScript living outside
  this repository. That is a genuine piece of hidden coupling and it has
  bitten us once, when a rule change silently dropped the claim and every
  reseller request started 403ing.
