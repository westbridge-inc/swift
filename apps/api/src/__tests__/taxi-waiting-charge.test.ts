import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type OrderStatus, type TaxiStopStatus, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { OrderService } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { CashRulesService, type CashHandoverObserver } from '../modules/cash/cash-rules.service';
import { freezeTaxiWaiting } from '../modules/rides/taxi-waiting';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { LEGACY_GY_TAXI_CARD, pinLegacyGuyanaTaxiCard } from './helpers/legacy-taxi-card';
import { loginWithOtp } from './helpers/otp';
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';

// ---------------------------------------------------------------------------
// [TAXI waiting charge · owner ruling 1 Oct 2026] The charge through the real
// routes, the real completion seam and the database (CONTRACT.md Rev 2 §8).
//
//  - Off (TAXI_WAITING_CHARGE unset, the default): every payload is today's,
//    byte for byte; nothing is written; nothing is charged.
//  - On: the estimate, the capability read and the request answer disclose
//    the terms; the terms are frozen on the ride at booking; the rider's and
//    the driver's active ride show the live wait from the arrival on; "Fare
//    collected" freezes the charge ONCE, inside its commit, into the order's
//    total, the driver's fare earning, the DELIVERED event, the passenger's
//    finished ride and the admin order page.
//  - Never charged: a no-show or a refusal, a ride booked while off, a ride
//    completed while off, waiting at the final destination.
//
// Bartica (no fare zone). Kept fixtures (a failed fare's filing is immutable
// evidence) live in this suite's own retained phone namespace.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
const MIN = 60_000;
const PHONE_PREFIX = retainedPhonePrefix('27');
const FIXTURE = 'taxi-waiting-charge';
const SUPER_ADMIN_PHONE = '+5926001000';

const PICKUP = { lat: 6.406, lng: -58.623 };
const DEST = { lat: 6.418, lng: -58.63 };
const PICKUP_ADDRESS = 'Bartica Police Station';
const DROPOFF_ADDRESS = 'Bartica Airstrip';

/** Today's request answer for PICKUP → DEST on the legacy card, byte for byte
 *  (the same bytes taxi-multistop-request pins, recorded on main). */
const PINNED_SINGLE_LEG_ANSWER = '{"success":true,"data":{"ride":{"id":"<ID>","orderNumber":"<NUMBER>","status":"PENDING","fare":1700,"rideClass":"ECONOMY","currencyCode":"GYD","fareSource":"formula","distanceKm":2,"durationMin":5,"ridePin":"<PIN>","pickupAddress":"Bartica Police Station","dropoffAddress":"Bartica Airstrip"},"message":"Looking for a driver near you…"}}';
/** The contract's §8.2 block for the default terms, byte for byte. */
const DISCLOSED = '{"chargePerBlock":500,"blockMinutes":10,"currencyCode":"GYD","text":"Waiting: 500 per 10 minutes after your driver arrives"}';
const WAIT_KEYS = /"(waiting|fareBreakdown|waitMinutes)"/;

let app: FastifyInstance;
let restoreTaxiCard: () => Promise<void> = async () => {};
let orders: OrderService;
let notifications: NotificationService;
let adminToken = '';
let seq = 0;
let door = 0;
const emitted: { room: string; event: string; payload: unknown }[] = [];
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);
const on = () => vi.stubEnv('TAXI_WAITING_CHARGE', '1');

