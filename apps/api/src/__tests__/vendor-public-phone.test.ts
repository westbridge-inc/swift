import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  validatePublicPhone,
  safePublicPhone,
  publicPhoneForWrite,
  publicPhoneErrorMessage,
} from '../utils/vendor-public-phone';
import { AppError } from '../utils/errors';

// ---------------------------------------------------------------------------
// A store publishing a number so customers can call BEFORE ordering.
//
// The founder's framing was "they attach their number on their dashboard like
// their MMG link", so this mirrors mmg-pay-url.ts: opt-in field, validate on
// write, re-validate on read, and the exposure gated by store state. There is
// no OTP step, by the same decision.
//
// That places the whole burden on the shape checks, and the reason is not
// symmetry with MMG. A wrong MMG link misdirects money the customer can see
// before paying. A wrong phone number rings a person who is not a customer, not
// a vendor, and has no way to make it stop. These tests are mostly about the
// numbers that must NEVER reach a customer's dialler.
//
// Landlines are first-class throughout: a fixed GTT line is what many shops
// actually answer.
// ---------------------------------------------------------------------------

describe('the number a customer will actually dial', () => {
  it('accepts a Georgetown landline — the case a mobile-only rule would have broken', () => {
    const r = validatePublicPhone('+592 225 1234');
    expect(r).toEqual({ valid: true, phone: '+5922251234' });
  });

  it('accepts a mobile, and every regional fixed range', () => {
    // 2-5 regional fixed, 6-7 mobile. A shop answers whichever it has.
    for (const lead of ['2', '3', '4', '5', '6', '7']) {
      const r = validatePublicPhone(`+592${lead}251234`);
      expect(r.valid, `leading digit ${lead} must be dialable`).toBe(true);
    }
  });

  it('reconciles however the shopkeeper typed it into ONE stored spelling', () => {
    // Same line, three keyboards. If these stored differently, the same shop
    // would compare unequal to itself across surfaces.
    const spellings = ['+592 225 1234', '+592-225-1234', '+592.225.1234'];
    const stored = spellings.map((s) => (validatePublicPhone(s) as { phone: string }).phone);
    expect(new Set(stored).size).toBe(1);
    expect(stored[0]).toBe('+5922251234');
  });

  it('the + must lead, and that boundary belongs to the shared normalizer', () => {
    // `(+592) 225 1234` is REJECTED: utils/phone.ts keeps a leading + only when
    // it is the first character, and its own docstring says so. That normalizer
    // is the platform's account-matching key across every auth surface, so this
    // field does not get its own laxer copy to be kind about one bracket — the
    // cost of two spellings of the same number is far worse than a re-type.
    expect(validatePublicPhone('(+592) 225 1234').valid).toBe(false);
    expect(validatePublicPhone('(592) 225 1234').valid).toBe(false);
  });
});

describe('what must never reach a dialler', () => {
  it('REFUSES an emergency short code', () => {
    // The one that actually matters: a "call us" button must never dial the
    // police, the fire service or an ambulance. The full-national-number rule
    // is what makes this structurally impossible rather than blacklisted.
    for (const emergency of ['911', '912', '913', '+592911', '+592 913']) {
      expect(safePublicPhone(emergency), `${emergency} must never be published`).toBeNull();
    }
  });

  it('REFUSES a half-typed number rather than publishing a fragment', () => {
    // A shopkeeper who stops typing mid-number must not end up publishing a
    // shorter number that belongs to someone else.
    expect(validatePublicPhone('+592225')).toEqual({ valid: false, reason: 'WRONG_LENGTH' });
    expect(validatePublicPhone('+59222512')).toEqual({ valid: false, reason: 'WRONG_LENGTH' });
    expect(validatePublicPhone('+5922251234567')).toEqual({ valid: false, reason: 'WRONG_LENGTH' });
  });

  it('REFUSES trunk, international and service prefixes', () => {
    // 0/1 are trunk/international prefixes and 8/9 are service ranges: no
    // subscriber is reachable there, so a number in that shape dials something
    // other than the shop.
    for (const lead of ['0', '1', '8', '9']) {
      expect(validatePublicPhone(`+592${lead}251234`)).toEqual({
        valid: false,
        reason: 'NOT_A_SUBSCRIBER_LINE',
      });
    }
  });

  it('REFUSES another country, because only Guyana is served', () => {
    expect(validatePublicPhone('+1 246 555 1234')).toEqual({ valid: false, reason: 'COUNTRY_NOT_SUPPORTED' });
    expect(validatePublicPhone('+44 20 7946 0000')).toEqual({ valid: false, reason: 'COUNTRY_NOT_SUPPORTED' });
  });

  it('REFUSES junk before it can be normalized into something plausible', () => {
    // normalizePhone strips non-digits, so a long punctuation string would
    // otherwise collapse into a short "valid-looking" number. Length is checked
    // on the RAW input for exactly that reason.
    expect(validatePublicPhone('-'.repeat(40) + '5922251234')).toEqual({ valid: false, reason: 'TOO_LONG' });
    expect(validatePublicPhone('call the shop')).toEqual({ valid: false, reason: 'MALFORMED' });
    expect(validatePublicPhone('225-1234')).toEqual({ valid: false, reason: 'MALFORMED' }); // no country code: never guessed
  });
});

