import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { csvTextCell } from '../../utils/csv';
import { sniffImageType } from '../../utils/images';
import { isStorePhotoKey, parsePublicPhotoKey } from '../../utils/public-photo-deletion';
import type { StorageProvider } from '../../providers/storage/storage-provider';
import { catalogueChecksFor } from '../compliance/prohibited-gate';

// ---------------------------------------------------------------------------
// [CHAINS PR2 · owner 29 Oct 2026] "Copy the menu from another branch" and "export the menu".
//
// COPY (POST /vendor/menu/copy): one branch's live menu (sections, items, option groups and options) is written
// into ANOTHER branch of the SAME owner whose menu is still empty. Rules:
//  - the same business only: both stores belong to one owner (so one market: the wall), and the caller manages
//    both (the owner, or a manager at both);
//  - into an EMPTY menu only, decided under the target store's row lock: a copy never merges into, duplicates or
//    overwrites a menu someone built. The same copy sent twice (the same copyKey) answers the first copy's result;
//  - prices are copied as the database's Decimal values, never through a float;
//  - what Swift does not allow is never copied (an item judged BANNED: banned goods, a banned category, Swift's own
//    ban). An item whose words wait for a person's check is copied and waits again at the branch (a person's
//    approval is for that one listing, never carried);
//  - a branch's stock is its own: copied items start untracked (no count), so nothing is sold from another branch's
//    shelf; the store sets counts per branch. An item hidden only by the other branch's count or its till is
//    available here; one the store switched off stays off;
//  - photos: the public photo door serves a photo only from the folder of the store that shows it, so a branch
//    cannot show another branch's photo by address. Each photo's stored bytes (already drawn by the door's own
//    drawing, metadata stripped) are kept again in THIS branch's folder through the storage seam. A photo that
//    cannot be read is left off its item (counted), never a reason to refuse the copy.
// EXPORT (GET /vendor/menu/export): the live menu as a CSV in the import template's columns plus the options, every
// text cell guarded against spreadsheet formulas.
// ---------------------------------------------------------------------------

export const MENU_COPY_MAX_ITEMS = 1000;
export const MENU_COPY_AUDIT_ACTION = 'VENDOR_MENU_COPIED';

type Db = PrismaClient | Prisma.TransactionClient;

export type MenuCopyResult = {
  fromStoreId: string;
  categories: number;
  items: number;
  options: number;
  photos: number;
  photosNotCopied: number;
  waitingForCheck: number;
  notAllowed: Array<{ name: string }>;
  replayed: boolean;
};

const sourceMenuSelect = {
  id: true, name: true, description: true, imageUrl: true, sortOrder: true, isActive: true,
  items: {
    where: { archivedAt: null },
    orderBy: { sortOrder: 'asc' },
    select: {
      id: true, name: true, description: true, imageUrl: true, basePrice: true, fulfillment: true, bookingConfig: true,
      isAvailable: true, autoHiddenAt: true, tillOffAt: true,
      isPopular: true, sku: true, barcode: true, unit: true, bulkUnits: true, substitutionGroup: true,
      dietaryTags: true, allergens: true, sortOrder: true, vatClass: true,
      optionGroups: {
        orderBy: { sortOrder: 'asc' },
        select: {
          name: true, isRequired: true, minSelect: true, maxSelect: true, sortOrder: true,
          options: { orderBy: { sortOrder: 'asc' }, select: { name: true, additionalPrice: true, isDefault: true, isAvailable: true, sortOrder: true } },
        },
      },
    },
  },
} satisfies Prisma.CategorySelect;

/** The source store's live menu: sections not archived, items not archived. */
export async function readLiveMenu(db: Db, vendorId: string) {
  return db.category.findMany({
    where: { vendorId, archivedAt: null },
    orderBy: { sortOrder: 'asc' },
    select: sourceMenuSelect,
  });
}

