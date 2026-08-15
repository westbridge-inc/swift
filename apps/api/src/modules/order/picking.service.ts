import type { Prisma, PrismaClient, SubstitutionStatus } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotificationService } from '../notification/notification.service';
import { FloatService } from '../dispatch/float.service';
import { AppError, NotFoundError } from '../../utils/errors';
import { assertMmgFulfilmentAllowed } from './order.service';

/** [REPORT-006 F-006-02] MMG order money is immutable in-app — ANY payment
 *  status. CAPTURED is money the store already received; PENDING is only the
 *  absence of the store's attestation, not proof the customer's external
 *  transfer didn't happen (same doctrine as the conversion block). Until a
 *  durable vendor-refund/adjustment obligation ledger exists (founder-gated),
 *  every picking operation that would rewrite an MMG total fails closed.
 *  Same-price substitutions pass (no money effect); CASH orders pass (the
 *  door handover collects the adjusted amount). */
function assertMmgMoneyAdjustable(order: { paymentMethod: string | null }): void {
  if (order.paymentMethod !== 'MOBILE_MONEY') return;
  throw new AppError(
    409,
    'MMG_ADJUSTMENT_UNAVAILABLE',
    'MMG order totals can’t change in-app — the store settles item changes with you directly until in-app MMG adjustments arrive.',
  );
}

// ---------------------------------------------------------------------------
// Grocery picking + substitution (§5.3). Shelf reality beats the database:
// staff tick lines as they pick; an out-of-stock line becomes either a
// substitution the CUSTOMER decides on (live prompt) or a line refund. A
// PENDING substitution blocks Mark-ready — the bag never closes with an open
// question in it. Picking rides INSIDE the existing PREPARING stage: the order
// state machine is locked and gains no new states.
//
// Money honesty: totals here are what's due at handover (cash) or what the
// vendor owes back (MMG already paid) — Swift adjusts numbers, never money.
//
// [REPORT-006 F-006-04/05] Concurrency doctrine: previews (getLine) exist for
// 404s and error copy ONLY. Every mutation either binds live order lifecycle +
// expected line state in its WRITE predicate, or — when money/stock/float move
// — runs one Order-row-locked transaction that revalidates everything from the
// locked row and commits line state, inventory, totals, float, and immutable
// evidence together. Sockets/notifications publish only after commit, and only
// for the CAS winner.
// ---------------------------------------------------------------------------

/** Order states where the pick list is editable by the vendor. */
const PICKABLE_STATES = [
  'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
  'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
];

type PickableStatus = import('@prisma/client').OrderStatus;

export class PickingService {
  private notifications: NotificationService;

  constructor(
    private prisma: PrismaClient,
    private io: Server,
  ) {
    this.notifications = new NotificationService(prisma, io);
  }

  /** A line is settled when it's picked, or its substitution question closed. */
  static lineResolved(line: { picked: boolean; subStatus: string }): boolean {
    return line.picked || line.subStatus === 'REFUNDED' || line.subStatus === 'REJECTED';
  }

