import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import type { AddressInfo } from 'node:net';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { testPhone } from './helpers/fixture-ids';

// Fastify stops the HTTP server before its onClose hooks run, and that waits for every open connection. A websocket holds
// one, so with a single phone connected a shutdown sat at its 15 s cap and failed, or Docker killed it at 10 s, on every
// deploy. Closing a node now drops its own sockets first, and only its own: the adapter would carry a plain
// disconnectSockets to every node. Two real nodes, real clients, the production adapter.

const previousNodeEnv = process.env['NODE_ENV'];
let leaving: FastifyInstance;
let staying: FastifyInstance;
let onLeaving: Socket;
let onStaying: Socket;
let userId = '';

async function node(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app;
}

function connect(app: FastifyInstance, token: string): Promise<Socket> {
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return new Promise((resolve, reject) => {
    const client = ioClient(url, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 3_000 });
    client.once('auth:ready', () => resolve(client));
    client.once('connect_error', reject);
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'production';
  process.env['PUSH_PROVIDER'] = 'expo';
  process.env['CORS_ORIGIN'] = 'http://127.0.0.1';
  process.env['JWT_SECRET'] ||= 'socket-shutdown-test-secret-at-least-32-characters';
  leaving = await node();
  staying = await node();
  const user = await staying.prisma.user.create({ data: { phone: testPhone(), firstName: 'Close', lastName: 'Socket', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true } });
  userId = user.id;
  const token = staying.jwt.sign({ userId, role: 'CUSTOMER', jti: nanoid(8) });
  await staying.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'socket-shutdown', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  onLeaving = await connect(leaving, token);
  onStaying = await connect(staying, token);
}, 30_000);

afterAll(async () => {
  onLeaving?.disconnect();
  onStaying?.disconnect();
  await staying.prisma.session.deleteMany({ where: { userId } });
  await staying.prisma.user.deleteMany({ where: { id: userId } });
  await staying.close();
  process.env['NODE_ENV'] = previousNodeEnv;
});

describe('closing a node with a phone connected', () => {
  it('finishes at once, and leaves the phones on other nodes alone', async () => {
    expect(onLeaving.connected).toBe(true);
    const startedAt = Date.now();
    await leaving.close();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect.poll(() => onLeaving.connected).toBe(false);

    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(onStaying.connected).toBe(true);
  }, 30_000);
});