type Actor = { userId: string; token: string; sessionId: string };
type DriverActor = Actor & { driverId: string };

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Wait', lastName: `U${seq}`, roles, activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2', countryCode: 'GY',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    },
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `wait-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}
const makeCustomer = () => makeUser(['CUSTOMER'], 'CUSTOMER');
async function makeDriver(): Promise<DriverActor> {
  const u = await makeUser(['DRIVER', 'CUSTOMER'], 'DRIVER');
  const driver = await sys(() => app.prisma.driver.create({
    data: {
      userId: u.userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020, vehicleColor: 'Silver',
      licensePlate: `HW ${7000 + seq}`, driverLicenseUrl: 'storage://wait/dl.jpg', vehicleInsuranceUrl: 'storage://wait/ins.jpg',
      documentsVerified: true, isOnline: true, isAvailable: false,
      currentLat: DEST.lat, currentLng: DEST.lng, lastLocationUpdate: new Date(), locationSessionId: u.sessionId,
    },
  }));
  return { ...u, driverId: driver.id };
}

type StopSpec = { status: TaxiStopStatus; arrivedAt?: Date; departedAt?: Date; skippedAt?: Date; skipReason?: string };
interface RideSpec {
  status: OrderStatus;
  driverArrivedAt?: Date | null;
  pickedUpAt?: Date | null;
  /** The terms frozen at booking; false = a ride booked while the switch was off. */
  terms?: { chargePerBlock: number; blockMinutes: number } | false;
  stops?: StopSpec[];
  fare?: number;
}

/** A cash ride in the given state, made directly (the clock is the subject, not the booking). */
async function makeRide(spec: RideSpec) {
  const customer = await makeCustomer();
  const driver = await makeDriver();
  door += 1;
  const drop = { lat: DEST.lat + door * 0.001, lng: DEST.lng - door * 0.001 };
  const fare = spec.fare ?? 2000;
  const stops = spec.stops ?? [];
  const order = await sys(() => app.prisma.order.create({
    data: {
      orderNumber: `WAIT-${nanoid(8)}`, orderType: 'TAXI', customerId: customer.userId, driverId: driver.driverId, status: spec.status,
      pickupAddress: PICKUP_ADDRESS, pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: `${door} Airstrip Road`, deliveryLat: drop.lat, deliveryLng: drop.lng,
      taxiPickupAddress: PICKUP_ADDRESS, taxiDropoffAddress: DROPOFF_ADDRESS,
      subtotalBase: fare, subtotalMarkup: 0, subtotalCustomer: fare, deliveryFee: 0,
      taxiFareTotal: fare, totalAmount: fare, paymentMethod: 'CASH', taxiDuration: 10,
      driverArrivedAt: spec.driverArrivedAt ?? null, pickedUpAt: spec.pickedUpAt ?? null,
      ridePinVerified: spec.pickedUpAt != null, ridePinVerifiedAt: spec.pickedUpAt ?? null,
      ...(spec.terms === false ? {} : {
        taxiRideWaiting: { create: { chargePerBlock: (spec.terms ?? { chargePerBlock: 500 }).chargePerBlock, blockMinutes: (spec.terms ?? { blockMinutes: 10 }).blockMinutes, currencyCode: 'GYD' } },
      }),
      ...(stops.length > 0 ? {
        taxiStopCount: stops.length,
        taxiStops: {
          create: stops.map((s, i) => ({
            sequence: i + 1, lat: 6.41 + i * 0.003, lng: -58.62 - i * 0.003, address: `Stop ${i + 1} ${door}`,
            status: s.status, arrivedAt: s.arrivedAt ?? null, departedAt: s.departedAt ?? null, skippedAt: s.skippedAt ?? null, skipReason: s.skipReason ?? null,
          })),
        },
      } : {}),
    },
  }));
  await sys(() => app.prisma.driver.update({ where: { id: driver.driverId }, data: { currentRideId: order.id } }));
  return { order, customer, driver, drop };
}

function call(method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return app.inject({
    method, url,
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}
const trip = () => ({ pickup: PICKUP, dropoff: DEST, pickupAddress: PICKUP_ADDRESS, dropoffAddress: DROPOFF_ADDRESS, passengerCount: 1, rideClass: 'ECONOMY' });
const paid = (r: Awaited<ReturnType<typeof makeRide>>) => call('POST', `/api/v1/driver/rides/${r.order.id}/handover`, r.driver.token, { outcome: 'paid', gps: r.drop });

/** Everything money about a ride, read back from the database. */
async function money(orderId: string) {
  return sys(async () => {
    const o = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { taxiRideWaiting: true } });
    const fares = await app.prisma.earning.findMany({ where: { orderId, type: 'TAXI_FARE' } });
    const w = o.taxiRideWaiting;
    return {
      status: o.status,
      total: Number(o.totalAmount),
      route: Number(o.taxiFareTotal),
      earnings: fares.map((e) => Number(e.amount)),
      waiting: w ? { seconds: w.waitingSeconds, minutes: w.waitingMinutes, charge: w.waitingCharge == null ? null : Number(w.waitingCharge), frozen: w.frozenAt != null } : null,
    };
  });
}

async function purge() {
  await runWithoutTenant(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (!ids.length) return;
    const driverIds = (await app.prisma.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    const allOids = (await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: ids } }, { driverId: { in: driverIds } }] }, select: { id: true } })).map((o) => o.id);
    await app.prisma.$transaction(async (tx) => {
      const kept = await retainedCohort(tx, { orderIds: allOids });
      const oids = without(allOids, kept.orderIds);
      const goneIds = without(ids, kept.userIds);
      await tx.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: allOids } }, { recipientId: { in: ids } }] } });
      await tx.algoDecision.deleteMany({ where: { subjectId: { in: [...allOids, ...driverIds] } } });
      await tx.dispatchSearch.deleteMany({ where: { subjectId: { in: oids } } });
      if (allOids.length > 0) await tx.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(allOids)})`;
      await tx.notification.deleteMany({ where: { userId: { in: ids } } });
      await tx.reimbursementClaim.deleteMany({ where: { orderId: { in: oids } } });
      await tx.strike.deleteMany({ where: { orderId: { in: oids } } });
      await tx.earning.deleteMany({ where: { orderId: { in: oids } } });
      await tx.checkoutReceipt.deleteMany({ where: { userId: { in: goneIds } } });
      await tx.supplyWatch.deleteMany({ where: { customerId: { in: ids } } });
      await tx.driver.updateMany({ where: { userId: { in: ids } }, data: { currentRideId: null } });
      await tx.order.deleteMany({ where: { id: { in: oids } } });
      await tx.driver.deleteMany({ where: { userId: { in: goneIds } } });
      await tx.session.deleteMany({ where: { userId: { in: ids } } });
      await tx.customer.deleteMany({ where: { userId: { in: goneIds } } });
      await tx.user.deleteMany({ where: { id: { in: goneIds } } });
      await retireKeptScaffolding(tx, kept);
    }, { timeout: 60_000 });
    for (const id of [...ids, ...driverIds, ...allOids]) {
      const keys = [...await app.redis.keys(`dispatch:*${id}*`), ...await app.redis.keys(`*idem:${id}:*`)];
      if (keys.length > 0) await app.redis.del(...keys);
    }
  }, FIXTURE);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['FARE_ZONE_TABLE_KILL'];
  delete process.env['MAPS_PROVIDER'];
  delete process.env['OSRM_URL'];
  delete process.env['DISPATCH_AVAILABILITY'];
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app, true);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();
  orders = new OrderService(app.prisma, app.io);
  notifications = new NotificationService(app.prisma, app.io);
  restoreTaxiCard = await pinLegacyGuyanaTaxiCard(app.prisma);
  await purge();
  const login = await loginWithOtp(app, SUPER_ADMIN_PHONE);
  adminToken = login.json().data.tokens.accessToken;
  const realTo = app.io.to.bind(app.io);
  (app.io as { to: (room: string) => unknown }).to = (room: string) => ({
    emit: (event: string, payload: unknown) => {
      emitted.push({ room, event, payload });
      return realTo(room).emit(event, payload);
    },
  });
});

