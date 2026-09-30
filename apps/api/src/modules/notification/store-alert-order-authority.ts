import { Prisma, type PrismaClient } from '@prisma/client';

export type AlertPersistenceGuard = <T>(write: (tx: Prisma.TransactionClient) => Promise<T>) => Promise<T | undefined>;

/** Order is the common parent even when no receipt or inbox row exists yet. */
export async function lockStoreAlertOrders(tx: Prisma.TransactionClient, orderIds: readonly string[], mode: 'read' | 'stop'): Promise<boolean> {
  const ids = [...new Set(orderIds)].sort();
  if (ids.length === 0) return false;
  const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id FROM "orders" WHERE id IN (${Prisma.join(ids)}) ORDER BY id
    ${mode === 'stop' ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`}
  `);
  return locked.length === ids.length;
}

export async function withStoreAlertStop<T>(prisma: PrismaClient, orderIds: readonly string[], write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
    await lockStoreAlertOrders(tx, orderIds, 'stop');
    return write(tx);
  }, { maxWait: 2_000, timeout: 5_000 });
}

export function storeAlertOrderId(data: Prisma.JsonValue): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return data['kind'] === 'vendor_order_alert' && typeof data['orderId'] === 'string' ? data['orderId'] : null;
}

/** NOWAIT avoids reversing existing User -> Order / Order -> Vendor writers. */
export function isAuthorityContention(error: unknown): boolean {
  const e = error as { code?: string; meta?: { code?: string } };
  return e?.code === '55P03' || e?.meta?.code === '55P03';
}
