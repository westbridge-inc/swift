/**
 * The icons a discovery category may carry (DiscoveryCategory.iconKey).
 *
 * Owner, 17 Oct: categories are drawn with the app's own icon set, never with
 * emoji. Each key is a MaterialCommunityIcons glyph name (the app's icon family
 * next to Feather; a mobile test proves every key exists in the installed glyph
 * map). The admin console offers exactly this list when it creates a category,
 * the API refuses any other key, and the app draws a known key and falls back
 * to its slug map, then the default, for anything else.
 */
export const CATEGORY_ICON_OPTIONS = [
  { key: 'storefront-outline', label: 'Store (default)' },
  // Food
  { key: 'pot-steam-outline', label: 'Cooking pot' },
  { key: 'bowl-mix-outline', label: 'Bowl' },
  { key: 'bowl-mix', label: 'Bowl (filled)' },
  { key: 'cupcake', label: 'Cupcake' },
  { key: 'noodles', label: 'Noodles' },
  { key: 'food-drumstick-outline', label: 'Drumstick' },
  { key: 'food-drumstick', label: 'Drumstick (filled)' },
  { key: 'grill-outline', label: 'Grill' },
  { key: 'fish', label: 'Fish' },
  { key: 'food', label: 'Fast food' },
  { key: 'hamburger', label: 'Burger' },
  { key: 'pizza', label: 'Pizza' },
  { key: 'egg-fried', label: 'Fried egg' },
  { key: 'food-croissant', label: 'Croissant' },
  { key: 'ice-cream', label: 'Ice cream' },
  { key: 'cup-outline', label: 'Cup' },
  { key: 'leaf', label: 'Leaf' },
  // Grocery
  { key: 'food-apple-outline', label: 'Apple' },
  { key: 'food-steak', label: 'Steak' },
  { key: 'barley', label: 'Grain' },
  { key: 'bottle-soda-classic-outline', label: 'Bottle' },
  { key: 'cookie-outline', label: 'Cookie' },
  { key: 'egg-outline', label: 'Egg' },
  { key: 'snowflake', label: 'Frozen' },
  { key: 'spray-bottle', label: 'Spray bottle' },
  { key: 'lotion-outline', label: 'Lotion' },
  { key: 'baby-bottle-outline', label: 'Baby bottle' },
  // Retail
  { key: 'cellphone', label: 'Phone' },
  { key: 'power-plug-outline', label: 'Plug' },
  { key: 'tshirt-crew-outline', label: 'T-shirt' },
  { key: 'shoe-sneaker', label: 'Sneaker' },
  { key: 'lipstick', label: 'Lipstick' },
  { key: 'flower-outline', label: 'Flower' },
  { key: 'silverware-fork-knife', label: 'Fork and knife' },
  { key: 'wrench-outline', label: 'Wrench' },
  { key: 'car-wrench', label: 'Car repair' },
  { key: 'book-open-variant', label: 'Book' },
  { key: 'teddy-bear', label: 'Teddy bear' },
  { key: 'soccer', label: 'Ball' },
  { key: 'paw', label: 'Paw' },
] as const;

export type CategoryIconKey = (typeof CATEGORY_ICON_OPTIONS)[number]['key'];

export const CATEGORY_ICON_KEYS: readonly CategoryIconKey[] = CATEGORY_ICON_OPTIONS.map((o) => o.key);

export function isCategoryIconKey(value: unknown): value is CategoryIconKey {
  return typeof value === 'string' && (CATEGORY_ICON_KEYS as readonly string[]).includes(value);
}
