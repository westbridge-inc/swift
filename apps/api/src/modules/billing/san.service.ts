import { Prisma, type PrismaClient, type Subscription } from '@prisma/client';
import { generateSan, validateSanShape, type SanValidationFailure } from './san';
import { log } from '../../utils/logger';

// SAN assignment + resolution [san spec 2.3/2.4]. Uniqueness is the DB's
// (subscriptions_san_key); collisions redraw. Tombstones are checked before
// any assignment so a released number can never come back. There is NO
// regenerate path anywhere — a SAN is for life.

type Db = PrismaClient | Prisma.TransactionClient;

const isUniqueViolation = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

/** Assign a SAN if the subscription lacks one; returns the (existing or new)
 *  number. Race-safe: concurrent callers collapse on the unique index. */
export async function ensureSan(db: Db, subscriptionId: string): Promise<string> {
  const sub = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, select: { san: true } });
  if (sub.san) return sub.san;

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const san = generateSan();
    // A fresh draw matching a tombstone would be a reuse — redraw. (No race:
    // tombstoning only ever happens to already-assigned numbers, and this one
    // isn't assigned anywhere.)
    const dead = await db.sanTombstone.findUnique({ where: { san }, select: { san: true } });
    if (dead) continue;
    try {
      // updateMany + san:null guard: if a concurrent caller won, count === 0
      // and the winner's number stands.
      const res = await db.subscription.updateMany({
        where: { id: subscriptionId, san: null },
        data: { san, sanAssignedAt: new Date() },
      });
      if (res.count === 0) {
        const winner = await db.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, select: { san: true } });
        if (winner.san) return winner.san;
        continue; // guard raced without a winner — redraw
      }
      return san;
    } catch (e) {
      if (isUniqueViolation(e)) continue; // another subscription drew it first
      throw e;
    }
  }
  // Statistically impossible below ~100M accounts — page-worthy.
  throw new Error('SAN_SPACE_PRESSURE');
}

/** Release a SAN into the tombstone registry (account erasure/closure paths).
 *  The subscription keeps no number; the tombstone keeps it forever. */
export async function releaseSan(db: Db, subscriptionId: string, reason: string): Promise<void> {
  const sub = await db.subscription.findUnique({ where: { id: subscriptionId }, select: { san: true } });
  if (!sub?.san) return;
  await db.sanTombstone.create({ data: { san: sub.san, subscriptionId, reason } });
  await db.subscription.update({ where: { id: subscriptionId }, data: { san: null } });
  log().info({ subscriptionId, reason }, 'SAN released to tombstone');
}

/** Read-path backstop: heal a missing SAN and return display fields. Spread
 *  into any owner-facing subscription payload — "My Swift Number". */
export async function sanDisplay(db: Db, sub: { id: string; san: string | null }): Promise<{ san: string; sanFormatted: string }> {
  const san = sub.san ?? (await ensureSan(db, sub.id));
  const { formatSan } = await import('./san');
  return { san, sanFormatted: formatSan(san) };
}

export type SanResolution =
  | { ok: true; subscription: Subscription }
  | { ok: false; code: SanValidationFailure | 'SAN_UNKNOWN' | 'TOMBSTONED' | 'ACCOUNT_CLOSED'; san?: string };

/** The DB half of the validation pipeline [spec 2.2]. In payment paths these
 *  codes route to suspense — never reject the money (SO-6); entry/inquiry
 *  paths may surface them directly. */
export async function resolveSan(db: Db, raw: string): Promise<SanResolution> {
  const shape = validateSanShape(raw);
  if (!shape.ok) return { ok: false, code: shape.code };
  const sub = await db.subscription.findUnique({ where: { san: shape.san } });
  if (!sub) {
    const dead = await db.sanTombstone.findUnique({ where: { san: shape.san } });
    return { ok: false, code: dead ? 'TOMBSTONED' : 'SAN_UNKNOWN', san: shape.san };
  }
  if (sub.status === 'CANCELLED') return { ok: false, code: 'ACCOUNT_CLOSED', san: shape.san };
  return { ok: true, subscription: sub };
}

/** Batched, resumable backfill [spec 2.4] + the integrity assertion. Batch of
 *  500 keeps each transaction humane; re-running skips assigned rows, so a
 *  crash mid-way resumes for free. */
export async function backfillSans(prisma: PrismaClient, batchSize = 500): Promise<{ assigned: number; total: number; distinct: number; luhnFailures: number }> {
  let assigned = 0;
  for (;;) {
    const batch = await prisma.subscription.findMany({
      where: { san: null },
      select: { id: true },
      take: batchSize,
      orderBy: { createdAt: 'asc' },
    });
    if (batch.length === 0) break;
    for (const row of batch) {
      await ensureSan(prisma, row.id);
      assigned += 1;
    }
  }
  // Integrity assertion: zero fee-liable rows without a SAN, platform-wide
  // distinctness, 100% Luhn-valid — asserted from the DB, not from hope.
  const [nullCount, rows] = await Promise.all([
    prisma.subscription.count({ where: { san: null } }),
    prisma.subscription.findMany({ where: { san: { not: null } }, select: { san: true } }),
  ]);
  const { luhnValid } = await import('./san');
  const sans = rows.map((r) => r.san!) ;
  const distinct = new Set(sans).size;
  const luhnFailures = sans.filter((s) => !luhnValid(s)).length;
  if (nullCount > 0 || distinct !== sans.length || luhnFailures > 0) {
    log().error({ nullCount, total: sans.length, distinct, luhnFailures }, 'SAN backfill integrity assertion FAILED');
  }
  return { assigned, total: sans.length, distinct, luhnFailures };
}
