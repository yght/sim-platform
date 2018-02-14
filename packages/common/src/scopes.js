'use strict';

/**
 * Authorisation decisions, kept separate from token verification.
 *
 * Verifying a JWT means network calls to Auth0's JWKS endpoint and a lot of
 * crypto. Deciding whether a verified token is allowed to suspend a SIM is
 * pure logic. Splitting them means the interesting half - the half where the
 * security bugs live - is exhaustively unit tested without a single mock.
 */

/**
 * Scopes as registered in the Auth0 API definition. Read scopes are handed
 * out freely to the portal; write scopes are on the machine-to-machine
 * clients and a small number of support roles.
 */
var Scopes = {
  READ_SIM: 'read:sims',
  WRITE_SIM: 'write:sims',
  ACTIVATE_SIM: 'activate:sims',
  SUSPEND_SIM: 'suspend:sims',
  TERMINATE_SIM: 'terminate:sims',
  READ_USAGE: 'read:usage',
  ADMIN: 'admin:all'
};

function ForbiddenError(required, held) {
  this.name = 'ForbiddenError';
  this.code = 'INSUFFICIENT_SCOPE';
  this.status = 403;
  this.required = required;
  this.message = 'Requires scope: ' + required.join(' or ');
  // Deliberately not putting `held` in the message. Telling a caller which
  // scopes they do have is a small gift to anyone probing the API.
  this.held = held;
}
ForbiddenError.prototype = Object.create(Error.prototype);
ForbiddenError.prototype.constructor = ForbiddenError;

/**
 * Auth0 puts scopes in a space delimited `scope` claim. Some of our older
 * M2M clients were issued tokens with an array instead, and we still have to
 * accept those until they rotate.
 */
function scopesFrom(token) {
  if (!token) {
    return [];
  }

  if (Array.isArray(token.scope)) {
    return token.scope.slice();
  }

  if (typeof token.scope === 'string') {
    return token.scope.split(' ').filter(function (s) { return s.length > 0; });
  }

  if (Array.isArray(token.permissions)) {
    return token.permissions.slice();
  }

  return [];
}

function has(token, scope) {
  var held = scopesFrom(token);
  return held.indexOf(scope) !== -1 || held.indexOf(Scopes.ADMIN) !== -1;
}

/**
 * True when the token carries at least one of `required`.
 * ADMIN satisfies everything, which is why it is handed out to exactly two
 * service accounts and nobody's personal login.
 */
function hasAny(token, required) {
  for (var i = 0; i < required.length; i++) {
    if (has(token, required[i])) {
      return true;
    }
  }
  return false;
}

function assertScope(token, required) {
  var list = Array.isArray(required) ? required : [required];

  if (!hasAny(token, list)) {
    throw new ForbiddenError(list, scopesFrom(token));
  }
}

module.exports = {
  Scopes: Scopes,
  ForbiddenError: ForbiddenError,
  scopesFrom: scopesFrom,
  has: has,
  hasAny: hasAny,
  assertScope: assertScope
};
