import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { PrismaClient } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adsRoutes } from '../modules/ads/ads.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [MASTER-064] An advertiser member can do only what their role allows.
//
// Every advertiser mutation accepted ANY member: an ANALYST (who the team
// screen says only reads stats) could draft campaigns, reserve inventory,
// issue invoices and cancel into a refund obligation. The server now applies
// one role matrix, by named capability:
//   read     — OWNER, MANAGER, ANALYST   (dashboards, stats, invoices, team list, refund preview)
//   campaign — OWNER, MANAGER            (draft, creatives, pause, resume)
//   finance  — OWNER                     (reserve inventory, checkout, cancel with a refund)
//   team     — OWNER                     (add members)
// and the money operations re-check the member's CURRENT role inside their own
// transaction, so a downgrade or removal that commits first is obeyed.
//
// Advertising is OFF at launch (the server switch refuses every ads route
// before authentication). The role matrix is graded with the switch explicitly
// ON, the way every other ads suite runs; the last case turns it OFF again and
// proves no role, not even the OWNER, reaches a money action.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const raw = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const userIds: string[] = [];
const advertiserIds: string[] = [];
let seq = 0;
const phoneBase = 592_850_000_000 + Math.floor(Math.random() * 150_000_000);
const WEEK_FUTURE = new Date('2026-11-02T00:00:00Z');

type Actor = { userId: string; token: string };
async function makeUser(): Promise<Actor> {
  seq += 1;
  const user = await app.prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'Role', lastName: `U${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'm064', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

let owner: Actor; let manager: Actor; let analyst: Actor; let stranger: Actor;
let advertiserId = '';
let otherAdvertiserId = '';

async function placement() {
  return app.prisma.adPlacement.create({ data: { key: `m064-${nanoid(6)}`, name: 'P', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 7000, slotsPerWeek: 6 } });
}
async function draftCampaign() {
  const p = await placement();
  return app.prisma.adCampaign.create({ data: { advertiserId, placementId: p.id, name: `Draft ${nanoid(4)}`, cities: ['*'], startWeek: WEEK_FUTURE, endWeek: WEEK_FUTURE } });
}
async function paidCampaign(status: 'SCHEDULED' | 'LIVE' = 'SCHEDULED') {
  const p = await placement();
  const c = await app.prisma.adCampaign.create({ data: { advertiserId, placementId: p.id, name: `Paid ${nanoid(4)}`, cities: ['*'], startWeek: WEEK_FUTURE, endWeek: WEEK_FUTURE, status, totalAmount: 7000 } });
  await app.prisma.adBooking.create({ data: { campaignId: c.id, placementId: p.id, city: '*', weekStart: WEEK_FUTURE, amount: 7000, status: 'CONFIRMED' } });
  await app.prisma.adInvoice.create({ data: { advertiserId, campaignId: c.id, number: `ADS-M064-${nanoid(8)}`, amount: 7000, status: 'PAID', provider: 'MOCK', paidAt: new Date('2026-10-01T00:00:00Z') } });
  return c;
}

const call = (method: 'GET' | 'POST', url: string, who: Actor, payload?: unknown) => app.inject({
  method, url,
  ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${who.token}` },
});
const setRole = (userId: string, role: 'OWNER' | 'MANAGER' | 'ANALYST') =>
  raw.advertiserMember.update({ where: { advertiserId_userId: { advertiserId, userId } }, data: { role } });
const campaignBody = () => ({ advertiserId, placementId: '', name: 'New one', startWeek: '2026-11-02', endWeek: '2026-11-02' });

