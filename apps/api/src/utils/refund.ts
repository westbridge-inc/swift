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
 * Item-level partials: Σ affected line totals + the proportional share of
 * any discount, and the delivery fee ONLY if the delivery did not happen —
 * the rider's time is real either way, and a rider is never clawed back from.
 * Never negative, never more than what was paid.
 */

export type RefundKind = 'CASH_PRE_HANDOVER' | 'CASH_POST_HANDOVER' | 'MMG_BLOCKED';

export interface RefundLine {
  totalCustomer: unknown;
  /** Lines already refunded or rejected at picking carry no money to return. */
  subStatus?: string | null;
  affected: boolean;
}

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
  // A discount was given against the whole basket: the returned lines carry
  // their share of it, so the customer is not refunded money they never paid.
  const discount = Math.max(0, Number(input.discount ?? 0));
  const discountShare = subtotal > 0 ? Math.round((discount * lineTotal) / subtotal) : 0;
  const deliveryFee = input.deliveryHappened ? 0 : Math.max(0, Number(input.deliveryFee ?? 0));
  const paid = Math.max(0, Number(input.totalAmount ?? 0));
  const amount = Math.min(paid, Math.max(0, lineTotal - discountShare + deliveryFee));
  const executable = kind === 'CASH_PRE_HANDOVER';

  const parts = [`${gyd(lineTotal)} for the returned items`];
  if (discountShare > 0) parts.push(`less ${gyd(discountShare)} of the discount they carried`);
  if (deliveryFee > 0) parts.push(`plus the ${gyd(deliveryFee)} delivery fee, because the delivery did not happen`);
  const basis = parts.join(', ');
  const sentence =
    kind === 'CASH_PRE_HANDOVER'
      ? `${gyd(amount)} comes off what is collected at the door: ${basis}.`
      : kind === 'CASH_POST_HANDOVER'
        ? `The store owes the customer ${gyd(amount)}: ${basis}. Swift records this; the store and customer settle it directly.`
        : `${gyd(amount)} would be due (${basis}), but MMG totals cannot change in-app — the store settles it with the customer directly until in-app MMG adjustments arrive.`;
  return { kind, executable, lineTotal, discountShare, deliveryFee, amount, sentence };
}
