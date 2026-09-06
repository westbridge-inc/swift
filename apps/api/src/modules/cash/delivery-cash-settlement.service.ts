import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { CashSettlementStatus } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import type { NotificationService } from '../notification/notification.service';

/**
 * MMG direct-pay cash ledger (store ⇄ rider).
 *
 * For an MMG-paid DELIVERY the customer paid the STORE — and the total the
 * store received includes the rider's checkout tip — so the store owes the
 * rider the delivery fee PLUS the tip in cash (normally handed over at
 * pickup) [SPS-F-0016b]. Swift moves no money — this ledger only tracks the
 * debt until BOTH sides confirm:
 *
 *   OWED ──rider──▶ RIDER_CONFIRMED ──store──▶ SETTLED
 *   OWED ──store──▶ STORE_CONFIRMED ──rider──▶ SETTLED
 *
 * Every transition is compare-and-set; re-confirming your own side is a no-op
 * (double-tap safe), so the endpoints are idempotent.
 */

/**
 * [W-26] Money is parsed exactly or refused. A settlement amount arriving as a
 * Prisma `Decimal` (a STRING on the wire) or as a number must land on the same
 * value; anything else is not an amount.
 */
function toAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    const parsed = Number((value as { toString(): string }).toString());
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The confirmer must name the ledger's own figure, to the cent. */
function assertAttestedAmountMatches(ledger: unknown, attested: unknown): void {
  const owed = toAmount(ledger);
  const said = toAmount(attested);
  if (said === null) {
    throw new AppError(400, 'ATTESTED_AMOUNT_REQUIRED', 'State the amount that changed hands before confirming.');
  }
  if (owed === null) {
    throw new AppError(409, 'SETTLEMENT_AMOUNT_UNREADABLE', 'This settlement has no readable amount and cannot be confirmed.');
  }
  // Cents, so 4500 and "4500.00" agree and 4500.01 does not.
  if (Math.round(owed * 100) !== Math.round(said * 100)) {
    throw new AppError(
      409,
      'ATTESTED_AMOUNT_MISMATCH',
      `This settlement is for GYD ${owed.toLocaleString()}, not GYD ${said.toLocaleString()}. Confirm only the amount that actually changed hands.`,
    );
  }
}

const SETTLEMENT_INCLUDE = {
  order: { select: { orderNumber: true } },
  // Phones are included so the two parties can actually reach each other to make
  // the CASH handover this ledger tracks — you can't hand someone money you owe
  // if you can't call them. Same contact the delivery already shared between
  // them; the ledger is scoped (each side sees only its own settlements).
  rider: { select: { userId: true, user: { select: { firstName: true, lastName: true, phone: true } } } },
  vendor: { select: { name: true, logoUrl: true, phone: true, owner: { select: { userId: true } } } },
} as const;

/** Wire shape both apps render — Decimal flattened to number. */
function toWire(s: any) {
  return {
    id: s.id,
    orderId: s.orderId,
    orderNumber: s.order?.orderNumber ?? null,
    amount: Number(s.amount),
    status: s.status,
    riderConfirmedAt: s.riderConfirmedAt,
    storeConfirmedAt: s.storeConfirmedAt,
    createdAt: s.createdAt,
    vendor: s.vendor ? { name: s.vendor.name, logoUrl: s.vendor.logoUrl, phone: s.vendor.phone ?? null } : null,
    rider: s.rider?.user ? { name: [s.rider.user.firstName, s.rider.user.lastName].filter(Boolean).join(' '), phone: s.rider.user.phone ?? null } : null,
  };
}

export class DeliveryCashSettlementService {
  constructor(
    private prisma: PrismaClient,
    private notifications: NotificationService,
  ) {}

  /** Rider ledger: what stores owe me. Owed = I haven't confirmed receiving it. */
  async listForRider(riderId: string) {
    return this.list({ riderId }, [CashSettlementStatus.OWED, CashSettlementStatus.STORE_CONFIRMED]);
  }

