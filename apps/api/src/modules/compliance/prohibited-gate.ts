/**
 * [GUARDRAILS §8] Applying the prohibited-items rule on every surface the server owns.
 *
 * `prohibited-items.ts` decides what an item IS (banned / waiting for a check /
 * approved / clear); this file reads the facts from the database and applies
 * the verdict:
 *
 *   · a partner cannot file an item or a store under a banned category, and
 *     cannot edit an item that is banned (409 PROHIBITED_ITEM, the owner's
 *     words: "Swift doesn't allow this item: alcohol.");
 *   · nobody sees a hidden item (banned, or a word hit not yet approved) —
 *     storefront menus, the website, Market, search, Home and the category
 *     rail leave it out, browse surfaces before any page is capped;
 *   · nobody can cart or order one — cart add/edit, basket upload, reorder,
 *     substitution and checkout (also under its row locks) refuse it the way
 *     they refuse a sold-out item (409 ITEM_UNAVAILABLE), so every app already
 *     shows the reason and offers Remove. Removing a line is never refused.
 *
 * The verdict is computed from the item's current words every time, so no
 * write path — a route, a CSV import, a till sync, a seed — can leave an item
 * judged on stale words.
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import {
  checkItem,
  classifyCategory,
  isHidden,
  notAllowedMessage,
  orderRefusalMessage,
  PROHIBITED_CLASS_LABELS,
  PROHIBITED_MARKS_PATTERN,
  PROHIBITED_PREFILTER_WORDS,
  WAITING_FOR_CHECK,
  type CatalogueCheck,
  type ItemWords,
  type ProhibitedClass,
} from './prohibited-items';

type Db = PrismaClient | Prisma.TransactionClient;

/** A platform category a partner tries to file an item or a store under. */
export function assertCategoryAllowed(category: { slug: string; name: string }, subject: 'item' | 'store' = 'item'): void {
  const hit = classifyCategory(category);
  if (!hit) return;
  const message = subject === 'item'
    ? notAllowedMessage(hit.prohibitedClass)
    : `Swift doesn't allow this category: ${PROHIBITED_CLASS_LABELS[hit.prohibitedClass]}.`;
  throw new AppError(409, 'PROHIBITED_ITEM', message, { prohibitedClass: hit.prohibitedClass, categorySlug: category.slug });
}

/** Platform categories each item is filed under (the join table has no Prisma relation). */
async function categoriesByItem(db: Db, itemIds: readonly string[]): Promise<Map<string, Array<{ slug: string; name: string }>>> {
  const out = new Map<string, Array<{ slug: string; name: string }>>();
  if (itemIds.length === 0) return out;
  const tags = await db.itemDiscoveryCategory.findMany({ where: { itemId: { in: [...itemIds] } }, select: { itemId: true, categoryId: true } });
  if (tags.length === 0) return out;
  const categories = await db.discoveryCategory.findMany({ where: { id: { in: [...new Set(tags.map((t) => t.categoryId))] } }, select: { id: true, slug: true, name: true } });
  const byId = new Map(categories.map((c) => [c.id, c]));
  for (const tag of tags) {
    const c = byId.get(tag.categoryId);
    if (c) out.set(tag.itemId, [...(out.get(tag.itemId) ?? []), { slug: c.slug, name: c.name }]);
  }
  return out;
}

/** The partner's own words for each item, with its store — what a reviewer reads and what an approval is bound to. */
export async function wordsFor(db: Db, itemIds: readonly string[]): Promise<Map<string, ItemWords & { vendorId: string; vendorName: string }>> {
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return new Map();
  const items = await db.item.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, name: true, description: true, vendorId: true,
      vendor: { select: { name: true } },
      category: { select: { name: true } },
      optionGroups: { select: { name: true, options: { select: { name: true } } } },
    },
  });
  return new Map(items.map((i) => [i.id, {
    name: i.name, description: i.description, sectionName: i.category.name,
    optionNames: i.optionGroups.flatMap((g) => [g.name, ...g.options.map((o) => o.name)]),
    vendorId: i.vendorId, vendorName: i.vendor.name,
  }]));
}

