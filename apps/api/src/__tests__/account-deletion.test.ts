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

// ---------------------------------------------------------------------------
// SWIFT-AUD-D9-05 — self-serve DPA rights: export (access + portability) and
// account deletion (erasure). Proves the erasure actually shreds documents,
// revokes access and de-identifies — and that it fails closed for partner
// accounts and mid-delivery.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
const phoneBase = 592_810_000_000 + Math.floor(Math.random() * 100_000_000);

async function makeUser(roles: UserRole[]) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Del',
      lastName: `U${seq}`,
      email: `del${seq}-${nanoid(6)}@example.com`,
      roles,
      activeRole: roles[0]!,
      isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: roles[0]!, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'del', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { userId: user.id, token };
}

const inject = (method: 'GET' | 'DELETE', url: string, token: string) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${token}` } });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
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
  await app.prisma.auditLog.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.encryptedObject.deleteMany({ where: { createdBy: { in: createdUserIds } } });
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('D9-05 — account export', () => {
  it('returns the customer’s own data as a portable bundle', async () => {
    const u = await makeUser(['CUSTOMER']);
    await app.prisma.address.create({ data: { userId: u.userId, label: 'Home', addressLine1: '1 Main St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1 } });

    const res = await inject('GET', '/api/v1/customer/account/export', u.token);
    expect(res.statusCode).toBe(200);
    const d = res.json().data;
    expect(d.account.id).toBe(u.userId);
    expect(d.addresses).toHaveLength(1);
    expect(d).toHaveProperty('orders');
    expect(d).toHaveProperty('ratingsGiven');
    expect(d).toHaveProperty('exportedAt');
  });
});

describe('D9-05 — account deletion (erasure)', () => {
  it('crypto-shreds documents, revokes sessions, de-identifies, and drops addresses', async () => {
    const u = await makeUser(['CUSTOMER']);
    await app.prisma.address.create({ data: { userId: u.userId, label: 'Home', addressLine1: '1 Main St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.1 } });

    const fileKey = `verif/${nanoid(12)}.jpg`;
    await app.prisma.encryptedObject.create({
      data: { fileKey, iv: Buffer.from('iv'), authTag: Buffer.from('tag'), wrappedDek: Buffer.from('dek'), mimeType: 'image/jpeg', sizeBytes: 10, sha256: 'abc', createdBy: u.userId },
    });
    const doc = await app.prisma.verificationDocument.create({ data: { userId: u.userId, role: 'CUSTOMER', docType: 'ID_CARD', fileUrl: fileKey } });

    const res = await inject('DELETE', '/api/v1/customer/account', u.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.deleted).toBe(true);

    const after = await app.prisma.user.findUnique({ where: { id: u.userId } });
    expect(after?.status).toBe('DEACTIVATED');
    expect(after?.firstName).toBe('Deleted');
    expect(after?.email).toBeNull();
    expect(after?.phone.startsWith('deleted:')).toBe(true); // real number freed, uniqueness kept

    expect(await app.prisma.session.count({ where: { userId: u.userId } })).toBe(0);
    expect(await app.prisma.address.count({ where: { userId: u.userId } })).toBe(0);

    const enc = await app.prisma.encryptedObject.findUnique({ where: { fileKey } });
    expect(enc?.wrappedDek).toBeNull(); // crypto-shredded — ciphertext now unrecoverable
    expect(enc?.shreddedAt).not.toBeNull();
    const purged = await app.prisma.verificationDocument.findUnique({ where: { id: doc.id } });
    expect(purged?.purgedAt).not.toBeNull();
  });

  it('refuses a partner (mover) account — those close through Support', async () => {
    const u = await makeUser(['CUSTOMER', 'MOVER']);
    const res = await inject('DELETE', '/api/v1/customer/account', u.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PARTNER_ACCOUNT');
  });

  it('refuses while an order is in flight', async () => {
    const u = await makeUser(['CUSTOMER']);
    await app.prisma.order.create({
      data: {
        orderNumber: `DEL-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: u.userId, status: 'PREPARING', fulfillment: 'DELIVERY',
        pickupAddress: 'a', pickupLat: 6.8, pickupLng: -58.15, deliveryAddress: 'b', deliveryLat: 6.81, deliveryLng: -58.16,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500, paymentMethod: 'CASH',
      },
    });
    const res = await inject('DELETE', '/api/v1/customer/account', u.token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('ACTIVE_ORDERS');
  });
});
