import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { driverRoutes } from '../modules/driver/driver.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { haversineDistance } from '../utils/distance';

let app: FastifyInstance;
let token: string;
let customerId: string;
let driverId: string;
let riderId: string;
const users: string[] = [];
const orders: string[] = [];
const at = { lat: 6.8013, lng: -58.1551 };
const pickup = { lat: 6.81137, lng: -58.15427 };
const dropoff = { lat: 6.83147, lng: -58.14273 };
const snap = (v: number) => Math.round(v / 0.003) * 0.003;
const money = { subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 1500, totalAmount: 1500, paymentMethod: 'CASH' as const };

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  const base = 592_750_000_000 + Math.floor(Math.random() * 100_000_000);
  const mover = await app.prisma.user.create({ data: { phone: `+${base}`, firstName: 'Fixture', lastName: 'Mover', roles: ['MOVER'], activeRole: 'MOVER', isPhoneVerified: true } });
  const customer = await app.prisma.user.create({ data: { phone: `+${base + 1}`, firstName: 'PrivateFixture', lastName: 'Customer', avatar: 'https://example.invalid/private-avatar', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } } });
  users.push(mover.id, customer.id); customerId = customer.id;
  token = app.jwt.sign({ userId: mover.id, role: 'MOVER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: mover.id, token, refreshToken: nanoid(48), deviceId: 'board-privacy', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  driverId = (await app.prisma.driver.create({ data: { userId: mover.id, vehicleMake: 'Fixture', vehicleModel: 'Car', vehicleYear: 2020, vehicleColor: 'Grey', licensePlate: nanoid(10), driverLicenseUrl: 'https://example.invalid/document', vehicleInsuranceUrl: 'https://example.invalid/document', isOnline: true, isAvailable: true, locationSessionId: nanoid(), currentLat: at.lat, currentLng: at.lng } })).id;
  riderId = (await app.prisma.rider.create({ data: { userId: mover.id, riderType: 'COURIER', vehicleType: 'MOTORCYCLE', isOnline: true, isAvailable: true, locationSessionId: nanoid(), currentLat: at.lat, currentLng: at.lng } })).id;
});

afterAll(async () => {
  if (!app) return;
  await runWithoutTenant(async () => {
    await app.prisma.taxiTripStop.deleteMany({ where: { orderId: { in: orders } } });
    await app.prisma.orderItem.deleteMany({ where: { orderId: { in: orders } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orders } } });
    await app.prisma.driver.deleteMany({ where: { id: driverId } });
    await app.prisma.rider.deleteMany({ where: { id: riderId } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.identityKey.deleteMany({ where: { accountId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  }, 'test-cleanup:l05-board');
  await app.close();
});

describe('unassigned boards reveal operational summaries only', () => {
  it('taxi omits passenger identity and private addresses, including intermediate stops', async () => {
    const order = await app.prisma.order.create({ data: { ...money, orderNumber: `BP-${nanoid()}`, orderType: 'TAXI', customerId, status: 'PENDING', pickupLat: pickup.lat, pickupLng: pickup.lng, deliveryLat: dropoff.lat, deliveryLng: dropoff.lng, pickupAddress: 'private pickup fixture', deliveryAddress: 'private destination fixture', taxiStopCount: 1, taxiFareTotal: 1500, taxiStops: { create: { sequence: 1, lat: 6.82147, lng: -58.14873, address: 'private stop fixture' } } } });
    orders.push(order.id);
    const res = await app.inject({ method: 'GET', url: '/api/v1/driver/rides/available', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode, res.body).toBe(200);
    const row = res.json().data.find((r: { id: string }) => r.id === order.id);
    expect(row).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(['id', 'orderNumber', 'pickupLat', 'pickupLng', 'dropoffLat', 'dropoffLng', 'passengerCount', 'estimatedDistance', 'estimatedDuration', 'fareTotal', 'fareSurge', 'distanceToPickup', 'etaToPickup', 'customer', 'createdAt', 'stopCount', 'stops'].sort());
    expect(Object.keys(row.customer)).toEqual(['displayRating']);
    expect(row.stops[0]).toEqual({ sequence: 1, lat: snap(6.82147), lng: snap(-58.14873) });
    expect(row.pickupLat).toBe(snap(pickup.lat)); expect(row.pickupLng).toBe(snap(pickup.lng));
    expect(row.dropoffLat).toBe(snap(dropoff.lat)); expect(row.dropoffLng).toBe(snap(dropoff.lng));
    expect(row.distanceToPickup).toBe(Math.round(haversineDistance(at.lat, at.lng, snap(pickup.lat), snap(pickup.lng)) * 10) / 10);
    expect(JSON.stringify(row)).not.toContain('private');
    expect(JSON.stringify(row)).not.toContain(customerId);
    // Assignment surfaces keep the exact journey needed to perform the job.
    await app.prisma.order.update({ where: { id: order.id }, data: { driverId, status: 'DRIVER_ASSIGNED' } });
    await app.prisma.driver.update({ where: { id: driverId }, data: { currentRideId: order.id } });
    const active = await app.inject({ method: 'GET', url: '/api/v1/driver/rides/active', headers: { authorization: `Bearer ${token}` } });
    expect(active.statusCode, active.body).toBe(200);
    expect(Number(active.json().data.pickupLat)).toBe(pickup.lat);
    expect(active.json().data.pickupAddress).toBe('private pickup fixture');
    await app.prisma.driver.update({ where: { id: driverId }, data: { currentRideId: null } });
  });

  it('courier omits addresses, instructions and item names; distances use coarse private points', async () => {
    const order = await app.prisma.order.create({ data: { ...money, orderNumber: `BP-${nanoid()}`, orderType: 'COURIER', customerId, status: 'READY_FOR_PICKUP', fulfillment: 'DELIVERY', pickupLat: pickup.lat, pickupLng: pickup.lng, deliveryLat: dropoff.lat, deliveryLng: dropoff.lng, pickupAddress: 'private parcel pickup', deliveryAddress: 'private parcel destination', deliveryInstructions: 'private instruction fixture', items: { create: { itemId: nanoid(), name: 'private item fixture', quantity: 2, basePrice: 0, markedUpPrice: 0, markupAmount: 0, totalBase: 0, totalMarkup: 0, totalCustomer: 0 } } } });
    orders.push(order.id);
    const res = await app.inject({ method: 'GET', url: '/api/v1/rider/orders/available', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode, res.body).toBe(200);
    const row = res.json().data.find((r: { id: string }) => r.id === order.id);
    expect(row).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(['id', 'orderNumber', 'orderType', 'status', 'vendor', 'itemCount', 'estLoad', 'deliveryFee', 'tipAmount', 'totalEarning', 'isExpress', 'paymentMethod', 'customerTrust', 'pickupDistanceKm', 'deliveryDistanceKm', 'estimatedPrepTime', 'estimatedDeliveryTime', 'placedAt'].sort());
    expect(row.itemCount).toBe(2); expect(row.deliveryFee).toBe(1500);
    expect(row.pickupDistanceKm).toBe(Math.round(haversineDistance(at.lat, at.lng, snap(pickup.lat), snap(pickup.lng)) * 10) / 10);
    expect(row.deliveryDistanceKm).toBe(Math.round(haversineDistance(snap(pickup.lat), snap(pickup.lng), snap(dropoff.lat), snap(dropoff.lng)) * 10) / 10);
    expect(JSON.stringify(row)).not.toContain('private');
  });
});
