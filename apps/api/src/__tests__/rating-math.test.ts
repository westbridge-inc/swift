import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  displayRating,
  countBucket,
  standingBand,
  topRatedEligible,
  RATING_AFFECTS_DISPATCH,
} from '../modules/rating/rating-math';
import { seedRatingTags, seedRows, tagsForRole } from '../modules/rating/tag-taxonomy.seed';

// ---------------------------------------------------------------------------
// Movement R foundation: RAT-C's fixture table BYTE-EXACT (the Bayesian
// smoothing that stops 1.0-star launches), the count buckets, the standing
// bands with their exact thresholds, R-Law 4 pinned in code, and the R4 tag
// taxonomy seeded per role with star-band gating.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } },
});
const TENANT = `rat-test-${Math.floor(Math.random() * 1_000_000)}`;

beforeAll(async () => { await prisma.$connect(); });
afterAll(async () => {
  await prisma.ratingTagDef.deleteMany({ where: { tenantId: TENANT } });
  await prisma.$disconnect();
});

describe('RAT-C: the display-rating fixture table (exact)', () => {
  it('matches every row of R3', () => {
    expect(displayRating(0, 0)).toBeNull(); // "New"
    expect(displayRating(4, 20)).toBeNull(); // below min-display: "New"
    expect(displayRating(5, 25)).toBe(4.7); // (46+25)/15
    expect(displayRating(5, 21)).toBe(4.5); // 4×5★+1×1★ → (46+21)/15
    expect(displayRating(100, 480)).toBe(4.8); // (46+480)/110
    expect(displayRating(20, 20)).toBe(2.2); // 20×1★ → (46+20)/30
  });

  it('buckets counts the Uber way', () => {
    expect(countBucket(7)).toBe('(7)');
    expect(countBucket(320)).toBe('(320+)');
    expect(countBucket(327)).toBe('(320+)');
    expect(countBucket(999)).toBe('(990+)');
    expect(countBucket(5000)).toBe('(5,000+)');
    expect(countBucket(5999)).toBe('(5,000+)');
  });
});

describe('standing bands (exact thresholds; only badges/coaching/founder-queue)', () => {
  it('NEW below min-display; GOOD-by-default below min-events', () => {
    expect(standingBand(3, 3, 15)).toBe('NEW');
    expect(standingBand(10, 10, 30)).toBe('GOOD'); // even at mean 3.0 — too few events to judge
  });

  it('bands flip at exactly 4.80 / 4.50 / 4.20 on the rolling mean', () => {
    expect(standingBand(50, 100, 480)).toBe('EXCELLENT'); // 4.80
    expect(standingBand(50, 100, 479)).toBe('GOOD'); // 4.79
    expect(standingBand(50, 100, 450)).toBe('GOOD'); // 4.50
    expect(standingBand(50, 100, 449)).toBe('ATTENTION'); // 4.49
    expect(standingBand(50, 100, 420)).toBe('ATTENTION'); // 4.20
    expect(standingBand(50, 100, 419)).toBe('AT_RISK'); // 4.19
  });

  it('top-rated needs EXCELLENT + volume where required', () => {
    expect(topRatedEligible('EXCELLENT', 50, true)).toBe(true);
    expect(topRatedEligible('EXCELLENT', 49, true)).toBe(false);
    expect(topRatedEligible('EXCELLENT', 3, false)).toBe(true); // riders/drivers: no volume gate
    expect(topRatedEligible('GOOD', 500, true)).toBe(false);
  });

  it('R-Law 4 is pinned in code: ratings never touch dispatch', () => {
    expect(RATING_AFFECTS_DISPATCH).toBe(false);
  });
});

describe('R4: the tag taxonomy', () => {
  it('seeds all five roles exactly, idempotently; star band gates the set', async () => {
    const rows = seedRows();
    expect(rows.filter((r) => r.role === 'VENDOR')).toHaveLength(12);
    expect(rows.filter((r) => r.role === 'RIDER')).toHaveLength(8);
    expect(rows.filter((r) => r.role === 'DRIVER')).toHaveLength(10);
    expect(rows.filter((r) => r.role === 'SERVICE_PROVIDER')).toHaveLength(10);
    expect(rows.filter((r) => r.role === 'CUSTOMER')).toHaveLength(6);

    const first = await seedRatingTags(prisma, TENANT);
    expect(first.created).toBe(rows.length);
    const again = await seedRatingTags(prisma, TENANT);
    expect(again.created).toBe(0);

    // 2★ shows the negative set; 5★ the positive; cold-food is vendor-only.
    const low = await tagsForRole(prisma, 'VENDOR', 2, TENANT);
    expect(low.has('cold-food')).toBe(true);
    expect(low.has('tasty-food')).toBe(false);
    const high = await tagsForRole(prisma, 'VENDOR', 5, TENANT);
    expect(high.has('tasty-food')).toBe(true);
    const riderLow = await tagsForRole(prisma, 'RIDER', 1, TENANT);
    expect(riderLow.has('cold-food')).toBe(false); // structurally rider-blameless (edge 8)
    expect(riderLow.has('late')).toBe(true);
  });
});
