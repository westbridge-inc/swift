import type { PrismaClient, Rating } from '@prisma/client';
import {
  RATING_ROLLING_COUNT,
  displayRating,
  standingBand,
} from './rating-math';

// ---------------------------------------------------------------------------
// Movement R — ActorRatingStat, the materialized aggregate (R3). Two writers,
// one truth: the incremental path (on every rating insert/edit/state-change)
// and the nightly full recompute MUST land identical values — RAT-H gates it.
// The subject mapping rides the EXISTING RatingType directions; ACTIVE rows
// count, EXCLUDED/REMOVED never do. Standing can warn, coach, or enqueue for
// the FOUNDER — nothing else (R-Law 3); dispatch never reads any of this
// (R-Law 4).
// ---------------------------------------------------------------------------

export type SubjectRef = { role: 'VENDOR' | 'RIDER' | 'DRIVER' | 'SERVICE_PROVIDER' | 'CUSTOMER'; id: string };

/** Which stat subject a rating row feeds, in the existing model's terms. */
export function subjectOf(rating: Pick<Rating, 'type' | 'vendorId' | 'rateeId'>): SubjectRef | null {
  switch (rating.type) {
    case 'CUSTOMER_TO_VENDOR':
      return rating.vendorId ? { role: 'VENDOR', id: rating.vendorId } : null;
    case 'CUSTOMER_TO_RIDER':
      return rating.rateeId ? { role: 'RIDER', id: rating.rateeId } : null;
    case 'CUSTOMER_TO_DRIVER':
      return rating.rateeId ? { role: 'DRIVER', id: rating.rateeId } : null;
    case 'CUSTOMER_TO_PROVIDER':
      return rating.rateeId ? { role: 'SERVICE_PROVIDER', id: rating.rateeId } : null;
    case 'RIDER_TO_CUSTOMER':
    case 'DRIVER_TO_CUSTOMER':
    case 'PROVIDER_TO_CUSTOMER':
      return rating.rateeId ? { role: 'CUSTOMER', id: rating.rateeId } : null;
    default:
      return null;
  }
}

export const TYPES_FOR_ROLE: Record<SubjectRef['role'], string[]> = {
  VENDOR: ['CUSTOMER_TO_VENDOR'],
  RIDER: ['CUSTOMER_TO_RIDER'],
  DRIVER: ['CUSTOMER_TO_DRIVER'],
  SERVICE_PROVIDER: ['CUSTOMER_TO_PROVIDER'],
  CUSTOMER: ['RIDER_TO_CUSTOMER', 'DRIVER_TO_CUSTOMER', 'PROVIDER_TO_CUSTOMER'],
};

export class RatingStatsService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Full recompute for one subject from rows — the reference implementation.
   * The incremental path simply calls this (correct beats clever: with the
   * rolling window and tag tops in play, a delta update re-derives the same
   * queries anyway; the nightly job re-runs it across all subjects so
   * RAT-H's three answers stay one value by construction).
   */
  async recompute(subject: SubjectRef, tenantId = 'swift-default'): Promise<void> {
    const where = {
      type: { in: TYPES_FOR_ROLE[subject.role] as never },
      state: 'ACTIVE' as const,
      ...(subject.role === 'VENDOR' ? { vendorId: subject.id } : { rateeId: subject.id }),
    };
    const rows = await this.prisma.rating.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: { score: true, tags: true, createdAt: true },
    });

    const lifetimeCount = rows.length;
    const lifetimeSum = rows.reduce((s, r) => s + r.score, 0);
    const rolling = rows.slice(0, RATING_ROLLING_COUNT);
    const rollingCount = rolling.length;
    const rollingSum = rolling.reduce((s, r) => s + r.score, 0);

    const tagCounts = new Map<string, number>();
    for (const r of rows) for (const t of r.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    const defs = await this.prisma.ratingTagDef.findMany({
      where: { tenantId, role: subject.role },
      select: { slug: true, sentiment: true },
    });
    const sentiment = new Map(defs.map((d) => [d.slug, d.sentiment]));
    const tops = (want: string) =>
      [...tagCounts.entries()]
        .filter(([slug]) => sentiment.get(slug) === want)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([tag, count]) => ({ tag, count }));

    const display = displayRating(lifetimeCount, lifetimeSum);
    const standing = standingBand(lifetimeCount, rollingCount, rollingSum);

    await this.prisma.actorRatingStat.upsert({
      where: { tenantId_subjectRole_subjectId: { tenantId, subjectRole: subject.role, subjectId: subject.id } },
      create: {
        tenantId,
        subjectRole: subject.role,
        subjectId: subject.id,
        lifetimeCount,
        lifetimeSum,
        rollingCount,
        rollingSum,
        displayRating: display,
        standing,
        topPositiveTags: tops('POSITIVE'),
        topNegativeTags: tops('NEGATIVE'),
      },
      update: {
        lifetimeCount,
        lifetimeSum,
        rollingCount,
        rollingSum,
        displayRating: display,
        standing,
        topPositiveTags: tops('POSITIVE'),
        topNegativeTags: tops('NEGATIVE'),
        recomputedAt: new Date(),
      },
    });
  }

  /** Incremental hook: recompute the subject a rating row touches. */
  async applyRating(rating: Pick<Rating, 'type' | 'vendorId' | 'rateeId'>): Promise<void> {
    const subject = subjectOf(rating);
    if (subject) await this.recompute(subject);
  }

  /** Nightly sweep across every subject with any rating (RAT-H's third leg
   *  is direct SQL in the test; this is the second). */
  async recomputeAll(tenantId = 'swift-default'): Promise<number> {
    const subjects = new Map<string, SubjectRef>();
    const rows = await this.prisma.rating.findMany({
      select: { type: true, vendorId: true, rateeId: true },
    });
    for (const r of rows) {
      const s = subjectOf(r);
      if (s) subjects.set(`${s.role}:${s.id}`, s);
    }
    for (const s of subjects.values()) await this.recompute(s, tenantId);
    return subjects.size;
  }

  /** Shield/ban plumbing (S2/S3/S4): flip state, re-level the touched
   *  subjects — the rating rows are KEPT (auditable), the aggregates move. */
  async excludeRatings(where: { orderId?: string; raterId?: string }, stateReason: string): Promise<number> {
    const targets = await this.prisma.rating.findMany({
      where: { ...where, state: 'ACTIVE' },
      select: { id: true, type: true, vendorId: true, rateeId: true },
    });
    if (targets.length === 0) return 0;
    await this.prisma.rating.updateMany({
      where: { id: { in: targets.map((t) => t.id) } },
      data: { state: 'EXCLUDED', stateReason },
    });
    const seen = new Set<string>();
    for (const t of targets) {
      const s = subjectOf(t);
      if (s && !seen.has(`${s.role}:${s.id}`)) {
        seen.add(`${s.role}:${s.id}`);
        await this.recompute(s);
      }
    }
    return targets.length;
  }
}
