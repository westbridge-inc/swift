/**
 * The icons a discovery category may carry (DiscoveryCategory.iconKey), for the
 * admin routes' validation. Owner 17 Oct: a category carries one of the app's
 * icons, never an emoji.
 *
 * A copy, on purpose: the compiled API cannot load a runtime value from the
 * source-only @swift/types package (runtime-package-imports.unit.test.ts). The
 * shared list is @swift/types CATEGORY_ICON_OPTIONS; category-icon-keys.unit.test.ts
 * fails the moment the two differ.
 */
export const CATEGORY_ICON_KEYS: readonly string[] = [
  'storefront-outline', 'pot-steam-outline', 'bowl-mix-outline', 'bowl-mix', 'cupcake',
  'noodles', 'food-drumstick-outline', 'food-drumstick', 'grill-outline', 'fish',
  'food', 'hamburger', 'pizza', 'egg-fried', 'food-croissant',
  'ice-cream', 'cup-outline', 'leaf', 'food-apple-outline', 'food-steak',
  'barley', 'bottle-soda-classic-outline', 'cookie-outline', 'egg-outline', 'snowflake',
  'spray-bottle', 'lotion-outline', 'baby-bottle-outline', 'cellphone', 'power-plug-outline',
  'tshirt-crew-outline', 'shoe-sneaker', 'lipstick', 'flower-outline', 'silverware-fork-knife',
  'wrench-outline', 'car-wrench', 'book-open-variant', 'teddy-bear', 'soccer',
  'paw',
];

export function isCategoryIconKey(value: unknown): value is string {
  return typeof value === 'string' && CATEGORY_ICON_KEYS.includes(value);
}
