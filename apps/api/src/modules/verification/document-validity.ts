import { guyanaDayKey, startOfGuyanaDay } from '../../utils/guyana-day';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · COORD ruling 28 Oct 2026, owner delegated; safety/fairness]
// A DOCUMENT IS VALID THROUGH THE END OF ITS EXPIRY DAY, IN GUYANA.
//
// The expiry a person at Swift keys from a document is a calendar day, and the
// API stores it as midnight UTC (`new Date('2026-10-28').toISOString()`). Every
// server check compared that stored instant with now, so a licence printed
// "valid until 28 Oct" stopped counting at 8 pm on 27 Oct in Guyana (UTC-4): a
// driver was taken offline, a store went dark, on the evening BEFORE the day
// the document says. Now:
//
//   - a stored value at exactly 00:00:00.000 UTC is that calendar day, and the
//     document counts until the END of that day in Guyana (it lapses at the
//     first instant of the next Guyana day);
//   - any other stored value is a moment (an auto-approval's N days, the
//     January re-check at the start of 16 January in Guyana), and it lapses at
//     that moment, as before.
//
// Every server check of a document's expiry goes through this file: the JS
// predicates for a row in hand, and the Prisma conditions for a query.
// The data-retention deadline (retentionExpiresAt) is a moment, not a document
// expiry, and is not judged here.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** A stored expiry at exactly midnight UTC is a calendar day the person keyed, not a moment. */
export function isCalendarDayExpiry(expiry: Date): boolean {
  return expiry.getUTCHours() === 0 && expiry.getUTCMinutes() === 0 && expiry.getUTCSeconds() === 0 && expiry.getUTCMilliseconds() === 0;
}

const ymdUtc = (at: Date) => at.toISOString().slice(0, 10);

/** The first instant the document no longer counts: the start of the Guyana day AFTER a calendar-day expiry, or the
 *  moment itself. */
export function documentLapsesAt(expiry: Date): Date {
  if (!isCalendarDayExpiry(expiry)) return expiry;
  return startOfGuyanaDay(ymdUtc(new Date(expiry.getTime() + DAY_MS)));
}

/** Does the document still count at `now`? No expiry = it never lapses. */
export function isDocumentValidAt(expiry: Date | null | undefined, now: Date = new Date()): boolean {
  if (expiry == null) return true;
  return now.getTime() < documentLapsesAt(expiry).getTime();
}

export function isDocumentExpired(expiry: Date | null | undefined, now: Date = new Date()): boolean {
  return !isDocumentValidAt(expiry, now);
}

/**
 * The calendar-day values (midnight UTC) that are already at or before `now` yet still count: today's Guyana date,
 * and tomorrow's while Guyana's evening is already past midnight UTC. Any later calendar day is after `now` anyway.
 */
export function stillCountingCalendarDays(now: Date): Date[] {
  const today = guyanaDayKey(now);
  const todayUtc = new Date(`${today}T00:00:00.000Z`);
  return [todayUtc, new Date(todayUtc.getTime() + DAY_MS)];
}

type Field = 'expiresAt' | 'expiresOn';

/** Prisma: a set expiry `field` that still counts at `now` (an OR list: a later instant, or a calendar day not yet
 *  over). For a column that always holds an expiry (a renewal schedule's). */
export function setExpiryStillCountsOr<F extends Field>(field: F, now: Date): Array<Record<F, { gt: Date } | { in: Date[] }>> {
  return [
    { [field]: { gt: now } } as Record<F, { gt: Date }>,
    { [field]: { in: stillCountingCalendarDays(now) } } as Record<F, { in: Date[] }>,
  ];
}

/** Prisma: the expiry `field` still counts at `now` (an OR list: none, a later instant, or a calendar day not yet over). */
export function validExpiryOr<F extends Field>(field: F, now: Date): Array<Record<F, null | { gt: Date } | { in: Date[] }>> {
  return [{ [field]: null } as Record<F, null>, ...setExpiryStillCountsOr(field, now)];
}

/** Prisma: the expiry `field` has lapsed at `now` (set, at or before now, and not a calendar day that still counts). */
export function lapsedExpiryAnd<F extends Field>(field: F, now: Date): Array<Record<F, { lte: Date } | { notIn: Date[] }>> {
  return [
    { [field]: { lte: now } } as Record<F, { lte: Date }>,
    { [field]: { notIn: stillCountingCalendarDays(now) } } as Record<F, { notIn: Date[] }>,
  ];
}
