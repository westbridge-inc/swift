import { describe, expect, it } from 'vitest';
import {
  documentLapsesAt, isCalendarDayExpiry, isDocumentExpired, isDocumentValidAt, lapsedExpiryAnd, stillCountingCalendarDays, validExpiryOr,
} from '../modules/verification/document-validity';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · COORD ruling 28 Oct 2026] A document is valid THROUGH THE END of its expiry day in Guyana
// (America/Guyana, UTC-4): a licence keyed "28 Oct" (stored 2026-10-28T00:00Z) counts until 23:59:59 on 28 Oct in
// Guyana = 03:59:59Z on 29 Oct, not until the stored instant (8 pm on 27 Oct in Guyana).
// ---------------------------------------------------------------------------

const KEYED = new Date('2026-10-28T00:00:00.000Z'); // "28 Oct", as the console stores a keyed expiry
const gy = (local: string) => new Date(`${local}-04:00`); // a Guyana wall-clock time

describe('[FOLLOWUPS] a keyed expiry counts through the end of its Guyana day', () => {
  it('the ruling\'s three instants', () => {
    expect(isDocumentValidAt(KEYED, gy('2026-10-27T22:00:00'))).toBe(true);
    expect(isDocumentValidAt(KEYED, gy('2026-10-28T23:30:00'))).toBe(true);
    expect(isDocumentValidAt(KEYED, gy('2026-10-29T00:01:00'))).toBe(false);
    expect(isDocumentExpired(KEYED, gy('2026-10-29T00:01:00'))).toBe(true);
  });

  it('it lapses at the first instant of the next Guyana day, and not a millisecond before', () => {
    expect(documentLapsesAt(KEYED).toISOString()).toBe('2026-10-29T04:00:00.000Z');
    expect(isDocumentValidAt(KEYED, new Date('2026-10-29T03:59:59.999Z'))).toBe(true);
    expect(isDocumentValidAt(KEYED, new Date('2026-10-29T04:00:00.000Z'))).toBe(false);
  });

  it('a moment (not midnight UTC) lapses at that moment, as before: the January re-check at the start of 16 Jan', () => {
    const recheck = new Date('2027-01-16T04:00:00.000Z');
    expect(isCalendarDayExpiry(recheck)).toBe(false);
    expect(documentLapsesAt(recheck)).toEqual(recheck);
    expect(isDocumentValidAt(recheck, new Date('2027-01-16T03:59:59.999Z'))).toBe(true);
    expect(isDocumentValidAt(recheck, recheck)).toBe(false);
  });

  it('no expiry never lapses', () => {
    expect(isDocumentValidAt(null, new Date('2099-01-01T00:00:00Z'))).toBe(true);
    expect(isDocumentValidAt(undefined)).toBe(true);
  });

  it('the query conditions agree with the predicate: the calendar days that still count at or before now', () => {
    // 28 Oct 23:30 in Guyana is already 29 Oct in UTC: both 28 Oct (today in Guyana) and 29 Oct still count.
    expect(stillCountingCalendarDays(gy('2026-10-28T23:30:00')).map((d) => d.toISOString())).toEqual(['2026-10-28T00:00:00.000Z', '2026-10-29T00:00:00.000Z']);
    const now = gy('2026-10-28T23:30:00');
    expect(validExpiryOr('expiresAt', now)).toEqual([
      { expiresAt: null }, { expiresAt: { gt: now } }, { expiresAt: { in: stillCountingCalendarDays(now) } },
    ]);
    expect(lapsedExpiryAnd('expiresOn', now)).toEqual([{ expiresOn: { lte: now } }, { expiresOn: { notIn: stillCountingCalendarDays(now) } }]);
  });

  it('every stored value: the query conditions and the predicate give the same answer, across a whole Guyana day', () => {
    const stored = [
      new Date('2026-10-27T00:00:00.000Z'), new Date('2026-10-28T00:00:00.000Z'), new Date('2026-10-29T00:00:00.000Z'), new Date('2026-10-30T00:00:00.000Z'),
      new Date('2026-10-28T02:00:00.000Z'), new Date('2026-10-28T04:00:00.000Z'), new Date('2026-10-29T03:00:00.000Z'), new Date('2026-10-29T05:00:00.000Z'),
    ];
    for (let h = 0; h < 48; h += 1) {
      const now = new Date(Date.UTC(2026, 9, 28, 0, 30) + h * 3_600_000);
      const counting = stillCountingCalendarDays(now).map((d) => d.getTime());
      for (const value of stored) {
        const byQuery = value.getTime() > now.getTime() || counting.includes(value.getTime());
        const lapsedByQuery = value.getTime() <= now.getTime() && !counting.includes(value.getTime());
        expect(byQuery, `${value.toISOString()} at ${now.toISOString()}`).toBe(isDocumentValidAt(value, now));
        expect(lapsedByQuery, `${value.toISOString()} at ${now.toISOString()}`).toBe(isDocumentExpired(value, now));
      }
    }
  });
});
