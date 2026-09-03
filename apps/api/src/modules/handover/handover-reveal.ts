import type { PrismaClient } from '@prisma/client';
import { randomInt } from 'crypto';
import { AppError, NotFoundError } from '../../utils/errors';
import { handoverBreakGlassCounter } from '../../plugins/observability';

// ---------------------------------------------------------------------------
// [A-15] THE ONE AUDITED DOOR TO A HANDOVER SECRET.
//
// A pickup code proves the person collecting an order is the customer. It is
// therefore a credential, and the rule that makes it worth anything is that
// the VERIFIER never holds it: the customer holds the code, the vendor types
// what the customer reads out, and the server compares. The admin console
// broke that rule by printing the code on every order row.
//
// Support does occasionally need it — a customer who cannot open the app, a
// disputed handover. That is an exception, and an exception needs a door
// rather than a window:
//
//   - a written reason, recorded with the read (the same shape as the G7
//     identity door);
//   - re-authentication (the route requires step-up before calling in);
//   - an audit row naming actor, order, customer and reason, written BEFORE
//     the value is returned, so a read that reaches the operator is a read
//     that was recorded;
//   - a counter, so "how often is this door used" is answerable;
//   - and rotation, because a code that has been read aloud to support is
//     spent: rotating issues a new one, resets the guessing budget, and the
//     customer sees the new code in their own app.
//
// Nothing here weakens verification. The vendor's complete-pickup route still
// reads the secret only at the comparison site and still never returns it.
// ---------------------------------------------------------------------------

/** A reason short enough to be a shrug is not a reason. Mirrors the G7 identity door. */
export const HANDOVER_REASON_MIN = 12;
export const HANDOVER_REASON_MAX = 500;

export interface HandoverRevealDeps {
  prisma: PrismaClient;
  now?: () => Date;
  /** test seam: called at named boundaries so a death mid-ceremony can be proven */
  failpoint?: (boundary: string, ctx?: Record<string, unknown>) => Promise<void>;
}

export interface RevealInput {
  orderId: string;
  actorId: string;
  reason: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface RevealResult {
  pickupCode: string;
  /** the audit row this read is recorded in — quoted back so the operator sees it is logged */
  auditId: string;
  attempts: number;
  locked: boolean;
}

export interface RotateResult {
  auditId: string;
  /** true when a code existed and was replaced */
  rotated: boolean;
}

function assertReason(reason: string): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < HANDOVER_REASON_MIN) {
    throw new AppError(400, 'REASON_REQUIRED', 'Say why you need this handover code, in a sentence — the audit trail records it.');
  }
  if (trimmed.length > HANDOVER_REASON_MAX) {
    throw new AppError(400, 'REASON_TOO_LONG', `Keep the reason under ${HANDOVER_REASON_MAX} characters.`);
  }
  return trimmed;
}

async function loadOrder(prisma: PrismaClient, orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, orderNumber: true, customerId: true, vendorId: true, status: true, fulfillment: true, pickupCode: true, pickupCodeAttempts: true },
  });
  if (!order) throw new NotFoundError('Order', orderId);
  return order;
}

/**
 * Read one order's pickup code, on the record. The audit row is committed
 * BEFORE the value is returned — if the write fails, the operator gets an
 * error rather than an unrecorded secret.
 */
export async function revealPickupCode(deps: HandoverRevealDeps, input: RevealInput): Promise<RevealResult> {
  const reason = assertReason(input.reason);
  const order = await loadOrder(deps.prisma, input.orderId);

  if (!order.pickupCode) {
    // Nothing to reveal, and the attempt is still worth recording: asking for a
    // code that does not exist is either confusion or probing.
    await deps.prisma.auditLog.create({
      data: {
        userId: input.actorId,
        action: 'REVEAL_PICKUP_CODE_MISS',
        entity: 'Order',
        entityId: order.id,
        changes: { reason, orderNumber: order.orderNumber, outcome: 'no_code_on_order' },
        ipAddress: input.ip,
        userAgent: input.userAgent,
      },
    });
    handoverBreakGlassCounter.labels('reveal_no_code').inc();
    throw new AppError(404, 'NO_PICKUP_CODE', 'This order has no pickup code.');
  }

  const audit = await deps.prisma.auditLog.create({
    data: {
      userId: input.actorId,
      action: 'REVEAL_PICKUP_CODE',
      entity: 'Order',
      entityId: order.id,
      // the reason, the subject and the circumstances — never the value
      changes: {
        reason,
        orderNumber: order.orderNumber,
        customerId: order.customerId,
        vendorId: order.vendorId,
        orderStatus: order.status,
        attempts: order.pickupCodeAttempts,
      },
      ipAddress: input.ip,
      userAgent: input.userAgent,
    },
  });
  handoverBreakGlassCounter.labels('reveal').inc();
  await deps.failpoint?.('after-audit', { orderId: order.id, auditId: audit.id });

  return {
    pickupCode: order.pickupCode,
    auditId: audit.id,
    attempts: order.pickupCodeAttempts,
    locked: order.pickupCodeAttempts >= 5,
  };
}

/**
 * Issue a new pickup code and reset the guessing budget. Used after a reveal
 * (the old code has been spoken aloud) or when a customer reports the code
 * was seen. The customer's own order screen shows the new value; the vendor
 * still cannot read either.
 */
export async function rotatePickupCode(deps: HandoverRevealDeps, input: RevealInput): Promise<RotateResult> {
  const reason = assertReason(input.reason);
  const order = await loadOrder(deps.prisma, input.orderId);
  if (!order.pickupCode) throw new AppError(404, 'NO_PICKUP_CODE', 'This order has no pickup code to rotate.');

  const next = String(randomInt(100000, 1000000));
  await deps.failpoint?.('before-rotate', { orderId: order.id });

  const { audit } = await deps.prisma.$transaction(async (tx) => {
    // compare-and-set on the code we read: a concurrent rotation must not be
    // silently overwritten, or two operators hand two different codes out
    const updated = await tx.order.updateMany({
      where: { id: order.id, pickupCode: order.pickupCode },
      data: { pickupCode: next, pickupCodeAttempts: 0 },
    });
    if (updated.count !== 1) {
      throw new AppError(409, 'ROTATION_RACED', 'This pickup code was rotated by someone else — reload the order.');
    }
    const row = await tx.auditLog.create({
      data: {
        userId: input.actorId,
        action: 'ROTATE_PICKUP_CODE',
        entity: 'Order',
        entityId: order.id,
        changes: {
          reason,
          orderNumber: order.orderNumber,
          customerId: order.customerId,
          orderStatus: order.status,
          attemptsCleared: order.pickupCodeAttempts,
        },
        ipAddress: input.ip,
        userAgent: input.userAgent,
      },
    });
    return { audit: row };
  });

  handoverBreakGlassCounter.labels('rotate').inc();
  return { auditId: audit.id, rotated: true };
}
