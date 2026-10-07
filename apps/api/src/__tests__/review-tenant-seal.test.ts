/**
 * [REVIEW-PARTNER · Sol re-review] The store-review fiction is SEALED at the shared seams,
 * not route by route:
 *   1. outbound: every SMS, push and email the channels hand out is suppressed when the
 *      send is the fiction's (declared subject, a reviewer's request, or a demo destination);
 *      admin pages and ops alerts about a REVIEW tenant page no real operator; SOS from a
 *      demo account is answered with a demo-only message and writes/pages nothing;
 *   2. money commands: a REVIEW-owned notice is never delivered (retry sweep included) and a
 *      REVIEW link is never applied — the executor skips it before any write;
 *   3. role grants: refused inside the provisioning, vehicle-change, advertiser, store-staff and
 *      service-provider authorities, so every entry point inherits the refusal;
 *   4. fees: no subscription is ever born for the fiction, and billing-rail changes refuse it.
 * Production subjects keep sending and keep being billed exactly as before.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { beginRequestTenantContext, runWithoutTenant, runWithTenant } from '../plugins/tenant-context';
import { safetyRoutes } from '../modules/safety/safety.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { adsRoutes } from '../modules/ads/ads.routes';
import { decideStaffInvite, deliverStaffInvite } from '../modules/vendor/staff-invites';
import { provisionReviewTenant } from '../modules/review/provision';
import { seedReviewContentPack, planReviewContentPack } from '../modules/review/content-pack';
import { sealReviewChannels, sendOnBehalfOf, resetReviewSealCache } from '../providers/notifications/review-seal';
import type { NotificationChannels } from '../providers/notifications/channels';
import { devChannelLog } from '../providers/notifications/channels';
import { notifyAdmins, NotificationService } from '../modules/notification/notification.service';
import { openOpsAlert } from '../modules/safety/ops-alert';
import { deliverPendingMoneySurfaceNotices, applyDueMmgLinkChanges } from '../modules/integrity/money-surface';
import { PartnerService } from '../modules/partner/partner.service';
import { AdvertiserService } from '../modules/ads/advertiser.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { BillingService } from '../modules/billing/billing.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { REVIEW_DEMO_NO_SOS, REVIEW_DEMO_NO_SOS_MESSAGE, REVIEW_DEMO_NO_NEW_ROLES, REVIEW_DEMO_NO_MONEY } from '../modules/review/demo-policy';

/** Advertising is closed at launch (ADS_ENABLED); the demo's own refusal sits
 *  behind that switch, so it is graded with advertising switched on. */
async function withAdsOn<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env['ADS_ENABLED'];
  process.env['ADS_ENABLED'] = '1';
  try { return await fn(); } finally {
    if (prior === undefined) delete process.env['ADS_ENABLED']; else process.env['ADS_ENABLED'] = prior;
  }
}
import { grantStepUp } from './helpers/step-up';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0').toLowerCase();
const REVIEW = `review-seal-${RUN}`;
const PRODUCTION = 'swift-default';
const DAY = 86_400_000;
/** Phones: +59200065 + 4 digits (a block no other suite uses). */
const base = `+59200065${String(Math.floor(Math.random() * 90) + 10)}`;
const CONTACT = `${base}91`; // a real-looking emergency contact a reviewer might type (no account)

let app: FastifyInstance;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'review-seal-test');
const ids = { customer: '', rider: '', riderId: '', driver: '', admin: '', prodUser: '', prodOwner: '', prodVendor: '', reviewVendor: '' };
const tokens = { customer: '', rider: '', prodOwner: '' };
const created: string[] = [];
const smsCount = (to: string) => devChannelLog.filter((e) => e.channel === 'sms' && e.to === to).length;

