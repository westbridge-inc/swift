import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import type Redis from 'ioredis';
import type { AddressInfo } from 'node:net';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { AuthService } from '../modules/auth/auth.service';

type RedisBackedAdapter = {
  pubClient: Redis;
};

let first: FastifyInstance;
let second: FastifyInstance;
let secondUrl: string;
let socket: Socket | undefined;
let userId: string | undefined;

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

function connectReady(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const candidate = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 3_000,
    });
    const timer = setTimeout(() => {
      candidate.disconnect();
      reject(new Error('cluster socket authorization timed out'));
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

function waitForDisconnect(candidate: Socket): Promise<void> {
  if (!candidate.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('remote socket was not disconnected'));
    }, 5_000);
    candidate.once('disconnect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'production';
  process.env['CORS_ORIGIN'] = 'http://127.0.0.1';
  process.env['DATABASE_URL'] ||= 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] ||= 'redis://localhost:6382';
  process.env['JWT_SECRET'] ||= 'socket-cluster-test-secret-at-least-32-characters';

  first = await makeNode();
  try {
    second = await makeNode();
  } catch (error) {
    await first.close();
    throw error;
  }
  secondUrl = `http://127.0.0.1:${(second.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  socket?.disconnect();
  if (userId) {
    await first.prisma.session.deleteMany({ where: { userId } });
    await first.prisma.moverRevocationOutbox.deleteMany({ where: { userId } });
    await first.prisma.user.deleteMany({ where: { id: userId } });
  }
  const closeResults = await Promise.allSettled([first.close(), second.close()]);
  const closeErrors = closeResults.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []);
  if (closeErrors.length > 0) {
    throw new AggregateError(closeErrors, 'Socket Redis test node cleanup failed');
  }
});

describe('production Socket.IO Redis adapter', () => {
  it('is subscription-ready before serving and evicts a socket on a peer node', async () => {
    const user = await first.prisma.user.create({
      data: {
        phone: `+59283${nanoid(7)}`,
        firstName: 'Redis',
        lastName: 'Socket',
        roles: ['CUSTOMER'],
        activeRole: 'CUSTOMER',
        status: 'ACTIVE',
        isPhoneVerified: true,
      },
    });
    userId = user.id;
    const token = first.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
    const session = await first.prisma.session.create({
      data: {
        userId: user.id,
        token,
        refreshToken: nanoid(48),
        deviceId: 'redis-cluster-test',
        deviceType: 'test',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    socket = await connectReady(secondUrl, token);
    expect(socket.connected).toBe(true);
    const disconnected = waitForDisconnect(socket);

    await new AuthService(first).logout(session.id, user.id);

    await disconnected;
    expect(socket.connected).toBe(false);
    expect(await first.prisma.session.findUnique({ where: { id: session.id } })).toBeNull();
  });

  it('observes an adapter publish rejection instead of raising an unhandled rejection', async () => {
    const adapter = first.io.of('/').adapter as unknown as RedisBackedAdapter;
    const logSpy = vi.spyOn(first.log, 'error');
    adapter.pubClient.disconnect(false);
    if (adapter.pubClient.status !== 'end') {
      await new Promise<void>((resolve) => adapter.pubClient.once('end', resolve));
    }

    // redis-adapter ignores this publish Promise. The installed command guard
    // must observe its rejection and keep the process alive.
    first.io.in(`missing:${nanoid(8)}`).disconnectSockets(true);
    await new Promise((resolve) => setImmediate(resolve));

    expect(logSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pub', command: 'publish' }),
      'Socket adapter Redis command rejected',
    );
  });
});