  /** Store ledger: what I owe riders. Owed = I haven't confirmed paying it. */
  async listForVendors(vendorIds: string[]) {
    return this.list({ vendorId: { in: vendorIds } }, [CashSettlementStatus.OWED, CashSettlementStatus.RIDER_CONFIRMED]);
  }

  private async list(scope: Record<string, unknown>, owedStatuses: CashSettlementStatus[]) {
    const [unsettled, settled, owedAgg] = await Promise.all([
      this.prisma.deliveryCashSettlement.findMany({
        where: { ...scope, status: { not: 'SETTLED' } },
        include: SETTLEMENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      this.prisma.deliveryCashSettlement.findMany({
        where: { ...scope, status: 'SETTLED' },
        include: SETTLEMENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
      // SWIFT-120: the owed SUMMARY must aggregate EVERY owed row on the DB, not
      // sum the displayed (capped-100) list — otherwise the "stores owe you" /
      // "you owe" figure silently undercounts once a party has >100 open rows.
      this.prisma.deliveryCashSettlement.aggregate({
        where: { ...scope, status: { in: owedStatuses } },
        _sum: { amount: true },
        _count: true,
      }),
    ]);
    return {
      summary: {
        owed: Number(owedAgg._sum.amount ?? 0),
        count: owedAgg._count,
      },
      unsettled: unsettled.map(toWire),
      settled: settled.map(toWire),
    };
  }

  /**
   * One side confirms the cash handover. `owner` scopes authz: a rider may only
   * confirm their own rows, a store only rows for its vendors (404 otherwise —
   * existence stays hidden, matching the rest of the API).
   */
  /**
   * [W-26] Close one side of a cash handover.
   *
   * This used to be a single click with no evidence behind it: the row recorded
   * a TIMESTAMP for "the store confirmed" and nothing else — not which person
   * pressed it, and not what amount they say changed hands. A mis-click, or a
   * confirmation on the wrong settlement, closed a real debt with nothing to
   * reconstruct afterwards.
   *
   * So a confirmation is now an ATTESTATION. The confirmer states the amount
   * they handed over or received, and the ledger refuses any figure that is not
   * its own — a settlement cannot be closed for an amount nobody agreed to.
   * The actor is recorded beside the timestamp.
   *
   * What was already right and is unchanged: both sides must confirm to reach
   * SETTLED, every transition is compare-and-set, and re-confirming your own
   * side is a no-op.
   */
  async confirm(
    settlementId: string,
    side: 'RIDER' | 'STORE',
    owner: { riderId?: string; vendorIds?: string[] },
    attestation: { actorId: string; amount: unknown },
  ) {
    const scope =
      side === 'RIDER'
        ? { riderId: owner.riderId! }
        : { vendorId: { in: owner.vendorIds! } };

    // Read first: the attested figure is checked against the ledger's own
    // amount BEFORE anything is written.
    const existing = await this.prisma.deliveryCashSettlement.findFirst({
      where: { id: settlementId, ...scope },
      select: { amount: true },
    });
    if (!existing) throw new NotFoundError('Settlement', settlementId);
    assertAttestedAmountMatches(existing.amount, attestation.amount);

    const now = new Date();
    const attested = toAmount(attestation.amount)!;
    const mine =
      side === 'RIDER'
        ? { riderConfirmedAt: now, riderConfirmedById: attestation.actorId, riderAttestedAmount: attested }
        : { storeConfirmedAt: now, storeConfirmedById: attestation.actorId, storeAttestedAmount: attested };
    const half = side === 'RIDER' ? CashSettlementStatus.RIDER_CONFIRMED : CashSettlementStatus.STORE_CONFIRMED;
    const otherHalf = side === 'RIDER' ? CashSettlementStatus.STORE_CONFIRMED : CashSettlementStatus.RIDER_CONFIRMED;

    // CAS 1: first confirmer — OWED → my half.
    let hit = await this.prisma.deliveryCashSettlement.updateMany({
      where: { id: settlementId, ...scope, status: CashSettlementStatus.OWED },
      data: { status: half, ...mine },
    });
    // CAS 2: second confirmer — other half → SETTLED.
    if (hit.count === 0) {
      hit = await this.prisma.deliveryCashSettlement.updateMany({
        where: { id: settlementId, ...scope, status: otherHalf },
        data: { status: CashSettlementStatus.SETTLED, ...mine },
      });
    }

    const row = await this.prisma.deliveryCashSettlement.findFirst({
      where: { id: settlementId, ...scope },
      include: SETTLEMENT_INCLUDE,
    });
    if (!row) throw new NotFoundError('Settlement', settlementId);

    // No CAS hit on an unsettled row = this side already confirmed → no-op.
    if (hit.count > 0) {
      // [DOC-1 §31.6 · P31-3] Both sides of every handover, always: the confirmation is an audited
      // assertion in the spec's words — the rider claims the fee was received, the store claims it paid.
      await this.prisma.auditLog.create({ data: {
        userId: attestation.actorId,
        action: side === 'RIDER' ? 'RIDER_CLAIMED_FEE_RECEIVED' : 'VENDOR_CLAIMED_RIDER_PAID_FEE',
        entity: 'DeliveryCashSettlement', entityId: settlementId,
        changes: { orderId: row.orderId, amount: String(attested), status: row.status },
      } });
      await this.notifyCounterpart(row);
    }

    return toWire(row);
  }

  /** Tell the other side what just happened — nudge or closure, never money. */
  private async notifyCounterpart(row: any) {
    const amount = `GYD ${Number(row.amount).toLocaleString()}`;
    const orderRef = row.order?.orderNumber ? `order #${row.order.orderNumber}` : 'an order';
    const base = { type: 'PAYMENT_RECEIVED' as const, data: { kind: 'delivery_cash_settlement', settlementId: row.id, orderId: row.orderId, status: row.status } };

    if (row.status === 'RIDER_CONFIRMED') {
      // Rider says the cash is in hand → store closes its side.
      await this.notifications.send({
        ...base,
        userId: row.vendor.owner.userId,
        title: 'Delivery pay handover confirmed',
        body: `Your rider confirmed receiving the ${amount} delivery pay for ${orderRef}. Tap to mark it paid and close it out.`,
      });
    } else if (row.status === 'STORE_CONFIRMED') {
      // Store says it paid → rider confirms receipt.
      await this.notifications.send({
        ...base,
        userId: row.rider.userId,
        title: `${row.vendor.name} marked your delivery pay paid`,
        body: `${row.vendor.name} says they handed you ${amount} for ${orderRef}. Confirm you received it.`,
      });
    } else if (row.status === 'SETTLED') {
      // Second confirmation — tell whoever confirmed FIRST that it's closed.
      const firstConfirmer =
        row.riderConfirmedAt && row.storeConfirmedAt && row.riderConfirmedAt < row.storeConfirmedAt
          ? row.rider.userId
          : row.vendor.owner.userId;
      await this.notifications.send({
        ...base,
        userId: firstConfirmer,
        title: 'Delivery pay settled',
        body: `The ${amount} delivery pay for ${orderRef} is confirmed by both sides. All square.`,
      });
    }
  }
}

/** Guard shared by both confirm routes. */
/**
 * [W-26] The body a confirmation must carry. `amount` is required and is
 * checked against the ledger — a confirmation with no figure is a click, not an
 * attestation.
 */
export const settlementAttestationSchema = z.object({
  amount: z.union([z.number(), z.string()]),
});

export function assertSettlementId(id: string | undefined): string {
  if (!id || id.length > 50) throw new AppError(400, 'INVALID_ID', 'Invalid settlement id');
  return id;
}
