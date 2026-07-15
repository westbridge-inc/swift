import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { verificationRoutes } from '../modules/verification/verification.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { looksLikeDocument } from '../utils/images';

// ---------------------------------------------------------------------------
// Security-spec gaps (task #16): uploads sniff content, checkout is idempotent.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
let userId: string;
let vendorId: string;
let itemId: string;
const marker = nanoid(6).toLowerCase();
const createdOrderIds: string[] = [];

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['LIFECYCLE_V2'] = '0';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(verificationRoutes, { prefix: '/api/v1/verification' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const user = await app.prisma.user.create({
    data: {
      phone: `+59265${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Sec', lastName: 'Gap',
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      customer: { create: {} },
    },
  });
  userId = user.id;
  token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'secgap-test', deviceType: 'test',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });

  // A live vendor + item + address so checkout can succeed
  // Cheap untracked item — stays under the L2 ID-gate threshold for cash.
  const vendor = await app.prisma.vendor.findFirstOrThrow({
    where: { status: 'ACTIVE', isVerified: true, items: { some: { isAvailable: true, stockQuantity: null, basePrice: { lt: 3000 } } } },
    select: { id: true, items: { where: { isAvailable: true, stockQuantity: null, basePrice: { lt: 3000 } }, take: 1, select: { id: true } } },
  });
  vendorId = vendor.id;
  itemId = vendor.items[0]!.id;
  await app.prisma.address.create({
    data: {
      userId: user.id, label: 'Home', addressLine1: '1 Test St', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.16, isDefault: true,
    },
  });
});

afterAll(async () => {
  if (createdOrderIds.length > 0) {
    // status logs are append-only (immutable plugin) — order delete cascades.
    await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  if (userId) {
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: userId } } });
    await app.prisma.cart.deleteMany({ where: { customerId: userId } });
    await app.prisma.address.deleteMany({ where: { userId } });
    await app.prisma.encryptedObject.deleteMany({ where: { createdBy: userId } });
    await app.prisma.session.deleteMany({ where: { userId } });
    await app.prisma.customer.deleteMany({ where: { userId } });
    await app.prisma.user.deleteMany({ where: { id: userId } });
  }
  await app.close();
});

function uploadBytes(bytes: Buffer, mime: string) {
  const boundary = `----sec${marker}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="f"\r\ncontent-type: ${mime}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: '/api/v1/verification/upload',
    headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

describe('upload magic-byte sniffing (spec §6)', () => {
  it('unit: signatures match reality, spoofed headers do not', () => {
    expect(looksLikeDocument(Buffer.from('%PDF-1.7 rest'), 'application/pdf')).toBe(true);
    expect(looksLikeDocument(Buffer.from('<html>evil</html> padpadpad'), 'application/pdf')).toBe(false);
    expect(looksLikeDocument(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(16)]), 'image/jpeg')).toBe(true);
    expect(looksLikeDocument(Buffer.from('MZ executable bytes here'), 'image/jpeg')).toBe(false);
  });

  it('rejects an HTML payload wearing a PDF content-type', async () => {
    const res = await uploadBytes(Buffer.from('<html><script>alert(1)</script></html>'), 'application/pdf');
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_CONTENT');
  });

  it('accepts a real PDF', async () => {
    const res = await uploadBytes(Buffer.from('%PDF-1.4\n%test document bytes'), 'application/pdf');
    expect(res.statusCode).toBe(200);
    expect(res.json().data.url).toBeTruthy();
  });
});

describe('checkout idempotency (spec §5.5)', () => {
  async function fillCart() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customer/cart/items',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { vendorId, itemId, quantity: 1 },
    });
    expect([200, 201]).toContain(res.statusCode);
  }
  function checkout(key?: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/customer/checkout',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(key ? { 'idempotency-key': key } : {}),
      },
      payload: { paymentMethod: 'CASH' },
    });
  }

  it('a replay with the same key returns the SAME order, not a second one', async () => {
    await fillCart();
    const key = `test-${marker}-replay`;
    const first = await checkout(key);
    expect(first.statusCode).toBe(200);
    const firstOrder = first.json().data.orders?.[0] ?? first.json().data.order;
    createdOrderIds.push(firstOrder.id);

    const replay = await checkout(key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    const replayOrder = replay.json().data.orders?.[0] ?? replay.json().data.order;
    expect(replayOrder.id).toBe(firstOrder.id);
  });

  it('a concurrent duplicate is refused with 409 while the first is in flight', async () => {
    const key = `test-${marker}-race`;
    await app.redis.set(`checkout:idem:${userId}:${key}`, 'IN_FLIGHT', 'EX', 60, 'NX');
    const res = await checkout(key);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE_REQUEST');
    await app.redis.del(`checkout:idem:${userId}:${key}`);
  });

  it('a FAILED checkout releases the key so the same key can retry', async () => {
    // Empty cart → checkout fails; the key must not stay claimed.
    const key = `test-${marker}-release`;
    const fail = await checkout(key);
    expect(fail.statusCode).toBeGreaterThanOrEqual(400);
    expect(await app.redis.get(`checkout:idem:${userId}:${key}`)).toBeNull();

    // Same key now succeeds once the customer fixes their cart.
    await fillCart();
    const retry = await checkout(key);
    expect(retry.statusCode).toBe(200);
    const order = retry.json().data.orders?.[0] ?? retry.json().data.order;
    createdOrderIds.push(order.id);
  });
});
