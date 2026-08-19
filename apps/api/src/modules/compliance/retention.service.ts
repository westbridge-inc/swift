import type { PrismaClient } from '@prisma/client';

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

type Enforcer = (prisma: PrismaClient, cutoff: Date) => Promise<number>;

/** Every enforcer deletes ONLY rows strictly older than the cutoff, by the
 *  class's own clock field, and must be safe to re-run (idempotent). */
const ENFORCERS: Record<string, Enforcer> = {
  'sessions.expired': async (prisma, cutoff) =>
    (await prisma.session.deleteMany({ where: { expiresAt: { lt: cutoff } } })).count,
  'signup_attempts': async (prisma, cutoff) =>
    (await prisma.signupAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } })).count,
  'notifications.old': async (prisma, cutoff) =>
    (await prisma.notification.deleteMany({ where: { createdAt: { lt: cutoff } } })).count,
};

export interface SweepResult {
  dataClass: string;
  deleted: number;
  cutoff: Date;
  skipped?: 'disabled' | 'no-enforcer';
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
    const started = Date.now();
    const deleted = await enforcer(prisma, cutoff);
    await prisma.retentionSweepReceipt.create({
      data: { dataClass: policy.dataClass, cutoff, deleted, durationMs: Date.now() - started },
    });
    results.push({ dataClass: policy.dataClass, deleted, cutoff });
  }
  return results;
}
