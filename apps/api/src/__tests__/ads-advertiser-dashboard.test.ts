import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adsRoutes } from '../modules/ads/ads.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { AdsRefundService } from '../modules/ads/refund.service';

// Ads §14 — the advertiser-dashboard API. The load-bearing law: the refund
// PREVIEW must equal what the cancel actually EXECUTES (same assembly, same
// pure calculator — proven here by running both). Plus the member-gated reads
// (campaigns/invoices/team) and OWNER-only team management.

let app: FastifyInstance;
const userIds: string[] = [];
const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
let seq = 0;
const phoneBase = 592_840_000_000 + Math.floor(Math.random() * 150_000_000);

// A future Monday relative to the anchor dates used across the ads suite.
const WEEK_FUTURE = new Date('2026-11-02T00:00:00Z'); // Monday, weeks out
const NOW = new Date('2026-10-05T12:00:00Z');

async function makeUser(roles: 'CUSTOMER'[] = ['CUSTOMER']) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Dash', lastName: `U${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'dash', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

async function seedAdvertiser(ownerUserId: string) {
  const a = await app.prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: `${nanoid(6)}@x.gy`, contactPhone: '+5926000004', createdByUserId: ownerUserId, status: 'APPROVED' } });
  advertiserIds.push(a.id);
  await app.prisma.advertiserMember.create({ data: { advertiserId: a.id, userId: ownerUserId, role: 'OWNER' } });
  return a;
}

async function seedPaidCampaign(advertiserId: string, opts: { status?: 'LIVE' | 'SCHEDULED' } = {}) {
  const p = await app.prisma.adPlacement.create({ data: { key: `d-${nanoid(6)}`, name: 'P', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 7000, slotsPerWeek: 6 } });
  placementIds.push(p.id);
  const c = await app.prisma.adCampaign.create({ data: { advertiserId, placementId: p.id, name: `Camp ${nanoid(4)}`, cities: ['*'], startWeek: WEEK_FUTURE, endWeek: WEEK_FUTURE, status: opts.status ?? 'SCHEDULED', totalAmount: 7000 } });
  campaignIds.push(c.id);
  await app.prisma.adBooking.create({ data: { campaignId: c.id, placementId: p.id, city: '*', weekStart: WEEK_FUTURE, amount: 7000, status: 'CONFIRMED' } });
  await app.prisma.adInvoice.create({ data: { advertiserId, campaignId: c.id, number: `ADS-TEST-${nanoid(8)}`, amount: 7000, status: 'PAID', provider: 'MOCK', paidAt: new Date('2026-10-01T00:00:00Z') } });
  return { placement: p, campaign: c };
}

const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const post = (url: string, payload: unknown, token: string) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adsRoutes, { prefix: '/api/v1/ads' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.adInvoice.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await app.prisma.adBooking.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await app.prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await app.prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await app.prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await app.prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('§14.4 refund preview — the number shown IS the number executed (MERGE GATE)', () => {
  it('preview equals execute for the same campaign and moment', async () => {
    const owner = await makeUser();
    const a = await seedAdvertiser(owner.userId);
    const { campaign } = await seedPaidCampaign(a.id);

    const svc = new AdsRefundService(app.prisma, app.io);
    const preview = await svc.preview(campaign.id, 'ADVERTISER_CANCEL', { cancelFullRefundDays: 7, now: NOW });
    // Weeks away, ≥7 days out → §8.4 row 2: 100% refund of the future week.
    expect(preview.total).toBe(7000);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]!.kind).toBe('REFUND');

    const executed = await svc.execute(campaign.id, 'ADVERTISER_CANCEL', owner.userId, { cancelFullRefundDays: 7, now: NOW });
    expect(executed.planTotal).toBe(preview.total); // BY CONSTRUCTION equal
    expect(executed.refundedTotal).toBe(7000);
  });

  it('serves over HTTP member-gated; a stranger gets 404, preview mutates nothing', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const a = await seedAdvertiser(owner.userId);
    const { campaign } = await seedPaidCampaign(a.id);

    const res = await get(`/api/v1/ads/campaigns/${campaign.id}/refund-preview`, owner.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.total).toBe(7000);

    // Nothing changed: booking still CONFIRMED, campaign still SCHEDULED.
    const booking = await app.prisma.adBooking.findFirst({ where: { campaignId: campaign.id } });
    expect(booking!.status).toBe('CONFIRMED');
    expect((await app.prisma.adCampaign.findUnique({ where: { id: campaign.id } }))!.status).toBe('SCHEDULED');

    const denied = await get(`/api/v1/ads/campaigns/${campaign.id}/refund-preview`, stranger.token);
    expect(denied.statusCode).toBe(404); // authz-by-absence per house style
  });
});

