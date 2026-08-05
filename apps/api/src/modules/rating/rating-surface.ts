// ---------------------------------------------------------------------------
// Movement R — R8: the public star line, computed in ONE place. Every surface
// (browse cards, storefront header, search documents) reads this mapper so the
// Bayesian display, the count bucket and the Top-rated badge can never drift
// apart between screens (RAT-I: sort by Top rated matches search matches SQL).
// ---------------------------------------------------------------------------

import { countBucket, topRatedEligible, type StandingBand } from './rating-math';

export interface RatingSurface {
  /** Bayesian display value, null under RATING_MIN_DISPLAY (UI shows "New"). */
  displayRating: number | null;
  /** "(7)" · "(40+)" · "(5,000+)" — the public count bucket. */
  ratingBucket: string;
  /** Raw lifetime count (search filtering / reconciliation; UI shows the bucket). */
  ratingCount: number;
  topRated: boolean;
}

/** Vendors/providers need volume for the badge; people need only the band. */
const VOLUME_ROLES = new Set(['VENDOR', 'SERVICE_PROVIDER']);

export const NEW_ACTOR_SURFACE: RatingSurface = Object.freeze({
  displayRating: null,
  ratingBucket: '(0)',
  ratingCount: 0,
  topRated: false,
});

interface StatRow {
  subjectId: string;
  displayRating: unknown; // Prisma Decimal | null
  lifetimeCount: number;
  standing: string;
}

/** One stat row → its public face (pure). */
export function surfaceOf(stat: StatRow, role: string): RatingSurface {
  return {
    displayRating: stat.displayRating == null ? null : Number(stat.displayRating),
    ratingBucket: countBucket(stat.lifetimeCount),
    ratingCount: stat.lifetimeCount,
    topRated: topRatedEligible(stat.standing as StandingBand, stat.lifetimeCount, VOLUME_ROLES.has(role)),
  };
}

interface StatDelegate {
  actorRatingStat: {
    findMany(args: {
      where: { subjectRole: string; subjectId: { in: string[] } };
    }): Promise<StatRow[]>;
  };
}

/** Batched R8 lookup: the star line for a page of subjects in one query.
 *  Unrated subjects get the NEW face — absence of a stat row is not an error. */
export async function ratingSurfaces(
  prisma: StatDelegate,
  role: 'VENDOR' | 'RIDER' | 'DRIVER' | 'SERVICE_PROVIDER' | 'CUSTOMER',
  subjectIds: string[],
): Promise<Map<string, RatingSurface>> {
  const map = new Map<string, RatingSurface>();
  for (const id of subjectIds) map.set(id, NEW_ACTOR_SURFACE);
  if (!subjectIds.length) return map;
  const stats = await prisma.actorRatingStat.findMany({
    where: { subjectRole: role, subjectId: { in: subjectIds } },
  });
  for (const s of stats) map.set(s.subjectId, surfaceOf(s, role));
  return map;
}
