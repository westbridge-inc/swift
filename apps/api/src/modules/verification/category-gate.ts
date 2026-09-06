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
