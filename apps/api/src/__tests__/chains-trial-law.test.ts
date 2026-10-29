import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { normalizeDocNumber } from '../modules/integrity/normalize';
import { IdentityService } from '../modules/integrity/identity.service';
import { TrialEntitlementService } from '../modules/integrity/trial-entitlement.service';
import { previewTrial } from '../modules/integrity/enforcement';
import { SubscriptionService, TRIAL_DAYS, chainTrialPreview } from '../modules/subscription/subscription.service';
import { lockVendorActivationBilling } from '../modules/billing/billing-access';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { weeklyFeeAmount } from '../modules/billing/subscription-fee';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// [R048-001] the trial law's partial unique index self-installs on a db-push database (migrations carry it in CI).
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// [CHAINS · owner 29 Oct 2026] Multi-location chains and the trial law.
//
// 1. SHARED CHAIN TRIAL. A branch the owner adds while their first store's free trial runs shares that trial: it
//    ends on the SAME day. Never a fresh 14 days per branch, and no second trial grant. A branch added after the
//    trial ended is billed from approval (today's behaviour). Another person's account in the same identity
//    cluster gets nothing from it (the abuse rules for brand-new owners stay).
// 2. FOUNDER EXCEPTIONS GRANT ONLY WHAT THEY SAY. A live exception used to authorize an extra trial whatever its
//    scope: a MULTI_LOCATION_VENDOR exception handed out driver trials, a HOUSEHOLD one let the same person start
//    over. Now: MULTI_LOCATION_VENDOR covers store trials only; HOUSEHOLD covers another person of the household
//    (an account holding no trial of its own for the role); FOUNDER_OVERRIDE covers any role; anything else none.
//    The told-before preview says the same thing.
// 3. A CHAIN DEAL is born on a new branch: its custom rate is the owner's deal when the deal is not above its fee.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const identity = new IdentityService(prisma);
const trialLaw = new TrialEntitlementService(prisma);
const subscriptions = new SubscriptionService(prisma);
const TENANT = 'swift-default';
const DAY = 86_400_000;

const userIds: string[] = [];
const vendorIds: string[] = [];
let seq = 0;

async function makeUser() {
  seq += 1;
  const u = await prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Chain', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  userIds.push(u.id);
  return u;
}

async function makeStoreFor(userId: string) {
  const owner = await prisma.vendorOwner.upsert({ where: { userId }, create: { userId }, update: {} });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Chain Branch ${seq}-${wordFreeTag(8)}`, slug: `chain-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: testPhone(),
      addressLine1: '1 Branch Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  return { vendor, ownerId: owner.id };
}

const sameId = async (...accounts: string[]) => {
  const doc = `ID-${nanoid(8)}`;
  for (const accountId of accounts) {
    await identity.capture({ accountId, actorRole: 'VENDOR', type: 'ID_DOC_NUMBER', normalizedValue: normalizeDocNumber(doc), source: 'AI_ID_ANALYZER' });
  }
  return (await identity.resolveCluster(accounts[0]!))!;
};

const grantRow = (clusterId: string, accountId: string, role: string, status: 'ACTIVE' | 'CONSUMED' = 'ACTIVE') =>
  prisma.trialGrant.create({ data: { tenantId: TENANT, clusterId, role, accountId, status, startedAt: new Date(), endsAt: new Date(Date.now() + TRIAL_DAYS * DAY) } });

const exception = (clusterId: string, scope: string, expiresAt: Date | null = null) =>
  prisma.exceptionGrant.create({ data: { clusterId, scope, note: 'chains test', grantedBy: 'founder-test', expiresAt } });

