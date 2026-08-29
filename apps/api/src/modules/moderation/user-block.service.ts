import { Prisma, type PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';

/**
 * [STORE-002] User blocking — the third leg of App Store Guideline 1.2 and
 * Google Play's UGC policy. Swift shipped the content filter, the report door
 * and the published contact; this is the one a person actually reaches for
 * when the other three have not helped them.
 *
 * Two rules, and they are deliberately not the same rule:
 *
 *   VISIBILITY is DIRECTIONAL. The blocker stops seeing what the blocked
 *   person wrote. The blocked person's reviews do not vanish for everyone
 *   else — one customer's block is not a moderation decision, and treating it
 *   as one would hand any user a delete button over someone else's writing.
 *
 *   CONTACT is SYMMETRIC. Neither side may open or continue a conversation
 *   while a block is active in EITHER direction. A one-way contact rule only
 *   means the blocked party keeps talking in the other direction, which is
 *   the behaviour being escaped.
 *
 * Every query passes tenantId explicitly. The request-scoped Prisma extension
 * is a second wall, not the only one: socket handlers and background workers
 * do not run inside an HTTP tenant context at all.
 */

type UserBlockDb = Pick<PrismaClient, 'userBlock'>;

export interface ActiveUserBlock {
  id: string;
  blockerId: string;
  blockedId: string;
  blockedAt: Date;
}

const ACTIVE_FIELDS = { id: true, blockerId: true, blockedId: true, blockedAt: true } as const;

/**
 * The block standing between two people, in either direction, or null.
 *
 * Callers asking "may these two be put in contact" must use this and not a
 * one-directional lookup — see the symmetry rule above.
 */
export async function findActiveBlockBetween(
  db: UserBlockDb,
  tenantId: string,
  firstUserId: string,
  secondUserId: string,
): Promise<ActiveUserBlock | null> {
  if (firstUserId === secondUserId) return null;
  return db.userBlock.findFirst({
    where: {
      tenantId,
      unblockedAt: null,
      OR: [
        { blockerId: firstUserId, blockedId: secondUserId },
        { blockerId: secondUserId, blockedId: firstUserId },
      ],
    },
    select: ACTIVE_FIELDS,
  });
}

/** User ids whose authored content must be hidden FROM this viewer.
 *  Directional on purpose: this is what the blocker chose not to read, not a
 *  judgement anyone else inherits. */
export async function blockedAuthorIds(
  db: UserBlockDb,
  tenantId: string,
  viewerId: string,
): Promise<string[]> {
  const rows = await db.userBlock.findMany({
    where: { tenantId, blockerId: viewerId, unblockedAt: null },
    select: { blockedId: true },
  });
  return [...new Set(rows.map((r) => r.blockedId))];
}

/**
 * User ids this person may not be put in contact with — those they blocked AND
 * those who blocked them. Dispatch and chat both ask this question, and both
 * must ask it in both directions.
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
  return [...new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)))];
}

/** Refuse a contact attempt across a block. */
export async function assertUsersMayContact(
  db: UserBlockDb,
  tenantId: string,
  firstUserId: string,
  secondUserId: string,
): Promise<void> {
  if (await findActiveBlockBetween(db, tenantId, firstUserId, secondUserId)) {
    // One neutral message whichever side is asking. Saying "you blocked them"
    // to one party and "they blocked you" to the other turns this endpoint
    // into an oracle for a decision the other person made privately.
    throw new AppError(403, 'USER_BLOCKED', 'Contact is unavailable between these accounts.');
  }
}

/**
 * Put a block in force. Idempotent: blocking someone already blocked returns
 * the standing block untouched, the same call ContentReport makes for
 * re-reporting. Re-blocking after an unblock reuses the row and refreshes
 * `blockedAt`, so the screen dates the block that is actually in force.
 */
export async function activateUserBlock(
  db: UserBlockDb,
  input: { tenantId: string; blockerId: string; blockedId: string; reason?: string | null },
): Promise<{ block: ActiveUserBlock; alreadyBlocked: boolean }> {
  if (input.blockerId === input.blockedId) {
    // Also a CHECK constraint. Refused here so the caller gets a sentence
    // rather than a database error, and refused there so no other writer can
    // introduce a row that would make contactBlockedUserIds hand back the
    // caller's own id — which reads, at the dispatch seam, as "this person may
    // not be matched with anyone".
    throw new AppError(400, 'CANNOT_BLOCK_SELF', 'You cannot block your own account.');
  }
  const now = new Date();
  const key = {
    tenantId_blockerId_blockedId: {
      tenantId: input.tenantId,
      blockerId: input.blockerId,
      blockedId: input.blockedId,
    },
  };
  const existing = await db.userBlock.findUnique({ where: key, select: { unblockedAt: true } });
  if (existing && existing.unblockedAt === null) {
    const block = await db.userBlock.findUniqueOrThrow({ where: key, select: ACTIVE_FIELDS });
    return { block, alreadyBlocked: true };
  }

  try {
    const block = await db.userBlock.upsert({
      where: key,
      create: { ...input, reason: input.reason ?? null, blockedAt: now },
      // A row that exists here was unblocked: re-arm it and re-date it.
      update: { unblockedAt: null, blockedAt: now, reason: input.reason ?? null },
      select: ACTIVE_FIELDS,
    });
    return { block, alreadyBlocked: false };
  } catch (error) {
    // Two taps can both pass the read above. The unique index is the race
    // boundary: one write wins, the loser reports the same outcome rather than
    // a 500, because from the user's side both taps did block the person.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const winner = await db.userBlock.findUnique({ where: key, select: ACTIVE_FIELDS });
      if (winner) return { block: winner, alreadyBlocked: true };
    }
    throw error;
  }
}

/**
 * Lift a block. Resolves in place — the row is never deleted, because "they
 * blocked me, then unblocked me" is exactly the shape a harassment review
 * needs to be able to see. Returns how many rows moved, so an unblock of
 * someone who was not blocked is a no-op rather than an error.
 */
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
