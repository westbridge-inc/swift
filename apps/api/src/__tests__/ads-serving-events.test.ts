import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHash, createHmac } from 'node:crypto';
import { nanoid } from 'nanoid';
import {
  adPrincipalScope,
  adTokenMatchesPrincipal,
  signImpressionToken,
  verifyImpressionToken,
  userHash,
} from '../modules/ads/ads-token';
import { mondayOf } from '../modules/ads/ads-weeks';
import { AdServingService } from '../modules/ads/serving.service';
import { AdEventService } from '../modules/ads/event.service';
import { adsRoutes } from '../modules/ads/ads.routes';
import { authPlugin } from '../plugins/auth';
import { beginRequestTenantContext, prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] This suite states the destructive capability it needs; without it the test-mode guard refuses.
grantSuiteCapability('unscoped-mutation');

// Ads Phase 4/5 — serving + event tracking (spec §11/§12). The billable loop:
// serve issues an HMAC impression token → events verify it. "Ads never break
// the home screen" (house fallback / empty), and stats are unforgeable (a token
// never issued can't be counted).

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
process.env['ADS_EVENT_SECRET'] = process.env['ADS_EVENT_SECRET'] || 'test-ads-event-secret-abcdefgh';
const serving = new AdServingService(prisma);
const events = new AdEventService(prisma);
let httpApp: FastifyInstance;
const eventPrincipal = (userId: string | null, authPresented = userId !== null) => ({ userId, authPresented });

const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
const houseIds: string[] = [];
const userIds: string[] = [];
const tenant = `t-${nanoid(6)}`;
// The PRODUCT week is the Guyana-local week (ads-weeks mondayOf) — keying the
// fixture to the UTC Monday made this suite red every Sunday 20:00–24:00
// Georgetown time (UTC already Monday, serving still reading the local week).
const WK = mondayOf(new Date());