beforeAll(async () => {
  await prisma.$connect();
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "trial_grants_one_active" ON "trial_grants" ("tenantId", "clusterId", "role") WHERE status = 'ACTIVE'`,
  );
});

afterAll(async () => {
  const clusters = await prisma.identityClusterMember.findMany({ where: { accountId: { in: userIds } }, select: { clusterId: true } });
  const clusterIds = [...new Set(clusters.map((c) => c.clusterId))];
  const subs = await prisma.subscription.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } });
  await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
  await prisma.enforcementAction.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.trialGrant.deleteMany({ where: { OR: [{ accountId: { in: userIds } }, { clusterId: { in: clusterIds } }] } });
  await prisma.identityKey.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.identityClusterMember.deleteMany({ where: { accountId: { in: userIds } } });
  await prisma.exceptionGrant.deleteMany({ where: { clusterId: { in: clusterIds } } });
  await prisma.identityCluster.deleteMany({ where: { OR: [{ id: { in: clusterIds } }, { mergedIntoId: { in: clusterIds } }] } });
  await prisma.subscription.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('[CHAINS] shared chain trial', () => {
  it('a branch added while the first store\'s trial runs shares its end date: no fresh 14 days, no second grant, no denial row', async () => {
    const owner = await makeUser();
    const first = await makeStoreFor(owner.id);
    const firstSub = await subscriptions.startTrialForVendor(first.vendor.id);
    expect(firstSub.status).toBe('TRIAL');
    // Days later the owner adds a branch: its trial must end when the first store's does, not 14 days from now.
    const earlier = new Date(Date.now() + 9 * DAY);
    await prisma.subscription.update({ where: { id: firstSub.id }, data: { trialEndDate: earlier, currentPeriodEnd: earlier, nextBillingDate: earlier } });
    const grantsBefore = await prisma.trialGrant.count({ where: { accountId: owner.id } });

    const branch = await makeStoreFor(owner.id);
    const branchSub = await subscriptions.startTrialForVendor(branch.vendor.id);
    expect(branchSub.status).toBe('TRIAL');
    expect(branchSub.isTrialActive).toBe(true);
    expect(branchSub.trialEndDate?.getTime()).toBe(earlier.getTime());
    expect(branchSub.nextBillingDate.getTime()).toBe(earlier.getTime());
    expect(branchSub.currentPeriodEnd.getTime()).toBe(earlier.getTime());
    expect(await prisma.trialGrant.count({ where: { accountId: owner.id } }), 'the branch shares the grant; it never takes one').toBe(grantsBefore);
    expect(await prisma.enforcementAction.count({ where: { accountId: owner.id, level: 'DENY_TRIAL' } }), 'a shared trial is not a denial').toBe(0);
  });

  it('a branch never outlives the trial grant itself (the earlier of the two ends)', async () => {
    const owner = await makeUser();
    const first = await makeStoreFor(owner.id);
    const firstSub = await subscriptions.startTrialForVendor(first.vendor.id);
    const grantEnd = new Date(Date.now() + 3 * DAY);
    await prisma.trialGrant.updateMany({ where: { accountId: owner.id, status: 'ACTIVE' }, data: { endsAt: grantEnd } });
    expect(firstSub.trialEndDate!.getTime()).toBeGreaterThan(grantEnd.getTime());
    const branch = await makeStoreFor(owner.id);
    const branchSub = await subscriptions.startTrialForVendor(branch.vendor.id);
    expect(branchSub.status).toBe('TRIAL');
    expect(branchSub.trialEndDate?.getTime()).toBe(grantEnd.getTime());
  });

  it('a branch added after the trial ended is billed from approval, as today', async () => {
    const owner = await makeUser();
    const first = await makeStoreFor(owner.id);
    const firstSub = await subscriptions.startTrialForVendor(first.vendor.id);
    // Day 15: the trial converted (the grant itself stays ACTIVE in the ledger; the store's trial is over).
    const past = new Date(Date.now() - DAY);
    await prisma.subscription.update({ where: { id: firstSub.id }, data: { status: 'ACTIVE', isTrialActive: false, trialEndDate: past } });
    const branch = await makeStoreFor(owner.id);
    const before = Date.now();
    const branchSub = await subscriptions.startTrialForVendor(branch.vendor.id);
    expect(branchSub.status).toBe('ACTIVE');
    expect(branchSub.isTrialActive).toBe(false);
    expect(branchSub.nextBillingDate.getTime()).toBeLessThanOrEqual(Date.now());
    expect(branchSub.nextBillingDate.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('a branch whose sibling trial ended by date (not yet converted) is billed from approval', async () => {
    const owner = await makeUser();
    const first = await makeStoreFor(owner.id);
    const firstSub = await subscriptions.startTrialForVendor(first.vendor.id);
    const past = new Date(Date.now() - 60_000);
    await prisma.subscription.update({ where: { id: firstSub.id }, data: { trialEndDate: past } });
    const branch = await makeStoreFor(owner.id);
    const branchSub = await subscriptions.startTrialForVendor(branch.vendor.id);
    expect(branchSub.status).toBe('ACTIVE');
  });

  it('another account of the same person gets no shared trial from it (the abuse rule stays)', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    await sameId(h1.id, h2.id);
    const first = await makeStoreFor(h1.id);
    await subscriptions.startTrialForVendor(first.vendor.id);
    const other = await makeStoreFor(h2.id);
    const sub = await subscriptions.startTrialForVendor(other.vendor.id);
    expect(sub.status).toBe('ACTIVE');
    expect(await prisma.enforcementAction.count({ where: { accountId: h2.id, level: 'DENY_TRIAL', reasonCode: 'TRIAL_ACTIVE_ELSEWHERE' } })).toBe(1);
  });

  it('a store trial another person\'s running trial paid for (via a founder exception) is never shared onward', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    const clusterId = await sameId(h1.id, h2.id);
    const a = await makeStoreFor(h1.id);
    await subscriptions.startTrialForVendor(a.vendor.id);
    const ex = await exception(clusterId, 'MULTI_LOCATION_VENDOR');
    const b = await makeStoreFor(h2.id);
    expect((await subscriptions.startTrialForVendor(b.vendor.id)).status, 'the exception trial').toBe('TRIAL');
    await prisma.exceptionGrant.update({ where: { id: ex.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    // h2's own exception trial is used up (a store of h2 churned) while store B's trial still runs: h2's next store
    // finds a running VENDOR grant, but it is h1's, not h2's own, so nothing is shared.
    await prisma.trialGrant.updateMany({ where: { accountId: h2.id, role: `VENDOR:EX:${h2.id}` }, data: { status: 'CONSUMED' } });
    const c = await makeStoreFor(h2.id);
    expect((await subscriptions.startTrialForVendor(c.vendor.id)).status).toBe('ACTIVE');
  });

  for (const scope of ['FOUNDER_OVERRIDE', 'MULTI_LOCATION_VENDOR']) {
    it(`a live ${scope} exception never gives a branch a fresh trial: every branch shares the owner's, one grant, every approval succeeds`, async () => {
      const owner = await makeUser();
      const other = await makeUser();
      const clusterId = await sameId(owner.id, other.id);
      await exception(clusterId, scope);
      const first = await makeStoreFor(owner.id);
      const firstSub = await subscriptions.startTrialForVendor(first.vendor.id);
      expect(firstSub.status).toBe('TRIAL');
      const end = firstSub.trialEndDate!.getTime();
      for (let n = 0; n < 3; n += 1) {
        const b = await makeStoreFor(owner.id);
        const sub = await subscriptions.startTrialForVendor(b.vendor.id);
        expect(sub.status, `branch ${n + 2}`).toBe('TRIAL');
        expect(sub.trialEndDate!.getTime(), `branch ${n + 2} shares the owner's end`).toBe(end);
      }
      expect(await prisma.trialGrant.count({ where: { accountId: owner.id } }), 'one grant for the whole chain').toBe(1);
    });

    for (const ownTrial of ['an exception grant', 'an ordinary grant']) {
      it(`a live ${scope} exception, the owner's own store trial (${ownTrial}) has ENDED: a new branch is billed from approval (no second grant, no crash)`, async () => {
        const owner = await makeUser();
        const other = await makeUser();
        const clusterId = await sameId(owner.id, other.id);
        if (ownTrial === 'an exception grant') {
          // The cluster's ordinary store trial went to the other account, so the owner's own trial is the exception's.
          const o = await makeStoreFor(other.id);
          expect((await subscriptions.startTrialForVendor(o.vendor.id)).status).toBe('TRIAL');
          await exception(clusterId, scope);
        }
        const first = await makeStoreFor(owner.id);
        const firstSub = await subscriptions.startTrialForVendor(first.vendor.id);
        expect(firstSub.status).toBe('TRIAL');
        if (ownTrial === 'an ordinary grant') await exception(clusterId, scope);
        const ownRole = ownTrial === 'an exception grant' ? `VENDOR:EX:${owner.id}` : 'VENDOR';
        expect(await prisma.trialGrant.count({ where: { accountId: owner.id, role: ownRole, status: 'ACTIVE' } })).toBe(1);
        // The clock passes the owner's trial end. Nothing flips a grant off ACTIVE at its end, so its row stays ACTIVE.
        const past = new Date(Date.now() - DAY);
        await prisma.trialGrant.updateMany({ where: { clusterId }, data: { startedAt: new Date(past.getTime() - TRIAL_DAYS * DAY), endsAt: past } });
        // The trial converted and the first week is paid (next bill ahead), so no fee sweep elsewhere picks these rows up.
        const ahead = new Date(Date.now() + 6 * DAY);
        await prisma.subscription.updateMany({
          where: { vendor: { owner: { userId: { in: [owner.id, other.id] } } } },
          data: { status: 'ACTIVE', isTrialActive: false, trialEndDate: past, currentPeriodEnd: ahead, nextBillingDate: ahead },
        });
        const b = await makeStoreFor(owner.id);
        const sub = await subscriptions.startTrialForVendor(b.vendor.id);
        expect(sub.status, 'billed from approval').toBe('ACTIVE');
        expect(sub.isTrialActive).toBe(false);
        expect(await prisma.trialGrant.count({ where: { accountId: owner.id } }), 'still the one grant of their own').toBe(1);
        // REVIEW-G P2: and the branch after that too (it used to throw once a second exception trial had ended).
        const c = await makeStoreFor(owner.id);
        expect((await subscriptions.startTrialForVendor(c.vendor.id)).status).toBe('ACTIVE');
        expect(await prisma.trialGrant.count({ where: { accountId: owner.id } })).toBe(1);
        expect(await chainTrialPreview(prisma, owner.id, new Date()), 'the add-a-branch screen says: billed from approval').toBeNull();
      });
    }
  }

  it('an owner whose first store trial came from a founder exception shares it with their branches too', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    const clusterId = await sameId(h1.id, h2.id);
    const a = await makeStoreFor(h1.id);
    await subscriptions.startTrialForVendor(a.vendor.id);
    await exception(clusterId, 'MULTI_LOCATION_VENDOR');
    const b = await makeStoreFor(h2.id);
    const bSub = await subscriptions.startTrialForVendor(b.vendor.id);
    expect(bSub.status).toBe('TRIAL');
    for (let n = 0; n < 2; n += 1) {
      const c = await makeStoreFor(h2.id);
      const cSub = await subscriptions.startTrialForVendor(c.vendor.id);
      expect(cSub.status).toBe('TRIAL');
      expect(cSub.trialEndDate!.getTime()).toBe(bSub.trialEndDate!.getTime());
    }
    expect(await prisma.trialGrant.count({ where: { accountId: h2.id } })).toBe(1);
    // REVIEW-G E12: the add-a-branch screen tells this owner (trial from a founder exception) the same shared end day.
    expect((await chainTrialPreview(prisma, h2.id, new Date()))?.getTime()).toBe(bSub.trialEndDate!.getTime());
  });

  it('a branch approved while its owner\'s chain deal is being set waits for the deal and is born on it (REVIEW-G E10)', async () => {
    const owner = await makeUser();
    const first = await makeStoreFor(owner.id);
    await subscriptions.startTrialForVendor(first.vendor.id);
    const b = await makeStoreFor(owner.id);
    let activation: Promise<{ customRate: unknown }> | null = null;
    await prisma.$transaction(async (tx) => {
      // What setChainDeal holds while it writes a deal: the owner's settlement locks.
      await lockVendorActivationBilling(tx, owner.id);
      await tx.vendorOwner.update({ where: { userId: owner.id }, data: { dealWeeklyRate: 9000, dealCurrencyCode: 'GYD', dealSetAt: new Date(), dealSetBy: 'founder-test', dealReason: 'chain deal test' } });
      activation = subscriptions.startTrialForVendor(b.vendor.id);
      await new Promise((r) => setTimeout(r, 1500));
    }, { timeout: 20_000 });
    const sub = await activation!;
    expect(Number(sub.customRate), 'born on the deal set while it waited').toBe(9000);
  });
});

