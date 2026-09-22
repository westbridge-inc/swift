const KIND_LABEL: Record<string, string> = {
  CUISINE: 'Cuisine',
  DISH: 'Dish',
  DIETARY: 'Dietary',
  AISLE: 'Grocery aisle',
  RETAIL: 'Department',
};

/** Human copy only. Unknown kinds remain truthful instead of inventing art. */
export function categoryKindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? 'Category';
}

export type CategoryTintKey = 'food' | 'groceries' | 'shops';

export function categoryTintKey(vertical: string): CategoryTintKey {
  if (vertical === 'FOOD') return 'food';
  if (vertical === 'GROCERY') return 'groceries';
  return 'shops';
}
