import type { FastifyInstance } from 'fastify';

export async function riderRoutes(app: FastifyInstance) {
  app.get('/profile', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await app.prisma.rider.findUnique({
      where: { userId: request.user.userId },
      include: { user: true, subscription: true },
    });
    return { success: true, data: rider };
  });

  app.post('/go-online', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await app.prisma.rider.update({
      where: { userId: request.user.userId },
      data: { isOnline: true },
    });
    return { success: true, data: rider };
  });

  app.post('/go-offline', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await app.prisma.rider.update({
      where: { userId: request.user.userId },
      data: { isOnline: false },
    });
    return { success: true, data: rider };
  });

  app.put('/location', { preHandler: [app.authenticate] }, async (request) => {
    const { latitude, longitude } = request.body as { latitude: number; longitude: number };
    await app.prisma.rider.update({
      where: { userId: request.user.userId },
      data: { currentLat: latitude, currentLng: longitude, lastLocationUpdate: new Date() },
    });
    return { success: true };
  });

  app.get('/orders/available', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await app.prisma.rider.findUnique({ where: { userId: request.user.userId } });
    if (!rider) return { success: true, data: [] };

    const orders = await app.prisma.order.findMany({
      where: {
        status: { in: ['READY_FOR_PICKUP', 'PENDING'] },
        riderId: null,
        orderType: { in: ['FOOD_DELIVERY', 'GROCERY_DELIVERY', 'COURIER'] },
      },
      include: { vendor: true },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    return { success: true, data: orders };
  });

  app.post('/orders/:id/accept', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const rider = await app.prisma.rider.findUnique({ where: { userId: request.user.userId } });
    if (!rider) return { success: false, error: { code: 'NOT_FOUND', message: 'Rider not found' } };

    const order = await app.prisma.order.update({
      where: { id },
      data: { riderId: rider.id, status: 'RIDER_ASSIGNED' },
    });
    await app.prisma.orderStatusLog.create({
      data: { orderId: id, status: 'RIDER_ASSIGNED', changedBy: request.user.userId },
    });
    await app.prisma.rider.update({
      where: { id: rider.id },
      data: { isAvailable: false, currentOrderId: id },
    });
    app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: 'RIDER_ASSIGNED' });
    return { success: true, data: order };
  });

  app.put('/orders/:id/delivered', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const rider = await app.prisma.rider.findUnique({ where: { userId: request.user.userId } });
    if (!rider) return { success: false, error: { code: 'NOT_FOUND', message: 'Rider not found' } };

    const order = await app.prisma.order.update({
      where: { id },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
    await app.prisma.orderStatusLog.create({
      data: { orderId: id, status: 'DELIVERED', changedBy: request.user.userId },
    });
    await app.prisma.rider.update({
      where: { id: rider.id },
      data: {
        isAvailable: true,
        currentOrderId: null,
        totalDeliveries: { increment: 1 },
      },
    });
    app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: 'DELIVERED' });
    return { success: true, data: order };
  });

  // Earnings
  app.get('/earnings', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await app.prisma.rider.findUnique({ where: { userId: request.user.userId } });
    if (!rider) return { success: true, data: { earnings: [], total: 0 } };

    const earnings = await app.prisma.earning.findMany({
      where: { riderId: rider.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const total = await app.prisma.earning.aggregate({
      where: { riderId: rider.id },
      _sum: { amount: true },
    });
    return { success: true, data: { earnings, total: total._sum.amount || 0 } };
  });

  app.get('/earnings/today', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await app.prisma.rider.findUnique({ where: { userId: request.user.userId } });
    if (!rider) return { success: true, data: { earnings: [], total: 0 } };

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const earnings = await app.prisma.earning.findMany({
      where: { riderId: rider.id, createdAt: { gte: today } },
      orderBy: { createdAt: 'desc' },
    });
    const total = await app.prisma.earning.aggregate({
      where: { riderId: rider.id, createdAt: { gte: today } },
      _sum: { amount: true },
    });
    return { success: true, data: { earnings, total: total._sum.amount || 0 } };
  });

  // Subscription
  app.get('/subscription', { preHandler: [app.authenticate] }, async (request) => {
    const rider = await app.prisma.rider.findUnique({
      where: { userId: request.user.userId },
      include: { subscription: { include: { payments: { take: 10, orderBy: { createdAt: 'desc' } } } } },
    });
    return { success: true, data: rider?.subscription || null };
  });
}
