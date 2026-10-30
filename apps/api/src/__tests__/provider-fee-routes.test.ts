import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { beginRequestTenantContext, prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { runWithoutTenant } from '../plugins/tenant-context';
import { providerFeeRoutes } from '../modules/services/provider-fee.routes';
import { providerChecklist } from '../modules/services/services.service';
import { birthDueProFees, ensureProFeeBorn, PRO_FEE_ACK_PATH, proFeeQuote, recordProFeeAck } from '../modules/services/pro-fee';
import { PRO_FEE_COVERED_CODE } from '../modules/services/provider-fee.routes';
import { WEEKLY_FEE_ACK_TEXT_V1, WEEKLY_FEE_ACK_TYPE, WEEKLY_FEE_ACK_VERSION } from '../modules/partner/weekly-fee-ack';
import { publishLegalDocumentOnce, recordConsent } from '../modules/legal/consent.service';
import { recordReacceptance } from '../modules/legal/reaccept';
import { NotificationService } from '../modules/notification/notification.service';
import { PROVIDER_FEE_KINDS, providerFeeNotice } from '../modules/notification/provider-fee-kinds';
import { mmgPayLine } from '../modules/billing/fee-notice-copy';
import { sweepTrialFeeEducation } from '../modules/billing/trial-fee-education';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [BILL-PRO PR4 · owner A4 · plan G13/G14] A pro's own weekly fee: /api/v1/provider/subscription (and its MMG checkout
// and card routes) for the pro's OWN subscription only, and the pro's fee notices under kinds no shipped phone build
// routes to a store's or a mover's fee screen, naming the app and the website as places to pay.
// Synthetic data only.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
const providerIds: string[] = [];
const vendorIds: string[] = [];
const DAY = 86_400_000;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-provider-fee-routes');
const on = () => { process.env['PRO_WEEKLY_FEE'] = '1'; };

async function makeUser() {
  return sys(async () => {
    const user = await app.prisma.user.create({ data: {
      phone: testPhone(), firstName: 'Pro', lastName: `Pay${nanoid(4)}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
    } });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'pro-pay', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    return { userId: user.id, token };
  });
}

async function makePro(opts: { agreed?: boolean } = {}) {
  const u = await makeUser();
  const provider = await sys(() => app.prisma.serviceProvider.create({ data: { userId: u.userId, trade: 'tutor', isVerified: true } }));
  providerIds.push(provider.id);
  for (const docType of await sys(() => providerChecklist(app.prisma, u.userId))) {
    await sys(() => app.prisma.verificationDocument.create({
      data: { userId: u.userId, role: 'CUSTOMER', docType, fileUrl: `storage://t/${docType}.jpg`, status: 'APPROVED', consentAt: new Date(), privacyNoticeVersion: 'v1' },
    }));
  }
  if (opts.agreed) {
    await sys(() => recordReacceptance(app.prisma, { userId: u.userId, roles: ['CUSTOMER'], hadAccepted: false, surface: 'mobile' }));
    const quote = await sys(() => proFeeQuote(app.prisma, u.userId));
    await sys(() => recordProFeeAck(app.prisma, { userId: u.userId, ack: { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: quote.currencyCode }, surface: 'mobile' }));
  }
  return { ...u, providerId: provider.id };
}

const get = (token: string, url: string) => app.inject({ method: 'GET', url: `/api/v1/provider${url}`, headers: { authorization: `Bearer ${token}` } });
const post = (token: string, url: string, payload: Record<string, unknown> = {}) => app.inject({ method: 'POST', url: `/api/v1/provider${url}`, headers: { authorization: `Bearer ${token}` }, payload });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(providerFeeRoutes, { prefix: '/api/v1/provider' });
  await app.ready();
});

afterEach(() => { delete process.env['PRO_WEEKLY_FEE']; });

afterAll(async () => {
  await sys(async () => {
    const subs = (await app.prisma.subscription.findMany({ where: { OR: [{ serviceProviderId: { in: providerIds } }, { vendorId: { in: vendorIds } }] }, select: { id: true } })).map((s) => s.id);
    await cleanupBillingClocks(app.prisma, subs);
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subs } } });
    await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subs } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subs } } });
    await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: userIds } } }).catch(() => {});
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.serviceProvider.deleteMany({ where: { id: { in: providerIds } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });
  await app.close();
});

