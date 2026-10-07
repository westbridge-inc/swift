import { Prisma, type StockMovementReason } from '@prisma/client';
import { AppError } from '../../utils/errors';

// ---------------------------------------------------------------------------
// THE SINGLE WRITER [MKT-2 Movement 1].
//
// `Item.stockQuantity` is a CACHE. `StockMovement` is the truth. This module is
// the only thing allowed to move either, and it always moves both, in one
// transaction, so they cannot disagree.
//
// Before this, five separate places wrote the counter — checkout, cancel
// restock, picking, picking refunds, and the vendor's manual adjustment — and
// only two of them left any audit row at all. The three that didn't were the
// ordinary ones: SELLING something wrote nothing down. So a vendor asking "I had
// twelve, you show nine" could not be answered from the data, because the three
// that sold were never recorded.
//
// The atomic conditional decrement that already worked is preserved exactly. It
// is the correct concurrency pattern and it is not being replaced — it is being
// wrapped so that the ledger row commits or rolls back with it.
//
// `stock-single-writer.test.ts` is the CI gate: a source scan that fails the
// build if anyone writes `stockQuantity` outside this file. That is the same
// mechanism `operate-gate-unification.test.ts` uses to stop the canOperate
// predicate being forked, and it works — it already caught a real divergence.
// ---------------------------------------------------------------------------

export interface StockMovementInput {
  itemId: string;
  /** Signed. Negative takes stock off the shelf, positive puts it back. */
  delta: number;
  reason: StockMovementReason;
  /** The order this belongs to, when it has one. */
  orderId?: string | null;
  /** Who caused it. Null for system-driven movements. */
  actorId?: string | null;
  note?: string | null;
  /** Tenancy comes from the item's vendor; pass it when the caller already knows. */
  tenantId?: string;
}

export interface StockApplyResult {
  /** false = the item does not track stock; nothing moved and nothing was logged. */
  applied: boolean;
  balanceAfter: number | null;
  movementId: string | null;
}

/**
 * Move stock and write the ledger row, atomically.
 *
 * MUST be called inside a transaction the caller owns, so the movement shares a
 * fate with whatever caused it — an order that rolls back must not leave a sale
 * in the ledger, and a logged sale must never exist without the stock actually
 * having moved.
 *
 * Untracked items (`stockQuantity === null`) are a deliberate no-op: null means
 * "always available" and must stay null. Logging a movement against an untracked
 * item would invent a balance that has no meaning.
 *
 * A decrement uses the same conditional guard checkout always used — the update
 * only matches while there is enough on hand, so two customers racing for the
 * last one cannot both win. When it does not match we throw, and because we are
 * inside the caller's transaction the whole thing unwinds.
 */
export async function applyStockMovement(
  tx: Prisma.TransactionClient,
  input: StockMovementInput,
): Promise<StockApplyResult> {
  const { itemId, delta, reason } = input;

  if (!Number.isInteger(delta)) {
    throw new AppError(500, 'STOCK_DELTA_INVALID', `Stock delta must be a whole number (got ${delta})`);
  }
  if (delta === 0) {
    return { applied: false, balanceAfter: null, movementId: null };
  }

  const item = await tx.item.findUnique({
    where: { id: itemId },
    select: { id: true, name: true, stockQuantity: true, vendor: { select: { tenantId: true } } },
  });
  if (!item) {
    throw new AppError(404, 'ITEM_NOT_FOUND', `Item ${itemId} does not exist`);
  }

  // null = untracked = always in stock. Never write a movement for it.
  if (item.stockQuantity === null) {
    return { applied: false, balanceAfter: null, movementId: null };
  }

  if (delta < 0) {
    // THE GUARD. Conditional on there being enough, so concurrent takers cannot
    // oversell. Unchanged from what checkout already did — just no longer the
    // only thing that happens.
    const hit = await tx.item.updateMany({
      where: { id: itemId, stockQuantity: { gte: -delta } },
      data: { stockQuantity: { decrement: -delta } },
    });
    if (hit.count === 0) {
      throw new AppError(
        409,
        'INSUFFICIENT_STOCK',
        `${item.name} just sold out — remove it from your cart and try again`,
        { itemId },
      );
    }
  } else {
    await tx.item.update({
      where: { id: itemId },
      data: { stockQuantity: { increment: delta } },
    });
  }

  // Re-read inside the transaction: this is the authoritative post-move value,
  // and recording it is what lets a reconciliation check the cache without
  // replaying the entire history of the item.
  const after = await tx.item.findUniqueOrThrow({
    where: { id: itemId },
    select: { stockQuantity: true },
  });
  const balanceAfter = after.stockQuantity ?? 0;

  const movement = await tx.stockMovement.create({
    data: {
      itemId,
      delta,
      balanceAfter,
      reason,
      tenantId: input.tenantId ?? item.vendor.tenantId,
      orderId: input.orderId ?? null,
      actorId: input.actorId ?? null,
      note: input.note ?? null,
    },
    select: { id: true },
  });

  return { applied: true, balanceAfter, movementId: movement.id };
}

