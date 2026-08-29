import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { OrderService } from '../modules/order/order.service';
import { CountryConfigService } from '../modules/country/country-config.service';

// ---------------------------------------------------------------------------
// the locked domain model exists and works end-to-end:
// Guyana CountryConfig, 4 vendor types, every fulfillment kind, qrSlug,
// trust levels, verification document lifecycle, strikes, and an order
// walked through every state with the append-only log as evidence.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const countryConfig = new CountryConfigService(prisma);

// OrderService uses Socket.IO only for broadcasts — a no-op stub keeps the
// smoke test on state transitions and the log.
const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;
const orderService = new OrderService(prisma, ioStub);

let customerId: string;
let vendorId: string;
const createdOrderIds: string[] = [];
const testStart = new Date();

beforeAll(async () => {
  const customer = await prisma.user.findUnique({ where: { phone: '+5926003000' } });
  const vendor = await prisma.vendor.findUnique({ where: { slug: 'oasis-cafe' } });
  if (!customer || !vendor) throw new Error('Run prisma db seed before this smoke test');
  customerId = customer.id;
  vendorId = vendor.id;
});

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  // Guarded: a beforeAll that dies before customerId is set must never strip
  // the where-clause into a table-wide wipe (the pressure-test lesson).
  if (customerId) {
    await prisma.notification.deleteMany({ where: { userId: customerId, createdAt: { gte: testStart } } });
    await prisma.verificationDocument.deleteMany({ where: { userId: customerId } });
    await prisma.strike.deleteMany({ where: { userId: customerId } });
  }
  await prisma.user.deleteMany({ where: { phone: '+5920000888' } });
  await prisma.$disconnect();
});

