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
      where: { vendorId },
      include: {
        items: {
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
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('Category', id);
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

  /** Hard-delete a category and everything under it (items → option groups →
   *  options). Returns the removed item ids so the caller can evict their
   *  search docs (no sweep could find these rows later). */
  async deleteCategory(vendorId: string, id: string): Promise<{ itemsRemoved: number; removedItemIds: string[] }> {
    const existing = await this.prisma.category.findUnique({
      where: { id },
      include: { _count: { select: { items: true } }, items: { select: { id: true } } },
    });
    if (!existing || existing.vendorId !== vendorId) throw new NotFoundError('Category', id);

    await this.prisma.option.deleteMany({ where: { optionGroup: { item: { categoryId: id } } } });
    await this.prisma.optionGroup.deleteMany({ where: { item: { categoryId: id } } });
    await this.prisma.item.deleteMany({ where: { categoryId: id } });
    await this.prisma.category.delete({ where: { id } });

    return { itemsRemoved: existing._count.items, removedItemIds: existing.items.map((i) => i.id) };
  }

  async reorderCategories(vendorId: string, order: Array<{ id: string; sortOrder: number }>) {
    await this.prisma.$transaction(
      order.map((item) => this.prisma.category.updateMany({ where: { id: item.id, vendorId }, data: { sortOrder: item.sortOrder } })),
    );
    return this.prisma.category.findMany({ where: { vendorId }, orderBy: { sortOrder: 'asc' } });
  }
}
