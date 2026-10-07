import { AppError } from '../../utils/errors';
import { zMoneyWhole } from '../../utils/money-schema';

// ---------------------------------------------------------------------------
// [L02 · row 34] THE CASH TAKEN AT THE DOOR — what the mover says changed hands.
//
// "Paid" used to mean "the full amount was collected": the door never asked how
// much cash the customer handed over, so a short payment was booked as a full
// one. The mover now states the amount, and this file decides what that
// statement means against the amount due (owner ruling, 5 Oct 2026):
//
//   - EXACT: the amount due, in full. The delivery completes as it always did,
//     and the stated amount is recorded.
//   - OVER: more than is due. Refused: nothing about the order may claim that
//     more money moved than the order is worth.
//   - SHORT, and the goods are still with the mover: NO HANDOVER. The answer is
//     a refusal that says so; the mover's next step is the "customer cannot pay
//     in full" outcome, which sends the order back to the store.
//   - SHORT, and the mover says they handed the goods over anyway: recorded as
//     it happened. The mover bears the difference (the ruling); the mismatch is
//     held for a person and operations is paged. Nothing is deducted from
//     anybody by the platform: the mover simply holds less cash.
//
// No amount at all is an older app: the full amount is assumed exactly as
// before and nothing is attested for it. That keeps the store build working.
//
// Every comparison is in whole cents of the order's own total, so a Decimal
// total and an integer statement can never disagree by a rounding.
// ---------------------------------------------------------------------------

export type DoorCashDecision =
  /** An older client stated nothing: today's path, nothing attested. */
  | { kind: 'UNSTATED' }
  | { kind: 'EXACT'; due: number; collected: number }
  | { kind: 'SHORT_HANDED_OVER'; due: number; collected: number; shortfall: number };

const cents = (n: number): number => Math.round(n * 100);

/** The amount due at the door: the order's total, as a number. */
export function doorCashDue(order: { totalAmount: unknown }): number {
  const due = Number(order.totalAmount);
  if (order.totalAmount === null || order.totalAmount === '' || !Number.isSafeInteger(due) || due < 0) {
    throw new AppError(409, 'ORDER_TOTAL_UNREADABLE', 'This order has no readable total, so the cash cannot be recorded. Contact support.');
  }
  return due;
}

/**
 * What a "paid" statement at the door means. Throws the refusals (OVER, and
 * SHORT while the goods are still with the mover); returns what to record.
 */
export function decideDoorCash(
  order: { totalAmount: unknown; orderType?: string },
  stated: { collectedAmount?: number; handedOverShort?: boolean },
): DoorCashDecision {
  if (stated.collectedAmount === undefined) {
    if (stated.handedOverShort === true) {
      throw new AppError(400, 'CASH_AMOUNT_REQUIRED', 'Record the cash actually collected.');
    }
    return { kind: 'UNSTATED' };
  }
  const due = doorCashDue(order);
  const collected = stated.collectedAmount;
  assertCashAmount(collected);
  if (cents(collected) > cents(due)) {
    throw new AppError(409, 'CASH_OVER_DUE',
      `This order is GY$${gyd(due)}. Record only the cash you took for it, never more — give any extra back to the customer.`,
      { due, collected });
  }
  if (cents(collected) === cents(due)) return { kind: 'EXACT', due, collected };
  // The owner's short-handover ruling covers goods deliveries. Taxi fares
  // and courier fees retain their existing outcome rules.
  if (order.orderType === 'TAXI' || order.orderType === 'COURIER') {
    throw new AppError(409, 'SHORT_PAYMENT_NOT_AVAILABLE',
      'This outcome is for goods deliveries. For a ride or a parcel, record the outcome the job offers or contact support.');
  }
  if (stated.handedOverShort !== true) {
    throw new AppError(409, 'CASH_SHORT_NO_HANDOVER',
      `Do not hand over: the customer must pay the full GY$${gyd(due)}. If they cannot, choose "Customer can't pay in full" and the order goes back to the store, which gives you back the cash you paid for it.`,
      { due, collected });
  }
  return { kind: 'SHORT_HANDED_OVER', due, collected, shortfall: (cents(due) - cents(collected)) / 100 };
}

