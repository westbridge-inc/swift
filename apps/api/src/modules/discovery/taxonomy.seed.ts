import type { PrismaClient, DiscoveryCategoryKind, DiscoveryCategoryVertical } from '@prisma/client';

// ---------------------------------------------------------------------------
// The seed taxonomy (category spec Part 3) — inserted EXACTLY as written, per
// tenant, idempotently (upsert on [tenantId, slug]; founder renames/hides/
// reorders afterward in admin). Aliases feed the Stage-A matcher — the
// Guyanese terms are the local moat: extend them as real menus teach you,
// never trim the seeds.
// ---------------------------------------------------------------------------

export interface SeedCategory {
  slug: string;
  name: string;
  kind: DiscoveryCategoryKind;
  vertical: DiscoveryCategoryVertical;
  emoji: string;
  aliases: string[];
  sortWeight: number;
}

const FOOD: Array<[string, string, DiscoveryCategoryKind, string, string[]]> = [
  ['local-creole', 'Local & Creole', 'CUISINE', '🍲', ['creole', 'guyanese', 'cook-up', 'cookup rice', 'pepperpot', 'metemgee', 'garlic pork', 'fried rice and chicken', 'bake and saltfish']],
  ['roti-curry', 'Roti & Curry', 'CUISINE', '🫓', ['roti', 'dhalpuri', 'dhal puri', 'puri', 'curry', 'dhal', 'aloo', 'channa', 'duck curry']],
  ['snackette', 'Snackette', 'DISH', '🥟', ['egg ball', 'pholourie', 'plantain chips', 'cheese roll', 'pine tart', 'patties', 'black pudding', 'chicken foot']],
  ['chinese', 'Chinese', 'CUISINE', '🥡', ['chowmein', 'chow mein', 'lo mein', 'fried rice', 'wonton', 'char siu']],
  ['fried-chicken', 'Fried Chicken', 'DISH', '🍗', ['broasted', 'crispy chicken', 'chicken and chips']],
  ['bbq-grill', 'BBQ & Grill', 'CUISINE', '🍖', ['bbq', 'barbecue', 'jerk', 'grilled']],
  ['seafood', 'Seafood', 'CUISINE', '🦐', ['fish', 'shrimp', 'prawns', 'bangamary', 'gilbaka', 'trout']],
  ['fast-food', 'Fast Food', 'CUISINE', '🍟', ['combo', 'value meal']],
  ['burgers', 'Burgers', 'DISH', '🍔', ['cheeseburger', 'smash burger']],
  ['pizza', 'Pizza', 'DISH', '🍕', ['slice', 'pepperoni']],
  ['wings', 'Wings', 'DISH', '🍗', ['buffalo wings', 'bbq wings']],
  ['breakfast', 'Breakfast', 'DISH', '🍳', ['bake', 'saltfish', 'plantain', 'porridge']],
  ['bakery-pastries', 'Bakery & Pastries', 'CUISINE', '🥐', ['bread', 'tennis roll', 'salara', 'cake', 'pastry', 'buns']],
  ['ice-cream-desserts', 'Ice Cream & Desserts', 'DISH', '🍦', ['dessert', 'sundae', 'cheesecake', 'fudge']],
  ['juices-smoothies', 'Juices & Smoothies', 'DISH', '🥤', ['juice', 'smoothie', 'fruit punch', 'mauby', 'sorrel', 'peanut punch', 'coconut water']],
  ['indian', 'Indian', 'CUISINE', '🍛', ['biryani', 'tandoori', 'naan']],
  ['vegan-vegetarian', 'Vegan & Vegetarian', 'DIETARY', '🥗', ['vegan', 'vegetarian', 'plant based', 'meatless', 'tofu']],
];

