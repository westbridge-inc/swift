import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { NotificationService } from '../modules/notification/notification.service';
import { pushOptionsFor, pushOptionsForDevice } from '../providers/notifications/alert-class';
import type { NotificationChannels, PushOptions } from '../providers/notifications/channels';
import type { Server } from 'socket.io';

// ---------------------------------------------------------------------------
// Device push registration. Failure paths first: unauthenticated writes are
// refused; a token that re-registers under a NEW login is reassigned to that
// user (one phone, next owner must not push to the previous account); logout
// deactivation only touches the caller's own token.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdTokens: string[] = [];

let seq = 0;
async function makeUser() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200178${String(seq).padStart(2, '0')}`,
      firstName: 'Push',
      lastName: `User${seq}`,
      roles: ['CUSTOMER'],
      activeRole: 'CUSTOMER',
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'device-token-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

function register(deviceToken: string, auth?: string) {
  createdTokens.push(deviceToken);
  return app.inject({
    method: 'POST',
    url: '/api/v1/customer/notifications/devices',
    payload: { token: deviceToken, platform: 'ios' },
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
  });
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  // Must precede route registration (matches server.ts and every route test) —
  // registered after, thrown ZodErrors surface as 500s instead of 400s.
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});

afterAll(async () => {
  await app.prisma.deviceToken.deleteMany({ where: { token: { in: createdTokens } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('POST /notifications/devices', () => {
  it('refuses unauthenticated registration', async () => {
    const res = await register(`ExponentPushToken[${nanoid(12)}]`);
    expect(res.statusCode).toBe(401);
  });

  it('rejects a malformed platform', async () => {
    const { token } = await makeUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/notifications/devices',
      payload: { token: `ExponentPushToken[${nanoid(12)}]`, platform: 'blackberry' },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('registers, is idempotent, and reassigns the token to the newest login', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const device = `ExponentPushToken[${nanoid(12)}]`;

    expect((await register(device, a.token)).statusCode).toBe(200);
    expect((await register(device, a.token)).statusCode).toBe(200); // same user re-register = no-op upsert

    let row = await app.prisma.deviceToken.findUnique({ where: { token: device } });
    expect(row).toMatchObject({ userId: a.userId, isActive: true, platform: 'ios' });

    // Same phone, next owner: the token must move, never dual-deliver.
    expect((await register(device, b.token)).statusCode).toBe(200);
    row = await app.prisma.deviceToken.findUnique({ where: { token: device } });
    expect(row).toMatchObject({ userId: b.userId, isActive: true });
  });
});

describe('DELETE /notifications/devices', () => {
  it('deactivates own token; cannot touch someone else’s', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const device = `ExponentPushToken[${nanoid(12)}]`;
    await register(device, a.token);

    // B tries to deactivate A's token — silently affects nothing.
    const foreign = await app.inject({
      method: 'DELETE',
      url: '/api/v1/customer/notifications/devices',
      payload: { token: device },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` },
    });
    expect(foreign.statusCode).toBe(200);
    let row = await app.prisma.deviceToken.findUnique({ where: { token: device } });
    expect(row?.isActive).toBe(true);

    const own = await app.inject({
      method: 'DELETE',
      url: '/api/v1/customer/notifications/devices',
      payload: { token: device },
      headers: { 'content-type': 'application/json', authorization: `Bearer ${a.token}` },
    });
    expect(own.statusCode).toBe(200);
    row = await app.prisma.deviceToken.findUnique({ where: { token: device } });
    expect(row?.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// [RINGER · loud alerts 3/4] DeviceToken.alertsVersion: what the installed
// app can ring with, as it reported at registration. Builds 9-11 report
// nothing (0) and must keep receiving exactly today's push; the build-12 app
// reports 1 and gets the job ring for a new order or an offer.
// ---------------------------------------------------------------------------

function registerReporting(deviceToken: string, auth: string, extra: Record<string, unknown>) {
  createdTokens.push(deviceToken);
  return app.inject({
    method: 'POST',
    url: '/api/v1/customer/notifications/devices',
    payload: { token: deviceToken, platform: 'android', ...extra },
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
  });
}

const storedVersion = async (deviceToken: string) =>
  (await app.prisma.deviceToken.findUniqueOrThrow({ where: { token: deviceToken } })).alertsVersion;

describe('[RINGER] POST /notifications/devices records alertsVersion', () => {
  it('records what the app reported; an app that reports nothing (builds 9-11) reads 0', async () => {
    const { token } = await makeUser();
    const ringBuild = `ExponentPushToken[${nanoid(12)}]`;
    const oldBuild = `ExponentPushToken[${nanoid(12)}]`;
    expect((await registerReporting(ringBuild, token, { alertsVersion: 1 })).statusCode).toBe(200);
    expect((await register(oldBuild, token)).statusCode).toBe(200);
    expect(await storedVersion(ringBuild)).toBe(1);
    expect(await storedVersion(oldBuild)).toBe(0);
  });

  it('a malformed report reads 0 and never costs the phone its registration', async () => {
    const { token } = await makeUser();
    for (const malformed of ['1', 1.5, -1, 5000, null, true, {}]) {
      const device = `ExponentPushToken[${nanoid(12)}]`;
      const res = await registerReporting(device, token, { alertsVersion: malformed });
      expect(res.statusCode, JSON.stringify(malformed)).toBe(200);
      expect(await storedVersion(device), JSON.stringify(malformed)).toBe(0);
    }
  });

  it('is rewritten on every registration: an app that stops reporting it reads 0 again', async () => {
    const { token } = await makeUser();
    const device = `ExponentPushToken[${nanoid(12)}]`;
    await registerReporting(device, token, { alertsVersion: 1 });
    expect(await storedVersion(device)).toBe(1);
    await registerReporting(device, token, {});
    expect(await storedVersion(device)).toBe(0);
  });
});

describe('[RINGER] a ringing notification reaches each device as its app can ring', () => {
  const ioStub = { to: () => ({ emit: () => true }) } as unknown as Server;

  function recordingChannels() {
    const calls: Array<{ tokens: string[]; data?: Record<string, unknown>; options?: PushOptions }> = [];
    const channels: NotificationChannels = {
      sms: { sendSms: async () => ({ ref: 'sms' }) },
      email: { sendEmail: async () => ({ ref: 'email' }) },
      push: {
        async sendPush(tokens, _title, _body, data, options) {
          calls.push({ tokens, data, options });
          return { sent: tokens.length };
        },
      },
    };
    return { calls, channels };
  }

  it('a new order: the ring for the build-12 phone, today\'s push for the build-11 phone', async () => {
    const owner = await makeUser();
    const oldBuild = `ExponentPushToken[${nanoid(12)}]`;
    const ringBuild = `ExponentPushToken[${nanoid(12)}]`;
    await registerReporting(oldBuild, owner.token, {});
    await registerReporting(ringBuild, owner.token, { alertsVersion: 1 });
    const { calls, channels } = recordingChannels();

    await new NotificationService(app.prisma, ioStub, channels).send({
      userId: owner.userId,
      type: 'ORDER_UPDATE',
      title: 'New Order!',
      body: 'Order SW-R1',
      audience: 'business',
      data: { orderId: `o-${nanoid(8)}`, orderNumber: 'SW-R1', status: 'PENDING', kind: 'vendor_order_alert', respondBy: new Date(Date.now() + 600_000).toISOString() },
    });

    expect(calls.map((call) => call.tokens)).toEqual([[oldBuild], [ringBuild]]);
    const data = calls[0]!.data;
    expect(calls[0]!.options).toEqual(pushOptionsFor(data));
    expect(calls[0]!.options).not.toHaveProperty('channelId');
    expect(calls[1]!.options).toEqual(pushOptionsForDevice(data, 1));
    expect(calls[1]!.options).toMatchObject({ channelId: 'job_offers', sound: 'swift_job_ring.wav', interruptionLevel: 'time-sensitive' });
  });

  it('an ordinary notification is one push with today\'s options for both phones', async () => {
    const user = await makeUser();
    const oldBuild = `ExponentPushToken[${nanoid(12)}]`;
    const ringBuild = `ExponentPushToken[${nanoid(12)}]`;
    await registerReporting(oldBuild, user.token, {});
    await registerReporting(ringBuild, user.token, { alertsVersion: 1 });
    const { calls, channels } = recordingChannels();

    await new NotificationService(app.prisma, ioStub, channels).send({
      userId: user.userId, type: 'ORDER_UPDATE', title: 'On the way', body: 'Your order is on the way',
      data: { orderId: `o-${nanoid(8)}`, status: 'PICKED_UP' },
    });

    expect(calls).toHaveLength(1);
    expect([...calls[0]!.tokens].sort()).toEqual([oldBuild, ringBuild].sort());
    expect(calls[0]!.options).toEqual(pushOptionsFor(calls[0]!.data));
  });
});

