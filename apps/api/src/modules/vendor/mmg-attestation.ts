import type { Order, PaymentStatus, Prisma } from '@prisma/client';
import { AppError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// [W-25] "MMG PAYMENT RECEIVED" IS AN ATTESTATION, NOT A RECONCILED CAPTURE.
//
// Swift holds no money on this rail: the customer pays the store's own mobile
// wallet, the store sees it land, and the store tells Swift. That is the only
// signal there is, and it is a human's word. The console treated it as proof
// and offered the button on almost every order — the predicate was "not
// captured and not cancelled", so a payment the provider had FAILED, one that
// had been REFUNDED, and one nobody could resolve (UNKNOWN) all showed a
// one-tap "MMG payment received" with no amount, no recipient and no
// reference. A tap on a reversed payment recaptured a refund.
//
// Two things change here.
//
// 1. THE MATRIX. An attestation is admissible only from a payment state where
//    money plausibly landed and nothing has reversed or resolved it: PENDING
//    or AUTHORIZED. Every other state is refused in its own words, because
//    the reasons are different and an operator has to know which one they hit.
//
// 2. THE EVIDENCE. The store types the provider's transaction reference — the
//    one in the wallet's own message. It is stored, and it is UNIQUE across
//    orders, so the same reference cannot mark two orders paid. The row then
//    says plainly that this capture rests on a person's word: who attested,
//    when, and against what reference. A later provider reconciliation can
//    match on it; until that exists, `vendorAttestedCaptures` is the list of
//    captures with no provider evidence behind them.
//
// What this does NOT do is pretend the attestation is a reconciled capture.
// It is recorded as what it is, and the register keeps a way to find it.
// ---------------------------------------------------------------------------

/** The only payment states a store may attest against. */
export const ATTESTABLE_PAYMENT_STATUSES: PaymentStatus[] = ['PENDING', 'AUTHORIZED'];

/** A provider reference is a short alphanumeric token; the wallet's message is the source. */
export const MMG_REFERENCE_MIN = 4;
export const MMG_REFERENCE_MAX = 64;
const REFERENCE_SHAPE = /^[A-Z0-9][A-Z0-9._-]{2,62}[A-Z0-9]$/;

export interface AttestableOrder {
  paymentStatus: PaymentStatus;
  paymentMethod: string;
  status: string;
}

/**
 * Refuse anything outside the matrix, each in its own words. `CAPTURED` is not
 * refused here: the caller answers a repeat tap idempotently, which is a
 * different thing from an inadmissible state.
 */
export function assertMmgAttestable(order: AttestableOrder): void {
  const status = order.paymentStatus;
  if (ATTESTABLE_PAYMENT_STATUSES.includes(status) || status === 'CAPTURED' || status === 'CLAIMED') return;

  switch (status) {
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
      throw new AppError(
        409,
        'PAYMENT_REVERSED',
        'This payment was refunded. Marking it received would record the refund as income — if the customer has paid again, that is a new payment.',
      );
    case 'FAILED':
      throw new AppError(
        409,
        'PAYMENT_FAILED',
        'MMG reports this payment as failed. If money did reach your wallet, contact support with the transaction reference — do not mark it received here.',
      );
    case 'EXPIRED':
      throw new AppError(
        409,
        'PAYMENT_EXPIRED',
        'The payment window for this order closed. Ask the customer to pay again; a new payment can be marked received.',
      );
    case 'CANCELLED':
      throw new AppError(409, 'PAYMENT_CANCELLED', 'This payment was superseded and cannot be marked received.');
    case 'UNKNOWN':
      throw new AppError(
        409,
        'PAYMENT_UNRESOLVED',
        'This payment is unresolved — money may have moved and MMG has not said. Support resolves it against MMG; a store cannot settle it by eye.',
      );
    default:
      throw new AppError(409, 'PAYMENT_NOT_ATTESTABLE', `A payment in ${status} state cannot be marked received.`);
  }
}

/** The reference as it will be stored and compared: trimmed, upper-cased, shape-checked. */
export function normaliseMmgReference(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (value.length < MMG_REFERENCE_MIN || value.length > MMG_REFERENCE_MAX) {
    throw new AppError(
      400,
      'REFERENCE_REQUIRED',
      'Enter the MMG transaction reference from the message in your wallet — it is what proves this payment later.',
    );
  }
  if (!REFERENCE_SHAPE.test(value)) {
    throw new AppError(
      400,
      'REFERENCE_INVALID',
      'That does not look like an MMG transaction reference. Copy it from the payment message in your wallet.',
    );
  }
  return value;
}

export interface AttestationInput {
  orderId: string;
  reference: string;
  actorId: string;
  amount: Prisma.Decimal | number | string;
  recipientName: string | null;
  now?: Date;
}

/**
 * The write, inside the caller's transaction and under the caller's order
 * lock. Returns false when the reference already belongs to another order —
 * a store cannot mark two orders paid with one transaction.
 */
export async function recordVendorAttestation(
  tx: Prisma.TransactionClient,
  input: AttestationInput,
): Promise<{ ok: true } | { ok: false; reason: 'REFERENCE_ALREADY_USED' }> {
  const now = input.now ?? new Date();
  const clash = await tx.order.findFirst({
    where: { mmgAttestedRef: input.reference, id: { not: input.orderId } },
    select: { id: true, orderNumber: true },
  });
  if (clash) return { ok: false, reason: 'REFERENCE_ALREADY_USED' };

  await tx.order.update({
    where: { id: input.orderId },
    data: { mmgAttestedRef: input.reference, mmgAttestedById: input.actorId, mmgAttestedAt: now },
  });
  // The evidence a reconciliation, a dispute or an audit reads back. It names
  // the money and the destination, because "received" without an amount and a
  // recipient is not a claim anyone can check.
  await tx.auditLog.create({
    data: {
      userId: input.actorId,
      action: 'ATTEST_MMG_PAYMENT',
      entity: 'Order',
      entityId: input.orderId,
      changes: {
        reference: input.reference,
        amount: String(input.amount),
        currency: 'GYD',
        recipient: input.recipientName,
        basis: 'VENDOR_ATTESTED',
      },
    },
  });
  return { ok: true };
}

export interface AttestedCapture {
  orderId: string;
  orderNumber: string;
  reference: string | null;
  attestedAt: Date | null;
  amount: string;
  ageHours: number;
}

/**
 * [W-25 observability] Captures resting on a store's word, oldest first. Every
 * row here is money Swift believes arrived because someone said so; a
 * provider reconciliation, when it exists, clears them by reference.
 */
export async function vendorAttestedCaptures(
  prisma: { order: { findMany: (args: unknown) => Promise<Array<Pick<Order, 'id' | 'orderNumber' | 'mmgAttestedRef' | 'mmgAttestedAt' | 'totalAmount'>>> } },
  opts: { limit?: number; now?: Date } = {},
): Promise<AttestedCapture[]> {
  const now = opts.now ?? new Date();
  const rows = await prisma.order.findMany({
    where: { mmgAttestedAt: { not: null } },
    select: { id: true, orderNumber: true, mmgAttestedRef: true, mmgAttestedAt: true, totalAmount: true },
    orderBy: { mmgAttestedAt: 'asc' },
    take: Math.min(500, opts.limit ?? 200),
  });
  return rows.map((r) => ({
    orderId: r.id,
    orderNumber: r.orderNumber,
    reference: r.mmgAttestedRef,
    attestedAt: r.mmgAttestedAt,
    amount: String(r.totalAmount),
    ageHours: r.mmgAttestedAt ? Math.floor((now.getTime() - r.mmgAttestedAt.getTime()) / 3_600_000) : 0,
  }));
}
