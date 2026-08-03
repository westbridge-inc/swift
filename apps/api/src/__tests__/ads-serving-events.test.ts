import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { signImpressionToken, verifyImpressionToken, userHash } from '../modules/ads/ads-token';
import { mondayOf } from '../modules/ads/ads-weeks';
import { AdServingService } from '../modules/ads/serving.service';
import { AdEventService } from '../modules/ads/event.service';

// Ads Phase 4/5 — serving + event tracking (spec §11/§12). The billable loop:
// serve issues an HMAC impression token → events verify it. "Ads never break
// the home screen" (house fallback / empty), and stats are unforgeable (a token
// never issued can't be counted).

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
process.env['ADS_EVENT_SECRET'] = process.env['ADS_EVENT_SECRET'] || 'test-ads-event-secret-abcdefgh';
const serving = new AdServingService(prisma);
const events = new AdEventService(prisma);

const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
const houseIds: string[] = [];
const tenant = `t-${nanoid(6)}`;
// The PRODUCT week is the Guyana-local week (ads-weeks mondayOf) — keying the
// fixture to the UTC Monday made this suite red every Sunday 20:00–24:00
// Georgetown time (UTC already Monday, serving still reading the local week).
const WK = mondayOf(new Date());

beforeAll(async () => { await prisma.$connect(); });

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
  await prisma.$disconnect();
});

async function liveBookedCampaign(placementId: string, company: string, freqCap?: number) {
  const a = await prisma.advertiser.create({ data: { companyName: company, industry: 'RETAIL', contactName: 'C', contactEmail: 'c@x.gy', contactPhone: '+5926000000', createdByUserId: `u-${nanoid(6)}`, status: 'APPROVED', tenantId: tenant } });
  advertiserIds.push(a.id);
  const c = await prisma.adCampaign.create({ data: { tenantId: tenant, advertiserId: a.id, placementId, name: company, cities: ['*'], startWeek: WK, endWeek: WK, status: 'LIVE', destinationType: 'URL', destinationValue: 'https://x.gy' } });
  campaignIds.push(c.id);
  await prisma.adCreative.create({ data: { campaignId: c.id, kind: 'IMAGE', fileUrl: `https://cdn/${nanoid(6)}.png`, headline: `${company} sale`, ctaLabel: 'Shop', status: 'APPROVED', transcodeStatus: 'READY' } });
  await prisma.adInventoryWeek.create({ data: { placementId, city: '*', weekStart: WK, capacity: 6, booked: 1 } }).catch(() => {});
  await prisma.adBooking.create({ data: { campaignId: c.id, placementId, city: '*', weekStart: WK, amount: 5000, status: 'CONFIRMED' } });
  void freqCap;
  return c;
}
async function makePlacement(base: string, freqCap?: number) {
  const key = `${base}-${nanoid(6)}`; // unique per test — @@unique([tenantId, key])
  const p = await prisma.adPlacement.create({ data: { tenantId: tenant, key, name: base, tier: base.includes('hero') ? 1 : 3, mediaKind: 'IMAGE', weeklyPrice: 5000, slotsPerWeek: 6, freqCapPerUserPerDay: freqCap ?? null } });
  placementIds.push(p.id);
  return p;
}