const GROCERY: Array<[string, string, string, string[]]> = [
  ['produce', 'Fresh Produce', '🥭', ['fruits', 'vegetables', 'ground provisions', 'plantain', 'cassava', 'eddoes', 'bora']],
  ['meat-poultry', 'Meat & Poultry', '🥩', ['beef', 'chicken', 'mutton', 'pork']],
  ['seafood-market', 'Fresh Seafood', '🐟', []],
  ['rice-grains', 'Rice & Grains', '🌾', ['rice', 'flour', 'split peas', 'oats']],
  ['beverages', 'Beverages', '🧃', ['drinks', 'soda', 'malta', 'water']],
  ['snacks', 'Snacks', '🍪', ['biscuits', 'chips', 'confectionery']],
  ['dairy-eggs', 'Dairy & Eggs', '🥚', []],
  ['frozen', 'Frozen', '🧊', []],
  ['household', 'Household & Cleaning', '🧼', ['detergent', 'bleach', 'soap powder']],
  ['personal-care', 'Personal Care', '🧴', []],
  ['baby-kids', 'Baby & Kids', '🍼', ['diapers', 'formula']],
];

const RETAIL: Array<[string, string, string, string[]]> = [
  ['electronics', 'Electronics', '📱', ['phone', 'laptop', 'tv', 'speaker', 'charger']],
  ['phone-accessories', 'Phone Accessories', '🔌', ['case', 'screen protector', 'earbuds', 'cable']],
  ['fashion', 'Fashion & Clothing', '👕', ['clothes', 'dress', 'jeans', 'shirt']],
  ['shoes', 'Shoes', '👟', ['sneakers', 'slippers', 'sandals']],
  ['beauty', 'Beauty & Cosmetics', '💄', ['makeup', 'skincare', 'wig', 'lashes']],
  ['pharmacy', 'Pharmacy & Health', '💊', ['medicine', 'otc', 'vitamins', 'first aid']],
  ['flowers-gifts', 'Flowers & Gifts', '💐', ['bouquet', 'roses', 'gift basket', 'teddy']],
  ['home-kitchen', 'Home & Kitchen', '🍳', ['cookware', 'appliances', 'bedding']],
  ['hardware-tools', 'Hardware & Tools', '🔧', ['tools', 'paint', 'plumbing', 'electrical']],
  ['auto-parts', 'Auto Parts', '🚗', ['tyres', 'battery', 'oil', 'brake']],
  ['stationery-books', 'Stationery & Books', '📚', ['school supplies', 'exercise book', 'pens']],
  ['toys-games', 'Toys & Games', '🧸', []],
  ['sports', 'Sports & Fitness', '⚽', []],
  ['pets', 'Pet Supplies', '🐾', ['dog food', 'cat food']],
];

export const SEED_TAXONOMY: SeedCategory[] = [
  ...FOOD.map(([slug, name, kind, emoji, aliases], i) => ({
    slug, name, kind, vertical: 'FOOD' as DiscoveryCategoryVertical, emoji, aliases, sortWeight: 100 + i * 10,
  })),
  ...GROCERY.map(([slug, name, emoji, aliases], i) => ({
    slug, name, kind: 'AISLE' as DiscoveryCategoryKind, vertical: 'GROCERY' as DiscoveryCategoryVertical, emoji, aliases, sortWeight: 100 + i * 10,
  })),
  ...RETAIL.map(([slug, name, emoji, aliases], i) => ({
    slug, name, kind: 'RETAIL' as DiscoveryCategoryKind, vertical: 'RETAIL' as DiscoveryCategoryVertical, emoji, aliases, sortWeight: 100 + i * 10,
  })),
];

/** Idempotent per-tenant seed: create-only for name/emoji/sortWeight (the
 *  founder's edits win forever), but aliases UNION on re-seed so shipped
 *  alias extensions reach existing tenants without trampling admin additions. */
export async function seedDiscoveryTaxonomy(prisma: PrismaClient, tenantId = 'swift-default'): Promise<{ created: number; aliasUpdated: number }> {
  let created = 0;
  let aliasUpdated = 0;
  for (const seed of SEED_TAXONOMY) {
    const existing = await prisma.discoveryCategory.findUnique({
      where: { tenantId_slug: { tenantId, slug: seed.slug } },
    });
    if (!existing) {
      await prisma.discoveryCategory.create({
        data: { ...seed, tenantId, isSeed: true },
      });
      created += 1;
      continue;
    }
    const merged = Array.from(new Set([...existing.aliases, ...seed.aliases]));
    if (merged.length !== existing.aliases.length) {
      await prisma.discoveryCategory.update({ where: { id: existing.id }, data: { aliases: merged } });
      aliasUpdated += 1;
    }
  }
  return { created, aliasUpdated };
}
