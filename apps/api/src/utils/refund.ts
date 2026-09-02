/**
 * [ALG-25] Refund computation — constrained by law before it is constrained
 * by maths. Swift never holds order money, so "refund" means one of three
 * things, and this function's first job is to say WHICH:
 *
 *   CASH_PRE_HANDOVER    the customer simply hands over less at the door —
 *                        the order total is re-run on the adjusted basket
 *                        (picking.service does this today). The only refund
 *                        Swift can execute.
 *   CASH_POST_HANDOVER   money changed hands between two people. Swift
 *                        computes and RECORDS what the store owes the
 *                        customer; it moves nothing.
 *   MMG_BLOCKED          MMG totals cannot change in-app until the vendor
 *                        refund / adjustment obligation ledger exists
 *                        (founder-gated). picking.service's guard fails
 *                        closed with MMG_ADJUSTMENT_UNAVAILABLE and this
 *                        never weakens it: the number is computed for the
 *                        record and marked not executable.
 *
 * Item-level partials: Σ affected line totals less the discount THOSE LINES
 * carry, and the delivery fee ONLY if the delivery did not happen — the
 * rider's time is real either way, and a rider is never clawed back from.
 * Never negative, never more than what was paid.
 *
 * [M-33] Where the discount share comes from. An order placed under M-32
 * carries an immutable redemption snapshot: the discount per component and
 * per line, and who funded it. The refund CONSUMES that: a returned line is
 * net of its own goods share; the delivery component is never subtracted
 * from goods (a FREE_DELIVERY order that returns everything gets every goods
 * dollar back — the delivery happened, and its fee was never charged); and a
 * fee that was discounted is not "refunded" when the delivery did not happen.
 * Before, the aggregate `discount` was spread across the returned lines in
 * proportion, so the delivery-fee discount under-refunded merchandise.
 * Without a snapshot (legacy orders) the inference still runs, but the result
 * is MARKED inferred and routed to review — never silently used as truth.
 */

export type RefundKind = 'CASH_PRE_HANDOVER' | 'CASH_POST_HANDOVER' | 'MMG_BLOCKED';

export interface RefundLine {
  /** The order line's id — the key the snapshot's line allocations use. */
  id?: string;
  totalCustomer: unknown;
  /** Lines already refunded or rejected at picking carry no money to return. */
  subStatus?: string | null;
  affected: boolean;
}

/** [M-33] The order's immutable redemption snapshot, when it has one. */
export interface RefundSnapshot {
  goodsDiscount: unknown;
  deliveryDiscount: unknown;
  funder: string | null;
  discountType?: string | null;
  lineAllocations?: ReadonlyArray<{ orderItemId: string; goods: number }> | null;
}

export type RefundBasis = 'SNAPSHOT' | 'INFERRED' | 'NONE';

export interface RefundInput {
  paymentMethod: string | null | undefined;
  /** Delivered / completed orders are post-handover; everything live is pre. */
  status: string;
  lines: readonly RefundLine[];
  deliveryFee: unknown;
  discount: unknown;
  totalAmount: unknown;
  /** Did the delivery actually happen? A returned parcel still travelled. */
  deliveryHappened: boolean;
  /** [M-33] The redemption snapshot; null/undefined = no snapshot (legacy). */
  snapshot?: RefundSnapshot | null;
}

export interface RefundComputation {
  kind: RefundKind;
  /** True only for the kind Swift can execute at the door. */
  executable: boolean;
  lineTotal: number;
  discountShare: number;
  deliveryFee: number;
  amount: number;
  sentence: string;
  /** [M-33] Where the discount share came from. INFERRED is a review flag. */
  basis: RefundBasis;
  /** [M-33] Who funded the discount the refund is net of; null when unknown. */
  funder: string | null;
  /** [M-33] The dual calculation: what the aggregate inference says. */
  inferredAmount: number;
}

const HANDED_OVER = new Set(['DELIVERED', 'COMPLETED']);
const gyd = (n: number) => `GY$${Math.round(n).toLocaleString('en-US')}`;

export function classifyRefund(order: { paymentMethod: string | null | undefined; status: string }): RefundKind {
  if (order.paymentMethod === 'MOBILE_MONEY') return 'MMG_BLOCKED';
  return HANDED_OVER.has(order.status) ? 'CASH_POST_HANDOVER' : 'CASH_PRE_HANDOVER';
}

