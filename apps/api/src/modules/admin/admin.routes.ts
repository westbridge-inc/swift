import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  UserRole,
  UserStatus,
  VendorStatus,
  VendorType,
  RiderType,
  OrderStatus,
  OrderType,
  SettlementStatus,
  SubscriptionStatus,
  SubscriptionType,
  DiscountType,
  VerificationDocumentStatus,
  ClaimStatus,
  ReturnStatus,
  RideClass,
} from '@prisma/client';
import { NotificationService } from '../notification/notification.service';
import { VerificationService } from '../verification/verification.service';
import { BillingService } from '../billing/billing.service';
import { SubscriptionService } from '../subscription/subscription.service';
import { CashRulesService } from '../cash/cash-rules.service';
import { OrderService } from '../order/order.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { AppError, NotFoundError, ForbiddenError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const reasonSchema = z.object({
  reason: z.string().max(500).optional(),
});

const featureSchema = z.object({
  featured: z.boolean().optional(),
});

const verifyDocsSchema = z.object({
  verified: z.boolean().optional(),
  rejectionReason: z.string().max(500).optional(),
});

const rideClassSchema = z.object({
  rideClass: z.nativeEnum(RideClass),
});

const cancelOrderSchema = z.object({
  reason: z.string().max(500).optional(),
  refund: z.boolean().optional(),
});

const processSettlementSchema = z.object({
  reference: z.string().max(200).optional(),
});

const configValueSchema = z.object({
  // Platform config values are free-form JSON; presence is what we validate
  value: z.any(),
});

const usersQuerySchema = z.object({
  role: z.nativeEnum(UserRole).optional(),
  status: z.nativeEnum(UserStatus).optional(),
  search: z.string().max(100).optional(),
});

const vendorsQuerySchema = z.object({
  status: z.nativeEnum(VendorStatus).optional(),
  type: z.nativeEnum(VendorType).optional(),
  search: z.string().max(100).optional(),
});

// Riders/drivers list filters use UI keywords, not DB enums
const moverFilterQuerySchema = z.object({
  status: z.enum(['online', 'offline', 'verified', 'unverified']).optional(),
  type: z.nativeEnum(RiderType).optional(),
  search: z.string().max(100).optional(),
});

const adminOrdersQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  type: z.nativeEnum(OrderType).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  search: z.string().max(100).optional(),
});

const settlementsQuerySchema = z.object({
  status: z.nativeEnum(SettlementStatus).optional(),
  vendorId: z.string().optional(),
});

const promosQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional(),
});

const createPromoSchema = z.object({
  code: z.string().trim().min(2).max(40),
  description: z.string().max(500),
  discountType: z.nativeEnum(DiscountType),
  discountValue: z.number().min(0),
  minOrderAmount: z.number().min(0).optional(),
  maxDiscount: z.number().min(0).optional(),
  applicableTo: z.array(z.string().max(50)).max(20).optional(),
  validFrom: z.coerce.date(),
  validUntil: z.coerce.date(),
  maxUses: z.number().int().min(1).optional(),
  maxUsesPerUser: z.number().int().min(1).optional(),
});

const updatePromoSchema = z.object({
  description: z.string().max(500).optional(),
  discountValue: z.number().min(0).optional(),
  minOrderAmount: z.number().min(0).optional(),
  maxDiscount: z.number().min(0).optional(),
  validFrom: z.coerce.date().optional(),
  validUntil: z.coerce.date().optional(),
  maxUses: z.number().int().min(1).optional(),
  maxUsesPerUser: z.number().int().min(1).optional(),
  isActive: z.boolean().optional(),
});

const createZoneSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional(),
  // GeoJSON blob — stored as JSON, shape owned by the maps layer
  boundary: z.any(),
  deliveryBaseFee: z.number().min(0).optional(),
  deliveryPerKm: z.number().min(0).optional(),
  surgeMultiplier: z.number().min(0.5).max(10).optional(),
});

const updateZoneSchema = createZoneSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const subscriptionsQuerySchema = z.object({
  status: z.nativeEnum(SubscriptionStatus).optional(),
  type: z.nativeEnum(SubscriptionType).optional(),
});

