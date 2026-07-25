import type { PrismaClient } from '@prisma/client';
import { CashSettlementStatus } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import type { NotificationService } from '../notification/notification.service';

/**
 * MMG direct-pay cash ledger (store ⇄ rider).
 *
 * For an MMG-paid DELIVERY the customer paid the STORE, so the store owes the
 * rider the delivery fee in cash (normally handed over at pickup). Swift moves
 * no money — this ledger only tracks the debt until BOTH sides confirm:
 *
 *   OWED ──rider──▶ RIDER_CONFIRMED ──store──▶ SETTLED
 *   OWED ──store──▶ STORE_CONFIRMED ──rider──▶ SETTLED
 *
 * Every transition is compare-and-set; re-confirming your own side is a no-op
 * (double-tap safe), so the endpoints are idempotent.
 */

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
  async confirm(settlementId: string, side: 'RIDER' | 'STORE', owner: { riderId?: string; vendorIds?: string[] }) {
    const scope =
      side === 'RIDER'
        ? { riderId: owner.riderId! }
        : { vendorId: { in: owner.vendorIds! } };

    const now = new Date();
    const mine = side === 'RIDER' ? { riderConfirmedAt: now } : { storeConfirmedAt: now };
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
    if (hit.count > 0) await this.notifyCounterpart(row);

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
        title: 'Delivery fee handover confirmed',
        body: `Your rider confirmed receiving the ${amount} delivery fee for ${orderRef}. Tap to mark it paid and close it out.`,
      });
    } else if (row.status === 'STORE_CONFIRMED') {
      // Store says it paid → rider confirms receipt.
      await this.notifications.send({
        ...base,
        userId: row.rider.userId,
        title: `${row.vendor.name} marked your delivery fee paid`,
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
        title: 'Delivery fee settled',
        body: `The ${amount} delivery fee for ${orderRef} is confirmed by both sides. All square.`,
      });
    }
  }
}

/** Guard shared by both confirm routes. */
export function assertSettlementId(id: string | undefined): string {
  if (!id || id.length > 50) throw new AppError(400, 'INVALID_ID', 'Invalid settlement id');
  return id;
}
