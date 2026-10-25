import { Prisma, type PrismaClient } from '@prisma/client';
import { isServerIssuedMediaId } from '../chat/chat-authority';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';
import { scanLegalHolds } from '../safety/legal-hold';
import { getStorageProvider } from '../../providers/storage/storage-provider';
import { log } from '../../utils/logger';

/**
 * [DCR-1 NR-2] Retention clocks — stage 1.
 *
 * The DPA's storage-limitation principle: personal data may not be kept
 * longer than its purpose needs. The registry (retention_policies) declares
 * each window as data; the sweep enforces it and writes a receipt row —
 * the demonstrable-compliance trail the registration pack compiles.
 *
 * [R23 · research C1] Stage 2 adds the owner's retention table: order chat (1 year after the
 * order ended, unless linked to a claim), resolved support tickets (3 years), and safety records
 * (7 years after closing). Each is a registry row, enforced daily with its own receipt.
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
  // [R23 · research C1/C3] The owner's retention table, enforced by clocks before the policy quotes it.
  {
    dataClass: 'chat.order_messages',
    description: 'Order and service-job chat (messages and their photos), 1 year after the order or job ended.',
    retainDays: 365,
    legalBasis: 'Needed only to settle questions about that order; kept longer while linked to a claim, dispute, return, strike, refund, support ticket, safety case or report, or a legal hold (C3).',
  },
  {
    dataClass: 'support_tickets.resolved',
    description: 'Resolved Help & Support tickets (not safety tickets), 3 years after resolution.',
    retainDays: 1095,
    legalBasis: 'Complaint handling and dispute defence (Limitation Act, 3-year injury/property window); safety tickets follow the safety clock; tickets tied to a refund are kept.',
  },
  {
    dataClass: 'safety.records',
    description: 'Closed SOS alerts, closed incident cases and resolved safety tickets, 7 years after closing.',
    retainDays: 2555,
    legalBasis: 'Safety and incident records cover injury (3 years) and contract (6 years) limitation periods with margin (research C3); never while a legal hold or its evidence exists.',
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

/** An order or service job is "linked to a claim" while any of these points at it (R23). */
const ORDER_CLAIMED = Prisma.sql`(
  EXISTS (SELECT 1 FROM reimbursement_claims x WHERE x."orderId" = o.id)
  OR EXISTS (SELECT 1 FROM custody_recovery_cases x WHERE x."orderId" = o.id)
  OR EXISTS (SELECT 1 FROM return_requests x WHERE x."orderId" = o.id)
  OR EXISTS (SELECT 1 FROM strikes x WHERE x."orderId" = o.id)
  OR EXISTS (SELECT 1 FROM mmg_refund_obligations x WHERE x."orderId" = o.id)
  OR EXISTS (SELECT 1 FROM support_tickets x WHERE x."orderId" = o.id)
  OR EXISTS (SELECT 1 FROM "IncidentCase" x WHERE x."orderId" = o.id)
  OR EXISTS (SELECT 1 FROM "SosAlert" x WHERE x."orderId" = o.id)
  -- an open money question recorded on the order itself (REVIEW-F S3-1): the MMG disagreement
  -- latch (cleared on resolution), cash a rider could not hand back, a door-cash mismatch
  OR o."mmgClaimMismatchAt" IS NOT NULL
  -- (IS NOT DISTINCT FROM: a NULL status must read as not held, never as unknown, or NOT (...) drops every row)
  OR (o."doorCashReturnStatus" IS NOT DISTINCT FROM 'HELD' AND o."doorCashReturnResolvedAt" IS NULL)
  OR (o."doorCashMismatchAt" IS NOT NULL AND o."doorCashReturnResolvedAt" IS NULL))`;
const JOB_CLAIMED = Prisma.sql`EXISTS (SELECT 1 FROM "SosAlert" x WHERE x."serviceJobId" = j.id)`;

/** [S-09] While any legal hold is partial (or the freeze is on), Swift cannot tell what a hold
 *  covers: every R23 clock deletes nothing, like the evidence sweep. */
async function legalHoldFrozen(tx: Prisma.TransactionClient, clock: string): Promise<boolean> {
  const holds = await scanLegalHolds(tx as unknown as PrismaClient);
  if (holds.deletionFrozen) {
    log().error({ clock, partial: holds.partial.slice(0, 20) }, '[R23] retention frozen: a legal hold is partial or the freeze is on; nothing deleted');
  }
  return holds.deletionFrozen;
}

const CHAT_BATCH = 500;
/** Photo deletes are network calls inside the receipt transaction (timeout 120 s): one run stops
 *  taking new batches after this long, and the next daily run continues the backlog. */
