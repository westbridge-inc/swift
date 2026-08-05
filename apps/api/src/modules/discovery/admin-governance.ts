import type { PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// Admin governance (#17 Part 7) — founder-gated taxonomy stewardship.
// The request queue disposes what vendors propose (approve / map / reject —
// the reject reason is shown to the vendor VERBATIM, so it's written to be
// read). The merge tool repoints every tag/suggestion row in ONE transaction
// with dedupe on the uniques; row counts must reconcile (CAT-J:
// before === after + dedupes) or the transaction never lands.
// ---------------------------------------------------------------------------

function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export class DiscoveryGovernanceService {
  constructor(private prisma: PrismaClient) {}

  private async request(requestId: string) {
    const req = await this.prisma.discoveryCategoryRequest.findUnique({ where: { id: requestId } });
    if (!req) throw new NotFoundError('CategoryRequest', requestId);
    if (req.status !== 'PENDING') throw new AppError(400, 'ALREADY_RESOLVED', `This request is ${req.status.toLowerCase()}`);
    return req;
  }

  /** Approve → a new ACTIVE category is born (curated by the founder). */
  async approveRequest(
    requestId: string,
    input: { name?: string; emoji: string; kind: 'CUISINE' | 'DISH' | 'DIETARY' | 'AISLE' | 'RETAIL'; vertical: 'FOOD' | 'GROCERY' | 'RETAIL'; resolvedBy: string },
  ) {
    const req = await this.request(requestId);
    const name = (input.name ?? req.proposedName).trim();
    const slug = slugify(name);
    if (!slug) throw new AppError(400, 'BAD_NAME', 'That name does not make a usable category');

    const category = await this.prisma.discoveryCategory.upsert({
      where: { tenantId_slug: { tenantId: req.tenantId, slug } },
      create: {
        tenantId: req.tenantId, slug, name, kind: input.kind, vertical: input.vertical,
        emoji: input.emoji, aliases: [name.toLowerCase()], status: 'ACTIVE',
      },
      update: { status: 'ACTIVE' },
    });
    await this.prisma.discoveryCategoryRequest.update({
      where: { id: req.id },
      data: { status: 'APPROVED', resolvedCategoryId: category.id, resolvedBy: input.resolvedBy, resolvedAt: new Date() },
    });
    return { request: req, category };
  }

  /** Map → the request resolves to an EXISTING category; the vendor's store
   *  gains it as an ADMIN secondary when there's room and no membership yet. */
  async mapRequest(requestId: string, targetSlug: string, resolvedBy: string) {
    const req = await this.request(requestId);
    const target = await this.prisma.discoveryCategory.findUnique({
      where: { tenantId_slug: { tenantId: req.tenantId, slug: targetSlug } },
    });
    if (!target || target.status !== 'ACTIVE') throw new AppError(400, 'UNKNOWN_CATEGORY', 'Pick an active category to map to');

    const member = await this.prisma.vendorDiscoveryCategory.findUnique({
      where: { vendorId_categoryId: { vendorId: req.vendorId, categoryId: target.id } },
    });
    const chosen = await this.prisma.vendorDiscoveryCategory.count({
      where: { vendorId: req.vendorId, source: { in: ['VENDOR', 'ADMIN'] } },
    });
    if (!member && chosen < 3) {
      await this.prisma.vendorDiscoveryCategory.create({
        data: { tenantId: req.tenantId, vendorId: req.vendorId, categoryId: target.id, role: 'SECONDARY', source: 'ADMIN' },
      }).catch(() => undefined); // a race with the vendor's own pick — theirs wins
    }
    await this.prisma.discoveryCategoryRequest.update({
      where: { id: req.id },
      data: { status: 'MERGED', resolvedCategoryId: target.id, resolvedBy, resolvedAt: new Date() },
    });
    return { request: req, target };
  }

  /** Reject — reason required; the vendor reads it verbatim. */
  async rejectRequest(requestId: string, reason: string, resolvedBy: string) {
    const req = await this.request(requestId);
    await this.prisma.discoveryCategoryRequest.update({
      where: { id: req.id },
      data: { status: 'REJECTED', resolvedNote: reason.trim(), resolvedBy, resolvedAt: new Date() },
    });
    return { request: req };
  }

  /**
   * Merge category A into B (CAT-J): one transaction repoints every
   * VendorDiscoveryCategory / ItemDiscoveryCategory / Suggestion row with
   * dedupe on the unique constraints, marks A MERGED with mergedIntoId
   * (after which /c/A 301s and the feed follows the redirect). Row counts
   * reconcile — before === after + dedupes — asserted INSIDE the tx so a
   * miscount can never land.
   */
  async mergeCategories(sourceId: string, targetId: string) {
    if (sourceId === targetId) throw new AppError(400, 'SELF_MERGE', 'A category cannot merge into itself');
    const [source, target] = await Promise.all([
      this.prisma.discoveryCategory.findUnique({ where: { id: sourceId } }),
      this.prisma.discoveryCategory.findUnique({ where: { id: targetId } }),
    ]);
    if (!source) throw new NotFoundError('Category', sourceId);
    if (!target || target.status !== 'ACTIVE') throw new AppError(400, 'BAD_TARGET', 'Merge target must be an active category');
    if (source.status === 'MERGED') throw new AppError(400, 'ALREADY_MERGED', 'Already merged');

    return this.prisma.$transaction(async (tx) => {
      const beforeCounts = {
        vendor: await tx.vendorDiscoveryCategory.count({ where: { categoryId: { in: [sourceId, targetId] } } }),
        item: await tx.itemDiscoveryCategory.count({ where: { categoryId: { in: [sourceId, targetId] } } }),
        suggestion: await tx.discoveryCategorySuggestion.count({ where: { categoryId: { in: [sourceId, targetId] } } }),
      };

      // Dedupe: a source row whose owner already holds a target row would
      // collide with the unique — it is dropped (that's the dedupe count).
      const dupVendors = await tx.vendorDiscoveryCategory.findMany({
        where: { categoryId: sourceId, vendorId: { in: (await tx.vendorDiscoveryCategory.findMany({ where: { categoryId: targetId }, select: { vendorId: true } })).map((r) => r.vendorId) } },
        select: { id: true },
      });
      const dupItems = await tx.itemDiscoveryCategory.findMany({
        where: { categoryId: sourceId, itemId: { in: (await tx.itemDiscoveryCategory.findMany({ where: { categoryId: targetId }, select: { itemId: true } })).map((r) => r.itemId) } },
        select: { id: true },
      });
      const dupSuggestions = await tx.discoveryCategorySuggestion.findMany({
        where: { categoryId: sourceId, itemId: { in: (await tx.discoveryCategorySuggestion.findMany({ where: { categoryId: targetId }, select: { itemId: true } })).map((r) => r.itemId) } },
        select: { id: true },
      });
      await tx.vendorDiscoveryCategory.deleteMany({ where: { id: { in: dupVendors.map((d) => d.id) } } });
      await tx.itemDiscoveryCategory.deleteMany({ where: { id: { in: dupItems.map((d) => d.id) } } });
      await tx.discoveryCategorySuggestion.deleteMany({ where: { id: { in: dupSuggestions.map((d) => d.id) } } });

      await tx.vendorDiscoveryCategory.updateMany({ where: { categoryId: sourceId }, data: { categoryId: targetId } });
      await tx.itemDiscoveryCategory.updateMany({ where: { categoryId: sourceId }, data: { categoryId: targetId } });
      await tx.discoveryCategorySuggestion.updateMany({ where: { categoryId: sourceId }, data: { categoryId: targetId } });

      await tx.discoveryCategory.update({
        where: { id: sourceId },
        data: { status: 'MERGED', mergedIntoId: targetId },
      });

      const afterCounts = {
        vendor: await tx.vendorDiscoveryCategory.count({ where: { categoryId: targetId } }),
        item: await tx.itemDiscoveryCategory.count({ where: { categoryId: targetId } }),
        suggestion: await tx.discoveryCategorySuggestion.count({ where: { categoryId: targetId } }),
      };
      const dedupes = { vendor: dupVendors.length, item: dupItems.length, suggestion: dupSuggestions.length };
      // CAT-J inside the tx: a miscount aborts the whole merge.
      for (const key of ['vendor', 'item', 'suggestion'] as const) {
        if (beforeCounts[key] !== afterCounts[key] + dedupes[key]) {
          throw new AppError(500, 'MERGE_MISCOUNT', `Merge reconciliation failed on ${key} rows`);
        }
      }
      const orphans = await tx.vendorDiscoveryCategory.count({ where: { categoryId: sourceId } })
        + await tx.itemDiscoveryCategory.count({ where: { categoryId: sourceId } })
        + await tx.discoveryCategorySuggestion.count({ where: { categoryId: sourceId } });
      if (orphans !== 0) throw new AppError(500, 'MERGE_ORPHANS', 'Merge left orphaned rows');

      return { beforeCounts, afterCounts, dedupes };
    });
  }
}
