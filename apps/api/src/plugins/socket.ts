import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type Redis from 'ioredis';
import type {
  Prisma,
  SessionAuthMethod,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { resolveCorsOrigins } from '../utils/cors-origin';
import { idempotentAsync, positiveDurationMs, withTimeout } from '../utils/async-lifecycle';
import { AuthService } from '../modules/auth/auth.service';
import {
  hasPrivilegedSessionAssurance,
  requiresPrivilegedSessionAssurance,
} from '../modules/auth/session-assurance';
import {
  socketAuthSessionRoom,
  socketAuthUserRoom,
} from '../utils/socket-revocation';
import { guardRedisCommandPromises } from '../utils/redis-command-guard';
import { warRoomsForSocket } from '../modules/safety/war-room';
import { findActiveBlockBetween } from '../modules/moderation/user-block.service';

// Socket payloads come straight off the wire from any authenticated client —
// validate them like request bodies. cuid ids are 25 chars; 64 is headroom.
const orderEvent = z.object({ orderId: z.string().min(1).max(64) });
const chatEvent = z.object({ roomId: z.string().min(1).max(64) });
const vendorEvent = z.object({ vendorId: z.string().min(1).max(64) });
const MAX_EARLY_AUTH_PACKETS = 4;
const MAX_SOCKET_PACKET_BYTES = 64 * 1024;

const REDIS_PUBLISH_COMMANDS = ['publish', 'spublish'] as const;
const REDIS_SUBSCRIPTION_COMMANDS = [
  'subscribe',
  'psubscribe',
  'ssubscribe',
  'unsubscribe',
  'punsubscribe',
  'sunsubscribe',
] as const;

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
    checkSocketAdapterReady: () => boolean;
  }
}

interface SocketAuthorityRow {
  sessionId: string;
  token: string;
  expiresAt: Date;
  authMethod: SessionAuthMethod;
  userId: string;
  tenantId: string;
  userStatus: UserStatus;
  roles: UserRole[];
  activeRole: UserRole;
}