/**
 * Does the ledger explain the counter?
 *
 * Sums every movement for an item and compares it to `stockQuantity`. They must
 * agree — the opening-balance row written at migration means the sum accounts
 * for stock that existed before the ledger did.
 *
 * A drift here means something wrote the counter without going through
 * `applyStockMovement`, which is exactly what the source-scan test exists to
 * prevent. It returns the numbers rather than throwing so a nightly job can
 * report every drifting item instead of dying on the first one.
 */
export async function reconcileItemStock(
  db: Prisma.TransactionClient,
  itemId: string,
): Promise<{ tracked: boolean; counter: number | null; ledger: number | null; drift: number | null }> {
  const item = await db.item.findUnique({ where: { id: itemId }, select: { stockQuantity: true } });
  if (!item || item.stockQuantity === null) {
    return { tracked: false, counter: null, ledger: null, drift: null };
  }
  const sum = await db.stockMovement.aggregate({ where: { itemId }, _sum: { delta: true } });
  const ledger = sum._sum.delta ?? 0;
  return {
    tracked: true,
    counter: item.stockQuantity,
    ledger,
    drift: item.stockQuantity - ledger,
  };
}

/**
 * Record the opening balance for a newly created item.
 *
 * Creating an item with a quantity is not a MOVEMENT — nothing left or entered a
 * shelf, a baseline was declared. But the ledger still has to explain it, or
 * every newly created item reads as drifted by exactly its own starting
 * quantity, and the reconciliation that is supposed to catch real problems
 * starts crying wolf on ordinary ones.
 *
 * Call this in the same transaction as the create. No-op for untracked items.
 *
 * It SETS the counter as well as writing the row, so a caller never has to touch
 * `stockQuantity` itself. That matters: the single-writer gate is only true if
 * this module is genuinely the only place the column is assigned, and a caller
 * that sets the baseline "just this once" is how the rule erodes.
 */
export async function recordOpeningBalance(
  tx: Prisma.TransactionClient,
  itemId: string,
  quantity: number | null | undefined,
  actorId?: string | null,
): Promise<void> {
  if (quantity === null || quantity === undefined) return;
  const item = await tx.item.findUnique({
    where: { id: itemId },
    select: { vendor: { select: { tenantId: true } } },
  });
  if (!item) return;
  await tx.item.update({ where: { id: itemId }, data: { stockQuantity: quantity } });
  await tx.stockMovement.create({
    data: {
      itemId,
      delta: quantity,
      balanceAfter: quantity,
      reason: 'OPENING_BALANCE',
      tenantId: item.vendor.tenantId,
      actorId: actorId ?? null,
      note: 'Stock on hand when the item was created',
    },
  });
}

// ---------------------------------------------------------------------------
// [POS-SYNC] THE SAME WRITER, FOR A BATCH.
//
// A till export can change thousands of counts at once. Done one item at a
// time (4–5 statements each) the store's lock was held for as long as that
// took, and a checkout waiting on the same lock timed out. These are the set
// versions of the two writes above: one UPDATE moves every counter and one
// INSERT writes every ledger row, in the caller's transaction, so the counter
// and the ledger still move together and the single-writer rule still holds —
// they live here, in the one file allowed to move the counter.
// ---------------------------------------------------------------------------

/**
 * Lock items in ONE order — by id — before moving more than one of them.
 *
 * Two transactions that each move several items deadlock when they take the
 * same rows in different orders (a cancel restocking lines B then A while a
 * till sync holds A and waits for B). Every path that moves several items
 * takes their locks through here first, so all of them queue the same way.
 */
