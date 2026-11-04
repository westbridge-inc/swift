import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { runWithoutTenant } from '../plugins/tenant-context';
import { testPhone } from './helpers/fixture-ids';

// A MOVER who signed up and stopped before the vehicle step has no Rider row and no Driver row. The People list could
// not tell such an account from a working rider. Each row now says which profile exists, and nothing more than that:
// the rider and driver pages own every other mover fact, and the masking rules on the row are unchanged.

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const DAY = 86_400_000;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'admin-users-mover-kind-test');

let app: FastifyInstance;
const userIds: string[] = [];
const tokens: Record<string, string> = {};
const phones = { none: testPhone(), rider: testPhone(), driver: testPhone() };
const ids = { none: '', rider: '', driver: '', riderRow: '', driverRow: '' };

async function person(phone: string, roles: string[], extra: Record<string, unknown> = {}) {
  const user = await system(() => app.prisma.user.create({ data: {
    phone, firstName: 'Kind', lastName: `K${RUN}`, roles: roles as never, activeRole: roles[0] as never, status: 'ACTIVE', isPhoneVerified: true, ...extra,
  } as never }));
  userIds.push(user.id);
  return user.id;
}

async function adminWith(name: string, permissions: readonly string[]) {
  const id = await person(testPhone(), ['ADMIN', 'CUSTOMER'], { admin: { create: { permissions: [...permissions] } } });
  const token = app.jwt.sign({ userId: id, role: 'ADMIN', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `kind-${RUN}-${name}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  tokens[name] = token;
}

const list = async (token: string) => {
  const res = await app.inject({ method: 'GET', url: `/api/v1/admin/users?search=K${RUN}&role=MOVER`, headers: { authorization: `Bearer ${token}` } });
  expect(res.statusCode).toBe(200);
  return res.json().data as Array<Record<string, unknown> & { id: string; phone: string }>;
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  ids.none = await person(phones.none, ['MOVER', 'CUSTOMER']);
  ids.rider = await person(phones.rider, ['MOVER', 'CUSTOMER']);
  ids.driver = await person(phones.driver, ['MOVER', 'CUSTOMER']);
  ids.riderRow = (await system(() => app.prisma.rider.create({ data: { userId: ids.rider, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } as never }))).id;
  ids.driverRow = (await system(() => app.prisma.driver.create({ data: {
    userId: ids.driver, vehicleType: 'CAR', vehicleMake: 'Test', vehicleModel: 'Car', vehicleYear: 2020, vehicleColor: 'Silver', licensePlate: `K${RUN}`, driverLicenseUrl: 'test/l', vehicleInsuranceUrl: 'test/i',
  } as never }))).id;
  await adminWith('full', ['*']);
  await adminWith('noContact', ['user.read']);
});

afterAll(async () => {
  await system(async () => {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  });
  await app.close();
});

describe('GET /admin/users says which mover profile exists', () => {
  it('a rider row, a driver row, or neither: the id of what exists and null for what does not', async () => {
    const rows = await list(tokens['full']!);
    const of = (id: string) => rows.find((row) => row.id === id)!;
    expect(of(ids.rider)).toMatchObject({ rider: { id: ids.riderRow }, driver: null });
    expect(of(ids.driver)).toMatchObject({ rider: null, driver: { id: ids.driverRow } });
    expect(of(ids.none)).toMatchObject({ rider: null, driver: null });
  });

  it('nothing else about the mover rides on the row, for any grant', async () => {
    for (const token of [tokens['full']!, tokens['noContact']!]) {
      const row = (await list(token)).find((candidate) => candidate.id === ids.driver)!;
      expect(Object.keys(row['driver'] as object)).toEqual(['id']);
    }
  });

  it('the masking rules hold: without the contact capability the number stays masked, with the profile fact still there', async () => {
    const rows = await list(tokens['noContact']!);
    const none = rows.find((row) => row.id === ids.none)!;
    expect(none.phone).toMatch(new RegExp(`•+${phones.none.slice(-4)}$`));
    expect(none['rider']).toBeNull();
    const full = (await list(tokens['full']!)).find((row) => row.id === ids.none)!;
    expect(full.phone).toBe(phones.none);
  });
});
