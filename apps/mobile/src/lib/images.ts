import { API_URL } from '../services/api';

// Shared imagery for cards/heroes when a vendor/item has no photo yet.
// Photo-led UI; a deterministic fallback keeps the same entity on the same image
// (no flicker between renders) and is type-aware (no food photos on a hardware store).

// [S8] The stock-photo pools that used to live here — FOOD_IMAGES,
// GROCERY_IMAGES, NEUTRAL_IMAGES — are GONE, and so is CATEGORY_IMAGES below.
// F-264 deleted the helpers that handed them out (fallbackImage/itemImage/
// vendorImage) but left the arrays behind, so the ammunition outlived the gun:
// nothing imported them any more, and any new call site could have picked one
// up and started advertising a stranger's dinner again. A pool of photographs
// of food nobody is selling has no honest use, so it does not get to sit here
// waiting for one. `stock-photo-gate.test.ts` now fails the build if a stock
// URL comes back.

// Neutral dark-charcoal placeholder blurhash (avg sRGB ~#1d1d1f) so a slow or
// failed image load reads as an intentional dark tile under the scrim + label,
// never a broken-image icon. NB: the previous value decoded to vivid BLUE
// (sRGB 34,38,178) — every un-loaded product/vendor card showed a blue block.
export const DARK_BLURHASH = 'L03R{_fQfQfQfQfQfQfQfQfQfQfQ';


/**
 * Imagery for a Home category chip — the merchant's own picture, or null.
 *
 * This used to be `CATEGORY_IMAGES[key] ?? FOOD_IMAGES[0]!`: a string,
 * unconditionally, from a map keyed by the six VERTICAL names (food, grocery,
 * taxi …). The chips on Home are vendor MENU categories — "Mains", "Produce",
 * "Rice & Grains" — so no key ever matched and every chip on the screen was
 * the same stock photograph of somebody's breakfast. Three different
 * categories, one identical image, visible on the running app.
 *
 * Which is precisely what the F-264 note below this function describes, about
 * the three sibling helpers that were deleted for doing it. This one was in
 * the same file, directly above the explanation, and was missed.
 *
 * `Category.imageUrl` is a real column and now travels on the feed. When a
 * merchant has not set one the honest answer is NOTHING — the caller draws a
 * placeholder that names the category, rather than advertising a stranger's
 * food under it.
 *
 * The vertical fallback map went with the pools. It only ever matched six
 * literal names, so it fired for a handful of chips and silently put a stock
 * photograph on them while every neighbouring chip drew an honest placeholder
 * — one rail, two different truth standards. `Photo` renders
 * `PhotoPlaceholder` on null (the vertical's ground colour, its pictogram and
 * the category's real name), so null is not a blank: it is the designed tile.
 */
export function categoryPhoto(
  category: { name?: string | null; imageUrl?: string | null },
  width: StorePhotoWidth = 320, // a Home category tile is a small square
): string | null {
  // [IMAGES-E2E PR4] Through storePhotoUrl like every store photo: the stored value is a bare
  // key ("items/<store>/<file>") that no image view can load without the API origin.
  return storePhotoUrl(category.imageUrl, width);
}

/**
 * [F-264] `fallbackImage`, `itemImage` and `vendorImage` USED TO LIVE HERE and
 * are deliberately gone. They returned a string unconditionally, inventing a
 * random stock photograph keyed off the row id whenever a thing had none — so
 * every call site silently advertised a stranger's food and no reviewer could
 * see the lie at the call site. Use `itemPhoto`/`vendorPhoto` below, which
 * return null, and let the card draw an honest placeholder. Deleting them
 * rather than deprecating them is the point: a helper that CAN invent a photo
 * will be used again.
 */
export type ImageKind = 'food' | 'grocery' | 'store' | 'service';


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

/** Absolute URL for a stored media path. A relative "/uploads/..." key (local
 *  storage provider) gets the API origin prefixed; absolute URLs pass through. */
export function mediaUrl(url?: string | null): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  return `${API_URL}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** A menu item's display image: its own photo, else a deterministic food fallback. */

/**
 * The HONEST photo accessors [F-264].
 *
 * `itemImage`/`vendorImage` above fall back to `fallbackImage()`, which hands
 * out a RANDOM stock photo keyed off the row id. That is how "Mauby" — a
 * Guyanese drink — came to be advertised on Home with a photograph of a
 * cheeseburger. On a marketplace a customer chooses from the picture, so a
 * picture of something they are not buying misrepresents the goods; and once
 * any photo on a screen might be invented, the real ones stop being evidence.
 *
 * These return null instead of inventing one, so a card can render a designed
 * placeholder that names the actual item. The older helpers are kept for the
 * call sites not yet migrated rather than being changed underneath them — a
 * silent signature change across twenty-one screens is its own defect.
 */
export function itemPhoto(item: { imageUrl?: string | null }, width: StorePhotoWidth = LIST_PHOTO_WIDTH): string | null {
  return storePhotoUrl(item.imageUrl, width);
}

/** [IMAGES-E2E] The cover (else the logo) as an address the app can load. It used to be
 *  handed out as stored: a store photo kept in object storage is a bare key
 *  ("items/<store>/<file>"), which no image view can load without the API origin. */
export function vendorPhoto(
  v?: { coverImageUrl?: string | null; logoUrl?: string | null } | null,
  width: StorePhotoWidth = LIST_PHOTO_WIDTH,
): string | null {
  if (!v) return null;
  return storePhotoUrl(v.coverImageUrl || v.logoUrl, width);
}

/** The widths the API's store-photo door draws (apps/api utils/public-store-photos.ts
 *  STORE_PHOTO_WIDTHS); any other width is refused there. */
export const STORE_PHOTO_WIDTHS = [160, 320, 480, 640, 960, 1280] as const;
export type StorePhotoWidth = (typeof STORE_PHOTO_WIDTHS)[number];
/** A card in a list or a row: a phone screen's card is at most ~400 pt wide. */
export const LIST_PHOTO_WIDTH: StorePhotoWidth = 640;
/** A photo across the whole screen (a store's or an item's own page). */
export const HERO_PHOTO_WIDTH: StorePhotoWidth = 1280;

/** A key in a public photo folder (stores' photos, providers' portfolios), exactly as the upload saves it in object storage. */
const STORE_PHOTO_KEY = /^\/?(?:items|portfolio)\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{16}(?:\.[A-Za-z0-9_-]{1,16})?$/;

/** [IMAGES-E2E PR4 · COORD ruling 19 Oct (a)] A photo Swift keeps: a path with no host (the API's
 *  utils/photo-address.ts rule). An outside address saved before photos became upload-only is no
 *  longer handed to customers, so the store's own screens say it needs uploading again. */
const KEPT_PHOTO_ADDRESS = /^\/?[A-Za-z0-9_-][A-Za-z0-9_./-]*$/;
export function isKeptPhoto(url?: string | null): boolean {
  return typeof url === 'string' && KEPT_PHOTO_ADDRESS.test(url);
}

/** [IMAGES-E2E] A store photo sized for where it is drawn: a key in the stores' photo
 *  folder asks the server for that width (a list gets a small copy, not the full
 *  photo); any other address is mediaUrl unchanged. */
export function storePhotoUrl(url: string | null | undefined, width: StorePhotoWidth = LIST_PHOTO_WIDTH): string | null {
  const absolute = mediaUrl(url);
  if (!absolute || !url || !STORE_PHOTO_KEY.test(url)) return absolute;
  return `${absolute}?w=${width}`;
}
