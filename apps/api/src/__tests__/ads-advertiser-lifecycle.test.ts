import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adsRoutes } from '../modules/ads/ads.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';

// Swift Ads Phase 1b/1c — advertiser registration + the founder review queue
// (ads-platform spec §4). "Done = a real signup lands in the founder's queue
// and gets approved." Driven through the real authed routes end-to-end.

let app: FastifyInstance;
const userIds: string[] = [];
const advertiserIds: string[] = [];
let seq = 0;
const phoneBase = 592_810_000_000 + Math.floor(Math.random() * 180_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Adv', lastName: `U${seq}`, roles, activeRole: roles[0]!, isPhoneVerified: true, selfieCapturedAt: new Date(), ...(roles.includes('ADMIN') && { admin: { create: { permissions: ['*'] } } }) },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), ...(roles.some((role) => role === 'ADMIN' || role === 'SUPER_ADMIN') && { authMethod: 'OTP' as const }), deviceId: 'adv', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

const REG = {
  companyName: 'Regent Street Roti', industry: 'Food & Beverage',
  contactName: 'Ana', contactEmail: 'ana@roti.gy', contactPhone: '+5926005000',
  website: 'https://roti.gy', city: 'Georgetown',
};

const post = (url: string, payload: unknown, token?: string) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { ...(url.includes('/api/v1/admin') ? { 'x-swift-reason': TEST_ADMIN_REASON } : {}), 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
const put = (url: string, payload: unknown, token: string) =>
  app.inject({ method: 'PUT', url, payload: payload as Record<string, unknown>, headers: { ...(url.includes('/api/v1/admin') ? { 'x-swift-reason': TEST_ADMIN_REASON } : {}), 'content-type': 'application/json', authorization: `Bearer ${token}` } });
const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { ...(url.includes('/api/v1/admin') ? { 'x-swift-reason': TEST_ADMIN_REASON } : {}), authorization: `Bearer ${token}` } });

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
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.adCampaign.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await app.prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await app.prisma.adsAuditLog.deleteMany({ where: { entityId: { in: advertiserIds } } });
  await app.prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

async function register(token: string, over: Partial<typeof REG> = {}) {
  const res = await post('/api/v1/ads/advertiser/register', { ...REG, ...over }, token);
  if (res.statusCode === 200) advertiserIds.push(res.json().data.id);
  return res;
}

