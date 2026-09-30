import { Prisma, type PrismaClient } from '@prisma/client';
import type { SubmissionGuard } from '../../providers/notifications/channels';

const AUTHORITY_WINDOW_MS = 4_000;

/** Same recipient rule inside the caller's Order authority transaction. */
export async function storeAlertAuthorityInTx(tx: Prisma.TransactionClient, vendorId: string, userId: string, nowait = false): Promise<boolean> {
  const owner = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT v.id FROM "vendors" v JOIN "vendor_owners" o ON o.id = v."ownerId"
      JOIN "users" u ON u.id = o."userId"
      WHERE v.id = ${vendorId} AND u.id = ${userId} AND u."tenantId" = v."tenantId" AND u.status = 'ACTIVE'
      FOR SHARE OF v, o, u ${nowait ? Prisma.sql`NOWAIT` : Prisma.empty}
    `);
  const member = owner.length > 0 ? owner : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT s.id FROM "vendor_staff" s JOIN "vendors" v ON v.id = s."vendorId"
      JOIN "users" u ON u.id = s."userId"
      WHERE v.id = ${vendorId} AND u.id = ${userId}
        AND u."tenantId" = v."tenantId" AND u.status = 'ACTIVE'
      FOR SHARE OF s, v, u ${nowait ? Prisma.sql`NOWAIT` : Prisma.empty}
    `);
  return member.length > 0;
}

/** Serialize a recipient's inbox write/handoff with staff deletion, account
 * changes and store ownership changes. No provider response is awaited here.
 * A committed deletion wins before these locks, or waits until handoff. */
export async function withStoreAlertAuthority<T>(
  prisma: PrismaClient,
  vendorId: string,
  userId: string,
  work: (tx: Prisma.TransactionClient, current: () => boolean) => Promise<T>,
): Promise<T | undefined> {
  return prisma.$transaction(async (tx) => {
    const started = performance.now();
    await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
    const admitted = await storeAlertAuthorityInTx(tx, vendorId, userId);
    const current = () => performance.now() - started < AUTHORITY_WINDOW_MS;
    if (!admitted || !current()) return undefined;
    return work(tx, current);
  }, { maxWait: 2_000, timeout: 5_000 });
}

/** Start the outbound operation while authority is locked, attach both result
 * handlers immediately, then commit/release before awaiting the network. The
 * handoff cannot be recalled if a later deletion commits or the response is lost. */
export function storeAlertSubmission(
  prisma: PrismaClient,
  vendorId: string,
  userId: string,
  ready: () => Promise<boolean> = async () => true,
  current: () => boolean = () => true,
): SubmissionGuard {
  return async <T>(submit: () => Promise<T>): Promise<T | undefined> => {
    let pending: Promise<{ value: T } | { error: unknown }> | undefined;
    await withStoreAlertAuthority(prisma, vendorId, userId, async (_tx, authorityCurrent) => {
      if (!(await ready()) || !authorityCurrent() || !current()) return;
      // There is no await between this final check and the actual handoff.
      pending = submit().then((value) => ({ value }), (error: unknown) => ({ error }));
    });
    const result = await pending;
    if (!result) return undefined;
    if ('error' in result) throw result.error;
    return result.value;
  };
}