/**
 * The "customer cannot pay in full" outcome: the goods are NOT handed over and
 * go back to the store. A reported full amount is not partial cash; the caller
 * must check the amount and select the matching outcome.
 */
export function assertGenuinelyShort(order: { totalAmount: unknown }, collected: number | undefined): { due: number; collected: number | null } {
  const due = doorCashDue(order);
  if (collected !== undefined) assertCashAmount(collected);
  if (collected !== undefined && cents(collected) >= cents(due)) {
    throw new AppError(409, 'CASH_NOT_SHORT',
      `The amount recorded is at least the full GY$${gyd(due)}. Check the cash and choose the correct outcome.`,
      { due, collected });
  }
  return { due, collected: collected ?? null };
}

export interface DoorCashReturnRecord {
  amount: number;
  status: 'RETURNED' | 'HELD';
  heldForReview: boolean;
}

/** Owner ruling, 7 Oct: hand partial cash back before returning the goods.
 * If that could not happen, record what the rider still holds for operations.
 * Omitted fields retain the old client's unstated behavior. */
export function decideDoorCashReturn(
  order: { totalAmount: unknown },
  input: { collectedAmount?: number; cashReturned?: boolean },
): DoorCashReturnRecord | undefined {
  const { collected } = assertGenuinelyShort(order, input.collectedAmount);
  if (input.cashReturned !== undefined && (collected === null || collected === 0)) {
    throw new AppError(400, 'CASH_AMOUNT_REQUIRED', 'Record the positive amount of partial cash taken from the customer.');
  }
  if (collected === null || collected === 0) return undefined;
  if (typeof input.cashReturned !== 'boolean') {
    throw new AppError(409, 'CASH_RETURN_CONFIRMATION_REQUIRED',
      'Hand the partial cash back to the customer, then tap "Cash returned". If you could not return it, report that so operations can help. Do not hand over the goods.');
  }
  return { amount: collected, status: input.cashReturned ? 'RETURNED' : 'HELD', heldForReview: !input.cashReturned };
}

export function assertDoorCashOutcome(input: { outcome: string; cashReturned?: boolean; handedOverShort?: boolean }): void {
  if ((input.cashReturned !== undefined && input.outcome !== 'short_payment')
      || (input.outcome === 'short_payment' && input.handedOverShort === true)) {
    throw new AppError(400, 'CASH_OUTCOME_CONFLICT', 'Check whether the goods were handed over and choose the matching cash outcome.');
  }
}

/** Read the durable fact on a retry; never let a new body rewrite it. */
export function recordedDoorCashReturn(order: {
  doorCashReturnAmount: unknown; doorCashReturnStatus: string | null;
}): DoorCashReturnRecord | undefined {
  const status = order.doorCashReturnStatus;
  if (status !== 'RETURNED' && status !== 'HELD') return undefined;
  return { amount: Number(order.doorCashReturnAmount), status, heldForReview: status === 'HELD' };
}

function assertCashAmount(amount: number): void {
  if (!zMoneyWhole.safeParse(amount).success) {
    throw new AppError(400, 'CASH_AMOUNT_INVALID', 'Record a non-negative whole cash amount within the supported limit.');
  }
}

export function gyd(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** The page operations receives when a mover hands over for less than due. */
export function shortHandoverPage(orderNumber: string, d: { due: number; collected: number; shortfall: number }): { title: string; body: string } {
  return {
    title: 'Cash order handed over short',
    body: `Order ${orderNumber}: the rider handed the order over for GY$${gyd(d.collected)} of the GY$${gyd(d.due)} due (GY$${gyd(d.shortfall)} short). `
      + 'Owner rule: the rider bears the difference; nothing was deducted from anyone. The mismatch is held for review.',
  };
}

/** The note written to the order's status trail when a customer cannot pay in full. */
export function shortPaymentNote(cash: DoorCashReturnRecord | undefined, gpsNote: string): string {
  const detail = !cash ? 'no partial cash reported'
    : cash.status === 'RETURNED' ? `cash returned GY$${gyd(cash.amount)} to the customer`
      : `cash GY$${gyd(cash.amount)} held by the rider for operations; could not return it to the customer`;
  return `customer could not pay in full (${detail}) — not handed over, returning to the store — ${gpsNote}`;
}
