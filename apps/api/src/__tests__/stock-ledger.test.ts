import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { applyStockMovement, reconcileItemStock, recordOpeningBalance } from '../modules/inventory/stock';

// ---------------------------------------------------------------------------
// THE STOCK LEDGER [MKT-2 Movement 1] — does it actually explain the counter?
//
// `Item.stockQuantity` is a cache. `stock_movements` is the truth. The whole
// point is that replaying the ledger reproduces the counter, so that when a
// vendor says "I had twelve and you show nine" there is an answer.
//
// Before this the answer did not exist: five places wrote the counter and only
// two logged anything, and the one that never logged was SELLING — the most
// ordinary movement there is.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } },
});

// A fresh phone range per run. The ledger is append-only even in tests, so a
// failed teardown leaves rows behind and a fixed prefix would then collide on
// the next run — which is exactly how the first run of this file failed.
const PHONE_BASE = 592_009_500_000 + Math.floor(Math.random() * 400_000);

const userIds: string[] = [];
const vendorIds: string[] = [];
const itemIds: string[] = [];
let categoryId = '';
let seq = 0;

async function makeItem(stock: number | null) {
  seq += 1;
  const owner = await prisma.user.create({
    data: {
      phone: `+${PHONE_BASE + seq}`,
      firstName: 'Ledger', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  userIds.push(owner.id);
  const vo = await prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Ledger Store ${seq}`, slug: `ledger-${nanoid(6)}`,
      vendorType: 'STORE', phone: '+5920095100', addressLine1: '9 Regent St',
      city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const cat = await prisma.category.create({ data: { vendorId: vendor.id, name: 'Goods', sortOrder: 0 } });
  categoryId = cat.id;
  const item = await prisma.item.create({
    data: { vendorId: vendor.id, categoryId: cat.id, name: `Tool ${seq}`, basePrice: 2500, isAvailable: true, stockQuantity: stock },
  });
  itemIds.push(item.id);
  return item;
}

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  // Deliberately NOT deleting the movements: the database refuses, by design.
  // Inventory evidence outlives the item it describes, which is the whole point
  // — so these rows stay, orphaned and harmless, as they would in production.
  await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
  await prisma.category.deleteMany({ where: { id: categoryId } }).catch(() => {});
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const counterOf = async (id: string) =>
  (await prisma.item.findUniqueOrThrow({ where: { id }, select: { stockQuantity: true } })).stockQuantity;

describe('the ledger explains the counter', () => {
  it('a sale moves the counter AND leaves a row that says why', async () => {
    const item = await makeItem(12);
    await recordOpeningBalance(prisma, item.id, 12);

    await prisma.$transaction(async (tx) => {
      await applyStockMovement(tx, { itemId: item.id, delta: -3, reason: 'SALE', orderId: 'ord_test_1' });
    });

    expect(await counterOf(item.id)).toBe(9);

    // The question a vendor actually asks: "I had twelve, you show nine — why?"
    const movements = await prisma.stockMovement.findMany({
      where: { itemId: item.id }, orderBy: { occurredAt: 'asc' },
    });
    expect(movements).toHaveLength(2);
    expect(movements[1]!.reason).toBe('SALE');
    expect(movements[1]!.delta).toBe(-3);
    expect(movements[1]!.balanceAfter).toBe(9);
    expect(movements[1]!.orderId).toBe('ord_test_1');

    const recon = await reconcileItemStock(prisma, item.id);
    expect(recon).toMatchObject({ tracked: true, counter: 9, ledger: 9, drift: 0 });
  });

  it('replaying every movement reproduces the counter exactly', async () => {
    const item = await makeItem(20);
    await recordOpeningBalance(prisma, item.id, 20);

    // A plausible week: sales, a cancellation, a picker refund, a manual count.
    for (const m of [
      { delta: -5, reason: 'SALE' as const },
      { delta: -2, reason: 'PICK' as const },
      { delta: +2, reason: 'CANCEL_RESTOCK' as const },
      { delta: -1, reason: 'SALE' as const },
      { delta: +1, reason: 'PICK_REFUND' as const },
      { delta: -3, reason: 'DAMAGED' as const },
    ]) {
      await prisma.$transaction(async (tx) => {
        await applyStockMovement(tx, { itemId: item.id, ...m });
      });
    }

    const counter = await counterOf(item.id);
    expect(counter).toBe(12); // 20 -5 -2 +2 -1 +1 -3

    const recon = await reconcileItemStock(prisma, item.id);
    expect(recon.ledger).toBe(counter);
    expect(recon.drift).toBe(0);
  });

  it('refuses to oversell — the conditional guard survived the rewrite', async () => {
    const item = await makeItem(2);
    await recordOpeningBalance(prisma, item.id, 2);

    await expect(
      prisma.$transaction(async (tx) => {
        await applyStockMovement(tx, { itemId: item.id, delta: -5, reason: 'SALE' });
      }),
    ).rejects.toThrow(/sold out/i);

    // Nothing moved, and nothing was written — the transaction unwound whole.
    expect(await counterOf(item.id)).toBe(2);
    const sales = await prisma.stockMovement.count({ where: { itemId: item.id, reason: 'SALE' } });
    expect(sales).toBe(0);
  });

  it('an untracked item is left alone — null means "always in stock" and must stay null', async () => {
    const item = await makeItem(null);
    const result = await prisma.$transaction((tx) =>
      applyStockMovement(tx, { itemId: item.id, delta: -4, reason: 'SALE' }),
    );
    expect(result.applied).toBe(false);
    expect(await counterOf(item.id)).toBeNull();
    expect(await prisma.stockMovement.count({ where: { itemId: item.id } })).toBe(0);
  });

  it('the ledger cannot be rewritten — corrections are new rows, not edits', async () => {
    const item = await makeItem(5);
    await recordOpeningBalance(prisma, item.id, 5);
    const row = await prisma.stockMovement.findFirstOrThrow({ where: { itemId: item.id } });

    // The database refuses, not just our code. An inventory ledger someone can
    // quietly edit is not evidence, and the moment they want to is the moment
    // it matters.
    await expect(
      prisma.stockMovement.update({ where: { id: row.id }, data: { delta: 999 } }),
    ).rejects.toThrow(/append-only/i);

    await expect(
      prisma.stockMovement.delete({ where: { id: row.id } }),
    ).rejects.toThrow(/append-only/i);
  });
});