beforeAll(async () => {
  vi.stubEnv('ADS_ENABLED', '1');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adsRoutes, { prefix: '/api/v1/ads' });
  await app.ready();
  [owner, manager, analyst, stranger] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
  const a = await app.prisma.advertiser.create({ data: { companyName: `M064 ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: `${nanoid(6)}@x.gy`, contactPhone: '+5926000004', createdByUserId: owner.userId, status: 'APPROVED' } });
  const b = await app.prisma.advertiser.create({ data: { companyName: `M064b ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: `${nanoid(6)}@x.gy`, contactPhone: '+5926000005', createdByUserId: stranger.userId, status: 'APPROVED' } });
  advertiserId = a.id; otherAdvertiserId = b.id;
  advertiserIds.push(a.id, b.id);
  await app.prisma.advertiserMember.createMany({ data: [
    { advertiserId, userId: owner.userId, role: 'OWNER' },
    { advertiserId, userId: manager.userId, role: 'MANAGER' },
    { advertiserId, userId: analyst.userId, role: 'ANALYST' },
    { advertiserId: otherAdvertiserId, userId: stranger.userId, role: 'OWNER' },
  ] });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  // Refund intents/outbox are immutable and RESTRICT their campaign — fixtures stay; ids are unique per run.
  await app.prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await raw.$disconnect();
  await app.close();
});

