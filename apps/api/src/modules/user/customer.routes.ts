import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { VendorType, OrderStatus, TransactionType, NotificationType } from '@prisma/client';
import { calculateMarkup, calculateCustomerPrice, calculateDeliveryFee } from '../../utils/markup';
import { estimateDrivingDistance, estimateDeliveryMinutes } from '../../utils/distance';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { AppError, NotFoundError, ValidationError, ForbiddenError } from '../../utils/errors';
import { OrderService } from '../order/order.service';
import { RatingService } from '../rating/rating.service';
import { WalletService } from '../wallet/wallet.service';
import { NotificationService } from '../notification/notification.service';

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(50).optional(),
  lastName: z.string().trim().min(1).max(50).optional(),
  email: z.string().email().optional(),
  avatar: z.string().max(2048).optional(),
});

const createAddressSchema = z.object({
  label: z.string().trim().min(1).max(50),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: z.string().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  region: z.string().max(100).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  instructions: z.string().max(500).optional(),
  isDefault: z.boolean().optional(),
});

const updateAddressSchema = createAddressSchema.omit({ isDefault: true }).partial();

const latLngQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

const vendorsBrowseQuerySchema = latLngQuerySchema.extend({
  type: z.nativeEnum(VendorType).optional(),
  cuisine: z.string().max(50).optional(),
  search: z.string().max(100).optional(),
  open: z.enum(['true', 'false']).optional(),
  sort: z.string().max(30).optional(),
});

const addCartItemSchema = z.object({
  vendorId: z.string().min(1),
  itemId: z.string().min(1),
  quantity: z.number().int().min(1).max(99).optional(),
  selectedOptions: z.record(z.unknown()).optional(),
  specialInstructions: z.string().max(500).optional(),
});

const updateCartItemSchema = z.object({
  // <= 0 removes the item, so no lower bound here
  quantity: z.number().int().max(99),
  selectedOptions: z.record(z.unknown()).optional(),
  specialInstructions: z.string().max(500).optional(),
});

const cartAddressSchema = z.object({
  addressId: z.string().min(1),
});

const cartTipSchema = z.object({
  amount: z.number().min(0),
});

const cartInstructionsSchema = z.object({
  instructions: z.string().max(500),
});

const checkoutSchema = z.object({
  paymentMethod: z.string().max(30).optional(),
  deliveryInstructions: z.string().max(500).optional(),
  tipAmount: z.number().min(0).optional(),
  scheduledFor: z.string().max(40).optional(),
  promoCode: z.string().max(40).optional(),
  // Per-vendor DELIVERY|PICKUP choice for multi-vendor carts
  fulfillmentSelections: z.record(z.enum(['DELIVERY', 'PICKUP'])).optional(),
  // Requested slots for APPOINTMENT listings (booked at vendor acceptance)
  appointments: z
    .array(z.object({ itemId: z.string().min(1), slotStart: z.coerce.date() }))
    .max(10)
    .optional(),
});

