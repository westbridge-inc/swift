import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { registerErrorHandler } from '../middleware/error-handler';
import { purgeAuditLogs } from '../lib/audit-immutability';
import { heldFolder } from '../lib/upload-scan-debt';
import { walkOrderStatus } from './helpers/order-status-walk';
import { testPhone } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [BUG-HUNT-2 G11 · REVIEW-G11 block on #2364] A proof photo is an opaque stored key, never a link, so an admin
// "Open" that put the key in an href went nowhere. Through the real admin route with a key as the upload door
// stores it: a short signed link, a stated reason, an audit row first, the people on the order refused.
// ---------------------------------------------------------------------------

const signed = vi.hoisted(() => ({ calls: [] as Array<{ key: string; ttl: number | undefined }> }));
vi.mock('../providers/storage/storage-provider', async (original) => ({
  ...(await original<typeof import('../providers/storage/storage-provider')>()),
  getStorageProvider: () => ({
    getSignedUrl: async (key: string, ttl?: number) => { signed.calls.push({ key, ttl }); return `https://files.example/signed/${key}?sig=abc`; },
  }),
}));

const REASON = 'The sender says the parcel never reached the door';
const DOOR_KEY = `courier-proof/${nanoid(10)}/opaque.jpg`;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'test:admin-proof-photo');
type Actor = { id: string; token: string };

let app: FastifyInstance;
let admin: Actor;
let boss: Actor;
const people: string[] = [];
const orderIds: string[] = [];
const clusterIds: string[] = [];
const riderIds: string[] = [];

async function actor(roles: UserRole[], active: UserRole, adminRow = false): Promise<Actor> {
  const user = await sys(() => app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Dan', lastName: 'Proof', roles, activeRole: active, status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(),
    ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}), ...(adminRow ? { admin: { create: { permissions: ['*'] } } } : {}),
  } }));
  people.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: active, jti: nanoid(8) });
  await sys(() => app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'proof', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } }));
  return { id: user.id, token };
}

async function parcel(sender?: Actor, over: Record<string, unknown> = { courierProofPhotoUrl: DOOR_KEY }) {
  const customer = sender ?? await actor(['CUSTOMER'], 'CUSTOMER');
  const order = await sys(async () => {
    const created = await app.prisma.order.create({ data: {
      orderNumber: `PRF-${nanoid(10)}`, customerId: customer.id, orderType: 'COURIER', status: 'PENDING', pickupAddress: 'Pickup', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: 'Door', deliveryLat: 6.81, deliveryLng: -58.16, subtotalBase: 800, subtotalMarkup: 0, subtotalCustomer: 800, deliveryFee: 800, totalAmount: 800, paymentMethod: 'CASH',
    } as never });
    await walkOrderStatus(app.prisma, created.id, 'CANCELLED', {});
    await app.prisma.order.update({ where: { id: created.id }, data: over });
    return app.prisma.order.findUniqueOrThrow({ where: { id: created.id } });
  });
  orderIds.push(order.id);
  return { order, customer };
}

const show = (id: string, as: Actor, photo = 'door', reason: string | null = REASON) => app.inject({
  method: 'GET', url: `/api/v1/admin/orders/${id}/proof-photo?photo=${photo}`,
  headers: { authorization: `Bearer ${as.token}`, ...(reason ? { 'x-swift-reason': reason } : {}) },
});
const debtKeys: string[] = [];
const debt = (row: Record<string, unknown> & { fileKey: string }) => {
  debtKeys.push(row.fileKey);
  return sys(() => app.prisma.uploadScanDebt.create({ data: { surface: 'courier-proof', reason: 'evidence', sha256: 'a'.repeat(64), ...row } as never }));
};
const views = (id: string) => sys(() => app.prisma.auditLog.findMany({ where: { entityId: id, action: 'VIEW_PROOF_PHOTO' } }));
const linked = (accounts: string[], review = false) => sys(async () => {
  const cluster = await app.prisma.identityCluster.create({ data: { authorityReviewRequired: review } });
  clusterIds.push(cluster.id);
  await app.prisma.identityClusterMember.createMany({ data: accounts.map((accountId) => ({ accountId, clusterId: cluster.id, linkedVia: [] })) });
});

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  admin = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
  boss = await actor(['SUPER_ADMIN', 'CUSTOMER'], 'SUPER_ADMIN', true);
});

afterAll(async () => {
  await sys(async () => {
    await app.prisma.identityClusterMember.deleteMany({ where: { clusterId: { in: clusterIds } } });
    await app.prisma.identityCluster.deleteMany({ where: { id: { in: clusterIds } } });
    await app.prisma.uploadScanDebt.deleteMany({ where: { fileKey: { in: debtKeys } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await purgeAuditLogs(app.prisma, { entityId: { in: orderIds } }, 'test-cleanup:admin-proof-photo');
    await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: people } } });
    await app.prisma.user.deleteMany({ where: { id: { in: people } } });
  });
  await app.close();
});

