import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OrderStatus, OrderType, SettlementStatus } from '@prisma/client';
import { OrderService } from '../order/order.service';
import { NotificationService } from '../notification/notification.service';
import { BookingService } from '../booking/booking.service';
import { VerificationService } from '../verification/verification.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { parseCsvWithHeader } from '../../utils/csv';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const updateVendorProfileSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  phone: z.string().max(20).optional(),
  email: z.string().email().optional(),
  addressLine1: z.string().max(200).optional(),
  addressLine2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  region: z.string().max(100).optional(),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  logoUrl: z.string().max(2048).optional(),
  coverImageUrl: z.string().max(2048).optional(),
  cuisineTypes: z.array(z.string().max(50)).max(20).optional(),
  tags: z.array(z.string().max(50)).max(30).optional(),
  deliveryRadius: z.number().positive().max(100).optional(),
  minOrderAmount: z.number().min(0).optional(),
  estimatedPrepTime: z.number().int().min(0).max(480).optional(),
});

const acceptOrderSchema = z.object({
  estimatedPrepTime: z.number().int().min(1).max(480).optional(),
});

const rejectOrderSchema = z.object({
  reason: z.string().max(500).optional(),
});

const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(1000).optional(),
  imageUrl: z.string().max(2048).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const updateCategorySchema = createCategorySchema.partial().extend({
  isActive: z.boolean().optional(),
});

const reorderCategoriesSchema = z.object({
  order: z
    .array(z.object({ id: z.string().min(1), sortOrder: z.number().int().min(0) }))
    .min(1)
    .max(200),
});

const optionInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  additionalPrice: z.number().min(0).optional(),
  isDefault: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const optionGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  isRequired: z.boolean().optional(),
  minSelect: z.number().int().min(0).max(50).optional(),
  maxSelect: z.number().int().min(1).max(50).optional(),
  sortOrder: z.number().int().min(0).optional(),
});

const createItemSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(1).max(150),
  description: z.string().max(2000).optional(),
  imageUrl: z.string().max(2048).optional(),
  basePrice: z.number().min(0).max(10_000_000),
  sku: z.string().max(64).optional(),
  unit: z.string().max(30).optional(),
  stockQuantity: z.number().int().min(0).optional(),
  isAvailable: z.boolean().optional(),
  isPopular: z.boolean().optional(),
  dietaryTags: z.array(z.string().max(40)).max(30).optional(),
  allergens: z.array(z.string().max(40)).max(30).optional(),
  sortOrder: z.number().int().min(0).optional(),
  optionGroups: z
    .array(optionGroupInputSchema.extend({ options: z.array(optionInputSchema).max(100) }))
    .max(50)
    .optional(),
});

const updateItemSchema = createItemSchema.omit({ optionGroups: true }).partial();

const itemAvailabilitySchema = z.object({
  isAvailable: z.boolean().optional(),
});

const addOptionGroupSchema = optionGroupInputSchema.extend({
  options: z.array(optionInputSchema).max(100).optional(),
});

const updateOptionGroupSchema = optionGroupInputSchema.partial();

const addOptionSchema = optionInputSchema.extend({
  isAvailable: z.boolean().optional(),
});

const updateOptionSchema = addOptionSchema.partial();

const operatingHoursSchema = z.object({
  hours: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        openTime: z.string().max(10).optional().default(''),
        closeTime: z.string().max(10).optional().default(''),
        isClosed: z.boolean(),
      }),
    )
    .min(1)
    .max(7),
});

const importCsvSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
});

const MAX_IMPORT_ROWS = 5000;

/** One CSV row of the import template. Coercions keep messy files importable. */
const csvRowSchema = z.object({
  category: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(150),
  description: z.string().max(2000).optional().default(''),
  basePrice: z.coerce.number().min(0).max(10_000_000),
  sku: z.string().max(64).optional().default(''),
  unit: z.string().max(30).optional().default(''),
  stockQuantity: z
    .union([z.literal(''), z.coerce.number().int().min(0)])
    .optional()
    .default(''),
  isAvailable: z.enum(['true', 'false', '']).optional().default(''),
  fulfillment: z.enum(['DELIVERY', 'PICKUP', 'APPOINTMENT', '']).optional().default(''),
  imageUrl: z.string().max(2048).optional().default(''),
});

const CSV_TEMPLATE = [
  'category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment,imageUrl',
  'Groceries,Basmati Rice 5kg,"Long grain, aged",3500,RICE-5KG,bag,40,true,DELIVERY,',
  'Services,Haircut,"30 minute appointment",2000,,,,true,APPOINTMENT,',
].join('\n');

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Cheap magic-byte sniff so a spoofed Content-Type cannot smuggle non-images. */
function looksLikeImage(buffer: Buffer): boolean {
  if (buffer.length < 12) return false;
  const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  const png = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const webp =
    buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return jpeg || png || webp;
}

const vendorOrdersQuerySchema = z.object({
  status: z.nativeEnum(OrderStatus).optional(),
  orderType: z.nativeEnum(OrderType).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  search: z.string().max(100).optional(),
});

const vendorItemsQuerySchema = z.object({
  categoryId: z.string().optional(),
  isAvailable: z.enum(['true', 'false']).optional(),
  search: z.string().max(100).optional(),
});

const revenueQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});

const popularItemsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const settlementsQuerySchema = z.object({
  status: z.nativeEnum(SettlementStatus).optional(),
});

