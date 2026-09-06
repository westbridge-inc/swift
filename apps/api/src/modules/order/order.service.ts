import { Prisma } from '@prisma/client';
import type { PrismaClient, OrderStatus, FulfillmentType, DiscountType, PromoFunder } from '@prisma/client';
import type { Server } from 'socket.io';
import { clampDriverFare, deliveryFeeFromRates, expressDeliveryFee, generateOrderNumber, type DeliveryRates } from '../../utils/markup';
import { getMapsProvider, type MapsProvider, type RouteSource } from '../../providers/maps/maps-provider';
import { canonicalBillableKm } from '../../utils/billable-distance';
import { lineTotal, orderTotal, promoDiscount, promoCapacity, allocatePromo, allocateAcrossLines, type PromoAllocation } from '../../utils/order-total';
import { isFreeCancellation, LATE_CANCEL_FEE } from './cancel-policy';
import { riderStackingCapacity, reserveRiderLeg, settleRiderLegs } from '../dispatch/concurrency-policy';
import { stackVerdict } from '../dispatch/stack-eligibility';
import {
  TERMINAL_ORDER_STATUSES,
  LIVE_ORDER_STATUSES,
  isTerminalOrderStatus,
  MOVER_HOLDING_STATUSES,
  ORDER_TRANSITIONS,
  RECOVERY_TRANSITIONS,
} from './order-status';
import { NotificationService } from '../notification/notification.service';
import { CountryConfigService } from '../country/country-config.service';
import { BookingService } from '../booking/booking.service';
import { orderingRestriction, CashRulesService, TAXI_FARE_OUTCOME_ENFORCED_AT, COURIER_CASH_OUTCOME_ENFORCED_AT } from '../cash/cash-rules.service';
import { resolveSelectedOptions, optionsUnitPrice, type ResolvedOption } from './options';
import { isKitchenAtCapacity, KITCHEN_ACTIVE_STATUSES } from '../fulfillment/kitchen-capacity';
import { log } from '../../utils/logger';
import { checkoutQueueTiming, persistCheckoutOutboxInTransaction, persistCheckoutReceiptInTransaction } from './checkout-outbox';
import { FloatService, riderFloatForOrder } from '../dispatch/float.service';
import { shadowPredictAtAccept } from '../prep/prep-time';
import { promiseAtCheckout, promiseView } from '../eta/promise';
import { AppError, ConflictError } from '../../utils/errors';
import { applyStockMovement } from '../inventory/stock';
import { dispatchSearchesCounter, earningsMissingTuplesGauge, earningsRepairsCounter, taxiDeliveredUnpaidGauge, courierDeliveredUnpaidGauge } from '../../plugins/observability';
import { randomInt } from 'node:crypto';
import { HANDOVER_SECRETS_OMIT } from '../handover/handover-security';
import {
  hasTaxiPassengerCustody,
  lockTaxiOrderForCustodyDecision,
} from '../rides/passenger-custody';
import { validateMmgPayUrl } from '../../utils/mmg-pay-url';
import { subscriptionOperability } from '../subscription/operate-gate';
import { lockActiveOrderCustomer } from './order-creation-authority';

interface CheckoutInput {
  userId: string;
  /** [M-11] The command's identity: the customer's idempotency key and the
   *  request's fingerprint. When present the result is written inside the
   *  order transaction as a receipt, so a replay is answered from the
   *  database even if Redis forgot. */
  idempotency?: { key: string; requestHash: string };
  paymentMethod: string;
  deliveryInstructions?: string;
  tipAmount?: number;
  scheduledFor?: string; // ISO date string
  promoCode?: string;
  /** Per-vendor fulfillment choice; DELIVERY when omitted */
  fulfillmentSelections?: Record<string, 'DELIVERY' | 'PICKUP'>;
  /** Priority delivery: 1.5x the delivery fee, dispatched ahead of standard
   *  orders, premium goes to the rider. DELIVERY groups only. */
  express?: boolean;
  /** Requested appointment slots for APPOINTMENT listings in the cart.
   *  mode picks where a BOTH-mode service happens (validated against what
   *  the business actually offers). */
  appointments?: Array<{ itemId: string; slotStart: Date; mode?: 'AT_BUSINESS' | 'MOBILE' }>;
  /** Injectable clock so the risk heuristic is testable */
  now?: Date;
  /** Test seam [REPORT-013 F-013-01/06]: runs after pre-transaction pricing
   *  and before the atomic commit, so interleaving proofs (a tip mutation, a
   *  suspension, an item going dark) can be driven deterministically into the
   *  exact window the in-transaction barriers close. Never set in routes. */
  beforeTransaction?: () => Promise<void>;
  /** Test seam [M-11]: runs INSIDE the checkout transaction after the outbox
   *  rows and the receipt are written and before the commit, so a proof can
   *  make the commit fail and observe that neither the order nor its tail
   *  nor its receipt survive. Never set in routes. */
  afterDurableTail?: () => Promise<void>;
  /** Test seam [REPORT-017B F-016-01]: runs INSIDE the checkout transaction,
   *  right after the cart + cart-item rows are FOR UPDATE-locked, so an
   *  interleaving proof can attempt a concurrent child mutation and observe it
   *  block against the held lock. Never set in routes. */
  afterCartLock?: () => Promise<void>;
}

function requireCheckoutMmgPayUrl(rawUrl: string | null | undefined, vendorName: string): string {
  const checked = validateMmgPayUrl(rawUrl);
  if (checked.valid) return checked.url;
  if (checked.reason === 'MISSING') {
    throw new AppError(400, 'MMG_NOT_AVAILABLE', `${vendorName} isn't set up for MMG yet — choose cash instead.`);
  }
  if (checked.reason === 'ALLOWLIST_NOT_CONFIGURED' || checked.reason === 'ALLOWLIST_INVALID') {
    throw new AppError(503, 'MMG_PAY_LINKS_NOT_CONFIGURED', 'MMG pay links are not configured for this environment yet — choose cash instead.');
  }
  throw new AppError(400, 'MMG_LINK_INVALID', `${vendorName}'s MMG pay link cannot be used safely right now — choose cash instead.`);
}

/** [REPORT-012 F-012-04] THE post-commit publication policy for cancelling an
 *  order whose MMG payment was never attested (MOBILE_MONEY + PENDING).
 *  Whoever the terminal actor is — the customer, the vendor-timeout job, an
 *  ops agent, an admin — the STORE gets the same durable liability notice:
 *  it holds the only rail that can make an already-paid customer whole.
 *  Optional customer guidance rides the same seam so a new cancel path can
 *  never ship with half the policy. Call AFTER the canonical CANCELLED
 *  commit; per-source wording arrives via the overrides, the policy doesn't
 *  fork. */
export async function publishUnattestedMmgCancellation(
  prisma: PrismaClient,
  notifications: Pick<NotificationService, 'send'>,
  input: {
    orderId: string;
    orderNumber: string;
    vendorId: string | null;
    storeBody?: string;
    customer?: { userId: string; title: string; body: string; data?: Record<string, unknown> };
  },
): Promise<void> {
  if (input.customer) {
    await notifications.send({
      userId: input.customer.userId,
      type: 'ORDER_UPDATE',
      title: input.customer.title,
      body: input.customer.body,
      data: { orderId: input.orderId, status: 'CANCELLED', ...(input.customer.data ?? {}) },
    }).catch(() => {});
  }
  if (!input.vendorId) return;
  const vendor = await prisma.vendor
    .findUnique({ where: { id: input.vendorId }, select: { owner: { select: { userId: true } } } })
    .catch(() => null);
  if (!vendor?.owner) return;
  await notifications.send({
    userId: vendor.owner.userId,
    type: 'ORDER_UPDATE',
    title: 'Cancelled order may hold an MMG payment',
    body:
      input.storeBody
      ?? `Order ${input.orderNumber} was cancelled before its MMG payment was confirmed. If the customer's transfer arrived in your MMG, refund them directly.`,
    audience: 'business',
    data: { orderId: input.orderId, kind: 'mmg_unattested_cancellation' },
  }).catch(() => {});
}

// The order state machine — FORWARD edges and RELEASE edges — now lives in
// order-status.ts, the leaf that owns status law, so the rescue watchdog, the
// rider handback and session revocation can all read it without importing this
// module. Re-exported here because a dozen call sites already import it from
// order.service, and moving a table is not a reason to move a dozen imports.
export { ORDER_TRANSITIONS, RECOVERY_TRANSITIONS };

/** States where the order is physically with the mover — no cancellation. */
const IN_TRANSIT = MOVER_HOLDING_STATUSES;
/**
 * The order is over. EXPORTED because a hand-written copy of this list drifted
 * and shipped: Home's active-order query omitted FAILED, so a failed handover
 * rendered as a live order with "Track order" forever — and, being the newest
 * row, MASKED the customer's genuinely live order behind it.
 *
 * Anything asking "is this order finished" imports this. A second list is a
 * second answer, and the two only have to disagree once.
 *
 * That law was right, and was then broken TWELVE more times: locals in
 * mover-authority (custody), dispatch.service, delivery-watchdog (rescue),
 * order-sla, account.service and trip-share; an inline literal in admin.routes
 * — in a file already importing this very constant 1,500 lines above it; and
 * FIVE raw SQL string literals in the mover-authority cutover preparation.
 *
 * All thirteen agreed, and nothing made them. `OrderStatus[]` is not
 * exhaustive, so a new state produced no compile error anywhere and the copies
 * would have split in silence — in custody, which decides who holds authority
 * over an order, and in the watchdog, which decides what gets rescued. The SQL
 * strings could never be type-checked at all.
 *
 * The list now lives in ./order-status.ts behind a `Record<OrderStatus, …>`
 * that fails the BUILD until a new state is classified — a guarantee, not a
 * convention. Re-exported here so every existing importer is untouched.
 */
export { TERMINAL_ORDER_STATUSES, LIVE_ORDER_STATUSES, isTerminalOrderStatus };

// ---------------------------------------------------------------------------
// [SPS-F-0016 / LB-015] The MMG payment-first law. An MMG marketplace order is
// paid customer→store OUTSIDE Swift, and only the store can attest the money
// landed (vendor confirm-payment → paymentStatus CAPTURED). Until then the
// order may not move through fulfilment: not accepted, prepared, readied,
// claimed/assigned, taken into custody, delivered, self-delivered, or
// pickup-completed. The negative paths (CANCELLED / REFUNDED / FAILED) stay
// open, and the store's confirm-payment action never passes through here — it
// IS the capture. TAXI is out of scope: fares settle driver-direct at the kerb.
// ---------------------------------------------------------------------------
/** [DOC-1 §31.5 · P31-2] On the store's own wallet, money "moved" is either the provider's capture or the store's claim. */
export const MMG_MONEY_MOVED: ReadonlySet<string> = new Set(['CAPTURED', 'CLAIMED']);
const MMG_GATED_TARGETS: ReadonlySet<OrderStatus> = new Set([
  'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
  'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
  'PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED',
  'DELIVERED', 'COMPLETED',
]);

/**
 * [SPS-F-0022] CASH platform-delivery discounts have NO sponsoring rail: the
 * rider fronts the vendor the FULL goods value (subtotalBase — float gate and
 * pickup handover know nothing of promos) and collects the DISCOUNTED total,
 * so every promo dollar would come out of the rider's delivery fee. Every
 * other combination is naturally vendor-funded (MMG: customer pays the
 * discounted total to the store; PICKUP/self-delivery: the store collects its
 * own discounted amount). Fail closed on the one broken combination until the
 * vendor-funded fronting rail (front = goods − discount, with cancel/refund
 * coherence) is built and founder-approved.
 */
export function assertCashDiscountSponsored(args: {
  paymentMethod: string;
  discount: number;
  fulfillments: string[];
}): void {
  if (args.discount <= 0) return;
  if (args.paymentMethod !== 'CASH') return;
  if (!args.fulfillments.includes('DELIVERY')) return;
  throw new AppError(
    409,
    'PROMO_UNAVAILABLE_CASH_DELIVERY',
    'Promo codes aren’t available on cash delivery orders yet — pay the store directly by MMG, switch to pickup, or check out without the code.',
  );
}

export function assertMmgFulfilmentAllowed(
  order: { paymentMethod: string | null; paymentStatus: string; orderType: string | null; mmgClaimMismatchAt?: Date | null },
  target: OrderStatus,
): void {
  if (order.paymentMethod !== 'MOBILE_MONEY') return;
  if (order.orderType === 'TAXI') return;
  if (!MMG_GATED_TARGETS.has(target)) return;
  // [DOC-1 §31.5] Two claims that disagree open a case BEFORE the rider is dispatched, not after.
  if (order.mmgClaimMismatchAt) {
    throw new AppError(409, 'MMG_CLAIM_MISMATCH', 'The customer disputes the store\'s payment claim. A person must resolve it before the order moves.');
  }
  if (!MMG_MONEY_MOVED.has(order.paymentStatus)) {
    throw new AppError(
      409,
      'MMG_PAYMENT_PENDING',
      'This MMG order can move only after the store confirms the payment landed in its MMG wallet.',
    );
  }
}

/**
 * REFUNDED is intentionally overloaded in the current order model.  The
 * normal state machine uses it after CANCELLED/DELIVERED/COMPLETED as a
 * financial/accounting transition.  The admin cancellation override may use
 * it directly from an active state, where it is operationally a cancellation:
 * it closes dispatch and releases the assigned mover.
 *
 * Only the latter is a new terminalization.  Keeping this distinction here
 * lets a completed trip be refunded without allowing an active taxi with a
 * passenger aboard to be disguised as REFUNDED and made dispatchable again.
 */
function isCancellationTerminalization(sourceStatus: OrderStatus, target: OrderStatus): boolean {
  return target === 'CANCELLED'
    || (target === 'REFUNDED' && !ORDER_TRANSITIONS.REFUNDED.includes(sourceStatus));
}

// ---------------------------------------------------------------------------
// LIFECYCLE_V2 hold (spec Part A). While holdExpiresAt is in the FUTURE the
// order is hidden from the vendor and undispatched — the customer's free-cancel
// window. OFF by default: with the flag unset, orders are born with no hold and
// behave exactly as before. The server clock decides everything; any client
// countdown is cosmetic.
// ---------------------------------------------------------------------------

/** Hold duration in ms, or null when the feature is off / misconfigured. */
export function holdWindowMs(): number | null {
  if (process.env['LIFECYCLE_V2'] !== '1') return null;
  // [REPORT-036 F036-03b] Default 5 — the SETTLED value (Total Audit S4; both
  // env examples say 5 since #792). The code defaulting 2 meant an env that
  // omitted the variable quietly broke the documented customer promise: the
  // free-cancel window (FREE_CANCEL_WINDOW_MIN = 5) outlived the hold, putting
  // orders on the vendor board while still free to cancel.
  const minutes = Number(process.env['ORDER_HOLD_MINUTES'] ?? 5);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : null;
}

/** Prisma WHERE fragment: only orders a vendor/mover is allowed to see. */
export function notHeldFilter() {
  return { OR: [{ holdExpiresAt: null }, { holdExpiresAt: { lte: new Date() } }] };
}

/** A held order = pre-release: hidden, undispatched, freely cancellable. */
export function isHeld(order: { holdExpiresAt: Date | null }, now = new Date()): boolean {
  return order.holdExpiresAt != null && order.holdExpiresAt > now;
}

const RIDER_ASSIGNMENT_SNAPSHOT_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  customerId: true,
  vendorId: true,
  pickupAddress: true,
  deliveryAddress: true,
  deliveryFee: true,
  tipAmount: true,
  // [REPORT-006] Locked-row money facts: the board-accept route commits CASH
  // float from THIS snapshot (never its pre-lock preview), so the amount
  // matches what picking/refunds may have changed before the lock was taken.
  paymentMethod: true,
  subtotalBase: true,
  rider: { select: { user: { select: { firstName: true } } } },
} as const satisfies Prisma.OrderSelect;

