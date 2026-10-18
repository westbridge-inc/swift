// ---------------------------------------------------------------------------
// [COORD ruling 18 Oct, option S] ONE partition of the ratings a person received, for everything
// a non-store ratee is shown about them: their app's figures and their data export.
//
// The ratings a person received in one role, in the order they were given, are cut into
// consecutive groups of RATING_GROUP_SIZE. Only whole groups of FINAL ratings are ever shown
// (a rating can be edited for RATING_WINDOW_DAYS; nothing after the first still-editable one
// counts yet). So every figure moves only when a whole new group of 5 lands: two looks a day or
// a week apart differ by a whole group or not at all, never by one rating, and no figure can be
// set against another cut of the same ratings (there is no other cut). Stores are not ratees
// here: their reviews page already lists each review.
//
// Residual: a moderator excluding or restoring a rating later re-forms the groups after it.
// ---------------------------------------------------------------------------

import type { PrismaClient } from '@prisma/client';
import { TYPES_FOR_ROLE, type SubjectRef } from './rating-stats.service';
import { RATING_ROLLING_COUNT, countBucket, displayRating, standingBand, topRatedEligible, type StandingBand } from './rating-math';
import type { RatingSurface } from './rating-surface';

export const RATING_GROUP_SIZE = 5;

/** The roles a PERSON is rated in (a store is rated as the store, by vendorId). */
export type PersonRatingRole = Exclude<SubjectRef['role'], 'VENDOR'>;
export const PERSON_RATING_ROLES: readonly PersonRatingRole[] = ['CUSTOMER', 'RIDER', 'DRIVER', 'SERVICE_PROVIDER'];

export interface RatingGroup {
  /** When its first and last rating was given. */
  from: Date;
  to: Date;
  count: number;
  /** Rounded as the app rounds (rating-standing.ts). */
  average: number;
}

export interface GroupedRatings<T extends RatingRow = RatingRow> {
  groups: RatingGroup[];
  /** The ratings inside whole groups, in the order given (tags and rolling figures are read from these only). */
  rows: T[];
  /** Over whole groups only. */
  count: number;
  sum: number;
  average: number | null;
}

export interface RatingRow { score: number; createdAt: Date; editableUntil: Date | null }

const round2 = (x: number) => Math.round(x * 100) / 100;

/** The pure cut: rows in the order given -> the final prefix -> whole groups. */
export function groupRatings<T extends RatingRow>(rows: readonly T[], now: Date = new Date()): GroupedRatings<T> {
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const open = ordered.findIndex((r) => r.editableUntil !== null && r.editableUntil.getTime() > now.getTime());
  const final = open === -1 ? ordered : ordered.slice(0, open);
  const whole = final.slice(0, final.length - (final.length % RATING_GROUP_SIZE));
  const groups: RatingGroup[] = [];
  for (let i = 0; i < whole.length; i += RATING_GROUP_SIZE) {
    const g = whole.slice(i, i + RATING_GROUP_SIZE);
    groups.push({ from: g[0]!.createdAt, to: g[g.length - 1]!.createdAt, count: g.length, average: round2(g.reduce((s, r) => s + r.score, 0) / g.length) });
  }
  const sum = whole.reduce((s, r) => s + r.score, 0);
  return { groups, rows: whole, count: whole.length, sum, average: whole.length ? round2(sum / whole.length) : null };
}

/** What a person is SHOWN about the ratings they received (their own views, and their star shown to others). */
export interface ShownRating extends RatingSurface {
  standing: StandingBand;
  /** The plain mean, one decimal (where the legacy averageRating was shown); null before the first whole group. */
  average: number | null;
}

/** The star line, count and band of a person, from whole groups only (display; ranking and dispatch keep their own math). */
export function shownRating(grouped: GroupedRatings, role: PersonRatingRole): ShownRating {
  const rolling = grouped.rows.slice(-RATING_ROLLING_COUNT);
  const standing = standingBand(grouped.count, rolling.length, rolling.reduce((s, r) => s + r.score, 0));
  return {
    displayRating: displayRating(grouped.count, grouped.sum),
    ratingBucket: countBucket(grouped.count),
    ratingCount: grouped.count,
    topRated: topRatedEligible(standing, grouped.count, role === 'SERVICE_PROVIDER'),
    standing,
    average: grouped.count ? Math.round((grouped.sum / grouped.count) * 10) / 10 : null,
  };
}

/**
 * Shown figures for several people at once, one query. Cached for a few minutes: a cached value is an
 * older whole-groups figure, so two looks still differ by whole groups only, never by one rating.
 */
const SHOWN_CACHE_MS = 5 * 60_000;
const SHOWN_CACHE_MAX = 10_000;
const shownCache = new Map<string, { at: number; value: ShownRating }>();
export function clearShownRatingCache(): void { shownCache.clear(); }

export async function shownRatingsFor(
  db: Pick<PrismaClient, 'rating'>,
  role: PersonRatingRole,
  userIds: readonly string[],
  now: Date = new Date(),
): Promise<Map<string, ShownRating>> {
  const out = new Map<string, ShownRating>();
  const missing: string[] = [];
  for (const id of new Set(userIds)) {
    const hit = shownCache.get(`${role}:${id}`);
    if (hit && now.getTime() - hit.at < SHOWN_CACHE_MS) out.set(id, hit.value); else missing.push(id);
  }
  if (missing.length) {
    const rows = await db.rating.findMany({
      where: { rateeId: { in: missing }, type: { in: TYPES_FOR_ROLE[role] as never }, state: 'ACTIVE' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { rateeId: true, score: true, createdAt: true, editableUntil: true },
    });
    const byPerson = new Map<string, RatingRow[]>(missing.map((id) => [id, []]));
    for (const r of rows) byPerson.get(r.rateeId!)?.push(r);
    for (const [id, list] of byPerson) {
      const value = shownRating(groupRatings(list, now), role);
      if (shownCache.size >= SHOWN_CACHE_MAX) shownCache.delete(shownCache.keys().next().value!);
      shownCache.set(`${role}:${id}`, { at: now.getTime(), value });
      out.set(id, value);
    }
  }
  return out;
}

/** One person's shown figures. */
export async function shownRatingFor(db: Pick<PrismaClient, 'rating'>, role: PersonRatingRole, userId: string): Promise<ShownRating> {
  return (await shownRatingsFor(db, role, [userId])).get(userId)!;
}

/** The groups of the ratings `userId` received in `role` (ACTIVE ones only), read from the database. */
export async function ratingGroupsFor(
  db: Pick<PrismaClient, 'rating'>,
  subject: { role: PersonRatingRole; userId: string },
  now: Date = new Date(),
): Promise<GroupedRatings> {
  const rows = await db.rating.findMany({
    where: { rateeId: subject.userId, type: { in: TYPES_FOR_ROLE[subject.role] as never }, state: 'ACTIVE' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { score: true, createdAt: true, editableUntil: true },
  });
  return groupRatings(rows, now);
}

/** The four star-line fields of a shown figure (the RatingSurface shape every client already reads). */
export function shownSurface({ displayRating, ratingBucket, ratingCount, topRated }: ShownRating): RatingSurface {
  return { displayRating, ratingBucket, ratingCount, topRated };
}

/** Where a screen showed the legacy averageRating/totalRatings: the same names, from whole groups. */
export async function shownRatingTotals(db: Pick<PrismaClient, 'rating'>, role: PersonRatingRole, userId: string) {
  const shown = await shownRatingFor(db, role, userId);
  return { averageRating: shown.average, totalRatings: shown.ratingCount };
}