const reviewsQuerySchema = z.object({
  minScore: z.coerce.number().int().min(1).max(5).optional(),
  maxScore: z.coerce.number().int().min(1).max(5).optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VendorOwnerWithVendors {
  id: string;
  userId: string;
  vendors: { id: string }[];
}

interface IdParam {
  id: string;
}

interface ItemIdParam {
  itemId: string;
}

interface GroupIdParam {
  groupId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the authenticated user to a VendorOwner and their vendor IDs.
 * Throws 404 if the user is not a vendor owner.
 */
async function resolveOwner(app: FastifyInstance, userId: string): Promise<VendorOwnerWithVendors> {
  const owner = await app.prisma.vendorOwner.findUnique({
    where: { userId },
    include: { vendors: { select: { id: true } } },
  });
  if (!owner) throw new NotFoundError('VendorOwner');
  return owner;
}

/**
 * Resolve the owner and return the *first* vendor (most vendors have one).
 * Throws 404 if the vendor doesn't exist.
 */
async function resolveVendor(app: FastifyInstance, userId: string) {
  const owner = await resolveOwner(app, userId);
  if (owner.vendors.length === 0) throw new NotFoundError('Vendor');
  return { ownerId: owner.id, vendorId: owner.vendors[0]!.id, vendorIds: owner.vendors.map((v) => v.id) };
}

/** Acknowledge the persistent order alert — read = acknowledged = silence. */
async function ackVendorAlert(app: FastifyInstance, userId: string, orderId: string) {
  await app.prisma.notification.updateMany({
    where: {
      userId,
      isRead: false,
      AND: [
        { data: { path: ['kind'], equals: 'vendor_order_alert' } },
        { data: { path: ['orderId'], equals: orderId } },
      ],
    },
    data: { isRead: true, readAt: new Date() },
  });
}

/**
 * Verify that the given order belongs to one of the user's vendors and return it.
 */
async function resolveOwnedOrder(app: FastifyInstance, userId: string, orderId: string) {
  const { vendorIds } = await resolveVendor(app, userId);
  const order = await app.prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      statusHistory: { orderBy: { createdAt: 'desc' } },
      customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
      rider: { include: { user: { select: { firstName: true, lastName: true, phone: true } } } },
    },
  });
  if (!order || !order.vendorId || !vendorIds.includes(order.vendorId)) {
    throw new NotFoundError('Order', orderId);
  }
  return order;
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export async function vendorRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  const orderService = new OrderService(app.prisma, app.io);
  const verification = new VerificationService(
    app.prisma,
    new NotificationService(app.prisma, app.io),
    getKycProvider(),
  );
  const storage = getStorageProvider();
  const bookingService = new BookingService(app.prisma);

  // =========================================================================
  // 1. PROFILE
  // =========================================================================

  /** GET /profile — Vendor owner profile with all vendor details */
  app.get('/profile', auth, async (request) => {
    const owner = await app.prisma.vendorOwner.findUnique({
      where: { userId: request.user.userId },
      include: {
        vendors: {
          include: {
            operatingHours: { orderBy: { dayOfWeek: 'asc' } },
            subscription: true,
            categories: { orderBy: { sortOrder: 'asc' }, include: { _count: { select: { items: true } } } },
            _count: { select: { orders: true, items: true } },
          },
        },
      },
    });
    if (!owner) throw new NotFoundError('VendorOwner');
    return { success: true, data: owner };
  });

  /** PUT /profile — Update vendor profile details */
  app.put('/profile', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const body = updateVendorProfileSchema.parse(request.body);

    const vendor = await app.prisma.vendor.update({
      where: { id: vendorId },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.phone !== undefined && { phone: body.phone }),
        ...(body.email !== undefined && { email: body.email }),
        ...(body.addressLine1 !== undefined && { addressLine1: body.addressLine1 }),
        ...(body.addressLine2 !== undefined && { addressLine2: body.addressLine2 }),
        ...(body.city !== undefined && { city: body.city }),
        ...(body.region !== undefined && { region: body.region }),
        ...(body.latitude !== undefined && { latitude: body.latitude }),
        ...(body.longitude !== undefined && { longitude: body.longitude }),
        ...(body.logoUrl !== undefined && { logoUrl: body.logoUrl }),
        ...(body.coverImageUrl !== undefined && { coverImageUrl: body.coverImageUrl }),
        ...(body.cuisineTypes !== undefined && { cuisineTypes: body.cuisineTypes }),
        ...(body.tags !== undefined && { tags: body.tags }),
        ...(body.deliveryRadius !== undefined && { deliveryRadius: body.deliveryRadius }),
        ...(body.minOrderAmount !== undefined && { minOrderAmount: body.minOrderAmount }),
        ...(body.estimatedPrepTime !== undefined && { estimatedPrepTime: body.estimatedPrepTime }),
      },
      include: { operatingHours: { orderBy: { dayOfWeek: 'asc' } } },
    });

    return { success: true, data: vendor };
  });

  // =========================================================================
  // 2. VENDOR MANAGEMENT — Toggle open / accepting orders
  // =========================================================================

  /** PUT /vendor/toggle-open — Toggle isCurrentlyOpen */
  app.put('/vendor/toggle-open', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });

    const updated = await app.prisma.vendor.update({
      where: { id: vendorId },
      data: { isCurrentlyOpen: !vendor.isCurrentlyOpen },
    });

    // Broadcast to anyone watching this vendor's storefront
    app.io.emit('vendor:status', { vendorId, isCurrentlyOpen: updated.isCurrentlyOpen });

    return { success: true, data: { isCurrentlyOpen: updated.isCurrentlyOpen, acceptingOrders: updated.acceptingOrders } };
  });

  /** PUT /vendor/toggle-orders — Toggle acceptingOrders */
  app.put('/vendor/toggle-orders', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });

    const updated = await app.prisma.vendor.update({
      where: { id: vendorId },
      data: { acceptingOrders: !vendor.acceptingOrders },
    });

    app.io.emit('vendor:status', { vendorId, acceptingOrders: updated.acceptingOrders });

    return { success: true, data: { isCurrentlyOpen: updated.isCurrentlyOpen, acceptingOrders: updated.acceptingOrders } };
  });

  // =========================================================================
  // 3. ORDERS
  // =========================================================================

  /** GET /alerts/pending — unacknowledged order alerts (dashboard banner state). */
  app.get('/alerts/pending', auth, async (request) => {
    const alerts = await app.prisma.notification.findMany({
      where: {
        userId: request.user.userId,
        isRead: false,
        data: { path: ['kind'], equals: 'vendor_order_alert' },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, title: true, body: true, data: true, createdAt: true },
    });
    return { success: true, data: alerts };
  });

  /** PUT /orders/:id/ack — explicit acknowledgement without accept/reject. */
  app.put<{ Params: IdParam }>('/orders/:id/ack', auth, async (request) => {
    await resolveOwnedOrder(app, request.user.userId, request.params.id);
    await ackVendorAlert(app, request.user.userId, request.params.id);
    return { success: true, data: { acknowledged: true } };
  });

  /** GET /orders — Paginated, filterable order list */
  app.get('/orders', auth, async (request) => {
    const { vendorIds } = await resolveVendor(app, request.user.userId);
    const query = request.query as Record<string, string | undefined>;
    const pagination = parsePagination(query);
    const { status, orderType, from, to, search } = vendorOrdersQuerySchema.parse(request.query);

    const where: Record<string, unknown> = { vendorId: { in: vendorIds } };
    if (status) where['status'] = status;
    if (orderType) where['orderType'] = orderType;
    if (from) where['placedAt'] = { ...(where['placedAt'] as object || {}), gte: from };
    if (to) where['placedAt'] = { ...(where['placedAt'] as object || {}), lte: to };
    if (search) {
      where['OR'] = [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { customer: { firstName: { contains: search, mode: 'insensitive' } } },
        { customer: { lastName: { contains: search, mode: 'insensitive' } } },
      ];
    }

    const [orders, total] = await Promise.all([
      app.prisma.order.findMany({
        where,
        include: {
          items: true,
          customer: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          rider: { include: { user: { select: { firstName: true, lastName: true, phone: true } } } },
        },
        orderBy: { placedAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      app.prisma.order.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(orders, total, pagination) };
  });

  /** GET /orders/:id — Full order detail */
  app.get<{ Params: IdParam }>('/orders/:id', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    return { success: true, data: order };
  });

  /** PUT /orders/:id/accept — Accept an incoming order */
  app.put<{ Params: IdParam }>('/orders/:id/accept', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    if (order.status !== 'PENDING') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot accept order in ${order.status} status`);
    }
    const body = acceptOrderSchema.parse(request.body ?? {});

    // Appointment orders book their slot AT ACCEPTANCE (locked model). If the
    // slot was taken since checkout, this 409s and the order stays PENDING —
    // the customer picks a new time instead of holding a phantom booking.
    if (order.fulfillment === 'APPOINTMENT' && order.appointmentSlot) {
      const serviceItem = order.items[0];
      if (serviceItem?.itemId) {
        await bookingService.reserveSlot(serviceItem.itemId, order.customerId, order.appointmentSlot, order.id);
      }
    }

    if (body.estimatedPrepTime) {
      await app.prisma.order.update({
        where: { id: order.id },
        data: { estimatedPrepTime: body.estimatedPrepTime },
      });
    }
    const updated = await orderService.updateStatus(order.id, 'ACCEPTED', request.user.userId, 'Accepted by vendor');
    await ackVendorAlert(app, request.user.userId, order.id); // accepting acknowledges the alert

    // Step 8: acceptance of a DELIVERY order starts the dispatch cascade.
    // PICKUP and APPOINTMENT orders never dispatch.
    if (order.fulfillment === 'DELIVERY' && app.dispatchQueue) {
      await app.dispatchQueue.add('dispatch-order', { orderId: order.id }, {
        removeOnComplete: 100,
        removeOnFail: 50,
      });
    }

    return { success: true, data: updated };
  });

  /** PUT /orders/:id/preparing — Mark order as being prepared */
  app.put<{ Params: IdParam }>('/orders/:id/preparing', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    if (order.status !== 'ACCEPTED') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot mark as preparing from ${order.status} status`);
    }
    const updated = await orderService.updateStatus(order.id, 'PREPARING', request.user.userId, 'Vendor started preparing');
    return { success: true, data: updated };
  });

  /** PUT /orders/:id/ready — Mark order as ready for pickup */
  app.put<{ Params: IdParam }>('/orders/:id/ready', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    if (order.status !== 'PREPARING') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot mark as ready from ${order.status} status`);
    }
    const updated = await orderService.updateStatus(order.id, 'READY_FOR_PICKUP', request.user.userId, 'Order ready for pickup');
    return { success: true, data: updated };
  });

  /** PUT /orders/:id/reject — Vendor cancels / rejects an order */
  app.put<{ Params: IdParam }>('/orders/:id/reject', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    const rejectableStatuses = ['PENDING', 'ACCEPTED', 'PREPARING'];
    if (!rejectableStatuses.includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS', `Cannot reject order in ${order.status} status`);
    }
    const body = rejectOrderSchema.parse(request.body ?? {});
    const reason = body.reason || 'Rejected by vendor';
    await ackVendorAlert(app, request.user.userId, order.id); // rejecting acknowledges too

    const updated = await app.prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: request.user.userId,
        cancellationReason: reason,
      },
      include: { customer: { select: { id: true, firstName: true } } },
    });

    await app.prisma.orderStatusLog.create({
      data: {
        orderId: order.id,
        status: 'CANCELLED',
        changedBy: request.user.userId,
        note: reason,
      },
    });

    // Free up assigned rider if one was already assigned
    if (order.riderId) {
      await app.prisma.rider.update({
        where: { id: order.riderId },
        data: { isAvailable: true, currentOrderId: null },
      });
    }

    app.io.to(`order:${order.id}`).emit('order:status_changed', {
      orderId: order.id,
      status: 'CANCELLED',
      reason,
      timestamp: new Date().toISOString(),
    });

    return { success: true, data: updated };
  });

  // =========================================================================
  // 4. MENU — Categories
  // =========================================================================

  /** GET /categories — List all categories for the vendor */
  app.get('/categories', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const categories = await app.prisma.category.findMany({
      where: { vendorId },
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
          include: { optionGroups: { orderBy: { sortOrder: 'asc' }, include: { options: { orderBy: { sortOrder: 'asc' } } } } },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });
    return { success: true, data: categories };
  });

  /** POST /categories — Create a category */
  app.post('/categories', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const body = createCategorySchema.parse(request.body);
    if (!body.name?.trim()) throw new ValidationError('Category name is required');

    // Auto-assign sortOrder to end if not provided
    let sortOrder = body.sortOrder;
    if (sortOrder === undefined) {
      const last = await app.prisma.category.findFirst({
        where: { vendorId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }

    const category = await app.prisma.category.create({
      data: {
        vendorId,
        name: body.name.trim(),
        description: body.description?.trim(),
        imageUrl: body.imageUrl,
        sortOrder,
      },
    });
    return { success: true, data: category };
  });

  /** PUT /categories/:id — Update a category */
  app.put<{ Params: IdParam }>('/categories/:id', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const existing = await app.prisma.category.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('Category', request.params.id);

    const body = updateCategorySchema.parse(request.body);
    const category = await app.prisma.category.update({
      where: { id: request.params.id },
      data: {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.description !== undefined && { description: body.description?.trim() }),
        ...(body.imageUrl !== undefined && { imageUrl: body.imageUrl }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
      },
    });
    return { success: true, data: category };
  });

  /** DELETE /categories/:id — Delete a category (and its items) */
  app.delete<{ Params: IdParam }>('/categories/:id', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const existing = await app.prisma.category.findUnique({
      where: { id: request.params.id },
      include: { _count: { select: { items: true } } },
    });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('Category', request.params.id);

    // Delete all items in this category first (cascading through option groups/options)
    await app.prisma.option.deleteMany({
      where: { optionGroup: { item: { categoryId: request.params.id } } },
    });
    await app.prisma.optionGroup.deleteMany({
      where: { item: { categoryId: request.params.id } },
    });
    await app.prisma.item.deleteMany({ where: { categoryId: request.params.id } });
    await app.prisma.category.delete({ where: { id: request.params.id } });

    return { success: true, data: { deleted: true, itemsRemoved: existing._count.items } };
  });

  /** PUT /categories/reorder — Bulk reorder categories */
  app.put('/categories/reorder', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const body = reorderCategoriesSchema.parse(request.body);

    await app.prisma.$transaction(
      body.order.map((item) =>
        app.prisma.category.updateMany({
          where: { id: item.id, vendorId },
          data: { sortOrder: item.sortOrder },
        }),
      ),
    );

    const categories = await app.prisma.category.findMany({
      where: { vendorId },
      orderBy: { sortOrder: 'asc' },
    });
    return { success: true, data: categories };
  });

  // =========================================================================
  // 4. MENU — Items
  // =========================================================================

  /** GET /items — List all items, optionally filtered by categoryId */
  app.get('/items', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const query = vendorItemsQuerySchema.parse(request.query);

    const where: Record<string, unknown> = { vendorId };
    if (query.categoryId) where['categoryId'] = query.categoryId;
    if (query.isAvailable === 'true') where['isAvailable'] = true;
    if (query.isAvailable === 'false') where['isAvailable'] = false;
    if (query.search) where['name'] = { contains: query.search, mode: 'insensitive' };

    const items = await app.prisma.item.findMany({
      where,
      include: {
        category: { select: { id: true, name: true } },
        optionGroups: {
          orderBy: { sortOrder: 'asc' },
          include: { options: { orderBy: { sortOrder: 'asc' } } },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });
    return { success: true, data: items };
  });

  /** POST /items — Create an item with optional option groups */
  app.post('/items', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);

    // Step 4 gate: no listing until the vendor-type checklist is approved.
    // Legacy isVerified grandfathers pre-checklist vendors.
    const vendorRecord = await app.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { isVerified: true, vendorType: true },
    });
    const verified = vendorRecord.isVerified
      || await verification.isRoleVerified(request.user.userId, vendorRecord.vendorType);
    if (!verified) {
      throw new AppError(403, 'VERIFICATION_REQUIRED', 'Complete document verification before listing items');
    }

    const body = createItemSchema.parse(request.body);

    // Verify category belongs to this vendor
    const category = await app.prisma.category.findUnique({ where: { id: body.categoryId } });
    if (!category || category.vendorId !== vendorId) throw new NotFoundError('Category', body.categoryId);

    // Auto-assign sortOrder
    let sortOrder = body.sortOrder;
    if (sortOrder === undefined) {
      const last = await app.prisma.item.findFirst({
        where: { vendorId, categoryId: body.categoryId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }

    const item = await app.prisma.item.create({
      data: {
        vendorId,
        categoryId: body.categoryId,
        name: body.name.trim(),
        description: body.description?.trim(),
        imageUrl: body.imageUrl,
        basePrice: body.basePrice,
        sku: body.sku,
        unit: body.unit,
        stockQuantity: body.stockQuantity,
        isAvailable: body.isAvailable ?? true,
        isPopular: body.isPopular ?? false,
        dietaryTags: body.dietaryTags || [],
        allergens: body.allergens || [],
        sortOrder,
        optionGroups: body.optionGroups?.length
          ? {
              create: body.optionGroups.map((group, gi) => ({
                name: group.name,
                isRequired: group.isRequired ?? false,
                minSelect: group.minSelect ?? 0,
                maxSelect: group.maxSelect ?? 1,
                sortOrder: group.sortOrder ?? gi,
                options: {
                  create: group.options.map((opt, oi) => ({
                    name: opt.name,
                    additionalPrice: opt.additionalPrice ?? 0,
                    isDefault: opt.isDefault ?? false,
                    sortOrder: opt.sortOrder ?? oi,
                  })),
                },
              })),
            }
          : undefined,
      },
      include: {
        category: { select: { id: true, name: true } },
        optionGroups: { include: { options: { orderBy: { sortOrder: 'asc' } } }, orderBy: { sortOrder: 'asc' } },
      },
    });

    return { success: true, data: item };
  });

  /** GET /items/import/template — CSV template for bulk import */
  app.get('/items/import/template', auth, async (_request, reply) => {
    reply.type('text/csv').header('content-disposition', 'attachment; filename="swift-catalogue-template.csv"');
    return CSV_TEMPLATE;
  });

  /** POST /items/import — CSV bulk import: bad rows reported, good rows imported */
  app.post('/items/import', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);

    // Same listing gate as single-item creation
    const vendorRecord = await app.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { isVerified: true, vendorType: true },
    });
    const verified = vendorRecord.isVerified
      || await verification.isRoleVerified(request.user.userId, vendorRecord.vendorType);
    if (!verified) {
      throw new AppError(403, 'VERIFICATION_REQUIRED', 'Complete document verification before listing items');
    }

    const { csv } = importCsvSchema.parse(request.body);
    const rows = parseCsvWithHeader(csv);

    if (rows.length === 0) {
      throw new AppError(400, 'EMPTY_CSV', 'No data rows found — download the template to see the format');
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new AppError(400, 'TOO_MANY_ROWS', `Import is limited to ${MAX_IMPORT_ROWS} rows per file (got ${rows.length})`);
    }

    const failures: Array<{ row: number; errors: string[] }> = [];
    const valid: Array<{ rowNumber: number; data: z.infer<typeof csvRowSchema> }> = [];

    rows.forEach((raw, index) => {
      const parsed = csvRowSchema.safeParse(raw);
      if (parsed.success) {
        valid.push({ rowNumber: index + 2, data: parsed.data }); // +2: 1-based + header
      } else {
        failures.push({
          row: index + 2,
          errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
        });
      }
    });

    // Categories resolve by name (case-insensitive), created on demand
    const categories = await app.prisma.category.findMany({ where: { vendorId } });
    const categoryIds = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));

    let imported = 0;
    for (const { rowNumber, data } of valid) {
      const key = data.category.toLowerCase();
      let categoryId = categoryIds.get(key);
      if (!categoryId) {
        const created = await app.prisma.category.create({
          data: { vendorId, name: data.category, sortOrder: categoryIds.size },
        });
        categoryId = created.id;
        categoryIds.set(key, categoryId);
      }

      try {
        await app.prisma.item.create({
          data: {
            vendorId,
            categoryId,
            name: data.name,
            description: data.description || undefined,
            basePrice: data.basePrice,
            sku: data.sku || undefined,
            unit: data.unit || undefined,
            stockQuantity: data.stockQuantity === '' ? undefined : data.stockQuantity,
            isAvailable: data.isAvailable === '' ? true : data.isAvailable === 'true',
            fulfillment: data.fulfillment === '' ? 'DELIVERY' : data.fulfillment,
            imageUrl: data.imageUrl || undefined,
            dietaryTags: [],
            allergens: [],
          },
        });
        imported += 1;
      } catch {
        failures.push({ row: rowNumber, errors: ['Database rejected this row'] });
      }
    }

    return {
      success: true,
      data: {
        imported,
        failedCount: failures.length,
        // Cap the detail list so a fully-broken huge file stays readable
        failures: failures.slice(0, 100),
      },
    };
  });

  /** POST /items/:id/image — upload behind the StorageProvider interface */
  app.post<{ Params: IdParam }>('/items/:id/image', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const existing = await app.prisma.item.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('Item', request.params.id);

    const file = await request.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach an image file');
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      throw new AppError(400, 'BAD_IMAGE_TYPE', 'Only JPEG, PNG, or WebP images are accepted');
    }

    const buffer = await file.toBuffer();
    if (!looksLikeImage(buffer)) {
      throw new AppError(400, 'BAD_IMAGE', 'File content does not match an image format');
    }

    const { url } = await storage.upload({
      buffer,
      filename: file.filename,
      mimeType: file.mimetype,
      folder: `items/${vendorId}`,
    });

    const item = await app.prisma.item.update({
      where: { id: request.params.id },
      data: { imageUrl: url },
      select: { id: true, name: true, imageUrl: true },
    });

    return { success: true, data: item };
  });

  /** PUT /items/:id — Update an item */
  app.put<{ Params: IdParam }>('/items/:id', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const existing = await app.prisma.item.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('Item', request.params.id);

    const body = updateItemSchema.parse(request.body);

    // If moving to a different category, verify ownership
    if (body.categoryId && body.categoryId !== existing.categoryId) {
      const cat = await app.prisma.category.findUnique({ where: { id: body.categoryId } });
      if (!cat || cat.vendorId !== vendorId) throw new NotFoundError('Category', body.categoryId);
    }

    const item = await app.prisma.item.update({
      where: { id: request.params.id },
      data: {
        ...(body.categoryId !== undefined && { categoryId: body.categoryId }),
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.description !== undefined && { description: body.description?.trim() }),
        ...(body.imageUrl !== undefined && { imageUrl: body.imageUrl }),
        ...(body.basePrice !== undefined && { basePrice: body.basePrice }),
        ...(body.sku !== undefined && { sku: body.sku }),
        ...(body.unit !== undefined && { unit: body.unit }),
        ...(body.stockQuantity !== undefined && { stockQuantity: body.stockQuantity }),
        ...(body.isAvailable !== undefined && { isAvailable: body.isAvailable }),
        ...(body.isPopular !== undefined && { isPopular: body.isPopular }),
        ...(body.dietaryTags !== undefined && { dietaryTags: body.dietaryTags }),
        ...(body.allergens !== undefined && { allergens: body.allergens }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
      },
      include: {
        category: { select: { id: true, name: true } },
        optionGroups: { include: { options: { orderBy: { sortOrder: 'asc' } } }, orderBy: { sortOrder: 'asc' } },
      },
    });

    return { success: true, data: item };
  });

  /** DELETE /items/:id — Delete an item and its option groups/options */
  app.delete<{ Params: IdParam }>('/items/:id', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const existing = await app.prisma.item.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('Item', request.params.id);

    await app.prisma.option.deleteMany({ where: { optionGroup: { itemId: request.params.id } } });
    await app.prisma.optionGroup.deleteMany({ where: { itemId: request.params.id } });
    await app.prisma.item.delete({ where: { id: request.params.id } });

    return { success: true, data: { deleted: true } };
  });

  /** PUT /items/:id/availability — Quick toggle availability */
  app.put<{ Params: IdParam }>('/items/:id/availability', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const existing = await app.prisma.item.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('Item', request.params.id);

    const body = itemAvailabilitySchema.parse(request.body ?? {});
    const newAvailability = body.isAvailable !== undefined ? body.isAvailable : !existing.isAvailable;

    const item = await app.prisma.item.update({
      where: { id: request.params.id },
      data: { isAvailable: newAvailability },
      select: { id: true, name: true, isAvailable: true },
    });

    return { success: true, data: item };
  });

  // =========================================================================
  // 4. MENU — Option Groups
  // =========================================================================

  /** POST /items/:itemId/option-groups — Add an option group to an item */
  app.post<{ Params: ItemIdParam }>('/items/:itemId/option-groups', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const item = await app.prisma.item.findUnique({ where: { id: request.params.itemId } });
    if (!item || item.vendorId !== vendorId) throw new NotFoundError('Item', request.params.itemId);

    const body = addOptionGroupSchema.parse(request.body);

    let sortOrder = body.sortOrder;
    if (sortOrder === undefined) {
      const last = await app.prisma.optionGroup.findFirst({
        where: { itemId: request.params.itemId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }

    const group = await app.prisma.optionGroup.create({
      data: {
        itemId: request.params.itemId,
        name: body.name.trim(),
        isRequired: body.isRequired ?? false,
        minSelect: body.minSelect ?? 0,
        maxSelect: body.maxSelect ?? 1,
        sortOrder,
        options: body.options?.length
          ? {
              create: body.options.map((opt, i) => ({
                name: opt.name,
                additionalPrice: opt.additionalPrice ?? 0,
                isDefault: opt.isDefault ?? false,
                sortOrder: opt.sortOrder ?? i,
              })),
            }
          : undefined,
      },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    });

    return { success: true, data: group };
  });

  /** PUT /option-groups/:id — Update an option group */
  app.put<{ Params: IdParam }>('/option-groups/:id', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const existing = await app.prisma.optionGroup.findUnique({
      where: { id: request.params.id },
      include: { item: { select: { vendorId: true } } },
    });
    if (!existing || existing.item.vendorId !== vendorId) throw new NotFoundError('OptionGroup', request.params.id);

    const body = updateOptionGroupSchema.parse(request.body);

    const group = await app.prisma.optionGroup.update({
      where: { id: request.params.id },
      data: {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.isRequired !== undefined && { isRequired: body.isRequired }),
        ...(body.minSelect !== undefined && { minSelect: body.minSelect }),
        ...(body.maxSelect !== undefined && { maxSelect: body.maxSelect }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
      },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    });

    return { success: true, data: group };
  });

  /** DELETE /option-groups/:id — Delete an option group and its options */
  app.delete<{ Params: IdParam }>('/option-groups/:id', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const existing = await app.prisma.optionGroup.findUnique({
      where: { id: request.params.id },
      include: { item: { select: { vendorId: true } } },
    });
    if (!existing || existing.item.vendorId !== vendorId) throw new NotFoundError('OptionGroup', request.params.id);

    await app.prisma.option.deleteMany({ where: { optionGroupId: request.params.id } });
    await app.prisma.optionGroup.delete({ where: { id: request.params.id } });

    return { success: true, data: { deleted: true } };
  });

  // =========================================================================
  // 4. MENU — Options
  // =========================================================================

  /** POST /option-groups/:groupId/options — Add an option to a group */
  app.post<{ Params: GroupIdParam }>('/option-groups/:groupId/options', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const group = await app.prisma.optionGroup.findUnique({
      where: { id: request.params.groupId },
      include: { item: { select: { vendorId: true } } },
    });
    if (!group || group.item.vendorId !== vendorId) throw new NotFoundError('OptionGroup', request.params.groupId);

    const body = addOptionSchema.parse(request.body);

    let sortOrder = body.sortOrder;
    if (sortOrder === undefined) {
      const last = await app.prisma.option.findFirst({
        where: { optionGroupId: request.params.groupId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }

    const option = await app.prisma.option.create({
      data: {
        optionGroupId: request.params.groupId,
        name: body.name.trim(),
        additionalPrice: body.additionalPrice ?? 0,
        isDefault: body.isDefault ?? false,
        isAvailable: body.isAvailable ?? true,
        sortOrder,
      },
    });

    return { success: true, data: option };
  });

  /** PUT /options/:id — Update an option */
  app.put<{ Params: IdParam }>('/options/:id', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const existing = await app.prisma.option.findUnique({
      where: { id: request.params.id },
      include: { optionGroup: { include: { item: { select: { vendorId: true } } } } },
    });
    if (!existing || existing.optionGroup.item.vendorId !== vendorId) throw new NotFoundError('Option', request.params.id);

    const body = updateOptionSchema.parse(request.body);

    const option = await app.prisma.option.update({
      where: { id: request.params.id },
      data: {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.additionalPrice !== undefined && { additionalPrice: body.additionalPrice }),
        ...(body.isDefault !== undefined && { isDefault: body.isDefault }),
        ...(body.isAvailable !== undefined && { isAvailable: body.isAvailable }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
      },
    });

    return { success: true, data: option };
  });

  /** DELETE /options/:id — Delete an option */
  app.delete<{ Params: IdParam }>('/options/:id', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const existing = await app.prisma.option.findUnique({
      where: { id: request.params.id },
      include: { optionGroup: { include: { item: { select: { vendorId: true } } } } },
    });
    if (!existing || existing.optionGroup.item.vendorId !== vendorId) throw new NotFoundError('Option', request.params.id);

    await app.prisma.option.delete({ where: { id: request.params.id } });

    return { success: true, data: { deleted: true } };
  });

  // =========================================================================
  // 5. OPERATING HOURS
  // =========================================================================

  /** GET /hours — Get operating hours for all 7 days */
  app.get('/hours', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const hours = await app.prisma.operatingHours.findMany({
      where: { vendorId },
      orderBy: { dayOfWeek: 'asc' },
    });
    return { success: true, data: hours };
  });

  /** PUT /hours — Bulk upsert operating hours for all 7 days */
  app.put('/hours', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const body = operatingHoursSchema.parse(request.body);

    // Open days must carry both times (closed days may omit them)
    for (const h of body.hours) {
      if (!h.isClosed && (!h.openTime || !h.closeTime)) {
        throw new ValidationError(`openTime and closeTime required for day ${h.dayOfWeek}`);
      }
    }

    // Replace all hours in a transaction: delete existing, then create new
    const results = await app.prisma.$transaction(async (tx) => {
      await tx.operatingHours.deleteMany({ where: { vendorId } });
      await tx.operatingHours.createMany({
        data: body.hours.map((h) => ({
          vendorId,
          dayOfWeek: h.dayOfWeek,
          openTime: h.openTime || '',
          closeTime: h.closeTime || '',
          isClosed: h.isClosed,
        })),
      });
      return tx.operatingHours.findMany({
        where: { vendorId },
        orderBy: { dayOfWeek: 'asc' },
      });
    });

    return { success: true, data: results };
  });

  // =========================================================================
  // 6. ANALYTICS
  // =========================================================================

  /** GET /analytics/overview — Dashboard summary cards */
  app.get('/analytics/overview', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(todayStart);
    monthStart.setDate(monthStart.getDate() - 30);

    const completedStatuses = ['DELIVERED', 'COMPLETED'] as import('@prisma/client').OrderStatus[];

    const [
      vendor,
      todayOrders,
      weekOrders,
      monthOrders,
      todayRevenue,
      weekRevenue,
      monthRevenue,
      activeItems,
      pendingOrders,
    ] = await Promise.all([
      app.prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { averageRating: true, totalRatings: true, totalOrders: true, isCurrentlyOpen: true, acceptingOrders: true },
      }),
      app.prisma.order.count({ where: { vendorId, placedAt: { gte: todayStart } } }),
      app.prisma.order.count({ where: { vendorId, placedAt: { gte: weekStart } } }),
      app.prisma.order.count({ where: { vendorId, placedAt: { gte: monthStart } } }),
      app.prisma.order.aggregate({
        where: { vendorId, status: { in: completedStatuses }, placedAt: { gte: todayStart } },
        _sum: { subtotalBase: true },
      }),
      app.prisma.order.aggregate({
        where: { vendorId, status: { in: completedStatuses }, placedAt: { gte: weekStart } },
        _sum: { subtotalBase: true },
      }),
      app.prisma.order.aggregate({
        where: { vendorId, status: { in: completedStatuses }, placedAt: { gte: monthStart } },
        _sum: { subtotalBase: true },
      }),
      app.prisma.item.count({ where: { vendorId, isAvailable: true } }),
      app.prisma.order.count({ where: { vendorId, status: 'PENDING' } }),
    ]);

    return {
      success: true,
      data: {
        vendor: {
          averageRating: vendor?.averageRating ?? 0,
          totalRatings: vendor?.totalRatings ?? 0,
          totalOrders: vendor?.totalOrders ?? 0,
          isCurrentlyOpen: vendor?.isCurrentlyOpen ?? false,
          acceptingOrders: vendor?.acceptingOrders ?? false,
        },
        today: {
          orders: todayOrders,
          revenue: Number(todayRevenue._sum?.subtotalBase ?? 0),
        },
        week: {
          orders: weekOrders,
          revenue: Number(weekRevenue._sum?.subtotalBase ?? 0),
        },
        month: {
          orders: monthOrders,
          revenue: Number(monthRevenue._sum?.subtotalBase ?? 0),
        },
        activeMenuItems: activeItems,
        pendingOrders,
      },
    };
  });

  /** GET /analytics/revenue — Daily revenue breakdown for the last 30 days */
  app.get('/analytics/revenue', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const { days } = revenueQuerySchema.parse(request.query);

    const since = new Date();
    since.setDate(since.getDate() - days);
    since.setHours(0, 0, 0, 0);

    const completedStatuses = ['DELIVERED', 'COMPLETED'] as import('@prisma/client').OrderStatus[];

    const orders = await app.prisma.order.findMany({
      where: {
        vendorId,
        status: { in: completedStatuses },
        placedAt: { gte: since },
      },
      select: {
        placedAt: true,
        subtotalBase: true,
        subtotalMarkup: true,
        totalAmount: true,
      },
      orderBy: { placedAt: 'asc' },
    });

    // Aggregate by day
    const dailyMap = new Map<string, { date: string; orders: number; revenue: number; markup: number; total: number }>();

    // Pre-fill all days so gaps show as zero
    for (let d = 0; d < days; d++) {
      const date = new Date(since);
      date.setDate(date.getDate() + d);
      const key = date.toISOString().slice(0, 10);
      dailyMap.set(key, { date: key, orders: 0, revenue: 0, markup: 0, total: 0 });
    }

    for (const o of orders) {
      const key = o.placedAt.toISOString().slice(0, 10);
      const entry = dailyMap.get(key);
      if (entry) {
        entry.orders += 1;
        entry.revenue += Number(o.subtotalBase);
        entry.markup += Number(o.subtotalMarkup);
        entry.total += Number(o.totalAmount);
      }
    }

    const daily = Array.from(dailyMap.values());

    return {
      success: true,
      data: {
        days,
        daily,
        totals: {
          orders: orders.length,
          revenue: daily.reduce((s, d) => s + d.revenue, 0),
          markup: daily.reduce((s, d) => s + d.markup, 0),
          total: daily.reduce((s, d) => s + d.total, 0),
        },
      },
    };
  });

  /** GET /analytics/popular-items — Top items by totalOrdered */
  app.get('/analytics/popular-items', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const { limit } = popularItemsQuerySchema.parse(request.query);

    const items = await app.prisma.item.findMany({
      where: { vendorId },
      orderBy: { totalOrdered: 'desc' },
      take: limit,
      select: {
        id: true,
        name: true,
        basePrice: true,
        imageUrl: true,
        totalOrdered: true,
        isAvailable: true,
        category: { select: { id: true, name: true } },
      },
    });

    // Also get recent order-item counts for the last 30 days for trending data
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const recentCounts = await app.prisma.orderItem.groupBy({
      by: ['itemId'],
      where: {
        order: { vendorId, placedAt: { gte: since } },
      },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: limit,
    });

    const recentMap = new Map(recentCounts.map((rc) => [rc.itemId, rc._sum.quantity || 0]));

    const enriched = items.map((item) => ({
      ...item,
      basePrice: Number(item.basePrice),
      recentOrders: recentMap.get(item.id) || 0,
    }));

    return { success: true, data: enriched };
  });

  // =========================================================================
  // 7. SETTLEMENTS
  // =========================================================================

  /** GET /settlements — Paginated settlement history */
  app.get('/settlements', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const query = request.query as Record<string, string | undefined>;
    const pagination = parsePagination(query);

    const { status } = settlementsQuerySchema.parse(request.query);
    const where: Record<string, unknown> = { vendorId };
    if (status) where['status'] = status;

    const [settlements, total] = await Promise.all([
      app.prisma.settlement.findMany({
        where,
        orderBy: { periodEnd: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      app.prisma.settlement.count({ where }),
    ]);

    // Convert Decimal fields to numbers for JSON
    const data = settlements.map((s) => ({
      ...s,
      totalBase: Number(s.totalBase),
      totalMarkup: Number(s.totalMarkup),
    }));

    return { success: true, ...paginatedResponse(data, total, pagination) };
  });

  // =========================================================================
  // 8. SUBSCRIPTION
  // =========================================================================

  /** GET /subscription — Current subscription details */
  app.get('/subscription', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const subscription = await app.prisma.subscription.findFirst({
      where: { vendorId },
    });

    return {
      success: true,
      data: subscription
        ? {
            ...subscription,
            weeklyRate: Number(subscription.weeklyRate),
          }
        : null,
    };
  });

  // =========================================================================
  // 9. REVIEWS
  // =========================================================================

  /** GET /reviews — Paginated customer reviews for the vendor */
  app.get('/reviews', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId);
    const query = request.query as Record<string, string | undefined>;
    const pagination = parsePagination(query);

    const where: Record<string, unknown> = {
      vendorId,
      type: 'CUSTOMER_TO_VENDOR',
    };
    const { minScore, maxScore } = reviewsQuerySchema.parse(request.query);
    if (minScore) where['score'] = { ...(where['score'] as object || {}), gte: minScore };
    if (maxScore) where['score'] = { ...(where['score'] as object || {}), lte: maxScore };

    const [reviews, total, aggregate] = await Promise.all([
      app.prisma.rating.findMany({
        where,
        include: {
          rater: { select: { id: true, firstName: true, lastName: true, avatar: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      app.prisma.rating.count({ where }),
      app.prisma.rating.aggregate({
        where: { vendorId, type: 'CUSTOMER_TO_VENDOR' },
        _avg: { score: true },
        _count: true,
      }),
    ]);

    // Score distribution
    const distribution = await app.prisma.rating.groupBy({
      by: ['score'],
      where: { vendorId, type: 'CUSTOMER_TO_VENDOR' },
      _count: true,
      orderBy: { score: 'asc' },
    });

    const scoreDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const d of distribution) {
      scoreDistribution[d.score] = d._count;
    }

    return {
      success: true,
      ...paginatedResponse(reviews, total, pagination),
      summary: {
        averageRating: aggregate._avg.score ?? 0,
        totalReviews: aggregate._count,
        distribution: scoreDistribution,
      },
    };
  });
}