/** True when the store has any live section or item (the copy's target must have neither). */
export async function menuHasAnything(db: Db, vendorId: string): Promise<boolean> {
  const [sections, items] = await Promise.all([
    db.category.count({ where: { vendorId, archivedAt: null } }),
    db.item.count({ where: { vendorId, archivedAt: null } }),
  ]);
  return sections + items > 0;
}

/** The result a copy with this key already wrote for this store, if any (the same copy sent again). */
export async function priorCopy(db: Db, targetId: string, copyKey: string): Promise<MenuCopyResult | null> {
  const row = await db.auditLog.findFirst({
    where: {
      action: MENU_COPY_AUDIT_ACTION, entity: 'Vendor', entityId: targetId,
      changes: { path: ['copyKey'], equals: copyKey },
    },
    select: { changes: true },
  });
  if (!row) return null;
  const result = (row.changes as { result?: MenuCopyResult } | null)?.result;
  return result ? { ...result, replayed: true } : null;
}

/** The bare storage key of a photo this store keeps in its own folder, or null (anything else is not copied). */
function ownPhotoKey(url: string | null, vendorId: string): string | null {
  if (!url || !isStorePhotoKey(url, vendorId)) return null;
  const parsed = parsePublicPhotoKey(url);
  return parsed ? `${parsed.folder}/${parsed.ownerId}/${parsed.file}` : null;
}

/**
 * Keep a copy of each of the source store's photos in the target store's folder. Answers the map from each source
 * address to the new one, and the addresses that could not be copied. The caller deletes `kept` if the copy fails.
 */
export async function copyPhotos(
  storage: StorageProvider, sourceId: string, targetId: string, urls: Array<string | null>,
): Promise<{ map: Map<string, string>; kept: string[]; failed: number }> {
  const map = new Map<string, string>();
  const kept: string[] = [];
  let failed = 0;
  for (const url of new Set(urls.filter((u): u is string => !!u))) {
    const key = ownPhotoKey(url, sourceId);
    if (!key) { failed += 1; continue; }
    try {
      const bytes = await storage.getObject(key);
      const type = sniffImageType(bytes);
      if (!type) { failed += 1; continue; }
      const ext = type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg';
      const { url: copied } = await storage.upload({ buffer: bytes, filename: `photo${ext}`, mimeType: type, folder: `items/${targetId}` });
      map.set(url, copied);
      kept.push(copied);
    } catch {
      failed += 1;
    }
  }
  return { map, kept, failed };
}

type SourceMenu = Awaited<ReturnType<typeof readLiveMenu>>;

/** The items of the source menu Swift does not allow (never copied) and those waiting for a person's check. */
export async function judgeSourceItems(db: Db, menu: SourceMenu): Promise<{ banned: Set<string>; waiting: Set<string> }> {
  const checks = await catalogueChecksFor(db, menu.flatMap((c) => c.items.map((i) => i.id)));
  const banned = new Set<string>();
  const waiting = new Set<string>();
  for (const [id, check] of checks) {
    if (check.state === 'BANNED') banned.add(id);
    else if (check.state === 'WAITING' || check.state === 'APPROVED') waiting.add(id);
  }
  return { banned, waiting };
}

