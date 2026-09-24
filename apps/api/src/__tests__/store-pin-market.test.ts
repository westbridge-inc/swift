import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { STORE_PIN_OUT_OF_MARKET } from '../modules/vendor/store-pin';

// ---------------------------------------------------------------------------
// [Q8] Owner report: a store must not simply take the spot its owner signed up
// from. The app now has the owner place and confirm the pin on a map; this is
// the server half. The pin is where riders and customers are sent and what
// decides which shoppers see the store as nearby, so both writers of store
// coordinates refuse a pin outside every launch market with a named 400, and
// write nothing when they do:
//
//   POST /partner/become  (a new store)
//   PUT  /vendor/profile  (a store moving its pin)
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
// Unique phone prefix per file (parallel-test gotcha): +592007183xx.
const PHONE_PREFIX = '+592007183';

let app: FastifyInstance;
const createdUserIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: 'Pin',
      lastName: `Owner${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      avatar: '/uploads/avatars/pin.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      authMethod: 'OTP',
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'store-pin-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

const GEORGETOWN = { latitude: 6.8013, longitude: -58.1551 };

function business(pin: { latitude: number; longitude: number }) {
  return {
    name: 'Pin Test Roti Shop',
    vendorType: 'RESTAURANT',
    phone: '+5926001834',
    addressLine1: '12 Regent Street',
    city: 'Georgetown',
    ...pin,
  };
}

function become(token: string, pin: { latitude: number; longitude: number }) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/partner/become',
    payload: { acceptAgreement: true, role: 'VENDOR', business: business(pin) },
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

function putProfile(token: string, vendorId: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'PUT',
    url: '/api/v1/vendor/profile',
    payload,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-vendor-id': vendorId },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  // A rerun after an interrupted run starts from nothing.
  await app.prisma.user.deleteMany({ where: { phone: { startsWith: PHONE_PREFIX } } });
});

afterAll(async () => {
  // Deleting the account cascades its owner row, its store and its sessions.
  if (createdUserIds.length > 0) await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('a new store is created only at a pin inside the market', () => {
  it.each([
    ['a phone that signed up abroad (New York)', { latitude: 40.7128, longitude: -74.006 }],
    ['a 0,0 fix', { latitude: 0, longitude: 0 }],
    ['Port of Spain', { latitude: 10.6596, longitude: -61.5089 }],
    ['Paramaribo', { latitude: 5.852, longitude: -55.2038 }],
  ])('%s is refused with a named 400, and nothing is created', async (_where, pin) => {
    const newcomer = await makeUser(['CUSTOMER'], 'CUSTOMER');

    const res = await become(newcomer.token, pin);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(STORE_PIN_OUT_OF_MARKET);
    expect(res.json().error.message).toMatch(/outside Guyana/);
    expect(await app.prisma.vendorOwner.count({ where: { userId: newcomer.userId } })).toBe(0);
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: newcomer.userId }, select: { roles: true, activeRole: true } });
    expect(user.roles).not.toContain('VENDOR_OWNER');
    expect(user.activeRole).toBe('CUSTOMER');
  });

  it('control: a store in a border town (Lethem, on the Takutu) is created at exactly its pin', async () => {
    const newcomer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const lethem = { latitude: 3.3803, longitude: -59.7968 };

    const res = await become(newcomer.token, lethem);

    expect(res.statusCode).toBe(201);
    const vendor = await app.prisma.vendor.findFirstOrThrow({ where: { owner: { userId: newcomer.userId } } });
    expect({ latitude: vendor.latitude, longitude: vendor.longitude }).toEqual(lethem);
  });
});

describe('a store moves its pin only to a spot inside the market', () => {
  async function storeAtGeorgetown() {
    const owner = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const created = await become(owner.token, GEORGETOWN);
    expect(created.statusCode).toBe(201);
    const vendor = await app.prisma.vendor.findFirstOrThrow({ where: { owner: { userId: owner.userId } } });
    return { token: owner.token, vendorId: vendor.id };
  }

  async function pinOf(vendorId: string) {
    const v = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { latitude: true, longitude: true } });
    return { latitude: v.latitude, longitude: v.longitude };
  }

  it('a pin moved out of the market is refused with the same named 400, and the store stays put', async () => {
    const store = await storeAtGeorgetown();

    const res = await putProfile(store.token, store.vendorId, { latitude: 40.7128, longitude: -74.006 });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(STORE_PIN_OUT_OF_MARKET);
    expect(await pinOf(store.vendorId)).toEqual(GEORGETOWN);
  });

  it('half a pin is refused: latitude and longitude travel together', async () => {
    const store = await storeAtGeorgetown();

    const onlyLatitude = await putProfile(store.token, store.vendorId, { latitude: 6.9 });
    const onlyLongitude = await putProfile(store.token, store.vendorId, { longitude: -58.2 });

    expect(onlyLatitude.statusCode).toBe(400);
    expect(onlyLatitude.json().error.code).toBe('VALIDATION_ERROR');
    expect(onlyLongitude.statusCode).toBe(400);
    expect(onlyLongitude.json().error.code).toBe('VALIDATION_ERROR');
    expect(await pinOf(store.vendorId)).toEqual(GEORGETOWN);
  });

  it('control: a pin moved within the market is saved, and the profile read returns it', async () => {
    const store = await storeAtGeorgetown();
    const entrance = { latitude: 6.8102, longitude: -58.1623 };

    const res = await putProfile(store.token, store.vendorId, entrance);

    expect(res.statusCode).toBe(200);
    expect(await pinOf(store.vendorId)).toEqual(entrance);
  });

  it('control: an edit that does not touch the pin is untouched by the pin rule', async () => {
    const store = await storeAtGeorgetown();

    const res = await putProfile(store.token, store.vendorId, { description: 'Roti, curry and dhal puri.' });

    expect(res.statusCode).toBe(200);
    expect(await pinOf(store.vendorId)).toEqual(GEORGETOWN);
  });
});
