import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { Server } from 'socket.io';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { authPlugin } from '../plugins/auth';
import {
  GreedyDispatchPlanner,
  VroomDispatchPlanner,
  getDispatchPlanner,
  type PlanJob,
  type PlanVehicle,
} from '../providers/dispatch/dispatch-planner';
import { assignReadyRiders } from '../jobs/assign-riders';

// ---------------------------------------------------------------------------
// Dispatch planning (build-kit L). The greedy planner mirrors the historical
// nearest-rider rule; VROOM solves the batch globally and falls back to
// greedy on any failure; the sweep applies plans with CAS so racers resolve
// to one winner and a claimed order rolls its rider back.
// ---------------------------------------------------------------------------

function mockFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }));
}

// Two pickups and two riders arranged so GREEDY (order A first) picks the
// shared-nearest rider for A, while the GLOBAL optimum swaps them.
const JOB_A = { orderId: 'A', lat: 6.8100, lng: -58.1500 };
const JOB_B = { orderId: 'B', lat: 6.8110, lng: -58.1500 };
const RIDER_1 = { riderId: 'r1', lat: 6.8105, lng: -58.1500 }; // between both
const RIDER_2 = { riderId: 'r2', lat: 6.8000, lng: -58.1500 }; // south — near A only

describe('GreedyDispatchPlanner', () => {
  it('assigns each order the nearest still-free rider within 10km', async () => {
    const plan = await new GreedyDispatchPlanner().planAssignments([JOB_A, JOB_B], [RIDER_1, RIDER_2]);
    // A grabs r1 (nearest overall), B falls to r2.
    expect(plan).toEqual([
      { orderId: 'A', riderId: 'r1' },
      { orderId: 'B', riderId: 'r2' },
    ]);
  });

  it('leaves an order unassigned when nobody is within range', async () => {
    const farJob = { orderId: 'far', lat: 8.0, lng: -59.5 };
    const plan = await new GreedyDispatchPlanner().planAssignments([farJob], [RIDER_1]);
    expect(plan).toEqual([]);
  });
});

describe('VroomDispatchPlanner', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps VROOM routes back to order/rider pairs (index-based ids)', async () => {
    // VROOM's global optimum: vehicle 0 (r1) → job 1 (B); vehicle 1 (r2) → job 0 (A).
    const f = mockFetch(200, {
      code: 0,
      routes: [
        { vehicle: 0, steps: [{ type: 'start' }, { type: 'job', id: 1 }, { type: 'end' }] },
        { vehicle: 1, steps: [{ type: 'start' }, { type: 'job', id: 0 }, { type: 'end' }] },
      ],
    });
    vi.stubGlobal('fetch', f);
    const plan = await new VroomDispatchPlanner('http://vroom.test').planAssignments([JOB_A, JOB_B], [RIDER_1, RIDER_2]);
    expect(plan).toEqual([
      { orderId: 'B', riderId: 'r1' },
      { orderId: 'A', riderId: 'r2' },
    ]);

    const [, init] = f.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(init.body);
    expect(body.vehicles[0].capacity).toEqual([1]); // one order per rider — cash-float model intact
    expect(body.jobs[0].location).toEqual([JOB_A.lng, JOB_A.lat]); // lng,lat order
  });

  it('falls back to greedy when the solver is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const plan = await new VroomDispatchPlanner('http://vroom.test').planAssignments([JOB_A, JOB_B], [RIDER_1, RIDER_2]);
    expect(plan).toEqual(await new GreedyDispatchPlanner().planAssignments([JOB_A, JOB_B], [RIDER_1, RIDER_2]));
  });

  it('selection is config: greedy default, vroom needs VROOM_URL', () => {
    // The dev .env may point at live local engines — pin a clean env here.
    delete process.env['DISPATCH_PLANNER'];
    delete process.env['VROOM_URL'];
    expect(getDispatchPlanner()).toBeInstanceOf(GreedyDispatchPlanner);
    process.env['DISPATCH_PLANNER'] = 'vroom';
    expect(() => getDispatchPlanner()).toThrow(/VROOM_URL/);
    process.env['VROOM_URL'] = 'http://vroom.test';
    expect(getDispatchPlanner()).toBeInstanceOf(VroomDispatchPlanner);
    delete process.env['DISPATCH_PLANNER'];
    delete process.env['VROOM_URL'];
  });
});