  /** Gate for Mark-ready on quantity-tracked stores: no open lines. */
  async unresolvedLines(orderId: string): Promise<number> {
    const lines = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: { picked: true, subStatus: true },
    });
    return lines.filter((l) => !PickingService.lineResolved(l)).length;
  }

  private async getLine(orderId: string, lineId: string) {
    const line = await this.prisma.orderItem.findFirst({
      where: { id: lineId, orderId },
      include: { order: { select: {
        id: true, status: true, customerId: true, orderNumber: true, vendorId: true,
        paymentMethod: true, paymentStatus: true, orderType: true,
      } } },
    });
    if (!line) throw new NotFoundError('Order line', lineId);
    if (!PICKABLE_STATES.includes(line.order.status)) {
      throw new AppError(409, 'NOT_PICKABLE', `The pick list is closed once the order is ${line.order.status}`);
    }
    return line;
  }

  /** Staff tick/untick a shelf-picked line. */
  async setPicked(orderId: string, lineId: string, picked: boolean) {
    const line = await this.getLine(orderId, lineId);
    // [SPS-F-0016 / REPORT-004 F-004-05] Ticking a line IS preparing the order
    // — gated for unpaid MMG like every other affirmative prep action.
    // Unticking (corrective) stays open.
    if (picked) assertMmgFulfilmentAllowed(line.order, 'PREPARING');
    if (line.subStatus === 'PENDING') {
      throw new AppError(409, 'SUBSTITUTION_OPEN', 'Resolve the substitution before picking this line');
    }
    if (line.subStatus === 'REFUNDED' || line.subStatus === 'REJECTED') {
      throw new AppError(409, 'LINE_CLOSED', 'This line was refunded — nothing to pick');
    }
    // [REPORT-006 F-006-05] The write re-binds live order lifecycle and line
    // state — a cancellation or line closure committing after the preview
    // matches nothing instead of mutating a closed order.
    const updated = await this.prisma.orderItem.updateMany({
      where: {
        id: lineId,
        subStatus: { notIn: ['PENDING', 'REFUNDED', 'REJECTED'] },
        order: { status: { in: PICKABLE_STATES as PickableStatus[] } },
      },
      data: { picked },
    });
    if (updated.count === 0) {
      throw new AppError(409, 'NOT_PICKABLE', 'This line just changed — refresh the order');
    }
    this.emitPickState(line.order.vendorId, orderId, lineId, { picked });
    return this.prisma.orderItem.findUnique({ where: { id: lineId } });
  }

  /**
   * Out of stock → propose a substitute. Only items from the SAME vendor and
   * (when the original declares one) the same substitutionGroup qualify — the
   * customer decides, live.
   */
  async proposeSubstitution(orderId: string, lineId: string, substituteItemId: string, changedBy: string) {
    const line = await this.getLine(orderId, lineId);
    // [SPS-F-0016] Proposing a substitute is affirmative preparation — gated.
    assertMmgFulfilmentAllowed(line.order, 'PREPARING');
    if (line.picked) throw new AppError(409, 'ALREADY_PICKED', 'This line is already picked');
    if (line.subStatus !== 'NONE') {
      throw new AppError(409, 'SUBSTITUTION_EXISTS', `This line is already ${line.subStatus.toLowerCase()}`);
    }

    const [original, substitute] = await Promise.all([
      line.itemId ? this.prisma.item.findUnique({ where: { id: line.itemId } }) : null,
      this.prisma.item.findUnique({ where: { id: substituteItemId } }),
    ]);
    if (!substitute || substitute.vendorId !== line.order.vendorId) {
      throw new NotFoundError('Substitute item', substituteItemId);
    }
    if (!substitute.isAvailable) {
      throw new AppError(409, 'SUBSTITUTE_UNAVAILABLE', 'That substitute is itself unavailable');
    }
    if (original?.substitutionGroup && substitute.substitutionGroup !== original.substitutionGroup) {
      throw new AppError(400, 'WRONG_GROUP', 'Substitutes must come from the same substitution group');
    }

    // [REPORT-006 F-006-05] Lifecycle + line state bound in the write: a
    // customer cancellation between preview and write leaves nothing to
    // propose on — no PENDING question ever opens on a closed order.
    const updated = await this.prisma.orderItem.updateMany({
      where: {
        id: lineId,
        subStatus: 'NONE',
        picked: false,
        order: { status: { in: PICKABLE_STATES as PickableStatus[] } },
      },
      data: {
        subStatus: 'PENDING',
        substituteItemId,
        substituteName: substitute.name,
        substitutePrice: substitute.basePrice,
      },
    });
    if (updated.count === 0) {
      throw new AppError(409, 'SUBSTITUTION_EXISTS', 'This line just changed — refresh the order');
    }

    await this.prisma.orderStatusLog.create({
      data: { orderId, status: line.order.status as PickableStatus, changedBy, note: `Substitution proposed: ${line.name} → ${substitute.name}` },
    });
    this.io.to(`order:${orderId}`).emit('order:substitution', {
      orderId,
      lineId,
      originalName: line.name,
      substituteName: substitute.name,
      substitutePrice: Number(substitute.basePrice),
      quantity: line.quantity,
      status: 'PENDING',
    });
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: `${line.name} is out of stock`,
      body: `The store suggests ${substitute.name} instead for order #${line.order.orderNumber}. Approve or reject it in the app.`,
      data: { orderId, kind: 'substitution_pending', lineId },
    });
    return this.prisma.orderItem.findUnique({ where: { id: lineId } });
  }

  /** No substitute possible → refund the line: totals shrink, stock returns. */
  async refundLine(orderId: string, lineId: string, changedBy: string) {
    const line = await this.getLine(orderId, lineId);
    if (line.picked) throw new AppError(409, 'ALREADY_PICKED', 'This line is already picked');
    // Idempotent on BOTH closed states [REPORT-005 F-005-02]: a customer
    // rejection also closes the line — refunding it again double-decremented
    // totals and double-restocked.
    if (line.subStatus === 'REFUNDED' || line.subStatus === 'REJECTED') return line;
    // [F-006-02] Fail-fast preview for honest copy; the authoritative check
    // re-runs inside closeLine's locked transaction.
    assertMmgMoneyAdjustable(line.order);

    const closed = await this.closeLine(line, 'REFUNDED', changedBy);
    // [REPORT-006 F-006-05] Only the CAS winner speaks: a lost duplicate race
    // must not send the customer a second "removed from your order" push.
    if (closed) {
      await this.notifications.send({
        userId: line.order.customerId,
        type: 'ORDER_UPDATE',
        title: `${line.name} removed from your order`,
        body: `It's out of stock at the store. Order #${line.order.orderNumber}'s total went down by $${Number(line.totalCustomer).toLocaleString()}.`,
        data: { orderId, kind: 'line_refunded', lineId },
      });
      return this.prisma.orderItem.findUnique({ where: { id: lineId } });
    }
    // Lost the CAS: honest only if the winner reached the SAME outcome. A
    // duplicate refund/reject landing first is an idempotent success; losing
    // to a concurrent APPROVAL means the line is now the substitute — saying
    // "refunded" would be a lie, so surface the conflict.
    const finalLine = await this.prisma.orderItem.findUnique({ where: { id: lineId } });
    if (finalLine && (finalLine.subStatus === 'REFUNDED' || finalLine.subStatus === 'REJECTED')) {
      return finalLine;
    }
    throw new AppError(409, 'LINE_CHANGED', 'This line just changed — refresh the order');
  }

  /** The customer's verdict on a pending substitution. */
  async decideSubstitution(orderId: string, lineId: string, customerId: string, approve: boolean) {
    const line = await this.prisma.orderItem.findFirst({
      where: { id: lineId, orderId, order: { customerId } },
      include: { order: { select: {
        id: true, status: true, customerId: true, orderNumber: true, vendorId: true,
        paymentMethod: true, paymentStatus: true, orderType: true,
      } } },
    });
    if (!line) throw new NotFoundError('Order line', lineId);
    if (line.subStatus !== 'PENDING') {
      throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
    }

    if (!approve) {
      // A rejection ALSO rewrites totals (closeLine decrements the line) — on
      // MMG that is an unrecorded refund [F-006-02]. Preview fail-fast; the
      // locked transaction inside closeLine re-asserts from the live row.
      assertMmgMoneyAdjustable(line.order);
      const closed = await this.closeLine(line, 'REJECTED', customerId);
      if (closed) return this.prisma.orderItem.findUnique({ where: { id: lineId } });
      // Lost the CAS. A concurrent duplicate reject (or a vendor refund) is
      // the same outcome — idempotent success. Losing to a concurrent
      // APPROVAL is a conflicting decision: the line is now the substitute,
      // and a 200 here would tell the customer their rejection stuck.
      const finalLine = await this.prisma.orderItem.findUnique({ where: { id: lineId } });
      if (finalLine && (finalLine.subStatus === 'REFUNDED' || finalLine.subStatus === 'REJECTED')) {
        return finalLine;
      }
      throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
    }

    // Approve: the line BECOMES the substitute — name/price swap, totals move
    // by the price difference × qty. Stock: substitute decrements (guarded,
    // oversell-impossible), the original goes back on the shelf.
    //
    // [REPORT-006 F-006-04/05] One Order-locked transaction owns the whole
    // decision: live lifecycle + payment validation, an expected-state line
    // CAS (two concurrent approvals have exactly one winner), both inventory
    // moves, the totals delta, the assigned rider's committed CASH float, and
    // the immutable status log. Everything commits or nothing does — the old
    // shape moved stock before an unconditional line write, so a double
    // approval doubled stock moves and totals.
    const approved = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR UPDATE`;
      const order = await tx.order.findFirst({
        where: { id: orderId, customerId },
        select: {
          id: true, status: true, paymentMethod: true, paymentStatus: true,
          orderType: true, riderId: true, totalAmount: true, vendorId: true,
        },
      });
      if (!order) throw new NotFoundError('Order', orderId);
      if (!PICKABLE_STATES.includes(order.status)) {
        throw new AppError(409, 'NOT_PICKABLE', `The pick list is closed once the order is ${order.status}`);
      }
      assertMmgFulfilmentAllowed(order, 'PREPARING');

      const fresh = await tx.orderItem.findFirst({ where: { id: lineId, orderId } });
      if (!fresh || fresh.subStatus !== 'PENDING') {
        throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
      }

      const substitutePrice = Number(fresh.substitutePrice ?? 0);
      const newLineTotal = substitutePrice * fresh.quantity;
      const delta = newLineTotal - Number(fresh.totalCustomer);

      // [F-006-02] On MMG, a dearer substitute records money never collected
      // and a cheaper one an unrecorded refund — any payment status. Only a
      // same-price swap may proceed until the adjustment/refund ledger exists.
      if (delta !== 0) assertMmgMoneyAdjustable(order);

      // A substitute may reduce a line's price but must NEVER drive the ORDER
      // total below zero. On a discounted order a free/cheap substitute could
      // otherwise invert the total into "the platform owes the customer".
      if (Number(order.totalAmount) + delta < 0) {
        throw new AppError(400, 'SUBSTITUTE_NEGATIVE_TOTAL', 'That substitute would drop the order total below zero — refund the line instead.');
      }

      // Exactly-one approval: expected-state CAS on the line.
      const cas = await tx.orderItem.updateMany({
        where: { id: lineId, subStatus: 'PENDING', picked: false },
        data: {
          subStatus: 'APPROVED',
          picked: false, // staff still has to shelf-pick the substitute
          name: `${fresh.substituteName} (sub for ${fresh.name})`,
          basePrice: substitutePrice,
          markedUpPrice: substitutePrice,
          totalBase: newLineTotal,
          totalCustomer: newLineTotal,
        },
      });
      if (cas.count === 0) {
        throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
      }

      if (fresh.substituteItemId) {
        const sub = await tx.item.findUnique({
          where: { id: fresh.substituteItemId },
          select: { stockQuantity: true },
        });
        if (sub?.stockQuantity != null) {
          // Same conditional-decrement guard as checkout: overselling impossible.
          const decremented = await tx.item.updateMany({
            where: { id: fresh.substituteItemId, stockQuantity: { gte: fresh.quantity } },
            data: { stockQuantity: { decrement: fresh.quantity } },
          });
          if (decremented.count === 0) {
            throw new AppError(409, 'SUBSTITUTE_OUT_OF_STOCK', 'The substitute just sold out — ask the store to pick another');
          }
          // Mirror the inventory engine: hitting zero auto-hides from browse.
          await tx.item.updateMany({
            where: { id: fresh.substituteItemId, stockQuantity: { lte: 0 }, isAvailable: true },
            data: { isAvailable: false, autoHiddenAt: new Date() },
          });
        }
      }
      await this.restockLine(fresh, 'customer approved substitution', tx);

      await tx.order.update({
        where: { id: orderId },
        data: {
          subtotalBase: { increment: delta },
          subtotalCustomer: { increment: delta },
          totalAmount: { increment: delta },
        },
      });

      // [REPORT-006 F-006-05] Committed float tracks the LIVE cash subtotal a
      // rider fronts. A dearer substitute must still fit the exposure cap
      // (guarded commit — fail closed, never silently exceed); a cheaper one
      // releases the difference now, or the terminal release under-unwinds
      // and the rider's float headroom leaks forever.
      if (order.paymentMethod === 'CASH' && order.riderId && delta !== 0) {
        const float = new FloatService(tx);
        if (delta > 0) {
          const withinCap = await float.commit(tx, order.riderId, delta);
          if (!withinCap) {
            throw new AppError(409, 'SUBSTITUTE_FLOAT_EXCEEDED', 'Your rider can’t front the extra cash for that substitute — refund the line or ask the store for a same-price option.');
          }
        } else {
          await float.release(tx, order.riderId, -delta);
        }
      }

      await tx.orderStatusLog.create({
        data: { orderId, status: order.status as PickableStatus, changedBy: customerId, note: `Substitution approved: ${fresh.substituteName}` },
      });
      return { vendorId: order.vendorId };
    });

    this.emitPickState(approved.vendorId, orderId, lineId, { subStatus: 'APPROVED' });
    return this.prisma.orderItem.findUnique({ where: { id: lineId } });
  }

  /** Shared close-out for refund/reject: totals shrink, stock returns.
   *  Returns true only for the CAS winner — callers publish nothing on false. */
  private async closeLine(
    line: { id: string; itemId: string | null; substituteItemId: string | null; name: string; quantity: number; totalCustomer: unknown; subStatus: SubstitutionStatus; order: { id: string; status: string; vendorId: string | null } },
    subStatus: 'REFUNDED' | 'REJECTED',
    changedBy: string,
  ): Promise<boolean> {
    // [REPORT-006 F-006-02/05] One Order-locked transaction: live lifecycle +
    // payment-rail authority come from the LOCKED row (never the caller's
    // preview — a capture or cancellation committing after the preview is
    // seen here), the line CAS picks exactly one winner, and money, float,
    // stock + its audit row, and the status log commit together. The old
    // shape released float and restocked AFTER commit — a crash there could
    // never heal because the idempotent early-return skips closed lines.
    const closed = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${line.order.id} FOR UPDATE`;
      const ord = await tx.order.findUniqueOrThrow({
        where: { id: line.order.id },
        select: {
          status: true, paymentMethod: true, riderId: true,
          subtotalBase: true, subtotalCustomer: true, totalAmount: true,
        },
      });
      if (!PICKABLE_STATES.includes(ord.status)) {
        throw new AppError(409, 'NOT_PICKABLE', `The pick list is closed once the order is ${ord.status}`);
      }
      assertMmgMoneyAdjustable(ord);

      // Floor the order totals at 0. On a discounted order the stored discount
      // can equal (or exceed) a line's share, so decrementing by the FULL line
      // total would drive subtotal/total negative — "the platform owes the
      // customer", nonsensical for a cash handover. The substitution sibling
      // throws (it has an alternative); a refund must always succeed, so we
      // CLAMP the decrement per field instead of blocking it.
      const lineTotal = Number(line.totalCustomer);
      const decBase = Math.min(lineTotal, Number(ord.subtotalBase));
      const decCustomer = Math.min(lineTotal, Number(ord.subtotalCustomer));
      const decTotal = Math.min(lineTotal, Number(ord.totalAmount));

      // [REPORT-005 F-005-02] Exactly-one close: the line update is a CAS on
      // the caller's observed subStatus. A lost race exits before any money,
      // float, stock, or socket effect.
      const cas = await tx.orderItem.updateMany({
        where: { id: line.id, subStatus: line.subStatus, picked: false },
        data: { subStatus, substituteItemId: null, substituteName: null, substitutePrice: null },
      });
      if (cas.count === 0) return false;
      await tx.order.update({
        where: { id: line.order.id },
        data: {
          subtotalBase: { decrement: decBase },
          subtotalCustomer: { decrement: decCustomer },
          totalAmount: { decrement: decTotal },
        },
      });
      await tx.orderStatusLog.create({
        data: { orderId: line.order.id, status: ord.status as PickableStatus, changedBy, note: `Line ${subStatus.toLowerCase()}: ${line.name}` },
      });
      // Keep a CASH rider's committed float in sync with the subtotal it
      // fronts: this close shrinks subtotalBase by decBase, and the terminal
      // release later unwinds only the REDUCED subtotal — without releasing
      // the delta now, committedFloat stays perma-leaked.
      if (ord.paymentMethod === 'CASH' && ord.riderId && decBase > 0) {
        await new FloatService(tx).release(tx, ord.riderId, decBase);
      }
      // [REPORT-007-v4 F-04] The goods reserved by an APPROVED substitution
      // are the SUBSTITUTE units (the original went back on the shelf at
      // approval) — refunding that line must return the substitute, or the
      // original is restocked twice while the substitute strands decremented
      // (possibly auto-hidden at zero) with the wrong RETURN audit row.
      const restockItemId = line.subStatus === 'APPROVED' ? line.substituteItemId : line.itemId;
      await this.restockLine({ itemId: restockItemId, quantity: line.quantity }, subStatus.toLowerCase(), tx);
      return true;
    });
    if (!closed) return false;
    this.emitPickState(line.order.vendorId, line.order.id, line.id, { subStatus });
    this.io.to(`order:${line.order.id}`).emit('order:substitution', { orderId: line.order.id, lineId: line.id, status: subStatus });
    return true;
  }

  /** Put a line's units back on the shelf (tracked items only) + log it. */
  private async restockLine(
    line: { itemId: string | null; quantity: number },
    note: string,
    db: Prisma.TransactionClient | PrismaClient = this.prisma,
  ) {
    if (!line.itemId) return;
    const restocked = await db.item.updateMany({
      where: { id: line.itemId, stockQuantity: { not: null } },
      data: { stockQuantity: { increment: line.quantity } },
    });
    if (restocked.count > 0) {
      await db.item.updateMany({
        where: { id: line.itemId, autoHiddenAt: { not: null }, stockQuantity: { gt: 0 } },
        data: { isAvailable: true, autoHiddenAt: null },
      });
      await db.stockAdjustment.create({
        data: { itemId: line.itemId, delta: line.quantity, reason: 'RETURN', note: `picking: ${note}` },
      });
    }
  }

  private emitPickState(vendorId: string | null, orderId: string, lineId: string, patch: object) {
    if (vendorId) this.io.to(`vendor:${vendorId}`).emit('order:pick_state', { orderId, lineId, ...patch });
  }
}
