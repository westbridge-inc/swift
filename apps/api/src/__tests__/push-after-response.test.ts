import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { NotificationService } from '../modules/notification/notification.service';
import { drainPushesAfterResponse, pushAfterResponse, pushesAfterResponseInFlight } from '../lib/push-after-response';

// ---------------------------------------------------------------------------
// [PERF item 3] A store's tap answers without waiting for the customer's push.
//
// Accept, Start preparing and Mark ready each told the customer by push, and
// the store's request waited for it: an HTTPS call to the push provider with
// retries after 2 s and 8 s and an 8 s deadline per try. A slow provider held
// the store's tap for up to about 34 s; a healthy one still added a round trip
// abroad to every tap. The inbox row and the socket events stay in the request
// (written before the answer); only the provider call goes on after it, with
// the same retries, log and counter, and it still goes out exactly once.
//
// The provider here is a real HTTP server standing in for Expo, so the real
// Expo provider and its retry wrapper run unchanged. It can hang until told.
// ---------------------------------------------------------------------------

class FakeExpo {
  server!: Server;
  bodies: string[] = [];
  private held: Array<() => void> = [];
  hang = false;
  async start(): Promise<string> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString('utf8'); });
      req.on('end', () => {
        this.bodies.push(raw);
        const count = (() => { try { const b = JSON.parse(raw) as unknown; return Array.isArray(b) ? b.length : 1; } catch { return 1; } })();
        const answer = () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: Array.from({ length: count }, () => ({ status: 'ok', id: nanoid(8) })) }));
        };
        if (this.hang) this.held.push(answer); else answer();
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('no fake provider address');
    return `http://127.0.0.1:${address.port}`;
  }
  release() { this.hang = false; for (const answer of this.held.splice(0)) answer(); }
  sendsFor(orderId: string) { return this.bodies.filter((b) => b.includes(orderId)).length; }
  async waitForSends(orderId: string, n: number) {
    for (let i = 0; i < 200 && this.sendsFor(orderId) < n; i += 1) await new Promise((r) => setTimeout(r, 10));
  }
  async stop() { this.release(); this.server.closeAllConnections(); await new Promise<void>((r) => this.server.close(() => r())); }
}

const provider = new FakeExpo();
let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
const routeHooks = new Map<string, unknown>();
let vendorToken = '';
let vendorId = '';
let customerId = '';

