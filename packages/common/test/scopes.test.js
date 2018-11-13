'use strict';

var s = require('../src/scopes');
var Scopes = s.Scopes;

function token(scope, org) {
  var t = { sub: 'auth0|5b2f1c', scope: scope };
  if (org) {
    t[s.ORG_CLAIM] = org;
  }
  return t;
}

describe('reading scopes off a token', function () {
  it('splits the space delimited claim Auth0 issues', function () {
    expect(s.scopesFrom(token('read:sims write:sims'))).toEqual(['read:sims', 'write:sims']);
  });

  it('accepts the array form our older M2M clients still send', function () {
    expect(s.scopesFrom({ scope: ['read:sims'] })).toEqual(['read:sims']);
  });

  it('falls back to the permissions claim when RBAC is enabled', function () {
    expect(s.scopesFrom({ permissions: ['read:usage'] })).toEqual(['read:usage']);
  });

  it('returns nothing for a token with no scopes at all', function () {
    expect(s.scopesFrom({})).toEqual([]);
    expect(s.scopesFrom(null)).toEqual([]);
  });

  it('ignores the extra whitespace a misconfigured client sent us', function () {
    expect(s.scopesFrom(token('read:sims   write:sims'))).toEqual(['read:sims', 'write:sims']);
  });
});

describe('scope checks', function () {
  it('grants what the token holds', function () {
    expect(s.has(token('read:sims'), Scopes.READ_SIM)).toBe(true);
  });

  it('denies what it does not', function () {
    expect(s.has(token('read:sims'), Scopes.TERMINATE_SIM)).toBe(false);
  });

  it('lets admin through everything', function () {
    expect(s.has(token('admin:all'), Scopes.TERMINATE_SIM)).toBe(true);
    expect(s.has(token('admin:all'), Scopes.APPROVE_FRAUD)).toBe(true);
  });

  it('is not fooled by a scope that merely contains the required one', function () {
    // 'read:sims:all' must not satisfy 'read:sims' - substring matching here
    // would be a genuine privilege escalation.
    expect(s.has(token('read:sims:all'), Scopes.READ_SIM)).toBe(false);
  });

  it('hasAny passes when one of several is held', function () {
    expect(s.hasAny(token('suspend:sims'), [Scopes.WRITE_SIM, Scopes.SUSPEND_SIM])).toBe(true);
  });

  it('assertScope throws a 403 carrying what was needed', function () {
    try {
      s.assertScope(token('read:sims'), Scopes.TERMINATE_SIM);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.code).toBe('INSUFFICIENT_SCOPE');
      expect(err.status).toBe(403);
      expect(err.required).toEqual([Scopes.TERMINATE_SIM]);
    }
  });

  it('assertScope stays quiet when the scope is held', function () {
    expect(function () {
      s.assertScope(token('terminate:sims'), Scopes.TERMINATE_SIM);
    }).not.toThrow();
  });

  it('does not leak the held scopes into the error message', function () {
    try {
      s.assertScope(token('read:sims write:sims'), Scopes.APPROVE_FRAUD);
    } catch (err) {
      expect(err.message).not.toContain('read:sims');
      expect(err.message).not.toContain('write:sims');
    }
  });
});

describe('tenant isolation', function () {
  it('allows a caller into their own org', function () {
    expect(s.canAccessOrg(token('read:sims', 'org_bell_reseller_04'), 'org_bell_reseller_04')).toBe(true);
  });

  it('keeps a caller out of somebody else org', function () {
    expect(s.canAccessOrg(token('read:sims', 'org_bell_reseller_04'), 'org_vodafone_direct')).toBe(false);
  });

  it('lets admin cross tenants, because support has to work tickets', function () {
    expect(s.canAccessOrg(token('admin:all'), 'org_anything')).toBe(true);
  });

  it('denies a token carrying no org claim rather than defaulting open', function () {
    expect(s.canAccessOrg(token('read:sims'), 'org_bell_reseller_04')).toBe(false);
  });

  it('denies when the resource has no org either - two nulls are not a match', function () {
    expect(s.canAccessOrg(token('read:sims'), null)).toBe(false);
  });
});