describe('§4.2 registration', () => {
  it('a real signup lands PENDING_REVIEW in the founder queue, with the caller as OWNER + an admin page', async () => {
    const admin = await makeUser(['ADMIN']);
    const user = await makeUser(['CUSTOMER']);
    const res = await register(user.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('PENDING_REVIEW');
    const id = res.json().data.id;

    // OWNER membership created.
    const member = await app.prisma.advertiserMember.findUniqueOrThrow({ where: { advertiserId_userId: { advertiserId: id, userId: user.userId } } });
    expect(member.role).toBe('OWNER');
    // Admin queue paged.
    expect(await app.prisma.notification.findFirst({ where: { userId: admin.userId, title: 'New advertiser application' } })).not.toBeNull();

    // It appears in the founder queue.
    const queue = await get('/api/v1/admin/ads/advertisers/queue', admin.token);
    expect(queue.statusCode).toBe(200);
    expect((queue.json().data as Array<{ id: string }>).some((a) => a.id === id)).toBe(true);

    // The applicant sees it on their dashboard.
    const me = await get('/api/v1/ads/advertiser/me', user.token);
    expect((me.json().data as Array<{ id: string; memberRole: string }>).find((a) => a.id === id)?.memberRole).toBe('OWNER');
  });

  it('validates the form and refuses a duplicate live registration', async () => {
    const user = await makeUser(['CUSTOMER']);
    expect((await register(user.token, { companyName: 'X' })).statusCode).toBe(400); // <2 chars
    expect((await register(user.token, { contactPhone: '12345' })).statusCode).toBe(400); // not intl
    expect((await register(user.token, { industry: 'Crypto' as never })).statusCode).toBe(400); // off-picklist
    expect((await register(user.token)).statusCode).toBe(200);
    expect((await register(user.token)).statusCode).toBe(409); // same company, still live → refused
  });

  it('registration requires auth', async () => {
    expect((await post('/api/v1/ads/advertiser/register', REG)).statusCode).toBe(401);
  });
});

describe('§4.3 admin lifecycle — approve / reject / suspend / reinstate', () => {
  it('approve unlocks the advertiser, is audited, and pages the owner', async () => {
    const admin = await makeUser(['ADMIN']);
    const user = await makeUser(['CUSTOMER']);
    const id = (await register(user.token)).json().data.id;

    const res = await put(`/api/v1/admin/ads/advertisers/${id}/approve`, {}, admin.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('APPROVED');
    expect(await app.prisma.adsAuditLog.findFirst({ where: { entityId: id, action: 'ADVERTISER_APPROVE' } })).not.toBeNull();
    expect(await app.prisma.notification.findFirst({ where: { userId: user.userId, title: { contains: 'approved' } } })).not.toBeNull();
  });

  it('reject requires a reason, preserves the record, and blocks a second decision', async () => {
    const admin = await makeUser(['ADMIN']);
    const user = await makeUser(['CUSTOMER']);
    const id = (await register(user.token)).json().data.id;

    expect((await put(`/api/v1/admin/ads/advertisers/${id}/reject`, {}, admin.token)).statusCode).toBe(400); // reason required
    const res = await put(`/api/v1/admin/ads/advertisers/${id}/reject`, { reason: 'Website is a dead link — reapply with a live page.' }, admin.token);
    expect(res.json().data.status).toBe('REJECTED');
    // A rejected application cannot then be approved (invalid transition).
    expect((await put(`/api/v1/admin/ads/advertisers/${id}/approve`, {}, admin.token)).statusCode).toBe(409);
  });

  it('suspend auto-pauses LIVE/SCHEDULED campaigns; reinstate leaves them paused', async () => {
    const admin = await makeUser(['ADMIN']);
    const user = await makeUser(['CUSTOMER']);
    const id = (await register(user.token)).json().data.id;
    await put(`/api/v1/admin/ads/advertisers/${id}/approve`, {}, admin.token);

    // A placement + two campaigns: one LIVE, one already COMPLETED (must not move).
    const placement = await app.prisma.adPlacement.create({ data: { key: `k-${nanoid(6)}`, name: 'P', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 5000 } });
    const mon = new Date('2026-08-03T00:00:00Z');
    const live = await app.prisma.adCampaign.create({ data: { advertiserId: id, placementId: placement.id, name: 'Live', cities: ['*'], startWeek: mon, endWeek: mon, status: 'LIVE' } });
    const done = await app.prisma.adCampaign.create({ data: { advertiserId: id, placementId: placement.id, name: 'Done', cities: ['*'], startWeek: mon, endWeek: mon, status: 'COMPLETED' } });

    const res = await put(`/api/v1/admin/ads/advertisers/${id}/suspend`, { reason: 'Chargeback dispute pending.' }, admin.token);
    expect(res.json().data.status).toBe('SUSPENDED');
    expect((await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('PAUSED');
    expect((await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: done.id } })).status).toBe('COMPLETED'); // untouched

    const back = await put(`/api/v1/admin/ads/advertisers/${id}/reinstate`, {}, admin.token);
    expect(back.json().data.status).toBe('APPROVED');
    expect((await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('PAUSED'); // stays paused (§4.3)

    await app.prisma.adCampaign.deleteMany({ where: { advertiserId: id } });
    await app.prisma.adPlacement.delete({ where: { id: placement.id } });
  });

  it('the queue + actions are admin-only', async () => {
    const user = await makeUser(['CUSTOMER']);
    const id = (await register(user.token)).json().data.id;
    expect((await get('/api/v1/admin/ads/advertisers/queue', user.token)).statusCode).toBe(403);
    expect((await put(`/api/v1/admin/ads/advertisers/${id}/approve`, {}, user.token)).statusCode).toBe(403);
  });
});
