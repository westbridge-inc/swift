import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { goOnlineRefusal } from '../modules/subscription/go-online-refusals';
import { cleanupBillingClocks, cleanupPayerBillingClocks } from './helpers/billing-clock-cleanup';

// [NO-DEAD-ENDS · owner, 6 Oct] Why GO snapped back, and where to fix it.
// The store build in review (build 9) shows the GO refusal verbatim under the
// switch. "Your documents must be verified before you can go online" named no
// place to fix it, and "Top up or pay" pointed at a wallet Swift does not have
// (the weekly fee is paid on the MMG checkout page under Weekly fee). Every
// request here is build 9's: POST /rider/go-online {latitude, longitude}.
// Codes and statuses are unchanged.

const DAY = 86_400_000;
const phoneBase = 592_046_700_000 + Math.floor(Math.random() * 90_000);
let app: FastifyInstance;
let seq = 0;
const userIds: string[] = [];
const subIds: string[] = [];

async function riderAccount(documentsVerified: boolean) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Go', lastName: `R${seq}`, roles: ['RIDER', 'CUSTOMER'] as UserRole[], activeRole: 'RIDER',
      isPhoneVerified: true, selfieCapturedAt: new Date(), countryCode: 'GY', customer: { create: {} },
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `go-${nanoid(6)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  const rider = await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified } });
  return { userId: user.id, token, riderId: rider.id };
}

/** Build 9: riderApi.goOnline(latitude, longitude). */
const build9GoOnline = (token: string) => app.inject({
  method: 'POST', url: '/api/v1/rider/go-online', payload: { latitude: 6.8013, longitude: -58.1551 },
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
});

afterAll(async () => {
  await cleanupPayerBillingClocks(app.prisma, userIds);
  await cleanupBillingClocks(app.prisma, subIds);
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.close();
});

describe('a refused GO names the screen that fixes it', () => {
  it('documents not verified: "Open Documents in your account" (403 VERIFICATION_REQUIRED unchanged)', async () => {
    const rider = await riderAccount(false);
    const res = await build9GoOnline(rider.token);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('VERIFICATION_REQUIRED');
    expect(res.json().error.message).toMatch(/Open Documents in your account/);
    expect(res.json().error.details).toEqual({ nextStep: 'OPEN_DOCUMENTS' });
  });

  it('weekly fee unpaid: "Open Weekly fee in your account", never "Top up" (403 SUBSCRIPTION_SUSPENDED unchanged)', async () => {
    const rider = await riderAccount(true);
    const sub = await app.prisma.subscription.create({
      data: {
        riderId: rider.riderId, type: 'DELIVERY_RIDER', status: 'SUSPENDED', suspendedAt: new Date(), weeklyRate: 6000, billingMethod: 'CASH',
        currentPeriodStart: new Date(Date.now() - 9 * DAY), currentPeriodEnd: new Date(Date.now() - 2 * DAY), nextBillingDate: new Date(Date.now() - 2 * DAY),
      },
    });
    subIds.push(sub.id);
    const res = await build9GoOnline(rider.token);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('SUBSCRIPTION_SUSPENDED');
    expect(res.json().error.message).toMatch(/Open Weekly fee in your account/);
    expect(res.json().error.message).not.toMatch(/top up/i);
    expect(res.json().error.details).toEqual({ nextStep: 'OPEN_WEEKLY_FEE' });
  });

  it('every GO refusal names its screen and keeps each route’s historical status and code', () => {
    const cases: Array<[Parameters<typeof goOnlineRefusal>[0], 'RIDER' | 'DRIVER', number, string, RegExp]> = [
      ['DOCUMENTS', 'RIDER', 403, 'VERIFICATION_REQUIRED', /Open Documents/],
      ['DOCUMENTS', 'DRIVER', 403, 'VERIFICATION_REQUIRED', /Open Documents/],
      ['FEE_GRACE_LAPSED', 'RIDER', 403, 'SUBSCRIPTION_PAST_DUE', /Open Weekly fee/],
      ['FEE_GRACE_LAPSED', 'DRIVER', 403, 'SUBSCRIPTION_PAST_DUE', /Open Weekly fee/],
      ['FEE_INACTIVE', 'RIDER', 403, 'SUBSCRIPTION_SUSPENDED', /Open Weekly fee/],
      ['FEE_INACTIVE', 'DRIVER', 400, 'SUBSCRIPTION_REQUIRED', /Open Weekly fee/],
    ];
    for (const [kind, route, status, code, words] of cases) {
      const e = goOnlineRefusal(kind, route);
      expect({ status: e.statusCode, code: e.code }, `${kind}/${route}`).toEqual({ status, code });
      expect(e.message, `${kind}/${route}`).toMatch(words);
      expect(e.message).not.toMatch(/top up/i);
    }
  });
});
