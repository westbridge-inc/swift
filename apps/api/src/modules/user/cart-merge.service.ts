import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { getTenantId } from '../../plugins/tenant-context';
import { AppError } from '../../utils/errors';
import { checkoutRequestHash } from '../order/checkout-outbox';
import { normalizeItemNote, OptionSelectionError, selectionKey, validateSelectedOptions } from '../order/options';
import { priceCartLine } from '../order/cart-plans';
import { vendorTenantForCaller } from '../vendor/vendor-visibility';

const id = z.string().min(1).max(128);
export const cartMergeSchema = z.object({
  lines: z.array(z.object({
    clientLineId: id, vendorId: id, itemId: id,
    quantity: z.number().int().min(1).max(99),
    expectedUnitPrice: z.number().int().min(0).max(99999999),
    selectedOptions: z.record(z.union([id, z.array(id).max(50)])).optional(),
  })).min(1).max(100),
}).superRefine(({ lines }, ctx) => {
  if (new Set(lines.map(l => l.clientLineId)).size !== lines.length) ctx.addIssue({ code: 'custom', message: 'Each basket line needs its own identifier.' });
  if (new Set(lines.map(l => l.vendorId)).size !== 1) ctx.addIssue({ code: 'custom', message: 'Upload one store basket at a time.' });
});
export type MergeBody = z.infer<typeof cartMergeSchema>;
export type MergeStatus = 'READY' | 'ADDED' | 'UNAVAILABLE' | 'PRICE_CHANGED' | 'OPTIONS_CHANGED' | 'INSUFFICIENT_STOCK' | 'DIFFERENT_STORE' | 'QUANTITY_LIMIT';
export interface MergeVerdict { clientLineId: string; status: MergeStatus; unitPrice?: number }
export interface MergeResult { applied: boolean; verdicts: MergeVerdict[] }

/** A guest upload is one caller-owned command: validate every line before any
 * writes; cart changes and its replay receipt commit together. */
