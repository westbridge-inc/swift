import type { FastifyInstance } from 'fastify';
import { NotificationService } from '../notification/notification.service';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { AppError, NotFoundError, ForbiddenError } from '../../utils/errors';

export async function adminRoutes(app: FastifyInstance) {
  const notifications = new NotificationService(app.prisma, app.io);

  // Middleware: verify ADMIN or SUPER_ADMIN role
  const adminGuard = async (request: any, reply: any) => {
    await app.authenticate(request, reply);
    if (!['ADMIN', 'SUPER_ADMIN'].includes(request.user.role)) {
      throw new ForbiddenError('Admin access required');
    }
  };

  // Helper: write an audit log entry
  async function audit(
    userId: string,
    action: string,
    entity: string,
    entityId: string,
    changes?: Record<string, unknown>,
    request?: any,
  ) {
    await app.prisma.auditLog.create({
      data: {
        userId,
        action,
        entity,
        entityId,
        changes: (changes ?? undefined) as any,
        ipAddress: request?.ip,
        userAgent: request?.headers?.['user-agent'],
      },
    });
  }

  // ─── Dashboard ─────────────────────────────────────────────────────────

  app.get('/dashboard/overview', { preHandler: [adminGuard] }, async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const [
      totalUsers,
      totalOrders,
      todayOrders,
      todayRevenue,
      activeRiders,
      activeDrivers,
      activeVendors,
      totalVendors,
      subscriptionCounts,
      todayNewUsers,
      weeklyOrderCounts,
    ] = await Promise.all([
      app.prisma.user.count(),
      app.prisma.order.count(),
      app.prisma.order.count({ where: { placedAt: { gte: today } } }),
      app.prisma.order.aggregate({
        where: { placedAt: { gte: today }, status: { in: ['DELIVERED', 'COMPLETED'] } },
        _sum: { subtotalMarkup: true, deliveryFee: true, totalAmount: true },
        _count: true,
      }),
      app.prisma.rider.count({ where: { isOnline: true } }),
      app.prisma.driver.count({ where: { isOnline: true } }),
      app.prisma.vendor.count({ where: { status: 'ACTIVE' } }),
      app.prisma.vendor.count(),
      app.prisma.subscription.groupBy({
        by: ['type', 'status'],
        _count: true,
      }),
      app.prisma.user.count({ where: { createdAt: { gte: today } } }),
      // Weekly trend: orders per day for the last 7 days
      app.prisma.$queryRaw<Array<{ date: string; count: bigint; revenue: number }>>`
        SELECT
          DATE("placedAt") as date,
          COUNT(*)::int as count,
          COALESCE(SUM(CASE WHEN status IN ('DELIVERED', 'COMPLETED') THEN "subtotalMarkup" ELSE 0 END), 0) as revenue
        FROM orders
        WHERE "placedAt" >= ${weekAgo}
        GROUP BY DATE("placedAt")
        ORDER BY date ASC
      `,
    ]);

    // Compute subscription revenue
    const subRates: Record<string, number> = {
      DELIVERY_RIDER: 10000,
      COURIER_RIDER: 20000,
      TAXI_DRIVER: 20000,
      RESTAURANT: 20000,
      SUPERMARKET: 20000,
    };
    const activeSubs = subscriptionCounts.filter((s) => s.status === 'ACTIVE');
    const weeklySubscriptionRevenue = activeSubs.reduce(
      (acc, s) => acc + s._count * (subRates[s.type] || 0),
      0,
    );

    return {
      success: true,
      data: {
        totalUsers,
        todayNewUsers,
        totalOrders,
        todayOrders,
        todayCompletedOrders: todayRevenue._count,
        activeRiders,
        activeDrivers,
        activeVendors,
        totalVendors,
        revenue: {
          todayMarkup: todayRevenue._sum.subtotalMarkup || 0,
          todayDeliveryFees: todayRevenue._sum.deliveryFee || 0,
          todayTotal: todayRevenue._sum.totalAmount || 0,
          weeklySubscriptionRevenue,
        },
        subscriptionBreakdown: subscriptionCounts,
        weeklyTrend: weeklyOrderCounts,
      },
    };
  });

  // ─── Users ─────────────────────────────────────────────────────────────

  app.get('/users', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { role, status, search } = request.query as { role?: string; status?: string; search?: string };

    const where: any = {
      ...(role && { activeRole: role }),
      ...(status && { status }),
      ...(search && {
        OR: [
          { firstName: { contains: search, mode: 'insensitive' } },
          { lastName: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { email: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [users, total] = await Promise.all([
      app.prisma.user.findMany({
        where,
        select: {
          id: true,
          phone: true,
          email: true,
          firstName: true,
          lastName: true,
          avatar: true,
          roles: true,
          activeRole: true,
          status: true,
          isPhoneVerified: true,
          createdAt: true,
          lastActiveAt: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.user.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(users, total, { page, limit, skip }) };
  });

  app.get('/users/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const user = await app.prisma.user.findUnique({
      where: { id },
      include: {
        customer: true,
        rider: { include: { subscription: true } },
        driver: { include: { subscription: true } },
        vendorOwner: { include: { vendors: true } },
        addresses: true,
        _count: { select: { orders: true, notifications: true, transactions: true } },
      },
    });
    if (!user) throw new NotFoundError('User', id);

    return { success: true, data: user };
  });

  app.put('/users/:id/suspend', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason?: string };

    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('User', id);
    if (user.status === 'SUSPENDED') throw new AppError(400, 'ALREADY_SUSPENDED', 'User is already suspended');

    const updated = await app.prisma.user.update({
      where: { id },
      data: { status: 'SUSPENDED' },
    });

    await audit(request.user.userId, 'SUSPEND_USER', 'User', id, { reason, previousStatus: user.status }, request);

    await notifications.send({
      userId: id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Account Suspended',
      body: reason || 'Your account has been suspended. Please contact support for more information.',
    });

    return { success: true, data: updated };
  });

  app.put('/users/:id/unsuspend', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('User', id);
    if (user.status !== 'SUSPENDED') throw new AppError(400, 'NOT_SUSPENDED', 'User is not suspended');

    const updated = await app.prisma.user.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });

    await audit(request.user.userId, 'UNSUSPEND_USER', 'User', id, {}, request);

    await notifications.send({
      userId: id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Account Restored',
      body: 'Your account has been reinstated. Welcome back!',
    });

    return { success: true, data: updated };
  });

  app.put('/users/:id/ban', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason?: string };

    const user = await app.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundError('User', id);
    if (user.status === 'BANNED') throw new AppError(400, 'ALREADY_BANNED', 'User is already banned');

    // Prevent banning other admins unless SUPER_ADMIN
    if (user.roles.includes('ADMIN') && request.user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenError('Only SUPER_ADMIN can ban admin users');
    }

    const updated = await app.prisma.user.update({
      where: { id },
      data: { status: 'BANNED' },
    });

    // Invalidate all sessions
    await app.prisma.session.deleteMany({ where: { userId: id } });

    await audit(request.user.userId, 'BAN_USER', 'User', id, { reason, previousStatus: user.status }, request);

    return { success: true, data: updated };
  });

  // ─── Vendors ───────────────────────────────────────────────────────────

  app.get('/vendors', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, type, search } = request.query as { status?: string; type?: string; search?: string };

    const where: any = {
      ...(status && { status }),
      ...(type && { vendorType: type }),
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { slug: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [vendors, total] = await Promise.all([
      app.prisma.vendor.findMany({
        where,
        include: {
          owner: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } } },
          subscription: { select: { id: true, status: true, type: true, weeklyRate: true } },
          _count: { select: { orders: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.vendor.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(vendors, total, { page, limit, skip }) };
  });

  app.get('/vendors/pending', { preHandler: [adminGuard] }, async () => {
    const vendors = await app.prisma.vendor.findMany({
      where: { status: 'PENDING_APPROVAL' },
      include: {
        owner: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return { success: true, data: vendors };
  });

  app.put('/vendors/:id/approve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const vendor = await app.prisma.vendor.findUnique({
      where: { id },
      include: { owner: true },
    });
    if (!vendor) throw new NotFoundError('Vendor', id);
    if (vendor.status === 'ACTIVE') throw new AppError(400, 'ALREADY_ACTIVE', 'Vendor is already approved');

    const updated = await app.prisma.vendor.update({
      where: { id },
      data: { status: 'ACTIVE', isVerified: true },
    });

    await audit(request.user.userId, 'APPROVE_VENDOR', 'Vendor', id, { previousStatus: vendor.status }, request);

    await notifications.send({
      userId: vendor.owner.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Vendor Approved!',
      body: `Congratulations! ${vendor.name} has been approved and is now live on Swift.`,
      data: { vendorId: id },
    });

    return { success: true, data: updated };
  });

  app.put('/vendors/:id/suspend', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason?: string };

    const vendor = await app.prisma.vendor.findUnique({
      where: { id },
      include: { owner: true },
    });
    if (!vendor) throw new NotFoundError('Vendor', id);

    const updated = await app.prisma.vendor.update({
      where: { id },
      data: { status: 'SUSPENDED', acceptingOrders: false },
    });

    await audit(request.user.userId, 'SUSPEND_VENDOR', 'Vendor', id, { reason, previousStatus: vendor.status }, request);

    await notifications.send({
      userId: vendor.owner.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Vendor Suspended',
      body: reason || `${vendor.name} has been suspended. Please contact support.`,
      data: { vendorId: id },
    });

    return { success: true, data: updated };
  });

  app.put('/vendors/:id/feature', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { featured } = request.body as { featured?: boolean };

    const vendor = await app.prisma.vendor.findUnique({ where: { id } });
    if (!vendor) throw new NotFoundError('Vendor', id);

    const isFeatured = featured !== undefined ? featured : !vendor.isFeatured;

    const updated = await app.prisma.vendor.update({
      where: { id },
      data: { isFeatured },
    });

    await audit(request.user.userId, 'TOGGLE_FEATURED_VENDOR', 'Vendor', id, { isFeatured }, request);

    return { success: true, data: updated };
  });

  // ─── Riders ────────────────────────────────────────────────────────────

  app.get('/riders', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, type, search } = request.query as { status?: string; type?: string; search?: string };

    const where: any = {
      ...(type && { riderType: type }),
      ...(status === 'online' && { isOnline: true }),
      ...(status === 'offline' && { isOnline: false }),
      ...(status === 'verified' && { documentsVerified: true }),
      ...(status === 'unverified' && { documentsVerified: false }),
      ...(search && {
        user: {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
          ],
        },
      }),
    };

    const [riders, total] = await Promise.all([
      app.prisma.rider.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, phone: true, avatar: true, status: true } },
          subscription: { select: { id: true, status: true, type: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.rider.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(riders, total, { page, limit, skip }) };
  });

  app.get('/riders/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const rider = await app.prisma.rider.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, avatar: true, status: true, createdAt: true } },
        subscription: { include: { payments: { take: 5, orderBy: { createdAt: 'desc' } } } },
        earnings: { take: 20, orderBy: { createdAt: 'desc' } },
        _count: { select: { orders: true, earnings: true } },
      },
    });
    if (!rider) throw new NotFoundError('Rider', id);

    return { success: true, data: rider };
  });

  app.put('/riders/:id/verify-documents', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { verified, rejectionReason } = request.body as { verified?: boolean; rejectionReason?: string };

    const rider = await app.prisma.rider.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!rider) throw new NotFoundError('Rider', id);

    const isVerified = verified !== false; // default true

    const updated = await app.prisma.rider.update({
      where: { id },
      data: {
        documentsVerified: isVerified,
        documentsVerifiedAt: isVerified ? new Date() : null,
        documentsVerifiedBy: isVerified ? request.user.userId : null,
      },
    });

    await audit(
      request.user.userId,
      isVerified ? 'VERIFY_RIDER_DOCUMENTS' : 'REJECT_RIDER_DOCUMENTS',
      'Rider',
      id,
      { verified: isVerified, rejectionReason },
      request,
    );

    await notifications.send({
      userId: rider.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: isVerified ? 'Documents Verified!' : 'Document Review Update',
      body: isVerified
        ? 'Your documents have been verified. You can now go online and start accepting deliveries!'
        : `Your documents need attention: ${rejectionReason || 'Please resubmit your documents.'}`,
    });

    return { success: true, data: updated };
  });

  // ─── Drivers ───────────────────────────────────────────────────────────

  app.get('/drivers', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, search } = request.query as { status?: string; search?: string };

    const where: any = {
      ...(status === 'online' && { isOnline: true }),
      ...(status === 'offline' && { isOnline: false }),
      ...(status === 'verified' && { documentsVerified: true }),
      ...(status === 'unverified' && { documentsVerified: false }),
      ...(search && {
        user: {
          OR: [
            { firstName: { contains: search, mode: 'insensitive' } },
            { lastName: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search } },
          ],
        },
      }),
    };

    const [drivers, total] = await Promise.all([
      app.prisma.driver.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, phone: true, avatar: true, status: true } },
          subscription: { select: { id: true, status: true, type: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.driver.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(drivers, total, { page, limit, skip }) };
  });

  app.get('/drivers/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const driver = await app.prisma.driver.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, firstName: true, lastName: true, phone: true, email: true, avatar: true, status: true, createdAt: true } },
        subscription: { include: { payments: { take: 5, orderBy: { createdAt: 'desc' } } } },
        earnings: { take: 20, orderBy: { createdAt: 'desc' } },
        _count: { select: { orders: true, earnings: true } },
      },
    });
    if (!driver) throw new NotFoundError('Driver', id);

    return { success: true, data: driver };
  });

  app.put('/drivers/:id/verify-documents', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { verified, rejectionReason } = request.body as { verified?: boolean; rejectionReason?: string };

    const driver = await app.prisma.driver.findUnique({
      where: { id },
      include: { user: true },
    });
    if (!driver) throw new NotFoundError('Driver', id);

    const isVerified = verified !== false;

    const updated = await app.prisma.driver.update({
      where: { id },
      data: {
        documentsVerified: isVerified,
        documentsVerifiedAt: isVerified ? new Date() : null,
        documentsVerifiedBy: isVerified ? request.user.userId : null,
      },
    });

    await audit(
      request.user.userId,
      isVerified ? 'VERIFY_DRIVER_DOCUMENTS' : 'REJECT_DRIVER_DOCUMENTS',
      'Driver',
      id,
      { verified: isVerified, rejectionReason },
      request,
    );

    await notifications.send({
      userId: driver.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: isVerified ? 'Documents Verified!' : 'Document Review Update',
      body: isVerified
        ? 'Your documents have been verified. You can now go online and start accepting rides!'
        : `Your documents need attention: ${rejectionReason || 'Please resubmit your documents.'}`,
    });

    return { success: true, data: updated };
  });

  // ─── Orders ────────────────────────────────────────────────────────────

  app.get('/orders', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, type, dateFrom, dateTo, search } = request.query as {
      status?: string;
      type?: string;
      dateFrom?: string;
      dateTo?: string;
      search?: string;
    };

    const where: any = {
      ...(status && { status }),
      ...(type && { orderType: type }),
      ...(dateFrom || dateTo
        ? {
            placedAt: {
              ...(dateFrom && { gte: new Date(dateFrom) }),
              ...(dateTo && { lte: new Date(dateTo) }),
            },
          }
        : {}),
      ...(search && {
        OR: [
          { orderNumber: { contains: search, mode: 'insensitive' } },
          { deliveryAddress: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };

    const [orders, total] = await Promise.all([
      app.prisma.order.findMany({
        where,
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
          vendor: { select: { id: true, name: true } },
          rider: { include: { user: { select: { firstName: true, lastName: true } } } },
          driver: { include: { user: { select: { firstName: true, lastName: true } } } },
          items: true,
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.order.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(orders, total, { page, limit, skip }) };
  });

  app.get('/orders/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const order = await app.prisma.order.findUnique({
      where: { id },
      include: {
        customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
        vendor: { select: { id: true, name: true, phone: true, addressLine1: true, city: true } },
        rider: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } } },
        driver: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } } },
        items: { include: { selectedOptions: true } },
        statusHistory: { orderBy: { createdAt: 'desc' } },
        promoCode: true,
      },
    });
    if (!order) throw new NotFoundError('Order', id);

    return { success: true, data: order };
  });

  app.put('/orders/:id/cancel', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason, refund } = request.body as { reason?: string; refund?: boolean };

    const order = await app.prisma.order.findUnique({
      where: { id },
      include: { vendor: true },
    });
    if (!order) throw new NotFoundError('Order', id);

    const terminalStatuses = ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED'];
    if (terminalStatuses.includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS', `Cannot cancel an order with status ${order.status}`);
    }

    const newStatus = refund ? 'REFUNDED' : 'CANCELLED';

    await app.prisma.order.update({
      where: { id },
      data: {
        status: newStatus,
        cancelledAt: new Date(),
        cancelledBy: request.user.userId,
        cancellationReason: reason || 'Cancelled by admin',
      },
    });

    await app.prisma.orderStatusLog.create({
      data: { orderId: id, status: newStatus, changedBy: request.user.userId, note: reason || 'Admin cancellation' },
    });

    // Free up assigned rider or driver
    if (order.riderId) {
      await app.prisma.rider.update({
        where: { id: order.riderId },
        data: { isAvailable: true, currentOrderId: null },
      });
    }
    if (order.driverId) {
      await app.prisma.driver.update({
        where: { id: order.driverId },
        data: { isAvailable: true, currentRideId: null },
      });
    }

    // Refund to wallet if requested
    if (refund) {
      await app.prisma.user.update({
        where: { id: order.customerId },
        data: { walletBalance: { increment: Number(order.totalAmount) } },
      });
      await app.prisma.transaction.create({
        data: {
          userId: order.customerId,
          type: 'ORDER_REFUND',
          amount: order.totalAmount,
          direction: 'CREDIT',
          description: `Refund for order ${order.orderNumber}`,
          reference: order.orderNumber,
          balanceAfter: 0, // Will be corrected by actual balance lookup in production
        },
      });
    }

    app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: newStatus });

    await audit(request.user.userId, 'CANCEL_ORDER', 'Order', id, { reason, refund, previousStatus: order.status }, request);

    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: refund ? 'Order Refunded' : 'Order Cancelled',
      body: refund
        ? `Your order ${order.orderNumber} has been cancelled and refunded to your wallet.`
        : `Your order ${order.orderNumber} has been cancelled by the system. ${reason || ''}`.trim(),
      data: { orderId: id, status: newStatus },
    });

    return { success: true, data: { orderId: id, status: newStatus, refunded: !!refund } };
  });

  // ─── Finance ───────────────────────────────────────────────────────────

  app.get('/finance/revenue', { preHandler: [adminGuard] }, async () => {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [dailyRevenue, subscriptionRevenue, totalDeliveryFees] = await Promise.all([
      // Daily revenue breakdown for last 30 days
      app.prisma.$queryRaw<
        Array<{ date: string; markup: number; delivery_fees: number; total: number; order_count: bigint }>
      >`
        SELECT
          DATE("placedAt") as date,
          COALESCE(SUM("subtotalMarkup"), 0) as markup,
          COALESCE(SUM("deliveryFee"), 0) as delivery_fees,
          COALESCE(SUM("totalAmount"), 0) as total,
          COUNT(*)::int as order_count
        FROM orders
        WHERE "placedAt" >= ${thirtyDaysAgo}
          AND status IN ('DELIVERED', 'COMPLETED')
        GROUP BY DATE("placedAt")
        ORDER BY date ASC
      `,
      // Active subscription revenue
      app.prisma.subscription.findMany({
        where: { status: 'ACTIVE' },
        select: { type: true, weeklyRate: true },
      }),
      // Total delivery fees collected
      app.prisma.order.aggregate({
        where: { createdAt: { gte: thirtyDaysAgo }, status: { in: ['DELIVERED', 'COMPLETED'] } },
        _sum: { deliveryFee: true, subtotalMarkup: true },
      }),
    ]);

    const weeklySubRevenue = subscriptionRevenue.reduce((acc, s) => acc + Number(s.weeklyRate), 0);
    const monthlySubRevenue = weeklySubRevenue * 4; // approximate

    return {
      success: true,
      data: {
        dailyRevenue,
        summary: {
          thirtyDayMarkup: totalDeliveryFees._sum.subtotalMarkup || 0,
          thirtyDayDeliveryFees: totalDeliveryFees._sum.deliveryFee || 0,
          weeklySubscriptionRevenue: weeklySubRevenue,
          monthlySubscriptionRevenue: monthlySubRevenue,
          activeSubscriptions: subscriptionRevenue.length,
        },
      },
    };
  });

  app.get('/finance/settlements', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, vendorId } = request.query as { status?: string; vendorId?: string };

    const where: any = {
      ...(status && { status }),
      ...(vendorId && { vendorId }),
    };

    const [settlements, total] = await Promise.all([
      app.prisma.settlement.findMany({
        where,
        include: {
          vendor: { select: { id: true, name: true, slug: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.settlement.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(settlements, total, { page, limit, skip }) };
  });

  app.put('/finance/settlements/:id/process', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reference } = request.body as { reference?: string };

    const settlement = await app.prisma.settlement.findUnique({
      where: { id },
      include: { vendor: { include: { owner: true } } },
    });
    if (!settlement) throw new NotFoundError('Settlement', id);
    if (settlement.status === 'PAID') throw new AppError(400, 'ALREADY_PAID', 'Settlement has already been processed');

    const updated = await app.prisma.settlement.update({
      where: { id },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        reference: reference || null,
      },
    });

    await audit(request.user.userId, 'PROCESS_SETTLEMENT', 'Settlement', id, { amount: settlement.totalBase, reference }, request);

    await notifications.send({
      userId: settlement.vendor.owner.userId,
      type: 'PAYMENT_RECEIVED',
      title: 'Settlement Processed',
      body: `Your settlement of $${Number(settlement.totalBase).toLocaleString()} GYD for ${settlement.vendor.name} has been processed.`,
      data: { settlementId: id },
    });

    return { success: true, data: updated };
  });

  // ─── Config ────────────────────────────────────────────────────────────

  app.get('/config', { preHandler: [adminGuard] }, async () => {
    const configs = await app.prisma.platformConfig.findMany({
      orderBy: { key: 'asc' },
    });
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

    await audit(request.user.userId, 'UPDATE_CONFIG', 'PlatformConfig', key, { value }, request);

    return { success: true, data: config };
  });

  // ─── Promos ────────────────────────────────────────────────────────────

  app.get('/promos', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { active } = request.query as { active?: string };

    const where: any = {
      ...(active === 'true' && { isActive: true }),
      ...(active === 'false' && { isActive: false }),
    };

    const [promos, total] = await Promise.all([
      app.prisma.promoCode.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      app.prisma.promoCode.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(promos, total, { page, limit, skip }) };
  });

  app.post('/promos', { preHandler: [adminGuard] }, async (request) => {
    const body = request.body as {
      code: string;
      description: string;
      discountType: 'PERCENTAGE' | 'FIXED_AMOUNT' | 'FREE_DELIVERY';
      discountValue: number;
      minOrderAmount?: number;
      maxDiscount?: number;
      applicableTo?: string[];
      validFrom: string;
      validUntil: string;
      maxUses?: number;
      maxUsesPerUser?: number;
    };

    // Ensure code is unique and uppercase
    const existingCode = await app.prisma.promoCode.findUnique({ where: { code: body.code.toUpperCase() } });
    if (existingCode) throw new AppError(409, 'DUPLICATE_CODE', 'A promo code with this code already exists');

    const promo = await app.prisma.promoCode.create({
      data: {
        code: body.code.toUpperCase(),
        description: body.description,
        discountType: body.discountType,
        discountValue: body.discountValue,
        minOrderAmount: body.minOrderAmount,
        maxDiscount: body.maxDiscount,
        applicableTo: (body.applicableTo || []) as any,
        validFrom: new Date(body.validFrom),
        validUntil: new Date(body.validUntil),
        maxUses: body.maxUses,
        maxUsesPerUser: body.maxUsesPerUser || 1,
      },
    });

    await audit(request.user.userId, 'CREATE_PROMO', 'PromoCode', promo.id, { code: promo.code }, request);

    return { success: true, data: promo };
  });

  app.put('/promos/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      description?: string;
      discountValue?: number;
      minOrderAmount?: number;
      maxDiscount?: number;
      validFrom?: string;
      validUntil?: string;
      maxUses?: number;
      maxUsesPerUser?: number;
      isActive?: boolean;
    };

    const existing = await app.prisma.promoCode.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('PromoCode', id);

    const promo = await app.prisma.promoCode.update({
      where: { id },
      data: {
        ...(body.description !== undefined && { description: body.description }),
        ...(body.discountValue !== undefined && { discountValue: body.discountValue }),
        ...(body.minOrderAmount !== undefined && { minOrderAmount: body.minOrderAmount }),
        ...(body.maxDiscount !== undefined && { maxDiscount: body.maxDiscount }),
        ...(body.validFrom !== undefined && { validFrom: new Date(body.validFrom) }),
        ...(body.validUntil !== undefined && { validUntil: new Date(body.validUntil) }),
        ...(body.maxUses !== undefined && { maxUses: body.maxUses }),
        ...(body.maxUsesPerUser !== undefined && { maxUsesPerUser: body.maxUsesPerUser }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
      },
    });

    await audit(request.user.userId, 'UPDATE_PROMO', 'PromoCode', id, body as Record<string, unknown>, request);

    return { success: true, data: promo };
  });

  app.delete('/promos/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const existing = await app.prisma.promoCode.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('PromoCode', id);

    // Soft-delete: deactivate rather than removing data
    await app.prisma.promoCode.update({
      where: { id },
      data: { isActive: false },
    });

    await audit(request.user.userId, 'DELETE_PROMO', 'PromoCode', id, { code: existing.code }, request);

    return { success: true, message: 'Promo code deactivated' };
  });

  // ─── Zones ─────────────────────────────────────────────────────────────

  app.get('/zones', { preHandler: [adminGuard] }, async () => {
    const zones = await app.prisma.zone.findMany({
      orderBy: { name: 'asc' },
    });
    return { success: true, data: zones };
  });

  app.post('/zones', { preHandler: [adminGuard] }, async (request) => {
    const body = request.body as {
      name: string;
      description?: string;
      boundary: any;
      deliveryBaseFee?: number;
      deliveryPerKm?: number;
      surgeMultiplier?: number;
    };

    const zone = await app.prisma.zone.create({
      data: {
        name: body.name,
        description: body.description,
        boundary: body.boundary,
        deliveryBaseFee: body.deliveryBaseFee,
        deliveryPerKm: body.deliveryPerKm,
        surgeMultiplier: body.surgeMultiplier || 1.0,
      },
    });

    await audit(request.user.userId, 'CREATE_ZONE', 'Zone', zone.id, { name: zone.name }, request);

    return { success: true, data: zone };
  });

  app.put('/zones/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      description?: string;
      boundary?: any;
      isActive?: boolean;
      deliveryBaseFee?: number;
      deliveryPerKm?: number;
      surgeMultiplier?: number;
    };

    const existing = await app.prisma.zone.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Zone', id);

    const zone = await app.prisma.zone.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.boundary !== undefined && { boundary: body.boundary }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(body.deliveryBaseFee !== undefined && { deliveryBaseFee: body.deliveryBaseFee }),
        ...(body.deliveryPerKm !== undefined && { deliveryPerKm: body.deliveryPerKm }),
        ...(body.surgeMultiplier !== undefined && { surgeMultiplier: body.surgeMultiplier }),
      },
    });

    await audit(request.user.userId, 'UPDATE_ZONE', 'Zone', id, body as Record<string, unknown>, request);

    return { success: true, data: zone };
  });

  app.delete('/zones/:id', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };

    const existing = await app.prisma.zone.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Zone', id);

    // Soft-delete: deactivate the zone
    await app.prisma.zone.update({
      where: { id },
      data: { isActive: false },
    });

    await audit(request.user.userId, 'DELETE_ZONE', 'Zone', id, { name: existing.name }, request);

    return { success: true, message: 'Zone deactivated' };
  });

  // ─── Subscriptions ─────────────────────────────────────────────────────

  app.get('/subscriptions', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, type } = request.query as { status?: string; type?: string };

    const where: any = {
      ...(status && { status }),
      ...(type && { type }),
    };

    const [subscriptions, total] = await Promise.all([
      app.prisma.subscription.findMany({
        where,
        include: {
          rider: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } } },
          driver: { include: { user: { select: { id: true, firstName: true, lastName: true, phone: true } } } },
          vendor: { select: { id: true, name: true } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.subscription.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(subscriptions, total, { page, limit, skip }) };
  });

  app.put('/subscriptions/:id/waive-fee', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = request.body as { reason?: string };

    const subscription = await app.prisma.subscription.findUnique({ where: { id } });
    if (!subscription) throw new NotFoundError('Subscription', id);

    const updated = await app.prisma.subscription.update({
      where: { id },
      data: {
        feeWaived: true,
        feeWaivedBy: request.user.userId,
        feeWaivedReason: reason || 'Waived by admin',
      },
    });

    await audit(request.user.userId, 'WAIVE_SUBSCRIPTION_FEE', 'Subscription', id, { reason }, request);

    // Notify the subscription holder
    const notifyUserId = subscription.riderId
      ? (await app.prisma.rider.findUnique({ where: { id: subscription.riderId }, select: { userId: true } }))?.userId
      : subscription.driverId
        ? (await app.prisma.driver.findUnique({ where: { id: subscription.driverId }, select: { userId: true } }))?.userId
        : subscription.vendorId
          ? (await app.prisma.vendor.findUnique({ where: { id: subscription.vendorId }, include: { owner: true } }))?.owner
              ?.userId
          : null;

    if (notifyUserId) {
      await notifications.send({
        userId: notifyUserId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Subscription Fee Waived',
        body: 'Your subscription fee has been waived. You will not be charged for this period.',
      });
    }

    return { success: true, data: updated };
  });

  // ─── Notifications / Broadcast ─────────────────────────────────────────

  app.post('/notifications/broadcast', { preHandler: [adminGuard] }, async (request) => {
    const { title, body, role, data } = request.body as {
      title: string;
      body: string;
      role?: string; // Send to specific role, or all if omitted
      data?: Record<string, unknown>;
    };

    if (!title || !body) {
      throw new AppError(400, 'VALIDATION_ERROR', 'Title and body are required');
    }

    const where: any = {
      status: 'ACTIVE',
      ...(role && { activeRole: role }),
    };

    const users = await app.prisma.user.findMany({
      where,
      select: { id: true },
    });

    const userIds = users.map((u) => u.id);

    if (userIds.length === 0) {
      return { success: true, data: { sent: 0 } };
    }

    // Batch create notifications
    await app.prisma.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        type: 'SYSTEM_ANNOUNCEMENT' as const,
        title,
        body,
        data: (data ?? undefined) as any,
      })),
    });

    // Push via Socket.IO to each user's room
    const payload = {
      type: 'SYSTEM_ANNOUNCEMENT',
      title,
      body,
      data,
      createdAt: new Date().toISOString(),
    };

    for (const userId of userIds) {
      app.io.to(`user:${userId}`).emit('notification', payload);
    }

    await audit(
      request.user.userId,
      'BROADCAST_NOTIFICATION',
      'Notification',
      'broadcast',
      { title, role: role || 'ALL', recipientCount: userIds.length },
      request,
    );

    return { success: true, data: { sent: userIds.length, role: role || 'ALL' } };
  });

  // ─── Audit Logs ────────────────────────────────────────────────────────

  app.get('/audit-logs', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { action, entity, userId, dateFrom, dateTo } = request.query as {
      action?: string;
      entity?: string;
      userId?: string;
      dateFrom?: string;
      dateTo?: string;
    };

    const where: any = {
      ...(action && { action: { contains: action, mode: 'insensitive' } }),
      ...(entity && { entity: { contains: entity, mode: 'insensitive' } }),
      ...(userId && { userId }),
      ...(dateFrom || dateTo
        ? {
            createdAt: {
              ...(dateFrom && { gte: new Date(dateFrom) }),
              ...(dateTo && { lte: new Date(dateTo) }),
            },
          }
        : {}),
    };

    const [logs, total] = await Promise.all([
      app.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
      app.prisma.auditLog.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(logs, total, { page, limit, skip }) };
  });
}