describe('[CHAINS] a founder exception grants only what its scope says', () => {
  it('MULTI_LOCATION_VENDOR: a store trial, never a driver trial', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    const clusterId = await sameId(h1.id, h2.id);
    await grantRow(clusterId, h1.id, 'DRIVER');
    await grantRow(clusterId, h1.id, 'VENDOR');
    await exception(clusterId, 'MULTI_LOCATION_VENDOR');
    const driver = await trialLaw.decide(h2.id, 'DRIVER', TENANT);
    expect(driver).toMatchObject({ grant: false, reason: 'TRIAL_ACTIVE_ELSEWHERE' });
    const store = await trialLaw.decide(h2.id, 'VENDOR', TENANT);
    expect(store).toMatchObject({ grant: true, reason: 'EXCEPTION_GRANT' });
    expect((await previewTrial(prisma, h2.id, 'DRIVER', TENANT)).willTrial).toBe(false);
    expect((await previewTrial(prisma, h2.id, 'VENDOR', TENANT)).willTrial).toBe(true);
  });

  it('HOUSEHOLD: another person of the household, never the same person a second time', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    const clusterId = await sameId(h1.id, h2.id);
    await grantRow(clusterId, h1.id, 'RIDER', 'CONSUMED');
    await exception(clusterId, 'HOUSEHOLD');
    expect(await trialLaw.decide(h1.id, 'RIDER', TENANT)).toMatchObject({ grant: false, reason: 'TRIAL_CONSUMED' });
    expect((await previewTrial(prisma, h1.id, 'RIDER', TENANT)).willTrial).toBe(false);
    expect(await trialLaw.decide(h2.id, 'RIDER', TENANT)).toMatchObject({ grant: true, reason: 'EXCEPTION_GRANT' });
    expect((await previewTrial(prisma, h2.id, 'RIDER', TENANT)).willTrial).toBe(true);
  });

  it('HOUSEHOLD: a person who already had a household trial for the role does not get another', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    const clusterId = await sameId(h1.id, h2.id);
    await grantRow(clusterId, h1.id, 'RIDER');
    await prisma.trialGrant.create({ data: { tenantId: TENANT, clusterId, role: `RIDER:EX:${h2.id}`, accountId: h2.id, status: 'CONSUMED', startedAt: new Date(), endsAt: new Date(), statusReason: 'EXCEPTION_GRANT' } });
    await exception(clusterId, 'HOUSEHOLD');
    expect(await trialLaw.decide(h2.id, 'RIDER', TENANT)).toMatchObject({ grant: false, reason: 'TRIAL_ACTIVE_ELSEWHERE' });
    expect((await previewTrial(prisma, h2.id, 'RIDER', TENANT)).willTrial).toBe(false);
  });

  it('FOUNDER_OVERRIDE: any role', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    const clusterId = await sameId(h1.id, h2.id);
    await grantRow(clusterId, h1.id, 'DRIVER');
    await exception(clusterId, 'FOUNDER_OVERRIDE');
    expect(await trialLaw.decide(h2.id, 'DRIVER', TENANT)).toMatchObject({ grant: true, reason: 'EXCEPTION_GRANT' });
    expect((await previewTrial(prisma, h2.id, 'DRIVER', TENANT)).willTrial).toBe(true);
  });

  it('a scope Swift does not know grants nothing, and an expired exception grants nothing', async () => {
    const h1 = await makeUser();
    const h2 = await makeUser();
    const clusterId = await sameId(h1.id, h2.id);
    await grantRow(clusterId, h1.id, 'VENDOR');
    await exception(clusterId, 'SOMETHING_ELSE');
    await exception(clusterId, 'FOUNDER_OVERRIDE', new Date(Date.now() - 1000));
    expect(await trialLaw.decide(h2.id, 'VENDOR', TENANT)).toMatchObject({ grant: false, reason: 'TRIAL_ACTIVE_ELSEWHERE' });
    expect((await previewTrial(prisma, h2.id, 'VENDOR', TENANT)).willTrial).toBe(false);
  });
});

