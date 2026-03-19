import type { FastifyInstance } from 'fastify';

export async function adminRoutes(app: FastifyInstance) {
  // Middleware to check admin role
  const adminGuard = async (request: any, reply: any) => {
    await app.authenticate(request, reply);
    if (!['ADMIN', 'SUPER_ADMIN'].includes(request.user.role)) {
      return reply.status(403).send({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required' } });
    }
  };

  // Dashboard overview
  app.get('/dashboard/overview', { preHandler: [adminGuard] }, async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalUsers,
      totalOrders,
      todayOrders,
      activeRiders,
      activeDrivers,
      activeVendors,
      todayRevenue,
      subscriptionCounts,
    ] = await Promise.all([
      app.prisma.user.count(),
      app.prisma.order.count(),
      app.prisma.order.count({ where: { placedAt: { gte: today } } }),
      app.prisma.rider.count({ where: { isOnline: true } }),
      app.prisma.driver.count({ where: { isOnline: true } }),
      app.prisma.vendor.count({ where: { status: 'ACTIVE' } }),
      app.prisma.order.aggregate({
        where: { placedAt: { gte: today }, status: { in: ['DELIVERED', 'COMPLETED'] } },
        _sum: { subtotalMarkup: true },
      }),
      app.prisma.subscription.groupBy({
        by: ['type'],
        where: { status: 'ACTIVE' },
        _count: true,
      }),
    ]);

    // Calculate subscription revenue
    const subRevenue = subscriptionCounts.reduce((acc, sub) => {
      const rates: Record<string, number> = {
        DELIVERY_RIDER: 10000,
        COURIER_RIDER: 20000,
        TAXI_DRIVER: 20000,
        RESTAURANT: 20000,
        SUPERMARKET: 20000,
      };
      return acc + (sub._count * (rates[sub.type] || 0));
    }, 0);

    return {
      success: true,
      data: {
        totalUsers,
        totalOrders,
        todayOrders,
        activeRiders,
        activeDrivers,
        activeVendors,
        todayMarkupRevenue: todayRevenue._sum.subtotalMarkup || 0,
        weeklySubscriptionRevenue: subRevenue,
        subscriptionBreakdown: subscriptionCounts,
      },
    };
  });

  // User management
  app.get('/users', { preHandler: [adminGuard] }, async (request) => {
    const { page = '1', limit = '20', role, status } = request.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {
      ...(role && { role: role as any }),
      ...(status && { status: status as any }),
    };
    const [users, total] = await Promise.all([
      app.prisma.user.findMany({ where, skip, take: parseInt(limit), orderBy: { createdAt: 'desc' } }),
      app.prisma.user.count({ where }),
    ]);
    return { success: true, data: users, meta: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) } };
  });

  // Vendor management
  app.get('/vendors', { preHandler: [adminGuard] }, async (request) => {
    const { status } = request.query as { status?: string };
    const vendors = await app.prisma.vendor.findMany({
      where: status ? { status: status as any } : undefined,
      include: { subscription: true, owner: { include: { user: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: vendors };
  });

  app.get('/vendors/pending', { preHandler: [adminGuard] }, async () => {
    const vendors = await app.prisma.vendor.findMany({
      where: { status: 'PENDING_APPROVAL' },
      include: { owner: { include: { user: true } } },
    });
    return { success: true, data: vendors };
  });

  app.put('/vendors/:id/approve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const vendor = await app.prisma.vendor.update({
      where: { id },
      data: { status: 'ACTIVE', isVerified: true },
    });
    return { success: true, data: vendor };
  });

  // Rider management
  app.get('/riders', { preHandler: [adminGuard] }, async () => {
    const riders = await app.prisma.rider.findMany({
      include: { user: true, subscription: true },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: riders };
  });

  app.put('/riders/:id/verify-documents', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const rider = await app.prisma.rider.update({
      where: { id },
      data: { documentsVerified: true, documentsVerifiedAt: new Date(), documentsVerifiedBy: request.user.userId },
    });
    return { success: true, data: rider };
  });

  // Orders
  app.get('/orders', { preHandler: [adminGuard] }, async (request) => {
    const { status, type, page = '1', limit = '20' } = request.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const where = {
      ...(status && { status: status as any }),
      ...(type && { orderType: type as any }),
    };
    const [orders, total] = await Promise.all([
      app.prisma.order.findMany({
        where,
        include: { vendor: true, items: true },
        skip,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.order.count({ where }),
    ]);
    return { success: true, data: orders, meta: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) } };
  });

  // Finance
  app.get('/finance/revenue', { preHandler: [adminGuard] }, async () => {
    const thisWeek = new Date();
    thisWeek.setDate(thisWeek.getDate() - 7);

    const [markupRevenue, subscriptions] = await Promise.all([
      app.prisma.order.aggregate({
        where: { createdAt: { gte: thisWeek }, status: { in: ['DELIVERED', 'COMPLETED'] } },
        _sum: { subtotalMarkup: true },
      }),
      app.prisma.subscription.findMany({
        where: { status: 'ACTIVE' },
        select: { type: true, weeklyRate: true },
      }),
    ]);

    const subRevenue = subscriptions.reduce((acc, s) => acc + Number(s.weeklyRate), 0);

    return {
      success: true,
      data: {
        weeklyMarkupRevenue: markupRevenue._sum.subtotalMarkup || 0,
        weeklySubscriptionRevenue: subRevenue,
        totalWeeklyRevenue: (Number(markupRevenue._sum.subtotalMarkup) || 0) + subRevenue,
      },
    };
  });

  // Config
  app.get('/config', { preHandler: [adminGuard] }, async () => {
    const configs = await app.prisma.platformConfig.findMany();
    return { success: true, data: configs };
  });

  app.put('/config/:key', { preHandler: [adminGuard] }, async (request) => {
    const { key } = request.params as { key: string };
    const { value } = request.body as { value: any };
    const config = await app.prisma.platformConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
    return { success: true, data: config };
  });

  // Promos
  app.get('/promos', { preHandler: [adminGuard] }, async () => {
    const promos = await app.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' } });
    return { success: true, data: promos };
  });

  app.post('/promos', { preHandler: [adminGuard] }, async (request) => {
    const body = request.body as any;
    const promo = await app.prisma.promoCode.create({ data: body });
    return { success: true, data: promo };
  });
}
