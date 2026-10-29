import { closeStoreSilentMmgCase, mmgAcceptedPayBy, mmgPayByStoreLine } from '../order/mmg-accept-expiry';
import { drainPushesAfterResponse, pushAfterResponse } from '../../lib/push-after-response';
import { emitToOrderRoom, emitToStoreRoom } from '../order/order-room-emission.service';
import { readFeePause } from '../billing/mmg-pause';
import { latestCaseFor, mayHaveCase, partyCaseView } from '../custody/custody-case';
import { assertHandoverRequestBudget } from '../handover/handover-request-budget';
import { confirmReturn } from '../custody/custody-recovery';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from '../../lib/zod';
import { VAT_CLASSES } from '../store-vat/vat-math';
import { storeVatNumberChanged } from '../store-vat/store-vat-decisions';
import { UPLOAD_CONSENT_TICKS, consentSubjectForRole, recordUploadConsent } from '../verification/upload-consent';
import { consentSurfaceOf } from '../legal/consent-surface';
import { assertNameNotReserved } from '../../lib/fixture-filter';
import { assertPromoTerms, recordPromoTermsVersion, updatePromoTerms } from '../promo/promo-terms';
import { OrderStatus, OrderType, SettlementStatus } from '@prisma/client';
import type { FulfillmentMode, Prisma } from '@prisma/client';
import { OrderService, assertMmgFulfilmentAllowed, vendorVisibleFilter, cancelledWhileHeld, holdWindowMs, isTerminalOrderStatus, preparationMayStart, releaseLapsedHoldInTransaction } from '../order/order.service';
import { STORE_ACCEPT_PATH, STORE_REJECTABLE_STATUSES } from '../order/order-status';
import { vendorResponseSlaMinutes, vendorRespondBy } from '../order/response-sla';
import { VendorAnalyticsService } from './vendor-analytics.service';
import { VendorMenuService } from './vendor-menu.service';
import { PickingService } from '../order/picking.service';
import { lineOptionsAsMade } from '../order/substitution-view';
import { makeDispatchService } from '../dispatch/dispatch.service';
import { dispatchTrigger, enqueueDeliveryDispatch } from '../dispatch/dispatch-trigger';
import { resolveDeliveryMode } from '../fulfillment/fulfillment-mode';
import { HANDOVER_SECRETS_OMIT } from '../handover/handover-security';
import { pickingReadinessCounter, mmgAttestationCounter } from '../../plugins/observability';
import { assertMmgAttestable, normaliseMmgReference, recordVendorAttestation } from './mmg-attestation';
import { completeMmgClaimNotice, decideStoreMmgClaim, mmgClaimLockObserver, mmgDispatchBlocked, stageStoreMmgClaim, type MmgClaimNotice } from '../order/mmg-claim.service';
import { NotificationService } from '../notification/notification.service';
import { deliverStaffInvite, staffAddReply, staffInviteAcceptEnabled, lockStaffInviteGrant, closePendingStaffInvites, recordStaffInviteRevocation, staffInviteRevocationVersion, withdrawPendingStaffInvites, spendStaffAddAllowance, staffAddDailyCap } from './staff-invites';
import { BookingService, lockBusinessTime } from '../booking/booking.service';
import { fmtSlotTime, MAX_BUFFER_MINUTES, MAX_MIN_NOTICE_MINUTES, peakMoment } from '../booking/availability';
import { INSTANT_BOOKING_OFF_MESSAGE, instantBookingSettingsForSave, mergeBookingConfig, overlappingWindows, overlappingWindowsMessage, windowsForSave } from '../booking/booking-config';
import { instantBookingEnabled, NEW_BOOKABLE_LISTING_DEFAULTS } from '../booking/instant-booking';
import { NO_SHOW_REASON, noShowCustomerNotice, noShowRefusal, noShowView, recordNoShowInTransaction } from '../booking/appointment-no-show';
import { bookingLimitsFor } from '../booking/booking-limits';
import { MAX_BOOKING_CAPACITY } from '../booking/one-at-a-time';
import { guyanaDayKey, isDateOnly, startOfGuyanaDay } from '../../utils/guyana-day';
import { VerificationService } from '../verification/verification.service';
import { CountryConfigService } from '../country/country-config.service';
import { getKycProvider } from '../../providers/kyc/kyc-provider';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { encryptBuffer, generateDek, getKeyProvider } from '../../providers/storage/envelope';
import { createHash } from 'node:crypto';
import { publishLegalDocumentOnce, recordConsent, type ConsentSurface } from '../legal/consent.service';
import { LEGAL_VERSION } from '../legal/legal.routes';
import { ACTIVITY_CLASSES, DECLARATION_CONSENT_TYPE, DECLARATION_VERSION, UNREGISTERED_TRADER_DECLARATION_V1, renderDeclarationPdf } from './unregistered-declaration';
import { OWN_NAME_CONSENT_TYPE, OWN_NAME_DECLARATION_V1, OWN_NAME_DECLARATION_VERSION, OWN_NAME_VENDOR_TYPES, renderOwnNamePdf, storeNameIsOwnName } from './own-name';
import { FOOD_HANDLERS_CONSENT_TYPE, FOOD_HANDLERS_TICK_V1, FOOD_HANDLERS_VERSION, foodHandlerTickApplies, storeAttested } from './food-handlers';
import { DECLARATION_DOC_TYPE, OWN_NAME_DOC_TYPE } from '../verification/doc-registry';
import { validRegistrationRecord } from './vendor-tier';
import { parseCsvWithHeader } from '../../utils/csv';
import { guessColumnMapping, applyMapping, toImportCsv, REQUIRED_FIELDS, type ColumnMapping } from '../../utils/catalogue-map';
import { scanXlsxZip, XlsxZipGuardError, XLSX_IMPORT_ZIP_BUDGET } from '../../utils/xlsx-zip-guard';
import { parseMenuText } from '../../utils/menu-text-parse';
import { extractMenuPdf } from '../../utils/menu-pdf-process';
import { parsePagination, paginatedResponse } from '../../utils/pagination';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors';
import { vendorOperateRefusal, vendorOperateError } from './vendor-operate';
import { ReviewDemoMoneyRefusedError, isReviewAccount, refuseReviewAccountRoleGrant } from '../review/demo-policy';
import { applyStockMovement, recordOpeningBalance } from '../inventory/stock';
import { DeliveryCashSettlementService, assertSettlementId, settlementAttestationSchema } from '../cash/delivery-cash-settlement.service';
import { BillingService } from '../billing/billing.service';
import { getPaymentProvider } from '../../providers/payment/payment-provider';
import { throwForMissingProfile } from '../../utils/role-gate';
import { registerPartnerMmgCheckoutRoutes } from '../billing/mmg-checkout.routes';
import { keepPublicPhoto } from '../../utils/owned-photo-upload';
import { IMPORT_PHOTO_ADDRESS_NOTE, uploadOnlyPhotoField } from '../../utils/photo-address';
import { retryStorageOrphan } from '../../lib/storage-orphans';
import { runAsSystem } from '../../plugins/tenant-context';
import { queueStorePhotoDeletions } from './store-photos';
import { scheduleVendorSearchSync } from '../search/search-sync';
import { assertNotBanned, assertNotBannedGoods, assertStoreAllowed, catalogueChecksFor, partnerStoreView, partnerView, storeCheckOf, unhideRestocked } from '../compliance/prohibited-gate';
import { certainGoods, notAllowedMessage } from '../compliance/prohibited-items';
import { SearchService } from '../search/search.service';
import { subscriptionOperability } from '../subscription/operate-gate';
import { QrService } from '../qr/qr.service';
import { DiscoveryService } from '../discovery/discovery.service';
import { QrAnalyticsService } from '../qr/qr-analytics.service';
import { cachedRender, renderQrPng, renderQrSvg, renderTemplatePdf } from '../qr/qr-assets.service';
import { publicWebBase } from '../qr/qr-codes';
import {
  respondToVendorReview,
  STORE_REVIEW_PROJECTION,
  summarizeRatingDistribution,
  publishedVendorReviewWhere,
  storeVisibleReview,
} from '../rating/vendor-review-visibility';
import { mmgPayUrlForWrite, safeMmgPayUrl } from '../../utils/mmg-pay-url';
import { mmgNumberForWrite, safeMmgNumber } from '../../utils/mmg-number';
import { assertStoreMmgPayLinkWritable, storeMmgPayLinkEnabled } from '../../utils/store-mmg';
import { requireStepUp } from '../auth/step-up';
import { stageMmgLinkChange, cancelMmgLinkChange, clearMmgLink } from '../integrity/money-surface';
import { assertVelocity } from '../integrity/velocity';
import { publicPhoneForWrite, safePublicPhone } from '../../utils/vendor-public-phone';
import { refundRuleForWrite } from './refund-rule';
import { awaitingFirstGoLive, goLiveMissing } from './go-live';
import { vatNumberForWrite } from '../../utils/vendor-vat-number';
import { BULK_CHOICES, bulkUnitsForChoice, bulkChoiceForUnits, type BulkChoice } from '../../utils/load';
import { redactCustomerContact, riderCounterpartySelect } from '../../utils/counterparty';
import { withCounterpartPhones } from '../calls/counterpart-phone';
import { resolveAvatarUrls } from '../../utils/avatar-url';
import { HANDED_TO_RIDER_NOTE, NO_CODE_HANDOVER_NOTE, handedToRiderSinceAssignment, handoverEpisodeRowsWhere } from '../order/store-handover-log';
import { assertStorePinInMarket } from './store-pin';
import { lockStorePin, recordStorePinMove } from './store-pin-move';
import { registerPartnerCardRoutes, withCardPayAction } from '../billing/card-rail.routes';

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
  // [O-2 · owner 22 Oct 2026] The takeaway pickup code: off by default; the store may turn it on.
  requirePickupCode: z.boolean().optional(),
  // FUL-007: kitchen-capacity cap. Positive int caps concurrent in-flight orders;
  // null clears the cap (unlimited intake).
  maxConcurrentOrders: z.number().int().min(1).max(1000).nullable().optional(),
  // [BOOK-S1 · COORD C1(a)] How many appointments the business serves at once, across its listings
  // (1 = one at a time, the default). Optional: an older app never sends it and the store keeps its value.
  bookingCapacity: z.number().int().min(1).max(MAX_BOOKING_CAPACITY).optional(),
  // The vendor's own MMG "pay me" link (opt-in). null/empty clears it → cash-only.
  mmgPayUrl: z.string().trim().max(500).nullable().optional(),
  // [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The store's MMG number (+592 mobile); '' / null = stop taking MMG.
  mmgNumber: z.string().trim().max(40).nullable().optional(),
  // The number customers may call before ordering. Opt-in; null/'' takes it
  // down. Shape is enforced by publicPhoneForWrite, not here, so the write
  // and read boundaries cannot drift apart on what a valid number is.
  publicPhone: z.string().trim().max(32).nullable().optional(),
  // [VERIFY-DOCS · ruling 7] OPTIONAL VAT registration number, owner only; null/'' takes it off.
  // Shape is enforced by vatNumberForWrite (utils/vendor-vat-number).
  vatRegistrationNumber: z.string().trim().max(40).nullable().optional(),
  // [R3 · CAA s.70(3)] The store's own refund rule, owner only; null/'' takes it down.
  // Shape is enforced by refundRuleForWrite (vendor/refund-rule).
  refundRule: z.string().max(2000).nullable().optional(),
})
  // [Q8] A store pin is one point. Half of one would move the store along a
  // single axis to a spot nobody chose, so the two travel together or not at all.
  .refine((body) => (body.latitude === undefined) === (body.longitude === undefined), {
    message: 'Send latitude and longitude together',
    path: ['longitude'],
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
  reason: z.string().trim().min(1).max(500),
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
// [BOOK-S1] Windows on one day may not overlap (judged by the handlers, which
// know what the listing already stores: windowsForSave); the gap after each
// booking and the minimum notice are the business's to set (an older app's save
// keeps them: mergeBookingConfig on update).
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
  bufferMinutes: z.number().int().min(0).max(MAX_BUFFER_MINUTES).optional(),
  minNoticeMinutes: z.number().int().min(0).max(MAX_MIN_NOTICE_MINUTES).optional(),
  // [BOOK-S3 · owner A4] "Confirm bookings automatically". Refused while INSTANT_BOOKING
  // is off; with it on, a listing becoming bookable starts as automatic (instantBookingSettingsForSave).
  instantBooking: z.boolean().optional(),
});

/** [BOOK-S3] The instant-booking settings of a save, or the refusal while the switch is off. */
function bookingSettingsForSave(incoming: Record<string, unknown>, stored: unknown): Record<string, unknown> {
  const settled = instantBookingSettingsForSave(incoming, stored, instantBookingEnabled(), NEW_BOOKABLE_LISTING_DEFAULTS);
  if (!settled) throw new AppError(400, 'INSTANT_BOOKING_OFF', INSTANT_BOOKING_OFF_MESSAGE);
  return settled;
}

/** [BOOK-S1] The refusal of a new overlap between two opening times on one day. */
function overlappingHoursError(pair: Parameters<typeof overlappingWindowsMessage>[0]): AppError {
  return new AppError(400, 'OVERLAPPING_HOURS', overlappingWindowsMessage(pair));
}

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
  // [STORE-VAT · owner O-5] The item's VAT class, the store's call (it is told it is responsible). Optional: an older
  // app never sends it, and the item keeps its class (STANDARD for a new one). It carries VAT only for a store whose
  // VAT a person approved.
  vatClass: z.enum(VAT_CLASSES).optional(),
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
// Excel-import guards (audit DS107 High #5): the zip-bomb budget lives in
// utils/xlsx-zip-guard; these bound the workbook shape once exceljs has parsed
// it. 1 MB compressed is generous for a catalogue workbook (text compresses
// ~10:1, and the confirm step already caps 5000 rows).
const XLSX_MAX_COMPRESSED_BYTES = 1 * 1024 * 1024;
const MAX_XLSX_COLUMNS = 100;
const MAX_XLSX_CELL_TEXT = 2000;

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

// [IMAGES-E2E PR4 · COORD ruling 19 Oct (a)] No photo column: photos are uploaded, never
// imported (an imageUrl column in an older file is still read, and refused per row).
const CSV_TEMPLATE = [
  'category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment',
  'Groceries,Basmati Rice 5kg,"Long grain, aged",3500,RICE-5KG,bag,40,true,DELIVERY',
  'Services,Haircut,"30 minute appointment",2000,,,,true,APPOINTMENT',
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
function requireRole(access: { role: VendorAccessRole }, min: 'MANAGER' | 'OWNER') {
  if (ROLE_RANK[access.role] < ROLE_RANK[min]) {
    throw new AppError(403, 'STAFF_FORBIDDEN',
      min === 'OWNER'
        ? 'Only the store owner can do this'
        : 'This needs a manager — ask the store owner to upgrade your role');
  }
}

/**
 * [Row 52] The caller's membership in the store that OWNS this order — not the
 * store selected in the header — so a manager of one store who is only staff
 * at another cannot borrow the higher role. resolveOwnedOrder has already
 * proved the order belongs to one of the caller's stores.
 */
async function orderStoreMember(
  app: FastifyInstance,
  userId: string,
  vendorId: string,
): Promise<{ role: VendorAccessRole; memberId: string }> {
  const owner = await app.prisma.vendorOwner.findFirst({
    where: { userId, vendors: { some: { id: vendorId } } },
    select: { id: true },
  });
  if (owner) return { role: 'OWNER', memberId: owner.id };
  const staff = await app.prisma.vendorStaff.findUnique({
    where: { vendorId_userId: { vendorId, userId } },
    select: { id: true, role: true },
  });
  if (!staff) throw new AppError(403, 'STAFF_FORBIDDEN', 'You are not a member of this store');
  return { role: staff.role as VendorAccessRole, memberId: staff.id };
}

/** [Row 52] Coordinator ruling 5 Oct: OWNER and MANAGER confirm MMG payments. */
const CONFIRM_PAYMENT_MIN_ROLE = 'MANAGER' as const;

/** The flag the board and the order screen read to show the confirm button. */
function canConfirmPayment(role: VendorAccessRole | undefined): boolean {
  return role !== undefined && ROLE_RANK[role] >= ROLE_RANK[CONFIRM_PAYMENT_MIN_ROLE];
}

/** The caller's role at each of their stores, for per-order flags on a board
 *  that may span several stores (an owner owns them all; staff roles differ
 *  store by store). */
async function storeRoles(app: FastifyInstance, userId: string, access: VendorAccess): Promise<Map<string, VendorAccessRole>> {
  if (access.ownerId) return new Map(access.vendorIds.map((id) => [id, 'OWNER' as const]));
  const rows = await app.prisma.vendorStaff.findMany({
    where: { userId, vendorId: { in: access.vendorIds } },
    select: { vendorId: true, role: true },
  });
  return new Map(rows.map((r) => [r.vendorId, r.role as VendorAccessRole]));
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
    || await verification.isRoleVerified(await vendorOwnerUserId(app, vendorId), vendorRecord.vendorType, app.prisma, vendorId);
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

/**
 * [SEC-TRUST F15] What the owner sees of a team member, on EVERY route that returns one (GET /staff,
 * PUT /staff/:id). While staff invites need no acceptance (STAFF_INVITE_ACCEPT off), a member was added
 * without saying yes: the owner sees the first name and the number they typed, never the last name or the
 * photo. The fields stay in the answer (null), so every app build reads the same shape.
 */
function staffMemberUserSelect() {
  const consented = staffInviteAcceptEnabled();
  return { id: true, firstName: true, lastName: consented, phone: true, avatar: consented } as const;
}
function shownStaffMember<M extends { user: { lastName?: string | null; avatar?: string | null } }>(member: M) {
  return staffInviteAcceptEnabled() ? member : { ...member, user: { ...member.user, lastName: null, avatar: null } };
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
  // [STORE-VAT · owner O-5] The VAT included in a VAT store's goods, and the goods by class (null on every other order).
  'vatAmount', 'vatStandardGoods', 'vatZeroRatedGoods', 'vatExemptGoods', 'vatBase',
] as const;

/** Every `Decimal` money column on `model OrderItem`. */
const ORDER_ITEM_MONEY_FIELDS = [
  'basePrice', 'markedUpPrice', 'markupAmount',
  'totalBase', 'totalMarkup', 'totalCustomer', 'substitutePrice',
] as const;

/** `model Item` / `model Option` — the menu's own prices. */
const ITEM_MONEY_FIELDS = ['basePrice'] as const;
const OPTION_MONEY_FIELDS = ['additionalPrice'] as const;

/** [L09 · M026] The store makes what the customer chose: every line carries its
 *  snapshotted options (group, choice, price) on the board and the detail —
 *  and none once an approved substitute replaced the line, because the swap is
 *  charged without them (order/substitution-view.ts). */
const VENDOR_ORDER_ITEMS = {
  include: { selectedOptions: { select: { optionGroupName: true, optionName: true, markedUpPrice: true } } },
} as const;

function vendorOrderLine<T extends { subStatus: string; selectedOptions: Array<{ optionGroupName: string; optionName: string; markedUpPrice: unknown }> }>(line: T) {
  const { selectedOptions, ...rest } = line;
  return { ...rest, options: lineOptionsAsMade({ subStatus: line.subStatus, selectedOptions }) };
}

export { HANDED_TO_RIDER_NOTE };

/** [O-2] The order is still with the store, so a rider may be handed it (and the card shows who). */
const STORE_HANDOVER_LIVE_STATUSES: readonly string[] = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'];

/**
 * [O-2] What the store's order card needs for the handover, for a page of its orders:
 * - pickupCodeRequired: the store's takeaway-code setting (off by default);
 * - handedToRiderAt: when the store tapped "Handed to rider" (the status-log row), or null;
 * - rider.photoUrl: the assigned rider's photo, RESOLVED (a signed URL or null, never the raw key),
 *   next to the first name, vehicle and plate the card already gets.
 */
async function storeHandoverFields(
  app: FastifyInstance,
  orders: ReadonlyArray<{ id: string; status: string; fulfillment: string; riderId?: string | null; vendor?: { requirePickupCode?: boolean } | null; rider?: object | null }>,
): Promise<Map<string, { pickupCodeRequired: boolean; handedToRiderAt: string | null; rider?: object | null }>> {
  // Only a delivery with a Swift rider has a handover to record (a booking, a takeaway: nothing to read).
  const ids = orders.filter((o) => o.fulfillment === 'DELIVERY' && o.riderId).map((o) => o.id);
  // [REVIEW-G S3-1 on #2055] The store needs the rider's face only to hand the order over: the photo is
  // read and given only while the order is still with the store (before Picked up), never on a past order.
  const handoverLive = (o: { status: string }) => STORE_HANDOVER_LIVE_STATUSES.includes(o.status);
  const riderIds = [...new Set(orders.filter(handoverLive).map((o) => o.riderId).filter((r): r is string => !!r))];
  const [handed, riders] = await Promise.all([
    ids.length ? app.prisma.orderStatusLog.findMany({
      where: handoverEpisodeRowsWhere(ids), select: { orderId: true, status: true, note: true, createdAt: true }, orderBy: { createdAt: 'asc' },
    }) : [],
    riderIds.length ? app.prisma.rider.findMany({ where: { id: { in: riderIds } }, select: { id: true, user: { select: { avatar: true } } } }) : [],
  ]);
  const firstHanded = handedToRiderSinceAssignment(handed);
  const photos = await resolveAvatarUrls(riders.map((r) => r.user?.avatar));
  const photoOf = new Map(riders.map((r) => [r.id, r.user?.avatar ? photos.get(r.user.avatar) ?? null : null]));
  const out = new Map<string, { pickupCodeRequired: boolean; handedToRiderAt: string | null; rider?: object | null }>();
  for (const order of orders) {
    out.set(order.id, {
      pickupCodeRequired: order.vendor?.requirePickupCode === true,
      handedToRiderAt: order.riderId ? firstHanded.get(order.id)?.toISOString() ?? null : null,
      ...(order.rider && order.riderId ? { rider: { ...order.rider, photoUrl: handoverLive(order) ? photoOf.get(order.riderId) ?? null : null } } : {}),
    });
  }
  return out;
}

/** [O-4 · owner 22 Oct 2026] An order with an open "Out of stock" question (a swap or a removal
 *  the customer has not answered yet) is not accepted: the customer agrees to the changed order
 *  first. The refusal names the item and how long the answer can take. An order whose every line
 *  came off has nothing to accept: the store rejects it instead (with its reason). */
export function assertNoOpenCustomerQuestion(
  lines: ReadonlyArray<{ name: string; subStatus: string; substituteDecideBy?: Date | null }>,
  now: Date = new Date(),
): void {
  const open = lines.find((line) => line.subStatus === 'PENDING');
  if (!open) {
    if (lines.length > 0 && lines.every((line) => line.subStatus === 'REFUNDED' || line.subStatus === 'REJECTED')) {
      throw new AppError(409, 'NOTHING_TO_ACCEPT', 'Every item on this order was removed. Reject the order instead, with the reason.');
    }
    return;
  }
  const minutes = open.substituteDecideBy
    ? Math.max(1, Math.ceil((open.substituteDecideBy.getTime() - now.getTime()) / 60_000))
    : null;
  throw new AppError(
    409,
    'CUSTOMER_DECIDING',
    `The customer is still deciding about ${open.name}${minutes ? ` (up to ${minutes} more minute${minutes === 1 ? '' : 's'})` : ''}. Accept the order after they answer.`,
  );
}

/**
 * Verify that the given order belongs to one of the user's vendors and return it.
 */
async function resolveOwnedOrder(app: FastifyInstance, userId: string, orderId: string, request: { headers: Record<string, string | string[] | undefined> }) {
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
      items: VENDOR_ORDER_ITEMS,
      statusHistory: { orderBy: { createdAt: 'desc' } },
      // [COORD 17 Oct] The store order screen's Call button: first name + phone, never the last name.
      // [O-1] The customer's and rider's phones go only to an installed store build (below).
      customer: { select: { id: true, firstName: true, phone: true } },
      // [F-027-07] allow-list, not `include` — see utils/counterparty.
      rider: { select: riderCounterpartySelect({ withPhone: true }) },
      // vendorType drives the pick-list UI (grocery/goods shelf-pick §5.3).
      vendor: { select: { vendorType: true, selfDeliveryEnabled: true, requirePickupCode: true } },
    },
  });
  if (!order || !order.vendorId || !vendorIds.includes(order.vendorId)) {
    throw new NotFoundError('Order', orderId);
  }
  // LIFECYCLE_V2: a held order is invisible to the vendor even by direct id —
  // and so, once its dead window lapses, is one cancelled inside it [Q12].
  if ((order.holdExpiresAt && order.holdExpiresAt > new Date()) || cancelledWhileHeld(order)) {
    throw new NotFoundError('Order', orderId);
  }
  // [O-1 · owner 19:40Z] A bridge-aware store screen calls through Swift: no personal number.
  return withCounterpartPhones(request, order);
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------


