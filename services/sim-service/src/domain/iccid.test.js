'use strict';

var iccid = require('./iccid');

// Real-shaped ICCIDs: 89 (telecom) + country + issuer + serial + Luhn digit.
var BELL = '8913027201000024686';
var VODAFONE = '8944150002000035712';
var ATT = '8913104103000048267';

describe('iccid.validate', function () {
  it('accepts a well formed 19 digit ICCID', function () {
    expect(iccid.validate(BELL)).toEqual({ valid: true, iccid: BELL });
  });

  it('accepts a 20 digit ICCID', function () {
    var body = '8933150000000000001';
    var full = body + iccid.checkDigitFor(body);

    expect(full.length).toBe(20);
    expect(iccid.validate(full).valid).toBe(true);
  });

  it('rejects an empty or missing value', function () {
    expect(iccid.validate('').reason).toBe('ICCID_EMPTY');
    expect(iccid.validate(null).reason).toBe('ICCID_EMPTY');
    expect(iccid.validate(undefined).reason).toBe('ICCID_EMPTY');
  });

  it('rejects non numeric input', function () {
    expect(iccid.validate('89130272010000ABCDE').reason).toBe('ICCID_NOT_NUMERIC');
  });

  it('rejects anything that is not a telecom MII', function () {
    // Same length and a valid checksum, but starts 88 rather than 89.
    var body = '881302720100002468';
    var full = body + iccid.checkDigitFor(body);

    expect(iccid.validate(full).reason).toBe('ICCID_NOT_TELECOM');
  });

  it('rejects a bad length even when the checksum is fine', function () {
    var body = '89302720000000000';
    var full = body + iccid.checkDigitFor(body);

    expect(full.length).toBe(18);
    expect(iccid.validate(full).reason).toBe('ICCID_BAD_LENGTH');
  });

  it('rejects a transposed digit, which is the whole point of the check digit', function () {
    // Swap the '2' and '4' at positions 14/15. Luhn catches every adjacent
    // transposition except 09 <-> 90, so we deliberately avoid that pair.
    var swapped = BELL.substring(0, 14) + BELL.charAt(15) + BELL.charAt(14) + BELL.substring(16);

    expect(swapped).not.toBe(BELL);
    expect(iccid.validate(swapped).reason).toBe('ICCID_BAD_CHECKSUM');
  });
});

describe('iccid.normalize', function () {
  it('strips the spaces Bell put in their exports', function () {
    expect(iccid.normalize('8913 0272 0100 0024 686')).toBe(BELL);
  });

  it('strips hyphens', function () {
    expect(iccid.normalize('8913-0272-0100-0024-686')).toBe(BELL);
  });

  it('strips the trailing F padding nibble AT&T leave on', function () {
    expect(iccid.normalize(ATT + 'F')).toBe(ATT);
    expect(iccid.normalize(ATT + 'f')).toBe(ATT);
  });

  it('leaves an already clean ICCID untouched', function () {
    expect(iccid.normalize(VODAFONE)).toBe(VODAFONE);
  });

  it('validates carrier formatted input end to end', function () {
    expect(iccid.validate('8913 1041 0300 0048 267F')).toEqual({ valid: true, iccid: ATT });
  });
});

describe('iccid.checkDigitFor', function () {
  it('produces a digit that makes the whole string Luhn valid', function () {
    var bodies = ['891302720100002468', '894415000200003571', '891310410300004826'];

    bodies.forEach(function (body) {
      var full = body + iccid.checkDigitFor(body);
      expect(iccid.luhnValid(full)).toBe(true);
    });
  });
});