describe('§11.3 impression token', () => {
  it('round-trips and rejects tamper + expiry', () => {
    const t = signImpressionToken({ c: 'camp1', r: 'cr1', p: 'home_ad_bar', s: 'sess1' });
    const v = verifyImpressionToken(t);
    expect(v.ok).toBe(true);
    if (v.ok) { expect(v.payload.c).toBe('camp1'); expect(v.payload.p).toBe('home_ad_bar'); }
    // Tamper the payload → bad signature.
    const [, sig] = t.split('.');
    const forged = `${Buffer.from(JSON.stringify({ c: 'evil', r: 'x', p: 'y', s: 'z', e: Date.now() + 60000 })).toString('base64url')}.${sig}`;
    expect(verifyImpressionToken(forged).ok).toBe(false);
    // Expired.
    const old = signImpressionToken({ c: 'a', r: 'b', p: 'c', s: 'd' }, Date.now() - 20 * 60_000);
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
    const res = await serving.serve({ tenantId: tenant, city: 'georgetown', sessionId: 'sess-1', userHash: null, keys: [p.key] });
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
    const withHouse = await serving.serve({ tenantId: tenant, city: '*', sessionId: 's', userHash: null, keys: [p.key] });
    expect(withHouse.placements[p.key]!.items[0]!.advertiserName).toBe('Swift');
    expect(withHouse.placements[p.key]!.items[0]!.impressionToken).toBeUndefined(); // house not tracked
    expect(withHouse._house[p.key]).toBe(true);

    // Remove the house ad → collapsed (empty items), still no error.
    await prisma.houseAd.update({ where: { id: h.id }, data: { active: false } });
    AdServingService.invalidateTenant(tenant);
    const collapsed = await serving.serve({ tenantId: tenant, city: '*', sessionId: 's', userHash: null, keys: [p.key] });
    expect(collapsed.placements[p.key]!.items).toHaveLength(0);
  });

  it('a frequency-capped-out user gets no tracked items (falls through)', async () => {
    const p = await makePlacement('home_hero_video', 2); // cap 2/day
    await liveBookedCampaign(p.id, 'Capped Co');
    const uh = userHash('user-cap', new Date().toISOString().slice(0, 10));
    await prisma.adFreqCounter.create({ data: { userHash: uh, placementKey: p.key, day: new Date(new Date().toISOString().slice(0, 10)), count: 2 } });
    AdServingService.invalidateTenant(tenant);
    const res = await serving.serve({ tenantId: tenant, city: '*', sessionId: 's', userHash: uh, keys: [p.key] });
    expect(res.placements[p.key]!.items).toHaveLength(0); // capped out, no house → empty
  });
});

describe('§12 events', () => {
  it('accepts a valid token once, dedupes a replay, rejects a forged token', async () => {
    const p = await makePlacement('home_ad_bar');
    const c = await liveBookedCampaign(p.id, 'Event Co');
    const creative = await prisma.adCreative.findFirstOrThrow({ where: { campaignId: c.id } });
    const token = signImpressionToken({ c: c.id, r: creative.id, p: 'home_ad_bar', s: 'sess-ev' });

    const first = await events.ingest([{ token, eventType: 'IMPRESSION', occurredAt: new Date().toISOString() }], null);
    expect(first).toEqual(['accepted']);
    // Same token + type again → duplicate.
    const dup = await events.ingest([{ token, eventType: 'IMPRESSION', occurredAt: new Date().toISOString() }], null);
    expect(dup).toEqual(['duplicate']);
    // Forged token → invalid, nothing recorded.
    const bad = await events.ingest([{ token: 'forged.sig', eventType: 'CLICK', occurredAt: new Date().toISOString() }], null);
    expect(bad).toEqual(['invalid']);

    const stored = await prisma.adEvent.count({ where: { campaignId: c.id } });
    expect(stored).toBe(1); // only the accepted one
  });

  it('a viewable impression increments the freq counter (billing-grade truth in Postgres)', async () => {
    const p = await makePlacement('home_top_card', 10);
    const c = await liveBookedCampaign(p.id, 'View Co');
    const creative = await prisma.adCreative.findFirstOrThrow({ where: { campaignId: c.id } });
    const uh = userHash('user-view', new Date().toISOString().slice(0, 10));
    const token = signImpressionToken({ c: c.id, r: creative.id, p: 'home_top_card', s: 'sess-v' });
    await events.ingest([{ token, eventType: 'VIEWABLE_IMPRESSION', occurredAt: new Date().toISOString() }], uh);
    const counter = await prisma.adFreqCounter.findUnique({ where: { userHash_placementKey_day: { userHash: uh, placementKey: 'home_top_card', day: new Date(new Date().toISOString().slice(0, 10)) } } });
    expect(counter?.count).toBe(1);
    const ev = await prisma.adEvent.findFirstOrThrow({ where: { campaignId: c.id, eventType: 'VIEWABLE_IMPRESSION' } });
    expect(ev.userHash).toBe(uh); // pseudonymous, never a raw id
  });
});