/** [ALG-34 · owner 17 Oct 2026 PAYMENT-SIMPLIFY] The store's own view of where MMG money goes.
 *  The MMG NUMBER (live + staged, each re-checked on read) is what customers pay now. The pay
 *  LINK is shown only while STORE_MMG_PAY_LINK is on (`mmgPayLinkEnabled`); off, a stored link
 *  stays dormant and an older app shows an empty card, never a link Swift does not use. */
function storeMoneySurfaceView(row: {
  mmgPayUrl: string | null; mmgPayUrlPending: string | null; mmgPayUrlApplyAt: Date | null;
  mmgNumber: string | null; mmgNumberPending: string | null; mmgNumberApplyAt: Date | null;
}) {
  const linkOn = storeMmgPayLinkEnabled();
  return {
    mmgPayLinkEnabled: linkOn,
    mmgPayUrl: linkOn ? safeMmgPayUrl(row.mmgPayUrl) : null,
    mmgPayUrlPending: linkOn ? safeMmgPayUrl(row.mmgPayUrlPending) : null,
    mmgPayUrlApplyAt: linkOn ? row.mmgPayUrlApplyAt : null,
    mmgNumber: safeMmgNumber(row.mmgNumber),
    mmgNumberPending: safeMmgNumber(row.mmgNumberPending),
    mmgNumberApplyAt: row.mmgNumberPending ? row.mmgNumberApplyAt : null,
  };
}


/** [owner 18 Oct 2026 · PAYMENT-SIMPLIFY] An accepted MMG order waiting for "Paid by MMG"
 *  cancels 30 minutes after acceptance: the store sees when (server clock, the sweep's rule). */
function storeMmgPayBy(order: Parameters<typeof mmgAcceptedPayBy>[0]): { mmgPayBy: string | null; mmgPayByLine: string | null } {
  const payBy = mmgAcceptedPayBy(order);
  return payBy ? { mmgPayBy: payBy.toISOString(), mmgPayByLine: mmgPayByStoreLine(payBy) } : { mmgPayBy: null, mmgPayByLine: null };
}

/**
 * [IMAGES-E2E] What PUT /profile may do with the logo and cover addresses. They are
 * photos the store uploads (POST /profile/logo|cover), so typed text may only take
 * one down ('' = none) or send back the value already there (a client that echoes
 * the profile). Anything else (an outside address, another store's key, a path into
 * another folder) is refused: it would skip the scan and the redraw. undefined =
 * leave the field as it is.
 */
export async function storePhotoFieldsForWrite(
  app: FastifyInstance,
  vendorId: string,
  logoUrl: string | undefined,
  coverImageUrl: string | undefined,
): Promise<{ logoUrl?: string | null; coverImageUrl?: string | null }> {
  if (logoUrl === undefined && coverImageUrl === undefined) return {};
  const current = await app.prisma.vendor.findUnique({ where: { id: vendorId }, select: { logoUrl: true, coverImageUrl: true } });
  const one = (sent: string | undefined, now: string | null | undefined): string | null | undefined => {
    if (sent === undefined) return undefined;
    if (sent.trim() === '') return null;
    if (sent === (now ?? '')) return undefined;
    throw new AppError(400, 'STORE_PHOTO_UPLOAD_ONLY', 'Add the store\'s logo or cover by uploading a photo');
  };
  return { logoUrl: one(logoUrl, current?.logoUrl), coverImageUrl: one(coverImageUrl, current?.coverImageUrl) };
}

