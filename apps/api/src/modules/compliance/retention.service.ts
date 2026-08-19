import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * [DCR-1 NR-2] Retention clocks — stage 1.
 *
 * The DPA's storage-limitation principle: personal data may not be kept
 * longer than its purpose needs. The registry (retention_policies) declares
 * each window as data; the sweep enforces it and writes a receipt row —
 * the demonstrable-compliance trail the registration pack compiles.
 *
 * Stage 1 covers the classes that are safely enforceable today, with
 * deliberately conservative windows (a shorter window is a one-row update
 * later — the machinery existing is what cannot be retrofitted). Classes
 * whose lifecycle already ends elsewhere are NOT duplicated here:
 * OTP/session-adjacent Redis keys expire by TTL; verification documents
 * crypto-shred at account deletion (account.service); identity-graph rows
 * purge at deletion per the tombstone setting.
 */

export interface RetentionDefault {
  dataClass: string;
  description: string;
  retainDays: number;
  legalBasis: string;
}

export const RETENTION_DEFAULTS: RetentionDefault[] = [
  {
    dataClass: 'sessions.expired',
    description: 'Login sessions whose expiry passed — kept briefly for refresh-theft forensics, then dropped.',
    retainDays: 30,
    legalBasis: 'Authentication artifact; no purpose beyond the re-auth/theft-detection window.',
  },
  {
    dataClass: 'signup_attempts',
    description: 'Hashed signup-velocity rows (phone/device/IP hashes) used for abuse detection.',
    retainDays: 90,
    legalBasis: 'Fraud-prevention legitimate interest; velocity signals are stale after 90 days.',
  },
  {
    dataClass: 'notifications.old',
    description: 'In-app notification inbox rows.',
    retainDays: 180,
    legalBasis: 'Service communication history; users retain receipts/orders separately.',
  },
];

/** Idempotent: insert missing defaults, never overwrite operator-tuned rows. */
export async function seedRetentionDefaults(prisma: PrismaClient): Promise<void> {
  for (const d of RETENTION_DEFAULTS) {
    await prisma.retentionPolicy.upsert({
      where: { dataClass: d.dataClass },
      update: {},
      create: { ...d },
    });
  }
}

/** [F-021-14] The registry is a privileged control path, but a sign/zero typo
 *  must not become an erase-everything cutoff: windows below this floor are
 *  refused at enforcement time (and by a DB CHECK).  */
export const MIN_RETAIN_DAYS = 7;

/** [F-021-15] Enforcers run INSIDE the receipt transaction — the deletion and
 *  its evidence commit together or not at all, so a retry can never replace
 *  the true count with a fabricated zero. [F-021-20] Deletes are batched
 *  (bounded id-subquery) so a backlog cannot pin the compliance worker. */
type Enforcer = (tx: Prisma.TransactionClient, cutoff: Date) => Promise<number>;

const BATCH = 10_000;
/** Statement templates are STATIC (no dynamic identifiers — the SQL-safety
 *  census holds); only values are parameterized. Each loops until drained. */
async function drain(step: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await step();
    total += n;
    if (n < BATCH) return total;
  }
}

const ENFORCERS: Record<string, Enforcer> = {
  'sessions.expired': (tx, cutoff) => drain(() => tx.$executeRaw(Prisma.sql`
    DELETE FROM sessions WHERE id IN (
      SELECT id FROM sessions WHERE "expiresAt" < ${cutoff} LIMIT ${BATCH})`)),
  'signup_attempts': (tx, cutoff) => drain(() => tx.$executeRaw(Prisma.sql`
    DELETE FROM signup_attempts WHERE id IN (
      SELECT id FROM signup_attempts WHERE "createdAt" < ${cutoff} LIMIT ${BATCH})`)),
  // [F-021-12] SAFETY notices are due-process evidence tied to incident cases
  // and legal holds — they are NOT covered by this generic clock. Their
  // lifecycle belongs to the case-based retention of NR-3 (legal hold aware).
  'notifications.old': (tx, cutoff) => drain(() => tx.$executeRaw(Prisma.sql`
    DELETE FROM notifications WHERE id IN (
      SELECT id FROM notifications
      WHERE "createdAt" < ${cutoff} AND type <> 'SAFETY' LIMIT ${BATCH})`)),
};

export interface SweepResult {
  dataClass: string;
  deleted: number;
  cutoff: Date;
  skipped?: 'disabled' | 'no-enforcer' | 'unsafe-window';
}

/** Run every enabled policy once; one receipt per enforced policy. A policy
 *  without an enforcer is reported, never silently ignored — a registry row
 *  the sweep cannot enforce is a coverage gap, not a no-op. */
export async function runRetentionSweep(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<SweepResult[]> {
  const policies = await prisma.retentionPolicy.findMany({ orderBy: { dataClass: 'asc' } });
  const results: SweepResult[] = [];
  for (const policy of policies) {
    const cutoff = new Date(now.getTime() - policy.retainDays * 24 * 60 * 60 * 1000);
    if (!policy.enabled) {
      results.push({ dataClass: policy.dataClass, deleted: 0, cutoff, skipped: 'disabled' });
      continue;
    }
    const enforcer = ENFORCERS[policy.dataClass];
    if (!enforcer) {
      results.push({ dataClass: policy.dataClass, deleted: 0, cutoff, skipped: 'no-enforcer' });
      continue;
    }
    if (policy.retainDays < MIN_RETAIN_DAYS) {
      results.push({ dataClass: policy.dataClass, deleted: 0, cutoff, skipped: 'unsafe-window' });
      continue;
    }
    const started = Date.now();
    // [F-021-15] deletion + receipt commit atomically.
    const deleted = await prisma.$transaction(async (tx) => {
      const n = await enforcer(tx, cutoff);
      await tx.retentionSweepReceipt.create({
        data: { dataClass: policy.dataClass, cutoff, deleted: n, durationMs: Date.now() - started },
      });
      return n;
    }, { timeout: 120_000 });
    results.push({ dataClass: policy.dataClass, deleted, cutoff });
  }
  // [F-021-18] An ENABLED policy the sweep cannot enforce (or refuses as
  // unsafe) is a COVERAGE FAILURE, not a green run: fail the job so the
  // worker's failed-handler pages it durably. Enforced receipts above have
  // already committed — failing here loses nothing.
  const gaps = results.filter((r) => r.skipped === 'no-enforcer' || r.skipped === 'unsafe-window');
  if (gaps.length > 0) {
    throw new Error(
      `[DCR-1 NR-2] retention coverage failure: ${gaps.map((g) => `${g.dataClass}(${g.skipped})`).join(', ')}`,
    );
  }
  return results;
}
