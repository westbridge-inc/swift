import type { PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotificationService } from '../notification/notification.service';
import { AppError, NotFoundError } from '../../utils/errors';

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
// ---------------------------------------------------------------------------

/** Order states where the pick list is editable by the vendor. */
const PICKABLE_STATES = [
  'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
  'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
];

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
      include: { order: { select: { id: true, status: true, customerId: true, orderNumber: true, vendorId: true } } },
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
    if (line.subStatus === 'PENDING') {
      throw new AppError(409, 'SUBSTITUTION_OPEN', 'Resolve the substitution before picking this line');
    }
    if (line.subStatus === 'REFUNDED' || line.subStatus === 'REJECTED') {
      throw new AppError(409, 'LINE_CLOSED', 'This line was refunded — nothing to pick');
    }
    const updated = await this.prisma.orderItem.update({ where: { id: lineId }, data: { picked } });
    this.emitPickState(line.order.vendorId, orderId, lineId, { picked });
    return updated;
  }

  /**
   * Out of stock → propose a substitute. Only items from the SAME vendor and
   * (when the original declares one) the same substitutionGroup qualify — the
   * customer decides, live.
   */
  async proposeSubstitution(orderId: string, lineId: string, substituteItemId: string, changedBy: string) {
    const line = await this.getLine(orderId, lineId);
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

    const updated = await this.prisma.orderItem.update({
      where: { id: lineId },
      data: {
        subStatus: 'PENDING',
        substituteItemId,
        substituteName: substitute.name,
        substitutePrice: substitute.basePrice,
      },
    });

    await this.prisma.orderStatusLog.create({
      data: { orderId, status: line.order.status as any, changedBy, note: `Substitution proposed: ${line.name} → ${substitute.name}` },
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
    return updated;
  }

  /** No substitute possible → refund the line: totals shrink, stock returns. */
  async refundLine(orderId: string, lineId: string, changedBy: string) {
    const line = await this.getLine(orderId, lineId);
    if (line.picked) throw new AppError(409, 'ALREADY_PICKED', 'This line is already picked');
    if (line.subStatus === 'REFUNDED') return line;

    await this.closeLine(line, 'REFUNDED', changedBy);
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: `${line.name} removed from your order`,
      body: `It's out of stock at the store. Order #${line.order.orderNumber}'s total went down by $${Number(line.totalCustomer).toLocaleString()}.`,
      data: { orderId, kind: 'line_refunded', lineId },
    });
    return this.prisma.orderItem.findUnique({ where: { id: lineId } });
  }

  /** The customer's verdict on a pending substitution. */
  async decideSubstitution(orderId: string, lineId: string, customerId: string, approve: boolean) {
    const line = await this.prisma.orderItem.findFirst({
      where: { id: lineId, orderId, order: { customerId } },
      include: { order: { select: { id: true, status: true, customerId: true, orderNumber: true, vendorId: true } } },
    });
    if (!line) throw new NotFoundError('Order line', lineId);
    if (line.subStatus !== 'PENDING') {
      throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
    }

    if (!approve) {
      await this.closeLine(line, 'REJECTED', customerId);
      return this.prisma.orderItem.findUnique({ where: { id: lineId } });
    }

    // Approve: the line BECOMES the substitute — name/price swap, totals move
    // by the price difference × qty. Stock: substitute decrements (guarded,
    // oversell-impossible), the original goes back on the shelf.
    const substitutePrice = Number(line.substitutePrice ?? 0);
    const newLineTotal = substitutePrice * line.quantity;
    const delta = newLineTotal - Number(line.totalCustomer);

    // A substitute may reduce a line's price but must NEVER drive the ORDER total
    // below zero. On a discounted order a free/cheap substitute could otherwise
    // invert the total into "the platform owes the customer" (cash handover would
    // be nonsensical). Guard before any stock/restock side-effects.
    const ord = await this.prisma.order.findUnique({ where: { id: orderId }, select: { totalAmount: true } });
    if (ord && Number(ord.totalAmount) + delta < 0) {
      throw new AppError(400, 'SUBSTITUTE_NEGATIVE_TOTAL', 'That substitute would drop the order total below zero — refund the line instead.');
    }

    if (line.substituteItemId) {
      const sub = await this.prisma.item.findUnique({
        where: { id: line.substituteItemId },
        select: { stockQuantity: true },
      });
      if (sub?.stockQuantity != null) {
        // Same conditional-decrement guard as checkout: overselling impossible.
        const decremented = await this.prisma.item.updateMany({
          where: { id: line.substituteItemId, stockQuantity: { gte: line.quantity } },
          data: { stockQuantity: { decrement: line.quantity } },
        });
        if (decremented.count === 0) {
          throw new AppError(409, 'SUBSTITUTE_OUT_OF_STOCK', 'The substitute just sold out — ask the store to pick another');
        }
        // Mirror the inventory engine: hitting zero auto-hides from browse.
        await this.prisma.item.updateMany({
          where: { id: line.substituteItemId, stockQuantity: { lte: 0 }, isAvailable: true },
          data: { isAvailable: false, autoHiddenAt: new Date() },
        });
      }
    }
    await this.restockLine(line, 'customer approved substitution');

    await this.prisma.$transaction([
      this.prisma.orderItem.update({
        where: { id: lineId },
        data: {
          subStatus: 'APPROVED',
          picked: false, // staff still has to shelf-pick the substitute
          name: `${line.substituteName} (sub for ${line.name})`,
          basePrice: substitutePrice,
          markedUpPrice: substitutePrice,
          totalBase: newLineTotal,
          totalCustomer: newLineTotal,
        },
      }),
      this.prisma.order.update({
        where: { id: orderId },
        data: {
          subtotalBase: { increment: delta },
          subtotalCustomer: { increment: delta },
          totalAmount: { increment: delta },
        },
      }),
      this.prisma.orderStatusLog.create({
        data: { orderId, status: line.order.status as any, changedBy: customerId, note: `Substitution approved: ${line.substituteName}` },
      }),
    ]);

    this.emitPickState(line.order.vendorId, orderId, lineId, { subStatus: 'APPROVED' });
    return this.prisma.orderItem.findUnique({ where: { id: lineId } });
  }

  /** Shared close-out for refund/reject: totals shrink, stock returns. */
  private async closeLine(
    line: { id: string; itemId: string | null; name: string; quantity: number; totalCustomer: unknown; order: { id: string; status: string; vendorId: string | null } },
    subStatus: 'REFUNDED' | 'REJECTED',
    changedBy: string,
  ) {
    const lineTotal = Number(line.totalCustomer);
    await this.prisma.$transaction([
      this.prisma.orderItem.update({ where: { id: line.id }, data: { subStatus, substituteItemId: null, substituteName: null, substitutePrice: null } }),
      this.prisma.order.update({
        where: { id: line.order.id },
        data: {
          subtotalBase: { decrement: lineTotal },
          subtotalCustomer: { decrement: lineTotal },
          totalAmount: { decrement: lineTotal },
        },
      }),
      this.prisma.orderStatusLog.create({
        data: { orderId: line.order.id, status: line.order.status as any, changedBy, note: `Line ${subStatus.toLowerCase()}: ${line.name}` },
      }),
    ]);
    await this.restockLine(line, subStatus.toLowerCase());
    this.emitPickState(line.order.vendorId, line.order.id, line.id, { subStatus });
    this.io.to(`order:${line.order.id}`).emit('order:substitution', { orderId: line.order.id, lineId: line.id, status: subStatus });
  }

  /** Put a line's units back on the shelf (tracked items only) + log it. */
  private async restockLine(line: { itemId: string | null; quantity: number }, note: string) {
    if (!line.itemId) return;
    const restocked = await this.prisma.item.updateMany({
      where: { id: line.itemId, stockQuantity: { not: null } },
      data: { stockQuantity: { increment: line.quantity } },
    });
    if (restocked.count > 0) {
      await this.prisma.item.updateMany({
        where: { id: line.itemId, autoHiddenAt: { not: null }, stockQuantity: { gt: 0 } },
        data: { isAvailable: true, autoHiddenAt: null },
      });
      await this.prisma.stockAdjustment.create({
        data: { itemId: line.itemId, delta: line.quantity, reason: 'RETURN', note: `picking: ${note}` },
      });
    }
  }

  private emitPickState(vendorId: string | null, orderId: string, lineId: string, patch: object) {
    if (vendorId) this.io.to(`vendor:${vendorId}`).emit('order:pick_state', { orderId, lineId, ...patch });
  }
}