export async function vendorRoutes(app: FastifyInstance) {
  const auth = { preHandler: [app.authenticate] };
  // [PERF item 3] A store's order taps answer without waiting for the push to the customer's
  // phone (lib/push-after-response): the inbox row and socket events stay in the request.
  const tap = { ...auth, onRequest: pushAfterResponse };
  app.addHook('onClose', async () => drainPushesAfterResponse());
  const orderService = new OrderService(app.prisma, app.io, undefined, undefined, app.redis);
  const analytics = new VendorAnalyticsService(app.prisma);
  const menu = new VendorMenuService(app.prisma);
  /** [Item 62] A listing archived between an editor's read and its guarded
   *  write is gone: 404, never a 500 (Prisma's P2025 "record not found"). */
  const goneIfArchived = (id: string) => (err: unknown): never => {
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2025') throw new NotFoundError('Item', id);
    throw err;
  };
  const dispatch = makeDispatchService(app);
  const notifications = new NotificationService(app.prisma, app.io);
  const custodyDeps = { prisma: app.prisma, io: app.io, notifications };
  const settlementLedger = new DeliveryCashSettlementService(app.prisma, notifications);
  const picking = new PickingService(app.prisma, app.io);
  const verification = new VerificationService(
    app.prisma,
    new NotificationService(app.prisma, app.io),
    getKycProvider(),
  );
  const storage = getStorageProvider();
  /** [IMAGES-E2E PR4] After a store photo's pointer change commits: delete each photo now. A
   *  delete that fails stays owed and the standing retry (retryStorageOrphans) finishes it. */
  const deleteQueuedPhotos = async (orphanIds: string[]) => {
    if (orphanIds.length === 0) return;
    await runAsSystem('public-photo-deletion', async () => {
      for (const id of orphanIds) await retryStorageOrphan(app.prisma, storage, app.log, id);
    });
  };
  /** A photo just kept that its row could not take (the row went meanwhile) is deleted, not left behind. */
  const discardKeptPhoto = async (vendorId: string, url: string) => {
    const ids = await app.prisma.$transaction((tx) => queueStorePhotoDeletions(tx, vendorId, [url])).catch(() => [] as string[]);
    await deleteQueuedPhotos(ids);
  };
  /** [IMAGES-E2E PR4] A menu section's photo set (an upload) or taken down (null), under the
   *  section's lock; the photo it replaces is queued for deletion in the same transaction. */
  const setSectionPhoto = async (vendorId: string, id: string, url: string | null) => {
    const { category, orphanIds } = await app.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ imageUrl: string | null }>>`
        SELECT "imageUrl" FROM "categories" WHERE "id" = ${id} AND "vendorId" = ${vendorId} AND "archivedAt" IS NULL
        FOR UPDATE /* section-photo-authority */
      `;
      if (!rows[0]) throw new NotFoundError('Category', id);
      const queued = rows[0].imageUrl !== url ? await queueStorePhotoDeletions(tx, vendorId, [rows[0].imageUrl]) : [];
      const row = await tx.category.update({ where: { id }, data: { imageUrl: url } });
      return { category: row, orphanIds: queued };
    });
    await deleteQueuedPhotos(orphanIds);
    return category;
  };
  const bookingService = new BookingService(app.prisma, app.io);
  const qrService = new QrService(app.prisma);
  const discovery = new DiscoveryService(app.prisma);
  const qrAnalytics = new QrAnalyticsService(app.prisma);

  /** The order/mode transition has already committed when this runs. Queue or
   * Redis trouble must not turn that durable success into a contradictory HTTP
   * failure. The periodic dispatch reconciler reads the same committed row and
   * is the durable recovery path when this immediate attempt cannot be armed. */
  async function startPlatformDeliveryAfterCommit(
    order: { id: string; isExpress: boolean },
    fulfillmentModeVersion: number,
    reason: 'accept' | 'ready' | 'mode_switch' | 'mmg_paid',
  ): Promise<boolean> {
    try {
      const current = await dispatch.prepareForPlatformDelivery(order.id, fulfillmentModeVersion);
      if (!current) return false;
      await enqueueDeliveryDispatch(app, order);
      return true;
    } catch (err) {
      app.log.error(
        { err, orderId: order.id, fulfillmentModeVersion, reason },
        'platform delivery committed but immediate dispatch arm failed; reconciler will retry',
      );
      return false;
    }
  }

  // A vendor may only DRIVE an order FORWARD (accept / prepare / ready / complete)
  // while eligible to operate — the SAME predicate as the toggle-orders front
  // door. The doc-expiry sweep sets isVerified=false but leaves status ACTIVE, so
  // a lapsed store's board keeps rendering and every order already in flight when
  // the docs lapsed could otherwise be fully accepted, prepared and handed over.
  // This closes that server-authoritative hole (invariant 2). Reject/cancel are
  // deliberately NOT gated — a blocked store must still be able to decline.
  /**
   * [BILLING-INFLIGHT · owner ruling 1 Oct ~22:10] "Suspended store: accepted
   * orders are completed; new orders are blocked until it pays." A weekly-fee
   * hold (a billing suspension, or a lapsed fee grace) refuses NEW work only:
   * `work: 'IN_FLIGHT'` (progress on an order the store already accepted) skips
   * the billing arm. Every other hold keeps its rule on both kinds of work: an
   * admin/safety/moderation suspension, a closed store, expired documents.
   * A null suspension source is billing's (the transition rule reinstate uses).
   */
  async function assertVendorCanOperate(vendorId: string, work: 'NEW' | 'IN_FLIGHT' = 'NEW') {
    // [BOOK-S3] THE predicate lives in vendor-operate.ts, shared with an instant
    // booking's standing acceptance at checkout; the words and codes here are unchanged.
    const refusal = await vendorOperateRefusal(app.prisma, verification, vendorId, work);
    if (refusal) throw vendorOperateError(refusal);
  }

  /** Resolve only a genuinely unresolved delivery owner from the Order row
   * held by the canonical transition lock. An explicit mode that committed
   * after the route's initial read always wins. The vendor preference is a
   * snapshot default for this order: later profile changes do not silently
   * rewrite accepted work, and PLATFORM_RIDER remains available as recovery. */
  async function bindUnresolvedDeliveryMode(
    tx: Prisma.TransactionClient,
    source: {
      id: string;
      vendorId: string | null;
      riderId: string | null;
      fulfillment: string;
      fulfillmentMode: FulfillmentMode | null;
    },
  ): Promise<void> {
    if (source.fulfillment !== 'DELIVERY' || source.riderId || source.fulfillmentMode != null) return;
    const vendor = source.vendorId
      ? await tx.vendor.findUnique({ where: { id: source.vendorId }, select: { selfDeliveryEnabled: true } })
      : null;
    const mode = resolveDeliveryMode(null, vendor?.selfDeliveryEnabled ?? false);
    await tx.order.update({
      where: { id: source.id },
      data: { fulfillmentMode: mode, fulfillmentModeVersion: { increment: 1 } },
    });
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
      include: { user: { select: staffMemberUserSelect() } },
    });
    return { success: true, data: staff.map(shownStaffMember) };
  });

  /** POST /staff — invite a Swift account to the team by phone. [Row 55]
   *  Every number gets the SAME reply (staffAddReply): known, unknown, already
   *  on the team or already invited. With STAFF_INVITE_ACCEPT on, a known
   *  account gets an invite and joins only when it accepts; with it off (the
   *  app build without the Accept card) it is added at once, as before. */
  app.post('/staff', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    // [SEC-TRUST F15] A team is added to a store Swift has approved (ACTIVE), never to one still waiting.
    const store = await app.prisma.vendor.findUnique({ where: { id: vendorId }, select: { status: true } });
    if (store?.status !== 'ACTIVE') {
      throw new AppError(403, 'STORE_NOT_APPROVED', 'You can add team members once your store is approved and open.');
    }
    await requireStepUp(app, request); // [ALG-34] a grant hands the store's board to a phone
    const body = addStaffSchema.parse(request.body);
    // [Row 55] A daily allowance per owner account, spent BEFORE the number is
    // looked up: reaching it reads the same for every number and grants nothing.
    if (!(await spendStaffAddAllowance(app.redis, request.user.userId))) {
      throw new AppError(429, 'STAFF_ADD_DAILY_LIMIT', `You can add up to ${staffAddDailyCap()} team members a day. Try again tomorrow.`);
    }

    const target = await app.prisma.user.findUnique({
      where: { phone: body.phone },
      select: { id: true, status: true },
    });
    // The owner's own number tells them nothing they do not know.
    if (target && target.id === request.user.userId) {
      throw new AppError(400, 'SELF_STAFF', 'You already own this store');
    }
    // [REVIEW-PARTNER] No store membership is granted by a demo account. This
    // answers about the caller alone, so it says nothing about the number.
    await refuseReviewAccountRoleGrant(app.prisma, request.user.userId);
    const reply = staffAddReply(body.role);
    // The same read runs for every number. Capture authority before scheduling
    // delivery, without waiting for invitation persistence or publication.
    const revocationVersion = staffInviteAcceptEnabled()
      ? await staffInviteRevocationVersion(app.prisma, vendorId, target?.id ?? 'unresolved-recipient') : 0;
    if (!target || target.status !== 'ACTIVE') return reply;

    if (staffInviteAcceptEnabled()) {
      // Off the request path: the reply never waits on whether an invite was due
      // (deliverStaffInvite also sends nothing to a demo account).
      void deliverStaffInvite(app.prisma, notifications, {
        vendorId, targetUserId: target.id, role: body.role, inviterId: request.user.userId, now: new Date(), revocationVersion,
      }).catch((err: unknown) => request.log.error({ err, vendorId }, '[row 55] staff invite not delivered'));
      return reply;
    }
    // [REVIEW-PARTNER] ...nor granted to one: the same reply as any number, nothing granted.
    if (await isReviewAccount(app.prisma, target.id)) return reply;

    const existing = await app.prisma.vendorStaff.findUnique({
      where: { vendorId_userId: { vendorId, userId: target.id } },
      select: { id: true },
    });
    if (!existing) {
      await app.prisma.vendorStaff.create({
        data: { vendorId, userId: target.id, role: body.role, invitedBy: request.user.userId },
      });
      void notifications.send({
        userId: target.id,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'You joined a store team',
        body: `You've been added as ${body.role === 'MANAGER' ? 'a manager' : 'staff'} — open Swift and choose "Business" to start.`,
        data: { kind: 'staff_added', vendorId },
      }).catch((err: unknown) => request.log.error({ err, vendorId }, 'staff added notice failed'));
    }
    return reply;
  });

  // The person invited answers under /customer/team-invites (customer.routes):
  // they are not on a store team yet, so the /vendor prefix is not theirs.

  /** POST /staff/invites/withdraw — take back every unanswered invite from
   *  this store. [Row 55] Nothing pending is listed to the owner, so a mistyped
   *  number is withdrawn with all the others; the reply is the same however
   *  many there were, so it never counts which numbers are Swift accounts. */
  app.post('/staff/invites/withdraw', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    await withdrawPendingStaffInvites(app.prisma, { vendorId, actorId: request.user.userId, now: new Date() });
    return { success: true, data: { withdrawn: true, message: 'Any invites from this store that were not answered yet have been withdrawn.' } };
  });

  /** PUT /staff/:id — change a member's role. */
  app.put<{ Params: IdParam }>('/staff/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    await requireStepUp(app, request); // [ALG-34]
    const body = updateStaffSchema.parse(request.body);
    const existing = await app.prisma.vendorStaff.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('StaffMember', request.params.id);
    // [REVIEW-PARTNER] No store membership is raised by, or for, a demo account.
    await refuseReviewAccountRoleGrant(app.prisma, request.user.userId, existing.userId);

    const member = await app.prisma.vendorStaff.update({
      where: { id: request.params.id },
      data: { role: body.role },
      include: { user: { select: staffMemberUserSelect() } },
    });
    return { success: true, data: shownStaffMember(member) };
  });

  /** DELETE /staff/:id — remove a member (their access ends immediately). */
  app.delete<{ Params: IdParam }>('/staff/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const existing = await app.prisma.vendorStaff.findUnique({ where: { id: request.params.id } });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('StaffMember', request.params.id);

    await app.prisma.$transaction(async (tx) => {
      await lockStaffInviteGrant(tx, vendorId, existing.userId);
      const current = await tx.vendorStaff.findFirst({ where: { id: request.params.id, vendorId, userId: existing.userId } });
      if (!current) throw new NotFoundError('StaffMember', request.params.id);
      await recordStaffInviteRevocation(tx, vendorId, current.userId, request.user.userId);
      await closePendingStaffInvites(tx, vendorId, current.userId, new Date());
      await tx.vendorStaff.delete({ where: { id: current.id } });
    });
    // [Owner ruling #15] Out of the live room of the store at once, on every
    // API node: a removed member stops hearing it now, not at the next event
    // (the store-room gate would refuse them then anyway).
    app.io?.in(`user:${existing.userId}`).socketsLeave(`vendor:${vendorId}`);
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
        categories: { where: { archivedAt: null }, orderBy: { sortOrder: 'asc' }, include: { _count: { select: { items: { where: { archivedAt: null } } } } } },
        _count: { select: { orders: true, items: { where: { archivedAt: null } } } },
      },
    });
    // Legacy rows predate the MMG destination validator. Never reflect an
    // invalid stored value back into an app where it could be opened.
    const safeVendors = vendors.map((vendor) => ({
      ...vendor,
      ...storeMoneySurfaceView(vendor),
      publicPhone: safePublicPhone(vendor.publicPhone),
      // [owner #51] What still stands between a never-live store and going
      // live, besides its documents (additive; older apps ignore it).
      goLiveMissing: awaitingFirstGoLive(vendor) ? goLiveMissing(vendor) : [],
      // [GUARDRAILS §8 · owner 14 Oct, store names] Why customers can't see the store: its own words wait for Swift.
      storeCheck: partnerStoreView(storeCheckOf(vendor)),
      nameReviewApprovedHash: undefined,
      // [BOOK-S5a · owner A4] A Services business may choose "Confirm bookings automatically" only
      // while INSTANT_BOOKING is on; the partner app shows the setting only on this word. Switch
      // off: not sent (the answer is today's).
      ...(vendor.vendorType === 'SERVICE' && instantBookingEnabled() ? { instantBookingAvailable: true } : {}),
    }));
    const visible = access.role === 'OWNER'
      ? safeVendors
      : safeVendors.map((v) => ({ ...v, subscription: undefined, vatRegistrationNumber: undefined }));
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
    // [R15 · owner 15 Oct 2026, research D9] Home cooks are held: a home kitchen needs the council's
    // registration, and whether one can be registered is not confirmed yet. Refused before anything is written.
    if (body.activityClass === 'home_cook') {
      throw new AppError(409, 'HOME_COOK_HELD', 'Swift can’t take home cooks yet: a home kitchen needs a council registration that is still being confirmed. We’ll tell you when it opens.');
    }
    const [vendor, user, registered, existing] = await Promise.all([
      app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { id: true, name: true, tier: true, vendorType: true } }),
      app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { firstName: true, lastName: true, countryCode: true } }),
      validRegistrationRecord(app.prisma, userId),
      app.prisma.verificationDocument.findFirst({ where: { userId, docType: DECLARATION_DOC_TYPE, status: { in: ['PENDING', 'APPROVED'] } }, select: { id: true, status: true } }),
    ]);
    if (registered) throw new AppError(409, 'ALREADY_REGISTERED', 'A business registration is on file for this store, so it is a registered seller — no declaration is needed.');
    if (existing) throw new AppError(409, 'DECLARATION_EXISTS', `A self-declaration is already ${existing.status === 'APPROVED' ? 'on file' : 'under review'} for this store.`);

    // Preflight the same country/tier checklist used by intake. SERVICE has
    // no declaration checklist by default; this route cannot invent one.
    const checklist = await new CountryConfigService(app.prisma).getDocumentChecklist(user.countryCode, vendor.vendorType, 'UNREGISTERED');
    if (!checklist.includes(DECLARATION_DOC_TYPE)) {
      throw new AppError(400, 'DECLARATION_UNSUPPORTED', 'A self-declaration is not supported for this store type in your country.');
    }
    // Acquire and wrap the key BEFORE publishing words, changing tier, or
    // recording consent. No generated declaration may fall back to plaintext.
    const dek = generateDek();
    let wrappedDek: Buffer;
    try {
      const keys = getKeyProvider();
      if (!keys) throw new Error('Envelope encryption unavailable');
      wrappedDek = await keys.wrapDek(dek);
    } catch {
      throw new AppError(503, 'VERIFICATION_UPLOAD_UNAVAILABLE', 'Verification uploads are temporarily unavailable. Try again later.');
    }

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
    const { ciphertext, iv, authTag } = encryptBuffer(pdf, dek);
    const { url: fileUrl } = await storage.upload({ buffer: ciphertext, filename: `declaration-${DECLARATION_VERSION}.pdf.enc`, mimeType: 'application/octet-stream', folder: `verification/${userId}` });
    await app.prisma.encryptedObject.create({ data: {
      fileKey: fileUrl, iv: new Uint8Array(iv), authTag: new Uint8Array(authTag), wrappedDek: new Uint8Array(wrappedDek),
      mimeType: 'application/pdf', sizeBytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'), createdBy: userId,
    } });
    const doc = await verification.submitDocument(userId, vendor.vendorType as 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE', DECLARATION_DOC_TYPE, fileUrl, body.privacyNoticeVersion);
    reply.code(201);
    return { success: true, data: { tier: 'UNREGISTERED', declaration: { id: doc.id, status: doc.status, docType: doc.docType }, status: await verification.getStatus(userId, vendor.vendorType as 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE') } };
  });

  // =========================================================================
  // [STORE-VAT · owner O-5] The store's VAT: its answer, its certificate, and what a person decided. OWNER only
  // (the business's tax registration is the owner's to give, like vatRegistrationNumber). Nothing a customer sees
  // changes until a person approves the certificate (store-vat-decisions.ts).
  // =========================================================================

  /** GET /vat — the store's VAT as its owner sees it (status, mode, the approved details, the rate, the sources). */
  app.get('/vat', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const { storeVatView } = await import('../store-vat/store-vat-decisions');
    return { success: true, data: await storeVatView(app.prisma, vendorId) };
  });

  /** PUT /vat — "Is your business VAT-registered with the GRA?" No = VAT off at once. Yes = the number (as on the
   *  certificate) and how the prices relate to VAT; the store waits for a person. */
  app.put('/vat', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const body = z.object({
      registered: z.boolean(),
      vatRegistrationNumber: z.string().trim().max(40).nullable().optional(),
      mode: z.enum(['PRICES_INCLUDE_VAT', 'ADD_VAT_AT_CHECKOUT']).optional(),
    }).strict().parse(request.body);
    const { updateStoreVatSettings } = await import('../store-vat/store-vat-decisions');
    return { success: true, data: await updateStoreVatSettings(app.prisma, vendorId, body) };
  });

  /** POST /vat/certificate — the store's GRA VAT registration certificate (uploaded first through
   *  /verification/upload, like every document). Filed for a PERSON's review, never sent to a document processor. */
  app.post('/vat/certificate', auth, async (request, reply) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const body = z.object({
      fileUrl: z.string().min(5).max(2048),
      consent: z.literal(true),
      privacyNoticeVersion: z.string().min(1).max(20),
      consentTick: z.enum(UPLOAD_CONSENT_TICKS).optional(),
    }).strict().parse(request.body);
    const { storeVatEnabled, VAT_CERTIFICATE_DOC_TYPE } = await import('../store-vat/store-vat');
    const { linkVatCertificate, STORE_VAT_OFF_CODE } = await import('../store-vat/store-vat-decisions');
    if (!storeVatEnabled()) {
      throw new AppError(409, STORE_VAT_OFF_CODE, 'VAT settings are not available on Swift right now. Your prices stay exactly as you typed them.');
    }
    const userId = request.user.userId;
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { vendorType: true, vatStatus: true } });
    if (vendor.vatStatus === 'NONE') {
      throw new AppError(409, 'VAT_NOT_CLAIMED', 'First say your business is VAT-registered and type its VAT number, then send the certificate.');
    }
    const role = vendor.vendorType as 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';
    const doc = await verification.submitDocument(userId, role, VAT_CERTIFICATE_DOC_TYPE, body.fileUrl, body.privacyNoticeVersion, request.user.role, { storeVatCertificate: true });
    if (body.consentTick) {
      await recordUploadConsent(app.prisma, { userId, tick: body.consentTick, subjectType: consentSubjectForRole(role), surface: consentSurfaceOf(request), ip: request.ip, docType: VAT_CERTIFICATE_DOC_TYPE });
    }
    reply.code(201);
    return { success: true, data: await linkVatCertificate(app.prisma, vendorId, doc) };
  });

  /**
   * [ROLE-DOCS · owner ruling 21 Oct 2026] POST /onboarding/own-name — the owner of a store that trades under their
   * OWN name (Business Names (Registration) Act s.3: their true surname, with nothing added except their first names
   * or initials) signs the own-name declaration instead of uploading a business registration (vendor/own-name.ts).
   * Refused when the store's name clearly is not the account's own name, when the store is a service business (no
   * registration is asked of it) or on the self-declared tier, and when a business registration is already on file.
   * Records the signature in the consent ledger (words hashed, version pinned), files the signed words as the
   * `own_name_declaration` document a person reviews against the owner's ID, and marks THIS store — only this one —
   * as trading under the owner's own name [REVIEW-G #2046 S2-1, COORD 23 Oct: per store, never per type]: another
   * store of the owner keeps needing its business registration. Owner only.
   */
  app.post('/onboarding/own-name', auth, async (request, reply) => {
    const access = await requireVendor(app, request, 'OWNER');
    const { vendorId } = access;
    const userId = request.user.userId;
    const body = z.object({
      accept: z.literal(true),
      attestationVersion: z.literal(OWN_NAME_DECLARATION_VERSION),
      privacyNoticeVersion: z.string().min(1).max(20).default(LEGAL_VERSION),
    }).parse(request.body ?? {});
    const [vendor, user, registered, existing] = await Promise.all([
      app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { id: true, name: true, tier: true, vendorType: true, ownerId: true, tradesUnderOwnName: true } }),
      app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { firstName: true, lastName: true } }),
      validRegistrationRecord(app.prisma, userId),
      app.prisma.verificationDocument.findFirst({ where: { userId, docType: OWN_NAME_DOC_TYPE, status: { in: ['PENDING', 'APPROVED'] } }, select: { id: true, status: true } }),
    ]);
    if (!(OWN_NAME_VENDOR_TYPES as readonly string[]).includes(vendor.vendorType)) {
      throw new AppError(400, 'OWN_NAME_NOT_APPLICABLE', 'A service business is not asked for a business registration, so it needs no own-name declaration.');
    }
    if (vendor.tier === 'UNREGISTERED') throw new AppError(409, 'OWN_NAME_NOT_APPLICABLE', 'This store is on the self-declared tier. Contact support to change how it is registered.');
    if (registered) throw new AppError(409, 'ALREADY_REGISTERED', 'A business registration is on file for this store, so it needs no own-name declaration.');
    if (existing?.status === 'PENDING' || (existing && vendor.tradesUnderOwnName)) {
      throw new AppError(409, 'OWN_NAME_DECLARATION_EXISTS', `Your own-name declaration is already ${existing.status === 'APPROVED' ? 'on file' : 'waiting for review'}.`);
    }
    // An approval a person gave for the store's name BEFORE the owner switched to a business name (when the store
    // could be renamed) is not reused for whatever the name is now: a person decides.
    if (existing) throw new AppError(409, 'OWN_NAME_SUPPORT', 'An earlier own-name declaration is on file. Contact support to trade under your own name again.');
    if (!storeNameIsOwnName(vendor.name, user.firstName, user.lastName)) {
      throw new AppError(400, 'OWN_NAME_MISMATCH', `“${vendor.name}” is not just your surname with your first names or initials, so the law asks you to register it as a business name. Upload your business registration instead.`);
    }
    // Acquire and wrap the key BEFORE publishing words, changing the store, or recording consent (as the declaration).
    const dek = generateDek();
    let wrappedDek: Buffer;
    try {
      const keys = getKeyProvider();
      if (!keys) throw new Error('Envelope encryption unavailable');
      wrappedDek = await keys.wrapDek(dek);
    } catch {
      throw new AppError(503, 'VERIFICATION_UPLOAD_UNAVAILABLE', 'Verification uploads are temporarily unavailable. Try again later.');
    }
    await publishLegalDocumentOnce(app.prisma, { documentType: OWN_NAME_CONSENT_TYPE, version: OWN_NAME_DECLARATION_VERSION, renderedText: OWN_NAME_DECLARATION_V1 });
    const signedAt = new Date();
    const platform = String(request.headers['x-client-platform'] ?? '').toLowerCase();
    const surface: ConsentSurface = platform === 'ios' || platform === 'android' ? platform : 'vendor_web';
    const legalName = `${user.firstName} ${user.lastName}`.trim();
    await app.prisma.$transaction(async (tx) => {
      // This store only: its name is the one checked, and the one the PDF and this consent row name.
      await tx.vendor.update({ where: { id: vendor.id }, data: { tradesUnderOwnName: true } });
      await recordConsent(tx, {
        subjectType: 'vendor_user', subjectId: userId, documentType: OWN_NAME_CONSENT_TYPE, version: OWN_NAME_DECLARATION_VERSION,
        action: 'granted', surface, ip: request.ip,
        evidence: { vendorId, storeName: vendor.name, signedAt: signedAt.toISOString() },
      });
    });
    const pdf = await renderOwnNamePdf({ storeName: vendor.name, legalName, signedAt });
    const storage = getStorageProvider();
    const { ciphertext, iv, authTag } = encryptBuffer(pdf, dek);
    const { url: fileUrl } = await storage.upload({ buffer: ciphertext, filename: `own-name-${OWN_NAME_DECLARATION_VERSION}.pdf.enc`, mimeType: 'application/octet-stream', folder: `verification/${userId}` });
    await app.prisma.encryptedObject.create({ data: {
      fileKey: fileUrl, iv: new Uint8Array(iv), authTag: new Uint8Array(authTag), wrappedDek: new Uint8Array(wrappedDek),
      mimeType: 'application/pdf', sizeBytes: pdf.length, sha256: createHash('sha256').update(pdf).digest('hex'), createdBy: userId,
    } });
    const role = vendor.vendorType as 'RESTAURANT' | 'SUPERMARKET' | 'STORE';
    const doc = await verification.submitDocument(userId, role, OWN_NAME_DOC_TYPE, fileUrl, body.privacyNoticeVersion, undefined, { ownNameSigned: true });
    reply.code(201);
    return { success: true, data: { nameBasis: 'OWN_NAME', declaration: { id: doc.id, status: doc.status, docType: doc.docType }, status: await verification.getStatus(userId, role) } };
  });

  /**
   * [ROLE-DOCS · owner ruling 21 Oct 2026] DELETE /onboarding/own-name — the owner uses a business name after all
   * (or the reviewer rejected the own-name declaration): THIS store goes back to needing a business registration
   * (per store, as POST). A declaration on file no longer counts for these stores (their checklist asks for the registration
   * again); it is never reused for a later name (POST refuses then: support decides). Owner only.
   */
  app.delete('/onboarding/own-name', auth, async (request) => {
    const access = await requireVendor(app, request, 'OWNER');
    const userId = request.user.userId;
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: access.vendorId }, select: { id: true, vendorType: true } });
    await app.prisma.vendor.update({ where: { id: vendor.id }, data: { tradesUnderOwnName: false } });
    await verification.reprojectVendorActivation(userId);
    const role = vendor.vendorType as 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';
    return { success: true, data: { nameBasis: 'REGISTERED', status: await verification.getStatus(userId, role) } };
  });

  /** GET /vat/report?from=YYYY-MM-DD&to=YYYY-MM-DD — [STORE-VAT · PR4] the store's VAT report for its accountant: its
   *  own supplied VAT orders, by Guyana day, as the sales lines of the GRA VAT return. OWNER only (the business's tax
   *  figures). Read from the VAT each order froze; Swift never files the return. */
  app.get('/vat/report', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const query = z.object({ from: z.string().max(10), to: z.string().max(10) }).strict().parse(request.query);
    const { storeVatReport } = await import('../store-vat/vat-report');
    return { success: true, data: await storeVatReport(app.prisma, vendorId, query.from, query.to) };
  });

  /**
   * [FOOD-PERMIT · owner ruling 24 Oct 2026] POST /onboarding/food-handlers — the owner of a REGISTERED restaurant
   * ticks, for the selected store: "Everyone who handles food here holds a current food handler's certificate."
   * (vendor/food-handlers.ts). The words are published as their own versioned document and the tick is a row in the
   * consent ledger (append-only): who (the owner), which store (evidence.vendorId), when, the words' version and hash.
   * A store that was waiting only for it goes live now (the activation projection), not at the next daily belt.
   * Refused for a home cook (self-declared tier: the certificate itself is required) and every other store type.
   * Ticking again changes nothing. Owner only.
   */
  app.post('/onboarding/food-handlers', auth, async (request, reply) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const userId = request.user.userId;
    z.object({ accept: z.literal(true), attestationVersion: z.literal(FOOD_HANDLERS_VERSION) }).parse(request.body ?? {});
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { id: true, name: true, vendorType: true, tier: true } });
    if (!foodHandlerTickApplies(vendor)) {
      throw new AppError(409, 'FOOD_HANDLERS_NOT_APPLICABLE', vendor.vendorType === 'RESTAURANT'
        ? 'A self-declared food seller uploads their own food handler’s certificate under Documents. This tick is for registered restaurants.'
        : 'Only a restaurant confirms its food handlers.');
    }
    await publishLegalDocumentOnce(app.prisma, { documentType: FOOD_HANDLERS_CONSENT_TYPE, version: FOOD_HANDLERS_VERSION, renderedText: FOOD_HANDLERS_TICK_V1 });
    const platform = String(request.headers['x-client-platform'] ?? '').toLowerCase();
    const surface: ConsentSurface = platform === 'ios' || platform === 'android' ? platform : 'vendor_web';
    const recorded = await app.prisma.$transaction(async (tx) => {
      // One tick per store at a time: the store row is the lock, and the tick is decided again under it.
      await tx.$queryRaw`SELECT "id" FROM "vendors" WHERE "id" = ${vendor.id} FOR UPDATE /* food-handlers-tick */`;
      if (await storeAttested(tx, userId, vendor.id)) return false;
      await recordConsent(tx, {
        subjectType: 'vendor_user', subjectId: userId, documentType: FOOD_HANDLERS_CONSENT_TYPE, version: FOOD_HANDLERS_VERSION,
        action: 'granted', surface, ip: request.ip,
        evidence: { vendorId: vendor.id, storeName: vendor.name, control: 'checkbox', attestedAt: new Date().toISOString() },
      });
      return true;
    });
    if (recorded) {
      // A failure here never undoes the tick: the daily belt makes the store live.
      await verification.reprojectVendorActivation(userId)
        .catch((err) => request.log.warn({ err, vendorId: vendor.id }, 'go-live projection after the food handlers tick is held for the belt'));
    }
    reply.code(recorded ? 201 : 200);
    return { success: true, data: { foodHandlers: { vendorId: vendor.id, attested: true, version: FOOD_HANDLERS_VERSION }, status: await verification.getStatus(userId, 'RESTAURANT') } };
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
      tierUsage(app.prisma, vendorId, now, { storeView: true }),
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
    // [PIN-OWNER] Either coordinate makes this an owner action, even when the
    // pair is incomplete. Refuse before validation or any profile/money write.
    const supplied = request.body as { latitude?: unknown; longitude?: unknown } | null;
    if (supplied?.latitude !== undefined || supplied?.longitude !== undefined) requireRole(access, 'OWNER');
    const body = updateVendorProfileSchema.parse(request.body);
    if (body.name !== undefined) {
      // [MC-PR3] "TEST-" store names belong to test accounts (+5920…) only; an unchanged name is never re-judged.
      const current = await app.prisma.vendor.findUnique({ where: { id: vendorId }, select: { name: true, tradesUnderOwnName: true, owner: { select: { user: { select: { phone: true } } } } } });
      assertNameNotReserved(body.name, current?.owner.user.phone, current?.name);
      // [ROLE-DOCS · owner 21 Oct 2026] A store trading under its owner's own name was checked by a person as THAT name
      // (Business Names (Registration) Act s.3); a new name is a new legal question, so it is not changed in the app.
      if (current?.tradesUnderOwnName && body.name.trim() !== current.name) {
        throw new AppError(409, 'OWN_NAME_RENAME', 'This store trades under your own name, which a person checked. To use a different name, register it as a business name first, then switch the store to it under Documents.');
      }
    }
    // [REVIEW-PARTNER · DL-5] The store-review fiction moves no money: an MMG pay link is
    // refused before it is even read, and before any step-up, write or owner notice.
    if ((body.mmgPayUrl !== undefined || body.mmgNumber !== undefined) && request.tenantKind === 'REVIEW') throw new ReviewDemoMoneyRefusedError();
    // [owner 17 Oct 2026 · PAYMENT-SIMPLIFY] The pay link is replaced by the MMG number: while
    // STORE_MMG_PAY_LINK is off a NEW link is refused before step-up or any money-surface write.
    if (body.mmgPayUrl !== undefined) assertStoreMmgPayLinkWritable(body.mmgPayUrl);
    // [Q8] A moved pin is held to the same market rule as a new store, before anything is written.
    const pin = body.latitude !== undefined && body.longitude !== undefined ? { latitude: body.latitude, longitude: body.longitude } : null;
    if (pin) assertStorePinInMarket(pin.latitude, pin.longitude);
    const mmgPayUrl = body.mmgPayUrl === undefined
      ? undefined
      : mmgPayUrlForWrite(body.mmgPayUrl);
    // [ALG-34 / ALG-INV-14] The MMG pay link is where the store's money goes.
    // Owner only, step-up first; a new link is STAGED behind a cool-off with
    // the old one still live and the owner told (integrity/money-surface.ts).
    // Clearing it is immediate — it redirects nothing.
    // [PAYMENT-SIMPLIFY · ALG-34 parity] The store's MMG number is the same kind of money
    // destination: owner only, step-up first, the same velocity budget, a new number STAGED
    // behind the same cool-off with the old one still live and the owner told; clearing is immediate.
    const mmgNumber = body.mmgNumber === undefined
      ? undefined
      : mmgNumberForWrite(body.mmgNumber);
    if (mmgPayUrl !== undefined || mmgNumber !== undefined) {
      requireRole(access, 'OWNER');
      await requireStepUp(app, request);
      await assertVelocity(app, request, 'money.mmg-link'); // [R048-007] a money surface: fails closed when the control is down
    }
    // undefined = field not sent (leave as-is); null/'' = the store takes its
    // number down. publicPhoneForWrite collapses both of the latter to null.
    const publicPhone = body.publicPhone === undefined
      ? undefined
      : publicPhoneForWrite(body.publicPhone);
    // [VERIFY-DOCS · ruling 7] The business's tax registration is the owner's to give.
    const vatRegistrationNumber = body.vatRegistrationNumber === undefined
      ? undefined
      : vatNumberForWrite(body.vatRegistrationNumber);
    if (vatRegistrationNumber !== undefined) requireRole(access, 'OWNER');
    // [R3 · CAA s.70(3)] The refund rule is the store's own commitment to its customers: the owner's to give.
    if (body.refundRule !== undefined) requireRole(access, 'OWNER');
    const refundRule = refundRuleForWrite(body.refundRule);
    // [IMAGES-E2E] The logo and cover are photos the store UPLOADS (POST /profile/logo|cover:
    // scanned, redrawn without metadata, kept where the public door serves them). Typed
    // text may only take one down ('' = none) or repeat what is already there.
    const photoFields = await storePhotoFieldsForWrite(app, vendorId, body.logoUrl, body.coverImageUrl);
    let photoOrphans: string[] = [];

    // [DS269 F1] A pin move commits with its record: the row is locked, the pin
    // it replaces is read, and the audit row (and the owner notice, when the
    // mover is not the owner) lands in this same transaction.
    const { vendor, pinNoticeId } = await app.prisma.$transaction(async (tx) => {
      // [BOOK-S1 · REVIEW-M S4-1] Lowering "how many at once" below what the business already
      // holds at one moment is refused in plain words, under the business's time lock (no booking
      // can slip in between the count and the change). Raising it, or keeping it, is never refused.
      if (body.bookingCapacity !== undefined) {
        await lockBusinessTime(tx, vendorId);
        const current = await tx.vendor.findUnique({ where: { id: vendorId }, select: { bookingCapacity: true } });
        if (body.bookingCapacity < (current?.bookingCapacity ?? 1)) {
          const held = await tx.booking.findMany({
            where: { vendorId, status: { not: 'CANCELLED' }, slotEnd: { gt: new Date() } },
            select: { slotStart: true, slotEnd: true },
          });
          const peak = peakMoment(held.map((b) => ({ start: b.slotStart, end: b.slotEnd })));
          if (peak.count > body.bookingCapacity && peak.at) {
            throw new AppError(409, 'BOOKING_CAPACITY_IN_USE',
              `You already have ${peak.count} appointments at the same time (${fmtSlotTime(peak.at)}). Move or cancel some of them first, or keep how many you take at once at ${peak.count} or more.`);
          }
        }
      }
      const before = pin ? await lockStorePin(tx, vendorId) : null;
      // [IMAGES-E2E PR4] A logo or cover this save takes down is deleted, not just unlinked:
      // read under the row's lock, queued for deletion in this transaction, deleted after.
      const clearing = (['logoUrl', 'coverImageUrl'] as const).filter((field) => photoFields[field] === null);
      if (clearing.length > 0) {
        const rows = await tx.$queryRaw<Array<{ logoUrl: string | null; coverImageUrl: string | null }>>`
          SELECT "logoUrl", "coverImageUrl" FROM "vendors" WHERE "id" = ${vendorId}
          FOR UPDATE /* store-photo-authority */
        `;
        photoOrphans = await queueStorePhotoDeletions(tx, vendorId, clearing.map((field) => rows[0]?.[field]));
      }
      const updated = await tx.vendor.update({
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
          ...(photoFields.logoUrl !== undefined && { logoUrl: photoFields.logoUrl }),
          ...(photoFields.coverImageUrl !== undefined && { coverImageUrl: photoFields.coverImageUrl }),
          ...(body.cuisineTypes !== undefined && { cuisineTypes: body.cuisineTypes }),
          ...(body.tags !== undefined && { tags: body.tags }),
          ...(body.deliveryRadius !== undefined && { deliveryRadius: body.deliveryRadius }),
          ...(body.minOrderAmount !== undefined && { minOrderAmount: body.minOrderAmount }),
          ...(body.estimatedPrepTime !== undefined && { estimatedPrepTime: body.estimatedPrepTime }),
          ...(body.selfDeliveryEnabled !== undefined && { selfDeliveryEnabled: body.selfDeliveryEnabled }),
          ...(body.requirePickupCode !== undefined && { requirePickupCode: body.requirePickupCode }),
          ...(body.maxConcurrentOrders !== undefined && { maxConcurrentOrders: body.maxConcurrentOrders }),
          ...(body.bookingCapacity !== undefined && { bookingCapacity: body.bookingCapacity }),
          ...(publicPhone !== undefined && { publicPhone }),
          ...(vatRegistrationNumber !== undefined && { vatRegistrationNumber }),
          ...(refundRule !== undefined && { refundRule }),
        },
        include: { operatingHours: { orderBy: { dayOfWeek: 'asc' } } },
      });
      // [STORE-VAT] A new VAT number is a new claim: an approval for another number stops standing.
      if (vatRegistrationNumber !== undefined) await storeVatNumberChanged(tx, vendorId, vatRegistrationNumber);
      const noticeId = pin && before
        ? await recordStorePinMove(tx, { vendorId, before, to: pin, actorUserId: request.user.userId, actorRole: access.role })
        : null;
      return { vendor: updated, pinNoticeId: noticeId };
    });
    // The notice committed with the move; fanning it out afterwards cannot undo either.
    if (pinNoticeId) await notifications.publishPersisted(pinNoticeId);
    await deleteQueuedPhotos(photoOrphans);

    if (mmgPayUrl === null) {
      await clearMmgLink({ prisma: app.prisma, io: app.io, redis: app.redis }, { actor: 'VENDOR', entityId: vendorId, userId: request.user.userId });
    } else if (mmgPayUrl !== undefined) {
      await stageMmgLinkChange({ prisma: app.prisma, io: app.io, redis: app.redis }, {
        actor: 'VENDOR', entityId: vendorId, userId: request.user.userId, sessionId: request.authSessionId, newUrl: mmgPayUrl,
      });
    }
    if (mmgNumber === null) {
      await clearMmgLink({ prisma: app.prisma, io: app.io, redis: app.redis }, { actor: 'VENDOR', entityId: vendorId, userId: request.user.userId, field: 'NUMBER' });
    } else if (mmgNumber !== undefined) {
      await stageMmgLinkChange({ prisma: app.prisma, io: app.io, redis: app.redis }, {
        actor: 'VENDOR', entityId: vendorId, userId: request.user.userId, sessionId: request.authSessionId, newNumber: mmgNumber, field: 'NUMBER',
      });
    }
    // [owner #51] A never-live store whose documents are done waits only for
    // its published number: once it has one, the activation projection runs
    // now (not at the next daily belt) and the store goes live. A failure
    // there never undoes the saved number — the belt heals it.
    if (publicPhone && awaitingFirstGoLive(vendor)) {
      await verification.reprojectVendorActivation(await vendorOwnerUserId(app, vendorId))
        .catch((err) => request.log.warn({ err, vendorId }, 'go-live projection after the published number was saved is held for the belt'));
    }
    // The link state is read back AFTER staging so the response says what is
    // live and what is pending — never the value the caller sent.
    const link = await app.prisma.vendor.findUniqueOrThrow({
      where: { id: vendorId },
      select: {
        mmgPayUrl: true, mmgPayUrlPending: true, mmgPayUrlApplyAt: true,
        mmgNumber: true, mmgNumberPending: true, mmgNumberApplyAt: true,
        status: true, isVerified: true, acceptingOrders: true,
      },
    });

    // On-write search sync [SWIFT-UG-SRCH-01]: catalog writes schedule a debounced per-vendor reindex.
    scheduleVendorSearchSync(app, vendorId);

    return {
      success: true,
      data: {
        ...vendor,
        ...(access.role !== 'OWNER' ? { vatRegistrationNumber: undefined } : {}),
        ...link,
        ...storeMoneySurfaceView(link),
        // [GUARDRAILS §8 · owner 14 Oct, store names] A rename is judged at once: the partner reads whether it waits.
        storeCheck: partnerStoreView(storeCheckOf(vendor)),
        nameReviewApprovedHash: undefined,
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

  /** DELETE /profile/mmg-number/pending — [PAYMENT-SIMPLIFY · ALG-34 parity] "this wasn't me"
   *  for the store's MMG number: drop the staged change and sign out every other device.
   *  Owner only; no step-up — cancelling is always the safe direction. */
  app.delete('/profile/mmg-number/pending', auth, async (request) => {
    await assertVelocity(app, request, 'money.mmg-link.cancel'); // [R048-007]
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const data = await cancelMmgLinkChange({ prisma: app.prisma, io: app.io, redis: app.redis }, {
      actor: 'VENDOR', entityId: vendorId, userId: request.user.userId, keepSessionId: request.authSessionId, field: 'NUMBER',
    });
    return { success: true, data };
  });

  // =========================================================================
  // 2. VENDOR MANAGEMENT — Toggle open / accepting orders
  // =========================================================================

  /** [owner 21 Oct · COORD 03:15Z] The state a store switch should END in, when the client says so.
   *  The switches used to FLIP whatever the server held and ignore the body: with the phone and the
   *  website open at once, an owner closed the store on the phone and a manager's stale "Close" on the
   *  website then OPENED it, and it took orders. A client that sends the desired state gets exactly
   *  that state (asking for the state it is already in changes nothing). An older app that sends no
   *  body (builds 9 and 11) still flips. */
  const desiredSwitch = (body: unknown, field: 'isCurrentlyOpen' | 'acceptingOrders'): boolean | undefined => {
    if (body === null || body === undefined || typeof body !== 'object') return undefined;
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new AppError(400, 'VALIDATION_ERROR', `${field} must be true or false.`);
    return value;
  };

  /** PUT /vendor/toggle-open — Toggle isCurrentlyOpen */
  app.put('/vendor/toggle-open', auth, async (request) => {
    const desired = desiredSwitch(request.body, 'isCurrentlyOpen');
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    // Already where the client wants it: nothing changes (never the opposite of what was tapped).
    if (desired === vendor.isCurrentlyOpen) {
      return { success: true, data: { isCurrentlyOpen: vendor.isCurrentlyOpen, acceptingOrders: vendor.acceptingOrders } };
    }

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
    const desired = desiredSwitch(request.body, 'acceptingOrders');
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const vendor = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    // Already where the client wants it: nothing changes (never the opposite of what was tapped).
    if (desired === vendor.acceptingOrders) {
      return { success: true, data: { isCurrentlyOpen: vendor.isCurrentlyOpen, acceptingOrders: vendor.acceptingOrders } };
    }

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
      || await verification.isRoleVerified(await vendorOwnerUserId(app, vendorId), vendor.vendorType, app.prisma, vendorId);
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
      const verifiedOk = await verification.isRoleVerified(toggleOwnerUserId, locked.vendorType, tx, vendorId);
      if (!verifiedOk) {
        if (locked.isVerified) staleVerifiedToHeal = true;
        throw new AppError(403, 'VERIFICATION_REQUIRED',
          'Your store can take orders once its documents are verified. Check Documents for anything missing or expired.');
      }
      // Subscription re-evaluated under the same lock (grace lapse included).
      const sub = await tx.subscription.findFirst({ where: { vendorId }, orderBy: { createdAt: 'desc' } });
      const toggleOperability = subscriptionOperability(sub, { missingRow: 'GRANDFATHER' }, await readFeePause(tx, process.env, sub?.id));
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
            await vendorOwnerUserId(app, vendorId), still.vendorType, tx, vendorId);
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
    await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    // Alert-delivery ack (§A4): the store ACTED on this order's alert. [Q10]
    // Only AFTER the ownership check: it used to run first, so any signed-in
    // account naming an order id stamped that store receipt, then got a 404.
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(app.prisma, 'VENDOR_ORDER', request.params.id).catch(() => {});
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

    // LIFECYCLE_V2: a held order does not exist for the vendor yet, and one
    // cancelled inside its hold never will [Q12]. Lives in AND[] so the search
    // block's own OR can't clobber it.
    const where: Record<string, unknown> = { vendorId: ordersScope(access, requested), AND: [vendorVisibleFilter(app.prisma)] };
    if (status) where['status'] = status;
    if (orderType) where['orderType'] = orderType;
    if (from) where['placedAt'] = { ...(where['placedAt'] as object || {}), gte: from };
    if (to) where['placedAt'] = { ...(where['placedAt'] as object || {}), lte: to };
    if (search) {
      where['OR'] = [
        { orderNumber: { contains: search, mode: 'insensitive' } },
        { customer: { firstName: { contains: search, mode: 'insensitive' } } },
        // [COORD 17 Oct] No search by a customer's last name: the store is no longer shown it, and a
        // search would reveal it one guess at a time.
      ];
    }

    const [orders, total] = await Promise.all([
      app.prisma.order.findMany({
        where,
        // HND-003: strip handover secrets from the vendor board too (see resolveOwnedOrder).
        omit: { pickupCode: true, pickupCodeAttempts: true, ridePin: true },
        include: {
          items: VENDOR_ORDER_ITEMS,
          customer: { select: { id: true, firstName: true } }, // [COORD 17 Oct] never the last name
          // [F-027-07] allow-list, not `include` — see utils/counterparty.
          rider: { select: riderCounterpartySelect({ withPhone: true }) },
          // Franchise roll-up: the board aggregates every store the owner has, so each
          // order needs to say which store it belongs to.
          vendor: { select: { id: true, name: true, selfDeliveryEnabled: true, requirePickupCode: true } },
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
    const roles = await storeRoles(app, request.user.userId, access);
    const handover = await storeHandoverFields(app, orders);
    // [S1 response-shaping] a terminal order no longer hands floor staff the
    // customer's phone, the rider's phone, or the delivery address/GPS — the
    // live order keeps all of it, which is the only thing a handover needs.
    const data = orders.map((order) => withCounterpartPhones(request, redactCustomerContact({
      ...coerceMoney(order, ORDER_MONEY_FIELDS),
      ...handover.get(order.id),
      items: order.items.map((item) => vendorOrderLine(coerceMoney(item, ORDER_ITEM_MONEY_FIELDS))),
      respondBy: vendorRespondBy(order, respondOpts),
      ...storeMmgPayBy(order),
      canConfirmPayment: canConfirmPayment(order.vendorId ? roles.get(order.vendorId) : undefined),
    })));

    return { success: true, ...paginatedResponse(data, total, pagination) };
  });

  /** GET /orders/:id — Full order detail */
  app.get<{ Params: IdParam }>('/orders/:id', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    // The takeover polls this read: the response-SLA deadline is computed here,
    // from the same inputs the auto-cancel job was enqueued with.
    const respondBy = vendorRespondBy(order, { slaMinutes: await vendorResponseSlaMinutes(app.prisma), holdMs: holdWindowMs() ?? 0 });
    // [S1 response-shaping] same redaction as the board — closed order, no
    // customer contact, rider contact, or delivery destination.
    // [AF-MOB-006] The store sees the order's recovery case: a return coming
    // back to it, another rider taking over, or support holding it.
    const custodyRecovery = mayHaveCase(order) ? partyCaseView(await latestCaseFor(app.prisma, order.id), 'VENDOR', order) : null;
    const { role } = await orderStoreMember(app, request.user.userId, order.vendorId!);
    const handover = (await storeHandoverFields(app, [order])).get(order.id);
    // [BOOK-FU2 · REVIEW-F S3-1 on #2201] An appointment says whether "Customer didn't come" may be recorded now
    // (booking/appointment-no-show.ts noShowView); the partner app shows the button only on noShow.allowed === true.
    const noShow = order.fulfillment === 'APPOINTMENT' ? { noShow: noShowView(order, new Date()) } : {};
    return { success: true, data: { ...redactCustomerContact({ ...order, ...handover, items: order.items.map(vendorOrderLine), respondBy, ...storeMmgPayBy(order), canConfirmPayment: canConfirmPayment(role), ...noShow }), custodyRecovery } };
  });

  /** [AF-MOB-006] POST /orders/:id/recovery/return-received — the store
   *  confirms the goods came back. Closes the return (RETURNED) through the
   *  canonical seam, which resolves the case and frees the rider. */
  app.post<{ Params: IdParam }>('/orders/:id/recovery/return-received', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    if (order.orderType === 'COURIER') {
      throw new AppError(409, 'NOT_A_STORE_RETURN', 'A courier parcel goes back to its sender, not to a store.');
    }
    const kase = await confirmReturn({ ...custodyDeps, orderService }, {
      orderId: order.id, actor: { userId: request.user.userId, role: 'VENDOR' },
    });
    return { success: true, data: { orderId: order.id, caseId: kase.id, state: kase.state } };
  });

  /** PUT /orders/:id/accept — Accept an incoming order */
  app.put<{ Params: IdParam }>('/orders/:id/accept', tap, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    // Alert-delivery ack (§A4): the store ACTED on this order's alert, for
    // every recipient. [Q10] After the ownership check, never before it.
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(app.prisma, 'VENDOR_ORDER', order.id).catch(() => {});
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
    // [O-4 · owner 22 Oct 2026] The store accepts the WHOLE order — after the customer answered every
    // "Out of stock" question asked before acceptance (early answer; the authority is the locked
    // re-check inside the transition below).
    assertNoOpenCustomerQuestion(order.items);
    const body = acceptOrderSchema.parse(request.body ?? {});

    // Appointment orders book their slot AT ACCEPTANCE (locked model). If the
    // slot was taken since checkout, this 409s and the order stays PENDING —
    // the customer picks a new time instead of holding a phantom booking.
    // [BOOK-S2] A slot already taken at checkout (INSTANT_BOOKING on) is not
    // taken twice: the transition's coupling seam confirms it, and the
    // reservation below finds it held and returns it.
    // [REPORT-007-v4 F-05] The reservation and prep-time write ride the SAME
    // Order-lock transaction as the ACCEPTED transition: a concurrent
    // cancellation serializes on that lock, so acceptance can no longer lose
    // the race yet leave behind a CONFIRMED slot-blocking booking (its throw
    // rolls the booking back with the transition).
    const appointmentItemId = order.fulfillment === 'APPOINTMENT' && order.appointmentSlot
      ? order.items[0]?.itemId ?? null
      : null;
    // [BOOK-S3 · REVIEW-G S4-2 on #2192] With INSTANT_BOOKING on, a request whose slot was
    // not held at checkout (placed while the switch was off) takes its booking under the
    // customer's slot-squatting cap, like every booking taken at checkout.
    const bookingLimits = appointmentItemId && instantBookingEnabled()
      ? await bookingLimitsFor(app.prisma, order.tenantId)
      : undefined;
    // [O-3 · owner 22 Oct 2026] Accept IS the start of preparation (STORE_ACCEPT_PATH): one tap,
    // PENDING -> ACCEPTED -> PREPARING in this one commit, one push to the customer. A booking or an
    // MMG order still waiting for "Paid by MMG" stops at ACCEPTED (preparationMayStart).
    const [acceptedStatus, preparingStatus] = STORE_ACCEPT_PATH;
    const updated = await orderService.updateStatus(order.id, acceptedStatus, request.user.userId, 'Accepted by vendor', {
      continueTo: { target: preparingStatus, note: 'Preparing: the store accepted the order', when: preparationMayStart },
      withinTransaction: async (tx, lockedOrder) => {
        // [Q12 · AX289 F1] An order whose hold lapsed before the release sweep
        // reached it: accepting takes it out of the sweep's reach, so the
        // acceptance releases it — counted for the store once, here.
        await releaseLapsedHoldInTransaction(tx, order.id);
        // [O-4] On the locked row: a question asked after the route's read is seen here.
        assertNoOpenCustomerQuestion(await tx.orderItem.findMany({
          where: { orderId: order.id },
          select: { name: true, subStatus: true, substituteDecideBy: true },
        }));
        if (appointmentItemId && order.appointmentSlot) {
          // Switch off: the call it always was (no cap argument).
          await bookingService.reserveSlot(appointmentItemId, order.customerId, order.appointmentSlot, order.id, tx, ...(bookingLimits ? [bookingLimits] : []));
        }
        if (body.estimatedPrepTime) {
          await tx.order.update({
            where: { id: order.id },
            data: { estimatedPrepTime: body.estimatedPrepTime },
          });
        }
        await bindUnresolvedDeliveryMode(tx, lockedOrder);
      },
    });
    if (appointmentItemId) await bookingService.nudgeForItem(appointmentItemId).catch(() => {});
    await ackVendorAlert(app, request.user.userId, order.id); // accepting acknowledges the alert

    // acceptance of a DELIVERY order starts the dispatch cascade (PICKUP and
    // APPOINTMENT orders never dispatch). FUL-005: this is the ON_ACCEPT trigger
    // (the default) — the rider travels to the store during prep. ON_READY
    // defers dispatch to the Mark-ready transition below instead.
    if (updated.fulfillmentMode === 'VENDOR_DELIVERY') {
      await dispatch.retireForVendorDelivery(order.id, updated.fulfillmentModeVersion);
    } else if (updated.fulfillmentMode === 'PLATFORM_RIDER' && dispatchTrigger() === 'ON_ACCEPT' && !mmgDispatchBlocked(updated)) {
      // [owner 17 Oct 2026 · PAYMENT-SIMPLIFY · Q1] An MMG order the store accepts BEFORE the money
      // arrives arms no dispatch here: no rider is sought for an unpaid order. The store's
      // "Paid by MMG" (confirm-payment) arms it instead.
      await startPlatformDeliveryAfterCommit(order, updated.fulfillmentModeVersion, 'accept');
    }

    return { success: true, data: updated };
  });

  /** Statuses where a rider already owns the status lane. Kitchen progress
   *  then rides the preparingAt/readyAt timestamps instead of the status —
   *  without this, a rider accepting within seconds of the vendor (the normal
   *  case) killed the vendor's Start-preparing/Mark-ready buttons with 400s. */
  const COURIER_ACTIVE: OrderStatus[] = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'];

  async function recordPrepProgress(
    order: {
      id: string; status: OrderStatus; vendorId: string | null; riderId: string | null;
      orderNumber: string; preparingAt: Date | null; paymentMethod: string | null;
      paymentStatus: string; orderType: string | null; mmgClaimMismatchAt: Date | null;
    },
    phase: 'PREPARING' | 'READY',
    userId: string,
  ) {
    // [SPS-F-0016 / REPORT-004 F-004-05] Milestone timestamps are the ALTERNATE
    // representation of preparing/ready when a rider owns the status lane — the
    // payment-first law applies to them exactly as it does to the transitions.
    assertMmgFulfilmentAllowed(order, phase === 'PREPARING' ? 'PREPARING' : 'READY_FOR_PICKUP');
    const now = new Date();
    // [E04] The milestone write, the status-log append and the ownership check
    // share ONE transaction on the order-row lock (the
    // stageCanonicalOrderTransition / lockPickableOrder pattern), so a
    // cancellation — or a rider release/handback — that commits after the
    // route's read is seen on the LOCKED re-read and refuses here with nothing
    // written, nothing logged and nothing pushed. Pinning riderId refuses the
    // release-then-regrab path (the stale screen's rider is no longer the
    // owner); the empty-milestone check keeps two rapid taps from
    // double-logging and double-pushing.
    const stale = () => new AppError(
      409,
      'HANDOVER_STALE',
      'This order changed since the screen was loaded — refresh before acting on it.',
    );
    const { row, alreadyStamped } = await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} FOR UPDATE`;
      const live = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        omit: HANDOVER_SECRETS_OMIT,
      });
      if (!COURIER_ACTIVE.includes(live.status)) throw stale();
      if (live.riderId !== order.riderId) throw stale();
      // Payment-first, evaluated on the locked fresh row (the canonical seam's
      // rule) — a capture/dispute that landed after the route's read is not
      // stamped over.
      assertMmgFulfilmentAllowed(live, phase === 'PREPARING' ? 'PREPARING' : 'READY_FOR_PICKUP');
      const stamped = phase === 'PREPARING' ? live.preparingAt : live.readyAt;
      if (stamped) return { row: live, alreadyStamped: true as const };
      // Marking READY implies preparing happened — backfill it for the timeline
      // (from the fresh row, not the stale pre-read).
      // [F1] The answer goes to the store: never the codes it hands over against.
      const next = await tx.order.update({
        where: { id: order.id },
        omit: HANDOVER_SECRETS_OMIT,
        data: phase === 'PREPARING'
          ? { preparingAt: now }
          : { readyAt: now, ...(live.preparingAt ? {} : { preparingAt: now }) },
      });
      await tx.orderStatusLog.create({
        data: {
          orderId: order.id,
          status: live.status,
          changedBy: userId,
          note: phase === 'PREPARING' ? 'Vendor started preparing (rider already assigned)' : 'Order ready for pickup (rider already assigned)',
        },
      });
      return { row: next, alreadyStamped: false as const };
    });
    if (alreadyStamped) return row;
    const evt = { orderId: order.id, prep: phase, timestamp: new Date().toISOString() };
    await emitToOrderRoom(app.prisma, app.io, order.id, 'order:prep_update', evt);
    if (order.vendorId) await emitToStoreRoom(app.prisma, app.io, order.vendorId, 'order:prep_update', evt);
    // The rider on the FRESH row is the one who needs "it's ready" — never the
    // rider the stale screen read. Re-check after commit and push only while
    // that rider still owns the order, so a cancellation landing right after
    // this milestone never notifies a freed rider.
    if (phase === 'READY' && row.riderId) {
      const stillOwns = await app.prisma.order.findFirst({
        where: { id: order.id, riderId: row.riderId, status: { in: COURIER_ACTIVE } },
        select: { id: true },
      });
      if (stillOwns) {
        const rider = await app.prisma.rider.findUnique({ where: { id: row.riderId }, select: { userId: true } });
        if (rider) {
          // [Q10] The RIDER copy: tagged earner, so the shopping inbox of a
          // rider who also orders never lists it, and the tap-router opens
          // the rider live job (ActiveJob) rather than the customer screen.
          await notifications.send({
            userId: rider.userId,
            type: 'ORDER_UPDATE',
            title: 'Order ready for pickup',
            body: `Order ${row.orderNumber} is packed and waiting at the counter.`,
            audience: 'earner',
            data: { orderId: order.id, kind: 'prep_ready' },
          });
        }
      }
    }
    return row;
  }

  /** PUT /orders/:id/preparing — Mark order as being prepared */
  app.put<{ Params: IdParam }>('/orders/:id/preparing', tap, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    await assertVendorCanOperate(order.vendorId!, 'IN_FLIGHT');
    // A booking has no kitchen: it is confirmed, then completed with
    // complete-appointment. Marking it "preparing" sent the customer kitchen
    // pushes for a haircut and stranded it (complete-appointment requires
    // ACCEPTED). The canonical transition refuses this too, for every caller.
    if (order.fulfillment === 'APPOINTMENT') {
      throw new AppError(400, 'NOT_A_KITCHEN_ORDER', 'A booking is not prepared — confirm it, then mark it complete.');
    }
    if (order.status === 'ACCEPTED') {
      const updated = await orderService.updateStatus(order.id, 'PREPARING', request.user.userId, 'Vendor started preparing');
      return { success: true, data: updated };
    }
    // [O-3] Accept already started preparation. Store builds 9/11/12 (and a stale web tab) still
    // show "Start preparing" after an accept: their tap is a 200 no-op that answers with the order
    // as it is — never an error, never a second status row or push. A closed order still refuses.
    if (order.preparingAt && !isTerminalOrderStatus(order.status)) {
      return { success: true, data: order };
    }
    if (COURIER_ACTIVE.includes(order.status)) {
      if (order.preparingAt) return { success: true, data: order }; // double-tap safe
      const updated = await recordPrepProgress(order, 'PREPARING', request.user.userId);
      return { success: true, data: updated };
    }
    throw new AppError(400, 'INVALID_STATUS', `Cannot mark as preparing from ${order.status} status`);
  });

  /** PUT /orders/:id/ready — Mark order as ready for pickup */
  app.put<{ Params: IdParam }>('/orders/:id/ready', tap, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    await assertVendorCanOperate(order.vendorId!, 'IN_FLIGHT');
    // A booking is never "ready for pickup" — see /preparing above; a booking
    // that already sits in PREPARING is not reopened into the kitchen path.
    if (order.fulfillment === 'APPOINTMENT') {
      throw new AppError(400, 'NOT_A_KITCHEN_ORDER', 'A booking is not marked ready — confirm it, then mark it complete.');
    }
    // Grocery/goods picking gate (§5.3): the bag never closes with an open
    // question in it — every line picked, or its substitution resolved.
    // Restaurants don't shelf-pick, so only quantity-tracked store types gate.
    if (order.vendorId) {
      const v = await app.prisma.vendor.findUnique({ where: { id: order.vendorId }, select: { vendorType: true } });
      if (v && ['SUPERMARKET', 'STORE'].includes(v.vendorType)) {
        const state = await picking.readiness(order.id);
        if (state.unresolved > 0) {
          // [O-4] Ticks are optional: only an open customer question holds the bag.
          throw new AppError(409, 'PICKING_INCOMPLETE', `${state.unresolved} item${state.unresolved === 1 ? ' is' : 's are'} still waiting for the customer's answer`);
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
      const updated = await orderService.updateStatus(order.id, 'READY_FOR_PICKUP', request.user.userId, 'Order ready for pickup', {
        withinTransaction: bindUnresolvedDeliveryMode,
      });
      // FUL-005: ON_READY — dispatch NOW, when the food is ready, not at accept.
      // No-op under the ON_ACCEPT default (the rider was already dispatched); and
      // never dispatches if a rider is already assigned.
      if (updated.fulfillmentMode === 'VENDOR_DELIVERY') {
        await dispatch.retireForVendorDelivery(order.id, updated.fulfillmentModeVersion);
      } else if (updated.fulfillmentMode === 'PLATFORM_RIDER' && dispatchTrigger() === 'ON_READY') {
        await startPlatformDeliveryAfterCommit(order, updated.fulfillmentModeVersion, 'ready');
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
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    await assertVendorCanOperate(order.vendorId!, 'IN_FLIGHT');
    const { mode } = fulfillmentModeSchema.parse(request.body);
    if (order.fulfillment !== 'DELIVERY') {
      throw new AppError(400, 'NOT_DELIVERY', 'Only delivery orders have a fulfillment mode');
    }
    if (isTerminalOrderStatus(order.status)) {
      throw new AppError(409, 'ORDER_CLOSED', 'This order is already closed');
    }
    // The rider claim path locks this same row. Whichever decision wins the
    // lock wins custody; the loser receives a conflict rather than producing
    // both a vendor courier and a Swift rider for one order.
    const committed = await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} FOR UPDATE`;
      const live = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        select: {
          id: true,
          vendorId: true,
          status: true,
          fulfillment: true,
          fulfillmentMode: true,
          fulfillmentModeVersion: true,
          riderId: true,
          // [#1875 · REVIEW-G/M S4] the MMG dispatch gate is judged on THIS locked row, not the route's pre-read
          paymentMethod: true,
          orderType: true,
          paymentStatus: true,
          mmgClaimMismatchAt: true,
        },
      });
      if (live.fulfillment !== 'DELIVERY') {
        throw new AppError(400, 'NOT_DELIVERY', 'Only delivery orders have a fulfillment mode');
      }
      if (isTerminalOrderStatus(live.status)) {
        throw new AppError(409, 'ORDER_CLOSED', 'This order is already closed');
      }
      if (mode === 'VENDOR_DELIVERY') {
        const vendor = live.vendorId
          ? await tx.vendor.findUnique({ where: { id: live.vendorId }, select: { selfDeliveryEnabled: true } })
          : null;
        if (!vendor?.selfDeliveryEnabled) {
          throw new AppError(400, 'SELF_DELIVERY_DISABLED', 'Turn on self-delivery in settings first');
        }
      }
      if (mode === 'VENDOR_DELIVERY' && live.riderId) {
        throw new AppError(409, 'RIDER_ALREADY_ASSIGNED', 'A Swift rider already has this order');
      }
      if (mode === 'PLATFORM_RIDER' && live.fulfillmentMode === 'VENDOR_DELIVERY' && live.riderId) {
        throw new AppError(409, 'CUSTODY_CONFLICT', 'This order has conflicting delivery custody and needs operator review');
      }
      if (live.fulfillmentMode === mode) return live;
      return tx.order.update({
        where: { id: order.id },
        data: { fulfillmentMode: mode, fulfillmentModeVersion: { increment: 1 } },
      });
    });
    // Fallback: "get a rider instead" dispatches a platform rider now if none is
    // on it yet. VENDOR_DELIVERY needs no rider — the vendor's own courier delivers.
    if (mode === 'VENDOR_DELIVERY') {
      await dispatch.retireForVendorDelivery(order.id, committed.fulfillmentModeVersion);
    } else if (!committed.riderId && !mmgDispatchBlocked(committed)) {
      // [#1848 follow-up · REVIEW-M S4-1] Like acceptance: an MMG order not yet "Paid by MMG" arms no
      // dispatch here — "Paid by MMG" arms it. Decided on the committed row (the locked read, or the row the
      // switch wrote), so a "Paid by MMG" that landed while the switch waited for the lock is seen.
      await startPlatformDeliveryAfterCommit(order, committed.fulfillmentModeVersion, 'mode_switch');
    }
    return { success: true, data: { orderId: order.id, fulfillmentMode: mode } };
  });

  // ── Grocery picking (§5.3) — the pick list inside PREPARING ───────────────

  /** PUT /orders/:id/items/:lineId/picked — staff tick a shelf-picked line. */
  app.put('/orders/:id/items/:lineId/picked', auth, async (request) => {
    const { id, lineId } = request.params as { id: string; lineId: string };
    await resolveOwnedOrder(app, request.user.userId, id, request);
    const { picked } = z.object({ picked: z.boolean() }).parse(request.body);
    const line = await picking.setPicked(id, lineId, picked);
    return { success: true, data: line };
  });

  /** POST /orders/:id/items/:lineId/substitute — out of stock: propose a swap
   *  the CUSTOMER approves live. Same vendor; same substitutionGroup when set. */
  app.post('/orders/:id/items/:lineId/substitute', auth, async (request) => {
    const { id, lineId } = request.params as { id: string; lineId: string };
    const order = await resolveOwnedOrder(app, request.user.userId, id, request);
    const { substituteItemId } = z.object({ substituteItemId: z.string().min(1) }).parse(request.body);
    const line = await picking.proposeSubstitution(id, lineId, substituteItemId, request.user.userId);
    await ackPreAcceptQuestion(order, request.user.userId);
    return { success: true, data: line };
  });

  /** POST /orders/:id/items/:lineId/refund-line — nothing to swap: the line
   *  comes off the order, totals shrink, stock goes back on the shelf. */
  app.post('/orders/:id/items/:lineId/refund-line', auth, async (request) => {
    const { id, lineId } = request.params as { id: string; lineId: string };
    const order = await resolveOwnedOrder(app, request.user.userId, id, request);
    // [O-4] On a waiting order this ASKS the customer (continue without it, or cancel); after the
    // accept it removes the line at once, as before.
    const line = await picking.refundLine(id, lineId, request.user.userId);
    await ackPreAcceptQuestion(order, request.user.userId);
    return { success: true, data: line };
  });

  /** [O-4] A store that asked the customer about an item before accepting has answered its new-order
   *  alert: the "still waiting" ladder stops (the same ack an accept or a reject gives). */
  async function ackPreAcceptQuestion(order: { id: string; status: OrderStatus }, userId: string) {
    if (order.status !== 'PENDING') return;
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(app.prisma, 'VENDOR_ORDER', order.id).catch(() => {});
    await ackVendorAlert(app, userId, order.id);
  }

  /** POST /items/:id/adjust — reasoned stock movement (received/damaged/…),
   *  atomic and logged. The audit trail behind quantity-on-hand.
   *
   *  [MASTER-025] ONE command. The canonical movement, the adjustment record
   *  and the availability edges commit in one transaction — a failure in any
   *  of them leaves the stock unmoved, so an error answer is the truth. With an
   *  `Idempotency-Key` the adjustment record is the command's durable receipt
   *  (unique per item): a retry of the same command returns the committed
   *  movement instead of moving stock again; the same key naming a different
   *  adjustment is refused; a new key is a new, intentional adjustment. */
  app.post<{ Params: IdParam }>('/items/:id/adjust', auth, async (request) => {
    const access = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const body = z.object({
      delta: z.number().int().min(-100_000).max(100_000).refine((n) => n !== 0, 'Zero is not an adjustment'),
      reason: z.enum(['RECEIVED', 'DAMAGED', 'MANUAL', 'RECONCILE', 'RETURN']),
      note: z.string().max(300).optional(),
    }).parse(request.body);
    const rawKey = request.headers['idempotency-key'];
    if (rawKey !== undefined && (typeof rawKey !== 'string' || rawKey.length < 8 || rawKey.length > 128)) {
      throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'The Idempotency-Key header must be 8 to 128 characters');
    }
    const commandKey = typeof rawKey === 'string' ? rawKey : null;
    const note = body.note ?? null;

    const item = await app.prisma.item.findFirst({ where: { id: request.params.id, vendorId: { in: access.vendorIds }, archivedAt: null } });
    if (!item) throw new NotFoundError('Item', request.params.id);
    if (item.stockQuantity == null) {
      throw new AppError(400, 'UNTRACKED', 'This item does not track stock — set a quantity on it first');
    }

    const answer = async (adjustment: { movementId: string | null }, replayed: boolean) => {
      const fresh = await app.prisma.item.findUnique({ where: { id: item.id }, select: { stockQuantity: true, isAvailable: true } });
      return { success: true, data: { adjustment, movementId: adjustment.movementId, stockQuantity: fresh?.stockQuantity, isAvailable: fresh?.isAvailable, replayed } };
    };
    /** The committed receipt for this command, if there is one — refused when
     *  the key already named a different adjustment. */
    const committedReceipt = async () => {
      if (!commandKey) return null;
      const receipt = await app.prisma.stockAdjustment.findUnique({ where: { itemId_commandKey: { itemId: item.id, commandKey } } });
      if (!receipt) return null;
      if (receipt.delta !== body.delta || receipt.reason !== body.reason || (receipt.note ?? null) !== note || receipt.createdBy !== request.user.userId) {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This key already named a different stock adjustment — use a new key for a new adjustment');
      }
      return receipt;
    };

    const prior = await committedReceipt();
    if (prior) return answer(prior, true);

    // [MKT-2] Through the single writer, so the vendor's own correction lands in
    // the same ledger as the sales it is correcting. Still guarded: stock can't
    // be adjusted below zero — the writer's conditional decrement enforces it.
    // In a TRANSACTION. applyStockMovement's own contract says it must be —
    // it moves the counter and writes the ledger row in two statements, so
    // outside a transaction a crash between them leaves the cache and the truth
    // disagreeing, which is the exact failure the ledger exists to prevent.
    // Mirror the inventory engine's edges in the SAME transaction as the movement: zero hides, restock un-hides —
    // never a banned item, judged under the item's row lock with the write. [GUARDRAILS §8 · DS1266 S3 · DS1267 S4]
    // [MASTER-025] The adjustment record (the command's receipt) commits in the
    // same transaction too, so an error answer means nothing moved.
    let replayed = false;
    const adjustment = await app.prisma.$transaction(async (tx) => {
      const moved = await applyStockMovement(tx, {
        itemId: item.id,
        delta: body.delta,
        reason: body.reason,
        actorId: request.user.userId,
        note,
      });
      await tx.item.updateMany({
        where: { id: item.id, stockQuantity: { lte: 0 }, isAvailable: true },
        data: { isAvailable: false, autoHiddenAt: new Date() },
      });
      await unhideRestocked(tx, item.id);
      return tx.stockAdjustment.create({
        data: { itemId: item.id, delta: body.delta, reason: body.reason, note, createdBy: request.user.userId, commandKey, movementId: moved.movementId },
      });
    }).catch(async (err) => {
      if (err instanceof AppError && err.code === 'INSUFFICIENT_STOCK') {
        throw new AppError(409, 'INSUFFICIENT_STOCK', 'That would take the stock below zero');
      }
      // A concurrent submission of the same command committed first: this one
      // rolled back whole, and answers with that command's receipt.
      if (commandKey && (err as { code?: unknown }).code === 'P2002') {
        const winner = await committedReceipt();
        if (winner) { replayed = true; return winner; }
      }
      throw err;
    });
    if (replayed) return answer(adjustment, true);
    scheduleVendorSearchSync(app, item.vendorId);
    return answer(adjustment, false);
  });

  // ── [IN-STORE-SALE] "Sold in store −1" — one tap takes one sold-in-person item off the Swift stock ─────────
  //
  // A store with no till system sells an item at the counter: the next app order must not sell the one that is
  // gone. One tap on a tracked item's row is ONE sale, through the SAME single writer and guard as a checkout sale
  // (applyStockMovement: never below 0, ledger row with balanceAfter, all in one transaction), hidden at 0 exactly
  // as a checkout hides it, and the owner alerted on the same crossing edge. The tap's own Idempotency-Key makes
  // its StockAdjustment row the durable receipt: a retry or double-submit of the SAME tap answers with it; a new
  // tap (new key) is a new sale. Who may: exactly who may use the stock adjust route above (resolveVendor: the
  // owner or any member of the store that owns the item). Old app builds never call these; nothing above changed.
  const IN_STORE_SALE_NONE_LEFT = "You have 0 of this left on Swift. Update the stock if that's wrong.";
  const IN_STORE_SALE_UNTRACKED = "Stock isn't counted for this item. Add a stock number to track it.";
  const IN_STORE_SALE_NO_SALE = "That sale isn't on Swift, so there's nothing to undo.";
  const IN_STORE_SALE_NOT_YOURS = 'Only the person who recorded this sale can undo it. Use Adjust stock to correct the count.';
  /** A tap's key: required, and from a plain alphabet, so it can never collide with the `undo:` receipts below. */
  const saleTapKey = (raw: unknown): string => {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(raw)) {
      throw new AppError(400, 'INVALID_IDEMPOTENCY_KEY', 'Each tap needs its own Idempotency-Key: 8 to 128 letters, digits, - or _');
    }
    return raw;
  };
  /** The caller's tracked, live item — the same lookup and refusals as the stock adjust route. The store check
   *  (resolveVendor) runs FIRST, before the key or the body is read, exactly as on /adjust: a token that is not a
   *  store's is refused before anything else answers. */
  const saleAccess = (request: { user: { userId: string }; headers: Record<string, string | string[] | undefined> }) =>
    resolveVendor(app, request.user.userId, selectedVendorId(request));
  const saleItem = async (access: VendorAccess, request: { params: IdParam }) => {
    const item = await app.prisma.item.findFirst({ where: { id: request.params.id, vendorId: { in: access.vendorIds }, archivedAt: null } });
    if (!item) throw new NotFoundError('Item', request.params.id);
    if (item.stockQuantity == null) throw new AppError(400, 'UNTRACKED', IN_STORE_SALE_UNTRACKED);
    return item;
  };
  const saleAnswer = async (itemId: string, receipt: { movementId: string | null }, replayed: boolean) => {
    const fresh = await app.prisma.item.findUnique({ where: { id: itemId }, select: { stockQuantity: true, isAvailable: true } });
    return { success: true, data: { movementId: receipt.movementId, stockQuantity: fresh?.stockQuantity, isAvailable: fresh?.isAvailable, replayed } };
  };
  /** The committed receipt under this key, if any; refused when the key already named something else. */
  const saleReceipt = async (itemId: string, commandKey: string, delta: 1 | -1, userId: string) => {
    const receipt = await app.prisma.stockAdjustment.findUnique({ where: { itemId_commandKey: { itemId, commandKey } } });
    if (!receipt) return null;
    if (receipt.reason !== 'IN_STORE_SALE' || receipt.delta !== delta || receipt.createdBy !== userId) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'This key already named a different stock change — use a new key for a new tap');
    }
    return receipt;
  };

  /** POST /items/:id/in-store-sale — one sold in person (-1). Idempotency-Key required: one key = one tap. */
  app.post<{ Params: IdParam }>('/items/:id/in-store-sale', auth, async (request) => {
    const access = await saleAccess(request);
    const commandKey = saleTapKey(request.headers['idempotency-key']);
    const item = await saleItem(access, request);
    const userId = request.user.userId;
    // Read BEFORE moving: a retry of a sale that took the last one answers with its receipt, never "0 left".
    const prior = await saleReceipt(item.id, commandKey, -1, userId);
    if (prior) return saleAnswer(item.id, prior, true);

    let replayed = false;
    let event: { itemId: string; name: string; remaining: number; kind: 'low' | 'out' } | null = null;
    const receipt = await app.prisma.$transaction(async (tx) => {
      const moved = await applyStockMovement(tx, { itemId: item.id, delta: -1, reason: 'IN_STORE_SALE', actorId: userId });
      // Stock stopped being counted since the read above: nothing moved, so no sale is recorded either.
      if (!moved.applied) throw new AppError(400, 'UNTRACKED', IN_STORE_SALE_UNTRACKED);
      const after = await tx.item.findUniqueOrThrow({ where: { id: item.id }, select: { stockQuantity: true, lowStockThreshold: true } });
      const remaining = after.stockQuantity ?? 0;
      // Hidden at 0 exactly as a checkout sale hides it.
      await tx.item.updateMany({ where: { id: item.id, stockQuantity: { lte: 0 }, isAvailable: true }, data: { isAvailable: false, autoHiddenAt: new Date() } });
      // The owner is alerted as a checkout alerts: at 0, or on the crossing edge of the low-stock level (once).
      if (remaining <= 0) event = { itemId: item.id, name: item.name, remaining: 0, kind: 'out' };
      else if (after.lowStockThreshold !== null && remaining <= after.lowStockThreshold && remaining + 1 > after.lowStockThreshold) {
        event = { itemId: item.id, name: item.name, remaining, kind: 'low' };
      }
      return tx.stockAdjustment.create({
        data: { itemId: item.id, delta: -1, reason: 'IN_STORE_SALE', note: null, createdBy: userId, commandKey, movementId: moved.movementId },
      });
    }).catch(async (err) => {
      // The same tap sent twice at once: the first committed, this one rolled back whole and answers with its receipt.
      // Looked for FIRST: on the last one, the copy that lost finds 0 left, yet its tap did happen. [REVIEW-M/G #2157 S4-1]
      const insufficient = err instanceof AppError && err.code === 'INSUFFICIENT_STOCK';
      if (insufficient || (err as { code?: unknown }).code === 'P2002') {
        const winner = await saleReceipt(item.id, commandKey, -1, userId);
        if (winner) { replayed = true; return winner; }
      }
      if (insufficient) throw new AppError(409, 'NONE_LEFT', IN_STORE_SALE_NONE_LEFT);
      throw err;
    });
    if (replayed) return saleAnswer(item.id, receipt, true);
    scheduleVendorSearchSync(app, item.vendorId);
    const alert = event as { itemId: string; name: string; remaining: number; kind: 'low' | 'out' } | null;
    if (alert) {
      // After the commit, never failing the tap: the sale stands whether or not the alert goes out.
      void (async () => {
        const vendor = await app.prisma.vendor.findUnique({ where: { id: item.vendorId }, select: { owner: { select: { userId: true } } } });
        if (vendor?.owner?.userId) await notifications.lowStock(vendor.owner.userId, alert);
      })().catch((err) => request.log.warn({ err, itemId: item.id }, '[IN-STORE-SALE] low-stock alert failed; the sale stands'));
    }
    return saleAnswer(item.id, receipt, false);
  });

  /** POST /items/:id/in-store-sale/undo { saleKey } — puts back the one that tap took: a NEW +1 ledger row (the
   *  ledger is append-only), once per sale whatever the retries (its receipt key is derived from the sale's). Only
   *  the person who recorded the sale. Shows the item again as a restock does (only an auto-hidden one). */
  app.post<{ Params: IdParam }>('/items/:id/in-store-sale/undo', auth, async (request) => {
    const access = await saleAccess(request);
    const { saleKey } = z.object({ saleKey: z.string() }).parse(request.body);
    const key = saleTapKey(saleKey);
    const item = await saleItem(access, request);
    const userId = request.user.userId;
    const sale = await app.prisma.stockAdjustment.findUnique({ where: { itemId_commandKey: { itemId: item.id, commandKey: key } } });
    if (!sale || sale.reason !== 'IN_STORE_SALE' || sale.delta !== -1) {
      throw new AppError(404, 'SALE_NOT_FOUND', IN_STORE_SALE_NO_SALE);
    }
    // [REVIEW-G #2157 S4-2] Another member's sale (of this store's own item) is named for what it is.
    if (sale.createdBy !== userId) throw new AppError(403, 'SALE_NOT_YOURS', IN_STORE_SALE_NOT_YOURS);
    const commandKey = `undo:${key}`;
    const prior = await saleReceipt(item.id, commandKey, 1, userId);
    if (prior) return saleAnswer(item.id, prior, true);

    let replayed = false;
    const receipt = await app.prisma.$transaction(async (tx) => {
      const moved = await applyStockMovement(tx, { itemId: item.id, delta: 1, reason: 'IN_STORE_SALE', actorId: userId, note: `Undo of in-store sale ${sale.movementId ?? sale.id}` });
      if (!moved.applied) throw new AppError(400, 'UNTRACKED', IN_STORE_SALE_UNTRACKED);
      // [Owner ruling via COORD 28 Oct · REVIEW-F S4-8] The one back on the shelf shows the item again exactly as any
      // restock does: only an item the stock engine hid (autoHiddenAt set) and now above 0 — never one the store hid by
      // hand, never one Swift does not allow (the shared rule, judged under the item's row lock).
      await unhideRestocked(tx, item.id);
      return tx.stockAdjustment.create({
        data: { itemId: item.id, delta: 1, reason: 'IN_STORE_SALE', note: 'Undo of an in-store sale', createdBy: userId, commandKey, movementId: moved.movementId },
      });
    }).catch(async (err) => {
      if ((err as { code?: unknown }).code === 'P2002') {
        const winner = await saleReceipt(item.id, commandKey, 1, userId);
        if (winner) { replayed = true; return winner; }
      }
      throw err;
    });
    if (replayed) return saleAnswer(item.id, receipt, true);
    scheduleVendorSearchSync(app, item.vendorId);
    return saleAnswer(item.id, receipt, false);
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
        AND "archivedAt" IS NULL
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
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    // [Row 52] Coordinator ruling 5 Oct: OWNER and MANAGER may confirm an MMG
    // payment; STAFF may not. Checked first, before any read-back or write, so
    // a refused tap leaves the order exactly as it was.
    const member = await orderStoreMember(app, request.user.userId, order.vendorId!);
    requireRole(member, CONFIRM_PAYMENT_MIN_ROLE);
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
    // [ORDER-SPINE S1-6] It is also the lock the customer's claim and an
    // operator's decision take (order/mmg-claim.service.ts): the three
    // commands on one order's payment claims serialize here, in either order.
    const now = new Date();
    const capture = await app.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} AND "tenantId" = ${order.tenantId} FOR UPDATE`;
      // [REPORT-005 F-005-04] The vendor is the pickup-code VERIFIER: every
      // read here must omit handover secrets exactly like resolveOwnedOrder,
      // or this response hands the verifier the code (and the ride PIN).
      const locked = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        omit: HANDOVER_SECRETS_OMIT,
      });
      await mmgClaimLockObserver.afterLock?.({ orderId: order.id, actor: 'STORE' });
      if (ORDER_CLOSED_STATUSES.includes(locked.status)) throw orderClosedError();
      // [W-25] the preview above is UX; THIS is the authority — a payment that
      // failed or was reversed between the tap and the lock is refused here
      assertMmgAttestable(locked);
      // [S1-6] The claim is decided on the LOCKED row: a repeat tap writes
      // nothing; an attempt an operator rejected cannot be revived; and a
      // durable customer denial — or a different reference — becomes the
      // disagreement in the SAME statement that writes CLAIMED.
      const decision = decideStoreMmgClaim(locked, reference, now);
      if (decision.kind === 'ALREADY_CLAIMED') {
        return { won: false, order: locked, notice: null as MmgClaimNotice | null, outboxId: null as string | null }; // idempotent under the lock
      }
      // [DOC-1 §31.5 · DOC-INV-48 · P31-2] The store's word is a CLAIM. It lands as CLAIMED —
      // never CAPTURED, which is reserved for a provider's own evidence — so nothing
      // downstream can read a person's attestation as a settled fact.
      const cas = await tx.order.updateMany({
        where: {
          id: order.id,
          paymentStatus: { notIn: ['CAPTURED', 'CLAIMED'] },
          status: { notIn: ORDER_CLOSED_STATUSES as OrderStatus[] },
          mmgClaimRevision: locked.mmgClaimRevision,
        },
        data: { paymentStatus: 'CLAIMED', ...decision.data },
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
      let notice: MmgClaimNotice | null = null;
      let outboxId: string | null = null;
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
          changes: {
            reference, amount: String(fresh.totalAmount), claim: 'payment_claimed_by_vendor',
            // [Row 52] who confirmed it, as a store member
            memberId: member.memberId, memberRole: member.role,
          },
        } });
        // [S1-6] The disagreement's evidence and the durable notice obligation
        // commit with the claim; the customer is told what the STORE said.
        ({ notice, outboxId } = await stageStoreMmgClaim(tx, { facts: fresh, decision, actorId: request.user.userId, reference, now }));
        // [owner 18 Oct 2026 · REVIEW-G S4] A "customer says paid, store silent" case closes with the store's tap.
        await closeStoreSilentMmgCase(tx, order.id, 'PAID_BY_MMG', now);
        // Answer with the row as it now stands, attestation evidence included.
        const claimedRow = await tx.order.findUniqueOrThrow({ where: { id: order.id }, omit: HANDOVER_SECRETS_OMIT });
        return { won: true, order: claimedRow, notice, outboxId };
      }
      return { won: false, order: fresh, notice, outboxId };
    });
    if (!capture.won) return { success: true, data: capture.order };
    mmgAttestationCounter.labels('attested').inc();
    // [O-3 · STORE_ACCEPT_PATH] An MMG order the store accepted before the money arrived stopped at
    // ACCEPTED (payment-first). "Paid by MMG" is where its preparation starts: the rest of the
    // store's one-tap accept, never a separate "Start preparing". After the claim committed, and on
    // its own: a booking, a disputed claim (the seam re-decides payment-first on the locked row) or
    // an order that moved on first is left as it is, and the claim stands either way.
    const startPreparation = capture.order.status === STORE_ACCEPT_PATH[0] && preparationMayStart(capture.order);
    const prepared = startPreparation
      ? await orderService.updateStatus(order.id, STORE_ACCEPT_PATH[1], request.user.userId, 'Preparing: the store confirmed the MMG payment', {
        allowedFrom: [STORE_ACCEPT_PATH[0]],
      }).catch((err: unknown) => {
        request.log.warn({ err, orderId: order.id }, '[O-3] preparation did not start with the MMG payment; the store can still start it');
        return null;
      })
      : null;
    const updated = prepared ?? capture.order;
    await emitToOrderRoom(app.prisma, app.io, order.id, 'order:status_changed', {
      orderId: order.id, status: updated.status, paymentStatus: 'CLAIMED',
      mmgClaimRevision: updated.mmgClaimRevision, mmgDisputed: updated.mmgClaimMismatchAt != null,
    });
    // The socket covers an open order screen; the notification survives it. It
    // is delivered from the obligation committed above, in the STORE's words —
    // never as a confirmation, and as a dispute notice when the claims disagree.
    if (capture.notice && capture.outboxId) {
      await completeMmgClaimNotice({ prisma: app.prisma, notifications }, { outboxId: capture.outboxId, notice: capture.notice })
        .catch((err: unknown) => request.log.error({ err, orderId: order.id }, '[S1-6] claim notice fast path failed — the outbox sweep will deliver it'));
    }
    // [owner 17 Oct 2026 · PAYMENT-SIMPLIFY · Q1] The store accepted this MMG order before the money
    // arrived, so acceptance armed no dispatch. "Paid by MMG" is that moment: arm the platform
    // delivery now, exactly as acceptance would have (ON_ACCEPT) — never while a claim is disputed,
    // and never twice (no rider yet; the dispatch arm is versioned and idempotent).
    if (
      updated.fulfillmentMode === 'PLATFORM_RIDER' && dispatchTrigger() === 'ON_ACCEPT'
      && updated.riderId == null && ['ACCEPTED', 'PREPARING'].includes(updated.status)
      && !mmgDispatchBlocked(updated)
    ) {
      await startPlatformDeliveryAfterCommit(updated, updated.fulfillmentModeVersion, 'mmg_paid');
    }
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
   *  it. Idempotent; any staff can confirm. */
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
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    await assertVendorCanOperate(order.vendorId!, 'IN_FLIGHT');
    if (order.fulfillment !== 'DELIVERY') {
      throw new AppError(400, 'NOT_DELIVERY', 'Only delivery orders are dispatched to movers');
    }
    if (order.riderId) {
      throw new AppError(409, 'ALREADY_ASSIGNED', 'A mover already has this order');
    }
    if (resolveDeliveryMode(order.fulfillmentMode, order.vendor?.selfDeliveryEnabled ?? false) === 'VENDOR_DELIVERY') {
      throw new AppError(409, 'VENDOR_DELIVERY_SELECTED', 'Choose “Get a Swift rider” before retrying dispatch');
    }
    if (!['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS', `Cannot search for a mover while the order is ${order.status}`);
    }
    const result = await dispatch.retryDispatch(order.id);
    return { success: true, data: { orderId: order.id, searching: !!result.offered, exhausted: !!result.exhausted } };
  });

  /** PUT /orders/:id/complete-pickup — Takeaway: customer collected the order.
   *  Vendor verifies the pickup code (if set) and closes it; no rider involved. */
  app.put<{ Params: IdParam }>('/orders/:id/complete-pickup', tap, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    await assertVendorCanOperate(order.vendorId!, 'IN_FLIGHT');
    if (order.fulfillment !== 'PICKUP') {
      throw new AppError(400, 'NOT_A_PICKUP', 'This order is not a pickup order.');
    }
    if (order.status !== 'READY_FOR_PICKUP' && order.status !== 'COMPLETED') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot complete pickup from ${order.status} status`);
    }
    const { code } = completePickupSchema.parse(request.body ?? {});
    await assertHandoverRequestBudget(app.redis, order.id);
    // [O-2 · owner 22 Oct 2026] With the store's takeaway code OFF (the default) the store hands the
    // order over without a code (the owner's rule: it checks the first name + order number). A code an
    // older store build still sends is verified exactly as before; with the setting ON, today's flow.
    const codeWaived = order.vendor?.requirePickupCode !== true;
    // [REVIEW-F S3-1 on #2055] The note records only what the server knows: no code was asked for.
    // (Store builds 11/12's board-card "Mark picked up" sends no code and asked for no name check.)
    const note = codeWaived && !code
      ? NO_CODE_HANDOVER_NOTE
      : 'Picked up by customer';
    const updated = await orderService.updateStatus(order.id, 'COMPLETED', request.user.userId, note, {
      allowedFrom: ['READY_FOR_PICKUP'], expectedFulfillment: 'PICKUP',
      handover: { purpose: 'pickup', code, vendorUserId: request.user.userId, expectedVendorId: order.vendorId!, codeWaived },
    });
    return { success: true, data: updated };
  });

  /** PUT /orders/:id/handed-to-rider — [O-2 · owner 22 Oct 2026] the store's one tap when it hands a
   *  delivery to the assigned Swift rider (the card shows the rider's photo, first name, vehicle and
   *  plate). EVIDENCE, not custody: the status is unchanged (the rider's "Picked up" moves it), one
   *  status-log row is written, and a repeat tap (or one after the pickup) is a 200 with no new row.
   *  Courier/parcel and taxi are never here (no store); a self-delivery has no Swift rider. */
  // Plain `auth`: the tap pushes no customer, so it does not carry the push-after-response hook.
  app.put<{ Params: IdParam }>('/orders/:id/handed-to-rider', auth, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    // [REVIEW-G S4-4 on #2055] Like every other in-flight store action: a closed (or non-billing
    // suspended) store's staff cannot tap.
    await assertVendorCanOperate(order.vendorId!, 'IN_FLIGHT');
    if (order.fulfillment !== 'DELIVERY' || order.fulfillmentMode === 'VENDOR_DELIVERY' || order.orderType === 'COURIER' || order.orderType === 'TAXI') {
      throw new AppError(400, 'NOT_A_RIDER_DELIVERY', 'This order is not handed to a Swift rider.');
    }
    const HANDOVER_STATUSES: readonly string[] = ['READY_FOR_PICKUP', 'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'];
    // Still with the store and no rider can have taken it yet: the answer is "no rider yet", not a status.
    const BEFORE_A_RIDER: readonly string[] = ['ACCEPTED', 'PREPARING'];
    const AFTER_PICKUP: readonly string[] = ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED', 'DELIVERED', 'COMPLETED'];
    const handed = await app.prisma.$transaction(async (tx) => {
      // The order lock every transition takes: a cancellation or a rider release committing first is seen here.
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} FOR UPDATE`;
      const live = await tx.order.findUniqueOrThrow({ where: { id: order.id }, select: { status: true, riderId: true } });
      // Idempotent per rider: a tap already made for THIS rider's assignment answers again; one made for a
      // rider who since handed the order back does not speak for the new one.
      const episodeRows = await tx.orderStatusLog.findMany({
        where: handoverEpisodeRowsWhere([order.id]), select: { orderId: true, status: true, note: true, createdAt: true }, orderBy: { createdAt: 'asc' },
      });
      // A rider who handed the order back leaves no current rider: an earlier tap answers nothing then.
      const already = live.riderId ? handedToRiderSinceAssignment(episodeRows).get(order.id) ?? null : null;
      if (already || AFTER_PICKUP.includes(live.status)) return { handedToRiderAt: already, wrote: false };
      if (!live.riderId && (BEFORE_A_RIDER.includes(live.status) || HANDOVER_STATUSES.includes(live.status))) {
        throw new AppError(409, 'NO_RIDER_YET', 'No Swift rider has taken this order yet. Hand it over when the rider arrives.');
      }
      if (!HANDOVER_STATUSES.includes(live.status)) {
        throw new AppError(409, 'INVALID_STATUS', `This order is ${live.status.toLowerCase().replace(/_/g, ' ')} — nothing to hand over.`);
      }
      const row = await tx.orderStatusLog.create({
        data: { orderId: order.id, status: live.status, changedBy: request.user.userId, note: HANDED_TO_RIDER_NOTE },
        select: { createdAt: true },
      });
      return { handedToRiderAt: row.createdAt, wrote: true };
    });
    if (handed.wrote && order.vendorId) {
      await emitToStoreRoom(app.prisma, app.io, order.vendorId, 'order:handed_to_rider', { orderId: order.id });
    }
    return { success: true, data: { orderId: order.id, handedToRiderAt: handed.handedToRiderAt?.toISOString() ?? null } };
  });

  /** PUT /orders/:id/complete-appointment — Service: vendor marks the appointment done.
   *  APPOINTMENT orders skip prepare/ready/dispatch; they go ACCEPTED -> COMPLETED. */
  app.put<{ Params: IdParam }>('/orders/:id/complete-appointment', tap, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    await assertVendorCanOperate(order.vendorId!, 'IN_FLIGHT');
    if (order.fulfillment !== 'APPOINTMENT') {
      throw new AppError(400, 'NOT_AN_APPOINTMENT', 'This order is not an appointment.');
    }
    if (order.status !== 'ACCEPTED') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot complete appointment from ${order.status} status`);
    }
    const updated = await orderService.updateStatus(order.id, 'COMPLETED', request.user.userId, 'Appointment completed by vendor');
    return { success: true, data: updated };
  });

  /** PUT /orders/:id/no-show — [BOOK-FU2 · owner B3] "Customer didn't come". An appointment the business accepted
   *  (by hand or by its automatic confirmation), once its time has started, closes with a recorded outcome: the one
   *  canonical CANCELLED transition (the business gets its time back) and, in the same commit, the record of which
   *  booking, when and who (booking/appointment-no-show.ts). No fee, no strike, no money moved; the customer is told
   *  in neutral words; a person at Swift reviews repeated cases. */
  app.put<{ Params: IdParam }>('/orders/:id/no-show', tap, async (request) => {
    // The same team (any member of the store, like complete-appointment) and the same operate gate as
    // complete-appointment: recording an outcome about a customer is progress on accepted work, not a decline, so a
    // store under a hold (suspended by Swift, closed, expired documents) cannot record one; a weekly-fee hold still
    // lets it finish accepted work (IN_FLIGHT), exactly as completing it.
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    await assertVendorCanOperate(order.vendorId!, 'IN_FLIGHT');
    const refusal = noShowRefusal(order, new Date());
    if (refusal) throw refusal;
    await orderService.transitionOrderAtomically({
      orderId: order.id,
      target: 'CANCELLED',
      allowedFrom: ['ACCEPTED'],
      changedBy: request.user.userId,
      note: NO_SHOW_REASON,
      cancellation: { by: request.user.userId, reason: NO_SHOW_REASON },
      // Judged again on the locked row (a move or a cancel that committed first wins), then recorded in this commit.
      withinTransaction: async (tx, lockedSource) => { await recordNoShowInTransaction(tx, lockedSource, request.user.userId, new Date()); },
      invalidStatus: () => new AppError(409, 'NO_SHOW_NOT_OPEN', 'This appointment can no longer be marked as "Customer didn\'t come".'),
    });
    const updated = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      // [F1] Returned to the store, the pickup-code verifier: never a handover secret.
      omit: HANDOVER_SECRETS_OMIT,
      include: { customer: { select: { id: true, firstName: true } }, appointmentNoShow: { select: { bookingId: true, recordedAt: true } } },
    });

    const event = { orderId: order.id, status: 'CANCELLED', reason: NO_SHOW_REASON, timestamp: new Date().toISOString() };
    await emitToOrderRoom(app.prisma, app.io, order.id, 'order:status_changed', event);
    if (order.vendorId) await emitToStoreRoom(app.prisma, app.io, order.vendorId, 'order:status_changed', event);

    // The customer is told, in neutral words. The order id routes the tap to the booking's own order screen on every build.
    await notifications.send({
      userId: updated.customer.id,
      type: 'ORDER_UPDATE',
      ...noShowCustomerNotice(updated.orderNumber),
      audience: 'customer',
      dedupeKey: `appointment-no-show:${order.id}`,
      data: { orderId: order.id, status: 'CANCELLED' },
    }).catch(() => undefined);

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
  app.put<{ Params: IdParam }>('/orders/:id/delivered', tap, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    await assertVendorCanOperate(order.vendorId!, 'IN_FLIGHT');
    if (order.fulfillmentMode !== 'VENDOR_DELIVERY') {
      throw new AppError(400, 'NOT_SELF_DELIVERY', 'This order is being delivered by a Swift rider — they complete it from their app.');
    }
    if (order.status !== 'READY_FOR_PICKUP') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot mark delivered from ${order.status} status`);
    }
    // updateStatus is the CAS: a concurrent cancel (or a double-tap) matches
    // nothing and throws, so exactly one transition and one status-log row.
    const updated = await orderService.updateStatus(order.id, 'DELIVERED', request.user.userId, 'Delivered by the store', {
      allowedFrom: ['READY_FOR_PICKUP'],
      expectedFulfillment: 'DELIVERY',
      expectedFulfillmentMode: 'VENDOR_DELIVERY',
      expectedRiderId: null,
      expectedDriverId: null,
    });
    return { success: true, data: updated };
  });

  /** PUT /orders/:id/reject — Vendor cancels / rejects an order */
  app.put<{ Params: IdParam }>('/orders/:id/reject', tap, async (request) => {
    const order = await resolveOwnedOrder(app, request.user.userId, request.params.id, request);
    // Alert-delivery ack (§A4): the store ACTED on this order's alert, for
    // every recipient. [Q10] After the ownership check, never before it.
    const { acknowledgeAlert } = await import('../notification/notification.service');
    await acknowledgeAlert(app.prisma, 'VENDOR_ORDER', order.id).catch(() => {});
    const rejectableStatuses: readonly string[] = STORE_REJECTABLE_STATUSES;
    if (!rejectableStatuses.includes(order.status)) {
      throw new AppError(400, 'INVALID_STATUS', `Cannot reject order in ${order.status} status`);
    }
    const body = rejectOrderSchema.parse(request.body ?? {});
    const reason = body.reason;
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
      // [Q12 · AX289 F1] A decline of an order whose hold lapsed before the
      // release sweep reached it releases it first — the store saw it, so it
      // counts for the store once, here (the sweep can no longer reach it).
      withinTransaction: async (tx) => { await releaseLapsedHoldInTransaction(tx, order.id); },
      invalidStatus: () => new AppError(400, 'INVALID_STATUS', 'This order can no longer be rejected'),
    });
    const updated = await app.prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      // [F1] Returned to the store, the pickup-code verifier: never a handover secret.
      omit: HANDOVER_SECRETS_OMIT,
      include: { customer: { select: { id: true, firstName: true } } },
    });

    const rejectEvent = { orderId: order.id, status: 'CANCELLED', reason, timestamp: new Date().toISOString() };
    await emitToOrderRoom(app.prisma, app.io, order.id, 'order:status_changed', rejectEvent);
    if (order.vendorId) {
      await emitToStoreRoom(app.prisma, app.io, order.vendorId, 'order:status_changed', rejectEvent);
    }

    // Tell the CUSTOMER, with the reason — parity with the admin-cancel path
    // [SWIFT-024]. The socket event only reaches a client already on the order
    // screen; a customer whose app is closed or elsewhere would otherwise never
    // learn their order was declined (it just silently vanished).
    // [REPORT-010 F-03] An unattested-MMG decline carries the refund guidance
    // — the customer may have already paid the store's link.
    // A booking is declined by its PROVIDER: the words follow the appointment
    // fulfillment, exactly as the acceptance push does, so a haircut is never
    // "an order declined by the store". Food, grocery and retail keep theirs.
    const booking = order.fulfillment === 'APPOINTMENT';
    const decliner = booking ? 'the provider' : 'the store';
    const mmgGuidance = order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus === 'PENDING'
      ? ` If you already sent the MMG payment, ${decliner} refunds you directly.`
      : '';
    await notifications.send({
      userId: updated.customer.id,
      type: 'ORDER_UPDATE',
      title: booking ? 'Booking declined' : 'Order declined',
      body: `Your ${booking ? 'booking' : 'order'} ${updated.orderNumber} was declined by ${decliner}. ${reason}${mmgGuidance}`.trim(),
      data: { orderId: order.id, status: 'CANCELLED' },
    });

    return { success: true, data: updated };
  });

  // =========================================================================
  // 4. MENU — Categories
  // =========================================================================

  /** GET /categories — List all categories for the vendor (the phone's menu read).
   *  [TAP-AUDIT 27 Oct] Each item as GET /items and the item editor's answers carry it: its bulk as the WORD (G2: the
   *  integer never crosses the wire) and why customers cannot see it (GUARDRAILS §8). The phone's editor opened from
   *  this read showed every item as "Normal" and saved that back, so editing a 20 kg bag's price made it bicycle-
   *  sized for dispatch; and the menu never showed "Waiting for a quick check". Additive for every app (no client
   *  reads bulkUnits). */
  app.get('/categories', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const categories = await menu.listCategories(vendorId);
    const checks = await catalogueChecksFor(app.prisma, categories.flatMap((c) => c.items.map((i) => i.id)));
    const data = categories.map((category) => ({
      ...category,
      items: category.items.map((item) => ({ ...withBulkWord(item), catalogueCheck: partnerView(checks.get(item.id)) })),
    }));
    return { success: true, data };
  });

  /** POST /categories — Create a category */
  app.post('/categories', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const body = createCategorySchema.parse(request.body);
    // [IMAGES-E2E PR4] A section's photo is uploaded (POST /categories/:id/image), never typed.
    uploadOnlyPhotoField(body.imageUrl, null, 'the section\'s photo');
    const category = await menu.createCategory(vendorId, { ...body, imageUrl: undefined });
    scheduleVendorSearchSync(app, vendorId);
    return { success: true, data: category };
  });

  /** PUT /categories/:id — Update a category */
  app.put<{ Params: IdParam }>('/categories/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { imageUrl, ...fields } = updateCategorySchema.parse(request.body);
    // [IMAGES-E2E PR4] Typed text may only take the section's photo down ('') or repeat it.
    const current = imageUrl === undefined ? null
      : await app.prisma.category.findFirst({ where: { id: request.params.id, vendorId, archivedAt: null }, select: { imageUrl: true } });
    if (imageUrl !== undefined && !current) throw new NotFoundError('Category', request.params.id);
    const photo = uploadOnlyPhotoField(imageUrl, current?.imageUrl, 'the section\'s photo');
    let category = await menu.updateCategory(vendorId, request.params.id, fields);
    if (photo === null) category = await setSectionPhoto(vendorId, request.params.id, null);
    scheduleVendorSearchSync(app, vendorId);
    return { success: true, data: category };
  });

  /** [IMAGES-E2E PR4] POST /categories/:id/image — the section's own photo (store managers):
   *  a photo whose bytes say so, scanned, redrawn without metadata (storeOwnPhoto), kept in the
   *  store's photo folder, which the public door serves while the section is live. */
  app.post<{ Params: IdParam }>('/categories/:id/image', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const section = await app.prisma.category.findFirst({ where: { id: request.params.id, vendorId, archivedAt: null }, select: { id: true } });
    if (!section) throw new NotFoundError('Category', request.params.id);
    const url = await storeOwnPhoto(request, vendorId);
    const category = await setSectionPhoto(vendorId, section.id, url).catch(async (err: unknown) => {
      await discardKeptPhoto(vendorId, url);
      throw err;
    });
    scheduleVendorSearchSync(app, vendorId);
    return { success: true, data: { id: category.id, name: category.name, imageUrl: category.imageUrl } };
  });

  /** [IMAGES-E2E PR4] DELETE /categories/:id/image — take the section's photo down (deleted from storage). */
  app.delete<{ Params: IdParam }>('/categories/:id/image', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const category = await setSectionPhoto(vendorId, request.params.id, null);
    scheduleVendorSearchSync(app, vendorId);
    return { success: true, data: { id: category.id, name: category.name, imageUrl: category.imageUrl } };
  });

  /** DELETE /categories/:id — Delete a category: [owner 11 Oct] it and its
   *  listings are ARCHIVED (see VendorMenuService.deleteCategory). */
  app.delete<{ Params: IdParam }>('/categories/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { itemsRemoved, removedItemIds } = await menu.deleteCategory(vendorId, request.params.id);

    // Evict the archived listings' search docs now [SWIFT-UG-SRCH-01].
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

    // [Item 62] A deleted (archived) listing is history, not menu.
    const where: Record<string, unknown> = { vendorId, archivedAt: null };
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
    // [GUARDRAILS §8] The partner reads, per item, whether Swift does not allow it
    // or is holding it for a quick check — and why (the word and the field).
    const checks = await catalogueChecksFor(app.prisma, items.map((i) => i.id));
    const data = items.map((item) => ({
      ...coerceMoney(withBulkWord(item), ITEM_MONEY_FIELDS),
      optionGroups: item.optionGroups.map((group) => ({
        ...group,
        options: group.options.map((option) => coerceMoney(option, OPTION_MONEY_FIELDS)),
      })),
      catalogueCheck: partnerView(checks.get(item.id)),
    }));
    return { success: true, data };
  });

  /** POST /items — Create an item with optional option groups */
  app.post('/items', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    await requireListingAllowed(app, verification, vendorId);

    const body = createItemSchema.parse(request.body);
    // [BOOK-S1] A new listing stores nothing yet: any overlap is new.
    const newOverlap = body.bookingConfig ? overlappingWindows(body.bookingConfig.slots) : null;
    if (newOverlap) throw overlappingHoursError(newOverlap);
    // [IMAGES-E2E PR4 · COORD ruling 19 Oct (a)] An item's photo is uploaded (POST /items/:id/image), never typed.
    uploadOnlyPhotoField(body.imageUrl, null, 'the item\'s photo');

    // Verify category belongs to this vendor
    const category = await app.prisma.category.findUnique({ where: { id: body.categoryId } });
    if (!category || category.vendorId !== vendorId || category.archivedAt) throw new NotFoundError('Category', body.categoryId);
    // [GUARDRAILS §8 · #55] A name or an option that IS banned goods is refused, never held.
    assertNotBannedGoods([body.name, ...(body.optionGroups ?? []).flatMap((g) => [g.name, ...g.options.map((o) => o.name)])]);
    // [#54] A store filed under a banned category lists nothing new: every item it carries is banned.
    await assertStoreAllowed(app.prisma, vendorId);

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
        // [BOOK-S3] A new listing stores nothing yet: with the switch on it starts as automatic.
        ...(body.bookingConfig ? { bookingConfig: bookingSettingsForSave(body.bookingConfig, null) as object } : {}),
        ...(body.vatClass !== undefined ? { vatClass: body.vatClass } : {}),
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

    // [GUARDRAILS §8] A banned word in the partner's own text saves the item but holds
    // it hidden until a person checks it; the partner reads "Waiting for a quick check".
    const check = (await catalogueChecksFor(app.prisma, [item.id])).get(item.id);
    return { success: true, data: { ...withBulkWord(item), catalogueCheck: partnerView(check) } };
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

    // [NO-AI] The synonym table in `utils/catalogue-map.ts` is the whole
    // mapper now. A model used to be asked for the columns the synonyms
    // missed; when it cannot be asked, the honest answer is to say WHICH
    // columns were not recognised and let the vendor rename them or use the
    // template — which is what the 422 below already does, and which is the
    // manual confirmation the removal requires. Nothing is guessed.
    const mapping: ColumnMapping = guessColumnMapping(headers);

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
   *  fields (a deterministic synonym table; unmapped columns go to the vendor).
   *  Returns a preview + a canonical
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
    // Compressed transport cap: the global multipart limit is 5 MB (KYC/
    // selfie photos); a catalogue workbook is far smaller, so hold THIS route
    // to 1 MB on disk. The guard below bounds what it can expand TO. An
    // over-cap upload is translated into this route's own 400 vocabulary, not
    // busboy's raw 413.
    let buffer: Buffer;
    try {
      const file = await request.file({ limits: { fileSize: XLSX_MAX_COMPRESSED_BYTES, files: 1 } });
      if (!file) throw new AppError(400, 'NO_FILE', 'Attach an .xlsx file');
      buffer = await file.toBuffer();
    } catch (err) {
      if (err instanceof AppError) throw err;
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw new AppError(400, 'XLSX_TOO_LARGE', `That workbook is too large: the compressed file must be under ${XLSX_MAX_COMPRESSED_BYTES / (1024 * 1024)} MB.`);
      }
      throw err;
    }
    // Zip-bomb guard: refuse by the ZIP central directory's ADVERTISED sizes
    // BEFORE exceljs inflates anything. A tiny .xlsx can legally declare a
    // multi-GB sharedStrings.xml; exceljs would try to inflate it and OOM the
    // process before any header validation could refuse it.
    // [SEC-DOS F3] exceljs gets the guard's rebuilt archive of exactly the bytes it measured, never the upload.
    let measured: Buffer;
    try {
      measured = scanXlsxZip(buffer, XLSX_IMPORT_ZIP_BUDGET).archive;
    } catch (err) {
      if (err instanceof XlsxZipGuardError) {
        throw new AppError(400, 'BAD_XLSX', `That workbook is not importable: ${err.message}`);
      }
      throw err;
    }

    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(measured as unknown as ArrayBuffer);
    } catch {
      throw new AppError(400, 'BAD_XLSX', 'That file is not a readable Excel workbook (.xlsx)');
    }
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount < 2) {
      throw new AppError(400, 'EMPTY_CSV', 'No data rows found in the first worksheet');
    }
    // Post-load shape caps: the central-directory guard bounds what exceljs
    // can inflate; these bound what the row loop below can build. Keep the
    // row cap in lock-step with the CSV confirm step's MAX_IMPORT_ROWS.
    if (sheet.rowCount - 1 > MAX_IMPORT_ROWS) {
      throw new AppError(400, 'TOO_MANY_ROWS', `Import is limited to ${MAX_IMPORT_ROWS} rows per file (got ${sheet.rowCount - 1})`);
    }
    if (sheet.columnCount > MAX_XLSX_COLUMNS) {
      throw new AppError(400, 'BAD_XLSX', `Import is limited to ${MAX_XLSX_COLUMNS} columns per file (got ${sheet.columnCount})`);
    }

    const cellText = (v: unknown, where: string): string => {
      let text: string;
      if (v === null || v === undefined) {
        text = '';
      } else if (typeof v === 'object') {
        const rich = v as { richText?: Array<{ text: string }>; text?: string; result?: unknown };
        if (rich.richText) text = rich.richText.map((t) => t.text).join('');
        else if (rich.text) text = rich.text;
        else if (rich.result !== undefined) text = String(rich.result);
        else text = '';
      } else {
        text = String(v);
      }
      if (text.length > MAX_XLSX_CELL_TEXT) {
        throw new AppError(400, 'BAD_XLSX', `Cell text at ${where} exceeds ${MAX_XLSX_CELL_TEXT} characters.`);
      }
      return text;
    };

    const headerRow = sheet.getRow(1);
    const headers: string[] = [];
    headerRow.eachCell({ includeEmpty: false }, (cell, col) => { headers[col - 1] = cellText(cell.value, `header column ${col}`).trim(); });

    const rows: Record<string, string>[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const record: Record<string, string> = {};
      let hasValue = false;
      headers.forEach((h, i) => {
        if (!h) return;
        const value = cellText(row.getCell(i + 1).value, `row ${rowNumber}, column ${i + 1}`).trim();
        record[h] = value;
        if (value) hasValue = true;
      });
      if (hasValue) rows.push(record);
    });

    return { success: true, data: await automapRows(rows) };
  });

  /** POST /items/import/menu-parse — a restaurant's PDF menu becomes draft
   *  items to CONFIRM (master plan §3.1). Deterministic guard rails: the AI
   *  parser reads the extracted text; rows without a parseable price are
   *  dropped, never invented, and nothing imports until the vendor confirms. */
  app.post('/items/import/menu-parse', { ...auth, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const file = await request.file();
    if (!file) throw new AppError(400, 'NO_FILE', 'Attach a PDF menu');
    if (file.mimetype !== 'application/pdf') {
      throw new AppError(400, 'BAD_MENU_FILE', 'Only PDF menus are supported for now — export your menu as PDF, or use CSV/Excel');
    }

    const buffer = await file.toBuffer();
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    const onClose = () => { if (!reply.raw.writableFinished) abort.abort(); };
    request.raw.once('aborted', onAbort);
    reply.raw.once('close', onClose);
    if (request.raw.aborted || reply.raw.destroyed) abort.abort();
    let text: string;
    try {
      text = await extractMenuPdf(buffer, vendorId, abort.signal);
    } finally {
      request.raw.off('aborted', onAbort);
      reply.raw.off('close', onClose);
    }
    if (text.length < 20) {
      throw new AppError(422, 'MENU_NO_TEXT', 'That PDF has no readable text (a photo scan?) — use CSV/Excel or type items in');
    }

    // [NO-AI] The menu is READ, not interpreted. `parseMenuText` takes the
    // PDF's own text layer and returns only the lines that plainly carry a
    // name and a price; anything it cannot read is skipped rather than
    // guessed at, and the vendor confirms every row in the preview below.
    const drafts = parseMenuText(text.slice(0, 12_000));
    if (drafts.length === 0) {
      throw new AppError(422, 'MENU_UNPARSEABLE', 'Couldn’t find priced items in that menu — use CSV/Excel or add items manually');
    }

    // The same validation as before: the parser proposes, this decides.
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
        // [F-1218-01] EVERY proposed row, not a capped preview. The parser is
        // conservative and the vendor's confirmation is the last guard — but a
        // row they were never shown is a row they cannot refuse. The CSV below
        // imports exactly this list, so this list is what they see.
        preview: normalized,
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
    // [GUARDRAILS §8 · #54] Nor imports anything.
    await assertStoreAllowed(app.prisma, vendorId);
    const rows = parseCsvWithHeader(csv);

    if (rows.length === 0) {
      throw new AppError(400, 'EMPTY_CSV', 'No data rows found — download the template to see the format');
    }
    if (rows.length > MAX_IMPORT_ROWS) {
      throw new AppError(400, 'TOO_MANY_ROWS', `Import is limited to ${MAX_IMPORT_ROWS} rows per file (got ${rows.length})`);
    }

    const failures: Array<{ row: number; errors: string[] }> = [];
    // [IMAGES-E2E PR4 · COORD ruling 19 Oct (a)] A row that names a photo address is imported
    // WITHOUT it (photos are uploaded), and the answer says so for that row.
    const notes: Array<{ row: number; note: string }> = [];
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
    // [owner 11 Oct] An archived category never takes new rows: a row naming
    // it files into a new live category of the same name.
    const categories = await app.prisma.category.findMany({ where: { vendorId, archivedAt: null } });
    const categoryIds = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));

    let imported = 0;
    const importedIds: Array<{ id: string; row: number; name: string }> = [];
    for (const { rowNumber, data } of valid) {
      // [GUARDRAILS §8 · #55] A row whose name IS banned goods is refused and listed; the rest import.
      const bannedGoods = certainGoods(data.name);
      if (bannedGoods) {
        failures.push({ row: rowNumber, errors: [notAllowedMessage(bannedGoods.prohibitedClass)] });
        continue;
      }
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
        const created = await app.prisma.item.create({
          select: { id: true },
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
            dietaryTags: [],
            allergens: [],
          },
        });
        importedIds.push({ id: created.id, row: rowNumber, name: data.name });
        imported += 1;
        if (data.imageUrl.trim() !== '') notes.push({ row: rowNumber, note: IMPORT_PHOTO_ADDRESS_NOTE });
      } catch {
        failures.push({ row: rowNumber, errors: ['Database rejected this row'] });
      }
    }

    scheduleVendorSearchSync(app, vendorId);

    // [GUARDRAILS §8] Imported rows a banned word is holding for a quick check, by row.
    const importChecks = await catalogueChecksFor(app.prisma, importedIds.map((i) => i.id));
    const waitingForCheck = importedIds
      .filter((i) => importChecks.get(i.id)?.state === 'WAITING')
      .map((i) => ({ row: i.row, name: i.name }));

    return {
      success: true,
      data: {
        imported,
        waitingForCheck: waitingForCheck.slice(0, 100),
        waitingForCheckCount: waitingForCheck.length,
        failedCount: failures.length,
        // Cap the detail list so a fully-broken huge file stays readable
        failures: failures.slice(0, 100),
        notes: notes.slice(0, 100),
        notesCount: notes.length,
      },
    };
  });

  /**
   * [IMAGES-E2E] The one way a store's own photo (menu item, logo, cover) is kept:
   * a JPEG/PNG/WebP whose bytes say so, scanned, then DRAWN AGAIN with the public
   * door's own drawing (utils/public-store-photos renderStorePhoto: upright, sRGB,
   * no metadata at all, EXIF/GPS/XMP/ICC included, long edge at most 1600 px), and
   * kept in the store's photo folder `items/<store>/`, which is the only folder the
   * public door serves. The storage seam strips again on the way in.
   */
  async function storeOwnPhoto(request: FastifyRequest, vendorId: string): Promise<string> {
    return keepPublicPhoto(request, storage, `items/${vendorId}`, 'store-media');
  }

  /** [IMAGES-E2E PR4] The logo or cover set (an upload) or taken down (null) under the store row's
   *  lock; the photo it replaces is queued for deletion in the same transaction, deleted after. */
  const setStorePhoto = async (vendorId: string, field: 'logoUrl' | 'coverImageUrl', url: string | null) => {
    const { vendor, orphanIds } = await app.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ logoUrl: string | null; coverImageUrl: string | null }>>`
        SELECT "logoUrl", "coverImageUrl" FROM "vendors" WHERE "id" = ${vendorId}
        FOR UPDATE /* store-photo-authority */
      `;
      if (!rows[0]) throw new NotFoundError('Vendor', vendorId);
      const before = rows[0][field];
      const queued = before !== url ? await queueStorePhotoDeletions(tx, vendorId, [before]) : [];
      const row = await tx.vendor.update({
        where: { id: vendorId },
        data: { [field]: url },
        select: { id: true, logoUrl: true, coverImageUrl: true },
      });
      return { vendor: row, orphanIds: queued };
    });
    await deleteQueuedPhotos(orphanIds);
    return vendor;
  };

  /** POST /profile/logo, /profile/cover — the store's own logo or cover photo (store managers).
   *  [#1964 retry census] Registered with literal paths, so the census can read every route. */
  const uploadStorePhoto = (field: 'logoUrl' | 'coverImageUrl') => async (request: FastifyRequest) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const url = await storeOwnPhoto(request, vendorId);
    const vendor = await setStorePhoto(vendorId, field, url).catch(async (err: unknown) => {
      await discardKeptPhoto(vendorId, url);
      throw err;
    });
    scheduleVendorSearchSync(app, vendorId);
    return { success: true, data: vendor };
  };
  app.post('/profile/logo', auth, uploadStorePhoto('logoUrl'));
  app.post('/profile/cover', auth, uploadStorePhoto('coverImageUrl'));

  /** DELETE /profile/logo, /profile/cover — take it down (deleted from storage after the pointer goes). */
  const removeStorePhoto = (field: 'logoUrl' | 'coverImageUrl') => async (request: FastifyRequest) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const vendor = await setStorePhoto(vendorId, field, null);
    scheduleVendorSearchSync(app, vendorId);
    return { success: true, data: vendor };
  };
  app.delete('/profile/logo', auth, removeStorePhoto('logoUrl'));
  app.delete('/profile/cover', auth, removeStorePhoto('coverImageUrl'));

  /** POST /items/:id/image — upload behind the StorageProvider interface */
  app.post<{ Params: IdParam }>('/items/:id/image', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const existing = await app.prisma.item.findFirst({ where: { id: request.params.id, vendorId, archivedAt: null } });
    if (!existing) throw new NotFoundError('Item', request.params.id);

    const url = await storeOwnPhoto(request, vendorId);

    // [IMAGES-E2E PR4] Under the item's lock; the photo it replaces is queued for deletion in the
    // same transaction and deleted after (a photo the row could not take is deleted too).
    const { item, orphanIds } = await app.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ imageUrl: string | null }>>`
        SELECT "imageUrl" FROM "items" WHERE "id" = ${request.params.id} AND "vendorId" = ${vendorId} AND "archivedAt" IS NULL
        FOR UPDATE /* item-photo-authority */
      `;
      if (!rows[0]) throw new NotFoundError('Item', request.params.id);
      const queued = await queueStorePhotoDeletions(tx, vendorId, [rows[0].imageUrl]);
      const row = await tx.item.update({
        where: { id: request.params.id, archivedAt: null },
        data: { imageUrl: url },
        select: { id: true, name: true, imageUrl: true },
      });
      return { item: row, orphanIds: queued };
    }).catch(async (err: unknown) => {
      await discardKeptPhoto(vendorId, url);
      return goneIfArchived(request.params.id)(err);
    });
    await deleteQueuedPhotos(orphanIds);

    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: item };
  });

  /** PUT /items/:id — Update an item */
  app.put<{ Params: IdParam }>('/items/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const existing = await app.prisma.item.findFirst({ where: { id: request.params.id, vendorId, archivedAt: null } });
    if (!existing) throw new NotFoundError('Item', request.params.id);
    // [GUARDRAILS §8] An item Swift does not allow is never edited back to life (one banned only by
    // its own words may be renamed out of them — the new name is judged before it is written).
    await assertNotBanned(app.prisma, existing.id, { wordBanEditable: true });

    const body = updateItemSchema.parse(request.body);
    // [BOOK-S1 · REVIEW-M S4-3] A new overlap is refused; overlapping windows the listing already
    // stores (saved before the rule) are joined, so an unchanged save from any app build still works.
    let bookingConfigToStore: Record<string, unknown> | undefined;
    if (body.bookingConfig !== undefined) {
      const windows = windowsForSave(body.bookingConfig.slots, existing.bookingConfig);
      if (!windows.ok) throw overlappingHoursError(windows.pair);
      bookingConfigToStore = mergeBookingConfig(existing.bookingConfig, bookingSettingsForSave({ ...body.bookingConfig, slots: windows.slots }, existing.bookingConfig));
    }
    // [IMAGES-E2E PR4 · COORD ruling 19 Oct (a)] Typed text may only take the item's photo down ('') or repeat it.
    const photo = uploadOnlyPhotoField(body.imageUrl, existing.imageUrl, 'the item\'s photo');
    let photoOrphans: string[] = [];
    if (body.name !== undefined) assertNotBannedGoods([body.name]);

    // If moving to a different category, verify ownership
    if (body.categoryId && body.categoryId !== existing.categoryId) {
      const cat = await app.prisma.category.findUnique({ where: { id: body.categoryId } });
      if (!cat || cat.vendorId !== vendorId || cat.archivedAt) throw new NotFoundError('Category', body.categoryId);
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

    const itemInclude = {
      category: { select: { id: true, name: true } },
      optionGroups: { include: { options: { orderBy: { sortOrder: 'asc' as const } } }, orderBy: { sortOrder: 'asc' as const } },
    };
    // [GUARDRAILS §8 · Opus S3-1] Switched on only if the item AFTER this edit is not banned, judged in the same
    // transaction: "Spare Rum" + {isAvailable: true} is refused (nothing of the request is written), "Spare Rum"
    // renamed to "Coconut cake" may come on, and a restock never switches a banned item back on (its count is saved).
    const item = await app.prisma.$transaction(async (tx) => {
      if (photo === null) {
        const rows = await tx.$queryRaw<Array<{ imageUrl: string | null }>>`
          SELECT "imageUrl" FROM "items" WHERE "id" = ${request.params.id} AND "archivedAt" IS NULL
          FOR UPDATE /* item-photo-authority */
        `;
        photoOrphans = await queueStorePhotoDeletions(tx, vendorId, [rows[0]?.imageUrl]);
      }
      const updated = await tx.item.update({
        where: { id: request.params.id, archivedAt: null },
        data: {
          ...(body.categoryId !== undefined && { categoryId: body.categoryId }),
          ...(body.name !== undefined && { name: body.name.trim() }),
          ...(body.description !== undefined && { description: body.description?.trim() }),
          ...(photo === null && { imageUrl: null }),
          ...(body.basePrice !== undefined && { basePrice: body.basePrice }),
          ...(body.vatClass !== undefined && { vatClass: body.vatClass }),
          ...(body.sku !== undefined && { sku: body.sku }),
          ...(body.unit !== undefined && { unit: body.unit }),
          ...(body.bulk !== undefined && { bulkUnits: bulkUnitsForChoice(body.bulk) }),
          ...(body.lowStockThreshold !== undefined && { lowStockThreshold: body.lowStockThreshold }),
          ...(body.isAvailable !== undefined && { isAvailable: body.isAvailable, autoHiddenAt: null }),
          ...(body.isPopular !== undefined && { isPopular: body.isPopular }),
          ...(body.dietaryTags !== undefined && { dietaryTags: body.dietaryTags }),
          ...(body.allergens !== undefined && { allergens: body.allergens }),
          ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
          ...(body.fulfillment !== undefined && { fulfillment: body.fulfillment }),
          // [BOOK-S1] A save that does not mention the gap or the notice keeps the stored ones.
          ...(bookingConfigToStore !== undefined && { bookingConfig: bookingConfigToStore as object }),
        },
        include: itemInclude,
      });
      if (body.isAvailable === true) await assertNotBanned(tx, updated.id);
      if (!unhide) return updated;
      const banned = (await catalogueChecksFor(tx, [updated.id])).get(updated.id)?.state === 'BANNED';
      return banned ? updated : tx.item.update({ where: { id: updated.id }, data: { isAvailable: true, autoHiddenAt: null }, include: itemInclude });
    }).catch(goneIfArchived(request.params.id));
    await deleteQueuedPhotos(photoOrphans);

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

    // [GUARDRAILS §8] Re-judged on every edit: an approved item renamed into a banned word is held again.
    const check = (await catalogueChecksFor(app.prisma, [item.id])).get(item.id);
    return { success: true, data: { ...withBulkWord(saved), catalogueCheck: partnerView(check) } };
  });

  /** DELETE /items/:id — [Item 62] Delete a listing from the menu: the row is
   *  ARCHIVED, not removed. Orders hold a loose reference to it (their lines
   *  are snapshots) and bookings a real one (a hard delete cascaded and erased
   *  the customer's reservation); an open order must still cancel and restock
   *  against it. Archived means: off every menu, search and cart (it can never
   *  be available again — the items_archived_unavailable check), refused by
   *  every editor, and its option history kept. The response is unchanged. */
  app.delete<{ Params: IdParam }>('/items/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const existing = await app.prisma.item.findFirst({ where: { id: request.params.id, vendorId, archivedAt: null } });
    if (!existing) throw new NotFoundError('Item', request.params.id);

    // One compare-and-set: a concurrent delete or editor finds it archived.
    // autoHiddenAt is cleared so a later cancellation restock (which re-shows
    // only auto-hidden rows) can never put a deleted listing back on sale.
    const archived = await app.prisma.item.updateMany({
      where: { id: request.params.id, vendorId, archivedAt: null },
      data: { archivedAt: new Date(), isAvailable: false, autoHiddenAt: null },
    });
    if (archived.count !== 1) throw new NotFoundError('Item', request.params.id);

    // Evict the search doc now [SWIFT-UG-SRCH-01]; the sync that follows sees
    // an unavailable row and leaves it out.
    new SearchService(app.prisma).removeItemDoc(request.params.id).catch(() => {});
    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: { deleted: true } };
  });

  /** PUT /items/:id/availability — Quick toggle availability */
  app.put<{ Params: IdParam }>('/items/:id/availability', auth, async (request) => {
    const { vendorId } = await resolveVendor(app, request.user.userId, selectedVendorId(request));
    const existing = await app.prisma.item.findFirst({ where: { id: request.params.id, vendorId, archivedAt: null } });
    if (!existing) throw new NotFoundError('Item', request.params.id);

    const body = itemAvailabilitySchema.parse(request.body ?? {});
    const newAvailability = body.isAvailable !== undefined ? body.isAvailable : !existing.isAvailable;
    // [GUARDRAILS §8] Switching a banned item off is always fine; back on, never.
    if (newAvailability) await assertNotBanned(app.prisma, existing.id);

    const item = await app.prisma.item.update({
      where: { id: request.params.id, archivedAt: null },
      data: { isAvailable: newAvailability },
      select: { id: true, name: true, isAvailable: true },
    }).catch(goneIfArchived(request.params.id));

    scheduleVendorSearchSync(app, vendorId);

    return { success: true, data: item };
  });

  // =========================================================================
  // 4. MENU — Option Groups
  // =========================================================================

  /** POST /items/:itemId/option-groups — Add an option group to an item */
  app.post<{ Params: ItemIdParam }>('/items/:itemId/option-groups', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const item = await app.prisma.item.findFirst({ where: { id: request.params.itemId, vendorId, archivedAt: null } });
    if (!item) throw new NotFoundError('Item', request.params.itemId);

    const body = addOptionGroupSchema.parse(request.body);
    // [GUARDRAILS §8] Options of an item Swift does not allow are not edited either, and an
    // option that IS banned goods ("Carib Lager") is refused. [#55]
    await assertNotBanned(app.prisma, item.id, { wordBanEditable: true });
    assertNotBannedGoods([body.name, ...(body.options ?? []).map((o) => o.name)]);

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
  // [Row 300 matrix] Ownership is part of the LOOKUP: the row is found only through
  // an unarchived item of this store. Under the tenant wall another tenant's item is
  // invisible, and including that REQUIRED relation failed the read itself (a 500 on
  // the walled login, T3); asking for it in the where makes any other store's id
  // simply not found, a 404 on both logins. Same lookup on every option route below.
  app.put<{ Params: IdParam }>('/option-groups/:id', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const existing = await app.prisma.optionGroup.findFirst({
      where: { id: request.params.id, item: { vendorId, archivedAt: null } },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('OptionGroup', request.params.id);
    await assertNotBanned(app.prisma, existing.itemId, { wordBanEditable: true });

    const body = updateOptionGroupSchema.parse(request.body);
    if (body.name !== undefined) assertNotBannedGoods([body.name]);

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
    const existing = await app.prisma.optionGroup.findFirst({
      where: { id: request.params.id, item: { vendorId, archivedAt: null } },
      select: { id: true, itemId: true },
    });
    if (!existing) throw new NotFoundError('OptionGroup', request.params.id);

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
    const group = await app.prisma.optionGroup.findFirst({
      where: { id: request.params.groupId, item: { vendorId, archivedAt: null } },
      select: { id: true, itemId: true },
    });
    if (!group) throw new NotFoundError('OptionGroup', request.params.groupId);
    await assertNotBanned(app.prisma, group.itemId, { wordBanEditable: true });

    const body = addOptionSchema.parse(request.body);
    assertNotBannedGoods([body.name]);

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
    const existing = await app.prisma.option.findFirst({
      where: { id: request.params.id, optionGroup: { item: { vendorId, archivedAt: null } } },
      select: { id: true, optionGroup: { select: { itemId: true } } },
    });
    if (!existing) throw new NotFoundError('Option', request.params.id);
    await assertNotBanned(app.prisma, existing.optionGroup.itemId, { wordBanEditable: true });

    const body = updateOptionSchema.parse(request.body);
    if (body.name !== undefined) assertNotBannedGoods([body.name]);

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
    const existing = await app.prisma.option.findFirst({
      where: { id: request.params.id, optionGroup: { item: { vendorId, archivedAt: null } } },
      select: { id: true, optionGroup: { select: { itemId: true } } },
    });
    if (!existing) throw new NotFoundError('Option', request.params.id);

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
      .object({ from: z.string().optional(), to: z.string().optional() })
      .parse(request.query);
    const start = from
      ? isDateOnly(from) ? startOfGuyanaDay(from) : z.coerce.date().parse(from)
      : startOfGuyanaDay(guyanaDayKey(new Date()));
    const baseKey = guyanaDayKey(start);
    const [year, month, day] = baseKey.split('-').map(Number);
    const endKey = new Date(Date.UTC(year!, month! - 1, day! + 14)).toISOString().slice(0, 10);
    const end = to
      ? isDateOnly(to) ? startOfGuyanaDay(to) : z.coerce.date().parse(to)
      : startOfGuyanaDay(endKey);
    const bookings = await app.prisma.booking.findMany({
      where: { vendorId, slotStart: { gte: start, lt: end }, status: { not: 'CANCELLED' } },
      select: {
        id: true, customerId: true, orderId: true, slotStart: true, slotEnd: true, status: true, itemId: true,
        item: { select: { name: true, basePrice: true } },
      },
      orderBy: { slotStart: 'asc' },
    });
    // Booking.customerId is a User id with no relation — resolve names in one hit.
    const custIds = [...new Set(bookings.map((b) => b.customerId))];
    const users = custIds.length
      ? await app.prisma.user.findMany({ where: { id: { in: custIds } }, select: { id: true, firstName: true } }) // only the first name is served
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    // [BOOK-FU2 · REVIEW-F S3-1 on #2201] Each booking's order, for the "Customer didn't come" word (the store's own orders).
    const orderIds = [...new Set(bookings.map((b) => b.orderId).filter((id): id is string => !!id))];
    const orders = orderIds.length
      ? await app.prisma.order.findMany({
        where: { id: { in: orderIds }, vendorId },
        select: { id: true, fulfillment: true, status: true, appointmentSlot: true, paymentMethod: true, paymentStatus: true },
      })
      : [];
    const orderById = new Map(orders.map((o) => [o.id, o]));
    const now = new Date();
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
        // [BOOK-S5a · owner B2] The listing booked: the partner app's "Move" offers its free times.
        itemId: b.itemId,
        customer: byId.has(b.customerId) ? { firstName: byId.get(b.customerId)!.firstName } : null,
        // [BOOK-FU2] Whether "Customer didn't come" may be recorded on this booking's order now (false with no order).
        noShow: noShowView(b.orderId ? orderById.get(b.orderId) : null, now),
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
    const start = from ?? new Date(`${guyanaDayKey(new Date())}T00:00:00.000Z`);
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
      const item = await app.prisma.item.findFirst({ where: { id: body.itemId, vendorId, archivedAt: null }, select: { id: true } });
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
        audience: 'customer',
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
    const item = await app.prisma.item.findFirst({ where: { id: itemId, vendorId, archivedAt: null }, select: { id: true, name: true, description: true } });
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
  // The MMG weekly-fee checkout [mmg checkout 3/6]: the store's OWNER starts
  // and follows a checkout for the selected store's subscription.
  const feeSubscriptionFor = async (request: FastifyRequest) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    return app.prisma.subscription.findFirst({ where: { vendorId } });
  };
  const mmgCheckout = registerPartnerMmgCheckoutRoutes(app, { subscriptionFor: feeSubscriptionFor });
  // [PT-2] Card payment for the weekly fee (CARD-CHECKOUT-API.md): the store's
  // OWNER lists, removes, adds and pays by card for the selected store's
  // subscription. Card rail v2 stays behind CARD_RAIL_V2 (default off).
  const cardRail = registerPartnerCardRoutes(app, { subscriptionFor: feeSubscriptionFor });

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
    const { feeStatusFor } = await import('../billing/fee-status');
    if (!subscription) return { success: true, data: null };
    const fee = await payInfo(app.prisma, subscription);
    return {
      success: true,
      data: {
        ...subscription,
        // "My Swift Number" + Pay-screen block [san spec 2.4/6.1].
        ...(await sanDisplay(app.prisma, subscription)),
        ...fee,
        // [FEE-STATUS] Where the fee stands, in the server's words: never a passed date as a next bill.
        feeStatus: await feeStatusFor(app.prisma, subscription, fee),
        // payActions, latestMmgCheckout, recentCheckouts (MMG-CHECKOUT-API.md section 3).
        ...withCardPayAction(await mmgCheckout.feePayload(subscription, request.headers), await cardRail.subscriptionFields(subscription, request)),
        weeklyRate: Number(subscription.weeklyRate),
        // [owner legal plan R12] The weekly-fee receipts, as printed (billing/fee-receipt.ts).
        feeReceipts: await (await import('../billing/fee-receipt')).feeReceiptsFor(app.prisma, subscription.id),
      },
    };
  });

  /** PUT /subscription/billing-method — §13 rail selection (owner-only:
   *  CASH prepaid vs MOBILE_MONEY merchant-initiated on the owner's MMG), and
   *  [E12] the partner's self-serve stop/resume: `NONE` stops weekly billing
   *  (the paid period still runs out, then the store stops receiving work);
   *  CASH or MOBILE_MONEY resumes it on that rail. */
  app.put('/subscription/billing-method', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'OWNER');
    const body = z.object({
      method: z.enum(['CASH', 'MOBILE_MONEY', 'NONE']),
      mmgPayerMsisdn: z.string().trim().min(5).max(30).optional(),
    }).parse(request.body);
    // [REVIEW-PARTNER · DL-5] No weekly fee in the fiction: no rail to choose, no step-up to run.
    if (request.tenantKind === 'REVIEW') throw new ReviewDemoMoneyRefusedError();
    await requireStepUp(app, request);
    const sub = await app.prisma.subscription.findFirst({ where: { vendorId } });
    if (!sub) throw new NotFoundError('Subscription');
    const billingSvc = new BillingService(app.prisma, notifications, getPaymentProvider());
    const updated = body.method === 'NONE'
      ? await billingSvc.stopBilling(sub.id, request.user.userId)
      : await billingSvc.setBillingRail(sub.id, body.method, body.mmgPayerMsisdn);
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

    const tenantId = request.tenantId;
    if (!tenantId) {
      throw new AppError(500, 'TENANT_CONTEXT_REQUIRED', 'This review request has no authenticated tenant context.');
    }
    const { minScore, maxScore } = reviewsQuerySchema.parse(request.query);
    // The store console must not vary with the operator's own blocks: an
    // operator already knows customers from orders and could link a review
    // to a customer by toggling a block and watching this list change.
    const publishedWhere = publishedVendorReviewWhere(vendorId);
    const where = {
      ...publishedWhere,
      ...(minScore || maxScore
        ? {
          score: {
            ...(minScore ? { gte: minScore } : {}),
            ...(maxScore ? { lte: maxScore } : {}),
          },
        }
        : {}),
    };

    const [reviews, scoreBuckets] = await Promise.all([
      // Row 52: the store sees what was said, never who said it. An explicit
      // allowlist (no rater, raterId, orderId or moderation fields) so a new
      // column can never leak through this list by default.
      app.prisma.rating.findMany({
        where,
        select: STORE_REVIEW_PROJECTION,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.limit,
      }),
      app.prisma.rating.groupBy({
        by: ['score'],
        where,
        _count: true,
        orderBy: { score: 'asc' },
      }),
    ]);
    const summary = summarizeRatingDistribution(scoreBuckets);

    return {
      success: true,
      ...paginatedResponse(reviews.map(storeVisibleReview), summary.totalReviews, pagination),
      summary: {
        averageRating: summary.averageRating,
        totalReviews: summary.totalReviews,
        distribution: summary.distribution,
      },
    };
  });

  /** POST /reviews/:id/respond — the operator's public reply (§4.1). One reply
   *  per review, editable; the reviewer is notified. */
  app.post<{ Params: IdParam }>('/reviews/:id/respond', auth, async (request) => {
    const { vendorId } = await requireVendor(app, request, 'MANAGER');
    const { response } = respondReviewSchema.parse(request.body);
    const tenantId = request.tenantId;
    if (!tenantId) {
      throw new AppError(500, 'TENANT_CONTEXT_REQUIRED', 'This review request has no authenticated tenant context.');
    }
    // Movement R (R7): scrub, live block/publication check, response CAS and
    // durable notification fact are one serializable operation. Only delivery
    // of the already-persisted notification happens after commit.
    const updated = await respondToVendorReview(app.prisma, notifications, {
      tenantId,
      responderId: request.user.userId,
      vendorId,
      reviewId: request.params.id,
      response,
      respondedAt: new Date(),
    });

    return { success: true, data: updated };
  });
}
