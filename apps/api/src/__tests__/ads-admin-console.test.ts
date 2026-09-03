import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import { rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { adsRoutes } from '../modules/ads/ads.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { AdsRevenueService } from '../modules/ads/revenue.service';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { injectWithApproval } from './helpers/admin-approval';

// Ads §15 operator console. The revenue MERGE GATE is the dashboards law /
// acceptance #11: booked revenue must tie to paid invoices EXACTLY (delta 0)
// for any query range — whole-campaign reconciliation, never range-clipped.
// Booked vs recognized (§8.5) are both computed and never conflated.
// Multipart here is registered with the PRODUCTION limits (server.ts — 5 MB,
// 1 file) so the per-call overrides on the ads upload routes are proven
// against the real transport config, not a permissive test one.

let app: FastifyInstance;
let uploadDir: string;
const userIds: string[] = [];
const advertiserIds: string[] = [];
const placementIds: string[] = [];
const campaignIds: string[] = [];
const houseAdIds: string[] = [];
let seq = 0;
const phoneBase = 592_820_000_000 + Math.floor(Math.random() * 170_000_000);

// Mondays (same anchor family as the stats test — 2026-09-14 is a Monday).
const WEEK1 = new Date('2026-10-05T00:00:00Z');
const WEEK2 = new Date('2026-10-12T00:00:00Z');
// Thursday of week 1: 3 full days of week 1 elapsed; week 2 not started.
const NOW = new Date('2026-10-08T12:00:00Z');

const REAL_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

async function makeAdmin() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Ops', lastName: `A${seq}`, roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'ops', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Cus', lastName: `C${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'cus', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { userId: user.id, token };
}

/** Advertiser + IMAGE placement + campaign with CONFIRMED bookings for
 *  WEEK1+WEEK2 and one PAID invoice covering exactly those bookings — the
 *  invariant checkout+markPaid guarantee in production. */
async function seedPaidCampaign(opts: { price?: number; refundWeek2?: boolean } = {}) {
  const price = opts.price ?? 7000;
  const a = await app.prisma.advertiser.create({ data: { companyName: `Co ${nanoid(6)}`, industry: 'RETAIL', contactName: 'C', contactEmail: `${nanoid(6)}@x.gy`, contactPhone: '+5926000001', createdByUserId: `u-${nanoid(6)}`, status: 'APPROVED' } });
  advertiserIds.push(a.id);
  const p = await app.prisma.adPlacement.create({ data: { key: `k-${nanoid(6)}`, name: `P ${nanoid(4)}`, tier: 3, mediaKind: 'IMAGE', weeklyPrice: price, slotsPerWeek: 6 } });
  placementIds.push(p.id);
  const c = await app.prisma.adCampaign.create({ data: { advertiserId: a.id, placementId: p.id, name: `Camp ${nanoid(4)}`, cities: ['*'], startWeek: WEEK1, endWeek: WEEK2, status: 'LIVE', totalAmount: price * 2 } });
  campaignIds.push(c.id);
  await app.prisma.adBooking.create({ data: { campaignId: c.id, placementId: p.id, city: '*', weekStart: WEEK1, amount: price, status: 'CONFIRMED' } });
  await app.prisma.adBooking.create({ data: { campaignId: c.id, placementId: p.id, city: '*', weekStart: WEEK2, amount: price, status: opts.refundWeek2 ? 'REFUNDED' : 'CONFIRMED' } });
  await app.prisma.adInvoice.create({
    data: {
      advertiserId: a.id, campaignId: c.id, number: `ADS-TEST-${nanoid(8)}`, amount: price * 2,
      status: opts.refundWeek2 ? 'PARTIALLY_REFUNDED' : 'PAID', provider: 'MOCK', providerRef: nanoid(8),
      paidAt: new Date('2026-10-01T00:00:00Z'), refundedAmount: opts.refundWeek2 ? price : 0,
    },
  });
  return { advertiser: a, placement: p, campaign: c, price };
}

const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { ...(url.includes('/api/v1/admin') ? { 'x-swift-reason': TEST_ADMIN_REASON } : {}), authorization: `Bearer ${token}` } });
const putJson = (url: string, payload: unknown, token: string) =>
  injectWithApproval(app, { method: 'PUT', url, payload: payload as Record<string, unknown>, headers: { ...(url.includes('/api/v1/admin') ? { 'x-swift-reason': TEST_ADMIN_REASON } : {}), 'content-type': 'application/json', authorization: `Bearer ${token}` } });

function multipartBody(fields: Record<string, string>, file?: { mime: string; content: Buffer }) {
  const boundary = `----swift${nanoid(8)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  if (file) {
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="house.png"\r\ncontent-type: ${file.mime}\r\n\r\n`));
    parts.push(file.content, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  uploadDir = await mkdtemp(join(tmpdir(), 'ads-house-'));
  process.env['UPLOAD_DIR'] = uploadDir;
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } }); // = server.ts prod limits
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(adsRoutes, { prefix: '/api/v1/ads' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.houseAd.deleteMany({ where: { id: { in: houseAdIds } } });
  await app.prisma.adCreative.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await app.prisma.advertiserMember.deleteMany({ where: { advertiserId: { in: advertiserIds } } });
  await app.prisma.adInvoice.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await app.prisma.adBooking.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await app.prisma.adInventoryWeek.deleteMany({ where: { placementId: { in: placementIds } } });
  await app.prisma.adCampaign.deleteMany({ where: { id: { in: campaignIds } } });
  await app.prisma.advertiser.deleteMany({ where: { id: { in: advertiserIds } } });
  await app.prisma.adPlacement.deleteMany({ where: { id: { in: placementIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await rm(uploadDir, { recursive: true, force: true }).catch(() => {});
  await app.close();
});

describe('§15.8 revenue dashboard — reconciliation MERGE GATE', () => {
  it('booked ties to paid invoices exactly (delta 0), booked vs recognized never conflated', async () => {
    const svc = new AdsRevenueService(app.prisma);
    const { price, placement } = await seedPaidCampaign(); // 2 × 7000, PAID 14000
    await app.prisma.adInventoryWeek.create({ data: { placementId: placement.id, city: '*', weekStart: WEEK1, capacity: 6, booked: 2 } });

    const d = await svc.dashboard('swift-default', WEEK1, WEEK2, NOW);
    const myRows = d.weeks.filter((w) => w.placementId === placement.id);
    expect(myRows).toHaveLength(2);

    const w1 = myRows.find((w) => w.weekStart === '2026-10-05')!;
    const w2 = myRows.find((w) => w.weekStart === '2026-10-12')!;
    expect(w1.bookedGross).toBe(price);
    // Recognized §8.5: 3 full elapsed days of week 1 → 7000/7×3 = 3000.
    expect(w1.recognized).toBe(3000);
    expect(w1.capacity).toBe(6);
    expect(w1.bookedSlots).toBe(2);
    expect(w1.fillRate).toBe(0.3333);
    // Week 2 hasn't started: booked yes, recognized 0 — the §8.5 distinction.
    expect(w2.bookedGross).toBe(price);
    expect(w2.recognized).toBe(0);

    // THE TIE-OUT: campaign bookings Σ == paid invoices Σ.
    expect(d.reconciliation.delta).toBe(0);
    expect(d.reconciliation.invoicedPaid).toBeGreaterThanOrEqual(price * 2);
  });

  it('range-clipped queries still reconcile to whole campaigns (delta stays 0)', async () => {
    const svc = new AdsRevenueService(app.prisma);
    const { price, placement } = await seedPaidCampaign();
    // Query ONLY week 1 — the weeks rows clip, the reconciliation must not.
    const d = await svc.dashboard('swift-default', WEEK1, WEEK1, NOW);
    const myRows = d.weeks.filter((w) => w.placementId === placement.id);
    expect(myRows).toHaveLength(1);
    expect(myRows[0]!.bookedGross).toBe(price);
    expect(d.reconciliation.delta).toBe(0);
  });

  it('a refunded week splits gross/refunded/net and recognizes nothing', async () => {
    const svc = new AdsRevenueService(app.prisma);
    const { price, placement } = await seedPaidCampaign({ refundWeek2: true });
    const d = await svc.dashboard('swift-default', WEEK1, WEEK2, NOW);
    const w2 = d.weeks.find((w) => w.placementId === placement.id && w.weekStart === '2026-10-12')!;
    expect(w2.bookedGross).toBe(price);
    expect(w2.refunded).toBe(price);
    expect(w2.bookedNet).toBe(0);
    expect(w2.recognized).toBe(0);
    // Refunds change statuses/refundedAmount, never the invoice amount — tie holds.
    expect(d.reconciliation.delta).toBe(0);
    expect(d.reconciliation.invoiceRefunded).toBeGreaterThanOrEqual(price);
    expect(d.totals.advertiserCount).toBeGreaterThanOrEqual(1);
  });

  it('serves over HTTP behind the admin guard (customer gets 403)', async () => {
    const admin = await makeAdmin();
    const customer = await makeCustomer();
    const ok = await get('/api/v1/admin/ads/revenue?from=2026-10-05&to=2026-10-12', admin.token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.reconciliation.delta).toBe(0);
    const denied = await get('/api/v1/admin/ads/revenue', customer.token);
    expect(denied.statusCode).toBe(403);
  });
});

describe('§15.3 inventory calendar', () => {
  it('shows materialised weeks and defaults untouched weeks to full capacity', async () => {
    const svc = new AdsRevenueService(app.prisma);
    const { placement, campaign } = await seedPaidCampaign();
    await app.prisma.adInventoryWeek.create({ data: { placementId: placement.id, city: '*', weekStart: WEEK1, capacity: 6, booked: 2 } });

    const cal = await svc.inventoryCalendar('swift-default', 2, WEEK1);
    expect(cal.weekStarts).toEqual(['2026-10-05', '2026-10-12']);
    const mine = cal.placements.find((p) => p.id === placement.id)!;
    const star = mine.cities.find((c) => c.city === '*')!;
    const w1 = star.weeks[0]!;
    const w2 = star.weeks[1]!;
    expect(w1.capacity).toBe(6);
    expect(w1.booked).toBe(2);
    expect(w1.campaigns.map((c) => c.id)).toContain(campaign.id);
    // Week 2 has no inventory row: untouched → slotsPerWeek capacity, 0 booked
    // (but the CONFIRMED booking still lists for click-through).
    expect(w2.capacity).toBe(6);
    expect(w2.booked).toBe(0);
    expect(w2.campaigns.map((c) => c.id)).toContain(campaign.id);
  });
});

describe('§15.4 placement + settings config', () => {
  it('updates pricing knobs; existing booking amounts stay locked (E4)', async () => {
    const admin = await makeAdmin();
    const { placement, campaign, price } = await seedPaidCampaign();
    const res = await putJson(`/api/v1/admin/ads/placements/${placement.id}`, { weeklyPrice: 9000, slotsPerWeek: 4 }, admin.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.weeklyPrice).toBe(9000);
    const bookings = await app.prisma.adBooking.findMany({ where: { campaignId: campaign.id } });
    for (const b of bookings) expect(Number(b.amount)).toBe(price); // price locked at checkout
  });

  it('upserts tenant settings', async () => {
    const admin = await makeAdmin();
    const res = await putJson('/api/v1/admin/ads/settings', { reservationMinutes: 30, reviewSlaHours: 12 }, admin.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.reservationMinutes).toBe(30);
    const read = await get('/api/v1/admin/ads/settings', admin.token);
    expect(read.json().data.reviewSlaHours).toBe(12);
  });
});

describe('§15.5 campaigns table', () => {
  it('lists campaigns with advertiser, placement, and invoices; filters by status', async () => {
    const admin = await makeAdmin();
    const { campaign, advertiser } = await seedPaidCampaign();
    const res = await get('/api/v1/admin/ads/campaigns?status=LIVE&limit=100', admin.token);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string; advertiser: string; invoices: Array<{ status: string }> }>;
    const mine = rows.find((r) => r.id === campaign.id)!;
    expect(mine).toBeTruthy();
    expect(mine.advertiser).toBe(advertiser.companyName);
    expect(mine.invoices[0]!.status).toBe('PAID');
  });
});

describe('§9.1 video transport cap (the 5 MB global-limit bug)', () => {
  it('accepts a >5 MB MP4 creative through the real route despite the prod global limit', async () => {
    // A VIDEO placement + campaign owned by a real member.
    const member = await makeCustomer();
    const a = await app.prisma.advertiser.create({ data: { companyName: `Vid ${nanoid(6)}`, industry: 'RETAIL', contactName: 'V', contactEmail: `${nanoid(6)}@x.gy`, contactPhone: '+5926000002', createdByUserId: member.userId, status: 'APPROVED' } });
    advertiserIds.push(a.id);
    await app.prisma.advertiserMember.create({ data: { advertiserId: a.id, userId: member.userId, role: 'OWNER' } });
    const p = await app.prisma.adPlacement.create({ data: { key: `v-${nanoid(6)}`, name: 'Hero', tier: 1, mediaKind: 'VIDEO', weeklyPrice: 50000, slotsPerWeek: 1 } });
    placementIds.push(p.id);
    const c = await app.prisma.adCampaign.create({ data: { advertiserId: a.id, placementId: p.id, name: 'VidCamp', cities: ['*'], startWeek: WEEK1, endWeek: WEEK1, status: 'PENDING_REVIEW' } });
    campaignIds.push(c.id);

    // 6 MB "mp4": ftyp magic at offset 4 — over the 5 MB global transport cap,
    // under the §9.1 25 MB video cap. Without the per-call override this dies
    // in transport before the service ever sees it.
    const mp4 = Buffer.alloc(6 * 1024 * 1024, 0);
    mp4.write('ftyp', 4, 'ascii');
    const body = multipartBody({ kind: 'VIDEO' }, { mime: 'video/mp4', content: mp4 });
    const res = await app.inject({ method: 'POST', url: `/api/v1/ads/campaigns/${c.id}/creatives`, payload: body.payload, headers: { 'content-type': body.contentType, authorization: `Bearer ${member.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.transcodeStatus).toBe('QUEUED'); // videos await the transcode job
  });
});

