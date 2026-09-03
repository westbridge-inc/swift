import { describe, it, expect } from 'vitest';
import {
  CSAE_DISPOSITIONS, closureBody, csaeActions, fieldsFor, MAX_STARS, stars, targetSummary,
} from './moderationView';

// ---------------------------------------------------------------------------
// [D-17] A CHILD-SAFETY REPORT CANNOT BE CLOSED BY TYPING NOTHING.
//
// THE CRASH: the reported content was summarised with
// `'★'.repeat(Number(t.score) || 0)`. `repeat` THROWS RangeError on a negative
// count — so one rating row with a negative score does not render badly, it
// takes down the whole moderation queue, including the child-safety reports
// sorted to the top of it.
//
// THE CLOSURE: "Mark handled" and "Dismiss" sent `{ status, note? }` with the
// note OPTIONAL, on CSAE rows too. The API has since required a coded
// disposition and the evidence it implies (A-17), and a dismissal takes two
// people — so this console's child-safety closures were refused by the server,
// and before that rule existed a report could be closed with an empty string.
// ---------------------------------------------------------------------------

describe('[D-17] the star formatter is total — it renders the queue people report abuse to', () => {
  it('a NEGATIVE score renders nothing instead of throwing — the crash, in one line', () => {
    expect(() => stars(-1)).not.toThrow();
    expect(stars(-1)).toBe('');
    expect(stars(-999999)).toBe('');
  });

  it('an enormous score is bounded, not printed', () => {
    expect(stars(1e6)).toBe('★'.repeat(MAX_STARS));
    expect(stars(Number.MAX_SAFE_INTEGER)).toBe('★'.repeat(MAX_STARS));
  });

  it('a non-number is nothing, never NaN stars', () => {
    for (const v of [undefined, null, 'five', {}, [], Number.NaN, Infinity, -Infinity]) {
      expect(() => stars(v), String(v)).not.toThrow();
      expect(stars(v), String(v)).toBe('');
    }
  });

  it('an ordinary score still reads as stars', () => {
    expect(stars(1)).toBe('★');
    expect(stars(5)).toBe('★★★★★');
    expect(stars('4')).toBe('★★★★');
    expect(stars(3.7)).toBe('★★★');
  });
});

describe('[D-17] the summary never crashes the queue, whatever the row holds', () => {
  it('a rating with a hostile score renders', () => {
    expect(() => targetSummary({ targetType: 'RATING', targetId: 'r1', target: { score: -3, comment: 'x' } })).not.toThrow();
    expect(targetSummary({ targetType: 'RATING', targetId: 'r1', target: { score: -3, comment: 'x' } })).toBe('"x"');
  });

  it('removed content says so rather than rendering an empty row', () => {
    expect(targetSummary({ targetType: 'RATING', targetId: 'r1', target: null })).toBe('(content already removed)');
    expect(targetSummary({ targetType: 'USER', targetId: 'u1' })).toBe('(content already removed)');
  });

  it('a rating with neither stars nor text says that too', () => {
    expect(targetSummary({ targetType: 'RATING', targetId: 'r1', target: { score: 0 } })).toBe('(no rating text)');
  });

  it('non-string fields do not produce "[object Object]" in an ops queue', () => {
    expect(targetSummary({ targetType: 'VENDOR', targetId: 'v1', target: { name: 42 } })).toBe('42');
    expect(targetSummary({ targetType: 'USER', targetId: 'u1', target: { id: 7 } })).toBe('7');
  });

  it('an unknown target type falls back to its id, not a blank', () => {
    expect(targetSummary({ targetType: 'SOMETHING_NEW', targetId: 'x9', target: {} })).toBe('x9');
  });
});

describe('[D-17] a child-safety closure states what was decided', () => {
  it('a CSAE closure carries its disposition and evidence', () => {
    const body = closureBody('ACTIONED', 'account banned', {
      disposition: 'ENFORCED_AND_REPORTED', enforcementRef: 'BAN-77', authorityRef: 'NCMEC-9', evidencePreserved: true,
    });
    expect(body).toEqual({
      status: 'ACTIONED', note: 'account banned', disposition: 'ENFORCED_AND_REPORTED',
      enforcementRef: 'BAN-77', authorityRef: 'NCMEC-9', evidencePreserved: true,
    });
  });

  it('an ORDINARY report sends no evidence fields — empty ones would make the CSAE contract look satisfied everywhere', () => {
    expect(closureBody('DISMISSED', 'spam', null)).toEqual({ status: 'DISMISSED', note: 'spam' });
    expect(closureBody('ACTIONED', '   ', null)).toEqual({ status: 'ACTIONED' });
  });

  it('blank CSAE fields are omitted rather than sent empty — the server judges completeness, and empty is not an answer', () => {
    const body = closureBody('ACTIONED', '', { disposition: '', enforcementRef: '  ', authorityRef: '', evidencePreserved: false });
    expect(body).toEqual({ status: 'ACTIONED' });
  });

  it('dismissing a child-safety report is a PROPOSAL — it takes two people', () => {
    const actions = csaeActions();
    expect(actions.map((a) => a.status)).toEqual(['ACTIONED', 'PROPOSE_DISMISS']);
    expect(actions.find((a) => a.status === 'PROPOSE_DISMISS')!.label).toMatch(/second reviewer/);
    // the one-tap DISMISSED that used to close these is not on offer at all
    expect(actions.some((a) => a.status === 'DISMISSED')).toBe(false);
  });

  it('each disposition asks for what it implies — and nothing it does not', () => {
    expect(fieldsFor('ENFORCED')).toEqual({ enforcementRef: true, authorityRef: false, evidence: true });
    expect(fieldsFor('ENFORCED_AND_REPORTED')).toEqual({ enforcementRef: true, authorityRef: true, evidence: true });
    expect(fieldsFor('NO_VIOLATION')).toEqual({ enforcementRef: false, authorityRef: false, evidence: true });
    expect(fieldsFor('DUPLICATE')).toEqual({ enforcementRef: false, authorityRef: false, evidence: false });
    expect(fieldsFor('')).toEqual({ enforcementRef: false, authorityRef: false, evidence: false });
  });

  it('the dispositions offered are the four the API accepts', () => {
    expect([...CSAE_DISPOSITIONS]).toEqual(['ENFORCED', 'ENFORCED_AND_REPORTED', 'NO_VIOLATION', 'DUPLICATE']);
  });
});
