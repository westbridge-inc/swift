/**
 * [DOC-1 §18.3 · P18-2] Documents control what can be sold — DOC-INV-26.
 *
 * A gate names a category (one slug, or a kind for a family) in a country and
 * the document type a vendor must hold VALID — approved and unexpired — to
 * list in it. BLOCK_LISTING refuses the tag and hides the item from the feed;
 * BLOCK_ORDER does both and also fails the order at checkout, which catches
 * the licence that lapsed after the item was published: when the liquor
 * licence expires at midnight, alcohol stops being ORDERABLE, not merely
 * listed. WARN flags and allows. Validity is computed live from the vendor
 * owner's documents — nothing here caches a licence.
 */
import type { Prisma, PrismaClient, DiscoveryCategoryKind, GateEnforcement } from '@prisma/client';
import { AppError } from '../../utils/errors';

type Db = PrismaClient | Prisma.TransactionClient;

export interface GateCategory { id: string; slug: string; kind: DiscoveryCategoryKind }
export interface GateVerdict {
  gateCode: string;
  category: GateCategory;
  enforcement: GateEnforcement;
  /** legacy document type code, as a vendor submits it */
  requiredDocType: string;
  requiredDisplayName: string;
  ok: boolean;
}

export async function enforcedGates(prisma: Db, countryCode: string, now = new Date()) {
  return prisma.categoryDocumentGate.findMany({
    where: { countryCode, OR: [{ enforcedFrom: null }, { enforcedFrom: { lte: now } }] },
    include: { requiredDocType: { select: { legacyCode: true, displayName: true, needsSpecimen: true } } },
  });
}

export function gateApplies(gate: { categorySlug: string | null; categoryKind: DiscoveryCategoryKind | null }, category: GateCategory): boolean {
  if (gate.categorySlug) return gate.categorySlug === category.slug;
  return gate.categoryKind !== null && gate.categoryKind === category.kind;
}

/** VALID = approved and unexpired, held by the vendor's owner. The image may be purged; the record is what counts. */
export async function holdsValidDocument(prisma: Db, ownerUserId: string, legacyCode: string, now = new Date()): Promise<boolean> {
  const doc = await prisma.verificationDocument.findFirst({
    where: { userId: ownerUserId, docType: legacyCode, status: 'APPROVED', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { id: true },
  });
  return doc !== null;
}

export async function vendorOwnerContext(prisma: Db, vendorId: string): Promise<{ ownerUserId: string; countryCode: string }> {
  const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { owner: { select: { user: { select: { id: true, countryCode: true } } } } } });
  if (!vendor) throw new AppError(404, 'NOT_FOUND', 'Vendor not found');
  return { ownerUserId: vendor.owner.user.id, countryCode: vendor.owner.user.countryCode };
}

export async function gateVerdicts(prisma: Db, ctx: { ownerUserId: string; countryCode: string }, categories: readonly GateCategory[], now = new Date()): Promise<GateVerdict[]> {
  const gates = await enforcedGates(prisma, ctx.countryCode, now);
  const validity = new Map<string, boolean>();
  const verdicts: GateVerdict[] = [];
  for (const category of categories) {
    for (const gate of gates) {
      if (!gateApplies(gate, category)) continue;
      const code = gate.requiredDocType.legacyCode;
      if (!validity.has(code)) validity.set(code, await holdsValidDocument(prisma, ctx.ownerUserId, code, now));
      verdicts.push({ gateCode: gate.code, category, enforcement: gate.enforcement, requiredDocType: code, requiredDisplayName: gate.requiredDocType.displayName, ok: validity.get(code)! });
    }
  }
  return verdicts;
}

/** The verdicts that block, for a surface: listing (BLOCK_LISTING and BLOCK_ORDER) or ordering (BLOCK_ORDER only). */
export function blocking(verdicts: readonly GateVerdict[], surface: 'LISTING' | 'ORDER'): GateVerdict[] {
  return verdicts.filter((v) => !v.ok && (surface === 'LISTING' ? v.enforcement !== 'WARN' : v.enforcement === 'BLOCK_ORDER'));
}

/** Publish time: a tag into a gated category needs the licence — refused with the ground; WARN gates come back as warnings. */
export async function assertTaggable(prisma: Db, vendorId: string, category: GateCategory, now = new Date()): Promise<GateVerdict[]> {
  const verdicts = await gateVerdicts(prisma, await vendorOwnerContext(prisma, vendorId), [category], now);
  const [blocked] = blocking(verdicts, 'LISTING');
  if (blocked) {
    throw new AppError(409, 'CATEGORY_GATED', `Listing in ${category.slug} needs a valid ${blocked.requiredDisplayName} — upload it under your documents`, { categorySlug: category.slug, requiredDocType: blocked.requiredDocType });
  }
  return verdicts.filter((v) => !v.ok);
}

/** Feed time: for each vendor on a page, the category ids it may not list in right now. */
export async function blockedCategoryIdsForVendors(prisma: Db, tenantId: string, vendorIds: readonly string[], now = new Date()): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (vendorIds.length === 0) return out;
  const categories: GateCategory[] = await prisma.discoveryCategory.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { id: true, slug: true, kind: true } });
  for (const vendorId of new Set(vendorIds)) {
    const verdicts = await gateVerdicts(prisma, await vendorOwnerContext(prisma, vendorId), categories, now);
    out.set(vendorId, new Set(blocking(verdicts, 'LISTING').map((v) => v.category.id)));
  }
  return out;
}

