import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [FOLLOWUPS · COORD privacy ruling 28 Oct 2026] Two admin detail reads carry only what their page uses:
//   - a custody case (GET /admin/custody-cases/:id) names the rider holding the goods and the relay rider, and
//     whether each is online. It sent each rider's LIVE position (currentLat/currentLng/lastLocationUpdate); the
//     console's custody page never drew it, so it is no longer sent.
//   - a person (GET /admin/users/:id) never carries their push device tokens (pinned: the read does not include
//     them, and the console reads none).
// ---------------------------------------------------------------------------

const RUN = nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x');
const DAY = 86_400_000;
let app: FastifyInstance;
let token = '';
const userIds: string[] = [];
const ids = { rider: '', relay: '', order: '', kase: '', customer: '' };
const LAT = 6.80123;
const LNG = -58.15987;
const DEVICE_TOKEN = `ExponentPushToken[fixture-${RUN}]`;
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'admin-detail-no-location-test');

async function person(roles: string[], extra: Record<string, unknown> = {}) {
  const user = await system(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Detail', lastName: `P${RUN}`, roles: roles as never, activeRole: roles[0] as never, status: 'ACTIVE', isPhoneVerified: true, ...extra,
  } as never }));
  userIds.push(user.id);
  return user.id;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await person(['SUPER_ADMIN', 'CUSTOMER'], { admin: { create: { permissions: ['*'] } } });
  token = app.jwt.sign({ userId: admin, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: admin, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `detail-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  ids.customer = await person(['CUSTOMER']);
  await system(() => app.prisma.deviceToken.create({ data: { userId: ids.customer, token: DEVICE_TOKEN, platform: 'ios' } as never }));
  const rider = async () => { const userId = await person(['RIDER']); return (await system(() => app.prisma.rider.create({ data: {
    userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', isOnline: false, currentLat: LAT, currentLng: LNG, lastLocationUpdate: new Date(),
  } as never }))).id; };
  ids.rider = await rider();
  ids.relay = await rider();
  ids.order = (await system(() => app.prisma.order.create({ data: {
    orderNumber: `DNL-${RUN}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', status: 'PICKED_UP', customerId: ids.customer, riderId: ids.rider,
    deliveryAddress: '1 Gate St', deliveryLat: 6.801, deliveryLng: -58.156,
    subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
  } as never }))).id;
  ids.kase = (await system(() => app.prisma.custodyRecoveryCase.create({ data: {
    orderId: ids.order, reason: 'VEHICLE_BREAKDOWN', holderRiderId: ids.rider, relayRiderId: ids.relay, state: 'TRANSFER_IN_PROGRESS', deadlineAt: new Date(Date.now() + 600_000),
  } }))).id;
});

afterAll(async () => {
  await system(async () => {
    await purgeAuditLogs(app.prisma, { userId: { in: userIds } }, 'test-cleanup:admin-detail-no-location').catch(() => 0);
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:admin-detail-no-location').catch(() => 0);
    await app.prisma.custodyRecoveryCase.deleteMany({ where: { id: ids.kase } });
    await app.prisma.order.deleteMany({ where: { id: ids.order } });
    await app.prisma.rider.deleteMany({ where: { id: { in: [ids.rider, ids.relay] } } });
    await app.prisma.deviceToken.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
});

const get = (url: string) => app.inject({ method: 'GET', url: `/api/v1/admin${url}`, headers: { authorization: `Bearer ${token}` } });

describe('[FOLLOWUPS] admin detail reads carry only what their page uses', () => {
  it('a custody case names the holder and the relay rider and whether each is online, and never their live position', async () => {
    const res = await get(`/custody-cases/${ids.kase}`);
    expect(res.statusCode).toBe(200);
    const { holder, relay } = res.json().data;
    for (const rider of [holder, relay]) {
      expect(rider.isOnline).toBe(false);
      expect(rider.user.firstName).toBe('Detail');
      for (const key of ['currentLat', 'currentLng', 'lastLocationUpdate']) expect(key in rider, key).toBe(false);
    }
    expect(res.payload).not.toContain(String(LAT));
    expect(res.payload).not.toContain(String(LNG));
  });

  it('a person never carries their push device tokens', async () => {
    const res = await get(`/users/${ids.customer}`);
    expect(res.statusCode).toBe(200);
    expect('deviceTokens' in res.json().data).toBe(false);
    expect(res.payload).not.toContain(DEVICE_TOKEN);
  });
});
