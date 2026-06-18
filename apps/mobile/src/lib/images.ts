// Shared food imagery for cards/heroes when a vendor/item has no photo yet.
// Uber-style UIs are photo-led; a deterministic fallback keeps the same entity
// on the same image instead of flickering between renders.
export const FOOD_IMAGES = [
  'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&q=80',
  'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&q=80',
  'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600&q=80',
  'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=600&q=80',
  'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&q=80',
  'https://images.unsplash.com/photo-1432139555190-58524dae6a55?w=600&q=80',
];

export function fallbackImage(seed?: string | null): string {
  const s = seed ?? '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return FOOD_IMAGES[h % FOOD_IMAGES.length]!;
}
