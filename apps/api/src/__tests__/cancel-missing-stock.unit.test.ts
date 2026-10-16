import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { applyStockMovement, type StockMovementInput } from '../modules/inventory/stock';

function missingItem() {
  const writes = { create: vi.fn().mockResolvedValue({ id: 'movement-fixture' }) };
  const tx = {
    item: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn(), updateMany: vi.fn() },
    stockMovement: writes,
  };
  return { tx, client: tx as unknown as Prisma.TransactionClient, writes };
}
const input: StockMovementInput = {
  itemId: 'deleted-item-fixture', orderId: 'cancelled-order-fixture', delta: 3,
  reason: 'CANCEL_RESTOCK', note: 'Order cancelled before pickup',
  ifItemMissing: { record: true, tenantId: 'tenant-fixture' },
};

describe('cancellation records missing stock without inventing an item balance', () => {
  it('records the skipped quantity against the order and tenant', async () => {
    const { tx, client, writes } = missingItem();
    expect(await applyStockMovement(client, input)).toEqual({
      applied: false, balanceAfter: null, movementId: 'movement-fixture', skipped: 'ITEM_MISSING',
    });
    expect(writes.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        itemId: input.itemId, orderId: input.orderId, tenantId: 'tenant-fixture',
        delta: 0, balanceAfter: 0, reason: 'CANCEL_RESTOCK', actorId: null,
        note: 'Order cancelled before pickup — item no longer exists: 3 unit(s) could not be put back on the shelf',
      }, select: { id: true },
    });
    expect(tx.item.update).not.toHaveBeenCalled();
    expect(tx.item.updateMany).not.toHaveBeenCalled();
  });

  it('keeps missing-item failure for ordinary callers and stock deductions', async () => {
    for (const patch of [{ ifItemMissing: undefined }, { ifItemMissing: 'throw' as const }, { delta: -3 }]) {
      const { client, writes } = missingItem();
      await expect(applyStockMovement(client, { ...input, ...patch }))
        .rejects.toMatchObject({ code: 'ITEM_NOT_FOUND' });
      expect(writes.create).not.toHaveBeenCalled();
    }
  });

  it('does not silently lose the skip if its movement cannot be committed', async () => {
    const { client, writes } = missingItem();
    writes.create.mockRejectedValueOnce(new Error('movement write failed'));
    await expect(applyStockMovement(client, input)).rejects.toThrow('movement write failed');
  });
});
