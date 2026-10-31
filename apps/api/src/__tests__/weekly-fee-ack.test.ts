/**
 * [COORD ruling 22 Oct 2026 · row 628] The weekly fee at partner sign-up.
 *
 * A partner sees the weekly fee BEFORE they submit sign-up — the server's amount for their vehicle or
 * business, what it covers, when it starts, how it is paid and the 14-day rule for price changes — and
 * ticks "I understand the weekly fee" next to the partner agreement. The words come from the server
 * (GET /auth/pricing `feeTerms`), are hash-anchored in the consent ledger (weekly_fee_acknowledgement v1),
 * and the tick is recorded in the same transaction that provisions the partner, with the amount the
 * partner saw — which must be the server's quote at that moment.
 *
 * Who must send it: the website (a browser client) always, and any client that sends the field. Phone
 * builds 9-12 send no such field and keep signing up; nothing is fabricated for them.
 */
import { createHash } from 'node:crypto';
import { WEEKLY_RETIER_ON } from '../modules/billing/weekly-retier';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ACCESS_COOKIE, resetBrowserOriginsForTests } from '../modules/auth/browser-session';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';

const NUM = String(Date.now()).slice(-5);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'weekly-fee-ack-test');
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
let app: FastifyInstance;
const users: string[] = [];

/** The exact v1 words, written out here so a change to them is a red test, never a silent re-anchor. */
const V1_ITEMS = [
  { heading: 'What it covers', text: 'The Swift app and its tools for your work. Swift takes no commission: you keep 100% of your sales, fares, delivery fees and tips.' },
  // [REVIEW-F S3-1] True for riders and drivers too: their fee is born at approval, not when they first go online.
  { heading: 'When it starts', text: 'Nothing is paid at sign-up. The weekly fee starts only after Swift approves you, and after your free trial if you get one.' },
  { heading: 'How you pay', text: 'In the Swift app, on MMG’s checkout page, one week at a time. Paying by card is not offered yet.' },
  { heading: 'If the price changes', text: 'Swift tells you in the app at least 14 days before. A new price applies only from your first weekly fee due after that, never to a week you have already paid.' },
];
const V1_TICK = 'I understand the weekly fee.';
const V1_TEXT = [...V1_ITEMS.map((i) => `${i.heading}: ${i.text}`), V1_TICK].join('\n');

async function customer(n: number) {
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: { phone: `+59274${NUM}${n}`, firstName: 'Fee', lastName: `Tick${n}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, customer: { create: {} } } as never }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(24), deviceId: `fee-${NUM}-${n}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3_600_000) } as never });
  return { id: u.id, token };
}
const become = (token: string, payload: Record<string, unknown>, extra: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/v1/partner/become', payload, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra } });
const WEB_ORIGIN = 'http://localhost:3001';
const savedCorsOrigin = process.env['CORS_ORIGIN'];
/** The web app's request: the HttpOnly session cookie, the browser client header and an allowed origin. */
const becomeFromWeb = (token: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/v1/partner/become', payload, headers: { 'content-type': 'application/json', 'x-swift-client': 'web', origin: WEB_ORIGIN, cookie: `${ACCESS_COOKIE}=${token}` } });

interface PriceList {
  currencyCode: string;
  movers: Array<{ vehicleType: string; rate: number; tier: string }>;
  vendors: { service: number; catalogue: Array<{ minItems: number; rate: number; tier: string }> };
  feeTerms?: { version: string; items: Array<{ heading: string; text: string }>; tick: string };
}
async function priceList(): Promise<PriceList> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/auth/pricing' });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data as PriceList;
}
const moverRate = (p: PriceList, vehicleType: string) => p.movers.find((q) => q.vehicleType === vehicleType)!.rate;

const feeRows = (userId: string) => system(() => app.prisma.consentRecord.findMany({ where: { subjectId: userId, documentType: 'weekly_fee_acknowledgement' } }));
async function provisioned(userId: string) {
  return system(() => app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { roles: true, rider: { select: { id: true } }, driver: { select: { id: true } }, vendorOwner: { select: { vendors: { select: { id: true } } } } } }));
}
const store = (vendorType: string, n: number) => ({ name: `Fee Tick Shop ${NUM}${n}`, vendorType, phone: '+5926001834', addressLine1: '12 Regent Street', city: 'Georgetown', latitude: 6.8013, longitude: -58.1551 });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  process.env['CORS_ORIGIN'] = WEB_ORIGIN;
  resetBrowserOriginsForTests();
  app = Fastify({ logger: false }); registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.ready();
});
afterAll(async () => {
  await system(async () => {
    const vendors = await app.prisma.vendor.findMany({ where: { owner: { userId: { in: users } } }, select: { id: true } });
    await app.prisma.vendorStaff.deleteMany({ where: { vendorId: { in: vendors.map((v) => v.id) } } }).catch(() => {});
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendors.map((v) => v.id) } } }).catch(() => {});
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
  if (savedCorsOrigin === undefined) delete process.env['CORS_ORIGIN']; else process.env['CORS_ORIGIN'] = savedCorsOrigin;
  resetBrowserOriginsForTests();
});

