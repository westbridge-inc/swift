/**
 * [GUARDRAILS §8] Applying the prohibited-items rule on every surface the server owns.
 *
 * `prohibited-items.ts` decides what an item IS (banned / waiting for a check /
 * approved / clear); this file reads the facts from the database and applies
 * the verdict:
 *
 *   · a partner cannot file an item or a store under a banned category, cannot
 *     save a name or an option that IS banned goods ("Hennessy VS", "Carib
 *     Lager"), and cannot edit an item that is banned outright (409
 *     PROHIBITED_ITEM, the owner's words: "Swift doesn't allow this item:
 *     alcohol."). An item banned only by its own words may be edited out of
 *     them — the edit is judged too;
 *   · nobody sees a hidden item (banned, or a word hit not yet approved) —
 *     storefront menus, the website, Market, search, Home and the category
 *     rail leave it out, browse surfaces before any page is capped;
 *   · nobody can cart or order one — cart add/edit, basket upload, reorder,
 *     substitution and checkout (also under its row locks) refuse it the way
 *     they refuse a sold-out item (409 ITEM_UNAVAILABLE), so every app already
 *     shows the reason and offers Remove. Removing a line is never refused;
 *   · an order already placed with such a line never moves toward the
 *     customer: not accepted, prepared, made ready, handed over or given to a
 *     rider. Rejecting or cancelling it is never refused.
 *
 * The verdict is computed from the item's current words every time, so no
 * write path — a route, a CSV import, a till sync, a seed — can leave an item
 * judged on stale words.
 */
import { Prisma, type OrderStatus, type PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { custodyOf, ORDER_TRANSITIONS, STORE_REJECTABLE_STATUSES } from '../order/order-status';
import {
  certainGoods,
  checkItem,
  classifyCategory,
  classifyText,
  isHidden,
  notAllowedMessage,
  orderRefusalMessage,
  PROHIBITED_CLASS_LABELS,
  storeCategoryReason,
  WAITING_FOR_CHECK,
  type CatalogueCheck,
  type ItemWords,
  type ProhibitedClass,
} from './prohibited-items';
import { prefilterCandidateIds } from './prohibited-scan.service';
import { trackBackgroundRead } from '../../lib/background-reads';

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

/** The memberships that count as a store being FILED under a category: chosen by the store or by Swift — never
 *  the machine's DERIVED rows, which only echo its items' tags (those items are judged themselves). [#54] */
const CHOSEN_STORE_SOURCES = ['VENDOR', 'ADMIN'] as const;

/** Platform categories each store CHOSE (the join table has no Prisma relation). */
async function storeCategoriesByVendor(db: Db, vendorIds: readonly string[]): Promise<Map<string, Array<{ slug: string; name: string }>>> {
  const out = new Map<string, Array<{ slug: string; name: string }>>();
  if (vendorIds.length === 0) return out;
  const rows = await db.vendorDiscoveryCategory.findMany({
    where: { vendorId: { in: [...vendorIds] }, source: { in: [...CHOSEN_STORE_SOURCES] } },
    select: { vendorId: true, categoryId: true },
  });
  if (rows.length === 0) return out;
  const categories = await db.discoveryCategory.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.categoryId))] } }, select: { id: true, slug: true, name: true } });
  const byId = new Map(categories.map((c) => [c.id, c]));
  for (const row of rows) {
    const c = byId.get(row.categoryId);
    if (c) out.set(row.vendorId, [...(out.get(row.vendorId) ?? []), { slug: c.slug, name: c.name }]);
  }
  return out;
}

/**
 * The banned category a store is filed under, or null. A store filed under one
 * (Pharmacy, a liquor category) is hidden from every list, search, storefront
 * and Home, and every item it carries counts as banned; nothing is deleted. [#54]
 */
export async function prohibitedStoreCategory(db: Db, vendorId: string): Promise<{ slug: string; name: string; prohibitedClass: ProhibitedClass } | null> {
  for (const category of (await storeCategoriesByVendor(db, [vendorId])).get(vendorId) ?? []) {
    const hit = classifyCategory(category);
    if (hit) return { ...category, prohibitedClass: hit.prohibitedClass };
  }
  return null;
}

