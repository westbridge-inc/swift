import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { authRoutes } from '../modules/auth/auth.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { requestOtp } from './helpers/otp';
import { syntheticLocationOwner } from './helpers/online-mover';

// Unique phone prefix per file (parallel-test gotcha).
const BIKE_PHONE = '+59200199001';
const CAR_PHONE = '+59200199002';
const VENDOR_PHONE = '+59200199003';
const BUS_PHONE = '+59200199004';
const WAGON_PHONE = '+59200199005';
const RACE_PHONE = '+59200199006';

let app: FastifyInstance;
let bikeToken = '';
let carToken = '';
let vendorToken = '';
let busToken = '';
let wagonToken = '';
let raceToken = '';

async function cleanup() {
  await app.prisma.user.deleteMany({ where: { phone: { in: [BIKE_PHONE, CAR_PHONE, VENDOR_PHONE, BUS_PHONE, WAGON_PHONE, RACE_PHONE] } } });
}

async function signupCustomer(phone: string): Promise<string> {
  const code = await requestOtp(app, phone);
  await app.inject({
    method: 'POST',
    url: '/api/v1/auth/verify-otp',
    payload: { phone, code },
    headers: { 'content-type': 'application/json' },
  });
  const reg = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { phone, firstName: 'Test', lastName: 'Partner', countryCode: 'GY', role: 'CUSTOMER', acceptTerms: true },
    headers: { 'content-type': 'application/json' },
  });
  return JSON.parse(reg.body).data.tokens.accessToken;
}

function post(url: string, payload: unknown, token?: string) {
  return app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}