type RiderAssignmentSnapshot = Prisma.OrderGetPayload<{
  select: typeof RIDER_ASSIGNMENT_SNAPSHOT_SELECT;
}>;

const CANONICAL_TRANSITION_INCLUDE = {
  vendor: { select: { name: true, ownerId: true } },
  customer: { select: { id: true, firstName: true } },
  rider: {
    select: {
      userId: true,
      totalDeliveries: true,
      user: { select: { firstName: true } },
    },
  },
} as const satisfies Prisma.OrderInclude;

type CanonicalTransitionOrder = Prisma.OrderGetPayload<{
  include: typeof CANONICAL_TRANSITION_INCLUDE;
  omit: typeof HANDOVER_SECRETS_OMIT;
}>;

type EarningNotice = {
  userId: string;
  amount: number;
  type: 'DELIVERY_FEE' | 'COURIER_FEE' | 'TAXI_FARE' | 'TIP';
};

export interface CanonicalOrderTransitionInput {
  orderId: string;
  target: OrderStatus;
  allowedFrom: readonly OrderStatus[];
  /** Null denotes an automated system transition, never a customer action. */
  changedBy: string | null;
  note?: string;
  /** Cancellation metadata is route-specific; cleanup is derived centrally
   * from the target + the fresh, locked source state. */
  cancellation?: {
    /** Null keeps system cancellations out of customer-risk attribution. */
    by: string | null;
    reason: string;
    lateFeeDue?: number;
  };
  /** Route-specific terminal facts that must commit with the state machine.
   * Deliberately whitelisted so callers cannot overwrite ownership, money, or
   * status outside the canonical transition rules. */
  terminalMetadata?: {
    actualDeliveryTime?: number | null;
    courierProofPhotoUrl?: string;
  };
  /** A successfully completed taxi trip rehabilitates the driver's rolling
   * cancellation-rate signal in the same commit that counts the ride. */
  decayDriverCancellationRate?: boolean;
  /** Queue-only guard: the worker may cancel PENDING work only after its
   * checkout hold has elapsed. Revalidated from the locked source row. */
  requireHoldExpired?: boolean;
  /** [REPORT-014 F-014-02] Actor bind ON THE LOCKED ROW: the transition
   * commits only while this rider still owns the order. A route-level
   * ownership pre-read cannot survive a watchdog release or reassignment
   * committing before the lock — this can. */
  expectedRiderId?: string;
  /** Legacy cancel routes historically healed null/dangling mover pointers.
   * Strict state-machine completions leave every different pointer untouched. */
  releaseStaleMoverPointer?: boolean;
  /** [REPORT-007-v4 F-05] Route-specific work that must share the canonical
   * Order-lock commit (e.g. the appointment slot reservation at vendor
   * acceptance). Runs AFTER the status write and cleanup on the same locked
   * row; a throw rolls the whole transition back. Must not publish. */
  withinTransaction?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** Admin's explicit action evidence belongs in the same commit as the order
   * state. The generic after-response route audit remains defence in depth. */
  operatorAudit?: {
    userId: string;
    action: string;
    entity: string;
    entityId: string;
    changes?: (sourceStatus: OrderStatus) => Prisma.InputJsonValue;
    ipAddress?: string;
    userAgent?: string;
  };
  invalidStatus?: (current: OrderStatus) => AppError;
}

export interface CanonicalOrderTransitionResult {
  order: CanonicalTransitionOrder;
  sourceStatus: OrderStatus;
  cancelledSearches: number;
  earningNotices: EarningNotice[];
}

const RISK_NEW_ACCOUNT_HOURS = 72;
/** Guyana is UTC-4 year-round */
const GUYANA_UTC_OFFSET_HOURS = -4;

export class OrderService {
  private notifications: NotificationService;
  private countryConfig: CountryConfigService;
  private booking: BookingService;

  constructor(
    private prisma: PrismaClient,
    private io: Server,
    private maps: MapsProvider = getMapsProvider(),
    /** Rider-supply read for the §2 checkout gate (availability spec) — the
     *  SAME read dispatch uses, injected so this service stays dispatch-free.
     *  floatRequired mirrors dispatch's cash-float gate so the probe counts only
     *  riders that could actually take THIS order. */
    private riderAvailability?: (point: { lat: number; lng: number }, floatRequired?: number) => Promise<{ level: string }>,
  ) {
    this.notifications = new NotificationService(prisma, io);
    this.countryConfig = new CountryConfigService(prisma);
    this.booking = new BookingService(prisma, io);
  }

