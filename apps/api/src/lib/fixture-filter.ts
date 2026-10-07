import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../utils/errors';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-3] HIDE TEST DATA — ONE PREDICATE, ON A FACT NO USER CONTROLS.
//
// The journey suite runs against staging through the real signup API and
// shares its database (deploy/docker-compose.journeys.yml), so its people and
// stores land in the default PRODUCTION tenant with isSynthetic = false (the
// tenant trigger refuses true there). The console's lists counted them as real.
//
// A fixture is keyed ONLY on the account's phone, a server-controlled fact:
//   - every suite phone is +5920 followed by digits (scripts/livetest/guard.ts
//     FICTIONAL_GY — "a 0 after +592 is never a subscriber number"; the review
//     tenant's identifiers use the same block);
//   - a phone is set once, at signup, from a number that received the OTP
//     (auth.service verifyOtp); there is no phone-change route; and production
//     refuses to boot with the development OTP bypass (utils/boot-config.ts), so
//     nobody can hold a +5920 account in production by typing one.
// It is NEVER keyed on a name: a real store or person could call themselves
// "TEST-…" and vanish from the console that oversees them. Names starting with
// "TEST-" are reserved for fixture accounts at the API boundary instead
// (assertNameNotReserved), so the prefix keeps meaning "test".
//
// Filtering happens in the query, so the pager's totals stay true, and every
// list reports how many fixture rows it left out, so nothing disappears
// without a count. It happens only when the caller asks (`excludeFixtures=
// true`, which the console sends unless "Show test data" is ticked): with no
// parameter a list returns every row, as it always has, so the API's other
// callers — the journey and contract suites among them — see no change.
// ---------------------------------------------------------------------------

export const FIXTURE_PHONE_PREFIX = '+5920';
export const RESERVED_NAME_PREFIX = 'TEST-';

/** A person who is a test fixture. */
export const FIXTURE_USER = { phone: { startsWith: FIXTURE_PHONE_PREFIX } } satisfies Prisma.UserWhereInput;

/** A store whose owner is a test fixture. */
export const FIXTURE_VENDOR = { owner: { user: FIXTURE_USER } } satisfies Prisma.VendorWhereInput;

/** A rider or driver who is a test fixture. */
export const FIXTURE_MOVER = { user: FIXTURE_USER } satisfies Prisma.RiderWhereInput & Prisma.DriverWhereInput;

/** An order a fixture placed or a fixture store served. */
export const FIXTURE_ORDER = {
  OR: [{ customer: FIXTURE_USER }, { vendor: FIXTURE_VENDOR }],
} satisfies Prisma.OrderWhereInput;

/** `?excludeFixtures=true` hides test data; absent or `false` lists every row. */
export const excludeFixturesQuerySchema = z.object({
  excludeFixtures: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
});

/** The list's where, with fixtures left out when asked; and the where that counts what was left out. */
export function withFixtureFilter<W extends object>(base: W, fixture: W, exclude: boolean): { where: W; hiddenWhere: W | null } {
  return exclude
    ? { where: { AND: [base, { NOT: fixture }] } as W, hiddenWhere: { AND: [base, fixture] } as W }
    : { where: base, hiddenWhere: null };
}

export function isFixturePhone(phone: string | null | undefined): boolean {
  return !!phone && phone.startsWith(FIXTURE_PHONE_PREFIX);
}

/**
 * A name starting with "TEST-" is reserved for fixture accounts (+5920…), so a
 * real person or store can never pass for test data. Checked only when a name
 * is being SET (a new one, or a change), so an unchanged name re-sent by an
 * older app build never fails an unrelated update.
 */
export function assertNameNotReserved(
  name: string | null | undefined,
  accountPhone: string | null | undefined,
  previous?: string | null,
): void {
  if (!name) return;
  const next = name.trim();
  if (!next.toUpperCase().startsWith(RESERVED_NAME_PREFIX)) return;
  if (previous != null && previous.trim() === next) return;
  if (isFixturePhone(accountPhone)) return;
  throw new AppError(400, 'RESERVED_NAME', `Names starting with "TEST-" are reserved for Swift’s test accounts. Please choose another name.`);
}
