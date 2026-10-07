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
 * change approving makes to the total, and the decisions the server will
 * accept. An MMG order's total can't change in-app (picking.service
 * assertMmgMoneyAdjustable), so only a same-price approval is open there and
 * the store settles anything else with the customer directly. Once decided,
 * the line itself is the record (an approved line IS the substitute), so only
 * the state remains.
 */
export function substitutionView(line: {
  subStatus: string;
  name: string;
  quantity: number;
  totalCustomer: unknown;
  substituteItemId: string | null;
  substituteName: string | null;
  substitutePrice: unknown;
  selectedOptions: readonly OptionSnapshot[];
}, paymentMethod: string | null) {
  if (line.subStatus === 'NONE') return null;
  if (line.subStatus !== 'PENDING') return { state: line.subStatus, original: null, proposed: null, priceDelta: null, decisions: null, settlementGuidance: null };
  const delta = substitutionLineChange(line).delta;
  const mmg = paymentMethod === 'MOBILE_MONEY';
  return {
    state: line.subStatus,
    original: {
      name: line.name,
      unitPrice: cents(Number(line.totalCustomer) / line.quantity),
      options: chosenOptions(line.selectedOptions),
    },
    proposed: { itemId: line.substituteItemId, name: line.substituteName, unitPrice: Number(line.substitutePrice ?? 0) },
    priceDelta: delta,
    decisions: { approve: !mmg || delta === 0, reject: !mmg },
    settlementGuidance: mmg ? MMG_SWAP_SETTLES_DIRECTLY : null,
  };
}
