/**
 * Pricing for an item's selected options (size, add-ons…).
 *
 * `selectedOptions` is `{ [optionGroupId]: optionId | optionId[] }`. We resolve
 * those ids against the item's OWN option groups, so only options that genuinely
 * belong to the item are ever priced — a client can't inject an arbitrary
 * priced option. Used by both the cart total and the order/checkout total so
 * the two never disagree.
 */
export type ResolvedOption = {
  optionGroupName: string;
  optionName: string;
  additionalPrice: number;
};

type OptionLike = { id: string; name: string; additionalPrice: unknown };
type GroupLike = { name: string; options: OptionLike[] };
type ItemWithOptions = { optionGroups?: GroupLike[] | null };

function selectedOptionIds(selected: unknown): string[] {
  if (!selected || typeof selected !== 'object') return [];
  const ids: string[] = [];
  for (const value of Object.values(selected as Record<string, unknown>)) {
    if (Array.isArray(value)) ids.push(...value.filter((v): v is string => typeof v === 'string'));
    else if (typeof value === 'string') ids.push(value);
  }
  return ids;
}

export function resolveSelectedOptions(item: ItemWithOptions, selected: unknown): ResolvedOption[] {
  const byId = new Map<string, { groupName: string; name: string; price: number }>();
  for (const group of item.optionGroups ?? []) {
    for (const option of group.options) {
      byId.set(option.id, { groupName: group.name, name: option.name, price: Number(option.additionalPrice) });
    }
  }
  const resolved: ResolvedOption[] = [];
  for (const id of selectedOptionIds(selected)) {
    const match = byId.get(id);
    if (match) resolved.push({ optionGroupName: match.groupName, optionName: match.name, additionalPrice: match.price });
  }
  return resolved;
}

/** Per-unit price the selected options add on top of the item's base price. */
export function optionsUnitPrice(options: ResolvedOption[]): number {
  return options.reduce((sum, o) => sum + o.additionalPrice, 0);
}
