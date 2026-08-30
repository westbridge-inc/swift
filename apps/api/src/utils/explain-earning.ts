import { billableDistance } from './billable-distance';

/**
 * [ALG-21] A rider's earning, explainable in one sentence.
 *
 * The maths exists — createEarnings, the fee schedule, the fare — and
 * reconciles against the money matrix. The EXPLANATION did not: a row said
 * "DELIVERY_FEE  GY$700" and nothing else. This is the sentence, generated
 * from the same stored fields that produced the number and nothing else
 * (L2 — never a second computation): the amount on the earning row, the
 * frozen billable distance (ALG-18), the express flag, the rail.
 *
 * What it deliberately does NOT do is split the fee into "base + per km":
 * the schedule that priced it is not frozen on the order, so a split would
 * be recomputed from today's rates — a second computation, and a lie the
 * day a rate changes. If a component cannot be explained from stored
 * fields, it does not appear in the sentence.
 *
 * Glossary (CI-gated): the rider's money is "cash in hand". Never "payout".
 */

export interface EarningForSentence {
  type: string;
  amount: unknown;
}

export interface OrderForSentence {
  orderType?: string | null;
  paymentMethod?: string | null;
  isExpress?: boolean | null;
  billableKm?: unknown;
  billableKmSource?: string | null;
  taxiDistance?: unknown;
}

export function gyd(n: unknown): string {
  return `GY$${Math.round(Number(n ?? 0)).toLocaleString('en-US')}`;
}

function distancePhrase(order: OrderForSentence | null | undefined): string {
  const d = order ? billableDistance(order) : null;
  return d ? ` for ${d.label} (${d.sourceLabel})` : '';
}

// (`kind:` is the notification census idiom — this parameter is deliberately not called that.)
function rail(order: OrderForSentence | null | undefined, of: 'fee' | 'tip' | 'fare'): string {
  const method = order?.paymentMethod ?? 'CASH';
  if (method === 'CASH') return 'Cash in hand.';
  // The customer paid the store by MMG; the store owes the rider the fee
  // (money matrix row 2: VENDOR_OWES_RIDER) and the tip rode the same payment.
  if (of === 'fare') return 'Paid by MMG.';
  return 'The store owes you this — settled with the store, not at the door.';
}

export function explainEarning(earning: EarningForSentence, order?: OrderForSentence | null): string {
  const amount = gyd(earning.amount);
  switch (earning.type) {
    case 'DELIVERY_FEE':
    case 'COURIER_FEE': {
      const what = earning.type === 'COURIER_FEE' ? 'courier pay' : 'delivery pay';
      const express = order?.isExpress ? ', express' : '';
      return `${amount} — ${what}${distancePhrase(order)}${express}. ${rail(order, 'fee')}`;
    }
    case 'TIP':
      return `${amount} — tip from the customer. ${rail(order, 'tip')}`;
    case 'TAXI_FARE':
      return `${amount} — fare${distancePhrase(order)}. ${rail(order, 'fare')}`;
    case 'RESCUE_INCENTIVE':
      // [ALG-06 / ALG-INV-19] Swift's own money: a payable Swift settles, not the customer's or the store's.
      return `${amount} — rescue bonus from Swift for taking a job nobody nearby would. Swift pays this, not the customer or the store.`;
    default:
      return `${amount} — earning. ${rail(order, 'fee')}`;
  }
}