describe('assignReadyRiders sweep (CAS application)', () => {
  let app: FastifyInstance;
  const createdUserIds: string[] = [];
  const ioStub = { to: () => ({ emit: () => {} }), emit: () => {} } as unknown as Server;

  let seq = 0;
  async function makeRider(lat: number, lng: number) {
    seq += 1;
    const user = await app.prisma.user.create({
      data: {
        phone: `+59200378${String(seq).padStart(2, '0')}`,
        firstName: 'Plan',
        lastName: `Rider${seq}`,
        roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole],
        activeRole: 'RIDER' as UserRole,
        isPhoneVerified: true,
        selfieCapturedAt: new Date(),
        customer: { create: {} },
      },
    });
    createdUserIds.push(user.id);
    return app.prisma.rider.create({
      data: {
        userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
        documentsVerified: true, isOnline: true, isAvailable: true,
        currentLat: lat, currentLng: lng,
      },
    });
  }

  async function makeReadyOrder(lat: number, lng: number) {
    seq += 1;
    const user = await app.prisma.user.create({
      data: {
        phone: `+59200379${String(seq).padStart(2, '0')}`,
        firstName: 'Plan',
        lastName: `Cust${seq}`,
        roles: ['CUSTOMER' as UserRole],
        activeRole: 'CUSTOMER' as UserRole,
        isPhoneVerified: true,
        selfieCapturedAt: new Date(),
        customer: { create: {} },
      },
    });
    createdUserIds.push(user.id);
    return app.prisma.order.create({
      data: {
        orderNumber: `PL-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: user.id,
        status: 'READY_FOR_PICKUP',
        pickupAddress: 'v', pickupLat: lat, pickupLng: lng,
        deliveryAddress: 'c', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 500, totalAmount: 1500, paymentMethod: 'CASH',
      },
    });
  }

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'development';
    process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
    process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
    app = Fastify({ logger: false });
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(authPlugin);
    await app.register(socketPlugin);
    await app.ready();
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
  });

  it('assigns the batch, marks riders busy, and reports the trigger outcome', async () => {
    const rider = await makeRider(6.8105, -58.1500);
    const order = await makeReadyOrder(6.8100, -58.1500);

    // Scope the planner to THIS test's pair — the sweep's batch query is
    // global and parallel test files own their orders/riders.
    const scoped = {
      planAssignments: (jobs: PlanJob[], vehicles: PlanVehicle[]) =>
        new GreedyDispatchPlanner().planAssignments(
          jobs.filter((j) => j.orderId === order.id),
          vehicles.filter((v) => v.riderId === rider.id),
        ),
    };
    const result = await assignReadyRiders({ prisma: app.prisma, io: ioStub }, order.id, scoped);
    expect(result.triggerAssigned).toBe(true);
    expect(result.assigned).toBeGreaterThanOrEqual(1);

    const after = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('RIDER_ASSIGNED');
    expect(after.riderId).toBe(rider.id);
    const riderAfter = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(riderAfter.isAvailable).toBe(false);
    expect(riderAfter.currentOrderId).toBe(order.id);
  });

  it('a claimed order is skipped and the rider is rolled back (CAS)', async () => {
    const rider = await makeRider(6.8105, -58.1500);
    const order = await makeReadyOrder(6.8100, -58.1500);

    // A "planner" that insists on assigning this pair, while the order gets
    // claimed under it (simulating a racing manual claim).
    const stubborn = {
      planAssignments: async () => {
        await app.prisma.order.update({ where: { id: order.id }, data: { status: 'PICKED_UP' } });
        return [{ orderId: order.id, riderId: rider.id }];
      },
    };
    const result = await assignReadyRiders({ prisma: app.prisma, io: ioStub }, order.id, stubborn);
    expect(result.assigned).toBe(0);

    const riderAfter = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(riderAfter.isAvailable).toBe(true); // rolled back, free again
    expect(riderAfter.currentOrderId).toBeNull();
  });
});
