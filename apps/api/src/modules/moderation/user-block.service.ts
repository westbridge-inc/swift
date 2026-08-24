import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';

type UserBlockDb = Pick<PrismaClient, 'userBlock'>;
type ContactLockDb = Pick<PrismaClient, '$queryRaw'>;

export interface ActiveUserBlock {
  id: string;
  blockerId: string;
  blockedId: string;
  createdAt: Date;
}

/**
 * Serialize a contact write against block/unblock for one unordered user pair.
 * Call only inside a Prisma transaction: PostgreSQL releases the advisory
 * lock at transaction end. Canonical ordering makes multi-participant chat
 * sends deadlock-safe.
 */
export async function lockUserContactPair(
  db: ContactLockDb,
  tenantId: string,
  firstUserId: string,
  secondUserId: string,
): Promise<void> {
  const [first, second] = [firstUserId, secondUserId].sort();
  const key = `${tenantId}:${first}:${second}`;
  await db.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"
  `;
}

/**
 * A block is directional for visibility (the blocker hides the blocked
 * author's content), but symmetric for contact: neither side may start or
 * continue a conversation while an active row exists in either direction.
 *
 * Every query carries tenantId explicitly. The request-scoped Prisma extension
 * is a second wall, not the only wall, and socket handlers do not run inside an
 * HTTP tenant context at all.
 */
export async function findActiveBlockBetween(
  db: UserBlockDb,
  tenantId: string,
  firstUserId: string,
  secondUserId: string,
): Promise<ActiveUserBlock | null> {
  return db.userBlock.findFirst({
    where: {
      tenantId,
      unblockedAt: null,
      OR: [
        { blockerId: firstUserId, blockedId: secondUserId },
        { blockerId: secondUserId, blockedId: firstUserId },
      ],
    },
    select: { id: true, blockerId: true, blockedId: true, createdAt: true },
  });
}

/** User ids whose authored content must be hidden from this viewer. */
export async function blockedAuthorIds(
  db: UserBlockDb,
  tenantId: string,
  blockerId: string,
): Promise<string[]> {
  const rows = await db.userBlock.findMany({
    where: { tenantId, blockerId, unblockedAt: null },
    select: { blockedId: true },
  });
  return [...new Set(rows.map((row) => row.blockedId))];
}

/**
 * User ids with whom contact is disabled. This includes people the caller
 * blocked and people who blocked the caller; otherwise the blocked party could
 * simply keep sending messages in the opposite direction.
 */
export async function contactBlockedUserIds(
  db: UserBlockDb,
  tenantId: string,
  userId: string,
): Promise<string[]> {
  const rows = await db.userBlock.findMany({
    where: {
      tenantId,
      unblockedAt: null,
      OR: [{ blockerId: userId }, { blockedId: userId }],
    },
    select: { blockerId: true, blockedId: true },
  });
  return [...new Set(rows.map((row) => (
    row.blockerId === userId ? row.blockedId : row.blockerId
  )))];
}

export async function assertUsersMayContact(
  db: UserBlockDb,
  tenantId: string,
  firstUserId: string,
  secondUserId: string,
): Promise<void> {
  if (firstUserId === secondUserId) return;
  if (await findActiveBlockBetween(db, tenantId, firstUserId, secondUserId)) {
    // One neutral response for both directions. Disclosing which side blocked
    // whom would turn the block endpoint into an account-status oracle.
    throw new AppError(403, 'USER_BLOCKED', 'Contact is unavailable between these accounts.');
  }
}

/**
 * Create one audit episode. Repeating an already-active block is idempotent;
 * blocking again after an unblock creates a new row and preserves both events.
 */
export async function activateUserBlock(
  db: UserBlockDb,
  input: { tenantId: string; blockerId: string; blockedId: string },
): Promise<{ block: ActiveUserBlock; alreadyBlocked: boolean }> {
  const current = await db.userBlock.findFirst({
    where: {
      tenantId: input.tenantId,
      blockerId: input.blockerId,
      blockedId: input.blockedId,
      unblockedAt: null,
    },
    select: { id: true, blockerId: true, blockedId: true, createdAt: true },
  });
  if (current) return { block: current, alreadyBlocked: true };

  try {
    const block = await db.userBlock.create({
      data: input,
      select: { id: true, blockerId: true, blockedId: true, createdAt: true },
    });
    return { block, alreadyBlocked: false };
  } catch (error) {
    // The partial unique index is the race boundary. If two taps both pass the
    // read, one insert wins and the other returns the same idempotent outcome.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await db.userBlock.findFirst({
        where: {
          tenantId: input.tenantId,
          blockerId: input.blockerId,
          blockedId: input.blockedId,
          unblockedAt: null,
        },
        select: { id: true, blockerId: true, blockedId: true, createdAt: true },
      });
      if (winner) return { block: winner, alreadyBlocked: true };
    }
    throw error;
  }
}

/** Resolve active rows in place. Audit rows are never deleted. */
export async function deactivateUserBlock(
  db: UserBlockDb,
  input: { tenantId: string; blockerId: string; blockedId: string },
): Promise<number> {
  const result = await db.userBlock.updateMany({
    where: {
      tenantId: input.tenantId,
      blockerId: input.blockerId,
      blockedId: input.blockedId,
      unblockedAt: null,
    },
    data: { unblockedAt: new Date() },
  });
  return result.count;
}
