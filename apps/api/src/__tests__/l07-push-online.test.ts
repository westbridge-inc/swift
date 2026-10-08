import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';
import { currentMoverDocuments } from './helpers/current-mover-documents';

// Real GO routes, sessions, documents, fee authority and PostgreSQL. External
// Redis/socket effects are synthetic; the fixture never writes shared Redis.
let app: FastifyInstance;
const users: string[] = [];
const errors: string[] = [];
const subscriptionIds: string[] = [];
const run = nanoid(8);
let seq = 0;
beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  app.addHook('onError', async (_request, _reply, error) => { errors.push(error.stack ?? String(error)); });
  await app.register(prismaPlugin);
  app.decorate('io', { to: () => ({ emit: vi.fn() }), emit: vi.fn() } as never);
  app.decorate('redis', { get: async () => null, set: async () => 'OK', del: async () => 1, eval: async () => 1, sadd: async () => 1, expire: async () => 1, lrange: async () => [] } as never);
  app.decorate('authenticate', async (request) => {
    request.user = { userId: String(request.headers['test-actor']), role: 'MOVER' };
    request.authSessionId = String(request.headers['test-session']);
  });
  await app.register(riderRoutes, { prefix: '/rider' });
  await app.register(driverRoutes, { prefix: '/driver' });
  await app.ready();
});
afterEach(() => { vi.restoreAllMocks(); errors.length = 0; });
afterAll(async () => {
  if (!app) return;
  await cleanupPayerBillingClocks(app.prisma, users);
  await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subscriptionIds } } });
  await app.close();
});
async function fixture(pool: 'driver' | 'rider', push: 'active' | 'absent' | 'inactive' | 'muted') {
  const user = await app.prisma.user.create({ data: {
    firstName: 'Synthetic', lastName: 'Fixture', phone: `+5920785${String(++seq).padStart(4, '0')}`, roles: ['MOVER', 'DRIVER', 'RIDER'], activeRole: 'MOVER',
    selfieCapturedAt: new Date(), notificationPrefs: { push: push !== 'muted' },
    ...(pool === 'driver' ? { driver: { create: {
      vehicleType: 'CAR', vehicleMake: 'Toyota', vehicleModel: 'Fixture', vehicleYear: 2020, vehicleColor: 'White',
      licensePlate: `L07-GO-${seq}`, driverLicenseUrl: 'storage://synthetic/dl', vehicleInsuranceUrl: 'storage://synthetic/insurance',
      documentsVerified: true,
    } } } : { rider: { create: { riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } } }),
  }, include: { driver: true, rider: true } });
  users.push(user.id);
  const session = await app.prisma.session.create({ data: { userId: user.id,
    token: nanoid(48), refreshToken: nanoid(48), deviceId: `l07-${run}-${seq}`, deviceType: 'ios', expiresAt: new Date(Date.now() + 86_400_000),
  } });
  await currentMoverDocuments(app.prisma, user.id, pool === 'driver' ? 'CAR' : 'MOTORCYCLE', pool === 'driver');
  const subscriptions = new SubscriptionService(app.prisma);
  const sub = pool === 'driver' ? await subscriptions.startTrialForDriver(user.driver!.id) : await subscriptions.startTrialForRider(user.rider!.id);
  subscriptionIds.push(sub.id);
  if (push !== 'absent') await app.prisma.deviceToken.create({ data: {
    userId: user.id, token: `ExpoPushToken[synthetic-${nanoid(12)}]`, platform: 'ios', isActive: push !== 'inactive',
  } });
  const go = () => app.inject({ method: 'POST', url: `/${pool}/go-online`,
    headers: { 'test-actor': user.id, 'test-session': session.id }, payload: { latitude: 3.38, longitude: -59.79 },
  });
  const profile = () => pool === 'driver'
    ? app.prisma.driver.findUniqueOrThrow({ where: { userId: user.id } })
    : app.prisma.rider.findUniqueOrThrow({ where: { userId: user.id } });
  return { user, go, profile };
}

describe('both GO doors require a reachable push registration', () => {
  for (const pool of ['driver', 'rider'] as const) {
    it.each(['absent', 'inactive', 'muted'] as const)(`${pool} refuses %s push without activating supply`, async (push) => {
      const f = await fixture(pool, push);
      const response = await f.go();
      expect(response.statusCode, [response.body, ...errors].join('\n')).toBe(403);
      expect(response.json().error).toMatchObject({ code: 'PUSH_REQUIRED' });
      expect(await f.profile()).toMatchObject({ isOnline: false, locationSessionId: null });
    });
    it.each(['token', 'preferences'] as const)(`${pool} refuses a push revocation that commits while GO waits`, async (changed) => {
      const f = await fixture(pool, 'active');
      let entered!: () => void; let release!: () => void;
      const waiting = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const mutation = app.prisma.$transaction(async (tx) => {
        if (changed === 'token') await tx.deviceToken.updateMany({ where: { userId: f.user.id }, data: { isActive: false } });
        else await tx.user.update({ where: { id: f.user.id }, data: { notificationPrefs: { push: false } } });
        entered(); await gate;
      }, { timeout: 30_000 });
      await waiting;
      const response = Promise.resolve(f.go());
      try {
        const deadline = Date.now() + 10_000;
        let count = 0;
        while (Date.now() < deadline) {
          const rows = await app.prisma.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`;
          count = rows[0]!.count;
          if (count) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(count).toBeGreaterThan(0);
      } finally { release(); await mutation; }
      expect((await response).statusCode).toBe(403);
      expect(await f.profile()).toMatchObject({ isOnline: false, locationSessionId: null });
    });
    it(`${pool} keeps the build-9 request and response working with an active registration`, async () => {
      const f = await fixture(pool, 'active');
      const response = await f.go();
      expect(response.statusCode, [response.body, ...errors].join('\n')).toBe(200);
      expect(response.json()).toMatchObject({ success: true, data: { isOnline: true, isAvailable: true } });
      expect((await f.profile()).isOnline).toBe(true);
    });
  }
});