describe('GET /api/v1/provider/subscription — the pro\'s own fee', () => {
  it('is 404 for a person with no provider profile', async () => {
    const someone = await makeUser();
    const res = await get(someone.token, '/subscription');
    expect(res.statusCode).toBe(404);
  });

  it('switch off: no fee and none required', async () => {
    const pro = await makePro();
    const res = await get(pro.token, '/subscription');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ data: null, standing: { required: false, operable: true }, coveredBy: null });
  });

  it('switch on, born: the pro\'s own INDEPENDENT_PRO fee with how to pay, where it stands and the standing', async () => {
    on();
    const pro = await makePro({ agreed: true });
    const id = await ensureProFeeBorn(app.prisma, pro.userId);
    const res = await get(pro.token, '/subscription');
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.data).toMatchObject({ id, type: 'INDEPENDENT_PRO', serviceProviderId: pro.providerId, status: 'TRIAL', isActive: true });
    expect(body.data).toHaveProperty('payActions');
    expect(body.data).toHaveProperty('feeStatus');
    expect(body.data).toHaveProperty('feeReceipts');
    expect(body.standing).toMatchObject({ required: true, operable: true, source: 'OWN', subscriptionId: id });
    expect(body.coveredBy).toBeNull();
  });

  it('a pro covered by their own Services store\'s fee has no pro fee here and is told so', async () => {
    on();
    const pro = await makePro({ agreed: true });
    await sys(async () => {
      const owner = await app.prisma.vendorOwner.create({ data: { userId: pro.userId } });
      const vendor = await app.prisma.vendor.create({ data: {
        ownerId: owner.id, name: `Pro Pay Store ${wordFreeTag(8)}`, slug: `pro-pay-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
        phone: '+5920000576', addressLine1: '1 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
      } });
      vendorIds.push(vendor.id);
      await app.prisma.subscription.create({ data: {
        vendorId: vendor.id, type: 'SERVICE_PROVIDER', weeklyRate: 8000, status: 'ACTIVE', currencyCode: 'GYD',
        currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 6 * DAY), nextBillingDate: new Date(Date.now() + 6 * DAY),
      } });
    });
    expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeNull();
    const res = await get(pro.token, '/subscription');
    expect(res.json()).toMatchObject({ data: null, standing: { operable: true, source: 'STORE' }, coveredBy: 'STORE' });
  });
});

describe('POST /api/v1/provider/weekly-fee-ack — "I understand the weekly fee" (owner B3)', () => {
  it('GET shows the words and the amount to tick; a wrong version or amount writes nothing; the tick (with the agreement) makes the fee due', async () => {
    on();
    const pro = await makePro();
    await sys(() => recordReacceptance(app.prisma, { userId: pro.userId, roles: ['CUSTOMER'], hadAccepted: false, surface: 'mobile' }));
    const before = (await get(pro.token, '/subscription')).json();
    expect(before).toMatchObject({ data: null, standing: { operable: false, why: 'FEE_TERMS' }, feeTerms: { version: WEEKLY_FEE_ACK_VERSION, amount: 8000, currencyCode: 'GYD', acknowledged: false, tick: 'I understand the weekly fee.' } });
    const stale = await post(pro.token, '/weekly-fee-ack', { version: 'v0', amount: 8000, currencyCode: 'GYD' });
    expect([stale.statusCode, stale.json().error?.code]).toEqual([409, 'WEEKLY_FEE_TERMS_CHANGED']);
    const wrong = await post(pro.token, '/weekly-fee-ack', { version: WEEKLY_FEE_ACK_VERSION, amount: 5000, currencyCode: 'GYD' });
    expect([wrong.statusCode, wrong.json().error?.code]).toEqual([409, 'WEEKLY_FEE_CHANGED']);
    const ok = await post(pro.token, '/weekly-fee-ack', { version: WEEKLY_FEE_ACK_VERSION, amount: 8000, currencyCode: 'GYD' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data).toMatchObject({ acknowledged: true, standing: { operable: true, source: 'OWN' } });
    const after = (await get(pro.token, '/subscription')).json();
    expect(after).toMatchObject({ data: { type: 'INDEPENDENT_PRO', status: 'TRIAL' }, feeTerms: { acknowledged: true } });
    const rows = await sys(() => app.prisma.consentRecord.findMany({ where: { subjectId: pro.userId, documentType: 'weekly_fee_acknowledgement' }, select: { evidence: true } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.evidence).toMatchObject({ path: 'provider/weekly-fee-ack', kind: 'PROVIDER', weeklyFee: { amount: 8000, currencyCode: 'GYD' } });
  });
});

describe('[REVIEW-G #2230 S3-1 · owner B3] a fee tick is consent to ONE amount: the fee is born only at the amount ticked', () => {
  const setServicesRate = async (rate: number | null, saved: unknown) => sys(() => app.prisma.countryConfig.update({
    where: { code: 'GY' }, data: { subscriptionTiers: (rate === null ? saved : { ...(saved as object), serviceVendor: rate }) as never },
  }));

  it('ticked at 8,000 with the switch off; the rate becomes 9,000; switch on: not born, asked again at 9,000; the re-tick at 9,000 is recorded and births at 9,000', async () => {
    const saved = (await sys(() => app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } }))).subscriptionTiers;
    try {
      const pro = await makePro();
      await sys(() => recordReacceptance(app.prisma, { userId: pro.userId, roles: ['CUSTOMER'], hadAccepted: false, surface: 'mobile' }));
      // Switch off: the tick is recorded (at the amount shown then), nothing is born.
      const first = await post(pro.token, '/weekly-fee-ack', { version: WEEKLY_FEE_ACK_VERSION, amount: 8000, currencyCode: 'GYD' });
      expect(first.statusCode, first.body).toBe(200);
      await setServicesRate(9000, saved);
      on();
      // Not born at an amount never ticked: by the tick's own birth, the hourly switch-on pass, or the activation itself.
      expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeNull();
      await sys(() => birthDueProFees(app.prisma));
      expect(await sys(() => app.prisma.subscription.findUnique({ where: { serviceProviderId: pro.providerId } }))).toBeNull();
      // GET asks again, naming the new amount and the one they ticked.
      const asked = (await get(pro.token, '/subscription')).json();
      expect(asked).toMatchObject({
        data: null, standing: { required: true, operable: false, why: 'FEE_TERMS' },
        feeTerms: { amount: 9000, currencyCode: 'GYD', acknowledged: false, acknowledgedAmount: 8000, acknowledgedCurrencyCode: 'GYD', changed: true },
      });
      // The old amount is refused now; the new one is a new consent (never swallowed as "already ticked").
      const stale = await post(pro.token, '/weekly-fee-ack', { version: WEEKLY_FEE_ACK_VERSION, amount: 8000, currencyCode: 'GYD' });
      expect([stale.statusCode, stale.json().error?.code]).toEqual([409, 'WEEKLY_FEE_CHANGED']);
      const again = await post(pro.token, '/weekly-fee-ack', { version: WEEKLY_FEE_ACK_VERSION, amount: 9000, currencyCode: 'GYD' });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().data).toMatchObject({ acknowledged: true, standing: { operable: true, source: 'OWN' } });
      const born = await sys(() => app.prisma.subscription.findUniqueOrThrow({ where: { serviceProviderId: pro.providerId } }));
      expect([Number(born.weeklyRate), born.currencyCode, born.status]).toEqual([9000, 'GYD', 'TRIAL']);
      const ticks = await sys(() => app.prisma.consentRecord.findMany({ where: { subjectId: pro.userId, documentType: 'weekly_fee_acknowledgement' }, orderBy: { capturedAt: 'asc' }, select: { evidence: true } }));
      expect(ticks.map((t) => (t.evidence as { weeklyFee: { amount: number } }).weeklyFee.amount)).toEqual([8000, 9000]);
      // The same amount again writes nothing more.
      expect((await post(pro.token, '/weekly-fee-ack', { version: WEEKLY_FEE_ACK_VERSION, amount: 9000, currencyCode: 'GYD' })).statusCode).toBe(200);
      expect(await sys(() => app.prisma.consentRecord.count({ where: { subjectId: pro.userId, documentType: 'weekly_fee_acknowledgement' } }))).toBe(2);
      expect((await get(pro.token, '/subscription')).json().feeTerms).toMatchObject({ acknowledged: true, acknowledgedAmount: 9000, changed: false });
      // Once born, the tick that bore it holds: a later services-rate change never unlists a pro with a fee (a born
      // fee's own price changes follow the told-in-advance fee-rise rules).
      await setServicesRate(10000, saved);
      expect((await get(pro.token, '/subscription')).json()).toMatchObject({ standing: { operable: true, source: 'OWN' }, feeTerms: { acknowledged: true } });
    } finally {
      await setServicesRate(null, saved);
    }
  });

  it('[REVIEW-G #2230 bd1e46f3 NEW S3-1 · owner B1] a pro their own Services store\'s fee covers stays listed when the services rate changes; when the cover ends nothing is born until a tick at the new rate', async () => {
    const saved = (await sys(() => app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } }))).subscriptionTiers;
    try {
      on();
      const pro = await makePro({ agreed: true });
      const storeFee = await sys(async () => {
        const owner = await app.prisma.vendorOwner.create({ data: { userId: pro.userId } });
        const vendor = await app.prisma.vendor.create({ data: {
          ownerId: owner.id, name: `Pro Rate Store ${wordFreeTag(8)}`, slug: `pro-rate-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
          phone: '+5920000578', addressLine1: '1 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
        } });
        vendorIds.push(vendor.id);
        return app.prisma.subscription.create({ data: {
          vendorId: vendor.id, type: 'SERVICE_PROVIDER', weeklyRate: 8000, status: 'ACTIVE', currencyCode: 'GYD',
          currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 6 * DAY), nextBillingDate: new Date(Date.now() + 6 * DAY),
        } });
      });
      expect((await get(pro.token, '/subscription')).json()).toMatchObject({ standing: { operable: true, source: 'STORE' }, coveredBy: 'STORE' });
      // The services rate changes while the store's fee covers them: still listed (the fee they pay is the store's).
      await setServicesRate(9000, saved);
      const covered = (await get(pro.token, '/subscription')).json();
      expect(covered).toMatchObject({
        data: null, coveredBy: 'STORE', standing: { required: true, operable: true, why: null, source: 'STORE', subscriptionId: storeFee.id },
        feeTerms: { amount: 9000, acknowledged: true, acknowledgedAmount: 8000, changed: false },
      });
      expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeNull();
      // The cover ends: their own fee is not born at an amount never ticked; they are asked again at 9,000.
      await sys(() => app.prisma.subscription.update({ where: { id: storeFee.id }, data: { status: 'CANCELLED' } }));
      expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeNull();
      await sys(() => birthDueProFees(app.prisma));
      expect(await sys(() => app.prisma.subscription.findUnique({ where: { serviceProviderId: pro.providerId } }))).toBeNull();
      expect((await get(pro.token, '/subscription')).json()).toMatchObject({
        data: null, coveredBy: null, standing: { operable: false, why: 'FEE_TERMS', source: null },
        feeTerms: { amount: 9000, acknowledged: false, acknowledgedAmount: 8000, changed: true },
      });
      const again = await post(pro.token, '/weekly-fee-ack', { version: WEEKLY_FEE_ACK_VERSION, amount: 9000, currencyCode: 'GYD' });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().data).toMatchObject({ acknowledged: true, standing: { operable: true, source: 'OWN' } });
      const born = await sys(() => app.prisma.subscription.findUniqueOrThrow({ where: { serviceProviderId: pro.providerId } }));
      expect([Number(born.weeklyRate), born.currencyCode, born.status]).toEqual([9000, 'GYD', 'TRIAL']);
    } finally {
      await setServicesRate(null, saved);
    }
  });

  it('[REVIEW-G #2230 S4 G5] a tick holds only for the same CURRENCY too: the same number in another currency is not consent to this fee', async () => {
    on();
    const pro = await makePro();
    await sys(() => recordReacceptance(app.prisma, { userId: pro.userId, roles: ['CUSTOMER'], hadAccepted: false, surface: 'mobile' }));
    const quote = await sys(() => proFeeQuote(app.prisma, pro.userId));
    expect(quote.currencyCode).toBe('GYD');
    await sys(async () => {
      await publishLegalDocumentOnce(app.prisma, { documentType: WEEKLY_FEE_ACK_TYPE, version: WEEKLY_FEE_ACK_VERSION, renderedText: WEEKLY_FEE_ACK_TEXT_V1 });
      await app.prisma.$transaction((tx) => recordConsent(tx, {
        subjectType: 'vendor_user', subjectId: pro.userId, documentType: WEEKLY_FEE_ACK_TYPE, version: WEEKLY_FEE_ACK_VERSION,
        action: 'granted', surface: 'mobile', ip: null,
        evidence: { control: 'weekly_fee_checkbox', path: PRO_FEE_ACK_PATH, kind: 'PROVIDER', weeklyFee: { amount: quote.amount, currencyCode: 'USD', tier: quote.tier } },
      }));
    });
    expect(await ensureProFeeBorn(app.prisma, pro.userId)).toBeNull();
    expect(await sys(() => app.prisma.subscription.findUnique({ where: { serviceProviderId: pro.providerId } }))).toBeNull();
    expect((await get(pro.token, '/subscription')).json()).toMatchObject({
      data: null, standing: { operable: false, why: 'FEE_TERMS' },
      feeTerms: { amount: quote.amount, currencyCode: 'GYD', acknowledged: false, acknowledgedAmount: quote.amount, acknowledgedCurrencyCode: 'USD', changed: true },
    });
    // The tick in the fee's own currency is a new consent, written, and births the fee.
    const ok = await post(pro.token, '/weekly-fee-ack', { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: 'GYD' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().data).toMatchObject({ acknowledged: true, standing: { operable: true, source: 'OWN' } });
    expect(await sys(() => app.prisma.consentRecord.count({ where: { subjectId: pro.userId, documentType: WEEKLY_FEE_ACK_TYPE } }))).toBe(2);
  });

  it('[REVIEW-F #2231 S3-3 · REVIEW-G #2230 N2] a pro their Services store\'s fee covers is told so before any tick, and cannot "resume" a fee of their own', async () => {
    on();
    const pro = await makePro();
    await sys(() => recordReacceptance(app.prisma, { userId: pro.userId, roles: ['CUSTOMER'], hadAccepted: false, surface: 'mobile' }));
    await sys(async () => {
      const owner = await app.prisma.vendorOwner.create({ data: { userId: pro.userId } });
      const vendor = await app.prisma.vendor.create({ data: {
        ownerId: owner.id, name: `Pro Cover Store ${wordFreeTag(8)}`, slug: `pro-cover-${nanoid(8).toLowerCase()}`, vendorType: 'SERVICE',
        phone: '+5920000577', addressLine1: '1 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
      } });
      vendorIds.push(vendor.id);
      await app.prisma.subscription.create({ data: {
        vendorId: vendor.id, type: 'SERVICE_PROVIDER', weeklyRate: 8000, status: 'ACTIVE', currencyCode: 'GYD',
        currentPeriodStart: new Date(Date.now() - DAY), currentPeriodEnd: new Date(Date.now() + 6 * DAY), nextBillingDate: new Date(Date.now() + 6 * DAY),
      } });
    });
    expect((await get(pro.token, '/subscription')).json()).toMatchObject({ data: null, coveredBy: 'STORE', standing: { why: 'FEE_TERMS' }, feeTerms: { acknowledged: false, changed: false } });
    const resume = await app.inject({ method: 'PUT', url: '/api/v1/provider/subscription/billing-method', headers: { authorization: `Bearer ${pro.token}` }, payload: { method: 'CASH' } });
    expect([resume.statusCode, resume.json().error?.code]).toEqual([409, PRO_FEE_COVERED_CODE]);
    // Switch off: nothing is covered or required.
    delete process.env['PRO_WEEKLY_FEE'];
    expect((await get(pro.token, '/subscription')).json()).toMatchObject({ coveredBy: null, standing: { required: false } });
  });
});

