import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { checkoutIdempotencyCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [MOB-020] The receipt probe: what became of a checkout attempt whose answer
// never arrived. The phone asks BEFORE it places a DIFFERENT order over an
// unresolved one. The receipt row (written inside the order's transaction) is
// the truth for "placed"; a claimed Redis key is "in flight"; nothing is
// "none". Only the caller's own keys answer.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const receiptIds: string[] = [];
let seq = 0;
const phoneBase = 592_730_000_000 + Math.floor(Math.random() * 200_000_000);

async function makeUser(roles: UserRole[] = ['CUSTOMER']) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Probe',
      lastName: `U${seq}`,
      roles,
      activeRole: roles[0]!,
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'probe', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { userId: user.id, token };
}

const probe = (key: string, token: string) => app.inject({ method: 'GET', url: `/api/v1/customer/checkout/receipts/${encodeURIComponent(key)}`, headers: { authorization: `Bearer ${token}` } });

async function count(outcome: string): Promise<number> {
  const metric = await checkoutIdempotencyCounter.get();
  return metric.values.find((v) => v.labels['outcome'] === outcome)?.value ?? 0;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
});
afterAll(async () => {
  await app.prisma.checkoutReceipt.deleteMany({ where: { id: { in: receiptIds } } }).catch(() => {});
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } }).catch(() => {});
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
  await app.close();
});

describe('[MOB-020] GET /customer/checkout/receipts/:key', () => {
  it('answers none, in_flight and placed from the truth the server holds, and counts each', async () => {
    const me = await makeUser();
    const key = `chk_probe_${nanoid(10)}`;
    const before = { none: await count('probe_none'), inFlight: await count('probe_in_flight'), placed: await count('probe_placed') };

    const none = await probe(key, me.token);
    expect(none.statusCode).toBe(200);
    expect(none.json().data).toEqual({ status: 'none' });
    expect(await count('probe_none')).toBe(before.none + 1);

    await app.redis.set(`checkout:idem:${me.userId}:${key}`, 'IN_FLIGHT', 'EX', 60);
    try {
      const inFlight = await probe(key, me.token);
      expect(inFlight.json().data).toEqual({ status: 'in_flight' });
      expect(await count('probe_in_flight')).toBe(before.inFlight + 1);
    } finally {
      await app.redis.del(`checkout:idem:${me.userId}:${key}`);
    }

    const receipt = await app.prisma.checkoutReceipt.create({
      data: { userId: me.userId, idempotencyKey: key, requestHash: 'h'.repeat(64), orderIds: ['order-1', 'order-2'], result: { orders: [] } },
    });
    receiptIds.push(receipt.id);
    const placed = await probe(key, me.token);
    expect(placed.json().data).toEqual({ status: 'placed', orderIds: ['order-1', 'order-2'] });
    expect(await count('probe_placed')).toBe(before.placed + 1);
  });

  it('answers only the caller’s own keys: another account probing the same key sees nothing', async () => {
    const me = await makeUser();
    const other = await makeUser();
    const key = `chk_probe_${nanoid(10)}`;
    const receipt = await app.prisma.checkoutReceipt.create({
      data: { userId: me.userId, idempotencyKey: key, requestHash: 'h'.repeat(64), orderIds: ['order-9'], result: { orders: [] } },
    });
    receiptIds.push(receipt.id);
    expect((await probe(key, me.token)).json().data.status).toBe('placed');
    expect((await probe(key, other.token)).json().data).toEqual({ status: 'none' });
  });

  it('refuses a key outside the command window and an unauthenticated caller', async () => {
    const me = await makeUser();
    expect((await probe('short', me.token)).statusCode).toBeGreaterThanOrEqual(400);
    const anon = await app.inject({ method: 'GET', url: `/api/v1/customer/checkout/receipts/chk_probe_${nanoid(10)}` });
    expect(anon.statusCode).toBe(401);
  });
});
