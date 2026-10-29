/**
 * The legacy `emoji` field a discovery category is served with.
 *
 * App builds 9-11 draw this field as the category's tile mark. Builds with the
 * icon rail (#1836) ignore it and draw the app icon from iconKey/slug. Owner
 * 17 Oct: no emoji in the UI, so a category created since then stores
 * emoji ''. Served as-is, that drew a BLANK tile on builds 9-11. COORD 18 Oct:
 * when the stored emoji is empty, serve the first letter of the category's
 * name, uppercase plain text, never an emoji. No request names its app build,
 * so every client gets the letter; the new builds never read it.
 */
export function legacyCategoryMark(c: { emoji: string | null; name: string; slug?: string }): string {
  if (c.emoji && c.emoji.trim()) return c.emoji;
  const first = `${c.name} ${c.slug ?? ''}`.match(/[\p{L}\p{N}]/u)?.[0] ?? '';
  return first.toLocaleUpperCase('en');
}
