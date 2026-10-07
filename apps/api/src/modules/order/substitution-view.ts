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

/** The options a line is made and charged with: none once it is a substitute. */
export function lineOptionsAsMade(line: { subStatus: string; selectedOptions: readonly OptionSnapshot[] }) {
  return line.subStatus === 'APPROVED' ? [] : chosenOptions(line.selectedOptions);
}

/**
 * The swap as the customer decides it. While it is open: the line as ordered
 * (unit price with its options, and those options), the proposal, and the
 * exact change approving makes to the total. Once decided, the line itself is
 * the record (an approved line IS the substitute), so only the state remains.
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
}) {
  if (line.subStatus === 'NONE') return null;
  if (line.subStatus !== 'PENDING') return { state: line.subStatus, original: null, proposed: null, priceDelta: null };
  return {
    state: line.subStatus,
    original: {
      name: line.name,
      unitPrice: cents(Number(line.totalCustomer) / line.quantity),
      options: chosenOptions(line.selectedOptions),
    },
    proposed: { itemId: line.substituteItemId, name: line.substituteName, unitPrice: Number(line.substitutePrice ?? 0) },
    priceDelta: substitutionLineChange(line).delta,
  };
}
