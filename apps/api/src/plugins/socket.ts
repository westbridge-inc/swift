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
      origin: process.env.CORS_ORIGIN || '*',
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  });

  app.decorate('io', io);

  io.on('connection', (socket) => {
    app.log.info(`Socket connected: ${socket.id}`);

    socket.on('location:update', (data) => {
      // Handle rider/driver location updates
      app.log.info(`Location update from ${socket.id}`);
    });

    socket.on('order:subscribe', (data: { orderId: string }) => {
      socket.join(`order:${data.orderId}`);
    });

    socket.on('disconnect', () => {
      app.log.info(`Socket disconnected: ${socket.id}`);
    });
  });

  app.addHook('onClose', async () => {
    io.close();
  });
});