describe('[G11] an admin opens a proof photo', () => {
  it('a real stored key comes back as a short signed link, never the key, and the read is recorded first', async () => {
    const { order } = await parcel();
    signed.calls.length = 0;
    const res = await show(order.id, admin);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const data = res.json().data;
    expect(data.url).toBe(`https://files.example/signed/${DOOR_KEY}?sig=abc`);
    expect(data.expiresInSeconds).toBe(300);
    expect(signed.calls).toEqual([{ key: DOOR_KEY, ttl: 300 }]);
    const [view] = await views(order.id);
    expect(view).toMatchObject({ userId: admin.id, entity: 'Order' });
    expect(view!.changes).toMatchObject({ reason: REASON, photo: 'door', orderNumber: order.orderNumber });
    expect(JSON.stringify(view!.changes)).not.toContain(DOOR_KEY);
  });

  it('each photo has its own key', async () => {
    const pickup = `courier-proof/${nanoid(10)}/pickup.jpg`;
    const back = `courier-proof/${nanoid(10)}/return.jpg`;
    const { order } = await parcel(undefined, { courierPickupProofPhotoUrl: pickup, courierReturnProofPhotoUrl: back });
    expect((await show(order.id, admin, 'pickup')).json().data.url).toContain(pickup);
    expect((await show(order.id, admin, 'return')).json().data.url).toContain(back);
  });

  it('asks why, and a read with no reason signs nothing and records nothing', async () => {
    const { order } = await parcel();
    signed.calls.length = 0;
    const res = await show(order.id, admin, 'door', null);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.message).toContain('this photo');
    expect(signed.calls).toEqual([]);
    expect(await views(order.id)).toEqual([]);
  });

  it('a photo that is not there says so, and a photo the scanner has not cleared is not served', async () => {
    const { order } = await parcel(undefined, {});
    const none = await show(order.id, admin);
    expect(none.statusCode, none.body).toBe(404);
    expect(none.json().error.code).toBe('NO_PROOF_PHOTO');

    const held = `${heldFolder('UNSCANNED', 'courier-proof')}/${nanoid(10)}.jpg`;
    await debt({ fileKey: held });
    const waiting = await parcel(undefined, { courierProofPhotoUrl: held });
    signed.calls.length = 0;
    const res = await show(waiting.order.id, admin);
    expect(res.statusCode, res.body).toBe(409);
    expect(signed.calls).toEqual([]);
    expect(await views(waiting.order.id)).toEqual([]);
  });

  it('an upload the scanner still owes is not served, wherever it is stored, and a held key with no record is not either', async () => {
    const owed = `courier-proof/${nanoid(10)}.jpg`;
    await debt({ fileKey: owed, reason: 'bypass' });
    const open = await parcel(undefined, { courierProofPhotoUrl: owed });
    const res = await show(open.order.id, admin);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('AWAITING_MALWARE_SCAN');

    const lost = await parcel(undefined, { courierProofPhotoUrl: `${heldFolder('UNSCANNED', 'courier-proof')}/${nanoid(10)}.jpg` });
    signed.calls.length = 0;
    const second = await show(lost.order.id, admin);
    expect(second.statusCode, second.body).toBe(409);
    expect(second.json().error.code).toBe('PROOF_PHOTO_HELD');
    expect(signed.calls).toEqual([]);
  });

  it('a held photo the scanner later cleared opens at the key its bytes moved to, not the one the order keeps', async () => {
    const held = `${heldFolder('UNSCANNED', 'courier-proof')}/${nanoid(10)}.jpg`;
    const released = `courier-proof/${nanoid(10)}.jpg`;
    await debt({ fileKey: held, result: 'CLEAN', rescannedAt: new Date(), releasedAt: new Date(), releasedKey: released });
    const { order } = await parcel(undefined, { courierProofPhotoUrl: held });
    signed.calls.length = 0;
    const res = await show(order.id, admin);
    expect(res.statusCode, res.body).toBe(200);
    expect(signed.calls).toEqual([{ key: released, ttl: 300 }]);
  });

  it('nobody opens a proof on an order they are on, through any account', async () => {
    const own = await parcel(admin);
    const res = await show(own.order.id, admin);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('OWN_ORDER');

    const twin = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    const linkedOrder = await parcel();
    await linked([linkedOrder.customer.id, twin.id]);
    expect((await show(linkedOrder.order.id, twin)).json().error.code).toBe('OWN_ORDER');
  });

  it('nor one they carried', async () => {
    const riderUser = await actor(['ADMIN', 'MOVER', 'CUSTOMER'], 'ADMIN', true);
    const rider = await sys(() => app.prisma.rider.create({ data: { userId: riderUser.id, riderType: 'COURIER', vehicleType: 'MOTORCYCLE' } as never }));
    riderIds.push(rider.id);
    const { order } = await parcel(undefined, { courierProofPhotoUrl: DOOR_KEY, riderId: rider.id });
    const res = await show(order.id, riderUser);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('OWN_ORDER');
  });

  it('a staff account on the order goes to a SUPER_ADMIN who is not on it', async () => {
    const staffer = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    const staffOrder = await parcel(staffer);
    const res = await show(staffOrder.order.id, admin);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('STAFF_ON_ORDER');
    expect((await show(staffOrder.order.id, boss)).statusCode).toBe(200);
  });

  it('an identity waiting for a person refuses, on the order or at the desk', async () => {
    const onHold = await parcel();
    await linked([onHold.customer.id], true);
    expect((await show(onHold.order.id, admin)).json().error.code).toBe('IDENTITY_REVIEW_REQUIRED');

    const reviewed = await actor(['ADMIN', 'CUSTOMER'], 'ADMIN', true);
    await linked([reviewed.id], true);
    const { order } = await parcel();
    expect((await show(order.id, reviewed)).json().error.code).toBe('IDENTITY_REVIEW_REQUIRED');
  });

  it('is a C1 read with its own capability', () => {
    expect(ADMIN_ROUTE_AUTHORITY['GET /orders/:id/proof-photo']).toMatchObject({ cls: 'C1', capability: 'order.proof.read' });
  });
});