function get(url: string, token: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
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
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.ready();

  await cleanup();
  for (const p of [BIKE_PHONE, CAR_PHONE, VENDOR_PHONE, BUS_PHONE, WAGON_PHONE, RACE_PHONE]) {
    await app.redis.del(`otp:${p}`, `otp_rate:${p}`, `otp_attempt:${p}`, `otp_verified:${p}`);
  }
  bikeToken = await signupCustomer(BIKE_PHONE);
  carToken = await signupCustomer(CAR_PHONE);
  vendorToken = await signupCustomer(VENDOR_PHONE);
  busToken = await signupCustomer(BUS_PHONE);
  wagonToken = await signupCustomer(WAGON_PHONE);
  raceToken = await signupCustomer(RACE_PHONE);
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

describe('partner provisioning — failure paths', () => {
  it('rejects unauthenticated /become', async () => {
    const res = await post('/api/v1/partner/become', { role: 'MOVER', vehicleType: 'BICYCLE' });
    expect(res.statusCode).toBe(401);
  });

  it('a fresh customer is FORBIDDEN on /driver before provisioning', async () => {
    // Sharpened by the authz matrix: an account without the MOVER role is an
    // outsider — 403, not a 404 oracle. (After /partner/become grants the role,
    // a missing profile is a real 404.)
    const res = await get('/api/v1/driver/profile', carToken);
    expect(res.statusCode).toBe(403);
  });

  it('rejects a car driver with no vehicle details', async () => {
    const res = await post('/api/v1/partner/become', { role: 'MOVER', vehicleType: 'CAR' }, carToken);
    expect(res.statusCode).toBe(400);
  });
});

describe('partner provisioning — happy paths', () => {
  it('provisions a Driver with vehicle details and unblocks /driver', async () => {
    const res = await post(
      '/api/v1/partner/become',
      { role: 'MOVER', vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Allion', year: 2018, color: 'Silver', licensePlate: 'PXX 1234' } },
      carToken,
    );
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.kind).toBe('DRIVER');
    const profile = await get('/api/v1/driver/profile', carToken);
    expect(profile.statusCode).toBe(200);
  });

  it('is idempotent — re-provisioning a Driver returns 200, no duplicate', async () => {
    const res = await post(
      '/api/v1/partner/become',
      { role: 'MOVER', vehicleType: 'CAR', vehicle: { make: 'Toyota', model: 'Allion', year: 2018, color: 'Silver', licensePlate: 'PXX 1234' } },
      carToken,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.created).toBe(false);
    const count = await app.prisma.driver.count({ where: { user: { phone: CAR_PHONE } } });
    expect(count).toBe(1);
  });

  it('provisions a Rider for a bike mover and unblocks /rider', async () => {
    const res = await post('/api/v1/partner/become', { role: 'MOVER', vehicleType: 'BICYCLE' }, bikeToken);
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.kind).toBe('RIDER');
    const profile = await get('/api/v1/rider/profile', bikeToken);
    expect(profile.statusCode).toBe(200);
  });

  it('provisions a GROUP Driver for a bus mover — passenger runs', async () => {
    const res = await post(
      '/api/v1/partner/become',
      { role: 'MOVER', vehicleType: 'BUS_15', vehicle: { make: 'Toyota', model: 'Coaster', year: 2019, color: 'White', licensePlate: 'BXX 5150' } },
      busToken,
    );
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.kind).toBe('DRIVER');
    const driver = await app.prisma.driver.findFirst({ where: { user: { phone: BUS_PHONE } } });
    expect(driver?.rideClass).toBe('GROUP');
    expect(driver?.vehicleType).toBe('BUS_15'); // drives the commercial doc checklist + hire gate
  });

  it('provisions a COMFORT Driver for a wagon mover', async () => {
    const res = await post(
      '/api/v1/partner/become',
      { role: 'MOVER', vehicleType: 'WAGON_CAR', vehicle: { make: 'Toyota', model: 'Fielder', year: 2017, color: 'Grey', licensePlate: 'WXX 7777' } },
      wagonToken,
    );
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.kind).toBe('DRIVER');
    const driver = await app.prisma.driver.findFirst({ where: { user: { phone: WAGON_PHONE } } });
    expect(driver?.rideClass).toBe('COMFORT');
    expect(driver?.vehicleType).toBe('WAGON_CAR');
  });

  it('appends MOVER + RIDER roles exactly once', async () => {
    await post('/api/v1/partner/become', { role: 'MOVER', vehicleType: 'BICYCLE' }, bikeToken);
    const user = await app.prisma.user.findUnique({ where: { phone: BIKE_PHONE }, select: { roles: true, activeRole: true } });
    expect(user?.roles.filter((r) => r === 'MOVER')).toHaveLength(1);
    expect(user?.roles).toContain('RIDER');
    expect(user?.activeRole).toBe('RIDER');
  });

  it('serializes concurrent identical and mixed partner joins without duplicate profiles or lost roles', async () => {
    const bicycleResponses = await Promise.all(
      Array.from({ length: 8 }, () => post(
        '/api/v1/partner/become',
        { role: 'MOVER', vehicleType: 'BICYCLE' },
        raceToken,
      )),
    );
    expect(bicycleResponses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(bicycleResponses.every((response) => [200, 201].includes(response.statusCode))).toBe(true);
    expect(bicycleResponses.map((response) => JSON.parse(response.body).data.id))
      .toEqual(Array(8).fill(JSON.parse(bicycleResponses[0]!.body).data.id));

    const mixed = await Promise.all([
      post('/api/v1/partner/become', { role: 'MOVER', vehicleType: 'BICYCLE' }, raceToken),
      post('/api/v1/partner/become', {
        role: 'MOVER',
        vehicleType: 'CAR',
        vehicle: { make: 'Toyota', model: 'Axio', year: 2020, color: 'White', licensePlate: 'RACE 100' },
      }, raceToken),
    ]);
    expect(mixed.every((response) => [200, 201].includes(response.statusCode))).toBe(true);

    const business = {
      name: 'Race Provision Store',
      vendorType: 'STORE',
      phone: '+5926007777',
      addressLine1: '7 Serial Lane',
      city: 'Georgetown',
      latitude: 6.8013,
      longitude: -58.1551,
    };
    const vendorResponses = await Promise.all(
      Array.from({ length: 8 }, () => post(
        '/api/v1/partner/become',
        { role: 'VENDOR', business },
        raceToken,
      )),
    );
    expect(vendorResponses.filter((response) => response.statusCode === 201)).toHaveLength(1);
    expect(vendorResponses.every((response) => [200, 201].includes(response.statusCode))).toBe(true);

    const user = await app.prisma.user.findUniqueOrThrow({
      where: { phone: RACE_PHONE },
      select: {
        roles: true,
        rider: { select: { floatLimit: true } },
        driver: { select: { id: true } },
        vendorOwner: { select: { vendors: { select: { id: true } } } },
      },
    });
    for (const role of ['CUSTOMER', 'MOVER', 'RIDER', 'DRIVER', 'VENDOR_OWNER'] as const) {
      expect(user.roles.filter((candidate) => candidate === role)).toHaveLength(1);
    }
    expect(user.rider).not.toBeNull();
    expect(Number(user.rider!.floatLimit)).toBeGreaterThan(0);
    expect(user.driver).not.toBeNull();
    expect(user.vendorOwner?.vendors).toHaveLength(1);
  });

  it('customer → join mover activates server authority so verified GO succeeds', async () => {
    const user = await app.prisma.user.findUniqueOrThrow({ where: { phone: BIKE_PHONE } });
    await app.prisma.user.update({ where: { id: user.id }, data: { selfieCapturedAt: new Date() } });
    const rider = await app.prisma.rider.update({
      where: { userId: user.id },
      data: { documentsVerified: true, isOnline: false, isAvailable: false },
    });

    const online = await post('/api/v1/rider/go-online', {
      latitude: 6.8013,
      longitude: -58.1551,
    }, bikeToken);
    expect(online.statusCode).toBe(200);
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(after.isOnline).toBe(true);

    await app.prisma.rider.update({
      where: { id: rider.id },
      data: { isOnline: false, isAvailable: false },
    });
  });

  it('cannot provision-switch an active mover into Business and maroon the job', async () => {
    const user = await app.prisma.user.findUniqueOrThrow({ where: { phone: BIKE_PHONE } });
    const rider = await app.prisma.rider.update({
      where: { userId: user.id },
      data: { isOnline: true, isAvailable: false, currentOrderId: 'partner-active-job', locationSessionId: syntheticLocationOwner('partner') },
    });
    const blocked = await post('/api/v1/partner/become', {
      role: 'VENDOR',
      business: {
        name: 'Mover Side Store',
        vendorType: 'STORE',
        phone: '+5926001234',
        addressLine1: '1 Authority Street',
        city: 'Georgetown',
        latitude: 6.8013,
        longitude: -58.1551,
      },
    }, bikeToken);
    expect(blocked.statusCode).toBe(409);
    const [afterUser, afterRider] = await Promise.all([
      app.prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } }),
    ]);
    expect(afterUser.activeRole).toBe('RIDER');
    expect(afterRider.currentOrderId).toBe('partner-active-job');
    expect(afterRider.isOnline).toBe(true);
    expect(afterUser.roles).not.toContain('VENDOR_OWNER');
    expect(await app.prisma.vendor.count({ where: { owner: { userId: user.id } } })).toBe(0);
    await app.prisma.rider.update({
      where: { id: rider.id },
      data: { currentOrderId: null, isOnline: false, isAvailable: false },
    });
  });
});

