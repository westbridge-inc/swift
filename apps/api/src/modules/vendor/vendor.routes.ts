import type { FastifyInstance } from 'fastify';

export async function vendorRoutes(app: FastifyInstance) {
  app.get('/profile', { preHandler: [app.authenticate] }, async (request) => {
    const vendorOwner = await app.prisma.vendorOwner.findUnique({
      where: { userId: request.user.userId },
      include: { vendors: { include: { operatingHours: true, subscription: true } } },
    });
    return { success: true, data: vendorOwner };
  });

  // Orders for vendor
  app.get('/orders', { preHandler: [app.authenticate] }, async (request) => {
    const vendorOwner = await app.prisma.vendorOwner.findUnique({
      where: { userId: request.user.userId },
      include: { vendors: { select: { id: true } } },
    });
    if (!vendorOwner) return { success: false, error: { code: 'NOT_FOUND', message: 'Vendor not found' } };

    const vendorIds = vendorOwner.vendors.map((v) => v.id);
    const orders = await app.prisma.order.findMany({
      where: { vendorId: { in: vendorIds } },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: orders };
  });

  app.put('/orders/:id/accept', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const order = await app.prisma.order.update({
      where: { id },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
    await app.prisma.orderStatusLog.create({
      data: { orderId: id, status: 'ACCEPTED', changedBy: request.user.userId },
    });
    app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: 'ACCEPTED' });
    return { success: true, data: order };
  });

  app.put('/orders/:id/preparing', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const order = await app.prisma.order.update({
      where: { id },
      data: { status: 'PREPARING', preparingAt: new Date() },
    });
    await app.prisma.orderStatusLog.create({
      data: { orderId: id, status: 'PREPARING', changedBy: request.user.userId },
    });
    app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: 'PREPARING' });
    return { success: true, data: order };
  });

  app.put('/orders/:id/ready', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const order = await app.prisma.order.update({
      where: { id },
      data: { status: 'READY_FOR_PICKUP', readyAt: new Date() },
    });
    await app.prisma.orderStatusLog.create({
      data: { orderId: id, status: 'READY_FOR_PICKUP', changedBy: request.user.userId },
    });
    app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: 'READY_FOR_PICKUP' });
    return { success: true, data: order };
  });

  // Menu management
  app.get('/categories', { preHandler: [app.authenticate] }, async (request) => {
    const vendorOwner = await app.prisma.vendorOwner.findUnique({
      where: { userId: request.user.userId },
      include: { vendors: { select: { id: true } } },
    });
    if (!vendorOwner?.vendors[0]) return { success: true, data: [] };
    const categories = await app.prisma.category.findMany({
      where: { vendorId: vendorOwner.vendors[0].id },
      include: { items: true },
      orderBy: { sortOrder: 'asc' },
    });
    return { success: true, data: categories };
  });

  app.post('/items', { preHandler: [app.authenticate] }, async (request) => {
    const body = request.body as {
      categoryId: string;
      name: string;
      description?: string;
      basePrice: number;
      dietaryTags?: string[];
      allergens?: string[];
    };
    const vendorOwner = await app.prisma.vendorOwner.findUnique({
      where: { userId: request.user.userId },
      include: { vendors: { select: { id: true } } },
    });
    if (!vendorOwner?.vendors[0]) return { success: false, error: { code: 'NOT_FOUND', message: 'Vendor not found' } };

    const item = await app.prisma.item.create({
      data: {
        vendorId: vendorOwner.vendors[0].id,
        categoryId: body.categoryId,
        name: body.name,
        description: body.description,
        basePrice: body.basePrice,
        dietaryTags: body.dietaryTags || [],
        allergens: body.allergens || [],
      },
    });
    return { success: true, data: item };
  });

  // Analytics
  app.get('/analytics/overview', { preHandler: [app.authenticate] }, async (request) => {
    const vendorOwner = await app.prisma.vendorOwner.findUnique({
      where: { userId: request.user.userId },
      include: { vendors: true },
    });
    if (!vendorOwner?.vendors[0]) return { success: true, data: null };
    const vendor = vendorOwner.vendors[0];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [todayOrders, totalRevenue] = await Promise.all([
      app.prisma.order.count({
        where: { vendorId: vendor.id, placedAt: { gte: today } },
      }),
      app.prisma.order.aggregate({
        where: { vendorId: vendor.id, status: { in: ['DELIVERED', 'COMPLETED'] } },
        _sum: { subtotalBase: true },
      }),
    ]);

    return {
      success: true,
      data: {
        todayOrders,
        totalRevenue: totalRevenue._sum.subtotalBase || 0,
        averageRating: vendor.averageRating,
        totalRatings: vendor.totalRatings,
      },
    };
  });

  // Subscription
  app.get('/subscription', { preHandler: [app.authenticate] }, async (request) => {
    const vendorOwner = await app.prisma.vendorOwner.findUnique({
      where: { userId: request.user.userId },
      include: { vendors: { include: { subscription: true } } },
    });
    return { success: true, data: vendorOwner?.vendors[0]?.subscription || null };
  });
}
