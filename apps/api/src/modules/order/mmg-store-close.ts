import type { Order, Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { ORDER_TRANSITIONS } from './order-status';
import { mmgRefundPolicy, mmgRefundRemainder, openMmgRefundObligation } from './mmg-refund-law';
import type { OrderService } from './order.service';

// ---------------------------------------------------------------------------
// [MMGCLOSE · owner 8 Oct ~22:45] "Money doesn't go through me."
//
// Customers pay cash, or pay the STORE directly through the store's own MMG
// link. Once the store says the MMG payment arrived (paymentStatus CLAIMED),
// nothing in Swift can cancel the order — every cancel path refuses paid MMG
// money (MMG_CANCEL_UNAVAILABLE) and refund-settled refuses MMG
// (MMG_REFUND_RAIL_REQUIRED) — so an order the store cannot fulfil stayed open
// for ever.
//
// Swift support may now CLOSE such an order as "refund handled by the store".
// It is a record, not a payment:
//   * two admins (the C4 approval gate), a stated reason, bound to the order and
//     to the claim revision the admin reviewed;
//   * the order becomes CANCELLED through the canonical transition seam (search,
//     stock and mover cleanup in the same commit), with the refund rail's
//     CANCELLATION obligation, OWED, for what the store attested it received —
//     the store owes the customer that refund, from its own MMG;
//   * no money moves anywhere: no send, no credit, no earning, no fee; the
//     payment status, the total and every cash-refund column stay as they were;
//   * the customer and the store are told in plain words who refunds.
// Only CLAIMED: a provider-CAPTURED payment stays refused, and so does an
// order whose two payment claims are in dispute (that is the payment-claim
// decision, first).
// ---------------------------------------------------------------------------

export const MMG_STORE_CLOSE_DISPOSITION = 'REFUND_HANDLED_BY_STORE' as const;

type CloseFacts = Pick<Order, 'status' | 'paymentMethod' | 'paymentStatus' | 'mmgClaimMismatchAt' | 'mmgAttestedAmount' | 'vendorId'>;

/** Why this order cannot be closed this way, or null when it can. The order
 *  screen and the locked write read the same rule. */
export function mmgStoreCloseRefusal(order: CloseFacts): { code: string; message: string } | null {
  if (order.paymentMethod !== 'MOBILE_MONEY' || order.paymentStatus !== 'CLAIMED' || !order.vendorId) {
    return {
      code: 'MMG_STORE_CLOSE_NOT_ELIGIBLE',
      message: 'Only an order the store has marked as paid by MMG can be closed as "refund handled by the store".',
    };
  }
  if (!ORDER_TRANSITIONS.CANCELLED.includes(order.status)) {
    return {
      code: 'MMG_STORE_CLOSE_NOT_ELIGIBLE',
      message: `This order is ${order.status} and cannot be closed this way: a finished order, or goods already with a mover, follow their own flow.`,
    };
  }
  if (order.mmgClaimMismatchAt != null) {
    return {
      code: 'MMG_CLAIM_DISPUTED',
      message: 'The customer and the store disagree about this payment. Decide the payment dispute first.',
    };
  }
  if (order.mmgAttestedAmount == null) {
    return {
      code: 'MMG_PAYMENT_NOT_ATTESTED',
      message: 'The store never recorded the amount it received, so there is no refund to record.',
    };
  }
  return null;
}

export interface MmgStoreCloseInput {
  orderId: string;
  adminUserId: string;
  /** The claim revision the admin reviewed; a different one on the locked row is refused. */
  expectedClaimRevision: number;
  reason: string;
  /** The admin audit row, written inside the same transaction. */
  audit: (tx: Prisma.TransactionClient, facts: { disposition: typeof MMG_STORE_CLOSE_DISPOSITION; claimRevision: number; obligationId: string }) => Promise<void>;
}

/**
 * Close a store-claimed MMG order as "refund handled by the store". One
 * transaction: the canonical CANCELLED transition on the locked row, the
 * eligibility and the claim revision re-read there, the OWED CANCELLATION
 * obligation and the admin audit row. A refusal anywhere rolls all of it back.
 */
export async function closeMmgOrderAsStoreRefund(orderService: Pick<OrderService, 'transitionOrderAtomically'>, input: MmgStoreCloseInput) {
  let obligationId = '';
  const committed = await orderService.transitionOrderAtomically({
    orderId: input.orderId,
    target: 'CANCELLED',
    allowedFrom: ORDER_TRANSITIONS.CANCELLED,
    changedBy: input.adminUserId,
    note: 'Closed by Swift support: the store cannot fulfil this order and refunds the customer directly from its own MMG. Record only — Swift moved no money.',
    cancellation: { by: input.adminUserId, reason: input.reason },
    releaseStaleMoverPointer: true,
    paidMmgStoreRefundClosure: true,
    invalidStatus: (current) => new AppError(409, 'MMG_STORE_CLOSE_NOT_ELIGIBLE', `This order is ${current} and cannot be closed as "refund handled by the store".`),
    withinTransaction: async (tx, locked) => {
      const refusal = mmgStoreCloseRefusal(locked);
      if (refusal) throw new AppError(409, refusal.code, refusal.message);
      if (locked.mmgClaimRevision !== input.expectedClaimRevision) {
        throw new AppError(409, 'MMG_CLAIM_STALE', 'The payment claims on this order changed since you reviewed it. Refresh and review it again.', {
          expectedClaimRevision: input.expectedClaimRevision, currentClaimRevision: locked.mmgClaimRevision,
        });
      }
      // What the store attested it received, less anything already owed back
      // on this order (a removed line, a cheaper substitute).
      const held = await tx.mmgRefundObligation.findMany({ where: { orderId: input.orderId }, select: { status: true, amount: true } });
      const amount = mmgRefundRemainder(locked.mmgAttestedAmount, held);
      if (!amount.gt(0)) {
        throw new AppError(409, 'MMG_REFUND_NOTHING_LEFT', 'Everything the customer paid by MMG is already owed back on this order, so there is nothing left to record.');
      }
      const obligation = await tx.mmgRefundObligation.create({
        data: openMmgRefundObligation({
          kind: 'CANCELLATION',
          tenantId: locked.tenantId,
          orderId: input.orderId,
          vendorId: locked.vendorId as string, // checked by mmgStoreCloseRefusal
          customerId: locked.customerId,
          amount,
          currencyCode: 'GYD',
          basis: 'ATTESTED_REMAINDER',
          reason: input.reason,
          createdById: input.adminUserId,
        }, await mmgRefundPolicy(tx), new Date()),
        select: { id: true },
      });
      obligationId = obligation.id;
      await input.audit(tx, { disposition: MMG_STORE_CLOSE_DISPOSITION, claimRevision: locked.mmgClaimRevision, obligationId });
    },
  });
  return { order: committed.order, obligationId };
}

/** The plain-words notices, one per party. Swift is never the one who refunds. */
export function mmgStoreCloseNotices(orderNumber: string) {
  return {
    customer: {
      title: 'Order closed — the store refunds you',
      body: `Order ${orderNumber} could not be completed, so Swift support closed it. You paid the store by MMG, so the store refunds you directly from its MMG account. Swift never holds your money. If the refund does not arrive, contact support from the order screen.`,
    },
    store: {
      title: 'Order closed — refund the customer',
      body: `Order ${orderNumber} could not be fulfilled, so Swift support closed it. The customer paid your store by MMG: refund them directly from your MMG account. Swift never holds or moves order money.`,
    },
  };
}
