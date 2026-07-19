import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import type { AddressInfo } from 'node:net';
import type { UserStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// SEC-1 regression — Socket.IO connections must present a valid JWT AND a live
// session for an active account (SWIFT-AUD-D3-03): a JWT alone (logged out, or
// suspended) must not admit a realtime socket.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let url: string;
const openSockets: Socket[] = [];
const createdUserIds: string[] = [];
const phoneBase = 592_140_000_000 + Math.floor(Math.random() * 800_000_000);
let seq = 0;

/** A real user + live session; returns the session token (what a client holds). */
async function makeSessionToken(status: UserStatus = 'ACTIVE'): Promise<{ userId: string; token: string }> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Sock', lastName: `U${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, status },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'sock', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) },
  });
  return { userId: user.id, token };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);

  // Socket.IO needs a real listening server — fastify.inject() cannot carry websockets
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  url = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  for (const socket of openSockets) socket.disconnect();
  if (createdUserIds.length) {
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

function connect(auth: Record<string, unknown>): Promise<{ socket: Socket; error?: Error }> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, {
      auth,
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
    });
    openSockets.push(socket);
    const timer = setTimeout(() => reject(new Error('socket connection attempt timed out')), 4000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve({ socket });
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      resolve({ socket, error });
    });
  });
}

describe('SEC-1 regression — Socket.IO authentication', () => {
  it('rejects a connection with no token', async () => {
    const { socket, error } = await connect({});
    expect(error).toBeDefined();
    expect(error!.message).toBe('Authentication required');
    expect(socket.connected).toBe(false);
  });

  it('rejects a connection with a tampered token', async () => {
    const { socket, error } = await connect({ token: 'tampered.invalid.token' });
    expect(error).toBeDefined();
    expect(error!.message).toBe('Invalid or expired token');
    expect(socket.connected).toBe(false);
  });

  it('accepts a connection with a valid JWT + live session, joins the user room', async () => {
    const { userId, token } = await makeSessionToken('ACTIVE');
    const { socket, error } = await connect({ token });
    expect(error).toBeUndefined();
    expect(socket.connected).toBe(true);

    // The server derives the room from the verified token, never from client data
    const room = app.io.sockets.adapter.rooms.get(`user:${userId}`);
    expect(room?.size).toBe(1);
  });

  it('rejects a validly-signed JWT with NO session (logged out) [SWIFT-AUD-D3-03]', async () => {
    // A real, signature-valid token whose session was deleted (logout/reset).
    const token = app.jwt.sign({ userId: 'no-session-user', role: 'CUSTOMER', jti: nanoid(8) });
    const { socket, error } = await connect({ token });
    expect(error).toBeDefined();
    expect(error!.message).toBe('Session revoked or expired');
    expect(socket.connected).toBe(false);
  });

  it('rejects a suspended account even with a live session [SWIFT-AUD-D3-03]', async () => {
    const { token } = await makeSessionToken('SUSPENDED');
    const { socket, error } = await connect({ token });
    expect(error).toBeDefined();
    expect(error!.message).toBe('Account not active');
    expect(socket.connected).toBe(false);
  });
});
