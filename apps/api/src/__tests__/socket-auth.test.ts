import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { io as ioClient, type Socket } from 'socket.io-client';
import { nanoid } from 'nanoid';
import type { AddressInfo } from 'node:net';
import type { Prisma, UserStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { AuthService } from '../modules/auth/auth.service';
import { AccountService } from '../modules/user/account.service';
import {
  transitionUserRoleAuthority,
  transitionUserStatusAuthority,
} from '../modules/mover-authority';

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
async function makeSessionToken(
  status: UserStatus = 'ACTIVE',
  options: { sessionTtlMs?: number; accessTokenExpiresInSeconds?: number } = {},
): Promise<{
  userId: string;
  sessionId: string;
  token: string;
  refreshToken: string;
}> {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Sock', lastName: `U${seq}`, roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, status },
  });
  createdUserIds.push(user.id);
  const token = options.accessTokenExpiresInSeconds === undefined
    ? app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) })
    : app.jwt.sign(
      { userId: user.id, role: 'CUSTOMER', jti: nanoid(8) },
      { expiresIn: options.accessTokenExpiresInSeconds },
    );
  const refreshToken = nanoid(48);
  const session = await app.prisma.session.create({
    data: {
      userId: user.id,
      token,
      refreshToken,
      deviceId: 'sock',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + (options.sessionTtlMs ?? 86_400_000)),
    },
  });
  return { userId: user.id, sessionId: session.id, token, refreshToken };
}

async function makeAdditionalSession(userId: string) {
  const token = app.jwt.sign({ userId, role: 'CUSTOMER', jti: nanoid(8) });
  const refreshToken = nanoid(48);
  const session = await app.prisma.session.create({
    data: {
      userId,
      token,
      refreshToken,
      deviceId: 'sock-second',
      deviceType: 'test',
      expiresAt: new Date(Date.now() + 86400000),
    },
  });
  return { sessionId: session.id, token, refreshToken };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['SOCKET_AUTH_RECHECK_MS'] = '100';
  process.env['SOCKET_AUTH_RECHECK_TIMEOUT_MS'] = '1000';

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
    await app.prisma.moverRevocationOutbox.deleteMany({
      where: { userId: { in: createdUserIds } },
    });
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
    let settled = false;
    let transportConnected = false;
    const finish = (result: { socket: Socket; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.disconnect();
      reject(new Error('socket authorization attempt timed out'));
    }, 7_500);
    socket.on('connect', () => {
      transportConnected = true;
    });
    // The transport-level connect packet precedes SWIFT's post-registration
    // authority recheck. Tests (and clients that need an explicit readiness
    // signal) wait for this event before treating private rooms as active.
    socket.on('auth:ready', () => finish({ socket }));
    socket.on('connect_error', (error) => {
      finish({ socket, error });
    });
    socket.on('disconnect', () => {
      if (transportConnected && !settled) {
        finish({ socket, error: new Error('Authorization revoked during connection') });
      }
    });
  });
}

function waitForSocketDisconnect(socket: Socket, timeoutMs = 4_000): Promise<boolean> {
  if (!socket.connected) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onDisconnect = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      socket.off('disconnect', onDisconnect);
      resolve(false);
    }, timeoutMs);
    socket.once('disconnect', onDisconnect);
  });
}

function holdPostConnectAuthorityRead(token: string) {
  type InteractiveTransaction = (
    operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
    options?: {
      maxWait?: number;
      timeout?: number;
      isolationLevel?: Prisma.TransactionIsolationLevel;
    },
  ) => Promise<unknown>;
  const originalTransaction = app.prisma.$transaction.bind(app.prisma) as unknown as InteractiveTransaction;
  let release!: () => void;
  let observed!: () => void;
  let held = false;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const readObserved = new Promise<void>((resolve) => { observed = resolve; });
  const spy = vi.spyOn(app.prisma, '$transaction');
  spy.mockImplementation(((operation: unknown, options?: unknown) => {
    if (typeof operation !== 'function') {
      throw new Error('Unexpected batch transaction while holding socket authority read');
    }
    return originalTransaction(async (tx) => {
      const result = await (operation as (client: Prisma.TransactionClient) => Promise<unknown>)(tx);
      if (
        !held
        && Array.isArray(result)
        && result.some((row) => (
          typeof row === 'object'
          && row !== null
          && (row as { token?: unknown }).token === token
        ))
      ) {
        held = true;
        observed();
        await released;
      }
      return result;
    }, options as Parameters<InteractiveTransaction>[1]);
  }) as typeof app.prisma.$transaction);
  return {
    observed: readObserved,
    release,
    restore: () => spy.mockRestore(),
  };
}

