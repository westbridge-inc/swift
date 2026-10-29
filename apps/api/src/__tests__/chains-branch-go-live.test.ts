import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { mapInBatches, vendorRoutes } from '../modules/vendor/vendor.routes';
import { storeGoLive } from '../modules/vendor/go-live';
import { FOOD_HANDLERS_TICK_V1 } from '../modules/vendor/food-handlers';
import { signupQuote, WEEKLY_FEE_ACK_VERSION } from '../modules/partner/weekly-fee-ack';
import { grantStepUp } from './helpers/step-up';
import { wordFreeTag } from './helpers/fixture-ids';
import { purgeFixtureAuditTrail } from './helpers/audit-fixture-purge';

// ---------------------------------------------------------------------------
// [CHAINS PR2 · REVIEW-F #2220 S3-1] A new branch is never told it waits for Swift while the next step is its
// owner's. A store's first go-live needs, from its owner: the documents its type needs, a published number customers
// can call (never the account line) and, for a registered restaurant, the food handlers tick. So:
//  - the add-a-branch form gives them: the number customers can call (required, published as `publicPhone`) and the
//    restaurant's food handlers tick (optional), recorded with the add;
//  - every list of stores says whose turn it is (`goLive`): Swift's only when nothing is owed by the owner, otherwise
//    the owner's steps still to do.
// ---------------------------------------------------------------------------

const DAY = 864e5;
const SUPERMARKET_DOCS = ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'];
const RESTAURANT_DOCS = ['owner_national_id', 'business_registration', 'gra_restaurant_licence', 'storefront_photo'];
const PUBLISHED = '+5926007788';

let app: FastifyInstance;
const marker = nanoid(6).toLowerCase();
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_330_000_000 + Math.floor(Math.random() * 800_000_000);

