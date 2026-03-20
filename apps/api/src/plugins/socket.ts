import fp from 'fastify-plugin';
import { Server } from 'socket.io';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    io: Server;
  }
}

export const socketPlugin = fp(async (app: FastifyInstance) => {
  const io = new Server(app.server, {
    cors: {
      origin: process.env['CORS_ORIGIN'] || '*',
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  app.decorate('io', io);

  io.on('connection', (socket) => {
    app.log.info(`Socket connected: ${socket.id}`);

    // Authenticate socket and join user room
    socket.on('auth', (data: { userId: string }) => {
      if (data.userId) {
        socket.join(`user:${data.userId}`);
        socket.data.userId = data.userId;
        app.log.info(`Socket ${socket.id} authenticated as user ${data.userId}`);
      }
    });

    // Subscribe to order updates
    socket.on('order:subscribe', (data: { orderId: string }) => {
      socket.join(`order:${data.orderId}`);
      app.log.debug(`Socket ${socket.id} subscribed to order ${data.orderId}`);
    });

    socket.on('order:unsubscribe', (data: { orderId: string }) => {
      socket.leave(`order:${data.orderId}`);
    });

    // Subscribe to chat room
    socket.on('chat:join', (data: { roomId: string }) => {
      socket.join(`chat:${data.roomId}`);
    });

    socket.on('chat:leave', (data: { roomId: string }) => {
      socket.leave(`chat:${data.roomId}`);
    });

    // Real-time location updates from riders/drivers
    socket.on('location:update', async (data: { lat: number; lng: number; orderId?: string; userId?: string }) => {
      const userId = data.userId || socket.data.userId;
      if (!userId) return;

      // Cache in Redis for fast lookup
      try {
        await app.redis.set(
          `location:${userId}`,
          JSON.stringify({ lat: data.lat, lng: data.lng, ts: Date.now() }),
          'EX',
          300, // 5 min TTL
        );
      } catch {
        // Redis write failure is non-fatal
      }

      // Broadcast to order subscribers
      if (data.orderId) {
        io.to(`order:${data.orderId}`).emit('rider:location', {
          lat: data.lat,
          lng: data.lng,
          timestamp: Date.now(),
        });
      }
    });

    // Typing indicator for chat
    socket.on('chat:typing', (data: { roomId: string; userId: string }) => {
      socket.to(`chat:${data.roomId}`).emit('chat:typing', { userId: data.userId });
    });

    socket.on('chat:stop-typing', (data: { roomId: string; userId: string }) => {
      socket.to(`chat:${data.roomId}`).emit('chat:stop-typing', { userId: data.userId });
    });

    // Vendor subscribes to new orders
    socket.on('vendor:subscribe', (data: { vendorId: string }) => {
      socket.join(`vendor:${data.vendorId}`);
    });

    socket.on('disconnect', () => {
      app.log.debug(`Socket disconnected: ${socket.id}`);
    });
  });

  app.addHook('onClose', async () => {
    io.close();
  });
});
