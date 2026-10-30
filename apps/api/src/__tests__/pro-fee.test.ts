import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { beginRequestTenantContext, prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { servicesRoutes } from '../modules/services/services.routes';
import { providerChecklist, refreshProviderVerification } from '../modules/services/services.service';
import { authRoutes } from '../modules/auth/auth.routes';
import { LEGAL_VERSION } from '../modules/legal/legal.routes';
import { providerShowsPhoto } from '../utils/public-store-photos';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { recordReacceptance } from '../modules/legal/reaccept';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { assertProviderCanOperate } from '../modules/services/provider-operate';
import {
  assertProFeeAllowsNewWork, birthDueProFees, ensureProFeeBorn, PRO_FEE_CUSTOMER_MESSAGE, proFeeQuote, proFeeStanding, proWeeklyFeeEnabled, recordProFeeAck,
} from '../modules/services/pro-fee';
import { WEEKLY_FEE_ACK_VERSION } from '../modules/partner/weekly-fee-ack';

// ---------------------------------------------------------------------------
// [BILL-PRO PR3 · owner 28 Oct 2026 Rounds A+B] The pro weekly fee is BORN and GATES new work, behind PRO_WEEKLY_FEE.
//  - Off (the default): no pro is ever charged or gated; every answer is as before.
//  - On: a pro's fee is born only when their documents are approved AND they accepted the Business Agreement that
//    covers Providers (never charged without the tick: A1/A3), on the services rate with the 14-day trial (A2), once;
//    a pro who also owns a Services store whose fee is live pays that one fee (B1). New work (listed, request, quote,
//    the customer's schedule, confirm, a booking from their list, public photos) needs the fee operable (B2: hidden
//    after the 48-hour grace); work already booked still goes ahead.
// Synthetic data only.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
const providerIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const DAY = 86_400_000;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-pro-fee');
const on = () => { process.env['PRO_WEEKLY_FEE'] = '1'; };

async function makeUser() {
  return sys(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: testPhone(), firstName: 'Pro', lastName: `Fee${nanoid(4)}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
    } });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'pro-fee', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    return { userId: user.id, token };
  });
}

/** The pro's "I understand the weekly fee" tick, with the amount they were quoted. */
async function tickFee(userId: string) {
  const quote = await sys(() => proFeeQuote(app.prisma, userId));
  await sys(() => recordProFeeAck(app.prisma, { userId, ack: { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: quote.currencyCode }, surface: 'mobile' }));
}

/** A pro whose whole checklist a person approved (live verification); `agreed` = ticked the Business Agreement AND
 *  "I understand the weekly fee" (`feeTick` alone overrides the second). */
async function makePro(opts: { agreed?: boolean; verified?: boolean; feeTick?: boolean } = {}) {
  const u = await makeUser();
  const provider = await sys(() => app.prisma.serviceProvider.create({ data: { userId: u.userId, trade: 'tutor', isVerified: opts.verified !== false } }));
  providerIds.push(provider.id);
  if (opts.verified !== false) {
    for (const docType of await sys(() => providerChecklist(app.prisma, u.userId))) {
      await sys(() => app.prisma.verificationDocument.create({
        data: { userId: u.userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
      }));
    }
  }
  if (opts.agreed) await sys(() => recordReacceptance(app.prisma, { userId: u.userId, roles: ['CUSTOMER'], hadAccepted: false, surface: 'mobile' }));
  if (opts.feeTick ?? opts.agreed) await tickFee(u.userId);
  return { ...u, providerId: provider.id };
}

async function servicesStoreFor(userId: string, status: 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' = 'ACTIVE') {
  return sys(async () => {
    const owner = await app.prisma.vendorOwner.upsert({ where: { userId }, update: {}, create: { userId } });
    const vendor = await app.prisma.vendor.create({ data: {
      ownerId: owner.id, name: `Pro Fee Store ${wordFreeTag(8)}`, slug: `pro-fee-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
      phone: '+5920000575', addressLine1: '1 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
    } });
    vendorIds.push(vendor.id);
    const sub = await app.prisma.subscription.create({ data: {
      vendorId: vendor.id, type: 'SERVICE_PROVIDER', weeklyRate: 8000, status, currencyCode: 'GYD',
      currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 6 * DAY), nextBillingDate: new Date(Date.now() + 6 * DAY),
    } });
    subIds.push(sub.id);
    return sub.id;
  });
}

