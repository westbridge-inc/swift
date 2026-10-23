import { handoverBlockCounter } from '../../plugins/observability';
import type { Order, Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { handoverAttemptState, handoverCodeMatches } from './handover-security';
import { handoverAuthorityFor, handoverVersionMatches, HANDOVER_REFUSALS } from '../order/handover-authority';

export interface HandoverDecision {
  purpose: 'pickup' | 'delivery' | 'cash-delivery';
  code?: string;
  vendorUserId?: string;
  expectedVendorId?: string;
  handoverVersion?: string;
  /** [O-2 · owner 22 Oct 2026] Takeaway only: the store has the pickup code OFF (the default), so a
   *  handover with NO code needs no proof (the store checked the customer's first name + order
   *  number). A code that IS sent (store builds 9/11/12) is still verified exactly as before. */
  codeWaived?: boolean;
}
export interface HandoverFailure {
  handoverFailure: { statusCode: number; code: string; message: string };
}

/** Run with the canonical Order lock held. Membership locks retain the
 * vendor grant until the terminal write commits; route previews cannot grant it. */
export async function authorizeHandover(tx: Prisma.TransactionClient, source: Order, proof: HandoverDecision): Promise<void> {
  if (proof.purpose !== 'pickup') return;
  if (!source.vendorId || source.vendorId !== proof.expectedVendorId || !proof.vendorUserId) {
    throw new AppError(409, 'DELIVERY_AUTHORITY_CHANGED', 'This order no longer belongs to the expected store.');
  }
  await tx.$queryRaw`SELECT id FROM vendors WHERE id = ${source.vendorId} AND "tenantId" = ${source.tenantId} FOR SHARE`;
  const vendor = await tx.vendor.findFirst({ where: { id: source.vendorId, tenantId: source.tenantId },
    select: { status: true, suspensionSource: true, owner: { select: { userId: true } } },
  });
  if (!vendor || vendor.status === 'CLOSED' || (vendor.status === 'SUSPENDED' && vendor.suspensionSource !== 'BILLING')) {
    throw new AppError(403, 'VENDOR_SUSPENDED', 'Your store is not active and cannot work orders. Reopen it from Account.');
  }
  if (vendor.owner.userId !== proof.vendorUserId) {
    const memberships = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM vendor_staff
      WHERE "vendorId" = ${source.vendorId} AND "userId" = ${proof.vendorUserId} FOR SHARE`;
    if (!memberships.length) throw new AppError(403, 'STAFF_FORBIDDEN', 'You are not a member of this store');
  }
}

/** [MOB-023 · F-103-01] The delivered door's own answers, on the locked row and
 *  BEFORE the seam's generic gates (as the door answered on main): a screen
 *  that rendered an older payment or custody state is refused as stale, and a
 *  rail whose money has not landed is refused with the door's ONE mapping. */
export function preflightHandoverDoor(source: Order, proof: HandoverDecision): void {
  if (proof.purpose !== 'delivery') return;
  if (!handoverVersionMatches(source, proof.handoverVersion)) {
    handoverBlockCounter.labels('STALE_VERSION').inc();
    throw new AppError(409, 'HANDOVER_STALE', 'This order changed since the screen was loaded — refresh before handing over.');
  }
  const authority = handoverAuthorityFor(source);
  if (authority.permitted === 'BLOCKED') {
    handoverBlockCounter.labels(authority.blockReason ?? 'BLOCKED').inc();
    const refusal = HANDOVER_REFUSALS[authority.blockReason ?? ''];
    throw new AppError(409, refusal?.code ?? (source.paymentStatus === 'PENDING' ? 'MMG_PAYMENT_PENDING' : 'PAYMENT_NOT_CAPTURED'),
      refusal?.message ?? `Payment is ${source.paymentStatus.toLowerCase()} — do not hand over. Refresh, or ask the store to confirm the payment.`);
  }
}

/** A wrong guess returns a value, so its attempt commits before the caller
 * reports the error. Success and the terminal facts share this same lock. */
export async function verifyHandoverDecision(tx: Prisma.TransactionClient, source: Order, proof: HandoverDecision): Promise<HandoverFailure | null> {
  const pickup = proof.purpose === 'pickup';
  if (!pickup) {
    if (proof.purpose === 'cash-delivery' && source.paymentMethod !== 'CASH') {
      throw new AppError(409, 'CASH_HANDOVER_ONLY', 'Customer cash handover is available only for cash orders.');
    }
    if (proof.purpose === 'delivery') {
      if (source.paymentMethod === 'CASH' && source.paymentStatus !== 'CAPTURED') {
        throw new AppError(409, 'PAYMENT_NOT_CAPTURED', 'Collect the cash first — use “Confirm payment & hand over” to record it, which completes the delivery.');
      }
    }
  }
  const secret = pickup ? source.pickupCode : source.ridePin;
  // Existing in-flight legacy rows remain compatible. Appointment proof is a
  // separate client rollout; this operation never changes that contract.
  if (!secret) return null;
  // [O-2] No code, and the store has the takeaway code off: no proof is asked. (Before the attempt
  // lockout: the lockout guards code GUESSES, and none is being made.)
  if (pickup && proof.codeWaived === true && !proof.code) return null;
  const attempts = pickup ? source.pickupCodeAttempts : source.ridePinAttempts;
  const { locked, remaining } = handoverAttemptState(attempts);
  if (locked) return { handoverFailure: { statusCode: 400, code: 'MAX_ATTEMPTS', message: 'Too many incorrect handover-code attempts on this order. Please contact support.' } };
  if (!proof.code) return { handoverFailure: { statusCode: 400, code: pickup ? 'MISSING_PICKUP_CODE' : 'MISSING_PIN',
    message: pickup ? "Enter the customer's pickup code to hand over this order." : "Enter the customer's 6-digit delivery PIN." } };
  // Fixed-length digests avoid a secret-dependent comparison or length exit.
  const matches = handoverCodeMatches(secret, proof.code);
  // Preserve the existing counters: pickup counts every comparison, delivery
  // counts wrong guesses. A successful terminal action admits no more guesses.
  if (pickup || !matches) await tx.order.update({ where: { id: source.id }, data: pickup
    ? { pickupCodeAttempts: { increment: 1 } } : { ridePinAttempts: { increment: 1 } },
  });
  if (!matches) return { handoverFailure: { statusCode: 400, code: pickup ? 'WRONG_PICKUP_CODE' : 'INVALID_PIN',
    message: `${pickup ? 'That pickup code' : 'That PIN'} does not match. ${remaining} attempt(s) remaining.` } };
  return null;
}
