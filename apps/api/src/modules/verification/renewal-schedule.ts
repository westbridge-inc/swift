/**
 * [DOC-1 §9.3 · P4-7] Renewal schedules — DOC-INV-4.
 *
 * Every APPROVED document with an expiry has a renewal_schedule row, kept by
 * a trigger on the document itself (so no writer — admin approval, an
 * auto-approval, a backfill — can create the one without the other): notices
 * at T-30, T-14, T-7 and T-1, suspension at expiry. The daily sweep reads the
 * schedule and sends at most ONE notice per run — the latest one due — and
 * advances lastNotified, so a gap in the sweep never becomes a burst of four.
 * Expiry marks the schedule suspended.
 *
 * This file is the source of truth for the trigger DDL; the migration mirrors
 * it and the suite installs it.
 */
import type { PrismaClient } from '@prisma/client';

export const RENEWAL_NOTICE_DAYS: readonly number[] = [30, 14, 7, 1];
const DAY_MS = 86_400_000;

export function noticeTimesFor(expiresOn: Date): Date[] {
  return RENEWAL_NOTICE_DAYS.map((d) => new Date(expiresOn.getTime() - d * DAY_MS));
}

export function renewalScheduleDdl(): string[] {
  const keep = `CREATE OR REPLACE FUNCTION renewal_schedule_keep() RETURNS trigger AS $$
      DECLARE v_tenant TEXT;
      BEGIN
        IF NEW.status = 'APPROVED' AND NEW."expiresAt" IS NOT NULL THEN
          SELECT "tenantId" INTO v_tenant FROM users WHERE id = NEW."userId";
          INSERT INTO renewal_schedule ("documentId", "tenantId", "subjectId", "expiresOn", "notifyAt", "suspendAt", "createdAt", "updatedAt")
          VALUES (NEW.id, COALESCE(v_tenant, 'swift-default'), NEW."userId", NEW."expiresAt",
                  ARRAY[NEW."expiresAt" - interval '30 days', NEW."expiresAt" - interval '14 days', NEW."expiresAt" - interval '7 days', NEW."expiresAt" - interval '1 day'],
                  NEW."expiresAt", now(), now())
          ON CONFLICT ("documentId") DO UPDATE SET
            "expiresOn" = EXCLUDED."expiresOn",
            "notifyAt" = EXCLUDED."notifyAt",
            "suspendAt" = EXCLUDED."suspendAt",
            "suspendedAt" = CASE WHEN renewal_schedule."expiresOn" = EXCLUDED."expiresOn" THEN renewal_schedule."suspendedAt" ELSE NULL END,
            "lastNotified" = CASE WHEN renewal_schedule."expiresOn" = EXCLUDED."expiresOn" THEN renewal_schedule."lastNotified" ELSE NULL END,
            "updatedAt" = now();
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`;
  return [
    keep,
    `DROP TRIGGER IF EXISTS verification_documents_keep_renewal ON verification_documents`,
    `CREATE TRIGGER verification_documents_keep_renewal AFTER INSERT OR UPDATE OF status, "expiresAt" ON verification_documents FOR EACH ROW EXECUTE FUNCTION renewal_schedule_keep()`,
  ];
}

export interface DueNotice { scheduleId: string; documentId: string; subjectId: string; expiresOn: Date; noticeAt: Date; daysLeft: number }

/** The latest notice due per active schedule that has not been sent — one per document, never a burst. */
export async function dueRenewalNotices(prisma: PrismaClient, now = new Date()): Promise<DueNotice[]> {
  const rows = await prisma.renewalSchedule.findMany({
    where: { suspendedAt: null, expiresOn: { gt: now }, document: { status: 'APPROVED' } },
    select: { id: true, documentId: true, subjectId: true, expiresOn: true, notifyAt: true, lastNotified: true },
  });
  const due: DueNotice[] = [];
  for (const r of rows) {
    const candidates = r.notifyAt.filter((t) => t.getTime() <= now.getTime() && (r.lastNotified === null || t.getTime() > r.lastNotified.getTime()));
    if (candidates.length === 0) continue;
    const latest = candidates.reduce((a, b) => (a > b ? a : b));
    due.push({ scheduleId: r.id, documentId: r.documentId, subjectId: r.subjectId, expiresOn: r.expiresOn, noticeAt: latest, daysLeft: Math.round((r.expiresOn.getTime() - latest.getTime()) / DAY_MS) });
  }
  return due;
}
