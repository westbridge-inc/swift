/**
 * [TENANT-WALL · 1 Nov 2026] A guest's home-screen ad slots and ad events work
 * under production's CONTRACT tenant posture (for the day ads go on; they are
 * OFF at launch, and every ads route refuses first while the switch is off).
 *
 * GET /api/v1/ads/serve and POST /api/v1/ads/events take optional auth: a
 * guest carries no session, so nothing binds a tenant. Under the posture (the
 * app's own client on a least-privilege login that does not bypass row
 * security, system work on its own bypass-member login, TENANT_RLS_BIND=1 and
 * TENANT_UNSCOPED_ACCESS=deny):
 *  - serving NAMED the default marketplace but never bound it: its read of the
 *    placements was refused, and the route's catch served every guest an
 *    empty home screen;
 *  - an event's transaction began unbound, saw no campaign, and every guest
 *    event was counted invalid (billing-grade telemetry silently lost).
 *
 * Measured here through the app's own client on a per-suite walled login,
 * with the same request context boundary as server.ts:
 *  - a guest is served the marketplace's slot;
 *  - a guest's verified event is accepted once and written in the campaign's
 *    own operator; a repeat is a duplicate;
 *  - a forged token, a token whose campaign is gone and another person's
 *    token are still invalid and write nothing;
 *  - a signed-in caller's event still runs in the tenant authentication bound;
 *  - the guest's system work is at most ONE read (the campaign's operator);
 *  - the wall still binds the app.
 * Synthetic fixtures only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { testPrismaClient } from './helpers/test-prisma-client';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { createTenantProbeLogins } from './helpers/tenant-probe-logins';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { sessionCredentialDigest } from '../lib/session-credential';

// [R048-001] creates only this suite's temporary request/system LOGIN roles, by raw DDL.
grantSuiteCapability('ddl');

const TEST_URL = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
const ENV_KEYS = ['DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_UNSCOPED_ACCESS', 'TENANT_RLS_BIND', 'ADS_ENABLED'] as const;
const priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const RUN = wordFreeTag(8);
/** The guest marketplace (the route's own resolution) and a campaign operator of this suite's own. */
const GUEST_TENANT = 'swift-default';
const OPERATOR = `adwall-${RUN}`;
const SLOT = `adwall-slot-${RUN}`;
const DAY = 86_400_000;
/** The Monday (UTC date) of the week `offsetWeeks` from this one: campaigns are booked in whole weeks. */
const monday = (offsetWeeks: number) => {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 7 * offsetWeeks);
  return d;
};

let owner: PrismaClient;
let logins: Awaited<ReturnType<typeof createTenantProbeLogins>> | undefined;
let app: FastifyInstance;
let prismaModule: typeof import('../plugins/prisma') | null = null;
let adsToken: typeof import('../modules/ads/ads-token');

const userIds: string[] = [];
const ids = { guestPlacement: '', houseAd: '', advertiser: '', placement: '', campaign: '', goneCampaign: '', creative: '' };
let memberToken = '';
let memberId = '';