/** Write the source menu into the (empty, locked) target store. Inside the caller's transaction. */
export async function writeMenuCopy(
  tx: Prisma.TransactionClient,
  input: { targetId: string; menu: SourceMenu; banned: Set<string>; photoMap: Map<string, string> },
): Promise<{ categories: number; items: number; options: number; photos: number }> {
  let categories = 0;
  let items = 0;
  let options = 0;
  let photos = 0;
  const photo = (url: string | null) => {
    const copied = url ? input.photoMap.get(url) ?? null : null;
    if (copied) photos += 1;
    return copied;
  };
  for (const section of input.menu) {
    const copiedItems = section.items.filter((i) => !input.banned.has(i.id));
    // A section that held only banned items is not copied (it would be an empty heading).
    if (section.items.length > 0 && copiedItems.length === 0) continue;
    const category = await tx.category.create({ data: {
      vendorId: input.targetId, name: section.name, description: section.description, imageUrl: photo(section.imageUrl),
      sortOrder: section.sortOrder, isActive: section.isActive,
    } });
    categories += 1;
    for (const item of copiedItems) {
      await tx.item.create({ data: {
        vendorId: input.targetId, categoryId: category.id,
        name: item.name, description: item.description, imageUrl: photo(item.imageUrl),
        basePrice: item.basePrice, fulfillment: item.fulfillment,
        ...(item.bookingConfig !== null ? { bookingConfig: item.bookingConfig as Prisma.InputJsonValue } : {}),
        // Hidden by the other branch's stock count or its till (not the store's own switch): this branch has its own.
        isAvailable: item.isAvailable || item.autoHiddenAt !== null || item.tillOffAt !== null, isPopular: item.isPopular, sku: item.sku, barcode: item.barcode, unit: item.unit,
        bulkUnits: item.bulkUnits, substitutionGroup: item.substitutionGroup, dietaryTags: item.dietaryTags,
        allergens: item.allergens, sortOrder: item.sortOrder, vatClass: item.vatClass,
        optionGroups: item.optionGroups.length ? {
          create: item.optionGroups.map((g) => ({
            name: g.name, isRequired: g.isRequired, minSelect: g.minSelect, maxSelect: g.maxSelect, sortOrder: g.sortOrder,
            options: { create: g.options.map((o) => ({
              name: o.name, additionalPrice: o.additionalPrice, isDefault: o.isDefault, isAvailable: o.isAvailable, sortOrder: o.sortOrder,
            })) },
          })),
        } : undefined,
      } });
      items += 1;
      options += item.optionGroups.reduce((n, g) => n + g.options.length, 0);
    }
  }
  return { categories, items, options, photos };
}

/** Refuse a source menu too large to copy in one go (the CSV export and import handle any size). */
export function assertCopyable(menu: SourceMenu): void {
  const count = menu.reduce((n, c) => n + c.items.length, 0);
  if (count === 0) throw new AppError(409, 'SOURCE_MENU_EMPTY', 'That branch has no menu to copy yet.');
  if (count > MENU_COPY_MAX_ITEMS) {
    throw new AppError(409, 'MENU_TOO_LARGE',
      `That menu has ${count} items. A copy takes up to ${MENU_COPY_MAX_ITEMS}: export it and import the file instead.`,
      { items: count, limit: MENU_COPY_MAX_ITEMS });
  }
}

const EXPORT_HEADER = ['category', 'name', 'description', 'basePrice', 'sku', 'unit', 'stockQuantity', 'isAvailable', 'fulfillment', 'options'];

/** "Size: Small (+0.00), Large (+500.00) | Sauce: ..." — one cell; prices as the database's Decimal text. */
function optionsCell(groups: SourceMenu[number]['items'][number]['optionGroups']): string {
  return groups.map((g) => `${g.name}: ${g.options.map((o) => `${o.name} (+${o.additionalPrice.toFixed(2)})`).join(', ')}`).join(' | ');
}

/** The store's live menu as CSV (the import template's columns, then the options), formula-safe. */
export async function menuExportCsv(db: Db, vendorId: string): Promise<string> {
  const [menu, stock] = await Promise.all([
    readLiveMenu(db, vendorId),
    db.item.findMany({ where: { vendorId, archivedAt: null }, select: { id: true, stockQuantity: true } }),
  ]);
  const counts = new Map(stock.map((s) => [s.id, s.stockQuantity]));
  const lines = [EXPORT_HEADER.join(',')];
  for (const section of menu) {
    for (const item of section.items) {
      const count = counts.get(item.id);
      lines.push([
        csvTextCell(section.name), csvTextCell(item.name), csvTextCell(item.description ?? ''), item.basePrice.toFixed(2),
        csvTextCell(item.sku ?? ''), csvTextCell(item.unit ?? ''), count === null || count === undefined ? '' : String(count),
        item.isAvailable ? 'true' : 'false', item.fulfillment, csvTextCell(optionsCell(item.optionGroups)),
      ].join(','));
    }
  }
  return lines.join('\n');
}
