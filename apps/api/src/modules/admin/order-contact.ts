import type { PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { maskPhone } from '../auth/step-up';
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN } from './admin-authority';

// ---------------------------------------------------------------------------
// [O-1 · COORD ruling 22 Oct 2026, owner delegated] THE ADMIN ORDER DESK SHOWS
// PHONE NUMBERS MASKED; THE FULL NUMBER IS AN AUDITED REVEAL.
//
// Riders, drivers, stores and customers no longer see each other's numbers
// (modules/calls/counterpart-phone.ts). Support still has to reach both sides,
// so the ops desk keeps the numbers, but a number on an open order page is in
// every screen share and screenshot of it. So:
//
//   - GET /admin/orders/:id and the order list return each party's phone
//     MASKED (+592•••••1234): enough to match a caller, not enough to dial;
//   - GET /admin/orders/:id/party-phone?party=customer|store|mover returns the
//     full number of ONE party, and only:
//       * with a stated reason (the x-swift-reason header, the console's one
//         reason transport; same 12-500 character rule as every admin reason),
//       * after an audit row naming the actor, the order, the party, the
//         person and the reason is WRITTEN, so a number that reaches the
//         operator is a number whose read was recorded (never the number
//         itself in the row);
//   - asking for a party the order does not have is recorded too (a miss).
//
// The ADM-007 sensitive-read log still records the order page itself (C1).
// ---------------------------------------------------------------------------

export const ORDER_CONTACT_PARTIES = ['customer', 'store', 'mover'] as const;
export type OrderContactParty = (typeof ORDER_CONTACT_PARTIES)[number];

type PhoneHolder = { phone?: string | null } | null | undefined;
type OrderWithParties = {
  customer?: PhoneHolder;
  vendor?: PhoneHolder;
  rider?: { user?: PhoneHolder } | null;
  driver?: { user?: PhoneHolder } | null;
};

const masked = (phone: string | null | undefined) => (phone ? maskPhone(phone) : phone ?? null);

/** The order with every party phone masked. A new object; the input is untouched. */
export function maskOrderPartyPhones<T extends OrderWithParties>(order: T): T {
  const out: OrderWithParties = { ...order };
  if (order.customer && 'phone' in order.customer) out.customer = { ...order.customer, phone: masked(order.customer.phone) };
  if (order.vendor && 'phone' in order.vendor) out.vendor = { ...order.vendor, phone: masked(order.vendor.phone) };
  for (const key of ['rider', 'driver'] as const) {
    const mover = order[key];
    if (mover?.user && 'phone' in mover.user) out[key] = { ...mover, user: { ...mover.user, phone: masked(mover.user.phone) } };
  }
  return out as T;
}

export interface OrderContactDeps {
  prisma: PrismaClient;
}

export interface OrderContactInput {
  orderId: string;
  party: OrderContactParty;
  actorId: string;
  reason: string | null;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface OrderContactResult {
  party: OrderContactParty;
  phone: string;
  /** The audit row this read is recorded in, quoted back so the operator sees it is logged. */
  auditId: string;
}

function assertReason(reason: string | null): string {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < ADMIN_REASON_MIN) {
    throw new AppError(400, 'REASON_REQUIRED', 'Say why you need this phone number, in a sentence. The audit trail records it.');
  }
  if (trimmed.length > ADMIN_REASON_MAX) {
    throw new AppError(400, 'REASON_TOO_LONG', `Keep the reason under ${ADMIN_REASON_MAX} characters.`);
  }
  return trimmed;
}

/** One party's full number, after its read is recorded. */
export async function revealOrderPartyPhone(deps: OrderContactDeps, input: OrderContactInput): Promise<OrderContactResult> {
  const reason = assertReason(input.reason);
  const order = await deps.prisma.order.findUnique({
    where: { id: input.orderId },
    select: {
      id: true,
      orderNumber: true,
      customer: { select: { id: true, phone: true } },
      vendor: { select: { id: true, phone: true } },
      rider: { select: { user: { select: { id: true, phone: true } } } },
      driver: { select: { user: { select: { id: true, phone: true } } } },
    },
  });
  if (!order) throw new NotFoundError('Order', input.orderId);

  const subject = input.party === 'customer'
    ? (order.customer ? { holder: 'user' as const, id: order.customer.id, phone: order.customer.phone } : null)
    : input.party === 'store'
      ? (order.vendor ? { holder: 'vendor' as const, id: order.vendor.id, phone: order.vendor.phone } : null)
      : (order.rider?.user
        ? { holder: 'user' as const, id: order.rider.user.id, phone: order.rider.user.phone }
        : order.driver?.user ? { holder: 'user' as const, id: order.driver.user.id, phone: order.driver.user.phone } : null);

  const changes = {
    reason,
    party: input.party,
    orderNumber: order.orderNumber,
    ...(subject ? (subject.holder === 'vendor' ? { vendorId: subject.id } : { subjectUserId: subject.id }) : {}),
  };
  const audit = { userId: input.actorId, entity: 'Order', entityId: order.id, ipAddress: input.ip, userAgent: input.userAgent };

  if (!subject?.phone) {
    // Nothing to show, and the ask is still worth recording.
    await deps.prisma.auditLog.create({ data: { ...audit, action: 'REVEAL_PARTY_PHONE_MISS', changes: { ...changes, outcome: 'no_number_for_party' } } });
    throw new AppError(404, 'NO_PARTY_PHONE', 'This order has no phone number for that party.');
  }

  // Written BEFORE the number leaves: if this fails, the operator gets an error, never the number.
  const row = await deps.prisma.auditLog.create({ data: { ...audit, action: 'REVEAL_PARTY_PHONE', changes } });
  return { party: input.party, phone: subject.phone, auditId: row.id };
}