describe('§15.7 house ads manager', () => {
  it('creates from a real image, rejects garbage bytes, updates sort/active (no hard delete)', async () => {
    const admin = await makeAdmin();
    const { placement } = await seedPaidCampaign();

    const good = multipartBody(
      { placementId: placement.id, kind: 'IMAGE', headline: 'Swift Deals', ctaLabel: 'Order now', sort: '2' },
      { mime: 'image/png', content: REAL_PNG },
    );
    const created = await injectWithApproval(app, { method: 'POST', url: '/api/v1/admin/ads/house', payload: good.payload, headers: { 'x-swift-reason': TEST_ADMIN_REASON,  'content-type': good.contentType, authorization: `Bearer ${admin.token}` } });
    expect(created.statusCode).toBe(200);
    const row = created.json().data as { id: string; fileUrl: string; sort: number };
    houseAdIds.push(row.id);
    expect(row.fileUrl).toBeTruthy();
    expect(row.sort).toBe(2);

    const bad = multipartBody({ placementId: placement.id, kind: 'IMAGE' }, { mime: 'image/png', content: Buffer.alloc(64, 7) });
    const rejected = await injectWithApproval(app, { method: 'POST', url: '/api/v1/admin/ads/house', payload: bad.payload, headers: { 'x-swift-reason': TEST_ADMIN_REASON,  'content-type': bad.contentType, authorization: `Bearer ${admin.token}` } });
    expect(rejected.statusCode).toBe(400);

    const updated = await putJson(`/api/v1/admin/ads/house/${row.id}`, { sort: 0, active: false }, admin.token);
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.active).toBe(false);

    const list = await get('/api/v1/admin/ads/house', admin.token);
    expect(list.statusCode).toBe(200);
    const listed = (list.json().data as Array<{ id: string; active: boolean }>).find((h) => h.id === row.id)!;
    expect(listed.active).toBe(false); // deactivated, never deleted (§18)
  });
});
