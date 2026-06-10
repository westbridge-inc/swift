import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import type { AddressInfo } from 'node:net';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// SEC-1 regression — Socket.IO connections must present a valid JWT.
// Before the fix, any client could connect and claim any userId.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let url: string;
const openSockets: Socket[] = [];

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

  it('accepts a connection with a valid JWT and joins the user room', async () => {
    const token = app.jwt.sign({ userId: 'sec1-regression-user', role: 'CUSTOMER' });
    const { socket, error } = await connect({ token });
    expect(error).toBeUndefined();
    expect(socket.connected).toBe(true);

    // The server derives the room from the verified token, never from client data
    const room = app.io.sockets.adapter.rooms.get('user:sec1-regression-user');
    expect(room?.size).toBe(1);
  });
});