export const socketPlugin = fp(async (app: FastifyInstance) => {
  const corsOrigin = resolveCorsOrigins(process.env['CORS_ORIGIN'], process.env['NODE_ENV']);

  const io = new Server(app.server, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
    // Every current event is a small identifier payload. Bound both normal and
    // pre-authorization packet memory well below Socket.IO's 1 MiB default.
    maxHttpBufferSize: MAX_SOCKET_PACKET_BYTES,
  });
  const authService = new AuthService(app);
  const adapterClients: Redis[] = [];
  let socketAdapterHealthy = process.env['NODE_ENV'] !== 'production';
  app.decorate('checkSocketAdapterReady', () => (
    process.env['NODE_ENV'] !== 'production'
    || (
      socketAdapterHealthy
      && adapterClients.length === 2
      && adapterClients.every((client) => client.status === 'ready')
    )
  ));
  const socketShutdownTimeoutMs = positiveDurationMs(
    process.env['SOCKET_SHUTDOWN_TIMEOUT_MS'] ?? process.env['PROCESS_SHUTDOWN_TIMEOUT_MS'],
    5_000,
  );
  const socketAuthorityRecheckMs = positiveDurationMs(
    process.env['SOCKET_AUTH_RECHECK_MS'],
    5_000,
  );
  const socketAuthorityRecheckTimeoutMs = positiveDurationMs(
    process.env['SOCKET_AUTH_RECHECK_TIMEOUT_MS'],
    Math.min(4_000, socketAuthorityRecheckMs),
  );
  // Keep one complete authority-store pass inside one configured deadline.
  // The database statement timeout is shorter than the outer deadline, so a
  // timed-out Promise cannot leave a query consuming the pool in the background.
  const authorityTransactionMaxWaitMs = Math.max(
    1,
    Math.min(250, Math.floor(socketAuthorityRecheckTimeoutMs / 4)),
  );
  const authorityTransactionTimeoutMs = Math.max(
    1,
    socketAuthorityRecheckTimeoutMs - authorityTransactionMaxWaitMs,
  );
  const authorityStatementTimeoutMs = Math.max(
    1,
    authorityTransactionTimeoutMs - Math.min(100, Math.floor(authorityTransactionTimeoutMs / 4)),
  );
  const activeSocketAuthorities = new Map<string, {
    socketId: string;
    userId: string;
    tenantId: string;
    role: string;
    sessionId: string;
    token: string;
  }>();
  let authorityRecheckClosing = false;
  let authorityRecheckPromise: Promise<void> | undefined;

  async function runBoundedAuthorityRead<T>(
    label: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return withTimeout(
      app.prisma.$transaction(async (tx) => {
        // PostgreSQL performs the cancellation; the outer deadline is only a
        // final lifecycle guard. This prevents timed-out scans accumulating as
        // invisible work in Prisma's pool.
        await tx.$executeRaw`
          SELECT set_config(
            'statement_timeout',
            ${`${authorityStatementTimeoutMs}ms`},
            true
          )
        `;
        return operation(tx);
      }, {
        maxWait: authorityTransactionMaxWaitMs,
        timeout: authorityTransactionTimeoutMs,
      }),
      socketAuthorityRecheckTimeoutMs,
      label,
    );
  }

  async function readAuthoritiesBySessionIds(
    sessionIds: string[],
  ): Promise<SocketAuthorityRow[]> {
    if (sessionIds.length === 0) return [];
    // JSON is one bind parameter regardless of fleet size. Prisma's normal
    // `in: []` expansion consumes one PostgreSQL parameter per session and can
    // cross the protocol limit on a large node.
    const sessionIdsJson = JSON.stringify(sessionIds);
    return runBoundedAuthorityRead('Socket authority fallback recheck', (tx) =>
      tx.$queryRaw<SocketAuthorityRow[]>`
        SELECT
          s."id" AS "sessionId",
          s."token",
          s."expiresAt",
          s."authMethod",
          u."id" AS "userId",
          u."tenantId",
          u."status" AS "userStatus",
          u."roles",
          u."activeRole"
        FROM "sessions" s
        INNER JOIN "users" u ON u."id" = s."userId"
        WHERE s."id" IN (
          SELECT jsonb_array_elements_text(${sessionIdsJson}::jsonb)
        )
      `,
    );
  }

  async function readAuthorityByToken(token: string): Promise<SocketAuthorityRow | undefined> {
    const rows = await runBoundedAuthorityRead('Socket post-connect authority read', (tx) =>
      tx.$queryRaw<SocketAuthorityRow[]>`
        SELECT
          s."id" AS "sessionId",
          s."token",
          s."expiresAt",
          s."authMethod",
          u."id" AS "userId",
          u."tenantId",
          u."status" AS "userStatus",
          u."roles",
          u."activeRole"
        FROM "sessions" s
        INNER JOIN "users" u ON u."id" = s."userId"
        WHERE s."token" = ${token}
        LIMIT 1
      `,
    );
    return rows[0];
  }

  const closeForAuthorityStoreFailure = (socketId: string) => {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket?.connected) return;
    // This is fail-closed but reconnectable. `socket.disconnect(true)` tells a
    // Socket.IO client never to reconnect; a transport close lets it retry once
    // the authority store recovers, while removing every room immediately.
    socket.client.conn.close();
  };

  const authorityRecheckTimer = setInterval(() => {
    if (authorityRecheckClosing || authorityRecheckPromise || activeSocketAuthorities.size === 0) return;
    authorityRecheckPromise = (async () => {
      const snapshot = [...activeSocketAuthorities.values()];
      const sessionIds = [...new Set(snapshot.map(({ sessionId }) => sessionId))];
      try {
        const sessions = await readAuthoritiesBySessionIds(sessionIds);
        const sessionsById = new Map(sessions.map((session) => [session.sessionId, session]));
        const now = Date.now();
        for (const authority of snapshot) {
          const liveSocket = io.sockets.sockets.get(authority.socketId);
          if (!liveSocket?.connected) continue;
          const session = sessionsById.get(authority.sessionId);
          const privilegedAssuranceValid = session
            ? !requiresPrivilegedSessionAssurance(session.activeRole, session.roles)
              || hasPrivilegedSessionAssurance(session.authMethod)
            : false;
          if (
            !session
            || session.token !== authority.token
            || session.expiresAt.getTime() <= now
            || session.userId !== authority.userId
            || session.tenantId !== authority.tenantId
            || session.activeRole !== authority.role
            || ['SUSPENDED', 'BANNED', 'DEACTIVATED'].includes(session.userStatus)
            || !privilegedAssuranceValid
          ) {
            app.log.warn(
              {
                socketId: authority.socketId,
                userId: authority.userId,
                sessionId: authority.sessionId,
              },
              'Socket authority fallback recheck failed; disconnecting transport',
            );
            liveSocket.disconnect(true);
          }
        }
      } catch (error) {
        // Redis delivers the fast revocation path; this database pass is the
        // fail-closed fallback when Pub/Sub is missed. If the authority store
        // itself cannot be read, no socket from this snapshot may stay active.
        app.log.error(
          { err: error, sockets: snapshot.length, sessions: sessionIds.length },
          'Socket authority fallback recheck unavailable; closing transports',
        );
        for (const authority of snapshot) closeForAuthorityStoreFailure(authority.socketId);
      }
    })().catch((error) => {
      app.log.error(
        { err: error },
        'Socket authority fallback recheck crashed; disconnecting all transports',
      );
      for (const socket of io.sockets.sockets.values()) socket.disconnect(true);
    }).finally(() => {
      authorityRecheckPromise = undefined;
    });
  }, socketAuthorityRecheckMs);
  authorityRecheckTimer.unref();

  const closeSocketInfrastructure = idempotentAsync(async () => {
    const errors: unknown[] = [];
    try {
      await withTimeout(
        io.close(),
        socketShutdownTimeoutMs,
        'Socket.IO server shutdown',
      );
    } catch (error) {
      errors.push(error);
    }

    const redisResults = await Promise.allSettled(adapterClients.map(async (client, index) => {
      if (client.status === 'end') return;
      try {
        await withTimeout(
          client.quit(),
          socketShutdownTimeoutMs,
          `Socket adapter Redis client ${index + 1} shutdown`,
        );
      } catch (error) {
        // Stop reconnect timers even if graceful QUIT rejects or times out.
        client.disconnect(false);
        throw error;
      }
    }));
    for (const result of redisResults) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Socket infrastructure shutdown failed');
    }
  });

  // SWIFT-AUD-D6-01: fan emits out across ALL API instances in production. Without
  // a Redis adapter, io.to(room).emit() reaches only sockets on the EMITTING
  // instance — a rider connected to instance B never receives the dispatch offer
  // a worker emits on instance A, and customers miss order-status updates. Dev/
  // test run a single process (the default in-memory adapter is correct there);
  // gating on production also keeps vitest's per-file socket servers from
  // cross-talking through a shared Redis pub/sub channel.
  if (process.env['NODE_ENV'] === 'production') {
    const { createAdapter } = await import('@socket.io/redis-adapter');
    const pubClient = app.redis.duplicate();
    const subClient = app.redis.duplicate();
    adapterClients.push(pubClient, subClient);
    for (const [kind, client] of [['pub', pubClient], ['sub', subClient]] as const) {
      const withdrawReadiness = (reason: string, error?: unknown) => {
        socketAdapterHealthy = false;
        app.log.error(
          { err: error, kind, reason },
          'Socket adapter Redis unhealthy; withdrawing instance readiness',
        );
      };
      client.on('error', (error) => withdrawReadiness('error', error));
      client.on('close', () => withdrawReadiness('close'));
      client.on('end', () => withdrawReadiness('end'));
    }
    const reportCommandFailure = (kind: 'pub' | 'sub') => (
      { command, error }: { command: string; error: unknown },
    ) => {
      socketAdapterHealthy = false;
      app.log.error(
        { err: error, kind, command },
        'Socket adapter Redis command rejected',
      );
    };
    const publishGuard = guardRedisCommandPromises(
      pubClient,
      REDIS_PUBLISH_COMMANDS,
      reportCommandFailure('pub'),
    );
    // Runtime publishes must be observed for rejection safety but never
    // retained; they have no startup readiness role.
    publishGuard.stopTracking();
    const subscriptionGuard = guardRedisCommandPromises(
      subClient,
      REDIS_SUBSCRIPTION_COMMANDS,
      reportCommandFailure('sub'),
    );
    try {
      const startupTimeoutMs = positiveDurationMs(
        process.env['SOCKET_REDIS_STARTUP_TIMEOUT_MS']
          ?? process.env['REDIS_STARTUP_TIMEOUT_MS'],
        10_000,
      );
      // One deadline covers duplicate connectivity, adapter construction, and
      // subscription acknowledgement. No phase may silently extend boot.
      await withTimeout(
        (async () => {
          // Fail boot rather than silently run a single-node adapter in production.
          await Promise.all([pubClient.ping(), subClient.ping()]);
          io.adapter(createAdapter(pubClient, subClient));
          // Redis adapter 8.3.0 does not await its ioredis subscriptions. Verify
          // the default namespace subscriptions before plugin readiness.
          await subscriptionGuard.verifyAndStopTracking(['psubscribe', 'subscribe']);
          socketAdapterHealthy = true;
        })(),
        startupTimeoutMs,
        'Socket adapter startup',
      );
    } catch (error) {
      authorityRecheckClosing = true;
      clearInterval(authorityRecheckTimer);
      try {
        await closeSocketInfrastructure();
      } catch (cleanupError) {
        app.log.error(
          { err: cleanupError },
          'Socket adapter partial startup cleanup failed',
        );
      }
      throw error;
    }
  }

  /** [F-028-01] A DECIDED credential verdict, as distinct from "the authority
   *  store was unreachable". Mirrors auth.ts's AuthRefused (F-250): the class
   *  marks decisions; everything else reaching a catch is infrastructure.
   *  Collapsing the two into 'Invalid or expired token' made a database blip
   *  read as a revoked login — and clients treat a credential verdict as
   *  terminal (drop the token, log out) exactly as they should, which turned
   *  an outage into a forced re-authentication. */
  class SocketAuthRefused extends Error {}
  const isSocketCredentialVerdict = (err: unknown): boolean => {
    if (err instanceof SocketAuthRefused) return true;
    // JWT verification failures are decided verdicts about the token. The
    // HTTP path's jwtVerify() throws FST_JWT_* codes; the direct
    // app.jwt.verify() used here throws the underlying fast-jwt FAST_JWT_*
    // codes — a tampered token surfaces as FAST_JWT_MALFORMED. Both are
    // decisions about the credential, not about our infrastructure.
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' && (code.startsWith('FST_JWT') || code.startsWith('FAST_JWT'));
  };
  /** Public message for an UNDECIDED failure: retryable, discloses nothing. */
  const AUTH_UNAVAILABLE_MESSAGE = 'Authorization temporarily unavailable';
  const publicAuthorizationMessages = new Set([
    'Session revoked or expired',
    'Account not active',
    'Invalid or expired token',
  ]);

  async function resolveSocketAuthority(token: string, boundedPostConnectRead = false): Promise<{
    userId: string;
    tenantId: string;
    role: string;
    authSessionId: string;
    authorizationExpiresAtMs: number;
  }> {
    const payload = app.jwt.verify<{ userId: string; role: string; exp?: number }>(token);
    if (!Number.isSafeInteger(payload.exp)) {
      throw new SocketAuthRefused('Invalid or expired token');
    }

    // A valid JWT is not enough: the exact session and account remain the
    // authoritative principal for both the initial and post-registration read.
    const session = boundedPostConnectRead
      ? await readAuthorityByToken(token).then((row) => row ? ({
        id: row.sessionId,
        expiresAt: row.expiresAt,
        authMethod: row.authMethod,
        user: {
          id: row.userId,
          tenantId: row.tenantId,
          status: row.userStatus,
          roles: row.roles,
          activeRole: row.activeRole,
        },
      }) : null)
      : await app.prisma.session.findUnique({
        where: { token },
        select: {
          id: true,
          expiresAt: true,
          authMethod: true,
          user: {
            select: {
              id: true,
              tenantId: true,
              status: true,
              roles: true,
              activeRole: true,
            },
          },
        },
      });
    const authorizationExpiresAtMs = session
      ? Math.min(session.expiresAt.getTime(), payload.exp! * 1000)
      : 0;
    if (
      !session
      || authorizationExpiresAtMs <= Date.now()
      || session.user.id !== payload.userId
    ) {
      throw new SocketAuthRefused('Session revoked or expired');
    }
    if (['SUSPENDED', 'BANNED', 'DEACTIVATED'].includes(session.user.status)) {
      throw new SocketAuthRefused('Account not active');
    }
    if (
      requiresPrivilegedSessionAssurance(session.user.activeRole, session.user.roles)
      && !hasPrivilegedSessionAssurance(session.authMethod)
    ) {
      // The assurance verdict is already DECIDED; a logout hiccup must not
      // downgrade it to an infrastructure error.
      await authService.logout(session.id, session.user.id).catch(() => {});
      throw new SocketAuthRefused('Invalid or expired token');
    }
    return {
      userId: session.user.id,
      tenantId: session.user.tenantId,
      role: session.user.activeRole,
      authSessionId: session.id,
      authorizationExpiresAtMs,
    };
  }

  // Require valid JWT on every connection — no unauthenticated sockets
  io.use(async (socket, next) => {
    const token = (socket.handshake.auth as Record<string, unknown>)?.['token'] as string | undefined;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const authority = await resolveSocketAuthority(token);
      socket.data.userId = authority.userId;
      socket.data.tenantId = authority.tenantId;
      socket.data.role = authority.role;
      socket.data.authSessionId = authority.authSessionId;
      socket.data.authorizationExpiresAtMs = authority.authorizationExpiresAtMs;
      next();
    } catch (error) {
      // [F-028-01] Only a DECIDED verdict may say the credentials are bad. A
      // pool-exhausted Prisma read landing here used to become 'Invalid or
      // expired token' — the exact false credential decision F-250 removed
      // from HTTP — so every connected client's reconnect during a database
      // blip was told its login was dead. Infrastructure failures now say so,
      // in a retryable message that discloses nothing.
      if (isSocketCredentialVerdict(error)) {
        const message = error instanceof Error && publicAuthorizationMessages.has(error.message)
          ? error.message
          : 'Invalid or expired token';
        return next(new Error(message));
      }
      app.log.error({ err: error }, '[F-028-01] socket auth could not reach the authority store — refusing RETRYABLY, not as a credential verdict');
      next(new Error(AUTH_UNAVAILABLE_MESSAGE));
    }
  });

  app.decorate('io', io);

  io.on('connection', (socket) => {
    // These values passed the first read, but are not activated until the
    // authorization-only rooms are registered and a second read converges.
    const token = (socket.handshake.auth as Record<string, unknown>)?.['token'] as string | undefined;
    const userId = socket.data.userId as string;
    const tenantId = socket.data.tenantId as string;
    const authSessionId = socket.data.authSessionId as string;
    let authorizationReady = false;
    let authorizationFailed = false;
    let authorizationExpiryTimer: ReturnType<typeof setTimeout> | undefined;
    const pendingPackets: Array<(error?: Error) => void> = [];

    // A client may flush buffered subscriptions as soon as it receives the
    // Socket.IO connect packet. Hold those packets until the post-registration
    // authority read succeeds, rather than dropping them or executing them in
    // the handshake/revocation race window.
    socket.use((_packet, next) => {
      if (authorizationReady) return next();
      if (authorizationFailed) return next(new Error('Socket authorization failed'));
      if (pendingPackets.length >= MAX_EARLY_AUTH_PACKETS) {
        authorizationFailed = true;
        next(new Error('Too many packets before socket authorization'));
        socket.disconnect(true);
        return;
      }
      pendingPackets.push(next);
    });

    // Subscribe to order updates — only if the order belongs to the user
    socket.on('order:subscribe', async (raw: unknown) => {
      const parsed = orderEvent.safeParse(raw);
      if (!parsed.success) return;
      try {
        const order = await app.prisma.order.findFirst({
          where: {
            id: parsed.data.orderId,
            OR: [
              { customerId: userId },
              { rider: { userId } },
              { driver: { userId } },
              { vendor: { owner: { userId } } },
            ],
          },
          select: { id: true },
        });
        if (order) {
          socket.join(`order:${parsed.data.orderId}`);
        }
      } catch {
        // Non-fatal — socket stays connected
      }
    });

    socket.on('order:unsubscribe', (raw: unknown) => {
      const parsed = orderEvent.safeParse(raw);
      if (parsed.success) socket.leave(`order:${parsed.data.orderId}`);
    });

    // Chat rooms — only participants can join
    socket.on('chat:join', async (raw: unknown) => {
      const parsed = chatEvent.safeParse(raw);
      if (!parsed.success) return;
      try {
        const participant = await app.prisma.chatRoomParticipant.findUnique({
          where: { chatRoomId_userId: { chatRoomId: parsed.data.roomId, userId } },
          select: { id: true },
        });
        const counterparts = participant
          ? await app.prisma.chatRoomParticipant.findMany({
              where: { chatRoomId: parsed.data.roomId, userId: { not: userId } },
              select: { userId: true },
            })
          : [];
        const contactBlocked = (
          await Promise.all(counterparts.map((counterpart) => (
            findActiveBlockBetween(app.prisma, tenantId, userId, counterpart.userId)
          )))
        ).some(Boolean);
        if (participant && !contactBlocked) {
          socket.join(`chat:${parsed.data.roomId}`);
        }
      } catch {
        // Non-fatal
      }
    });

    socket.on('chat:leave', (raw: unknown) => {
      const parsed = chatEvent.safeParse(raw);
      if (parsed.success) socket.leave(`chat:${parsed.data.roomId}`);
    });

    // NOTE: there is deliberately no socket `location:update` handler. GPS goes
    // through the REST routes (rider/driver PUT /location), which verify the
    // sender owns the entity before persisting or broadcasting — a socket
    // handler keyed only on orderId would let any signed-in user broadcast fake
    // positions into someone else's order room.

    // Typing indicators relay only from sockets that were admitted to the room
    // (`to(room)` itself doesn't require sender membership — socket.rooms does).
    socket.on('chat:typing', (raw: unknown) => {
      const parsed = chatEvent.safeParse(raw);
      if (!parsed.success || !socket.rooms.has(`chat:${parsed.data.roomId}`)) return;
      socket.to(`chat:${parsed.data.roomId}`).emit('chat:typing', { userId });
    });

    socket.on('chat:stop-typing', (raw: unknown) => {
      const parsed = chatEvent.safeParse(raw);
      if (!parsed.success || !socket.rooms.has(`chat:${parsed.data.roomId}`)) return;
      socket.to(`chat:${parsed.data.roomId}`).emit('chat:stop-typing', { userId });
    });

    // Vendor order feed — only if the authenticated user owns the vendor
    socket.on('vendor:subscribe', async (raw: unknown) => {
      const parsed = vendorEvent.safeParse(raw);
      if (!parsed.success) return;
      try {
        const vendor = await app.prisma.vendor.findFirst({
          where: { id: parsed.data.vendorId, owner: { userId } },
          select: { id: true },
        });
        if (vendor) {
          socket.join(`vendor:${parsed.data.vendorId}`);
        }
      } catch {
        // Non-fatal
      }
    });

    const failPendingPackets = () => {
      authorizationFailed = true;
      for (const next of pendingPackets.splice(0)) {
        next(new Error('Socket authorization failed'));
      }
    };

    socket.on('disconnect', () => {
      activeSocketAuthorities.delete(socket.id);
      if (authorizationExpiryTimer) clearTimeout(authorizationExpiryTimer);
      if (!authorizationReady) failPendingPackets();
      app.log.debug(`Socket disconnected: ${socket.id} (user: ${userId})`);
    });

    // Close the handshake/revocation TOCTOU window:
    //   1. join authorization-only rooms (no product events use them),
    //   2. re-read the exact session/account,
    //   3. only then join event-bearing rooms and release buffered packets.
    // A revocation before (1) is caught by (2); on this binary generation, one
    // after (1) disconnects the socket through its auth room. The mandatory
    // non-rolling cutover is part of this guarantee because baseline binaries
    // did not join exact-session authority rooms.
    void (async () => {
      try {
        if (!token) throw new SocketAuthRefused('Authentication required');
        await socket.join([
          socketAuthUserRoom(userId),
          socketAuthSessionRoom(authSessionId),
        ]);
        const authority = await resolveSocketAuthority(token, true);
        if (
          authority.userId !== userId
          || authority.tenantId !== tenantId
          || authority.authSessionId !== authSessionId
          || !socket.connected
        ) {
          throw new SocketAuthRefused('Socket authority changed during connection');
        }

        socket.data.role = authority.role;
        socket.data.authorizationExpiresAtMs = authority.authorizationExpiresAtMs;
        await socket.join([`user:${userId}`, `session:${authSessionId}`]);
        // [F-027-16] The ops war room had seven emit producers and NO join.
        // Every live emergency — SOS activations, incidents, "not my driver"
        // releases — went into an empty room, and because emitting into an
        // empty room does not throw, the delivery receipt said it landed.
        // Role-gated and tenant-scoped: a tenant's ADMIN joins only their own
        // room, because these payloads carry another person's role, order id
        // and coordinates (the leak F-026-15 closed on the push channel).
        const warRooms = warRoomsForSocket(authority.role, tenantId);
        if (warRooms.length > 0) {
          await socket.join(warRooms);
          app.log.info({ socketId: socket.id, userId, role: authority.role, warRooms }, 'ops socket joined the war room');
        }
        if (!socket.connected) throw new SocketAuthRefused('Socket revoked during connection');

        const expiryDelayMs = authority.authorizationExpiresAtMs - Date.now();
        if (expiryDelayMs <= 0) throw new SocketAuthRefused('Socket authorization expired');
        authorizationExpiryTimer = setTimeout(() => {
          app.log.info(
            { socketId: socket.id, userId, authSessionId },
            'Socket authorization expired; disconnecting transport',
          );
          socket.disconnect(true);
        }, expiryDelayMs);
        authorizationExpiryTimer.unref();

        authorizationReady = true;
        activeSocketAuthorities.set(socket.id, {
          socketId: socket.id,
          userId,
          tenantId,
          role: authority.role,
          sessionId: authSessionId,
          token,
        });
        for (const next of pendingPackets.splice(0)) next();
        socket.emit('auth:ready', {
          expiresAt: new Date(authority.authorizationExpiresAtMs).toISOString(),
        });
        app.log.info(`Socket connected: ${socket.id} (user: ${userId})`);
      } catch (error) {
        failPendingPackets();
        // [F-028-01] Two different failures were sharing disconnect(true) —
        // which this file itself documents as "never reconnect". A DECIDED
        // verdict (revoked, changed, expired) deserves that. A transient
        // authority-store outage in the handshake window does not: it
        // stranded a valid ops/SOS socket forever after the store recovered.
        // Infra failures now take the same reconnectable transport close the
        // recurring recheck already uses.
        if (isSocketCredentialVerdict(error)) {
          app.log.warn(
            { err: error, socketId: socket.id, userId, authSessionId },
            'Socket authority changed during connection; disconnecting transport',
          );
          if (socket.connected) socket.disconnect(true);
        } else {
          app.log.error(
            { err: error, socketId: socket.id, userId, authSessionId },
            '[F-028-01] authority store unreachable during socket registration — closing transport RECONNECTABLY',
          );
          closeForAuthorityStoreFailure(socket.id);
        }
      }
    })();
  });

  app.addHook('onClose', async () => {
    authorityRecheckClosing = true;
    clearInterval(authorityRecheckTimer);
    activeSocketAuthorities.clear();
    const errors: unknown[] = [];
    if (authorityRecheckPromise) {
      try {
        await withTimeout(
          authorityRecheckPromise,
          socketShutdownTimeoutMs,
          'Socket authority fallback recheck shutdown',
        );
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      // Always close Socket.IO and both duplicate Redis clients even when the
      // in-flight authority read exceeded the shutdown deadline.
      await closeSocketInfrastructure();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Socket plugin shutdown failed');
    }
  });
});