const broadcastSchema = z.object({
  title: z.string().trim().min(1).max(150),
  body: z.string().trim().min(1).max(1000),
  role: z.nativeEnum(UserRole).optional(),
  data: z.record(z.unknown()).optional(),
});

const topUpSchema = z.object({
  amount: z.number().positive().max(10_000_000),
  reference: z.string().max(200).optional(),
});

const verificationQueueQuerySchema = z.object({
  status: z.nativeEnum(VerificationDocumentStatus).default('PENDING'),
});

const claimsQueueQuerySchema = z.object({
  status: z.nativeEnum(ClaimStatus).default('PENDING_REVIEW'),
});

const returnsQuerySchema = z.object({
  status: z.nativeEnum(ReturnStatus).optional(),
});
const resolveReturnSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'REFUNDED']),
  note: z.string().max(1000).optional(),
});

const approveDocSchema = z.object({
  // Optional document expiry (e.g. licence end date entered during review)
  expiresAt: z.coerce.date().optional(),
  // Insurance 5-point manual check (spec §3.4) — supplied for hire-insurance docs
  insurance: z.object({
    insurerName: z.string().min(1).max(120),
    policyNumber: z.string().min(1).max(60),
    coverageClass: z.enum(['HIRE', 'PRIVATE']),
    hireClassConfirmed: z.boolean(),
    plateCrossChecked: z.boolean(),
  }).optional(),
});

const rejectDocSchema = z.object({
  reason: z.string().min(3).max(500),
});

