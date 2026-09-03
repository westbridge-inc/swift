import { docId } from './search-scope';
/**
 * `ItemHit` — THE shape an item takes when it is listed outside its own store.
 *
 * Search returns it, and the Market feed returns it. This file is the one
 * definition: the marketplace law is "one catalogue, one cart, one search index,
 * one design system — the Market tab is a LENS over them, it never gets its
 * own", and a second item shape is the first crack in that. A client that can
 * render a search result can render a market card, unchanged.
 *
 * ⚠️ THE CLAIM ABOVE WAS FALSE FOR THREE DAYS AND THIS IS THE REPAIR. The file
 * was extracted for the Market feed with a comment saying "search returns it" —
 * and search never adopted it. `search.routes.ts` kept its own local
 * `type ItemHit` and hand-built the object TWICE (once from Meilisearch hits,
 * once from Prisma rows), and `search.service.ts` hand-built the index document
 * twice more. Four hand-written copies of one shape, under a comment asserting
 * there was one. Extracting a definition and leaving the originals running is
 * not consolidation; it is a fifth copy with a promise attached. Everything an
 * item looks like outside its store now lives HERE: the wire shape, the DB
 * select, the search-index document, and the mapper for each.
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
  /** Recently listed — the `NEW` badge the founder's Market reference draws.
   *  DERIVED on the server, never stored, so every surface agrees on what new
   *  means; a client that computed its own would drift the moment two clients
   *  picked different windows. See `NEW_ITEM_WINDOW_DAYS`. */
  isNew: boolean;
};

/**
 * How long a listing wears `NEW`.
 *
 * Fourteen days: long enough that stock added on a Monday is still flagged the
 * following weekend, short enough that a launch catalogue does not sit
 * permanently "new" and teach shoppers the badge means nothing. It is the ONE
 * definition — `LIMITED` and `HANDMADE` from the same reference are deliberately
 * absent, because no field on `Item` can honestly produce them (M-D3).
 */
export const NEW_ITEM_WINDOW_DAYS = 14;
const NEW_ITEM_WINDOW_MS = NEW_ITEM_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** The `select` every ItemHit query needs — kept beside the type so a caller
 *  cannot select less than the shape promises and fail at runtime. */
export const ITEM_HIT_SELECT = {
  id: true,
  name: true,
  basePrice: true,
  imageUrl: true,
  createdAt: true,
  vendorId: true,
  vendor: { select: { name: true } },
  category: { select: { name: true } },
} as const;

type ItemHitRow = {
  id: string;
  name: string;
  basePrice: unknown;
  imageUrl: string | null;
  createdAt: Date;
  vendorId: string;
  vendor: { name: string } | null;
  category: { name: string } | null;
};

/**
 * One mapper, so `basePrice` is a number everywhere and a missing relation is
 * null rather than a crash.
 *
 * NOTE: this reads the clock, and it deliberately takes NO `now` argument.
 * Every call site is `rows.map(toItemHit)`, and `Array.map` passes the INDEX as
 * the second argument — an optional `now` parameter would silently receive `0`
 * for the first row and `1` for the second, quietly marking the whole page as
 * ancient. Tests pin the boundary by choosing `createdAt`, not by injecting a
 * clock.
 */
export function toItemHit(row: ItemHitRow): ItemHit {
  return {
    id: row.id,
    name: row.name,
    basePrice: Number(row.basePrice),
    imageUrl: row.imageUrl,
    vendorId: row.vendorId,
    vendorName: row.vendor?.name ?? '',
    categoryName: row.category?.name ?? null,
    isNew: Date.now() - new Date(row.createdAt).getTime() < NEW_ITEM_WINDOW_MS,
  };
}

// ---------------------------------------------------------------------------
// THE SEARCH-INDEX DOCUMENT — the same item, as Meilisearch stores it.
//
// Kept in this file beside the wire shape because the two must agree: every
// field the fast path serves comes out of the index, so a field added to
// `ItemHit` and forgotten in the document makes the engine that answered
// visible to the client — which is the exact defect the route's own "ONE wire
// contract" comment was written for.
// ---------------------------------------------------------------------------

/** What one Item looks like in the index. `createdAt` rides as epoch millis:
 *  Meilisearch has no date type, and a number is also filterable and sortable
 *  should a "new arrivals" facet ever want it. */
export type ItemSearchDoc = {
  /** [R048-003] The index primary key: `<tenantId>__<itemId>` — one operator's id space never overlaps another's. */
  id: string;
  /** The item's own id, what clients receive as `id`. */
  entityId: string;
  /** The partition. Filterable; the server-built filter always names it. */
  tenantId: string;
  name: string;
  description: string;
  vendorId: string;
  vendorName: string;
  categoryName: string;
  basePrice: number;
  imageUrl: string | null;
  createdAt: number;
  isAvailable: boolean;
  isPopular: boolean;
  dietaryTags: string[];
  allergens: string[];
  totalOrdered: number;
  categories: string[];
};

type ItemDocRow = {
  id: string;
  name: string;
  description: string | null;
  vendorId: string;
  vendor: { name: string; tenantId: string };
  category: { name: string };
  basePrice: unknown;
  imageUrl: string | null;
  createdAt: Date;
  isAvailable: boolean;
  isPopular: boolean;
  dietaryTags: string[];
  allergens: string[];
  totalOrdered: number;
};

/** The ONE index-document builder. Both syncs (`syncAllItems` and
 *  `syncVendorItems`) call this, so a field can never be indexed by the full
 *  re-sync and missed by the per-vendor one — which would make an item's search
 *  card change shape depending on which job last touched it. */
export function toItemSearchDoc(row: ItemDocRow, categories: string[]): ItemSearchDoc {
  return {
    id: docId(row.vendor.tenantId, row.id),
    entityId: row.id,
    tenantId: row.vendor.tenantId,
    name: row.name,
    description: row.description || '',
    vendorId: row.vendorId,
    vendorName: row.vendor.name,
    categoryName: row.category.name,
    basePrice: Number(row.basePrice),
    imageUrl: row.imageUrl,
    createdAt: new Date(row.createdAt).getTime(),
    isAvailable: row.isAvailable,
    isPopular: row.isPopular,
    dietaryTags: row.dietaryTags,
    allergens: row.allergens,
    totalOrdered: row.totalOrdered,
    categories,
  };
}

/**
 * A Meilisearch hit, back into the one wire shape.
 *
 * A document indexed before `createdAt` was added carries no timestamp, and the
 * answer then is `isNew: false` — NOT a guess. Degraded data may only make a
 * surface more conservative [L6]: an un-badged new arrival is a missed flourish,
 * a `NEW` badge on year-old stock is the UI lying. The badge returns for that
 * item on its next sync.
 */
export function itemHitFromSearchDoc(h: Record<string, unknown>): ItemHit {
  const created = typeof h['createdAt'] === 'number' ? (h['createdAt'] as number) : null;
  return {
    // the entity id, never the tenant-prefixed document id
    id: String(h['entityId'] ?? h['id']),
    name: String(h['name']),
    basePrice: Number(h['basePrice'] ?? 0),
    imageUrl: (h['imageUrl'] as string | null) ?? null,
    vendorId: String(h['vendorId']),
    vendorName: String(h['vendorName'] ?? ''),
    categoryName: (h['categoryName'] as string | null) ?? null,
    isNew: created != null && Date.now() - created < NEW_ITEM_WINDOW_MS,
  };
}