afterAll(async () => {
  await restoreTaxiCard();
  await purge();
  await app.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ===========================================================================
describe('switched off (the default): every payload is today\'s, nothing is written or charged', () => {
  it('the estimate, the capability read and the request answer are today\'s bytes; no terms row is written', async () => {
    for (const flag of [undefined, '', '0', 'true', 'on']) {
      if (flag !== undefined) vi.stubEnv('TAXI_WAITING_CHARGE', flag);
      const customer = await makeCustomer();
      const caps = await call('GET', '/api/v1/rides/capabilities', customer.token);
      expect(caps.body, String(flag)).toBe('{"success":true,"data":{"maxStops":0}}');
      const estimate = await call('POST', '/api/v1/rides/estimate', customer.token, { pickup: PICKUP, dropoff: DEST });
      expect(estimate.statusCode).toBe(200);
      expect(estimate.body).not.toMatch(WAIT_KEYS);
      const res = await call('POST', '/api/v1/rides/request', customer.token, trip(), { 'idempotency-key': `off-${nanoid(10)}` });
      expect(res.statusCode, res.body).toBe(201);
      const ride = res.json().data.ride as { id: string; orderNumber: string; ridePin: string };
      expect(res.body.replace(ride.id, '<ID>').replace(ride.orderNumber, '<NUMBER>').replace(`"ridePin":"${ride.ridePin}"`, '"ridePin":"<PIN>"')).toBe(PINNED_SINGLE_LEG_ANSWER);
      expect(await sys(() => app.prisma.taxiRideWaiting.count({ where: { orderId: ride.id } }))).toBe(0);
      vi.unstubAllEnvs();
    }
  });

  it('the order row gains no column: the waiting lives beside the ride, so every order payload keeps today\'s keys', () => {
    const order = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Order')!;
    expect(order.fields.filter((f) => f.kind !== 'object' && /wait/i.test(f.name)).map((f) => f.name)).toEqual([]);
  });

  it('the rider\'s and the driver\'s active ride show nothing new, even for a ride whose driver has waited 25 minutes with terms on it', async () => {
    const r = await makeRide({ status: 'DRIVER_ARRIVED', driverArrivedAt: new Date(Date.now() - 25 * MIN) });
    const raw = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: r.order.id } }));
    for (const [url, token] of [['/api/v1/rides/active', r.customer.token], [`/api/v1/rides/${r.order.id}`, r.customer.token], ['/api/v1/driver/rides/active', r.driver.token]] as const) {
      const res = await call('GET', url, token);
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).not.toMatch(WAIT_KEYS);
      // Today's keys, in today's order: the order row's own columns, then the relations the route adds.
      const keys = Object.keys(res.json().data).filter((k) => k in raw);
      expect(keys, url).toEqual(Object.keys(raw).filter((k) => keys.includes(k)));
      expect(Object.keys(res.json().data).filter((k) => !(k in raw)).every((k) => ['driver', 'customer', 'statusHistory'].includes(k)), url).toBe(true);
    }
  });

  it('a ride with terms completed while off is charged nothing: total, earning and event are today\'s; the terms row stays unfrozen', async () => {
    const t = Date.now();
    const r = await makeRide({ status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 60 * MIN), pickedUpAt: new Date(t - 35 * MIN) });
    emitted.length = 0;
    const res = await paid(r);
    expect(res.statusCode, res.body).toBe(200);
    expect(await money(r.order.id)).toEqual({ status: 'DELIVERED', total: 2000, route: 2000, earnings: [2000], waiting: { seconds: null, minutes: null, charge: null, frozen: false } });
    const event = emitted.find((e) => e.event === 'order:status_changed' && (e.payload as { status: string }).status === 'DELIVERED')!.payload as { fare: Record<string, unknown> };
    expect(Object.keys(event.fare)).toEqual(['base', 'perKm', 'perMin', 'surge', 'total']);
    const finished = await call('GET', `/api/v1/rides/${r.order.id}`, r.customer.token);
    expect(finished.body).not.toMatch(WAIT_KEYS);
  });
});

