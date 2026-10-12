import { grantStepUp } from './helpers/step-up';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ownedVerificationFixture } from './helpers/verification-object';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { AccountService } from '../modules/user/account.service';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { lockMoverFeeAuthority } from '../modules/subscription/mover-fee-authority';
import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { RatingService } from '../modules/rating/rating.service';

// ---------------------------------------------------------------------------
// SWIFT-AUD-D9-05 — self-serve DPA rights: export (access + portability) and
// account deletion (erasure). Proves the erasure actually shreds documents,
// revokes access and de-identifies — and that it fails closed for partner
// accounts and mid-delivery.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const advertiserIds: string[] = [];
const placementIds: string[] = [];
let seq = 0;
const phoneBase = 592_810_000_000 + Math.floor(Math.random() * 100_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Del',
      lastName: `U${seq}`,
      email: `del${seq}-${nanoid(6)}@example.com`,
      roles,
      activeRole: roles[0]!,
      isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'del', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await grantStepUp(app, token);
  return { userId: user.id, token };
}

const inject = (method: 'GET' | 'DELETE', url: string, token: string) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.adsAuditLog.deleteMany({ where: { entityId: { in: advertiserIds } } });
  await app.prisma.adCampaign.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await app.prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await app.prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await app.prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await app.prisma.vendorStaff.deleteMany({ where: { userId: { in: createdUserIds } } });
  const originals = await app.prisma.subscription.findMany({ where: { OR: [
    { rider: { userId: { in: createdUserIds } } }, { driver: { userId: { in: createdUserIds } } },
    { vendor: { owner: { userId: { in: createdUserIds } } } },
  ] }, select: { id: true } });
  await cleanupPayerBillingClocks(app.prisma, createdUserIds);
  await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: createdUserIds } } });
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.supportTicket.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: originals.map((s) => s.id) } } });
  await purgeAuditLogs(app.prisma, { OR: [{ userId: { in: createdUserIds } }, { entityId: { in: createdUserIds } }] }, 'test-cleanup:account-deletion');
  await app.close();
});