/**
 * [S2-1] The tenant's hidden-only item ids — items whose discovery tags exist
 * but point ONLY at categories that are not ACTIVE (HIDDEN, MERGED, PENDING).
 *
 * The taxonomy is a join table without a Prisma relation, so the rule is
 * resolved to ids here and callers exclude them from the ITEM where-clause
 * BEFORE a page or fixed window is capped. A hidden row ranked ahead of a
 * listable one must never consume the page budget: the page, its cursor and
 * the counts then all see the same eligible population. Untagged items and
 * items with at least one ACTIVE tag are not in the result and stay listable,
 * exactly as `listableItemsForVendors` judges them.
 */
export async function hiddenOnlyItemIds(prisma: Db, tenantId: string): Promise<string[]> {
  const categories = await prisma.discoveryCategory.findMany({
    where: { tenantId },
    select: { id: true, status: true },
  });
  const active = new Set(categories.filter((c) => c.status === 'ACTIVE').map((c) => c.id));
  const nonActive = categories.filter((c) => c.status !== 'ACTIVE').map((c) => c.id);
  // With no non-ACTIVE category there is nothing that can hide a tagged item.
  if (nonActive.length === 0) return [];
  const hiddenTagged = await prisma.itemDiscoveryCategory.findMany({
    where: { tenantId, categoryId: { in: nonActive } },
    select: { itemId: true },
    distinct: ['itemId'],
  });
  const candidates = [...new Set(hiddenTagged.map((t) => t.itemId))];
  // With no ACTIVE category at all, every tagged item is hidden-only; the
  // rescue lookup below would be dead work with an empty `in`.
  if (candidates.length === 0 || active.size === 0) return candidates;
  const rescued = await prisma.itemDiscoveryCategory.findMany({
    where: { tenantId, itemId: { in: candidates }, categoryId: { in: [...active] } },
    select: { itemId: true },
    distinct: ['itemId'],
  });
  const rescueIds = new Set(rescued.map((t) => t.itemId));
  return candidates.filter((id) => !rescueIds.has(id));
}

/** Shared public-listing projection gate for Market and guest search. */
export async function listableItemsForVendors<T extends { id: string; vendorId: string }>(
  prisma: Db, tenantId: string, rows: readonly T[],
): Promise<T[]> {
  if (rows.length === 0) return [];
  const gated = await blockedCategoryIdsForVendors(prisma, tenantId, rows.map((r) => r.vendorId));
  const tags = await prisma.itemDiscoveryCategory.findMany({
    where: { tenantId, itemId: { in: rows.map((r) => r.id) } },
    select: { itemId: true, categoryId: true },
  });
  // Untagged catalogue items remain listable. A tagged item needs at least
  // one active discovery category; a hidden-only tag must not publish it in
  // "All" or search. The existing document blocks still apply, including to mixed tags.
  const activeCategories = tags.length ? await prisma.discoveryCategory.findMany({
    where: { tenantId, id: { in: [...new Set(tags.map((t) => t.categoryId))] }, status: 'ACTIVE' },
    select: { id: true },
  }) : [];
  const activeIds = new Set(activeCategories.map((c) => c.id));
  const byItem = new Map<string, string[]>();
  for (const tag of tags) byItem.set(tag.itemId, [...(byItem.get(tag.itemId) ?? []), tag.categoryId]);
  return rows.filter((r) => {
    const categoryIds = byItem.get(r.id) ?? [];
    return (categoryIds.length === 0 || categoryIds.some((id) => activeIds.has(id))) &&
      !categoryIds.some((id) => gated.get(r.vendorId)?.has(id));
  });
}

/** Checkout: a line in a BLOCK_ORDER category whose licence is not valid fails the order — the lapse-after-publish case. */
export async function assertOrderable(prisma: Db, vendorId: string, items: ReadonlyArray<{ id: string; name: string }>, now = new Date()): Promise<void> {
  if (items.length === 0) return;
  const tags = await prisma.itemDiscoveryCategory.findMany({ where: { itemId: { in: items.map((i) => i.id) } }, select: { itemId: true, categoryId: true } });
  if (tags.length === 0) return;
  const categories: GateCategory[] = await prisma.discoveryCategory.findMany({ where: { id: { in: [...new Set(tags.map((t) => t.categoryId))] } }, select: { id: true, slug: true, kind: true } });
  const verdicts = await gateVerdicts(prisma, await vendorOwnerContext(prisma, vendorId), categories, now);
  const blockedCategoryIds = new Set(blocking(verdicts, 'ORDER').map((v) => v.category.id));
  if (blockedCategoryIds.size === 0) return;
  for (const item of items) {
    const hit = tags.find((t) => t.itemId === item.id && blockedCategoryIds.has(t.categoryId));
    if (!hit) continue;
    const verdict = blocking(verdicts, 'ORDER').find((v) => v.category.id === hit.categoryId)!;
    throw new AppError(409, 'CATEGORY_LICENCE_LAPSED', `${item.name} can't be ordered right now — the seller's ${verdict.requiredDisplayName} is not valid`, { itemId: item.id, requiredDocType: verdict.requiredDocType, categorySlug: verdict.category.slug });
  }
}

/** Document types a vendor may submit because a gate in their country names them — never one that still needs a specimen. */
export async function submittableGateDocTypes(prisma: Db, countryCode: string): Promise<string[]> {
  const gates = await prisma.categoryDocumentGate.findMany({ where: { countryCode }, include: { requiredDocType: { select: { legacyCode: true, needsSpecimen: true } } } });
  return [...new Set(gates.filter((g) => !g.requiredDocType.needsSpecimen).map((g) => g.requiredDocType.legacyCode))];
}