describe('[MASTER-064] the advertiser role matrix', () => {
  it('drafting a campaign: OWNER and MANAGER may, ANALYST may not; a stranger cannot draft into another account', async () => {
    const p = await placement();
    for (const [who, status] of [[owner, 200], [manager, 200], [analyst, 403]] as const) {
      const res = await call('POST', '/api/v1/ads/campaigns', who, { ...campaignBody(), placementId: p.id });
      expect(res.statusCode, `${who === owner ? 'OWNER' : who === manager ? 'MANAGER' : 'ANALYST'}`).toBe(status);
      if (status === 403) expect(res.json().error.code).toBe('ADVERTISER_ROLE_FORBIDDEN');
    }
    expect(await app.prisma.adCampaign.count({ where: { placementId: p.id, createdAt: { gte: new Date(Date.now() - 60_000) } } })).toBe(2);
    expect((await call('POST', '/api/v1/ads/campaigns', stranger, { ...campaignBody(), placementId: p.id })).statusCode).toBe(404);
  });

  it.each(['reserve', 'checkout'] as const)('%s is the OWNER’s alone; a refused member changes no inventory and issues no invoice', async (action) => {
    for (const who of [manager, analyst]) {
      const c = await draftCampaign();
      const res = await call('POST', `/api/v1/ads/campaigns/${c.id}/${action}`, who, {});
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ADVERTISER_ROLE_FORBIDDEN');
      expect(await app.prisma.adBooking.count({ where: { campaignId: c.id } })).toBe(0);
      expect(await app.prisma.adInvoice.count({ where: { campaignId: c.id } })).toBe(0);
      expect((await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('DRAFT');
    }
    const c = await draftCampaign();
    expect((await call('POST', `/api/v1/ads/campaigns/${c.id}/${action}`, owner, {})).statusCode).toBe(200);
  });

  it('cancelling a paid campaign into a refund is the OWNER’s alone', async () => {
    for (const who of [manager, analyst]) {
      const c = await paidCampaign();
      const res = await call('POST', `/api/v1/ads/campaigns/${c.id}/cancel`, who, {});
      expect(res.statusCode).toBe(403);
      expect((await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('SCHEDULED');
      expect(await app.prisma.adRefundIntent.count({ where: { campaignId: c.id } })).toBe(0);
    }
    const c = await paidCampaign();
    expect((await call('POST', `/api/v1/ads/campaigns/${c.id}/cancel`, owner, {})).statusCode).toBe(200);
    expect((await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('CANCELLED');
  });

  it('an ANALYST cannot pause, resume, upload creatives or add members — and still reads everything', async () => {
    const c = await paidCampaign('LIVE');
    for (const url of [`/api/v1/ads/campaigns/${c.id}/pause`, `/api/v1/ads/campaigns/${c.id}/resume`, `/api/v1/ads/campaigns/${c.id}/creatives`]) {
      expect((await call('POST', url, analyst, {})).statusCode, url).toBe(403);
    }
    expect((await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('LIVE');
    expect((await call('POST', `/api/v1/ads/advertiser/${advertiserId}/members`, analyst, { phone: '+5926001234', role: 'ANALYST' })).statusCode).toBe(403);
    expect((await call('POST', `/api/v1/ads/advertiser/${advertiserId}/members`, manager, { phone: '+5926001234', role: 'ANALYST' })).statusCode).toBe(403);
    for (const url of [
      `/api/v1/ads/advertiser/${advertiserId}/campaigns`, `/api/v1/ads/advertiser/${advertiserId}/invoices`, `/api/v1/ads/advertiser/${advertiserId}/members`,
      `/api/v1/ads/campaigns/${c.id}/stats`, `/api/v1/ads/campaigns/${c.id}/refund-preview`,
    ]) expect((await call('GET', url, analyst)).statusCode, url).toBe(200);
  });

  it('a MANAGER can pause and resume a live campaign', async () => {
    const c = await paidCampaign('LIVE');
    expect((await call('POST', `/api/v1/ads/campaigns/${c.id}/pause`, manager, {})).statusCode).toBe(200);
    expect((await call('POST', `/api/v1/ads/campaigns/${c.id}/resume`, manager, {})).statusCode).toBe(200);
  });

  it.each(['reserve', 'checkout', 'cancel'] as const)('an OWNER downgraded after the route check but before the %s commits is refused inside the transaction', async (action) => {
    const c = action === 'cancel' ? await paidCampaign() : await draftCampaign();
    const real = app.prisma.adsSettings.findUnique.bind(app.prisma.adsSettings);
    // Every money route reads the ads settings after its membership check: the
    // downgrade commits on another connection exactly there.
    const spy = vi.spyOn(app.prisma.adsSettings, 'findUnique').mockImplementationOnce((async (args: never) => {
      await setRole(owner.userId, 'ANALYST');
      return real(args);
    }) as never);
    try {
      const res = await call('POST', `/api/v1/ads/campaigns/${c.id}/${action}`, owner, {});
      expect(spy).toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ADVERTISER_ROLE_FORBIDDEN');
      const after = await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: c.id } });
      expect(after.status).toBe(action === 'cancel' ? 'SCHEDULED' : 'DRAFT');
      expect(await app.prisma.adInvoice.count({ where: { campaignId: c.id, status: 'UNPAID' } })).toBe(0);
      if (action !== 'cancel') expect(await app.prisma.adBooking.count({ where: { campaignId: c.id } })).toBe(0);
    } finally {
      spy.mockRestore();
      await setRole(owner.userId, 'OWNER');
    }
  });

  it('with advertising switched OFF, not even the OWNER reaches a money or campaign action, and nothing changes', async () => {
    const draft = await draftCampaign();
    const paid = await paidCampaign();
    const live = await paidCampaign('LIVE');
    const p = await placement();
    vi.stubEnv('ADS_ENABLED', '0');
    try {
      for (const [url, body] of [
        [`/api/v1/ads/campaigns/${draft.id}/reserve`, {}],
        [`/api/v1/ads/campaigns/${draft.id}/checkout`, {}],
        [`/api/v1/ads/campaigns/${paid.id}/cancel`, {}],
        [`/api/v1/ads/campaigns/${live.id}/pause`, {}],
        ['/api/v1/ads/campaigns', { ...campaignBody(), placementId: p.id }],
      ] as const) {
        const res = await call('POST', url, owner, body);
        expect(res.statusCode, url).toBe(403);
        expect(res.json().error.code, url).toBe('ADS_DISABLED');
      }
    } finally {
      vi.stubEnv('ADS_ENABLED', '1');
    }
    expect((await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe('DRAFT');
    expect(await app.prisma.adBooking.count({ where: { campaignId: draft.id } })).toBe(0);
    expect(await app.prisma.adInvoice.count({ where: { campaignId: draft.id } })).toBe(0);
    expect((await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: paid.id } })).status).toBe('SCHEDULED');
    expect(await app.prisma.adRefundIntent.count({ where: { campaignId: paid.id } })).toBe(0);
    expect((await app.prisma.adCampaign.findUniqueOrThrow({ where: { id: live.id } })).status).toBe('LIVE');
    expect(await app.prisma.adCampaign.count({ where: { placementId: p.id } })).toBe(0);
  });
});
