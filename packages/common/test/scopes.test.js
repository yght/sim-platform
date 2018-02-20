'use strict';

var s = require('../src/scopes');
var Scopes = s.Scopes;

function token(scope) {
  return { sub: 'auth0|5b2f1c', scope: scope };
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
    }
  });

  it('assertScope stays quiet when the scope is held', function () {
    expect(function () {
      s.assertScope(token('terminate:sims'), Scopes.TERMINATE_SIM);
    }).not.toThrow();
  });

  it('does not leak the held scopes into the error message', function () {
    try {
      s.assertScope(token('read:sims write:sims'), Scopes.READ_USAGE);
    } catch (err) {
      expect(err.message).not.toContain('read:sims');
    }
  });
});