beforeAll(async () => {
  for (const k of ENV_KEYS) priorEnv[k] = process.env[k];
  owner = testPrismaClient(TEST_URL);
  logins = await createTenantProbeLogins(owner, TEST_URL);
  await owner.tenant.create({ data: { id: OPERATOR, name: 'Ads wall tenant', slug: OPERATOR, isActive: true } });

  // The guest marketplace's slot, filled by a house ad.
  ids.guestPlacement = (await owner.adPlacement.create({ data: {
    tenantId: GUEST_TENANT, key: SLOT, name: 'Wall slot', tier: 2, mediaKind: 'IMAGE', weeklyPrice: 1000,
  } })).id;
  ids.houseAd = (await owner.houseAd.create({ data: {
    tenantId: GUEST_TENANT, placementId: ids.guestPlacement, kind: 'IMAGE', fileUrl: `https://cdn.example.test/house-${RUN}.jpg`, headline: `House ${RUN}`,
  } })).id;

  // A live campaign of the suite's own operator.
  const creator = await owner.user.create({ data: {
    phone: testPhone(), firstName: 'Ads', lastName: `Wall${RUN}`, tenantId: OPERATOR, isPhoneVerified: true,
    roles: ['CUSTOMER'], activeRole: 'CUSTOMER', customer: { create: {} },
  } });
  userIds.push(creator.id);
  memberId = creator.id;
  ids.advertiser = (await owner.advertiser.create({ data: {
    tenantId: OPERATOR, companyName: `Wall Co ${RUN}`, industry: 'retail', contactName: 'Ads Wall', contactEmail: `ads-${RUN}@example.test`,
    contactPhone: '+5926000000', status: 'APPROVED', createdByUserId: creator.id,
  } })).id;
  ids.placement = (await owner.adPlacement.create({ data: {
    tenantId: OPERATOR, key: SLOT, name: 'Wall slot', tier: 2, mediaKind: 'IMAGE', weeklyPrice: 1000,
  } })).id;
  const campaign = (data: { name: string }) => owner.adCampaign.create({ data: {
    tenantId: OPERATOR, advertiserId: ids.advertiser, placementId: ids.placement, name: data.name,
    startWeek: monday(-1), endWeek: monday(1), status: 'LIVE',
  } });
  ids.campaign = (await campaign({ name: `Wall ${RUN}` })).id;
  ids.creative = (await owner.adCreative.create({ data: { campaignId: ids.campaign, kind: 'IMAGE', fileUrl: `https://cdn.example.test/c-${RUN}.jpg`, status: 'APPROVED' } })).id;
  ids.goneCampaign = (await campaign({ name: `Gone ${RUN}` })).id;
  await owner.adCampaign.delete({ where: { id: ids.goneCampaign } });

  // The app's OWN client on the walled login, system work on the bypass-member login,
  // and the contract's two settings, set BEFORE the app's modules load their client.
  process.env['DATABASE_URL'] = logins.requestUrl;
  process.env['SYSTEM_DATABASE_URL'] = logins.systemUrl;
  process.env['TENANT_UNSCOPED_ACCESS'] = 'deny';
  process.env['TENANT_RLS_BIND'] = '1';
  process.env['ADS_ENABLED'] = '1';
  const Fastify = (await import('fastify')).default;
  prismaModule = await import('../plugins/prisma');
  adsToken = await import('../modules/ads/ads-token');
  const { redisPlugin } = await import('../plugins/redis');
  const { authPlugin } = await import('../plugins/auth');
  const { socketPlugin } = await import('../plugins/socket');
  const { registerErrorHandler } = await import('../middleware/error-handler');
  const { beginRequestTenantContext } = await import('../plugins/tenant-context');
  const { adsRoutes } = await import('../modules/ads/ads.routes');
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaModule.prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // server.ts's request context boundary: every request starts with no tenant bound.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(adsRoutes, { prefix: '/api/v1/ads' });
  await app.ready();

  // A signed-in person of the campaign's operator (sessions are stored as digests).
  memberToken = app.jwt.sign({ userId: memberId, role: 'CUSTOMER', jti: nanoid(8) });
  await owner.session.create({ data: {
    userId: memberId, token: sessionCredentialDigest(memberToken), refreshToken: sessionCredentialDigest(nanoid(48)),
    deviceId: `adwall-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
  } });
}, 120_000);

afterAll(async () => {
  try {
    await app?.close();
    await prismaModule?.systemPrismaClient()?.$disconnect().catch(() => {});
    prismaModule?.setSystemPrismaClient(null);
  } finally {
    for (const k of ENV_KEYS) {
      if (priorEnv[k] === undefined) delete process.env[k]; else process.env[k] = priorEnv[k];
    }
    await owner.adEvent.deleteMany({ where: { campaignId: { in: [ids.campaign, ids.goneCampaign].filter(Boolean) } } });
    await owner.adFreqCounter.deleteMany({ where: { placementKey: SLOT } });
    if (ids.creative) await owner.adCreative.deleteMany({ where: { id: ids.creative } });
    await owner.adCampaign.deleteMany({ where: { id: { in: [ids.campaign, ids.goneCampaign].filter(Boolean) } } });
    await owner.houseAd.deleteMany({ where: { id: ids.houseAd } });
    await owner.adPlacement.deleteMany({ where: { id: { in: [ids.guestPlacement, ids.placement].filter(Boolean) } } });
    if (ids.advertiser) await owner.advertiser.deleteMany({ where: { id: ids.advertiser } });
    await owner.session.deleteMany({ where: { userId: { in: userIds } } });
    await owner.customer.deleteMany({ where: { userId: { in: userIds } } });
    await owner.user.deleteMany({ where: { id: { in: userIds } } });
    await owner.tenant.deleteMany({ where: { id: OPERATOR } });
    await logins?.cleanup();
    await owner.$disconnect();
  }
});

/** A token as a serve mints one: for this campaign's creative in the slot, to a guest (or `userId`). */
const tokenFor = (campaignId: string, sessionId: string, userId: string | null = null) =>
  adsToken.signImpressionToken({ c: campaignId, r: ids.creative, p: SLOT, s: sessionId }, userId);
const send = (token: string, eventType = 'IMPRESSION', auth?: string) => app.inject({
  method: 'POST', url: '/api/v1/ads/events',
  payload: { events: [{ token, eventType, occurredAt: new Date().toISOString() }] },
  headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
});
const verdict = async (res: Awaited<ReturnType<typeof send>>) => {
  expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
  return res.json().data.results[0] as string;
};

/** System reads by model and capability, from the wall's own counter. */
async function systemReads(): Promise<Map<string, number>> {
  const { tenantUnscopedAccessCounter } = await import('../plugins/observability');
  const out = new Map<string, number>();
  for (const v of (await tenantUnscopedAccessCounter.get()).values) {
    if (v.labels['mode'] !== 'system') continue;
    const key = `${v.labels['capability']}|${v.labels['model']}.${v.labels['operation']}`;
    out.set(key, (out.get(key) ?? 0) + v.value);
  }
  return out;
}
const grewBy = (before: Map<string, number>, after: Map<string, number>) => [...after].filter(([key, n]) => n !== (before.get(key) ?? 0)).map(([key]) => key);

describe('[TENANT-WALL] guest ads under the production CONTRACT tenant posture', () => {
  it('the app really runs on the wall: its own login neither is a superuser, nor bypasses, nor joins the bypass role', async () => {
    const { readRlsFacts } = await import('../lib/rls-attestation');
    const facts = await readRlsFacts(app.prisma as unknown as PrismaClient);
    expect([facts.isSuperuser, facts.hasBypassRls, facts.isBypassRoleMember]).toEqual([false, false, false]);
  });

  it('a guest is served the marketplace’s slot, and serving is never system work', async () => {
    const before = await systemReads();
    const res = await app.inject({ method: 'GET', url: `/api/v1/ads/serve?placements=${SLOT}&sessionId=guest-${RUN}` });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const slot = res.json().data.placements[SLOT];
    expect(slot?.items?.map((i: { mediaUrl: string }) => i.mediaUrl)).toEqual([`https://cdn.example.test/house-${RUN}.jpg`]);
    expect(res.json().data._house[SLOT]).toBe(true);
    expect(grewBy(before, await systemReads())).toEqual([]);
  });

  it('a guest’s verified event is accepted once, in the campaign’s own operator; a repeat is a duplicate', async () => {
    const { AD_EVENT_GUEST_CAPABILITY } = await import('../modules/ads/event.service');
    const token = tokenFor(ids.campaign, `guest-${RUN}`);
    const before = await systemReads();
    expect(await verdict(await send(token))).toBe('accepted');
    expect(grewBy(before, await systemReads())).toEqual([`${AD_EVENT_GUEST_CAPABILITY}|AdCampaign.findUnique`]);
    expect(await verdict(await send(token))).toBe('duplicate');
    const rows = await owner.adEvent.findMany({ where: { campaignId: ids.campaign, sessionId: `guest-${RUN}` }, select: { tenantId: true, eventType: true, userHash: true } });
    expect(rows).toEqual([{ tenantId: OPERATOR, eventType: 'IMPRESSION', userHash: null }]);
  });

  it('a forged token, a token whose campaign is gone and another person’s token are still invalid, and write nothing', async () => {
    const good = tokenFor(ids.campaign, `forged-${RUN}`);
    const forged = `${good.slice(0, -2)}${good.endsWith('aa') ? 'bb' : 'aa'}`;
    expect(await verdict(await send(forged))).toBe('invalid');
    expect(await verdict(await send(tokenFor(ids.goneCampaign, `gone-${RUN}`)))).toBe('invalid');
    // a token served to a signed-in person, replayed by a guest
    expect(await verdict(await send(tokenFor(ids.campaign, `theirs-${RUN}`, memberId)))).toBe('invalid');
    const written = await owner.adEvent.count({ where: { sessionId: { in: [`forged-${RUN}`, `gone-${RUN}`, `theirs-${RUN}`] } } });
    expect(written).toBe(0);
  });

  it('a signed-in person’s event still runs in the tenant authentication bound', async () => {
    const { AD_EVENT_GUEST_CAPABILITY } = await import('../modules/ads/event.service');
    const before = await systemReads();
    expect(await verdict(await send(tokenFor(ids.campaign, `member-${RUN}`, memberId), 'VIEWABLE_IMPRESSION', memberToken))).toBe('accepted');
    // (authentication itself resolves the session's account as named system work; the event adds none)
    expect(grewBy(before, await systemReads()).filter((key) => key.startsWith(`${AD_EVENT_GUEST_CAPABILITY}|`))).toEqual([]);
    const rows = await owner.adEvent.findMany({ where: { campaignId: ids.campaign, sessionId: `member-${RUN}` }, select: { tenantId: true } });
    expect(rows).toEqual([{ tenantId: OPERATOR }]);
  });
});
