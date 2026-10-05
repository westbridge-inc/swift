import type { PrismaClient } from '@prisma/client';
import { mmgDisabled } from '../../providers/mmg/mmg-provider';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// [PROD-PATH] The MMG-off pause clock. While MMG_DRIVER=disabled, a partner on
// the MMG rail cannot pay, so no billing deadline of theirs may run: each tick
// of the MMG poll job (every 2 minutes) moves forward, by the time elapsed
// since the previous tick, every deadline the billing machine would act on —
//   PAST_DUE:  gracePeriodEnd and nextRetryAt (the operate gate's deadline and
//              the next collection attempt);
//   SUSPENDED: suspendedAt (the churn clock) and nextRetryAt.
// When MMG is switched on again the clock row is removed and every deadline
// keeps exactly the time it had left when MMG went off (to within one tick).
// The operate gate also treats a paused PAST_DUE partner as inside grace
// (operate-gate.ts), so a missed tick can never lock anyone out.
//
// Ticks serialise on an advisory lock and each moves only the elapsed span
// since the stored tick, so two workers ticking at once move nothing twice.
// ---------------------------------------------------------------------------

export const MMG_PAUSE_CLOCK_KEY = 'billing.mmg_pause.clock_at';

export interface MmgPauseTick { paused: boolean; movedMs: number; pastDueMoved: number; suspendedMoved: number }

export async function syncMmgPauseClock(
  prisma: PrismaClient,
  now = new Date(),
  env: Record<string, string | undefined> = process.env,
  /** Test seam: a pause after the stored tick is read (the race proof holds one tick here). */
  failpoint?: (boundary: string) => Promise<void>,
): Promise<MmgPauseTick> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('swift:mmg-pause-clock'))`;
    const row = await tx.platformConfig.findUnique({ where: { key: MMG_PAUSE_CLOCK_KEY }, select: { value: true } });
    if (!mmgDisabled(env)) {
      if (row) await tx.platformConfig.delete({ where: { key: MMG_PAUSE_CLOCK_KEY } });
      return { paused: false, movedMs: 0, pastDueMoved: 0, suspendedMoved: 0 };
    }
    const last = typeof row?.value === 'string' ? new Date(row.value) : null;
    await failpoint?.('after-read');
    const movedMs = last && Number.isFinite(last.getTime()) ? now.getTime() - last.getTime() : 0;
    let pastDueMoved = 0;
    let suspendedMoved = 0;
    if (movedMs > 0) {
      const seconds = movedMs / 1000;
      pastDueMoved = await tx.$executeRaw`
        UPDATE "subscriptions"
           SET "gracePeriodEnd" = "gracePeriodEnd" + make_interval(secs => ${seconds}::double precision),
               "nextRetryAt" = "nextRetryAt" + make_interval(secs => ${seconds}::double precision)
         WHERE "status" = 'PAST_DUE' AND "billingMethod" = 'MOBILE_MONEY' AND "gracePeriodEnd" IS NOT NULL`;
      suspendedMoved = await tx.$executeRaw`
        UPDATE "subscriptions"
           SET "suspendedAt" = COALESCE("suspendedAt", "updatedAt") + make_interval(secs => ${seconds}::double precision),
               "nextRetryAt" = "nextRetryAt" + make_interval(secs => ${seconds}::double precision)
         WHERE "status" = 'SUSPENDED' AND "billingMethod" = 'MOBILE_MONEY'`;
    }
    // Never move the stored tick backwards (a skewed clock moves nothing).
    if (movedMs > 0 || !last || !Number.isFinite(last.getTime())) {
      await tx.platformConfig.upsert({
        where: { key: MMG_PAUSE_CLOCK_KEY },
        update: { value: now.toISOString() },
        create: { key: MMG_PAUSE_CLOCK_KEY, value: now.toISOString() },
      });
    }
    if (pastDueMoved + suspendedMoved > 0) {
      log().info({ movedMs, pastDueMoved, suspendedMoved }, '[PROD-PATH] MMG is off: billing deadlines of MMG-rail partners held for the span');
    }
    return { paused: true, movedMs: Math.max(0, movedMs), pastDueMoved, suspendedMoved };
  });
}
