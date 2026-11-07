import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { NotificationService } from '../notification/notification.service';
import { serverErrorsByHour } from '../../lib/server-error-tally';
import { runAsSystem } from '../../plugins/tenant-context';
import { OPS_PAGE_CAPABILITY, pageOps, resolveOpsPage, type PageOutcome } from './ops-page';

// ---------------------------------------------------------------------------
// [FIXES-4] Server errors that keep happening, too few at a time for the spike.
//
// The spike pager in the error handler needs ERROR_RATE_ALERT_PER_MIN (30)
// unhandled 500s inside ONE minute. A week with 70 of them in 26 bursts could
// never fire it: nobody heard. The worker now reads the hourly tally every five
// minutes:
//  - ERROR_SUSTAINED_ALERT_PER_DAY (10) errors in the last 24 to 25 hours open
//    ONE platform page through the durable path (ops-page.ts): an OpsAlert row,
//    a push to the responders, one text to the on-call list, and the ladder
//    until a person acknowledges it. Never an SOS: no SosAlert, no emergency
//    contact. Its reminders obey the SMS cap (ops-alert.ts): one every 2 hours,
//    at most 6 a UTC day, GSM-7, one part;
//  - a delivered page holds its key for a day, so one page a day is the most
//    this condition can open, whatever the bursts do. Errors that never stop
//    page again the next day: bounded, never silenced. The database holds the
//    same bound: a Redis wipe, or a page nobody was staffed to receive, cannot
//    open another that day;
//  - this clock hour and the last one holding no error close the page: nobody
//    is reminded of a condition that ended. The day's count cannot say so, it
//    remembers for a day.
// A quiet tick pages nobody, however many errors the day holds.
// ---------------------------------------------------------------------------

export const SUSTAINED_ERROR_PAGE_TITLE = 'Server errors keep happening';
export const SUSTAINED_ERROR_PAGE_KEY = 'ops_page:error-sustained';
export const SUSTAINED_ERROR_PAGE_WINDOW_SECONDS = 86_400;
/** This hour and the 24 before it: the reach always covers a whole 24 hours. */
const HOURS_READ = 25;
const DEFAULT_THRESHOLD = 10;

/** A typo never silences the page, and one error is never a sustained rate. */
export const sustainedErrorThreshold = (env: Readonly<Record<string, string | undefined>> = process.env): number => {
  const n = Number(env['ERROR_SUSTAINED_ALERT_PER_DAY'] ?? DEFAULT_THRESHOLD);
  return Number.isInteger(n) && n >= 2 ? n : DEFAULT_THRESHOLD;
};

export async function watchErrorRate(
  deps: { prisma: PrismaClient; redis: Redis; notifications: NotificationService; resolveRecipients?: () => Promise<string[]> },
  options: { now?: Date; env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<{ errors: number; threshold: number; outcome: PageOutcome['status'] | 'quiet' | 'below' }> {
  const nowMs = (options.now ?? new Date()).getTime();
  const threshold = sustainedErrorThreshold(options.env);
  const hours = await serverErrorsByHour(deps.redis, HOURS_READ, nowMs);
  const errors = hours.reduce((sum, n) => sum + n, 0);
  if (hours[0] === 0 && hours[1] === 0) {
    await resolveOpsPage(deps.prisma, SUSTAINED_ERROR_PAGE_TITLE, 'errors-stopped');
    return { errors, threshold, outcome: 'quiet' };
  }
  if (errors < threshold) return { errors, threshold, outcome: 'below' };
  // [REVIEW-G10 S4-4] A page that closed or was acknowledged inside the day still counts when its key is gone.
  // An open one is pageOps' own to answer.
  const pagedToday = await runAsSystem(OPS_PAGE_CAPABILITY, () => deps.prisma.opsAlert.findFirst({
    where: {
      kind: 'PLATFORM', title: SUSTAINED_ERROR_PAGE_TITLE, createdAt: { gt: new Date(nowMs - SUSTAINED_ERROR_PAGE_WINDOW_SECONDS * 1000) },
      OR: [{ closedAt: { not: null } }, { acknowledgedAt: { not: null } }],
    },
    select: { id: true },
  }));
  if (pagedToday) return { errors, threshold, outcome: 'deduped' };
  const page = await pageOps(deps, {
    key: SUSTAINED_ERROR_PAGE_KEY,
    windowSeconds: SUSTAINED_ERROR_PAGE_WINDOW_SECONDS,
    title: SUSTAINED_ERROR_PAGE_TITLE,
    body: `${errors} server errors in the last 24 to 25 hours: too few in any one minute for the spike page. Read the API logs for "Unhandled error": each line names the route and the error class.`,
    data: { kind: 'ops_error_sustained', errors },
  });
  return { errors, threshold, outcome: page.status };
}