async function bearer(userId: string, role: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `seal-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return token;
}
const call = (method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` }, ...(payload !== undefined ? { payload: payload as never } : {}) });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(safetyRoutes, { prefix: '/api/v1/safety' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(adsRoutes, { prefix: '/api/v1/ads' });
  await app.ready();

  const provisioned = await system(() => provisionReviewTenant(app.prisma, { slug: REVIEW, phonePrefix: `${base.slice(0, -2)}0` }));
  await system(() => seedReviewContentPack(app.prisma, { slug: REVIEW }));
  await system(async () => {
    const byRole = (role: string) => app.prisma.user.findUniqueOrThrow({ where: { phone: provisioned.credentials.find((c) => c.role === role)!.identifier }, select: { id: true } });
    ids.customer = (await byRole('CUSTOMER')).id;
    ids.rider = (await byRole('RIDER')).id;
    ids.driver = (await byRole('DRIVER')).id;
    ids.riderId = (await app.prisma.rider.findUniqueOrThrow({ where: { userId: ids.rider } })).id;
    ids.reviewVendor = planReviewContentPack(REVIEW).vendors[0]!.id;
    // A real platform operator who must never be paged by the fiction, and a production store owner.
    ids.admin = (await app.prisma.user.create({ data: { phone: `${base}81`, firstName: 'Real', lastName: 'Operator', roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', tenantId: PRODUCTION, status: 'ACTIVE' } })).id;
    ids.prodUser = (await app.prisma.user.create({ data: { phone: `${base}82`, firstName: 'Real', lastName: 'Person', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', tenantId: PRODUCTION } })).id;
    ids.prodOwner = (await app.prisma.user.create({ data: { phone: `${base}83`, firstName: 'Real', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', tenantId: PRODUCTION } })).id;
    created.push(ids.admin, ids.prodUser, ids.prodOwner);
    const vo = await app.prisma.vendorOwner.create({ data: { userId: ids.prodOwner } });
    ids.prodVendor = (await app.prisma.vendor.create({ data: {
      ownerId: vo.id, tenantId: PRODUCTION, name: `Real Store ${RUN}`, slug: `real-store-seal-${RUN}`, vendorType: 'STORE', phone: `${base}84`,
      addressLine1: '1 Real Road', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
    } })).id;
    tokens.customer = await bearer(ids.customer, 'CUSTOMER');
    tokens.rider = await bearer(ids.rider, 'RIDER');
    tokens.prodOwner = await bearer(ids.prodOwner, 'VENDOR_OWNER');
  });
});

afterAll(async () => {
  await system(async () => {
    const reviewUsers = (await app.prisma.user.findMany({ where: { tenantId: REVIEW }, select: { id: true } })).map((u) => u.id);
    const everyone = [...reviewUsers, ...created];
    await app.prisma.moneySurfaceCommand.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.subscription.deleteMany({ where: { riderId: ids.riderId } });
    await app.prisma.emergencyContact.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.vendorStaff.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.advertiserMember.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.advertiser.deleteMany({ where: { createdByUserId: { in: everyone } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.deviceToken.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: everyone } } });
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: everyone } } });
    const p = planReviewContentPack(REVIEW);
    const vendorIds = [...p.vendors.map((v) => v.id), ids.prodVendor];
    await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.operatingHours.deleteMany({ where: { vendorId: { in: vendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: [...everyone, p.ownerUserId] } } });
    await app.prisma.user.deleteMany({ where: { id: { in: [...everyone, p.ownerUserId] } } });
    await app.prisma.reviewCredential.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.reviewSession.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.ratingTagDef.deleteMany({ where: { tenantId: REVIEW } });
    await app.prisma.tenant.updateMany({ where: { id: REVIEW }, data: { purgeProtected: false } });
    await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
  });
  await app.close();
});

describe('[seal 1] the channel layer: the fiction sends nothing, production sends as before', () => {
  function recording() {
    const sent: string[] = [];
    const inner: NotificationChannels = {
      sms: { sendSms: async (to) => { sent.push(`sms:${to}`); return { ref: 'x' }; } },
      push: { sendPush: async (tokens) => { sent.push(`push:${tokens.join(',')}`); return { sent: tokens.length }; } },
      email: { sendEmail: async (to) => { sent.push(`email:${to}`); return { ref: 'x' }; } },
    };
    return { sent, channels: sealReviewChannels(inner) };
  }

  it('a REVIEW subject (declared, or the bound request tenant, or a demo destination) is suppressed; a PRODUCTION one is delivered', async () => {
    resetReviewSealCache();
    const { sent, channels } = recording();
    await system(() => app.prisma.deviceToken.createMany({ data: [
      { userId: ids.rider, token: `seal-review-${RUN}`, platform: 'android' },
      { userId: ids.prodUser, token: `seal-prod-${RUN}`, platform: 'android' },
    ] }));
    // declared subject (background work on behalf of a tenant)
    await sendOnBehalfOf(REVIEW, () => channels.sms.sendSms(CONTACT, 'x'));
    await sendOnBehalfOf(PRODUCTION, () => channels.sms.sendSms(CONTACT, 'x'));
    // the request is bound to the fiction / to production
    await runWithTenant(REVIEW, () => channels.sms.sendSms(CONTACT, 'x'));
    await runWithTenant(PRODUCTION, () => channels.sms.sendSms(CONTACT, 'y'));
    // the destination is a demo account (no context at all)
    const riderPhone = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: ids.rider }, select: { phone: true } }))).phone;
    await channels.sms.sendSms(riderPhone, 'x');
    await channels.push.sendPush([`seal-review-${RUN}`], 't', 'b');
    await channels.push.sendPush([`seal-prod-${RUN}`], 't', 'b');
    await channels.sms.sendSms(`${base}82`, 'z');
    expect(sent).toEqual([`sms:${CONTACT}`, `sms:${CONTACT}`, `push:seal-prod-${RUN}`, `sms:${base}82`]);
  });
});

describe('[seal 1] operators are never paged by the fiction', () => {
  it('an admin page or an ops alert about a REVIEW tenant reaches nobody; a PRODUCTION page reaches the operator', async () => {
    const t0 = new Date();
    const notifications = new NotificationService(app.prisma, app.io);
    expect(await system(() => notifyAdmins(app.prisma, notifications, { tenantId: REVIEW, title: 'x', body: 'y', data: { kind: 'seal_probe' } }))).toBe(0);
    const ops = await system(() => openOpsAlert(app.prisma, notifications, { kind: 'SOS', tenantId: REVIEW, title: 'x', body: 'y', data: {} }));
    expect(ops).toEqual({ opsAlertId: '', recipients: 0, delivered: 0, oncallTexted: 0 });
    expect(await system(() => app.prisma.notification.count({ where: { userId: ids.admin, createdAt: { gte: t0 } } }))).toBe(0);
    expect(await system(() => app.prisma.opsAlert.count({ where: { tenantId: REVIEW } }))).toBe(0);
    expect(await system(() => notifyAdmins(app.prisma, notifications, { tenantId: PRODUCTION, title: 'x', body: 'y', data: { kind: 'seal_probe' } }))).toBeGreaterThan(0);
    expect(await system(() => app.prisma.notification.count({ where: { userId: ids.admin, createdAt: { gte: t0 } } }))).toBe(1);
  });
});

describe('[seal 1] safety: SOS and emergency contacts from a demo account page and text nobody', () => {
  it('SOS (and its confirm) answers with the demo-only message; no alert, no ops page, no SMS', async () => {
    const t0 = new Date();
    const res = await call('POST', '/api/v1/safety/sos', tokens.customer, { lat: 6.8, lng: -58.15 });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toEqual({ code: REVIEW_DEMO_NO_SOS, message: REVIEW_DEMO_NO_SOS_MESSAGE });
    const confirm = await call('POST', '/api/v1/safety/sos/no-such-alert/confirm', tokens.customer);
    expect(confirm.statusCode).toBe(404);
    await system(async () => {
      expect(await app.prisma.sosAlert.count({ where: { actorUserId: ids.customer } })).toBe(0);
      expect(await app.prisma.opsAlert.count({ where: { createdAt: { gte: t0 } } })).toBe(0);
      expect(await app.prisma.notification.count({ where: { userId: ids.admin, createdAt: { gte: t0 } } })).toBe(0);
    });
  });

  it('adding an emergency contact and resending its code text the contact nothing', async () => {
    const before = smsCount(CONTACT);
    const add = await call('POST', '/api/v1/safety/emergency-contacts', tokens.customer, { name: 'Demo Contact', phoneE164: CONTACT });
    expect(add.statusCode, add.body).toBe(200);
    const resend = await call('POST', `/api/v1/safety/emergency-contacts/${add.json().data.id}/resend`, tokens.customer);
    expect([200, 429]).toContain(resend.statusCode);
    expect(smsCount(CONTACT)).toBe(before);
  });
});

describe('[seal 2] money commands of the fiction are never delivered or applied', () => {
  it('a REVIEW-owned notice committed earlier is retired by the sweep without a notification or SMS; a REVIEW link is skipped with no write', async () => {
    const now = new Date();
    await system(async () => {
      await app.prisma.moneySurfaceCommand.create({ data: {
        actor: 'VENDOR', entityId: ids.reviewVendor, userId: ids.customer, kind: 'MMG_LINK_STAGE', state: 'DECIDED', generation: 1,
        oldDigest: 'none', newDigest: 'x', decisionId: `seal-${RUN}`, stepUpBinding: 'x', signals: [] as never,
        applyAt: new Date(now.getTime() - DAY), noticeKind: 'mmg_link_change_staged', noticePayload: { title: 't', body: 'b', sms: 's' } as never,
        createdAt: new Date(now.getTime() - 60_000),
      } });
      await app.prisma.vendor.update({ where: { id: ids.reviewVendor }, data: { mmgPayUrlPending: 'https://mmg.example/pay/legacy', mmgPayUrlPendingAt: new Date(now.getTime() - 2 * DAY), mmgPayUrlApplyAt: new Date(now.getTime() - DAY) } });
    });
    const customerPhone = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: ids.customer }, select: { phone: true } }))).phone;
    const smsBefore = smsCount(customerPhone);
    const deps = { prisma: app.prisma, io: app.io };
    const sweep = await system(() => deliverPendingMoneySurfaceNotices(deps, now));
    expect(sweep.delivered).toBe(0);
    await system(() => applyDueMmgLinkChanges(deps, now));
    await system(async () => {
      const cmd = await app.prisma.moneySurfaceCommand.findFirstOrThrow({ where: { entityId: ids.reviewVendor } });
      expect([cmd.noticeSentAt, cmd.noticeLastError, cmd.state, cmd.leasedUntil]).toEqual([null, 'review-tenant send suppressed', 'DECIDED', null]);
      expect(await app.prisma.notification.count({ where: { userId: ids.customer } })).toBe(0);
      const v = await app.prisma.vendor.findUniqueOrThrow({ where: { id: ids.reviewVendor } });
      expect(v.mmgPayUrl).toBeNull();
      // A second sweep does not pick it up again.
      expect((await deliverPendingMoneySurfaceNotices(deps, now)).pending).toBe(0);
      await app.prisma.vendor.update({ where: { id: ids.reviewVendor }, data: { mmgPayUrlPending: null, mmgPayUrlPendingAt: null, mmgPayUrlApplyAt: null } });
    });
    expect(smsCount(customerPhone)).toBe(smsBefore);
  });
});

