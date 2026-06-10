import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import type { FastifyInstance } from 'fastify';

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
    socket.on('order:subscribe', async (data: { orderId: string }) => {
      try {
        const order = await app.prisma.order.findFirst({
          where: {
            id: data.orderId,
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
          socket.join(`order:${data.orderId}`);
        }
      } catch {
        // Non-fatal — socket stays connected
      }
    });

    socket.on('order:unsubscribe', (data: { orderId: string }) => {
      socket.leave(`order:${data.orderId}`);
    });

    // Chat rooms — only participants can join
    socket.on('chat:join', async (data: { roomId: string }) => {
      try {
        const participant = await app.prisma.chatRoomParticipant.findUnique({
          where: { chatRoomId_userId: { chatRoomId: data.roomId, userId } },
          select: { id: true },
        });
        if (participant) {
          socket.join(`chat:${data.roomId}`);
        }
      } catch {
        // Non-fatal
      }
    });

    socket.on('chat:leave', (data: { roomId: string }) => {
      socket.leave(`chat:${data.roomId}`);
    });

    // Location updates — userId always from verified token, never from data
    socket.on('location:update', async (data: { lat: number; lng: number; orderId?: string }) => {
      try {
        await app.redis.set(
          `location:${userId}`,
          JSON.stringify({ lat: data.lat, lng: data.lng, ts: Date.now() }),
          'EX',
          300,
        );
      } catch {
        // Redis write failure is non-fatal
      }

      if (data.orderId) {
        io.to(`order:${data.orderId}`).emit('rider:location', {
          lat: data.lat,
          lng: data.lng,
          timestamp: Date.now(),
        });
      }
    });

    socket.on('chat:typing', (data: { roomId: string }) => {
      socket.to(`chat:${data.roomId}`).emit('chat:typing', { userId });
    });

    socket.on('chat:stop-typing', (data: { roomId: string }) => {
      socket.to(`chat:${data.roomId}`).emit('chat:stop-typing', { userId });
    });

    // Vendor order feed — only if the authenticated user owns the vendor
    socket.on('vendor:subscribe', async (data: { vendorId: string }) => {
      try {
        const vendor = await app.prisma.vendor.findFirst({
          where: { id: data.vendorId, owner: { userId } },
          select: { id: true },
        });
        if (vendor) {
          socket.join(`vendor:${data.vendorId}`);
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