function connectTransport(token: string): Socket {
  const socket = ioClient(url, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000,
  });
  openSockets.push(socket);
  return socket;
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
    const { userId, sessionId, token } = await makeSessionToken('ACTIVE');
    const { socket, error } = await connect({ token });
    expect(error).toBeUndefined();
    expect(socket.connected).toBe(true);

    // The server derives the room from the verified token, never from client data
    const room = app.io.sockets.adapter.rooms.get(`user:${userId}`);
    expect(room?.size).toBe(1);
    expect(app.io.sockets.adapter.rooms.get(`session:${sessionId}`)?.size).toBe(1);
  });

  it('buffers at most four packets until post-connect authority converges, then drains them', async () => {
    const { token } = await makeSessionToken('ACTIVE');
    const held = holdPostConnectAuthorityRead(token);
    const orderLookup = vi.spyOn(app.prisma.order, 'findFirst');
    const socket = connectTransport(token);
    try {
      await held.observed;
      const authReady = new Promise<void>((resolve) => socket.once('auth:ready', () => resolve()));
      for (let index = 0; index < 4; index += 1) {
        socket.emit('order:subscribe', { orderId: `early-packet-${index}` });
      }
      await new Promise((resolve) => setImmediate(resolve));
      expect(orderLookup).not.toHaveBeenCalled();

      held.release();
      await authReady;
      await vi.waitFor(() => expect(orderLookup).toHaveBeenCalledTimes(4));
      expect(socket.connected).toBe(true);
    } finally {
      held.release();
      held.restore();
      orderLookup.mockRestore();
      socket.disconnect();
    }
  });

  it('disconnects and fails queued callbacks on a fifth pre-authorization packet', async () => {
    const { token } = await makeSessionToken('ACTIVE');
    const held = holdPostConnectAuthorityRead(token);
    const orderLookup = vi.spyOn(app.prisma.order, 'findFirst');
    const socket = connectTransport(token);
    try {
      await held.observed;
      const dropped = waitForSocketDisconnect(socket);
      for (let index = 0; index < 5; index += 1) {
        socket.emit('order:subscribe', { orderId: `overflow-packet-${index}` });
      }
      expect(await dropped).toBe(true);
      expect(socket.connected).toBe(false);
      expect(orderLookup).not.toHaveBeenCalled();
    } finally {
      held.release();
      held.restore();
      orderLookup.mockRestore();
      socket.disconnect();
    }
  });

  it('rejects a Socket.IO packet larger than the 64 KiB transport ceiling', async () => {
    const { token } = await makeSessionToken('ACTIVE');
    const { socket, error } = await connect({ token });
    expect(error).toBeUndefined();
    const dropped = waitForSocketDisconnect(socket);
    socket.emit('order:subscribe', {
      orderId: 'oversized-packet',
      padding: 'x'.repeat(70 * 1024),
    });
    expect(await dropped).toBe(true);
    expect(socket.connected).toBe(false);
  });

  it('closes the handshake/revocation race before private rooms become active', async () => {
    const { userId, sessionId, token } = await makeSessionToken('ACTIVE');
    const originalFindUnique = app.prisma.session.findUnique.bind(app.prisma.session);
    let releaseFirstRead!: () => void;
    let signalFirstRead!: () => void;
    const firstReadReleased = new Promise<void>((resolve) => { releaseFirstRead = resolve; });
    const firstReadObserved = new Promise<void>((resolve) => { signalFirstRead = resolve; });
    let tokenReads = 0;
    const findUniqueSpy = vi.spyOn(app.prisma.session, 'findUnique');
    findUniqueSpy.mockImplementation((async (args) => {
      const result = await originalFindUnique(args as never);
      const where = (args as { where?: { token?: string } }).where;
      if (where?.token === token && ++tokenReads === 1) {
        signalFirstRead();
        await firstReadReleased;
      }
      return result;
    }) as typeof app.prisma.session.findUnique);

    try {
      const connecting = connect({ token });
      await firstReadObserved;

      // The first authority read is complete, but middleware has not admitted
      // the socket yet. This used to let logout miss every room and the stale
      // result call next(), leaving a private socket alive for up to 15 min.
      await new AuthService(app).logout(sessionId, userId);
      releaseFirstRead();

      const { socket, error } = await connecting;
      expect(error?.message).toBe('Authorization revoked during connection');
      expect(socket.connected).toBe(false);
      expect(await app.prisma.session.findUnique({ where: { id: sessionId } })).toBeNull();
      expect(app.io.sockets.adapter.rooms.get(`user:${userId}`)).toBeUndefined();
    } finally {
      releaseFirstRead();
      findUniqueSpy.mockRestore();
    }
  });

  it('disconnects an already-open socket when its database session expires', async () => {
    const { token } = await makeSessionToken('ACTIVE', { sessionTtlMs: 5_000 });
    const { socket, error } = await connect({ token });
    expect(error).toBeUndefined();
    expect(socket.connected).toBe(true);

    const dropped = waitForSocketDisconnect(socket, 6_500);
    expect(await dropped).toBe(true);
    expect(socket.connected).toBe(false);
  });

  it('fails closed from the database when cluster revocation delivery is missed', async () => {
    const { sessionId, token } = await makeSessionToken('ACTIVE');
    const { socket, error } = await connect({ token });
    expect(error).toBeUndefined();
    expect(socket.connected).toBe(true);

    const dropped = waitForSocketDisconnect(socket, 2_000);
    // Delete authority directly: no socket helper and therefore no local or
    // Redis disconnect is emitted. The batched DB fallback on this node must
    // still notice the missing session and terminate the transport promptly.
    await app.prisma.session.delete({ where: { id: sessionId } });

    expect(await dropped).toBe(true);
    expect(socket.connected).toBe(false);
  });

  it('fails closed reconnectably when the authority store is transiently unavailable', async () => {
    const { token } = await makeSessionToken('ACTIVE');
    const socket = ioClient(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 25,
      reconnectionDelayMax: 50,
      timeout: 3000,
    });
    openSockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('initial socket readiness timed out')), 4_000);
      socket.once('auth:ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const disconnectReason = new Promise<string>((resolve) => socket.once('disconnect', resolve));
    const readyAgain = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not recover after authority store outage')), 4_000);
      socket.once('auth:ready', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const transactionSpy = vi.spyOn(app.prisma, '$transaction');
    transactionSpy.mockRejectedValueOnce(new Error('forced transient authority store outage'));
    try {
      expect(await disconnectReason).not.toBe('io server disconnect');
      await readyAgain;
      expect(socket.connected).toBe(true);
    } finally {
      transactionSpy.mockRestore();
      socket.disconnect();
    }
  });

  it('disconnects at access-token expiry even while the database session remains live', async () => {
    const { sessionId, token } = await makeSessionToken('ACTIVE', {
      accessTokenExpiresInSeconds: 5,
    });
    const { socket, error } = await connect({ token });
    expect(error).toBeUndefined();
    expect(socket.connected).toBe(true);

    const dropped = waitForSocketDisconnect(socket, 6_500);
    expect(await dropped).toBe(true);
    expect(socket.connected).toBe(false);
    expect(await app.prisma.session.findUnique({ where: { id: sessionId } })).not.toBeNull();
  });

  it('drops sockets on role switch and reconciles a stale JWT role on reconnect', async () => {
    seq += 1;
    const user = await app.prisma.user.create({
      data: {
        phone: `+${phoneBase + seq}`,
        firstName: 'Socket',
        lastName: 'RoleSwitch',
        roles: ['SUPER_ADMIN', 'CUSTOMER'],
        activeRole: 'SUPER_ADMIN',
        isPhoneVerified: true,
        status: 'ACTIVE',
      },
    });
    createdUserIds.push(user.id);
    const token = app.jwt.sign({
      userId: user.id,
      role: 'SUPER_ADMIN',
      jti: nanoid(8),
    });
    await app.prisma.session.create({
      data: {
        userId: user.id,
        token,
        refreshToken: nanoid(48),
        authMethod: 'OTP',
        deviceId: 'socket-role-switch',
        deviceType: 'test',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const first = await connect({ token });
    expect(first.error).toBeUndefined();
    expect(app.io.sockets.sockets.get(first.socket.id!)?.data.role).toBe('SUPER_ADMIN');
    const dropped = waitForSocketDisconnect(first.socket);

    await transitionUserRoleAuthority(app, user.id, 'CUSTOMER');
    expect(await dropped).toBe(true);
    expect(first.socket.connected).toBe(false);

    const second = await connect({ token });
    expect(second.error).toBeUndefined();
    expect(app.io.sockets.sockets.get(second.socket.id!)?.data.role).toBe('CUSTOMER');
  });

  it('rejects and revokes a legacy customer session after privilege promotion', async () => {
    const { userId, sessionId, token } = await makeSessionToken('ACTIVE');
    await app.prisma.user.update({
      where: { id: userId },
      data: {
        roles: { set: ['SUPER_ADMIN', 'CUSTOMER'] },
        activeRole: 'CUSTOMER',
      },
    });

    const { socket, error } = await connect({ token });
    expect(error).toBeDefined();
    expect(error!.message).toBe('Invalid or expired token');
    expect(socket.connected).toBe(false);
    expect(await app.prisma.session.findUnique({ where: { id: sessionId } })).toBeNull();
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

  it('SWIFT-099: logoutAll drops the user\'s already-open socket', async () => {
    const { userId, token } = await makeSessionToken('ACTIVE');
    const pushToken = `ExponentPushToken[logout-all-${nanoid(12)}]`;
    await app.prisma.deviceToken.create({
      data: { userId, token: pushToken, platform: 'ios', isActive: true },
    });
    const { socket, error } = await connect({ token });
    expect(error).toBeUndefined();
    expect(socket.connected).toBe(true);

    const dropped = waitForSocketDisconnect(socket);
    // Revoke every session (the "log out everywhere" / suspension path).
    await new AuthService(app).logoutAll(userId);

    // RED before SWIFT-099: sessions are gone but the live socket stays connected
    // (the auth gate only runs at connect), so it never disconnects.
    expect(await dropped).toBe(true);
    expect(socket.connected).toBe(false);
    expect((await app.prisma.deviceToken.findUniqueOrThrow({ where: { token: pushToken } })).isActive)
      .toBe(false);
  });

  it('account deletion drops the already-open socket and destroys its session', async () => {
    const { userId, sessionId, token } = await makeSessionToken('ACTIVE');
    const { socket, error } = await connect({ token });
    expect(error).toBeUndefined();
    expect(socket.connected).toBe(true);

    const dropped = waitForSocketDisconnect(socket);
    await new AccountService(app).deleteAccount(userId);

    expect(await dropped).toBe(true);
    expect(socket.connected).toBe(false);
    expect(await app.prisma.session.findUnique({ where: { id: sessionId } })).toBeNull();
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: userId } })).status)
      .toBe('DEACTIVATED');
  });

  it('non-rolling exact-session logout drops only the revoked session socket', async () => {
    const first = await makeSessionToken('ACTIVE');
    const second = await makeAdditionalSession(first.userId);
    const [{ socket, error }, { socket: otherSocket, error: otherError }] = await Promise.all([
      connect({ token: first.token }),
      connect({ token: second.token }),
    ]);
    expect(error).toBeUndefined();
    expect(otherError).toBeUndefined();
    expect(socket.connected).toBe(true);
    // Exact-session room membership is a mandatory non-rolling cutover: older
    // nodes did not expose a session room that could be revoked safely. Never
    // replace this with logoutAll merely to make a mixed-version deploy work.
    expect(otherSocket.connected).toBe(true);

    const dropped = waitForSocketDisconnect(socket);
    expect(await new AuthService(app).logoutByRefreshToken(first.refreshToken)).toBe(true);

    expect(await dropped).toBe(true);
    expect(socket.connected).toBe(false);
    expect(otherSocket.connected).toBe(true);
    expect(await app.prisma.session.findUnique({ where: { id: first.sessionId } })).toBeNull();
    expect(await app.prisma.session.findUnique({ where: { id: second.sessionId } })).not.toBeNull();
  });

  it('suspension drops every already-open socket without deleting resumable sessions', async () => {
    const first = await makeSessionToken('ACTIVE');
    const second = await makeAdditionalSession(first.userId);
    const [{ socket: firstSocket, error: firstError }, { socket: secondSocket, error: secondError }] = await Promise.all([
      connect({ token: first.token }),
      connect({ token: second.token }),
    ]);
    expect(firstError).toBeUndefined();
    expect(secondError).toBeUndefined();

    const firstDropped = waitForSocketDisconnect(firstSocket);
    const secondDropped = waitForSocketDisconnect(secondSocket);

    await transitionUserStatusAuthority(app, first.userId, 'SUSPENDED');

    expect(await Promise.all([firstDropped, secondDropped])).toEqual([true, true]);
    expect(firstSocket.connected).toBe(false);
    expect(secondSocket.connected).toBe(false);
    expect(await app.prisma.session.count({ where: { userId: first.userId } })).toBe(2);
  });

  it('ban drops every already-open socket and deletes every session', async () => {
    const first = await makeSessionToken('ACTIVE');
    const second = await makeAdditionalSession(first.userId);
    const [{ socket: firstSocket, error: firstError }, { socket: secondSocket, error: secondError }] = await Promise.all([
      connect({ token: first.token }),
      connect({ token: second.token }),
    ]);
    expect(firstError).toBeUndefined();
    expect(secondError).toBeUndefined();

    const firstDropped = waitForSocketDisconnect(firstSocket);
    const secondDropped = waitForSocketDisconnect(secondSocket);

    await transitionUserStatusAuthority(app, first.userId, 'BANNED');

    expect(await Promise.all([firstDropped, secondDropped])).toEqual([true, true]);
    expect(firstSocket.connected).toBe(false);
    expect(secondSocket.connected).toBe(false);
    expect(await app.prisma.session.count({ where: { userId: first.userId } })).toBe(0);
  });
});
