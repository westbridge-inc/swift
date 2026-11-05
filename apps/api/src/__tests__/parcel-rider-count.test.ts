import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import courierRoutes from '../modules/courier/courier.routes';
import { DISPATCH_WIDEST_RADIUS_KM } from '../modules/dispatch/dispatch.service';
import { assertParcelHasRiders, ridersOnlineNear } from '../modules/dispatch/delivery-capacity';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [FULL-LAUNCH 5 Nov 2026] A parcel with no rider anywhere near was taken, told "still looking", and cancelled up to
// 75 minutes later. Same flag as the store gate: with no rider who could ever be offered it, the sender is told at the
// door and nothing is written. A busy rider counts (a parcel can wait for one), and so does a rider out at the last
// round of the search. Fixtures sit in a far southern cell of their own, moved per case.
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase();
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'parcel-rider-count-fixture');
const DAY = 86_400_000;
const cell = (k: number) => ({ lat: 1.5 + k * 0.5, lng: -58.2 });
const metersNorth = (at: { lat: number; lng: number }, m: number) => at.lat + m / 111_000;

let app: FastifyInstance;
const userIds: string[] = [];
const riderIds: string[] = [];

type Actor = { userId: string; token: string; sessionId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Parcel', lastName: `P${RUN}`, roles, activeRole, status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `pr-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

async function rider(at: { lat: number; lng: number }, meters: number, o: { riderType?: 'DELIVERY' | 'COURIER' | 'BOTH'; busy?: boolean; online?: boolean; vehicleType?: 'BICYCLE' | 'MOTORCYCLE' } = {}) {
  const u = await makeUser(['RIDER'], 'RIDER');
  const row = await sys(() => app.prisma.rider.create({
    data: {
      userId: u.userId, riderType: o.riderType ?? 'BOTH', vehicleType: o.vehicleType ?? 'MOTORCYCLE', documentsVerified: true, floatLimit: 8_000,
      isOnline: o.online ?? true, isAvailable: !o.busy, locationSessionId: u.sessionId, currentLat: metersNorth(at, meters), currentLng: at.lng, lastLocationUpdate: new Date(), acceptanceRate: 50,
    },
  }));
  riderIds.push(row.id);
}

const parcel = (at: { lat: number; lng: number }, packageSize = 'SMALL') => ({
  pickup: at, dropoff: { lat: at.lat + 0.02, lng: at.lng }, pickupAddress: '12 Sender Street', dropoffAddress: '34 Recipient Avenue',
  packageSize, packageDescription: 'A box of spare parts', speed: 'STANDARD', recipientName: 'Test Recipient', recipientPhone: '+5926001234', payer: 'SENDER',
});
const send = (c: Actor, body: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/api/v1/courier/order', payload: body,
  headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' },
});
const orders = (c: Actor) => sys(() => app.prisma.order.count({ where: { customerId: c.userId } }));

const NO_RIDERS = 'No riders are online near your pickup right now — try sending your parcel again later.';

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();
}, 120_000);

afterEach(async () => {
  delete process.env['DISPATCH_AVAILABILITY'];
  delete process.env['DELIVERY_BLOCK_ON_NONE'];
  await sys(() => app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { isOnline: false } }));
});

afterAll(async () => {
  await sys(async () => {
    const rows = await app.prisma.order.findMany({ where: { customerId: { in: userIds } }, select: { id: true } });
    const ids = rows.map((o) => o.id);
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { id: { in: ids } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });
  await app.close();
}, 120_000);

describe('[FULL-LAUNCH] a parcel and the riders online', () => {
  it('nobody online: refused in the server’s words, the code the apps know, nothing written', async () => {
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const res = await send(c, parcel(cell(1)));
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'DELIVERY_NO_RIDERS', message: NO_RIDERS });
    expect(res.json().error.details).toMatchObject({ reason: 'NO_RIDERS' });
    expect(res.body).not.toMatch(/Pickup/);
    expect(await orders(c)).toBe(0);
  });

  it('a rider near: the parcel is taken', async () => {
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const at = cell(2);
    await rider(at, 1_000);
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await send(c, parcel(at))).statusCode).toBe(201);
    expect(await orders(c)).toBe(1);
  });

  it('a rider busy with a job still counts: a parcel can wait for one', async () => {
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const at = cell(3);
    await rider(at, 1_000, { busy: true });
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await send(c, parcel(at))).statusCode).toBe(201);
  });

  it('the widest search counts: inside its last round the parcel is taken, past it refused', async () => {
    process.env['DISPATCH_AVAILABILITY'] = '1';
    expect(DISPATCH_WIDEST_RADIUS_KM).toBe(15);
    const inside = cell(4);
    await rider(inside, 14_000);
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await send(c, parcel(inside))).statusCode).toBe(201);
    const past = cell(5);
    await rider(past, 16_000);
    expect((await send(c, parcel(past))).statusCode).toBe(409);
  });

  it('only a rider who serves parcels counts, as dispatch offers them: a DELIVERY-only rider does not', async () => {
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const at = cell(6);
    await rider(at, 1_000, { riderType: 'DELIVERY' });
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await send(c, parcel(at))).statusCode).toBe(409);
    await rider(at, 1_200, { riderType: 'COURIER' });
    expect((await send(c, parcel(at))).statusCode).toBe(201);
  });

  it('only a vehicle that can carry this size counts', async () => {
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const at = cell(7);
    await rider(at, 1_000, { vehicleType: 'BICYCLE' });
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await send(c, parcel(at, 'LARGE'))).statusCode).toBe(409);
    expect((await send(c, parcel(at, 'SMALL'))).statusCode).toBe(201);
  });

  it('an offline rider does not count', async () => {
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const at = cell(8);
    await rider(at, 1_000, { online: false });
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await send(c, parcel(at))).statusCode).toBe(409);
  });

  it('flag off, or the gate turned off: as before, the parcel is taken', async () => {
    const c = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await send(c, parcel(cell(9)))).statusCode).toBe(201);
    process.env['DISPATCH_AVAILABILITY'] = '1';
    process.env['DELIVERY_BLOCK_ON_NONE'] = '0';
    expect((await send(c, parcel(cell(9)))).statusCode).toBe(201);
  });

  it('store delivery counts as it did: a courier-only rider is not a delivery rider', async () => {
    const at = cell(11);
    await rider(at, 1_000, { riderType: 'COURIER' });
    const count = () => sys(() => ridersOnlineNear(app.prisma, at, null, 'SMALL', 90));
    expect(await count()).toBe(0);
    await rider(at, 1_200, { riderType: 'DELIVERY' });
    expect(await count()).toBe(1);
  });

  it('a read that fails says nothing: the parcel goes ahead', async () => {
    process.env['DISPATCH_AVAILABILITY'] = '1';
    const broken = { $queryRaw: async () => { throw new Error('read failed'); } } as unknown as FastifyInstance['prisma'];
    await expect(assertParcelHasRiders(broken, cell(10), null, 'SMALL', 90, 15)).resolves.toBeUndefined();
  });
});
