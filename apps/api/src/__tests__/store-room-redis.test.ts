import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import { once } from 'node:events';
import type Redis from 'ioredis';
import type { AddressInfo } from 'node:net';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { isStoreRoomMember } from '../modules/notification/store-alert-recipients';
import { revokeStoreRoom } from '../modules/notification/store-room';

// The store-room membership rule runs for real; the mock only lets the test
// park a subscription's read after it said yes.
vi.mock('../modules/notification/store-alert-recipients', async (importOriginal) => {
  const real = await importOriginal<typeof import('../modules/notification/store-alert-recipients')>();
  return { ...real, isStoreRoomMember: vi.fn(real.isStoreRoomMember) };
});

// ---------------------------------------------------------------------------
// [Q10 loud alerts 2/4 · AX317 F03] A store room across two API instances on
// the production Redis adapter, when a removal's revocation is LOST: it is
// published while the other instance's Redis subscriber is down (Redis
// Pub/Sub keeps nothing for a subscriber that is not connected). That
// instance must stop trusting the stream the moment it drops, and read every
// store-room membership again before it trusts it again: the removed member,
// whether already in the room or with a subscription in flight (answered
// during the outage, or only after the recovery), hears nothing after it, and
// the owner is back in the room without asking.
//
// Fixture range: +5920419nnn (this file only; a grep of apps/, packages/ and
// scripts/ found no other use of 5920419).
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+5920419';

let first: FastifyInstance;
let second: FastifyInstance;
let secondUrl: string;
const sockets: Socket[] = [];

type RedisBackedAdapter = { pubClient: Redis; subClient: Redis };
const adapterOf = (node: FastifyInstance) => node.io.of('/').adapter as unknown as RedisBackedAdapter;

async function makeNode(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  try {
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(authPlugin);
    await app.register(socketPlugin);
    await app.listen({ host: '127.0.0.1', port: 0 });
    return app;
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
}

function connectReady(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const candidate = ioClient(secondUrl, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 3_000 });
    sockets.push(candidate);
    const timer = setTimeout(() => reject(new Error('socket authorization timed out')), 7_500);
    candidate.once('auth:ready', () => { clearTimeout(timer); resolve(candidate); });
    candidate.once('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

let seq = 0;
async function makeUser(role: 'VENDOR_OWNER' | 'CUSTOMER'): Promise<{ userId: string; token: string }> {
  seq += 1;
  const user = await first.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Room', lastName: `Cluster${seq}`, roles: [role], activeRole: role,
      status: 'ACTIVE', isPhoneVerified: true,
    },
  });
  const token = first.jwt.sign({ userId: user.id, role, jti: nanoid(8) });
  await first.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `q10c-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
  });
  return { userId: user.id, token };
}

async function purgeFixtures() {
  await runWithoutTenant(async () => {
    const ids = (await first.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } })).map((u) => u.id);
    const ownerIds = (await first.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((o) => o.id);
    const vendorIds = (await first.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } })).map((v) => v.id);
    await first.prisma.vendorStaff.deleteMany({ where: { OR: [{ userId: { in: ids } }, { vendorId: { in: vendorIds } }] } });
    await first.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await first.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
    await first.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await first.prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

/** The sockets in `room` on THIS node only. */
const localRoom = async (node: FastifyInstance, room: string) => (await node.io.local.in(room).fetchSockets()).map((s) => s.id);

/** A round trip on the socket's own connection: the reply comes after any
 *  broadcast the server had already sent it. */
const barrier = (socket: Socket) => new Promise<void>((done) => {
  socket.emit('vendor:subscribe', {}, () => done());
  setTimeout(done, 1_000);
});

function subscribe(socket: Socket, vendorId: string): Promise<{ joined: boolean } | 'no-answer'> {
  return new Promise((resolve) => {
    socket.emit('vendor:subscribe', { vendorId }, resolve);
    setTimeout(() => resolve('no-answer'), 4_000);
  });
}

beforeAll(async () => {
  // [F-027-15] A production boot must also name a real push provider.
  process.env['NODE_ENV'] = 'production';
  process.env['PUSH_PROVIDER'] = 'expo';
  process.env['CORS_ORIGIN'] = 'http://127.0.0.1';
  process.env['DATABASE_URL'] ||= 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] ||= 'redis://localhost:6382';
  process.env['JWT_SECRET'] ||= 'store-room-cluster-test-secret-at-least-32-characters';

  first = await makeNode();
  try {
    second = await makeNode();
  } catch (error) {
    await first.close();
    throw error;
  }
  secondUrl = `http://127.0.0.1:${(second.server.address() as AddressInfo).port}`;
  await purgeFixtures();
});

afterAll(async () => {
  for (const socket of sockets) socket.disconnect();
  const errors: unknown[] = [];
  try {
    await purgeFixtures();
  } catch (error) {
    errors.push(error);
  }
  const closeResults = await Promise.allSettled([first.close(), second.close()]);
  for (const result of closeResults) if (result.status === 'rejected') errors.push(result.reason);
  if (errors.length > 0) throw new AggregateError(errors, 'Store-room cluster test cleanup failed');
});