async function createSmokeOrder(suffix: string) {
  const order = await prisma.order.create({
    data: {
      orderNumber: `SMOKE-${Date.now()}-${suffix}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      deliveryAddress: '123 Smoke Test Street, Georgetown',
      deliveryLat: 6.8045,
      deliveryLng: -58.1553,
      subtotalBase: 1000,
      subtotalMarkup: 0,
      subtotalCustomer: 1000,
      deliveryFee: 500,
      totalAmount: 1500,
      paymentMethod: 'CASH',
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

describe('CountryConfig — Guyana seeded, everything reads from config', () => {
  it('has an active Guyana config with GYD and the locked tiers', async () => {
    const gy = await countryConfig.getByCode('GY');
    expect(gy.isActive).toBe(true);
    expect(gy.currencyCode).toBe('GYD');
    expect(Number(gy.idGateThresholdUsd)).toBe(50);

    const tiers = await countryConfig.getSubscriptionTiers('GY');
    expect(tiers).toMatchObject({ mover: 10000, moverHeavy: 12000, smallVendor: 20000, largeVendor: 30000 });
  });

  it('converts the USD ID-gate to local currency from config', async () => {
    const gy = await countryConfig.getByCode('GY');
    const localGate = await countryConfig.getIdGateThresholdLocal('GY');
    expect(localGate).toBe(50 * Number(gy.usdExchangeRate));
    expect(localGate).toBeGreaterThan(0);
  });

  it('serves role document checklists from config', async () => {
    const moverDocs = await countryConfig.getDocumentChecklist('GY', 'MOVER');
    expect(moverDocs).toContain('national_id');
    const restaurantDocs = await countryConfig.getDocumentChecklist('GY', 'RESTAURANT');
    expect(restaurantDocs).toContain('food_handler_cert');
  });

  it('scales the mover checklist to the vehicle (no docs a vehicle can\'t have)', async () => {
    // Police clearance is base (every courier — cash + home visits, master
    // plan §3.2); only VEHICLE documents scale away. A car/taxi adds the
    // occupational extras (hire permit, plate + exterior photos, fitness).
    const bicycle = await countryConfig.getMoverChecklist('GY', 'BICYCLE');
    expect(bicycle).toContain('national_id');
    expect(bicycle).toContain('police_clearance');
    expect(bicycle).not.toContain('drivers_licence');

    const motorcycle = await countryConfig.getMoverChecklist('GY', 'MOTORCYCLE');
    expect(motorcycle).toContain('drivers_licence');
    expect(motorcycle).toContain('vehicle_insurance');
    expect(motorcycle).not.toContain('hire_car_permit');

    const car = await countryConfig.getMoverChecklist('GY', 'CAR');
    expect(car).toContain('drivers_licence');
    expect(car).toContain('police_clearance');
    expect(car).toContain('vehicle_exterior_photo');
    expect(car).toContain('fitness_cert');
  });

  it('lists Guyana among active countries for the signup picker', async () => {
    const active = await countryConfig.getActiveCountries();
    expect(active.some((c) => c.code === 'GY')).toBe(true);
  });
});

describe('Vendors — exactly the locked types, with stable QR slugs', () => {
  it('has at least one vendor of each of the 4 locked types', async () => {
    const types = await prisma.vendor.groupBy({ by: ['vendorType'], _count: true });
    const present = new Set(types.map((t) => t.vendorType));
    for (const required of ['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE'] as const) {
      expect(present.has(required)).toBe(true);
    }
  });

  it('every vendor has a unique, non-empty qrSlug', async () => {
    const vendors = await prisma.vendor.findMany({ select: { qrSlug: true } });
    expect(vendors.length).toBeGreaterThan(0);
    for (const v of vendors) expect(v.qrSlug.length).toBeGreaterThan(0);
    expect(new Set(vendors.map((v) => v.qrSlug)).size).toBe(vendors.length);
  });
});

describe('Listings — one model for goods AND services', () => {
  it('has listings of every fulfillment kind', async () => {
    const [delivery, pickup, appointment] = await Promise.all([
      prisma.item.count({ where: { fulfillment: 'DELIVERY' } }),
      prisma.item.count({ where: { fulfillment: 'PICKUP' } }),
      prisma.item.count({ where: { fulfillment: 'APPOINTMENT' } }),
    ]);
    expect(delivery).toBeGreaterThan(0);
    expect(pickup).toBeGreaterThan(0);
    expect(appointment).toBeGreaterThan(0);
  });

  it('APPOINTMENT listings carry a bookingConfig with duration and slots', async () => {
    const service = await prisma.item.findFirst({
      where: { fulfillment: 'APPOINTMENT' },
      select: { bookingConfig: true },
    });
    expect(service).not.toBeNull();
    const config = service!.bookingConfig as { durationMinutes: number; slots: unknown[] };
    expect(config.durationMinutes).toBeGreaterThan(0);
    expect(Array.isArray(config.slots)).toBe(true);
    expect(config.slots.length).toBeGreaterThan(0);
  });
});

describe('Trust levels, verification documents, strikes', () => {
  it('new users default to trust level L1', async () => {
    await prisma.user.deleteMany({ where: { phone: '+5920000888' } });
    const user = await prisma.user.create({
      data: {
        phone: '+5920000888',
        firstName: 'Trust',
        lastName: 'Default',
        roles: ['CUSTOMER'],
        activeRole: 'CUSTOMER',
      },
    });
    expect(user.trustLevel).toBe('L1');
    expect(user.countryCode).toBe('GY');
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('walks a verification document through its full lifecycle', async () => {
    const doc = await prisma.verificationDocument.create({
      data: { userId: customerId, role: 'CUSTOMER', docType: 'national_id', fileUrl: 'storage://smoke/national_id.jpg' },
    });
    expect(doc.status).toBe('PENDING');

    for (const status of ['APPROVED', 'REJECTED', 'EXPIRED'] as const) {
      const updated = await prisma.verificationDocument.update({
        where: { id: doc.id },
        data: { status, reviewedBy: 'smoke-test', reviewedAt: new Date() },
      });
      expect(updated.status).toBe(status);
    }
  });

  it('records strikes with phone and address fingerprint for collusion checks', async () => {
    const strike = await prisma.strike.create({
      data: {
        userId: customerId,
        reason: 'failed_payment_no_show',
        phone: '+5926003000',
        addressKey: 'georgetown:main-street:123',
      },
    });
    expect(strike.id).toBeTruthy();
    const count = await prisma.strike.count({ where: { userId: customerId } });
    expect(count).toBeGreaterThan(0);
  });
});

describe('Order lifecycle — every state, append-only log as evidence', () => {
  it('walks an order PENDING -> ACCEPTED -> PREPARING -> READY_FOR_PICKUP -> PICKED_UP -> DELIVERED', async () => {
    const order = await createSmokeOrder('happy');
    expect(order.status).toBe('PENDING');

    const path = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'PICKED_UP', 'DELIVERED'] as const;
    for (const status of path) {
      const updated = await orderService.updateStatus(order.id, status, 'smoke-test', `smoke: ${status}`);
      expect(updated.status).toBe(status);
    }

    const final = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(final.status).toBe('DELIVERED');
    expect(final.acceptedAt).not.toBeNull();
    expect(final.pickedUpAt).not.toBeNull();
    expect(final.deliveredAt).not.toBeNull();

    const log = await prisma.orderStatusLog.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(log.map((l) => l.status)).toEqual([...path]);
  });

  it('walks the cancellation path and logs it', async () => {
    const order = await createSmokeOrder('cancel');
    const updated = await orderService.updateStatus(order.id, 'CANCELLED', 'smoke-test', 'smoke: cancelled');
    expect(updated.status).toBe('CANCELLED');

    const log = await prisma.orderStatusLog.findMany({ where: { orderId: order.id } });
    expect(log.some((l) => l.status === 'CANCELLED')).toBe(true);
  });
});