function transactionClientFailingAfterAdEventCreate(transactionClient: any, failure: Error) {
  return new Proxy(transactionClient, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === 'adEvent') {
        return new Proxy(value, {
          get(delegate, delegateProperty) {
            const delegateValue = Reflect.get(delegate, delegateProperty, delegate);
            if (delegateProperty === 'create') {
              return async (...args: any[]) => {
                await delegateValue.apply(delegate, args);
                throw failure;
              };
            }
            return typeof delegateValue === 'function'
              ? delegateValue.bind(delegate)
              : delegateValue;
          },
        });
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Fail after the real billing-grade insert inside the next transaction. This
 * keeps PostgreSQL in charge of rollback and makes the retry regression prove
 * durable state, rather than merely asserting mocked delegate call order. */
function failNextTransactionAfterAdEventCreate(failure: Error | string) {
  const originalTransaction = prisma.$transaction.bind(prisma) as (...args: any[]) => any;
  const injectedFailure = typeof failure === 'string' ? new Error(failure) : failure;
  return vi.spyOn(prisma, '$transaction').mockImplementationOnce(((operation: any, options?: any) => {
    if (typeof operation !== 'function') return originalTransaction(operation, options);
    return originalTransaction(
      (tx: any) => operation(transactionClientFailingAfterAdEventCreate(tx, injectedFailure)),
      options,
    );
  }) as never);
}

beforeAll(async () => {
  await prisma.$connect();
  httpApp = Fastify({ logger: false });
  registerErrorHandler(httpApp);
  await httpApp.register(prismaPlugin);
  await httpApp.register(redisPlugin);
  await httpApp.register(authPlugin);
  await httpApp.register(socketPlugin);
  httpApp.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await httpApp.register(adsRoutes, { prefix: '/api/v1/ads' });
  await httpApp.ready();
});

afterAll(async () => {
  await prisma.adEvent.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adEventDedupe.deleteMany({ where: {} }).catch(() => {});
  await prisma.adFreqCounter.deleteMany({ where: {} }).catch(() => {});
  await prisma.adBooking.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.adInventoryWeek.deleteMany({ where: { placementId: { in: placementIds } } });
  await prisma.adCreative.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.houseAd.deleteMany({ where: { id: { in: houseIds } } });
  await prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await httpApp.close();
  await prisma.$disconnect();
});

async function liveBookedCampaign(placementId: string, company: string, freqCap?: number, tenantId = tenant) {
  const a = await prisma.advertiser.create({ data: { companyName: company, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: `u-${nanoid(6)}`, status: 'APPROVED', tenantId } });
  advertiserIds.push(a.id);
  const c = await prisma.adCampaign.create({ data: { tenantId, advertiserId: a.id, placementId, name: company, cities: ['*'], startWeek: WK, endWeek: WK, status: 'LIVE', destinationType: 'URL', destinationValue: 'https://x.gy' } });
  campaignIds.push(c.id);
  await prisma.adCreative.create({ data: { campaignId: c.id, kind: 'IMAGE', fileUrl: `https://cdn/${nanoid(6)}.png`, headline: `${company} sale`, ctaLabel: 'Shop', status: 'APPROVED', transcodeStatus: 'READY' } });
  await prisma.adInventoryWeek.create({ data: { placementId, city: '*', weekStart: WK, capacity: 6, booked: 1 } }).catch(() => {});
  await prisma.adBooking.create({ data: { campaignId: c.id, placementId, city: '*', weekStart: WK, amount: 5000, status: 'CONFIRMED' } });
  void freqCap;
  return c;
}
async function makePlacement(base: string, freqCap?: number, tenantId = tenant) {
  const key = `${base}-${nanoid(6)}`; // unique per test — @@unique([tenantId, key])
  const p = await prisma.adPlacement.create({ data: { tenantId, key, name: base, tier: base.includes('hero') ? 1 : 3, mediaKind: 'IMAGE', weeklyPrice: 5000, slotsPerWeek: 6, freqCapPerUserPerDay: freqCap ?? null } });
  placementIds.push(p.id);
  return p;
}

async function makeHttpUser(sessionCount = 1) {
  const user = await httpApp.prisma.user.create({
    data: {
      phone: `+592${Math.floor(1_000_000 + Math.random() * 8_999_999)}`,
      firstName: 'Ad', lastName: `Principal${nanoid(4)}`,
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
    },
  });
  userIds.push(user.id);
  const tokens: string[] = [];
  for (let i = 0; i < sessionCount; i += 1) {
    const token = httpApp.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await httpApp.prisma.session.create({
      data: {
        userId: user.id, token, refreshToken: nanoid(48), deviceId: `ads-${i}`,
        deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    tokens.push(token);
  }
  return { userId: user.id, tokens };
}

describe('§11.3 impression token', () => {
  it('round-trips and rejects tamper + expiry', () => {
    const scope = adPrincipalScope('user-a', 'sess1');
    const t = signImpressionToken({ c: 'camp1', r: 'cr1', p: 'home_ad_bar', s: 'sess1' }, 'user-a');
    const v = verifyImpressionToken(t);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.payload.c).toBe('camp1');
      expect(v.payload.p).toBe('home_ad_bar');
      expect(v.payload.a).toBe(scope);
      expect(v.payload.a).not.toContain('user-a'); // no raw principal in the client token
      expect(adTokenMatchesPrincipal(v.payload, 'user-a', true)).toBe(true);
      expect(adTokenMatchesPrincipal(v.payload, 'user-b', true)).toBe(false);
      expect(adTokenMatchesPrincipal(v.payload, null, false)).toBe(false);
    }
    // Tamper the payload → bad signature.
    const [, sig] = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ c: 'evil', r: 'x', p: 'y', s: 'z', e: Date.now() + 60000 })).toString('base64url')}.${sig}`;
    expect(verifyImpressionToken(forged).ok).toBe(false);
    // Even a correctly signed pre-v1 token lacks principal authority and is
    // deliberately non-billable. The release is a coordinated nonrolling
    // cutover; mixed token generations are never treated as compatible.
    const legacyPayload = Buffer.from(JSON.stringify({ c: 'old', r: 'old', p: 'old', s: 'old', e: Date.now() + 60_000 })).toString('base64url');
    const legacySignature = createHmac('sha256', process.env['ADS_EVENT_SECRET']!).update(legacyPayload).digest('base64url');
    expect(verifyImpressionToken(`${legacyPayload}.${legacySignature}`)).toMatchObject({ ok: false, reason: 'MALFORMED' });
    // Expired.
    const old = signImpressionToken({ c: 'a', r: 'b', p: 'c', s: 'd' }, null, Date.now() - 20 * 60_000);
    expect(verifyImpressionToken(old)).toMatchObject({ ok: false, reason: 'EXPIRED' });
    // Garbage.
    expect(verifyImpressionToken('not-a-token').ok).toBe(false);
  });
});

describe('§11 serving', () => {
  it('serves a live booked campaign with the advertiser name + a token', async () => {
    const p = await makePlacement('home_ad_bar');
    await liveBookedCampaign(p.id, 'Survival Supermarket');
    AdServingService.invalidateTenant(tenant);
    const res = await serving.serve({ tenantId: tenant, city: 'georgetown', sessionId: 'sess-1', userId: null, keys: [p.key] });
    const slot = res.placements[p.key]!;
    expect(slot.items.length).toBe(1);
    expect(slot.items[0]!.advertiserName).toBe('Survival Supermarket'); // client renders "Ad · {this}"
    expect(slot.items[0]!.impressionToken).toBeTruthy();
    expect(res._house[p.key]).toBeUndefined();
  });

  it('empty inventory falls back to house ads (untracked), then collapses when none', async () => {
    const p = await makePlacement('home_top_card');
    // No booked campaign → house ad.
    const h = await prisma.houseAd.create({ data: { tenantId: tenant, placementId: p.id, kind: 'IMAGE', fileUrl: 'https://cdn/house.png', headline: 'Swift', active: true } });
    houseIds.push(h.id);
    AdServingService.invalidateTenant(tenant);
    const withHouse = await serving.serve({ tenantId: tenant, city: '*', sessionId: 's', userId: null, keys: [p.key] });
    expect(withHouse.placements[p.key]!.items[0]!.advertiserName).toBe('Swift');
    expect(withHouse.placements[p.key]!.items[0]!.impressionToken).toBeUndefined(); // house not tracked
    expect(withHouse._house[p.key]).toBe(true);

    // Remove the house ad → collapsed (empty items), still no error.
    await prisma.houseAd.update({ where: { id: h.id }, data: { active: false } });
    AdServingService.invalidateTenant(tenant);
    const collapsed = await serving.serve({ tenantId: tenant, city: '*', sessionId: 's', userId: null, keys: [p.key] });
    expect(collapsed.placements[p.key]!.items).toHaveLength(0);
  });

  it('a frequency-capped-out user gets no tracked items (falls through)', async () => {
    const p = await makePlacement('home_hero_video', 2); // cap 2/day
    await liveBookedCampaign(p.id, 'Capped Co');
    const uh = userHash('user-cap', new Date().toISOString().slice(0, 10));
    await prisma.adFreqCounter.create({ data: { userHash: uh, placementKey: p.key, day: new Date(new Date().toISOString().slice(0, 10)), count: 2 } });
    AdServingService.invalidateTenant(tenant);
    const res = await serving.serve({ tenantId: tenant, city: '*', sessionId: 's', userId: 'user-cap', keys: [p.key] });
    expect(res.placements[p.key]!.items).toHaveLength(0); // capped out, no house → empty
  });
});

describe('§12 events', () => {
  it('accepts a valid token once, dedupes a replay, rejects a forged token', async () => {
    const p = await makePlacement('home_ad_bar');
    const c = await liveBookedCampaign(p.id, 'Event Co');
    const creative = await prisma.adCreative.findFirstOrThrow({ where: { campaignId: c.id } });
    const token = signImpressionToken({ c: c.id, r: creative.id, p: 'home_ad_bar', s: 'sess-ev' }, null);

    const first = await events.ingest([{ token, eventType: 'IMPRESSION', occurredAt: new Date().toISOString() }], eventPrincipal(null));
    expect(first).toEqual(['accepted']);
    // Same token + type again → duplicate.
    const dup = await events.ingest([{ token, eventType: 'IMPRESSION', occurredAt: new Date().toISOString() }], eventPrincipal(null));
    expect(dup).toEqual(['duplicate']);
    // Forged token → invalid, nothing recorded.
    const bad = await events.ingest([{ token: 'forged.sig', eventType: 'CLICK', occurredAt: new Date().toISOString() }], eventPrincipal(null));
    expect(bad).toEqual(['invalid']);

    const stored = await prisma.adEvent.count({ where: { campaignId: c.id } });
    expect(stored).toBe(1); // only the accepted one
  });

  it('a viewable impression increments the freq counter (billing-grade truth in Postgres)', async () => {
    const p = await makePlacement('home_top_card', 10);
    const c = await liveBookedCampaign(p.id, 'View Co');
    const creative = await prisma.adCreative.findFirstOrThrow({ where: { campaignId: c.id } });
    const uh = userHash('user-view', new Date().toISOString().slice(0, 10));
    const token = signImpressionToken({ c: c.id, r: creative.id, p: 'home_top_card', s: 'sess-v' }, 'user-view');
    await events.ingest([{ token, eventType: 'VIEWABLE_IMPRESSION', occurredAt: new Date().toISOString() }], eventPrincipal('user-view'));
    const counter = await prisma.adFreqCounter.findUnique({ where: { userHash_placementKey_day: { userHash: uh, placementKey: 'home_top_card', day: new Date(new Date().toISOString().slice(0, 10)) } } });
    expect(counter?.count).toBe(1);
    const ev = await prisma.adEvent.findFirstOrThrow({ where: { campaignId: c.id, eventType: 'VIEWABLE_IMPRESSION' } });
    expect(ev.userHash).toBe(uh); // pseudonymous, never a raw id
  });

  it('rolls back every event write after a late fault so the same token can be retried exactly once', async () => {
    const p = await makePlacement('atomic-retry-ad', 10);
    const c = await liveBookedCampaign(p.id, 'Atomic Retry Co');
    const creative = await prisma.adCreative.findFirstOrThrow({ where: { campaignId: c.id } });
    const now = new Date('2035-01-02T12:00:00.000Z');
    const principal = eventPrincipal(`atomic-user-${nanoid(6)}`);
    const token = signImpressionToken(
      { c: c.id, r: creative.id, p: p.key, s: 'atomic-retry-session' },
      principal.userId,
      now.getTime(),
    );
    const event = { token, eventType: 'VIEWABLE_IMPRESSION' as const, occurredAt: now.toISOString() };
    const th = createHash('sha256').update(token).digest('hex');
    const uh = userHash(principal.userId!, now.toISOString().slice(0, 10));
    const day = new Date(now.toISOString().slice(0, 10));
    const injectedFailure = 'deterministic fault after billing-grade ad event insert';
    const transactionSpy = failNextTransactionAfterAdEventCreate(injectedFailure);

    try {
      await expect(events.ingest([event], principal, now)).rejects.toThrow(injectedFailure);
    } finally {
      transactionSpy.mockRestore();
    }

    const [dedupeAfterFailure, counterAfterFailure, eventsAfterFailure] = await Promise.all([
      prisma.adEventDedupe.count({ where: { tokenHash: th, eventType: event.eventType } }),
      prisma.adFreqCounter.findUnique({
        where: { userHash_placementKey_day: { userHash: uh, placementKey: p.key, day } },
      }),
      prisma.adEvent.count({ where: { tokenHash: th, eventType: event.eventType } }),
    ]);
    expect(dedupeAfterFailure).toBe(0);
    expect(counterAfterFailure).toBeNull();
    expect(eventsAfterFailure).toBe(0);

    expect(await events.ingest([event], principal, now)).toEqual(['accepted']);
    expect(await events.ingest([event], principal, now)).toEqual(['duplicate']);

    const [dedupeAfterRetry, counterAfterRetry, storedEvents] = await Promise.all([
      prisma.adEventDedupe.count({ where: { tokenHash: th, eventType: event.eventType } }),
      prisma.adFreqCounter.findUnique({
        where: { userHash_placementKey_day: { userHash: uh, placementKey: p.key, day } },
      }),
      prisma.adEvent.findMany({ where: { tokenHash: th, eventType: event.eventType } }),
    ]);
    expect(dedupeAfterRetry).toBe(1);
    expect(counterAfterRetry?.count).toBe(1);
    expect(storedEvents).toHaveLength(1);
    expect(storedEvents[0]?.tenantId).toBe(tenant);
  });

  it('propagates a non-dedupe P2002, rolls back its claim, and accepts a clean retry', async () => {
    const p = await makePlacement('non-dedupe-conflict-ad', 10);
    const c = await liveBookedCampaign(p.id, 'Non-Dedupe Conflict Co');
    const creative = await prisma.adCreative.findFirstOrThrow({ where: { campaignId: c.id } });
    const now = new Date('2035-01-03T09:00:00.000Z');
    const principal = eventPrincipal(`p2002-user-${nanoid(6)}`);
    const token = signImpressionToken(
      { c: c.id, r: creative.id, p: p.key, s: 'non-dedupe-conflict-session' },
      principal.userId,
      now.getTime(),
    );
    const event = { token, eventType: 'VIEWABLE_IMPRESSION' as const, occurredAt: now.toISOString() };
    const th = createHash('sha256').update(token).digest('hex');
    const uh = userHash(principal.userId!, now.toISOString().slice(0, 10));
    const day = new Date(now.toISOString().slice(0, 10));
    const conflict = new Prisma.PrismaClientKnownRequestError(
      'Injected unique conflict outside the ad-event dedupe claim',
      {
        code: 'P2002',
        clientVersion: Prisma.prismaVersion.client,
        meta: { modelName: 'AdEvent', target: ['unrelated_billing_constraint'] },
      },
    );
    const transactionSpy = failNextTransactionAfterAdEventCreate(conflict);

    try {
      await expect(events.ingest([event], principal, now)).rejects.toMatchObject({
        code: 'P2002',
        meta: { target: ['unrelated_billing_constraint'] },
      });
    } finally {
      transactionSpy.mockRestore();
    }

    const [dedupeAfterConflict, counterAfterConflict, eventsAfterConflict] = await Promise.all([
      prisma.adEventDedupe.count({ where: { tokenHash: th, eventType: event.eventType } }),
      prisma.adFreqCounter.findUnique({
        where: { userHash_placementKey_day: { userHash: uh, placementKey: p.key, day } },
      }),
      prisma.adEvent.count({ where: { tokenHash: th, eventType: event.eventType } }),
    ]);
    expect(dedupeAfterConflict).toBe(0);
    expect(counterAfterConflict).toBeNull();
    expect(eventsAfterConflict).toBe(0);

    expect(await events.ingest([event], principal, now)).toEqual(['accepted']);
    expect(await prisma.adEventDedupe.count({ where: { tokenHash: th, eventType: event.eventType } })).toBe(1);
    expect(await prisma.adFreqCounter.findUnique({
      where: { userHash_placementKey_day: { userHash: uh, placementKey: p.key, day } },
    })).toMatchObject({ count: 1 });
    expect(await prisma.adEvent.count({ where: { tokenHash: th, eventType: event.eventType } })).toBe(1);
  });

  it('accepts exactly one of two concurrent deliveries of the same event token', async () => {
    const p = await makePlacement('concurrent-event-ad', 10);
    const c = await liveBookedCampaign(p.id, 'Concurrent Event Co');
    const creative = await prisma.adCreative.findFirstOrThrow({ where: { campaignId: c.id } });
    const now = new Date('2035-01-03T12:00:00.000Z');
    const principal = eventPrincipal(`concurrent-user-${nanoid(6)}`);
    const token = signImpressionToken(
      { c: c.id, r: creative.id, p: p.key, s: 'concurrent-event-session' },
      principal.userId,
      now.getTime(),
    );
    const event = { token, eventType: 'VIEWABLE_IMPRESSION' as const, occurredAt: now.toISOString() };
    const th = createHash('sha256').update(token).digest('hex');
    const uh = userHash(principal.userId!, now.toISOString().slice(0, 10));
    const day = new Date(now.toISOString().slice(0, 10));

    const verdicts = await Promise.all([
      events.ingest([event], principal, now),
      events.ingest([event], principal, now),
    ]);
    expect(verdicts.flat().sort()).toEqual(['accepted', 'duplicate']);

    const [dedupeCount, counter, eventCount] = await Promise.all([
      prisma.adEventDedupe.count({ where: { tokenHash: th, eventType: event.eventType } }),
      prisma.adFreqCounter.findUnique({
        where: { userHash_placementKey_day: { userHash: uh, placementKey: p.key, day } },
      }),
      prisma.adEvent.count({ where: { tokenHash: th, eventType: event.eventType } }),
    ]);
    expect(dedupeCount).toBe(1);
    expect(counter?.count).toBe(1);
    expect(eventCount).toBe(1);
  });

  it('accepts two distinct signed tokens racing the same frequency row and counts both', async () => {
    const p = await makePlacement('concurrent-frequency-ad', 10);
    const c = await liveBookedCampaign(p.id, 'Concurrent Frequency Co');
    const creative = await prisma.adCreative.findFirstOrThrow({ where: { campaignId: c.id } });
    const now = new Date('2035-01-04T12:00:00.000Z');
    const principal = eventPrincipal(`frequency-user-${nanoid(6)}`);
    const tokens = ['frequency-session-a', 'frequency-session-b'].map((sessionId) => signImpressionToken(
      { c: c.id, r: creative.id, p: p.key, s: sessionId },
      principal.userId,
      now.getTime(),
    ));
    const incoming = tokens.map((token) => ({
      token,
      eventType: 'VIEWABLE_IMPRESSION' as const,
      occurredAt: now.toISOString(),
    }));
    const hashes = tokens.map((token) => createHash('sha256').update(token).digest('hex'));
    const uh = userHash(principal.userId!, now.toISOString().slice(0, 10));
    const day = new Date(now.toISOString().slice(0, 10));

    const verdicts = await Promise.all(incoming.map((event) => events.ingest([event], principal, now)));
    expect(verdicts.flat()).toEqual(['accepted', 'accepted']);

    const [dedupeCount, counter, eventCount] = await Promise.all([
      prisma.adEventDedupe.count({
        where: { tokenHash: { in: hashes }, eventType: 'VIEWABLE_IMPRESSION' },
      }),
      prisma.adFreqCounter.findUnique({
        where: { userHash_placementKey_day: { userHash: uh, placementKey: p.key, day } },
      }),
      prisma.adEvent.count({
        where: { tokenHash: { in: hashes }, eventType: 'VIEWABLE_IMPRESSION' },
      }),
    ]);
    expect(dedupeCount).toBe(2);
    expect(counter?.count).toBe(2);
    expect(eventCount).toBe(2);
  });

  it('rejects a stale token for a deleted non-default-tenant campaign without any writes', async () => {
    const deletedTenant = `deleted-ad-tenant-${nanoid(6)}`;
    const p = await makePlacement('deleted-campaign-ad', 10, deletedTenant);
    const c = await liveBookedCampaign(p.id, 'Deleted Campaign Co', 10, deletedTenant);
    const creative = await prisma.adCreative.findFirstOrThrow({ where: { campaignId: c.id } });
    const now = new Date('2035-01-05T12:00:00.000Z');
    const principal = eventPrincipal(`deleted-campaign-user-${nanoid(6)}`);
    const token = signImpressionToken(
      { c: c.id, r: creative.id, p: p.key, s: 'deleted-campaign-session' },
      principal.userId,
      now.getTime(),
    );
    const th = createHash('sha256').update(token).digest('hex');
    const uh = userHash(principal.userId!, now.toISOString().slice(0, 10));
    const day = new Date(now.toISOString().slice(0, 10));

    await prisma.adBooking.deleteMany({ where: { campaignId: c.id } });
    await prisma.adCreative.deleteMany({ where: { campaignId: c.id } });
    await prisma.adCampaign.delete({ where: { id: c.id } });

    expect(await events.ingest([{
      token,
      eventType: 'VIEWABLE_IMPRESSION',
      occurredAt: now.toISOString(),
    }], principal, now)).toEqual(['invalid']);

    const [dedupeCount, counter, eventCount] = await Promise.all([
      prisma.adEventDedupe.count({ where: { tokenHash: th, eventType: 'VIEWABLE_IMPRESSION' } }),
      prisma.adFreqCounter.findUnique({
        where: { userHash_placementKey_day: { userHash: uh, placementKey: p.key, day } },
      }),
      prisma.adEvent.count({ where: { tokenHash: th, eventType: 'VIEWABLE_IMPRESSION' } }),
    ]);
    expect(dedupeCount).toBe(0);
    expect(counter).toBeNull();
    expect(eventCount).toBe(0);
  });

  it('binds events to the serve-time principal without consuming rejected replays', async () => {
    const p = await makePlacement('home_ad_bar');
    const c = await liveBookedCampaign(p.id, 'Principal Bound Co');
    const creative = await prisma.adCreative.findFirstOrThrow({ where: { campaignId: c.id } });
    const userA = `user-a-${nanoid(6)}`;
    const userB = `user-b-${nanoid(6)}`;
    const userSession = 'app-session-user';
    const guestSession = 'app-session-guest';
    const userToken = signImpressionToken(
      { c: c.id, r: creative.id, p: p.key, s: userSession },
      userA,
    );
    const guestToken = signImpressionToken(
      { c: c.id, r: creative.id, p: p.key, s: guestSession },
      null,
    );
    const occurredAt = new Date().toISOString();

    expect(await events.ingest([{ token: userToken, eventType: 'IMPRESSION', occurredAt }], eventPrincipal(userB))).toEqual(['invalid']);
    expect(await events.ingest([{ token: userToken, eventType: 'IMPRESSION', occurredAt }], eventPrincipal(null))).toEqual(['invalid']);
    expect(await events.ingest([{ token: userToken, eventType: 'IMPRESSION', occurredAt }], eventPrincipal(userA))).toEqual(['accepted']);

    expect(await events.ingest([{ token: guestToken, eventType: 'CLICK', occurredAt }], eventPrincipal(userB))).toEqual(['invalid']);
    expect(await events.ingest([{ token: guestToken, eventType: 'CLICK', occurredAt }], eventPrincipal(null, true))).toEqual(['invalid']);
    expect(await events.ingest([{ token: guestToken, eventType: 'CLICK', occurredAt }], eventPrincipal(null))).toEqual(['accepted']);

    const stored = await prisma.adEvent.findMany({ where: { campaignId: c.id } });
    expect(stored).toHaveLength(2);
    expect(stored.find((event) => event.eventType === 'IMPRESSION')?.userHash)
      .toBe(userHash(userA, new Date().toISOString().slice(0, 10)));
    expect(stored.find((event) => event.eventType === 'CLICK')?.userHash).toBeNull();
  });
});

describe('§12 HTTP principal authority', () => {
  const authHeader = (token?: string) => token ? { authorization: `Bearer ${token}` } : {};
  const eventPayload = (token: string, eventType: 'IMPRESSION' | 'CLICK') => ({
    events: [{ token, eventType, occurredAt: new Date().toISOString() }],
  });

  it('rejects A→B and guest→B, while accepting rotated same-user auth and explicit no-auth guest delivery', async () => {
    const p = await makePlacement('http-principal-ad', undefined, 'swift-default');
    const c = await liveBookedCampaign(p.id, 'HTTP Principal Co', undefined, 'swift-default');
    const userA = await makeHttpUser(2); // second live access session models rotation
    const userB = await makeHttpUser();
    AdServingService.invalidateTenant('swift-default');

    const servedForA = await httpApp.inject({
      method: 'GET',
      url: `/api/v1/ads/serve?placements=${encodeURIComponent(p.key)}&city=*&sessionId=app-session-a`,
      headers: authHeader(userA.tokens[0]),
    });
    expect(servedForA.statusCode).toBe(200);
    const userToken = servedForA.json().data.placements[p.key].items[0].impressionToken as string;
    expect(userToken).toBeTruthy();

    const asB = await httpApp.inject({
      method: 'POST', url: '/api/v1/ads/events',
      headers: authHeader(userB.tokens[0]), payload: eventPayload(userToken, 'IMPRESSION'),
    });
    expect(asB.statusCode).toBe(200);
    expect(asB.json().data.results).toEqual(['invalid']);

    // The same user may submit after an access/session rotation. Authority is
    // the canonical user principal + signed app session, not the old JWT row.
    const asRotatedA = await httpApp.inject({
      method: 'POST', url: '/api/v1/ads/events',
      headers: authHeader(userA.tokens[1]), payload: eventPayload(userToken, 'IMPRESSION'),
    });
    expect(asRotatedA.statusCode).toBe(200);
    expect(asRotatedA.json().data.results).toEqual(['accepted']);

    const servedForGuest = await httpApp.inject({
      method: 'GET',
      url: `/api/v1/ads/serve?placements=${encodeURIComponent(p.key)}&city=*&sessionId=app-session-guest`,
    });
    expect(servedForGuest.statusCode).toBe(200);
    const guestToken = servedForGuest.json().data.placements[p.key].items[0].impressionToken as string;
    expect(guestToken).toBeTruthy();

    const guestAsB = await httpApp.inject({
      method: 'POST', url: '/api/v1/ads/events',
      headers: authHeader(userB.tokens[0]), payload: eventPayload(guestToken, 'CLICK'),
    });
    expect(guestAsB.statusCode).toBe(200);
    expect(guestAsB.json().data.results).toEqual(['invalid']);

    const guestWithInvalidAuth = await httpApp.inject({
      method: 'POST', url: '/api/v1/ads/events',
      headers: { authorization: 'Bearer invalid-or-expired' },
      payload: eventPayload(guestToken, 'CLICK'),
    });
    expect(guestWithInvalidAuth.statusCode).toBe(200);
    expect(guestWithInvalidAuth.json().data.results).toEqual(['invalid']);

    const guestNoAuth = await httpApp.inject({
      method: 'POST', url: '/api/v1/ads/events', payload: eventPayload(guestToken, 'CLICK'),
    });
    expect(guestNoAuth.statusCode).toBe(200);
    expect(guestNoAuth.json().data.results).toEqual(['accepted']);

    const stored = await prisma.adEvent.findMany({ where: { campaignId: c.id } });
    expect(stored).toHaveLength(2);
    expect(stored.find((event) => event.eventType === 'IMPRESSION')?.userHash)
      .toBe(userHash(userA.userId, new Date().toISOString().slice(0, 10)));
    expect(stored.find((event) => event.eventType === 'CLICK')?.userHash).toBeNull();
  });
});
