import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { STOCK_REASON_ACTOR } from '../modules/inventory/stock';

// ---------------------------------------------------------------------------
// [RETIER · REVIEW-M #2259 S4-1] THE CENSUS of every write to a store's listings.
//
// items."updatedAt" means "the store changed this listing": a new store's fee and the weekly re-tier count a listing
// that is not for sale when it changed in the last 7 days, and a re-tier notice tells the store that leaving those
// listings alone stops the rise. So a write the store did not make must never move the stamp
// (inventory/system-item-writes.ts says why). Prisma stamps it on every item update, updateMany and upsert.
//
// Every file in the API that writes items is named below, with how many writes of each kind it holds, and is either
// the STORE's (its own editor, stock counts, in-store sales, a till file it confirms, removing listings: the stamp is
// right) or SWIFT's (plain SQL that never names "updatedAt"). A new writer anywhere fails this until it is put on one
// side. If it is Swift's, the fix is a function in system-item-writes.ts, never a Prisma item update.
// ---------------------------------------------------------------------------

const API_SRC = join(__dirname, '..');
const PRISMA_ITEM_WRITE = /\.item\.(update|updateMany|upsert)\(/g;
const RAW_ITEM_UPDATE = /UPDATE\s+"?items"?\s/g;
const NESTED_ITEM_WRITE = /\bitems:\s*\{\s*(update|updateMany|upsert|set)\b/g;

type Census = { prisma: number; raw: number; side: 'STORE' | 'SWIFT' | 'SWIFT_PUTS_ON_SALE' };
const CENSUS: Record<string, Census> = {
  // The store's own routes: image, item editor (+ restock un-hide), delete, availability, stock adjust's and an
  // in-store sale's zero-hide.
  'modules/vendor/vendor.routes.ts': { prisma: 7, raw: 0, side: 'STORE' },
  // The store deleting a section of its menu (its listings are removed with it).
  'modules/vendor/vendor-menu.service.ts': { prisma: 1, raw: 0, side: 'STORE' },
  // A till export the store confirmed: its prices, its for-sale marks, its counts.
  'modules/inventory/pos-sync.ts': { prisma: 4, raw: 1, side: 'STORE' },
  // The stock writer: the opening balance of an item the store creates (Prisma), and the counter moves, which stamp
  // only for a STORE reason (STOCK_REASON_ACTOR, pinned below).
  'modules/inventory/stock.ts': { prisma: 1, raw: 4, side: 'STORE' },
  // Swift's writes, plain SQL without "updatedAt".
  'modules/inventory/system-item-writes.ts': { prisma: 0, raw: 6, side: 'SWIFT' },
  // Stock coming back re-shows a listing the stock engine hid: behind the ban check, the only guarded un-hide.
  'modules/compliance/prohibited-gate.ts': { prisma: 0, raw: 1, side: 'SWIFT' },
  'modules/store-vat/vat-pricing.ts': { prisma: 0, raw: 2, side: 'SWIFT' },
  // The app-review content pack heals its own demo listings, and the same write puts each one on sale
  // (isAvailable: true), so the stamp never decides whether it counts.
  'modules/review/content-pack.ts': { prisma: 1, raw: 0, side: 'SWIFT_PUTS_ON_SALE' },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

const read = (rel: string) => readFileSync(join(API_SRC, rel), 'utf8');
/** The SQL of every $executeRaw / $queryRaw template in a file. */
const sqlOf = (src: string) => [...src.matchAll(/\$(?:executeRaw|queryRaw)(?:<[^>]*>)?`([^`]*)`/g)].map((m) => m[1]!);

describe('every write to a store\'s listings is the store\'s or Swift\'s, and only the store\'s moves "updatedAt"', () => {
  it('the census names every file that writes items, with its writes', () => {
    const found: Record<string, { prisma: number; raw: number }> = {};
    for (const file of sourceFiles(API_SRC)) {
      const src = readFileSync(file, 'utf8');
      const prisma = (src.match(PRISMA_ITEM_WRITE) ?? []).length + (src.match(NESTED_ITEM_WRITE) ?? []).length;
      const raw = (src.match(RAW_ITEM_UPDATE) ?? []).length;
      if (prisma + raw > 0) found[file.slice(API_SRC.length + 1).split('\\').join('/')] = { prisma, raw };
    }
    const expected = Object.fromEntries(Object.entries(CENSUS).map(([file, c]) => [file, { prisma: c.prisma, raw: c.raw }]));
    expect(found).toEqual(expected);
  });

  it('Swift\'s writes never touch "updatedAt" and never use a Prisma item update', () => {
    for (const [file, c] of Object.entries(CENSUS)) {
      if (c.side !== 'SWIFT') continue;
      const sql = sqlOf(read(file)).filter((q) => /UPDATE\s+"?items"?\s/.test(q));
      expect(sql.length, file).toBe(c.raw);
      for (const q of sql) expect(q, file).not.toMatch(/updatedAt/);
    }
  });

  it('the content pack\'s one Prisma write puts its demo listing on sale in the same write', () => {
    const src = read('modules/review/content-pack.ts');
    const fields = src.slice(src.indexOf('const fields = {'), src.indexOf('await prisma.item.upsert('));
    expect(fields).toContain('isAvailable: true,');
  });

  it('only a STORE stock reason stamps the listing: a sale, a cancelled order\'s restock and a picker\'s movements do not', () => {
    expect(STOCK_REASON_ACTOR).toEqual({
      SALE: 'SYSTEM', CANCEL_RESTOCK: 'SYSTEM', PICK: 'SYSTEM', PICK_REFUND: 'SYSTEM',
      RECEIVED: 'STORE', DAMAGED: 'STORE', MANUAL: 'STORE', RECONCILE: 'STORE', RETURN: 'STORE',
      OPENING_BALANCE: 'STORE', IN_STORE_SALE: 'STORE', POS_IMPORT: 'STORE',
    });
    const stock = read('modules/inventory/stock.ts');
    // Both counter moves and the batch move stamp through the reason, never unconditionally.
    expect(stock.match(/\$\{storeStamp\((reason|input\.reason)\)\}/g)).toHaveLength(3);
  });

  it('Swift\'s callers write through system-item-writes.ts: checkout, a picker\'s substitution, a lapsed check, a wind-down, an erasure, Swift\'s reviewers', () => {
    const uses: Array<[string, string[]]> = [
      ['modules/order/order.service.ts', ['await countItemsOrdered(tx, itemIds);', 'await hideSoldOut(tx, oi.itemId);']],
      ['modules/order/picking.service.ts', ['await hideSoldOut(tx, fresh.substituteItemId);']],
      ['modules/verification/verification.service.ts', ['await hideStoreListings(this.prisma, [vendor.id], { onlyForSale: false });']],
      ['modules/user/partner-wind-down.ts', ['hideStoreListings(prisma, vendorIds, { onlyForSale: true })']],
      ['modules/vendor/store-photos.ts', ['await clearListingPhotos(tx, vendorId);']],
      ['modules/admin/admin.routes.ts', ['await approveListingWords(tx, {', 'await markListingProhibited(app.prisma, {']],
    ];
    for (const [file, calls] of uses) {
      const src = read(file);
      for (const call of calls) expect(src, file).toContain(call);
    }
  });
});
