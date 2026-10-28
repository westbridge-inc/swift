import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { testPrismaClient } from './helpers/test-prisma-client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adsRoutes } from '../modules/ads/ads.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { AdvertiserService } from '../modules/ads/advertiser.service';
import { AdServingService } from '../modules/ads/serving.service';
import { CreativeService } from '../modules/ads/creative.service';
import { mondayOf } from '../modules/ads/ads-weeks';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [SEC-TRUST F6] A suspension is Swift's decision, and the advertiser cannot
// undo it. While its account is not APPROVED, the advertiser's own pause,
// resume, cancel and creative upload are refused (read under lock inside the
// action), its campaigns never serve, and a campaign Swift's suspension paused
// stays paused until Swift lifts the suspension.
// Ads are OFF at launch; graded with the switch ON like every ads suite.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const raw = testPrismaClient();
const userIds: string[] = [];
const advertiserIds: string[] = [];
const WEEK_FUTURE = new Date('2026-11-02T00:00:00Z');

type Actor = { userId: string; token: string };
async function makeUser(): Promise<Actor> {
  const user = await app.prisma.user.create({ data: { phone: testPhone(), firstName: 'Ads', lastName: 'Suspended', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'sec-trust-f6', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

let owner: Actor;
let adminId = '';
const service = () => new AdvertiserService(app.prisma, app.io);

async function advertiser(status: 'APPROVED' | 'SUSPENDED' = 'APPROVED') {
  const a = await app.prisma.advertiser.create({ data: {
    companyName: `F6 ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: `${nanoid(6)}@x.gy`, contactPhone: '+5926000004',
    createdByUserId: owner.userId, status,
  } });
  advertiserIds.push(a.id);
  await app.prisma.advertiserMember.create({ data: { advertiserId: a.id, userId: owner.userId, role: 'OWNER', acceptedAt: new Date() } });
  return a.id;
}
async function campaign(advertiserId: string, status: 'DRAFT' | 'LIVE' | 'PAUSED', week = WEEK_FUTURE, statusReason: string | null = null) {
  const p = await app.prisma.adPlacement.create({ data: { key: `f6-${nanoid(6)}`, name: 'P', tier: 3, mediaKind: 'IMAGE', weeklyPrice: 7000, slotsPerWeek: 6 } });
  const c = await app.prisma.adCampaign.create({ data: { advertiserId, placementId: p.id, name: `F6 ${nanoid(4)}`, cities: ['*'], startWeek: week, endWeek: week, status, statusReason, totalAmount: 7000 } });
  if (status !== 'DRAFT') await app.prisma.adBooking.create({ data: { campaignId: c.id, placementId: p.id, city: '*', weekStart: week, amount: 7000, status: 'CONFIRMED' } });
  return { campaignId: c.id, placementKey: p.key };
}
const call = (url: string, who: Actor) => app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${who.token}` } });
const statusOf = async (campaignId: string) => (await raw.adCampaign.findUniqueOrThrow({ where: { id: campaignId } })).status;
const codeOf = (body: string) => { const j = JSON.parse(body); return j.error?.code ?? j.code; };

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
  owner = await makeUser();
  adminId = (await makeUser()).userId;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await raw.$disconnect();
  await app.close();
});

describe('[SEC-TRUST F6] a suspended advertiser cannot undo Swift’s suspension', () => {
  it('the owner cannot resume the campaign the suspension paused; after reinstatement it may', async () => {
    const id = await advertiser();
    const { campaignId } = await campaign(id, 'LIVE', mondayOf(new Date(), 'America/Guyana'));
    await service().suspend(id, adminId, 'Policy review.');
    expect(await statusOf(campaignId)).toBe('PAUSED');

    const resumed = await call(`/api/v1/ads/campaigns/${campaignId}/resume`, owner);
    expect(resumed.statusCode, resumed.body).toBe(403);
    expect(codeOf(resumed.body)).toBe('ADVERTISER_NOT_APPROVED');
    expect(await statusOf(campaignId)).toBe('PAUSED');

    await service().reinstate(id, adminId);
    const after = await call(`/api/v1/ads/campaigns/${campaignId}/resume`, owner);
    expect(after.statusCode, after.body).toBe(200);
    expect(await statusOf(campaignId)).toBe('LIVE');
  });

  it('a campaign the suspension paused before its booked week resumes to SCHEDULED, never LIVE early', async () => {
    const id = await advertiser();
    const { campaignId } = await campaign(id, 'LIVE', WEEK_FUTURE);
    await raw.adCampaign.update({ where: { id: campaignId }, data: { status: 'SCHEDULED' } });
    await service().suspend(id, adminId, 'Policy review.');
    expect(await statusOf(campaignId)).toBe('PAUSED');
    await service().reinstate(id, adminId);
    const res = await call(`/api/v1/ads/campaigns/${campaignId}/resume`, owner);
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(campaignId)).toBe('SCHEDULED');
  });

  it('a pause Swift’s suspension made is not the advertiser’s to lift, even on an approved account', async () => {
    const id = await advertiser();
    const { campaignId } = await campaign(id, 'PAUSED', WEEK_FUTURE, 'Advertiser suspended: Policy review.');
    const res = await call(`/api/v1/ads/campaigns/${campaignId}/resume`, owner);
    expect(res.statusCode, res.body).toBe(409);
    expect(codeOf(res.body)).toBe('CAMPAIGN_PAUSED_BY_SWIFT');
    expect(await statusOf(campaignId)).toBe('PAUSED');
  });

  it('a suspended advertiser cannot cancel (into a refund) or pause', async () => {
    const id = await advertiser('SUSPENDED');
    const draft = await campaign(id, 'DRAFT');
    const cancel = await call(`/api/v1/ads/campaigns/${draft.campaignId}/cancel`, owner);
    expect(cancel.statusCode, cancel.body).toBe(403);
    expect(await statusOf(draft.campaignId)).toBe('DRAFT');
    const live = await campaign(id, 'LIVE');
    const pause = await call(`/api/v1/ads/campaigns/${live.campaignId}/pause`, owner);
    expect(pause.statusCode, pause.body).toBe(403);
    expect(await statusOf(live.campaignId)).toBe('LIVE');
  });

  it('a suspended advertiser cannot upload a creative', async () => {
    const id = await advertiser('SUSPENDED');
    const { campaignId } = await campaign(id, 'DRAFT');
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    await expect(new CreativeService(app.prisma, app.io).upload({ campaignId, kind: 'IMAGE', buffer: png, mime: 'image/png', filename: 'f6.png', text: { headline: 'Hello' } }))
      .rejects.toMatchObject({ code: 'ADVERTISER_NOT_APPROVED' });
    expect(await raw.adCreative.count({ where: { campaignId } })).toBe(0);
  });

  it('a suspended advertiser’s live campaign never serves', async () => {
    const id = await advertiser('SUSPENDED');
    const week = mondayOf(new Date(), 'America/Guyana');
    const { campaignId, placementKey } = await campaign(id, 'LIVE', week);
    await app.prisma.adCreative.create({ data: { campaignId, kind: 'IMAGE', fileUrl: 'storage://f6/creative.png', status: 'APPROVED', transcodeStatus: 'READY' } });
    AdServingService.invalidateTenant('swift-default');
    const served = await new AdServingService(app.prisma).serve({ tenantId: 'swift-default', city: 'Georgetown', sessionId: nanoid(8), userId: null, keys: [placementKey] });
    const ids = (served.placements[placementKey]?.items ?? []).map((item) => (item as { campaignId?: string }).campaignId);
    expect(ids).not.toContain(campaignId);
  });
});