export async function mergeGuestCart(prisma: PrismaClient, userId: string, key: string, input: MergeBody): Promise<MergeResult> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'A basket upload needs a valid Idempotency-Key.');
  const tenantId = getTenantId();
  if (!tenantId) throw new AppError(403, 'TENANT_REQUIRED', 'The signed-in account could not be verified.');
  const requestHash = checkoutRequestHash(input);
  return prisma.$transaction(async tx => {
    // A user exists before a cart does. This row serializes empty-cart creation
    // and same-key replays as well as distinct uploads for this person.
    const user = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM users WHERE id = ${userId} AND "tenantId" = ${tenantId} FOR UPDATE`;
    if (!user.length) throw new AppError(403, 'ACCOUNT_UNAVAILABLE', 'The signed-in account is unavailable.');
    const receipt = await tx.cartMergeReceipt.findUnique({ where: { tenantId_userId_idempotencyKey: { tenantId, userId, idempotencyKey: key } } });
    if (receipt) {
      if (receipt.requestHash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'That basket upload key already belongs to another basket.');
      return receipt.result as unknown as MergeResult;
    }
    const saved = await tx.cart.findUnique({ where: { customerId: userId } });
    if (saved) {
      await tx.$queryRaw`SELECT id FROM carts WHERE id = ${saved.id} AND "customerId" = ${userId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM cart_items WHERE "cartId" = ${saved.id} ORDER BY id FOR UPDATE`;
    }
    const itemIds = [...new Set(input.lines.map(l => l.itemId))].sort();
    const vendorIds = [...new Set(input.lines.map(l => l.vendorId))].sort();
    // Lock the same catalogue boundaries as checkout, before the final read.
    await tx.$queryRaw`SELECT id FROM vendors WHERE id IN (${Prisma.join(vendorIds)}) AND "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM items WHERE id IN (${Prisma.join(itemIds)}) AND "tenantId" = ${tenantId} ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT g.id FROM option_groups g JOIN items i ON i.id = g."itemId" WHERE i.id IN (${Prisma.join(itemIds)}) AND i."tenantId" = ${tenantId} ORDER BY g.id FOR UPDATE OF g`;
    await tx.$queryRaw`SELECT o.id FROM options o JOIN option_groups g ON g.id = o."optionGroupId" JOIN items i ON i.id = g."itemId" WHERE i.id IN (${Prisma.join(itemIds)}) AND i."tenantId" = ${tenantId} ORDER BY o.id FOR UPDATE OF o`;
    const items = await tx.item.findMany({ where: { id: { in: itemIds }, vendor: vendorTenantForCaller() }, include: { optionGroups: { include: { options: true } }, vendor: { select: { id: true, status: true } } } });
    const existing = saved ? await tx.cartItem.findMany({ where: { cartId: saved.id }, include: { item: { select: { vendorId: true } } } }) : [];
    // Only saved LINES from another store are a conflict. An empty saved cart
    // (its lines removed or gone) is no cart: the basket lands and the cart
    // follows this store, as a first add would.
    const differentStore = existing.some(l => l.item.vendorId !== vendorIds[0]);
    const prepared = input.lines.map(line => {
      const verdict: MergeVerdict = { clientLineId: line.clientLineId, status: 'READY' };
      const item = items.find(i => i.id === line.itemId && i.vendorId === line.vendorId);
      let selection = {} as Record<string, string | string[]>;
      if (!item || !item.isAvailable || item.vendor.status !== 'ACTIVE') verdict.status = 'UNAVAILABLE';
      else {
        try {
          selection = validateSelectedOptions(item, line.selectedOptions).selection;
          const price = priceCartLine({ item, quantity: 1, selectedOptions: selection }).unitPrice;
          if (!Number.isSafeInteger(price) || price < 0) verdict.status = 'UNAVAILABLE';
          else { verdict.unitPrice = price; if (price !== line.expectedUnitPrice) verdict.status = 'PRICE_CHANGED'; }
        } catch (e) { if (e instanceof OptionSelectionError) verdict.status = 'OPTIONS_CHANGED'; else throw e; }
      }
      if (verdict.status === 'READY' && differentStore) verdict.status = 'DIFFERENT_STORE';
      return { line, item, selection, verdict };
    });
    for (const part of prepared) {
      if (part.verdict.status !== 'READY' || !part.item) continue;
      const total = input.lines.filter(l => l.itemId === part.line.itemId).reduce((n, l) => n + l.quantity, 0)
        + existing.filter(l => l.itemId === part.line.itemId).reduce((n, l) => n + l.quantity, 0);
      if (part.item.stockQuantity !== null && total > part.item.stockQuantity) part.verdict.status = 'INSUFFICIENT_STOCK';
      const identity = selectionKey(part.selection);
      const combined = prepared.filter(p => p.line.itemId === part.line.itemId && selectionKey(p.selection) === identity).reduce((n, p) => n + p.line.quantity, 0)
        + existing.filter(l => l.itemId === part.line.itemId && selectionKey(l.selectedOptions) === identity && normalizeItemNote(l.specialInstructions) === null).reduce((n, l) => n + l.quantity, 0);
      if (combined > 99 && part.verdict.status === 'READY') part.verdict.status = 'QUANTITY_LIMIT';
    }
    const applied = prepared.every(p => p.verdict.status === 'READY');
    if (applied) {
      const cart = saved
        ? (saved.vendorId === vendorIds[0] ? saved : await tx.cart.update({ where: { id: saved.id }, data: { vendorId: vendorIds[0]! } }))
        : await tx.cart.create({ data: { customerId: userId, vendorId: vendorIds[0]! } });
      for (const part of prepared) {
        const matches = await tx.cartItem.findMany({ where: { cartId: cart.id, itemId: part.line.itemId } });
        const same = matches.find(l => selectionKey(l.selectedOptions) === selectionKey(part.selection) && normalizeItemNote(l.specialInstructions) === null);
        if (same) await tx.cartItem.update({ where: { id: same.id }, data: { quantity: { increment: part.line.quantity } } });
        else await tx.cartItem.create({ data: { cartId: cart.id, itemId: part.line.itemId, quantity: part.line.quantity, selectedOptions: part.selection, specialInstructions: null } });
        part.verdict.status = 'ADDED';
      }
      await tx.cart.update({ where: { id: cart.id }, data: { lastActivityAt: new Date() } });
    }
    const result: MergeResult = { applied, verdicts: prepared.map(p => p.verdict) };
    await tx.cartMergeReceipt.create({ data: { tenantId, userId, idempotencyKey: key, requestHash, result: result as unknown as Prisma.InputJsonValue } });
    return result;
  });
}
