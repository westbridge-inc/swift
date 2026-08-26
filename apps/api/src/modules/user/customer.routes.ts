import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Prisma, VendorType, OrderStatus, NotificationType } from '@prisma/client';
import { calculateDeliveryFee, deliveryFeeFromRates, expressDeliveryFee } from '../../utils/markup';
import { CountryConfigService } from '../country/country-config.service';
import { estimateDrivingDistance, estimateDeliveryMinutes } from '../../utils/distance';
import { getMapsProvider } from '../../providers/maps/maps-provider';
import { LATE_CANCEL_FEE, isFreeCancellation, freeCancellationExpiresAt } from '../order/cancel-policy';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { tenantCacheKey } from '../../utils/tenant-cache';
import { AppError, NotFoundError, ValidationError, ForbiddenError } from '../../utils/errors';
import { zMoneyMinor } from '../../utils/money-schema';
import { BookingService, type BookingConfig } from '../booking/booking.service';
import { computeDaySlots, fmtSlotTime } from '../booking/availability';
import { seedRatingTags, tagsForRole } from '../rating/tag-taxonomy.seed';
import { RATING_MAX_TAGS } from '../rating/rating-math';
import { ratingSurfaces, NEW_ACTOR_SURFACE } from '../rating/rating-surface';
import { createHash, randomInt } from 'node:crypto';
import { OrderService } from '../order/order.service';
import { PickingService } from '../order/picking.service';
import { dispatchSearchesCounter } from '../../plugins/observability';
import { resolveSelectedOptions, optionsUnitPrice } from '../order/options';
import { RatingService } from '../rating/rating.service';
import { NotificationService } from '../notification/notification.service';
import { SupportService } from '../support/support.service';
import { AccountService } from './account.service';
import { transitionUserRoleAuthority } from '../mover-authority';
import { safeMmgPayUrl, validateMmgPayUrl } from '../../utils/mmg-pay-url';
import { resolveAvatarUrl, resolveAvatarUrls } from '../../utils/avatar-url';
import {
  currentConsentDetailed, recordConsent, publishLegalDocumentOnce, type ConsentAction,
} from '../legal/consent.service';
import { LEGAL_VERSION, MARKETING_CONSENT } from '../legal/legal.routes';
import { liveLocationVisible, riderCounterpartySelect } from '../../utils/counterparty';

/** [F-021-21] Consent surface from the client's own attestation header,
 *  constrained to the known set — never a hardcoded guess. */
function consentSurface(request: { headers: Record<string, unknown> }): 'ios' | 'android' | 'mobile' | 'web' {
  const h = String(request.headers['x-client-platform'] ?? '').toLowerCase();
  return h === 'ios' || h === 'android' || h === 'web' ? h : 'mobile';
}

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

// avatar is deliberately NOT settable here — the public photo only ever comes
// from the camera-captured signup selfie (POST /auth/selfie, master plan §3).
const updateProfileSchema = z.object({
  firstName: z.string().trim().min(1).max(50).optional(),
  lastName: z.string().trim().min(1).max(50).optional(),
  email: z.string().email().optional(),
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
  minRating: z.coerce.number().min(0).max(5).optional(),
  // Category discovery (#17 6.3): the feed = THIS endpoint + category={slug}.
  category: z.string().max(80).optional(),
});

const itemSlotsQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
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
  amount: zMoneyMinor,
});

// [REPORT-013 F-013-02] The tip ceiling binds at EVERY tip entrance: the
// cart endpoint enforced 50,000 while direct checkout accepted the generic
// 99,999,999 storage ceiling — the same value the cart rejected.
const MAX_TIP_GYD = 50_000;

