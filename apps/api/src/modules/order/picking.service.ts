import { emitToOrderRoom, emitToStoreRoom } from './order-room-emission.service';
import type { Prisma, PrismaClient, SubstitutionStatus } from '@prisma/client';
import type { Server } from 'socket.io';
import { NotificationService } from '../notification/notification.service';
import { FloatService } from '../dispatch/float.service';
import { AppError, NotFoundError } from '../../utils/errors';
import { applyStockMovement, lockItemsInIdOrder } from '../inventory/stock';
import { hideSoldOut } from '../inventory/system-item-writes';
import { assertMmgFulfilmentAllowed } from './order.service';
import { mmgClaimLockObserver } from './mmg-claim.service';
import { substitutionLineChange, substitutionDecideMinutes, substitutionNoAnswer, orderTotalAdjustable, isRemovalQuestion, totalFixedCopy, ONLY_ITEM_LEFT_COPY, PICK_ALIVE_WHERE, type AdjustableOrder } from './substitution-view';
import { storeTeam, ringRecipients } from '../notification/store-team';
import { hiddenAmong, unhideRestocked } from '../compliance/prohibited-gate';
import { recomputeOrderVat } from '../store-vat/order-vat';

/** [REPORT-006 F-006-02] MMG order money is immutable in-app — ANY payment
 *  status. CAPTURED is money the store already received; PENDING is only the
 *  absence of the store's attestation, not proof the customer's external
 *  transfer didn't happen (same doctrine as the conversion block). Until a
 *  durable vendor-refund/adjustment obligation ledger exists (founder-gated),
 *  every picking operation that would rewrite an MMG total fails closed.
 *  Same-price substitutions pass (no money effect); CASH orders pass (the
 *  door handover collects the adjusted amount). */
