import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { earningsSummaryContract } from '../contracts/earnings';
import { walkOrderStatus } from './helpers/order-status-walk';

// ---------------------------------------------------------------------------
// [Board 13a "CASH COLLECTED · cash in hand" · owner 25 Oct 22:33Z] Each mover's earnings summary carries the cash
// they actually kept from handed-over CASH jobs, per period: the cash taken at the door (the stated amount, or the
// full total when none was stated) minus what they paid the store (subtotalBase; a taxi ride and a courier job have
// no store). MMG jobs and jobs that never completed carry no cash in hand; a ride or a courier job whose cash was never
// captured carries none either (createEarnings' rule, M-28/M-29); a delivered order its store refunded later still does.
// ---------------------------------------------------------------------------

const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, '0');
const PHONE_RUN = String(Date.now()).slice(-8);
const GEO = { lat: 6.8013, lng: -58.1551 };
const DAY = 24 * 3600 * 1000;

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
let vendorId = '';
let customerUserId = '';
let riderId = '';
let riderToken = '';
let driverId = '';
let driverToken = '';
// [REVIEW-G #2117 S4-1] Another rider and driver in the SAME tenant, with cash jobs of their own: each figure is the
// caller's own jobs only.
let otherRiderId = '';
let otherDriverId = '';