const checkoutSchema = z.object({
  paymentMethod: z.string().max(30).optional(),
  deliveryInstructions: z.string().max(500).optional(),
  tipAmount: zMoneyMinor.max(MAX_TIP_GYD).optional(),
  scheduledFor: z.string().max(40).optional(),
  promoCode: z.string().max(40).optional(),
  // Per-vendor DELIVERY|PICKUP choice for multi-vendor carts
  fulfillmentSelections: z.record(z.enum(['DELIVERY', 'PICKUP'])).optional(),
  // Priority delivery: 1.5x delivery fee, dispatched ahead of standard orders
  express: z.boolean().optional(),
  // Requested slots for APPOINTMENT listings (booked at vendor acceptance).
  // mode: where the service happens when the business offers BOTH — at their
  // place (AT_BUSINESS) or the customer's (MOBILE).
  appointments: z
    .array(
      z.object({
        itemId: z.string().min(1),
        slotStart: z.coerce.date(),
        mode: z.enum(['AT_BUSINESS', 'MOBILE']).optional(),
      }),
    )
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
  riderTags: z.array(z.string().max(40)).max(20).optional(),
  driverScore: z.number().int().min(1).max(5).optional(),
  driverComment: z.string().max(1000).optional(),
  driverTags: z.array(z.string().max(40)).max(20).optional(),
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

const deviceTokenSchema = z.object({
  token: z.string().min(8).max(512),
  platform: z.enum(['ios', 'android']),
});

const switchRoleSchema = z.object({
  role: z.enum(['CUSTOMER', 'VENDOR', 'RIDER', 'DRIVER', 'MOVER']),
});

const promoValidateSchema = z.object({
  code: z.string().trim().min(1).max(40),
});

const referralRedeemSchema = z.object({
  code: z.string().trim().min(3).max(64),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_DELIVERY_RADIUS_KM = 25;
// Cancel window/fee now import from the ONE policy module [UG-CRAFT-01] —
// the "must match order.service" comment era is over: the preview and the
// charge read the same constants by construction.
const HOME_CACHE_TTL = 60; // 1 min

/**
 * Drop every cached Home feed belonging to one customer.
 *
 * The feed is written at `t:<tenant>:home:<userId>:<lat>:<lng>` — the
 * coordinates are part of the key, so the exact key cannot be rebuilt from
 * a userId alone and a pattern is unavoidable. The pattern must therefore be
 * built by the SAME helper that builds the key: the three call sites used to
 * pass a hand-written `home:${userId}:*`, which stopped matching anything the
 * day [SWIFT-SEC-CACHE] added the tenant prefix to the writer and not to
 * them. Nothing was ever invalidated — a favourited store, and the Home feed
 * behind a just-placed order, stayed stale for the full TTL.
 *
 * SCAN rather than KEYS: now that the pattern matches, this runs for real on
 * every favourite toggle and every checkout, and KEYS blocks the whole Redis
 * instance for the length of the scan.
 */
async function invalidateHomeCache(app: FastifyInstance, userId: string): Promise<void> {
  const pattern = tenantCacheKey(`home:${userId}:*`);
  const doomed: string[] = [];
  let cursor = '0';
  do {
    const [next, batch] = await app.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    doomed.push(...batch);
  } while (cursor !== '0');
  if (doomed.length > 0) await app.redis.del(...doomed);
}

const MAX_ADDRESSES = 10;
// SWIFT-163: the Home discovery scan is bounded so an ever-growing catalogue
// can't load every ACTIVE vendor into memory per request. The feed only ever
// surfaces a few dozen (featured/nearby/open slices), so a generous cap is
// lossless at launch scale; the large-scale path is a geo-bounded (PostGIS)
// fetch of the nearest N, tracked separately.
const HOME_DISCOVERY_SCAN_CAP = 500;

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
              isAvailable: true, vendorId: true, fulfillment: true,
              optionGroups: {
                select: { name: true, options: { select: { id: true, name: true, additionalPrice: true } } },
              },
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

  // PU-05: payment capability belongs to the WHOLE cart, not cart.vendor
  // (which only tracks the most recently added vendor). MMG stays launch-safe
  // and coherent: exactly one unique vendor, with one currently valid direct-
  // pay destination. The raw destination is intentionally absent here.
  const paymentVendorIds = [...new Set(cart.items.map((item) => item.item.vendorId))].sort();
  const paymentVendors = await app.prisma.vendor.findMany({
    where: { id: { in: paymentVendorIds } },
    select: { id: true, mmgPayUrl: true },
    orderBy: { id: 'asc' },
  });
  const singlePaymentVendor = paymentVendorIds.length === 1 && paymentVendors.length === 1
    ? paymentVendors[0]!
    : null;
  const mmgValidation = singlePaymentVendor
    ? validateMmgPayUrl(singlePaymentVendor.mmgPayUrl)
    : null;
  const mmgAvailable = mmgValidation?.valid === true;
  const mmgUnavailableReason = paymentVendorIds.length !== 1
    ? 'MULTI_VENDOR_UNSUPPORTED' as const
    : !singlePaymentVendor?.mmgPayUrl
      ? 'VENDOR_NOT_CONFIGURED' as const
      : mmgAvailable
        ? null
        : 'VENDOR_LINK_INVALID' as const;
  // Opaque, non-secret scope: a method selection is valid only for this exact
  // vendor set + destination state. A previous cart's MMG choice cannot revive
  // when another MMG-capable vendor appears.
  const paymentScope = createHash('sha256')
    .update(JSON.stringify({
      cartId: cart.id,
      vendors: paymentVendors.map((vendor) => {
        const checked = validateMmgPayUrl(vendor.mmgPayUrl);
        return [vendor.id, checked.valid ? checked.url : checked.reason];
      }),
      expectedVendorIds: paymentVendorIds,
    }))
    .digest('hex')
    .slice(0, 24);

  // Fetch related address and promo code separately (no direct relations on
  // Cart). Same resolution as checkout: the cart's chosen address, else the
  // customer's default — so the quote prices the same journey checkout will.
  let deliveryAddr = cart.deliveryAddressId
    ? await app.prisma.address.findUnique({ where: { id: cart.deliveryAddressId } })
    : null;
  if (!deliveryAddr) {
    deliveryAddr = await app.prisma.address.findFirst({
      where: { userId: cart.customerId, isDefault: true },
    });
  }
  const promoCodeRecord = cart.promoCodeId
    ? await app.prisma.promoCode.findUnique({ where: { id: cart.promoCodeId } })
    : null;
  // The fee is about where the order is GOING: the chosen delivery address
  // wins over device coords (those are only a fallback before an address is
  // set). Same routing source as checkout, so the quote equals the final fee.
  const addrLat = deliveryAddr?.latitude ?? lat;
  const addrLng = deliveryAddr?.longitude ?? lng;

  let distanceKm = 3; // sensible default
  if (addrLat && addrLng && cart.vendor) {
    distanceKm = (await getMapsProvider().routeKm(
      { lat: cart.vendor.latitude, lng: cart.vendor.longitude },
      { lat: addrLat, lng: addrLng },
    )).km;
  }

  // Line items — zero markup: customers pay the vendor base price; platform
  // revenue is weekly subscriptions only. Field names are kept for client
  // compatibility, but markup is always 0 and customerPrice === basePrice.
  let subtotalBase = 0;
  const subtotalMarkup = 0;
  const unavailableItemIds: string[] = [];

  const itemDetails = cart.items.map((ci) => {
    const base = Number(ci.item.basePrice);
    const options = resolveSelectedOptions(ci.item, ci.selectedOptions);
    const unitPrice = base + optionsUnitPrice(options);
    const lineBase = unitPrice * ci.quantity;
    subtotalBase += lineBase;

    if (!ci.item.isAvailable) unavailableItemIds.push(ci.id);

    return {
      id: ci.id,
      itemId: ci.itemId,
      name: ci.item.name,
      imageUrl: ci.item.imageUrl,
      basePrice: base,
      customerPrice: unitPrice,
      quantity: ci.quantity,
      selectedOptions: ci.selectedOptions,
      selectedOptionNames: options.map((o) => o.optionName),
      specialInstructions: ci.specialInstructions,
      lineTotal: lineBase,
      isAvailable: ci.item.isAvailable,
      fulfillment: ci.item.fulfillment,
    };
  });

  const subtotalCustomer = subtotalBase;

  // Delivery fee — services are appointments (you go to them / they come to you),
  // not deliveries, so they never carry a delivery fee.
  // FUL-003b: resolve the same country delivery-fee schedule checkout uses, so
  // the fee previewed here equals the fee charged (null config → code default).
  const isService = cart.vendor?.vendorType === 'SERVICE';
  const buyer = await app.prisma.user.findUnique({ where: { id: userId }, select: { countryCode: true } });
  const deliveryRates = await new CountryConfigService(app.prisma).getDeliveryRates(buyer?.countryCode ?? '');
  const deliveryFee = isService ? 0 : deliveryFeeFromRates(distanceKm, deliveryRates);

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

  // SWIFT-070: the express premium is computed on the SERVER (same helper as
  // checkout) and handed to the client to RENDER — never re-derived on the
  // client, so the displayed total can't drift from the charged total. Zero for
  // services / free delivery.
  const expressSurcharge = deliveryFee > 0 ? expressDeliveryFee(deliveryFee) - deliveryFee : 0;
  const expressTotal = totalAmount + expressSurcharge;

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
    expressSurcharge,
    expressTotal,
    deliveryAddress: deliveryAddr ? {
      id: deliveryAddr.id,
      label: deliveryAddr.label,
      addressLine1: deliveryAddr.addressLine1,
      city: deliveryAddr.city,
    } : null,
    scheduledFor: cart.scheduledFor,
    estimatedPrepMin: prepMin,
    estimatedDeliveryMin: deliveryMin,
    estimatedTotalMin: etaMin,
    meetsMinimum,
    minimumOrderAmount: minOrder,
    lastActivityAt: cart.lastActivityAt,
    paymentCapabilities: {
      scope: paymentScope,
      cash: { available: true as const, fundsFlow: 'DIRECT_AT_HANDOVER' as const },
      mmg: {
        available: mmgAvailable,
        provider: 'MMG' as const,
        fundsFlow: 'DIRECT_TO_VENDOR' as const,
        unavailableReason: mmgUnavailableReason,
      },
    },
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
  const { makeDispatchService } = await import('../dispatch/dispatch.service');
  const dispatchForAvailability = makeDispatchService(app);
  const orderService = new OrderService(
    app.prisma,
    app.io,
    undefined,
    // §2 checkout gate reads the SAME supply dispatch would search — including
    // the cash-float requirement, so the probe and the real dispatch agree.
    (point, floatRequired) => dispatchForAvailability.getAvailability('RIDER', point, floatRequired),
  );
  const picking = new PickingService(app.prisma, app.io);
  const ratingService = new RatingService(app.prisma, app.io);
  const notificationService = new NotificationService(app.prisma, app.io);
  const bookingService = new BookingService(app.prisma, app.io);

  // Auth required by default (safe); browsing is public so guests can look
  // around. Only these GET routes use OPTIONAL auth — everything else (cart,
  // checkout, favourites, orders, profile, …) needs a real account.
  const PUBLIC_BROWSE = new Set([
    '/api/v1/customer/home',
    '/api/v1/customer/vendors',
    '/api/v1/customer/vendors/:id',
    '/api/v1/customer/vendors/:id/reviews',
  ]);
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'GET' && PUBLIC_BROWSE.has(request.routeOptions?.url ?? '')) {
      await app.authenticateOptional(request);
      return;
    }
    await app.authenticate(request, reply);
  });

  // ========================================================================
  // SUPPORT — in-app help / dispute channel (replaces the old mailto).
  // ========================================================================

  const support = new SupportService(app.prisma, notificationService);
  const account = new AccountService(app);
  const createTicketSchema = z.object({
    category: z.enum(['ORDER_ISSUE', 'PAYMENT', 'SAFETY', 'ACCOUNT', 'VENDOR', 'MOVER', 'OTHER']),
    subject: z.string().trim().min(3).max(120),
    message: z.string().trim().min(5).max(2000),
    orderId: z.string().min(1).max(64).optional(),
  });

  app.post('/support', async (request: AuthRequest) => {
    const body = createTicketSchema.parse(request.body);
    const ticket = await support.createTicket(request.user.userId, body);
    return { success: true, data: { id: ticket.id, status: ticket.status, createdAt: ticket.createdAt } };
  });

  app.get('/support', async (request: AuthRequest) => {
    const tickets = await support.listForUser(request.user.userId);
    return { success: true, data: tickets };
  });

  // ========================================================================
  // 0. REFERRAL — real attribution: redeeming a code writes Customer.referredBy
  // ========================================================================

  app.post('/referral/redeem', async (request: AuthRequest) => {
    const { userId } = request.user;
    const { code } = referralRedeemSchema.parse(request.body);

    const customer = await resolveCustomer(app, userId);
    if (customer.referredBy) {
      throw new AppError(409, 'ALREADY_REFERRED', 'You’ve already used a referral code');
    }

    // Trial-integrity A5: one referral per HUMAN — if any account in the
    // caller's identity cluster already redeemed, this human already used
    // theirs. Same honest copy: true at the human level, no signal named.
    const { clusterMemberIds } = await import('../integrity/identity.service');
    const memberIds = await clusterMemberIds(app.prisma, userId);
    if (memberIds.length > 1) {
      const clusterRedeemed = await app.prisma.customer.findFirst({
        where: { userId: { in: memberIds }, referredBy: { not: null } },
        select: { id: true },
      });
      if (clusterRedeemed) {
        throw new AppError(409, 'ALREADY_REFERRED', 'You’ve already used a referral code');
      }
    }

    const referrer = await app.prisma.customer.findFirst({
      where: { referralCode: { equals: code, mode: 'insensitive' } },
      include: { user: { select: { firstName: true } } },
    });
    if (!referrer) {
      throw new AppError(404, 'INVALID_REFERRAL', 'That referral code wasn’t found');
    }
    if (referrer.id === customer.id) {
      throw new AppError(400, 'SELF_REFERRAL', 'You can’t use your own referral code');
    }
    // A5 continued: your own code via your own OTHER account is still your
    // own code — the cluster knows.
    if (referrer.userId && memberIds.includes(referrer.userId)) {
      throw new AppError(400, 'SELF_REFERRAL', 'You can’t use your own referral code');
    }

    await app.prisma.customer.update({
      where: { id: customer.id },
      data: { referredBy: referrer.id },
    });

    return { success: true, data: { referrerName: referrer.user?.firstName ?? null } };
  });

  // ========================================================================
  // 1. PROFILE
  // ========================================================================

  /** Movement R9: "Your rating" — the customer's own aggregate (the drivers
   *  and riders rate them too; respect runs both ways). Aggregate only —
   *  never per-rating rows, never who said what. */
  app.get('/rating', async (request: AuthRequest) => {
    const surface = (await ratingSurfaces(app.prisma, 'CUSTOMER', [request.user.userId])).get(request.user.userId) ?? NEW_ACTOR_SURFACE;
    return { success: true, data: surface };
  });

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
    const referredCount = await app.prisma.customer.count({ where: { referredBy: customer.id } });

    return {
      success: true,
      data: {
        id: user.id,
        phone: user.phone,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        // [F-024-09] bare S3/R2 keys become short-lived signed URLs at read
        // time — a private object's key is unrenderable by any client.
        avatar: await resolveAvatarUrl(user.avatar),
        selfieCapturedAt: user.selfieCapturedAt,
        role: user.activeRole,
        activeRole: user.activeRole,
        lastMoverRole: user.lastMoverRole,
        roles: user.roles,
        customer: {
          id: customer.id,
          totalOrders: customer.totalOrders,
          totalSpent: Number(customer.totalSpent),
          referralCode: customer.referralCode,
          referredBy: customer.referredBy,
          referredCount,
        },
        addresses: user.addresses,
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

    // [REPORT-022 F-022-21] conditional write: a deletion that finished
    // between auth and here cannot be re-personalized.
    const updated = await app.prisma.user.updateMany({
      where: { id: userId, status: { notIn: ['DEACTIVATED', 'BANNED', 'SUSPENDED'] } },
      data: {
        ...(body.firstName !== undefined && { firstName: body.firstName }),
        ...(body.lastName !== undefined && { lastName: body.lastName }),
        ...(body.email !== undefined && { email: body.email }),
      },
    });
    if (updated.count === 0) {
      throw new AppError(409, 'ACCOUNT_INACTIVE', 'This account is not active.');
    }
    const user = await app.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: {
        id: true, phone: true, firstName: true, lastName: true,
        email: true, avatar: true, activeRole: true, lastMoverRole: true, updatedAt: true,
      },
    });

    return { success: true, data: { ...user, avatar: await resolveAvatarUrl(user.avatar) } };
  });

  /** GET /account/export — DPA right of access + portability: the customer's own
   *  data as portable JSON. Documents' contents are never exported. */
  app.get('/account/export', async (request: AuthRequest) => {
    const data = await account.exportData(request.user.userId);
    return { success: true, data };
  });

  /** DELETE /account — DPA right to erasure: crypto-shred + de-identify. The
   *  client must log the user out afterwards; every session is already revoked. */
  app.delete('/account', async (request: AuthRequest) => {
    const result = await account.deleteAccount(request.user.userId);
    // Leave an audit trail (the de-identified row is retained, so its id stays a
    // valid FK). Best-effort — the erasure itself has already committed.
    await app.prisma.auditLog
      .create({
        data: {
          userId: request.user.userId,
          action: 'ACCOUNT_SELF_DELETED',
          entity: 'User',
          entityId: request.user.userId,
          changes: { reason: 'DPA right to erasure (self-serve)' },
        },
      })
      .catch(() => {});
    return { success: true, data: result };
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
    // Browsing is open to guests; personalization (favourites, active order,
    // order-again) only applies when signed in.
    const userId = request.user?.userId;
    const { lat, lng } = latLngQuerySchema.parse(request.query);

    // Try Redis cache
    const cacheKey = tenantCacheKey(`home:${userId ?? 'guest'}:${lat ?? 'x'}:${lng ?? 'x'}`);
    const cached = await app.redis.get(cacheKey).catch(() => null);
    if (cached) {
      return { success: true, data: JSON.parse(cached) };
    }

    if (userId) await resolveCustomer(app, userId);

    // Parallel fetches
    const [
      allVendors,
      favoriteIds,
      activeOrder,
      recentOrders,
      popularItemRows,
    ] = await Promise.all([
      // All active, document-verified vendors with at least one orderable item
      // (unverified stores AND empty stores stay out of discovery — a vendor
      // with nothing available dead-ends when tapped; favorites and direct
      // links still resolve their storefront)
      app.prisma.vendor.findMany({
        // [F-028-07] `tenant: { isActive: true }` is load-bearing: a guest has
        // no tenant context, which the Prisma extension defines as an UNSCOPED
        // query — so without the relational predicate a deactivated operator's
        // whole catalog kept serving here after the platform shut them off.
        where: { status: 'ACTIVE', isVerified: true, tenant: { isActive: true }, items: { some: { isAvailable: true } } },
        include: {
          // imageUrl was NOT selected, so Home had nothing to draw a category
          // chip with and every chip fell back to the same stock photograph —
          // "Popular", "Produce" and "Rice & Grains" were one identical image.
          // The column has been on Category the whole time.
          categories: { select: { id: true, name: true, imageUrl: true }, take: 5 },
        },
        orderBy: { averageRating: 'desc' },
        take: HOME_DISCOVERY_SCAN_CAP, // SWIFT-163: bound the per-request scan
      }),

      // Customer's favorite vendor IDs (guests have none)
      userId
        ? app.prisma.vendor.findMany({
            where: { favoritedBy: { some: { userId } } },
            select: { id: true },
          }).then((vs) => new Set(vs.map((v) => v.id)))
        : Promise.resolve(new Set<string>()),

      // Active order (guests have none)
      userId
        ? app.prisma.order.findFirst({
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
          })
        : Promise.resolve(null),

      // Recently ordered vendors (guests have none)
      userId
        ? app.prisma.order.findMany({
            where: { customerId: userId, status: { in: ['DELIVERED', 'COMPLETED'] } },
            select: { vendorId: true },
            orderBy: { placedAt: 'desc' },
            take: 20,
            distinct: ['vendorId'],
          })
        : Promise.resolve([] as { vendorId: string }[]),

      // Popular dishes — top items by lifetime orders (Home "Popular right now" rail)
      app.prisma.item.findMany({
        // The FULL vendor-visibility predicate from the vendors query above —
        // isVerified and tenant.isActive included. Without them a platform-
        // deactivated or unverified operator's STORE was hidden while their
        // DISH sat above the fold ([F-028-07] applies here identically: a
        // guest request is unscoped, so the relational predicate is the only
        // thing standing between a shut-off operator and the Home rail).
        where: { isAvailable: true, vendor: { status: 'ACTIVE', isVerified: true, tenant: { isActive: true } } },
        orderBy: { totalOrdered: 'desc' },
        take: 10,
        select: {
          id: true,
          name: true,
          imageUrl: true,
          basePrice: true,
          vendorId: true,
          vendor: { select: { id: true, name: true, vendorType: true } },
        },
      }),
    ]);

    // Enrich vendors. R8/RAT-I: the home feed feeds EVERY Home rail
    // (featured/nearby/order-again/open/closed), so the star surface rides
    // here too — the sim certification caught these rails showing "New"
    // while browse showed the real display (the fields were missing HERE).
    const homeSurfaces = await ratingSurfaces(app.prisma, 'VENDOR', allVendors.map((v) => v.id));
    const enriched = allVendors.map((v) => ({
      ...enrichVendor(v, lat, lng),
      isFavorite: favoriteIds.has(v.id),
      ...(homeSurfaces.get(v.id) ?? NEW_ACTOR_SURFACE),
    }));

    // Sort by distance if location provided, otherwise by rating
    if (lat != null && lng != null) {
      enriched.sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
    }

    // Sections. "Orderable" must match the checkout gate exactly
    // (order.service.ts: isCurrentlyOpen && acceptingOrders && status ACTIVE —
    // status is already filtered above), otherwise a vendor that's open-by-hours
    // but not accepting orders surfaces in featured/nearby and dead-ends at
    // checkout with VENDOR_CLOSED.
    const isOrderable = (v: (typeof enriched)[number]) => v.isCurrentlyOpen && v.acceptingOrders;
    const openVendors = enriched.filter(isOrderable);
    const closedVendors = enriched.filter((v) => !isOrderable(v));

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
    const categorySet = new Map<string, { id: string; name: string; imageUrl: string | null }>();
    for (const v of allVendors) {
      for (const c of (v.categories ?? [])) {
        if (!categorySet.has(c.id)) categorySet.set(c.id, c);
      }
    }

    const popularItems = popularItemRows.map((it) => ({
      id: it.id,
      name: it.name,
      imageUrl: it.imageUrl,
      price: Number(it.basePrice),
      vendorId: it.vendorId,
      vendorName: it.vendor?.name ?? '',
      vendorType: it.vendor?.vendorType ?? null,
    }));

    const feed = {
      activeOrder,
      popularItems,
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
    const { type, cuisine, search, lat, lng, open, sort, minRating, category } = vendorsBrowseQuerySchema.parse(request.query);

    // Require ≥1 orderable item so empty stores don't clutter browse / dead-end on tap.
    // [F-028-07] tenant.isActive rides every public browse — see /home.
    const where: Record<string, unknown> = { status: 'ACTIVE', isVerified: true, tenant: { isActive: true }, items: { some: { isAvailable: true } } };
    if (type) where['vendorType'] = type;

    // Category feed (#17): membership = chosen + derived rows. A MERGED slug
    // follows its redirect (edge 4 — old links never die); HIDDEN/unknown
    // categories yield an honest empty feed, never an error.
    let categoryRow: { id: string; kind: string } | null = null;
    if (category) {
      let cat = await app.prisma.discoveryCategory.findUnique({
        where: { tenantId_slug: { tenantId: 'swift-default', slug: category } },
        select: { id: true, kind: true, status: true, mergedIntoId: true },
      });
      if (cat?.status === 'MERGED' && cat.mergedIntoId) {
        cat = await app.prisma.discoveryCategory.findFirst({
          where: { id: cat.mergedIntoId },
          select: { id: true, kind: true, status: true, mergedIntoId: true },
        });
      }
      if (!cat || cat.status !== 'ACTIVE') {
        return { success: true, ...paginatedResponse([], 0, { page, limit, skip }) };
      }
      categoryRow = { id: cat.id, kind: cat.kind };
      const members = await app.prisma.vendorDiscoveryCategory.findMany({
        where: { categoryId: cat.id },
        select: { vendorId: true },
      });
      where['id'] = { in: members.map((m) => m.vendorId) };
    }
    if (cuisine) where['cuisineTypes'] = { has: cuisine };
    if (open === 'true') where['isCurrentlyOpen'] = true;
    if (minRating != null) where['averageRating'] = { gte: minRating };
    if (search) {
      where['OR'] = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { cuisineTypes: { has: search } },
      ];
    }

    const orderBy: Record<string, string>[] = [];
    // Category feeds read open-first, closed under the divider (honest order).
    if (categoryRow) orderBy.push({ isCurrentlyOpen: 'desc' });
    switch (sort) {
      case 'rating': orderBy.push({ averageRating: 'desc' }); break;
      case 'popular': orderBy.push({ totalOrders: 'desc' }); break;
      case 'name': orderBy.push({ name: 'asc' }); break;
      default: orderBy.push({ averageRating: 'desc' }); break;
    }

    let vendors: Awaited<ReturnType<typeof app.prisma.vendor.findMany>>;
    let total: number;
    if (sort === 'top_rated') {
      // R8: Bayesian display lives on ActorRatingStat (relation-less by
      // design), so the global order is computed over an id projection first,
      // then the page is fetched — unrated stores sink, ties break on the raw
      // mean then name so the order is stable.
      const idRows = await app.prisma.vendor.findMany({
        where,
        select: { id: true, isCurrentlyOpen: true, averageRating: true, name: true },
      });
      const surfAll = await ratingSurfaces(app.prisma, 'VENDOR', idRows.map((r) => r.id));
      idRows.sort(
        (a, b) =>
          (categoryRow ? Number(b.isCurrentlyOpen) - Number(a.isCurrentlyOpen) : 0) ||
          (surfAll.get(b.id)!.displayRating ?? -1) - (surfAll.get(a.id)!.displayRating ?? -1) ||
          b.averageRating - a.averageRating ||
          a.name.localeCompare(b.name),
      );
      total = idRows.length;
      const pageIds = idRows.slice(skip, skip + limit).map((r) => r.id);
      const rows = await app.prisma.vendor.findMany({ where: { id: { in: pageIds } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      vendors = pageIds.map((id) => byId.get(id)).filter((v): v is NonNullable<typeof v> => v != null);
    } else {
      [vendors, total] = await Promise.all([
        app.prisma.vendor.findMany({
          where,
          skip,
          take: limit,
          orderBy,
        }),
        app.prisma.vendor.count({ where }),
      ]);
    }

    // R8: every card carries the one star line — display, bucket, badge.
    const surfaces = await ratingSurfaces(app.prisma, 'VENDOR', vendors.map((v) => v.id));

    const userLat = lat;
    const userLng = lng;

    // Favorite lookup (guests have none)
    const browserId = request.user?.userId;
    const favoriteIds = browserId
      ? new Set(
          (await app.prisma.vendor.findMany({
            where: { id: { in: vendors.map((v) => v.id) }, favoritedBy: { some: { userId: browserId } } },
            select: { id: true },
          })).map((v) => v.id),
        )
      : new Set<string>();

    // "14 vegan items" — the metadata line for item-truth categories (#17 6.3).
    // Two-step (the tag table is relation-less by design): tagged itemIds for
    // the category, then live-item counts grouped by vendor.
    const itemCounts = new Map<string, number>();
    if (categoryRow && ['DISH', 'DIETARY', 'AISLE'].includes(categoryRow.kind) && vendors.length) {
      const tagRows = await app.prisma.itemDiscoveryCategory.findMany({
        where: { categoryId: categoryRow.id },
        select: { itemId: true },
      });
      if (tagRows.length) {
        const grouped = await app.prisma.item.groupBy({
          by: ['vendorId'],
          where: {
            id: { in: tagRows.map((t) => t.itemId) },
            vendorId: { in: vendors.map((v) => v.id) },
            isAvailable: true,
          },
          _count: { _all: true },
        });
        for (const g of grouped) itemCounts.set(g.vendorId, g._count._all);
      }
    }

    let enriched = vendors.map((v) => ({
      ...enrichVendor(v, userLat, userLng),
      isFavorite: favoriteIds.has(v.id),
      ...(surfaces.get(v.id) ?? NEW_ACTOR_SURFACE),
      ...(categoryRow ? { itemsInCategory: itemCounts.get(v.id) ?? null } : {}),
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

    // [F-028-07] findFirst with a RELATIONAL tenant predicate, not
    // findUnique(id): a guest who knew an id could retrieve a store whose
    // TENANT the platform had deactivated — address, menu, hours. Vendor-level
    // status is deliberately NOT enforced here (the documented decision above:
    // favourites and direct links still resolve a paused store, and the client
    // renders its closed state); tenant deactivation is the operator-level
    // kill switch and nothing of a dead tenant may serve.
    const vendor = await app.prisma.vendor.findFirst({
      where: { id, tenant: { isActive: true } },
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

    // Live promotions the store is running (§4.2) — shown on the storefront.
    const activePromos = await app.prisma.promoCode.findMany({
      where: {
        vendorId: id,
        isActive: true,
        validFrom: { lte: new Date() },
        validUntil: { gt: new Date() },
      },
      select: {
        code: true, description: true, discountType: true,
        discountValue: true, minOrderAmount: true, validUntil: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    // Check if favorited (guests have none)
    const isFavorite = request.user?.userId
      ? (await app.prisma.customer.count({
          where: { userId: request.user.userId, favoriteVendors: { some: { id } } },
        })) > 0
      : false;

    // Zero markup — customers pay the vendor base price (revenue = subscriptions).
    const categories = vendor.categories.map((cat) => ({
      ...cat,
      items: cat.items.map((item) => ({
        ...item,
        basePrice: Number(item.basePrice),
        customerPrice: Number(item.basePrice),
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

    // R8: storefront header star + bucket (same mapper as every card).
    const ratingSurface = (await ratingSurfaces(app.prisma, 'VENDOR', [id])).get(id) ?? NEW_ACTOR_SURFACE;

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
        ...ratingSurface,
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
        promos: activePromos.map((p) => ({ ...p, discountValue: Number(p.discountValue), minOrderAmount: p.minOrderAmount ? Number(p.minOrderAmount) : null })),
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
          // The store's public reply (§4.1)
          response: r.response,
          respondedAt: r.respondedAt,
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
    await invalidateHomeCache(app, userId).catch(() => {});

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

    await invalidateHomeCache(app, userId).catch(() => {});

    return { success: true, data: { message: 'Removed from favorites' } };
  });

  // ========================================================================
  // APPOINTMENTS — bookable time slots for a SERVICE listing, generated from
  // Item.bookingConfig to match BookingService rules (aligned to duration,
  // inside a day-window, in the future, not already booked).
  // ========================================================================

  app.get('/items/:id/slots', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { date } = itemSlotsQuerySchema.parse(request.query);

    const item = await app.prisma.item.findUnique({
      where: { id },
      select: { id: true, vendorId: true, fulfillment: true, bookingConfig: true, isAvailable: true },
    });
    if (!item) throw new NotFoundError('Listing', id);
    if (item.fulfillment !== 'APPOINTMENT' || !item.bookingConfig) {
      throw new AppError(400, 'NOT_BOOKABLE', 'This listing does not take appointments');
    }

    const config = item.bookingConfig as unknown as BookingConfig;
    const duration = config.durationMinutes;
    const [y, m, d] = date.split('-').map(Number);
    const now = new Date();

    // THE availability computation (scheduling law: no double-source):
    // windows MINUS the vendor's exceptions MINUS non-cancelled bookings,
    // honoring buffers + lead time — the same math reservation validates.
    const dayStart = new Date(Date.UTC(y!, m! - 1, d!));
    const dayEnd = new Date(Date.UTC(y!, m! - 1, d!, 23, 59, 59, 999));
    const [exceptions, takenRows] = item.isAvailable
      ? await Promise.all([
          bookingService.exceptionsFor(item.vendorId, dayStart),
          app.prisma.booking.findMany({
            where: { itemId: id, status: { not: 'CANCELLED' }, slotStart: { gte: dayStart, lte: dayEnd } },
            select: { slotStart: true },
          }),
        ])
      : [[], [] as { slotStart: Date }[]];
    const slots = (item.isAvailable
      ? computeDaySlots({
          itemId: id,
          config,
          year: y!,
          month: m!,
          day: d!,
          exceptions,
          takenStarts: takenRows.map((b) => b.slotStart),
          now,
        })
      : []
    ).map((c) => c.toISOString());
    // Which weekdays have windows at all — drives the day chips in the picker.
    const bookableWeekdays = Array.from(new Set((config.slots ?? []).map((w) => w.dayOfWeek)));
    return {
      success: true,
      data: {
        date,
        durationMinutes: duration,
        slots,
        bookableWeekdays,
        serviceMode: config.serviceMode ?? 'AT_BUSINESS',
        serviceRadiusKm: config.serviceRadiusKm ?? null,
      },
    };
  });

  /** POST /bookings/:id/reschedule — move my appointment (scheduling 2.4).
   *  New slot reserved FIRST (the partial unique judges the race), old freed
   *  in the same transaction; the provider hears about it immediately. */
  app.post('/bookings/:id/reschedule', async (request: AuthRequest) => {
    const { userId } = request.user;
    const { id } = request.params as { id: string };
    const { newSlotStart } = z.object({ newSlotStart: z.coerce.date() }).parse(request.body);

    const result = await bookingService.rescheduleBooking(id, newSlotStart, { customerId: userId });
    if (result.moved) {
      const row = await app.prisma.booking.findUnique({
        where: { id: result.booking.id },
        select: { item: { select: { vendor: { select: { owner: { select: { userId: true } } } } } } },
      });
      const ownerUserId = row?.item.vendor.owner.userId;
      if (ownerUserId) {
        await notificationService.send({
          userId: ownerUserId,
          type: 'ORDER_UPDATE',
          title: 'Appointment moved',
          body: `${result.serviceName}: moved from ${fmtSlotTime(result.previousSlotStart)} to ${fmtSlotTime(result.booking.slotStart)}.`,
          data: { kind: 'booking_rescheduled', bookingId: result.booking.id },
        }).catch(() => undefined);
      }
    }
    return { success: true, data: result.booking };
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

    // Inventory (§4.2): don't let the cart promise more than the shelf holds.
    // Checkout re-checks atomically; this is the early, friendly stop.
    if (item.stockQuantity !== null && quantity > item.stockQuantity) {
      throw new AppError(409, 'INSUFFICIENT_STOCK',
        item.stockQuantity <= 0
          ? `${item.name} is sold out`
          : `Only ${item.stockQuantity} of ${item.name} left`,
        { itemId: item.id, available: item.stockQuantity });
    }

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
      const raw = (selectedOptions as Record<string, unknown>)[group.id];
      const chosen = Array.isArray(raw) ? raw : raw != null ? [raw] : [];
      const validIds = new Set(group.options.map((o) => o.id));
      for (const id of chosen) {
        if (typeof id !== 'string' || !validIds.has(id)) {
          throw new ValidationError(`That option isn't available for "${group.name}"`);
        }
      }
      if (group.isRequired && chosen.length < Math.max(1, group.minSelect)) {
        throw new ValidationError(`Please choose an option for "${group.name}"`);
      }
      if (chosen.length > group.maxSelect) {
        throw new ValidationError(`Choose at most ${group.maxSelect} for "${group.name}"`);
      }
    }

    // Get or create cart. Multi-vendor carts are allowed: checkout
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

  // [DCR-1 NR5-01] PUT /cart/instructions REMOVED: the ingress census proved
  // it purpose-free — stored and echoed, but checkout persists only
  // deliveryInstructions, and no client ever called it. Minimisation at
  // capture: an ingress with no purpose does not get to exist.

  // ========================================================================
  // 7. CHECKOUT
  // ========================================================================

  app.post('/checkout', async (request: AuthRequest) => {
    const { userId } = request.user;
    const body = checkoutSchema.parse(request.body ?? {});

    // Idempotency (security spec §5.5): the cart-clear after success already
    // suppresses SEQUENTIAL retries, but two in-flight requests racing (flaky
    // network + a retry) could both read the full cart and place twice. With
    // an Idempotency-Key header, the first request claims the key atomically;
    // a concurrent duplicate is refused, and a later replay gets the stored
    // result back instead of a second order.
    const idemKey = request.headers['idempotency-key'];
    const redisKey = typeof idemKey === 'string' && idemKey.length >= 8 && idemKey.length <= 128
      ? `checkout:idem:${userId}:${idemKey}`
      : null;
    if (redisKey) {
      const claimed = await app.redis.set(redisKey, 'IN_FLIGHT', 'EX', 86_400, 'NX');
      if (!claimed) {
        const existing = await app.redis.get(redisKey);
        if (existing && existing !== 'IN_FLIGHT') {
          return { success: true, data: JSON.parse(existing), replayed: true };
        }
        throw new AppError(409, 'DUPLICATE_REQUEST', 'This order is already being placed — hold on.');
      }
    }

    // Validate payment method. Orders are cash-only P2P: CASH, or MOBILE_MONEY
    // (the vendor's own MMG "pay me" link — money never touches Swift). CARD /
    // BANK_TRANSFER are NOT valid for orders — Swift is a SaaS, not a money
    // transmitter, and must never carry an in-app order-payment method.
    const validMethods = ['CASH', 'MOBILE_MONEY'];
    const paymentMethod = body.paymentMethod || 'CASH';
    if (!validMethods.includes(paymentMethod)) {
      throw new ValidationError(`Invalid payment method. Valid options: ${validMethods.join(', ')}`);
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

    let result;
    try {
      result = await orderService.checkout({
        userId,
        paymentMethod,
        deliveryInstructions: body.deliveryInstructions,
        tipAmount: body.tipAmount,
        scheduledFor: body.scheduledFor,
        promoCode: body.promoCode,
        fulfillmentSelections: body.fulfillmentSelections,
        express: body.express,
        appointments: body.appointments,
      });
    } catch (err) {
      // A failed attempt must not hold the key hostage — release so the same
      // key can retry once the customer fixes the problem (e.g. MIN_ORDER).
      if (redisKey) await app.redis.del(redisKey).catch(() => {});
      throw err;
    }

    // the vendor order alert escalates while unacknowledged —
    // re-alert after 60s, SMS fallback 60s after that
    if (app.queues) {
      // SWIFT-021: schedule the vendor-no-response auto-cancel so an order the
      // vendor never accepts doesn't hang in PENDING forever. Fire after the
      // hold window (LIFECYCLE_V2 only) PLUS the response SLA; the worker
      // re-checks status + hold, so an accepted or still-held order is a no-op.
      const holdMin = process.env['LIFECYCLE_V2'] === '1' ? Number(process.env['ORDER_HOLD_MINUTES'] ?? 2) : 0;
      const slaMin = Number(process.env['VENDOR_RESPONSE_SLA_MINUTES'] ?? 10);
      for (const order of result.orders) {
        await app.queues.notificationQueue.add('vendor-alert-escalate', { orderId: order.id, level: 0 }, {
          // Alerts spec §A1 ladder: second alert at +30s when loud alerts are
          // on; the shipping default stays 60s.
          delay: process.env['ALERTS_LOUD'] === '1' ? 30_000 : 60_000,
          removeOnComplete: 100,
          removeOnFail: 50,
        });
        await app.queues.orderQueue.add('auto-cancel', { orderId: order.id }, {
          delay: (holdMin + slaMin) * 60_000,
          removeOnComplete: 100,
          removeOnFail: 50,
        });
      }
    }

    // Invalidate caches
    await Promise.all([
      app.redis.del(`cart:${userId}`).catch(() => {}),
      invalidateHomeCache(app, userId).catch(() => {}),
    ]);

    // Store the result for idempotent replay (best-effort — the order exists
    // regardless; a lost write only downgrades a replay to NO_CART).
    if (redisKey) {
      await app.redis.set(redisKey, JSON.stringify(result), 'EX', 86_400).catch(() => {});
    }

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
          vendor: { select: { id: true, name: true, slug: true, logoUrl: true, coverImageUrl: true, vendorType: true } },
          items: { select: { id: true, name: true, quantity: true, totalCustomer: true } },
          // [F-027-07] allow-list, not `include` — see utils/counterparty.
          rider: { select: riderCounterpartySelect({ withPhone: false, withAvatar: true }) },
        },
        orderBy: { placedAt: 'desc' },
        skip,
        take: limit,
      }),
      app.prisma.order.count({ where }),
    ]);

    // [F-026-01] Rider avatars on this list were raw private keys. Resolve
    // every distinct one first (signing is local, and duplicates collapse),
    // then map — one pass, no per-row await.
    const riderAvatars = await resolveAvatarUrls(orders.map((o) => o.rider?.user?.avatar));
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
      fulfillment: o.fulfillment,
      // Takeaway handover gate — the customer PRESENTS this at the counter,
      // so it must survive past the checkout confirmation screen.
      pickupCode: o.pickupCode,
      // Taxi context — a ride's identity is its route + class, not a vendor.
      rideClass: o.rideClass,
      pickupAddress: o.pickupAddress,
      deliveryAddress: o.deliveryAddress,
      taxiFareTotal: o.taxiFareTotal != null ? Number(o.taxiFareTotal) : null,
      rider: o.rider ? { firstName: o.rider.user?.firstName, avatar: o.rider.user?.avatar ? riderAvatars.get(o.rider.user.avatar) ?? null : null } : null,
      placedAt: o.placedAt,
      deliveredAt: o.deliveredAt,
      scheduledFor: o.scheduledFor,
      // LIFECYCLE_V2: while in the future, the free-cancel window is open
      // (the server clock decides; any app countdown is cosmetic).
      holdExpiresAt: o.holdExpiresAt,
    }));

    return { success: true, ...paginatedResponse(enrichedOrders, total, { page, limit, skip }) };
  });

  /** GET /orders/:id/receipt — print-ready HTML receipt (marketplace §12).
   *  Derived from the order row on demand: always exactly what the ledger says. */
  app.get('/orders/:id/receipt', async (request: AuthRequest, reply) => {
    const { id } = request.params as { id: string };
    const order = await app.prisma.order.findFirst({
      where: { id, customerId: request.user.userId },
      include: {
        vendor: { select: { name: true, addressLine1: true, city: true, phone: true } },
        customer: { select: { firstName: true, lastName: true } },
        items: { select: { name: true, quantity: true, totalCustomer: true } },
      },
    });
    if (!order) throw new NotFoundError('Order', id);

    if (!['DELIVERED', 'COMPLETED'].includes(order.status)) {
      throw new AppError(400, 'ORDER_NOT_COMPLETE', 'Receipts are issued once the order completes.');
    }
    const { renderReceiptHtml } = await import('../order/receipt');
    reply.type('text/html; charset=utf-8');
    return renderReceiptHtml(order as never);
  });

  app.get('/orders/:id', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;

    const order = await app.prisma.order.findFirst({
      where: { id, customerId: userId },
      include: {
        vendor: {
          select: {
            id: true, name: true, slug: true, logoUrl: true, coverImageUrl: true,
            vendorType: true, phone: true, latitude: true, longitude: true,
          },
        },
        items: {
          include: {
            selectedOptions: true,
          },
        },
        statusHistory: { orderBy: { createdAt: 'asc' } },
        // [F-027-07 / F-028-11] Was a whole-relation `include`, which pulls
        // every Rider column — KYC document URLs, enforcement state, float —
        // into memory. The response below hand-projects, so nothing leaked,
        // but fetching them at all is one refactor away from leaking them.
        // This IS the legitimate live-tracking consumer, so it opts INTO the
        // live position explicitly; the projection then gates it on the order
        // still being in flight.
        // userId is needed INTERNALLY here (the rider-surface/display-rating
        // lookup below) and is not returned. Added at this call site rather
        // than to the shared allow-list, so surfaces that return the select
        // wholesale do not gain an identifier they have no use for.
        rider: { select: { ...riderCounterpartySelect({ withPhone: true, withLiveLocation: true, withAvatar: true }), userId: true } },
      },
    });

    // Fetch ratings for this order by the user
    const orderRatings = await app.prisma.rating.findMany({
      where: { orderId: id, raterId: userId },
    });

    if (!order) throw new NotFoundError('Order', id);

    // Existing orders use only the immutable destination committed at checkout.
    // A legacy/null/unsafe snapshot fails closed; the mutable vendor profile is
    // never a fallback because it may now point at a different recipient.
    // [REPORT-007-v4 F-02] Lifecycle-bound: a closed order must never hand a
    // client a live pay URL — the money would land on a dead order the store
    // can only refund directly. (An already-opened link can't be revoked; this
    // is defense in depth, not the whole containment.)
    const validatedOrderMmgUrl = order.paymentMethod === 'MOBILE_MONEY'
      && order.paymentStatus === 'PENDING'
      && !['CANCELLED', 'REFUNDED', 'FAILED'].includes(order.status)
      ? safeMmgPayUrl(order.mmgPayUrlSnapshot)
      : null;
    const paymentAction = validatedOrderMmgUrl && order.mmgRecipientNameSnapshot
      ? {
          kind: 'OPEN_EXTERNAL_URL' as const,
          method: 'MOBILE_MONEY' as const,
          provider: 'MMG' as const,
          fundsFlow: 'DIRECT_TO_VENDOR' as const,
          orderId: order.id,
          recipientName: order.mmgRecipientNameSnapshot,
          amount: Number(order.totalAmount),
          url: validatedOrderMmgUrl,
        }
      : null;

    // R8.4: the live-order card shows "{Rider} · {display}★" from the ONE mapper.
    const riderSurface = order.rider?.userId
      ? (await ratingSurfaces(app.prisma, 'RIDER', [order.rider.userId])).get(order.rider.userId)
      : null;

    // Delivery progress info
    const hasBeenRated = orderRatings.length > 0;
    // [REPORT-006 F-006-01] Captured MMG orders can't cancel in-app (the store
    // holds the money and settles refunds directly) — the button must not
    // offer what the locked cancel path will refuse.
    const canCancel = !['DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED', 'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'].includes(order.status)
      && !(order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus === 'CAPTURED');
    const previewNow = new Date();
    // THE one policy predicate, shared with the charge path [cancel-policy.ts]
    // — the fee shown here and the marker recorded there can never drift
    // again. The hold exemption, the assignment guard and the scheduled-slot
    // branch all live inside it; this file no longer restates any of them.
    const freeCancellation = canCancel && isFreeCancellation(order, previewNow);

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
        isExpress: order.isExpress,
        tipAmount: Number(order.tipAmount),
        discount: Number(order.discount),
        totalAmount: Number(order.totalAmount),
        paymentMethod: order.paymentMethod,
        // MMG: PENDING → CAPTURED when the vendor confirms they received it, so
        // the pay/track screen can flip from Awaiting to Paid.
        paymentStatus: order.paymentStatus,
        paymentAction,
        fulfillment: order.fulfillment,
        // Takeaway handover gate — the customer PRESENTS this code at the
        // counter. It was only in the checkout response before, so it
        // vanished the moment they left the confirmation screen.
        pickupCode: order.pickupCode,
        // [B9] The SENDER's copy of the public tracking token. Minted at
        // courier checkout since launch and returned once in the create
        // response — which the app discards on navigation — so "Share
        // tracking" had nothing durable to build a link from. Customer-scoped
        // read (this route already proves ownership); null on non-courier rows.
        courierTrackingToken: order.courierTrackingToken,
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
          avatar: await resolveAvatarUrl(order.rider.user?.avatar), // [F-026-01]
          displayRating: riderSurface?.displayRating ?? null,
          // Trust visibility (master plan §5): the customer sees who and what
          // is coming — vehicle, plate, and its photo.
          vehicleType: order.rider.vehicleType,
          vehicleMake: order.rider.vehicleMake,
          vehicleModel: order.rider.vehicleModel,
          vehicleColor: order.rider.vehicleColor,
          licensePlate: order.rider.licensePlate,
          vehiclePhotoUrl: order.rider.vehiclePhotoUrl,
          // Last-known position seeds the tracking marker instantly; the
          // socket stream (rider:location) takes over from the first event.
          // [F-028-11] ...but only while this delivery is actually in flight.
          // These are the mover's PROFILE coordinates — they keep updating on
          // every later job — so a settled order must not keep showing where
          // that person is now.
          currentLat: liveLocationVisible(order.status) ? order.rider.currentLat : null,
          currentLng: liveLocationVisible(order.status) ? order.rider.currentLng : null,
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
        // What a cancel would cost right now (0 inside the free window) — so
        // the app shows the fee BEFORE the customer confirms.
        cancellationFee: canCancel && !freeCancellation ? LATE_CANCEL_FEE : 0,
        // Held orders: the free window IS the hold; otherwise the legacy clock.
        // Only promised while the cancel is ACTUALLY free right now — a mover
        // assignment or a committed vendor voids the promise, so it must never
        // be minted for those states.
        holdExpiresAt: order.holdExpiresAt,
        // ONE implementation, shared with the predicate [cancel-policy.ts] —
        // built inline this used to promise `placedAt + 5min`, which on a
        // scheduled order is a countdown that expired hours before the window
        // it claims to describe.
        freeCancellationExpiresAt: canCancel
          ? (freeCancellationExpiresAt(order, previewNow)?.toISOString() ?? null)
          : null,
      },
    };
  });

  /**
   * POST /orders/:id/convert-to-pickup — the ONE additive transition
   * (availability spec §4.2), flag-gated: when delivery dispatch struggles
   * and the food may already be cooking, the customer collects it instead.
   * Allowed ONLY while no rider is assigned; the delivery fee AND rider tip
   * come off the total (both were the rider's money, and no rider exists —
   * no Swift money involved). Guarded by CAS: a rider claiming the job
   * mid-request wins, the conversion loses, honestly.
   */
  app.post('/orders/:id/convert-to-pickup', async (request: AuthRequest) => {
    if (process.env['DISPATCH_EXHAUSTION'] !== '1') {
      throw new AppError(404, 'NOT_FOUND', 'Not available');
    }
    const { id } = request.params as { id: string };
    const { userId } = request.user;

    const order = await app.prisma.order.findFirst({
      where: { id, customerId: userId },
      select: {
        id: true, status: true, fulfillment: true, riderId: true, vendorId: true,
        deliveryFee: true, tipAmount: true, totalAmount: true, orderNumber: true,
        paymentMethod: true, paymentStatus: true,
        vendor: { select: { name: true, ownerId: true } },
      },
    });
    if (!order) throw new NotFoundError('Order', id);
    if (order.fulfillment !== 'DELIVERY' || !order.vendorId) {
      throw new AppError(400, 'NOT_A_DELIVERY', 'Only delivery orders can switch to pickup.');
    }
    // [SPS-F-0016 / REPORT-005 F-005-03] NO MMG order converts — any status.
    // CAPTURED: the store confirmed the original total landed; rewriting it
    // records less than money received with no refund rail. PENDING is not
    // proof funds haven't moved on this EXTERNAL direct-pay rail — the
    // customer may have followed the payment link before the store attests.
    // And a preview check alone is a TOCTOU: capture can commit between the
    // read and the conversion CAS. Fail closed until a vendor-confirmed
    // cancellation/refund workflow records the money outcome (founder-gated).
    if (order.paymentMethod === 'MOBILE_MONEY') {
      // [REPORT-007-v4 F-03] Copy must not promise a cancel that the captured
      // gate refuses: unpaid MMG can cancel and re-order; paid MMG settles
      // with the store directly.
      throw new AppError(
        409,
        'MMG_REFUND_UNAVAILABLE',
        order.paymentStatus === 'CAPTURED'
          ? 'A pickup switch isn’t available on MMG orders — this one is already paid, so the store settles any change with you directly.'
          : 'A pickup switch isn’t available on MMG orders yet — if you haven’t paid, cancel and re-order for pickup.',
      );
    }
    if (order.riderId) {
      throw new AppError(409, 'RIDER_ALREADY_ASSIGNED', 'A rider already has this order — it is on its way.');
    }
    if (!['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS', `Cannot switch a ${order.status} order to pickup.`);
    }

    const pickupCode = String(randomInt(100000, 1000000));

    // [REPORT-006 F-006-06] The conversion is an Order-locked transaction, and
    // the money write is an atomic DECREMENT of the fee+tip read from the
    // LOCKED row — never an absolute total computed from a route preview. The
    // old absolute write could overwrite a concurrent picking adjustment
    // (stale-total resurrection) or mutate a cancelled order; both rider-claim
    // seams and this conversion now serialize on the same orders row lock, and
    // the CAS binds lifecycle + rail + fulfillment as the belt.
    const { statusAtConvert } = await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} FOR UPDATE`;
      const locked = await tx.order.findFirst({
        where: { id: order.id, customerId: userId },
        select: { status: true, fulfillment: true, riderId: true, paymentMethod: true, deliveryFee: true, tipAmount: true, totalAmount: true },
      });
      if (!locked) throw new NotFoundError('Order', order.id);
      if (locked.riderId) {
        throw new AppError(409, 'RIDER_ALREADY_ASSIGNED', 'A rider just took this order — it is on its way.');
      }
      if (locked.fulfillment !== 'DELIVERY' || locked.paymentMethod !== 'CASH') {
        throw new AppError(409, 'RIDER_ALREADY_ASSIGNED', 'This order can no longer switch to pickup.');
      }
      if (!['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(locked.status)) {
        throw new AppError(400, 'INVALID_STATUS', `Cannot switch a ${locked.status} order to pickup.`);
      }
      const lockedFee = Number(locked.deliveryFee ?? 0);
      const lockedTip = Number(locked.tipAmount ?? 0);
      // Clamp like the old floor-at-zero: never decrement past the live total.
      const moneyOff = Math.min(lockedFee + lockedTip, Number(locked.totalAmount));
      const converted = await tx.order.updateMany({
        where: {
          id: order.id,
          riderId: null,
          fulfillment: 'DELIVERY',
          paymentMethod: 'CASH',
          status: { in: ['PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] },
        },
        data: {
          fulfillment: 'PICKUP',
          deliveryFee: 0,
          tipAmount: 0,
          totalAmount: { decrement: moneyOff },
          pickupCode,
        },
      });
      if (converted.count === 0) {
        throw new AppError(409, 'RIDER_ALREADY_ASSIGNED', 'A rider just took this order — it is on its way.');
      }
      // Evidence rides the same commit as the money it describes.
      await tx.orderStatusLog.create({
        data: {
          orderId: order.id,
          status: locked.status,
          changedBy: userId,
          note: `Customer switched to pickup (no rider found) — delivery fee $${lockedFee.toLocaleString()} and tip $${lockedTip.toLocaleString()} removed`,
        },
      });
      return { fee: lockedFee, tip: lockedTip, statusAtConvert: locked.status };
    });

    // Search journal (§3): the search is over — the customer solved it.
    await app.prisma.dispatchSearch
      .updateMany({
        where: { subjectId: order.id, status: { in: ['SEARCHING', 'EXHAUSTED'] } },
        data: { status: 'CANCELLED', resolution: 'SWITCHED_PICKUP' },
      })
      .then((r) => {
        if (r.count > 0) dispatchSearchesCounter.inc({ status: 'cancelled' });
      })
      .catch(() => {});

    // Both sides hear it now.
    app.io.to(`order:${order.id}`).emit('order:status_changed', {
      orderId: order.id, status: statusAtConvert, fulfillment: 'PICKUP',
    });
    if (order.vendor) {
      const owner = await app.prisma.vendorOwner.findUnique({ where: { id: order.vendor.ownerId } });
      if (owner) {
        await notificationService.send({
          userId: owner.userId,
          type: 'ORDER_UPDATE',
          title: 'Order switched to pickup',
          body: `#${order.orderNumber}: no rider is coming — the customer collects it with a pickup code.`,
          audience: 'business',
          data: { orderId: order.id, kind: 'converted_to_pickup' },
        });
      }
    }
    await notificationService.send({
      userId,
      type: 'ORDER_UPDATE',
      title: 'Switched to pickup',
      body: `Show ${order.vendor?.name ?? 'the store'} your pickup code when you arrive.`,
      // [NOC-A F48] The pickup code is a handover SECRET — the same class the
      // verifier is never allowed to read (HND-003). A push payload transits
      // Google/Apple and is then persisted in notifications.data for 180 days,
      // so it must carry the order id and generic copy only; the customer's
      // app reads the code over the authenticated order API after tapping.
      data: { orderId: order.id, kind: 'converted_to_pickup' },
    });

    const updated = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      select: { id: true, fulfillment: true, pickupCode: true, totalAmount: true, deliveryFee: true, tipAmount: true },
    });
    return { success: true, data: updated };
  });

  app.post('/orders/:id/cancel', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;
    const { reason } = cancelOrderSchema.parse(request.body ?? {});

    const result = await orderService.cancelOrder(id, userId, reason);

    return { success: true, data: result };
  });

  /** POST /orders/:id/items/:lineId/substitution — the customer's live verdict
   *  on an out-of-stock swap the store proposed (§5.3). Approve = the line
   *  becomes the substitute (totals adjust); reject = the line is refunded. */
  app.post('/orders/:id/items/:lineId/substitution', async (request: AuthRequest) => {
    const { id, lineId } = request.params as { id: string; lineId: string };
    const { approve } = z.object({ approve: z.boolean() }).parse(request.body);
    const line = await picking.decideSubstitution(id, lineId, request.user.userId, approve);
    return { success: true, data: line };
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

    // Movement R (R4): tags are CURATED — validate each set against the tag
    // taxonomy for its role + star band, cap at RATING_MAX_TAGS. (No client
    // sent tags before this shipped, so tightening breaks nothing.)
    const tagChecks: Array<[string, number | undefined, string[] | undefined]> = [
      ['VENDOR', body.vendorScore, body.vendorTags],
      ['RIDER', body.riderScore, body.riderTags],
      ['DRIVER', body.driverScore, body.driverTags],
    ];
    for (const [role, score, tags] of tagChecks) {
      if (!tags?.length) continue;
      if (!score) throw new ValidationError(`${role.toLowerCase()}Tags need a matching score`);
      if (tags.length > RATING_MAX_TAGS) throw new ValidationError(`Pick up to ${RATING_MAX_TAGS} tags`);
      const valid = await tagsForRole(app.prisma, role, score);
      for (const t of tags) {
        if (!valid.has(t)) throw new ValidationError(`Unknown tag for ${role.toLowerCase()}: ${t}`);
      }
    }

    const result = await ratingService.rateOrder(userId, id, body);

    return { success: true, data: result };
  });

  /** GET /rating-tags — the R4 taxonomy, grouped for the rating sheets.
   *  Lazy-seeds on first read (idempotent, tiny) so no boot-time write. */
  app.get('/rating-tags', async () => {
    if ((await app.prisma.ratingTagDef.count()) === 0) {
      await seedRatingTags(app.prisma).catch(() => undefined);
    }
    const rows = await app.prisma.ratingTagDef.findMany({
      where: { tenantId: 'swift-default' },
      orderBy: [{ role: 'asc' }, { sentiment: 'asc' }, { slug: 'asc' }],
      select: { role: true, slug: true, label: true, sentiment: true },
    });
    const grouped: Record<string, { positive: Array<{ slug: string; label: string }>; negative: Array<{ slug: string; label: string }> }> = {};
    for (const r of rows) {
      grouped[r.role] = grouped[r.role] ?? { positive: [], negative: [] };
      grouped[r.role]![r.sentiment === 'POSITIVE' ? 'positive' : 'negative'].push({ slug: r.slug, label: r.label });
    }
    return { success: true, data: grouped };
  });

  /** POST /orders/:id/item-feedback — Uber-style per-item thumbs (R5): feeds
   *  the vendor-insights Pareto; one verdict per (order, item, rater). */
  app.post('/orders/:id/item-feedback', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;
    const { itemId, verdict } = z.object({
      itemId: z.string().min(1),
      verdict: z.enum(['UP', 'DOWN']),
    }).parse(request.body);

    const order = await app.prisma.order.findFirst({
      where: { id, customerId: userId, status: { in: ['DELIVERED', 'COMPLETED'] } },
      select: { id: true, items: { select: { itemId: true } } },
    });
    if (!order) throw new NotFoundError('Order', id);
    if (!order.items.some((i) => i.itemId === itemId)) {
      throw new ValidationError('That item is not on this order');
    }
    const feedback = await app.prisma.itemFeedback.upsert({
      where: { orderId_itemId_raterUserId: { orderId: id, itemId, raterUserId: userId } },
      create: { orderId: id, itemId, raterUserId: userId, verdict },
      update: { verdict },
    });
    return { success: true, data: feedback };
  });

  /** POST /ratings/:id/report — flag a public review for the moderation
   *  queue (R7). One report per (rating, reporter); reasons are curated. */
  app.post('/ratings/:id/report', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;
    const { reason, note } = z.object({
      reason: z.enum(['OFFENSIVE', 'FALSE_CLAIM', 'PRIVATE_INFO', 'SPAM', 'OTHER']),
      note: z.string().trim().max(300).optional(),
    }).parse(request.body);

    const rating = await app.prisma.rating.findFirst({
      where: { id, type: { in: ['CUSTOMER_TO_VENDOR', 'CUSTOMER_TO_PROVIDER'] }, isPublic: true },
      select: { id: true },
    });
    if (!rating) throw new NotFoundError('Review', id);

    const existing = await app.prisma.ratingReport.findFirst({ where: { ratingId: id, reporterId: userId } });
    if (existing) return { success: true, data: existing }; // calm idempotence

    const report = await app.prisma.ratingReport.create({
      data: { ratingId: id, reporterId: userId, reason, note: note ?? null },
    });
    return { success: true, data: report };
  });

  /** POST /orders/:id/tip — post-delivery tipping FAILS CLOSED
   *  [SPS-F-0016c]: no rail collects a tip after the job, so the service
   *  refuses with TIP_COLLECTION_UNAVAILABLE (ownership 404 first). The route
   *  stays mounted for shipped clients; checkout tips are unaffected. */
  app.post('/orders/:id/tip', async (request: AuthRequest) => {
    const { id } = request.params as { id: string };
    const { amount } = z.object({ amount: z.number().positive().max(50_000) }).parse(request.body);
    const result = await orderService.addPostDeliveryTip(id, request.user.userId, amount);
    return { success: true, data: result };
  });

  /** POST /orders/:id/return — request a return on a delivered retail order (§4.5). */
  app.post('/orders/:id/return', async (request: AuthRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const { userId } = request.user;
    const { reason } = z.object({ reason: z.string().trim().min(5).max(1000) }).parse(request.body);

    const order = await app.prisma.order.findFirst({
      where: { id, customerId: userId },
      select: { id: true, status: true, vendor: { select: { vendorType: true } } },
    });
    if (!order) throw new NotFoundError('Order', id);
    if (!['DELIVERED', 'COMPLETED'].includes(order.status)) {
      throw new AppError(400, 'NOT_RETURNABLE', 'Only delivered orders can be returned');
    }
    if (order.vendor?.vendorType !== 'STORE') {
      throw new AppError(400, 'NOT_RETAIL', 'Returns are only available for retail orders');
    }
    const existing = await app.prisma.returnRequest.findFirst({ where: { orderId: id } });
    if (existing) {
      throw new AppError(409, 'RETURN_EXISTS', 'A return has already been requested for this order');
    }
    const created = await app.prisma.returnRequest.create({
      data: { orderId: id, customerId: userId, reason },
    });
    reply.code(201);
    return { success: true, data: created };
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

  /** PUT /notifications/prefs — per-user channel switches. */
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

  /** [DCR-1 NR1-03] GET /consent — this subject's current consent states,
   *  straight from the append-only ledger (latest row per document wins). */
  app.get('/consent', async (request: AuthRequest) => {
    const documentTypes = ['privacy_policy', 'terms_of_service', 'marketing_consent'] as const;
    const consents = await Promise.all(documentTypes.map(async (documentType) => {
      const detail = await currentConsentDetailed(app.prisma, 'customer', request.user.userId, documentType);
      return {
        documentType,
        state: detail?.action ?? null,
        version: detail?.version ?? null,
        // Consent to old words is not consent to the current words.
        current: !!detail && detail.version === LEGAL_VERSION,
      };
    }));
    return { success: true, data: { consents, servedVersion: LEGAL_VERSION } };
  });

  /** [DCR-1 NR1-03] POST /consent/marketing { granted } — grant or withdraw
   *  marketing consent. Withdrawal is a NEW ledger row (append-only) and takes
   *  effect immediately. The decision and the append happen in ONE serialized
   *  transaction (per-subject advisory lock) so a success response is an
   *  authority boundary [REPORT-021 F-021-04]; effectiveness is VERSION-AWARE
   *  — a grant to old words never suppresses re-consent to the current words
   *  [F-021-02]. */
  app.post('/consent/marketing', async (request: AuthRequest) => {
    const { granted } = z.object({ granted: z.boolean() }).parse(request.body);
    const userId = request.user.userId;
    await publishLegalDocumentOnce(app.prisma, {
      documentType: 'marketing_consent', version: LEGAL_VERSION, renderedText: MARKETING_CONSENT,
    });
    const outcome = await app.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtextextended(${`consent:marketing:${userId}`}, 0))`);
      const prior = await currentConsentDetailed(tx, 'customer', userId, 'marketing_consent');
      const effectiveAtCurrent = !!prior
        && (prior.action === 'granted' || prior.action === 're_granted')
        && prior.version === LEGAL_VERSION;
      const effectiveAtAny = !!prior && (prior.action === 'granted' || prior.action === 're_granted');
      if (granted === effectiveAtCurrent && (granted || !effectiveAtAny)) {
        return { marketing: effectiveAtCurrent, changed: false };
      }
      const action: ConsentAction = granted ? (prior ? 're_granted' : 'granted') : 'withdrawn';
      await recordConsent(tx, {
        subjectType: 'customer', subjectId: userId,
        documentType: 'marketing_consent', version: LEGAL_VERSION,
        action, surface: consentSurface(request), ip: request.ip,
        evidence: { control: 'marketing_toggle', path: 'consent/marketing' },
      });
      return { marketing: granted, changed: true };
    });
    return { success: true, data: outcome };
  });

  /** POST /notifications/devices — register this device for push. Upsert on
   *  the token: re-registering reassigns it to the CURRENT user (one phone,
   *  new login) and reactivates it. */
  app.post('/notifications/devices', async (request: AuthRequest) => {
    const { token, platform } = deviceTokenSchema.parse(request.body);
    await app.prisma.deviceToken.upsert({
      where: { token },
      create: { userId: request.user.userId, token, platform, isActive: true },
      update: { userId: request.user.userId, platform, isActive: true },
    });
    return { success: true, data: { message: 'Device registered' } };
  });

  /** DELETE /notifications/devices — deactivate on logout (own tokens only). */
  app.delete('/notifications/devices', async (request: AuthRequest) => {
    const { token } = deviceTokenSchema.pick({ token: true }).parse(request.body);
    await app.prisma.deviceToken.updateMany({
      where: { token, userId: request.user.userId },
      data: { isActive: false },
    });
    return { success: true, data: { message: 'Device deactivated' } };
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
    const user = await app.prisma.user.findUnique({
      where: { id: userId },
      select: { roles: true },
    });
    if (!user) throw new NotFoundError('User');

    const internalRole: import('@prisma/client').UserRole = role === 'VENDOR' ? 'VENDOR_OWNER' : role;

    if (!user.roles.includes(internalRole)) {
      throw new ForbiddenError(`You do not have the ${role} role. Available roles: ${user.roles.join(', ')}`);
    }

    // Verify associated entity exists for non-customer roles.
    // MOVER has no entity until verification creates one — membership
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

    // Generic MOVER -> remembered Rider/Driver resolution intentionally happens
    // inside this transition's User FOR UPDATE lock, never in the preflight read.
    const authority = await transitionUserRoleAuthority(app, userId, internalRole);

    return {
      success: true,
      data: {
        role,
        activeRole: authority.activeRole,
        lastMoverRole: authority.lastMoverRole,
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
      // A vendor's own code (§4.2) only counts that vendor's items.
      const counted = promo.vendorId
        ? cart.items.filter((ci) => ci.item.vendorId === promo.vendorId)
        : cart.items;
      if (promo.vendorId && counted.length === 0) {
        throw new AppError(400, 'PROMO_WRONG_VENDOR', 'This code belongs to a different store — add their items to use it');
      }
      let subtotal = 0;
      for (const ci of counted) {
        const base = Number(ci.item.basePrice);
        subtotal += base * ci.quantity;
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
