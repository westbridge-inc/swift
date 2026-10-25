/**
 * STAGING-RUN finding (21 Oct): staging runs NODE_ENV=loadtest, and the Socket.IO
 * Redis adapter only ran in production. So an emit from the worker process (e.g.
 * order:new when a held order is released) never reached a socket held by the API
 * process: store boards on staging (what the store reviewers use) got no live
 * order:new for held orders. Ruling (COORD): the adapter runs in every non-test
 * mode; test mode stays on the in-memory adapter; production's boot rule unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { io as ioClient, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import type { AddressInfo } from 'node:net';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { usesSocketRedisAdapter } from '../utils/runtime-mode';
import { attachWorkerSocketAdapter } from '../utils/worker-socket-adapter';
import { testPhone } from './helpers/fixture-ids';

let api: FastifyInstance;
let apiUrl: string;
let socket: Socket | undefined;
let userId: string | undefined;
const workerIo = new Server();
let workerRedis: Redis;
const workerConnections: Redis[] = [];
let workerAttached = false;

function connectReady(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const candidate = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 3_000 });
    const timer = setTimeout(() => {
      candidate.disconnect();
      reject(new Error('socket authorization timed out'));
    }, 7_500);
    candidate.once('auth:ready', () => {
      clearTimeout(timer);
      resolve(candidate);
    });
    candidate.once('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

beforeAll(async () => {
  // Staging's mode. A production-like boot names a real push provider (see
  // socket-redis-adapter.test.ts); this file opts in to the adapter under vitest.
  process.env['NODE_ENV'] = 'loadtest';
  process.env['SOCKET_REDIS_ADAPTER_UNDER_VITEST'] = '1';
  process.env['PUSH_PROVIDER'] = 'expo';
  process.env['CORS_ORIGIN'] = 'http://127.0.0.1';
  process.env['JWT_SECRET'] ||= 'socket-nonprod-adapter-test-secret-at-least-32-chars';

  const app = Fastify({ logger: false });
  try {
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(authPlugin);
    await app.register(socketPlugin);
    await app.listen({ host: '127.0.0.1', port: 0 });
  } catch (error) {
    await app.close().catch(() => {});
    throw error;
  }
  api = app;
  apiUrl = `http://127.0.0.1:${(api.server.address() as AddressInfo).port}`;

  // The worker process's side, built exactly as worker.ts builds it.
  workerRedis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6382', { maxRetriesPerRequest: null });
  workerAttached = await attachWorkerSocketAdapter(
    { io: workerIo, redis: workerRedis, log: { error: () => {} }, startupTimeoutMs: 5_000 },
    workerConnections,
  );
});

afterAll(async () => {
  socket?.disconnect();
  // Like worker.ts: the listener-less io is never closed (Server.close needs an engine); its Redis connections are.
  await Promise.allSettled([...workerConnections, workerRedis].filter(Boolean).map((c) => c.quit()));
  if (userId && api) {
    await api.prisma.session.deleteMany({ where: { userId } });
    await api.prisma.moverRevocationOutbox.deleteMany({ where: { userId } });
    await api.prisma.user.deleteMany({ where: { id: userId } });
  }
  await api?.close();
});

describe('Socket.IO Redis adapter outside production', () => {
  it('runs in production, loadtest and development; test keeps the in-memory adapter', () => {
    expect(usesSocketRedisAdapter({ NODE_ENV: 'production' })).toBe(true);
    expect(usesSocketRedisAdapter({ NODE_ENV: 'loadtest' })).toBe(true);
    expect(usesSocketRedisAdapter({ NODE_ENV: 'development' })).toBe(true);
    expect(usesSocketRedisAdapter({ NODE_ENV: 'test' })).toBe(false);
    // Production cannot be turned off, not even under vitest.
    expect(usesSocketRedisAdapter({ NODE_ENV: 'production', VITEST: 'true' })).toBe(true);
    // A vitest file that flips NODE_ENV to development stays in-memory unless it opts in.
    expect(usesSocketRedisAdapter({ NODE_ENV: 'development', VITEST: 'true' })).toBe(false);
    expect(usesSocketRedisAdapter({ NODE_ENV: 'loadtest', VITEST: 'true', SOCKET_REDIS_ADAPTER_UNDER_VITEST: '1' })).toBe(true);
    expect(() => usesSocketRedisAdapter({ NODE_ENV: 'staging' })).toThrow();
  });

  it('a worker-side emit reaches a store socket held by the API process (loadtest = staging)', async () => {
    const user = await api.prisma.user.create({
      data: { phone: testPhone(), firstName: 'Worker', lastName: 'Emit', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE', isPhoneVerified: true },
    });
    userId = user.id;
    const token = api.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    await api.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'nonprod-adapter-test', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) },
    });
    socket = await connectReady(apiUrl, token);

    const orderId = `held-${nanoid(8)}`;
    const received = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the worker emit never reached the API socket')), 5_000);
      socket!.once('order:new', (payload: unknown) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });
    expect(workerAttached).toBe(true);
    workerIo.to(`user:${user.id}`).emit('order:new', { orderId });

    expect(await received).toEqual({ orderId });
  });
});