/** A partner writing to a store filed under a banned category: refused, saying why and who changes it. [#54] */
export async function assertStoreAllowed(db: Db, vendorId: string): Promise<void> {
  const banned = await prohibitedStoreCategory(db, vendorId);
  if (banned) throw new AppError(409, 'PROHIBITED_ITEM', storeCategoryReason(banned.name), { prohibitedClass: banned.prohibitedClass, categorySlug: banned.slug });
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
        id: true, name: true, description: true, vendorId: true,
        prohibitedAt: true, prohibitedClass: true, prohibitedReason: true, reviewApprovedHash: true,
        category: { select: { name: true } },
        optionGroups: { select: { name: true, options: { select: { name: true } } } },
      },
    }),
    categoriesByItem(db, ids),
  ]);
  const storeCategories = await storeCategoriesByVendor(db, [...new Set(items.map((i) => i.vendorId))]);
  for (const item of items) {
    out.set(item.id, checkItem({
      name: item.name,
      description: item.description,
      sectionName: item.category.name,
      optionNames: item.optionGroups.flatMap((g) => [g.name, ...g.options.map((o) => o.name)]),
      categories: categories.get(item.id) ?? [],
      storeCategories: storeCategories.get(item.vendorId) ?? [],
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

/** The tenant's platform categories that are banned (judged by slug and name). `null`: every tenant (a guest). */
export async function prohibitedCategoryIds(db: Db, tenantId: string | null): Promise<string[]> {
  const categories = await db.discoveryCategory.findMany({ where: tenantId ? { tenantId } : {}, select: { id: true, slug: true, name: true } });
  return categories.filter((c) => classifyCategory(c) !== null).map((c) => c.id);
}

/** The stores filed under a banned category (chosen, not derived), read now. [#54] */
async function readProhibitedStoreIds(db: Db, tenantId: string | null): Promise<string[]> {
  const banned = await prohibitedCategoryIds(db, tenantId);
  if (banned.length === 0) return [];
  const rows = await db.vendorDiscoveryCategory.findMany({
    where: { categoryId: { in: banned }, source: { in: [...CHOSEN_STORE_SOURCES] }, ...(tenantId ? { tenantId } : {}) },
    select: { vendorId: true }, distinct: ['vendorId'],
  });
  return rows.map((r) => r.vendorId);
}

/**
 * Every item in a tenant whose verdict is not CLEAR — banned, waiting or
 * approved — with its verdict. A database pre-filter (one pattern, a superset
 * of the word list) narrows the catalogue to the rows that could hit; the
 * verdict is then computed exactly. Removed items and items filed under a
 * banned category are added whatever their words.
 */
export async function flaggedItemsInTenant(db: Db, tenantId: string): Promise<Map<string, CatalogueCheck>> {
  const candidates = await prefilterCandidateIds(db, tenantId);
  const banned = await prohibitedCategoryIds(db, tenantId);
  const tagged = banned.length === 0 ? [] : await db.itemDiscoveryCategory.findMany({
    where: { tenantId, categoryId: { in: banned } }, select: { itemId: true }, distinct: ['itemId'],
  });
  // [#54] Every item of a store filed under a banned category, whatever its words.
  const stores = await readProhibitedStoreIds(db, tenantId);
  const stocked = stores.length === 0 ? [] : await db.item.findMany({ where: { vendorId: { in: stores } }, select: { id: true } });
  const checks = await catalogueChecksFor(db, [...candidates, ...tagged.map((t) => t.itemId), ...stocked.map((i) => i.id)]);
  return new Map([...checks].filter(([, check]) => check.state !== 'CLEAR'));
}

/** How long a tenant's exclusion list is reused before it is read again. */
export const HIDDEN_IDS_CACHE_MS = 60_000;

/**
 * Stale-while-revalidate: a list younger than HIDDEN_IDS_CACHE_MS is served as
 * is; an older one is STILL served, at once, while one read refreshes it in the
 * background — so no customer request ever waits for the scan, except the very
 * first one a process serves for a tenant. A failed refresh keeps the old list;
 * a failed first read is not kept. [DS1100 S3; Opus S3-11]
 */
type Swr = { at: number; value: Promise<string[]>; refreshing: Promise<unknown> | null };
function staleWhileRevalidate(cache: Map<string, Swr>, key: string, load: () => Promise<string[]>, now: number): Promise<string[]> {
  const entry = cache.get(key);
  if (!entry) {
    const value = load();
    const fresh: Swr = { at: now, value, refreshing: null };
    value.catch(() => { if (cache.get(key) === fresh) cache.delete(key); });
    cache.set(key, fresh);
    return value;
  }
  if (now - entry.at >= HIDDEN_IDS_CACHE_MS && !entry.refreshing) {
    // Tracked, so a server closing waits for it before the database disconnects.
    entry.refreshing = trackBackgroundRead(load()
      .then((ids) => { cache.set(key, { at: Date.now(), value: Promise.resolve(ids), refreshing: null }); })
      .catch(() => { entry.refreshing = null; }));
  }
  return entry.value;
}

const hiddenIdsCache = new Map<string, Swr>();
const prohibitedStoresCache = new Map<string, Swr>();

/**
 * The ids a browse surface excludes IN its query, before a page or fixed
 * window is capped — the rule `hiddenOnlyItemIds` follows — so a hidden row
 * does not consume the page budget. Reading every item's words is a scan of
 * the whole catalogue, so a tenant's list is reused (stale-while-revalidate,
 * above). [DS1100 S3]
 *
 * This list only keeps pages full. It is never what stops a hidden item being
 * shown: every browse surface also runs `withoutHidden` on the rows it returns,
 * and cart, checkout and storefronts judge each item exactly.
 */
export function hiddenItemIds(db: Db, tenantId: string, now = Date.now()): Promise<string[]> {
  return staleWhileRevalidate(hiddenIdsCache, tenantId, () => flaggedItemsInTenant(db, tenantId)
    .then((flagged) => [...flagged].filter(([, check]) => isHidden(check)).map(([id]) => id)), now);
}

/**
 * The stores no customer list shows: filed under a banned category (#54). A
 * tenant's list (or, for a guest, every tenant's) is reused the same way. A
 * storefront opened directly is judged exactly (`prohibitedStoreCategory`).
 */
export function prohibitedStoreIds(db: Db, tenantId: string | null, now = Date.now()): Promise<string[]> {
  return staleWhileRevalidate(prohibitedStoresCache, tenantId ?? '*', () => readProhibitedStoreIds(db, tenantId), now);
}

/** Test seam: wait for any background refresh, so a test reads what it served next. */
export async function settleProhibitedCachesForTests(): Promise<void> {
  await Promise.all([...hiddenIdsCache.values(), ...prohibitedStoresCache.values()].map((e) => e.refreshing));
}

/** Test seam: forget every tenant's cached exclusion lists. */
export function resetHiddenItemIdsCacheForTests(): void {
  hiddenIdsCache.clear();
  prohibitedStoresCache.clear();
}

/** The exact last pass on rows a surface is about to return: hidden ones are dropped, whatever the cache said. */
export async function withoutHidden<T extends { id: string }>(db: Db, rows: readonly T[]): Promise<T[]> {
  if (rows.length === 0) return [];
  const hidden = await hiddenAmong(db, rows.map((r) => r.id));
  return hidden.size === 0 ? [...rows] : rows.filter((r) => !hidden.has(r.id));
}

/**
 * An item a partner may not edit or switch back on: banned outright. An item
 * banned only by its own words ("Legacy Rum") may still be EDITED — a new name
 * is judged before it is written (`assertNotBannedGoods`) — but never switched
 * back on while it is banned. [#55]
 */
export async function assertNotBanned(db: Db, itemId: string, options: { wordBanEditable?: boolean } = {}): Promise<void> {
  const check = (await catalogueChecksFor(db, [itemId])).get(itemId);
  if (check?.state !== 'BANNED') return;
  if (options.wordBanEditable && check.source === 'word') return;
  throw new AppError(409, 'PROHIBITED_ITEM', notAllowedMessage(check.prohibitedClass), { prohibitedClass: check.prohibitedClass });
}

/**
 * A name or an option a partner is about to save that IS banned goods — a
 * brand, a product phrase, a goods noun heading it: refused before anything is
 * written, never held for a reviewer. [#55/#56, Opus S1-LAUNCH-2]
 */
export function assertNotBannedGoods(texts: ReadonlyArray<string | null | undefined>): void {
  for (const text of texts) {
    const hit = certainGoods(text);
    if (hit) throw new AppError(409, 'PROHIBITED_ITEM', notAllowedMessage(hit.prohibitedClass), { prohibitedClass: hit.prohibitedClass, term: hit.term });
  }
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

/**
 * A move that takes an order's goods toward the customer while they are still
 * at the store: accept, prepare, ready, a rider assigned, arriving or
 * collecting, the store's own handover (counter pickup, own delivery). Read
 * from the one custody law. Never a cancellation, a refund, a failure, a
 * return or a recovery step back — and nothing once a rider holds the goods,
 * so a delivery already under way is never stranded in a rider's bag.
 */
const NEVER_HELD_BACK: ReadonlySet<OrderStatus> = new Set<OrderStatus>(['CANCELLED', 'REFUNDED', 'FAILED', 'RETURNING', 'RETURNED']);
export function movesTowardCustomer(source: OrderStatus, target: OrderStatus): boolean {
  if (NEVER_HELD_BACK.has(target) || !ORDER_TRANSITIONS[target].includes(source)) return false;
  const custody = custodyOf(source);
  return custody === 'UNASSIGNED' || custody === 'ASSIGNED_NOT_HOLDING';
}

/**
 * Is THIS move held back at the canonical seam? `movesTowardCustomer`, except
 * the store marking its OWN delivery done: a store-delivered order waits at
 * READY_FOR_PICKUP while the store's courier is already out with the goods, so
 * refusing "delivered" records nothing true and strands the order. [Opus S3-6]
 */
export function heldAtSeam(source: { status: OrderStatus; fulfillmentMode?: string | null }, target: OrderStatus): boolean {
  if (target === 'DELIVERED' && source.fulfillmentMode === 'VENDOR_DELIVERY') return false;
  return movesTowardCustomer(source.status, target);
}

/** Can the store still reject this order itself? Only before it is ready, and never on MMG money already moved
 *  (the cancel paths refuse that). Otherwise only Swift support cancels — and the refusal must say so. [Opus S3-6/S3-7] */
export function storeMayReject(order: { status: OrderStatus; paymentMethod?: string | null; paymentStatus?: string | null }, mmgMoneyMoved: ReadonlySet<string>): boolean {
  if (!(STORE_REJECTABLE_STATUSES as readonly string[]).includes(order.status)) return false;
  return !(order.paymentMethod === 'MOBILE_MONEY' && mmgMoneyMoved.has(order.paymentStatus ?? ''));
}

/**
 * An order placed before this rule — or whose item a person removed, or whose
 * words changed, after it was placed — does not go ahead while a line is
 * hidden. Each line is judged by its item's verdict today AND by its own
 * snapshotted name (the item may have been renamed since): a line whose own
 * name carries a banned word goes ahead only if its item is approved. Checkout
 * already refuses such a line; this covers the orders already in flight.
 * [GUARDRAILS §8; owner 13 Oct: refused at "order creation, dispatch"]
 *
 *   · 'store' — the canonical transition seam (store, support, rider legs):
 *     409 PROHIBITED_ITEM naming the line and what to do.
 *   · 'mover' — an offer card or a board grab: the rider is told the job is
 *     paused, nothing about the goods (409 JOB_UNAVAILABLE).
 */
export async function assertOrderMayProceed(db: Db, orderId: string, audience: 'store' | 'mover', options: { storeMayReject?: boolean } = {}): Promise<void> {
  // A line the store refunded, or a substitution the customer rejected, is no longer on the order. [DS1106 S3]
  const rows = await db.orderItem.findMany({
    where: { orderId, subStatus: { notIn: ['REFUNDED', 'REJECTED'] } },
    select: { itemId: true, name: true, subStatus: true, substituteItemId: true, substituteName: true },
  });
  if (rows.length === 0) return;
  // The goods on a line: the substitute once the customer approved it, the ordered item otherwise. [DS1106 S2]
  const lines = rows.map((r) => (r.subStatus === 'APPROVED' && r.substituteItemId
    ? { itemId: r.substituteItemId, name: r.substituteName ?? r.name }
    : { itemId: r.itemId, name: r.name }));
  const checks = await catalogueChecksFor(db, lines.map((l) => l.itemId));
  for (const line of lines) {
    const live = checks.get(line.itemId);
    const heldLive = live !== undefined && isHidden(live);
    const heldByOwnName = classifyText(line.name) !== null && live?.state !== 'APPROVED';
    if (!heldLive && !heldByOwnName) continue;
    if (audience === 'mover') {
      throw new AppError(409, 'JOB_UNAVAILABLE', 'This job isn\'t available — Swift has paused it. Take another job.', { reason: 'PROHIBITED' });
    }
    // Never "Reject the order" when the store cannot: once ready, or on MMG money already moved. [Opus S3-6/S3-7]
    const canReject = options.storeMayReject !== false;
    const message = live?.state === 'WAITING'
      ? (canReject
        ? `This order can't go ahead yet: ${line.name} is waiting for a quick check by Swift. Reject the order, or wait for the check.`
        : `This order can't go ahead yet: ${line.name} is waiting for a quick check by Swift. Wait for the check, or ask Swift support to cancel the order — the customer is told.`)
      : (canReject
        ? `This order can't go ahead: ${line.name} isn't allowed on Swift. Reject the order, or ask Swift support to cancel it — the customer is told.`
        : `This order can't go ahead: ${line.name} isn't allowed on Swift. Ask Swift support to cancel it — the customer is told.`);
    throw new AppError(409, 'PROHIBITED_ITEM', message, { itemId: line.itemId, reason: 'PROHIBITED' });
  }
}

/** Who reads a refusal at the canonical seam: a move INTO a mover's state (heading to the store,
 *  arriving, collecting) is the rider's own tap and reads the rider's words. [DS1106 S4] */
export function refusalAudience(target: OrderStatus): 'store' | 'mover' {
  const custody = custodyOf(target);
  return custody === 'ASSIGNED_NOT_HOLDING' || custody === 'MOVER_HOLDING' ? 'mover' : 'store';
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
