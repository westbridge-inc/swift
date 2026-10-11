import type { PrismaClient } from '@prisma/client';
import { NotFoundError, ValidationError } from '../../utils/errors';

// Menu/catalogue persistence extracted from vendor.routes.ts so the route file
// stays thin. Pure data + ownership enforcement; the routes keep auth, Zod
// parsing, and the search-index side effects (scheduleVendorSearchSync +
// SearchService) — this service returns what those side effects need (e.g. the
// removed item ids) rather than reaching for `app`. Characterized by the
// catalogue / checkout-integrity / guest-browse suites.
export class VendorMenuService {
  constructor(private prisma: PrismaClient) {}

  /** Categories with their items → option groups → options, all sort-ordered. */
  listCategories(vendorId: string) {
    return this.prisma.category.findMany({
      // [owner 11 Oct] A deleted (archived) category is history, not menu.
      where: { vendorId, archivedAt: null },
      include: {
        items: {
          // [Item 62] Deleted listings are archived history, not menu.
          where: { archivedAt: null },
          orderBy: { sortOrder: 'asc' },
          include: { optionGroups: { orderBy: { sortOrder: 'asc' }, include: { options: { orderBy: { sortOrder: 'asc' } } } } },
        },
      },
      orderBy: { sortOrder: 'asc' },
    });
  }

  async createCategory(vendorId: string, body: { name: string; description?: string; imageUrl?: string; sortOrder?: number }) {
    if (!body.name?.trim()) throw new ValidationError('Category name is required');
    // Auto-assign sortOrder to the end if not provided.
    let sortOrder = body.sortOrder;
    if (sortOrder === undefined) {
      const last = await this.prisma.category.findFirst({ where: { vendorId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }
    return this.prisma.category.create({
      data: { vendorId, name: body.name.trim(), description: body.description?.trim(), imageUrl: body.imageUrl, sortOrder },
    });
  }

  async updateCategory(vendorId: string, id: string, body: { name?: string; description?: string; imageUrl?: string; sortOrder?: number; isActive?: boolean }) {
    const existing = await this.prisma.category.findUnique({ where: { id } });
    if (!existing || existing.vendorId !== vendorId || existing.archivedAt) throw new NotFoundError('Category', id);
    return this.prisma.category.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name.trim() }),
        ...(body.description !== undefined && { description: body.description?.trim() }),
        ...(body.imageUrl !== undefined && { imageUrl: body.imageUrl }),
        ...(body.sortOrder !== undefined && { sortOrder: body.sortOrder }),
        ...(body.isActive !== undefined && { isActive: body.isActive }),
      },
    });
  }

  /** [Item 62 · owner 11 Oct] "Delete" a category: archive it and every live
   *  listing in it, in one transaction. Nothing is removed — orders keep their
   *  lines' references (a cancellation still restocks) and bookings keep their
   *  listing (a hard delete cascaded through items into the customer's
   *  reservation). Returns the listings it archived so the caller can evict
   *  their search docs. */
  async deleteCategory(vendorId: string, id: string): Promise<{ itemsRemoved: number; removedItemIds: string[] }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.category.findFirst({ where: { id, vendorId, archivedAt: null }, select: { id: true } });
      if (!existing) throw new NotFoundError('Category', id);
      const live = await tx.item.findMany({ where: { categoryId: id, archivedAt: null }, select: { id: true } });
      const now = new Date();
      // Same write as a single listing's delete: off sale, auto-hide cleared,
      // so a later restock can never put it back (items_archived_unavailable).
      await tx.item.updateMany({
        where: { categoryId: id, archivedAt: null },
        data: { archivedAt: now, isAvailable: false, autoHiddenAt: null },
      });
      const archived = await tx.category.updateMany({ where: { id, vendorId, archivedAt: null }, data: { archivedAt: now } });
      if (archived.count !== 1) throw new NotFoundError('Category', id);
      return { itemsRemoved: live.length, removedItemIds: live.map((i) => i.id) };
    });
  }

  async reorderCategories(vendorId: string, order: Array<{ id: string; sortOrder: number }>) {
    await this.prisma.$transaction(
      order.map((item) => this.prisma.category.updateMany({ where: { id: item.id, vendorId, archivedAt: null }, data: { sortOrder: item.sortOrder } })),
    );
    return this.prisma.category.findMany({ where: { vendorId, archivedAt: null }, orderBy: { sortOrder: 'asc' } });
  }
}
