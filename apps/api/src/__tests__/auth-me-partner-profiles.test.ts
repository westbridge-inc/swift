import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { buildApp } from '../app';
import { runWithoutTenant } from '../plugins/prisma';
import { fixtureTag, testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [PORTAL-404 · FLOW-QA F29] GET /auth/me says which of the signed-in person's OWN partner profiles exist
// (`data.profiles`: rider, driver, provider as yes/no), so the website asks only for the profiles the account holds.
// The browser logs every 404 itself; the website's earner office asked GET /driver/profile for a rider and
// GET /provider/subscription for anyone, and each answer the person did not have was a 404 in the console.
//
// Graded here, on the real composition (buildApp):
//  - each flag is true exactly when the profile route answers 200 (the same row), and false when it answers
//    404 or 403;
//  - a person only ever sees their own profiles;
//  - `data.user` keeps exactly its fields (the profile rows never ride along inside it);
//  - the profile routes keep their answers for the phone (404 = start onboarding, 403 = not a mover);
//  - a caller with no session still gets 401 and no data.
// Synthetic data only.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
const DAY = 86_400_000;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test-auth-me-partner-profiles');

type Actor = { userId: string; token: string };

async function makeUser(roles: Array<'CUSTOMER' | 'MOVER'>, activeRole: 'CUSTOMER' | 'MOVER'): Promise<Actor> {
  return sys(async () => {
    const user = await app.prisma.user.create({
      data: {
        phone: testPhone(), firstName: 'Profiles', lastName: `Probe${fixtureTag(4)}`, roles, activeRole,
        isPhoneVerified: true, status: 'ACTIVE', customer: { create: {} },
      },
      select: { id: true },
    });
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
    await app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(64), deviceId: `profiles-${fixtureTag(6)}`, deviceType: 'web', expiresAt: new Date(Date.now() + DAY) },
    });
    return { userId: user.id, token };
  });
}

const addRider = (userId: string) => sys(() => app.prisma.rider.create({ data: { userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }));
const addDriver = (userId: string) => sys(() => app.prisma.driver.create({
  data: {
    userId, vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2020, vehicleColor: 'Silver',
    licensePlate: `PP-${fixtureTag(8)}`, driverLicenseUrl: 'test/lic', vehicleInsuranceUrl: 'test/ins',
  },
}));
const addProvider = (userId: string) => sys(() => app.prisma.serviceProvider.create({ data: { userId, trade: 'tutor' } }));

const get = (url: string, token?: string) => app.inject({
  method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {},
});
const me = async (token: string) => {
  const res = await get('/api/v1/auth/me', token);
  expect(res.statusCode).toBe(200);
  return res.json().data as { user: Record<string, unknown>; profiles: unknown };
};

/** What each profile route says for this person, as the website reads it: 200 = held, 404/403 = not held. */
async function routeVerdicts(token: string) {
  const status = async (url: string) => (await get(url, token)).statusCode;
  return {
    rider: await status('/api/v1/rider/profile'),
    driver: await status('/api/v1/driver/profile'),
    provider: await status('/api/v1/provider/subscription'),
  };
}

let customer: Actor;
let moverNoProfile: Actor;
let riderOnly: Actor;
let driverOnly: Actor;
let riderAndDriver: Actor;
let pro: Actor;
let everything: Actor;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  moverNoProfile = await makeUser(['CUSTOMER', 'MOVER'], 'MOVER');
  riderOnly = await makeUser(['CUSTOMER', 'MOVER'], 'MOVER');
  await addRider(riderOnly.userId);
  driverOnly = await makeUser(['CUSTOMER', 'MOVER'], 'MOVER');
  await addDriver(driverOnly.userId);
  riderAndDriver = await makeUser(['CUSTOMER', 'MOVER'], 'MOVER');
  await addRider(riderAndDriver.userId);
  await addDriver(riderAndDriver.userId);
  pro = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await addProvider(pro.userId);
  everything = await makeUser(['CUSTOMER', 'MOVER'], 'MOVER');
  await addRider(everything.userId);
  await addDriver(everything.userId);
  await addProvider(everything.userId);
}, 60_000);