  /**
   * Direct board-grab persistence boundary. The caller must invoke this inside
   * the SAME interactive transaction that reserved cash float and locked the
   * user's mover authority. Order ownership/status, the one-live-job Rider
   * pointer, and the immutable status evidence either all commit or all roll
   * back. Network side effects deliberately do not happen here.
   */
  async stageDirectRiderAssignment(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      riderId: string;
      changedBy: string;
      note?: string;
      /** Rider-chosen delivery fee (CASH rail only) — the seam derives the
       *  clamp and the total delta from the LOCKED row, never from a route
       *  preview [REPORT-005 F-005-01]. */
      requestedFee?: number;
      moverUserId: string;
    },
  ): Promise<RiderAssignmentSnapshot> {
    // [SPS-F-0016] Direct claims (boards / dispatch accept) don't pass the
    // canonical transition seam, so the MMG payment-first gate is re-checked
    // here — inside the same transaction, before the CAS — covering legacy
    // in-flight rows that predate the gate.
    // [REPORT-006 F-006-03] A real row lock, not a plain read: a concurrent
    // CASH convert-to-pickup could commit between a snapshot read and the CAS,
    // leaving the fare delta derived from a fee the conversion already zeroed
    // (total below the goods subtotal) and a rider assigned to a PICKUP order.
    // Both writers serialize on the orders row; the CAS below additionally
    // binds fulfillment:'DELIVERY' as the belt.
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${input.orderId} FOR UPDATE`;
    const paymentGate = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { paymentMethod: true, paymentStatus: true, orderType: true, deliveryFee: true, fulfillment: true },
    });
    if (paymentGate) {
      assertMmgFulfilmentAllowed(paymentGate, 'RIDER_ASSIGNED');
      if (paymentGate.fulfillment !== 'DELIVERY') {
        throw new ConflictError('This order no longer needs a rider — the customer switched it to pickup');
      }
    }

    // [REPORT-005 F-005-01] Rider price choice is a CASH feature: the customer
    // pays the (lower) total at the door. An MMG total was already paid — or
    // externally instructed — at checkout; repricing after capture rewrites
    // money the store received. Fee applied as an atomic delta off the locked
    // row so a stale preview can never smuggle in an absolute total.
    let repricing: Prisma.OrderUncheckedUpdateManyInput = {};
    if (input.requestedFee != null && paymentGate) {
      const marketFee = Number(paymentGate.deliveryFee);
      const chosenFee = clampDriverFare(input.requestedFee, marketFee);
      if (chosenFee !== marketFee) {
        if (paymentGate.paymentMethod !== 'CASH') {
          throw new AppError(
            409,
            'MMG_PRICE_LOCKED',
            'The delivery price can’t change on an MMG order — the customer already paid the checkout total to the store.',
          );
        }
        repricing = { deliveryFee: chosenFee, totalAmount: { decrement: marketFee - chosenFee } };
      }
    }

    const claimed = await tx.order.updateMany({
      where: {
        id: input.orderId,
        customerId: { not: input.moverUserId },
        riderId: null,
        status: { in: ORDER_TRANSITIONS.RIDER_ASSIGNED },
        // [REPORT-006 F-006-03] Riders are assigned to DELIVERY work only —
        // a converted (PICKUP) or appointment order matches nothing here.
        fulfillment: 'DELIVERY',
        // [TA-S0-001 hold] An order held for a person (too old, already paid
        // by MMG) is not claimable by anyone but an operator's decision.
        foodAgeHeldAt: null,
      },
      data: {
        riderId: input.riderId,
        status: 'RIDER_ASSIGNED',
        ...repricing,
      },
    });
    if (claimed.count === 0) {
      throw new ConflictError('This order was just claimed by another rider, or is no longer available');
    }

    // Stacking [B5]: the ONE reservation both claim doors use — a guarded raw
    // update whose count condition and write are a single statement (the
    // FloatService.commit idiom), so concurrent claims cannot both slip under
    // the cap. Between legs, the batching rulebook judges the pairing first;
    // a refusal names its rule and rolls the whole claim back.
    const stackCapacity = await riderStackingCapacity(this.prisma);
    if (stackCapacity > 1) {
      const verdict = await stackVerdict(tx, input.riderId, input.orderId);
      if (!verdict.eligible && verdict.legs > 0) {
        throw new ConflictError(
          `This job can't be stacked with your current delivery (${verdict.rule}: ${verdict.detail})`,
        );
      }
    }
    const reserved = await reserveRiderLeg(tx, input.riderId, input.orderId, stackCapacity);
    if (!reserved) {
      throw new ConflictError(stackCapacity > 1
        ? 'You are at your delivery limit — finish one before taking another.'
        : 'You must be online and free before taking another order.');
    }

    await tx.orderStatusLog.create({
      data: {
        orderId: input.orderId,
        status: 'RIDER_ASSIGNED',
        changedBy: input.changedBy,
        note: input.note,
      },
    });

    return tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      select: RIDER_ASSIGNMENT_SNAPSHOT_SELECT,
    });
  }

  /** Publish live/customer hints only after the assignment transaction commits.
   * Canonical state is already durable, so a transient socket/push failure must
   * never turn a successful board grab into a misleading HTTP failure. */
  async publishCommittedRiderAssignment(
    order: RiderAssignmentSnapshot,
    changedBy: string,
  ): Promise<void> {
    log().info({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: 'RIDER_ASSIGNED',
      changedBy,
      vendorId: order.vendorId,
    }, 'order: status changed');

    const statusEvent = {
      orderId: order.id,
      status: 'RIDER_ASSIGNED',
      timestamp: new Date().toISOString(),
    };
    try {
      this.io.to(`order:${order.id}`).emit('order:status_changed', statusEvent);
      if (order.vendorId) {
        this.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', statusEvent);
      }
    } catch (err) {
      log().warn({ err, orderId: order.id }, 'rider assignment socket publication failed');
    }

    const riderName = order.rider?.user.firstName || 'Your rider';
    await this.notifications
      .riderAssigned(order.customerId, order.orderNumber, riderName, order.id)
      .catch((err) => log().warn({ err, orderId: order.id }, 'rider assignment notification failed'));
  }

  async checkout(input: CheckoutInput) {
    const now = input.now ?? new Date();

    const cart = await this.prisma.cart.findUnique({
      where: { customerId: input.userId },
      include: { items: { include: { item: { include: { vendor: true, optionGroups: { include: { options: true } } } } } } },
    });
    if (!cart || cart.items.length === 0) {
      throw new AppError(400, 'EMPTY_CART', 'Your cart is empty');
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: input.userId },
      select: { tenantId: true, trustLevel: true, countryCode: true, createdAt: true, selfieCapturedAt: true },
    });

    // Strike consequences: repeated failed cash handovers
    // restrict ordering to verified accounts, then ban outright
    const restriction = await orderingRestriction(this.prisma, input.userId);
    if (restriction === 'banned') {
      throw new AppError(403, 'ACCOUNT_RESTRICTED', 'Ordering is disabled on this account after repeated failed deliveries. Contact support.');
    }
    if (restriction === 'restricted') {
      throw new AppError(403, 'STRIKE_RESTRICTED', 'After repeated failed deliveries, ordering requires ID verification. Verify your identity to continue.');
    }

    // Universal signup selfie (master plan §3): every account carries a live
    // profile photo before transacting — the vendor/mover sees who is ordering.
    if (!user.selfieCapturedAt) {
      throw new AppError(403, 'SELFIE_REQUIRED', 'Add your profile photo before placing orders — it takes a few seconds in the app.');
    }

    // Group the cart by vendor — a multi-vendor cart splits into one order each
    const groups = new Map<string, typeof cart.items>();
    for (const ci of cart.items) {
      const list = groups.get(ci.item.vendorId) ?? [];
      list.push(ci);
      groups.set(ci.item.vendorId, list);
    }

    if (input.paymentMethod === 'MOBILE_MONEY' && groups.size !== 1) {
      throw new AppError(
        400,
        'MMG_MULTI_VENDOR_UNSUPPORTED',
        'MMG checkout currently supports one business at a time — choose cash or place separate orders.',
      );
    }

    const requestedSlots = new Map((input.appointments ?? []).map((a) => [a.itemId, a.slotStart]));
    const requestedModes = new Map((input.appointments ?? []).map((a) => [a.itemId, a.mode]));

    // Default address (only required when some group is DELIVERY)
    let address = cart.deliveryAddressId
      ? await this.prisma.address.findUnique({ where: { id: cart.deliveryAddressId } })
      : null;
    if (!address) {
      address = await this.prisma.address.findFirst({ where: { userId: input.userId, isDefault: true } });
    }

    // FUL-003b: resolve the delivery-fee schedule from the buyer's country
    // ONCE for this checkout (null config → code defaults). The cart preview
    // (buildCartResponse) resolves the same schedule, so the fee shown and the
    // fee charged never disagree.
    const deliveryRates: DeliveryRates = await this.countryConfig.getDeliveryRates(user.countryCode);

    // First pass: validate every group and price it (zero markup — §18)
    const plans: Array<{
      vendor: (typeof cart.items)[number]['item']['vendor'];
      fulfillment: FulfillmentType;
      appointmentSlot?: Date;
      distanceKm: number;
      /** [ALG-18] Which engine priced `distanceKm`; frozen on the order with it. */
      distanceSource: RouteSource | null;
      deliveryFee: number;
      subtotal: number;
      orderItems: Array<{
        itemId: string; name: string; quantity: number; basePrice: number;
        unitPrice: number; totalBase: number; specialInstructions?: string | null;
        options: ResolvedOption[]; tracksStock: boolean;
        /** [G2] Snapshot of Item.bulkUnits at checkout — see the create below. */
        bulkUnits: number | null;
      }>;
    }> = [];

    for (const [vendorId, items] of groups) {
      const vendor = items[0]!.item.vendor;
      if (!vendor.isCurrentlyOpen || !vendor.acceptingOrders || vendor.status !== 'ACTIVE') {
        throw new AppError(400, 'VENDOR_CLOSED', `${vendor.name} is currently not accepting orders`);
      }
      // [REPORT-012 F-012-05] The derived vendor flags are not the whole
      // authority: checkout re-evaluates SUBSCRIPTION operability live. This
      // closes the split-commit residue (a suspension whose vendor write
      // hasn't landed) AND the pure-wall-clock case — a PAST_DUE store whose
      // grace lapsed a minute ago stops selling NOW, not at the next sweep,
      // even from a cart opened while it was still operable.
      const vendorSub = await this.prisma.subscription.findFirst({
        where: { vendorId: vendor.id },
        orderBy: { createdAt: 'desc' },
        select: { status: true, gracePeriodEnd: true },
      });
      const vendorOperability = subscriptionOperability(vendorSub, { missingRow: 'GRANDFATHER' });
      if (!vendorOperability.operable) {
        throw new AppError(400, 'VENDOR_CLOSED', `${vendor.name} is currently not accepting orders`);
      }
      // FUL-007: kitchen-capacity guard (Part 5D). A vendor can cap how many
      // orders it holds in the kitchen at once so a small shop isn't drowned.
      // Best-effort early check (like the inventory early-check below): a rare
      // simultaneous-checkout race could admit one over the cap, which is
      // harmless — capacity is a protective throttle, not money. Null cap
      // (every vendor's default) means unlimited intake.
      if (vendor.maxConcurrentOrders != null) {
        const active = await this.prisma.order.count({
          where: { vendorId: vendor.id, status: { in: KITCHEN_ACTIVE_STATUSES } },
        });
        if (isKitchenAtCapacity(active, vendor.maxConcurrentOrders)) {
          throw new AppError(400, 'VENDOR_AT_CAPACITY',
            `${vendor.name} is at capacity right now — please try again in a few minutes`);
        }
      }
      // Friendly preflight. The same destination is re-read and validated under
      // a vendor row lock in the commit transaction, so a concurrent profile
      // edit cannot swap/remove the payment target after this decision.
      if (input.paymentMethod === 'MOBILE_MONEY') {
        requireCheckoutMmgPayUrl(vendor.mmgPayUrl, vendor.name);
      }

      // [DOC-1 §18.3 · DOC-INV-26] A line in a BLOCK_ORDER category whose licence
      // is not valid fails the order — the lapse-after-publish case.
      {
        const { assertOrderable } = await import('../verification/category-gate');
        await assertOrderable(this.prisma, vendorId, items.map((ci) => ({ id: ci.item.id, name: ci.item.name })), input.now ?? new Date());
      }
      // [DOC-1 §3.6 · P3-2] An UNREGISTERED micro-vendor trades under caps: orders a day and
      // gross a week. The order's food cost is what the cap counts (the same figure the rider
      // fronts); a REGISTERED store is never judged here.
      if (vendor.tier === 'UNREGISTERED') {
        const { assertWithinTierCaps, vendorTierCapsFor, nudgeOwnerOnce } = await import('../vendor/vendor-tier');
        const caps = await vendorTierCapsFor(this.countryConfig, (await this.prisma.user.findUniqueOrThrow({ where: { id: input.userId }, select: { countryCode: true } })).countryCode);
        const gross = items.reduce((sum, ci) => sum + Number(ci.item.basePrice) * ci.quantity, 0);
        const verdict = await assertWithinTierCaps(this.prisma, vendor, caps, gross, input.now ?? new Date());
        // The 60% nudge: told once a day, never on a refused order.
        if (verdict) await nudgeOwnerOnce(this.prisma, this.notifications, vendor, verdict, caps, input.now ?? new Date()).catch(() => false);
      }

      // Inventory (§4.2): a tracked item can't be ordered beyond the shelf.
      // The race-proof guard is the conditional decrement in the transaction
      // below — this is the friendly early error for the common case.
      for (const ci of items) {
        // A vendor can 86 a listing (isAvailable=false) independently of stock
        // tracking. Without this guard an un-tracked, hidden item would be
        // CHARGED — and a percentage/free-delivery promo would be computed
        // against a basket that includes an item the vendor can't fulfil. We
        // reject rather than silently drop: changing someone's order (and the
        // total they'll pay in cash) without consent is worse than asking them
        // to remove it. Mirrors the sold-out path so the client handles both.
        if (!ci.item.isAvailable) {
          throw new AppError(409, 'ITEM_UNAVAILABLE',
            `${ci.item.name} is no longer available — remove it to continue`,
            { itemId: ci.item.id });
        }
        if (ci.item.stockQuantity !== null && ci.quantity > ci.item.stockQuantity) {
          throw new AppError(409, 'INSUFFICIENT_STOCK',
            ci.item.stockQuantity <= 0
              ? `${ci.item.name} is sold out`
              : `Only ${ci.item.stockQuantity} of ${ci.item.name} left — reduce the quantity`,
            { itemId: ci.item.id, available: ci.item.stockQuantity });
        }
      }

      const appointmentItems = items.filter((ci) => ci.item.fulfillment === 'APPOINTMENT');
      let fulfillment: FulfillmentType;
      let appointmentSlot: Date | undefined;

      if (appointmentItems.length > 0) {
        if (appointmentItems.length !== items.length || items.length !== 1) {
          throw new AppError(400, 'MIXED_FULFILLMENT', 'Book appointments separately from goods');
        }
        const only = appointmentItems[0]!;
        const slot = requestedSlots.get(only.itemId);
        if (!slot) {
          throw new AppError(400, 'SLOT_REQUIRED', `Pick a time slot for ${only.item.name}`);
        }
        // Validates config, day window, alignment, and that it's in the future.
        // The slot is RESERVED at vendor acceptance, not here.
        await this.booking.validateSlot(only.itemId, slot);
        fulfillment = 'APPOINTMENT';
        appointmentSlot = slot;
      } else {
        fulfillment = input.fulfillmentSelections?.[vendorId] ?? 'DELIVERY';
      }

      let distanceKm = 0;
      let distanceSource: RouteSource | null = null;
      let deliveryFee = 0;
      if (fulfillment === 'DELIVERY') {
        if (!address) throw new AppError(400, 'NO_ADDRESS', 'Please set a delivery address');
        // §2 checkout gate (availability spec, flag-gated): zero riders online
        // means an order that would strand food on a counter — honesty beats
        // accepting it. Pickup remains available; appointments never get here.
        if (
          process.env['DISPATCH_AVAILABILITY'] === '1'
          && process.env['DELIVERY_BLOCK_ON_NONE'] !== '0'
          && this.riderAvailability
        ) {
          // Mirror dispatch's cash-float gate: a CASH delivery needs a rider who
          // can front this order's vendor-cash. Probing float-blind would count
          // riders dispatch then skips → checkout says "yes", dispatch exhausts.
          const cashFloat = input.paymentMethod === 'CASH'
            ? items.reduce((s, ci) => s + (Number(ci.item.basePrice) + optionsUnitPrice(resolveSelectedOptions(ci.item, ci.selectedOptions))) * ci.quantity, 0)
            : 0;
          const supply = await this.riderAvailability({ lat: vendor.latitude, lng: vendor.longitude }, cashFloat).catch(() => null);
          if (supply?.level === 'NONE') {
            throw new AppError(
              409,
              'DELIVERY_NO_RIDERS',
              'No delivery riders are online right now — you can order for Pickup instead, or try delivery again later.',
            );
          }
        }
        // Real road km when OSRM is configured; deterministic estimate otherwise.
        const route = await this.maps.routeKm(
          { lat: vendor.latitude, lng: vendor.longitude },
          { lat: address.latitude, lng: address.longitude },
        );
        // [ALG-18] Canonical BEFORE pricing: the fee and the frozen number are one number.
        distanceKm = canonicalBillableKm(route.km);
        distanceSource = route.source;
        if (distanceKm > vendor.deliveryRadius) {
          throw new AppError(400, 'OUT_OF_RANGE', `${vendor.name} only delivers within ${vendor.deliveryRadius} km. You are ${distanceKm.toFixed(1)} km away.`);
        }
        deliveryFee = deliveryFeeFromRates(distanceKm, deliveryRates);
        // Express mirrors the courier EXPRESS multiplier. The premium is part of
        // the fee the rider collects in cash — it is THEIR upside. Same helper
        // the cart quote uses, so the preview and the charge never disagree.
        if (input.express) deliveryFee = expressDeliveryFee(deliveryFee);
      } else if (fulfillment === 'APPOINTMENT') {
        // MOBILE / BOTH services travel to the customer — require their address and
        // enforce the provider's service radius (mirrors the DELIVERY gate above).
        const bcfg = (appointmentItems[0]!.item.bookingConfig ?? {}) as { serviceMode?: string; serviceRadiusKm?: number };
        const offered = bcfg.serviceMode ?? 'AT_BUSINESS';
        // Where it happens: the business's setting, narrowed by the customer's
        // choice when the business offers BOTH. Asking for a mode the business
        // does not offer is a 400, never a silent fallback.
        const requestedMode = requestedModes.get(appointmentItems[0]!.itemId);
        if (requestedMode === 'MOBILE' && offered === 'AT_BUSINESS') {
          throw new AppError(400, 'MODE_NOT_OFFERED', `${vendor.name} does not travel to customers for this service`);
        }
        if (requestedMode === 'AT_BUSINESS' && offered === 'MOBILE') {
          throw new AppError(400, 'MODE_NOT_OFFERED', `${vendor.name} only offers this service at your address`);
        }
        const mobileVisit = requestedMode ? requestedMode === 'MOBILE' : offered === 'MOBILE' || offered === 'BOTH';
        if (mobileVisit) {
          if (!address) throw new AppError(400, 'NO_ADDRESS', `Add your address — ${vendor.name} travels to you`);
          const travel = await this.maps.routeKm(
            { lat: vendor.latitude, lng: vendor.longitude },
            { lat: address.latitude, lng: address.longitude },
          );
          const travelKm = canonicalBillableKm(travel.km);
          distanceSource = travel.source;
          const radius = Number(bcfg.serviceRadiusKm ?? 0);
          if (radius > 0 && travelKm > radius) {
            throw new AppError(400, 'OUT_OF_SERVICE_AREA', `${vendor.name} travels within ${radius} km. You are ${travelKm.toFixed(1)} km away.`);
          }
          distanceKm = travelKm;
        }
      }

      // Zero-commission model: the customer pays exactly the vendor's price
      const orderItems = items.map((ci) => {
        const basePrice = Number(ci.item.basePrice);
        const options = resolveSelectedOptions(ci.item, ci.selectedOptions);
        const unitPrice = basePrice + optionsUnitPrice(options);
        return {
          itemId: ci.item.id,
          name: ci.item.name,
          quantity: ci.quantity,
          basePrice,
          unitPrice,
          totalBase: lineTotal(unitPrice, ci.quantity),
          specialInstructions: ci.specialInstructions,
          options,
          tracksStock: ci.item.stockQuantity !== null,
          bulkUnits: ci.item.bulkUnits ?? null,
        };
      });
      const subtotal = orderItems.reduce((s, i) => s + i.totalBase, 0);

      if (subtotal < Number(vendor.minOrderAmount)) {
        throw new AppError(400, 'MIN_ORDER', `Minimum order at ${vendor.name} is $${Number(vendor.minOrderAmount).toLocaleString()} GYD`);
      }

      plans.push({ vendor, fulfillment, appointmentSlot, distanceKm, distanceSource, deliveryFee, subtotal, orderItems });
    }

    // [REPORT-012 F-012-01] Presence, not truthiness: an explicit
    // `tipAmount: 0` from checkout means "NO tip", and must NOT fall through
    // (`||`) to a positive tip persisted on the cart by another surface/
    // session — that silently charged a tip the customer just zeroed. Only an
    // ABSENT client tip inherits the cart's stored value.
    const tip = input.tipAmount != null ? input.tipAmount : (Number(cart.tipAmount) || 0);
    // [REPORT-012 F-012-01] "Tip your rider" is delivery money. A basket with
    // no DELIVERY plan (pickup / appointment-only) has no rider, so no order
    // carries the tip — and it must not inflate grandTotal either: that figure
    // feeds the ID gate and customer.totalSpent, and a phantom tip there
    // corrupts threshold and accounting evidence.
    const tipPlanIndex = plans.findIndex((p) => p.fulfillment === 'DELIVERY');
    const effectiveTip = tipPlanIndex >= 0 ? tip : 0;

    let discount = 0;
    let promoCodeId: string | null = null;
    let promoVendorId: string | null = null;
    // [M-32] The terms the order is priced under, snapshotted on its redemption.
    let promoTerms: RedeemedPromoTerms | null = null;
    if (input.promoCode) {
      const promo = await this.validatePromoCode(
        input.promoCode,
        input.userId,
        plans.map((p) => ({ vendorId: p.vendor.id, subtotal: p.subtotal, deliveryFee: p.deliveryFee })),
      );
      discount = promo.discount;
      promoCodeId = promo.id;
      promoVendorId = promo.vendorId;
      promoTerms = promo.terms;
    }
    const promoFunder = promoTerms?.funder ?? null;

    // [REPORT-034 S1] A discount can never exceed what the basket it targets is
    // able to absorb. A FIXED_AMOUNT promo takes its value verbatim (see
    // validatePromoCode), so a $5,000 code on a $1,200 basket used to subtract
    // the whole $5,000 here — while each stored order clamped its own total at
    // zero further down. The result was a response `grandTotal` that disagreed
    // with the rows it summarised, and a lifetime `totalSpent` that could be
    // DECREMENTED by placing an order. Swift never owes a customer money: the
    // floor is zero, and it belongs at the point the discount is decided so
    // that every consumer below — the per-plan allocation, the stored totals,
    // the receipt and the spend ledger — reads the same number.
    //
    // The capacity mirrors the allocation rule used later: a vendor promo can
    // only be absorbed by ITS vendor's plan; a platform code by the whole
    // basket. Tip rides whichever plan carries it.
    const promoPlanIdxForCap = promoVendorId ? plans.findIndex((p) => p.vendor.id === promoVendorId) : -1;
    // [M-32] The capacity is what the promo's FUNDER may discount: the goods,
    // plus the delivery fee only for a platform code (a store's promotion is
    // not the rider's fee to give away). The tip is never in it — a promised
    // tip is the mover's, and no sponsor rail exists to fund it. Before, the
    // tip sat inside the capacity, so a code larger than goods + fee ate the
    // rider's tip while the tip earning was still minted in full.
    const discountCapacity = (promoPlanIdxForCap >= 0 ? [promoPlanIdxForCap] : plans.map((_, i) => i)).reduce(
      (sum, i) => sum + promoCapacity(promoFunder, { subtotal: plans[i]!.subtotal, deliveryFee: plans[i]!.deliveryFee }, promoTerms?.discountType ?? null),
      0,
    );
    discount = Math.min(discount, Math.max(0, discountCapacity));

    assertCashDiscountSponsored({
      paymentMethod: input.paymentMethod,
      discount,
      fulfillments: plans.map((p) => p.fulfillment),
    });

    const grandTotal = plans.reduce((s, p) => s + p.subtotal + p.deliveryFee, 0) + effectiveTip - discount;

    // The ID-gate (locked model): at or above the country's USD-equivalent
    // threshold, an L1 account must verify identity first. L2/L3 flow through.
    const gateLocal = await this.countryConfig.getIdGateThresholdLocal(user.countryCode);
    // [M-36] The order's currency is the buyer's market's — stamped once here
    // so every money column on the row names its unit.
    const orderCurrency = (await this.countryConfig.getByCode(user.countryCode).catch(() => null))?.currencyCode ?? 'GYD';
    if (user.trustLevel === 'L1' && grandTotal >= gateLocal) {
      throw new AppError(403, 'ID_VERIFICATION_REQUIRED',
        `Orders of $${Math.round(gateLocal).toLocaleString()} GYD or more need ID verification. Verify once in the app and this limit is gone.`,
        { threshold: gateLocal, total: grandTotal });
    }

    // SWIFT-162: high-value promo codes are the multi-account (fresh-SIM) abuse
    // target — the total-gate above misses a big code redeemed on a small NET
    // basket (a large discount pulls grandTotal back under the threshold). Gate
    // the discount itself: an L1 account claiming a discount worth at least the
    // ID-gate threshold must verify identity first, raising the bar from a
    // throwaway SIM to a verified ID. L2/L3 and ordinary low-value codes flow
    // through untouched. The threshold is the same CountryConfig ID-gate value —
    // one trust boundary, tunable per country, no new magic number.
    if (user.trustLevel === 'L1' && discount >= gateLocal) {
      throw new AppError(403, 'ID_VERIFICATION_REQUIRED',
        `This promo needs ID verification to use. Verify once in the app and it's yours to keep.`,
        { threshold: gateLocal, discount });
    }

    // Deterministic risk heuristic — vendor sees a call-to-confirm prompt
    const accountAgeHours = (now.getTime() - user.createdAt.getTime()) / 3_600_000;
    const localHour = ((now.getUTCHours() + GUYANA_UTC_OFFSET_HOURS) + 24) % 24;
    const oddHours = localHour >= 22 || localHour < 5;
    const highValue = grandTotal >= gateLocal * 0.5;
    const riskFlagged = accountAgeHours < RISK_NEW_ACCOUNT_HOURS && highValue && oddHours;
    const riskReason = riskFlagged
      ? `New account (${Math.floor(accountAgeHours)}h) + high value + odd hours — call to confirm`
      : null;

    // Order numbers: per-day sequence, one per vendor order
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const todayCount = await this.prisma.order.count({ where: { placedAt: { gte: today } } });

    // Inventory alerts collected inside the transaction, delivered after it
    // commits (notifications are best-effort and never roll an order back).
    const stockEventsByVendor = new Map<string, Array<{ itemId: string; name: string; remaining: number; kind: 'low' | 'out' }>>();

    if (input.beforeTransaction) await input.beforeTransaction();

    // [M-11] The two effects every order owes after it commits carry their
    // delays; computed before the transaction so the rows inside it are whole.
    const queueTiming = await checkoutQueueTiming(this.prisma);
    // Atomic: all orders, stock movements, stats, and the cart deletion commit together
    const checkoutCommit = await this.prisma.$transaction(async (tx) => {
      // Global creation lock order starts with User. Account deletion takes the
      // same row lock before counting live orders, closing the authenticate →
      // delete → insert race for every order produced by this checkout.
      await lockActiveOrderCustomer(tx, input.userId, user.tenantId);

      // Serialize concurrent checkouts of one cart: the row lock makes a rapid
      // double-submit deterministic (the loser waits, then rolls back on the
      // now-deleted cart) instead of leaning on the delete's P2025 by accident.
      await tx.$queryRaw`SELECT id FROM "carts" WHERE id = ${cart.id} FOR UPDATE`;
      // [REPORT-017B F-016-01] Lock the CHILD rows too. The parent-cart lock
      // alone did not serialize a `cartItem.delete`/quantity update — those
      // never touch the parent row — so a delete could commit AFTER the
      // signature check below and BEFORE order creation, ordering a removed
      // item. FOR UPDATE on every current child makes any concurrent
      // delete/update of them block until this checkout commits (by which
      // point the cart+items are gone), while the signature read below sees a
      // stable set. A concurrent ADD (a NEW row) is not money-dangerous — an
      // item not in the priced snapshot is simply never charged.
      await tx.$queryRaw`SELECT id FROM "cart_items" WHERE "cartId" = ${cart.id} FOR UPDATE`;
      if (input.afterCartLock) await input.afterCartLock();

      // [REPORT-013 F-013-01 / REPORT-016 F-016-01] Bind the priced snapshot
      // to the LOCKED cart AGGREGATE, not the parent timestamp. Pricing, the
      // ID gate, and promo math all ran on a pre-transaction read; any cart
      // mutation that committed since makes that math a lie about a different
      // basket. `Cart.updatedAt` was an INCOMPLETE token — deleting a
      // CartItem while others remain never touches the parent row, so a
      // removed item could still be ordered. The authoritative generation is
      // the item set (id + quantity) plus the tip; re-read it under the lock
      // and refuse on any drift.
      const cartSignature = (
        items: Array<{ id: string; quantity: number }>,
        tipAmount: Prisma.Decimal | number,
      ) =>
        JSON.stringify({
          items: items.map((i) => [i.id, i.quantity]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
          tip: Number(tipAmount),
        });
      const lockedCart = await tx.cart.findUnique({
        where: { id: cart.id },
        select: { tipAmount: true, items: { select: { id: true, quantity: true } } },
      });
      if (!lockedCart || cartSignature(lockedCart.items, lockedCart.tipAmount) !== cartSignature(cart.items, cart.tipAmount)) {
        throw new AppError(409, 'CART_CHANGED', 'Your cart just changed — review it and place the order again.');
      }

      // [REPORT-013 F-013-06] Authority is proven WHERE IT COMMITS: every
      // participating vendor row is locked (deterministic id order), then
      // lifecycle/ordering flags, subscription operability, the document
      // authority's wall-clock bound (activationValidUntil), and live item
      // availability are re-read on THIS transaction. The pre-transaction
      // checks above remain the friendly fast-fail; they authorize nothing.
      const planVendorIds = [...new Set(plans.map((p) => p.vendor.id))].sort();
      await tx.$queryRaw`SELECT id FROM "vendors" WHERE id IN (${Prisma.join(planVendorIds)}) ORDER BY id FOR UPDATE`;
      for (const planVendorId of planVendorIds) {
        const lockedVendor = await tx.vendor.findUniqueOrThrow({
          where: { id: planVendorId },
          select: { name: true, status: true, isCurrentlyOpen: true, acceptingOrders: true, activationValidUntil: true },
        });
        if (
          lockedVendor.status !== 'ACTIVE'
          || !lockedVendor.isCurrentlyOpen
          || !lockedVendor.acceptingOrders
          || (lockedVendor.activationValidUntil != null && lockedVendor.activationValidUntil <= now)
        ) {
          throw new AppError(400, 'VENDOR_CLOSED', `${lockedVendor.name} is currently not accepting orders`);
        }
        const lockedSub = await tx.subscription.findFirst({
          where: { vendorId: planVendorId },
          orderBy: { createdAt: 'desc' },
          select: { status: true, gracePeriodEnd: true },
        });
        const lockedOperability = subscriptionOperability(lockedSub, { missingRow: 'GRANDFATHER' });
        if (!lockedOperability.operable) {
          throw new AppError(400, 'VENDOR_CLOSED', `${lockedVendor.name} is currently not accepting orders`);
        }
      }
      const basketItemIds = plans.flatMap((p) => p.orderItems.map((oi) => oi.itemId));
      const darkItem = await tx.item.findFirst({
        where: { id: { in: basketItemIds }, isAvailable: false },
        select: { name: true },
      });
      if (darkItem) {
        // 409, not 400: the request was well-formed — the world changed under
        // it (a racer took the last unit and auto-hide flipped the item dark).
        // Same code+status as the pre-lock ITEM_UNAVAILABLE path, so a race
        // loser reads identically wherever the race is caught.
        throw new AppError(409, 'ITEM_UNAVAILABLE', `${darkItem.name} just became unavailable — remove it and try again.`);
      }

      let committedMmgPayUrl: string | null = null;
      let committedMmgRecipientName: string | null = null;
      if (input.paymentMethod === 'MOBILE_MONEY') {
        const paymentPlan = plans[0]!; // multi-vendor MMG was rejected above
        await tx.$queryRaw`SELECT id FROM "vendors" WHERE id = ${paymentPlan.vendor.id} FOR UPDATE`;
        const currentVendor = await tx.vendor.findUniqueOrThrow({
          where: { id: paymentPlan.vendor.id },
          select: { name: true, mmgPayUrl: true },
        });
        committedMmgPayUrl = requireCheckoutMmgPayUrl(currentVendor.mmgPayUrl, currentVendor.name);
        committedMmgRecipientName = currentVendor.name;
      }

      // Serialize promo redemption (pre-launch audit H11). validatePromoCode
      // ran BEFORE this transaction, so two concurrent checkouts of the SAME
      // code — different carts, or a global-cap code across users — could both
      // read the caps as unmet and both redeem. Lock the promo row: the loser
      // blocks here until the winner commits (incrementing currentUses and
      // creating its order), then re-reads the now-updated counts and is
      // correctly rejected. The pre-transaction check stays for the friendly
      // discount preview; THIS is the enforcement point.
      if (promoCodeId) {
        await tx.$queryRaw`SELECT id FROM "promo_codes" WHERE id = ${promoCodeId} FOR UPDATE`;
        const fresh = await tx.promoCode.findUniqueOrThrow({
          where: { id: promoCodeId },
          select: { currentUses: true, maxUses: true, maxUsesPerUser: true },
        });
        if (fresh.maxUses && fresh.currentUses >= fresh.maxUses) {
          throw new AppError(400, 'USED_PROMO', 'This promo code has reached its usage limit');
        }
        // Trial-integrity A5: per-user promo caps count the HUMAN — usage by
        // any account in the identity cluster counts (promo-farming across
        // fresh accounts dies here). Unclustered → [userId] exactly.
        const { clusterMemberIds } = await import('../integrity/identity.service');
        const promoMemberIds = await clusterMemberIds(this.prisma, input.userId);
        const userUses = await tx.order.count({
          where: { customerId: { in: promoMemberIds }, promoCodeId, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
        });
        if (userUses >= fresh.maxUsesPerUser) {
          throw new AppError(400, 'USED_PROMO', 'You have already used this promo code');
        }
      }

      const created = [];
      let sequence = todayCount;

      // A vendor promotion discounts (and records against) THAT vendor's order;
      // a platform-wide code applies to the whole basket.
      const promoPlanIndex = promoVendorId
        ? plans.findIndex((p) => p.vendor.id === promoVendorId)
        : -1;

      // "Tip your rider" is delivery money: it rides the first DELIVERY plan.
      // A pickup or appointment has no rider — a lingering cart tip must never
      // be charged there (founder screenshot 2026-07-15: haircut w/ rider tip).
      const planTipFor = (i: number) => (i === tipPlanIndex ? effectiveTip : 0);

      // Spread the discount across orders so it's never swallowed by a per-order
      // Math.max(0,…) clamp. A platform code larger than the first vendor's order
      // used to overcharge — grandTotal disagreed with the cash actually collected.
      // A vendor code hits only its plan; a platform code fills each plan up to its
      // own total until the discount is exhausted.
      const discountAlloc = new Array<number>(plans.length).fill(0);
      // [M-32] Per component, by funder: goods first, then (platform code
      // only) the delivery fee; never the tip. The parts are snapshotted on
      // the order's redemption below, so every discounted dollar names who
      // funds it.
      const discountParts = new Array<PromoAllocation | null>(plans.length).fill(null);
      let remainingDiscount = discount;
      const discountTargets = promoPlanIndex >= 0 ? [promoPlanIndex] : plans.map((_, i) => i);
      for (const i of discountTargets) {
        if (remainingDiscount <= 0) break;
        const parts = allocatePromo(promoFunder, remainingDiscount, { subtotal: plans[i]!.subtotal, deliveryFee: plans[i]!.deliveryFee }, promoTerms?.discountType ?? null);
        discountAlloc[i] = parts.total;
        discountParts[i] = parts;
        remainingDiscount -= parts.total;
      }

      for (const [index, plan] of plans.entries()) {
        sequence += 1;
        const planTip = planTipFor(index);
        const planDiscount = discountAlloc[index]!;
        // [ALG-24] The one total — the cart quote computes its total through the same function.
        const totalAmount = orderTotal({ subtotal: plan.subtotal, deliveryFee: plan.deliveryFee, tip: planTip, discount: planDiscount });
        // DELIVERY and MOBILE appointments go to the customer's address; PICKUP and
        // AT_BUSINESS appointments use the store (distanceKm>0 marks a mobile service).
        const toCustomer = plan.fulfillment === 'DELIVERY' || (plan.fulfillment === 'APPOINTMENT' && plan.distanceKm > 0);

        // [ALG-12] The customer's promise, written onto the order at creation:
        // prep p80 (ALG-03 tiers) + rider-to-store + handover + travel, padded
        // by the lateness this vertical-hour actually produced. Delivery only.
        const placedAt = new Date();
        const promise = plan.fulfillment === 'DELIVERY'
          ? await promiseAtCheckout(this.prisma, {
              tenantId: user.tenantId,
              orderType: plan.vendor.vendorType === 'SUPERMARKET' ? 'GROCERY_DELIVERY' : 'FOOD_DELIVERY',
              vendorId: plan.vendor.id, vendorType: plan.vendor.vendorType, declaredMinutes: plan.vendor.estimatedPrepTime ?? null,
              distanceKm: plan.distanceKm, itemCount: plan.orderItems.reduce((n, it) => n + it.quantity, 0), placedAt,
            })
          : null;

        const order = await tx.order.create({
          data: {
            tenantId: user.tenantId,
            orderNumber: generateOrderNumber(sequence),
            currencyCode: orderCurrency,
            orderType: plan.vendor.vendorType === 'SUPERMARKET' ? 'GROCERY_DELIVERY' : 'FOOD_DELIVERY',
            customerId: input.userId,
            vendorId: plan.vendor.id,
            status: 'PENDING',
            fulfillment: plan.fulfillment,
            appointmentSlot: plan.appointmentSlot,
            riskFlagged,
            riskReason,
            pickupAddress: `${plan.vendor.addressLine1}, ${plan.vendor.city}`,
            pickupLat: plan.vendor.latitude,
            pickupLng: plan.vendor.longitude,
            deliveryAddress: toCustomer
              ? `${address!.addressLine1}, ${address!.city}`
              : `${plan.vendor.addressLine1}, ${plan.vendor.city}`,
            deliveryLat: toCustomer ? address!.latitude : plan.vendor.latitude,
            deliveryLng: toCustomer ? address!.longitude : plan.vendor.longitude,
            deliveryInstructions: input.deliveryInstructions,
            subtotalBase: plan.subtotal,
            subtotalMarkup: 0,
            subtotalCustomer: plan.subtotal,
            deliveryFee: plan.deliveryFee,
            // [ALG-18] The distance the fee was priced from, frozen with its source.
            billableKm: plan.distanceKm > 0 ? plan.distanceKm : null,
            billableKmSource: plan.distanceKm > 0 ? plan.distanceSource : null,
            isExpress: input.express === true && plan.fulfillment === 'DELIVERY',
            // LIFECYCLE_V2: born held (hidden from the vendor, free-cancel
            // window open). Express skips the hold — the customer paid 1.5x
            // for priority; making them wait would break the product promise.
            holdExpiresAt:
              holdWindowMs() != null && !(input.express === true && plan.fulfillment === 'DELIVERY')
                ? new Date(now.getTime() + holdWindowMs()!)
                : null,
            tipAmount: planTip,
            discount: planDiscount,
            totalAmount,
            paymentMethod: input.paymentMethod as 'CASH' | 'MOBILE_MONEY' | 'BANK_TRANSFER' | 'CARD' | 'WALLET',
            // The payment instruction is part of the order contract. Snapshot
            // both fields while the vendor row is locked so a later profile
            // edit cannot redirect an already-placed order or relabel its payee.
            mmgPayUrlSnapshot: input.paymentMethod === 'MOBILE_MONEY' ? committedMmgPayUrl : null,
            mmgRecipientNameSnapshot: input.paymentMethod === 'MOBILE_MONEY' ? committedMmgRecipientName : null,
            estimatedPrepTime: plan.vendor.estimatedPrepTime,
            // Minutes-to-promise for the legacy field; the promise itself is the truth.
            estimatedDeliveryTime: promise ? Math.max(1, Math.round((promise.promisedAt.getTime() - placedAt.getTime()) / 60_000)) : null,
            placedAt,
            ...(promise ? { promisedAt: promise.promisedAt, promiseBaseSeconds: promise.baseSeconds, promisePadSeconds: promise.padSeconds } : {}),
            scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined,
            // Takeaway: a collection code the customer shows the vendor at pickup.
            // 6-digit, CSPRNG (not Math.random); handover is vendor-mediated in person.
            pickupCode: plan.fulfillment === 'PICKUP' ? String(randomInt(100000, 1000000)) : null,
            // Stamp the redemption on exactly one order (the vendor's plan, or
            // order 0 for a platform code) so per-user usage counting stays correct.
            promoCodeId: index === (promoPlanIndex >= 0 ? promoPlanIndex : 0) ? promoCodeId : null,
            items: {
              create: plan.orderItems.map((oi) => ({
                itemId: oi.itemId,
                name: oi.name,
                quantity: oi.quantity,
                basePrice: oi.basePrice,
                markedUpPrice: oi.basePrice,
                markupAmount: 0,
                totalBase: oi.totalBase,
                totalMarkup: 0,
                totalCustomer: oi.totalBase,
                specialInstructions: oi.specialInstructions,
                // [G2] SNAPSHOT, like name and every price above (ADR
                // SWIFT-AUD-D5-04): itemId is a loose reference with no FK, so
                // a vendor marking rice bulky next week must not change what
                // THIS order weighed when it was dispatched. Read by the load
                // gate shadow (#894) and by stack-eligibility's size class —
                // until this line, both saw NULL for every order ever placed.
                bulkUnits: oi.bulkUnits,
                ...(oi.options.length > 0 && {
                  selectedOptions: {
                    create: oi.options.map((o) => ({
                      optionGroupName: o.optionGroupName,
                      optionName: o.optionName,
                      basePrice: o.additionalPrice,
                      markedUpPrice: o.additionalPrice,
                      markupAmount: 0,
                    })),
                  },
                }),
              })),
            },
            statusHistory: {
              create: { status: 'PENDING', changedBy: input.userId, note: 'Order placed' },
            },
          },
          include: { items: true, vendor: { select: { id: true, name: true, ownerId: true } } },
        });

        await tx.vendor.update({
          where: { id: plan.vendor.id },
          data: { totalOrders: { increment: 1 } },
        });
        await tx.item.updateMany({
          where: { id: { in: plan.orderItems.map((oi) => oi.itemId) } },
          data: { totalOrdered: { increment: 1 } },
        });

        // Inventory (§4.2): conditional decrement — the WHERE guard makes
        // overselling impossible under concurrency; the losing checkout's
        // whole transaction rolls back. Items at zero auto-hide from browse.
        for (const oi of plan.orderItems) {
          if (!oi.tracksStock) continue;
          // [MKT-2] This is THE SALE, and until now it was the one movement
          // nobody wrote down: the counter dropped and no row explained why. It
          // now goes through the single writer, which keeps this exact guard and
          // records the movement in the same transaction — so a rolled-back
          // checkout leaves no phantom sale, and a sale can never exist without
          // the stock having actually moved.
          await applyStockMovement(tx, {
            itemId: oi.itemId,
            delta: -oi.quantity,
            reason: 'SALE',
            orderId: order.id,
            actorId: input.userId,
          });
          const after = await tx.item.findUniqueOrThrow({
            where: { id: oi.itemId },
            select: { stockQuantity: true, lowStockThreshold: true, isAvailable: true },
          });
          const remaining = after.stockQuantity ?? 0;
          if (remaining <= 0 && after.isAvailable) {
            await tx.item.update({
              where: { id: oi.itemId },
              data: { isAvailable: false, autoHiddenAt: new Date() },
            });
          }
          const events = stockEventsByVendor.get(plan.vendor.id) ?? [];
          if (remaining <= 0) {
            events.push({ itemId: oi.itemId, name: oi.name, remaining: 0, kind: 'out' });
          } else if (
            after.lowStockThreshold !== null &&
            remaining <= after.lowStockThreshold &&
            remaining + oi.quantity > after.lowStockThreshold
          ) {
            // Crossing edge only — the owner is alerted once, not on every
            // subsequent order below the threshold.
            events.push({ itemId: oi.itemId, name: oi.name, remaining, kind: 'low' });
          }
          if (events.length > 0) stockEventsByVendor.set(plan.vendor.id, events);
        }

        // [M-32] The redemption snapshot: the terms version this order was
        // priced under, the funder, and the discount per component. Written
        // on the order that carries the code (a zero-dollar redemption is
        // still a redemption) and on any other order the discount reached.
        const parts = discountParts[index];
        if (promoCodeId && promoTerms && (parts || index === (promoPlanIndex >= 0 ? promoPlanIndex : 0))) {
          await tx.promoRedemption.create({
            data: {
              orderId: order.id,
              promoCodeId,
              termsVersion: promoTerms.termsVersion,
              discountType: promoTerms.discountType,
              discountValue: promoTerms.discountValue,
              maxDiscount: promoTerms.maxDiscount,
              funder: promoTerms.funder,
              goodsDiscount: parts?.goods ?? 0,
              deliveryDiscount: parts?.delivery ?? 0,
              tipDiscount: 0,
              // [M-33] The goods discount owned line by line from this moment,
              // summing exactly to goodsDiscount — a return refunds each line's
              // own share, never a share inferred from the aggregate.
              lineAllocations: allocateAcrossLines(parts?.goods ?? 0, order.items.map((it) => ({ id: it.id, amount: Number(it.totalCustomer) })))
                .map((a) => ({ orderItemId: a.id, goods: a.share })),
              refundPolicy: REFUND_POLICY,
            },
          });
        }
        created.push(order);
      }

      if (promoCodeId) {
        await tx.promoCode.update({ where: { id: promoCodeId }, data: { currentUses: { increment: 1 } } });
      }
      await tx.customer.update({
        where: { userId: input.userId },
        data: { totalOrders: { increment: created.length }, totalSpent: { increment: grandTotal } },
      });
      await tx.cart.delete({ where: { id: cart.id } });

      const paymentAction = committedMmgPayUrl
        ? {
            kind: 'OPEN_EXTERNAL_URL' as const,
            method: 'MOBILE_MONEY' as const,
            provider: 'MMG' as const,
            fundsFlow: 'DIRECT_TO_VENDOR' as const,
            orderId: created[0]!.id,
            recipientName: committedMmgRecipientName!,
            amount: Number(created[0]!.totalAmount),
            url: committedMmgPayUrl,
          }
        : null;

      // [M-11] The command's durable tail and result commit WITH the orders:
      // the vendor alert ladder and the auto-cancel as outbox rows, and the
      // one immutable answer for this idempotency key as a receipt. A crash
      // or a queue outage after this point can delay the tail; it can no
      // longer lose it, and a same-key retry can no longer place twice.
      await persistCheckoutOutboxInTransaction(tx, { orders: created.map((o) => ({ id: o.id, tenantId: o.tenantId })), timing: queueTiming, now });
      if (input.idempotency) {
        await persistCheckoutReceiptInTransaction(tx, {
          userId: input.userId, tenantId: user.tenantId, idempotencyKey: input.idempotency.key, requestHash: input.idempotency.requestHash,
          orderIds: created.map((o) => o.id), result: { orders: created, paymentAction },
        });
      }
      await input.afterDurableTail?.();
      return { orders: created, paymentAction };
    });
    const { orders, paymentAction } = checkoutCommit;

    // Post-transaction: emit and notify per vendor (best-effort). The socket
    // event goes to that vendor's room only — a global emit would fan out to
    // every connected client and leak order metadata platform-wide.
    // A HELD order tells the vendor NOTHING here — the release worker does
    // that when the customer's cancel window closes. Low-stock alerts still
    // go out now: inventory already moved regardless of the hold.
    for (const order of orders) {
      const held = isHeld(order);
      if (!held) {
        this.io
          .to(`vendor:${order.vendorId}`)
          .emit('order:new', { orderId: order.id, vendorId: order.vendorId, orderNumber: order.orderNumber });
      }
      const vendorOwner = await this.prisma.vendorOwner.findUnique({ where: { id: order.vendor!.ownerId } });
      if (vendorOwner) {
        if (!held) {
          await this.notifications.newOrderForVendor(
            vendorOwner.userId,
            order.orderNumber,
            order.items.length,
            Number(order.totalAmount),
            order.id,
          );
        }
        if (order.vendorId) {
          for (const ev of stockEventsByVendor.get(order.vendorId) ?? []) {
            await this.notifications.lowStock(vendorOwner.userId, ev);
          }
          stockEventsByVendor.delete(order.vendorId);
        }
      }
    }

    for (const order of orders) {
      log().info({ orderId: order.id, orderNumber: order.orderNumber, vendorId: order.vendorId, orderType: order.orderType, fulfillment: order.fulfillment, total: Number(order.totalAmount), customerId: input.userId }, 'order: placed');
    }

    const summaries = orders.map((order) => ({
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      // The confirmation screen shows the free-cancel countdown off this.
      holdExpiresAt: order.holdExpiresAt,
      fulfillment: order.fulfillment,
      appointmentSlot: order.appointmentSlot,
      pickupCode: order.pickupCode,
      riskFlagged: order.riskFlagged,
      vendorName: order.vendor?.name,
      items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, price: Number(i.totalCustomer) })),
      subtotal: Number(order.subtotalCustomer),
      deliveryFee: Number(order.deliveryFee),
      isExpress: order.isExpress,
      tip: Number(order.tipAmount),
      discount: Number(order.discount),
      total: Number(order.totalAmount),
      paymentMethod: order.paymentMethod,
      estimatedPrepTime: order.estimatedPrepTime,
      estimatedDeliveryTime: order.estimatedDeliveryTime,
      promise: promiseView(order),
      deliveryAddress: order.deliveryAddress,
      placedAt: order.placedAt,
      scheduledFor: order.scheduledFor,
    }));

    return {
      // Single-vendor callers keep their shape; multi-vendor callers get all
      order: summaries[0]!,
      orders: summaries,
      grandTotal,
      paymentAction,
      message: orders.length > 1
        ? `${orders.length} orders placed — each vendor will confirm shortly.`
        : input.scheduledFor
          ? `Order scheduled! ${orders[0]!.vendor?.name} will prepare it at the right time.`
          : `Order placed! ${orders[0]!.vendor?.name} will confirm shortly.`,
    };
  }

  /**
   * Put a cancelled order's tracked stock back on the shelf. Every state an
   * order may be CANCELLED from precedes physical handover (see
   * ORDER_TRANSITIONS), so the goods never left the store. FAILED handovers
   * deliberately do NOT restock — returned food is the vendor's manual call.
   * Pure auto-hides (stock hit 0) un-hide once stock is back above zero.
   */
  /** Put tracked stock back on the shelf for a cancelled order. Public: the
   *  vendor reject route does its own status write (for reason fields) and
   *  must restock too — goods never left the store either way. */
  async restockCancelledOrder(
    orderId: string,
    db: PrismaClient | Prisma.TransactionClient = this.prisma,
  ) {
    const items = await db.orderItem.findMany({
      where: { orderId },
      select: { itemId: true, quantity: true, subStatus: true, substituteItemId: true },
    });
    for (const oi of items) {
      // [REPORT-006 F-006-05] Picking already restocked refunded/rejected
      // lines when it closed them — restocking again here doubles stock. An
      // APPROVED substitution's reserved goods are the SUBSTITUTE item (the
      // original went back on the shelf at approval), so the substitute is
      // what a cancellation must return.
      if (oi.subStatus === 'REFUNDED' || oi.subStatus === 'REJECTED') continue;
      const restockItemId = oi.subStatus === 'APPROVED' ? oi.substituteItemId : oi.itemId;
      if (!restockItemId) continue;
      // [MKT-2] Through the single writer. It no-ops on an untracked item, which
      // preserves the rule this code already had: a vendor may have stopped
      // tracking since the order was placed, and null must stay null.
      const restock = await applyStockMovement(db, {
        itemId: restockItemId,
        delta: oi.quantity,
        reason: 'CANCEL_RESTOCK',
        orderId,
        note: 'Order cancelled before pickup',
      });
      if (restock.applied) {
        await db.item.updateMany({
          where: { id: restockItemId, autoHiddenAt: { not: null }, stockQuantity: { gt: 0 } },
          data: { isAvailable: true, autoHiddenAt: null },
        });
      }
    }
  }

  /** Statuses where the goods are still in the store (nothing picked up yet), so
   *  a cancellation should put tracked stock back. After PICKED_UP the goods are
   *  with the mover and must NOT be restocked. Taxi/ride states carry no goods. */
  private static readonly PRE_PICKUP: OrderStatus[] = [
    'PENDING', 'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
    'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
  ];

  /** Whether cancelling FROM this status should restock (goods still in store). */
  static restocksOnCancel(status: OrderStatus): boolean {
    return OrderService.PRE_PICKUP.includes(status);
  }

  /**
   * Legacy cleanup used by the no-response queue after its guarded PENDING
   * cancellation. Interactive customer/vendor/admin paths use transactional
   * boundaries below. Call ONLY as the CAS winner so restock and float release
   * each run exactly once.
   */
  async applyCancellationSideEffects(
    order: { id: string; paymentMethod: string; riderId: string | null; driverId: string | null; subtotalBase: number },
    opts: { restock: boolean },
  ): Promise<void> {
    // Mirrors the cancellation cleanup rules for the legacy queue path.
    // ONE-SLOT-ONE-PERSON (scheduling spec 2.3): every order death frees its
    // appointment slot — found live: vendor reject and the no-response
    // auto-cancel left bookings CONFIRMED forever, permanently blocking the
    // provider's chair. The partial unique ignores CANCELLED rows, so the
    // slot is instantly sellable again.
    await this.prisma.booking.updateMany({
      where: { orderId: order.id, status: { not: 'CANCELLED' } },
      data: { status: 'CANCELLED' },
    });
    if (opts.restock) await this.restockCancelledOrder(order.id);
    if (order.riderId) {
      await new FloatService(this.prisma).release(this.prisma, order.riderId, riderFloatForOrder(order));
      // Through the seam, not a bare null: under stacking this rider may hold
      // another live leg, and "available" is the count against capacity.
      const riderId = order.riderId;
      await this.prisma.$transaction((tx) => settleRiderLegs(tx, riderId, { prisma: this.prisma, excludeOrderId: order.id }));
    }
    if (order.driverId) {
      await this.prisma.driver.updateMany({
        where: { id: order.driverId, currentRideId: order.id },
        data: { isAvailable: true, currentRideId: null },
      });
    }
  }

  /** Free the rider when this order owns the pointer. Legacy cancellation paths
   * may also heal a null/provably stale pointer; a real newer job is untouched. */
  private async stageRiderRelease(
    tx: Prisma.TransactionClient,
    riderId: string,
    orderId: string,
    countDelivery: boolean,
    releaseStalePointer: boolean,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "riders" WHERE id = ${riderId} FOR UPDATE`;
    const rider = await tx.rider.findUnique({ where: { id: riderId }, select: { currentOrderId: true } });
    if (!rider) return;
    let safeToFree = rider.currentOrderId === orderId
      || (releaseStalePointer && rider.currentOrderId == null);
    if (!safeToFree && releaseStalePointer && rider.currentOrderId != null) {
      const newerLiveJob = await tx.order.findFirst({
        where: {
          id: rider.currentOrderId!,
          riderId,
          status: { notIn: TERMINAL_ORDER_STATUSES },
        },
        select: { id: true },
      });
      safeToFree = newerLiveJob == null;
    }
    if (!safeToFree) return;
    // Stacking: the finished leg may not be the only one. The re-point rule
    // ("next live leg, else null; available iff legs < capacity") lives in the
    // seam so the delivery watchdog ends a leg the same way this does. This
    // order's status flipped terminal earlier in this same transaction, so the
    // count already excludes it; excludeOrderId guards the same-transaction
    // read either way.
    await settleRiderLegs(tx, riderId, { prisma: this.prisma, excludeOrderId: orderId, countDelivery });
  }

  /** Driver equivalent of stageRiderRelease (currentRideId is the authority). */
  private async stageDriverRelease(
    tx: Prisma.TransactionClient,
    driverId: string,
    orderId: string,
    countRide: boolean,
    releaseStalePointer: boolean,
    decayCancellationRate = false,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM "drivers" WHERE id = ${driverId} FOR UPDATE`;
    const driver = await tx.driver.findUnique({ where: { id: driverId }, select: { currentRideId: true } });
    if (!driver) return;
    let safeToFree = driver.currentRideId === orderId
      || (releaseStalePointer && driver.currentRideId == null);
    if (!safeToFree && releaseStalePointer && driver.currentRideId != null) {
      const newerLiveRide = await tx.order.findFirst({
        where: {
          id: driver.currentRideId!,
          driverId,
          status: { notIn: TERMINAL_ORDER_STATUSES },
        },
        select: { id: true },
      });
      safeToFree = newerLiveRide == null;
    }
    if (!safeToFree) return;
    await tx.driver.update({
      where: { id: driverId },
      data: {
        isAvailable: true,
        currentRideId: null,
        ...(countRide ? { totalRides: { increment: 1 } } : {}),
        ...(decayCancellationRate ? { cancellationRate: { multiply: 0.8 } } : {}),
      },
    });
  }

  /**
   * The canonical DB half of every order transition. This method is public only
   * so deterministic tests can inject a failure after all writes are staged and
   * prove PostgreSQL rolls the whole boundary back; callers should use
   * transitionOrderAtomically(), which owns retries and post-commit publication.
   */
  async stageCanonicalOrderTransition(
    tx: Prisma.TransactionClient,
    input: CanonicalOrderTransitionInput,
  ): Promise<CanonicalOrderTransitionResult> {
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${input.orderId} FOR UPDATE`;
    const source = await tx.order.findUnique({ where: { id: input.orderId } });
    if (!source) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    if (!input.allowedFrom.includes(source.status)) {
      throw input.invalidStatus?.(source.status)
        ?? new AppError(409, 'INVALID_TRANSITION', `Cannot move order from ${source.status} to ${input.target}`);
    }
    // [REPORT-014 F-014-02] The acting rider must own the LOCKED row — a
    // release/reassignment that committed after the route's ownership
    // pre-read loses here, not after a fabricated DELIVERED terminal.
    if (input.expectedRiderId !== undefined && source.riderId !== input.expectedRiderId) {
      throw new AppError(409, 'ACTOR_NOT_ASSIGNED',
        'This job is no longer assigned to you — it was released or reassigned.');
    }
    // [SPS-F-0016] Every canonical transition passes this seam (vendor accept/
    // prep/ready/self-deliver/pickup-complete, rider legs, /delivered), so the
    // MMG payment-first gate lives here, on the freshly locked row.
    assertMmgFulfilmentAllowed(source, input.target);
    // Defense in depth for every generic/ops caller (including the approved
    // agent, admin-refund, and courier-sender actions): neither a physical
    // delivery handoff nor a verified taxi handoff can be terminalized through
    // the canonical transition seam.  The row was locked and freshly read
    // above, so pickup/PIN/start/refund races serialize here.  A standard
    // post-terminal REFUNDED transition remains financial accounting and is
    // deliberately not treated as a fresh cancellation.
    const operationalCancellation = isCancellationTerminalization(source.status, input.target);
    if (
      operationalCancellation
      && (
        IN_TRANSIT.includes(source.status)
        || (source.orderType === 'TAXI' && hasTaxiPassengerCustody(source))
      )
    ) {
      throw input.invalidStatus?.(source.status)
        ?? (source.orderType === 'TAXI'
          ? new AppError(409, 'PASSENGER_IN_CUSTODY', 'A ride cannot be cancelled after passenger handoff. Use the safety or trip-completion flow.')
          : new AppError(409, 'ORDER_IN_CUSTODY', 'An order cannot be cancelled after pickup. Use the return-to-sender or delivery recovery flow.'));
    }
    // [REPORT-006 F-006-01] No negative terminal on captured MMG money: the
    // store already holds the customer's payment and no refund-obligation rail
    // exists yet (founder-gated), so CANCELLED/REFUNDED + CAPTURED would record
    // closed money with no owed path back. Every negative terminalizer shares
    // this locked seam (vendor reject, admin/ops cancel, no-response
    // auto-cancel) or the customer-cancel lock, and capture takes the same row
    // lock — the pair {capture, cancel} is serialized in both commit orders.
    // The store settles a cancellation of paid MMG money with the customer
    // directly; the order then completes or stays live for support.
    if (
      operationalCancellation
      && source.paymentMethod === 'MOBILE_MONEY'
      && MMG_MONEY_MOVED.has(source.paymentStatus)
    ) {
      throw new AppError(
        409,
        'MMG_CANCEL_UNAVAILABLE',
        'This order is already paid by MMG to the store. The store cancels and refunds you directly — Swift never holds the money.',
      );
    }

    const now = new Date();
    if (input.requireHoldExpired && source.holdExpiresAt && source.holdExpiresAt > now) {
      throw input.invalidStatus?.(source.status)
        ?? new AppError(409, 'INVALID_TRANSITION', 'Order is still within its checkout hold');
    }
    const data: Prisma.OrderUncheckedUpdateInput = { status: input.target };
    const timestampField: Partial<Record<OrderStatus, keyof Prisma.OrderUncheckedUpdateInput>> = {
      ACCEPTED: 'acceptedAt',
      PREPARING: 'preparingAt',
      READY_FOR_PICKUP: 'readyAt',
      PICKED_UP: 'pickedUpAt',
      DELIVERED: 'deliveredAt',
      CANCELLED: 'cancelledAt',
    };
    const timestamp = timestampField[input.target];
    if (timestamp) (data as Record<string, unknown>)[timestamp] = now;
    if (input.cancellation) {
      data.cancelledAt = now;
      data.cancelledBy = input.cancellation.by;
      data.cancellationReason = input.cancellation.reason;
      if (input.cancellation.lateFeeDue !== undefined) {
        data.lateCancelFeeDue = input.cancellation.lateFeeDue;
      }
    }
    if (input.terminalMetadata?.actualDeliveryTime !== undefined) {
      data.actualDeliveryTime = input.terminalMetadata.actualDeliveryTime;
    }
    if (input.terminalMetadata?.courierProofPhotoUrl !== undefined) {
      data.courierProofPhotoUrl = input.terminalMetadata.courierProofPhotoUrl;
    }
    await tx.order.update({ where: { id: input.orderId }, data });

    // A REFUNDED transition after CANCELLED/DELIVERED/COMPLETED is accounting
    // only. Replaying operational cleanup here could cancel historical booking
    // evidence, close a newer search, or release cash float now committed to a
    // different order owned by the same mover.
    const cancellationLike = operationalCancellation;
    let cancelledSearches = 0;
    if (cancellationLike) {
      await tx.booking.updateMany({
        where: { orderId: input.orderId, status: { not: 'CANCELLED' } },
        data: { status: 'CANCELLED' },
      });
      const searches = await tx.dispatchSearch.updateMany({
        where: { subjectId: input.orderId, status: { in: ['SEARCHING', 'EXHAUSTED'] } },
        data: { status: 'CANCELLED', resolution: 'CANCELLED' },
      });
      cancelledSearches = searches.count;
      if (OrderService.restocksOnCancel(source.status)) {
        await this.restockCancelledOrder(input.orderId, tx);
      }
    }

    const releasesMover = input.target === 'DELIVERED'
      || input.target === 'CANCELLED'
      || input.target === 'FAILED'
      || (input.target === 'REFUNDED' && operationalCancellation);
    if (releasesMover && source.riderId) {
      await new FloatService(tx).release(tx, source.riderId, riderFloatForOrder(source));
      await this.stageRiderRelease(
        tx,
        source.riderId,
        input.orderId,
        input.target === 'DELIVERED',
        input.releaseStaleMoverPointer ?? false,
      );
    }
    if (releasesMover && source.driverId) {
      await this.stageDriverRelease(
        tx,
        source.driverId,
        input.orderId,
        input.target === 'DELIVERED',
        input.releaseStaleMoverPointer ?? false,
        input.target === 'DELIVERED' && (input.decayDriverCancellationRate ?? false),
      );
    }

    // The mover's money is canonical state too. Any later failure (including
    // the immutable status log) rolls earnings and the order back together.
    const earningNotices = input.target === 'DELIVERED'
      ? await this.createEarnings(input.orderId, tx, false)
      : [];

    // [REPORT-008 F-03 tail] EVERY operational negative terminal of an
    // unattested MMG order carries the ambiguity marker centrally — vendor
    // reject, agent cancel, admin cancel, and auto-cancel share this seam, so
    // none of them can close possibly-paid external money without the
    // immutable evidence the customer-cancel path writes.
    const mmgUnattestedTerminal = operationalCancellation
      && source.paymentMethod === 'MOBILE_MONEY'
      && source.paymentStatus === 'PENDING';
    await tx.orderStatusLog.create({
      data: {
        orderId: input.orderId,
        status: input.target,
        changedBy: input.changedBy,
        note: mmgUnattestedTerminal
          ? `${input.note ?? 'Cancelled'} — MMG payment UNATTESTED at cancellation: if the customer already paid, the store refunds directly`
          : input.note,
      },
    });

    if (input.operatorAudit) {
      const changes = input.operatorAudit.changes?.(source.status);
      await tx.auditLog.create({
        data: {
          userId: input.operatorAudit.userId,
          action: input.operatorAudit.action,
          entity: input.operatorAudit.entity,
          entityId: input.operatorAudit.entityId,
          ...(changes !== undefined ? { changes } : {}),
          ipAddress: input.operatorAudit.ipAddress,
          userAgent: input.operatorAudit.userAgent,
        },
      });
    }

    if (input.withinTransaction) await input.withinTransaction(tx);

    const order = await tx.order.findUniqueOrThrow({
      where: { id: input.orderId },
      omit: HANDOVER_SECRETS_OMIT,
      include: CANONICAL_TRANSITION_INCLUDE,
    });
    // [M-29] The terminal authority's own guard, on the row as it will commit:
    // a cash ride is DELIVERED only with its fare recorded as captured.
    // Evaluated after the caller's hook, so the fare outcome (which captures
    // inside this transaction) passes and a bare completion — from any caller,
    // not only the driver route — rolls back with nothing minted.
    if (input.target === 'DELIVERED' && (order.orderType === 'TAXI' || order.orderType === 'COURIER') && order.paymentMethod === 'CASH' && order.paymentStatus !== 'CAPTURED') {
      throw new AppError(409, 'PAYMENT_NOT_CAPTURED', order.orderType === 'COURIER'
        ? 'Record the cash outcome first — a cash courier job completes when the fee is recorded as collected, refused or unpaid; a proof photo never implies money.'
        : 'Record the fare outcome first — a cash ride completes when the fare is recorded as paid, refused or unpaid.');
    }
    return { order, sourceStatus: source.status, cancelledSearches, earningNotices };
  }

  /** Serialize a transition on the canonical Order lock, then publish only
   * after commit. [REPORT-006/007-v4] Every claim entrance now acquires
   * User → Order → Rider, so the historical Rider→Order inversion is gone;
   * the P2034 retry below is retained purely as a belt against future
   * writer drift. Socket/order-status pushes remain owned by each route. */
  async transitionOrderAtomically(
    input: CanonicalOrderTransitionInput,
  ): Promise<CanonicalOrderTransitionResult> {
    let committed: CanonicalOrderTransitionResult | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        committed = await this.prisma.$transaction((tx) => this.stageCanonicalOrderTransition(tx, input));
        break;
      } catch (error) {
        const retryable = typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'P2034';
        if (!retryable || attempt === 3) throw error;
      }
    }
    if (!committed) throw new Error('Order transition transaction did not produce a result');

    if (committed.cancelledSearches > 0) {
      dispatchSearchesCounter.inc({ status: 'cancelled' }, committed.cancelledSearches);
    }
    for (const notice of committed.earningNotices) {
      await this.notifications
        .earningAvailable(notice.userId, notice.amount, notice.type)
        .catch((err) => log().warn({ err, orderId: input.orderId }, 'earning notification failed after order commit'));
    }
    return committed;
  }

  async cancelOrder(orderId: string, userId: string, reason?: string) {
    // Fast authorization/existence read. The transaction below deliberately
    // re-locks and re-reads the order: a direct rider assignment may commit
    // between these two reads, and cancellation must release THAT fresh
    // assignment rather than acting on this preview.
    const preview = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: userId },
      include: {
        vendor: { select: { name: true, ownerId: true } },
        driver: { select: { userId: true } },
      },
    });

    if (!preview) throw new AppError(404, 'NOT_FOUND', 'Order not found');

    if (
      IN_TRANSIT.includes(preview.status)
      || (
        preview.orderType === 'TAXI'
        && ORDER_TRANSITIONS.CANCELLED.includes(preview.status)
        && hasTaxiPassengerCustody(preview)
      )
    ) {
      throw new AppError(400, 'IN_TRANSIT', 'Order is already on its way and cannot be cancelled');
    }

    type CancellationOrder = NonNullable<typeof preview>;
    let committed: {
      order: CancellationOrder;
      heldNow: boolean;
      freeCancellation: boolean;
      cancellationFee: number;
      cancelledSearches: number;
    } | undefined;

    // Every claim entrance now locks User → Order → Rider [REPORT-006], the
    // same Order→Rider suffix as this path — the historical inversion is
    // gone. The retry loop stays as a belt against future writer drift: this
    // idempotent cancellation boundary must never surface a spurious 500.
    // (Historical rationale: direct CASH assignment once locked Rider before
    // Order and PostgreSQL resolved the opposing interleaving by aborting one
    // transaction.)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        committed = await this.prisma.$transaction(async (tx) => {
          await lockTaxiOrderForCustodyDecision(tx, orderId);
          const order = await tx.order.findFirst({
            where: { id: orderId, customerId: userId },
            include: {
              vendor: { select: { name: true, ownerId: true } },
              driver: { select: { userId: true } },
            },
          });
          if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
          if (
            IN_TRANSIT.includes(order.status)
            || (
              order.orderType === 'TAXI'
              && ORDER_TRANSITIONS.CANCELLED.includes(order.status)
              && hasTaxiPassengerCustody(order)
            )
          ) {
            throw new AppError(400, 'IN_TRANSIT', 'Order is already on its way and cannot be cancelled');
          }
          if (!ORDER_TRANSITIONS.CANCELLED.includes(order.status)) {
            throw new AppError(400, 'INVALID_STATUS', `This order is ${order.status} and cannot be cancelled`);
          }
          // [REPORT-006 F-006-01] Checked from the LOCKED row: a vendor
          // capture serializes on this same orders lock, so cancel-after-
          // capture refuses here and capture-after-cancel refuses in the
          // capture CAS — CANCELLED+CAPTURED can no longer be minted in
          // either commit order. PENDING MMG stays cancellable (the only
          // exit from an unpaid MMG order); if external money landed
          // unattested, the capture path's closed-order refusal directs the
          // store to refund directly.
          if (order.paymentMethod === 'MOBILE_MONEY' && MMG_MONEY_MOVED.has(order.paymentStatus)) {
            throw new AppError(
              409,
              'MMG_CANCEL_UNAVAILABLE',
              'This order is already paid by MMG to the store. The store cancels and refunds you directly — Swift never holds the money.',
            );
          }

          const now = new Date();
          // heldNow keeps ONE job: a held order was never shown to the vendor,
          // so the vendor-board socket below stays silent about it.
          const heldNow = isHeld(order, now) && !order.riderId && !order.driverId;
          // THE one policy predicate, shared with the customer preview
          // [cancel-policy.ts]: free ⟺ nothing was committed — no mover holds
          // the job, and the order is held or still in its uncommitted status
          // (PENDING; READY_FOR_PICKUP for a courier, which is born there)
          // inside the window.
          const freeCancellation = isFreeCancellation(order, now);
          const cancellationFee = freeCancellation ? 0 : LATE_CANCEL_FEE;

          // The row lock makes this update and every dependent release below one
          // canonical state transition. No stale riderId/driverId can escape.
          await tx.order.update({
            where: { id: orderId },
            data: {
              status: 'CANCELLED',
              cancelledAt: now,
              cancelledBy: userId,
              cancellationReason: reason,
              // Founder decision #5: recorded cash-only marker, never collected.
              lateCancelFeeDue: cancellationFee,
            },
          });

          await tx.booking.updateMany({
            where: { orderId, status: { not: 'CANCELLED' } },
            data: { status: 'CANCELLED' },
          });

          const searches = await tx.dispatchSearch.updateMany({
            where: { subjectId: orderId, status: { in: ['SEARCHING', 'EXHAUSTED'] } },
            data: { status: 'CANCELLED', resolution: 'CANCELLED' },
          });

          // Stock, immutable status evidence, float, and mover availability are
          // part of the same commit as CANCELLED — never compensating writes.
          await this.restockCancelledOrder(orderId, tx);
          // [REPORT-007-v4 F-02] A PENDING-MMG cancellation is AMBIGUOUS money:
          // the customer may have completed the external transfer before the
          // store attested. Record that ambiguity in the immutable evidence in
          // the SAME commit — the platform's durable acknowledgement that a
          // direct store refund may be owed (the full amount-bearing
          // obligation rail is a registered founder decision).
          const mmgUnattested = order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus === 'PENDING';
          await tx.orderStatusLog.create({
            data: {
              orderId,
              status: 'CANCELLED',
              changedBy: userId,
              note: `${reason || 'Cancelled by customer'}${mmgUnattested ? ' — MMG payment UNATTESTED at cancellation: if the customer already paid, the store refunds directly' : ''}`,
            },
          });

          if (order.riderId) {
            await new FloatService(tx).release(tx, order.riderId, riderFloatForOrder(order));
            await this.stageRiderRelease(tx, order.riderId, orderId, false, true);
          }

          if (order.driverId) {
            await this.stageDriverRelease(tx, order.driverId, orderId, false, true);
          }

          return {
            order,
            heldNow,
            freeCancellation,
            cancellationFee,
            cancelledSearches: searches.count,
          };
        });
        break;
      } catch (error) {
        const retryable = typeof error === 'object'
          && error !== null
          && 'code' in error
          && error.code === 'P2034';
        if (!retryable || attempt === 3) throw error;
      }
    }

    if (!committed) throw new Error('Cancellation transaction did not produce a result');
    const { order, heldNow, freeCancellation, cancellationFee, cancelledSearches } = committed;
    if (cancelledSearches > 0) dispatchSearchesCounter.inc({ status: 'cancelled' }, cancelledSearches);

    // The socket room only reaches a foregrounded app that subscribed to this
    // ride. A driver already en route with the app backgrounded would keep
    // driving to a pickup the rider abandoned — push them to stop. This network
    // side effect starts only after the canonical cancellation commits.
    if (order.driver?.userId) {
      await this.notifications.send({
        userId: order.driver.userId,
        type: 'ORDER_UPDATE',
        title: 'Ride cancelled',
        body: 'The passenger cancelled this ride. You can stop and go back online.',
        data: { orderId, status: 'CANCELLED' },
      });
    }

    this.io.to(`order:${orderId}`).emit('order:status_changed', { orderId, status: 'CANCELLED' });
    // A held order was never shown to the vendor — telling them about a
    // cancellation of something they never saw would only confuse the board.
    if (order.vendorId && !heldNow) {
      this.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', { orderId, status: 'CANCELLED' });
    }
    // [REPORT-007-v4 F-02 / REPORT-008 F-02] The store must LEARN a
    // possibly-paid MMG order was cancelled — it holds the only rail that can
    // make the customer whole. HELD orders are NOT exempt: the pay link went
    // live at checkout (mobile auto-opens it), so money can be in flight
    // during the exact window the vendor board hides the order — this
    // liability notice is how the otherwise-unaware store finds out.
    if (order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus === 'PENDING' && order.vendorId) {
      await publishUnattestedMmgCancellation(this.prisma, this.notifications, {
        orderId,
        orderNumber: order.orderNumber,
        vendorId: order.vendorId,
        storeBody: `Order ${order.orderNumber} was cancelled before you confirmed its MMG payment. If the customer's transfer arrived in your MMG, refund them directly.`,
      });
    }

    // [REPORT-007-v4 F-02] Never assert "no charge" on an MMG order: PENDING
    // is absence of the store's attestation, not proof the customer's external
    // transfer didn't happen. The platform cannot know, so it says what is
    // true and points at the party who holds the money.
    if (order.paymentMethod === 'MOBILE_MONEY') {
      return {
        message: 'Order cancelled. If you already sent the MMG payment, the store refunds you directly.',
        cancellationFee,
      };
    }
    return { message: freeCancellation ? 'Order cancelled — no charge' : 'Order cancelled', cancellationFee };
  }

  async updateStatus(
    orderId: string,
    status: string,
    changedBy: string,
    note?: string,
    opts?: { withinTransaction?: (tx: Prisma.TransactionClient) => Promise<void> },
  ) {
    const target = status as OrderStatus;
    const allowedFrom = ORDER_TRANSITIONS[target];
    if (!allowedFrom || allowedFrom.length === 0) {
      throw new AppError(409, 'INVALID_TRANSITION', `No order may transition into ${status}`);
    }

    // Status, timestamps, terminal mover/float release, stock, earnings, and
    // append-only evidence share one commit. Only sockets/push happen below.
    const { order } = await this.transitionOrderAtomically({
      orderId,
      target,
      allowedFrom,
      changedBy,
      note,
      ...(opts?.withinTransaction ? { withinTransaction: opts.withinTransaction } : {}),
      invalidStatus: (current) => new AppError(
        409,
        'INVALID_TRANSITION',
        `Cannot move order from ${current} to ${status}`,
      ),
    });

    log().info({ orderId, orderNumber: order.orderNumber, status, changedBy, vendorId: order.vendorId }, 'order: status changed');
    const statusEvent = { orderId, status, timestamp: new Date().toISOString() };
    this.io.to(`order:${orderId}`).emit('order:status_changed', statusEvent);
    // The vendor board listens on its own room so it sees every transition
    // live without subscribing to each order individually.
    if (order.vendorId) {
      this.io.to(`vendor:${order.vendorId}`).emit('order:status_changed', statusEvent);
    }

    // Send notifications
    const riderName = order.rider?.user?.firstName || 'Your rider';
    switch (status) {
      case 'ACCEPTED':
        // [ALG-03] Shadow: what the prep-time learner WOULD predict, written beside
        // the accept for the nightly grade. Fire-and-forget; never in the way.
        void shadowPredictAtAccept(this.prisma, orderId);
        await this.notifications.orderAccepted(order.customerId, order.orderNumber, order.vendor?.name || '', orderId);
        break;
      case 'PREPARING':
        await this.notifications.orderPreparing(order.customerId, order.orderNumber, order.vendor?.name || '', orderId);
        break;
      case 'READY_FOR_PICKUP':
        await this.notifications.orderReady(order.customerId, order.orderNumber, orderId);
        break;
      case 'RIDER_ASSIGNED':
        await this.notifications.riderAssigned(order.customerId, order.orderNumber, riderName, orderId);
        break;
      case 'PICKED_UP': {
        const eta = order.estimatedDeliveryTime ? Math.max(5, order.estimatedDeliveryTime - (order.estimatedPrepTime || 30)) : 15;
        await this.notifications.orderPickedUp(order.customerId, order.orderNumber, riderName, orderId, eta);
        break;
      }
      case 'DELIVERED':
        await this.notifications.orderDelivered(order.customerId, order.orderNumber, orderId);
        break;
    }

    // L3 — earned trust (master plan §5): completed history may promote the
    // customer. Cheap no-op unless they're L2 with a clean record; best-effort.
    if (status === 'DELIVERED' || status === 'COMPLETED') {
      const account = await this.prisma.user.findUnique({
        where: { id: order.customerId },
        select: { countryCode: true },
      });
      if (account) {
        await new CashRulesService(this.prisma, this.notifications, this)
          .maybePromoteToL3(order.customerId, account.countryCode)
          .catch(() => undefined);
      }
    }

    return order;
  }

  /**
   * LIFECYCLE_V2 release tick (BullMQ repeatable, every 30s): every held order
   * whose window closed becomes visible + dispatchable. The updateMany guard
   * is the race protection — a customer cancel that landed a millisecond
   * earlier flips the status, the CAS matches nothing, and we skip. Clearing
   * holdExpiresAt IS the release; a crash after the CAS is recovered by the
   * vendor board (order now visible) and the dispatch reconcile job.
   *
   * Courier orders (born READY_FOR_PICKUP, no vendor) start their offer
   * cascade here instead of at creation.
   */
  async releaseDueHeldOrders(enqueueDispatch: (orderId: string) => Promise<void>, batch = 100) {
    const due = await this.prisma.order.findMany({
      where: { status: { in: ['PENDING', 'READY_FOR_PICKUP'] }, holdExpiresAt: { lte: new Date() } },
      select: { id: true },
      take: batch,
    });

    const released: string[] = [];
    for (const { id } of due) {
      const res = await this.prisma.order.updateMany({
        where: { id, status: { in: ['PENDING', 'READY_FOR_PICKUP'] }, holdExpiresAt: { lte: new Date() } },
        data: { holdExpiresAt: null, releasedToVendorAt: new Date() },
      });
      if (res.count === 0) continue; // cancelled or raced — idempotent skip

      released.push(id);
      const order = await this.prisma.order.findUnique({
        where: { id },
        include: {
          items: { select: { id: true } },
          vendor: { select: { id: true, name: true, ownerId: true } },
        },
      });
      if (!order) continue;

      // No vendor to notify on a courier job — release = start the cascade.
      if (order.orderType === 'COURIER') {
        try {
          await enqueueDispatch(id);
        } catch (err) {
          log().error({ err, orderId: id }, 'hold-release: courier dispatch enqueue failed — reconcile will recover');
        }
        continue;
      }

      if (order.vendorId && order.vendor) {
        this.io
          .to(`vendor:${order.vendorId}`)
          .emit('order:new', { orderId: order.id, vendorId: order.vendorId, orderNumber: order.orderNumber });
        try {
          const vendorOwner = await this.prisma.vendorOwner.findUnique({ where: { id: order.vendor.ownerId } });
          if (vendorOwner) {
            await this.notifications.newOrderForVendor(
              vendorOwner.userId,
              order.orderNumber,
              order.items.length,
              Number(order.totalAmount),
              order.id,
            );
          }
        } catch (err) {
          log().error({ err, orderId: id }, 'hold-release: vendor notification failed — board still shows the order');
        }
      }
    }

    return { released };
  }

  async createEarnings(
    orderId: string,
    db: PrismaClient | Prisma.TransactionClient = this.prisma,
    notify = true,
  ): Promise<EarningNotice[]> {
    const order = await db.order.findUnique({
      where: { id: orderId },
      select: {
        riderId: true, driverId: true, deliveryFee: true, tipAmount: true,
        orderType: true, taxiFareTotal: true, paymentMethod: true,
        paymentStatus: true, vendorId: true,
      },
    });
    if (!order) return [];
    // [SPS-F-0016 / REPORT-004 F-004-03] Earnings are downstream of money
    // actually confirmed. An unpaid MMG order must never mint AVAILABLE
    // earnings or a vendor debt — not from a route, and not from the scheduled
    // reconciler sweeping legacy DELIVERED rows.
    assertMmgFulfilmentAllowed(order, 'DELIVERED');
    // [M-29] A cash fare is earned when the money is recorded, never on the
    // completion tap. The driver's fare outcome captures the payment inside
    // the DELIVERED transaction and mints from there; without the capture this
    // writer mints nothing — from the seam, the reconciler, or anyone else.
    if ((order.orderType === 'TAXI' || order.orderType === 'COURIER') && order.paymentMethod === 'CASH' && order.paymentStatus !== 'CAPTURED') return []; // [M-28] a courier's fee too: proof never implies money

    // MMG direct-pay: the customer paid the STORE (not the rider), and the
    // order total the store received INCLUDES the rider's tip — so the store
    // owes the rider the delivery fee PLUS the tip in cash [SPS-F-0016b].
    // A zero-fee promo with a tip still owes the tip. Record the debt for the
    // dual-confirm ledger (idempotent — orderId is unique). Swift moves no money.
    const settlementDue = Number(order.deliveryFee) + Number(order.tipAmount);
    if (order.paymentMethod === 'MOBILE_MONEY' && order.riderId && order.vendorId && settlementDue > 0) {
      await db.deliveryCashSettlement.upsert({
        where: { orderId },
        create: { orderId, riderId: order.riderId, vendorId: order.vendorId, amount: settlementDue },
        update: {},
      });
    }

    const earnings: Array<{
      riderId?: string;
      driverId?: string;
      orderId: string;
      type: 'DELIVERY_FEE' | 'COURIER_FEE' | 'TAXI_FARE' | 'TIP';
      amount: number;
      status: 'AVAILABLE';
    }> = [];

    if (order.riderId) {
      const feeType = order.orderType === 'COURIER' ? 'COURIER_FEE' : 'DELIVERY_FEE';
      earnings.push({
        riderId: order.riderId,
        orderId,
        type: feeType,
        amount: Number(order.deliveryFee),
        status: 'AVAILABLE',
      });

      if (Number(order.tipAmount) > 0) {
        earnings.push({
          riderId: order.riderId,
          orderId,
          type: 'TIP',
          amount: Number(order.tipAmount),
          status: 'AVAILABLE',
        });
      }
    }

    if (order.driverId) {
      earnings.push({
        driverId: order.driverId,
        orderId,
        type: 'TAXI_FARE',
        // Zero-commission model: the driver keeps the whole fare. A taxi
        // order's money lives in taxiFareTotal — deliveryFee is 0 for rides,
        // which silently paid drivers $0 before this read the right field.
        amount: Number(order.taxiFareTotal ?? order.deliveryFee),
        status: 'AVAILABLE',
      });

      if (Number(order.tipAmount) > 0) {
        earnings.push({
          driverId: order.driverId,
          orderId,
          type: 'TIP',
          amount: Number(order.tipAmount),
          status: 'AVAILABLE',
        });
      }
    }

    const notices: EarningNotice[] = [];
    if (earnings.length > 0) {
      // [M-10] The exact set difference, keyed by (order, type, beneficiary):
      // only the tuples that do not exist are inserted, and only the rows the
      // database actually inserted produce notices. Before, one missing row
      // among several expected made `created.count > 0`, and notices were
      // then built for EVERY expected row — a duplicate "you earned" for money
      // that had already been announced.
      const existing = await db.earning.findMany({
        where: { orderId },
        select: { type: true, riderId: true, driverId: true },
      });
      for (const row of existing) {
        const expected = earnings.find((e) => e.type === row.type);
        if (expected && ((expected.riderId ?? null) !== (row.riderId ?? null) || (expected.driverId ?? null) !== (row.driverId ?? null))) {
          // A row for this (order, type) exists but belongs to a different
          // mover than the order names: the current mover is unpaid and the
          // unique key keeps us from paying twice. A person must look.
          log().error({ orderId, type: row.type, rowRiderId: row.riderId, rowDriverId: row.driverId, expectedRiderId: expected.riderId ?? null, expectedDriverId: expected.driverId ?? null }, '[M-10] earning beneficiary mismatch — the order names a different mover than its earning row');
        }
      }
      const have = new Set(existing.map((row) => row.type));
      const missing = earnings.filter((e) => !have.has(e.type));
      if (missing.length === 0) return [];
      const inserted = await db.earning.createManyAndReturn({
        data: missing,
        skipDuplicates: true,
        select: { type: true, amount: true, riderId: true, driverId: true },
      });
      for (const earning of inserted) {
        // The database returns only rows it inserted from `missing`, so the
        // expected tuple names the notice type without a cast.
        const expected = missing.find((e) => e.type === earning.type);
        const moverId = earning.riderId || earning.driverId;
        if (expected && moverId) {
          const entity = earning.riderId
            ? await db.rider.findUnique({ where: { id: moverId }, select: { userId: true } })
            : await db.driver.findUnique({ where: { id: moverId }, select: { userId: true } });
          if (entity) {
            notices.push({ userId: entity.userId, amount: Number(earning.amount), type: expected.type });
          }
        }
      }
    }
    if (notify) {
      for (const notice of notices) {
        await this.notifications.earningAvailable(notice.userId, notice.amount, notice.type);
      }
    }
    return notices;
  }

  /** [SPS-F-0016c / LB-015] Post-delivery tipping FAILS CLOSED. No rail
   *  COLLECTS a tip after the job: a cash customer has already left, and an
   *  MMG customer paid the store directly at checkout. The previous behaviour
   *  minted an AVAILABLE TIP earning (and grew the order total) from money
   *  nobody collected — a debt with no sponsor. The route stays mounted
   *  (shipped apps still call it) but refuses until a real collection/
   *  authorization/capture path exists — founder-gated. Ownership is checked
   *  FIRST so a stranger still sees 404, never this 409. Tips chosen at
   *  checkout are collected with the order total and are untouched
   *  (createEarnings + the MMG settlement ledger). */
  async addPostDeliveryTip(orderId: string, userId: string, amount: number) {
    if (amount <= 0 || amount > 50_000) throw new AppError(400, 'INVALID_TIP', 'Enter a tip between 1 and 50,000.');
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: userId },
      select: { id: true },
    });
    if (!order) throw new AppError(404, 'NOT_FOUND', 'Order not found');
    throw new AppError(
      409,
      'TIP_COLLECTION_UNAVAILABLE',
      'Tips after delivery aren’t available yet — tips added at checkout still go to your mover in full.',
    );
  }

  async reorder(userId: string, orderId: string) {
    const original = await this.prisma.order.findFirst({
      where: { id: orderId, customerId: userId },
      include: { items: true },
    });

    if (!original || !original.vendorId) {
      throw new AppError(404, 'NOT_FOUND', 'Order not found');
    }

    const vendor = await this.prisma.vendor.findUnique({ where: { id: original.vendorId } });
    if (!vendor || vendor.status !== 'ACTIVE') {
      throw new AppError(400, 'VENDOR_UNAVAILABLE', 'This restaurant is no longer available');
    }

    // Clear existing cart and create new one
    await this.prisma.cart.deleteMany({ where: { customerId: userId } });

    const cart = await this.prisma.cart.create({
      data: { customerId: userId, vendorId: original.vendorId },
    });

    // Add items to cart, checking availability
    const availableItems = await this.prisma.item.findMany({
      where: { id: { in: original.items.map((i) => i.itemId) }, isAvailable: true },
    });
    const availableIds = new Set(availableItems.map((i) => i.id));

    const cartItems = original.items
      .filter((i) => availableIds.has(i.itemId))
      .map((i) => ({
        cartId: cart.id,
        itemId: i.itemId,
        quantity: i.quantity,
        selectedOptions: {},
        specialInstructions: i.specialInstructions,
      }));

    if (cartItems.length === 0) {
      throw new AppError(400, 'NO_ITEMS', 'None of the items from this order are currently available');
    }

    await this.prisma.cartItem.createMany({ data: cartItems });

    const unavailableCount = original.items.length - cartItems.length;
    return {
      cartId: cart.id,
      itemsAdded: cartItems.length,
      unavailableItems: unavailableCount,
      message: unavailableCount > 0
        ? `${cartItems.length} items added to cart. ${unavailableCount} item(s) were unavailable.`
        : `${cartItems.length} items added to cart. Ready to checkout!`,
    };
  }

  /**
   * Validate a code against the checkout's per-vendor plans. Platform-wide
   * codes (vendorId null) discount the whole basket; a VENDOR's code
   * (master plan §4.2) is valid only when that vendor is in the cart and
   * discounts only their subtotal.
   */
  private async validatePromoCode(
    code: string,
    userId: string,
    plans: Array<{ vendorId: string; subtotal: number; deliveryFee: number }>,
  ) {
    const promo = await this.prisma.promoCode.findUnique({ where: { code: code.toUpperCase() } });
    if (!promo) throw new AppError(404, 'INVALID_PROMO', 'Promo code not found');
    if (!promo.isActive) throw new AppError(400, 'INVALID_PROMO', 'This promo code is no longer active');

    const now = new Date();
    if (now < promo.validFrom || now > promo.validUntil) {
      throw new AppError(400, 'EXPIRED_PROMO', 'This promo code has expired');
    }

    if (promo.maxUses && promo.currentUses >= promo.maxUses) {
      throw new AppError(400, 'USED_PROMO', 'This promo code has reached its usage limit');
    }

    // Check per-user usage — per HUMAN (identity cluster), matching the
    // enforcement point inside the checkout transaction (trial-integrity A5).
    const { clusterMemberIds } = await import('../integrity/identity.service');
    const promoMemberIds = await clusterMemberIds(this.prisma, userId);
    const userUsage = await this.prisma.order.count({
      where: { customerId: { in: promoMemberIds }, promoCodeId: promo.id, status: { notIn: ['CANCELLED', 'REFUNDED'] } },
    });
    if (userUsage >= promo.maxUsesPerUser) {
      throw new AppError(400, 'USED_PROMO', 'You have already used this promo code');
    }

    // The discount basis: the promo vendor's plan, or the whole basket.
    let subtotal: number;
    let deliveryFeeBasis: number;
    if (promo.vendorId) {
      const plan = plans.find((p) => p.vendorId === promo.vendorId);
      if (!plan) {
        throw new AppError(400, 'PROMO_WRONG_VENDOR', 'This code belongs to a different store — add their items to use it');
      }
      subtotal = plan.subtotal;
      deliveryFeeBasis = plan.deliveryFee;
    } else {
      subtotal = plans.reduce((s, p) => s + p.subtotal, 0);
      deliveryFeeBasis = plans.reduce((s, p) => s + p.deliveryFee, 0);
    }

    if (promo.minOrderAmount && subtotal < Number(promo.minOrderAmount)) {
      throw new AppError(400, 'MIN_ORDER_PROMO', `Minimum order of $${Number(promo.minOrderAmount).toLocaleString()} GYD required for this promo`);
    }

    // [ALG-24] The one promo switch — the cart quote applies the same function.
    const discount = promoDiscount(promo, { subtotal, deliveryFee: deliveryFeeBasis });

    return {
      id: promo.id,
      discount,
      discountType: promo.discountType,
      vendorId: promo.vendorId,
      // [M-32] What the order will be priced under — snapshotted at redemption.
      terms: { termsVersion: promo.termsVersion, discountType: promo.discountType, discountValue: promo.discountValue, maxDiscount: promo.maxDiscount, funder: promo.funder },
    };
  }
}