// ===========================================================================
describe('disclosure before booking (CONTRACT §8.2)', () => {
  it('every estimate, with or without stops, carries the terms as its last key: today\'s bytes plus the block', async () => {
    const customer = await makeCustomer();
    const off = await call('POST', '/api/v1/rides/estimate', customer.token, { pickup: PICKUP, dropoff: DEST });
    on();
    const onRes = await call('POST', '/api/v1/rides/estimate', customer.token, { pickup: PICKUP, dropoff: DEST });
    expect(onRes.body).toBe(`${off.body.slice(0, -2)},"waiting":${DISCLOSED}}}`);
    vi.stubEnv('TAXI_MAX_STOPS', '3');
    const withStops = await call('POST', '/api/v1/rides/estimate', customer.token, { pickup: PICKUP, dropoff: DEST, stops: [{ lat: 6.412, lng: -58.618, address: 'Bartica Stelling' }] });
    expect(withStops.statusCode, withStops.body).toBe(200);
    const data = withStops.json().data as Record<string, unknown>;
    expect(Object.keys(data).slice(-3)).toEqual(['maxStops', 'stopCount', 'waiting']);
    expect(JSON.stringify(data['waiting'])).toBe(DISCLOSED);
  });

  it('the capability read tells the app the terms too', async () => {
    const customer = await makeCustomer();
    on();
    expect((await call('GET', '/api/v1/rides/capabilities', customer.token)).body).toBe(`{"success":true,"data":{"maxStops":0,"waiting":${DISCLOSED}}}`);
  });

  it('the request answer carries the frozen terms (today\'s bytes plus the block); a replay answers the same; the terms row is written with the ride', async () => {
    const customer = await makeCustomer();
    on();
    const key = `on-${nanoid(10)}`;
    const res = await call('POST', '/api/v1/rides/request', customer.token, trip(), { 'idempotency-key': key });
    expect(res.statusCode, res.body).toBe(201);
    const ride = res.json().data.ride as { id: string; orderNumber: string; ridePin: string };
    const masked = (body: string) => body.replace(ride.id, '<ID>').replace(ride.orderNumber, '<NUMBER>').replace(`"ridePin":"${ride.ridePin}"`, '"ridePin":"<PIN>"');
    expect(masked(res.body)).toBe(PINNED_SINGLE_LEG_ANSWER.replace('"dropoffAddress":"Bartica Airstrip"}', `"dropoffAddress":"Bartica Airstrip","waiting":${DISCLOSED}}`));
    const replay = await call('POST', '/api/v1/rides/request', customer.token, trip(), { 'idempotency-key': key });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().replayed).toBe(true);
    expect(replay.json().data).toEqual(res.json().data);
    const row = await sys(() => app.prisma.taxiRideWaiting.findUniqueOrThrow({ where: { orderId: ride.id } }));
    expect({ chargePerBlock: Number(row.chargePerBlock), blockMinutes: row.blockMinutes, currencyCode: row.currencyCode, frozenAt: row.frozenAt })
      .toEqual({ chargePerBlock: 500, blockMinutes: 10, currencyCode: 'GYD', frozenAt: null });
    const order = await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: ride.id } }));
    expect(row.tenantId).toBe(order.tenantId);
  });

  it('the rates are the market\'s config: 750 per 15 minutes is disclosed and frozen; a later change of the card never reaches the booked ride', async () => {
    const restore = await sys(() => app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' }, select: { taxiRates: true } }));
    try {
      await sys(() => app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { taxiRates: { ...LEGACY_GY_TAXI_CARD, waitingChargePerBlock: 750, waitingBlockMinutes: 15 } } }));
      on();
      const customer = await makeCustomer();
      const estimate = await call('POST', '/api/v1/rides/estimate', customer.token, { pickup: PICKUP, dropoff: DEST });
      expect(estimate.json().data.waiting).toEqual({ chargePerBlock: 750, blockMinutes: 15, currencyCode: 'GYD', text: 'Waiting: 750 per 15 minutes after your driver arrives' });
      const res = await call('POST', '/api/v1/rides/request', customer.token, trip());
      expect(res.statusCode, res.body).toBe(201);
      const id = res.json().data.ride.id as string;
      expect(res.json().data.ride.waiting).toMatchObject({ chargePerBlock: 750, blockMinutes: 15 });
      await sys(() => app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { taxiRates: restore.taxiRates as Prisma.InputJsonValue } }));
      const row = await sys(() => app.prisma.taxiRideWaiting.findUniqueOrThrow({ where: { orderId: id } }));
      expect({ chargePerBlock: Number(row.chargePerBlock), blockMinutes: row.blockMinutes }).toEqual({ chargePerBlock: 750, blockMinutes: 15 });
      expect(row.termsVersion).toEqual(expect.any(Number));
    } finally {
      await sys(() => app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { taxiRates: restore.taxiRates as Prisma.InputJsonValue } }));
    }
  });
});