describe('D9-05 — account export', () => {
  it('returns the customer’s own data as a portable bundle', async () => {
    const u = await makeUser(['CUSTOMER']);
    await app.prisma.address.create({ data: { userId: u.userId, label: 'Home', addressLine1: '1 Main St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1 } });

    const res = await inject('GET', '/api/v1/customer/account/export', u.token);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.account.id).toBe(u.userId);
    expect(d.addresses).toHaveLength(1);
    expect(d).toHaveProperty('orders');
    expect(d).toHaveProperty('ratingsGiven');
    expect(d).toHaveProperty('exportedAt');
  });
});

describe('D9-05 — account deletion (erasure)', () => {
  it('crypto-shreds documents, revokes sessions, de-identifies, and drops addresses', async () => {
    const u = await makeUser(['CUSTOMER']);
    await app.prisma.address.create({ data: { userId: u.userId, label: 'Home', addressLine1: '1 Main St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1 } });

    const fileKey = await ownedVerificationFixture(app.prisma, u.userId);
    const doc = await app.prisma.verificationDocument.create({ data: { userId: u.userId, role: 'CUSTOMER', docType: 'ID_CARD', fileUrl: fileKey } });

    const res = await inject('DELETE', '/api/v1/customer/account', u.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(true);

    const after = await app.prisma.user.findUnique({ where: { id: u.userId } });
    expect(after?.status).toBe('DEACTIVATED');
    expect(after?.firstName).toBe('Deleted');
    expect(after?.email).toBeNull();
    expect(after?.phone.startsWith('deleted:')).toBe(true); // real number freed, uniqueness kept

    expect(await app.prisma.session.count({ where: { userId: u.userId } })).toBe(0);
    expect(await app.prisma.address.count({ where: { userId: u.userId } })).toBe(0);

    const enc = await app.prisma.encryptedObject.findUnique({ where: { fileKey } });
    expect(enc?.wrappedDek).toBeNull(); // crypto-shredded — ciphertext now unrecoverable
    expect(enc?.shreddedAt).not.toBeNull();
    const purged = await app.prisma.verificationDocument.findUnique({ where: { id: doc.id } });
    expect(purged?.purgedAt).not.toBeNull();
  });

  it('[NR-3 gap 6] ephemeral high-risk rows go with the account', async () => {
    const u = await makeUser(['CUSTOMER']);
    const vendor = await app.prisma.vendor.findFirst({ select: { id: true } });
    await app.prisma.accountRecovery.create({ data: { userId: u.userId, method: 'IDENTITY_VERIFICATION', expiresAt: new Date(Date.now() + 86_400_000) } });
    await app.prisma.livenessCheck.create({ data: { userId: u.userId, profile: 'DRIVER', selfieUrl: 'liveness/x.jpg', outcome: 'PASS' } });
    await app.prisma.emergencyContact.create({ data: { userId: u.userId, name: 'Sis', phoneE164: '+5926000001' } });
    await app.prisma.supplyWatch.create({ data: { customerId: u.userId, pool: 'RIDE', lat: 6.8, lng: -58.1, expiresAt: new Date(Date.now() + 3_600_000) } });
    if (vendor) {
      await app.prisma.cart.create({ data: { customerId: u.userId, vendorId: vendor.id } });
    }

    const res = await inject('DELETE', '/api/v1/customer/account', u.token);
    expect(res.statusCode).toBe(200);

    expect(await app.prisma.accountRecovery.count({ where: { userId: u.userId } })).toBe(0);
    expect(await app.prisma.livenessCheck.count({ where: { userId: u.userId } })).toBe(0);
    expect(await app.prisma.emergencyContact.count({ where: { userId: u.userId } })).toBe(0);
    expect(await app.prisma.supplyWatch.count({ where: { customerId: u.userId } })).toBe(0);
    expect(await app.prisma.cart.count({ where: { customerId: u.userId } })).toBe(0);
  });

  it('[NR-3 gap 3] the deletion write barrier: a deactivated account cannot grow identity data back', async () => {
    const u = await makeUser(['CUSTOMER']);
    const res = await inject('DELETE', '/api/v1/customer/account', u.token);
    expect(res.statusCode).toBe(200);

    // Verification submit is refused outright.
    const { VerificationService } = await import('../modules/verification/verification.service');
    const { NotificationService } = await import('../modules/notification/notification.service');
    const { getKycProvider } = await import('../providers/kyc/kyc-provider');
    const verification = new VerificationService(
      app.prisma,
      new NotificationService(app.prisma, { to: () => ({ emit: () => {} }), emit: () => {} } as never),
      getKycProvider(),
    );
    await expect(
      verification.submitDocument(u.userId, 'MOVER', 'ID_CARD', 'verif/late.jpg', '2026-08-16'),
    ).rejects.toThrow(/not active/i);

    // Identity capture silently refuses to rebind the erased person.
    const { IdentityService } = await import('../modules/integrity/identity.service');
    const identity = new IdentityService(app.prisma);
    const out = await identity.capture({
      accountId: u.userId, actorRole: 'CUSTOMER', type: 'PHONE',
      normalizedValue: `5920099${String(Date.now()).slice(-6)}`, source: 'test-late-capture',
    });
    expect(out.merged).toBe(false);
    expect(await app.prisma.identityKey.count({ where: { accountId: u.userId } })).toBe(0);
  });

  // [Apple 5.1.1(v)] This used to assert the opposite: a mover was refused and
  // sent to Support. App Review names that specifically as not satisfying the
  // guideline — an app that lets you CREATE an account must let you delete it
  // IN the app — and Swift's app has a Delete account button, so a driver
  // pressing it was told to write an email.
  //
  // What replaced the blanket refusal is a narrow one: money in flight blocks,
  // everything else winds down.
  it('a mover with nothing outstanding closes their own account', async () => {
    const u = await makeUser(['CUSTOMER', 'MOVER']);
    const rider = await app.prisma.rider.create({ data: { userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
    const due = new Date(Date.now() - 2 * 86_400_000);
    const sub = await app.prisma.subscription.create({ data: { riderId: rider.id, type: 'DELIVERY_RIDER', status: 'TRIAL',
      weeklyRate: 6000, currentPeriodStart: new Date(due.getTime() - 7 * 86_400_000), currentPeriodEnd: due,
      nextBillingDate: due, isTrialActive: true, trialEndDate: due } });
    await app.prisma.$transaction((tx) => lockMoverFeeAuthority(tx, { userId: u.userId, tenantId: 'swift-default' }));
    const clock = await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { subscriptionId: sub.id } });
    const res = await inject('DELETE', '/api/v1/customer/account', u.token);
    expect(res.statusCode, res.payload).toBe(200);
    const after = await app.prisma.user.findUniqueOrThrow({ where: { id: u.userId } });
    expect(after.status).toBe('DEACTIVATED');
    expect(after.phone.startsWith('deleted:')).toBe(true);
    expect(after.firstName).toBe('Deleted');
    expect(await app.prisma.billingDunningClock.findUniqueOrThrow({ where: { id: clock.id } })).toEqual(clock);
    expect(await app.prisma.moverFeeAuthority.count({ where: { userId: u.userId } })).toBe(1);
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).autoRenew).toBe(false);
  });

  // [LAUNCH-2] The guard above filters `user.roles`. Advertiser membership and
  // vendor staff access deliberately are NOT roles, so these people have always
  // read as plain CUSTOMERs and could delete themselves — leaving a LIVE
  // campaign with no owner and staff rows pointing at "Deleted User".
  it('winds down an advertiser the deleted person solely owned — campaigns pause, seat goes', async () => {
    const u = await makeUser(['CUSTOMER']);
    const placement = await app.prisma.adPlacement.create({
      data: { key: `del_test_${nanoid(6)}`, name: 'Deletion test slot', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 1000 },
    });
    placementIds.push(placement.id);
    const adv = await app.prisma.advertiser.create({
      data: {
        companyName: `Del Ads ${nanoid(5)}`, industry: 'Retail', contactName: 'Del', contactEmail: 'del@example.com',
        contactPhone: '+5926000123', status: 'APPROVED', createdByUserId: u.userId,
        members: { create: { userId: u.userId, role: 'OWNER' } },
      },
    });
    advertiserIds.push(adv.id);
    const campaign = await app.prisma.adCampaign.create({
      data: {
        advertiserId: adv.id, placementId: placement.id, name: 'Live one', cities: ['*'],
        startWeek: new Date('2026-08-24'), endWeek: new Date('2026-08-31'), status: 'LIVE',
      },
    });

    const res = await inject('DELETE', '/api/v1/customer/account?receipts=v2', u.token);
    expect(res.statusCode).toBe(202);
    expect(res.json().data.status).toBe('CLOSURE_REQUESTED');
    expect(await app.prisma.session.count({ where: { userId: u.userId } })).toBe(1);
    // Authorized closure completion retains the existing wind-down invariants.
    await new AccountService(app).deleteAccount(u.userId);

    const afterCampaign = await app.prisma.adCampaign.findUnique({ where: { id: campaign.id } });
    expect(afterCampaign?.status).toBe('PAUSED'); // stops serving; NOT cancelled — no refund/inventory money moves on an erasure
    const afterAdv = await app.prisma.advertiser.findUnique({ where: { id: adv.id } });
    expect(afterAdv?.status).toBe('SUSPENDED');
    expect(afterAdv).not.toBeNull(); // the company + its invoices survive as financial records
    expect(await app.prisma.advertiserMember.count({ where: { userId: u.userId } })).toBe(0);
    expect(
      await app.prisma.adsAuditLog.count({ where: { entityId: adv.id, action: 'ADVERTISER_SUSPEND_ACCOUNT_DELETED' } }),
    ).toBe(1);
  });

  it('leaves a co-owned advertiser running — only the deleted person’s seat goes', async () => {
    const owner = await makeUser(['CUSTOMER']);
    const coOwner = await makeUser(['CUSTOMER']);
    const adv = await app.prisma.advertiser.create({
      data: {
        companyName: `Co Ads ${nanoid(5)}`, industry: 'Retail', contactName: 'Co', contactEmail: 'co@example.com',
        contactPhone: '+5926000124', status: 'APPROVED', createdByUserId: owner.userId,
        members: { create: [{ userId: owner.userId, role: 'OWNER' }, { userId: coOwner.userId, role: 'OWNER' }] },
      },
    });
    advertiserIds.push(adv.id);

    expect((await inject('DELETE', '/api/v1/customer/account?receipts=v2', owner.token)).statusCode).toBe(202);
    await new AccountService(app).deleteAccount(owner.userId);

    const afterAdv = await app.prisma.advertiser.findUnique({ where: { id: adv.id } });
    expect(afterAdv?.status).toBe('APPROVED'); // the company still has an owner
    expect(await app.prisma.advertiserMember.count({ where: { advertiserId: adv.id } })).toBe(1);
  });

  it('revokes vendor staff access rather than leaving rows pointing at “Deleted User”', async () => {
    const u = await makeUser(['CUSTOMER']);
    const vendor = await app.prisma.vendor.findFirst({ select: { id: true } });
    if (!vendor) return; // no seeded vendor in this database — nothing to assert against
    await app.prisma.vendorStaff.create({
      data: { vendorId: vendor.id, userId: u.userId, role: 'MANAGER', invitedBy: u.userId },
    });

    expect((await inject('DELETE', '/api/v1/customer/account', u.token)).statusCode).toBe(200);
    expect(await app.prisma.vendorStaff.count({ where: { userId: u.userId } })).toBe(0);
  });

  it('refuses while an order is in flight', async () => {
    const u = await makeUser(['CUSTOMER']);
    await app.prisma.order.create({
      data: {
        orderNumber: `DEL-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: u.userId, status: 'PREPARING', fulfillment: 'DELIVERY',
        pickupAddress: 'a', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'b', deliveryLat: 6.81, deliveryLng: -58.16,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500, paymentMethod: 'CASH',
      },
    });
    const res = await inject('DELETE', '/api/v1/customer/account', u.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ACTIVE_ORDERS');
  });
});

// [DELETION-INTEGRITY · owner decision 2026-10-05] A store's rating keeps the
// reviews a deleted person wrote — score and tags still count — but free text
// can identify them, so the comment AND the store's reply to it are deleted.
describe('DELETION-INTEGRITY — reviews by and about the person are kept anonymised', () => {
  it('keeps the score and tags, deletes the comment and the store reply, and leaves the store rating unchanged', async () => {
    const u = await makeUser(['CUSTOMER']);
    const vendor = await app.prisma.vendor.findFirstOrThrow({ select: { id: true } });
    const order = await app.prisma.order.create({ data: {
      orderNumber: `RV-${nanoid(10).toUpperCase()}`, customerId: u.userId, vendorId: vendor.id,
      orderType: 'FOOD_DELIVERY', status: 'DELIVERED', deliveryAddress: '1 Test St', deliveryLat: 6.8055, deliveryLng: -58.1553,
      subtotalBase: 1500, subtotalMarkup: 0, subtotalCustomer: 1500, deliveryFee: 0, totalAmount: 1500, paymentMethod: 'CASH',
    } });
    const rating = await app.prisma.rating.create({ data: {
      orderId: order.id, raterId: u.userId, vendorId: vendor.id, type: 'CUSTOMER_TO_VENDOR', score: 2,
      tags: ['cold_food'], comment: 'Del here from the blue house by the market, food was cold',
      response: 'Sorry Del, we will call you about the blue house order', respondedAt: new Date(), respondedBy: u.userId,
      visibleAt: new Date(),
    } });
    await app.prisma.ratingOutbox.create({ data: { ratingId: rating.id, command: 'SYNTHETIC_PAYLOAD', payload: { comment: 'Del here from the blue house', score: 2 } } });
    // [coordinator ruling 2026-10-05] A rating someone ELSE wrote about the
    // person can name or describe them too: it keeps its score and tags only.
    const author = await makeUser(['CUSTOMER']);
    const about = await app.prisma.rating.create({ data: {
      orderId: order.id, raterId: author.userId, rateeId: u.userId, type: 'RIDER_TO_CUSTOMER', score: 4,
      tags: ['friendly'], comment: 'Del was waiting at the blue house gate', response: 'Thanks, Del', respondedAt: new Date(), respondedBy: u.userId,
      visibleAt: new Date(),
    } });
    await app.prisma.ratingOutbox.create({ data: { ratingId: about.id, command: 'SYNTHETIC_PAYLOAD', payload: { comment: 'Del at the gate', score: 4 } } });
    try {
      const reviews = new RatingService(app.prisma);
      const before = await reviews.getVendorReviews(vendor.id, 100);

      const res = await inject('DELETE', '/api/v1/customer/account', u.token);
      expect(res.statusCode, res.payload).toBe(200);

      const kept = await app.prisma.rating.findUniqueOrThrow({ where: { id: rating.id } });
      expect(kept).toMatchObject({ score: 2, tags: ['cold_food'], state: 'ACTIVE', comment: null, response: null, respondedAt: null, respondedBy: null });
      const outbox = await app.prisma.ratingOutbox.findFirstOrThrow({ where: { ratingId: rating.id } });
      expect(outbox.payload).toEqual({ score: 2 });

      expect(await app.prisma.rating.findUniqueOrThrow({ where: { id: about.id } })).toMatchObject({
        score: 4, tags: ['friendly'], raterId: author.userId, comment: null, response: null, respondedAt: null, respondedBy: null,
      });
      expect((await app.prisma.ratingOutbox.findFirstOrThrow({ where: { ratingId: about.id } })).payload).toEqual({ score: 4 });

      const after = await reviews.getVendorReviews(vendor.id, 100);
      expect(after.distribution).toEqual(before.distribution);
      expect(after.total).toBe(before.total);
      const shown = after.reviews.find((r) => r.id === rating.id)!;
      expect(shown).toMatchObject({ score: 2, comment: null, response: null });
      expect(JSON.stringify(shown)).not.toMatch(/Del\b|blue house/);
      expect(shown.rater).toMatchObject({ firstName: 'Deleted', avatar: null });
    } finally {
      await app.prisma.ratingOutbox.deleteMany({ where: { ratingId: { in: [rating.id, about.id] } } });
      await app.prisma.rating.deleteMany({ where: { id: { in: [rating.id, about.id] } } });
    }
  });
});