async function user(first: string, roles: UserRole[], active: UserRole) {
  seq += 1;
  const u = await app.prisma.user.create({ data: {
    phone: `+592${PHONE_RUN}${String(seq).padStart(3, '0')}`, firstName: first, lastName: `Cash${RUN}`,
    roles, activeRole: active, countryCode: 'GY', isPhoneVerified: true, status: 'ACTIVE',
  } });
  userIds.push(u.id);
  return u;
}
async function session(userId: string, role: string) {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `cih-${RUN}-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return token;
}

/** A completed job, walked along declared edges to DELIVERED, delivered at `deliveredAt`. */
async function job(o: {
  mover: { riderId: string } | { driverId: string };
  method: 'CASH' | 'MOBILE_MONEY';
  subtotal: number; fee: number;
  door?: number;
  deliveredAt?: Date;
  taxi?: boolean;
  courier?: boolean;
  /** The cash outcome captured the payment (every handover in production does); false = a legacy uncaptured row. */
  captured?: boolean;
  stopAt?: 'PICKED_UP';
  thenTo?: 'REFUNDED';
}) {
  const total = o.subtotal + o.fee;
  const order = await app.prisma.order.create({ data: {
    orderNumber: `CIH-${RUN}-${nanoid(6)}`,
    orderType: o.taxi ? 'TAXI' : o.courier ? 'COURIER' : 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
    customerId: customerUserId, ...(o.taxi || o.courier ? {} : { vendorId }),
    status: o.taxi ? 'DRIVER_ASSIGNED' : 'RIDER_ASSIGNED',
    paymentMethod: o.method, paymentStatus: o.stopAt || o.captured === false ? 'PENDING' : 'CAPTURED',
    subtotalBase: o.subtotal, subtotalMarkup: 0, subtotalCustomer: o.subtotal,
    deliveryFee: o.fee, serviceFee: 0, taxAmount: 0, tipAmount: 0, discount: 0, totalAmount: total,
    ...(o.taxi ? { taxiFareTotal: total } : {}),
    deliveryAddress: '1 Cash Street', deliveryLat: GEO.lat + 0.01, deliveryLng: GEO.lng + 0.01,
    pickupLat: GEO.lat, pickupLng: GEO.lng, pickupAddress: 'Pickup corner',
    ...o.mover, acceptedAt: new Date(), pickedUpAt: new Date(),
  } });
  if (o.stopAt) {
    await walkOrderStatus(app.prisma, order.id, o.stopAt);
  } else {
    await walkOrderStatus(app.prisma, order.id, 'DELIVERED', {
      deliveredAt: o.deliveredAt ?? new Date(),
      ...(o.door != null ? { doorCashCollectedAmount: o.door } : {}),
    });
    if (o.thenTo) await walkOrderStatus(app.prisma, order.id, o.thenTo);
  }
  return order.id;
}

const summary = async (who: 'rider' | 'driver') => {
  const res = await app.inject({ method: 'GET', url: `/${who}/earnings/summary`, headers: { authorization: `Bearer ${who === 'rider' ? riderToken : driverToken}` } });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  earningsSummaryContract.parse(body);
  return body.data;
};

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/rider' });
  await app.register(driverRoutes, { prefix: '/driver' });
  await app.ready();

  const vendor = await runWithoutTenant(() => app.prisma.vendor.findFirst({
    where: { status: 'ACTIVE', owner: { user: { status: 'ACTIVE' } } }, select: { id: true },
  }), 'test:mover-cash-in-hand');
  if (!vendor) throw new Error('seeded ACTIVE vendor with an owner required');
  vendorId = vendor.id;
  customerUserId = (await user('Cust', ['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole)).id;

  const newRider = async (first: string) => {
    const u = await user(first, ['MOVER', 'CUSTOMER'] as UserRole[], 'MOVER' as UserRole);
    const id = (await app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit: 40_000 } })).id;
    return { userId: u.id, id };
  };
  const newDriver = async (first: string) => {
    const u = await user(first, ['MOVER', 'CUSTOMER'] as UserRole[], 'MOVER' as UserRole);
    const id = (await app.prisma.driver.create({ data: {
      userId: u.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2021, vehicleColor: 'Silver',
      licensePlate: `CI-${nanoid(4)}`, rideClass: 'ECONOMY', documentsVerified: true,
      driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
    } })).id;
    return { userId: u.id, id };
  };

  const r = await newRider('Rida');
  riderId = r.id;
  riderToken = await session(r.userId, 'MOVER');
  otherRiderId = (await newRider('Ridb')).id;

  const d = await newDriver('Driva');
  driverId = d.id;
  driverToken = await session(d.userId, 'MOVER');
  otherDriverId = (await newDriver('Drivb')).id;
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    const orders = await app.prisma.order.findMany({ where: { orderNumber: { startsWith: `CIH-${RUN}-` } }, select: { id: true } });
    const ids = orders.map((o) => o.id);
    await app.prisma.orderStatusLog.deleteMany({ where: { orderId: { in: ids } } }).catch(() => {});
    await app.prisma.order.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await app.prisma.rider.deleteMany({ where: { id: { in: [riderId, otherRiderId].filter(Boolean) } } }).catch(() => {});
    await app.prisma.driver.deleteMany({ where: { id: { in: [driverId, otherDriverId].filter(Boolean) } } }).catch(() => {});
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'test:mover-cash-in-hand:cleanup');
  await app.close();
});

describe('[board 13a] cash in hand on the earnings summary', () => {
  it('a rider: door cash minus the store’s share, per period; MMG and unfinished jobs carry none', async () => {
    expect((await summary('rider')).cashInHand).toEqual({ today: 0, thisWeek: 0, thisMonth: 0, allTime: 0 });

    await job({ mover: { riderId }, method: 'CASH', subtotal: 3000, fee: 500 });                 // full 3,500 assumed − 3,000 = 500
    await job({ mover: { riderId }, method: 'CASH', subtotal: 3000, fee: 500, door: 3200 });     // stated short 3,200 − 3,000 = 200
    await job({ mover: { riderId }, method: 'CASH', subtotal: 1500, fee: 500, deliveredAt: new Date(Date.now() - 40 * DAY) }); // 500, all time only
    await job({ mover: { riderId }, method: 'MOBILE_MONEY', subtotal: 9000, fee: 500 });                  // no cash
    await job({ mover: { riderId }, method: 'CASH', subtotal: 9000, fee: 500, stopAt: 'PICKED_UP' }); // not completed

    expect((await summary('rider')).cashInHand).toEqual({ today: 700, thisWeek: 700, thisMonth: 700, allTime: 1200 });

    await job({ mover: { riderId }, method: 'CASH', subtotal: 0, fee: 1200, courier: true });                  // courier fee: 1,200, no store
    await job({ mover: { riderId }, method: 'CASH', subtotal: 0, fee: 900, courier: true, captured: false });  // never captured: none
    await job({ mover: { riderId }, method: 'CASH', subtotal: 2000, fee: 400, thenTo: 'REFUNDED' });          // store refunded later: 400 stays
    await job({ mover: { riderId: otherRiderId }, method: 'CASH', subtotal: 1000, fee: 9_000 });              // another rider's: never mine

    expect((await summary('rider')).cashInHand).toEqual({ today: 2300, thisWeek: 2300, thisMonth: 2300, allTime: 2800 });
  });

  it('a taxi driver: the cash fare collected, with no store share taken from it', async () => {
    await job({ mover: { driverId }, method: 'CASH', subtotal: 1500, fee: 0, taxi: true });
    await job({ mover: { driverId }, method: 'CASH', subtotal: 2500, fee: 0, taxi: true, captured: false }); // never captured: none
    await job({ mover: { driverId }, method: 'MOBILE_MONEY', subtotal: 3000, fee: 0, taxi: true });          // paid by MMG: none
    await job({ mover: { driverId: otherDriverId }, method: 'CASH', subtotal: 7_000, fee: 0, taxi: true });  // another driver's: never mine
    const data = await summary('driver');
    expect(data.cashInHand).toEqual({ today: 1500, thisWeek: 1500, thisMonth: 1500, allTime: 1500 });
    // The rider's figure never takes the driver's rides, and the driver's never takes the rider's deliveries.
    expect((await summary('rider')).cashInHand.allTime).toBe(2800);
  });
});
