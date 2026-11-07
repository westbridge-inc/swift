// [TAP-AUDIT 27 Oct · owner: "every single button tap, adding menus"] A menu change shows the server's answer at once.
//
// Every change to the store's menu (an item switched off, a choice added, a section renamed, a photo) used to
// re-download the WHOLE menu (every section, item, option group and choice) before the screen settled, and the
// button waited for that second download too: two round trips, ~1.3 s on a 3G-like link, plus the whole list drawn
// again. A store switching ten items off at closing downloaded the menu ten times.
//
// Now the server's own answer to the change is written into the menu the screen already holds (never a guess: only
// what the server said it saved), and the menu is read again ONCE, after the changes stop (a burst of changes is
// one re-read). Anything an answer cannot place (an older server's shape, a menu not loaded) is left as it is: the
// re-read settles it. Prices are shown as the server sent them; nothing here computes money.

type Row = Record<string, unknown> & { id?: unknown };
type Section = Row & { items?: unknown };
type Item = Row & { categoryId?: unknown; optionGroups?: unknown };
type Group = Row & { options?: unknown };

const isRow = (v: unknown): v is Row => typeof v === 'object' && v !== null && typeof (v as Row).id === 'string';
const listOf = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const sameId = (a: unknown, id: unknown) => isRow(a) && a.id === id;

function mapItems(menu: unknown, fn: (item: Item) => Item | null): unknown {
  if (!Array.isArray(menu)) return menu;
  let changed = false;
  const next = menu.map((section: Section) => {
    if (!isRow(section) || !Array.isArray(section.items)) return section;
    const items: Item[] = [];
    let touched = false;
    for (const item of section.items as Item[]) {
      const out = isRow(item) ? fn(item) : item;
      if (out !== item) touched = true;
      if (out) items.push(out);
    }
    if (!touched) return section;
    changed = true;
    return { ...section, items };
  });
  return changed ? next : menu;
}

/** An item as the server saved it (create or edit): replaced in place, moved if its section changed, or added at the
 *  end of its section (where the server puts a new one). Fields the answer leaves out keep their menu value. */
export function menuWithItem(menu: unknown, answer: unknown): unknown {
  if (!Array.isArray(menu) || !isRow(answer) || typeof (answer as Item).categoryId !== 'string') return menu;
  const saved = answer as Item;
  let previous: Item | undefined;
  for (const section of menu as Section[]) for (const item of listOf<Item>(section?.items)) if (sameId(item, saved.id)) previous = item;
  if (!menu.some((section: Section) => sameId(section, saved.categoryId))) return menu;
  const merged: Item = { ...(previous ?? { optionGroups: [] }), ...saved };
  return (menu as Section[]).map((section) => {
    if (!isRow(section)) return section;
    const items = listOf<Item>(section.items);
    const here = items.some((item) => sameId(item, saved.id));
    if (section.id === saved.categoryId) {
      return { ...section, items: here ? items.map((item) => (sameId(item, saved.id) ? merged : item)) : [...items, merged] };
    }
    return here ? { ...section, items: items.filter((item) => !sameId(item, saved.id)) } : section;
  });
}

/** Some of an item's fields as the server answered them (its availability, its photo). */
export function menuWithItemFields(menu: unknown, id: string, fields: Record<string, unknown>): unknown {
  return mapItems(menu, (item) => (item.id === id ? { ...item, ...fields } : item));
}

/** An item the server archived: off the menu. */
export function menuWithoutItem(menu: unknown, id: string): unknown {
  return mapItems(menu, (item) => (item.id === id ? null : item));
}

/** A section as the server saved it: renamed (its items kept), or added at the end (empty). */
export function menuWithSection(menu: unknown, answer: unknown): unknown {
  if (!Array.isArray(menu) || !isRow(answer)) return menu;
  const fields: Section = { ...(answer as Section) };
  delete fields.items; // a section's answer never carries its items; the menu's are kept
  if (menu.some((section: Section) => sameId(section, answer.id))) {
    return (menu as Section[]).map((section) => (sameId(section, answer.id) ? { ...section, ...fields } : section));
  }
  return [...menu, { ...fields, items: [] }];
}

/** A section the server archived (with its items): off the menu. */
export function menuWithoutSection(menu: unknown, id: string): unknown {
  return Array.isArray(menu) && menu.some((section: Section) => sameId(section, id))
    ? (menu as Section[]).filter((section) => !sameId(section, id))
    : menu;
}

function mapGroups(menu: unknown, fn: (group: Group, item: Item) => Group | null, onlyItem?: string): unknown {
  return mapItems(menu, (item) => {
    if (onlyItem !== undefined && item.id !== onlyItem) return item;
    const groups = listOf<Group>(item.optionGroups);
    let touched = false;
    const next: Group[] = [];
    for (const group of groups) {
      const out = isRow(group) ? fn(group, item) : group;
      if (out !== group) touched = true;
      if (out) next.push(out);
    }
    return touched ? { ...item, optionGroups: next } : item;
  });
}

/** An option group (with its choices) as the server saved it, added to its item. */
export function menuWithOptionGroup(menu: unknown, itemId: string, answer: unknown): unknown {
  if (!isRow(answer)) return menu;
  return mapItems(menu, (item) => {
    if (item.id !== itemId) return item;
    const groups = listOf<Group>(item.optionGroups);
    if (groups.some((group) => sameId(group, answer.id))) return item;
    return { ...item, optionGroups: [...groups, { options: [], ...answer }] };
  });
}

/** An option group the server deleted (with its choices). */
export function menuWithoutOptionGroup(menu: unknown, groupId: string): unknown {
  return mapGroups(menu, (group) => (group.id === groupId ? null : group));
}

/** A choice as the server saved it, added to its group. */
export function menuWithOption(menu: unknown, groupId: string, answer: unknown): unknown {
  if (!isRow(answer)) return menu;
  return mapGroups(menu, (group) => {
    if (group.id !== groupId) return group;
    const options = listOf<Row>(group.options);
    return options.some((option) => sameId(option, answer.id)) ? group : { ...group, options: [...options, answer] };
  });
}

/** A choice the server deleted. */
export function menuWithoutOption(menu: unknown, optionId: string): unknown {
  return mapGroups(menu, (group) => {
    const options = listOf<Row>(group.options);
    return options.some((option) => sameId(option, optionId)) ? { ...group, options: options.filter((option) => !sameId(option, optionId)) } : group;
  });
}

/** How long the menu waits after the last change before it is read again (a burst of changes is one re-read). */
export const MENU_REREAD_SETTLE_MS = 1_200;