// ===========================================================================
describe('live, from the driver\'s arrival on (CONTRACT §8.3)', () => {
  it('at the pickup: the rider and the driver see the same running wait; the next block lands at arrival + 20:00', async () => {
    const arrived = new Date(Date.now() - 13.5 * MIN);
    const r = await makeRide({ status: 'DRIVER_ARRIVED', driverArrivedAt: arrived });
    on();
    const expected = {
      chargePerBlock: 500, blockMinutes: 10, currencyCode: 'GYD',
      pickupWaitMinutes: 13, waitingMinutes: 13, waitingCharge: 500, running: true,
      nextChargeAt: new Date(arrived.getTime() + 20 * MIN).toISOString(),
    };
    for (const [url, token] of [['/api/v1/rides/active', r.customer.token], [`/api/v1/rides/${r.order.id}`, r.customer.token], ['/api/v1/driver/rides/active', r.driver.token]] as const) {
      const data = (await call('GET', url, token)).json().data as Record<string, unknown>;
      expect(data['waiting'], url).toEqual(expected);
      expect(Object.keys(data).at(-1), url).toBe('waiting');
    }
  });

  it('absent before the arrival, and on a ride booked while the switch was off', async () => {
    on();
    const enRoute = await makeRide({ status: 'DRIVER_EN_ROUTE' });
    expect((await call('GET', '/api/v1/rides/active', enRoute.customer.token)).body).not.toMatch(WAIT_KEYS);
    const unbooked = await makeRide({ status: 'DRIVER_ARRIVED', driverArrivedAt: new Date(Date.now() - 25 * MIN), terms: false });
    expect((await call('GET', '/api/v1/rides/active', unbooked.customer.token)).body).not.toMatch(WAIT_KEYS);
    expect((await call('GET', '/api/v1/driver/rides/active', unbooked.driver.token)).body).not.toMatch(WAIT_KEYS);
  });

  it('on a trip with stops: each stop\'s own wait, the closed ones and the one running now, summed with the pickup', async () => {
    const t = Date.now();
    const stop2 = new Date(t - 3.5 * MIN);
    const r = await makeRide({
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 40 * MIN), pickedUpAt: new Date(t - 33 * MIN),
      stops: [
        { status: 'DEPARTED', arrivedAt: new Date(t - 20 * MIN), departedAt: new Date(t - 16 * MIN) },
        { status: 'ARRIVED', arrivedAt: stop2 },
        { status: 'PENDING' },
      ],
    });
    on();
    for (const [url, token] of [['/api/v1/rides/active', r.customer.token], ['/api/v1/driver/rides/active', r.driver.token]] as const) {
      const data = (await call('GET', url, token)).json().data as { stops: Record<string, unknown>[]; nextStopSequence: number; waiting: Record<string, unknown> };
      expect(data.stops.map((s) => s['waitMinutes']), url).toEqual([4, 3, null]);
      expect(data.stops.every((s) => Object.keys(s).at(-1) === 'waitMinutes'), url).toBe(true);
      expect(data.nextStopSequence).toBe(2);
      // 7 min at the pickup + 4 at stop 1 + 3.5 so far at stop 2 = 14.5 min: one block; the second at 20:00 summed.
      expect(data.waiting, url).toEqual({
        chargePerBlock: 500, blockMinutes: 10, currencyCode: 'GYD', pickupWaitMinutes: 7, waitingMinutes: 14, waitingCharge: 500, running: true,
        nextChargeAt: new Date(stop2.getTime() + 9 * MIN).toISOString(),
      });
    }
  });
});