export function computeRefund(input: RefundInput): RefundComputation {
  const kind = classifyRefund(input);
  const live = input.lines.filter((l) => l.subStatus !== 'REFUNDED' && l.subStatus !== 'REJECTED');
  const subtotal = live.reduce((s, l) => s + Number(l.totalCustomer ?? 0), 0);
  const lineTotal = live.filter((l) => l.affected).reduce((s, l) => s + Number(l.totalCustomer ?? 0), 0);
  const paid = Math.max(0, Number(input.totalAmount ?? 0));
  const executable = kind === 'CASH_PRE_HANDOVER';

  // The legacy inference — the aggregate discount spread across the returned
  // lines in proportion. Computed ALWAYS as the dual calculation, used as the
  // answer only when no snapshot exists, and then marked.
  const discount = Math.max(0, Number(input.discount ?? 0));
  const inferredShare = subtotal > 0 ? Math.round((discount * lineTotal) / subtotal) : 0;
  const rawFee = Math.max(0, Number(input.deliveryFee ?? 0));
  const inferredAmount = Math.min(paid, Math.max(0, lineTotal - inferredShare + (input.deliveryHappened ? 0 : rawFee)));

  let discountShare: number;
  let deliveryFee: number;
  let basis: RefundBasis;
  let funder: string | null = null;
  const snapshot = input.snapshot ?? null;
  if (snapshot) {
    // [M-33] The snapshot is the truth: each returned line's own goods share
    // (exact, from the allocation written at checkout; proportional to the
    // GOODS component only when an allocation is absent), never the delivery
    // component. A discounted fee was never paid, so it does not come back.
    const byLine = snapshot.lineAllocations
      ? new Map(snapshot.lineAllocations.map((a) => [a.orderItemId, Math.max(0, Number(a.goods) || 0)] as const))
      : null;
    const goodsDiscount = Math.max(0, Number(snapshot.goodsDiscount ?? 0));
    const affectedLive = live.filter((l) => l.affected);
    const allLinesKeyed = byLine !== null && affectedLive.every((l) => l.id !== undefined && byLine.has(l.id));
    discountShare = allLinesKeyed
      ? affectedLive.reduce((s, l) => s + (byLine!.get(l.id!) ?? 0), 0)
      : subtotal > 0 ? Math.round((goodsDiscount * lineTotal) / subtotal) : 0;
    const deliveryDiscount = Math.max(0, Number(snapshot.deliveryDiscount ?? 0));
    deliveryFee = input.deliveryHappened ? 0 : Math.max(0, rawFee - deliveryDiscount);
    basis = 'SNAPSHOT';
    funder = snapshot.funder ?? null;
  } else if (discount > 0) {
    discountShare = inferredShare;
    deliveryFee = input.deliveryHappened ? 0 : rawFee;
    basis = 'INFERRED';
  } else {
    discountShare = 0;
    deliveryFee = input.deliveryHappened ? 0 : rawFee;
    basis = 'NONE';
  }
  const amount = Math.min(paid, Math.max(0, lineTotal - discountShare + deliveryFee));

  const parts = [`${gyd(lineTotal)} for the returned items`];
  if (discountShare > 0) {
    const fundedBy = funder === 'VENDOR' ? ' (funded by the store)' : funder === 'PLATFORM' ? ' (funded by Swift)' : '';
    parts.push(`less ${gyd(discountShare)} of the discount they carried${fundedBy}`);
  }
  if (deliveryFee > 0) parts.push(`plus the ${gyd(deliveryFee)} delivery fee, because the delivery did not happen`);
  if (basis === 'INFERRED') parts.push('the discount share is INFERRED from the order’s total discount (no component record) — review before settling');
  const basisText = parts.join(', ');
  const sentence =
    kind === 'CASH_PRE_HANDOVER'
      ? `${gyd(amount)} comes off what is collected at the door: ${basisText}.`
      : kind === 'CASH_POST_HANDOVER'
        ? `The store owes the customer ${gyd(amount)}: ${basisText}. Swift records this; the store and customer settle it directly.`
        : `${gyd(amount)} would be due (${basisText}), but MMG totals cannot change in-app — the store settles it with the customer directly until in-app MMG adjustments arrive.`;
  return { kind, executable, lineTotal, discountShare, deliveryFee, amount, sentence, basis, funder, inferredAmount };
}