describe('§14.2/§14.5 member-gated reads', () => {
  it('campaigns + invoices return the advertiser world; strangers 404', async () => {
    const owner = await makeUser();
    const stranger = await makeUser();
    const a = await seedAdvertiser(owner.userId);
    const { campaign } = await seedPaidCampaign(a.id, { status: 'LIVE' });

    const campaigns = await get(`/api/v1/ads/advertiser/${a.id}/campaigns`, owner.token);
    expect(campaigns.statusCode).toBe(200);
    const rows = campaigns.json().data as Array<{ id: string; placement: { key: string }; invoices: Array<{ status: string }>; bookings: unknown[] }>;
    const mine = rows.find((r) => r.id === campaign.id)!;
    expect(mine.placement.key).toBeTruthy();
    expect(mine.invoices[0]!.status).toBe('PAID');
    expect(mine.bookings).toHaveLength(1);

    const invoices = await get(`/api/v1/ads/advertiser/${a.id}/invoices`, owner.token);
    expect(invoices.statusCode).toBe(200);
    expect((invoices.json().data as Array<{ campaign: string }>)[0]!.campaign).toBeTruthy();

    expect((await get(`/api/v1/ads/advertiser/${a.id}/campaigns`, stranger.token)).statusCode).toBe(404);
    expect((await get(`/api/v1/ads/advertiser/${a.id}/invoices`, stranger.token)).statusCode).toBe(404);
  });
});

describe('§14.6 team', () => {
  it('OWNER adds a MANAGER by phone; MANAGER cannot add; unknown phone 404', async () => {
    const owner = await makeUser();
    const manager = await makeUser();
    const analyst = await makeUser();
    const a = await seedAdvertiser(owner.userId);

    const managerPhone = (await app.prisma.user.findUnique({ where: { id: manager.userId }, select: { phone: true } }))!.phone;
    const added = await post(`/api/v1/ads/advertiser/${a.id}/members`, { phone: managerPhone, role: 'MANAGER' }, owner.token);
    expect(added.statusCode).toBe(200);
    expect(added.json().data.role).toBe('MANAGER');

    // The new MANAGER can read the team…
    const list = await get(`/api/v1/ads/advertiser/${a.id}/members`, manager.token);
    expect(list.statusCode).toBe(200);
    expect((list.json().data as Array<{ role: string }>).map((m) => m.role).sort()).toEqual(['MANAGER', 'OWNER']);

    // …but cannot manage it (OWNER only).
    const analystPhone = (await app.prisma.user.findUnique({ where: { id: analyst.userId }, select: { phone: true } }))!.phone;
    const denied = await post(`/api/v1/ads/advertiser/${a.id}/members`, { phone: analystPhone, role: 'ANALYST' }, manager.token);
    expect(denied.statusCode).toBe(403);

    const unknown = await post(`/api/v1/ads/advertiser/${a.id}/members`, { phone: '+5926999999', role: 'ANALYST' }, owner.token);
    expect(unknown.statusCode).toBe(404);
  });
});