describe('paying: only the pro\'s own fee, only on MMG\'s checkout page', () => {
  it('no fee: nothing to pay (404); a fee while MMG checkout is off: refused before any checkout is written', async () => {
    const none = await makePro();
    const noFee = await post(none.token, '/subscription/mmg-checkout');
    expect([noFee.statusCode, noFee.json().error?.code]).toEqual([404, 'SUBSCRIPTION_NOT_FOUND']);

    on();
    const pro = await makePro({ agreed: true });
    const id = (await ensureProFeeBorn(app.prisma, pro.userId))!;
    const saved = process.env['MMG_CHECKOUT_ENABLED'];
    delete process.env['MMG_CHECKOUT_ENABLED'];
    try {
      const off = await post(pro.token, '/subscription/mmg-checkout');
      expect([off.statusCode, off.json().error?.code]).toEqual([409, 'PAY_ACTION_OFF']);
    } finally {
      if (saved !== undefined) process.env['MMG_CHECKOUT_ENABLED'] = saved;
    }
    expect(await sys(() => app.prisma.mmgCheckoutIntent.count({ where: { subscriptionId: id } }))).toBe(0);
  });

  it('changing how the fee is paid (or stopping it) needs a fresh step-up', async () => {
    on();
    const pro = await makePro({ agreed: true });
    await ensureProFeeBorn(app.prisma, pro.userId);
    const res = await app.inject({ method: 'PUT', url: '/api/v1/provider/subscription/billing-method', headers: { authorization: `Bearer ${pro.token}` }, payload: { method: 'NONE' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error?.code).toMatch(/STEP_UP/);
  });
});

describe('a pro\'s fee notices (plan G14, owner A4)', () => {
  it('go out under pro kinds no shipped build routes to a store or mover fee screen; other notices are untouched', () => {
    expect(providerFeeNotice({ userId: 'u', type: 'SYSTEM_ANNOUNCEMENT', title: 't', body: 'b', audience: 'provider', data: { kind: 'billing_suspended', subscriptionId: 's' } }).data)
      .toEqual({ kind: 'provider_fee_suspended', feeKind: 'billing_suspended', feeFamily: 'provider', subscriptionId: 's' });
    expect(providerFeeNotice({ userId: 'u', type: 'SYSTEM_ANNOUNCEMENT', title: 't', body: 'b', audience: 'provider', data: { kind: 'billing_mmg_checkout' } }).data?.['kind']).toBe('provider_fee_mmg_checkout');
    expect(providerFeeNotice({ userId: 'u', type: 'SYSTEM_ANNOUNCEMENT', title: 't', body: 'b', audience: 'provider', data: { kind: 'something_new' } }).data?.['kind']).toBe('provider_fee_notice');
    const store = { userId: 'u', type: 'SYSTEM_ANNOUNCEMENT' as const, title: 't', body: 'b', audience: 'business' as const, data: { kind: 'billing_suspended' } };
    expect(providerFeeNotice(store)).toBe(store);
    for (const [from, to] of Object.entries(PROVIDER_FEE_KINDS)) {
      expect(to.kind, from).toMatch(/^provider_fee_/);
    }
  });

  it('the inbox row a pro receives carries the pro kind', async () => {
    const pro = await makeUser();
    const notifications = new NotificationService(app.prisma, app.io);
    await sys(() => notifications.send({ userId: pro.userId, type: 'SYSTEM_ANNOUNCEMENT', title: 'Weekly fee', body: 'Kept for your next weekly fee.', audience: 'provider', data: { kind: 'billing_banked', subscriptionId: 's1' } }));
    const row = await sys(() => app.prisma.notification.findFirst({ where: { userId: pro.userId }, orderBy: { createdAt: 'desc' } }));
    expect(row?.data).toMatchObject({ kind: 'provider_fee_banked', feeKind: 'billing_banked', audience: 'provider' });
  });

  it('a fee demand (the trial notice) keeps its kind in the ledger and reaches the pro under the pro kind, naming the app and the website', async () => {
    on();
    const pro = await makePro({ agreed: true });
    const id = (await ensureProFeeBorn(app.prisma, pro.userId))!;
    const end = new Date(Date.now() + 3.5 * DAY);
    await sys(() => app.prisma.subscription.update({ where: { id }, data: { trialEndDate: end, currentPeriodEnd: end, nextBillingDate: end } }));
    const before = process.env['MMG_CHECKOUT_ENABLED'];
    process.env['MMG_CHECKOUT_ENABLED'] = '1';
    try {
      const notifications = new NotificationService(app.prisma, app.io);
      await sys(() => sweepTrialFeeEducation(app.prisma, notifications));
    } finally {
      if (before === undefined) delete process.env['MMG_CHECKOUT_ENABLED'];
      else process.env['MMG_CHECKOUT_ENABLED'] = before;
    }
    const ledger = await sys(() => app.prisma.billingFeeNotice.findMany({ where: { subscriptionId: id }, select: { payload: true } }));
    expect(ledger.map((n) => (n.payload as { data: { kind: string } }).data.kind)).toEqual(['trial_fee_education']);
    const row = await sys(() => app.prisma.notification.findFirst({ where: { userId: pro.userId }, orderBy: { createdAt: 'desc' } }));
    expect(row?.data).toMatchObject({ kind: 'provider_fee_trial', feeKind: 'trial_fee_education', audience: 'provider', feeFamily: 'provider' });
    expect(row?.body).toContain('with MMG in the Swift app or on the Swift website.');
  });

  it('the pay sentence names the app and the website for a pro, the app alone for anyone else', () => {
    expect(mmgPayLine(8000, { alsoWebsite: true })).toBe('Pay GY$8,000 with MMG in the Swift app or on the Swift website.');
    expect(mmgPayLine(8000)).toBe('Pay GY$8,000 with MMG in the Swift app.');
  });
});