describe('[seal 3] role grants: refused inside every authority', () => {
  it('provisioning (rider, driver, store), vehicle change and advertiser registration refuse a demo account at the service', async () => {
    const partners = new PartnerService(app.prisma);
    const before = await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: ids.customer }, select: { roles: true } }));
    for (const input of [
      { role: 'MOVER' as const, vehicleType: 'MOTORCYCLE' as const },
      { role: 'MOVER' as const, vehicleType: 'CAR' as const, vehicle: { make: 'Demo', model: 'Car', year: 2020, color: 'Blue', licensePlate: 'H DEMO 7' } },
      { role: 'VENDOR' as const, business: { name: 'Demo Grow', vendorType: 'STORE' as const, phone: '+5920009399', addressLine1: '1 Demo Way', city: 'Georgetown', latitude: 6.8, longitude: -58.15 } },
    ]) {
      await expect(system(() => partners.becomePartner(ids.customer, input))).rejects.toMatchObject({ code: REVIEW_DEMO_NO_NEW_ROLES });
    }
    await expect(system(() => partners.changeVehicleWithAuthority(ids.rider, { vehicleType: 'BICYCLE' }, async () => null))).rejects.toMatchObject({ code: REVIEW_DEMO_NO_NEW_ROLES });
    await expect(system(() => new AdvertiserService(app.prisma, app.io).register(ids.customer, {
      companyName: `Demo Ads ${RUN}`, industry: 'Retail', contactName: 'Demo', contactEmail: 'demo@example.com', contactPhone: '+5926001234',
    } as never))).rejects.toMatchObject({ code: REVIEW_DEMO_NO_NEW_ROLES });
    await system(async () => {
      expect(await app.prisma.user.findUniqueOrThrow({ where: { id: ids.customer }, select: { roles: true } })).toEqual(before);
      expect(await app.prisma.vendorOwner.count({ where: { userId: ids.customer } })).toBe(0);
      expect(await app.prisma.driver.count({ where: { userId: ids.customer } })).toBe(0);
      expect(await app.prisma.rider.count({ where: { userId: ids.customer } })).toBe(0);
      expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: ids.riderId } })).vehicleType).toBe('MOTORCYCLE');
      expect(await app.prisma.advertiser.count({ where: { createdByUserId: ids.customer } })).toBe(0);
    });
  });

  it('a store membership is never granted to a demo account, even by a real store owner; an advertiser membership neither', async () => {
    const customerPhone = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: ids.customer }, select: { phone: true } }))).phone;
    // The production owner's request cannot see the demo account at all (tenant wall). [Row 55] It
    // gets the one reply every number gets (the same as a number with no account), never a grant.
    await grantStepUp(app, tokens.prodOwner);
    const staff = await call('POST', '/api/v1/vendor/staff', tokens.prodOwner, { phone: customerPhone, role: 'STAFF' });
    const noAccount = await call('POST', '/api/v1/vendor/staff', tokens.prodOwner, { phone: `${base}79`, role: 'STAFF' });
    expect(staff.statusCode, staff.body).toBe(200);
    expect(staff.json()).toEqual(noAccount.json());
    // A demo store owner (state a pre-seal /partner/become could leave) cannot grant a membership.
    await system(async () => {
      await app.prisma.user.update({ where: { id: ids.customer }, data: { roles: ['CUSTOMER', 'VENDOR_OWNER'] } });
      const vo = await app.prisma.vendorOwner.findUnique({ where: { userId: ids.customer } }) ?? await app.prisma.vendorOwner.create({ data: { userId: ids.customer } });
      await app.prisma.vendor.update({ where: { id: ids.reviewVendor }, data: { ownerId: vo.id } });
    });
    await grantStepUp(app, tokens.customer);
    const riderPhone = (await system(() => app.prisma.user.findUniqueOrThrow({ where: { id: ids.rider }, select: { phone: true } }))).phone;
    const demoGrant = await app.inject({ method: 'POST', url: '/api/v1/vendor/staff', headers: { authorization: `Bearer ${tokens.customer}`, 'x-vendor-id': ids.reviewVendor }, payload: { phone: riderPhone, role: 'STAFF' } });
    expect(demoGrant.statusCode, demoGrant.body).toBe(403);
    expect(demoGrant.json().error.code).toBe(REVIEW_DEMO_NO_NEW_ROLES);
    expect(await system(() => app.prisma.vendorStaff.count({ where: { userId: { in: [ids.customer, ids.rider] } } }))).toBe(0);
    // An existing membership (planted) is never raised by a demo owner either.
    const planted = await system(() => app.prisma.vendorStaff.create({ data: { vendorId: ids.reviewVendor, userId: ids.rider, role: 'STAFF', invitedBy: ids.customer } }));
    const raise = await app.inject({ method: 'PUT', url: `/api/v1/vendor/staff/${planted.id}`, headers: { authorization: `Bearer ${tokens.customer}`, 'x-vendor-id': ids.reviewVendor }, payload: { role: 'MANAGER' } });
    expect(raise.statusCode, raise.body).toBe(403);
    expect(raise.json().error.code).toBe(REVIEW_DEMO_NO_NEW_ROLES);
    expect((await system(() => app.prisma.vendorStaff.findUniqueOrThrow({ where: { id: planted.id } }))).role).toBe('STAFF');
    await system(() => app.prisma.vendorStaff.delete({ where: { id: planted.id } }));
    // An advertiser a demo account owns (planted) grants no membership.
    const adv = await system(async () => {
      const a = await app.prisma.advertiser.create({ data: { companyName: `Demo Co ${RUN}`, industry: 'Retail', contactName: 'Demo', contactEmail: 'demo@example.com', contactPhone: '+5926001234', createdByUserId: ids.customer, tenantId: REVIEW } as never });
      await app.prisma.advertiserMember.create({ data: { advertiserId: a.id, userId: ids.customer, role: 'OWNER' } });
      return a;
    });
    const member = await withAdsOn(() => call('POST', `/api/v1/ads/advertiser/${adv.id}/members`, tokens.customer, { phone: riderPhone, role: 'MANAGER' }));
    expect(member.statusCode, member.body).toBe(403);
    expect(member.json().error.code).toBe(REVIEW_DEMO_NO_NEW_ROLES);
    expect(await system(() => app.prisma.advertiserMember.count({ where: { advertiserId: adv.id, userId: ids.rider } }))).toBe(0);
    // restore the pack store's owner
    await system(async () => {
      const packOwner = await app.prisma.vendorOwner.findUniqueOrThrow({ where: { id: planReviewContentPack(REVIEW).vendorOwnerId } });
      await app.prisma.vendor.update({ where: { id: ids.reviewVendor }, data: { ownerId: packOwner.id } });
      await app.prisma.vendorOwner.deleteMany({ where: { userId: ids.customer } });
      await app.prisma.user.update({ where: { id: ids.customer }, data: { roles: ['CUSTOMER'] } });
    });
  });

  it('[row 55] a store-team invite is never sent to a demo account, and a demo account cannot accept one', async () => {
    const send = vi.fn().mockResolvedValue('never');
    const outcome = await system(() => deliverStaffInvite(app.prisma, { publishPersisted: send }, {
      vendorId: ids.prodVendor, targetUserId: ids.rider, role: 'STAFF', inviterId: ids.prodOwner, now: new Date(),
    }));
    expect(outcome).toBe('NOT_INVITABLE');
    expect(send).not.toHaveBeenCalled();

    // An invite row planted in a demo inbox (no path writes one) still grants nothing.
    const planted = await system(() => app.prisma.notification.create({ data: {
      userId: ids.rider, type: 'SYSTEM_ANNOUNCEMENT', title: 'Team invite', body: 'planted',
      data: { kind: 'staff_invite', vendorId: ids.prodVendor, storeName: 'Real Store', role: 'STAFF', invitedBy: ids.prodOwner,
        expiresAt: new Date(Date.now() + DAY).toISOString(), state: 'PENDING' },
    } }));
    await expect(system(() => decideStaffInvite(app.prisma, { inviteId: planted.id, userId: ids.rider, decision: 'ACCEPT', now: new Date() })))
      .rejects.toMatchObject({ statusCode: 403, code: REVIEW_DEMO_NO_NEW_ROLES });
    expect(await system(() => app.prisma.vendorStaff.count({ where: { userId: ids.rider } }))).toBe(0);
    const after = await system(() => app.prisma.notification.findUniqueOrThrow({ where: { id: planted.id }, select: { data: true } }));
    expect((after.data as { state: string }).state).toBe('PENDING');
    await system(() => app.prisma.notification.delete({ where: { id: planted.id } }));
  });
});