function assertMmgMoneyAdjustable(order: AdjustableOrder): void {
  // [O-4 · owner 22 Oct 2026] Before the store accepts, no MMG payment can exist
  // yet (the store's number shows only after acceptance; no pay link, no claim):
  // the total may still change, and the customer pays only the total they
  // confirmed. orderTotalAdjustable decides it; an unprojected fact fails closed.
  // [REVIEW-M S4-1 on #2043] The same rule on every rail but cash (card, bank
  // transfer: prepaid, both OFF today). The code stays MMG_ADJUSTMENT_UNAVAILABLE
  // (what clients already handle); the words fit the rail.
  if (orderTotalAdjustable(order)) return;
  throw new AppError(
    409,
    'MMG_ADJUSTMENT_UNAVAILABLE',
    totalFixedCopy(order),
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

/** Order states where the pick list is editable by the vendor.
 *  [O-4 · owner 22 Oct 2026] PENDING too: BEFORE accepting, the store marks a
 *  line "Out of stock" (a swap or a removal question the customer answers);
 *  ticking a line still waits for the accept (setPicked). */
const PICKABLE_STATES = [
  'PENDING',
  'ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP',
  'RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP',
];

/** [O-4] The order facts orderTotalAdjustable and the MMG gate read, projected
 *  wherever a pick-list write decides on money. */
const ADJUSTABLE_SELECT = {
  status: true, paymentMethod: true, paymentStatus: true, orderType: true, mmgClaimMismatchAt: true,
  acceptedAt: true, mmgAttestedRef: true, customerMmgClaim: true, mmgPayUrlSnapshot: true,
} as const;

/** The line + order facts every vendor pick-list action reads first. */
const LINE_INCLUDE = {
  order: { select: { ...ADJUSTABLE_SELECT, id: true, customerId: true, orderNumber: true, vendorId: true, totalAmount: true } },
} as const;
type PickLine = Prisma.OrderItemGetPayload<{ include: typeof LINE_INCLUDE }>;

/** [O-4] Before acceptance a question is part of the store's answer to the
 *  order (the un-gated ACCEPTED step of the MMG gate); after it, preparation. */
const questionGateTarget = (status: string) => (status === 'PENDING' ? 'ACCEPTED' : 'PREPARING') as 'ACCEPTED' | 'PREPARING';

/** [O-4] A pre-accept question keeps its decision instant on the line
 *  (substituteDecideBy), so the store's response clock restarts from the
 *  customer's answer (autoCancelUnresponsiveOrder, vendorRespondBy). After
 *  acceptance the field is cleared on close, as before. */
const closedQuestionStamp = (status: string, at: Date) => (status === 'PENDING' ? at : null);

type PickableStatus = import('@prisma/client').OrderStatus;

export class PickingService {
  private notifications: NotificationService;

  constructor(
    private prisma: PrismaClient,
    private io: Server,
    /** [O-4] The canonical seam, built by the caller WITH its Redis (offer withdrawal, census B4):
     *  needed only to cancel a waiting order whose only item got no answer. Without it that
     *  question stays open and the no-response clock ends the order (never removed into nothing). */
    private orderService?: Pick<import('./order.service').OrderService, 'transitionOrderAtomically'>,
  ) {
    this.notifications = new NotificationService(prisma, io);
  }

  /**
   * A line is SETTLED when nobody is still waiting on a decision about it:
   * it is picked, or its substitution question was closed by a refund or a
   * customer rejection.
   *
   * [W-28] Settled is not the same as FULFILLED, and conflating the two was
   * the defect. A refunded or rejected line has been removed from the order —
   * the money came off, the stock went back — so an order whose every line is
   * refused is settled on every line and contains nothing. It was still
   * markable ready, and went out for delivery: a rider dispatched to carry an
   * empty bag, a customer charged a delivery fee for it.
   */
  static lineResolved(line: { picked: boolean; subStatus: string }): boolean {
    // [O-4 · owner 22 Oct 2026] The store accepts the WHOLE order: a tick is a
    // tool, never a gate. A line is unsettled only while the customer is still
    // deciding on it (an open swap or removal question).
    return line.subStatus !== 'PENDING';
  }

  /** [W-28] A line is FULFILLED when something is actually going in the bag:
   *  [O-4] every line the store did not take off (ticked or not). */
  static lineFulfilled(line: { picked: boolean; subStatus: string }): boolean {
    return line.subStatus !== 'PENDING' && line.subStatus !== 'REFUNDED' && line.subStatus !== 'REJECTED';
  }

  /** Gate for Mark-ready on quantity-tracked stores: no open lines. */
  async unresolvedLines(orderId: string): Promise<number> {
    return (await this.readiness(orderId)).unresolved;
  }

  /**
   * [W-28] The readiness of an order as the SERVER sees it, in one read: how
   * many lines still need a decision, how many are actually being handed over,
   * and how many were removed. `ready` is the invariant the mark-ready route
   * enforces — every line settled AND at least one line fulfilled.
   */
  async readiness(orderId: string): Promise<{ total: number; unresolved: number; fulfilled: number; removed: number; ready: boolean }> {
    const lines = await this.prisma.orderItem.findMany({
      where: { orderId },
      select: { picked: true, subStatus: true },
    });
    const unresolved = lines.filter((l) => !PickingService.lineResolved(l)).length;
    const fulfilled = lines.filter((l) => PickingService.lineFulfilled(l)).length;
    return {
      total: lines.length,
      unresolved,
      fulfilled,
      removed: lines.length - unresolved - fulfilled,
      ready: unresolved === 0 && fulfilled > 0,
    };
  }

  private async getLine(orderId: string, lineId: string): Promise<PickLine> {
    const line = await this.prisma.orderItem.findFirst({
      where: { id: lineId, orderId },
      include: LINE_INCLUDE,
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
    // [O-4] Ticks belong to preparation: before the accept, a line is only ever
    // marked "Out of stock".
    if (line.order.status === 'PENDING') {
      throw new AppError(409, 'ACCEPT_FIRST', 'Accept the order first. Before accepting you can only mark an item out of stock.');
    }
    // [SPS-F-0016 / REPORT-004 F-004-05] Ticking a line IS preparing the order
    // — gated for unpaid MMG like every other affirmative prep action.
    // Unticking (corrective) stays open. This preview check only answers
    // early; the authority is the same gate on the LOCKED row below.
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
    // [ORDER-SPINE S1-6] And it commits under the order-row lock the direct-MMG
    // claim authority takes, with the MMG gate re-run on the locked row: a
    // customer's "I did not pay" committing after the preview is seen here.
    const updated = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockPickableOrder(tx, orderId);
      if (picked) assertMmgFulfilmentAllowed(order, 'PREPARING');
      return tx.orderItem.updateMany({
        where: {
          id: lineId,
          orderId,
          subStatus: { notIn: ['PENDING', 'REFUNDED', 'REJECTED'] },
          order: { status: { in: PICKABLE_STATES.filter((st) => st !== 'PENDING') as PickableStatus[] } },
        },
        data: { picked },
      });
    });
    if (updated.count === 0) {
      throw new AppError(409, 'NOT_PICKABLE', 'This line just changed — refresh the order');
    }
    this.emitPickState(line.order.vendorId, orderId, lineId, { picked });
    return this.prisma.orderItem.findUnique({ where: { id: lineId } });
  }

  /**
   * [ORDER-SPINE S1-6] The fence an affirmative pick-list write commits under:
   * the SAME order-row lock the direct-MMG claim authority, cancellation and
   * the canonical transitions take, then the live row read through it. A
   * customer's denial either commits first — and the gate on this row refuses
   * — or waits for this write, which then preceded the dispute.
   */
  private async lockPickableOrder(tx: Prisma.TransactionClient, orderId: string) {
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: ADJUSTABLE_SELECT,
    });
    if (!order) throw new NotFoundError('Order', orderId);
    await mmgClaimLockObserver.afterLock?.({ orderId, actor: 'PICK' });
    if (!PICKABLE_STATES.includes(order.status)) {
      throw new AppError(409, 'NOT_PICKABLE', `The pick list is closed once the order is ${order.status}`);
    }
    return order;
  }

  /**
   * Out of stock → propose a substitute. Only items from the SAME vendor and
   * (when the original declares one) the same substitutionGroup qualify — the
   * customer decides, live.
   */
  async proposeSubstitution(orderId: string, lineId: string, substituteItemId: string, changedBy: string) {
    const line = await this.getLine(orderId, lineId);
    // [SPS-F-0016] Proposing a substitute is affirmative preparation — gated.
    // (Early answer only; the authority is the gate on the locked row below.)
    // [O-4] Before the accept it is part of the store's answer (ACCEPTED gate).
    assertMmgFulfilmentAllowed(line.order, questionGateTarget(line.order.status));
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
    // [GUARDRAILS §8] A substitution never puts a prohibited item on an order.
    if ((await hiddenAmong(this.prisma, [substitute.id])).size > 0) {
      throw new AppError(409, 'SUBSTITUTE_UNAVAILABLE', 'That substitute isn\'t available on Swift');
    }
    if (original?.substitutionGroup && substitute.substitutionGroup !== original.substitutionGroup) {
      throw new AppError(400, 'WRONG_GROUP', 'Substitutes must come from the same substitution group');
    }
    // [SUBSTITUTION · owner 17 Oct] A question nobody can ever answer is never
    // asked. An MMG total can't change in-app, so on MMG a swap at a different
    // price could be neither approved nor declined (both rewrite the total) and
    // the order would wait forever. Only a same-price swap may be proposed
    // there; the store settles anything else with the customer directly.
    // (Early answer; the authority is the same check on the locked row below.)
    const priceChange = substitutionLineChange({
      substitutePrice: substitute.basePrice, quantity: line.quantity, totalCustomer: line.totalCustomer,
    }).delta;
    if (priceChange !== 0) assertMmgMoneyAdjustable(line.order);
    // [SUBSTITUTION] The wait is bounded: past decideBy the sweep removes the
    // line (never a silent swap) or, on MMG, withdraws the question.
    const decideMinutes = substitutionDecideMinutes();
    const decideBy = new Date(Date.now() + decideMinutes * 60_000);

    // [REPORT-006 F-006-05 · ORDER-SPINE S1-6] Proposing a substitute is
    // affirmative preparation: the MMG gate runs on the LOCKED order row, and
    // the proposal commits with its status-log evidence under that lock, bound
    // to live lifecycle and line state. A cancellation or a customer's "I did
    // not pay" committing after the preview leaves nothing to propose on.
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockPickableOrder(tx, orderId);
      assertMmgFulfilmentAllowed(order, questionGateTarget(order.status));
      if (priceChange !== 0) assertMmgMoneyAdjustable(order);
      const updated = await tx.orderItem.updateMany({
        where: {
          id: lineId,
          orderId,
          subStatus: 'NONE',
          picked: false,
          order: { status: { in: PICKABLE_STATES as PickableStatus[] } },
        },
        data: {
          subStatus: 'PENDING',
          substituteItemId,
          substituteName: substitute.name,
          substitutePrice: substitute.basePrice,
          substituteDecideBy: decideBy,
        },
      });
      if (updated.count === 0) {
        throw new AppError(409, 'SUBSTITUTION_EXISTS', 'This line just changed — refresh the order');
      }
      await tx.orderStatusLog.create({
        data: { orderId, status: order.status as PickableStatus, changedBy, note: `Substitution proposed: ${line.name} → ${substitute.name}` },
      });
    });
    // Only the committed winner speaks.
    await emitToOrderRoom(this.prisma, this.io, orderId, 'order:substitution', {
      orderId,
      lineId,
      originalName: line.name,
      substituteName: substitute.name,
      substitutePrice: Number(substitute.basePrice),
      quantity: line.quantity,
      status: 'PENDING',
      decideBy: decideBy.toISOString(),
    });
    // [SUBSTITUTION] The push says how long the question waits and what
    // happens without an answer, in words true on every build.
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: `${line.name} is out of stock`,
      body: substitutionNoAnswer(line.order) === 'REMOVE'
        ? `The store suggests ${substitute.name} instead for order #${line.order.orderNumber}. Approve or decline it in the app within ${decideMinutes} minutes. If you don't answer, it comes off your order and your total goes down.`
        : `The store suggests ${substitute.name} instead for order #${line.order.orderNumber}. If it isn't approved in the app within ${decideMinutes} minutes, the store settles this item with you directly.`,
      data: { orderId, kind: 'substitution_pending', lineId },
    });
    return this.prisma.orderItem.findUnique({ where: { id: lineId } });
  }

  /** No substitute possible → refund the line: totals shrink, stock returns.
   *  [O-4] Before the store accepts, the line is not removed yet: the CUSTOMER
   *  is asked (askRemoval) — continue without it, or cancel the order. */
  async refundLine(orderId: string, lineId: string, changedBy: string) {
    const line = await this.getLine(orderId, lineId);
    if (line.order.status === 'PENDING') return this.askRemoval(line, changedBy);
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

  /**
   * [O-4 · owner 22 Oct 2026] "Out of stock" with nothing to swap, BEFORE the
   * store accepts. Consumer protection: the customer agrees to the changed
   * order before paying. So the line becomes an open question with nothing
   * proposed (subStatus PENDING, no substitute): "Continue without it" removes
   * it (the server lowers the total), "Cancel order" is the free cancel a
   * waiting order already has. No answer by decideBy = removed (the safe
   * default the swap question already uses: the total only goes down). The
   * store accepts the rest after the answer (the accept refuses while a
   * question is open). Same lock, gates and evidence as a swap proposal.
   */
  private async askRemoval(line: PickLine, changedBy: string) {
    const orderId = line.order.id;
    if (line.subStatus === 'REFUNDED' || line.subStatus === 'REJECTED') return line;
    if (line.subStatus !== 'NONE') {
      throw new AppError(409, 'CUSTOMER_DECIDING', `The customer is still deciding about ${line.name}. Wait for the answer, or reject the order.`);
    }
    assertMmgFulfilmentAllowed(line.order, 'ACCEPTED');
    assertMmgMoneyAdjustable(line.order);
    const decideMinutes = substitutionDecideMinutes();
    const decideBy = new Date(Date.now() + decideMinutes * 60_000);
    await this.prisma.$transaction(async (tx) => {
      const order = await this.lockPickableOrder(tx, orderId);
      if (order.status !== 'PENDING') {
        throw new AppError(409, 'LINE_CHANGED', 'This order just changed — refresh it');
      }
      assertMmgFulfilmentAllowed(order, 'ACCEPTED');
      assertMmgMoneyAdjustable(order);
      // [O-4 · COORD 03:34Z, the shared last-item rule] The only item left (every other line off or
      // on its way off): there is nothing to continue with, so the store rejects the order instead.
      const alive = await tx.orderItem.count({ where: { orderId, id: { not: line.id }, ...PICK_ALIVE_WHERE } });
      if (alive === 0) {
        throw new AppError(409, 'REJECT_INSTEAD', `${line.name} is the only item left on this order. Reject the order instead, with the reason "Out of stock".`);
      }
      const asked = await tx.orderItem.updateMany({
        where: { id: line.id, orderId, subStatus: 'NONE', picked: false, order: { status: 'PENDING' } },
        data: { subStatus: 'PENDING', substituteItemId: null, substituteName: null, substitutePrice: null, substituteDecideBy: decideBy },
      });
      if (asked.count === 0) {
        throw new AppError(409, 'LINE_CHANGED', 'This line just changed — refresh the order');
      }
      await tx.orderStatusLog.create({
        data: { orderId, status: 'PENDING', changedBy, note: `Out of stock, customer asked: ${line.name}` },
      });
    });
    this.emitPickState(line.order.vendorId, orderId, line.id, { subStatus: 'PENDING' });
    await emitToOrderRoom(this.prisma, this.io, orderId, 'order:substitution', {
      orderId, lineId: line.id, originalName: line.name, substituteName: null, substitutePrice: null,
      quantity: line.quantity, status: 'PENDING', kind: 'REMOVAL', decideBy: decideBy.toISOString(),
    });
    const lower = Math.min(Number(line.totalCustomer), Number(line.order.totalAmount));
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: `${line.name} is out of stock`,
      body: `The store can't supply ${line.name} for order #${line.order.orderNumber}. In the app, continue without it (your total goes down by $${lower.toLocaleString()}) or cancel the order, within ${decideMinutes} minutes. If you don't answer, it comes off your order and your total goes down.`,
      data: { orderId, kind: 'substitution_pending', lineId: line.id },
    });
    return this.prisma.orderItem.findUnique({ where: { id: line.id } });
  }

  /** The customer's verdict on a pending substitution. */
  async decideSubstitution(orderId: string, lineId: string, customerId: string, approve: boolean) {
    const line = await this.prisma.orderItem.findFirst({
      where: { id: lineId, orderId, order: { customerId } },
      include: { order: { select: {
        ...ADJUSTABLE_SELECT,
        id: true, customerId: true, orderNumber: true, vendorId: true,
      } } },
    });
    if (!line) throw new NotFoundError('Order line', lineId);
    if (line.subStatus !== 'PENDING') {
      throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
    }

    // [O-4] A removal question (nothing proposed): "Continue without it" is the
    // yes — the line comes off and the total goes down. Its other answer is
    // "Cancel order" (the free cancel of a waiting order), never a decline here.
    if (isRemovalQuestion(line)) {
      if (!approve) {
        throw new AppError(409, 'CANCEL_INSTEAD', 'To keep this item you can cancel the order instead: nothing has been charged.');
      }
      assertMmgMoneyAdjustable(line.order);
      const closed = await this.closeLine(line, 'REFUNDED', customerId, { note: `Customer continued without: ${line.name}`, requireOthersLeft: true });
      if (closed) {
        await this.tellStoreTheCustomerAnswered(line.order, `${line.name}: the customer continues without it`);
        return this.prisma.orderItem.findUnique({ where: { id: lineId } });
      }
      const finalLine = await this.prisma.orderItem.findUnique({ where: { id: lineId } });
      if (finalLine && (finalLine.subStatus === 'REFUNDED' || finalLine.subStatus === 'REJECTED')) return finalLine;
      throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
    }

    if (!approve) {
      // A rejection ALSO rewrites totals (closeLine decrements the line) — on
      // MMG that is an unrecorded refund [F-006-02]. Preview fail-fast; the
      // locked transaction inside closeLine re-asserts from the live row.
      assertMmgMoneyAdjustable(line.order);
      const closed = await this.closeLine(line, 'REJECTED', customerId, { requireOthersLeft: true });
      if (closed) {
        await this.tellStoreTheCustomerAnswered(line.order, `${line.name}: the customer declined the swap, so it comes off`);
        return this.prisma.orderItem.findUnique({ where: { id: lineId } });
      }
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
          ...ADJUSTABLE_SELECT,
          id: true, riderId: true, totalAmount: true, vendorId: true,
        },
      });
      if (!order) throw new NotFoundError('Order', orderId);
      if (!PICKABLE_STATES.includes(order.status)) {
        throw new AppError(409, 'NOT_PICKABLE', `The pick list is closed once the order is ${order.status}`);
      }
      assertMmgFulfilmentAllowed(order, questionGateTarget(order.status));

      const fresh = await tx.orderItem.findFirst({ where: { id: lineId, orderId } });
      if (!fresh || fresh.subStatus !== 'PENDING') {
        throw new AppError(409, 'NOT_PENDING', 'There is no open substitution on this line');
      }
      // [GUARDRAILS §8 · DS1106 S2] The substitute is judged again at the customer's yes, under the
      // order lock: a person may have removed it, or its words changed, since the store proposed it.
      if (fresh.substituteItemId && (await hiddenAmong(tx, [fresh.substituteItemId])).size > 0) {
        throw new AppError(409, 'SUBSTITUTE_UNAVAILABLE', 'That substitute isn\'t available on Swift');
      }

      const substitutePrice = Number(fresh.substitutePrice ?? 0);
      // [L09 · M028] The one formula, also what the customer was shown before
      // deciding (substitution-view.ts): the substitute's price × quantity
      // replaces the line's total, paid options included.
      const { newLineTotal, delta } = substitutionLineChange(fresh);

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
          substituteDecideBy: closedQuestionStamp(order.status, new Date()),
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
      // [STORE-VAT] On an order that froze VAT, the line now carries the SUBSTITUTE's VAT class (read now, at the
      // customer's yes). A substitute with no item row keeps the line's class.
      if (fresh.vatClass != null && fresh.substituteItemId) {
        const subClass = await tx.item.findUnique({ where: { id: fresh.substituteItemId }, select: { vatClass: true } });
        if (subClass) await tx.orderItem.update({ where: { id: lineId }, data: { vatClass: subClass.vatClass } });
      }

      // Two items move here (the substitute off the shelf, the original back):
      // lock them in id order first, as every multi-item stock path does.
      await lockItemsInIdOrder(tx, [fresh.substituteItemId, fresh.itemId]);
      if (fresh.substituteItemId) {
        const sub = await tx.item.findUnique({
          where: { id: fresh.substituteItemId },
          select: { stockQuantity: true },
        });
        if (sub?.stockQuantity != null) {
          // [MKT-2] Through the single writer — same conditional guard, now with
          // a ledger row. A substitution moves real goods off a real shelf, so
          // it is a movement like any other.
          try {
            await applyStockMovement(tx, {
              itemId: fresh.substituteItemId,
              delta: -fresh.quantity,
              reason: 'PICK',
              orderId: fresh.orderId,
              note: 'Substitute picked',
            });
          } catch {
            throw new AppError(409, 'SUBSTITUTE_OUT_OF_STOCK', 'The substitute just sold out — ask the store to pick another');
          }
          // Mirror the inventory engine: hitting zero auto-hides from browse. [RETIER · REVIEW-M #2259 S4-1] The
          // picker's substitution hid it, not the store: items."updatedAt" stays put.
          await hideSoldOut(tx, fresh.substituteItemId);
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
      // [STORE-VAT] The VAT inside the goods follows the goods (a no-op on an order without VAT).
      await recomputeOrderVat(tx, orderId);

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
    await this.tellStoreTheCustomerAnswered(line.order, `${line.name}: the customer approved the swap`);
    return this.prisma.orderItem.findUnique({ where: { id: lineId } });
  }

  /** Shared close-out for refund/reject: totals shrink, stock returns.
   *  Returns true only for the CAS winner — callers publish nothing on false. */
  private async closeLine(
    line: { id: string; itemId: string | null; substituteItemId: string | null; name: string; quantity: number; totalCustomer: unknown; subStatus: SubstitutionStatus; order: { id: string; status: string; vendorId: string | null } },
    subStatus: 'REFUNDED' | 'REJECTED',
    changedBy: string,
    opts: { note?: string; decidedBefore?: Date; requireOthersLeft?: boolean } = {},
  ): Promise<false | { decTotal: number }> {
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
          ...ADJUSTABLE_SELECT,
          riderId: true,
          subtotalBase: true, subtotalCustomer: true, totalAmount: true,
        },
      });
      if (!PICKABLE_STATES.includes(ord.status)) {
        throw new AppError(409, 'NOT_PICKABLE', `The pick list is closed once the order is ${ord.status}`);
      }
      assertMmgMoneyAdjustable(ord);
      // [O-4 · REVIEW-F S3-1] On a waiting order a customer's answer never empties it: the only
      // item left is not removed by "continue" or a declined swap (the customer cancels instead).
      // Decided on the LOCKED rows: two answers racing on the last two lines cannot both remove.
      if (opts.requireOthersLeft && ord.status === 'PENDING') {
        const others = await tx.orderItem.count({ where: { orderId: line.order.id, id: { not: line.id }, ...PICK_ALIVE_WHERE } });
        if (others === 0) throw new AppError(409, 'ONLY_ITEM_LEFT', ONLY_ITEM_LEFT_COPY);
      }

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
        where: {
          id: line.id, subStatus: line.subStatus, picked: false,
          // [SUBSTITUTION] The deadline sweep removes only a question whose
          // wait is over on the row it writes, not on the row it read.
          ...(opts.decidedBefore ? { substituteDecideBy: { lte: opts.decidedBefore } } : {}),
        },
        data: { subStatus, substituteItemId: null, substituteName: null, substitutePrice: null, substituteDecideBy: closedQuestionStamp(ord.status, new Date()) },
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
      // [STORE-VAT] A removed line carries no VAT any more (a no-op on an order without VAT).
      await recomputeOrderVat(tx, line.order.id);
      await tx.orderStatusLog.create({
        data: { orderId: line.order.id, status: ord.status as PickableStatus, changedBy, note: opts.note ?? `Line ${subStatus.toLowerCase()}: ${line.name}` },
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
      await this.restockLine({ itemId: restockItemId, quantity: line.quantity, orderId: line.order.id }, subStatus.toLowerCase(), tx);
      return { decTotal };
    });
    if (!closed) return false;
    this.emitPickState(line.order.vendorId, line.order.id, line.id, { subStatus });
    await emitToOrderRoom(this.prisma, this.io, line.order.id, 'order:substitution', { orderId: line.order.id, lineId: line.id, status: subStatus });
    return closed;
  }

  /**
   * [SUBSTITUTION · owner 17 Oct 2026] A swap question past its deadline.
   * The SAFE default, never a silent swap: the line is REMOVED — it comes off
   * the order, the total drops (clamped like any removal), stock returns, the
   * customer is told, and the store can carry on. On MMG, where the total can't
   * change in-app, the question is WITHDRAWN instead: the line is back to the
   * store as it was, and the customer is told the store settles it directly.
   * A question opened before deadlines existed gets a full wait from now.
   * Every write is a compare-and-set on the open question, so a customer's
   * answer or a store's removal landing first wins and this does nothing.
   */
  async expireSubstitution(lineId: string, now: Date = new Date()): Promise<'removed' | 'withdrawn' | 'started' | 'cancelled' | 'skipped'> {
    const line = await this.prisma.orderItem.findFirst({
      where: { id: lineId, subStatus: 'PENDING', picked: false },
      include: { order: { select: { ...ADJUSTABLE_SELECT, id: true, customerId: true, orderNumber: true, vendorId: true } } },
    });
    if (!line || !PICKABLE_STATES.includes(line.order.status)) return 'skipped';
    const removal = isRemovalQuestion(line);
    if (!line.substituteDecideBy) {
      const started = await this.prisma.orderItem.updateMany({
        where: { id: line.id, subStatus: 'PENDING', picked: false, substituteDecideBy: null },
        data: { substituteDecideBy: new Date(now.getTime() + substitutionDecideMinutes() * 60_000) },
      });
      return started.count > 0 ? 'started' : 'skipped';
    }
    if (line.substituteDecideBy.getTime() > now.getTime()) return 'skipped';
    const changedBy = 'system:substitution-expiry';

    if (substitutionNoAnswer(line.order) === 'WITHDRAW') {
      const withdrawn = await this.prisma.$transaction(async (tx) => {
        const order = await this.lockPickableOrder(tx, line.orderId);
        const cas = await tx.orderItem.updateMany({
          where: { id: line.id, subStatus: 'PENDING', picked: false, substituteDecideBy: { lte: now } },
          data: { subStatus: 'NONE', substituteItemId: null, substituteName: null, substitutePrice: null, substituteDecideBy: null },
        });
        if (cas.count === 0) return false;
        await tx.orderStatusLog.create({
          data: { orderId: line.orderId, status: order.status as PickableStatus, changedBy, note: removal ? `Out-of-stock question withdrawn, no answer in time: ${line.name}` : `Substitution withdrawn, no answer in time: ${line.name} → ${line.substituteName ?? 'substitute'}` },
        });
        return true;
      });
      if (!withdrawn) return 'skipped';
      this.emitPickState(line.order.vendorId, line.orderId, line.id, { subStatus: 'NONE' });
      await emitToOrderRoom(this.prisma, this.io, line.orderId, 'order:substitution', { orderId: line.orderId, lineId: line.id, status: 'NONE' });
      await this.notifications.send({
        userId: line.order.customerId,
        type: 'ORDER_UPDATE',
        title: removal ? `${line.name}: the question closed` : `${line.name}: the swap question closed`,
        body: removal
          ? `The store's question about ${line.name} on order #${line.order.orderNumber} got no answer in time. The store settles ${line.name} with you directly.`
          : `The store's swap question on order #${line.order.orderNumber} got no answer in time. The store settles ${line.name} with you directly.`,
        data: { orderId: line.orderId, lineId: line.id },
      });
      return 'withdrawn';
    }

    // [O-4 · REVIEW-F S3-1] The only item left on a waiting order: removing it would empty the
    // order, so no answer cancels it, free (a system cancellation: never the customer's fault).
    if (line.order.status === 'PENDING') {
      const others = await this.prisma.orderItem.count({ where: { orderId: line.orderId, id: { not: line.id }, ...PICK_ALIVE_WHERE } });
      if (others === 0) return this.cancelOnlyItemLeft(line, now);
    }
    const closed = await this.closeLine(line, 'REFUNDED', changedBy, {
      decidedBefore: now,
      note: removal ? `Line removed, no answer to the out-of-stock question in time: ${line.name}` : `Line removed, no answer to the swap in time: ${line.name}`,
    });
    if (!closed) return 'skipped';
    if (line.order.status === 'PENDING') await this.tellStoreTheCustomerAnswered(line.order, `${line.name}: no answer in time, so it came off`);
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: `${line.name} removed from your order`,
      body: removal
        ? `You didn't answer in time, so ${line.name} (out of stock) came off order #${line.order.orderNumber}. Your total went down by $${closed.decTotal.toLocaleString()}.`
        : `The store's swap question got no answer in time, so ${line.name} came off order #${line.order.orderNumber}. Your total went down by $${closed.decTotal.toLocaleString()}.`,
      data: { orderId: line.orderId, kind: 'line_refunded', lineId: line.id },
    });
    return 'removed';
  }

  /**
   * [O-4 · REVIEW-F S3-1] No answer about the only item left on a waiting order: the order can't
   * go ahead. One canonical locked PENDING -> CANCELLED, re-decided on the locked rows (the line is
   * still the open question past its deadline and nothing else is left), cancelledBy unset (never
   * counted against the customer). Nothing has been charged: before acceptance no payment exists
   * (an MMG order past that point was WITHDRAWN above, never cancelled here).
   */
  private async cancelOnlyItemLeft(
    line: { id: string; orderId: string; name: string; order: { customerId: string; orderNumber: string; vendorId: string | null } },
    now: Date,
  ): Promise<'cancelled' | 'skipped'> {
    if (!this.orderService) return 'skipped';
    const reason = `Out of stock: ${line.name} was the only item and the customer did not answer in time`;
    try {
      await this.orderService.transitionOrderAtomically({
        orderId: line.orderId,
        target: 'CANCELLED',
        allowedFrom: ['PENDING'],
        changedBy: null,
        note: reason,
        cancellation: { by: null, reason },
        releaseStaleMoverPointer: true,
        withinTransaction: async (tx) => {
          const still = await tx.orderItem.count({ where: { id: line.id, subStatus: 'PENDING', picked: false, substituteDecideBy: { lte: now } } });
          const others = await tx.orderItem.count({ where: { orderId: line.orderId, id: { not: line.id }, ...PICK_ALIVE_WHERE } });
          if (still === 0 || others > 0) throw new AppError(409, 'NOT_ONLY_ITEM_LEFT', 'The order changed; the question is handled the usual way');
        },
        invalidStatus: () => new AppError(409, 'NOT_ONLY_ITEM_LEFT', 'The order is no longer waiting'),
      });
    } catch (error) {
      if (error instanceof AppError && (error.code === 'NOT_ONLY_ITEM_LEFT' || error.code === 'NOT_FOUND')) return 'skipped';
      throw error;
    }
    await emitToOrderRoom(this.prisma, this.io, line.orderId, 'order:status_changed', { orderId: line.orderId, status: 'CANCELLED' });
    if (line.order.vendorId) await emitToStoreRoom(this.prisma, this.io, line.order.vendorId, 'order:status_changed', { orderId: line.orderId, status: 'CANCELLED' });
    await this.notifications.send({
      userId: line.order.customerId,
      type: 'ORDER_UPDATE',
      title: `Order #${line.order.orderNumber} cancelled`,
      body: `${line.name} is out of stock and was the only item on your order, so the order was cancelled. Nothing has been charged.`,
      data: { orderId: line.orderId, status: 'CANCELLED' },
    });
    return 'cancelled';
  }

  /** [O-4 · REVIEW-G S4-2 on #2043] Asking the customer before accepting answered the store's
   *  new-order alert. When the customer answers (or the question times out), the store team is
   *  told at once that the order can be accepted now. One push, no SMS ladder. */
  private async tellStoreTheCustomerAnswered(
    order: { id?: string; status: string; vendorId: string | null; orderNumber: string },
    what: string,
  ): Promise<void> {
    if (order.status !== 'PENDING' || !order.vendorId || !order.id) return;
    try {
      const team = await storeTeam(this.prisma, order.vendorId);
      if (!team || !team.ringing) return;
      // [REVIEW-F S4-1 on #2043] "Accept now" only when nothing is left to answer: never a tap the
      // server would refuse (CUSTOMER_DECIDING).
      const stillOpen = await this.prisma.orderItem.count({ where: { orderId: order.id, subStatus: 'PENDING' } });
      const next = stillOpen > 0
        ? (stillOpen === 1 ? 'One more item is still waiting on the customer.' : `${stillOpen} more items are still waiting on the customer.`)
        : 'You can accept the order now.';
      for (const userId of ringRecipients(team)) {
        await this.notifications.send({
          userId,
          type: 'ORDER_UPDATE',
          title: `Order #${order.orderNumber}: the customer answered`,
          body: `${what}. ${next}`,
          data: { kind: 'vendor_customer_answered', orderId: order.id, orderNumber: order.orderNumber, audience: 'business' },
        });
      }
    } catch {
      // A notice, never the decision: the answer already committed.
    }
  }

  /** Put a line's units back on the shelf (tracked items only) + log it. */
  private async restockLine(
    line: { itemId: string | null; quantity: number; orderId: string },
    note: string,
    db: Prisma.TransactionClient | PrismaClient = this.prisma,
  ) {
    if (!line.itemId) return;
    // [MKT-2] Through the single writer. It no-ops on an untracked item, which
    // is the same rule the `stockQuantity: { not: null }` guard enforced here.
    // The movement names its order, like the sale it gives back, so the units
    // an open order still holds net to zero for this line (POS-SYNC
    // unitsHeldByOpenOrders).
    // [POS-SYNC · Sol S2] Only units this order actually took are given back
    // in its name. An order placed before the item tracked stock took nothing
    // from the count; naming it on a return would cancel another open order's
    // hold. Whatever it did not take is still put back, as before, but not in
    // its name. The item lock serializes this read with every stock writer.
    await lockItemsInIdOrder(db, [line.itemId]);
    const taken = await db.stockMovement.aggregate({
      where: { itemId: line.itemId, orderId: line.orderId },
      _sum: { delta: true },
    });
    const ownUnits = Math.min(line.quantity, Math.max(0, -(taken._sum.delta ?? 0)));
    const parts = [
      { delta: ownUnits, orderId: line.orderId },
      { delta: line.quantity - ownUnits, orderId: null },
    ].filter((part) => part.delta > 0);
    let applied = false;
    for (const part of parts) {
      const restock = await applyStockMovement(db, {
        itemId: line.itemId,
        delta: part.delta,
        reason: 'PICK_REFUND',
        orderId: part.orderId,
        note: `picking: ${note}`,
      });
      applied = applied || restock.applied;
    }
    if (applied) {
      await unhideRestocked(db, line.itemId); // never a banned item [GUARDRAILS §8 · DS1266 S3]
      await db.stockAdjustment.create({
        data: { itemId: line.itemId, delta: line.quantity, reason: 'RETURN', note: `picking: ${note}` },
      });
    }
  }

  private emitPickState(vendorId: string | null, orderId: string, lineId: string, patch: object) {
    // Fire-and-forget like before; the store-room gate never throws.
    if (vendorId) void emitToStoreRoom(this.prisma, this.io, vendorId, 'order:pick_state', { orderId, lineId, ...patch });
  }
}