describe('the weekly fee words are the server’s, pinned and served with the price', () => {
  it('GET /auth/pricing serves the v1 words beside the amounts: what it covers, when it starts, how it is paid, the 14-day rule, and the tick', async () => {
    const p = await priceList();
    expect(p.feeTerms).toEqual({ version: 'v1', items: V1_ITEMS, tick: V1_TICK });
  });

  it('[RETIER PR-B] says whether Swift moves existing stores between catalogue steps (off until the owner\'s go) and the notice a rise gets', async () => {
    const p = await priceList() as unknown as { catalogueRetier?: unknown };
    // the switch's own value (pinned off in weekly-retier-off.test.ts): turning it on changes this answer with it
    expect(p.catalogueRetier).toEqual({ on: WEEKLY_RETIER_ON, noticeDays: 14 });
    expect(WEEKLY_RETIER_ON).toBe(false);
  });
});

describe('the "I understand the weekly fee" tick at partner sign-up', () => {
  it('a phone that sends the tick with the quoted amount gets a ledger row anchored to the exact words, with the amount, in the provisioning request', async () => {
    const c = await customer(1);
    const p = await priceList();
    const amount = moverRate(p, 'MOTORCYCLE');
    const res = await become(c.token, { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: true, weeklyFeeAck: { version: 'v1', amount, currencyCode: p.currencyCode } }, { 'x-client-platform': 'android' });
    expect([200, 201], res.body).toContain(res.statusCode);
    const rows = await feeRows(c.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subjectType: 'driver', documentVersion: 'v1', action: 'granted', surface: 'android', documentContentHash: sha256(V1_TEXT) });
    expect(rows[0]!.evidence).toMatchObject({ control: 'weekly_fee_checkbox', path: 'partner/become', kind: 'RIDER', vehicleType: 'MOTORCYCLE', weeklyFee: { amount, currencyCode: p.currencyCode, tier: 'courier' } });
    const doc = await system(() => app.prisma.legalDocument.findUniqueOrThrow({ where: { documentType_version_locale: { documentType: 'weekly_fee_acknowledgement', version: 'v1', locale: 'en-GY' } } }));
    expect(doc.renderedText).toBe(V1_TEXT);
    expect(doc.publishedAt).toBeInstanceOf(Date);
  });

  it('phone builds 9-12 (no such field) still become partners, and no fee row is fabricated for them', async () => {
    const c = await customer(2);
    const res = await become(c.token, { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: true });
    expect([200, 201], res.body).toContain(res.statusCode);
    expect((await provisioned(c.id)).rider).not.toBeNull();
    expect(await feeRows(c.id)).toHaveLength(0);
  });

  it('the website must send the tick: without it nothing is provisioned, no role moves, no row is written', async () => {
    const c = await customer(3);
    const res = await becomeFromWeb(c.token, { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: true });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('WEEKLY_FEE_ACK_REQUIRED');
    expect(res.json().error.message).toMatch(/I understand the weekly fee/);
    // [REVIEW-F S4-4] A tab opened before the deploy has no box to tick: the message says how to get one.
    expect(res.json().error.message).toMatch(/reload the page/);
    const after = await provisioned(c.id);
    expect(after.rider).toBeNull();
    expect(after.roles).toEqual(['CUSTOMER']);
    expect(await system(() => app.prisma.consentRecord.count({ where: { subjectId: c.id } }))).toBe(0);

    const p = await priceList();
    const ticked = await becomeFromWeb(c.token, { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: true, weeklyFeeAck: { version: 'v1', amount: moverRate(p, 'MOTORCYCLE'), currencyCode: p.currencyCode } });
    expect([200, 201], ticked.body).toContain(ticked.statusCode);
    expect((await feeRows(c.id)).map((r) => r.surface)).toEqual(['web']);
  });

  it('an amount that is not the server’s quote right now is refused before anything is written, and names the fee to read again', async () => {
    const c = await customer(4);
    const p = await priceList();
    const amount = moverRate(p, 'MOTORCYCLE');
    const stale = await become(c.token, { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: true, weeklyFeeAck: { version: 'v1', amount: amount + 500, currencyCode: p.currencyCode } });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error.code).toBe('WEEKLY_FEE_CHANGED');
    expect(stale.json().error.details).toMatchObject({ amount, currencyCode: p.currencyCode });
    const wrongCurrency = await become(c.token, { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: true, weeklyFeeAck: { version: 'v1', amount, currencyCode: 'USD' } });
    expect(wrongCurrency.statusCode, wrongCurrency.body).toBe(409);
    expect(wrongCurrency.json().error.code).toBe('WEEKLY_FEE_CHANGED');
    const after = await provisioned(c.id);
    expect(after.rider).toBeNull();
    expect(after.roles).toEqual(['CUSTOMER']);
    expect(await system(() => app.prisma.consentRecord.count({ where: { subjectId: c.id } }))).toBe(0);
  });

  it('a tick given to other words (an older or unknown version) is refused before anything is written', async () => {
    const c = await customer(5);
    const p = await priceList();
    const res = await become(c.token, { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: true, weeklyFeeAck: { version: 'v0', amount: moverRate(p, 'MOTORCYCLE'), currencyCode: p.currencyCode } });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('WEEKLY_FEE_TERMS_CHANGED');
    expect((await provisioned(c.id)).rider).toBeNull();
    expect(await system(() => app.prisma.consentRecord.count({ where: { subjectId: c.id } }))).toBe(0);
  });

  it('a malformed tick is refused, never read as "not sent"', async () => {
    const c = await customer(6);
    for (const weeklyFeeAck of [true, 'v1', { version: 'v1' }, { version: 'v1', amount: 0, currencyCode: 'GYD' }]) {
      const res = await become(c.token, { role: 'MOVER', vehicleType: 'MOTORCYCLE', acceptAgreement: true, weeklyFeeAck });
      expect(res.statusCode, `${JSON.stringify(weeklyFeeAck)} ${res.body}`).toBe(400);
    }
    expect((await provisioned(c.id)).rider).toBeNull();
  });

  it('a taxi driver is quoted the taxi rate, and a business its own type’s first rate; each tick is on its own subject', async () => {
    const p = await priceList();
    const driver = await customer(7);
    const car = { make: 'Toyota', model: 'Allion', year: 2018, color: 'Silver', licensePlate: `HB ${NUM}7` };
    const taxiRate = moverRate(p, 'CAR');
    const wrong = await become(driver.token, { role: 'MOVER', vehicleType: 'CAR', vehicle: car, acceptAgreement: true, weeklyFeeAck: { version: 'v1', amount: moverRate(p, 'MOTORCYCLE'), currencyCode: p.currencyCode } });
    if (moverRate(p, 'MOTORCYCLE') !== taxiRate) expect(wrong.json().error?.code, wrong.body).toBe('WEEKLY_FEE_CHANGED');
    const ok = await become(driver.token, { role: 'MOVER', vehicleType: 'CAR', vehicle: car, acceptAgreement: true, weeklyFeeAck: { version: 'v1', amount: taxiRate, currencyCode: p.currencyCode } });
    expect([200, 201], ok.body).toContain(ok.statusCode);
    expect((await feeRows(driver.id))[0]!.evidence).toMatchObject({ kind: 'DRIVER', vehicleType: 'CAR', weeklyFee: { amount: taxiRate, tier: 'taxi' } });

    const service = await customer(8);
    const s = await become(service.token, { role: 'VENDOR', business: store('SERVICE', 8), acceptAgreement: true, weeklyFeeAck: { version: 'v1', amount: p.vendors.service, currencyCode: p.currencyCode } });
    expect([200, 201], s.body).toContain(s.statusCode);
    const serviceRows = await feeRows(service.id);
    expect(serviceRows).toHaveLength(1);
    expect(serviceRows[0]).toMatchObject({ subjectType: 'vendor_user', documentVersion: 'v1' });
    expect(serviceRows[0]!.evidence).toMatchObject({ kind: 'VENDOR', vendorType: 'SERVICE', weeklyFee: { amount: p.vendors.service, tier: 'service' } });

    const shop = await customer(9);
    const first = p.vendors.catalogue[0]!;
    const r = await become(shop.token, { role: 'VENDOR', business: store('RESTAURANT', 9), acceptAgreement: true, weeklyFeeAck: { version: 'v1', amount: first.rate, currencyCode: p.currencyCode } });
    expect([200, 201], r.body).toContain(r.statusCode);
    expect((await feeRows(shop.id))[0]!.evidence).toMatchObject({ kind: 'VENDOR', vendorType: 'RESTAURANT', weeklyFee: { amount: first.rate, tier: first.tier } });
  });
});
