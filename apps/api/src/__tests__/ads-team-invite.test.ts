import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adsRoutes } from '../modules/ads/ads.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { ADS_TEAM_INVITES_PER_DAY } from '../modules/ads/advertiser.service';

// ---------------------------------------------------------------------------
// [SWITCHES fact-check, ads security · built while ads are off] An advertiser OWNER used to "add" any
// existing account by phone: the membership was granted on the spot, with no invitation and no
// acceptance, and the team list then returned that person's full name and phone. That was a lookup:
// type a number, read who owns it. Now an add is an INVITATION the person must accept; the list shows
// accepted members only, and an open invitation shows its role and nothing about the person; and an
// advertiser may send a bounded number of invitations a day (every attempt counts, known number or not).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
const advertiserIds: string[] = [];
let seq = 0;
const phoneBase = 592_870_000_000 + Math.floor(Math.random() * 150_000_000);

async function makeUser() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Team', lastName: `Person${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'team', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token, phone: user.phone, name: `Team Person${seq}` };
}
async function seedAdvertiser(ownerUserId: string) {
  const a = await app.prisma.advertiser.create({ data: { companyName: `Team Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: `${nanoid(6)}@x.gy`, contactPhone: '+5926000004', createdByUserId: ownerUserId, status: 'APPROVED' } });
  advertiserIds.push(a.id);
  await app.prisma.advertiserMember.create({ data: { advertiserId: a.id, userId: ownerUserId, role: 'OWNER' } });
  return a;
}
const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
const post = (url: string, payload: unknown, token: string) =>
  app.inject({ method: 'POST', url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
const invite = (advertiserId: string, phone: string, token: string, role = 'MANAGER') => post(`/api/v1/ads/advertiser/${advertiserId}/members`, { phone, role }, token);

beforeAll(async () => {
  vi.stubEnv('ADS_ENABLED', '1');
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
beforeEach(async () => {
  // A fresh daily budget for every advertiser this file made.
  for (const id of advertiserIds) { const keys = await app.redis.keys(`ads:team-invites:${id}:*`); if (keys.length) await app.redis.del(...keys); }
});
afterAll(async () => {
  vi.unstubAllEnvs();
  for (const id of advertiserIds) { const keys = await app.redis.keys(`ads:team-invites:${id}:*`); if (keys.length) await app.redis.del(...keys); }
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await app.prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } }).catch(() => {});
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('an advertiser team grows by invitation and acceptance, never by a typed phone number', () => {
  it('an invite grants nothing: the invitee is not a member until they accept, and a known number answers like an unknown one', async () => {
    const owner = await makeUser(); const invitee = await makeUser();
    const a = await seedAdvertiser(owner.userId);
    const known = await invite(a.id, invitee.phone, owner.token);
    const unknown = await invite(a.id, '+5926999998', owner.token);
    expect(known.statusCode).toBe(200);
    expect(unknown.body).toBe(known.body);
    expect(known.body).not.toContain(invitee.userId);
    // not a member: the team, the advertiser and the placement inventory stay closed to them
    expect((await get(`/api/v1/ads/advertiser/${a.id}/members`, invitee.token)).statusCode).toBe(404);
    expect((await get(`/api/v1/ads/advertiser/${a.id}/campaigns`, invitee.token)).statusCode).toBe(404);
    const mine = (await get('/api/v1/ads/advertiser/me', invitee.token)).json().data as Array<{ id: string }> | { advertisers?: Array<{ id: string }> };
    expect(JSON.stringify(mine)).not.toContain(a.id);
  });

  it("the team list names accepted members only; an open invitation shows its role, never the person's name, phone or id", async () => {
    const owner = await makeUser(); const invitee = await makeUser();
    const a = await seedAdvertiser(owner.userId);
    await invite(a.id, invitee.phone, owner.token);
    const list = await get(`/api/v1/ads/advertiser/${a.id}/members`, owner.token);
    expect(list.statusCode).toBe(200);
    const body = list.body;
    expect(body).not.toContain(invitee.phone);
    expect(body).not.toContain(invitee.name);
    expect(body).not.toContain(invitee.userId);
    const rows = list.json().data as Array<{ role: string; status: string; name?: string | null; phone?: string | null }>;
    expect(rows.find((r) => r.role === 'OWNER')).toMatchObject({ status: 'ACCEPTED' });
    expect(rows.find((r) => r.role === 'MANAGER')).toEqual({ role: 'MANAGER', status: 'PENDING' });
  });

  it('the invitee sees the invitation, accepts it, and only then is a member (and named on the list)', async () => {
    const owner = await makeUser(); const invitee = await makeUser();
    const a = await seedAdvertiser(owner.userId);
    await invite(a.id, invitee.phone, owner.token, 'ANALYST');
    const mine = await get('/api/v1/ads/advertiser/invites', invitee.token);
    expect(mine.statusCode).toBe(200);
    expect(mine.json().data).toEqual([expect.objectContaining({ advertiserId: a.id, companyName: a.companyName, role: 'ANALYST' })]);
    const notified = await app.prisma.notification.findMany({ where: { userId: invitee.userId } });
    expect(notified.some((n) => (n.data as { kind?: string } | null)?.kind === 'advertiser_team_invite')).toBe(true);

    const accepted = await post(`/api/v1/ads/advertiser/${a.id}/members/accept`, {}, invitee.token);
    expect(accepted.statusCode).toBe(200);
    const list = await get(`/api/v1/ads/advertiser/${a.id}/members`, invitee.token);
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'ANALYST', status: 'ACCEPTED', name: invitee.name, phone: invitee.phone })]));
    expect((await get('/api/v1/ads/advertiser/invites', invitee.token)).json().data).toEqual([]);
  });

  it('a declined invitation is gone; accepting without an invitation is a 404', async () => {
    const owner = await makeUser(); const invitee = await makeUser(); const stranger = await makeUser();
    const a = await seedAdvertiser(owner.userId);
    await invite(a.id, invitee.phone, owner.token);
    expect((await post(`/api/v1/ads/advertiser/${a.id}/members/decline`, {}, invitee.token)).statusCode).toBe(200);
    expect(await app.prisma.advertiserMember.count({ where: { advertiserId: a.id, userId: invitee.userId } })).toBe(0);
    expect((await post(`/api/v1/ads/advertiser/${a.id}/members/accept`, {}, invitee.token)).statusCode).toBe(404);
    expect((await post(`/api/v1/ads/advertiser/${a.id}/members/accept`, {}, stranger.token)).statusCode).toBe(404);
  });

  it('an invitation never changes an accepted member (no silent role change)', async () => {
    const owner = await makeUser(); const member = await makeUser();
    const a = await seedAdvertiser(owner.userId);
    await invite(a.id, member.phone, owner.token, 'ANALYST');
    await post(`/api/v1/ads/advertiser/${a.id}/members/accept`, {}, member.token);
    await invite(a.id, member.phone, owner.token, 'MANAGER');
    expect((await app.prisma.advertiserMember.findUnique({ where: { advertiserId_userId: { advertiserId: a.id, userId: member.userId } } }))!.role).toBe('ANALYST');
  });

  it(`an advertiser sends at most ${ADS_TEAM_INVITES_PER_DAY} invitations a day, and every attempt counts, known number or not`, async () => {
    const owner = await makeUser(); const late = await makeUser();
    const a = await seedAdvertiser(owner.userId);
    for (let i = 0; i < ADS_TEAM_INVITES_PER_DAY; i += 1) {
      expect((await invite(a.id, `+59269${String(1000 + i).padStart(5, '0')}`, owner.token)).statusCode).toBe(200);
    }
    const over = await invite(a.id, late.phone, owner.token);
    expect(over.statusCode).toBe(429);
    expect(over.json().error?.code ?? over.json().code).toBe('TEAM_INVITE_LIMIT');
    expect(await app.prisma.advertiserMember.count({ where: { advertiserId: a.id, userId: late.userId } })).toBe(0);
  });

  it('only the OWNER invites', async () => {
    const owner = await makeUser(); const manager = await makeUser(); const other = await makeUser();
    const a = await seedAdvertiser(owner.userId);
    await invite(a.id, manager.phone, owner.token);
    await post(`/api/v1/ads/advertiser/${a.id}/members/accept`, {}, manager.token);
    expect((await invite(a.id, other.phone, manager.token)).statusCode).toBe(403);
  });
});
