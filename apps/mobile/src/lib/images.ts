import { API_URL } from '../services/api';

// Shared imagery for cards/heroes when a vendor/item has no photo yet.
// Photo-led UI; a deterministic fallback keeps the same entity on the same image
// (no flicker between renders) and is type-aware (no food photos on a hardware store).

export const FOOD_IMAGES = [
  'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&q=80',
  'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&q=80',
  'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600&q=80',
  'https://images.unsplash.com/photo-1567620905732-2d1ec7ab7445?w=600&q=80',
  'https://images.unsplash.com/photo-1565958011703-44f9829ba187?w=600&q=80',
  'https://images.unsplash.com/photo-1432139555190-58524dae6a55?w=600&q=80',
];

export const GROCERY_IMAGES = [
  'https://images.unsplash.com/photo-1542838132-92c53300491e?w=600&q=80',
  'https://images.unsplash.com/photo-1488459716781-31db52582fe9?w=600&q=80',
  'https://images.unsplash.com/photo-1604719312566-8912e9227c6a?w=600&q=80',
  'https://images.unsplash.com/photo-1578916171728-46686eac8d58?w=600&q=80',
];

// Generic storefront / service imagery (no food).
export const NEUTRAL_IMAGES = [
  'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=600&q=80',
  'https://images.unsplash.com/photo-1530124566582-a618bc2615dc?w=600&q=80',
  'https://images.unsplash.com/photo-1581244277943-fe4a9c777189?w=600&q=80',
  'https://images.unsplash.com/photo-1521791136064-7986c2920216?w=600&q=80',
];

// Neutral dark-charcoal placeholder blurhash (avg sRGB ~#1d1d1f) so a slow or
// failed image load reads as an intentional dark tile under the scrim + label,
// never a broken-image icon. NB: the previous value decoded to vivid BLUE
// (sRGB 34,38,178) — every un-loaded product/vendor card showed a blue block.
export const DARK_BLURHASH = 'L03R{_fQfQfQfQfQfQfQfQfQfQfQ';

export const CATEGORY_IMAGES: Record<string, string> = {
  food: 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=400&q=80',
  grocery: 'https://images.unsplash.com/photo-1542838132-92c53300491e?w=400&q=80',
  taxi: 'https://images.unsplash.com/photo-1502877338535-766e1452684a?w=400&q=80',
  courier: 'https://images.unsplash.com/photo-1526367790999-0150786686a2?w=400&q=80',
  shops: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=400&q=80',
  services: 'https://images.unsplash.com/photo-1621905251189-08b45d6a269e?w=400&q=80',
};

/** Imagery for a Home category tile; falls back to a food photo if unmapped. */
export function categoryImage(key: string): string {
  return CATEGORY_IMAGES[key] ?? FOOD_IMAGES[0]!;
}

export type ImageKind = 'food' | 'grocery' | 'store' | 'service';

const POOLS: Record<ImageKind, string[]> = {
  food: FOOD_IMAGES,
  grocery: GROCERY_IMAGES,
  store: NEUTRAL_IMAGES,
  service: NEUTRAL_IMAGES,
};

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function fallbackImage(seed?: string | null, kind: ImageKind = 'food'): string {
  const pool = POOLS[kind] ?? FOOD_IMAGES;
  return pool[hash(seed ?? '') % pool.length]!;
}

/** Map a vendor's type to the right fallback image pool. */
export function kindForVendor(v?: { vendorType?: string | null } | null): ImageKind {
  switch (v?.vendorType) {
    case 'SUPERMARKET':
      return 'grocery';
    case 'STORE':
      return 'store';
    case 'SERVICE':
      return 'service';
    default:
      return 'food';
  }
}

/** A vendor's display image: real cover/logo, else a type-aware fallback. */
export function vendorImage(v: {
  coverImageUrl?: string | null;
  logoUrl?: string | null;
  id?: string;
  vendorType?: string | null;
}): string {
  return v.coverImageUrl || v.logoUrl || fallbackImage(v.id, kindForVendor(v));
}

/** Absolute URL for a stored media path. A relative "/uploads/..." key (local
 *  storage provider) gets the API origin prefixed; absolute URLs pass through. */
export function mediaUrl(url?: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  return `${API_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** A menu item's display image: its own photo, else a deterministic food fallback. */
export function itemImage(item: { imageUrl?: string | null; id?: string }): string {
  return mediaUrl(item.imageUrl) || fallbackImage(item.id, 'food');
}
