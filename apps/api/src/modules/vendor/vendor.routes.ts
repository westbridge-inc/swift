import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { assertPromoTerms, recordPromoTermsVersion, updatePromoTerms } from '../promo/promo-terms';
import { OrderStatus, OrderType, SettlementStatus } from '@prisma/client';
import { OrderService, assertMmgFulfilmentAllowed, notHeldFilter, holdWindowMs } from '../order/order.service';
import { vendorResponseSlaMinutes, vendorRespondBy } from '../order/response-sla';
import { VendorAnalyticsService } from './vendor-analytics.service';
import { VendorMenuService } from './vendor-menu.service';
import { PickingService } from '../order/picking.service';
import { makeDispatchService } from '../dispatch/dispatch.service';
import { dispatchTrigger, enqueueDeliveryDispatch } from '../dispatch/dispatch-trigger';
import { resolveDeliveryMode } from '../fulfillment/fulfillment-mode';
import { handoverAttemptState, HANDOVER_SECRETS_OMIT } from '../handover/handover-security';
import { pickingReadinessCounter, mmgAttestationCounter } from '../../plugins/observability';
import { assertMmgAttestable, normaliseMmgReference, recordVendorAttestation } from './mmg-attestation';
import { NotificationService } from '../notification/notification.service';
import { BookingService } from '../booking/booking.service';
import { fmtSlotTime } from '../booking/availability';
import { VerificationService } from '../verification/verification.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { encryptBuffer, generateDek, getKeyProvider } from '../../providers/storage/envelope';
import { createHash } from 'node:crypto';
import { publishLegalDocumentOnce, recordConsent, type ConsentSurface } from '../legal/consent.service';
import { LEGAL_VERSION } from '../legal/legal.routes';
import { ACTIVITY_CLASSES, DECLARATION_CONSENT_TYPE, DECLARATION_VERSION, UNREGISTERED_TRADER_DECLARATION_V1, renderDeclarationPdf } from './unregistered-declaration';
import { DECLARATION_DOC_TYPE } from '../verification/doc-registry';
import { validRegistrationRecord } from './vendor-tier';
import { parseCsvWithHeader } from '../../utils/csv';
import { AiService } from '../ai/ai.service';
import { guessColumnMapping, applyMapping, toImportCsv, REQUIRED_FIELDS, type ColumnMapping } from '../../utils/catalogue-map';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors';
import { applyStockMovement, recordOpeningBalance } from '../inventory/stock';
import { DeliveryCashSettlementService, assertSettlementId, settlementAttestationSchema } from '../cash/delivery-cash-settlement.service';
import { BillingService } from '../billing/billing.service';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { throwForMissingProfile } from '../../utils/role-gate';
import { ALLOWED_IMAGE_TYPES, looksLikeImage } from '../../utils/images';
import { scheduleVendorSearchSync } from '../search/search-sync';
import { SearchService } from '../search/search.service';
import { subscriptionOperability } from '../subscription/operate-gate';
import { QrService } from '../qr/qr.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { QrAnalyticsService } from '../qr/qr-analytics.service';
import { cachedRender, renderQrPng, renderQrSvg, renderTemplatePdf } from '../qr/qr-assets.service';
import { publicWebBase } from '../qr/qr-codes';
import { processReviewText } from '../rating/review-scrub';
import { mmgPayUrlForWrite, safeMmgPayUrl } from '../../utils/mmg-pay-url';
import { requireStepUp } from '../auth/step-up';
import { stageMmgLinkChange, cancelMmgLinkChange, clearMmgLink } from '../integrity/money-surface';
import { assertVelocity } from '../integrity/velocity';
import { publicPhoneForWrite, safePublicPhone } from '../../utils/vendor-public-phone';
import { BULK_CHOICES, bulkUnitsForChoice, bulkChoiceForUnits, type BulkChoice } from '../../utils/load';
import { riderCounterpartySelect } from '../../utils/counterparty';

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
  // FUL-004: whether this vendor fulfils its own DELIVERY orders with its own courier.
  selfDeliveryEnabled: z.boolean().optional(),
  // FUL-007: kitchen-capacity cap. Positive int caps concurrent in-flight orders;
  // null clears the cap (unlimited intake).
  maxConcurrentOrders: z.number().int().min(1).max(1000).nullable().optional(),
  // The vendor's own MMG "pay me" link (opt-in). null/empty clears it → cash-only.
  mmgPayUrl: z.string().trim().max(500).nullable().optional(),
  // The number customers may call before ordering. Opt-in; null/'' takes it
  // down. Shape is enforced by publicPhoneForWrite, not here, so the write
  // and read boundaries cannot drift apart on what a valid number is.
  publicPhone: z.string().trim().max(32).nullable().optional(),
});

const acceptOrderSchema = z.object({
  estimatedPrepTime: z.number().int().min(1).max(480).optional(),
});

