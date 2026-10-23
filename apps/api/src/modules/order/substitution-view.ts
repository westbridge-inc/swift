import { AppError } from '../../utils/errors';
import { assertMmgFulfilmentAllowed } from './order.service';

/**
 * [L09 · M026 · M028] One place for what an out-of-stock swap does to an order
 * line, read by the approval itself (picking.service), the customer's order
 * screen and the store's order screens, so what is shown is what is charged.
 *
 * Approving a substitute makes the line the substitute: its total becomes the
 * substitute's price × quantity and replaces the line's old total, which
 * included any paid options. The original's options do NOT come with the swap
 * (they are not charged), so a swapped line lists none: the store never makes
 * extras nobody pays for. The original's option rows stay as history.
 */

const cents = (amount: number) => Math.round(amount * 100) / 100;

/** What approving moves on the line and on the order's totals. */
export function substitutionLineChange(line: { substitutePrice: unknown; quantity: number; totalCustomer: unknown }): {
  newLineTotal: number;
  delta: number;
} {
  const newLineTotal = cents(Number(line.substitutePrice ?? 0) * line.quantity);
  return { newLineTotal, delta: cents(newLineTotal - Number(line.totalCustomer)) };
}

interface OptionSnapshot {
  optionGroupName: string;
  optionName: string;
  markedUpPrice: unknown;
}

/** The options the customer chose for a line, as snapshotted at checkout. */
export function chosenOptions(rows: readonly OptionSnapshot[]): Array<{ group: string; name: string; price: number }> {
  return rows.map((o) => ({ group: o.optionGroupName, name: o.optionName, price: Number(o.markedUpPrice) }));
}

/** The options a line is made and charged with: none once it is a substitute,
 *  and none once the line is closed (refunded or rejected: nothing is made or
 *  charged, and a refunded swap must not list the original's choices beside
 *  the substitute's name). The option rows stay as history. */
export function lineOptionsAsMade(line: { subStatus: string; selectedOptions: readonly OptionSnapshot[] }) {
  return ['APPROVED', 'REFUNDED', 'REJECTED'].includes(line.subStatus) ? [] : chosenOptions(line.selectedOptions);
}

/** What the customer is told when an MMG swap can't be settled in-app: the
 *  same words the server answers a refused decision with. */
export const MMG_SWAP_SETTLES_DIRECTLY =
  'MMG order totals can’t change in-app — the store settles item changes with you directly until in-app MMG adjustments arrive.';

/**
 * The swap as the customer decides it. While it is open: the line as ordered
 * (unit price with its options, and those options), the proposal, the exact
 * change approving makes to the total, and decisions allowed by the current
 * total and payment snapshot. The locked decision still checks live stock,
 * lifecycle and rider float, which can change after this response. An MMG order's total can't change in-app (picking.service
 * assertMmgMoneyAdjustable), so only a same-price approval is open there and
 * the store settles anything else with the customer directly. Once decided,
 * the line itself is the record (an approved line IS the substitute), so only
 * the state remains.
 */
type ViewLine = {
  subStatus: string;
  name: string;
  quantity: number;
  totalCustomer: unknown;
  substituteItemId: string | null;
  substituteName: string | null;
  substitutePrice: unknown;
  substituteDecideBy?: Date | null;
  selectedOptions: readonly OptionSnapshot[];
};
type ViewOrder = Parameters<typeof assertMmgFulfilmentAllowed>[0] & AdjustableOrder & { totalAmount: unknown };

/** The order facts that decide whether its total may change in-app. Each one
 *  is optional so an older projection still type-checks — and an MMG order
 *  whose facts were not projected is never adjustable (fails closed). */
export type AdjustableOrder = {
  paymentMethod: string | null;
  status?: string;
  acceptedAt?: Date | null;
  paymentStatus?: string;
  mmgAttestedRef?: string | null;
  customerMmgClaim?: string;
  mmgPayUrlSnapshot?: string | null;
  mmgClaimMismatchAt?: Date | null;
};

/**
 * [O-4 · owner 22 Oct 2026] May this order's TOTAL change in-app — a line
 * removed, a swap at another price? On cash (and every rail but MMG): yes, the
 * handover collects the total the customer confirmed. On MMG the money goes
 * straight to the store, so the total stays fixed in-app once any payment can
 * exist (REPORT-006 F-006-02) — and it CAN'T exist yet before the store
 * accepts: the store's MMG number is shown only after acceptance, so the total
 * may change only while ALL of this holds: the order still waits for the store
 * (PENDING, never accepted), no pay link was issued, nobody (store or
 * customer) has said money moved, and no disagreement is open. Then the
 * customer pays only the total they confirmed. Anything not projected = no.
 */