const customerOrdersQuerySchema = z.object({
  status: z.string().max(300).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const orderStatusListSchema = z.array(z.nativeEnum(OrderStatus)).min(1);

const cancelOrderSchema = z.object({
  reason: z.string().max(500).optional(),
});

const rateOrderSchema = z.object({
  vendorScore: z.number().int().min(1).max(5).optional(),
  vendorComment: z.string().max(1000).optional(),
  vendorTags: z.array(z.string().max(40)).max(20).optional(),
  riderScore: z.number().int().min(1).max(5).optional(),
  riderComment: z.string().max(1000).optional(),
  driverScore: z.number().int().min(1).max(5).optional(),
  driverComment: z.string().max(1000).optional(),
});

const walletTopupSchema = z.object({
  amount: z.number().positive(),
  paymentMethod: z.string().max(30),
  externalRef: z.string().max(200).optional(),
});

const walletWithdrawSchema = z.object({
  amount: z.number().positive(),
  method: z.string().max(30),
  destination: z.record(z.unknown()),
});

const walletTransactionsQuerySchema = z.object({
  type: z.nativeEnum(TransactionType).optional(),
});

const notificationsQuerySchema = z.object({
  type: z.nativeEnum(NotificationType).optional(),
  unread: z.enum(['true', 'false']).optional(),
});

const notificationPrefsSchema = z.object({
  push: z.boolean().optional(),
  sms: z.boolean().optional(),
  email: z.boolean().optional(),
});

const switchRoleSchema = z.object({
  role: z.enum(['CUSTOMER', 'VENDOR', 'RIDER', 'DRIVER', 'MOVER']),
});

const promoValidateSchema = z.object({
  code: z.string().trim().min(1).max(40),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MARKUP_PCT = 5;
const MAX_DELIVERY_RADIUS_KM = 25;
const FREE_CANCEL_WINDOW_MIN = 5;
const HOME_CACHE_TTL = 60; // 1 min
const MAX_ADDRESSES = 10;
const MAX_TIP_GYD = 50_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AuthRequest = FastifyRequest & { user: { userId: string; role: string } };

/** Resolve customer record, creating one lazily if absent. */
async function resolveCustomer(app: FastifyInstance, userId: string) {
  let customer = await app.prisma.customer.findUnique({ where: { userId } });
  if (!customer) {
    const code = `REF${userId.slice(-6).toUpperCase()}${Date.now().toString(36).slice(-4).toUpperCase()}`;
    customer = await app.prisma.customer.create({
      data: { userId, referralCode: code },
    });
  }
  return customer;
}

/** Build a typed "cart with computed totals" response from a raw cart. */
async function buildCartResponse(
  app: FastifyInstance,
  userId: string,
  lat?: number,
  lng?: number,
) {
  const cart = await app.prisma.cart.findUnique({
    where: { customerId: userId },
    include: {
      vendor: {
        select: {
          id: true, name: true, slug: true, vendorType: true,
          estimatedPrepTime: true, minOrderAmount: true,
          latitude: true, longitude: true, deliveryRadius: true,
          isCurrentlyOpen: true, acceptingOrders: true, logoUrl: true,
        },
      },
      items: {
        include: {
          item: {
            select: {
              id: true, name: true, basePrice: true, imageUrl: true,
              isAvailable: true, vendorId: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!cart || cart.items.length === 0) {
    return null;
  }

  // Fetch related address and promo code separately (no direct relations on Cart)
  const deliveryAddr = cart.deliveryAddressId
    ? await app.prisma.address.findUnique({ where: { id: cart.deliveryAddressId } })
    : null;
  const promoCodeRecord = cart.promoCodeId
    ? await app.prisma.promoCode.findUnique({ where: { id: cart.promoCodeId } })
    : null;
  const addrLat = lat ?? deliveryAddr?.latitude;
  const addrLng = lng ?? deliveryAddr?.longitude;

  let distanceKm = 3; // sensible default
  if (addrLat && addrLng && cart.vendor) {
    distanceKm = estimateDrivingDistance(
      cart.vendor.latitude, cart.vendor.longitude,
      addrLat, addrLng,
    );
  }

  // Line items with markup
  let subtotalBase = 0;
  let subtotalMarkup = 0;
  const unavailableItemIds: string[] = [];

  const itemDetails = cart.items.map((ci) => {
    const base = Number(ci.item.basePrice);
    const markup = calculateMarkup(base, MARKUP_PCT);
    const customerPrice = base + markup;
    const lineBase = base * ci.quantity;
    const lineMarkup = markup * ci.quantity;
    subtotalBase += lineBase;
    subtotalMarkup += lineMarkup;

    if (!ci.item.isAvailable) unavailableItemIds.push(ci.id);

    return {
      id: ci.id,
      itemId: ci.itemId,
      name: ci.item.name,
      imageUrl: ci.item.imageUrl,
      basePrice: base,
      customerPrice,
      quantity: ci.quantity,
      selectedOptions: ci.selectedOptions,
      specialInstructions: ci.specialInstructions,
      lineTotal: lineBase + lineMarkup,
      isAvailable: ci.item.isAvailable,
    };
  });

  const subtotalCustomer = subtotalBase + subtotalMarkup;

  // Delivery fee
  const deliveryFee = calculateDeliveryFee(distanceKm);

  // Promo discount
  let discount = 0;
  let promoInfo: { code: string; discountType: string; description: string } | null = null;
  if (promoCodeRecord) {
    const promo = promoCodeRecord as {
      code: string; discountType: string; discountValue: unknown;
      maxDiscount: unknown; description?: string;
    };
    switch (promo.discountType) {
      case 'PERCENTAGE':
        discount = Math.ceil(subtotalCustomer * (Number(promo.discountValue) / 100));
        break;
      case 'FIXED_AMOUNT':
        discount = Number(promo.discountValue);
        break;
      case 'FREE_DELIVERY':
        discount = deliveryFee;
        break;
    }
    if (promo.maxDiscount) discount = Math.min(discount, Number(promo.maxDiscount));
    promoInfo = {
      code: promo.code,
      discountType: promo.discountType,
      description: promo.description || `${promo.code} applied`,
    };
  }

  const tip = Number(cart.tipAmount) || 0;
  const totalAmount = Math.max(0, subtotalCustomer + deliveryFee + tip - discount);

  // ETA
  const prepMin = cart.vendor?.estimatedPrepTime || 30;
  const deliveryMin = estimateDeliveryMinutes(distanceKm);
  const etaMin = prepMin + deliveryMin;

  // Min order check
  const minOrder = cart.vendor ? Number(cart.vendor.minOrderAmount) : 0;
  const meetsMinimum = subtotalCustomer >= minOrder;

  return {
    id: cart.id,
    vendor: cart.vendor ? {
      ...cart.vendor,
      distanceKm: Math.round(distanceKm * 10) / 10,
    } : null,
    items: itemDetails,
    itemCount: cart.items.reduce((sum, ci) => sum + ci.quantity, 0),
    unavailableItemIds,
    subtotalBase,
    subtotalMarkup,
    subtotalCustomer,
    deliveryFee,
    deliveryDistanceKm: Math.round(distanceKm * 10) / 10,
    discount,
    promoCode: promoInfo,
    tipAmount: tip,
    totalAmount,
    deliveryAddress: deliveryAddr ? {
      id: deliveryAddr.id,
      label: deliveryAddr.label,
      addressLine1: deliveryAddr.addressLine1,
      city: deliveryAddr.city,
    } : null,
    scheduledFor: cart.scheduledFor,
    specialInstructions: cart.specialInstructions,
    estimatedPrepMin: prepMin,
    estimatedDeliveryMin: deliveryMin,
    estimatedTotalMin: etaMin,
    meetsMinimum,
    minimumOrderAmount: minOrder,
    lastActivityAt: cart.lastActivityAt,
  };
}

/** Enrich a vendor row with distance, ETA, and marked-up featured items. */
function enrichVendor<T extends { latitude: number; longitude: number; estimatedPrepTime?: number | null }>(
  vendor: T,
  lat?: number,
  lng?: number,
): T & { distanceKm: number | null; etaMin: number | null; deliveryFee: number | null } {
  let distanceKm: number | null = null;
  let etaMin: number | null = null;
  if (lat != null && lng != null) {
    distanceKm = estimateDrivingDistance(lat, lng, vendor.latitude, vendor.longitude);
    const deliveryMin = estimateDeliveryMinutes(distanceKm);
    etaMin = (vendor.estimatedPrepTime || 30) + deliveryMin;
    distanceKm = Math.round(distanceKm * 10) / 10;
  }
  const deliveryFee = distanceKm != null ? calculateDeliveryFee(distanceKm) : null;
  return { ...vendor, distanceKm, etaMin, deliveryFee };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function customerRoutes(app: FastifyInstance) {
  // Service singletons
  const orderService = new OrderService(app.prisma, app.io);
  const ratingService = new RatingService(app.prisma);
  const walletService = new WalletService(app.prisma);
  const notificationService = new NotificationService(app.prisma, app.io);

  // All routes require auth
  app.addHook('onRequest', app.authenticate);

  // ========================================================================
  // 1. PROFILE
  // ========================================================================

  app.get('/profile', async (request: AuthRequest) => {
    const { userId } = request.user;
    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      include: {
        customer: true,
        addresses: { where: {}, orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }] },
      },
    });

    if (!user) throw new NotFoundError('User');

    const customer = await resolveCustomer(app, userId);
    const unreadNotifs = await app.prisma.notification.count({ where: { userId, isRead: false } });
    const balance = await walletService.getBalance(userId);

    return {
      success: true,
      data: {
        id: user.id,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        avatar: user.avatar,
        role: user.activeRole,
        roles: user.roles,
        customer: {
          id: customer.id,
          totalOrders: customer.totalOrders,
          totalSpent: Number(customer.totalSpent),
          referralCode: customer.referralCode,
        },
        addresses: user.addresses,
        walletBalance: balance,
        unreadNotifications: unreadNotifs,
        createdAt: user.createdAt,
      },
    };
  });

  app.put('/profile', async (request: AuthRequest, _reply: FastifyReply) => {
    const { userId } = request.user;
    const body = updateProfileSchema.parse(request.body);

    if (body.email) {
      const existing = await app.prisma.user.findFirst({
        where: { email: body.email, id: { not: userId } },
      });
      if (existing) {
        throw new AppError(409, 'EMAIL_TAKEN', 'This email is already in use by another account');
      }
    }

    const user = await app.prisma.user.update({
      where: { id: userId },
      data: {
        ...(body.firstName !== undefined && { firstName: body.firstName }),
        ...(body.lastName !== undefined && { lastName: body.lastName }),
        ...(body.email !== undefined && { email: body.email }),
        ...(body.avatar !== undefined && { avatar: body.avatar }),
      },
      select: {
        id: true, phone: true, firstName: true, lastName: true,
        email: true, avatar: true, activeRole: true, updatedAt: true,
      },
    });

    return { success: true, data: user };
  });

  // ========================================================================
  // 2. ADDRESSES
  // ========================================================================

  app.get('/addresses', async (request: AuthRequest) => {
    const addresses = await app.prisma.address.findMany({
      where: { userId: request.user.userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return { success: true, data: addresses };
  });

  app.post('/addresses', async (request: AuthRequest, reply: FastifyReply) => {
    const { userId } = request.user;
    const body = createAddressSchema.parse(request.body);

    // Enforce address limit
    const count = await app.prisma.address.count({ where: { userId } });
    if (count >= MAX_ADDRESSES) {
      throw new AppError(400, 'MAX_ADDRESSES', `You can have at most ${MAX_ADDRESSES} saved addresses`);
    }

    // If this is the first or explicitly default, clear other defaults
    const shouldBeDefault = body.isDefault || count === 0;
    if (shouldBeDefault) {
      await app.prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
    }

    const address = await app.prisma.address.create({
      data: {
        userId,
        label: body.label,
        addressLine1: body.addressLine1,
        addressLine2: body.addressLine2,
        city: body.city,
        region: body.region || '',
        latitude: body.latitude,
        longitude: body.longitude,
        instructions: body.instructions,
        isDefault: shouldBeDefault,
      },
    });

    reply.code(201);
    return { success: true, data: address };
  });

  app.put('/addresses/:id', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;
    const body = updateAddressSchema.parse(request.body);

    const existing = await app.prisma.address.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('Address', id);

    const address = await app.prisma.address.update({
      where: { id },
      data: {
        ...(body.label !== undefined && { label: body.label }),
        ...(body.addressLine1 !== undefined && { addressLine1: body.addressLine1 }),
        ...(body.addressLine2 !== undefined && { addressLine2: body.addressLine2 }),
        ...(body.city !== undefined && { city: body.city }),
        ...(body.region !== undefined && { region: body.region }),
        ...(body.latitude !== undefined && { latitude: body.latitude }),
        ...(body.longitude !== undefined && { longitude: body.longitude }),
        ...(body.instructions !== undefined && { instructions: body.instructions }),
      },
    });

    return { success: true, data: address };
  });

  app.delete('/addresses/:id', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;

    const existing = await app.prisma.address.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('Address', id);

    // Soft-delete
    await app.prisma.address.delete({ where: { id } });

    // If it was default, promote the newest remaining address
    if (existing.isDefault) {
      const next = await app.prisma.address.findFirst({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      });
      if (next) {
        await app.prisma.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    }

    return { success: true, data: { message: 'Address removed' } };
  });

  app.put('/addresses/:id/default', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;

    const existing = await app.prisma.address.findFirst({ where: { id, userId } });
    if (!existing) throw new NotFoundError('Address', id);

    await app.prisma.address.updateMany({ where: { userId }, data: { isDefault: false } });
    const address = await app.prisma.address.update({ where: { id }, data: { isDefault: true } });

    return { success: true, data: address };
  });

  // ========================================================================
  // 3. HOME FEED
  // ========================================================================

  app.get('/home', async (request: AuthRequest) => {
    const { userId } = request.user;
    const { lat, lng } = latLngQuerySchema.parse(request.query);

    // Try Redis cache
    const cacheKey = `home:${userId}:${lat ?? 'x'}:${lng ?? 'x'}`;
    const cached = await app.redis.get(cacheKey).catch(() => null);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    await resolveCustomer(app, userId);

    // Parallel fetches
    const [
      allVendors,
      favoriteIds,
      activeOrder,
      recentOrders,
    ] = await Promise.all([
      // All active vendors
      app.prisma.vendor.findMany({
        where: { status: 'ACTIVE' },
        include: {
          categories: { select: { id: true, name: true }, take: 5 },
        },
        orderBy: { averageRating: 'desc' },
      }),

      // Customer's favorite vendor IDs
      app.prisma.vendor.findMany({
        where: { favoritedBy: { some: { userId } } },
        select: { id: true },
      }).then((vs) => new Set(vs.map((v) => v.id))),

      // Active order (if any)
      app.prisma.order.findFirst({
        where: {
          customerId: userId,
          status: { notIn: ['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED'] },
        },
        select: {
          id: true, orderNumber: true, status: true,
          vendor: { select: { id: true, name: true, logoUrl: true } },
          estimatedDeliveryTime: true, placedAt: true,
        },
        orderBy: { placedAt: 'desc' },
      }),

      // Recently ordered vendors (for "Order Again")
      app.prisma.order.findMany({
        where: { customerId: userId, status: { in: ['DELIVERED', 'COMPLETED'] } },
        select: { vendorId: true },
        orderBy: { placedAt: 'desc' },
        take: 20,
        distinct: ['vendorId'],
      }),
    ]);

    // Enrich vendors
    const enriched = allVendors.map((v) => ({
      ...enrichVendor(v, lat, lng),
      isFavorite: favoriteIds.has(v.id),
    }));

    // Sort by distance if location provided, otherwise by rating
    if (lat != null && lng != null) {
      enriched.sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
    }

    // Sections
    const openVendors = enriched.filter((v) => v.isCurrentlyOpen);
    const closedVendors = enriched.filter((v) => !v.isCurrentlyOpen);

    // Featured: top-rated open vendors
    const featured = openVendors
      .filter((v) => (v.averageRating as number) >= 4.0 && (v.totalOrders as number) >= 10)
      .slice(0, 8);

    // Nearby: within 5 km, open
    const nearby = lat != null && lng != null
      ? openVendors.filter((v) => v.distanceKm != null && v.distanceKm <= 5).slice(0, 10)
      : [];

    // Order again: vendors from recent orders
    const recentVendorIds = new Set(recentOrders.map((o) => o.vendorId).filter(Boolean));
    const orderAgain = enriched.filter((v) => recentVendorIds.has(v.id)).slice(0, 6);

    // Categories (distinct)
    const categorySet = new Map<string, { id: string; name: string }>();
    for (const v of allVendors) {
      for (const c of (v.categories ?? [])) {
        if (!categorySet.has(c.id)) categorySet.set(c.id, c);
      }
    }

    const feed = {
      activeOrder,
      featured,
      nearby,
      orderAgain,
      categories: Array.from(categorySet.values()),
      openVendors: openVendors.slice(0, 30),
      closedVendors: closedVendors.slice(0, 10),
    };

    // Cache
    await app.redis.setex(cacheKey, HOME_CACHE_TTL, JSON.stringify(feed)).catch(() => {});

    return { success: true, data: feed };
  });

  // ========================================================================
  // 4. VENDORS
  // ========================================================================

  app.get('/vendors', async (request: AuthRequest) => {
    const query = request.query as Record<string, string | undefined>;
    const { page, limit, skip } = parsePagination(query);
    const { type, cuisine, search, lat, lng, open, sort } = vendorsBrowseQuerySchema.parse(request.query);

    const where: Record<string, unknown> = { status: 'ACTIVE' };
    if (type) where['vendorType'] = type;
    if (cuisine) where['cuisineTypes'] = { has: cuisine };
    if (open === 'true') where['isCurrentlyOpen'] = true;
    if (search) {
      where['OR'] = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { cuisineTypes: { has: search } },
      ];
    }

    const orderBy: Record<string, string>[] = [];
    switch (sort) {
      case 'rating': orderBy.push({ averageRating: 'desc' }); break;
      case 'popular': orderBy.push({ totalOrders: 'desc' }); break;
      case 'name': orderBy.push({ name: 'asc' }); break;
      default: orderBy.push({ averageRating: 'desc' }); break;
    }

    const [vendors, total] = await Promise.all([
      app.prisma.vendor.findMany({
        where,
        skip,
        take: limit,
        orderBy,
      }),
      app.prisma.vendor.count({ where }),
    ]);

    const userLat = lat;
    const userLng = lng;

    // Favorite lookup
    const favoriteIds = new Set(
      (await app.prisma.vendor.findMany({
        where: { id: { in: vendors.map((v) => v.id) }, favoritedBy: { some: { userId: request.user.userId } } },
        select: { id: true },
      })).map((v) => v.id),
    );

    let enriched = vendors.map((v) => ({
      ...enrichVendor(v, userLat, userLng),
      isFavorite: favoriteIds.has(v.id),
    }));

    // Re-sort by distance if location provided and no explicit sort
    if (userLat != null && userLng != null && sort === 'distance') {
      enriched.sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
    }

    return {
      success: true,
      ...paginatedResponse(enriched, total, { page, limit, skip }),
    };
  });

  app.get('/vendors/:id', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { lat, lng } = latLngQuerySchema.parse(request.query);

    const vendor = await app.prisma.vendor.findUnique({
      where: { id },
      include: {
        categories: {
          orderBy: { sortOrder: 'asc' },
          include: {
            items: {
              where: { isAvailable: true },
              orderBy: [{ sortOrder: 'asc' }, { totalOrdered: 'desc' }],
              include: { optionGroups: { include: { options: true } } },
            },
          },
        },
        operatingHours: true,
        images: true,
      },
    });

    if (!vendor) throw new NotFoundError('Vendor', id);

    // Check if favorited
    const isFavorite = await app.prisma.customer.count({
      where: { userId: request.user.userId, favoriteVendors: { some: { id } } },
    }) > 0;

    // Mark up item prices for customer display
    const categories = vendor.categories.map((cat) => ({
      ...cat,
      items: cat.items.map((item) => ({
        ...item,
        basePrice: Number(item.basePrice),
        customerPrice: calculateCustomerPrice(Number(item.basePrice), MARKUP_PCT),
      })),
    }));

    // Distance & ETA
    let distanceKm: number | null = null;
    let deliveryFee: number | null = null;
    let etaMin: number | null = null;
    if (lat != null && lng != null) {
      distanceKm = estimateDrivingDistance(lat, lng, vendor.latitude, vendor.longitude);
      deliveryFee = calculateDeliveryFee(distanceKm);
      etaMin = (vendor.estimatedPrepTime || 30) + estimateDeliveryMinutes(distanceKm);
      distanceKm = Math.round(distanceKm * 10) / 10;
    }

    return {
      success: true,
      data: {
        id: vendor.id,
        name: vendor.name,
        slug: vendor.slug,
        description: vendor.description,
        vendorType: vendor.vendorType,
        cuisineTypes: vendor.cuisineTypes,
        logoUrl: vendor.logoUrl,
        coverImageUrl: vendor.coverImageUrl,
        images: vendor.images,
        addressLine1: vendor.addressLine1,
        city: vendor.city,
        latitude: vendor.latitude,
        longitude: vendor.longitude,
        isCurrentlyOpen: vendor.isCurrentlyOpen,
        acceptingOrders: vendor.acceptingOrders,
        averageRating: vendor.averageRating,
        totalRatings: vendor.totalRatings,
        totalOrders: vendor.totalOrders,
        estimatedPrepTime: vendor.estimatedPrepTime,
        minOrderAmount: Number(vendor.minOrderAmount),
        deliveryRadius: vendor.deliveryRadius,
        operatingHours: vendor.operatingHours,
        categories,
        isFavorite,
        distanceKm,
        deliveryFee,
        etaMin,
      },
    };
  });

  app.get('/vendors/:id/reviews', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const { page, limit, skip } = parsePagination(query);

    const vendor = await app.prisma.vendor.findUnique({
      where: { id },
      select: { id: true, averageRating: true, totalRatings: true },
    });
    if (!vendor) throw new NotFoundError('Vendor', id);

    const result = await ratingService.getVendorReviews(id, limit, skip);

    return {
      success: true,
      data: {
        vendor: { id: vendor.id, averageRating: vendor.averageRating, totalRatings: vendor.totalRatings },
        reviews: result.reviews.map((r) => ({
          id: r.id,
          score: r.score,
          comment: r.comment,
          tags: r.tags,
          reviewer: r.rater,
          createdAt: r.createdAt,
        })),
        distribution: result.distribution,
        ...paginatedResponse([], result.total, { page, limit, skip }).meta,
      },
    };
  });

  // ========================================================================
  // 5. FAVORITES
  // ========================================================================

  app.get('/favorites', async (request: AuthRequest) => {
    const { userId } = request.user;
    const { lat, lng } = latLngQuerySchema.parse(request.query);

    const customer = await app.prisma.customer.findUnique({
      where: { userId },
      include: {
        favoriteVendors: {
          where: { status: 'ACTIVE' },
          orderBy: { name: 'asc' },
        },
      },
    });

    const vendors = (customer?.favoriteVendors ?? []).map((v) => ({
      ...enrichVendor(v, lat, lng),
      isFavorite: true,
    }));

    return { success: true, data: vendors };
  });

  app.post('/favorites/:vendorId', async (request: AuthRequest, reply: FastifyReply) => {
    const { vendorId } = request.params as { vendorId: string };
    const { userId } = request.user;

    const vendor = await app.prisma.vendor.findUnique({ where: { id: vendorId }, select: { id: true, name: true } });
    if (!vendor) throw new NotFoundError('Vendor', vendorId);

    await resolveCustomer(app, userId);
    await app.prisma.customer.update({
      where: { userId },
      data: { favoriteVendors: { connect: { id: vendorId } } },
    });

    // Invalidate home cache
    const keys = await app.redis.keys(`home:${userId}:*`).catch(() => [] as string[]);
    if (keys.length > 0) await app.redis.del(...keys).catch(() => {});

    reply.code(201);
    return { success: true, data: { message: `${vendor.name} added to favorites` } };
  });

  app.delete('/favorites/:vendorId', async (request: AuthRequest) => {
    const { vendorId } = request.params as { vendorId: string };
    const { userId } = request.user;

    await app.prisma.customer.update({
      where: { userId },
      data: { favoriteVendors: { disconnect: { id: vendorId } } },
    });

    const keys = await app.redis.keys(`home:${userId}:*`).catch(() => [] as string[]);
    if (keys.length > 0) await app.redis.del(...keys).catch(() => {});

    return { success: true, data: { message: 'Removed from favorites' } };
  });

  // ========================================================================
  // 6. CART
  // ========================================================================

  app.get('/cart', async (request: AuthRequest) => {
    const { lat, lng } = latLngQuerySchema.parse(request.query);

    const cart = await buildCartResponse(app, request.user.userId, lat, lng);
    return { success: true, data: cart };
  });

  app.post('/cart/items', async (request: AuthRequest, reply: FastifyReply) => {
    const { userId } = request.user;
    const body = addCartItemSchema.parse(request.body);

    const quantity = Math.max(1, Math.min(99, body.quantity ?? 1));

    // Validate item
    const item = await app.prisma.item.findFirst({
      where: { id: body.itemId, vendorId: body.vendorId, isAvailable: true },
      include: { optionGroups: { include: { options: true } } },
    });
    if (!item) throw new AppError(404, 'ITEM_NOT_FOUND', 'Item not found or unavailable');

    // Validate vendor is active
    const vendor = await app.prisma.vendor.findUnique({
      where: { id: body.vendorId },
      select: { id: true, status: true, name: true },
    });
    if (!vendor || vendor.status !== 'ACTIVE') {
      throw new AppError(400, 'VENDOR_UNAVAILABLE', 'This vendor is not currently available');
    }

    // Validate selected options against option groups
    const selectedOptions = body.selectedOptions ?? {};
    for (const group of item.optionGroups) {
      if (group.isRequired && !selectedOptions[group.id]) {
        throw new ValidationError(`Please select an option for "${group.name}"`);
      }
    }

    // Get or create cart. Multi-vendor carts are allowed (Step 7): checkout
    // splits per vendor; cart.vendorId just tracks the most recent vendor.
    let cart = await app.prisma.cart.findUnique({
      where: { customerId: userId },
      include: { items: true },
    });

    if (cart && cart.vendorId !== body.vendorId) {
      cart = await app.prisma.cart.update({
        where: { id: cart.id },
        data: { vendorId: body.vendorId },
        include: { items: true },
      });
    }

    if (!cart) {
      cart = await app.prisma.cart.create({
        data: { customerId: userId, vendorId: body.vendorId },
        include: { items: true },
      });
    }

    // Merge if same item + same options already in cart
    const optionsKey = JSON.stringify(selectedOptions);
    const existing = cart.items.find(
      (ci) => ci.itemId === body.itemId && JSON.stringify(ci.selectedOptions) === optionsKey,
    );

    if (existing) {
      await app.prisma.cartItem.update({
        where: { id: existing.id },
        data: { quantity: existing.quantity + quantity },
      });
    } else {
      await app.prisma.cartItem.create({
        data: {
          cartId: cart.id,
          itemId: body.itemId,
          quantity,
          selectedOptions: selectedOptions as never,
          specialInstructions: body.specialInstructions,
        },
      });
    }

    await app.prisma.cart.update({ where: { id: cart.id }, data: { lastActivityAt: new Date() } });

    // Invalidate cart cache
    await app.redis.del(`cart:${userId}`).catch(() => {});

    const updatedCart = await buildCartResponse(app, userId);

    reply.code(existing ? 200 : 201);
    return {
      success: true,
      data: {
        cart: updatedCart,
        message: existing ? 'Item quantity updated' : 'Item added to cart',
      },
    };
  });

  app.put('/cart/items/:id', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;
    const body = updateCartItemSchema.parse(request.body);

    // Verify ownership
    const cartItem = await app.prisma.cartItem.findUnique({
      where: { id },
      include: { cart: { select: { customerId: true } } },
    });
    if (!cartItem || cartItem.cart.customerId !== userId) {
      throw new NotFoundError('CartItem', id);
    }

    if (body.quantity <= 0) {
      await app.prisma.cartItem.delete({ where: { id } });

      // Auto-clear cart if last item removed
      const remaining = await app.prisma.cartItem.count({ where: { cartId: cartItem.cartId } });
      if (remaining === 0) {
        await app.prisma.cart.delete({ where: { id: cartItem.cartId } });
        await app.redis.del(`cart:${userId}`).catch(() => {});
        return { success: true, data: { cart: null, message: 'Cart cleared (last item removed)' } };
      }
    } else {
      const quantity = Math.min(99, body.quantity);
      await app.prisma.cartItem.update({
        where: { id },
        data: {
          quantity,
          ...(body.selectedOptions !== undefined && { selectedOptions: body.selectedOptions as never }),
          ...(body.specialInstructions !== undefined && { specialInstructions: body.specialInstructions }),
        },
      });
    }

    await app.prisma.cart.update({ where: { id: cartItem.cartId }, data: { lastActivityAt: new Date() } });
    await app.redis.del(`cart:${userId}`).catch(() => {});

    const updatedCart = await buildCartResponse(app, userId);
    return { success: true, data: { cart: updatedCart, message: 'Cart updated' } };
  });

  app.delete('/cart/items/:id', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;

    const cartItem = await app.prisma.cartItem.findUnique({
      where: { id },
      include: { cart: { select: { id: true, customerId: true } } },
    });
    if (!cartItem || cartItem.cart.customerId !== userId) {
      throw new NotFoundError('CartItem', id);
    }

    await app.prisma.cartItem.delete({ where: { id } });

    // Auto-clear if last item
    const remaining = await app.prisma.cartItem.count({ where: { cartId: cartItem.cart.id } });
    if (remaining === 0) {
      await app.prisma.cart.delete({ where: { id: cartItem.cart.id } });
      await app.redis.del(`cart:${userId}`).catch(() => {});
      return { success: true, data: { cart: null, message: 'Cart cleared (last item removed)' } };
    }

    await app.redis.del(`cart:${userId}`).catch(() => {});
    const updatedCart = await buildCartResponse(app, userId);
    return { success: true, data: { cart: updatedCart, message: 'Item removed' } };
  });

  app.delete('/cart', async (request: AuthRequest) => {
    const { userId } = request.user;
    await app.prisma.cart.deleteMany({ where: { customerId: userId } });
    await app.redis.del(`cart:${userId}`).catch(() => {});
    return { success: true, data: { message: 'Cart cleared' } };
  });

  app.put('/cart/address', async (request: AuthRequest) => {
    const { userId } = request.user;
    const { addressId } = cartAddressSchema.parse(request.body);

    // Verify address belongs to user
    const address = await app.prisma.address.findFirst({
      where: { id: addressId, userId },
    });
    if (!address) throw new NotFoundError('Address', addressId);

    const cart = await app.prisma.cart.findUnique({ where: { customerId: userId } });
    if (!cart) throw new AppError(400, 'NO_CART', 'No active cart');

    // Check delivery radius
    const vendor = await app.prisma.vendor.findUnique({
      where: { id: cart.vendorId },
      select: { latitude: true, longitude: true, deliveryRadius: true, name: true },
    });
    if (vendor) {
      const dist = estimateDrivingDistance(
        vendor.latitude, vendor.longitude,
        address.latitude, address.longitude,
      );
      if (dist > (vendor.deliveryRadius || MAX_DELIVERY_RADIUS_KM)) {
        throw new AppError(400, 'OUT_OF_RANGE',
          `${vendor.name} only delivers within ${vendor.deliveryRadius || MAX_DELIVERY_RADIUS_KM} km. This address is ${dist.toFixed(1)} km away.`);
      }
    }

    await app.prisma.cart.update({ where: { id: cart.id }, data: { deliveryAddressId: addressId, lastActivityAt: new Date() } });
    await app.redis.del(`cart:${userId}`).catch(() => {});

    const updatedCart = await buildCartResponse(app, userId);
    return { success: true, data: { cart: updatedCart, message: 'Delivery address set' } };
  });

  app.put('/cart/tip', async (request: AuthRequest) => {
    const { userId } = request.user;
    const { amount } = cartTipSchema.parse(request.body);

    if (amount > MAX_TIP_GYD) throw new ValidationError(`Tip cannot exceed $${MAX_TIP_GYD.toLocaleString()} GYD`);

    const cart = await app.prisma.cart.findUnique({ where: { customerId: userId } });
    if (!cart) throw new AppError(400, 'NO_CART', 'No active cart');

    await app.prisma.cart.update({ where: { id: cart.id }, data: { tipAmount: amount, lastActivityAt: new Date() } });
    await app.redis.del(`cart:${userId}`).catch(() => {});

    const updatedCart = await buildCartResponse(app, userId);
    return { success: true, data: { cart: updatedCart, message: 'Tip updated' } };
  });

  app.put('/cart/instructions', async (request: AuthRequest) => {
    const { userId } = request.user;
    const { instructions } = cartInstructionsSchema.parse(request.body);

    const cart = await app.prisma.cart.findUnique({ where: { customerId: userId } });
    if (!cart) throw new AppError(400, 'NO_CART', 'No active cart');

    await app.prisma.cart.update({
      where: { id: cart.id },
      data: { specialInstructions: instructions || null, lastActivityAt: new Date() },
    });
    await app.redis.del(`cart:${userId}`).catch(() => {});

    return { success: true, data: { message: 'Instructions updated' } };
  });

  // ========================================================================
  // 7. CHECKOUT
  // ========================================================================

  app.post('/checkout', async (request: AuthRequest) => {
    const { userId } = request.user;
    const body = checkoutSchema.parse(request.body ?? {});

    // Validate payment method
    const validMethods = ['CASH', 'MOBILE_MONEY', 'BANK_TRANSFER', 'CARD', 'WALLET'];
    const paymentMethod = body.paymentMethod || 'CASH';
    if (!validMethods.includes(paymentMethod)) {
      throw new ValidationError(`Invalid payment method. Valid options: ${validMethods.join(', ')}`);
    }

    // If paying with wallet, verify sufficient balance
    if (paymentMethod === 'WALLET') {
      const cart = await app.prisma.cart.findUnique({
        where: { customerId: userId },
        include: { items: { include: { item: true } }, vendor: true },
      });
      if (cart && cart.items.length > 0) {
        let estimate = 0;
        for (const ci of cart.items) {
          const base = Number(ci.item.basePrice);
          estimate += (base + calculateMarkup(base, MARKUP_PCT)) * ci.quantity;
        }
        estimate += calculateDeliveryFee(3) + (body.tipAmount || Number(cart.tipAmount) || 0);
        const balance = await walletService.getBalance(userId);
        if (balance < estimate) {
          throw new AppError(400, 'INSUFFICIENT_BALANCE',
            `Insufficient wallet balance. Available: $${balance.toLocaleString()} GYD, estimated total: $${estimate.toLocaleString()} GYD`);
        }
      }
    }

    // Validate scheduled time
    if (body.scheduledFor) {
      const scheduledDate = new Date(body.scheduledFor);
      const now = new Date();
      const minLeadMs = 30 * 60 * 1000; // 30 min minimum
      const maxLeadMs = 7 * 24 * 60 * 60 * 1000; // 7 days max
      if (scheduledDate.getTime() < now.getTime() + minLeadMs) {
        throw new ValidationError('Scheduled orders must be at least 30 minutes in the future');
      }
      if (scheduledDate.getTime() > now.getTime() + maxLeadMs) {
        throw new ValidationError('Scheduled orders can be at most 7 days in the future');
      }
    }

    const result = await orderService.checkout({
      userId,
      paymentMethod,
      deliveryInstructions: body.deliveryInstructions,
      tipAmount: body.tipAmount,
      scheduledFor: body.scheduledFor,
      promoCode: body.promoCode,
      fulfillmentSelections: body.fulfillmentSelections,
      appointments: body.appointments,
    });

    // Step 11: the vendor order alert escalates while unacknowledged —
    // re-alert after 60s, SMS fallback 60s after that
    if (app.queues) {
      for (const order of result.orders) {
        await app.queues.notificationQueue.add('vendor-alert-escalate', { orderId: order.id, level: 0 }, {
          delay: 60_000,
          removeOnComplete: 100,
          removeOnFail: 50,
        });
      }
    }

    // If wallet payment, debit
    if (paymentMethod === 'WALLET') {
      await walletService.debit(
        userId,
        result.order.total,
        'ORDER_PAYMENT',
        `Payment for order ${result.order.orderNumber}`,
        result.order.id,
      );
    }

    // Invalidate caches
    await Promise.all([
      app.redis.del(`cart:${userId}`).catch(() => {}),
      app.redis.keys(`home:${userId}:*`).then((keys) => keys.length > 0 ? app.redis.del(...keys) : null).catch(() => {}),
    ]);

    return { success: true, data: result };
  });

  // ========================================================================
  // 8. ORDERS
  // ========================================================================

  app.get('/orders', async (request: AuthRequest) => {
    const { userId } = request.user;
    const query = request.query as Record<string, string | undefined>;
    const { page, limit, skip } = parsePagination(query);
    const { status, from, to } = customerOrdersQuerySchema.parse(request.query);

    const where: Record<string, unknown> = { customerId: userId };
    if (status) {
      const statuses = orderStatusListSchema.parse(status.split(',').map((s) => s.trim().toUpperCase()));
      where['status'] = statuses.length === 1 ? statuses[0] : { in: statuses };
    }
    if (from || to) {
      const dateFilter: Record<string, Date> = {};
      if (from) dateFilter['gte'] = from;
      if (to) dateFilter['lte'] = to;
      where['placedAt'] = dateFilter;
    }

    const [orders, total] = await Promise.all([
      app.prisma.order.findMany({
        where,
        include: {
          vendor: { select: { id: true, name: true, slug: true, logoUrl: true, vendorType: true } },
          items: { select: { id: true, name: true, quantity: true, totalCustomer: true } },
          rider: { include: { user: { select: { firstName: true, avatar: true } } } },
        },
        orderBy: { placedAt: 'desc' },
        skip,
        take: limit,
      }),
      app.prisma.order.count({ where }),
    ]);

    const enrichedOrders = orders.map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      orderType: o.orderType,
      status: o.status,
      vendor: o.vendor,
      items: o.items.map((i) => ({
        id: i.id,
        name: i.name,
        quantity: i.quantity,
        price: Number(i.totalCustomer),
      })),
      itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
      subtotal: Number(o.subtotalCustomer),
      deliveryFee: Number(o.deliveryFee),
      tipAmount: Number(o.tipAmount),
      discount: Number(o.discount),
      totalAmount: Number(o.totalAmount),
      paymentMethod: o.paymentMethod,
      rider: o.rider ? { firstName: o.rider.user?.firstName, avatar: o.rider.user?.avatar } : null,
      placedAt: o.placedAt,
      deliveredAt: o.deliveredAt,
      scheduledFor: o.scheduledFor,
    }));

    return { success: true, ...paginatedResponse(enrichedOrders, total, { page, limit, skip }) };
  });

  app.get('/orders/:id', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;

    const order = await app.prisma.order.findFirst({
      where: { id, customerId: userId },
      include: {
        vendor: {
          select: {
            id: true, name: true, slug: true, logoUrl: true,
            vendorType: true, phone: true, latitude: true, longitude: true,
          },
        },
        items: {
          include: {
            selectedOptions: true,
          },
        },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        rider: {
          include: {
            user: { select: { firstName: true, lastName: true, phone: true, avatar: true } },
          },
        },
      },
    });

    // Fetch ratings for this order by the user
    const orderRatings = await app.prisma.rating.findMany({
      where: { orderId: id, raterId: userId },
    });

    if (!order) throw new NotFoundError('Order', id);

    // Delivery progress info
    const hasBeenRated = orderRatings.length > 0;
    const canCancel = !['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'].includes(order.status);
    const minutesSincePlaced = (Date.now() - order.placedAt.getTime()) / 60000;
    const freeCancellation = canCancel && minutesSincePlaced <= FREE_CANCEL_WINDOW_MIN && order.status === 'PENDING';

    // Timeline
    const timeline = order.statusHistory.map((sh) => ({
      status: sh.status,
      note: sh.note,
      timestamp: sh.createdAt,
    }));

    return {
      success: true,
      data: {
        id: order.id,
        orderNumber: order.orderNumber,
        orderType: order.orderType,
        status: order.status,
        vendor: order.vendor,
        items: order.items.map((i) => ({
          id: i.id,
          itemId: i.itemId,
          name: i.name,
          quantity: i.quantity,
          basePrice: Number(i.basePrice),
          customerPrice: Number(i.markedUpPrice),
          lineTotal: Number(i.totalCustomer),
          specialInstructions: i.specialInstructions,
        })),
        itemCount: order.items.reduce((sum, i) => sum + i.quantity, 0),
        subtotalBase: Number(order.subtotalBase),
        subtotalCustomer: Number(order.subtotalCustomer),
        deliveryFee: Number(order.deliveryFee),
        tipAmount: Number(order.tipAmount),
        discount: Number(order.discount),
        totalAmount: Number(order.totalAmount),
        paymentMethod: order.paymentMethod,
        deliveryAddress: order.deliveryAddress,
        deliveryLat: order.deliveryLat,
        deliveryLng: order.deliveryLng,
        deliveryInstructions: order.deliveryInstructions,
        pickupAddress: order.pickupAddress,
        pickupLat: order.pickupLat,
        pickupLng: order.pickupLng,
        estimatedPrepTime: order.estimatedPrepTime,
        estimatedDeliveryTime: order.estimatedDeliveryTime,
        rider: order.rider ? {
          firstName: order.rider.user?.firstName,
          lastName: order.rider.user?.lastName,
          phone: order.rider.user?.phone,
          avatar: order.rider.user?.avatar,
        } : null,
        timeline,
        placedAt: order.placedAt,
        acceptedAt: order.acceptedAt,
        preparingAt: order.preparingAt,
        readyAt: order.readyAt,
        pickedUpAt: order.pickedUpAt,
        deliveredAt: order.deliveredAt,
        cancelledAt: order.cancelledAt,
        cancellationReason: order.cancellationReason,
        scheduledFor: order.scheduledFor,
        hasBeenRated,
        canCancel,
        freeCancellationWindow: freeCancellation,
        freeCancellationExpiresAt: canCancel && order.status === 'PENDING'
          ? new Date(order.placedAt.getTime() + FREE_CANCEL_WINDOW_MIN * 60000).toISOString()
          : null,
      },
    };
  });

  app.post('/orders/:id/cancel', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;
    const { reason } = cancelOrderSchema.parse(request.body ?? {});

    const result = await orderService.cancelOrder(id, userId, reason);

    // Refund wallet payment if applicable
    const order = await app.prisma.order.findUnique({
      where: { id },
      select: { paymentMethod: true, totalAmount: true, orderNumber: true },
    });
    if (order && order.paymentMethod === 'WALLET' && result.cancellationFee === 0) {
      await walletService.credit(
        userId,
        Number(order.totalAmount),
        'ORDER_REFUND',
        `Refund for cancelled order ${order.orderNumber}`,
        id,
      );
    }

    return { success: true, data: result };
  });

  app.post('/orders/:id/reorder', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;

    const result = await orderService.reorder(userId, id);

    await app.redis.del(`cart:${userId}`).catch(() => {});
    const cart = await buildCartResponse(app, userId);

    return { success: true, data: { ...result, cart } };
  });

  // ========================================================================
  // 9. RATINGS
  // ========================================================================

  app.post('/orders/:id/rate', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;
    const body = rateOrderSchema.parse(request.body);

    if (!body.vendorScore && !body.riderScore && !body.driverScore) {
      throw new ValidationError('At least one rating score is required (vendorScore, riderScore, or driverScore)');
    }

    // Validate score ranges
    for (const [key, val] of Object.entries(body)) {
      if (key.endsWith('Score') && val != null) {
        if (typeof val !== 'number' || val < 1 || val > 5) {
          throw new ValidationError(`${key} must be between 1 and 5`);
        }
      }
    }

    const result = await ratingService.rateOrder(userId, id, body);

    return { success: true, data: result };
  });

  // ========================================================================
  // 10. WALLET
  // ========================================================================

  app.get('/wallet', async (request: AuthRequest) => {
    const { userId } = request.user;
    const balance = await walletService.getBalance(userId);

    // Recent transactions summary
    const { transactions, total } = await walletService.getTransactions(userId, { limit: 5 });

    return {
      success: true,
      data: {
        balance,
        currency: 'GYD',
        recentTransactions: transactions.map((t) => ({
          id: t.id,
          type: t.type,
          direction: t.direction,
          amount: Number(t.amount),
          description: t.description,
          balanceAfter: Number(t.balanceAfter),
          createdAt: t.createdAt,
        })),
        totalTransactions: total,
      },
    };
  });

  app.post('/wallet/topup', async (request: AuthRequest, reply: FastifyReply) => {
    const { userId } = request.user;
    const body = walletTopupSchema.parse(request.body);

    if (body.amount < 500) {
      throw new ValidationError('Minimum top-up amount is $500 GYD');
    }
    if (body.amount > 500_000) {
      throw new ValidationError('Maximum top-up amount is $500,000 GYD');
    }

    const validMethods = ['MOBILE_MONEY', 'BANK_TRANSFER', 'CARD', 'CASH'];
    if (!validMethods.includes(body.paymentMethod)) {
      throw new ValidationError(`Invalid payment method. Valid options: ${validMethods.join(', ')}`);
    }

    const newBalance = await walletService.topUp(userId, body.amount, body.paymentMethod, body.externalRef);

    reply.code(201);
    return {
      success: true,
      data: {
        balance: newBalance,
        currency: 'GYD',
        message: `$${body.amount.toLocaleString()} GYD added to wallet`,
      },
    };
  });

  app.post('/wallet/withdraw', async (request: AuthRequest) => {
    const { userId } = request.user;
    const body = walletWithdrawSchema.parse(request.body);

    if (body.amount < 1000) {
      throw new ValidationError('Minimum withdrawal amount is $1,000 GYD');
    }
    if (Object.keys(body.destination).length === 0) {
      throw new ValidationError('Destination details are required');
    }

    const result = await walletService.withdraw(userId, body.amount, body.method, body.destination);

    return {
      success: true,
      data: {
        requestId: result.requestId,
        balance: result.newBalance,
        currency: 'GYD',
        message: 'Withdrawal request submitted. Funds will arrive within 1-3 business days.',
      },
    };
  });

  app.get('/wallet/transactions', async (request: AuthRequest) => {
    const { userId } = request.user;
    const query = request.query as Record<string, string | undefined>;
    const { page, limit, skip } = parsePagination(query);
    const { type } = walletTransactionsQuerySchema.parse(request.query);

    const { transactions, total } = await walletService.getTransactions(userId, {
      type,
      limit,
      offset: skip,
    });

    const enriched = transactions.map((t) => ({
      id: t.id,
      type: t.type,
      direction: t.direction,
      amount: Number(t.amount),
      description: t.description,
      reference: t.reference,
      balanceAfter: Number(t.balanceAfter),
      createdAt: t.createdAt,
    }));

    return { success: true, ...paginatedResponse(enriched, total, { page, limit, skip }) };
  });

  // ========================================================================
  // 11. NOTIFICATIONS
  // ========================================================================

  app.get('/notifications', async (request: AuthRequest) => {
    const { userId } = request.user;
    const query = request.query as Record<string, string | undefined>;
    const { page, limit, skip } = parsePagination(query);
    const { type, unread } = notificationsQuerySchema.parse(request.query);

    const where: Record<string, unknown> = { userId };
    if (type) where['type'] = type;
    if (unread === 'true') where['isRead'] = false;

    const [notifications, total] = await Promise.all([
      app.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      app.prisma.notification.count({ where }),
    ]);

    return { success: true, ...paginatedResponse(notifications, total, { page, limit, skip }) };
  });

  /** PUT /notifications/prefs — per-user channel switches (Step 11). */
  app.put('/notifications/prefs', async (request: AuthRequest) => {
    const body = notificationPrefsSchema.parse(request.body);
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: request.user.userId },
      select: { notificationPrefs: true },
    });
    const merged = {
      push: true, sms: true, email: false,
      ...((user.notificationPrefs as Record<string, boolean> | null) ?? {}),
      ...body,
    };
    await app.prisma.user.update({
      where: { id: request.user.userId },
      data: { notificationPrefs: merged },
    });
    return { success: true, data: merged };
  });

  app.put('/notifications/:id/read', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;

    await notificationService.markAsRead(userId, id);

    return { success: true, data: { message: 'Notification marked as read' } };
  });

  app.put('/notifications/read-all', async (request: AuthRequest) => {
    const { userId } = request.user;

    await notificationService.markAllAsRead(userId);

    return { success: true, data: { message: 'All notifications marked as read' } };
  });

  app.get('/notifications/unread-count', async (request: AuthRequest) => {
    const { userId } = request.user;

    const count = await notificationService.getUnreadCount(userId);

    return { success: true, data: { count } };
  });

  // ========================================================================
  // 12. ROLE SWITCHING
  // ========================================================================

  app.post('/switch-role', async (request: AuthRequest) => {
    const { userId } = request.user;
    const { role } = switchRoleSchema.parse(request.body);

    // Public role names map to internal UserRole values: the locked model's
    // VENDOR is stored as VENDOR_OWNER (the old direct check could never pass).
    const internalRole: import('@prisma/client').UserRole = role === 'VENDOR' ? 'VENDOR_OWNER' : role;

    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      select: { roles: true },
    });
    if (!user) throw new NotFoundError('User');

    if (!user.roles.includes(internalRole)) {
      throw new ForbiddenError(`You do not have the ${role} role. Available roles: ${user.roles.join(', ')}`);
    }

    // Verify associated entity exists for non-customer roles.
    // MOVER has no entity until Step 4 verification creates one — membership
    // in roles[] is enough to sit in mover mode (gated from working anyway).
    if (role === 'VENDOR') {
      const owner = await app.prisma.vendorOwner.findUnique({ where: { userId } });
      if (!owner) throw new ForbiddenError('No vendor account associated with your profile');
    }
    if (role === 'RIDER') {
      const rider = await app.prisma.rider.findUnique({ where: { userId } });
      if (!rider) throw new ForbiddenError('No rider account associated with your profile');
    }
    if (role === 'DRIVER') {
      const driver = await app.prisma.driver.findUnique({ where: { userId } });
      if (!driver) throw new ForbiddenError('No driver account associated with your profile');
    }

    await app.prisma.user.update({ where: { id: userId }, data: { activeRole: internalRole } });

    return {
      success: true,
      data: {
        role,
        message: `Switched to ${role.toLowerCase()} mode`,
      },
    };
  });

  // ========================================================================
  // 13. PROMO VALIDATION
  // ========================================================================

  app.post('/promo/validate', async (request: AuthRequest) => {
    const { userId } = request.user;
    const { code } = promoValidateSchema.parse(request.body);

    const promo = await app.prisma.promoCode.findUnique({
      where: { code: code.toUpperCase().trim() },
    });

    if (!promo) throw new AppError(404, 'INVALID_PROMO', 'Promo code not found');
    if (!promo.isActive) throw new AppError(400, 'INVALID_PROMO', 'This promo code is no longer active');

    const now = new Date();
    if (now < promo.validFrom) throw new AppError(400, 'INVALID_PROMO', 'This promo code is not yet valid');
    if (now > promo.validUntil) throw new AppError(400, 'EXPIRED_PROMO', 'This promo code has expired');

    if (promo.maxUses && promo.currentUses >= promo.maxUses) {
      throw new AppError(400, 'EXHAUSTED_PROMO', 'This promo code has reached its usage limit');
    }

    // Check user-specific usage
    const userUsage = await app.prisma.order.count({
      where: { customerId: userId, promoCodeId: promo.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
    });
    if (userUsage >= promo.maxUsesPerUser) {
      throw new AppError(400, 'ALREADY_USED', 'You have already used this promo code the maximum number of times');
    }

    // Compute estimated discount using current cart if available
    let estimatedDiscount: number | null = null;
    const cart = await app.prisma.cart.findUnique({
      where: { customerId: userId },
      include: { items: { include: { item: true } } },
    });

    if (cart && cart.items.length > 0) {
      let subtotal = 0;
      for (const ci of cart.items) {
        const base = Number(ci.item.basePrice);
        subtotal += (base + calculateMarkup(base, MARKUP_PCT)) * ci.quantity;
      }

      if (promo.minOrderAmount && subtotal < Number(promo.minOrderAmount)) {
        throw new AppError(400, 'MIN_ORDER_PROMO',
          `Minimum order of $${Number(promo.minOrderAmount).toLocaleString()} GYD required. Current subtotal: $${subtotal.toLocaleString()} GYD`);
      }

      switch (promo.discountType) {
        case 'PERCENTAGE':
          estimatedDiscount = Math.ceil(subtotal * (Number(promo.discountValue) / 100));
          break;
        case 'FIXED_AMOUNT':
          estimatedDiscount = Number(promo.discountValue);
          break;
        case 'FREE_DELIVERY':
          estimatedDiscount = calculateDeliveryFee(3); // estimate
          break;
      }
      if (promo.maxDiscount && estimatedDiscount != null) {
        estimatedDiscount = Math.min(estimatedDiscount, Number(promo.maxDiscount));
      }

      // Apply promo to cart
      await app.prisma.cart.update({ where: { id: cart.id }, data: { promoCodeId: promo.id } });
      await app.redis.del(`cart:${userId}`).catch(() => {});
    }

    // Build description
    let description = '';
    switch (promo.discountType) {
      case 'PERCENTAGE':
        description = `${Number(promo.discountValue)}% off`;
        if (promo.maxDiscount) description += ` (up to $${Number(promo.maxDiscount).toLocaleString()} GYD)`;
        break;
      case 'FIXED_AMOUNT':
        description = `$${Number(promo.discountValue).toLocaleString()} GYD off`;
        break;
      case 'FREE_DELIVERY':
        description = 'Free delivery';
        break;
    }
    if (promo.minOrderAmount) {
      description += ` on orders over $${Number(promo.minOrderAmount).toLocaleString()} GYD`;
    }

    return {
      success: true,
      data: {
        code: promo.code,
        discountType: promo.discountType,
        discountValue: Number(promo.discountValue),
        maxDiscount: promo.maxDiscount ? Number(promo.maxDiscount) : null,
        minOrderAmount: promo.minOrderAmount ? Number(promo.minOrderAmount) : null,
        description,
        estimatedDiscount,
        validUntil: promo.validUntil,
        applied: cart != null && cart.items.length > 0,
      },
    };
  });
}
