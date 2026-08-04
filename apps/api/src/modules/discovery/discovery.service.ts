import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { CAT_MAX_ITEM_TAGS, suggestCategories, type MatchableCategory } from './matcher';
import { reconcileVendorDerived } from './derivation';

// ---------------------------------------------------------------------------
// Discovery service (#17) — vendor picks, item tags, suggestions, requests.
// The laws in force here:
//   · curated only: every slug validates against the tenant's ACTIVE taxonomy
//   · 1 PRIMARY per vendor (raw partial unique = the race judge) + ≤2 secondary
//   · ≤ CAT_MAX_ITEM_TAGS per item, counted in-transaction
//   · sticky human choice: machines never touch resolved ground — an ACCEPTED
//     or DISMISSED suggestion (or a human tag) freezes that (item, category)
//     pair for every future engine run; removing an AUTO tag writes DISMISSED
//     so it can never come back.
// ---------------------------------------------------------------------------

export const CAT_STORE_SECONDARY_MAX = 2;
export const CAT_REQUEST_RATE_PER_DAY = 5;

const isUniqueViolation = (e: unknown): e is Prisma.PrismaClientKnownRequestError =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export class DiscoveryService {
  constructor(private prisma: PrismaClient) {}

  /** ACTIVE taxonomy for a tenant (matcher shape included). */
  async taxonomy(tenantId = 'swift-default') {
    return this.prisma.discoveryCategory.findMany({
      where: { tenantId, status: 'ACTIVE' },
      orderBy: [{ vertical: 'asc' }, { sortWeight: 'asc' }],
    });
  }

  private async requireActiveCategory(slug: string, tenantId = 'swift-default') {
    const category = await this.prisma.discoveryCategory.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
    });
    if (!category || category.status !== 'ACTIVE') {
      throw new AppError(400, 'UNKNOWN_CATEGORY', 'Pick a category from the list');
    }
    return category;
  }

  // ---- store picks ---------------------------------------------------------

  async getVendorCategories(vendorId: string) {
    const rows = await this.prisma.vendorDiscoveryCategory.findMany({ where: { vendorId } });
    const categories = await this.prisma.discoveryCategory.findMany({
      where: { id: { in: rows.map((r) => r.categoryId) } },
    });
    const byId = new Map(categories.map((c) => [c.id, c]));
    const shape = (r: (typeof rows)[number]) => {
      const c = byId.get(r.categoryId);
      return c ? { slug: c.slug, name: c.name, emoji: c.emoji, kind: c.kind } : null;
    };
    return {
      primary: rows.filter((r) => r.role === 'PRIMARY' && r.source !== 'DERIVED').map(shape).find(Boolean) ?? null,
      secondary: rows.filter((r) => r.role === 'SECONDARY' && r.source !== 'DERIVED').map(shape).filter(Boolean),
      derived: rows.filter((r) => r.source === 'DERIVED').map(shape).filter(Boolean),
    };
  }

  /** Replace the vendor's CHOSEN set (1 PRIMARY + ≤2 secondary). DERIVED rows
   *  are machine ground and never touched here. Concurrent replaces: the
   *  partial unique makes the loser fail clean — retry-once then 409. */
  async setVendorCategories(vendorId: string, primarySlug: string, secondarySlugs: string[], tenantId = 'swift-default') {
    if (secondarySlugs.length > CAT_STORE_SECONDARY_MAX) {
      throw new AppError(400, 'TOO_MANY_CATEGORIES', `Pick up to ${CAT_STORE_SECONDARY_MAX} more categories`);
    }
    const unique = new Set([primarySlug, ...secondarySlugs]);
    if (unique.size !== 1 + secondarySlugs.length) {
      throw new AppError(400, 'DUPLICATE_CATEGORY', 'Each category can be picked once');
    }
    const primary = await this.requireActiveCategory(primarySlug, tenantId);
    const secondaries: Array<Awaited<ReturnType<DiscoveryService['requireActiveCategory']>>> = [];
    for (const slug of secondarySlugs) secondaries.push(await this.requireActiveCategory(slug, tenantId));

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.vendorDiscoveryCategory.deleteMany({
          where: { vendorId, source: { in: ['VENDOR', 'ADMIN'] } },
        });
        // A DERIVED row for a now-chosen category yields to the choice.
        await tx.vendorDiscoveryCategory.deleteMany({
          where: { vendorId, categoryId: { in: [primary.id, ...secondaries.map((s) => s.id)] } },
        });
        await tx.vendorDiscoveryCategory.create({
          data: { tenantId, vendorId, categoryId: primary.id, role: 'PRIMARY', source: 'VENDOR' },
        });
        for (const s of secondaries) {
          await tx.vendorDiscoveryCategory.create({
            data: { tenantId, vendorId, categoryId: s.id, role: 'SECONDARY', source: 'VENDOR' },
          });
        }
      });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      throw new AppError(409, 'CATEGORIES_CHANGED', 'Your categories just changed elsewhere — reload and try again');
    }
    return this.getVendorCategories(vendorId);
  }

  // ---- item tags -----------------------------------------------------------

  async addItemTag(itemId: string, slug: string, source: 'VENDOR' | 'ADMIN', tenantId = 'swift-default') {
    const category = await this.requireActiveCategory(slug, tenantId);
    try {
      await this.prisma.$transaction(async (tx) => {
        const count = await tx.itemDiscoveryCategory.count({ where: { itemId } });
        if (count >= CAT_MAX_ITEM_TAGS) {
          throw new AppError(400, 'TOO_MANY_TAGS', `${count} of ${CAT_MAX_ITEM_TAGS} categories used — remove one first`);
        }
        await tx.itemDiscoveryCategory.create({
          data: { tenantId, itemId, categoryId: category.id, source },
        });
        // A human tag resolves any open suggestion for the pair (law C).
        await tx.discoveryCategorySuggestion.updateMany({
          where: { itemId, categoryId: category.id, status: 'PENDING' },
          data: { status: 'ACCEPTED', resolvedAt: new Date() },
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) return; // already tagged — calm no-op
      throw e;
    }
  }

  /** Removing an AUTO tag writes DISMISSED so the engine never re-applies it. */
  async removeItemTag(itemId: string, slug: string, tenantId = 'swift-default') {
    const category = await this.prisma.discoveryCategory.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
    });
    if (!category) throw new NotFoundError('Category', slug);
    await this.prisma.$transaction(async (tx) => {
      const removed = await tx.itemDiscoveryCategory.deleteMany({ where: { itemId, categoryId: category.id } });
      if (removed.count === 0) throw new NotFoundError('Tag', slug);
      await tx.discoveryCategorySuggestion.upsert({
        where: { itemId_categoryId: { itemId, categoryId: category.id } },
        create: { tenantId, itemId, categoryId: category.id, confidence: 0, stage: 'MATCHER', status: 'DISMISSED', resolvedAt: new Date() },
        update: { status: 'DISMISSED', resolvedAt: new Date() },
      });
    });
  }

  async itemTags(itemId: string) {
    const rows = await this.prisma.itemDiscoveryCategory.findMany({ where: { itemId } });
    const categories = await this.prisma.discoveryCategory.findMany({ where: { id: { in: rows.map((r) => r.categoryId) } } });
    const byId = new Map(categories.map((c) => [c.id, c]));
    return rows
      .map((r) => {
        const c = byId.get(r.categoryId);
        return c ? { slug: c.slug, name: c.name, emoji: c.emoji, source: r.source, confidence: r.confidence ? Number(r.confidence) : null } : null;
      })
      .filter(Boolean);
  }

  // ---- suggestions ---------------------------------------------------------

  async pendingSuggestions(itemId: string) {
    const rows = await this.prisma.discoveryCategorySuggestion.findMany({
      where: { itemId, status: 'PENDING' },
      orderBy: { confidence: 'desc' },
    });
    const categories = await this.prisma.discoveryCategory.findMany({ where: { id: { in: rows.map((r) => r.categoryId) } } });
    const byId = new Map(categories.map((c) => [c.id, c]));
    return rows
      .map((r) => {
        const c = byId.get(r.categoryId);
        return c ? { id: r.id, slug: c.slug, name: c.name, emoji: c.emoji, confidence: Number(r.confidence), stage: r.stage } : null;
      })
      .filter(Boolean);
  }

  async resolveSuggestion(suggestionId: string, itemId: string, action: 'accept' | 'dismiss', tenantId = 'swift-default') {
    const suggestion = await this.prisma.discoveryCategorySuggestion.findFirst({
      where: { id: suggestionId, itemId },
    });
    if (!suggestion) throw new NotFoundError('Suggestion', suggestionId);
    if (suggestion.status !== 'PENDING') return; // already resolved — calm

    if (action === 'dismiss') {
      await this.prisma.discoveryCategorySuggestion.update({
        where: { id: suggestion.id },
        data: { status: 'DISMISSED', resolvedAt: new Date() },
      });
      return;
    }
    await this.prisma.$transaction(async (tx) => {
      const count = await tx.itemDiscoveryCategory.count({ where: { itemId } });
      if (count >= CAT_MAX_ITEM_TAGS) {
        throw new AppError(400, 'TOO_MANY_TAGS', `${count} of ${CAT_MAX_ITEM_TAGS} categories used — remove one first`);
      }
      try {
        await tx.itemDiscoveryCategory.create({
          data: { tenantId, itemId, categoryId: suggestion.categoryId, source: 'VENDOR' },
        });
      } catch (e) {
        if (!isUniqueViolation(e)) throw e; // already tagged — accept anyway
      }
      await tx.discoveryCategorySuggestion.update({
        where: { id: suggestion.id },
        data: { status: 'ACCEPTED', resolvedAt: new Date() },
      });
    });
  }

  // ---- Stage-A wiring ------------------------------------------------------

  /**
   * Run the matcher for one item and reconcile PENDING suggestions.
   * Law C at machine speed: pairs with a resolved suggestion or ANY existing
   * tag are frozen ground — untouched. PENDING pairs re-score; below the
   * floor they become SUPERSEDED, never deleted (audit trail).
   */
  async runMatcherForItem(item: { id: string; name: string; description?: string | null }, tenantId = 'swift-default'): Promise<number> {
    const taxonomy = await this.taxonomy(tenantId);
    const matchable: MatchableCategory[] = taxonomy.map((c) => ({ slug: c.slug, name: c.name, aliases: c.aliases }));
    const suggestions = suggestCategories({ name: item.name, description: item.description }, matchable);
    const byId = new Map(taxonomy.map((c) => [c.slug, c.id]));

    const frozen = new Set<string>();
    const resolved = await this.prisma.discoveryCategorySuggestion.findMany({
      where: { itemId: item.id, status: { in: ['ACCEPTED', 'DISMISSED'] } },
      select: { categoryId: true },
    });
    for (const r of resolved) frozen.add(r.categoryId);
    const tagged = await this.prisma.itemDiscoveryCategory.findMany({
      where: { itemId: item.id },
      select: { categoryId: true },
    });
    for (const t of tagged) frozen.add(t.categoryId);

    let written = 0;
    const suggestedIds = new Set<string>();
    for (const s of suggestions) {
      const categoryId = byId.get(s.slug);
      if (!categoryId || frozen.has(categoryId)) continue;
      suggestedIds.add(categoryId);
      await this.prisma.discoveryCategorySuggestion.upsert({
        where: { itemId_categoryId: { itemId: item.id, categoryId } },
        create: { tenantId, itemId: item.id, categoryId, confidence: s.confidence, stage: 'MATCHER', status: 'PENDING' },
        update: { confidence: s.confidence, stage: 'MATCHER', status: 'PENDING', resolvedAt: null },
      });
      written += 1;
    }
    // PENDING matcher rows that no longer score → SUPERSEDED.
    await this.prisma.discoveryCategorySuggestion.updateMany({
      where: { itemId: item.id, status: 'PENDING', stage: 'MATCHER', categoryId: { notIn: [...suggestedIds, ...frozen] } },
      data: { status: 'SUPERSEDED', resolvedAt: new Date() },
    });
    return written;
  }

  /** Stage-C on-change: reconcile the item's vendor after any tag mutation.
   *  Fire-and-forget garnish — the nightly job is the safety net. */
  async reconcileDerivedForItem(itemId: string): Promise<void> {
    const item = await this.prisma.item.findUnique({ where: { id: itemId }, select: { vendorId: true } });
    if (item) await reconcileVendorDerived(this.prisma, item.vendorId);
  }

  // ---- requests ------------------------------------------------------------

  async createRequest(vendorId: string, proposedName: string, note: string | undefined, tenantId = 'swift-default') {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const today = await this.prisma.discoveryCategoryRequest.count({
      where: { vendorId, createdAt: { gte: since } },
    });
    if (today >= CAT_REQUEST_RATE_PER_DAY) {
      throw new AppError(429, 'REQUEST_LIMIT', 'That’s the limit for today — we’ll review what you’ve sent');
    }
    return this.prisma.discoveryCategoryRequest.create({
      data: { tenantId, vendorId, proposedName: proposedName.trim(), note: note?.trim() || null },
    });
  }

  async vendorRequests(vendorId: string) {
    return this.prisma.discoveryCategoryRequest.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }
}