// FUL-004d: the vendor's one-tap fulfillment override — "we'll deliver it
// ourselves" / "get a rider instead".
const fulfillmentModeSchema = z.object({
  mode: z.enum(['PLATFORM_RIDER', 'VENDOR_DELIVERY']),
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
  // [G2] How much room one unit takes, as the WORD the shopkeeper chose. The
  // integer behind it lives in utils/load.ts and never crosses the wire.
  bulk: z.enum(BULK_CHOICES as [BulkChoice, ...BulkChoice[]]).optional(),
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

/** The row with its bulk as a WORD and the integer removed, so no client ever
 *  sees units — in either direction. */
function withBulkWord<T extends { bulkUnits: number | null }>(item: T): Omit<T, 'bulkUnits'> & { bulk: BulkChoice } {
  const { bulkUnits, ...rest } = item;
  return { ...rest, bulk: bulkChoiceForUnits(bulkUnits) };
}

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

// ---------------------------------------------------------------------------
// Money on the wire
// ---------------------------------------------------------------------------

/**
 * [S1] A Prisma `Decimal` is NOT a JS number — it serialises to a STRING
 * ("1500.00"). One backend feeds four clients, so a route that returns RAW
 * Prisma rows ships money as a string to all four at once, and whether that
 * breaks is a property of the RENDER, not of the data: string interpolation
 * looks perfect, `.toFixed()` throws, and arithmetic quietly yields
 * "1500.00500.00" or NaN. That is drift that bites in production, not in dev.
 *
 * So money is coerced HERE, at the seam where the response is built — once,
 * not at each of four renders. `paginatedResponse` is shared with routes that
 * carry no money at all, so rows are mapped BEFORE they are handed to it.
 *
 * Field NAMES never change: an installed app is months old and reads today's
 * names. This is a type fix, not a rename.
 */
function coerceMoney<T extends object>(row: T, fields: readonly (keyof T & string)[]): T {
  const out = { ...row } as Record<string, unknown>;
  for (const field of fields) {
    const raw = out[field];
    // LAW 1: a null fare is "there was no fare" — it stays null and renders as
    // an em-dash. Coercing it to 0 would invent a number nobody agreed to.
    if (raw === null || raw === undefined) continue;
    // LAW 2: guard the coercion. A value that will not parse becomes null
    // ("unknown") rather than a NaN on somebody's receipt.
    const parsed = Number(raw);
    out[field] = Number.isFinite(parsed) ? parsed : null;
  }
  return out as T;
}

/** Every `Decimal` money column on `model Order` (schema.prisma). */
const ORDER_MONEY_FIELDS = [
  'subtotalBase', 'subtotalMarkup', 'subtotalCustomer',
  'deliveryFee', 'serviceFee', 'taxAmount', 'tipAmount', 'discount', 'totalAmount',
  'taxiFareBase', 'taxiFarePerKm', 'taxiFarePerMin', 'taxiFareTotal',
] as const;

/** Every `Decimal` money column on `model OrderItem`. */
const ORDER_ITEM_MONEY_FIELDS = [
  'basePrice', 'markedUpPrice', 'markupAmount',
  'totalBase', 'totalMarkup', 'totalCustomer', 'substitutePrice',
] as const;

/** `model Item` / `model Option` — the menu's own prices. */
const ITEM_MONEY_FIELDS = ['basePrice'] as const;
const OPTION_MONEY_FIELDS = ['additionalPrice'] as const;

/**
 * Verify that the given order belongs to one of the user's vendors and return it.
 */
async function resolveOwnedOrder(app: FastifyInstance, userId: string, orderId: string) {
  const { vendorIds } = await resolveVendor(app, userId);
  const order = await app.prisma.order.findUnique({
    where: { id: orderId },
    // HND-003: the vendor is the pickup-code VERIFIER — it must never READ the
    // code (or it could close the handover without the customer present). The
    // shared vendor order object is stripped of every handover secret by
    // construction; the one path that needs the code (complete-pickup) fetches
    // it explicitly.
    //
    // [F-0011] This comment used to end "Same rule the driver ride-PIN response
    // already follows." It did not — the driver and rider paths returned the
    // full row for months, and this sentence is why nobody re-checked them.
    // Do not assert another path is safe; assert it in handover-secrets.test.ts.
    omit: HANDOVER_SECRETS_OMIT,
    include: {
      items: true,
      statusHistory: { orderBy: { createdAt: 'desc' } },
      customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
      // [F-027-07] allow-list, not `include` — see utils/counterparty.
      rider: { select: riderCounterpartySelect({ withPhone: true }) },
      // vendorType drives the pick-list UI (grocery/goods shelf-pick §5.3).
      vendor: { select: { vendorType: true, selfDeliveryEnabled: true } },
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
  const analytics = new VendorAnalyticsService(app.prisma);
  const menu = new VendorMenuService(app.prisma);
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
  const bookingService = new BookingService(app.prisma, app.io);
  const qrService = new QrService(app.prisma);
  const discovery = new DiscoveryService(app.prisma);
  const qrAnalytics = new QrAnalyticsService(app.prisma);

  // A vendor may only DRIVE an order FORWARD (accept / prepare / ready / complete)
  // while eligible to operate — the SAME predicate as the toggle-orders front
  // door. The doc-expiry sweep sets isVerified=false but leaves status ACTIVE, so
  // a lapsed store's board keeps rendering and every order already in flight when
  // the docs lapsed could otherwise be fully accepted, prepared and handed over.
  // This closes that server-authoritative hole (invariant 2). Reject/cancel are
  // deliberately NOT gated — a blocked store must still be able to decline.
  async function assertVendorCanOperate(vendorId: string) {
    const vendor = await app.prisma.vendor.findUnique({
      where: { id: vendorId },
      select: { isVerified: true, status: true, vendorType: true },
    });
    if (!vendor) throw new NotFoundError('Vendor', vendorId);
    if (vendor.status === 'SUSPENDED' || vendor.status === 'CLOSED') {
      throw new AppError(403, 'VENDOR_SUSPENDED', 'Your store is not active and cannot work orders. Reopen it from Account.');
    }
    const verified = vendor.isVerified || (await verification.isRoleVerified(await vendorOwnerUserId(app, vendorId), vendor.vendorType));
    if (!verified) {
      throw new AppError(403, 'VERIFICATION_REQUIRED', 'Your store’s documents need verifying before you can work orders — check Documents for anything expired.');
    }
    // THE canOperate rule (operate-gate.ts, G-BILL-03). Unification FIXED a
    // real divergence here: this copy was missing the grace-lapse check, so a
    // PAST_DUE vendor whose grace had run out kept working orders until the
    // billing sweep flipped them SUSPENDED. Now all three actor gates agree.
    const sub = await app.prisma.subscription.findFirst({ where: { vendorId }, orderBy: { createdAt: 'desc' } });
    const operability = subscriptionOperability(sub, { missingRow: 'GRANDFATHER' });
    if (!operability.operable) {
      if (operability.why === 'GRACE_LAPSED') {
        throw new AppError(403, 'SUBSCRIPTION_PAST_DUE', 'Your grace period has ended — pay this week’s fee to keep working orders.');
      }
      throw new AppError(403, 'SUBSCRIPTION_INACTIVE', 'Your subscription must be active to work orders — renew from Account.');
    }
  }

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
    await requireStepUp(app, request); // [ALG-34] a grant hands the store's board to a phone
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
    await requireStepUp(app, request); // [ALG-34]
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
  // 0. QR CODE (scan-to-store growth engine — QrCode lifecycle + short links)
  // =========================================================================

  /** Render one QrCode row as the API payload: the QR image encodes the SHORT
   *  link {base}/s/{code} (survives renames — the resolver 302s to the current
   *  slug). `deepLink` is kept as an alias of shortUrl for the existing mobile
   *  StoreQrCard, which renders { svg, deepLink } and predates this system. */
  async function qrPayload(row: { shortCode: string; version: number; status: string }, vendorName: string, slug: string) {
    const base = publicWebBase();
    const graceDays = await qrService.graceDays();
    const shortUrl = `${base}/s/${row.shortCode}`;
    // EC-H + quiet zone ≥ 4 + the contrast law live in the asset service — one
    // render home for the screen SVG, the PNGs, and the print pack.
    const svg = await renderQrSvg(shortUrl);
    return {
      deepLink: shortUrl,
      shortUrl,
      shortCode: row.shortCode,
      canonicalUrl: `${base}/store/${slug}`,
      version: row.version,
      status: row.status,
      // The regenerate confirm dialog states this (config, never a hardcoded 30).
      graceDays,
      svg,
      vendorName,
    };
  }

  /** GET /qr — get-or-create this store's ACTIVE code (idempotent; the
   *  one-ACTIVE partial unique makes it concurrency-safe). The acquisition
   *  artifact: print it, customers scan to order. */
  app.get('/qr', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const vendor = await app.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { slug: true, name: true },
    });
    const row = await qrService.getOrCreateForVendor(vendorId, request.user.userId);
    return { success: true, data: await qrPayload(row, vendor.name, vendor.slug) };
  });

  /** POST /qr/regenerate — supersede the current code (it keeps resolving for
   *  the grace window so printed materials die slowly) and mint the next one.
   *  Owner-only: it obsoletes physical material. */
  app.post('/qr/regenerate', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const vendor = await app.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { slug: true, name: true },
    });
    const graceDays = await qrService.graceDays();
    const { current, superseded } = await qrService.regenerateForVendor(vendorId, request.user.userId);
    return {
      success: true,
      data: {
        ...(await qrPayload(current, vendor.name, vendor.slug)),
        previous: superseded
          ? { shortCode: superseded.shortCode, graceDays, graceEndsAt: new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000).toISOString() }
          : null,
      },
    };
  });

  /** POST /qr/deactivate — immediate kill switch (stolen/misused materials).
   *  Requires { confirm: true }; owner-only; idempotent. */
  app.post('/qr/deactivate', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    z.object({ confirm: z.literal(true) }).parse(request.body);
    const { deactivated } = await qrService.deactivateForVendor(vendorId);
    return { success: true, data: { deactivated: deactivated > 0 } };
  });

  /** GET /qr/analytics?range=7d|30d|90d|all — the performance card. Every
   *  number reconciles to rows (raw + rollups); reconciliation is test-gated. */
  app.get('/qr/analytics', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { range } = z.object({ range: z.enum(['7d', '30d', '90d', 'all']).default('30d') })
      .parse(request.query ?? {});
    return { success: true, data: await qrAnalytics.forVendor(vendorId, range) };
  });

  /** GET /qr/assets/:format — the print & share pack (spec 4.4/4.5/16).
   *  png (1024|4096 px) · svg · pdf (one of six 300-DPI print templates with
   *  bleed + trim marks, vector code, brand fonts embedded). Renders cache per
   *  (code id, version, format, options) — regenerate mints a new row, so keys
   *  self-invalidate. Rate-limited per account-sized window (spec 20/hour). */
  app.get('/qr/assets/:format', {
    preHandler: [app.authenticate],
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
  }, async (request, reply) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { format } = z.object({ format: z.enum(['png', 'svg', 'pdf']) }).parse(request.params);
    const query = z.object({
      template: z.enum(['card', 'tabletent', 'sticker', 'flyer', 'decal', 'poster']).default('card'),
      size: z.coerce.number().int().refine((n) => n === 1024 || n === 4096, '1024 or 4096').default(1024),
    }).parse(request.query ?? {});

    const vendor = await app.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { name: true, vendorType: true },
    });
    const row = await qrService.getOrCreateForVendor(vendorId, request.user.userId);
    const shortUrl = `${publicWebBase()}/s/${row.shortCode}`;
    const cacheKey = `${row.id}:${row.version}:${format}:${query.template}:${query.size}`;

    if (format === 'svg') {
      const svg = await cachedRender(`${cacheKey}`, async () => Buffer.from(await renderQrSvg(shortUrl, 1024), 'utf8'));
      return reply
        .type('image/svg+xml')
        .header('content-disposition', `attachment; filename="swift-qr-${row.shortCode}.svg"`)
        .send(svg);
    }
    if (format === 'png') {
      const png = await cachedRender(cacheKey, () => renderQrPng(shortUrl, query.size));
      return reply
        .type('image/png')
        .header('content-disposition', `attachment; filename="swift-qr-${row.shortCode}-${query.size}.png"`)
        .send(png);
    }
    const pdf = await cachedRender(cacheKey, () =>
      renderTemplatePdf(query.template, { vendorName: vendor.name, vendorType: vendor.vendorType, shortUrl }));
    return reply
      .type('application/pdf')
      .header('content-disposition', `attachment; filename="swift-qr-${query.template}.pdf"`)
      .send(pdf);
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
    // Legacy rows predate the MMG destination validator. Never reflect an
    // invalid stored value back into an app where it could be opened.
    const safeVendors = vendors.map((vendor) => ({
      ...vendor,
      mmgPayUrl: safeMmgPayUrl(vendor.mmgPayUrl),
      mmgPayUrlPending: safeMmgPayUrl(vendor.mmgPayUrlPending),
      publicPhone: safePublicPhone(vendor.publicPhone),
    }));
    const visible = access.role === 'OWNER'
      ? safeVendors
      : safeVendors.map((v) => ({ ...v, subscription: undefined }));
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

    // [M-32] The store funds its own code, and it may only discount goods.
    // The whole record is validated, and version 1 of its terms is written
    // with the row in one transaction.
    const validFrom = new Date();
    assertPromoTerms({
      discountType: body.discountType, discountValue: body.discountValue, minOrderAmount: body.minOrderAmount ?? null, maxDiscount: body.maxDiscount ?? null,
      validFrom, validUntil: body.validUntil, maxUses: body.maxUses ?? null, maxUsesPerUser: body.maxUsesPerUser,
    });
    const promo = await app.prisma.$transaction(async (tx) => {
      const row = await tx.promoCode.create({
        data: {
          code,
          description: body.description,
          vendorId,
          discountType: body.discountType,
          discountValue: body.discountValue,
          minOrderAmount: body.minOrderAmount,
          maxDiscount: body.maxDiscount,
          applicableTo: [],
          validFrom,
          validUntil: body.validUntil,
          maxUses: body.maxUses,
          maxUsesPerUser: body.maxUsesPerUser,
          funder: 'VENDOR',
          termsVersion: 1,
        },
      });
      await recordPromoTermsVersion(tx, row.id, { createdBy: request.user.userId });
      return row;
    });
    return { success: true, data: promo };
  });

  /** PUT /promos/:id — pause/resume, extend, or reword an own code. */
  app.put<{ Params: IdParam }>('/promos/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const existing = await app.prisma.promoCode.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('PromoCode', request.params.id);

    const body = updatePromoSchema.parse(request.body);
    // [M-32] The MERGED record is validated (an end date before the stored
    // start is refused), and a change of terms writes an immutable new version.
    const promo = await updatePromoTerms(app.prisma, request.params.id, body, request.user.userId);
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
  /**
   * [DOC-1 §3.2/§3.6 · P3-2] POST /onboarding/declaration — the unregistered trader signs the
   * versioned self-declaration. One call does the whole thing, in this order: refuse if a
   * registration is already on file (then the tier is REGISTERED and the declaration is
   * moot); put the store on the UNREGISTERED tier; write the signature to the consent
   * ledger (words hashed, version pinned); render the signed declaration as a PDF and file
   * it as the BUSINESS document the tier's checklist requires. Owner only.
   */
  app.post('/onboarding/declaration', auth, async (request, reply) => {
    const access = await requireVendor(app, request, 'OWNER');
    const { vendorId } = access;
    const userId = request.user.userId;
    const body = z.object({
      tradingName: z.string().trim().min(2).max(80),
      activityClass: z.enum(ACTIVITY_CLASSES),
      declaredAddress: z.string().trim().min(5).max(200),
      attestationVersion: z.literal(DECLARATION_VERSION),
      privacyNoticeVersion: z.string().min(1).max(20).default(LEGAL_VERSION),
    }).parse(request.body ?? {});
    const [vendor, user, registered, existing] = await Promise.all([
      app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { id: true, name: true, tier: true, vendorType: true } }),
      app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { firstName: true, lastName: true, countryCode: true } }),
      validRegistrationRecord(app.prisma, userId),
      app.prisma.verificationDocument.findFirst({ where: { userId, docType: DECLARATION_DOC_TYPE, status: { in: ['PENDING', 'APPROVED'] } }, select: { id: true, status: true } }),
    ]);
    if (registered) throw new AppError(409, 'ALREADY_REGISTERED', 'A business registration is on file for this store, so it is a registered seller — no declaration is needed.');
    if (existing) throw new AppError(409, 'DECLARATION_EXISTS', `A self-declaration is already ${existing.status === 'APPROVED' ? 'on file' : 'under review'} for this store.`);

    await publishLegalDocumentOnce(app.prisma, { documentType: DECLARATION_CONSENT_TYPE, version: DECLARATION_VERSION, renderedText: UNREGISTERED_TRADER_DECLARATION_V1 });
    const signedAt = new Date();
    const platform = String(request.headers['x-client-platform'] ?? '').toLowerCase();
    const surface: ConsentSurface = platform === 'ios' || platform === 'android' ? platform : 'vendor_web';
    await app.prisma.$transaction(async (tx) => {
      await tx.vendor.update({ where: { id: vendorId }, data: { tier: 'UNREGISTERED', tierChangedAt: signedAt, tierNote: `self-declared unregistered trader (${body.activityClass}) — declaration ${DECLARATION_VERSION}` } });
      await recordConsent(tx, {
        subjectType: 'vendor_user', subjectId: userId, documentType: DECLARATION_CONSENT_TYPE, version: DECLARATION_VERSION,
        action: 'granted', surface, ip: request.ip,
        evidence: { vendorId, tradingName: body.tradingName, activityClass: body.activityClass, declaredAddress: body.declaredAddress, signedAt: signedAt.toISOString() },
      });
    });

    // The signed words, filed as the document the tier's checklist requires — encrypted like every upload.
    const pdf = await renderDeclarationPdf({
      tradingName: body.tradingName, activityClass: body.activityClass, declaredAddress: body.declaredAddress,
      legalName: `${user.firstName} ${user.lastName}`.trim(), signedAt, storeName: vendor.name,
    });
    const storage = getStorageProvider();
    const keys = getKeyProvider();
    let fileUrl: string;
    if (keys) {
      const dek = generateDek();
      const { ciphertext, iv, authTag } = encryptBuffer(pdf, dek);
      const up = await storage.upload({ buffer: ciphertext, filename: `declaration-${DECLARATION_VERSION}.pdf.enc`, mimeType: 'application/octet-stream', folder: `verification/${userId}` });
      fileUrl = up.url;
      await app.prisma.encryptedObject.create({ data: {
        fileKey: fileUrl, iv: new Uint8Array(iv), authTag: new Uint8Array(authTag), wrappedDek: new Uint8Array(await keys.wrapDek(dek)),
        mimeType: 'application/pdf', sizeBytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'), createdBy: userId,
      } });
    } else {
      fileUrl = (await storage.upload({ buffer: pdf, filename: `declaration-${DECLARATION_VERSION}.pdf`, mimeType: 'application/pdf', folder: `verification/${userId}` })).url;
    }
    const doc = await verification.submitDocument(userId, vendor.vendorType as 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE', DECLARATION_DOC_TYPE, fileUrl, body.privacyNoticeVersion);
    reply.code(201);
    return { success: true, data: { tier: 'UNREGISTERED', declaration: { id: doc.id, status: doc.status, docType: doc.docType }, status: await verification.getStatus(userId, vendor.vendorType as 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE') } };
  });

  /**
   * [DOC-1 §3.6 · P3-2] GET /tier — the store's tier as the owner sees it: caps, today's and this
   * week's usage, whether promoted placement is open, what would promote the store, and the
   * declaration on file. Everything is the server's; the screen decides nothing.
   */
  app.get('/tier', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const userId = request.user.userId;
    const { tierUsage, vendorTierCapsFor, judgeTierCap, validRegistrationRecord } = await import('./vendor-tier');
    const { CountryConfigService } = await import('../country/country-config.service');
    const { DECLARATION_DOC_TYPE, REGISTRATION_DOC_TYPES } = await import('../verification/doc-registry');
    const [vendor, user] = await Promise.all([
      app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { id: true, name: true, tier: true, tierChangedAt: true, isFeatured: true } }),
      app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { countryCode: true } }),
    ]);
    const now = new Date();
    const [caps, usage, registration, declaration, registrationDoc] = await Promise.all([
      vendorTierCapsFor(new CountryConfigService(app.prisma), user.countryCode),
      tierUsage(app.prisma, vendorId, now),
      validRegistrationRecord(app.prisma, userId, now),
      app.prisma.verificationDocument.findFirst({ where: { userId, docType: DECLARATION_DOC_TYPE }, orderBy: { createdAt: 'desc' }, select: { status: true, createdAt: true, expiresAt: true } }),
      app.prisma.verificationDocument.findFirst({ where: { userId, docType: { in: [...REGISTRATION_DOC_TYPES] } }, orderBy: { createdAt: 'desc' }, select: { status: true, createdAt: true } }),
    ]);
    const verdict = judgeTierCap(usage, caps, 0);
    return { success: true, data: {
      tier: vendor.tier, tierChangedAt: vendor.tierChangedAt?.toISOString() ?? null, capped: vendor.tier === 'UNREGISTERED',
      caps, usage: { ordersToday: usage.ordersToday, grossThisWeek: usage.grossThisWeek },
      nearCap: vendor.tier === 'UNREGISTERED' && verdict.nudge,
      promotedPlacement: vendor.tier !== 'UNREGISTERED',
      registration: registration ? { onFile: true, recordId: registration.id } : { onFile: false, submission: registrationDoc ? { status: registrationDoc.status, submittedAt: registrationDoc.createdAt.toISOString() } : null },
      declaration: declaration ? { status: declaration.status, signedAt: declaration.createdAt.toISOString(), expiresAt: declaration.expiresAt?.toISOString() ?? null } : null,
    } };
  });

  app.put('/profile', auth, async (request) => {
    const access = await requireVendor(app, request, 'MANAGER');
    const { vendorId } = access;
    const body = updateVendorProfileSchema.parse(request.body);
    const mmgPayUrl = body.mmgPayUrl === undefined
      ? undefined
      : mmgPayUrlForWrite(body.mmgPayUrl);
    // [ALG-34 / ALG-INV-14] The MMG pay link is where the store's money goes.
    // Owner only, step-up first; a new link is STAGED behind a cool-off with
    // the old one still live and the owner told (integrity/money-surface.ts).
    // Clearing it is immediate — it redirects nothing.
    if (mmgPayUrl !== undefined) {
      requireRole(access, 'OWNER');
      await requireStepUp(app, request);
      await assertVelocity(app, request, 'money.mmg-link'); // [R048-007] a money surface: fails closed when the control is down
    }
    // undefined = field not sent (leave as-is); null/'' = the store takes its
    // number down. publicPhoneForWrite collapses both of the latter to null.
    const publicPhone = body.publicPhone === undefined
      ? undefined
      : publicPhoneForWrite(body.publicPhone);

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
        ...(body.selfDeliveryEnabled !== undefined && { selfDeliveryEnabled: body.selfDeliveryEnabled }),
        ...(body.maxConcurrentOrders !== undefined && { maxConcurrentOrders: body.maxConcurrentOrders }),
        ...(publicPhone !== undefined && { publicPhone }),
      },
      include: { operatingHours: { orderBy: { dayOfWeek: 'asc' } } },
    });

    if (mmgPayUrl === null) {
      await clearMmgLink({ prisma: app.prisma, io: app.io, redis: app.redis }, { actor: 'VENDOR', entityId: vendorId, userId: request.user.userId });
    } else if (mmgPayUrl !== undefined) {
      await stageMmgLinkChange({ prisma: app.prisma, io: app.io, redis: app.redis }, {
        actor: 'VENDOR', entityId: vendorId, userId: request.user.userId, sessionId: request.authSessionId, newUrl: mmgPayUrl,
      });
    }
    // The link state is read back AFTER staging so the response says what is
    // live and what is pending — never the value the caller sent.
    const link = await app.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId }, select: { mmgPayUrl: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true },
    });

    // On-write search sync [SWIFT-UG-SRCH-01]: catalog writes schedule a debounced per-vendor reindex.
    scheduleVendorSearchSync(app, vendorId);

    return {
      success: true,
      data: {
        ...vendor,
        ...link,
        mmgPayUrl: safeMmgPayUrl(link.mmgPayUrl),
        mmgPayUrlPending: safeMmgPayUrl(link.mmgPayUrlPending),
      },
    };
  });

  /** DELETE /profile/mmg-pay-url/pending — "this wasn't me": drop a staged
   *  link change and sign out every other device. Owner only; no step-up —
   *  cancelling is always the safe direction. */
  app.delete('/profile/mmg-pay-url/pending', auth, async (request) => {
    await assertVelocity(app, request, 'money.mmg-link.cancel'); // [R048-007]
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const data = await cancelMmgLinkChange({ prisma: app.prisma, io: app.io, redis: app.redis }, {
      actor: 'VENDOR', entityId: vendorId, userId: request.user.userId, keepSessionId: request.authSessionId,
    });
    return { success: true, data };
  });

  // =========================================================================
  // 2. VENDOR MANAGEMENT — Toggle open / accepting orders
  // =========================================================================

  /** PUT /vendor/toggle-open — Toggle isCurrentlyOpen */
  app.put('/vendor/toggle-open', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });

    // [EV-ACT-14] OPENING needs a live store: a suspended/pending business
    // flipping this switch is invisible to customers anyway (public browse
    // requires ACTIVE) — refuse honestly instead of silently doing nothing
    // visible. CLOSING is always allowed.
    if (!vendor.isCurrentlyOpen && vendor.status !== 'ACTIVE') {
      throw new AppError(409, 'VENDOR_NOT_ACTIVE', 'Your store isn’t live yet — it opens to customers once it’s approved and active.');
    }

    // [EV-ACT-14 / REPORT-010 F-06] Atomic flip bound to the OBSERVED value
    // AND — when turning ON — the lifecycle authority that approved it: a
    // suspension committing between the preview and this write must beat the
    // stale request, not lose to it. Racing same-value taps still have one
    // winner.
    const flipped = await app.prisma.vendor.updateMany({
      where: {
        id: vendorId,
        isCurrentlyOpen: vendor.isCurrentlyOpen,
        ...(vendor.isCurrentlyOpen ? {} : { status: 'ACTIVE' }),
      },
      data: { isCurrentlyOpen: !vendor.isCurrentlyOpen },
    });
    if (flipped.count === 0 && !vendor.isCurrentlyOpen) {
      const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { status: true } });
      if (fresh.status !== 'ACTIVE') {
        throw new AppError(409, 'VENDOR_NOT_ACTIVE', 'Your store isn’t live right now — approval or reinstatement reopens it.');
      }
    }

    // SWIFT-102: was a GLOBAL io.emit('vendor:status') to EVERY connected socket
    // with zero listeners — noise + a privacy smell, no consumer. Deleted (rule
    // 17); a storefront-watch feature would emit to a `vendor:<id>` room instead.

    if (flipped.count > 0) scheduleVendorSearchSync(app, vendorId);

    const updated = await app.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { isCurrentlyOpen: true, acceptingOrders: true },
    });
    return { success: true, data: { isCurrentlyOpen: updated.isCurrentlyOpen, acceptingOrders: updated.acceptingOrders } };
  });

  /** PUT /vendor/toggle-orders — Toggle acceptingOrders */
  app.put('/vendor/toggle-orders', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });

    // Turning OFF is always allowed and needs no authority — a fast atomic flip.
    if (vendor.acceptingOrders) {
      await app.prisma.vendor.updateMany({
        where: { id: vendorId, acceptingOrders: true },
        data: { acceptingOrders: false },
      });
      const off = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { isCurrentlyOpen: true, acceptingOrders: true } });
      return { success: true, data: { isCurrentlyOpen: off.isCurrentlyOpen, acceptingOrders: off.acceptingOrders } };
    }

    // [EV-ACT-14 / REPORT-011 F-03] Turning commerce ON authorizes from THREE
    // facts (ACTIVE lifecycle, verified documents, operable subscription) —
    // all three must be bound at the write's linearization point, not merely
    // checked before it. A concurrent admin/billing suspension, a document
    // revocation, or a grace lapse committing after the preview must beat the
    // stale request. The vendor row lock is the serialization point: the
    // competing suspend writers touch this same row, so either they land
    // first (this re-read sees the loss and refuses) or this ON write commits
    // first (they simply win afterward).
    const verified = vendor.isVerified
      || await verification.isRoleVerified(await vendorOwnerUserId(app, vendorId), vendor.vendorType);
    if (!verified) {
      throw new AppError(403, 'VERIFICATION_REQUIRED',
        'Your store can take orders once its documents are verified. Check Documents for anything missing or expired.');
    }

    let staleVerifiedToHeal = false;
    await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "vendors" WHERE id = ${vendorId} FOR UPDATE`;
      // Re-read the authority generation UNDER the lock — every fact fresh.
      const locked = await tx.vendor.findUniqueOrThrow({
        where: { id: vendorId },
        select: { status: true, isVerified: true, acceptingOrders: true, vendorType: true },
      });
      if (locked.acceptingOrders) return; // a concurrent ON already won — idempotent
      if (locked.status !== 'ACTIVE') {
        throw new AppError(409, 'VENDOR_NOT_ACTIVE',
          'Your store isn’t active right now, so it can’t take orders. Approval or reinstatement switches it back on.');
      }
      // [REPORT-012 F-012-05 / REPORT-013 F-013-08] Turning commerce ON
      // evaluates LIVE document truth on THIS transaction — the cached
      // isVerified flag can be stale-true when evidence was invalidated by a
      // path whose projection hasn't landed. NO implicit grandfather: the
      // zero-evidence-rows carve-out was rejected in review (the daily
      // reconciler revokes exactly that state, the predicate wasn't
      // serialized against first-document insertion, and absence proves no
      // grant). Until the founder's slice-2d explicit grandfather records
      // exist, this fails CLOSED — consistent with the reconciler's law.
      // A discovered stale-true is healed post-rollback (a write inside
      // this refusing transaction would roll back with it).
      const toggleOwnerUserId = await vendorOwnerUserId(app, vendorId);
      const verifiedOk = await verification.isRoleVerified(toggleOwnerUserId, locked.vendorType, tx);
      if (!verifiedOk) {
        if (locked.isVerified) staleVerifiedToHeal = true;
        throw new AppError(403, 'VERIFICATION_REQUIRED',
          'Your store can take orders once its documents are verified. Check Documents for anything missing or expired.');
      }
      // Subscription re-evaluated under the same lock (grace lapse included).
      const sub = await tx.subscription.findFirst({ where: { vendorId }, orderBy: { createdAt: 'desc' } });
      const toggleOperability = subscriptionOperability(sub, { missingRow: 'GRANDFATHER' });
      if (!toggleOperability.operable) {
        if (toggleOperability.why === 'GRACE_LAPSED') {
          throw new AppError(403, 'SUBSCRIPTION_PAST_DUE',
            'Your grace period has ended — pay this week’s fee to reopen your store.');
        }
        throw new AppError(403, 'SUBSCRIPTION_INACTIVE',
          'Your subscription must be active to accept orders. Renew from Account to reopen your store.');
      }
      // Bind the observed generation in the write: status ACTIVE + the exact
      // verified value re-read above. A suspension or de-verify racing us
      // matches nothing (it changed one of these) — but it cannot, because it
      // waits on the FOR UPDATE lock this transaction holds.
      const won = await tx.vendor.updateMany({
        where: { id: vendorId, acceptingOrders: false, status: 'ACTIVE', isVerified: locked.isVerified },
        data: { acceptingOrders: true },
      });
      if (won.count === 0) {
        throw new AppError(409, 'VENDOR_NOT_ACTIVE',
          'Your store’s status just changed — refresh and try again.');
      }
    }).catch(async (err) => {
      if (staleVerifiedToHeal) {
        // The refusal rolled its transaction back — heal the stale cached
        // flag in its own atomic write, re-proving documents under a fresh
        // lock so a legitimate re-verification racing us is never clobbered.
        await app.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "vendors" WHERE id = ${vendorId} FOR UPDATE`;
          const still = await tx.vendor.findUniqueOrThrow({
            where: { id: vendorId }, select: { isVerified: true, vendorType: true },
          });
          if (!still.isVerified) return;
          const nowVerified = await verification.isRoleVerified(
            await vendorOwnerUserId(app, vendorId), still.vendorType, tx);
          if (!nowVerified) {
            await tx.vendor.updateMany({
              where: { id: vendorId, isVerified: true },
              data: { isVerified: false, acceptingOrders: false },
            });
          }
        }).catch(() => {});
      }
      throw err;
    });

    // SWIFT-102: global vendor:status emit deleted (zero listeners) — see above.

    const updated = await app.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: { isCurrentlyOpen: true, acceptingOrders: true },
    });
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
        // HND-003: strip handover secrets from the vendor board too (see resolveOwnedOrder).
        omit: { pickupCode: true, pickupCodeAttempts: true, ridePin: true },
        include: {
          items: true,
          customer: { select: { id: true, firstName: true, lastName: true, avatar: true } },
          // [F-027-07] allow-list, not `include` — see utils/counterparty.
          rider: { select: riderCounterpartySelect({ withPhone: true }) },
          // Franchise roll-up: the board aggregates every store the owner has, so each
          // order needs to say which store it belongs to.
          vendor: { select: { id: true, name: true, selfDeliveryEnabled: true } },
        },
        orderBy: { placedAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      app.prisma.order.count({ where }),
    ]);

    // [S1] Decimal → number BEFORE the shared paginator sees the rows. The
    // board's order totals AND every line's snapshotted prices; the web
    // storefront's `$NaN` came from exactly these strings.
    // The response-SLA deadline rides on the read so the board's accept-clock
    // drains toward the auto-cancel cut-off the server actually enforces.
    const respondOpts = { slaMinutes: await vendorResponseSlaMinutes(app.prisma), holdMs: holdWindowMs() ?? 0 };
    const data = orders.map((order) => ({
      ...coerceMoney(order, ORDER_MONEY_FIELDS),
      items: order.items.map((item) => coerceMoney(item, ORDER_ITEM_MONEY_FIELDS)),
      respondBy: vendorRespondBy(order, respondOpts),
    }));

    return { success: true, ...paginatedResponse(data, total, pagination) };
  });

  /** GET /orders/:id — Full order detail */
  app.get<{ Params: IdParam }>('/orders/:id', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    // The takeover polls this read: the response-SLA deadline is computed here,
    // from the same inputs the auto-cancel job was enqueued with.
    const respondBy = vendorRespondBy(order, { slaMinutes: await vendorResponseSlaMinutes(app.prisma), holdMs: holdWindowMs() ?? 0 });
    return { success: true, data: { ...order, respondBy } };
  });

  /** PUT /orders/:id/accept — Accept an incoming order */
  app.put<{ Params: IdParam }>('/orders/:id/accept', auth, async (request) => {
    // Alert-delivery ack (§A4): the store ACTED on this order's alert.
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(app.prisma, 'VENDOR_ORDER', request.params.id).catch(() => {});
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    await assertVendorCanOperate(order.vendorId!);
    if (order.status !== 'PENDING') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot accept order in ${order.status} status`);
    }
    // [SPS-F-0016] Payment-first: an MMG order is accepted only after the store
    // confirmed the payment landed (its Confirm-payment action stays available
    // while pending — it IS the capture). Early gate so the appointment slot
    // below is never reserved for an order that cannot proceed; the canonical
    // transition seam re-checks on the locked row.
    assertMmgFulfilmentAllowed(order, 'ACCEPTED');
    const body = acceptOrderSchema.parse(request.body ?? {});

    // Appointment orders book their slot AT ACCEPTANCE (locked model). If the
    // slot was taken since checkout, this 409s and the order stays PENDING —
    // the customer picks a new time instead of holding a phantom booking.
    // [REPORT-007-v4 F-05] The reservation and prep-time write ride the SAME
    // Order-lock transaction as the ACCEPTED transition: a concurrent
    // cancellation serializes on that lock, so acceptance can no longer lose
    // the race yet leave behind a CONFIRMED slot-blocking booking (its throw
    // rolls the booking back with the transition).
    const appointmentItemId = order.fulfillment === 'APPOINTMENT' && order.appointmentSlot
      ? order.items[0]?.itemId ?? null
      : null;
    const updated = await orderService.updateStatus(order.id, 'ACCEPTED', request.user.userId, 'Accepted by vendor', {
      withinTransaction: async (tx) => {
        if (appointmentItemId && order.appointmentSlot) {
          await bookingService.reserveSlot(appointmentItemId, order.customerId, order.appointmentSlot, order.id, tx);
        }
        if (body.estimatedPrepTime) {
          await tx.order.update({
            where: { id: order.id },
            data: { estimatedPrepTime: body.estimatedPrepTime },
          });
        }
      },
    });
    if (appointmentItemId) await bookingService.nudgeForItem(appointmentItemId).catch(() => {});
    await ackVendorAlert(app, request.user.userId, order.id); // accepting acknowledges the alert

    // acceptance of a DELIVERY order starts the dispatch cascade (PICKUP and
    // APPOINTMENT orders never dispatch). FUL-005: this is the ON_ACCEPT trigger
    // (the default) — the rider travels to the store during prep. ON_READY
    // defers dispatch to the Mark-ready transition below instead.
    if (order.fulfillment === 'DELIVERY' && dispatchTrigger() === 'ON_ACCEPT') {
      // FUL-004b: resolve who delivers (vendor default / prior override), record
      // it, and dispatch a platform rider ONLY for PLATFORM_RIDER — VENDOR_DELIVERY
      // means the vendor's own courier delivers, so no rider is pinged.
      const mode = resolveDeliveryMode(order.fulfillmentMode, order.vendor?.selfDeliveryEnabled ?? false);
      await app.prisma.order.update({ where: { id: order.id }, data: { fulfillmentMode: mode } });
      if (mode === 'PLATFORM_RIDER') await enqueueDeliveryDispatch(app, order);
    }

    return { success: true, data: updated };
  });

  /** Statuses where a rider already owns the status lane. Kitchen progress
   *  then rides the preparingAt/readyAt timestamps instead of the status —
   *  without this, a rider accepting within seconds of the vendor (the normal
   *  case) killed the vendor's Start-preparing/Mark-ready buttons with 400s. */
  const COURIER_ACTIVE: string[] = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'];

  async function recordPrepProgress(
    order: {
      id: string; status: OrderStatus; vendorId: string | null; riderId: string | null;
      orderNumber: string; preparingAt: Date | null; paymentMethod: string | null;
      paymentStatus: string; orderType: string | null;
    },
    phase: 'PREPARING' | 'READY',
    userId: string,
  ) {
    // [SPS-F-0016 / REPORT-004 F-004-05] Milestone timestamps are the ALTERNATE
    // representation of preparing/ready when a rider owns the status lane — the
    // payment-first law applies to them exactly as it does to the transitions.
    assertMmgFulfilmentAllowed(order, phase === 'PREPARING' ? 'PREPARING' : 'READY_FOR_PICKUP');
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
    await assertVendorCanOperate(order.vendorId!);
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
    await assertVendorCanOperate(order.vendorId!);
    // Grocery/goods picking gate (§5.3): the bag never closes with an open
    // question in it — every line picked, or its substitution resolved.
    // Restaurants don't shelf-pick, so only quantity-tracked store types gate.
    if (order.vendorId) {
      const v = await app.prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { vendorType: true } });
      if (v && ['SUPERMARKET', 'STORE'].includes(v.vendorType)) {
        const state = await picking.readiness(order.id);
        if (state.unresolved > 0) {
          throw new AppError(409, 'PICKING_INCOMPLETE', `${state.unresolved} line${state.unresolved === 1 ? '' : 's'} still need picking or a substitution decision`);
        }
        // [W-28] Settled is not fulfilled. If every line was refunded or the
        // customer rejected every substitute, the bag is empty: marking this
        // ready dispatches a rider to collect nothing and charges the customer
        // a delivery fee for it. An empty order is cancelled, not delivered.
        if (state.fulfilled === 0) {
          pickingReadinessCounter.labels('refused_empty').inc();
          throw new AppError(
            409,
            'NOTHING_TO_HAND_OVER',
            state.total === 0
              ? 'This order has no lines to hand over.'
              : `All ${state.total} line${state.total === 1 ? '' : 's'} were removed — there is nothing to hand over. Cancel the order instead so the customer is refunded.`,
          );
        }
        pickingReadinessCounter.labels(state.removed > 0 ? 'ready_partial' : 'ready_complete').inc();
      }
    }
    if (order.status === 'PREPARING') {
      const updated = await orderService.updateStatus(order.id, 'READY_FOR_PICKUP', request.user.userId, 'Order ready for pickup');
      // FUL-005: ON_READY — dispatch NOW, when the food is ready, not at accept.
      // No-op under the ON_ACCEPT default (the rider was already dispatched); and
      // never dispatches if a rider is already assigned.
      if (order.fulfillment === 'DELIVERY' && !order.riderId && dispatchTrigger() === 'ON_READY') {
        // FUL-004b: same resolution as at accept — VENDOR_DELIVERY skips the rider.
        const mode = resolveDeliveryMode(order.fulfillmentMode, order.vendor?.selfDeliveryEnabled ?? false);
        await app.prisma.order.update({ where: { id: order.id }, data: { fulfillmentMode: mode } });
        if (mode === 'PLATFORM_RIDER') await enqueueDeliveryDispatch(app, order);
      }
      return { success: true, data: updated };
    }
    if (COURIER_ACTIVE.includes(order.status)) {
      if (order.readyAt) return { success: true, data: order }; // double-tap safe
      const updated = await recordPrepProgress(order, 'READY', request.user.userId);
      return { success: true, data: updated };
    }
    throw new AppError(400, 'INVALID_STATUS', `Cannot mark as ready from ${order.status} status`);
  });

  /** PUT /orders/:id/fulfillment-mode — FUL-004d: the vendor's one-tap choice of
   *  who delivers. VENDOR_DELIVERY = "we'll deliver it ourselves"; PLATFORM_RIDER
   *  = "get a rider instead" — which dispatches a rider if none is assigned yet,
   *  the fallback that stops a self-delivery order dying in the kitchen. */
  app.put<{ Params: IdParam }>('/orders/:id/fulfillment-mode', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    const { mode } = fulfillmentModeSchema.parse(request.body);
    if (order.fulfillment !== 'DELIVERY') {
      throw new AppError(400, 'NOT_DELIVERY', 'Only delivery orders have a fulfillment mode');
    }
    if (['DELIVERED', 'CANCELLED', 'FAILED', 'COMPLETED'].includes(order.status)) {
      throw new AppError(409, 'ORDER_CLOSED', 'This order is already closed');
    }
    if (mode === 'VENDOR_DELIVERY' && !order.vendor?.selfDeliveryEnabled) {
      throw new AppError(400, 'SELF_DELIVERY_DISABLED', 'Turn on self-delivery in settings first');
    }
    await app.prisma.order.update({ where: { id: order.id }, data: { fulfillmentMode: mode } });
    // Fallback: "get a rider instead" dispatches a platform rider now if none is
    // on it yet. VENDOR_DELIVERY needs no rider — the vendor's own courier delivers.
    if (mode === 'PLATFORM_RIDER' && !order.riderId) {
      await enqueueDeliveryDispatch(app, order);
    }
    return { success: true, data: { orderId: order.id, fulfillmentMode: mode } };
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

    // [MKT-2] Through the single writer, so the vendor's own correction lands in
    // the same ledger as the sales it is correcting. Still guarded: stock can't
    // be adjusted below zero — the writer's conditional decrement enforces it.
    // In a TRANSACTION. applyStockMovement's own contract says it must be —
    // it moves the counter and writes the ledger row in two statements, so
    // outside a transaction a crash between them leaves the cache and the truth
    // disagreeing, which is the exact failure the ledger exists to prevent.
    await app.prisma.$transaction((tx) => applyStockMovement(tx, {
      itemId: item.id,
      delta: body.delta,
      reason: body.reason,
      actorId: request.user.userId,
      note: body.note ?? null,
    })).catch((err) => {
      if (err instanceof AppError && err.code === 'INSUFFICIENT_STOCK') {
        throw new AppError(409, 'INSUFFICIENT_STOCK', 'That would take the stock below zero');
      }
      throw err;
    });
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
    // [REPORT-005 F-005-03 tail / REPORT-006 F-006-01] A capture needs a live
    // order to attach to: confirming "the money landed" on a cancelled/
    // refunded/failed order would mint a CAPTURED row with no fulfilment and
    // no refund obligation. The store keeps the customer whole directly on its
    // own rail. Checked BEFORE the idempotent fast path — a legacy
    // CAPTURED+closed row must answer with this refusal, never a success —
    // and re-checked from the LOCKED row inside the transaction (this preview
    // is UX-only; the lock is the authority).
    // [W-25] The store's word is the only signal on this rail, so it is
    // admissible only where money plausibly landed and nothing has reversed
    // it, and only with the provider reference from the wallet's own message.
    const reference = normaliseMmgReference((request.body as { reference?: unknown } | null)?.reference);
    assertMmgAttestable(order);

    const ORDER_CLOSED_STATUSES = ['CANCELLED', 'REFUNDED', 'FAILED'];
    const orderClosedError = () => new AppError(
      409,
      'ORDER_CLOSED',
      'This order is closed — if the customer already paid by MMG, refund them directly from your MMG.',
    );
    if (ORDER_CLOSED_STATUSES.includes(order.status)) throw orderClosedError();
    if (order.paymentStatus === 'CAPTURED') {
      return { success: true, data: order }; // double-tap safe (fast path)
    }
    // Serialize the capture on the SAME orders row lock every negative
    // terminalizer takes (customer cancel, vendor reject, admin cancel,
    // auto-cancel) [REPORT-006 F-006-01]: cancel-first → the locked fresh read
    // below sees CANCELLED and refuses; capture-first → the cancel paths see
    // CAPTURED under their lock and refuse. The CAS keeps lifecycle + payment
    // predicates as defense in depth, and two concurrent confirm taps by store
    // staff still have exactly one winner (no duplicate push).
    const capture = await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} FOR UPDATE`;
      // [REPORT-005 F-005-04] The vendor is the pickup-code VERIFIER: every
      // read here must omit handover secrets exactly like resolveOwnedOrder,
      // or this response hands the verifier the code (and the ride PIN).
      const locked = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        omit: HANDOVER_SECRETS_OMIT,
      });
      if (ORDER_CLOSED_STATUSES.includes(locked.status)) throw orderClosedError();
      // [W-25] the preview above is UX; THIS is the authority — a payment that
      // failed or was reversed between the tap and the lock is refused here
      assertMmgAttestable(locked);
      if (locked.paymentStatus === 'CAPTURED' || locked.paymentStatus === 'CLAIMED') {
        return { won: false, order: locked }; // idempotent under the lock
      }
      // [DOC-1 §31.5 · DOC-INV-48 · P31-2] The store's word is a CLAIM. It lands as CLAIMED —
      // never CAPTURED, which is reserved for a provider's own evidence — so nothing
      // downstream can read a person's attestation as a settled fact.
      const cas = await tx.order.updateMany({
        where: {
          id: order.id,
          paymentStatus: { notIn: ['CAPTURED', 'CLAIMED'] },
          status: { notIn: ORDER_CLOSED_STATUSES as OrderStatus[] },
        },
        data: { paymentStatus: 'CLAIMED' },
      });
      // [LB-015 / REPORT-004 F-004-08] The capture and its evidence row commit
      // or vanish together, the evidence records the FRESH lifecycle status
      // (never a pre-transaction preview), and both the CAS winner and a
      // concurrent double-tap loser answer with the fresh row — a loser must
      // not report stale PENDING after the database says CAPTURED.
      const fresh = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        omit: HANDOVER_SECRETS_OMIT,
      });
      if (cas.count > 0) {
        // [W-25] The capture and the evidence behind it commit together: the
        // provider reference, who attested and when, plus an audit row naming
        // the amount and the destination. A reference already spent on another
        // order fails the whole transaction — one payment, one order.
        const attested = await recordVendorAttestation(tx, {
          orderId: order.id,
          reference,
          actorId: request.user.userId,
          amount: fresh.totalAmount,
          recipientName: fresh.mmgRecipientNameSnapshot,
        });
        if (!attested.ok) {
          mmgAttestationCounter.labels('reference_reused').inc();
          throw new AppError(
            409,
            'REFERENCE_ALREADY_USED',
            'That MMG reference is already recorded against another order. One payment settles one order.',
          );
        }
        await tx.orderStatusLog.create({
          data: { orderId: order.id, status: fresh.status, changedBy: request.user.userId, note: `MMG payment attested by the store (ref ${reference})` },
        });
        // [DOC-1 §31.6] Every money event is somebody's assertion: who claimed what, when, on what evidence.
        await tx.auditLog.create({ data: {
          userId: request.user.userId, action: 'VENDOR_CLAIMED_PAYMENT_RECEIVED', entity: 'Order', entityId: order.id,
          changes: { reference, amount: String(fresh.totalAmount), claim: 'payment_claimed_by_vendor' },
        } });
      }
      return { won: cas.count > 0, order: fresh };
    });
    if (!capture.won) return { success: true, data: capture.order };
    mmgAttestationCounter.labels('attested').inc();
    const updated = capture.order;
    app.io.to(`order:${order.id}`).emit('order:status_changed', { orderId: order.id, status: updated.status, paymentStatus: 'CLAIMED' });
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

  /** GET /cash-settlements — MMG direct-pay ledger: delivery pay (fee + tip)
   *  this store owes riders in cash (the customer's MMG payment landed in the
   *  store's wallet, fee and tip included). Scoped like the order board:
   *  selected store, else all. Distinct from /settlements, the weekly billing
   *  history. */
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
    // [W-26] The confirmer states the amount they handed over; the ledger
    // refuses any figure that is not its own. A one-click close of a real cash
    // debt left nothing to reconstruct — not the person, not the figure.
    const { amount } = settlementAttestationSchema.parse(request.body ?? {});
    const data = await settlementLedger.confirm(
      assertSettlementId(request.params.id),
      'STORE',
      { vendorIds: access.vendorIds },
      { actorId: request.user.userId, amount },
    );
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
    await assertVendorCanOperate(order.vendorId!);
    if (order.fulfillment !== 'PICKUP') {
      throw new AppError(400, 'NOT_A_PICKUP', 'This order is not a pickup order.');
    }
    if (order.status !== 'READY_FOR_PICKUP') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot complete pickup from ${order.status} status`);
    }
    const { code } = completePickupSchema.parse(request.body ?? {});
    // HND-003: the shared vendor order object never carries the code (the vendor
    // is the verifier). Read the secret ONLY here, where it's actually checked.
    const secret = await app.prisma.order.findUnique({
      where: { id: order.id },
      select: { pickupCode: true, pickupCodeAttempts: true },
    });
    // SWIFT-077: when a pickup code is set, it is REQUIRED — it's the only proof
    // the person collecting is the customer (mirrors the taxi ride PIN). The old
    // check let a missing code through (`code != null`), so the handover could be
    // closed without ever verifying it — anyone could claim the order.
    if (secret?.pickupCode) {
      if (code == null || code === '') {
        throw new AppError(400, 'MISSING_PICKUP_CODE', "Enter the customer's pickup code to hand over this order.");
      }
      // HND-001: brute-force lockout, parity with the taxi ride PIN. A 6-digit
      // code is guessable without it. Refuse once the budget is spent, then
      // count this try BEFORE comparing so a wrong guess always burns an attempt.
      const { locked, remaining } = handoverAttemptState(secret.pickupCodeAttempts);
      if (locked) {
        throw new AppError(400, 'MAX_ATTEMPTS', 'Too many incorrect pickup-code attempts on this order. Please contact support.');
      }
      await app.prisma.order.update({ where: { id: order.id }, data: { pickupCodeAttempts: { increment: 1 } } });
      if (code !== secret.pickupCode) {
        throw new AppError(400, 'WRONG_PICKUP_CODE', `That pickup code does not match. ${remaining} attempt(s) remaining.`);
      }
    }
    const updated = await orderService.updateStatus(order.id, 'COMPLETED', request.user.userId, 'Picked up by customer');
    return { success: true, data: updated };
  });

  /** PUT /orders/:id/complete-appointment — Service: vendor marks the appointment done.
   *  APPOINTMENT orders skip prepare/ready/dispatch; they go ACCEPTED -> COMPLETED. */
  app.put<{ Params: IdParam }>('/orders/:id/complete-appointment', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    await assertVendorCanOperate(order.vendorId!);
    if (order.fulfillment !== 'APPOINTMENT') {
      throw new AppError(400, 'NOT_AN_APPOINTMENT', 'This order is not an appointment.');
    }
    if (order.status !== 'ACCEPTED') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot complete appointment from ${order.status} status`);
    }
    const updated = await orderService.updateStatus(order.id, 'COMPLETED', request.user.userId, 'Appointment completed by vendor');
    return { success: true, data: updated };
  });

  /** PUT /orders/:id/delivered — [F-0026] the self-delivery terminal.
   *
   *  FUL-004b lets a vendor fulfil a DELIVERY order with its own courier: the
   *  mode resolves to VENDOR_DELIVERY at accept/ready and NO platform rider is
   *  dispatched. That left the order with no exit — the vendor could not use
   *  complete-pickup (it requires fulfillment PICKUP) and no rider could touch
   *  it (every rider route requires order.riderId), so it stranded in
   *  READY_FOR_PICKUP forever, held a kitchen-capacity slot, and kept the
   *  dispatch reconciler offering it to riders.
   *
   *  This is the vendor asserting their own driver handed the food over. The
   *  mode check is the barrier that keeps it out of the platform-rider lane:
   *  a PLATFORM_RIDER order must go through the rider's own /delivered, which
   *  carries the cash-capture gate and the PIN check. */
  app.put<{ Params: IdParam }>('/orders/:id/delivered', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id);
    await assertVendorCanOperate(order.vendorId!);
    if (order.fulfillmentMode !== 'VENDOR_DELIVERY') {
      throw new AppError(400, 'NOT_SELF_DELIVERY', 'This order is being delivered by a Swift rider — they complete it from their app.');
    }
    if (order.status !== 'READY_FOR_PICKUP') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot mark delivered from ${order.status} status`);
    }
    // updateStatus is the CAS: a concurrent cancel (or a double-tap) matches
    // nothing and throws, so exactly one transition and one status-log row.
    const updated = await orderService.updateStatus(order.id, 'DELIVERED', request.user.userId, 'Delivered by the store');
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

    // The locked transition re-reads the current status, then commits status,
    // stock, booking/search closure, float/mover release, and immutable evidence
    // together. A direct assignment that wins first changes the source to
    // RIDER_ASSIGNED, so this reject loses cleanly instead of acting on stale
    // riderId state; a double-tap still has exactly one winner.
    await orderService.transitionOrderAtomically({
      orderId: order.id,
      target: 'CANCELLED',
      allowedFrom: rejectableStatuses as OrderStatus[],
      changedBy: request.user.userId,
      note: reason,
      cancellation: { by: request.user.userId, reason },
      releaseStaleMoverPointer: true,
      invalidStatus: () => new AppError(400, 'INVALID_STATUS', 'This order can no longer be rejected'),
    });
    const updated = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { customer: { select: { id: true, firstName: true } } },
    });

    const rejectEvent = { orderId: order.id, status: 'CANCELLED', reason, timestamp: new Date().toISOString() };
    app.io.to(`order:${order.id}`).emit('order:status_changed', rejectEvent);
    if (order.vendorId) {
      app.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', rejectEvent);
    }

    // Tell the CUSTOMER, with the reason — parity with the admin-cancel path
    // [SWIFT-024]. The socket event only reaches a client already on the order
    // screen; a customer whose app is closed or elsewhere would otherwise never
    // learn their order was declined (it just silently vanished).
    // [REPORT-010 F-03] An unattested-MMG decline carries the refund guidance
    // — the customer may have already paid the store's link.
    const mmgGuidance = order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus === 'PENDING'
      ? ' If you already sent the MMG payment, the store refunds you directly.'
      : '';
    await notifications.send({
      userId: updated.customer.id,
      type: 'ORDER_UPDATE',
      title: 'Order declined',
      body: `Your order ${updated.orderNumber} was declined by the store. ${reason}${mmgGuidance}`.trim(),
      data: { orderId: order.id, status: 'CANCELLED' },
    });

    return { success: true, data: updated };
  });

  // =========================================================================
  // 4. MENU — Categories
  // =========================================================================

  /** GET /categories — List all categories for the vendor */
  app.get('/categories', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    return { success: true, data: await menu.listCategories(vendorId) };
  });

  /** POST /categories — Create a category */
  app.post('/categories', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const body = createCategorySchema.parse(request.body);
    const category = await menu.createCategory(vendorId, body);
    scheduleVendorSearchSync(app, vendorId);
    return { success: true, data: category };
  });

  /** PUT /categories/:id — Update a category */
  app.put<{ Params: IdParam }>('/categories/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const body = updateCategorySchema.parse(request.body);
    const category = await menu.updateCategory(vendorId, request.params.id, body);
    scheduleVendorSearchSync(app, vendorId);
    return { success: true, data: category };
  });

  /** DELETE /categories/:id — Delete a category (and its items) */
  app.delete<{ Params: IdParam }>('/categories/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { itemsRemoved, removedItemIds } = await menu.deleteCategory(vendorId, request.params.id);

    // hard delete: no sweep could find these rows later [SWIFT-UG-SRCH-01]
    const search = new SearchService(app.prisma);
    for (const itemId of removedItemIds) search.removeItemDoc(itemId).catch(() => {});
    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: { deleted: true, itemsRemoved } };
  });

  /** PUT /categories/reorder — Bulk reorder categories */
  app.put('/categories/reorder', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const body = reorderCategoriesSchema.parse(request.body);
    const categories = await menu.reorderCategories(vendorId, body.order);
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
    // [S1] `basePrice` is Decimal(10,2) and every option's `additionalPrice`
    // is too — raw rows shipped both as strings to the menu editor, the web
    // storefront and the POS.
    const data = items.map((item) => ({
      ...coerceMoney(withBulkWord(item), ITEM_MONEY_FIELDS),
      optionGroups: item.optionGroups.map((group) => ({
        ...group,
        options: group.options.map((option) => coerceMoney(option, OPTION_MONEY_FIELDS)),
      })),
    }));
    return { success: true, data };
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
        ...(body.bulk !== undefined ? { bulkUnits: bulkUnitsForChoice(body.bulk) } : {}),
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

    // [MKT-2] The ledger has to explain the stock this item was born with, or
    // it reads as drifted by exactly its own starting quantity forever.
    await recordOpeningBalance(app.prisma, item.id, body.stockQuantity, request.user.userId);

    scheduleVendorSearchSync(app, vendorId);
    // Stage-A categorizer reacts to what the vendor just typed (#17) —
    // fire-and-forget; suggestions are garnish, the save never waits.
    void discovery.runMatcherForItem(item).catch(() => undefined);

    return { success: true, data: withBulkWord(item) };
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // A crafted PDF (a "bomb": a tiny file that decompresses to millions of
        // pages) can make getText() churn CPU/memory for a long time even within
        // the 5MB upload cap. Bound it — a real menu parses in well under a second.
        const parsed = await Promise.race([
          parser.getText(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('menu PDF parse exceeded its time budget')), 15_000);
          }),
        ]);
        text = (parsed.text ?? '').trim();
      } finally {
        if (timer) clearTimeout(timer);
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

    // [MKT-2] STOCK IS NOT AN ORDINARY FIELD ON THIS FORM.
    //
    // Editing an item used to set `stockQuantity` directly alongside name and
    // price, which walked straight past the ledger: the counter moved and
    // nothing recorded why, so a reconciliation would report drift for a change
    // the vendor made deliberately.
    //
    // Setting an absolute quantity IS a movement — it is a stock count, so the
    // delta is (new - old) and the reason is RECONCILE. Handled after the row
    // update, through the single writer.
    const stockTarget = body.stockQuantity;

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
        ...(body.bulk !== undefined && { bulkUnits: bulkUnitsForChoice(body.bulk) }),
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

    // [MKT-2] THE STOCK COUNT, through the single writer.
    //
    // The vendor set an absolute quantity; the ledger records movements. So the
    // delta is (what they typed - what was there) and the reason is RECONCILE —
    // a human counting a shelf and correcting the system. An item that does not
    // track stock is left alone, and a no-change edit writes nothing.
    let newBalance: number | null = null;
    if (stockTarget !== undefined && stockTarget !== null && existing.stockQuantity !== null) {
      const delta = stockTarget - existing.stockQuantity;
      if (delta !== 0) {
        const moved = await app.prisma.$transaction((tx) => applyStockMovement(tx, {
          itemId: item.id,
          delta,
          reason: 'RECONCILE',
          actorId: request.user.userId,
          note: 'Stock count set from the item editor',
        }));
        if (moved.applied) newBalance = moved.balanceAfter;
      }
    } else if (stockTarget !== undefined && existing.stockQuantity === null) {
      // The item was untracked and the vendor is now tracking it: that is an
      // opening balance, not a movement — nothing left or entered a shelf.
      // recordOpeningBalance sets the counter itself, in the same transaction as
      // the row it writes, so this route never assigns stockQuantity at all.
      await app.prisma.$transaction((tx) =>
        recordOpeningBalance(tx, item.id, stockTarget, request.user.userId),
      );
      newBalance = stockTarget;
    }

    // The row update above no longer writes stockQuantity — the ledger does,
    // afterwards. So the object it returned still carries the OLD count, and
    // returning it would tell the vendor their stock is what it was before the
    // change they just made. The response states what the ledger actually set.
    const saved = newBalance !== null ? { ...item, stockQuantity: newBalance } : item;

    scheduleVendorSearchSync(app, vendorId);
    void discovery.runMatcherForItem(item).catch(() => undefined);

    return { success: true, data: withBulkWord(saved) };
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

  /** GET /bookings — the Services SCHEDULE: appointments in a date range for the
   *  selected store, joined to the service + customer. Powers the booking-calendar
   *  a SERVICE vendor runs their day from (R1 type-awareness — appointments were
   *  previously only visible as rows on the generic order board). Operational, so
   *  any vendor member (incl. floor STAFF) can read it, like the order board.
   *  Defaults to a two-week window from today; from/to narrow it. */
  app.get('/bookings', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const { from, to } = z
      .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
      .parse(request.query);
    const start = from ?? new Date(new Date().setHours(0, 0, 0, 0));
    const end = to ?? new Date(start.getTime() + 14 * 24 * 60 * 60 * 1000);
    const bookings = await app.prisma.booking.findMany({
      where: { item: { vendorId }, slotStart: { gte: start, lt: end }, status: { not: 'CANCELLED' } },
      select: {
        id: true, customerId: true, orderId: true, slotStart: true, slotEnd: true, status: true,
        item: { select: { name: true, basePrice: true } },
      },
      orderBy: { slotStart: 'asc' },
    });
    // Booking.customerId is a User id with no relation — resolve names in one hit.
    const custIds = [...new Set(bookings.map((b) => b.customerId))];
    const users = custIds.length
      ? await app.prisma.user.findMany({ where: { id: { in: custIds } }, select: { id: true, firstName: true, lastName: true } })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return {
      success: true,
      data: bookings.map((b) => ({
        id: b.id,
        serviceName: b.item.name,
        price: Number(b.item.basePrice),
        slotStart: b.slotStart,
        slotEnd: b.slotEnd,
        status: b.status,
        orderId: b.orderId,
        customer: byId.has(b.customerId) ? { firstName: byId.get(b.customerId)!.firstName } : null,
      })),
    };
  });

  // -------------------------------------------------------------------------
  // Block time (scheduling spec 2.1): one-off exceptions — vacation day, sick
  // day, lunch block. Subtracted from availability BEFORE bookings by the ONE
  // computation both the picker and reservation validate through; customers
  // simply never see blocked slots and no reason ever leaks.
  // -------------------------------------------------------------------------

  /** GET /bookings/exceptions?from&to — the vendor's blocks in a range. */
  app.get('/bookings/exceptions', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { from, to } = z
      .object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() })
      .parse(request.query ?? {});
    const start = from ?? new Date(new Date().setUTCHours(0, 0, 0, 0));
    const end = to ?? new Date(start.getTime() + 30 * 24 * 60 * 60 * 1000);
    const exceptions = await app.prisma.bookingException.findMany({
      where: { vendorId, date: { gte: start, lte: end } },
      orderBy: [{ date: 'asc' }, { start: 'asc' }],
    });
    return { success: true, data: exceptions };
  });

  /** POST /bookings/exceptions — block a full day or a window, one listing or
   *  the whole business. */
  app.post('/bookings/exceptions', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
    const body = z
      .object({
        itemId: z.string().optional(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        start: z.string().regex(HHMM).optional(),
        end: z.string().regex(HHMM).optional(),
        reason: z.string().trim().max(200).optional(),
      })
      .refine((b) => (b.start == null) === (b.end == null), { message: 'start and end come together' })
      .refine((b) => b.start == null || b.end == null || b.start < b.end, { message: 'start must be before end' })
      .parse(request.body);

    if (body.itemId) {
      const item = await app.prisma.item.findFirst({ where: { id: body.itemId, vendorId }, select: { id: true } });
      if (!item) throw new NotFoundError('Listing', body.itemId);
    }
    const [y, m, d] = body.date.split('-').map(Number);
    const exception = await app.prisma.bookingException.create({
      data: {
        vendorId,
        itemId: body.itemId ?? null,
        date: new Date(Date.UTC(y!, m! - 1, d!)),
        start: body.start ?? null,
        end: body.end ?? null,
        reason: body.reason ?? null,
      },
    });
    return { success: true, data: exception };
  });

  /** DELETE /bookings/exceptions/:id — unblock (own-vendor only). */
  app.delete<{ Params: IdParam }>('/bookings/exceptions/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const removed = await app.prisma.bookingException.deleteMany({
      where: { id: request.params.id, vendorId },
    });
    if (removed.count === 0) throw new NotFoundError('Block', request.params.id);
    return { success: true, data: { deleted: true } };
  });

  /** POST /bookings/:id/reschedule — vendor-initiated move (scheduling 2.4):
   *  same law, roles reversed; the customer is told immediately. */
  app.post<{ Params: IdParam }>('/bookings/:id/reschedule', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { newSlotStart } = z.object({ newSlotStart: z.coerce.date() }).parse(request.body);

    const result = await bookingService.rescheduleBooking(request.params.id, newSlotStart, { vendorId });
    if (result.moved) {
      await notifications.send({
        userId: result.booking.customerId,
        type: 'ORDER_UPDATE',
        title: 'Your appointment moved',
        body: `${result.serviceName}: moved from ${fmtSlotTime(result.previousSlotStart)} to ${fmtSlotTime(result.booking.slotStart)}.`,
        data: { kind: 'booking_rescheduled', bookingId: result.booking.id },
      }).catch(() => undefined);
    }
    return { success: true, data: result.booking };
  });

  // =========================================================================
  // CATEGORY DISCOVERY (#17) — store picks, item tags, suggestions, requests.
  // Curated only (slugs validate against the tenant taxonomy); one PRIMARY
  // per store (partial-unique raced); ≤3 tags per item; sticky human choice.
  // =========================================================================

  /** The caller must own the item — every item-tag surface goes through this. */
  async function requireOwnItem(vendorId: string, itemId: string) {
    const item = await app.prisma.item.findFirst({ where: { id: itemId, vendorId }, select: { id: true, name: true, description: true } });
    if (!item) throw new NotFoundError('Listing', itemId);
    return item;
  }

  /** GET /store-categories — { primary, secondary[], derived[] }. (The bare
   *  /categories namespace is the vendor's MENU SECTIONS — law B — so the
   *  platform taxonomy lives under /store-categories; divergence logged.) */
  app.get('/store-categories', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    return { success: true, data: await discovery.getVendorCategories(vendorId) };
  });

  /** PUT /store-categories — replace the chosen set: 1 PRIMARY + ≤2 secondary. */
  app.put('/store-categories', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const body = z.object({
      primarySlug: z.string().min(1).max(80),
      secondarySlugs: z.array(z.string().min(1).max(80)).max(2).default([]),
    }).parse(request.body);
    return { success: true, data: await discovery.setVendorCategories(vendorId, body.primarySlug, body.secondarySlugs) };
  });

  /** GET /items/:id/category-suggestions — PENDING suggestions for the item. */
  app.get<{ Params: IdParam }>('/items/:id/category-suggestions', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    await requireOwnItem(vendorId, request.params.id);
    return { success: true, data: await discovery.pendingSuggestions(request.params.id) };
  });

  /** GET /category-suggestions — every PENDING suggestion across the store,
   *  grouped by item. This is what the backfill's "takes about 2 minutes"
   *  notification promises; without it that review meant opening every listing
   *  in turn, which is why suggestions sat PENDING and catalogues stayed
   *  untagged. */
  app.get('/category-suggestions', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    return { success: true, data: await discovery.pendingSuggestionsForVendor(vendorId) };
  });

  /** POST /items/:id/categories — add a tag ({ slug }, ≤3, curated only). */
  app.post<{ Params: IdParam }>('/items/:id/categories', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    await requireOwnItem(vendorId, request.params.id);
    const { slug } = z.object({ slug: z.string().min(1).max(80) }).parse(request.body);
    await discovery.addItemTag(request.params.id, slug, 'VENDOR');
    void discovery.reconcileDerivedForItem(request.params.id).catch(() => undefined);
    return { success: true, data: await discovery.itemTags(request.params.id) };
  });

  /** DELETE /items/:id/categories/:slug — removing AUTO writes DISMISSED. */
  app.delete<{ Params: { id: string; slug: string } }>('/items/:id/categories/:slug', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    await requireOwnItem(vendorId, request.params.id);
    await discovery.removeItemTag(request.params.id, request.params.slug);
    void discovery.reconcileDerivedForItem(request.params.id).catch(() => undefined);
    return { success: true, data: await discovery.itemTags(request.params.id) };
  });

  /** POST /category-suggestions/:id/accept | /dismiss — one-tap disposal. */
  app.post<{ Params: { id: string; action: string } }>('/category-suggestions/:id/:action', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const action = z.enum(['accept', 'dismiss']).parse(request.params.action);
    const suggestion = await app.prisma.discoveryCategorySuggestion.findUnique({ where: { id: request.params.id } });
    if (!suggestion) throw new NotFoundError('Suggestion', request.params.id);
    await requireOwnItem(vendorId, suggestion.itemId);
    await discovery.resolveSuggestion(suggestion.id, suggestion.itemId, action);
    if (action === 'accept') void discovery.reconcileDerivedForItem(suggestion.itemId).catch(() => undefined);
    return { success: true, data: { status: action === 'accept' ? 'ACCEPTED' : 'DISMISSED' } };
  });

  /** POST /store-categories/request — the founder's queue, never free-text. */
  app.post('/store-categories/request', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const body = z.object({
      proposedName: z.string().trim().min(2).max(60),
      note: z.string().trim().max(300).optional(),
    }).parse(request.body);
    const created = await discovery.createRequest(vendorId, body.proposedName, body.note);
    return { success: true, data: created };
  });

  /** GET /store-categories/requests — my requests + statuses. */
  app.get('/store-categories/requests', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    return { success: true, data: await discovery.vendorRequests(vendorId) };
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

  /** GET /standing — Movement R9: the Standing module (big number + band chip
   *  + 13-week trend + folded tag tops + coaching card). Daily-folded (RAT-G):
   *  reads never include today's ratings, so no fresh rating is traceable. */
  app.get('/standing', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { actorStandingView } = await import('../rating/rating-standing');
    return { success: true, data: await actorStandingView(app.prisma, 'VENDOR', vendorId) };
  });

  /** GET /analytics/item-feedback — the item-thumbs Pareto (R9): which items
   *  earn the 👎, last 30 days, worst first — so the fix list writes itself. */
  app.get('/analytics/item-feedback', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const since = new Date(Date.now() - 30 * 24 * 3600_000);
    const items = await app.prisma.item.findMany({ where: { vendorId }, select: { id: true, name: true } });
    const names = new Map(items.map((i) => [i.id, i.name]));
    const grouped = await app.prisma.itemFeedback.groupBy({
      by: ['itemId', 'verdict'],
      where: { itemId: { in: items.map((i) => i.id) }, createdAt: { gte: since } },
      _count: { _all: true },
    });
    const tally = new Map<string, { up: number; down: number }>();
    for (const g of grouped) {
      const t = tally.get(g.itemId) ?? { up: 0, down: 0 };
      if (g.verdict === 'UP') t.up += g._count._all;
      else t.down += g._count._all;
      tally.set(g.itemId, t);
    }
    const rows = [...tally.entries()]
      .map(([itemId, t]) => ({ itemId, name: names.get(itemId) ?? 'Removed item', ...t }))
      .sort((a, b) => b.down - a.down || b.up - a.up)
      .slice(0, 10);
    return { success: true, data: rows };
  });

  /** GET /analytics/overview — Dashboard summary cards */
  app.get('/analytics/overview', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    return { success: true, data: await analytics.overview(vendorId) };
  });

  /** GET /analytics/ops — Operational quality over a window: how fast orders
   *  are accepted, how honest the prep quote is, and how often orders die.
   *  Everything derives from real order timestamps — no synthetic numbers. */
  app.get('/analytics/ops', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { days } = revenueQuerySchema.parse(request.query);

    return { success: true, data: await analytics.ops(vendorId, days) };
  });

  /** GET /analytics/revenue — Daily revenue breakdown for the last 30 days */
  app.get('/analytics/revenue', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { days } = revenueQuerySchema.parse(request.query);

    return { success: true, data: await analytics.revenue(vendorId, days) };
  });

  /** GET /analytics/busy-hours — orders by local hour of day, last 30 days
   *  (master plan §4.1 "busy hours"). Guyana is UTC-4 year-round. */
  app.get('/analytics/busy-hours', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    return { success: true, data: await analytics.busyHours(vendorId) };
  });

  /** GET /analytics/popular-items — Top items by totalOrdered */
  app.get('/analytics/popular-items', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { limit } = popularItemsQuerySchema.parse(request.query);

    return { success: true, data: await analytics.popularItems(vendorId, limit) };
  });

  /** GET /analytics/repeat-customers — how many of the store's customers come
   *  back (R2 analytics — this metric didn't exist). A repeat customer has >= 2
   *  COMPLETED/DELIVERED orders here; the repeat rate is repeat/total. Finished
   *  orders only — a repeat means they actually came back and completed, not an
   *  abandoned cart. */
  app.get('/analytics/repeat-customers', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    return { success: true, data: await analytics.repeatCustomers(vendorId) };
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
    // NO operability gate here, deliberately [PINV-8]. A suspended store must
    // keep the screen it pays on — see billing-suspension-retention.test.ts,
    // which fails the build if a status check ever appears in front of this.
    const subscription = await app.prisma.subscription.findFirst({
      where: { vendorId },
    });

    const { sanDisplay } = await import('../billing/san.service');
    const { payInfo } = await import('../billing/agent-cash.service');
    return {
      success: true,
      data: subscription
        ? {
            ...subscription,
            // "My Swift Number" + Pay-screen block [san spec 2.4/6.1].
            ...(await sanDisplay(app.prisma, subscription)),
            ...(await payInfo(app.prisma, subscription)),
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

    // Movement R (R7): the reply rides the same scrub pipeline — PII masked;
    // profanity is refused outright (this is the store's public face).
    const processed = processReviewText(response);
    if (processed.hold) {
      throw new AppError(400, 'KEEP_IT_PROFESSIONAL', 'That language can’t go on your storefront — rephrase and post again');
    }

    const isEdit = rating.response !== null;
    const updated = await app.prisma.rating.update({
      where: { id: request.params.id },
      data: { response: processed.text, respondedAt: new Date(), respondedBy: request.user.userId },
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