describe('[seal 4] fees: no subscription for the fiction, and no rail to change', () => {
  it('a trial is never born for a demo partner; pricing answers nothing; billing-rail and stop-billing refuse a fiction subscription', async () => {
    const subs = new SubscriptionService(app.prisma);
    await expect(system(() => subs.startTrialForRider(ids.riderId))).rejects.toMatchObject({ code: REVIEW_DEMO_NO_MONEY });
    expect(await system(() => subs.priceForActivation({ riderId: ids.riderId }))).toBeNull();
    expect(await system(() => app.prisma.subscription.count({ where: { riderId: ids.riderId } }))).toBe(0);
    // A legacy row (planted directly) is refused by the billing authority, unchanged.
    const sub = await system(() => app.prisma.subscription.create({ data: {
      riderId: ids.riderId, type: 'DELIVERY_RIDER', weeklyRate: 1000, currencyCode: 'GYD', billingMethod: 'CASH', status: 'ACTIVE',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * DAY), nextBillingDate: new Date(Date.now() + 7 * DAY),
    } }));
    const billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
    await expect(system(() => billing.setBillingRail(sub.id, 'MOBILE_MONEY', '+5926001234'))).rejects.toMatchObject({ code: REVIEW_DEMO_NO_MONEY });
    await expect(system(() => billing.stopBilling(sub.id, ids.rider))).rejects.toMatchObject({ code: REVIEW_DEMO_NO_MONEY });
    const after = await system(() => app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } }));
    expect([after.billingMethod, after.autoRenew, after.mmgPayerMsisdn]).toEqual(['CASH', true, null]);
  });
});
