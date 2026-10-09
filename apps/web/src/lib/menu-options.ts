/**
 * [W6] An item's choices on the website, judged by the API's own rules.
 *
 * The one validator the server runs at cart add, cart update and checkout
 * (apps/api/src/modules/order/options.ts, #1493) is imported here by path —
 * never re-expressed — so the store page can never accept a selection the
 * server would refuse, or price one differently. It is a pure module with no
 * imports; apps/web/Dockerfile copies exactly that file into the image build
 * (src/image-build-context.test.ts keeps the two in step).
 *
 * The page's figures are a preview. The server re-prices every line when it is
 * added and again at checkout.
 */
import { parseAmount } from './money';
import { resolveSelectedOptions, validateSelectedOptions } from '../../../api/src/modules/order/options';

export { OptionSelectionError, resolveSelectedOptions, validateSelectedOptions } from '../../../api/src/modules/order/options';
export type { OptionSelection, OptionSelectionReason, ValidatableGroup } from '../../../api/src/modules/order/options';

type PricedOption = { id: string; name: string; additionalPrice: unknown; isAvailable?: boolean | null; isDefault?: boolean };
type PricedGroup = { id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; options: PricedOption[] };
type PricedItem = { basePrice: unknown; customerPrice?: unknown; optionGroups?: PricedGroup[] | null };

/** The item's own price, or null when the server's figure cannot be read. */
export function basePrice(item: PricedItem): number | null {
  return parseAmount(item.customerPrice ?? item.basePrice);
}

/** How many choices a group needs before the item can be added (the validator's rule for an empty group). */
export function requiredCount(group: PricedGroup): number {
  return group.isRequired ? Math.max(1, group.minSelect) : 0;
}

/** The item cannot be added without opening its choices. */
export function needsChoices(item: PricedItem): boolean {
  return (item.optionGroups ?? []).some((group) => requiredCount(group) > 0);
}

/**
 * The item's Add opens its choices first: a choice is required, or the store
 * pre-selects one (the phone app pre-selects the same picks). One tap must
 * neither drop a store's pick from the order nor add it, and its price, unseen.
 */
export function opensChoices(item: PricedItem): boolean {
  return needsChoices(item)
    || (item.optionGroups ?? []).some((group) => group.options.some((option) => option.isDefault === true && option.isAvailable !== false));
}

/**
 * The lowest price the item can be ordered at: its price plus the cheapest
 * choices each required group needs, counting only choices on sale. This is
 * the "From" figure on the menu. Null when any figure in it cannot be read.
 */
export function fromPrice(item: PricedItem): number | null {
  const base = basePrice(item);
  if (base === null) return null;
  let total = base;
  for (const group of item.optionGroups ?? []) {
    const needed = requiredCount(group);
    if (needed === 0) continue;
    const deltas: number[] = [];
    for (const option of group.options) {
      if (option.isAvailable === false) continue;
      const delta = parseAmount(option.additionalPrice);
      if (delta === null) return null;
      deltas.push(delta);
    }
    deltas.sort((a, b) => a - b);
    for (const delta of deltas.slice(0, needed)) total += delta;
  }
  return total;
}

/**
 * One unit's price with these choices: the item's price plus each chosen
 * choice's price, resolved against the item's OWN groups by the API's
 * resolver. Null when any figure cannot be read.
 */
export function selectionPrice(item: PricedItem, selected: Record<string, string[]>): number | null {
  const base = basePrice(item);
  if (base === null) return null;
  let total = base;
  for (const option of resolveSelectedOptions(item, selected)) {
    const extra = parseAmount(option.additionalPrice);
    if (extra === null) return null;
    total += extra;
  }
  return total;
}

/** True when the server's validator would accept these choices for this item. */
export function selectionComplete(item: { optionGroups?: PricedGroup[] | null }, selected: Record<string, string[]>): boolean {
  try {
    validateSelectedOptions(item as Parameters<typeof validateSelectedOptions>[0], selected);
    return true;
  } catch {
    return false;
  }
}