describe('a store room across instances when a revocation is lost (AX317 F03)', () => {
  it('the instance whose subscriber dropped closes its store rooms, and after the reconnect reads every membership again: the removed member hears nothing, the owner is back', async () => {
    const owner = await makeUser('VENDOR_OWNER');
    const member = await makeUser('CUSTOMER');
    const vendorOwner = await first.prisma.vendorOwner.create({ data: { userId: owner.userId } });
    const vendor = await first.prisma.vendor.create({
      data: {
        ownerId: vendorOwner.id, name: 'Cluster Kitchen', slug: `q10c-${nanoid(8).toLowerCase().replace(/[^a-z0-9]/g, '0')}`,
        vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}900`,
        addressLine1: '7 Relay Road', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.81, longitude: -58.16,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      },
    });
    const staffRow = await first.prisma.vendorStaff.create({ data: { vendorId: vendor.id, userId: member.userId, role: 'STAFF', invitedBy: owner.userId } });
    const room = `vendor:${vendor.id}`;
    const subClient = adapterOf(second).subClient;
    const originalRetry = subClient.options.retryStrategy;
    const real = vi.mocked(isStoreRoomMember).getMockImplementation()!;
    try {
      // On instance 2: the owner and the member's phone A in the store room.
      const ownerSocket = await connectReady(owner.token);
      const phoneA = await connectReady(member.token);
      expect(await subscribe(ownerSocket, vendor.id)).toEqual({ joined: true });
      expect(await subscribe(phoneA, vendor.id)).toEqual({ joined: true });
      const ownerHeard: string[] = [];
      const heardA: string[] = [];
      const heardB: string[] = [];
      const heardC: string[] = [];
      ownerSocket.on('order:new', (p: { orderId: string }) => ownerHeard.push(p.orderId));
      phoneA.on('order:new', (p: { orderId: string }) => heardA.push(p.orderId));
      // The control: a broadcast made on instance 1 reaches instance 2's room.
      first.io.to(room).emit('order:new', { orderId: 'q10c-before', vendorId: vendor.id });
      await vi.waitFor(() => {
        expect(ownerHeard).toEqual(['q10c-before']);
        expect(heardA).toEqual(['q10c-before']);
      }, { timeout: 5_000, interval: 25 });

      // The member's phones B and C subscribe on instance 2; each read says
      // yes (the member is still on the team) and is parked there. B's read
      // returns during the outage, C's only after the recovery.
      const phoneB = await connectReady(member.token);
      const phoneC = await connectReady(member.token);
      phoneB.on('order:new', (p: { orderId: string }) => heardB.push(p.orderId));
      phoneC.on('order:new', (p: { orderId: string }) => heardC.push(p.orderId));
      const parks: Array<{ read: Promise<void>; readDone: () => void; resume: () => void; resumed: Promise<void> }> = [0, 1].map(() => {
        let readDone!: () => void;
        let resume!: () => void;
        const read = new Promise<void>((done) => { readDone = done; });
        const resumed = new Promise<void>((done) => { resume = done; });
        return { read, readDone, resume, resumed };
      });
      let memberReads = 0;
      vi.mocked(isStoreRoomMember).mockImplementation(async (...args) => {
        const verdict = await real(...args);
        if (args[2] !== member.userId) return verdict;
        const park = parks[memberReads];
        memberReads += 1;
        if (park) {
          park.readDone();
          await park.resumed;
        }
        return verdict;
      });
      const decidedB = subscribe(phoneB, vendor.id);
      await parks[0]!.read;
      const decidedC = subscribe(phoneC, vendor.id);
      await parks[1]!.read;

      // Instance 2's Redis subscriber drops and stays down for a second.
      subClient.options.retryStrategy = () => 1_000;
      const dropped = once(subClient, 'close');
      subClient.disconnect(true);
      await dropped;
      const roomDuringGap = await localRoom(second, room);

      // Instance 1 removes the member. Its revocation is published while
      // instance 2 is not subscribed: instance 2 never receives it.
      await first.prisma.vendorStaff.delete({ where: { id: staffRow.id } });
      revokeStoreRoom(first.io, vendor.id, member.userId);
      await adapterOf(first).pubClient.ping(); // Redis has processed the publish
      expect(subClient.status).not.toBe('ready');
      // Phone B's read, which said yes before the removal, returns now.
      parks[0]!.resume();
      const outcomeB = await decidedB;

      // Instance 2's subscriber is back and its subscriptions are in place.
      await vi.waitFor(() => expect(subClient.status).toBe('ready'), { timeout: 5_000, interval: 25 });
      await subClient.ping();
      subClient.options.retryStrategy = originalRetry;
      // The owner is in the store room again without asking again.
      const ownerOnSecond = ownerSocket.id!;
      await vi.waitFor(async () => expect(await localRoom(second, room)).toContain(ownerOnSecond), { timeout: 5_000, interval: 25 });
      // Phone C's read, which said yes before the removal, returns only now,
      // with the stream trusted again.
      parks[1]!.resume();
      const outcomeC = await decidedC;

      // The next broadcast from instance 1 reaches the owner, and not the
      // removed member on either phone.
      first.io.to(room).emit('order:new', { orderId: 'q10c-after-recovery', vendorId: vendor.id });
      await vi.waitFor(() => expect(ownerHeard).toEqual(['q10c-before', 'q10c-after-recovery']), { timeout: 5_000, interval: 25 });
      await Promise.all([barrier(phoneA), barrier(phoneB), barrier(phoneC)]);
      expect(heardA).toEqual(['q10c-before']);
      expect(heardB).toEqual([]);
      expect(heardC).toEqual([]);
      expect(outcomeB).toEqual({ joined: false });
      expect(outcomeC).toEqual({ joined: false });
      const roomAfter = await localRoom(second, room);
      expect(roomAfter).not.toContain(phoneA.id);
      expect(roomAfter).not.toContain(phoneB.id);
      expect(roomAfter).not.toContain(phoneC.id);
      // While the stream could not be trusted, nobody here was in the room.
      expect(roomDuringGap).toEqual([]);
    } finally {
      subClient.options.retryStrategy = originalRetry;
      vi.mocked(isStoreRoomMember).mockImplementation(real);
    }
  });
});
