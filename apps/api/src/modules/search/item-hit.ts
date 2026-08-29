/**
 * `ItemHit` — THE shape an item takes when it is listed outside its own store.
 *
 * Search returns it, and the Market feed returns it. Extracted here so there is
 * exactly one definition: the marketplace law is "one catalogue, one cart, one
 * search index, one design system — the Market tab is a LENS over them, it never
 * gets its own", and a second item shape is the first crack in that. A client
 * that can render a search result can render a market card, unchanged.
 *
 * `categoryName` comes from `Item.category` — the VENDOR-SCOPED category, the
 * store's own shelf. It is a fine subtitle on a card. It is NOT the market's
 * category chip: that is `ItemDiscoveryCategory`, which is cross-vendor. The two
 * are easy to confuse and confusing them returns one shop's aisle while looking
 * like a whole category.
 */
export type ItemHit = {
  id: string;
  name: string;
  basePrice: number;
  imageUrl: string | null;
  vendorId: string;
  vendorName: string;
  categoryName: string | null;
};

/** The `select` every ItemHit query needs — kept beside the type so a caller
 *  cannot select less than the shape promises and fail at runtime. */
export const ITEM_HIT_SELECT = {
  id: true,
  name: true,
  basePrice: true,
  imageUrl: true,
  vendorId: true,
  vendor: { select: { name: true } },
  category: { select: { name: true } },
} as const;

type ItemHitRow = {
  id: string;
  name: string;
  basePrice: unknown;
  imageUrl: string | null;
  vendorId: string;
  vendor: { name: string } | null;
  category: { name: string } | null;
};

/** One mapper, so `basePrice` is a number everywhere and a missing relation is
 *  null rather than a crash. */
export function toItemHit(row: ItemHitRow): ItemHit {
  return {
    id: row.id,
    name: row.name,
    basePrice: Number(row.basePrice),
    imageUrl: row.imageUrl,
    vendorId: row.vendorId,
    vendorName: row.vendor?.name ?? '',
    categoryName: row.category?.name ?? null,
  };
}