/** The verdict for each of these items, read from the database. Items that no longer exist are absent. */
export async function catalogueChecksFor(db: Db, itemIds: readonly string[]): Promise<Map<string, CatalogueCheck>> {
  const out = new Map<string, CatalogueCheck>();
  const ids = [...new Set(itemIds)];
  if (ids.length === 0) return out;
  const [items, categories] = await Promise.all([
    db.item.findMany({
      where: { id: { in: ids } },
      select: {
        id: true, name: true, description: true,
        prohibitedAt: true, prohibitedClass: true, prohibitedReason: true, reviewApprovedHash: true,
        category: { select: { name: true } },
        optionGroups: { select: { name: true, options: { select: { name: true } } } },
      },
    }),
    categoriesByItem(db, ids),
  ]);
  for (const item of items) {
    out.set(item.id, checkItem({
      name: item.name,
      description: item.description,
      sectionName: item.category.name,
      optionNames: item.optionGroups.flatMap((g) => [g.name, ...g.options.map((o) => o.name)]),
      categories: categories.get(item.id) ?? [],
      prohibitedAt: item.prohibitedAt,
      prohibitedClass: item.prohibitedClass,
      prohibitedReason: item.prohibitedReason,
      reviewApprovedHash: item.reviewApprovedHash,
    }));
  }
  return out;
}

/** The subset of these items no customer may see or buy right now. */
export async function hiddenAmong(db: Db, itemIds: readonly string[]): Promise<Set<string>> {
  const checks = await catalogueChecksFor(db, itemIds);
  return new Set([...checks].filter(([, check]) => isHidden(check)).map(([id]) => id));
}

/** The tenant's platform categories that are banned (judged by slug and name). */
export async function prohibitedCategoryIds(db: Db, tenantId: string): Promise<string[]> {
  const categories = await db.discoveryCategory.findMany({ where: { tenantId }, select: { id: true, slug: true, name: true } });
  return categories.filter((c) => classifyCategory(c) !== null).map((c) => c.id);
}

/**
 * Every item in a tenant whose verdict is not CLEAR — banned, waiting or
 * approved — with its verdict. A database pre-filter (one pattern, a superset
 * of the word list) narrows the catalogue to the rows that could hit; the
 * verdict is then computed exactly. Removed items and items filed under a
 * banned category are added whatever their words.
 */
