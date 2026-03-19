import type { FastifyInstance } from 'fastify';

export async function customerRoutes(app: FastifyInstance) {
  // Profile
  app.get('/profile', { preHandler: [app.authenticate] }, async (request) => {
    const user = await app.prisma.user.findUnique({
      where: { id: request.user.userId },
      include: { customer: true, addresses: true },
    });
    return { success: true, data: user };
  });

  app.put('/profile', { preHandler: [app.authenticate] }, async (request) => {
    const { firstName, lastName, email } = request.body as { firstName?: string; lastName?: string; email?: string };
    const user = await app.prisma.user.update({
      where: { id: request.user.userId },
      data: { ...(firstName && { firstName }), ...(lastName && { lastName }), ...(email && { email }) },
    });
    return { success: true, data: user };
  });

  // Addresses
  app.get('/addresses', { preHandler: [app.authenticate] }, async (request) => {
    const addresses = await app.prisma.address.findMany({
      where: { userId: request.user.userId },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: addresses };
  });

  app.post('/addresses', { preHandler: [app.authenticate] }, async (request) => {
    const body = request.body as {
      label: string;
      addressLine1: string;
      addressLine2?: string;
      city: string;
      region: string;
      latitude: number;
      longitude: number;
      instructions?: string;
    };
    const address = await app.prisma.address.create({
      data: { userId: request.user.userId, ...body },
    });
    return { success: true, data: address };
  });

  // Home feed
  app.get('/home', { preHandler: [app.authenticate] }, async (request) => {
    const { lat, lng } = request.query as { lat?: string; lng?: string };

    const vendors = await app.prisma.vendor.findMany({
      where: { status: 'ACTIVE', isCurrentlyOpen: true },
      include: { categories: { include: { items: { take: 5 } } } },
      take: 20,
      orderBy: { averageRating: 'desc' },
    });

    return { success: true, data: { vendors } };
  });

  // Vendors
  app.get('/vendors', { preHandler: [app.authenticate] }, async (request) => {
    const { type, cuisine, page = '1', limit = '20' } = request.query as Record<string, string>;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [vendors, total] = await Promise.all([
      app.prisma.vendor.findMany({
        where: {
          status: 'ACTIVE',
          ...(type && { vendorType: type as 'RESTAURANT' | 'SUPERMARKET' }),
          ...(cuisine && { cuisineTypes: { has: cuisine } }),
        },
        skip,
        take: parseInt(limit),
        orderBy: { averageRating: 'desc' },
      }),
      app.prisma.vendor.count({
        where: {
          status: 'ACTIVE',
          ...(type && { vendorType: type as 'RESTAURANT' | 'SUPERMARKET' }),
        },
      }),
    ]);

    return {
      success: true,
      data: vendors,
      meta: { page: parseInt(page), limit: parseInt(limit), total, totalPages: Math.ceil(total / parseInt(limit)) },
    };
  });

  app.get('/vendors/:id', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const vendor = await app.prisma.vendor.findUnique({
      where: { id },
      include: {
        categories: { include: { items: { include: { optionGroups: { include: { options: true } } } } } },
        operatingHours: true,
        images: true,
      },
    });
    if (!vendor) return { success: false, error: { code: 'NOT_FOUND', message: 'Vendor not found' } };
    return { success: true, data: vendor };
  });

  // Orders
  app.get('/orders', { preHandler: [app.authenticate] }, async (request) => {
    const orders = await app.prisma.order.findMany({
      where: { customerId: request.user.userId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: orders };
  });

  app.get('/orders/:id', { preHandler: [app.authenticate] }, async (request) => {
    const { id } = request.params as { id: string };
    const order = await app.prisma.order.findFirst({
      where: { id, customerId: request.user.userId },
      include: { items: { include: { selectedOptions: true } }, statusHistory: true },
    });
    return { success: true, data: order };
  });

  // Notifications
  app.get('/notifications', { preHandler: [app.authenticate] }, async (request) => {
    const notifications = await app.prisma.notification.findMany({
      where: { userId: request.user.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { success: true, data: notifications };
  });

  // Wallet
  app.get('/wallet', { preHandler: [app.authenticate] }, async (request) => {
    const user = await app.prisma.user.findUnique({
      where: { id: request.user.userId },
      select: { walletBalance: true },
    });
    const transactions = await app.prisma.transaction.findMany({
      where: { userId: request.user.userId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    return { success: true, data: { balance: user?.walletBalance, transactions } };
  });
}