describe('the read boundary distrusts what is already stored', () => {
  it('a bad stored row degrades to NO call button, never to a wrong call', () => {
    // Rows predate validators, migrations write them, and people edit databases
    // by hand. The consequence of trusting one is a customer dialling it.
    for (const stored of ['911', '+1 246 555 1234', '+592', 'not a number', '', null, undefined]) {
      expect(safePublicPhone(stored)).toBeNull();
    }
  });

  it('a good stored row is returned canonicalized', () => {
    expect(safePublicPhone('+592 225 1234')).toBe('+5922251234');
  });
});

describe('the write boundary', () => {
  it('empty is opt-OUT, not an error — a store can always take its number down', () => {
    // If this threw, a vendor could only stop publishing by first supplying a
    // valid number, which is the opposite of what taking it down means.
    expect(publicPhoneForWrite('')).toBeNull();
    expect(publicPhoneForWrite('   ')).toBeNull();
    expect(publicPhoneForWrite(null)).toBeNull();
    expect(publicPhoneForWrite(undefined)).toBeNull();
  });

  it('a bad number is a 400 the shopkeeper can act on', () => {
    try {
      publicPhoneForWrite('911');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      const err = e as AppError;
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe('INVALID_PUBLIC_PHONE');
    }
  });

  it('every rejection tells the shopkeeper what to type instead', () => {
    // These render on the vendor's own dashboard. A message that only names the
    // failure ("invalid") leaves them guessing at their own shop number.
    const reasons = ['MISSING', 'TOO_LONG', 'MALFORMED', 'COUNTRY_NOT_SUPPORTED', 'WRONG_LENGTH', 'NOT_A_SUBSCRIBER_LINE'] as const;
    for (const reason of reasons) {
      const msg = publicPhoneErrorMessage(reason);
      expect(msg.length).toBeGreaterThan(20);
      expect(msg).toMatch(/\.$/);
      expect(msg.toLowerCase()).not.toContain('undefined');
    }
    expect(publicPhoneErrorMessage('WRONG_LENGTH')).toContain('7 digits');
    expect(publicPhoneErrorMessage('COUNTRY_NOT_SUPPORTED')).toContain('+592');
  });
});

describe('one normalizer, imported', () => {
  it('does not re-express phone normalization locally', () => {
    // A second "strip spaces and dashes" here is how a vendor gets stored in a
    // spelling no other surface recognises. utils/phone.ts is the one author.
    const src = readFileSync(path.join(__dirname, '..', 'utils', 'vendor-public-phone.ts'), 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(stripped).toContain('normalizePhone');
    expect(stripped).not.toMatch(/replace\(\/\\D\/g/);
  });

  it('is not a second copy of the MMG validator either', () => {
    // It mirrors that module's SHAPE deliberately; it must not fork its logic.
    const src = readFileSync(path.join(__dirname, '..', 'utils', 'vendor-public-phone.ts'), 'utf8');
    // Comments stripped first: the module deliberately NAMES mmg-pay-url as the
    // shape it mirrors, and that explanation is the point. What must not appear
    // is a call into it.
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    expect(stripped).not.toContain('mmgPayUrl');
  });
});
