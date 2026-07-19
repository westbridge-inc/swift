import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

// Socket payloads come straight off the wire from any authenticated client —
// validate them like request bodies. cuid ids are 25 chars; 64 is headroom.
const orderEvent = z.object({ orderId: z.string().min(1).max(64) });
const chatEvent = z.object({ roomId: z.string().min(1).max(64) });
const vendorEvent = z.object({ vendorId: z.string().min(1).max(64) });

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
  }
}

const DEV_ORIGINS = ['http://localhost:3001', 'http://localhost:3000', 'http://127.0.0.1:3001'];

export const socketPlugin = fp(async (app: FastifyInstance) => {
  const corsOrigin = process.env['CORS_ORIGIN']
    ? process.env['CORS_ORIGIN'].split(',')
    : process.env['NODE_ENV'] === 'development'
      ? DEV_ORIGINS
      : false;

  const io = new Server(app.server, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
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
    io.adapter(createAdapter(app.redis.duplicate(), app.redis.duplicate()));
  }

  // Require valid JWT on every connection — no unauthenticated sockets
  io.use((socket, next) => {
    const token = (socket.handshake.auth as Record<string, unknown>)?.['token'] as string | undefined;
    if (!token) {
      return next(new Error('Authentication required'));
    }
    try {
      const payload = app.jwt.verify<{ userId: string; role: string }>(token);
      socket.data.userId = payload.userId;
      socket.data.role = payload.role;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  app.decorate('io', io);

  io.on('connection', (socket) => {
    // userId is guaranteed verified by middleware above
    const userId = socket.data.userId as string;
    socket.join(`user:${userId}`);
    app.log.info(`Socket connected: ${socket.id} (user: ${userId})`);

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
        if (participant) {
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

    socket.on('disconnect', () => {
      app.log.debug(`Socket disconnected: ${socket.id} (user: ${userId})`);
    });
  });

  app.addHook('onClose', async () => {
    io.close();
  });
});