const auditLogsQuerySchema = z.object({
  action: z.string().max(100).optional(),
  entity: z.string().max(100).optional(),
  userId: z.string().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

export async function adminRoutes(app: FastifyInstance) {
  const notifications = new NotificationService(app.prisma, app.io);
  const verification = new VerificationService(app.prisma, notifications, getKycProvider());
  const billing = new BillingService(app.prisma, notifications, getPaymentProvider());
  const subscriptions = new SubscriptionService(app.prisma);
  const cashRules = new CashRulesService(app.prisma, notifications, new OrderService(app.prisma, app.io));

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
      activeSubRevenue,
      todayNewUsers,
      weeklyOrderCounts,
      pendingVendors,
      pastDueSubs,
      unassignedOrders,
    ] = await Promise.all([
      app.prisma.user.count(),
      app.prisma.order.count(),
      app.prisma.order.count({ where: { placedAt: { gte: today } } }),
      app.prisma.order.aggregate({
        where: { placedAt: { gte: today }, status: { in: ['DELIVERED', 'COMPLETED'] } },
        _sum: { deliveryFee: true, totalAmount: true },
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
      app.prisma.subscription.aggregate({
        where: { status: 'ACTIVE' },
        _sum: { weeklyRate: true },
      }),
      app.prisma.user.count({ where: { createdAt: { gte: today } } }),
      // Weekly trend: orders per day for the last 7 days
      app.prisma.$queryRaw<Array<{ date: string; count: bigint; revenue: number }>>`
        SELECT
          DATE("placedAt") as date,
          COUNT(*)::int as count,
          COALESCE(SUM(CASE WHEN status IN ('DELIVERED', 'COMPLETED') THEN "totalAmount" ELSE 0 END), 0) as revenue
        FROM orders
        WHERE "placedAt" >= ${weekAgo}
        GROUP BY DATE("placedAt")
        ORDER BY date ASC
      `,
      // Operational alerts — real counts for the dashboard AlertsPanel.
      app.prisma.vendor.count({ where: { status: 'PENDING_APPROVAL' } }),
      app.prisma.subscription.count({ where: { status: 'PAST_DUE' } }),
      app.prisma.order.count({
        where: {
          riderId: null,
          status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
          placedAt: { lt: new Date(Date.now() - 10 * 60 * 1000) },
        },
      }),
    ]);

    // Real weekly rates from subscriptions (set from CountryConfig tiers),
    // never a hardcoded rate table.
    const weeklySubscriptionRevenue = Number(activeSubRevenue._sum.weeklyRate ?? 0);

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
          // Platform revenue = weekly subscriptions only (no markup, no commission).
          weeklySubscriptionRevenue,
          // Context only — mover earnings / GMV, NOT platform revenue:
          todayDeliveryFees: todayRevenue._sum.deliveryFee || 0,
          todayTotal: todayRevenue._sum.totalAmount || 0,
        },
        subscriptionBreakdown: subscriptionCounts,
        weeklyTrend: weeklyOrderCounts,
        alerts: { pendingVendors, pastDueSubs, unassignedOrders },
      },
    };
  });

  // ─── Users ─────────────────────────────────────────────────────────────

  app.get('/users', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { role, status, search } = usersQuerySchema.parse(request.query);

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
    const { reason } = reasonSchema.parse(request.body ?? {});

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
    const { reason } = reasonSchema.parse(request.body ?? {});

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

    // DPA §3.5 — a banned participant has left: schedule document deletion
    await verification.scheduleDocumentRetention(id);

    return { success: true, data: updated };
  });

  // ─── Vendors ───────────────────────────────────────────────────────────

  app.get('/vendors', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, type, search } = vendorsQuerySchema.parse(request.query);

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

    // A subscription is born as a 14-day trial the moment the vendor goes live.
    await subscriptions.startTrialForVendor(id);

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
    const { reason } = reasonSchema.parse(request.body ?? {});

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
    const { featured } = featureSchema.parse(request.body ?? {});

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
    const { status, type, search } = moverFilterQuerySchema.parse(request.query);

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
    const { verified, rejectionReason } = verifyDocsSchema.parse(request.body ?? {});

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

    // Verification is the founder-chosen trigger: start the 14-day trial.
    if (isVerified) await subscriptions.startTrialForRider(id);

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
    const { status, search } = moverFilterQuerySchema.parse(request.query);

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
    const { verified, rejectionReason } = verifyDocsSchema.parse(request.body ?? {});

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

    // Verification is the founder-chosen trigger: start the 14-day trial.
    if (isVerified) await subscriptions.startTrialForDriver(id);

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

  // Premium-fleet onboarding: set the top taxi tier a vehicle serves. This is the
  // assignment surface that makes Comfort/XL dispatchable (the #112 gap).
  app.put('/drivers/:id/ride-class', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { rideClass } = rideClassSchema.parse(request.body ?? {});

    const driver = await app.prisma.driver.findUnique({ where: { id }, select: { id: true } });
    if (!driver) throw new NotFoundError('Driver', id);

    const updated = await app.prisma.driver.update({ where: { id }, data: { rideClass } });
    await audit(request.user.userId, 'SET_DRIVER_RIDE_CLASS', 'Driver', id, { rideClass }, request);

    return { success: true, data: updated };
  });

  // ─── Orders ────────────────────────────────────────────────────────────

  app.get('/orders', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status, type, dateFrom, dateTo, search } = adminOrdersQuerySchema.parse(request.query);

    const where: any = {
      ...(status && { status }),
      ...(type && { orderType: type }),
      ...(dateFrom || dateTo
        ? {
            placedAt: {
              ...(dateFrom && { gte: dateFrom }),
              ...(dateTo && { lte: dateTo }),
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
    const { reason, refund } = cancelOrderSchema.parse(request.body ?? {});

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

    // V1 is cash-only: the platform never holds order money, so there is no wallet
    // to credit. A cancellation before handover means no cash changed hands; if cash
    // was already collected, the refund is settled in cash and tracked via the audit
    // log + customer notification below. (Wallet credit is a Part C / fintech-phase
    // concern — see the dormant walletBalance/Transaction schema notes.)

    app.io.to(`order:${id}`).emit('order:status_changed', { orderId: id, status: newStatus });

    await audit(request.user.userId, 'CANCEL_ORDER', 'Order', id, { reason, refund, previousStatus: order.status }, request);

    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Order Cancelled',
      body: refund
        ? `Your order ${order.orderNumber} has been cancelled. Any cash you paid will be refunded — our team will follow up.`
        : `Your order ${order.orderNumber} has been cancelled. ${reason || ''}`.trim(),
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
    const { status, vendorId } = settlementsQuerySchema.parse(request.query);

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
    const { reference } = processSettlementSchema.parse(request.body ?? {});

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
    const { value } = configValueSchema.parse(request.body);

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
    const { active } = promosQuerySchema.parse(request.query);

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
    const body = createPromoSchema.parse(request.body);

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
    const body = updatePromoSchema.parse(request.body);

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
    const body = createZoneSchema.parse(request.body);

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
    const body = updateZoneSchema.parse(request.body);

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
    const { status, type } = subscriptionsQuerySchema.parse(request.query);

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
    const { reason } = reasonSchema.parse(request.body ?? {});

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

  /** Record a cash/bank-transfer top-up (Step 5 — manual confirm for now).
   *  A top-up while PAST_DUE/SUSPENDED bills immediately and reinstates. */
  app.post('/subscriptions/:id/topup', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = topUpSchema.parse(request.body);

    const balance = await billing.recordTopUp(id, body.amount, request.user.userId, body.reference);
    await audit(request.user.userId, 'PREPAID_TOPUP', 'Subscription', id, { amount: body.amount, reference: body.reference }, request);

    return { success: true, data: { balance: Number(balance.balance), currencyCode: balance.currencyCode } };
  });

  /** Billing audit trail for one subscription. */
  app.get('/subscriptions/:id/billing-events', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);

    const where = { subscriptionId: id };
    const [events, total] = await Promise.all([
      app.prisma.billingEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      app.prisma.billingEvent.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(events, total, { page, limit, skip }) };
  });

  // ─── Notifications / Broadcast ─────────────────────────────────────────

  app.post('/notifications/broadcast', { preHandler: [adminGuard] }, async (request) => {
    const { title, body, role, data } = broadcastSchema.parse(request.body);

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

  // ─── Verification Review Queue (Step 4) ───────────────────────────────

  app.get('/verification/queue', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status } = verificationQueueQuerySchema.parse(request.query);

    const where = { status };
    const [documents, total] = await Promise.all([
      app.prisma.verificationDocument.findMany({
        where,
        include: {
          user: { select: { id: true, firstName: true, lastName: true, phone: true, countryCode: true } },
        },
        orderBy: { createdAt: 'asc' }, // oldest first — review in arrival order
        skip,
        take: limit,
      }),
      app.prisma.verificationDocument.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(documents, total, { page, limit, skip }) };
  });

  app.put('/verification/:id/approve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = approveDocSchema.parse(request.body ?? {});

    const doc = await verification.approveDocument(id, request.user.userId, body.expiresAt, body.insurance);
    await audit(
      request.user.userId,
      'APPROVE_VERIFICATION_DOC',
      'VerificationDocument',
      id,
      { docType: doc.docType, ...(body.insurance ? { insurance: body.insurance } : {}) },
      request,
    );

    return { success: true, data: doc };
  });

  app.put('/verification/:id/reject', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = rejectDocSchema.parse(request.body);

    const doc = await verification.rejectDocument(id, request.user.userId, body.reason);
    await audit(request.user.userId, 'REJECT_VERIFICATION_DOC', 'VerificationDocument', id, { docType: doc.docType, reason: body.reason }, request);

    return { success: true, data: doc };
  });

  /**
   * Short-lived signed URL to view a verification document. Never a public link
   * (DPA §3.5); every issuance is audit-logged as the document access trail
   * (§3.6). Returns 410 once a document has been purged under retention.
   */
  app.get('/verification/:id/document-url', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const doc = await app.prisma.verificationDocument.findUnique({
      where: { id },
      select: { id: true, fileUrl: true, purgedAt: true, docType: true },
    });
    if (!doc) throw new NotFoundError('VerificationDocument', id);
    if (doc.purgedAt || !doc.fileUrl) {
      throw new AppError(410, 'DOCUMENT_PURGED', 'This document has been deleted under the retention policy');
    }

    const ttlSeconds = 300;
    const url = await getStorageProvider().getSignedUrl(doc.fileUrl, ttlSeconds);
    await audit(request.user.userId, 'VIEW_VERIFICATION_DOC', 'VerificationDocument', id, { docType: doc.docType, ttlSeconds }, request);

    return { success: true, data: { url, expiresInSeconds: ttlSeconds } };
  });

  // ─── Retail returns (Phase 8) ──────────────────────────────────────────

  app.get('/returns', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status } = returnsQuerySchema.parse(request.query);
    const where = status ? { status } : {};
    const [items, total] = await Promise.all([
      app.prisma.returnRequest.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      app.prisma.returnRequest.count({ where }),
    ]);
    return { success: true, ...paginatedResponse(items, total, { page, limit, skip }) };
  });

  app.put('/returns/:id/resolve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = resolveReturnSchema.parse(request.body);
    const existing = await app.prisma.returnRequest.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('ReturnRequest', id);
    if (existing.status !== 'REQUESTED') {
      throw new AppError(400, 'ALREADY_RESOLVED', `This return is already ${existing.status.toLowerCase()}`);
    }
    const updated = await app.prisma.returnRequest.update({
      where: { id },
      data: { status: body.status, resolutionNote: body.note, reviewedBy: request.user.userId, reviewedAt: new Date() },
    });
    await audit(request.user.userId, 'RESOLVE_RETURN', 'ReturnRequest', id, { status: body.status }, request);
    return { success: true, data: updated };
  });

  // ─── Cash Rules: guarantee claims + founder metrics (Step 10) ──────────

  app.get('/cash-rules/claims', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { status } = claimsQueueQuerySchema.parse(request.query);

    const where = { status };
    const [claims, total] = await Promise.all([
      app.prisma.reimbursementClaim.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take: limit,
      }),
      app.prisma.reimbursementClaim.count({ where }),
    ]);
    return { success: true, ...paginatedResponse(claims, total, { page, limit, skip }) };
  });

  app.put('/cash-rules/claims/:id/approve', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = reasonSchema.parse(request.body ?? {});
    const claim = await cashRules.approveClaim(id, request.user.userId, body.reason);
    await audit(request.user.userId, 'APPROVE_CLAIM', 'ReimbursementClaim', id, { amount: Number(claim.amount) }, request);
    return { success: true, data: claim };
  });

  app.put('/cash-rules/claims/:id/reject', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = rejectDocSchema.parse(request.body);
    const claim = await cashRules.rejectClaim(id, request.user.userId, body.reason);
    await audit(request.user.userId, 'REJECT_CLAIM', 'ReimbursementClaim', id, { reason: body.reason }, request);
    return { success: true, data: claim };
  });

  app.put('/cash-rules/claims/:id/paid', { preHandler: [adminGuard] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = processSettlementSchema.parse(request.body ?? {});
    const claim = await cashRules.markClaimPaid(id, request.user.userId, body.reference);
    await audit(request.user.userId, 'PAY_CLAIM', 'ReimbursementClaim', id, { reference: body.reference }, request);
    return { success: true, data: claim };
  });

  /** Founder cockpit numbers: failed-payment %, payouts/week, claims by rider. */
  app.get('/cash-rules/metrics', { preHandler: [adminGuard] }, async () => {
    const metrics = await cashRules.founderMetrics();
    return { success: true, data: metrics };
  });

  // ─── Audit Logs ────────────────────────────────────────────────────────

  app.get('/audit-logs', { preHandler: [adminGuard] }, async (request) => {
    const { page, limit, skip } = parsePagination(request.query as Record<string, string>);
    const { action, entity, userId, dateFrom, dateTo } = auditLogsQuerySchema.parse(request.query);

    const where: any = {
      ...(action && { action: { contains: action, mode: 'insensitive' } }),
      ...(entity && { entity: { contains: entity, mode: 'insensitive' } }),
      ...(userId && { userId }),
      ...(dateFrom || dateTo
        ? {
            createdAt: {
              ...(dateFrom && { gte: dateFrom }),
              ...(dateTo && { lte: dateTo }),
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
