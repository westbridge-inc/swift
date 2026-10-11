import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { partnerRoutes } from '../modules/partner/partner.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { grantStepUp } from './helpers/step-up';

// ---------------------------------------------------------------------------
// [Owner ruling 11 Oct 2026 — H-PLATE: KEEP] A taxi's plate must be H-series
// and match its registration. Approval already refuses anything else, so the
// rule is said where the plate is TYPED: sign-up (/partner/become), the vehicle
// screen (/partner/vehicle) and a plate edit on the driver profile. A taxi
// driver can no longer save a plate that could never be approved ("PLL592"),
// and is told why in plain words. Delivery vehicles are not judged; buses are
// hidden at launch and keep their own path. Names here are plain strings so on
// the old code each case fails on its own assertion.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const users: string[] = [];
let seq = 0;
// One file, one block: +592076nnnnnn.
const phoneBase = 592_076_000_000 + Math.floor(Math.random() * 900_000);
const NUM = String(Date.now()).slice(-4);
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'taxi-plate-signup-test');
const DAY = 86_400_000;
const CODE = 'TAXI_PLATE_NOT_HIRE';

async function makeUser(): Promise<{ userId: string; token: string }> {
  seq += 1;
  const user = await system(() => app.prisma.user.create({ data: {
    phone: `+${phoneBase + seq}`, firstName: 'Plate', lastName: `Mover${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
    countryCode: 'GY', isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: `/uploads/avatars/tp-${seq}.jpg`,
  } }));
  users.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'taxi-plate', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { userId: user.id, token };
}

function send(method: 'POST' | 'PUT', url: string, token: string, payload: Record<string, unknown>) {
  return app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
}
const car = (licensePlate: string) => ({ make: 'Toyota', model: 'Allion', year: 2018, color: 'Silver', licensePlate });
const become = (token: string, vehicleType: string, plate: string) => send('POST', '/api/v1/partner/become', token, { role: 'MOVER', acceptAgreement: true, vehicleType, vehicle: car(plate) });

function expectPlainRefusal(res: { statusCode: number; json: () => any }) {
  expect(res.statusCode).toBe(400);
  const error = res.json().error;
  expect(error.code).toBe(CODE);
  // Plain words, with an example of what a taxi plate looks like.
  expect(error.message).toMatch(/start with H/);
  expect(error.message).toMatch(/HC 1234/);
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(partnerRoutes, { prefix: '/api/v1/partner' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();
});

afterAll(async () => {
  if (!app) return;
  await system(async () => {
    await app.prisma.subject.deleteMany({ where: { createdById: { in: users } } });
    await app.prisma.subscription.deleteMany({ where: { OR: [{ rider: { userId: { in: users } } }, { driver: { userId: { in: users } } }] } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } }).catch(() => {});
  });
  await app.close();
});

describe('[H-PLATE · owner 11 Oct] sign-up refuses a taxi plate that could never be approved', () => {
  it.each([['CAR', 'PLL592'], ['CAR', `PAB ${NUM}`], ['WAGON_CAR', `GAA ${NUM}`], ['CAR', `B${NUM}`]])('%s with plate %s: refused in plain words, nothing saved', async (vehicleType, plate) => {
    const u = await makeUser();
    expectPlainRefusal(await become(u.token, vehicleType, plate));
    expect(await system(() => app.prisma.driver.findUnique({ where: { userId: u.userId } }))).toBeNull();
    expect(await system(() => app.prisma.rider.findUnique({ where: { userId: u.userId } }))).toBeNull();
  });

  it.each([['CAR', `HC ${NUM}`], ['WAGON_CAR', `hd-${NUM}`]])('%s with H-series plate %s is taken', async (vehicleType, plate) => {
    const u = await makeUser();
    const res = await become(u.token, vehicleType, plate);
    expect(res.statusCode, res.body).toBe(201);
  });

  it('a delivery motorbike keeps its private plate (not a taxi)', async () => {
    const u = await makeUser();
    const res = await become(u.token, 'MOTORCYCLE', `PAB ${NUM}`);
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe('[H-PLATE · owner 11 Oct] the vehicle screens say it too', () => {
  it('changing to a car with a private plate is refused; an H plate is taken', async () => {
    const u = await makeUser();
    expect((await become(u.token, 'MOTORCYCLE', `PMB ${NUM}`)).statusCode).toBe(201);
    expectPlainRefusal(await send('PUT', '/api/v1/partner/vehicle', u.token, { vehicleType: 'CAR', vehicle: car(`PCC ${NUM}`) }));
    expect(await system(() => app.prisma.driver.findUnique({ where: { userId: u.userId } }))).toBeNull();
    const ok = await send('PUT', '/api/v1/partner/vehicle', u.token, { vehicleType: 'CAR', vehicle: car(`HC ${NUM}`) });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('a taxi driver retyping the plate to a private one is refused before step-up; the saved plate stays', async () => {
    const u = await makeUser();
    expect((await become(u.token, 'CAR', `HB ${NUM}`)).statusCode).toBe(201);
    const refused = await send('PUT', '/api/v1/driver/profile', u.token, { licensePlate: 'PLL592' });
    expectPlainRefusal(refused);
    expect((await system(() => app.prisma.driver.findUniqueOrThrow({ where: { userId: u.userId } }))).licensePlate).toBe(`HB ${NUM}`);
    await grantStepUp(app, u.token);
    const ok = await send('PUT', '/api/v1/driver/profile', u.token, { licensePlate: `HA ${NUM}` });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('a driver saved before the rule with a private plate can still save other details (the plate is unchanged)', async () => {
    const u = await makeUser();
    await system(() => app.prisma.driver.create({ data: {
      userId: u.userId, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver', licensePlate: 'PLL592',
      driverLicenseUrl: '/uploads/synthetic-licence', vehicleInsuranceUrl: '/uploads/synthetic-insurance',
    } }));
    await system(() => app.prisma.user.update({ where: { id: u.userId }, data: { roles: ['CUSTOMER', 'MOVER', 'DRIVER'], activeRole: 'DRIVER', lastMoverRole: 'DRIVER' } }));
    const res = await send('PUT', '/api/v1/driver/profile', u.token, { licensePlate: 'pll-592', profilePhotoUrl: '/uploads/avatars/tp-legacy.jpg' });
    expect(res.statusCode, res.body).toBe(200);
  });
});