describe('[CHAINS] a chain deal is born on a new branch', () => {
  it('a deal at or under the fee becomes the branch\'s custom rate; a deal above it is never applied', async () => {
    const owner = await makeUser();
    const first = await makeStoreFor(owner.id);
    const firstSub = await subscriptions.startTrialForVendor(first.vendor.id);
    const tier = Number(firstSub.weeklyRate);
    expect(firstSub.customRate).toBeNull();
    await prisma.vendorOwner.update({ where: { id: first.ownerId }, data: {
      dealWeeklyRate: tier - 2000, dealCurrencyCode: firstSub.currencyCode, dealSetAt: new Date(), dealSetBy: 'founder-test', dealReason: 'chain deal test',
    } });
    const branch = await makeStoreFor(owner.id);
    const branchSub = await subscriptions.startTrialForVendor(branch.vendor.id);
    expect(Number(branchSub.customRate)).toBe(tier - 2000);
    expect(Number(branchSub.weeklyRate)).toBe(tier);
    // [REVIEW-M S4-3] Its fee history says why it pays the deal.
    const born = await prisma.billingEvent.findMany({ where: { subscriptionId: branchSub.id, type: 'TIER_CHANGE' } });
    expect(born.map((e) => Number(e.amount))).toEqual([tier - 2000]);

    await prisma.vendorOwner.update({ where: { id: first.ownerId }, data: { dealWeeklyRate: tier + 500 } });
    const third = await makeStoreFor(owner.id);
    const thirdSub = await subscriptions.startTrialForVendor(third.vendor.id);
    // A standing rule: born on the deal, but never charged above its own fee.
    expect(Number(thirdSub.customRate)).toBe(tier + 500);
    expect(weeklyFeeAmount(thirdSub), 'a deal never raises a branch above its own fee').toBe(tier);
    expect(await prisma.billingEvent.count({ where: { subscriptionId: thirdSub.id } }), 'its fee is its own: nothing to record').toBe(0);
  });
});
