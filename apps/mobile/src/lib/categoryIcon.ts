import type { ComponentProps } from 'react';
import type { MaterialCommunityIcons } from '@expo/vector-icons';

/**
 * Discovery category -> the app's own icon (MaterialCommunityIcons, already
 * the app's icon family next to Feather). Owner, 17 Oct: the category rail
 * drew the seed's food emoji; categories are drawn with the app's icon set,
 * mapped HERE by slug, never from emoji in the data. A category this map does
 * not know (an admin-approved new one) gets the storefront icon.
 */
export type CategoryIconName = ComponentProps<typeof MaterialCommunityIcons>['name'];

export const CATEGORY_ICON_DEFAULT: CategoryIconName = 'storefront-outline';

export const CATEGORY_ICON: Readonly<Record<string, CategoryIconName>> = {
  // Food
  'local-creole': 'pot-steam-outline',
  'roti-curry': 'bowl-mix-outline',
  snackette: 'cupcake',
  chinese: 'noodles',
  'fried-chicken': 'food-drumstick-outline',
  'bbq-grill': 'grill-outline',
  seafood: 'fish',
  'fast-food': 'food',
  burgers: 'hamburger',
  pizza: 'pizza',
  wings: 'food-drumstick',
  breakfast: 'egg-fried',
  'bakery-pastries': 'food-croissant',
  'ice-cream-desserts': 'ice-cream',
  'juices-smoothies': 'cup-outline',
  indian: 'bowl-mix',
  'vegan-vegetarian': 'leaf',
  // Grocery aisles
  produce: 'food-apple-outline',
  'meat-poultry': 'food-steak',
  'seafood-market': 'fish',
  'rice-grains': 'barley',
  beverages: 'bottle-soda-classic-outline',
  snacks: 'cookie-outline',
  'dairy-eggs': 'egg-outline',
  frozen: 'snowflake',
  household: 'spray-bottle',
  'personal-care': 'lotion-outline',
  'baby-kids': 'baby-bottle-outline',
  // Retail
  electronics: 'cellphone',
  'phone-accessories': 'power-plug-outline',
  fashion: 'tshirt-crew-outline',
  shoes: 'shoe-sneaker',
  beauty: 'lipstick',
  'flowers-gifts': 'flower-outline',
  'home-kitchen': 'silverware-fork-knife',
  'hardware-tools': 'wrench-outline',
  'auto-parts': 'car-wrench',
  'stationery-books': 'book-open-variant',
  'toys-games': 'teddy-bear',
  sports: 'soccer',
  pets: 'paw',
};

export function categoryIcon(slug: string | null | undefined): CategoryIconName {
  return (slug && Object.prototype.hasOwnProperty.call(CATEGORY_ICON, slug) ? CATEGORY_ICON[slug] : undefined) ?? CATEGORY_ICON_DEFAULT;
}
