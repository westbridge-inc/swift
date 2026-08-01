import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adsRoutes } from '../modules/ads/ads.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// Ads Phase 2 routes — the sell-the-space flow through the real authed
// endpoints: browse placements → check availability → draft a campaign →
// reserve inventory (APPROVED-only), with weeks snapped to Mondays.

let app: FastifyInstance;
const userIds: string[] = [];
const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
let seq = 0;
const phoneBase = 592_820_000_000 + Math.floor(Math.random() * 170_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Cmp', lastName: `U${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true, selfieCapturedAt: new Date() } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'cmp', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}
async function makeAdvertiser(ownerUserId: string, status: 'PENDING_REVIEW' | 'APPROVED' = 'APPROVED') {
  const a = await app.prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: ownerUserId, status } });
  advertiserIds.push(a.id);
  await app.prisma.advertiserMember.create({ data: { advertiserId: a.id, userId: ownerUserId, role: 'OWNER' } });
  return a;
}
async function makePlacement() {
  const p = await app.prisma.adPlacement.create({ data: { key: `home_ad_bar_${nanoid(6)}`, name: 'Bar', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 5000, slotsPerWeek: 6 } });
  placementIds.push(p.id);
  return p;
}

const post = (url: string, payload: unknown, token: string) => app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

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
  await app.prisma.adBooking.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await app.prisma.adInventoryWeek.deleteMany({ where: { placementId: { in: placementIds } } });
  await app.prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await app.prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await app.prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await app.prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('the sell-the-space flow', () => {
  it('browse → availability → draft → reserve, weeks snapped to Mondays', async () => {
    const owner = await makeUser(['CUSTOMER']);
    const adv = await makeAdvertiser(owner.userId, 'APPROVED');
    const placement = await makePlacement();

    // Browse.
    const placements = await get('/api/v1/ads/placements', owner.token);
    expect(placements.statusCode).toBe(200);
    expect((placements.json().data as Array<{ id: string; weeklyPrice: number }>).find((p) => p.id === placement.id)?.weeklyPrice).toBe(5000);

    // Availability materialises rows.
    const avail = await get(`/api/v1/ads/placements/${placement.id}/availability?city=*&from=2026-08-03&to=2026-08-17`, owner.token);
    expect(avail.statusCode).toBe(200);
    expect((avail.json().data as unknown[]).length).toBe(3); // 3 Mondays

    // Draft with a NON-Monday start (Wed 2026-08-05) → snapped to Mon 08-03.
    const draft = await post('/api/v1/ads/campaigns', { advertiserId: adv.id, placementId: placement.id, name: 'Launch', cities: ['*'], startWeek: '2026-08-05', endWeek: '2026-08-10' }, owner.token);
    expect(draft.statusCode).toBe(200);
    expect(draft.json().data.status).toBe('DRAFT');
    const campaignId = draft.json().data.id;
    campaignIds.push(campaignId);
    expect(String(draft.json().data.startWeek).slice(0, 10)).toBe('2026-08-03'); // snapped

    // Reserve → PENDING_PAYMENT + locked total (2 weeks × 5000).
    const reserve = await post(`/api/v1/ads/campaigns/${campaignId}/reserve`, {}, owner.token);
    expect(reserve.statusCode).toBe(200);
    expect(reserve.json().data).toMatchObject({ bookings: 2, total: 10000 });
    const c = await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(c.status).toBe('PENDING_PAYMENT');
    expect(Number(c.totalAmount)).toBe(10000);
  });

  it('a PENDING advertiser can draft but cannot reserve', async () => {
    const owner = await makeUser(['CUSTOMER']);
    const adv = await makeAdvertiser(owner.userId, 'PENDING_REVIEW');
    const placement = await makePlacement();
    const draft = await post('/api/v1/ads/campaigns', { advertiserId: adv.id, placementId: placement.id, name: 'Wait', cities: ['*'], startWeek: '2026-08-03', endWeek: '2026-08-03' }, owner.token);
    expect(draft.statusCode).toBe(200); // drafting is allowed
    campaignIds.push(draft.json().data.id);
    const reserve = await post(`/api/v1/ads/campaigns/${draft.json().data.id}/reserve`, {}, owner.token);
    expect(reserve.statusCode).toBe(403);
    expect(reserve.json().error?.code ?? reserve.json().code).toBe('ADVERTISER_NOT_APPROVED');
  });

  it('a non-member cannot draft or reserve on someone else\'s advertiser', async () => {
    const owner = await makeUser(['CUSTOMER']);
    const stranger = await makeUser(['CUSTOMER']);
    const adv = await makeAdvertiser(owner.userId, 'APPROVED');
    const placement = await makePlacement();
    const res = await post('/api/v1/ads/campaigns', { advertiserId: adv.id, placementId: placement.id, name: 'Nope', cities: ['*'], startWeek: '2026-08-03', endWeek: '2026-08-03' }, stranger.token);
    expect(res.statusCode).toBe(404); // not a member → advertiser "not found" for them
  });
});
