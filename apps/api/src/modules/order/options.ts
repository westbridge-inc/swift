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
  constructor(
    readonly reason: OptionSelectionReason,
    readonly groupName: string | null,
    message: string,
    /** The choice that was refused, when one was named (a sold-out choice). */
    readonly optionName: string | null = null,
  ) {
    super(message);
    this.name = 'OptionSelectionError';
  }
}

type ValidatableOption = { id: string; name: string; additionalPrice: unknown; isAvailable?: boolean | null };
export type ValidatableGroup = { id: string; name: string; isRequired: boolean; minSelect: number; maxSelect: number; options: ValidatableOption[] };

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
      // [F4] Sold out is enforced HERE, for every client (an older app, the
      // web, a stale menu): never only by a screen hiding the choice.
      if (option.isAvailable === false) {
        throw new OptionSelectionError('OPTION_UNAVAILABLE', group.name, `${option.name} is sold out right now. Choose another option for "${group.name}"`, option.name);
      }
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

/**
 * [L09 · reorder] A past line's choices, rebuilt against TODAY's menu from the
 * group and option names its order kept (an order stores names, not ids).
 * Returns the canonical selection only when it can be rebuilt exactly and the
 * one validator accepts it; null when a choice is gone, sold out, renamed or
 * ambiguous, or the item now needs a choice the order never made. A reorder
 * never drops a choice silently and never guesses one.
 */
export function rebuildSelectionFromSnapshot(
  item: { optionGroups?: ValidatableGroup[] | null },
  snapshot: ReadonlyArray<{ optionGroupName: string; optionName: string }>,
): OptionSelection | null {
  const groups = item.optionGroups ?? [];
  const chosen = new Map<string, string[]>();
  for (const pick of snapshot) {
    const matchingGroups = groups.filter((g) => g.name === pick.optionGroupName);
    if (matchingGroups.length !== 1) return null;
    const group = matchingGroups[0]!;
    const matchingOptions = group.options.filter((o) => o.name === pick.optionName);
    if (matchingOptions.length !== 1) return null;
    chosen.set(group.id, [...(chosen.get(group.id) ?? []), matchingOptions[0]!.id]);
  }
  const shaped: Record<string, string | string[]> = {};
  for (const group of groups) {
    const ids = chosen.get(group.id);
    if (!ids) continue;
    // The shape the apps send: one id for a pick-one group, a list otherwise.
    shaped[group.id] = group.maxSelect > 1 || ids.length > 1 ? ids : ids[0]!;
  }
  try {
    return validateSelectedOptions(item, shaped).selection;
  } catch (error) {
    if (error instanceof OptionSelectionError) return null;
    throw error;
  }
}

/**
 * [F4] Why a cart line cannot be ordered as it stands, in a few plain words
 * for the cart screen, or null when its choices are still good. The cart
 * quote marks such a line unavailable, the same as a sold-out item, so every
 * app blocks the order button on it and offers Remove.
 */
export function lineOptionsIssue(item: { optionGroups?: ValidatableGroup[] | null }, selected: unknown): string | null {
  try {
    validateSelectedOptions(item, selected);
    return null;
  } catch (error) {
    if (!(error instanceof OptionSelectionError)) throw error;
    if (error.reason === 'OPTION_UNAVAILABLE' && error.optionName) return `${error.optionName} is sold out — remove and choose again`;
    if (error.reason === 'OPTION_UNKNOWN') return 'A choice is no longer on the menu — remove and choose again';
    return 'Your choices need updating — remove and choose again';
  }
}