export async function lockItemsInIdOrder(tx: Prisma.TransactionClient, itemIds: Array<string | null | undefined>): Promise<void> {
  const ids = [...new Set(itemIds.filter((id): id is string => !!id))].sort();
  if (ids.length === 0) return;
  await tx.$queryRaw`SELECT id FROM "items" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
}

export interface StockBatchEntry {
  itemId: string;
  /** Signed, as for applyStockMovement. */
  delta: number;
}

/**
 * Move many counters and write their ledger rows: one UPDATE, one INSERT.
 *
 * MUST run inside the caller's transaction, after the caller has locked the
 * rows and computed each delta from the locked counts. The same guard as the
 * single move holds for every row (an untracked item is never moved; no
 * counter goes below zero) — and if ANY row fails it, the whole batch throws
 * and the caller's transaction unwinds: a batch is all or nothing.
 *
 * Returns each moved item's balance after the move.
 */
export async function applyStockMovements(
  tx: Prisma.TransactionClient,
  input: {
    vendorId: string;
    tenantId: string;
    entries: StockBatchEntry[];
    reason: StockMovementReason;
    actorId?: string | null;
    note?: string | null;
  },
): Promise<Map<string, number>> {
  const entries = input.entries.filter((e) => e.delta !== 0);
  for (const e of entries) {
    if (!Number.isInteger(e.delta)) {
      throw new AppError(500, 'STOCK_DELTA_INVALID', `Stock delta must be a whole number (got ${e.delta})`);
    }
  }
  if (entries.length === 0) return new Map();
  if (new Set(entries.map((e) => e.itemId)).size !== entries.length) {
    throw new AppError(500, 'STOCK_BATCH_DUPLICATE', 'A stock batch names the same item twice');
  }

  const values = Prisma.join(entries.map((e) => Prisma.sql`(${e.itemId}::text, ${e.delta}::int)`));
  const moved = await tx.$queryRaw<Array<{ id: string; balance: number }>>`
    UPDATE "items" AS i
       SET "stockQuantity" = i."stockQuantity" + v.delta, "updatedAt" = now()
      FROM (VALUES ${values}) AS v(id, delta)
     WHERE i.id = v.id
       AND i."vendorId" = ${input.vendorId}
       AND i."stockQuantity" IS NOT NULL
       AND i."stockQuantity" + v.delta >= 0
    RETURNING i.id AS id, i."stockQuantity" AS balance`;
  if (moved.length !== entries.length) {
    throw new AppError(409, 'STOCK_MOVED', 'Stock changed while these counts were being saved. Nothing was saved; try again.');
  }

  const balances = new Map(moved.map((m) => [m.id, Number(m.balance)]));
  await tx.stockMovement.createMany({
    data: entries.map((e) => ({
      itemId: e.itemId,
      delta: e.delta,
      balanceAfter: balances.get(e.itemId)!,
      reason: input.reason,
      tenantId: input.tenantId,
      actorId: input.actorId ?? null,
      note: input.note ?? null,
    })),
  });
  return balances;
}

/**
 * Opening balances for many newly created items: one UPDATE sets the counters,
 * one INSERT writes the OPENING_BALANCE rows. Same rule as recordOpeningBalance —
 * the caller creates the items WITHOUT a count and this sets it — in the same
 * transaction as the creates.
 */
export async function recordOpeningBalances(
  tx: Prisma.TransactionClient,
  input: { vendorId: string; tenantId: string; entries: Array<{ itemId: string; quantity: number }>; actorId?: string | null },
): Promise<void> {
  const entries = input.entries;
  if (entries.length === 0) return;
  const values = Prisma.join(entries.map((e) => Prisma.sql`(${e.itemId}::text, ${e.quantity}::int)`));
  const set = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "items" AS i
       SET "stockQuantity" = v.quantity, "updatedAt" = now()
      FROM (VALUES ${values}) AS v(id, quantity)
     WHERE i.id = v.id AND i."vendorId" = ${input.vendorId} AND v.quantity >= 0
    RETURNING i.id AS id`;
  if (set.length !== entries.length) {
    throw new AppError(500, 'OPENING_BALANCE_MISMATCH', 'Opening balances did not match the items created');
  }
  await tx.stockMovement.createMany({
    data: entries.map((e) => ({
      itemId: e.itemId,
      delta: e.quantity,
      balanceAfter: e.quantity,
      reason: 'OPENING_BALANCE' as const,
      tenantId: input.tenantId,
      actorId: input.actorId ?? null,
      note: 'Stock on hand when the item was created',
    })),
  });
}