// ===========================================================================
describe('"Fare collected" freezes the charge once, into every money surface (CONTRACT §8.4)', () => {
  it('pickup 7 min + stop 4 min = 11 → 500: the total, the driver\'s earning, the frozen row, the event, the notice, the finished ride and the admin page agree', async () => {
    const t = Date.now();
    const r = await makeRide({
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 40 * MIN), pickedUpAt: new Date(t - 33 * MIN),
      stops: [{ status: 'DEPARTED', arrivedAt: new Date(t - 20 * MIN), departedAt: new Date(t - 16 * MIN) }],
    });
    on();
    emitted.length = 0;
    const res = await paid(r);
    expect(res.statusCode, res.body).toBe(200);
    expect(await money(r.order.id)).toEqual({ status: 'DELIVERED', total: 2500, route: 2000, earnings: [2500], waiting: { seconds: 660, minutes: 11, charge: 500, frozen: true } });
    const breakdown = { routeFare: 2000, waitingMinutes: 11, waitingCharge: 500, total: 2500, currencyCode: 'GYD' };
    const event = emitted.find((e) => e.event === 'order:status_changed' && (e.payload as { status: string }).status === 'DELIVERED')!;
    expect(event.room).toBe(`order:${r.order.id}`);
    expect((event.payload as { fare: { fareBreakdown: unknown } }).fare.fareBreakdown).toEqual(breakdown);
    const notice = await sys(() => app.prisma.notification.findFirstOrThrow({ where: { userId: r.customer.userId, title: 'Ride Complete' } }));
    expect(notice.body).toBe('You have arrived at your destination. Total fare: $2,500 GYD (trip $2,000 + waiting $500).');
    const finished = (await call('GET', `/api/v1/rides/${r.order.id}`, r.customer.token)).json().data as Record<string, unknown>;
    expect(finished['fareBreakdown']).toEqual(breakdown);
    expect(finished['waiting']).toBeUndefined();
    const admin = await call('GET', `/api/v1/admin/orders/${r.order.id}`, adminToken);
    expect(admin.statusCode, admin.body).toBe(200);
    expect(admin.json().data.fareBreakdown).toEqual(breakdown);
  });

  it('replays never add it twice: the repeated outcome, the completion tap and the reconciler change nothing', async () => {
    const t = Date.now();
    const r = await makeRide({ status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 50 * MIN), pickedUpAt: new Date(t - 25 * MIN) });
    on();
    expect((await paid(r)).statusCode).toBe(200);
    const once = await money(r.order.id);
    expect(once).toEqual({ status: 'DELIVERED', total: 3000, route: 2000, earnings: [3000], waiting: { seconds: 1500, minutes: 25, charge: 1000, frozen: true } });
    expect((await paid(r)).statusCode).toBe(200);
    expect((await call('PUT', `/api/v1/driver/rides/${r.order.id}/complete`, r.driver.token, {})).statusCode).toBe(400);
    // What the earnings reconciler runs for an order it sweeps: mints nothing more.
    expect(await sys(() => orders.createEarnings(r.order.id, app.prisma, false))).toEqual([]);
    expect(await money(r.order.id)).toEqual(once);
  });

  it('a crash inside the paid generation freezes nothing and adds nothing; the retry freezes once', async () => {
    const t = Date.now();
    const r = await makeRide({ status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 30 * MIN), pickedUpAt: new Date(t - 18 * MIN) });
    on();
    let armed = true;
    const observer: CashHandoverObserver = { afterTerminalFacts: async () => { if (armed) { armed = false; throw new Error('failpoint: the process died inside the paid generation'); } } };
    const cash = new CashRulesService(app.prisma, notifications, orders, observer);
    await expect(sys(() => cash.handover(r.order.id, r.driver.userId, { outcome: 'paid', gps: r.drop }))).rejects.toThrow(/failpoint/);
    expect(await money(r.order.id)).toEqual({ status: 'RIDE_IN_PROGRESS', total: 2000, route: 2000, earnings: [], waiting: { seconds: null, minutes: null, charge: null, frozen: false } });
    expect((await paid(r)).statusCode).toBe(200);
    expect(await money(r.order.id)).toEqual({ status: 'DELIVERED', total: 2500, route: 2000, earnings: [2500], waiting: { seconds: 720, minutes: 12, charge: 500, frozen: true } });
  });

  it('the freeze answers once: a second freeze of the same ride, in the same transaction, finds it frozen and adds nothing', async () => {
    const t = Date.now();
    const r = await makeRide({ status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 30 * MIN), pickedUpAt: new Date(t - 15 * MIN) });
    on();
    const answers = await sys(() => app.prisma.$transaction(async (tx) => {
      const source = await tx.order.findUniqueOrThrow({ where: { id: r.order.id } });
      const first = await freezeTaxiWaiting(tx, source, new Date());
      const second = await freezeTaxiWaiting(tx, source, new Date(Date.now() + 1000));
      throw Object.assign(new Error('rollback'), { answers: { first, second } });
    }).catch((e: { answers?: unknown }) => e.answers));
    expect(answers).toEqual({ first: { waitingSeconds: 900, waitingMinutes: 15, waitingCharge: 500 }, second: null });
  });

  const edge: Array<[string, number, number, number]> = [
    ['exactly 10:00', 600, 500, 10],
    ['9:59', 599, 0, 9],
    ['19:59', 1199, 500, 19],
    ['clock skew (the start reads before the arrival)', -300, 0, 0],
  ];
  it.each(edge)('a single-leg ride\'s pickup wait of %s: frozen as the rule says', async (_label, seconds, charge, minutes) => {
    const started = new Date(Date.now() - 30 * MIN);
    const r = await makeRide({ status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(started.getTime() - seconds * 1000), pickedUpAt: started });
    on();
    expect((await paid(r)).statusCode).toBe(200);
    expect(await money(r.order.id)).toEqual({
      status: 'DELIVERED', total: 2000 + charge, route: 2000, earnings: [2000 + charge],
      waiting: { seconds: Math.max(0, seconds), minutes, charge, frozen: true },
    });
  });

  it('a stop skipped after arriving counts its arrival → skip; one skipped before arriving counts nothing', async () => {
    const t = Date.now();
    const r = await makeRide({
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 50 * MIN), pickedUpAt: new Date(t - 50 * MIN),
      stops: [
        { status: 'SKIPPED', arrivedAt: new Date(t - 40 * MIN), skippedAt: new Date(t - 28 * MIN), skipReason: 'The passenger changed their mind' },
        { status: 'SKIPPED', skippedAt: new Date(t - 20 * MIN), skipReason: 'The road was closed' },
      ],
    });
    on();
    expect((await paid(r)).statusCode).toBe(200);
    expect((await money(r.order.id)).waiting).toEqual({ seconds: 720, minutes: 12, charge: 500, frozen: true });
  });

  it('waiting at the final destination is never counted: an hour between the last departure and "Fare collected" adds nothing', async () => {
    const t = Date.now();
    const r = await makeRide({
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 120 * MIN), pickedUpAt: new Date(t - 117 * MIN),
      stops: [{ status: 'DEPARTED', arrivedAt: new Date(t - 100 * MIN), departedAt: new Date(t - 98 * MIN) }],
    });
    on();
    expect((await paid(r)).statusCode).toBe(200);
    expect(await money(r.order.id)).toMatchObject({ total: 2000, earnings: [2000], waiting: { seconds: 300, minutes: 5, charge: 0, frozen: true } });
  });

  it('a stop still open refuses the close (409 STOPS_REMAINING) and freezes nothing', async () => {
    const t = Date.now();
    const r = await makeRide({
      status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 40 * MIN), pickedUpAt: new Date(t - 20 * MIN),
      stops: [{ status: 'ARRIVED', arrivedAt: new Date(t - 15 * MIN) }],
    });
    on();
    const res = await paid(r);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('STOPS_REMAINING');
    expect(await money(r.order.id)).toEqual({ status: 'RIDE_IN_PROGRESS', total: 2000, route: 2000, earnings: [], waiting: { seconds: null, minutes: null, charge: null, frozen: false } });
  });

  it('a ride booked while the switch was off is never charged, even when it completes with the switch on', async () => {
    const t = Date.now();
    const r = await makeRide({ status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 60 * MIN), pickedUpAt: new Date(t - 30 * MIN), terms: false });
    on();
    expect((await paid(r)).statusCode).toBe(200);
    expect(await money(r.order.id)).toEqual({ status: 'DELIVERED', total: 2000, route: 2000, earnings: [2000], waiting: null });
    expect((await call('GET', `/api/v1/rides/${r.order.id}`, r.customer.token)).body).not.toMatch(WAIT_KEYS);
  });

  it.each(['no_show', 'refused'] as const)('%s after a 25-minute wait: FAILED, nothing frozen, nothing added, the claim is the route fare', async (outcome) => {
    const t = Date.now();
    const r = await makeRide({ status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 45 * MIN), pickedUpAt: new Date(t - 20 * MIN) });
    on();
    const res = await call('POST', `/api/v1/driver/rides/${r.order.id}/handover`, r.driver.token, { outcome, gps: r.drop });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.claim).toMatchObject({ amount: 2000 });
    expect(await money(r.order.id)).toEqual({ status: 'FAILED', total: 2000, route: 2000, earnings: [], waiting: { seconds: null, minutes: null, charge: null, frozen: false } });
    expect((await call('GET', `/api/v1/rides/${r.order.id}`, r.customer.token)).body).not.toMatch(WAIT_KEYS);
  });
});