const CHAT_RUN_BUDGET_MS = 60_000;
/**
 * [R23] Order chat, 1 year after the order/job ended. A message goes only when its room's
 * order (or service job) is finished and ended before the cutoff, nothing claims the order,
 * no participant is under a legal hold, and the message itself was never reported. A photo's
 * stored object is deleted first; one that cannot be deleted keeps its message (and pointer)
 * for the next sweep, so no object is ever orphaned.
 */
async function enforceOrderChat(tx: Prisma.TransactionClient, cutoff: Date): Promise<number> {
  if (await legalHoldFrozen(tx, 'chat')) return 0;
  const storage = getStorageProvider();
  const started = Date.now();
  let total = 0;
  for (;;) {
    const rows = await tx.$queryRaw<Array<{ id: string; chatRoomId: string; mediaUrl: string | null }>>(Prisma.sql`
      SELECT m.id, m."chatRoomId", m."mediaUrl"
      FROM chat_messages m
      JOIN chat_rooms r ON r.id = m."chatRoomId"
      LEFT JOIN orders o ON o.id = r."orderId"
      LEFT JOIN service_jobs j ON j.id = r."serviceJobId"
      WHERE m."createdAt" < ${cutoff}
        AND (
          (o.id IS NOT NULL
            AND o.status::text IN (${Prisma.join(TERMINAL_ORDER_STATUSES)})
            AND COALESCE(o."deliveredAt", o."cancelledAt", o."updatedAt") < ${cutoff}
            AND NOT ${ORDER_CLAIMED})
          OR (o.id IS NULL AND j.id IS NOT NULL
            AND j.status IN ('COMPLETED', 'CANCELLED')
            AND COALESCE(j."completedAt", j."cancelledAt", j."updatedAt") < ${cutoff}
            AND NOT ${JOB_CLAIMED})
        )
        AND NOT EXISTS (SELECT 1 FROM content_reports cr WHERE cr."targetType" = 'CHAT_MESSAGE' AND cr."targetId" = m.id)
        AND NOT EXISTS (
          SELECT 1 FROM chat_room_participants p JOIN doc_legal_hold h ON h."subjectUserId" = p."userId"
          WHERE p."chatRoomId" = r.id AND h."releasedAt" IS NULL)
      ORDER BY m."createdAt"
      LIMIT ${CHAT_BATCH}`);
    if (rows.length === 0) return total;
    const deletable: string[] = [];
    let spent = false;
    for (const row of rows) {
      // The budget is checked per photo too: one slow batch must not outlive the transaction.
      if (Date.now() - started > CHAT_RUN_BUDGET_MS) { spent = true; break; }
      if (row.mediaUrl && isServerIssuedMediaId(row.mediaUrl, row.chatRoomId)) {
        try {
          await storage.delete(row.mediaUrl);
        } catch (err) {
          log().error({ err, messageId: row.id }, '[R23] chat retention: photo not deleted; the message is kept for the next sweep');
          continue;
        }
      }
      deletable.push(row.id);
    }
    if (deletable.length > 0) {
      total += await tx.$executeRaw(Prisma.sql`DELETE FROM chat_messages WHERE id IN (${Prisma.join(deletable)})`);
    }
    // Rows kept for a failed photo delete would be selected again: stop after one partial batch.
    if (rows.length < CHAT_BATCH || deletable.length < rows.length) return total;
    if (spent || Date.now() - started > CHAT_RUN_BUDGET_MS) {
      log().warn({ deleted: total }, '[R23] chat retention: run budget spent; the next sweep continues');
      return total;
    }
  }
}

/** [R23] Resolved, non-safety support tickets, 3 years after resolution; never one a refund points at
 *  or whose person is under a legal hold. */
async function enforceSupportTickets(tx: Prisma.TransactionClient, cutoff: Date): Promise<number> {
  if (await legalHoldFrozen(tx, 'tickets')) return 0;
  return drain(() => tx.$executeRaw(Prisma.sql`
    DELETE FROM support_tickets WHERE id IN (
      SELECT t.id FROM support_tickets t
      WHERE t.status = 'RESOLVED' AND t.category <> 'SAFETY'
        AND COALESCE(t."resolvedAt", t."updatedAt") < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM mmg_refund_sends s WHERE s."supportTicketId" = t.id)
        AND NOT EXISTS (SELECT 1 FROM doc_legal_hold h WHERE h."subjectUserId" = t."userId" AND h."releasedAt" IS NULL)
      LIMIT ${BATCH})`));
}

/**
 * [R23] Safety records, 7 years after closing: closed incident cases, then closed SOS alerts
 * (their escalation and retrigger rows cascade), then resolved safety tickets. FAILS CLOSED
 * like the evidence sweep: while any legal hold is partial (or the freeze is on) nothing is
 * deleted. A case or alert with evidence, a legal hold (safety or document), or a person under
 * a document legal hold is kept; an alert a case was opened from is kept while the case is.
 */
