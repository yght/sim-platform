'use strict';

/**
 * ICCID handling.
 *
 * An ICCID is the number physically printed on a SIM. ITU-T E.118 says it is
 * 19 or 20 digits: a Major Industry Identifier of 89 (telecom), a country
 * code, an issuer id, the account serial, and a trailing Luhn check digit.
 *
 * We validate on the way in because a bad ICCID is not something you want to
 * discover three services later, halfway through a carrier provisioning call
 * that has already taken your money.
 */

var MII_TELECOM = '89';
var MIN_LENGTH = 19;
var MAX_LENGTH = 20;

/**
 * Luhn checksum, the same algorithm used on payment cards.
 * Returns true when the digits (including the trailing check digit) are valid.
 */
function luhnValid(digits) {
  var sum = 0;
  var alternate = false;

  for (var i = digits.length - 1; i >= 0; i--) {
    var n = parseInt(digits.charAt(i), 10);

    if (alternate) {
      n = n * 2;
      if (n > 9) {
        n = n - 9;
      }
    }

    sum = sum + n;
    alternate = !alternate;
  }

  return sum % 10 === 0;
}

/**
 * Compute the check digit for a 18/19 digit ICCID body.
 * Useful in tests and when generating fixtures.
 */
function checkDigitFor(body) {
  var sum = 0;
  var alternate = true; // body has no check digit yet, so parity is flipped

  for (var i = body.length - 1; i >= 0; i--) {
    var n = parseInt(body.charAt(i), 10);

    if (alternate) {
      n = n * 2;
      if (n > 9) {
        n = n - 9;
      }
    }

    sum = sum + n;
    alternate = !alternate;
  }

  return String((10 - (sum % 10)) % 10);
}

/**
 * Bell send ICCIDs space separated in their inventory exports. Strip the
 * formatting before validating so we compare like with like.
 */
function normalize(raw) {
  if (typeof raw !== 'string') {
    return '';
  }

  return raw
    .replace(/[\s-]/g, '')
    .toUpperCase();
}

function validate(raw) {
  var iccid = normalize(raw);

  if (iccid.length === 0) {
    return { valid: false, reason: 'ICCID_EMPTY' };
  }

  if (!/^[0-9]+$/.test(iccid)) {
    return { valid: false, reason: 'ICCID_NOT_NUMERIC' };
  }

  if (iccid.length < MIN_LENGTH || iccid.length > MAX_LENGTH) {
    return { valid: false, reason: 'ICCID_BAD_LENGTH' };
  }

  if (iccid.substring(0, 2) !== MII_TELECOM) {
    return { valid: false, reason: 'ICCID_NOT_TELECOM' };
  }

  if (!luhnValid(iccid)) {
    return { valid: false, reason: 'ICCID_BAD_CHECKSUM' };
  }

  return { valid: true, iccid: iccid };
}

module.exports = {
  normalize: normalize,
  validate: validate,
  luhnValid: luhnValid,
  checkDigitFor: checkDigitFor
};
