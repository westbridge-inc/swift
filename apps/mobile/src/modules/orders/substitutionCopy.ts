import { moneyExact } from '../../lib/money';
import { orderLineOptionsText, type OrderLineOption } from '../vendor/orderLineOptions';

/** The server's open swap on a line (customer order detail, `items[].substitution`). */
export interface SubstitutionView {
  priceDelta?: number | null;
  decisions?: { approve: boolean; reject: boolean } | null;
  settlementGuidance?: string | null;
  original?: { options?: readonly OrderLineOption[] | null } | null;
  /** [SUBSTITUTION] When the question stops waiting, and what happens then. */
  decideBy?: string | null;
  ifNoAnswer?: 'REMOVE' | 'WITHDRAW' | null;
}

/**
 * [L09 · M028] What the swap card tells the customer approving changes, from
 * the server's own numbers (the formula the approval itself uses): the change
 * to the total, the line's paid options included, and, when the line had
 * chosen options, that they do not come with the swap (the substitute is made
 * and charged without them). Null when the server sent no swap details: the
 * card keeps its original sentence.
 */
export function swapDecisionPermissions(substitution: SubstitutionView | null | undefined, paymentMethod?: string | null) {
  const mmg = paymentMethod === 'MOBILE_MONEY';
  return {
    approve: substitution?.decisions?.approve ?? (!mmg || substitution?.priceDelta === 0),
    reject: substitution?.decisions?.reject ?? !mmg,
    settlementGuidance: substitution?.settlementGuidance ?? (mmg
      ? 'MMG order totals can’t change in-app — the store settles item changes with you directly until in-app MMG adjustments arrive.' : null),
  };
}

export function swapChangeText(substitution: SubstitutionView | null | undefined, paymentMethod?: string | null): string | null {
  if (!swapDecisionPermissions(substitution, paymentMethod).approve) return null;
  const delta = substitution?.priceDelta;
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return null;
  const price = delta > 0
    ? `Approving adds ${moneyExact(delta)} to your total.`
    : delta < 0
      ? `Approving lowers your total by ${moneyExact(-delta)}.`
      : 'Approving keeps your total the same.';
  const choices = orderLineOptionsText(substitution?.original?.options);
  return choices ? `${price} Your choices (${choices}) don't come with the swap.` : price;
}

function clockOf(d: Date): string {
  try {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return d.toISOString().slice(11, 16);
  }
}

/**
 * [SUBSTITUTION · owner 17 Oct 2026] The swap question waits a bounded time.
 * The card says until when, and what happens without an answer, from the
 * server's own deadline and outcome: on cash the item comes off and the total
 * drops (never a silent swap); on MMG the store settles it directly. Null
 * when the server sent no deadline (an older server): nothing extra is said.
 */
export function swapDeadlineText(substitution: SubstitutionView | null | undefined, clock: (d: Date) => string = clockOf): string | null {
  const raw = substitution?.decideBy;
  if (!raw) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  if (substitution?.ifNoAnswer === 'WITHDRAW') {
    return `If it isn't approved by ${clock(at)}, the store settles this item with you directly.`;
  }
  if (substitution?.ifNoAnswer === 'REMOVE') {
    return `Please answer by ${clock(at)}. If you don't, it comes off your order and your total goes down.`;
  }
  return null;
}

/**
 * [SUBSTITUTION] What the STORE reads under "Waiting on the customer": when the
 * question stops waiting and what then happens to the line, so the store knows
 * it is never stuck. Null without a usable deadline.
 */
export function storeSwapWaitText(decideBy: string | null | undefined, paymentMethod?: string | null, clock: (d: Date) => string = clockOf): string | null {
  if (!decideBy) return null;
  const at = new Date(decideBy);
  if (Number.isNaN(at.getTime())) return null;
  return paymentMethod === 'MOBILE_MONEY'
    ? `No answer by ${clock(at)} closes the question; settle the item with the customer directly.`
    : `No answer by ${clock(at)} removes the item and lowers the total.`;
}