const proSub = (providerId: string) => sys(() => app.prisma.subscription.findUnique({ where: { serviceProviderId: providerId } }));
const listedIds = async (token: string) => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/services/providers?trade=tutor&limit=50', headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().data.providers as Array<{ id: string }>).map((p) => p.id);
};

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(servicesRoutes, { prefix: '/api/v1/services' });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
});

afterEach(() => { delete process.env['PRO_WEEKLY_FEE']; });

afterAll(async () => {
  await sys(async () => {
    const subs = (await app.prisma.subscription.findMany({ where: { OR: [{ serviceProviderId: { in: providerIds } }, { id: { in: subIds } }] }, select: { id: true } })).map((s) => s.id);
    await cleanupBillingClocks(app.prisma, subs);
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subs } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subs } } });
    await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.serviceJob.deleteMany({ where: { providerId: { in: providerIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { id: { in: providerIds } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });
  await app.close();
});

describe('switch off (the default): nobody is charged or gated', () => {
  it('a verified pro who never ticked is listed, bookable and never born a fee; /providers/me says no fee is required', async () => {
    expect(proWeeklyFeeEnabled()).toBe(false);
    const pro = await makePro();
    const viewer = await makeUser();
    expect(await sys(() => proFeeStanding(app.prisma, pro.userId))).toEqual({ required: false, operable: true });
    expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeNull();
    expect(await proSub(pro.providerId)).toBeNull();
    expect(await listedIds(viewer.token)).toContain(pro.providerId);
    await expect(sys(() => assertProviderCanOperate(app.prisma, { userId: pro.userId }))).resolves.toBeUndefined();
    const me = await app.inject({ method: 'GET', url: '/api/v1/services/providers/me', headers: { authorization: `Bearer ${pro.token}` } });
    expect(me.json().data).toMatchObject({ fee: { required: false, operable: true }, listed: true });
  });
});

describe('switch on: never charged without the tick', () => {
  it('a verified pro who has not ticked is not born a fee, is not listed, and takes no new work (A3)', async () => {
    on();
    const pro = await makePro();
    const viewer = await makeUser();
    expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeNull();
    expect(await proSub(pro.providerId)).toBeNull();
    expect(await sys(() => proFeeStanding(app.prisma, pro.userId))).toMatchObject({ required: true, operable: false, why: 'AGREEMENT' });
    expect(await listedIds(viewer.token)).not.toContain(pro.providerId);
    const refused = await sys(() => assertProFeeAllowsNewWork(app.prisma, pro.userId, 'customer').then(() => null, (e: unknown) => e));
    expect(refused).toMatchObject({ statusCode: 409, code: 'PROVIDER_FEE_UNPAID', message: PRO_FEE_CUSTOMER_MESSAGE });
    await expect(sys(() => assertProviderCanOperate(app.prisma, { userId: pro.userId }))).rejects.toMatchObject({ code: 'PROVIDER_FEE_UNPAID' });
    const me = await app.inject({ method: 'GET', url: '/api/v1/services/providers/me', headers: { authorization: `Bearer ${pro.token}` } });
    expect(me.json().data).toMatchObject({ fee: { required: true, operable: false, why: 'AGREEMENT' }, listed: false });
  });

  it('a ticked, verified pro whose fee is not born yet takes no new work (fail closed: no fee row is not a free pass)', async () => {
    on();
    const pro = await makePro({ agreed: true });
    expect(await proSub(pro.providerId)).toBeNull();
    expect(await sys(() => proFeeStanding(app.prisma, pro.userId))).toMatchObject({ required: true, operable: false, why: 'MISSING', source: null });
  });

  it('a pro who accepted the agreement but not "I understand the weekly fee" is not born a fee and is not listed (B3)', async () => {
    on();
    const pro = await makePro({ agreed: true, feeTick: false });
    expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeNull();
    expect(await sys(() => proFeeStanding(app.prisma, pro.userId))).toMatchObject({ required: true, operable: false, why: 'FEE_TERMS' });
    await tickFee(pro.userId);
    expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeTruthy();
  });

  it('the fee tick is refused for other words or another amount, and writes nothing', async () => {
    const pro = await makePro();
    const quote = await sys(() => proFeeQuote(app.prisma, pro.userId));
    expect(quote.amount).toBe(8000);
    await expect(sys(() => recordProFeeAck(app.prisma, { userId: pro.userId, ack: { version: 'v0', amount: quote.amount, currencyCode: quote.currencyCode }, surface: 'mobile' })))
      .rejects.toMatchObject({ code: 'WEEKLY_FEE_TERMS_CHANGED' });
    await expect(sys(() => recordProFeeAck(app.prisma, { userId: pro.userId, ack: { version: WEEKLY_FEE_ACK_VERSION, amount: 1, currencyCode: quote.currencyCode }, surface: 'mobile' })))
      .rejects.toMatchObject({ code: 'WEEKLY_FEE_CHANGED' });
    expect(await sys(() => app.prisma.consentRecord.count({ where: { subjectId: pro.userId, documentType: 'weekly_fee_acknowledgement' } }))).toBe(0);
  });

  it('a pro who ticked but whose documents are not approved is not born a fee', async () => {
    on();
    const pro = await makePro({ verified: false, agreed: true });
    expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeNull();
    expect(await proSub(pro.providerId)).toBeNull();
  });
});

describe('switch on: the fee is born once, on the services rate, with the 14-day trial (A1/A2)', () => {
  it('verified + ticked: born INDEPENDENT_PRO in TRIAL for 14 days, owned by the pro; listed and operable; idempotent', async () => {
    on();
    const pro = await makePro({ agreed: true });
    const viewer = await makeUser();
    const before = Date.now();
    const id = await ensureProFeeBorn(app.prisma, pro.userId);
    expect(id).toBeTruthy();
    const sub = (await proSub(pro.providerId))!;
    expect(sub).toMatchObject({ id, type: 'INDEPENDENT_PRO', status: 'TRIAL', isTrialActive: true, vendorId: null, riderId: null, driverId: null });
    expect(Number(sub.weeklyRate)).toBe(8000);
    expect(sub.trialEndDate!.getTime() - before).toBeGreaterThanOrEqual(14 * DAY - 60_000);
    expect(sub.trialEndDate!.getTime() - before).toBeLessThanOrEqual(14 * DAY + 60_000);
    expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBe(id);
    expect(await sys(() => app.prisma.subscription.count({ where: { serviceProviderId: pro.providerId } }))).toBe(1);
    expect(await sys(() => proFeeStanding(app.prisma, pro.userId))).toMatchObject({ required: true, operable: true, source: 'OWN', subscriptionId: id });
    expect(await listedIds(viewer.token)).toContain(pro.providerId);
    // The trial law's own role for a pro: one trial per person as a pro, apart from a store's.
    expect(await sys(() => app.prisma.trialGrant.findMany({ where: { accountId: pro.userId }, select: { role: true } }))).toEqual([{ role: 'SERVICE_PROVIDER' }]);
  });

  it('[owner 30 Oct 00:14Z · F S3-2] ticked long before the switch: born by the hourly pass when it turns on, with a full 14-day trial from then', async () => {
    const pro = await makePro({ agreed: true }); // both ticks now, with the switch off
    expect(await birthDueProFees(app.prisma)).toEqual({ tried: 0, born: 0 });
    expect(await proSub(pro.providerId)).toBeNull();
    const ticks = await sys(() => app.prisma.consentRecord.findMany({ where: { subjectId: pro.userId }, select: { capturedAt: true } }));
    const lastTick = Math.max(...ticks.map((t) => t.capturedAt.getTime()));
    expect(ticks.length).toBeGreaterThanOrEqual(2);
    // The switch turns on 30 days later (the clock the trial reads; the ticks keep their own time).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(lastTick + 30 * DAY));
    try {
      on();
      const switchOn = Date.now();
      const pass = await birthDueProFees(app.prisma);
      expect(pass.born).toBeGreaterThanOrEqual(1);
      const sub = (await proSub(pro.providerId))!;
      expect(sub).toMatchObject({ type: 'INDEPENDENT_PRO', status: 'TRIAL', isTrialActive: true });
      // A full 14 days from the switch, never 14 days from the ticks (which would already have run out).
      expect(Math.abs(sub.trialEndDate!.getTime() - (switchOn + 14 * DAY))).toBeLessThanOrEqual(60_000);
      expect(sub.trialEndDate!.getTime() - lastTick).toBeGreaterThanOrEqual(44 * DAY - 60_000);
      // The pass is idempotent: a second run births nothing more for this pro.
      await birthDueProFees(app.prisma);
      expect(await sys(() => app.prisma.subscription.count({ where: { serviceProviderId: pro.providerId } }))).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('born by the document event (refreshProviderVerification) and by the tick (POST /auth/legal-acceptance)', async () => {
    on();
    const byDocs = await makePro({ agreed: true });
    expect(await proSub(byDocs.providerId)).toBeNull();
    await refreshProviderVerification(app.prisma, byDocs.userId);
    expect(await proSub(byDocs.providerId)).toMatchObject({ type: 'INDEPENDENT_PRO', status: 'TRIAL' });

    const byTick = await makePro({ feeTick: true });
    expect(await ensureProFeeBorn(app.prisma, byTick.userId)).toBeNull();
    const tick = await app.inject({ method: 'POST', url: '/api/v1/auth/legal-acceptance', headers: { authorization: `Bearer ${byTick.token}` }, payload: { version: LEGAL_VERSION, accept: true } });
    expect(tick.statusCode, tick.body).toBe(200);
    expect(await proSub(byTick.providerId)).toMatchObject({ type: 'INDEPENDENT_PRO', status: 'TRIAL' });
  });

  it('two births at once make one fee', async () => {
    on();
    const pro = await makePro({ agreed: true });
    const [a, b] = await Promise.all([ensureProFeeBorn(app.prisma, pro.userId), ensureProFeeBorn(app.prisma, pro.userId)]);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(await sys(() => app.prisma.subscription.count({ where: { serviceProviderId: pro.providerId } }))).toBe(1);
  });
});

describe('switch on: an unpaid fee blocks new work, never booked work (B2)', () => {
  it('suspended: hidden, no request or quote; a confirmed job still starts; paid again: listed', async () => {
    on();
    const pro = await makePro({ agreed: true });
    const customer = await makeUser();
    const id = (await ensureProFeeBorn(app.prisma, pro.userId))!;
    const booked = await sys(() => app.prisma.serviceJob.create({ data: {
      providerId: pro.providerId, customerId: customer.userId, tenantId: 'swift-default', description: 'Booked lesson', status: 'SCHEDULED',
      quoteAmount: '3000.00', scheduledFor: new Date(Date.now() - 60_000), providerConfirmedAt: new Date(Date.now() - DAY),
    } }));
    const requested = await sys(() => app.prisma.serviceJob.create({ data: {
      providerId: pro.providerId, customerId: customer.userId, tenantId: 'swift-default', description: 'New lesson', status: 'REQUESTED',
    } }));
    await sys(() => app.prisma.subscription.update({ where: { id }, data: { status: 'SUSPENDED', isTrialActive: false } }));

    expect(await listedIds(customer.token)).not.toContain(pro.providerId);
    expect(await sys(() => proFeeStanding(app.prisma, pro.userId))).toMatchObject({ operable: false, why: 'STATUS', source: 'OWN' });
    const quote = await app.inject({ method: 'POST', url: `/api/v1/services/jobs/${requested.id}/quote`, headers: { authorization: `Bearer ${pro.token}` }, payload: { amount: 5000 } });
    expect([quote.statusCode, quote.json().error?.code]).toEqual([409, 'PROVIDER_FEE_UNPAID']);
    expect(quote.json().error.message).toMatch(/Pay this week’s fee in the Swift app or on the Swift website/);
    const start = await app.inject({ method: 'POST', url: `/api/v1/services/jobs/${booked.id}/start`, headers: { authorization: `Bearer ${pro.token}` }, payload: {} });
    expect(start.statusCode, start.body).toBe(200);

    await sys(() => app.prisma.subscription.update({ where: { id }, data: { status: 'ACTIVE' } }));
    expect(await listedIds(customer.token)).toContain(pro.providerId);
  });

  it('suspended: no new request, no schedule, no confirm, no public portfolio photo', async () => {
    on();
    const pro = await makePro({ agreed: true });
    const customer = await makeUser();
    const id = (await ensureProFeeBorn(app.prisma, pro.userId))!;
    const photo = `portfolio/${pro.providerId}/work.jpg`;
    await sys(() => app.prisma.serviceProvider.update({ where: { id: pro.providerId }, data: { portfolioPhotos: [photo] } }));
    const quoted = await sys(() => app.prisma.serviceJob.create({ data: {
      providerId: pro.providerId, customerId: customer.userId, tenantId: 'swift-default', description: 'Quoted lesson', status: 'QUOTED', quoteAmount: '3000.00',
    } }));
    const toConfirm = await sys(() => app.prisma.serviceJob.create({ data: {
      providerId: pro.providerId, customerId: customer.userId, tenantId: 'swift-default', description: 'Lesson to confirm', status: 'SCHEDULED',
      quoteAmount: '3000.00', scheduledFor: new Date(Date.now() + 3 * DAY),
    } }));
    expect(await providerShowsPhoto(app, pro.providerId, 'work.jpg')).toBe(true);
    await sys(() => app.prisma.subscription.update({ where: { id }, data: { status: 'SUSPENDED', isTrialActive: false } }));

    const ask = await app.inject({ method: 'POST', url: '/api/v1/services/jobs', headers: { authorization: `Bearer ${customer.token}` }, payload: { providerId: pro.providerId, description: 'Help with maths homework' } });
    expect([ask.statusCode, ask.json().error?.code, ask.json().error?.message]).toEqual([409, 'PROVIDER_FEE_UNPAID', PRO_FEE_CUSTOMER_MESSAGE]);
    const schedule = await app.inject({ method: 'POST', url: `/api/v1/services/jobs/${quoted.id}/schedule`, headers: { authorization: `Bearer ${customer.token}` }, payload: { scheduledFor: new Date(Date.now() + 4 * DAY).toISOString() } });
    expect([schedule.statusCode, schedule.json().error?.code]).toEqual([409, 'PROVIDER_FEE_UNPAID']);
    const confirm = await app.inject({ method: 'POST', url: `/api/v1/services/jobs/${toConfirm.id}/confirm`, headers: { authorization: `Bearer ${pro.token}` }, payload: {} });
    expect([confirm.statusCode, confirm.json().error?.code]).toEqual([409, 'PROVIDER_FEE_UNPAID']);
    expect(await providerShowsPhoto(app, pro.providerId, 'work.jpg')).toBe(false);
  });
});

describe('switch on: one fee for a Services-store owner who is also a pro (B1)', () => {
  it('while the store fee is live no pro fee is born and the store fee decides; a suspended store fee blocks the pro too', async () => {
    on();
    const pro = await makePro({ agreed: true });
    const storeSub = await servicesStoreFor(pro.userId);
    expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeNull();
    expect(await proSub(pro.providerId)).toBeNull();
    expect(await sys(() => proFeeStanding(app.prisma, pro.userId))).toMatchObject({ operable: true, source: 'STORE', subscriptionId: storeSub });
    await sys(() => app.prisma.subscription.update({ where: { id: storeSub }, data: { status: 'SUSPENDED' } }));
    expect(await sys(() => proFeeStanding(app.prisma, pro.userId))).toMatchObject({ operable: false, why: 'STATUS', source: 'STORE' });
  });

  it('a store whose fee has ended does not cover the pro: their own fee is born', async () => {
    on();
    const pro = await makePro({ agreed: true });
    await servicesStoreFor(pro.userId, 'CANCELLED');
    expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeTruthy();
  });
});
