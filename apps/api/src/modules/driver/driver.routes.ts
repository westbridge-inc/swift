import type { FastifyInstance } from 'fastify';

export async function driverRoutes(app: FastifyInstance) {
  app.get('/profile', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await app.prisma.driver.findUnique({
      where: { userId: request.user.userId },
      include: { user: true, subscription: true },
    });
    return { success: true, data: driver };
  });

  app.post('/go-online', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await app.prisma.driver.update({
      where: { userId: request.user.userId },
      data: { isOnline: true },
    });
    return { success: true, data: driver };
  });

  app.post('/go-offline', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await app.prisma.driver.update({
      where: { userId: request.user.userId },
      data: { isOnline: false },
    });
    return { success: true, data: driver };
  });

  app.put('/location', { preHandler: [app.authenticate] }, async (request) => {
    const { latitude, longitude } = request.body as { latitude: number; longitude: number };
    await app.prisma.driver.update({
      where: { userId: request.user.userId },
      data: { currentLat: latitude, currentLng: longitude, lastLocationUpdate: new Date() },
    });
    return { success: true };
  });

  app.get('/rides/available', { preHandler: [app.authenticate] }, async (request) => {
    const orders = await app.prisma.order.findMany({
      where: { status: 'PENDING', orderType: 'TAXI', riderId: null },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });
    return { success: true, data: orders };
  });

  app.post('/rides/:id/accept', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await app.prisma.driver.findUnique({ where: { userId: request.user.userId } });
    if (!driver) return { success: false, error: { code: 'NOT_FOUND', message: 'Driver not found' } };

    const order = await app.prisma.order.update({
      where: { id },
      data: { riderId: driver.id, status: 'DRIVER_ASSIGNED' },
    });
    await app.prisma.driver.update({
      where: { id: driver.id },
      data: { isAvailable: false, currentRideId: id },
    });
    app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: 'DRIVER_ASSIGNED' });
    return { success: true, data: order };
  });

  app.put('/rides/:id/complete', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const driver = await app.prisma.driver.findUnique({ where: { userId: request.user.userId } });
    if (!driver) return { success: false, error: { code: 'NOT_FOUND', message: 'Driver not found' } };

    const order = await app.prisma.order.update({
      where: { id },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
    await app.prisma.driver.update({
      where: { id: driver.id },
      data: { isAvailable: true, currentRideId: null, totalRides: { increment: 1 } },
    });
    app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: 'DELIVERED' });
    return { success: true, data: order };
  });

  // Earnings
  app.get('/earnings', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await app.prisma.driver.findUnique({ where: { userId: request.user.userId } });
    if (!driver) return { success: true, data: { earnings: [], total: 0 } };
    const earnings = await app.prisma.earning.findMany({
      where: { driverId: driver.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { success: true, data: earnings };
  });

  app.get('/subscription', { preHandler: [app.authenticate] }, async (request) => {
    const driver = await app.prisma.driver.findUnique({
      where: { userId: request.user.userId },
      include: { subscription: true },
    });
    return { success: true, data: driver?.subscription || null };
  });
}