export function orderTotalAdjustable(order: AdjustableOrder): boolean {
  if (order.paymentMethod !== 'MOBILE_MONEY') return true;
  return order.status === 'PENDING'
    && order.acceptedAt === null
    && order.paymentStatus === 'PENDING'
    && order.mmgAttestedRef === null
    && order.customerMmgClaim === 'UNRECORDED'
    && order.mmgPayUrlSnapshot === null
    && order.mmgClaimMismatchAt === null;
}

/** [O-4] A store's "Out of stock" with no substitute, asked BEFORE it accepts:
 *  an open question with nothing proposed — the customer continues without the
 *  item (it comes off, the total goes down) or cancels the order. */
export function isRemovalQuestion(line: { subStatus: string; substituteItemId: string | null; substituteName: string | null }): boolean {
  return line.subStatus === 'PENDING' && line.substituteItemId === null && line.substituteName === null;
}

/**
 * [SUBSTITUTION · owner 17 Oct 2026] How long a store's swap question waits
 * for the customer. An ops setting (env SUBSTITUTION_DECIDE_MINUTES), NOT the
 * signed platform config: whole minutes, clamped to 3..30, default 10. Anything
 * unreadable is the default — a typo never makes the wait endless or instant.
 */
export const SUBSTITUTION_DECIDE_MINUTES_DEFAULT = 10;
export function substitutionDecideMinutes(raw: string | undefined = process.env['SUBSTITUTION_DECIDE_MINUTES']): number {
  const trimmed = raw?.trim() ?? '';
  if (!/^\d+$/.test(trimmed)) return SUBSTITUTION_DECIDE_MINUTES_DEFAULT;
  return Math.min(30, Math.max(3, Number(trimmed)));
}

/**
 * What happens when nobody answers in time — the SAFE default, never a silent
 * swap: the line is REMOVED (it comes off the order and the total drops). An
 * MMG order's total can't change in-app, so there the question is WITHDRAWN and
 * the store settles the item with the customer directly; no money moves.
 */
export function substitutionNoAnswer(order: AdjustableOrder): 'REMOVE' | 'WITHDRAW' {
  // [O-4] Before the store accepts and before any MMG payment can exist, an MMG
  // total may still change, so no answer removes the item there too.
  return order.paymentMethod === 'MOBILE_MONEY' && !orderTotalAdjustable(order) ? 'WITHDRAW' : 'REMOVE';
}

/**
 * [O-4 · REVIEW-F S3-1 on #2043] Is this the ONLY item still on a waiting order
 * (a one-item order, or the last line the others' answers left)? Then the
 * customer's "continue without it" (or a declined swap, or no answer) would
 * leave nothing to accept: the order can't go ahead. The customer is told so
 * and cancels free; no answer cancels it free (picking.service). Only before
 * acceptance; after it, today's rules.
 */
export function onlyItemLeft(
  line: { id: string },
  lines: ReadonlyArray<{ id: string; subStatus: string }>,
  orderStatus: string,
): boolean {
  if (orderStatus !== 'PENDING') return false;
  return !lines.some((other) => other.id !== line.id && other.subStatus !== 'REFUNDED' && other.subStatus !== 'REJECTED');
}

/** [O-4 · REVIEW-F S3-1] What the customer reads about the only item left. */
export const ONLY_ITEM_LEFT_COPY = "This was the only item on your order, so the order can't go ahead. Cancel it — nothing has been charged.";

