import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';

// ---------------------------------------------------------------------------
// order_status_logs is the immutable event trail behind cash disputes and
// claims. The plugin's Prisma extension makes it append-only in FACT: create is
// allowed, every mutation is refused at one interception point. This locks that
// guarantee in so a future caller can't quietly re-open the log to tampering.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let orderId: string;
let logId: string;

beforeAll(async () => {
  app = Fastify();
  await app.register(prismaPlugin);
  await app.ready();

  const customer = await app.prisma.user.findUnique({ where: { phone: '+5926003000' } });
  const vendor = await app.prisma.vendor.findUnique({ where: { slug: 'oasis-cafe' } });
  if (!customer || !vendor) throw new Error('Run prisma db seed before this test');

  const order = await app.prisma.order.create({
    data: {
      orderNumber: `LOG-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      customerId: customer.id,
      vendorId: vendor.id,
      status: 'PENDING',
      deliveryAddress: '1 Immutable Way, Georgetown',
      deliveryLat: 6.80451,
      deliveryLng: -58.15532,
      pickupLat: 6.80699,
      pickupLng: -58.15829,
      pickupAddress: 'Oasis corner',
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
      deliveryFee: 500, totalAmount: 2500,
      paymentMethod: 'CASH',
    },
  });
  orderId = order.id;
});

afterAll(async () => {
  // Deleting the parent order cascades its logs at the DB level — the intended,
  // un-intercepted cleanup path. That this leaves no rows proves the teardown
  // pattern the whole suite now relies on (no explicit orderStatusLog.deleteMany).
  if (orderId) await app.prisma.order.deleteMany({ where: { id: orderId } });
  const leftover = await app.prisma.orderStatusLog.count({ where: { orderId } });
  expect(leftover).toBe(0);
  await app.close();
});

describe('order_status_logs — append-only (immutable audit evidence)', () => {
  it('append (create) is permitted', async () => {
    const log = await app.prisma.orderStatusLog.create({
      data: { orderId, status: 'ACCEPTED', changedBy: 'test', note: 'vendor accepted' },
    });
    logId = log.id;
    expect(log.status).toBe('ACCEPTED');
  });

  it('update is refused', async () => {
    await expect(
      app.prisma.orderStatusLog.update({ where: { id: logId }, data: { note: 'tampered' } }),
    ).rejects.toThrow(/append-only/);
  });

  it('updateMany is refused', async () => {
    await expect(
      app.prisma.orderStatusLog.updateMany({ where: { orderId }, data: { note: 'tampered' } }),
    ).rejects.toThrow(/append-only/);
  });

  it('upsert is refused', async () => {
    await expect(
      app.prisma.orderStatusLog.upsert({
        where: { id: logId },
        update: { note: 'tampered' },
        create: { orderId, status: 'ACCEPTED', changedBy: 'test' },
      }),
    ).rejects.toThrow(/append-only/);
  });

  it('delete is refused', async () => {
    await expect(app.prisma.orderStatusLog.delete({ where: { id: logId } })).rejects.toThrow(/append-only/);
  });

  it('deleteMany is refused (selective erasure)', async () => {
    await expect(app.prisma.orderStatusLog.deleteMany({ where: { orderId } })).rejects.toThrow(/append-only/);
  });

  it('the row is intact after every refused mutation', async () => {
    const log = await app.prisma.orderStatusLog.findUniqueOrThrow({ where: { id: logId } });
    expect(log.note).toBe('vendor accepted'); // never became "tampered"
  });
});