const held = () => new Promise<'held'>((resolve) => setTimeout(() => resolve('held'), 1500));
const vendorPut = (url: string) =>
  app.inject({ method: 'PUT', url, headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' }, payload: {} });

async function pickupOrder(status: 'PENDING' | 'ACCEPTED' | 'PREPARING') {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `PA-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP', customerId, vendorId, status, deliveryAddress: 'Collect at the store', deliveryLat: 6.81, deliveryLng: -58.16,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 0, totalAmount: 2000, paymentMethod: 'CASH',
    },
  });
  orderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  vi.stubEnv('PUSH_PROVIDER', 'expo');
  vi.stubEnv('EXPO_PUSH_URL', await provider.start());
  vi.stubEnv('EXPO_PUSH_RECEIPT_DELAY_MS', '0');
  vi.stubEnv('PUSH_PROVIDER_TIMEOUT_MS', '30000');

  app = Fastify({ logger: false });
  app.addHook('onRoute', (route) => { routeHooks.set(`${String(route.method)} ${route.url}`, route.onRequest); });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.ready();

  const base = 592_150_000_000 + Math.floor(Math.random() * 600_000_000);
  const vu = await app.prisma.user.create({
    data: { phone: `+${base + 1}`, firstName: 'Push', lastName: 'Store', roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(vu.id);
  vendorToken = app.jwt.sign({ userId: vu.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: vu.id, token: vendorToken, refreshToken: nanoid(48), deviceId: 'pa', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: vu.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: 'Push After Diner', slug: `pad-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: '+5920090602', addressLine1: '2 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
  });
  vendorId = vendor.id;
  const cu = await app.prisma.user.create({
    data: { phone: `+${base + 2}`, firstName: 'Push', lastName: 'Customer', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  userIds.push(cu.id);
  customerId = cu.id;
  await app.prisma.deviceToken.create({ data: { userId: cu.id, token: `ExponentPushToken[pa-${nanoid(10)}]`, platform: 'ios' } });
});

afterAll(async () => {
  provider.release();
  await drainPushesAfterResponse();
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => undefined);
  await app.prisma.deviceToken.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
  await provider.stop();
  vi.unstubAllEnvs();
});

describe('[PERF item 3] a store\'s tap answers without waiting for the customer\'s push', () => {
  for (const [step, from] of [['accept', 'PENDING'], ['preparing', 'ACCEPTED'], ['ready', 'PREPARING']] as const) {
    it(`${step}: answers while the push provider hangs; the inbox row is already written; the push goes out exactly once`, async () => {
      const order = await pickupOrder(from);
      provider.hang = true;
      try {
        const res = await Promise.race([vendorPut(`/api/v1/vendor/orders/${order.id}/${step}`), held()]);
        expect(res, 'the tap waited for the push provider').not.toBe('held');
        if (res === 'held') return;
        expect(res.statusCode, res.body).toBe(200);
        // Written before the answer, as before: the customer's inbox row for this order.
        const inbox = await app.prisma.notification.findMany({ where: { userId: customerId } });
        expect(inbox.filter((n) => JSON.stringify(n.data).includes(order.id))).toHaveLength(1);
        // The push is on its way while the provider hangs: asked once, not yet answered.
        await provider.waitForSends(order.id, 1);
        expect(provider.sendsFor(order.id)).toBe(1);
        expect(pushesAfterResponseInFlight()).toBeGreaterThan(0);
      } finally {
        provider.release();
      }
      await drainPushesAfterResponse();
      expect(pushesAfterResponseInFlight()).toBe(0);
      await new Promise((r) => setTimeout(r, 100));
      expect(provider.sendsFor(order.id), 'sent exactly once').toBe(1);
    });
  }

  it('outside a partner tap nothing changes: a send still waits for the provider', async () => {
    const notifications = new NotificationService(app.prisma, app.io);
    const orderId = `outside-${nanoid(8)}`;
    provider.hang = true;
    try {
      const sent = notifications.send({ userId: customerId, type: 'ORDER_UPDATE', title: 'T', body: 'B', data: { orderId } } as never);
      expect(await Promise.race([sent, held()])).toBe('held');
    } finally {
      provider.release();
    }
    await provider.waitForSends(orderId, 1);
    expect(provider.sendsFor(orderId)).toBe(1);
  });

  it('inside a partner tap, a send that must know it reached a phone (sendReach) still waits', async () => {
    const tiny = Fastify({ logger: false });
    const notifications = new NotificationService(app.prisma, app.io);
    const orderId = `reach-${nanoid(8)}`;
    tiny.post('/tap', { onRequest: pushAfterResponse }, async () =>
      notifications.sendReach({ userId: customerId, type: 'ORDER_UPDATE', title: 'T', body: 'B', data: { orderId } } as never));
    await tiny.ready();
    provider.hang = true;
    try {
      expect(await Promise.race([tiny.inject({ method: 'POST', url: '/tap' }), held()])).toBe('held');
    } finally {
      provider.release();
    }
    await provider.waitForSends(orderId, 1);
    await tiny.close();
  });

  it('every partner tap that tells a customer by push carries the hook, and nothing else changed its routes', () => {
    const taps = [
      'PUT /api/v1/vendor/orders/:id/accept', 'PUT /api/v1/vendor/orders/:id/preparing', 'PUT /api/v1/vendor/orders/:id/ready',
      'PUT /api/v1/vendor/orders/:id/reject', 'PUT /api/v1/vendor/orders/:id/delivered', 'PUT /api/v1/vendor/orders/:id/complete-pickup',
      'PUT /api/v1/vendor/orders/:id/complete-appointment',
      // [BOOK-FU2 · owner B3] "Customer didn't come": the business closes an appointment and the customer is told by push, like complete-appointment.
      'PUT /api/v1/vendor/orders/:id/no-show',
      'POST /api/v1/rider/orders/:id/accept', 'PUT /api/v1/rider/orders/:id/en-route-pickup', 'PUT /api/v1/rider/orders/:id/arrived-pickup',
      'PUT /api/v1/rider/orders/:id/picked-up', 'PUT /api/v1/rider/orders/:id/en-route-delivery', 'PUT /api/v1/rider/orders/:id/arrived', 'PUT /api/v1/rider/orders/:id/delivered',
      'POST /api/v1/rider/orders/:id/handover',
      'POST /api/v1/driver/rides/:id/accept', 'PUT /api/v1/driver/rides/:id/en-route', 'PUT /api/v1/driver/rides/:id/arrived',
      'PUT /api/v1/driver/rides/:id/start', 'POST /api/v1/driver/rides/:id/handover', 'PUT /api/v1/driver/rides/:id/complete',
    ];
    const carries = (key: string) => {
      const hooks = routeHooks.get(key);
      return hooks === pushAfterResponse || (Array.isArray(hooks) && hooks.includes(pushAfterResponse));
    };
    expect(taps.filter((key) => !routeHooks.has(key)), 'listed routes exist').toEqual([]);
    expect(taps.filter((key) => !carries(key)), 'listed routes carry the hook').toEqual([]);
    const others = [...routeHooks.keys()].filter((key) => !taps.includes(key) && carries(key));
    expect(others, 'no other route carries it').toEqual([]);
    // Money and delivery-mode taps keep waiting, deliberately.
    expect(carries('POST /api/v1/vendor/orders/:id/confirm-payment')).toBe(false);
    expect(carries('PUT /api/v1/vendor/orders/:id/fulfillment-mode')).toBe(false);
  });
});
