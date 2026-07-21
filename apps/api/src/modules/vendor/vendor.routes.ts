import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OrderStatus, OrderType, SettlementStatus } from '@prisma/client';
import { OrderService, notHeldFilter } from '../order/order.service';
import { PickingService } from '../order/picking.service';
import { makeDispatchService } from '../dispatch/dispatch.service';
import { NotificationService } from '../notification/notification.service';
import { BookingService } from '../booking/booking.service';
import { VerificationService } from '../verification/verification.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import QRCode from 'qrcode';
import { parseCsvWithHeader } from '../../utils/csv';
import { AiService } from '../ai/ai.service';
import { guessColumnMapping, applyMapping, toImportCsv, REQUIRED_FIELDS, type ColumnMapping } from '../../utils/catalogue-map';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors';
import { startOfDayGY } from '../../utils/time-gy';
import { DeliveryCashSettlementService, assertSettlementId } from '../cash/delivery-cash-settlement.service';
import { BillingService } from '../billing/billing.service';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { throwForMissingProfile } from '../../utils/role-gate';
import { ALLOWED_IMAGE_TYPES, looksLikeImage } from '../../utils/images';
import { scheduleVendorSearchSync } from '../search/search-sync';
import { SearchService } from '../search/search.service';

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
  // The vendor's own MMG "pay me" link (opt-in). null/empty clears it → cash-only.
  mmgPayUrl: z.string().trim().max(500).nullable().optional(),
});

const acceptOrderSchema = z.object({
  estimatedPrepTime: z.number().int().min(1).max(480).optional(),
});

const rejectOrderSchema = z.object({
  reason: z.string().max(500).optional(),
});

