import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { isReviewSubscription } from '../modules/review/demo-policy';

// [BILL-PRO · REVIEW-G #2217 S3-1] The store-review money seal (REVIEW-PARTNER DL-5) refuses a fee subscription of
// the review fiction before setBillingRail / stopBilling write anything. A pro owns weekly fees from BILL-PRO PR3
// on, so the seal must see a pro's tenant too: a review-tenant pro's fee is the fiction, like a store's.
//
// The fake database answers only what the query selects, like Prisma: an owner the select leaves out reads as
// missing, so a seal that forgets the pro answers "not the fiction" (fail-open).
type Kind = 'LIVE' | 'REVIEW';
type Owner = 'rider' | 'driver' | 'vendor' | 'serviceProvider';

function fakeDb(owner: Owner, kind: Kind) {
  const tenant = { tenant: { kind } };
  const rows: Record<Owner, unknown> = {
    rider: { user: tenant },
    driver: { user: tenant },
    vendor: tenant,
    serviceProvider: { user: tenant },
  };
  return {
    subscription: {
      findUnique: async (args: { select: Record<string, unknown> }) => {
        const out: Record<string, unknown> = {};
        for (const key of Object.keys(args.select)) out[key] = key === owner ? rows[owner] : null;
        return out;
      },
    },
  } as unknown as Pick<PrismaClient, 'subscription'>;
}

describe('[BILL-PRO · G S3-1] isReviewSubscription sees every owner kind, the pro included', () => {
  it('a review-tenant pro\'s weekly fee is the fiction (refused before any money write)', async () => {
    expect(await isReviewSubscription(fakeDb('serviceProvider', 'REVIEW'), 'sub-pro')).toBe(true);
  });

  it('a live pro\'s weekly fee is not', async () => {
    expect(await isReviewSubscription(fakeDb('serviceProvider', 'LIVE'), 'sub-pro')).toBe(false);
  });

  it.each(['rider', 'driver', 'vendor'] as const)('the %s owner answers as before', async (owner) => {
    expect(await isReviewSubscription(fakeDb(owner, 'REVIEW'), 'sub')).toBe(true);
    expect(await isReviewSubscription(fakeDb(owner, 'LIVE'), 'sub')).toBe(false);
  });
});