export async function flaggedItemsInTenant(db: Db, tenantId: string): Promise<Map<string, CatalogueCheck>> {
  // Each column is read as the classifier reads text — NFD, combining marks removed
  // (so "Śtout" is "stout" here too), lowercased, split into words — and kept when
  // it shares a word with the pre-filter set. [DS1100 S2/S3]
  const M = PROHIBITED_MARKS_PATTERN;
  const W = [...PROHIBITED_PREFILTER_WORDS];
  const words = (column: Prisma.Sql) => Prisma.sql`regexp_split_to_array(lower(regexp_replace(normalize(${column}, NFD), ${M}, '', 'g')), '[^a-z0-9]+') && ${W}::text[]`;
  const candidates = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT i.id FROM items i JOIN categories c ON c.id = i."categoryId"
    WHERE i."tenantId" = ${tenantId}
      AND (i."prohibitedAt" IS NOT NULL
        OR ${words(Prisma.sql`i.name`)}
        OR ${words(Prisma.sql`coalesce(i.description, '')`)}
        OR ${words(Prisma.sql`c.name`)}
        OR EXISTS (SELECT 1 FROM option_groups g WHERE g."itemId" = i.id
          AND (${words(Prisma.sql`g.name`)}
            OR EXISTS (SELECT 1 FROM options o WHERE o."optionGroupId" = g.id AND ${words(Prisma.sql`o.name`)}))))`);
  const banned = await prohibitedCategoryIds(db, tenantId);
  const tagged = banned.length === 0 ? [] : await db.itemDiscoveryCategory.findMany({
    where: { tenantId, categoryId: { in: banned } }, select: { itemId: true }, distinct: ['itemId'],
  });
  const checks = await catalogueChecksFor(db, [...candidates.map((c) => c.id), ...tagged.map((t) => t.itemId)]);
  return new Map([...checks].filter(([, check]) => check.state !== 'CLEAR'));
}

/** How long a tenant's exclusion list is reused before it is read again. */
export const HIDDEN_IDS_CACHE_MS = 60_000;
const hiddenIdsCache = new Map<string, { at: number; ids: Promise<string[]> }>();

/**
 * The ids a browse surface excludes IN its query, before a page or fixed
 * window is capped — the rule `hiddenOnlyItemIds` follows — so a hidden row
 * does not consume the page budget. Reading every item's words is a scan of
 * the whole catalogue, so a tenant's list is reused for HIDDEN_IDS_CACHE_MS
 * (one read in flight at a time; a failed read is not kept). [DS1100 S3]
 *
 * This list only keeps pages full. It is never what stops a hidden item being
 * shown: every browse surface also runs `withoutHidden` on the rows it returns,
 * and cart, checkout and storefronts judge each item exactly.
 */
export function hiddenItemIds(db: Db, tenantId: string, now = Date.now()): Promise<string[]> {
  const cached = hiddenIdsCache.get(tenantId);
  if (cached && now - cached.at < HIDDEN_IDS_CACHE_MS) return cached.ids;
  const ids = flaggedItemsInTenant(db, tenantId)
    .then((flagged) => [...flagged].filter(([, check]) => isHidden(check)).map(([id]) => id));
  ids.catch(() => { if (hiddenIdsCache.get(tenantId)?.ids === ids) hiddenIdsCache.delete(tenantId); });
  hiddenIdsCache.set(tenantId, { at: now, ids });
  return ids;
}

/** Test seam: forget every tenant's cached exclusion list. */
export function resetHiddenItemIdsCacheForTests(): void {
  hiddenIdsCache.clear();
}

/** The exact last pass on rows a surface is about to return: hidden ones are dropped, whatever the cache said. */
export async function withoutHidden<T extends { id: string }>(db: Db, rows: readonly T[]): Promise<T[]> {
  if (rows.length === 0) return [];
  const hidden = await hiddenAmong(db, rows.map((r) => r.id));
  return hidden.size === 0 ? [...rows] : rows.filter((r) => !hidden.has(r.id));
}

/** An item a partner may not edit or switch back on: banned outright. */
export async function assertNotBanned(db: Db, itemId: string): Promise<void> {
  const check = (await catalogueChecksFor(db, [itemId])).get(itemId);
  if (check?.state !== 'BANNED') return;
  throw new AppError(409, 'PROHIBITED_ITEM', notAllowedMessage(check.prohibitedClass), { prohibitedClass: check.prohibitedClass });
}

/**
 * Cart and checkout: the first hidden line refuses the whole command, in the
 * sold-out shape (409 ITEM_UNAVAILABLE) every app already handles.
 */
export async function assertOrderableNow(db: Db, items: ReadonlyArray<{ id: string; name: string }>): Promise<void> {
  if (items.length === 0) return;
  const hidden = await hiddenAmong(db, items.map((i) => i.id));
  const hit = items.find((i) => hidden.has(i.id));
  if (hit) throw new AppError(409, 'ITEM_UNAVAILABLE', orderRefusalMessage(hit.name), { itemId: hit.id, reason: 'PROHIBITED' });
}

/** What a partner reads about one of their items: null when there is nothing to say. */
export type CatalogueCheckView =
  | null
  | { status: 'NOT_ALLOWED'; message: string; prohibitedClass: ProhibitedClass; reason: string | null }
  | { status: 'WAITING_FOR_CHECK'; message: string; prohibitedClass: ProhibitedClass; field: string; term: string };

export function partnerView(check: CatalogueCheck | undefined): CatalogueCheckView {
  if (!check || check.state === 'CLEAR' || check.state === 'APPROVED') return null;
  if (check.state === 'BANNED') return { status: 'NOT_ALLOWED', message: notAllowedMessage(check.prohibitedClass), prohibitedClass: check.prohibitedClass, reason: check.reason };
  return { status: 'WAITING_FOR_CHECK', message: WAITING_FOR_CHECK, prohibitedClass: check.prohibitedClass, field: check.field, term: check.term };
}