export function substitutionView(line: ViewLine, order: ViewOrder, ctx: { onlyItemLeft?: boolean } = {}) {
  if (line.subStatus === 'NONE') return null;
  if (line.subStatus !== 'PENDING') return { state: line.subStatus, original: null, proposed: null, priceDelta: null, decisions: null, settlementGuidance: null, decideBy: null, ifNoAnswer: null };
  const delta = substitutionLineChange(line).delta;
  // [O-4] On cash, and on MMG before the store accepts and before any payment
  // can exist, the total may change; otherwise only a same-price swap may.
  const adjustable = orderTotalAdjustable(order);
  // Use the existing approval guard verbatim: a proposal may outlive the
  // customer's payment denial. Required context prevents a missing projection
  // from silently enabling a same-price swap on a disputed order. [O-4] Before
  // the store accepts, answering is part of the acceptance, not preparation.
  let approvalHold: string | null = null;
  try {
    assertMmgFulfilmentAllowed(order, order.status === 'PENDING' ? 'ACCEPTED' : 'PREPARING');
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    approvalHold = error.message;
  }
  const original = {
    name: line.name,
    unitPrice: cents(Number(line.totalCustomer) / line.quantity),
    options: chosenOptions(line.selectedOptions),
  };
  const decideBy = line.substituteDecideBy ? line.substituteDecideBy.toISOString() : null;
  // [O-4 · REVIEW-F S3-1] The only item left on a waiting order: no answer may empty it. The
  // customer cancels free; no answer cancels it free. (MMG past adjustability keeps WITHDRAW.)
  const lastItem = ctx.onlyItemLeft === true && order.status === 'PENDING';
  const noAnswer = lastItem && substitutionNoAnswer(order) === 'REMOVE' ? 'CANCEL' as const : substitutionNoAnswer(order);
  if (isRemovalQuestion(line)) {
    // [O-4] Nothing is proposed: the customer continues without the item (the
    // total goes down by the line, never below zero) or cancels the order.
    if (lastItem) {
      return {
        state: line.subStatus, kind: 'REMOVAL' as const, lastItem: true, original, proposed: null,
        priceDelta: null, decisions: { approve: false, reject: false },
        settlementGuidance: ONLY_ITEM_LEFT_COPY, decideBy, ifNoAnswer: noAnswer,
      };
    }
    return {
      state: line.subStatus,
      kind: 'REMOVAL' as const,
      original,
      proposed: null,
      priceDelta: -Math.min(Number(line.totalCustomer), Number(order.totalAmount)),
      decisions: { approve: !approvalHold && adjustable, reject: false },
      settlementGuidance: approvalHold ?? (adjustable ? null : MMG_SWAP_SETTLES_DIRECTLY),
      decideBy,
      ifNoAnswer: substitutionNoAnswer(order),
    };
  }
  const negativeTotal = Number(order.totalAmount) + delta < 0;
  const settlementGuidance = approvalHold
    ?? (!adjustable ? MMG_SWAP_SETTLES_DIRECTLY : negativeTotal
      ? 'That substitute would drop the order total below zero — refund the line instead.' : null);
  return {
    state: line.subStatus,
    kind: 'SWAP' as const,
    original,
    proposed: { itemId: line.substituteItemId, name: line.substituteName, unitPrice: Number(line.substitutePrice ?? 0) },
    priceDelta: delta,
    // [O-4 · REVIEW-F S3-1] Declining the only item left would empty the order: not offered.
    decisions: { approve: !approvalHold && !negativeTotal && (adjustable || delta === 0), reject: adjustable && !lastItem },
    ...(lastItem ? { lastItem: true } : {}),
    settlementGuidance,
    // [SUBSTITUTION] The wait is bounded and the customer is told how: answer
    // by decideBy, or ifNoAnswer happens (REMOVE = the item comes off and the
    // total drops; WITHDRAW = MMG, the store settles it with you directly).
    decideBy,
    ifNoAnswer: noAnswer,
  };
}

/**
 * [SUBSTITUTION · owner 17 Oct 2026] The item fields a client WITHOUT the
 * swapDecisions=v1 capability gets (iPhone build 9 / 11, Android vc5 / vc7).
 *
 * Those builds already carry a swap card — "{item} is out of stock. {store}
 * suggests {substituteName} ({substitutePrice} × qty) instead. Rejecting removes
 * the item and lowers your total. [Approve swap] [No thanks]" — wired to the
 * same POST /customer/orders/:id/items/:lineId/substitution the server still
 * serves. Hiding the flat fields from them (ruling A, 7 Oct) left the customer
 * with NO way to see the question: the store waited on an answer nobody could
 * give. Owner 17 Oct: the customer is ALWAYS told; old builds get true text.
 *
 * So the old card is switched on exactly when every word on it is true and
 * both of its buttons work: both decisions are open (that already excludes MMG,
 * a payment hold and a negative total). Options the customer chose that do not
 * come with the swap are named in the substitute's name, the one place the
 * old card prints it. Otherwise the line's NAME carries the true status.
 * A removed line (refunded / rejected) says so and lists nothing charged, so the
 * old item list adds up to the total it shows.
 */
export function legacySwapItemFields(line: ViewLine, order: ViewOrder, ctx: { onlyItemLeft?: boolean } = {}): {
  name?: string;
  lineTotal?: number;
  subStatus?: 'PENDING';
  substituteName?: string;
  substitutePrice?: number;
} {
  if (line.subStatus === 'REFUNDED' || line.subStatus === 'REJECTED') {
    return { name: `${line.name} (removed, not charged)`, lineTotal: 0 };
  }
  if (line.subStatus !== 'PENDING') return {};
  const view = substitutionView(line, order, ctx);
  if (view?.decisions?.approve && view.decisions.reject) {
    const lost = (view.original?.options.length ?? 0) > 0;
    return {
      subStatus: 'PENDING',
      substituteName: `${line.substituteName ?? 'another item'}${lost ? ' (your chosen options don’t come with it)' : ''}`,
      substitutePrice: Number(line.substitutePrice ?? 0),
    };
  }
  // [O-4] The only item left on a waiting order: it can't go ahead, and the customer may cancel free.
  if (view?.ifNoAnswer === 'CANCEL') {
    return { name: `${line.name} (out of stock: it was the only item, so the order can't go ahead; you can cancel it, nothing has been charged)` };
  }
  return {
    name: substitutionNoAnswer(order) === 'WITHDRAW'
      ? `${line.name} (out of stock: the store will settle this item with you directly)`
      : `${line.name} (out of stock: it is being removed and your total will go down)`,
  };
}