async function enforceSafetyRecords(tx: Prisma.TransactionClient, cutoff: Date): Promise<number> {
  if (await legalHoldFrozen(tx, 'safety')) return 0;
  const cases = await drain(() => tx.$executeRaw(Prisma.sql`
    DELETE FROM "IncidentCase" WHERE id IN (
      SELECT c.id FROM "IncidentCase" c
      WHERE c.status = 'CLOSED' AND c."closedAt" < ${cutoff} AND c."legalHold" = false
        AND NOT EXISTS (SELECT 1 FROM legal_holds h WHERE h."caseId" = c.id)
        AND NOT EXISTS (SELECT 1 FROM doc_legal_hold d WHERE d."incidentCaseId" = c.id)
        AND NOT EXISTS (SELECT 1 FROM "EvidenceBundle" b WHERE b."caseId" = c.id
          OR (c."sosAlertId" IS NOT NULL AND b."sosAlertId" = c."sosAlertId"))
      LIMIT ${BATCH})`));
  const alerts = await drain(() => tx.$executeRaw(Prisma.sql`
    DELETE FROM "SosAlert" WHERE id IN (
      SELECT a.id FROM "SosAlert" a
      WHERE a.status IN ('RESOLVED', 'CANCELLED')
        AND COALESCE(a."resolvedAt", a."cancelledAt", a."triggeredAt") < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM "IncidentCase" c WHERE c."sosAlertId" = a.id)
        AND NOT EXISTS (SELECT 1 FROM "EvidenceBundle" b WHERE b."sosAlertId" = a.id)
        AND NOT EXISTS (SELECT 1 FROM doc_legal_hold h WHERE h."subjectUserId" = a."actorUserId" AND h."releasedAt" IS NULL)
        -- a hold on the other party of the alert's order keeps it too (REVIEW-F S4-2)
        AND NOT EXISTS (
          SELECT 1 FROM orders o JOIN doc_legal_hold h ON h."releasedAt" IS NULL AND h."subjectUserId" IN (
            o."customerId",
            (SELECT d."userId" FROM drivers d WHERE d.id = o."driverId"),
            (SELECT r."userId" FROM riders r WHERE r.id = o."riderId"))
          WHERE o.id = a."orderId")
      LIMIT ${BATCH})`));
  // The operations page an alert raised names the person and the place: it goes with the alert.
  const pages = await drain(() => tx.$executeRaw(Prisma.sql`
    DELETE FROM ops_alerts WHERE id IN (
      SELECT p.id FROM ops_alerts p
      WHERE p."sosAlertId" IS NOT NULL AND p."createdAt" < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM "SosAlert" a WHERE a.id = p."sosAlertId")
      LIMIT ${BATCH})`));
  const tickets = await drain(() => tx.$executeRaw(Prisma.sql`
    DELETE FROM support_tickets WHERE id IN (
      SELECT t.id FROM support_tickets t
      WHERE t.status = 'RESOLVED' AND t.category = 'SAFETY'
        AND COALESCE(t."resolvedAt", t."updatedAt") < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM mmg_refund_sends s WHERE s."supportTicketId" = t.id)
        AND NOT EXISTS (SELECT 1 FROM doc_legal_hold h WHERE h."subjectUserId" = t."userId" AND h."releasedAt" IS NULL)
      LIMIT ${BATCH})`));
  return cases + alerts + pages + tickets;
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
  'chat.order_messages': enforceOrderChat,
  'support_tickets.resolved': enforceSupportTickets,
  'safety.records': enforceSafetyRecords,
};

export interface SweepResult {
  dataClass: string;
  deleted: number;
  cutoff: Date;
  skipped?: 'disabled' | 'no-enforcer' | 'unsafe-window' | 'permanent-evidence' | 'policy-unapproved';
}

/** Run every enabled policy once; one receipt per enforced policy. A policy
 *  without an enforcer is reported, never silently ignored — a registry row
 *  the sweep cannot enforce is a coverage gap, not a no-op. */
export async function runRetentionSweep(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<SweepResult[]> {
  const policies = await prisma.retentionPolicy.findMany({ orderBy: { dataClass: 'asc' } });
  // Owner retention draft: admin audit evidence is permanent. Sensitive-read
  // expiry and legal-hold release are unapproved. Report both on every run,
  // including when no registry row exists; a registry clock cannot override it.
  // cutoff is the sweep reference time for these retained classes, not an expiry.
  const results: SweepResult[] = [
    { dataClass: 'audit_logs', deleted: 0, cutoff: now, skipped: 'permanent-evidence' },
    { dataClass: 'sensitive_read_logs', deleted: 0, cutoff: now, skipped: 'policy-unapproved' },
  ];
  for (const policy of policies) {
    if (policy.dataClass === 'audit_logs' || policy.dataClass === 'sensitive_read_logs') continue;
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