/** [M-33] The refund policy an order is placed under (recorded on its
 *  redemption): the delivery component is never refunded as goods, a
 *  discounted fee was never paid, and line shares come from lineAllocations. */
const REFUND_POLICY = 'ALG-25/M-33';

/** [M-32] The promo terms an order is priced under, as they stood at redemption. */
type RedeemedPromoTerms = {
  termsVersion: number;
  discountType: DiscountType;
  discountValue: Prisma.Decimal;
  maxDiscount: Prisma.Decimal | null;
  funder: PromoFunder;
};

// ---------------------------------------------------------------------------
// [F-0028 / G-002] The earnings reconciler — the last line of defence between
// a bug and a mover who quietly went unpaid.
//
// Earnings now have a single owner (updateStatus pays on the DELIVERED
// transition), which closes the window that lost them. This exists because the
// window can never be closed to zero: the status CAS and the earnings insert
// are still two statements, and paths that bypass updateStatus entirely — the
// courier proof route runs its own CAS — could always grow a new gap.
//
// A mover is the only person who would ever notice this, and they would notice
// it as "Swift shorted me", which is the single worst thing a mover can believe
// about a platform they front cash for. So: sweep, heal, and page if it ever
// fires, because a non-zero count means something upstream broke.
// ---------------------------------------------------------------------------

