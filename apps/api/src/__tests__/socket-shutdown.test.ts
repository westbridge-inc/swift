import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import net, { type AddressInfo } from 'node:net';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { testPhone } from './helpers/fixture-ids';

// Fastify stops the HTTP server before its onClose hooks run, and that waits for every open connection. A websocket holds
// one, so with a single phone connected a shutdown sat at its 15 s cap and failed, or Docker killed it at 10 s, on every
// deploy. Closing a node now closes its own transports first, and only its own. A closed transport, never a server
// disconnect: a client told 'io server disconnect' does not retry, and a phone would go silent after every deploy.
// Two real nodes, real clients with reconnection on, the production adapter, a front door like the one a phone dials.

const previousNodeEnv = process.env['NODE_ENV'];
let leaving: FastifyInstance;
let staying: FastifyInstance;
let onLeaving: Socket;
let onStaying: Socket;
let userId = '';
let token = '';
let targetPort = 0;
let tokenReads = 0;
const dropped: string[] = [];
const ready = { count: 0 };
const pipes = new Set<net.Socket>();
const frontDoor = net.createServer((client) => {
  const upstream = net.connect(targetPort, '127.0.0.1');
  for (const side of [client, upstream]) {
    pipes.add(side);
    side.on('error', () => {});
    side.on('close', () => { client.destroy(); upstream.destroy(); pipes.delete(side); });
  }
  client.pipe(upstream);
  upstream.pipe(client);
});
const portOf = (app: FastifyInstance) => (app.server.address() as AddressInfo).port;

async function node(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.listen({ host: '127.0.0.1', port: 0 });
  return app;
}

function direct(app: FastifyInstance): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const client = ioClient(`http://127.0.0.1:${portOf(app)}`, { auth: { token }, transports: ['websocket'], reconnection: false, timeout: 3_000 });
    client.once('auth:ready', () => resolve(client));
    client.once('connect_error', reject);
  });
}

/** A phone: it dials the front door, retries as a phone does, and reads its token again on every try. */
function phone(): Promise<Socket> {
  const url = `http://127.0.0.1:${(frontDoor.address() as AddressInfo).port}`;
  return new Promise((resolve, reject) => {
    const client = ioClient(url, {
      auth: (give) => { tokenReads += 1; give({ token }); },
      transports: ['websocket'], reconnection: true, reconnectionDelay: 50, reconnectionDelayMax: 200, timeout: 3_000,
    });
    client.on('disconnect', (reason) => dropped.push(reason));
    client.on('auth:ready', () => { ready.count += 1; if (ready.count === 1) resolve(client); });
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
  token = staying.jwt.sign({ userId, role: 'CUSTOMER', jti: nanoid(8) });
  await staying.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'socket-shutdown', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  await new Promise<void>((resolve) => { frontDoor.listen(0, '127.0.0.1', resolve); });
  targetPort = portOf(leaving);
  onLeaving = await phone();
  onStaying = await direct(staying);
}, 30_000);

afterAll(async () => {
  onLeaving?.disconnect();
  onStaying?.disconnect();
  await staying.prisma.session.deleteMany({ where: { userId } });
  await staying.prisma.user.deleteMany({ where: { id: userId } });
  await staying.close();
  for (const side of pipes) side.destroy();
  await new Promise((resolve) => { frontDoor.close(resolve); });
  process.env['NODE_ENV'] = previousNodeEnv;
});

describe('closing a node with a phone connected', () => {
  it('finishes at once, the phone retries by itself and reaches the next node, and phones on other nodes are left alone', async () => {
    expect(onLeaving.connected).toBe(true);
    expect(tokenReads).toBe(1);
    targetPort = portOf(staying);
    const startedAt = Date.now();
    await leaving.close();
    expect(Date.now() - startedAt).toBeLessThan(2_000);

    await expect.poll(() => ready.count, { timeout: 5_000 }).toBe(2);
    expect(dropped).toEqual(['transport close']);
    expect(onLeaving.connected).toBe(true);
    expect(tokenReads).toBe(2);
    expect(staying.io.sockets.sockets.size).toBe(2);

    expect(onStaying.connected).toBe(true);
  }, 30_000);
});
