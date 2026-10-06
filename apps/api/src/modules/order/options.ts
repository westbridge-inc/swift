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

// ---------------------------------------------------------------------------
// [L09 · M023] ONE validator for a selection, used by cart add, cart update
// and checkout. Pricing above only ever sees a selection this accepted.
// ---------------------------------------------------------------------------

export type OptionSelectionReason = 'OPTION_UNKNOWN' | 'OPTION_UNAVAILABLE' | 'OPTION_DUPLICATE' | 'OPTION_LIMIT' | 'OPTION_REQUIRED';

export class OptionSelectionError extends Error {
  constructor(readonly reason: OptionSelectionReason, readonly groupName: string | null, message: string) {
    super(message);
    this.name = 'OptionSelectionError';
  }
}

type ValidatableOption = { id: string; name: string; additionalPrice: unknown; isAvailable?: boolean | null };
type ValidatableGroup = { id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; options: ValidatableOption[] };

export type OptionSelection = Record<string, string | string[]>;

/**
 * Accepts `{ [optionGroupId]: optionId | optionId[] }` only when every key is
 * one of the item's groups, every id is a live option of THAT group, nothing
 * repeats, no group exceeds its maximum and every required group (and every
 * partly-filled group with a minimum) is satisfied. Returns the selection in
 * canonical form (keys sorted, multi-choice ids sorted) and its priced options.
 */
export function validateSelectedOptions(
  item: { optionGroups?: ValidatableGroup[] | null },
  selected: unknown,
): { selection: OptionSelection; options: ResolvedOption[] } {
  const groups = item.optionGroups ?? [];
  if (selected != null && (typeof selected !== 'object' || Array.isArray(selected))) {
    throw new OptionSelectionError('OPTION_UNKNOWN', null, 'Those options are not valid for this item.');
  }
  const raw = (selected ?? {}) as Record<string, unknown>;
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const key of Object.keys(raw)) {
    if (!byId.has(key)) throw new OptionSelectionError('OPTION_UNKNOWN', null, 'That option is not available for this item.');
  }
  const selection: OptionSelection = {};
  const options: ResolvedOption[] = [];
  for (const group of groups) {
    const value = raw[group.id];
    const chosen: unknown[] = value == null ? [] : Array.isArray(value) ? value : [value];
    const optionById = new Map(group.options.map((o) => [o.id, o]));
    const seen = new Set<string>();
    for (const id of chosen) {
      const option = typeof id === 'string' ? optionById.get(id) : undefined;
      if (!option) throw new OptionSelectionError('OPTION_UNKNOWN', group.name, `That option isn't available for "${group.name}"`);
      if (option.isAvailable === false) throw new OptionSelectionError('OPTION_UNAVAILABLE', group.name, `${option.name} is not available right now for "${group.name}"`);
      if (seen.has(option.id)) throw new OptionSelectionError('OPTION_DUPLICATE', group.name, `Choose each option for "${group.name}" once`);
      seen.add(option.id);
    }
    if (seen.size > group.maxSelect) {
      throw new OptionSelectionError('OPTION_LIMIT', group.name, `Choose at most ${group.maxSelect} for "${group.name}"`);
    }
    const minimum = group.isRequired ? Math.max(1, group.minSelect) : seen.size > 0 ? group.minSelect : 0;
    if (seen.size < minimum) {
      throw new OptionSelectionError('OPTION_REQUIRED', group.name, `Please choose an option for "${group.name}"`);
    }
    if (seen.size === 0) continue;
    const ids = [...seen];
    selection[group.id] = Array.isArray(value) ? [...ids].sort() : ids[0]!;
    for (const id of ids) {
      const option = optionById.get(id)!;
      options.push({ optionGroupName: group.name, optionName: option.name, additionalPrice: Number(option.additionalPrice) });
    }
  }
  const canonical: OptionSelection = {};
  for (const key of Object.keys(selection).sort()) canonical[key] = selection[key]!;
  return { selection: canonical, options };
}

/** A selection's identity, independent of key order and multi-choice order. */
export function selectionKey(selected: unknown): string {
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) return '{}';
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(selected as Record<string, unknown>).sort()) {
    const value = (selected as Record<string, unknown>)[key];
    out[key] = Array.isArray(value) ? [...value].map(String).sort() : value;
  }
  return JSON.stringify(out);
}

/** An item note as a cart line carries it: trimmed, and empty means none. */
export function normalizeItemNote(note: string | null | undefined): string | null {
  const trimmed = (note ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}
