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

export interface GroupedRatings {
  groups: RatingGroup[];
  /** Over whole groups only. */
  count: number;
  sum: number;
  average: number | null;
}

interface RatingRow { score: number; createdAt: Date; editableUntil: Date | null }

const round2 = (x: number) => Math.round(x * 100) / 100;

/** The pure cut: rows in the order given -> the final prefix -> whole groups. */
export function groupRatings(rows: readonly RatingRow[], now: Date = new Date()): GroupedRatings {
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
  return { groups, count: whole.length, sum, average: whole.length ? round2(sum / whole.length) : null };
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