const completePickupSchema = z.object({
  code: z.string().trim().max(10).optional(),
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

// SERVICE listings carry a bookingConfig: how long an appointment is, the weekly
// availability windows, and WHERE it happens — AT_BUSINESS (customer comes in),
// MOBILE (provider travels to the customer), or BOTH. serviceRadiusKm caps travel.
const bookingConfigSchema = z.object({
  durationMinutes: z.number().int().min(5).max(600),
  slots: z
    .array(
      z.object({
        dayOfWeek: z.number().int().min(0).max(6),
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
      }),
    )
    .max(50),
  serviceMode: z.enum(['AT_BUSINESS', 'MOBILE', 'BOTH']).optional(),
  serviceRadiusKm: z.number().min(0).max(100).optional(),
});

const createItemSchema = z.object({
  categoryId: z.string().min(1),
  name: z.string().trim().min(1).max(150),
  description: z.string().max(2000).optional(),
  imageUrl: z.string().max(2048).optional(),
  basePrice: z.number().min(0).max(10_000_000),
  sku: z.string().max(64).optional(),
  unit: z.string().max(30).optional(),
  stockQuantity: z.number().int().min(0).nullable().optional(),
  lowStockThreshold: z.number().int().min(0).nullable().optional(),
  isAvailable: z.boolean().optional(),
  isPopular: z.boolean().optional(),
  dietaryTags: z.array(z.string().max(40)).max(30).optional(),
  allergens: z.array(z.string().max(40)).max(30).optional(),
  sortOrder: z.number().int().min(0).optional(),
  fulfillment: z.enum(['DELIVERY', 'PICKUP', 'APPOINTMENT']).optional(),
  bookingConfig: bookingConfigSchema.optional(),
  optionGroups: z
    .array(optionGroupInputSchema.extend({ options: z.array(optionInputSchema).max(100) }))
    .max(50)
    .optional(),
});

const updateItemSchema = createItemSchema.omit({ optionGroups: true }).partial();

// Operator promotions (master plan §4.2). Vendor codes never touch delivery
// fees (not vendor revenue) — PERCENTAGE or FIXED_AMOUNT only.
const createPromoSchema = z.object({
  code: z.string().trim().min(3).max(24).regex(/^[A-Za-z0-9-]+$/, 'Letters, numbers and dashes only'),
  description: z.string().trim().min(1).max(200),
  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
  discountValue: z.number().positive().max(10_000_000),
  minOrderAmount: z.number().min(0).max(10_000_000).optional(),
  maxDiscount: z.number().positive().max(10_000_000).optional(),
  validUntil: z.coerce.date(),
  maxUses: z.number().int().positive().max(1_000_000).optional(),
  maxUsesPerUser: z.number().int().positive().max(100).default(1),
}).refine((d) => d.discountType !== 'PERCENTAGE' || d.discountValue <= 100, {
  message: 'A percentage discount cannot exceed 100',
});
const updatePromoSchema = z.object({
  description: z.string().trim().min(1).max(200).optional(),
  isActive: z.boolean().optional(),
  validUntil: z.coerce.date().optional(),
  maxUses: z.number().int().positive().max(1_000_000).nullable().optional(),
});

// Staff & roles (master plan §4.1)
const addStaffSchema = z.object({
  phone: z.string().min(10).max(15),
  role: z.enum(['MANAGER', 'STAFF']).default('STAFF'),
});
const updateStaffSchema = z.object({
  role: z.enum(['MANAGER', 'STAFF']),
});
const respondReviewSchema = z.object({
  response: z.string().trim().min(1).max(1000),
});

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
 * Resolve the owner and return the *first* vendor (most vendors have one).
 * Throws 404 if the vendor doesn't exist.
 */
/**
 * IDOR-safe store selection: honour the requested store only when the owner
 * owns it, otherwise fall back to the default (first) store.
 */
export function pickVendorId(ownedVendorIds: string[], requested?: string): string {
  return requested && ownedVendorIds.includes(requested) ? requested : ownedVendorIds[0]!;
}

/**
 * Order-board scope: an explicitly selected store (x-vendor-id) scopes the
 * board to that store — matching every other vendor surface — while no
 * selection keeps the franchise roll-up across all the caller's stores.
 */
export function ordersScope(
  access: { vendorId: string; vendorIds: string[] },
  requested?: string,
): string | { in: string[] } {
  return requested ? access.vendorId : { in: access.vendorIds };
}

/** OWNER > MANAGER > STAFF — every vendor route resolves one of these. */
export type VendorAccessRole = 'OWNER' | 'MANAGER' | 'STAFF';
const ROLE_RANK: Record<VendorAccessRole, number> = { STAFF: 0, MANAGER: 1, OWNER: 2 };

interface VendorAccess {
  /** VendorOwner.id when the caller owns the store; null for staff. */
  ownerId: string | null;
  vendorId: string;
  vendorIds: string[];
  role: VendorAccessRole;
}

/**
 * Access resolution for every vendor route (staff & roles, master plan §4.1):
 * owners see all their stores; staff see exactly the stores they were added
 * to, with the role the owner gave them. IDOR-safe store selection either way.
 */
async function resolveVendor(app: FastifyInstance, userId: string, requestedVendorId?: string): Promise<VendorAccess> {
  const owner = await app.prisma.vendorOwner.findUnique({
    where: { userId },
    include: { vendors: { select: { id: true }, orderBy: { createdAt: 'asc' } } },
  });
  if (owner && owner.vendors.length > 0) {
    const vendorIds = owner.vendors.map((v) => v.id);
    return { ownerId: owner.id, vendorId: pickVendorId(vendorIds, requestedVendorId), vendorIds, role: 'OWNER' };
  }

  const memberships = await app.prisma.vendorStaff.findMany({
    where: { userId },
    select: { vendorId: true, role: true },
    orderBy: { createdAt: 'asc' },
  });
  // Neither an owner with stores nor staff anywhere: outsiders get 403 (authz
  // answers, not existence); a VENDOR_OWNER with no store yet keeps the 404
  // the onboarding flow expects.
  if (memberships.length === 0) await throwForMissingProfile(app, userId, 'VENDOR_OWNER', 'Vendor');
  const vendorIds = memberships.map((m) => m.vendorId);
  const vendorId = pickVendorId(vendorIds, requestedVendorId);
  const role = memberships.find((m) => m.vendorId === vendorId)!.role as VendorAccessRole;
  return { ownerId: null, vendorId, vendorIds, role };
}

/** Gate an action on the caller's store role. */
function requireRole(access: VendorAccess, min: 'MANAGER' | 'OWNER') {
  if (ROLE_RANK[access.role] < ROLE_RANK[min]) {
    throw new AppError(403, 'STAFF_FORBIDDEN',
      min === 'OWNER'
        ? 'Only the store owner can do this'
        : 'This needs a manager — ask the store owner to upgrade your role');
  }
}

/** The verification gate belongs to the BUSINESS (its owner), not to whoever
 *  is logged in — a verified store stays verified when staff work in it. */
async function vendorOwnerUserId(app: FastifyInstance, vendorId: string): Promise<string> {
  const vendor = await app.prisma.vendor.findUniqueOrThrow({
    where: { id: vendorId },
    select: { owner: { select: { userId: true } } },
  });
  return vendor.owner.userId;
}

/**
 * Listing gate (gated-trials spec §B2). Verified stores list freely. With
 * PREVIEW_MODE on, a store that has NEVER been live (pending approval) may
 * build its menu as DRAFTS — customer surfaces only show ACTIVE stores, so
 * nothing leaks — and goes live the minute verification lands. A store that
 * HAS been live (ACTIVE/SUSPENDED) keeps the hard gate: suspension means
 * suspended.
 */
async function requireListingAllowed(
  app: FastifyInstance,
  verification: VerificationService,
  vendorId: string,
): Promise<void> {
  const vendorRecord = await app.prisma.vendor.findUniqueOrThrow({
    where: { id: vendorId },
    select: { isVerified: true, vendorType: true, status: true },
  });
  const verified = vendorRecord.isVerified
    || await verification.isRoleVerified(await vendorOwnerUserId(app, vendorId), vendorRecord.vendorType);
  if (verified) return;
  const draftableStatus = vendorRecord.status !== 'ACTIVE' && vendorRecord.status !== 'SUSPENDED';
  if (process.env['PREVIEW_MODE'] === '1' && draftableStatus) return;
  throw new AppError(403, 'VERIFICATION_REQUIRED', 'Complete document verification before listing items');
}

/** The selected store from the `x-vendor-id` header (multi-store switch). */
function selectedVendorId(request: { headers: Record<string, string | string[] | undefined> }): string | undefined {
  const h = request.headers['x-vendor-id'];
  return typeof h === 'string' ? h : undefined;
}

/** resolveVendor + role gate in one call — for MANAGER/OWNER-only routes. */
async function requireVendor(
  app: FastifyInstance,
  request: { user: { userId: string }; headers: Record<string, string | string[] | undefined> },
  min: 'MANAGER' | 'OWNER',
): Promise<VendorAccess> {
  const access = await resolveVendor(app, request.user.userId, selectedVendorId(request));
  requireRole(access, min);
  return access;
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
      // vendorType drives the pick-list UI (grocery/goods shelf-pick §5.3).
      vendor: { select: { vendorType: true } },
    },
  });
  if (!order || !order.vendorId || !vendorIds.includes(order.vendorId)) {
    throw new NotFoundError('Order', orderId);
  }
  // LIFECYCLE_V2: a held order is invisible to the vendor even by direct id.
  if (order.holdExpiresAt && order.holdExpiresAt > new Date()) {
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
  const dispatch = makeDispatchService(app);
  const notifications = new NotificationService(app.prisma, app.io);
  const settlementLedger = new DeliveryCashSettlementService(app.prisma, notifications);
  const picking = new PickingService(app.prisma, app.io);
  const verification = new VerificationService(
    app.prisma,
    new NotificationService(app.prisma, app.io),
    getKycProvider(),
  );
  const storage = getStorageProvider();
  const bookingService = new BookingService(app.prisma);

  // =========================================================================
  // Multi-store — list the owner's stores so the app can switch between them.
  // =========================================================================

  /** GET /stores — every store this account works in (owner or staff). */
  app.get('/stores', auth, async (request) => {
    const access = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const stores = await app.prisma.vendor.findMany({
      where: { id: { in: access.vendorIds } },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, vendorType: true, isCurrentlyOpen: true, acceptingOrders: true, city: true, isVerified: true },
    });
    return { success: true, data: { stores, selectedId: access.vendorId, myRole: access.role } };
  });

  // =========================================================================
  // Staff & roles (master plan §4.1) — owner-only management of extra logins.
  // =========================================================================

  /** GET /staff — members of the selected store, with their user identity. */
  app.get('/staff', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const staff = await app.prisma.vendorStaff.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, firstName: true, lastName: true, phone: true, avatar: true } } },
    });
    return { success: true, data: staff };
  });

  /** POST /staff — add an EXISTING Swift account by phone (no ghost invites:
   *  they must have signed up + done the selfie like everyone else). */
  app.post('/staff', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const body = addStaffSchema.parse(request.body);

    const target = await app.prisma.user.findUnique({
      where: { phone: body.phone },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!target) {
      throw new AppError(404, 'USER_NOT_FOUND', 'No Swift account with that phone — ask them to download Swift and sign up first');
    }
    if (target.id === request.user.userId) {
      throw new AppError(400, 'SELF_STAFF', 'You already own this store');
    }
    const existing = await app.prisma.vendorStaff.findUnique({
      where: { vendorId_userId: { vendorId, userId: target.id } },
    });
    if (existing) {
      throw new AppError(409, 'ALREADY_STAFF', `${target.firstName} is already on this store's team`);
    }

    const member = await app.prisma.vendorStaff.create({
      data: { vendorId, userId: target.id, role: body.role, invitedBy: request.user.userId },
      include: { user: { select: { id: true, firstName: true, lastName: true, phone: true, avatar: true } } },
    });

    await notifications.send({
      userId: target.id,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'You joined a store team',
      body: `You've been added as ${body.role === 'MANAGER' ? 'a manager' : 'staff'} — open Swift and choose "Business" to start.`,
      data: { kind: 'staff_added', vendorId },
    });

    return { success: true, data: member };
  });

  /** PUT /staff/:id — change a member's role. */
  app.put<{ Params: IdParam }>('/staff/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const body = updateStaffSchema.parse(request.body);
    const existing = await app.prisma.vendorStaff.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('StaffMember', request.params.id);

    const member = await app.prisma.vendorStaff.update({
      where: { id: request.params.id },
      data: { role: body.role },
      include: { user: { select: { id: true, firstName: true, lastName: true, phone: true, avatar: true } } },
    });
    return { success: true, data: member };
  });

  /** DELETE /staff/:id — remove a member (their access ends immediately). */
  app.delete<{ Params: IdParam }>('/staff/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const existing = await app.prisma.vendorStaff.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('StaffMember', request.params.id);

    await app.prisma.vendorStaff.delete({ where: { id: request.params.id } });
    return { success: true, data: { deleted: true } };
  });

  // =========================================================================
  // 0. QR CODE (acquisition + catalogue — spec §5.4)
  // =========================================================================

  /** GET /qr — printable/shareable QR linking to this vendor's public catalogue.
   *  Doubles as the acquisition tool (pulls a vendor's customers onto Swift). */
  app.get('/qr', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const vendor = await app.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { slug: true, name: true },
    });
    const base = process.env['APP_PUBLIC_URL'] ?? 'https://swift.gy';
    const deepLink = `${base}/v/${vendor.slug}`;
    const svg = await QRCode.toString(deepLink, { type: 'svg', margin: 1, width: 320 });
    return { success: true, data: { deepLink, svg, vendorName: vendor.name } };
  });

  // =========================================================================
  // 1. PROFILE
  // =========================================================================

  /** GET /profile — the stores this account works in, with the caller's role.
   *  Owners see every owned store (incl. billing); staff see exactly their
   *  member stores with the subscription stripped (billing is owner-only). */
  app.get('/profile', auth, async (request) => {
    const access = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const vendors = await app.prisma.vendor.findMany({
      where: { id: { in: access.vendorIds } },
      orderBy: { createdAt: 'asc' },
      include: {
        operatingHours: { orderBy: { dayOfWeek: 'asc' } },
        subscription: true,
        categories: { orderBy: { sortOrder: 'asc' }, include: { _count: { select: { items: true } } } },
        _count: { select: { orders: true, items: true } },
      },
    });
    const visible = access.role === 'OWNER'
      ? vendors
      : vendors.map((v) => ({ ...v, subscription: undefined }));
    return {
      success: true,
      data: { id: access.ownerId, userId: request.user.userId, vendors: visible, myRole: access.role },
    };
  });

  // =========================================================================
  // Operator promotions (master plan §4.2) — the vendor's own promo codes.
  // =========================================================================

  /** GET /promos — this store's codes with usage. */
  app.get('/promos', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const promos = await app.prisma.promoCode.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
    });
    return { success: true, data: promos };
  });

  /** POST /promos — create a code for the selected store. */
  app.post('/promos', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const body = createPromoSchema.parse(request.body);

    const code = body.code.toUpperCase();
    const taken = await app.prisma.promoCode.findUnique({ where: { code } });
    if (taken) throw new AppError(409, 'CODE_TAKEN', 'That code is already in use — pick another');
    if (body.validUntil.getTime() <= Date.now()) {
      throw new AppError(400, 'INVALID_DATES', 'The end date must be in the future');
    }

    const promo = await app.prisma.promoCode.create({
      data: {
        code,
        description: body.description,
        vendorId,
        discountType: body.discountType,
        discountValue: body.discountValue,
        minOrderAmount: body.minOrderAmount,
        maxDiscount: body.maxDiscount,
        applicableTo: [],
        validFrom: new Date(),
        validUntil: body.validUntil,
        maxUses: body.maxUses,
        maxUsesPerUser: body.maxUsesPerUser,
      },
    });
    return { success: true, data: promo };
  });

  /** PUT /promos/:id — pause/resume, extend, or reword an own code. */
  app.put<{ Params: IdParam }>('/promos/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const existing = await app.prisma.promoCode.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('PromoCode', request.params.id);

    const body = updatePromoSchema.parse(request.body);
    const promo = await app.prisma.promoCode.update({
      where: { id: request.params.id },
      data: {
        ...(body.description !== undefined && { description: body.description }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
        ...(body.validUntil !== undefined && { validUntil: body.validUntil }),
        ...(body.maxUses !== undefined && { maxUses: body.maxUses }),
      },
    });
    return { success: true, data: promo };
  });

  /** DELETE /promos/:id — unused codes delete outright; used ones deactivate
   *  (orders reference them — the history must stay intact). */
  app.delete<{ Params: IdParam }>('/promos/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const existing = await app.prisma.promoCode.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('PromoCode', request.params.id);

    if (existing.currentUses === 0) {
      await app.prisma.promoCode.delete({ where: { id: request.params.id } });
      return { success: true, data: { deleted: true } };
    }
    await app.prisma.promoCode.update({ where: { id: request.params.id }, data: { isActive: false } });
    return { success: true, data: { deleted: false, deactivated: true } };
  });

  /** PUT /profile — Update vendor profile details */
  app.put('/profile', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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
        ...(body.mmgPayUrl !== undefined && { mmgPayUrl: body.mmgPayUrl || null }),
      },
      include: { operatingHours: { orderBy: { dayOfWeek: 'asc' } } },
    });

    // On-write search sync [SWIFT-UG-SRCH-01]: catalog writes schedule a debounced per-vendor reindex.
    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: vendor };
  });

  // =========================================================================
  // 2. VENDOR MANAGEMENT — Toggle open / accepting orders
  // =========================================================================

  /** PUT /vendor/toggle-open — Toggle isCurrentlyOpen */
  app.put('/vendor/toggle-open', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });

    const updated = await app.prisma.vendor.update({
      where: { id: vendorId },
      data: { isCurrentlyOpen: !vendor.isCurrentlyOpen },
    });

    // Broadcast to anyone watching this vendor's storefront
    app.io.emit('vendor:status', { vendorId, isCurrentlyOpen: updated.isCurrentlyOpen });

    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: { isCurrentlyOpen: updated.isCurrentlyOpen, acceptingOrders: updated.acceptingOrders } };
  });

  /** PUT /vendor/toggle-orders — Toggle acceptingOrders */
  app.put('/vendor/toggle-orders', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });

    // Turning commerce ON requires a verified business (same gate as listing
    // items; the checklist belongs to the owner). Turning OFF is always allowed.
    if (!vendor.acceptingOrders) {
      const verified = vendor.isVerified
        || await verification.isRoleVerified(await vendorOwnerUserId(app, vendorId), vendor.vendorType);
      if (!verified) {
        throw new AppError(403, 'VERIFICATION_REQUIRED',
          'Your store can take orders once its documents are verified. Check Documents for anything missing or expired.');
      }
    }

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
    await resolveVendor(app, request.user.userId, selectedVendorId(request)); // vendor surface only
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
    // Alert-delivery ack (§A4): the store ACTED on this order's alert.
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(app.prisma, 'VENDOR_ORDER', request.params.id).catch(() => {});
    await resolveOwnedOrder(app, request.user.userId, request.params.id);
    await ackVendorAlert(app, request.user.userId, request.params.id);
    return { success: true, data: { acknowledged: true } };
  });

  /** GET /orders — Paginated, filterable order list */
  app.get('/orders', auth, async (request) => {
    const requested = selectedVendorId(request);
    const access = await resolveVendor(app, request.user.userId, requested);
    const query = request.query as Record<string, string | undefined>;
    const pagination = parsePagination(query);
    const { status, orderType, from, to, search } = vendorOrdersQuerySchema.parse(request.query);

    // LIFECYCLE_V2: a held order does not exist for the vendor yet. Lives in
    // AND[] so the search block's own OR can't clobber it.
    const where: Record<string, unknown> = { vendorId: ordersScope(access, requested), AND: [notHeldFilter()] };
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
          // Franchise roll-up: the board aggregates every store the owner has, so each
          // order needs to say which store it belongs to.
          vendor: { select: { id: true, name: true } },
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
    // Alert-delivery ack (§A4): the store ACTED on this order's alert.
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(app.prisma, 'VENDOR_ORDER', request.params.id).catch(() => {});
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

    // acceptance of a DELIVERY order starts the dispatch cascade.
    // PICKUP and APPOINTMENT orders never dispatch. Express orders jump the
    // dispatch queue (lower number = higher BullMQ priority).
    if (order.fulfillment === 'DELIVERY' && app.dispatchQueue) {
      await app.dispatchQueue.add('dispatch-order', { orderId: order.id }, {
        priority: order.isExpress ? 1 : 10,
        removeOnComplete: 100,
        removeOnFail: 50,
      });
    }

    return { success: true, data: updated };
  });

  /** Statuses where a rider already owns the status lane. Kitchen progress
   *  then rides the preparingAt/readyAt timestamps instead of the status —
   *  without this, a rider accepting within seconds of the vendor (the normal
   *  case) killed the vendor's Start-preparing/Mark-ready buttons with 400s. */
  const COURIER_ACTIVE: string[] = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'];

  async function recordPrepProgress(
    order: { id: string; status: OrderStatus; vendorId: string | null; riderId: string | null; orderNumber: string; preparingAt: Date | null },
    phase: 'PREPARING' | 'READY',
    userId: string,
  ) {
    const now = new Date();
    // Marking READY implies preparing happened — backfill it for the timeline.
    const data: Record<string, Date> = phase === 'PREPARING'
      ? { preparingAt: now }
      : { readyAt: now, ...(order.preparingAt ? {} : { preparingAt: now }) };
    const updated = await app.prisma.order.update({ where: { id: order.id }, data });
    await app.prisma.orderStatusLog.create({
      data: {
        orderId: order.id,
        status: order.status,
        changedBy: userId,
        note: phase === 'PREPARING' ? 'Vendor started preparing (rider already assigned)' : 'Order ready for pickup (rider already assigned)',
      },
    });
    const evt = { orderId: order.id, prep: phase, timestamp: new Date().toISOString() };
    app.io.to(`order:${order.id}`).emit('order:prep_update', evt);
    if (order.vendorId) app.io.to(`vendor:${order.vendorId}`).emit('order:prep_update', evt);
    // The rider at (or heading to) the store is the one who needs "it's ready".
    if (phase === 'READY' && order.riderId) {
      const rider = await app.prisma.rider.findUnique({ where: { id: order.riderId }, select: { userId: true } });
      if (rider) {
        await notifications.send({
          userId: rider.userId,
          type: 'ORDER_UPDATE',
          title: 'Order ready for pickup',
          body: `Order ${order.orderNumber} is packed and waiting at the counter.`,
          data: { orderId: order.id, kind: 'prep_ready' },
        });
      }
    }
    return updated;
  }

  /** PUT /orders/:id/preparing — Mark order as being prepared */
  app.put<{ Params: IdParam }>('/orders/:id/preparing', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    if (order.status === 'ACCEPTED') {
      const updated = await orderService.updateStatus(order.id, 'PREPARING', request.user.userId, 'Vendor started preparing');
      return { success: true, data: updated };
    }
    if (COURIER_ACTIVE.includes(order.status)) {
      if (order.preparingAt) return { success: true, data: order }; // double-tap safe
      const updated = await recordPrepProgress(order, 'PREPARING', request.user.userId);
      return { success: true, data: updated };
    }
    throw new AppError(400, 'INVALID_STATUS', `Cannot mark as preparing from ${order.status} status`);
  });

  /** PUT /orders/:id/ready — Mark order as ready for pickup */
  app.put<{ Params: IdParam }>('/orders/:id/ready', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    // Grocery/goods picking gate (§5.3): the bag never closes with an open
    // question in it — every line picked, or its substitution resolved.
    // Restaurants don't shelf-pick, so only quantity-tracked store types gate.
    if (order.vendorId) {
      const v = await app.prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { vendorType: true } });
      if (v && ['SUPERMARKET', 'STORE'].includes(v.vendorType)) {
        const open = await picking.unresolvedLines(order.id);
        if (open > 0) {
          throw new AppError(409, 'PICKING_INCOMPLETE', `${open} line${open === 1 ? '' : 's'} still need picking or a substitution decision`);
        }
      }
    }
    if (order.status === 'PREPARING') {
      const updated = await orderService.updateStatus(order.id, 'READY_FOR_PICKUP', request.user.userId, 'Order ready for pickup');
      return { success: true, data: updated };
    }
    if (COURIER_ACTIVE.includes(order.status)) {
      if (order.readyAt) return { success: true, data: order }; // double-tap safe
      const updated = await recordPrepProgress(order, 'READY', request.user.userId);
      return { success: true, data: updated };
    }
    throw new AppError(400, 'INVALID_STATUS', `Cannot mark as ready from ${order.status} status`);
  });

  // ── Grocery picking (§5.3) — the pick list inside PREPARING ───────────────

  /** PUT /orders/:id/items/:lineId/picked — staff tick a shelf-picked line. */
  app.put('/orders/:id/items/:lineId/picked', auth, async (request) => {
    const { id, lineId } = request.params as { id: string; lineId: string };
    await resolveOwnedOrder(app, request.user.userId, id);
    const { picked } = z.object({ picked: z.boolean() }).parse(request.body);
    const line = await picking.setPicked(id, lineId, picked);
    return { success: true, data: line };
  });

  /** POST /orders/:id/items/:lineId/substitute — out of stock: propose a swap
   *  the CUSTOMER approves live. Same vendor; same substitutionGroup when set. */
  app.post('/orders/:id/items/:lineId/substitute', auth, async (request) => {
    const { id, lineId } = request.params as { id: string; lineId: string };
    await resolveOwnedOrder(app, request.user.userId, id);
    const { substituteItemId } = z.object({ substituteItemId: z.string().min(1) }).parse(request.body);
    const line = await picking.proposeSubstitution(id, lineId, substituteItemId, request.user.userId);
    return { success: true, data: line };
  });

  /** POST /orders/:id/items/:lineId/refund-line — nothing to swap: the line
   *  comes off the order, totals shrink, stock goes back on the shelf. */
  app.post('/orders/:id/items/:lineId/refund-line', auth, async (request) => {
    const { id, lineId } = request.params as { id: string; lineId: string };
    await resolveOwnedOrder(app, request.user.userId, id);
    const line = await picking.refundLine(id, lineId, request.user.userId);
    return { success: true, data: line };
  });

  /** POST /items/:id/adjust — reasoned stock movement (received/damaged/…),
   *  atomic and logged. The audit trail behind quantity-on-hand. */
  app.post<{ Params: IdParam }>('/items/:id/adjust', auth, async (request) => {
    const access = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const body = z.object({
      delta: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, 'Zero is not an adjustment'),
      reason: z.enum(['RECEIVED', 'DAMAGED', 'MANUAL', 'RECONCILE', 'RETURN']),
      note: z.string().max(300).optional(),
    }).parse(request.body);

    const item = await app.prisma.item.findFirst({ where: { id: request.params.id, vendorId: { in: access.vendorIds } } });
    if (!item) throw new NotFoundError('Item', request.params.id);
    if (item.stockQuantity == null) {
      throw new AppError(400, 'UNTRACKED', 'This item does not track stock — set a quantity on it first');
    }

    // Guarded: stock can't be adjusted below zero.
    const applied = await app.prisma.item.updateMany({
      where: { id: item.id, stockQuantity: { gte: body.delta < 0 ? -body.delta : 0 } },
      data: { stockQuantity: { increment: body.delta } },
    });
    if (applied.count === 0) {
      throw new AppError(409, 'INSUFFICIENT_STOCK', 'That would take the stock below zero');
    }
    // Mirror the inventory engine's edges: zero hides, restock un-hides.
    await app.prisma.item.updateMany({
      where: { id: item.id, stockQuantity: { lte: 0 }, isAvailable: true },
      data: { isAvailable: false, autoHiddenAt: new Date() },
    });
    await app.prisma.item.updateMany({
      where: { id: item.id, autoHiddenAt: { not: null }, stockQuantity: { gt: 0 } },
      data: { isAvailable: true, autoHiddenAt: null },
    });

    const adjustment = await app.prisma.stockAdjustment.create({
      data: { itemId: item.id, delta: body.delta, reason: body.reason, note: body.note, createdBy: request.user.userId },
    });
    const fresh = await app.prisma.item.findUnique({ where: { id: item.id }, select: { stockQuantity: true, isAvailable: true } });
    scheduleVendorSearchSync(app, item.vendorId);
    return { success: true, data: { adjustment, stockQuantity: fresh?.stockQuantity, isAvailable: fresh?.isAvailable } };
  });

  /** GET /items/low-stock — everything at/under its threshold. */
  app.get('/items/low-stock', auth, async (request) => {
    const access = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const items = await app.prisma.$queryRaw<Array<{ id: string; name: string; stockQuantity: number; lowStockThreshold: number }>>`
      SELECT id, name, "stockQuantity", "lowStockThreshold"
      FROM items
      WHERE "vendorId" = ANY(${access.vendorIds})
        AND "stockQuantity" IS NOT NULL AND "lowStockThreshold" IS NOT NULL
        AND "stockQuantity" <= "lowStockThreshold"
      ORDER BY "stockQuantity" ASC
      LIMIT 200
    `;
    return { success: true, data: items };
  });

  /** POST /orders/:id/confirm-payment — the vendor saw the customer's MMG payment
   *  land in their OWN MMG wallet and marks it received. Money never touches
   *  Swift; this only records confirmation + tells the customer live. MMG orders
   *  only (cash is settled at handover). Idempotent. */
  app.post<{ Params: IdParam }>('/orders/:id/confirm-payment', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    if (order.paymentMethod !== 'MOBILE_MONEY') {
      throw new AppError(400, 'NOT_MMG', 'Only MMG orders are confirmed here — cash is handled at handover.');
    }
    if (order.paymentStatus === 'CAPTURED') {
      return { success: true, data: order }; // double-tap safe (fast path)
    }
    // Compare-and-set the capture so two concurrent confirm taps by store staff
    // don't both send the customer a "Payment received" push. Record-only (no
    // money moves), so a lost race is a benign idempotent success.
    const claimed = await app.prisma.order.updateMany({
      where: { id: order.id, paymentStatus: { not: 'CAPTURED' } },
      data: { paymentStatus: 'CAPTURED' },
    });
    if (claimed.count === 0) return { success: true, data: order };
    const updated = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    await app.prisma.orderStatusLog.create({
      data: { orderId: order.id, status: order.status, changedBy: request.user.userId, note: 'MMG payment confirmed received by vendor' },
    });
    app.io.to(`order:${order.id}`).emit('order:status_changed', { orderId: order.id, status: order.status, paymentStatus: 'CAPTURED' });
    // The socket covers an open order screen; the notification survives it.
    await notifications.send({
      userId: order.customerId,
      type: 'PAYMENT_RECEIVED',
      title: 'Payment received',
      body: `Your MMG payment for order #${order.orderNumber} is confirmed.`,
      data: { orderId: order.id, kind: 'mmg_payment_confirmed' },
    });
    return { success: true, data: updated };
  });

  /** GET /cash-settlements — MMG direct-pay ledger: delivery fees this store
   *  owes riders in cash (the customer's MMG payment landed in the store's
   *  wallet, fee included). Scoped like the order board: selected store, else
   *  all. Distinct from /settlements, the weekly billing history. */
  app.get('/cash-settlements', auth, async (request) => {
    const requested = selectedVendorId(request);
    const access = await resolveVendor(app, request.user.userId, requested);
    const scope = ordersScope(access, requested);
    const data = await settlementLedger.listForVendors(typeof scope === 'string' ? [scope] : scope.in);
    return { success: true, data };
  });

  /** POST /cash-settlements/:id/confirm — "we handed the rider their delivery
   *  fee". First confirm marks the store's half; the rider's confirm settles
   *  it. Idempotent; any staff can confirm (same as the payment-received button). */
  app.post<{ Params: IdParam }>('/cash-settlements/:id/confirm', auth, async (request) => {
    const access = await resolveVendor(app, request.user.userId);
    const data = await settlementLedger.confirm(assertSettlementId(request.params.id), 'STORE', { vendorIds: access.vendorIds });
    return { success: true, data };
  });

  /** POST /orders/:id/retry-dispatch — after "no movers available", the vendor
   *  holds the order and asks Swift to search again (fresh radius, cleared
   *  decline memory). No-op while an offer is already live. */
  app.post<{ Params: IdParam }>('/orders/:id/retry-dispatch', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    if (order.fulfillment !== 'DELIVERY') {
      throw new AppError(400, 'NOT_DELIVERY', 'Only delivery orders are dispatched to movers');
    }
    if (order.riderId) {
      throw new AppError(409, 'ALREADY_ASSIGNED', 'A mover already has this order');
    }
    if (!['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS', `Cannot search for a mover while the order is ${order.status}`);
    }
    const result = await dispatch.retryDispatch(order.id);
    return { success: true, data: { orderId: order.id, searching: !result.exhausted, exhausted: !!result.exhausted } };
  });

  /** PUT /orders/:id/complete-pickup — Takeaway: customer collected the order.
   *  Vendor verifies the pickup code (if set) and closes it; no rider involved. */
  app.put<{ Params: IdParam }>('/orders/:id/complete-pickup', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    if (order.fulfillment !== 'PICKUP') {
      throw new AppError(400, 'NOT_A_PICKUP', 'This order is not a pickup order.');
    }
    if (order.status !== 'READY_FOR_PICKUP') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot complete pickup from ${order.status} status`);
    }
    const { code } = completePickupSchema.parse(request.body ?? {});
    if (order.pickupCode && code != null && code !== order.pickupCode) {
      throw new AppError(400, 'WRONG_PICKUP_CODE', 'That pickup code does not match.');
    }
    const updated = await orderService.updateStatus(order.id, 'COMPLETED', request.user.userId, 'Picked up by customer');
    return { success: true, data: updated };
  });

  /** PUT /orders/:id/complete-appointment — Service: vendor marks the appointment done.
   *  APPOINTMENT orders skip prepare/ready/dispatch; they go ACCEPTED -> COMPLETED. */
  app.put<{ Params: IdParam }>('/orders/:id/complete-appointment', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    if (order.fulfillment !== 'APPOINTMENT') {
      throw new AppError(400, 'NOT_AN_APPOINTMENT', 'This order is not an appointment.');
    }
    if (order.status !== 'ACCEPTED') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot complete appointment from ${order.status} status`);
    }
    const updated = await orderService.updateStatus(order.id, 'COMPLETED', request.user.userId, 'Appointment completed by vendor');
    return { success: true, data: updated };
  });

  /** PUT /orders/:id/reject — Vendor cancels / rejects an order */
  app.put<{ Params: IdParam }>('/orders/:id/reject', auth, async (request) => {
    // Alert-delivery ack (§A4): the store ACTED on this order's alert.
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(app.prisma, 'VENDOR_ORDER', request.params.id).catch(() => {});
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    const rejectableStatuses = ['PENDING', 'ACCEPTED', 'PREPARING'];
    if (!rejectableStatuses.includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS', `Cannot reject order in ${order.status} status`);
    }
    const body = rejectOrderSchema.parse(request.body ?? {});
    const reason = body.reason || 'Rejected by vendor';
    await ackVendorAlert(app, request.user.userId, order.id); // rejecting acknowledges too

    // Compare-and-set: exactly one reject wins. A double-tap (or a reject racing
    // the customer's cancel) would otherwise both pass the status pre-check and
    // both run the non-idempotent restock → phantom stock. The loser gets 400.
    const claimed = await app.prisma.order.updateMany({
      where: { id: order.id, status: { in: rejectableStatuses as OrderStatus[] } },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledBy: request.user.userId,
        cancellationReason: reason,
      },
    });
    if (claimed.count === 0) {
      throw new AppError(400, 'INVALID_STATUS', 'This order can no longer be rejected');
    }
    const updated = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
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

    // Restock (goods never left the store — reject is only from pre-pickup
    // states), return the CASH rider's committed float, and free the mover.
    // (Found live: reject left sold-out items sold out forever AND, separately,
    // never released the rider's float → the rider silently stopped getting
    // CASH offers.)
    await orderService.applyCancellationSideEffects(
      { id: order.id, paymentMethod: order.paymentMethod, riderId: order.riderId, driverId: order.driverId, subtotalBase: Number(order.subtotalBase) },
      { restock: true },
    );

    const rejectEvent = { orderId: order.id, status: 'CANCELLED', reason, timestamp: new Date().toISOString() };
    app.io.to(`order:${order.id}`).emit('order:status_changed', rejectEvent);
    if (order.vendorId) {
      app.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', rejectEvent);
    }

    return { success: true, data: updated };
  });

  // =========================================================================
  // 4. MENU — Categories
  // =========================================================================

  /** GET /categories — List all categories for the vendor */
  app.get('/categories', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
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
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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
    scheduleVendorSearchSync(app, vendorId);
    return { success: true, data: category };
  });

  /** PUT /categories/:id — Update a category */
  app.put<{ Params: IdParam }>('/categories/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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
    scheduleVendorSearchSync(app, vendorId);
    return { success: true, data: category };
  });

  /** DELETE /categories/:id — Delete a category (and its items) */
  app.delete<{ Params: IdParam }>('/categories/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const existing = await app.prisma.category.findUnique({
      where: { id: request.params.id },
      include: { _count: { select: { items: true } }, items: { select: { id: true } } },
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

    // hard delete: no sweep could find these rows later [SWIFT-UG-SRCH-01]
    const search = new SearchService(app.prisma);
    for (const item of existing.items) search.removeItemDoc(item.id).catch(() => {});
    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: { deleted: true, itemsRemoved: existing._count.items } };
  });

  /** PUT /categories/reorder — Bulk reorder categories */
  app.put('/categories/reorder', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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
    scheduleVendorSearchSync(app, vendorId);
    return { success: true, data: categories };
  });

  // =========================================================================
  // 4. MENU — Items
  // =========================================================================

  /** GET /items — List all items, optionally filtered by categoryId */
  app.get('/items', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
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
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    await requireListingAllowed(app, verification, vendorId);

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
        lowStockThreshold: body.lowStockThreshold,
        isAvailable: body.isAvailable ?? true,
        isPopular: body.isPopular ?? false,
        dietaryTags: body.dietaryTags || [],
        allergens: body.allergens || [],
        sortOrder,
        ...(body.fulfillment ? { fulfillment: body.fulfillment } : {}),
        ...(body.bookingConfig ? { bookingConfig: body.bookingConfig as object } : {}),
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

    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: item };
  });

  /** GET /items/import/template — CSV template for bulk import */
  app.get('/items/import/template', auth, async (request, reply) => {
    await resolveVendor(app, request.user.userId, selectedVendorId(request)); // vendor surface only
    reply.type('text/csv').header('content-disposition', 'attachment; filename="swift-catalogue-template.csv"');
    return CSV_TEMPLATE;
  });

  /** Shared automap core: raw header->value rows in, confirm-ready preview out.
   *  Never imports; only relabels columns, never invents prices (spec §4.5). */
  async function automapRows(rows: Record<string, string>[]) {
    if (rows.length === 0) {
      throw new AppError(400, 'EMPTY_CSV', 'No data rows found');
    }
    const headers = Object.keys(rows[0]!);

    let mapping: ColumnMapping = guessColumnMapping(headers);
    if (REQUIRED_FIELDS.some((f) => !mapping[f])) {
      // Best-effort AI assist for columns the synonyms missed (off the critical path).
      const ai = await new AiService().mapCatalogueColumns(headers);
      if (ai) mapping = { ...(ai as ColumnMapping), ...mapping }; // heuristic wins ties
    }

    const missing = REQUIRED_FIELDS.filter((f) => !mapping[f]);
    if (missing.length > 0) {
      throw new AppError(422, 'UNMAPPED_COLUMNS',
        `Could not map required columns (${missing.join(', ')}). Rename them or use the template.`,
        { mapping, headers });
    }

    const normalized = applyMapping(rows, mapping);
    return {
      mapping,
      rowCount: normalized.length,
      preview: normalized.slice(0, 10),
      normalizedCsv: toImportCsv(normalized),
    };
  }

  /** POST /items/import/automap — map a messy store CSV's columns to Swift
   *  fields (deterministic synonyms + AI assist). Returns a preview + a canonical
   *  CSV to confirm via POST /items/import. */
  app.post('/items/import/automap', auth, async (request) => {
    await requireVendor(app, request, 'MANAGER');
    const { csv } = importCsvSchema.parse(request.body);
    const rows = parseCsvWithHeader(csv);
    return { success: true, data: await automapRows(rows) };
  });

  /** POST /items/import/xlsx — Excel upload (master plan §3.1 "CSV/Excel").
   *  First worksheet, first row = headers; funnels into the same automap →
   *  confirm flow as CSV. */
  app.post('/items/import/xlsx', auth, async (request) => {
    await requireVendor(app, request, 'MANAGER');
    const file = await request.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach an .xlsx file');

    const buffer = await file.toBuffer();
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new AppError(400, 'BAD_XLSX', 'That file is not a readable Excel workbook (.xlsx)');
    }
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) {
      throw new AppError(400, 'EMPTY_CSV', 'No data rows found in the first worksheet');
    }

    const cellText = (v: unknown): string => {
      if (v === null || v === undefined) return '';
      if (typeof v === 'object') {
        const rich = v as { richText?: Array<{ text: string }>; text?: string; result?: unknown };
        if (rich.richText) return rich.richText.map((t) => t.text).join('');
        if (rich.text) return rich.text;
        if (rich.result !== undefined) return String(rich.result);
        return '';
      }
      return String(v);
    };

    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: false }, (cell, col) => { headers[col - 1] = cellText(cell.value).trim(); });

    const rows: Record<string, string>[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const record: Record<string, string> = {};
      let hasValue = false;
      headers.forEach((h, i) => {
        if (!h) return;
        const value = cellText(row.getCell(i + 1).value).trim();
        record[h] = value;
        if (value) hasValue = true;
      });
      if (hasValue) rows.push(record);
    });

    return { success: true, data: await automapRows(rows) };
  });

  /** POST /items/import/menu-parse — a restaurant's PDF menu becomes draft
   *  items to CONFIRM (master plan §3.1). Deterministic guard rails: the AI
   *  only restructures the extracted text; rows without a parseable price are
   *  dropped, never invented, and nothing imports until the vendor confirms. */
  app.post('/items/import/menu-parse', auth, async (request) => {
    await requireVendor(app, request, 'MANAGER');
    const file = await request.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach a PDF menu');
    if (file.mimetype !== 'application/pdf') {
      throw new AppError(400, 'BAD_MENU_FILE', 'Only PDF menus are supported for now — export your menu as PDF, or use CSV/Excel');
    }

    const buffer = await file.toBuffer();
    let text = '';
    try {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const parsed = await parser.getText();
        text = (parsed.text ?? '').trim();
      } finally {
        await parser.destroy().catch(() => undefined);
      }
    } catch {
      throw new AppError(400, 'BAD_MENU_FILE', 'Could not read that PDF');
    }
    if (text.length < 20) {
      throw new AppError(422, 'MENU_NO_TEXT', 'That PDF has no readable text (a photo scan?) — use CSV/Excel or type items in');
    }

    const ai = new AiService();
    if (!ai.enabled) {
      throw new AppError(503, 'AI_UNAVAILABLE', 'Menu parsing is offline right now — use CSV/Excel or add items manually');
    }
    const drafts = await ai.parseMenuItems(text.slice(0, 12_000));
    if (!drafts || drafts.length === 0) {
      throw new AppError(422, 'MENU_UNPARSEABLE', 'Couldn’t find priced items in that menu — use CSV/Excel or add items manually');
    }

    // Deterministic validation — the AI restructures, it never decides.
    const normalized = drafts
      .map((d) => ({
        category: String(d.category ?? 'Menu').slice(0, 80) || 'Menu',
        name: String(d.name ?? '').trim().slice(0, 150),
        description: String(d.description ?? '').trim().slice(0, 500),
        basePrice: Number(d.basePrice),
        sku: '', unit: '', stockQuantity: '', isAvailable: 'true', fulfillment: '', imageUrl: '',
      }))
      .filter((d) => d.name.length > 0 && Number.isFinite(d.basePrice) && d.basePrice > 0 && d.basePrice <= 10_000_000);
    if (normalized.length === 0) {
      throw new AppError(422, 'MENU_UNPARSEABLE', 'Couldn’t find priced items in that menu — use CSV/Excel or add items manually');
    }

    return {
      success: true,
      data: {
        rowCount: normalized.length,
        preview: normalized.slice(0, 10),
        normalizedCsv: toImportCsv(normalized as never),
        source: 'menu-pdf',
      },
    };
  });

  /** POST /items/import — CSV bulk import: bad rows reported, good rows imported */
  app.post('/items/import', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    // Same listing gate as single-item creation (owner-based, §B2 draft-aware).
    await requireListingAllowed(app, verification, vendorId);

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

    scheduleVendorSearchSync(app, vendorId);

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
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const existing = await app.prisma.item.findFirst({ where: { id: request.params.id, vendorId } });
    if (!existing) throw new NotFoundError('Item', request.params.id);

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

    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: item };
  });

  /** PUT /items/:id — Update an item */
  app.put<{ Params: IdParam }>('/items/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const existing = await app.prisma.item.findFirst({ where: { id: request.params.id, vendorId } });
    if (!existing) throw new NotFoundError('Item', request.params.id);

    const body = updateItemSchema.parse(request.body);

    // If moving to a different category, verify ownership
    if (body.categoryId && body.categoryId !== existing.categoryId) {
      const cat = await app.prisma.category.findUnique({ where: { id: body.categoryId } });
      if (!cat || cat.vendorId !== vendorId) throw new NotFoundError('Category', body.categoryId);
    }

    // Inventory: restocking above zero undoes an AUTO-hide (the engine hid it
    // when stock ran out) — the owner's own availability toggle always wins,
    // and any explicit isAvailable in this request clears the auto-hide marker.
    const restocksAboveZero = body.stockQuantity !== undefined && (body.stockQuantity ?? 0) > 0;
    const unhide = restocksAboveZero && existing.autoHiddenAt !== null && body.isAvailable === undefined;

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
        ...(body.lowStockThreshold !== undefined && { lowStockThreshold: body.lowStockThreshold }),
        ...(unhide && { isAvailable: true, autoHiddenAt: null }),
        ...(body.isAvailable !== undefined && { isAvailable: body.isAvailable, autoHiddenAt: null }),
        ...(body.isPopular !== undefined && { isPopular: body.isPopular }),
        ...(body.dietaryTags !== undefined && { dietaryTags: body.dietaryTags }),
        ...(body.allergens !== undefined && { allergens: body.allergens }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        ...(body.fulfillment !== undefined && { fulfillment: body.fulfillment }),
        ...(body.bookingConfig !== undefined && { bookingConfig: body.bookingConfig as object }),
      },
      include: {
        category: { select: { id: true, name: true } },
        optionGroups: { include: { options: { orderBy: { sortOrder: 'asc' } } }, orderBy: { sortOrder: 'asc' } },
      },
    });

    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: item };
  });

  /** DELETE /items/:id — Delete an item and its option groups/options */
  app.delete<{ Params: IdParam }>('/items/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const existing = await app.prisma.item.findFirst({ where: { id: request.params.id, vendorId } });
    if (!existing) throw new NotFoundError('Item', request.params.id);

    await app.prisma.option.deleteMany({ where: { optionGroup: { itemId: request.params.id } } });
    await app.prisma.optionGroup.deleteMany({ where: { itemId: request.params.id } });
    await app.prisma.item.delete({ where: { id: request.params.id } });

    // hard delete: no sweep could find this row later [SWIFT-UG-SRCH-01]
    new SearchService(app.prisma).removeItemDoc(request.params.id).catch(() => {});
    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: { deleted: true } };
  });

  /** PUT /items/:id/availability — Quick toggle availability */
  app.put<{ Params: IdParam }>('/items/:id/availability', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const existing = await app.prisma.item.findFirst({ where: { id: request.params.id, vendorId } });
    if (!existing) throw new NotFoundError('Item', request.params.id);

    const body = itemAvailabilitySchema.parse(request.body ?? {});
    const newAvailability = body.isAvailable !== undefined ? body.isAvailable : !existing.isAvailable;

    const item = await app.prisma.item.update({
      where: { id: request.params.id },
      data: { isAvailable: newAvailability },
      select: { id: true, name: true, isAvailable: true },
    });

    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: item };
  });

  // =========================================================================
  // 4. MENU — Option Groups
  // =========================================================================

  /** POST /items/:itemId/option-groups — Add an option group to an item */
  app.post<{ Params: ItemIdParam }>('/items/:itemId/option-groups', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const item = await app.prisma.item.findFirst({ where: { id: request.params.itemId, vendorId } });
    if (!item) throw new NotFoundError('Item', request.params.itemId);

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
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const hours = await app.prisma.operatingHours.findMany({
      where: { vendorId },
      orderBy: { dayOfWeek: 'asc' },
    });
    return { success: true, data: hours };
  });

  /** PUT /hours — Bulk upsert operating hours for all 7 days */
  app.put('/hours', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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

    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: results };
  });

  // =========================================================================
  // 6. ANALYTICS
  // =========================================================================

  /** GET /analytics/overview — Dashboard summary cards */
  app.get('/analytics/overview', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');

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
      // Held orders (LIFECYCLE_V2) aren't the vendor's to act on yet.
      app.prisma.order.count({ where: { vendorId, status: 'PENDING', ...notHeldFilter() } }),
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

  /** GET /analytics/ops — Operational quality over a window: how fast orders
   *  are accepted, how honest the prep quote is, and how often orders die.
   *  Everything derives from real order timestamps — no synthetic numbers. */
  app.get('/analytics/ops', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { days } = revenueQuerySchema.parse(request.query);

    // DASH-06: window from Guyana-local midnight N days ago, not UTC midnight.
    const since = startOfDayGY(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

    const orders = await app.prisma.order.findMany({
      where: { vendorId, placedAt: { gte: since } },
      select: {
        status: true,
        placedAt: true,
        acceptedAt: true,
        readyAt: true,
        estimatedPrepTime: true,
        cancelledBy: true,
      },
    });

    const placed = orders.length;
    const accepted = orders.filter((o) => o.acceptedAt);
    const cancelled = orders.filter((o) => o.status === 'CANCELLED' || o.status === 'REFUNDED');
    const vendorCancelled = cancelled.filter((o) => (o.cancelledBy ?? '').toUpperCase().includes('VENDOR'));
    // Acceptance is judged on DECIDED orders (accepted, or killed by the
    // store) — customer cancellations before acceptance are not held against
    // the vendor.
    const decided = accepted.length + vendorCancelled.length;

    const avgMinutes = (pairs: Array<[Date, Date]>) =>
      pairs.length
        ? pairs.reduce((sum, [a, b]) => sum + (b.getTime() - a.getTime()) / 60000, 0) / pairs.length
        : null;

    const acceptPairs = accepted
      .filter((o) => o.acceptedAt! >= o.placedAt)
      .map((o) => [o.placedAt, o.acceptedAt!] as [Date, Date]);
    const prepPairs = orders
      .filter((o) => o.acceptedAt && o.readyAt && o.readyAt >= o.acceptedAt)
      .map((o) => [o.acceptedAt!, o.readyAt!] as [Date, Date]);
    const quoted = orders.filter((o) => o.acceptedAt && o.readyAt && o.estimatedPrepTime != null);
    const avgQuotedPrep = quoted.length
      ? quoted.reduce((s, o) => s + (o.estimatedPrepTime ?? 0), 0) / quoted.length
      : null;

    const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);

    return {
      success: true,
      data: {
        days,
        placedOrders: placed,
        acceptanceRate: decided ? Math.round((accepted.length / decided) * 100) : null,
        cancellationRate: placed ? Math.round((cancelled.length / placed) * 100) : null,
        vendorCancellations: vendorCancelled.length,
        avgAcceptMinutes: round1(avgMinutes(acceptPairs)),
        avgPrepMinutes: round1(avgMinutes(prepPairs)),
        avgQuotedPrepMinutes: round1(avgQuotedPrep),
      },
    };
  });

  /** GET /analytics/revenue — Daily revenue breakdown for the last 30 days */
  app.get('/analytics/revenue', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { days } = revenueQuerySchema.parse(request.query);

    // DASH-06: window from Guyana-local midnight N days ago, not UTC midnight.
    const since = startOfDayGY(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

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
        totalAmount: true,
      },
      orderBy: { placedAt: 'asc' },
    });

    // Aggregate by day
    const dailyMap = new Map<string, { date: string; orders: number; revenue: number; total: number }>();

    // Pre-fill all days so gaps show as zero
    for (let d = 0; d < days; d++) {
      const date = new Date(since);
      date.setDate(date.getDate() + d);
      const key = date.toISOString().slice(0, 10);
      dailyMap.set(key, { date: key, orders: 0, revenue: 0, total: 0 });
    }

    for (const o of orders) {
      const key = o.placedAt.toISOString().slice(0, 10);
      const entry = dailyMap.get(key);
      if (entry) {
        entry.orders += 1;
        entry.revenue += Number(o.subtotalBase);
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
          total: daily.reduce((s, d) => s + d.total, 0),
        },
      },
    };
  });

  /** GET /analytics/busy-hours — orders by local hour of day, last 30 days
   *  (master plan §4.1 "busy hours"). Guyana is UTC-4 year-round. */
  app.get('/analytics/busy-hours', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const since = new Date();
    since.setDate(since.getDate() - 30);

    const orders = await app.prisma.order.findMany({
      where: { vendorId, placedAt: { gte: since }, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
      select: { placedAt: true },
    });

    const GUYANA_OFFSET_HOURS = -4;
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0 }));
    for (const o of orders) {
      const local = ((o.placedAt.getUTCHours() + GUYANA_OFFSET_HOURS) + 24) % 24;
      hours[local]!.orders += 1;
    }
    const peak = hours.reduce((best, h) => (h.orders > best.orders ? h : best), hours[0]!);

    return {
      success: true,
      data: { days: 30, hours, peak: peak.orders > 0 ? peak : null, total: orders.length },
    };
  });

  /** GET /analytics/popular-items — Top items by totalOrdered */
  app.get('/analytics/popular-items', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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
  /** GET /sales-statement — print-ready HTML sales statement (the receipt's
   *  sibling, marketplace §12): what a store shows their accountant. Completed
   *  orders only; the store's take is items minus its own promo discounts —
   *  fees and tips belong to the rider. Default period 30 days. */
  app.get('/sales-statement', auth, async (request, reply) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { statementPeriod, buildVendorStatement, mintStatementPath } = await import('../order/statement');
    const q = request.query as { from?: string; to?: string; link?: string };
    const period = statementPeriod(q);
    // ?link=1 → a short-lived signed URL the in-app browser can open (share/print).
    if (q.link === '1') {
      return { success: true, data: mintStatementPath('vendor', vendorId, period) };
    }
    reply.type('text/html; charset=utf-8');
    return buildVendorStatement(app.prisma, vendorId, period);
  });

  app.get('/settlements', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
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
    const { vendorId } = await requireVendor(app, request, 'OWNER');
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

  /** PUT /subscription/billing-method — §13 rail selection (owner-only:
   *  CASH prepaid vs MOBILE_MONEY merchant-initiated on the owner's MMG). */
  app.put('/subscription/billing-method', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const body = z.object({
      method: z.enum(['CASH', 'MOBILE_MONEY']),
      mmgPayerMsisdn: z.string().trim().min(5).max(30).optional(),
    }).parse(request.body);
    const sub = await app.prisma.subscription.findFirst({ where: { vendorId } });
    if (!sub) throw new NotFoundError('Subscription');
    const billingSvc = new BillingService(app.prisma, notifications, getPaymentProvider());
    const updated = await billingSvc.setBillingRail(sub.id, body.method, body.mmgPayerMsisdn);
    return { success: true, data: { billingMethod: updated.billingMethod, mmgPayerMsisdn: updated.mmgPayerMsisdn } };
  });

  // =========================================================================
  // 9. REVIEWS
  // =========================================================================

  /** GET /reviews — Paginated customer reviews for the vendor */
  app.get('/reviews', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
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

  /** POST /reviews/:id/respond — the operator's public reply (§4.1). One reply
   *  per review, editable; the reviewer is notified. */
  app.post<{ Params: IdParam }>('/reviews/:id/respond', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { response } = respondReviewSchema.parse(request.body);

    const rating = await app.prisma.rating.findUnique({ where: { id: request.params.id } });
    if (!rating || rating.vendorId !== vendorId || rating.type !== 'CUSTOMER_TO_VENDOR') {
      throw new NotFoundError('Review', request.params.id);
    }

    const isEdit = rating.response !== null;
    const updated = await app.prisma.rating.update({
      where: { id: request.params.id },
      data: { response, respondedAt: new Date(), respondedBy: request.user.userId },
    });

    if (!isEdit) {
      const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { name: true } });
      await notifications.send({
        userId: rating.raterId,
        type: 'RATING_RECEIVED',
        title: `${vendor.name} replied to your review`,
        body: response.length > 120 ? `${response.slice(0, 117)}…` : response,
        data: { kind: 'review_response', ratingId: rating.id, vendorId },
      });
    }

    return { success: true, data: updated };
  });
}