/**
 * Find DELIVERED/COMPLETED orders that have a mover but no Earning row, and
 * create the missing rows. Healing is idempotent (@@unique([orderId, type]) +
 * skipDuplicates), so a double run changes nothing the second time.
 *
 * The grace window matters: an order delivered seconds ago may legitimately be
 * mid-flight between its transition and its earnings insert. Only orders past
 * the window are treated as missing.
 */
export async function reconcileMissingEarnings(
  prisma: PrismaClient,
  orders: OrderService,
  opts: { graceMinutes?: number; cap?: number; dryRun?: boolean } = {},
): Promise<{ scanned: number; healed: string[]; dryRun: boolean; oldestGapMinutes: number; taxiUnpaidDelivered: { total: number; sinceEnforced: number }; courierUnpaidDelivered: { total: number; sinceEnforced: number } }> {
  const graceMinutes = opts.graceMinutes ?? Number(process.env['EARNINGS_RECONCILE_GRACE_MIN'] ?? 10);
  const cap = opts.cap ?? 200;
  // [M-10 · operations] Rollback pauses the WRITES, never the report: in a dry
  // run the sweep still finds and publishes every discrepancy, and heals none.
  const dryRun = opts.dryRun ?? process.env['EARNINGS_RECONCILE_DRY_RUN'] === '1';
  const cutoff = new Date(Date.now() - graceMinutes * 60_000);

  // [M-10] The candidates are the orders whose EXPECTED tuples are not all
  // present — the fee/fare row for the mover, plus the tip row when a tip was
  // paid — never "orders with no earning at all". The old sweep excluded any
  // order that had any earning, so a fee row with a missing tip row was never
  // healed; and because complete orders are excluded here, a page of paid
  // history can no longer occupy the sweep forever.
  const candidates = await prisma.$queryRaw<Array<{ id: string; deliveredAt: Date }>>(Prisma.sql`
    SELECT o."id", o."deliveredAt"
    FROM "orders" o
    WHERE o."status" IN ('DELIVERED', 'COMPLETED')
      AND o."deliveredAt" <= ${cutoff}
      AND (o."riderId" IS NOT NULL OR o."driverId" IS NOT NULL)
      AND (o."paymentMethod" <> 'MOBILE_MONEY' OR o."orderType" = 'TAXI' OR o."paymentStatus" IN ('CAPTURED', 'CLAIMED'))
      AND NOT (o."orderType" IN ('TAXI', 'COURIER') AND o."paymentMethod" = 'CASH' AND o."paymentStatus" <> 'CAPTURED')
      AND (
        NOT EXISTS (SELECT 1 FROM "earnings" e WHERE e."orderId" = o."id" AND e."type" IN ('DELIVERY_FEE', 'COURIER_FEE', 'TAXI_FARE'))
        OR (o."tipAmount" > 0 AND NOT EXISTS (SELECT 1 FROM "earnings" e WHERE e."orderId" = o."id" AND e."type" = 'TIP'))
      )
    ORDER BY o."deliveredAt" ASC
    LIMIT ${cap}
  `);
  // [M-29 · operations] The manual-review set: cash rides delivered with no
  // captured fare. Never healed here — a fare is earned when the money is
  // recorded — only reported. Rows delivered before the fare outcome was
  // enforced are legacy; one delivered after it means a completion bypassed
  // the terminal authority, and the queue pages on it.
  const [taxiUnpaid] = await prisma.$queryRaw<Array<{ total: bigint; since_enforced: bigint }>>(Prisma.sql`
    SELECT count(*)::bigint AS total,
           count(*) FILTER (WHERE o."deliveredAt" >= ${TAXI_FARE_OUTCOME_ENFORCED_AT})::bigint AS since_enforced
    FROM "orders" o
    WHERE o."status" IN ('DELIVERED', 'COMPLETED')
      AND o."orderType" = 'TAXI' AND o."paymentMethod" = 'CASH' AND o."paymentStatus" <> 'CAPTURED'
  `);
  const taxiUnpaidDelivered = { total: Number(taxiUnpaid?.total ?? 0), sinceEnforced: Number(taxiUnpaid?.since_enforced ?? 0) };
  taxiDeliveredUnpaidGauge.labels('total').set(taxiUnpaidDelivered.total);
  taxiDeliveredUnpaidGauge.labels('since_enforced').set(taxiUnpaidDelivered.sinceEnforced);
  if (taxiUnpaidDelivered.sinceEnforced > 0) {
    log().error(taxiUnpaidDelivered, '[M-29] cash rides delivered with no captured fare after the fare outcome was enforced — a completion path bypassed the terminal authority');
  }
  // [M-28] The same census for cash courier jobs: delivered with no collected fee.
  const [courierUnpaid] = await prisma.$queryRaw<Array<{ total: bigint; since_enforced: bigint }>>(Prisma.sql`
    SELECT count(*)::bigint AS total,
           count(*) FILTER (WHERE o."deliveredAt" >= ${COURIER_CASH_OUTCOME_ENFORCED_AT})::bigint AS since_enforced
    FROM "orders" o
    WHERE o."status" IN ('DELIVERED', 'COMPLETED')
      AND o."orderType" = 'COURIER' AND o."paymentMethod" = 'CASH' AND o."paymentStatus" <> 'CAPTURED'
  `);
  const courierUnpaidDelivered = { total: Number(courierUnpaid?.total ?? 0), sinceEnforced: Number(courierUnpaid?.since_enforced ?? 0) };
  courierDeliveredUnpaidGauge.labels('total').set(courierUnpaidDelivered.total);
  courierDeliveredUnpaidGauge.labels('since_enforced').set(courierUnpaidDelivered.sinceEnforced);
  if (courierUnpaidDelivered.sinceEnforced > 0) {
    log().error(courierUnpaidDelivered, '[M-28] cash courier jobs delivered with no collected fee after the cash outcome was enforced — a completion path bypassed the terminal authority');
  }
  // The sweep walks delivered-ascending, so the first row is the oldest gap.
  const oldest = candidates[0];
  const oldestGapMinutes = oldest ? Math.max(0, Math.round((Date.now() - oldest.deliveredAt.getTime()) / 60_000)) : 0;
  earningsMissingTuplesGauge.labels('found').set(candidates.length);
  earningsMissingTuplesGauge.labels('oldest_gap_minutes').set(oldestGapMinutes);
  if (candidates.length === 0) {
    earningsMissingTuplesGauge.labels('unhealed').set(0);
    return { scanned: 0, healed: [], dryRun, oldestGapMinutes: 0, taxiUnpaidDelivered, courierUnpaidDelivered };
  }
  if (dryRun) {
    earningsMissingTuplesGauge.labels('unhealed').set(candidates.length);
    log().warn({ orderIds: candidates.map((c) => c.id), count: candidates.length, oldestGapMinutes }, '[M-10] earnings reconcile is in DRY RUN — discrepancies found, nothing written');
    return { scanned: candidates.length, healed: [], dryRun, oldestGapMinutes, taxiUnpaidDelivered, courierUnpaidDelivered };
  }
  const healed: string[] = [];
  for (const { id: orderId } of candidates) {
    try {
      // Inserts exactly the tuples that are missing and notifies only those.
      const inserted = await orders.createEarnings(orderId);
      if (inserted.length > 0) healed.push(orderId);
      for (const notice of inserted) earningsRepairsCounter.labels(notice.type).inc();
    } catch (err) {
      // One bad row must not stop the sweep — the next tick retries it, and the
      // count below still reports it as unhealed.
      log().error({ err, orderId }, 'earnings reconcile: could not heal order');
    }
  }
  earningsMissingTuplesGauge.labels('unhealed').set(candidates.length - healed.length);
  return { scanned: candidates.length, healed, dryRun, oldestGapMinutes, taxiUnpaidDelivered, courierUnpaidDelivered };
}