describe('vendor provisioning', () => {
  const business = {
    name: 'Test Roti Shop',
    vendorType: 'RESTAURANT',
    phone: '+5926009999',
    addressLine1: '1 Main St',
    city: 'Georgetown',
    latitude: 6.8,
    longitude: -58.16,
  };

  it('rejects a vendor with no business details', async () => {
    const res = await post('/api/v1/partner/become', { role: 'VENDOR' }, vendorToken);
    expect(res.statusCode).toBe(400);
  });

  it('provisions a Vendor store (PENDING_APPROVAL) + VENDOR_OWNER role', async () => {
    const res = await post('/api/v1/partner/become', { role: 'VENDOR', business }, vendorToken);
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).data.kind).toBe('VENDOR');
    const vendor = await app.prisma.vendor.findFirst({ where: { owner: { user: { phone: VENDOR_PHONE } } } });
    expect(vendor?.status).toBe('PENDING_APPROVAL');
    const user = await app.prisma.user.findUnique({ where: { phone: VENDOR_PHONE }, select: { roles: true, activeRole: true } });
    expect(user?.roles).toContain('VENDOR_OWNER');
    expect(user?.activeRole).toBe('VENDOR_OWNER');
  });

  it('is idempotent — one store per owner', async () => {
    const res = await post('/api/v1/partner/become', { role: 'VENDOR', business }, vendorToken);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.created).toBe(false);
    const count = await app.prisma.vendor.count({ where: { owner: { user: { phone: VENDOR_PHONE } } } });
    expect(count).toBe(1);
  });
});