afterAll(async () => {
  if (userIds.length > 0) {
    await sys(async () => {
      await app.prisma.serviceProvider.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
  }
  await app?.close();
});

describe('[F29] GET /auth/me names the partner profiles this person holds', () => {
  it('a customer with no partner profile: all three are no', async () => {
    expect((await me(customer.token)).profiles).toEqual({ rider: false, driver: false, provider: false });
  });

  it('a rider: rider yes, driver and provider no', async () => {
    expect((await me(riderOnly.token)).profiles).toEqual({ rider: true, driver: false, provider: false });
  });

  it('a driver: driver yes, rider and provider no', async () => {
    expect((await me(driverOnly.token)).profiles).toEqual({ rider: false, driver: true, provider: false });
  });

  it('one account with a rider and a driver profile: both yes', async () => {
    expect((await me(riderAndDriver.token)).profiles).toEqual({ rider: true, driver: true, provider: false });
  });

  it('a self-employed service provider: provider yes', async () => {
    expect((await me(pro.token)).profiles).toEqual({ rider: false, driver: false, provider: true });
  });

  it('a mover who has not added a vehicle yet: all three are no', async () => {
    expect((await me(moverNoProfile.token)).profiles).toEqual({ rider: false, driver: false, provider: false });
  });

  it('each flag is yes exactly when that profile route answers 200 (the same row), for every kind of account', async () => {
    for (const actor of [customer, moverNoProfile, riderOnly, driverOnly, riderAndDriver, pro, everything]) {
      const { profiles } = await me(actor.token);
      const verdicts = await routeVerdicts(actor.token);
      const flags = profiles as Record<'rider' | 'driver' | 'provider', boolean>;
      for (const kind of ['rider', 'driver', 'provider'] as const) {
        if (flags[kind]) expect(verdicts[kind], `${kind} held`).toBe(200);
        else expect([403, 404], `${kind} not held`).toContain(verdicts[kind]);
      }
    }
    expect((await me(everything.token)).profiles).toEqual({ rider: true, driver: true, provider: true });
  });

  it('the flags are yes/no only, and data.user keeps exactly its fields (no profile row rides along)', async () => {
    const data = await me(everything.token);
    expect(Object.keys(data.profiles as object).sort()).toEqual(['driver', 'provider', 'rider']);
    for (const value of Object.values(data.profiles as object)) expect(typeof value).toBe('boolean');
    expect(Object.keys(data.user).sort()).toEqual(['activeRole', 'firstName', 'id', 'lastName', 'phone', 'roles', 'status', 'storeStaff', 'tenant']);
    expect(data.user['id']).toBe(everything.userId);
  });

  it('a person only sees their own profiles, whatever other accounts hold', async () => {
    // `everything` holds all three; the customer beside it still holds none.
    const mine = await me(customer.token);
    expect(mine.user['id']).toBe(customer.userId);
    expect(mine.profiles).toEqual({ rider: false, driver: false, provider: false });
  });
});

describe('[F29] unchanged: the profile routes and the session door', () => {
  it('the phone keeps its answers: a mover with no driver profile gets 404 (onboarding), a customer gets 403', async () => {
    expect((await get('/api/v1/driver/profile', riderOnly.token)).statusCode).toBe(404);
    expect((await get('/api/v1/rider/profile', driverOnly.token)).statusCode).toBe(404);
    expect((await get('/api/v1/driver/profile', customer.token)).statusCode).toBe(403);
    expect((await get('/api/v1/rider/profile', customer.token)).statusCode).toBe(403);
    expect((await get('/api/v1/provider/subscription', riderOnly.token)).statusCode).toBe(404);
  });

  it('no session: 401 and no data, profiles or otherwise', async () => {
    const res = await get('/api/v1/auth/me');
    expect(res.statusCode).toBe(401);
    expect(res.json()).not.toHaveProperty('data');
    const forged = await get('/api/v1/auth/me', 'not-a-real-token');
    expect(forged.statusCode).toBe(401);
    expect(forged.json()).not.toHaveProperty('data');
  });
});