/**
 * [SUBSTITUTION · owner 17 Oct 2026] The once-a-minute deadline sweep: every
 * open swap question on a live order whose wait is over (or that has no
 * deadline yet) goes through expireSubstitution, one line at a time, each in
 * its own order's tenant (`narrow`; the job passes inTenantOf). A failure on
 * one line never stops the rest; it is counted and retried next minute.
 */
export async function sweepSubstitutionDeadlines(
  prisma: PrismaClient,
  io: Server,
  opts: {
    now?: Date;
    limit?: number;
    narrow?: <T>(orderId: string, fn: () => Promise<T>) => Promise<T>;
    /** [O-4] See PickingService: lets a waiting order whose only item got no answer be cancelled, free. */
    orderService?: Pick<import('./order.service').OrderService, 'transitionOrderAtomically'>;
  } = {},
): Promise<{ removed: number; withdrawn: number; started: number; cancelled: number; failed: number }> {
  const now = opts.now ?? new Date();
  const narrow = opts.narrow ?? (<T>(_orderId: string, fn: () => Promise<T>) => fn());
  const due = await prisma.orderItem.findMany({
    where: {
      subStatus: 'PENDING',
      picked: false,
      OR: [{ substituteDecideBy: { lte: now } }, { substituteDecideBy: null }],
      order: { status: { in: PICKABLE_STATES as PickableStatus[] } },
    },
    select: { id: true, orderId: true },
    orderBy: { substituteDecideBy: 'asc' },
    take: opts.limit ?? 200,
  });
  const result = { removed: 0, withdrawn: 0, started: 0, cancelled: 0, failed: 0 };
  const picking = new PickingService(prisma, io, opts.orderService);
  for (const line of due) {
    try {
      const outcome = await narrow(line.orderId, () => picking.expireSubstitution(line.id, now));
      if (outcome !== 'skipped') result[outcome] += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
