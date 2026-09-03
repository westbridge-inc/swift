import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { visibleVendorInTenant } from '../vendor/vendor-visibility';
import { bindPublicMarketTenant, decodeScopedCursor, encodeScopedCursor } from '../search/search-scope';
import { ITEM_HIT_SELECT, toItemHit, type ItemHit } from '../search/item-hit';
import { AppError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// THE MARKET FEED [MKT G1] — items across every store, by category.
//
// The Market tab shipped as a SHOP DIRECTORY: it called the vendors API filtered
// to `type=STORE` and rendered vendor cards, so pressing one opened a store.
// The ask was a CATALOGUE — "all items listed by categories… tools, hardware,
// clothes, jewellery… and when they click the item it'll be at their respective
// store, like Amazon". One lists shops; the other lists things.
//
// Everything that difference needs already existed — the cross-vendor taxonomy,
// item→category tagging, the classifier, the product page, the cart hooks —
// except the endpoint that joins them. That is this. It is a CONNECTION, not a
// construction: no new model, no second cart, no market-only index.
//
// THE ONE MISTAKE THIS FILE EXISTS TO AVOID: there are two category systems.
// `Item.categoryId` is VENDOR-SCOPED — City Hardware's own "Power Tools" aisle,
// cascade-deleted with the vendor. `ItemDiscoveryCategory` is the cross-vendor
// shopper's taxonomy. Filtering on the former looks right and returns plausible
// data — one shop's shelf wearing a category's name. The feed filters on the
// latter, always.
// ---------------------------------------------------------------------------

/** How many tagged items one category page will resolve ids for. Far above any
 *  plausible category at launch depth (the tab itself stays hidden below ~150
 *  items); a breach is LOGGED, never silently truncated. */
const CATEGORY_ITEM_CAP = 5_000;

/**
 * Which sellers a vertical means. RETAIL is the STORE — "goods, not food:
 * clothes, tools, household things, the stuff a STORE sells", in the Market
 * screen's own words. A restaurant's dishes and a tradesperson's services are
 * real catalogue items with their own tabs; they are not this one.
 */
const VERTICAL_VENDOR_TYPE = { RETAIL: 'STORE' } as const;

const SORTS = ['new', 'popular', 'price_asc', 'price_desc'] as const;
type Sort = (typeof SORTS)[number];

const marketQuerySchema = z.object({
  /** A DiscoveryCategory slug. Absent = "All". */
  category: z.string().trim().max(80).optional(),
  /** This tab is goods. Kept explicit so a future tab can reuse the feed. */
  vertical: z.enum(['RETAIL']).default('RETAIL'),
  sort: z.enum(SORTS).default('popular'),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(24),
  // NOTE: `lat`/`lng` are deliberately NOT accepted yet. The contract lists them
  // for deliverability + distance, and no deliverability primitive exists for
  // items — vendor reach is a booking-only concept today. Accepting them and
  // ignoring them would be the banned pattern in its purest form: "a chip that
  // filters nothing is a chip that lies". They slot in when the primitive does.
});

/** Keyset cursors are minted and checked by the scope module: they carry the
 *  sort AND the tenant they were produced under, so a cursor can neither be
 *  replayed against a different ordering nor walk another operator's catalogue. */
/** Ordering, always with `id` as the tiebreaker so keyset paging is stable when
 *  the sort column has duplicates (every price and every totalOrdered does). */
function orderFor(sort: Sort) {
  const dir = sort === 'price_asc' ? 'asc' : 'desc';
  if (sort === 'new') return [{ createdAt: 'desc' as const }, { id: 'asc' as const }];
  if (sort === 'popular') return [{ totalOrdered: 'desc' as const }, { id: 'asc' as const }];
  return [{ basePrice: dir as 'asc' | 'desc' }, { id: 'asc' as const }];
}

export async function marketRoutes(app: FastifyInstance) {
  // [R048-003] A guest surface has no session to bind a tenant from, so the
  // public market resolver binds one for every request here — the taxonomy,
  // the join rows and the vendors are tenant-scoped models and partition
  // themselves once bound; items carry no tenant and name it explicitly.
  app.addHook('preHandler', bindPublicMarketTenant(app));
  /**
   * GET /items — the catalogue, across stores.
   *
   * `isAvailable: true` is not a nicety: the inventory engine auto-hides an item
   * at zero stock and auto-returns it on restock, so the feed inherits live
   * stock for free — and defeating it here would sell things that are gone.
   */
  app.get('/items', async (request) => {
    const q = marketQuerySchema.parse(request.query);
    const tenantId = request.publicTenantId!;

    // Resolve the category slug to an id FIRST, so an unknown slug is an honest
    // 404 rather than a silently empty grid that looks like "we sell nothing".
    let categoryId: string | null = null;
    if (q.category) {
      // `status`, not a boolean — the taxonomy has four states. A MERGED slug
      // is a real category that was folded into another, so it resolves to its
      // target rather than 404ing: the founder's own governance model says
      // merged slugs redirect, and an old link must not become a dead end.
      // the slug is unique per (tenant, slug): two operators may share it, and only this tenant's resolves
      const cat = await app.prisma.discoveryCategory.findFirst({
        where: { tenantId, slug: q.category, status: { in: ['ACTIVE', 'MERGED'] } },
        select: { id: true, status: true, mergedIntoId: true },
      });
      if (!cat) throw new AppError(404, 'CATEGORY_NOT_FOUND', 'That category does not exist.');
      categoryId = cat.status === 'MERGED' && cat.mergedIntoId ? cat.mergedIntoId : cat.id;
    }

    // THE TAXONOMY IS A JOIN TABLE WITHOUT A PRISMA RELATION, AND THAT IS
    // DELIBERATE. `ItemDiscoveryCategory` and its sibling
    // `VendorDiscoveryCategory` both carry plain scalar ids and no `@relation`,
    // so a category merge or retirement cannot cascade into items or vendors —
    // the taxonomy is decoupled from the catalogue on purpose. That means no
    // `some:` filter exists to write, and adding a relation to one of the pair
    // would break a design its sibling still keeps.
    //
    // So the ids are resolved explicitly. This is bounded work per request and
    // sorts correctly by item fields, which a join-table-driven page could not.
    let itemIdsInCategory: string[] | null = null;
    if (categoryId) {
      const tags = await app.prisma.itemDiscoveryCategory.findMany({
        where: { tenantId, categoryId },
        select: { itemId: true },
        take: CATEGORY_ITEM_CAP + 1,
      });
      if (tags.length > CATEGORY_ITEM_CAP) {
        // NO SILENT CAPS. Say it out loud rather than serve a quietly partial
        // category; at that size this needs the relation and a real join.
        request.log.warn(
          { categoryId, cap: CATEGORY_ITEM_CAP },
          'market: category exceeds the id-resolution cap — results are partial, add the join',
        );
      }
      itemIdsInCategory = tags.slice(0, CATEGORY_ITEM_CAP).map((t) => t.itemId);
    }

    const where = {
      isAvailable: true,
      vendor: {
        // [M4] The ONE visibility predicate, imported — inside THIS tenant
        // ([R048-003]: the relation filter is not reached by the scoping
        // extension, so the tenant is named here). Re-expressing it would be
        // its seventh copy, and the copies already disagree.
        ...visibleVendorInTenant(tenantId),
        // THE MARKET IS GOODS. Without this the feed returned every item from
        // every vendor type, so the goods tab filled with restaurant dishes —
        // Dhal Puri, Pork Chops, Margherita — and service listings. `vertical`
        // was parsed and then never used: a parameter that filters nothing,
        // which is the same lie this file refuses `lat`/`lng` for six lines
        // above. Openness and type are per-surface extras and belong at the
        // call site by that predicate's own rule; visibility does not.
        vendorType: VERTICAL_VENDOR_TYPE[q.vertical],
      },
      // [§4.2] The CROSS-VENDOR taxonomy. Never `Item.categoryId`, which is the
      // store's own shelf and would return one shop's aisle wearing a
      // category's name.
      ...(itemIdsInCategory ? { id: { in: itemIdsInCategory } } : {}),
    };

    const cursorId = q.cursor ? decodeScopedCursor(q.cursor, tenantId, q.sort) : null;

    const [rows, total] = await Promise.all([
      app.prisma.item.findMany({
        where,
        select: ITEM_HIT_SELECT,
        orderBy: orderFor(q.sort),
        take: q.limit + 1, // one extra: its existence IS "there is a next page"
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      }),
      app.prisma.item.count({ where }),
    ]);

    const page = rows.slice(0, q.limit);
    const items: ItemHit[] = page.map(toItemHit);
    const last = page[page.length - 1];

    return {
      success: true,
      data: {
        items,
        // A cursor only when a further page actually exists — never a cursor
        // that leads to an empty page.
        nextCursor: rows.length > q.limit && last ? encodeScopedCursor(tenantId, last.id, q.sort) : null,
        meta: { total, category: q.category ?? null },
      },
    };
  });
}