// ===========================================================================
describe('the database holds the rule (taxi_ride_waiting)', () => {
  it('the terms never change once written; a frozen charge never changes again', async () => {
    const t = Date.now();
    const r = await makeRide({ status: 'RIDE_IN_PROGRESS', driverArrivedAt: new Date(t - 30 * MIN), pickedUpAt: new Date(t - 20 * MIN) });
    await expect(sys(() => app.prisma.taxiRideWaiting.update({ where: { orderId: r.order.id }, data: { chargePerBlock: 100 } }))).rejects.toThrow(/frozen/);
    await expect(sys(() => app.prisma.taxiRideWaiting.update({ where: { orderId: r.order.id }, data: { blockMinutes: 30 } }))).rejects.toThrow(/frozen/);
    on();
    expect((await paid(r)).statusCode).toBe(200);
    await expect(sys(() => app.prisma.taxiRideWaiting.update({ where: { orderId: r.order.id }, data: { waitingSeconds: 0, waitingMinutes: 0, waitingCharge: 0 } }))).rejects.toThrow(/frozen at completion/);
    await expect(sys(() => app.prisma.taxiRideWaiting.update({ where: { orderId: r.order.id }, data: { frozenAt: new Date() } }))).rejects.toThrow(/frozen at completion/);
    expect((await money(r.order.id)).waiting).toEqual({ seconds: 600, minutes: 10, charge: 500, frozen: true });
  });

  it('a charge that disagrees with its own seconds and terms cannot be written; the frozen facts come together or not at all', async () => {
    const r = await makeRide({ status: 'RIDE_IN_PROGRESS', terms: false });
    const base = { orderId: r.order.id, chargePerBlock: 500, blockMinutes: 10, currencyCode: 'GYD' };
    const frozenAt = new Date();
    for (const bad of [
      { waitingSeconds: 600, waitingMinutes: 10, waitingCharge: 0, frozenAt },     // a block earned, nothing charged
      { waitingSeconds: 599, waitingMinutes: 9, waitingCharge: 500, frozenAt },    // rounded up, not floored
      { waitingSeconds: 1200, waitingMinutes: 20, waitingCharge: 500, frozenAt },  // half the charge
      { waitingSeconds: 600, waitingMinutes: 9, waitingCharge: 500, frozenAt },    // minutes not of the seconds
      { waitingSeconds: -60, waitingMinutes: -1, waitingCharge: 0, frozenAt },     // negative
      { waitingSeconds: 600, waitingMinutes: 10, waitingCharge: 500 },             // facts without the freeze
      { frozenAt },                                                                // a freeze without facts
    ]) {
      await expect(sys(() => app.prisma.taxiRideWaiting.create({ data: { ...base, ...bad } })), JSON.stringify(bad)).rejects.toThrow();
    }
    for (const bad of [{ chargePerBlock: -1 }, { chargePerBlock: 10.5 }, { blockMinutes: 0 }, { blockMinutes: 1441 }, { currencyCode: 'gyd' }]) {
      await expect(sys(() => app.prisma.taxiRideWaiting.create({ data: { ...base, ...bad } })), JSON.stringify(bad)).rejects.toThrow();
    }
    const ok = await sys(() => app.prisma.taxiRideWaiting.create({ data: { ...base, waitingSeconds: 1199, waitingMinutes: 19, waitingCharge: 500, frozenAt } }));
    expect(Number(ok.waitingCharge)).toBe(500);
  });

  it('a ride\'s waiting goes with the ride', async () => {
    const r = await makeRide({ status: 'DRIVER_ASSIGNED' });
    await sys(() => app.prisma.driver.update({ where: { id: r.driver.driverId }, data: { currentRideId: null } }));
    await sys(() => app.prisma.order.delete({ where: { id: r.order.id } }));
    expect(await sys(() => app.prisma.taxiRideWaiting.count({ where: { orderId: r.order.id } }))).toBe(0);
  });
});