async function makeOwner(docs: { types: string[]; status: 'APPROVED' | 'PENDING' | 'REJECTED' } | null = { types: SUPERMARKET_DOCS, status: 'APPROVED' }) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Golive', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true, countryCode: 'GY', selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'chains-branch-go-live', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  await grantStepUp(app, token);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  seq += 1;
  const first = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Golive Mart ${seq}`, slug: `golive-mart-${marker}-${seq}`, vendorType: 'SUPERMARKET',
      phone: `+59268${String(seq).padStart(5, '0')}`, addressLine1: '1 Golive St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true, acceptingOrders: true, publicPhone: PUBLISHED,
    },
  });
  if (docs) await documents(user.id, docs.types, docs.status);
  return { userId: user.id, token, ownerId: vo.id, firstId: first.id };
}

async function documents(userId: string, types: readonly string[], status: 'APPROVED' | 'PENDING' | 'REJECTED') {
  for (const docType of types) {
    await app.prisma.verificationDocument.create({
      data: {
        userId, role: 'VENDOR_OWNER' as never, docType, fileUrl: `test/${marker}/${docType}/${nanoid(4)}`,
        status, expiresAt: new Date(Date.now() + 365 * DAY),
      } as never,
    });
  }
}

type Owner = Awaited<ReturnType<typeof makeOwner>>;
const headers = (o: Owner, vendorId?: string) => ({ authorization: `Bearer ${o.token}`, 'content-type': 'application/json', ...(vendorId ? { 'x-vendor-id': vendorId } : {}) });

async function addBranch(o: Owner, over: { vendorType?: string; publicPhone?: unknown; foodHandlers?: unknown } = {}) {
  const vendorType = over.vendorType ?? 'SUPERMARKET';
  const quote = await signupQuote(app.prisma, o.userId, { role: 'VENDOR', vendorType: vendorType as 'SUPERMARKET' });
  const payload: Record<string, unknown> = {
    business: {
      name: `Golive North ${wordFreeTag(6)}`, vendorType, phone: '+5926001234', addressLine1: '2 Golive St', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.14,
    },
    weeklyFeeAck: { version: WEEKLY_FEE_ACK_VERSION, amount: quote.amount, currencyCode: quote.currencyCode },
  };
  if (!('publicPhone' in over)) payload['publicPhone'] = PUBLISHED;
  else if (over.publicPhone !== undefined) payload['publicPhone'] = over.publicPhone;
  if (over.foodHandlers !== undefined) payload['foodHandlers'] = over.foodHandlers;
  return app.inject({ method: 'POST', url: '/api/v1/vendor/stores', payload, headers: headers(o) });
}

const storesList = async (o: Owner) => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/vendor/stores', headers: headers(o) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.stores as Array<{ id: string; awaitingApproval: boolean; goLive: unknown }>;
};
const profileStores = async (o: Owner) => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/vendor/profile', headers: headers(o) });
  expect(res.statusCode, res.body).toBe(200);
  return res.json().data.vendors as Array<{ id: string; goLive: unknown }>;
};
/** The same verdict on both lists the apps read (the phone's switcher: /profile; the website and branch screens: /stores). */
async function goLiveOf(o: Owner, vendorId: string) {
  const fromStores = (await storesList(o)).find((s) => s.id === vendorId)?.goLive;
  const fromProfile = (await profileStores(o)).find((s) => s.id === vendorId)?.goLive;
  expect(fromProfile).toEqual(fromStores);
  return fromStores;
}
const branchCount = (o: Owner) => app.prisma.vendor.count({ where: { ownerId: o.ownerId } });

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 300));
  if (userIds.length > 0) {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    const ids = (await app.prisma.vendor.findMany({ where: { owner: { userId: { in: userIds } } }, select: { id: true } })).map((v) => v.id);
    const subs = await app.prisma.subscription.findMany({ where: { vendorId: { in: ids } }, select: { id: true } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
    await app.prisma.subscription.deleteMany({ where: { vendorId: { in: ids } } });
    await app.prisma.trialGrant.deleteMany({ where: { accountId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await purgeFixtureAuditTrail(app.prisma, userIds, 'chains-branch-go-live');
    await app.prisma.vendor.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('[CHAINS] adding a branch gives what go-live needs from its owner', () => {
  it('the number customers can call is required and published; the branch phone stays the private contact line', async () => {
    const o = await makeOwner();
    for (const [publicPhone, code] of [[undefined, 'VALIDATION_ERROR'], ['', 'PUBLIC_PHONE_REQUIRED'], ['911', 'INVALID_PUBLIC_PHONE']] as const) {
      const res = await addBranch(o, { publicPhone });
      expect(res.statusCode, `${String(publicPhone)}: ${res.body}`).toBe(400);
      expect(res.json().error.code).toBe(code);
    }
    expect(await branchCount(o)).toBe(1);
    const res = await addBranch(o, { publicPhone: '+592 600 7788' });
    expect(res.statusCode, res.body).toBe(201);
    const branch = await app.prisma.vendor.findUniqueOrThrow({ where: { id: res.json().data.id }, select: { publicPhone: true, phone: true, tier: true } });
    expect(branch).toEqual({ publicPhone: PUBLISHED, phone: '+5926001234', tier: 'REGISTERED' });
  });

  it('a restaurant branch\'s food handlers tick comes with the add, on the ledger like the branch\'s own screen records it', async () => {
    const o = await makeOwner();
    const res = await addBranch(o, { vendorType: 'RESTAURANT', foodHandlers: { accept: true, attestationVersion: 'v1' } });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().data.id as string;
    const row = await app.prisma.consentRecord.findFirst({ where: { subjectId: o.userId, documentType: 'food_handler_attestation' } });
    expect(row).toMatchObject({ action: 'granted', documentVersion: 'v1', subjectType: 'vendor_user' });
    expect(row?.evidence).toMatchObject({ vendorId: id, control: 'checkbox', path: 'vendor/stores' });
  });

  it('a food handlers tick for a store that is not a restaurant, or in other words, is refused and nothing is written', async () => {
    const o = await makeOwner();
    const notRestaurant = await addBranch(o, { vendorType: 'SUPERMARKET', foodHandlers: { accept: true, attestationVersion: 'v1' } });
    expect(notRestaurant.statusCode, notRestaurant.body).toBe(409);
    expect(notRestaurant.json().error.code).toBe('FOOD_HANDLERS_NOT_APPLICABLE');
    const otherWords = await addBranch(o, { vendorType: 'RESTAURANT', foodHandlers: { accept: true, attestationVersion: 'v0' } });
    expect(otherWords.statusCode, otherWords.body).toBe(400);
    expect(await branchCount(o)).toBe(1);
    expect(await app.prisma.consentRecord.count({ where: { subjectId: o.userId, documentType: 'food_handler_attestation' } })).toBe(0);
  });

  it('the branch terms carry the food handlers words for a restaurant, and none for another type', async () => {
    const o = await makeOwner();
    const terms = async (vendorType: string) => (await app.inject({ method: 'GET', url: `/api/v1/vendor/stores/branch-terms?vendorType=${vendorType}`, headers: headers(o) })).json().data;
    expect((await terms('RESTAURANT')).foodHandlers).toEqual({ version: 'v1', tick: FOOD_HANDLERS_TICK_V1 });
    expect((await terms('SUPERMARKET')).foodHandlers).toBeNull();
  });
});

describe('[CHAINS] a store not live yet says whose turn it is', () => {
  it('owner\'s part complete: waiting for Swift (a person approves a branch); a live store has no go-live', async () => {
    const o = await makeOwner();
    const id = (await addBranch(o)).json().data.id as string;
    expect(await goLiveOf(o, id)).toEqual({ waitingFor: 'SWIFT', steps: [] });
    expect((await storesList(o)).find((s) => s.id === id)?.awaitingApproval).toBe(true);
    expect(await goLiveOf(o, o.firstId)).toBeNull();
  });

  it('a restaurant branch added without the tick waits for its OWNER (food handlers); the tick hands it to Swift', async () => {
    const o = await makeOwner({ types: [...new Set([...SUPERMARKET_DOCS, ...RESTAURANT_DOCS])], status: 'APPROVED' });
    const id = (await addBranch(o, { vendorType: 'RESTAURANT' })).json().data.id as string;
    expect(await goLiveOf(o, id)).toEqual({ waitingFor: 'OWNER', steps: ['FOOD_HANDLERS'] });
    const tick = await app.inject({ method: 'POST', url: '/api/v1/vendor/onboarding/food-handlers', headers: headers(o, id), payload: { accept: true, attestationVersion: 'v1' } });
    expect(tick.statusCode, tick.body).toBe(201);
    expect(await goLiveOf(o, id)).toEqual({ waitingFor: 'SWIFT', steps: [] });
  });

  it('no number customers can call: the owner\'s step (never the account line)', async () => {
    const o = await makeOwner();
    const id = (await addBranch(o)).json().data.id as string;
    await app.prisma.vendor.update({ where: { id }, data: { publicPhone: null } });
    expect(await goLiveOf(o, id)).toEqual({ waitingFor: 'OWNER', steps: ['PUBLISHED_PHONE'] });
  });

  it('a document never sent or sent back is the owner\'s step; one Swift is still reading is Swift\'s turn', async () => {
    const none = await makeOwner(null);
    const a = (await addBranch(none)).json().data.id as string;
    expect(await goLiveOf(none, a)).toEqual({ waitingFor: 'OWNER', steps: ['DOCUMENTS'] });

    const reading = await makeOwner({ types: SUPERMARKET_DOCS, status: 'PENDING' });
    const b = (await addBranch(reading)).json().data.id as string;
    expect(await goLiveOf(reading, b)).toEqual({ waitingFor: 'SWIFT', steps: [] });

    const sentBack = await makeOwner({ types: SUPERMARKET_DOCS.slice(1), status: 'APPROVED' });
    await documents(sentBack.userId, SUPERMARKET_DOCS.slice(0, 1), 'REJECTED');
    const c = (await addBranch(sentBack)).json().data.id as string;
    await app.prisma.vendor.update({ where: { id: c }, data: { publicPhone: null } });
    expect(await goLiveOf(sentBack, c)).toEqual({ waitingFor: 'OWNER', steps: ['DOCUMENTS', 'PUBLISHED_PHONE'] });
  });
});

describe('[CHAINS] the verdict and the summary reader', () => {
  it('storeGoLive: each owner step, and Swift\'s turn only when there is none', () => {
    const ok = { required: false, attested: false };
    const waiting = { status: 'PENDING_APPROVAL', publicPhone: PUBLISHED };
    expect(storeGoLive(waiting, { documentStates: ['APPROVED', 'PENDING'], foodHandlers: ok })).toEqual({ waitingFor: 'SWIFT', steps: [] });
    for (const state of ['MISSING', 'REJECTED', 'EXPIRED']) {
      expect(storeGoLive(waiting, { documentStates: ['APPROVED', state], foodHandlers: ok }).steps).toEqual(['DOCUMENTS']);
    }
    expect(storeGoLive({ ...waiting, publicPhone: '12' }, { documentStates: [], foodHandlers: ok }).steps).toEqual(['PUBLISHED_PHONE']);
    expect(storeGoLive(waiting, { documentStates: [], foodHandlers: { required: true, attested: false } }).steps).toEqual(['FOOD_HANDLERS']);
    expect(storeGoLive(waiting, { documentStates: [], foodHandlers: { required: true, attested: true } }).waitingFor).toBe('SWIFT');
  });

  it('mapInBatches keeps the order and never runs more than a batch at once', async () => {
    let running = 0;
    let most = 0;
    const out = await mapInBatches([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 5, async (n) => {
      running += 1; most = Math.max(most, running);
      await new Promise((r) => setTimeout(r, 13 - n));
      running -= 1;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(5);
  });
});
