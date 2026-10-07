import { money } from '../../lib/money';
import { orderLineOptionsText, type OrderLineOption } from '../vendor/orderLineOptions';

/** The server's open swap on a line (customer order detail, `items[].substitution`). */
export interface SubstitutionView {
  priceDelta?: number | null;
  original?: { options?: readonly OrderLineOption[] | null } | null;
}

/**
 * [L09 · M028] What the swap card tells the customer approving changes, from
 * the server's own numbers (the formula the approval itself uses): the change
 * to the total, the line's paid options included, and, when the line had
 * chosen options, that they do not come with the swap (the substitute is made
 * and charged without them). Null when the server sent no swap details: the
 * card keeps its original sentence.
 */
export function swapChangeText(substitution: SubstitutionView | null | undefined): string | null {
  const delta = substitution?.priceDelta;
  if (typeof delta !== 'number' || !Number.isFinite(delta)) return null;
  const price = delta > 0
    ? `Approving adds ${money(delta)} to your total.`
    : delta < 0
      ? `Approving lowers your total by ${money(-delta)}.`
      : 'Approving keeps your total the same.';
  const choices = orderLineOptionsText(substitution?.original?.options);
  return choices ? `${price} Your choices (${choices}) don't come with the swap.` : price;
}
