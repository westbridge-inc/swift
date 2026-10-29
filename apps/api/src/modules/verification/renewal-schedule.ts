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
import { guyanaWallClockParts, startOfGuyanaDay } from '../../utils/guyana-day';
import { isCalendarDayExpiry, setExpiryStillCountsOr } from './document-validity';

export const RENEWAL_NOTICE_DAYS: readonly number[] = [30, 14, 7, 1];
const DAY_MS = 86_400_000;

/**
 * [R16 · owner 15 Oct 2026, research D7] A document checked again every January (a yearly business name,
 * a licence or food certificate recorded by its year) lapses at the start of 16 January, Guyana time. Its
 * holder is reminded from 1 December — 46 days before — as well as at T-30/14/7/1, so the new year's
 * certificate can be fetched before the offices close for the holidays.
 */
export const JANUARY_RECHECK_FIRST_NOTICE_DAYS = 46;
/** The January re-check instant: 16 January, 00:00 Guyana time (the zone's own offset, never hard-coded). */
export function isJanuaryRecheck(expiresOn: Date): boolean {
  const at = guyanaWallClockParts(expiresOn);
  return at.month === 1 && at.day === 16 && at.hour === 0 && at.minute === 0
    && expiresOn.getUTCSeconds() === 0 && expiresOn.getUTCMilliseconds() === 0;
}

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
    // [FOLLOWUPS ruling] a document counts through the end of its expiry day in Guyana (document-validity.ts)
    where: { suspendedAt: null, OR: setExpiryStillCountsOr('expiresOn', now), document: { status: 'APPROVED' } },
    select: { id: true, documentId: true, subjectId: true, expiresOn: true, notifyAt: true, lastNotified: true },
  });
  const due: DueNotice[] = [];
  for (const r of rows) {
    // [R16] the 1 December reminder of a January re-check joins the database's T-30/14/7/1 notices
    const notifyAt = isJanuaryRecheck(r.expiresOn)
      ? [new Date(r.expiresOn.getTime() - JANUARY_RECHECK_FIRST_NOTICE_DAYS * DAY_MS), ...r.notifyAt]
      : r.notifyAt;
    // [FOLLOWUPS ruling] A calendar-day expiry's notice T-N goes out on the Guyana day N days before the expiry day
    // (its start, not 8 pm the evening before: the database keeps T-N as midnight UTC). The schedule's own time is
    // still what lastNotified records, so a notice already sent is never sent again.
    const sendsAt = (t: Date) => (isCalendarDayExpiry(r.expiresOn) && isCalendarDayExpiry(t) ? startOfGuyanaDay(t.toISOString().slice(0, 10)) : t);
    const candidates = notifyAt.filter((t) => sendsAt(t).getTime() <= now.getTime() && (r.lastNotified === null || t.getTime() > r.lastNotified.getTime()));
    if (candidates.length === 0) continue;
    const latest = candidates.reduce((a, b) => (a > b ? a : b));
    due.push({ scheduleId: r.id, documentId: r.documentId, subjectId: r.subjectId, expiresOn: r.expiresOn, noticeAt: latest, daysLeft: Math.round((r.expiresOn.getTime() - latest.getTime()) / DAY_MS) });
  }
  return due;
}
