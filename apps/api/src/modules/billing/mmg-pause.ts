import type { Prisma, PrismaClient } from '@prisma/client';
import { mmgDisabled } from '../../providers/mmg/mmg-provider';
import { log } from '../../utils/logger';
import { ACTIVE_CONFIRMATION_STATES, activeOverdueMs, currentDunningClock, projectDunningClock, resumeInstant } from './dunning-clock';

// ---------------------------------------------------------------------------
// [PROD-PATH] The MMG-off pause of the shared dunning clock.
//
// While MMG_DRIVER=disabled a partner on the MMG rail cannot pay, so no
// billing deadline of theirs may run. Every deadline the billing machine acts
// on — the 48-hour grace the operate gate enforces, the retry, the nudges and
// the churn — is a position on that subscription's BillingDunningClock
// (dunning-clock.ts), so the clock itself is PAUSED, exactly the way a payment
// confirmation pauses it: the elapsed overdue time is kept, no time accrues
// while paused, and the database's own clock rules (billing_clock_lineage)
// admit only that shape. Each tick of the MMG poll job (every 2 minutes):
//   MMG off: pause the running clock of every MMG-rail subscription that is
//            due, and remember which clocks this pause holds;
//   MMG on:  resume each clock this pause holds — unless something else (a
//            payment being confirmed, an authority hold) still holds it, in
//            which case that owner resumes it — and forget it.
// So when MMG is switched on, every MMG-rail partner has exactly the grace
// they had left when it went off. The operate gate and the billing entry
// points also check mmgRailPaused directly, so nothing is enforced in the
// moments before the first tick.
// ---------------------------------------------------------------------------

export const MMG_PAUSE_CLOCKS_KEY = 'billing.mmg_pause.clocks';
/** Per subscription: the instant MMG came back for it (owner ruling, 5 Oct). */
export const MMG_REACTIVATED_PREFIX = 'billing.mmg_pause.reactivated:';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Owner ruling (5 Oct 2026): on MMG reactivation only the CURRENT week is
// billed. The weeks while MMG was off — when Swift could not take payment —
// are not back-billed. When the pause releases a clock it records, per
// subscription, the instant MMG came back. The next settled weekly fee for
// that subscription is ONE fee whose period runs from the obligation's due
// date to the first weekly boundary after that instant (so it covers the
// off weeks and the week in progress), and the record is consumed in the
// same transaction. The obligation clock accepts exactly that shape: a paid
// period that starts at its due date and covers it (billing_obligation_proof).
// ---------------------------------------------------------------------------

/** The period end one settled fee buys: a week, or — the first time after an
 *  MMG reactivation — through the week in progress at reactivation. */
export async function mmgReactivationPeriodEnd(tx: Tx, subscriptionId: string, periodStart: Date): Promise<{ periodEnd: Date; reactivated: boolean }> {
  let periodEnd = new Date(periodStart.getTime() + WEEK_MS);
  const row = await tx.platformConfig.findUnique({ where: { key: `${MMG_REACTIVATED_PREFIX}${subscriptionId}` }, select: { value: true } });
  const at = typeof row?.value === 'string' ? new Date(row.value) : null;
  if (!at || !Number.isFinite(at.getTime())) return { periodEnd, reactivated: false };
  while (periodEnd.getTime() <= at.getTime()) periodEnd = new Date(periodEnd.getTime() + WEEK_MS);
  return { periodEnd, reactivated: true };
}

/** The reactivation record is used once, by the fee that settled with it. */
export async function consumeMmgReactivation(tx: Tx, subscriptionId: string): Promise<void> {
  await tx.platformConfig.deleteMany({ where: { key: `${MMG_REACTIVATED_PREFIX}${subscriptionId}` } });
}

async function recordReactivation(tx: Tx, subscriptionId: string, now: Date): Promise<void> {
  const key = `${MMG_REACTIVATED_PREFIX}${subscriptionId}`;
  await tx.platformConfig.upsert({ where: { key }, update: { value: now.toISOString() }, create: { key, value: now.toISOString() } });
}

export interface MmgPauseTick { paused: boolean; pausedNow: number; resumedNow: number; held: number }

type Tx = Prisma.TransactionClient;

async function heldClocks(tx: Tx): Promise<string[]> {
  const row = await tx.platformConfig.findUnique({ where: { key: MMG_PAUSE_CLOCKS_KEY }, select: { value: true } });
  return Array.isArray(row?.value) ? (row!.value as unknown[]).filter((v): v is string => typeof v === 'string') : [];
}

async function writeHeld(tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    await tx.platformConfig.deleteMany({ where: { key: MMG_PAUSE_CLOCKS_KEY } });
    return;
  }
  const value = [...new Set(ids)].sort();
  await tx.platformConfig.upsert({ where: { key: MMG_PAUSE_CLOCKS_KEY }, update: { value }, create: { key: MMG_PAUSE_CLOCKS_KEY, value } });
}

// Ticks serialise on this lock (taken first, before any payer or clock lock),
// so two workers never pause or resume the same clock twice.
const tickLock = (tx: Tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('swift:mmg-pause-clock'))`;

export async function syncMmgPauseClock(
  prisma: PrismaClient,
  now = new Date(),
  env: Record<string, string | undefined> = process.env,
  /** Test seam: a pause after the clock is read inside a tick (the race proof holds one tick here). */
  failpoint?: (boundary: string) => Promise<void>,
): Promise<MmgPauseTick> {
  let pausedNow = 0;
  let resumedNow = 0;
  if (mmgDisabled(env)) {
    const due = await prisma.subscription.findMany({
      where: { billingMethod: 'MOBILE_MONEY', autoRenew: true, status: { in: ['ACTIVE', 'PAST_DUE', 'SUSPENDED'] }, nextBillingDate: { lte: now } },
      select: { id: true },
    });
    for (const { id } of due) {
      try {
        pausedNow += await prisma.$transaction(async (tx) => {
          await tickLock(tx);
          // The canonical accessor: payer -> subscription -> clock locks, the
          // clock created from the subscription when it has none yet.
          const clock = await currentDunningClock(tx, id, now);
          await failpoint?.('after-read');
          if (clock.pausedAt) return 0; // already paused, by this pause or by a confirmation
          const paused = await tx.billingDunningClock.update({ where: { id: clock.id }, data: {
            elapsedMs: BigInt(activeOverdueMs(clock, now)), runningSince: null, pausedAt: now, version: { increment: 1 },
          } });
          await projectDunningClock(tx, paused, now);
          await writeHeld(tx, [...await heldClocks(tx), clock.id]);
          return 1;
        });
      } catch (err) {
        log().error({ err, subscriptionId: id }, '[PROD-PATH] MMG is off: could not pause this MMG-rail billing clock; the billing entry points still refuse to enforce');
      }
    }
  } else {
    const held = await prisma.$transaction(async (tx) => heldClocks(tx));
    for (const clockId of held) {
      try {
        resumedNow += await prisma.$transaction(async (tx) => {
          await tickLock(tx);
          const row = await tx.billingDunningClock.findUnique({ where: { id: clockId }, select: { subscriptionId: true } });
          const forget = async () => writeHeld(tx, (await heldClocks(tx)).filter((c) => c !== clockId));
          if (!row) { await forget(); return 0; }
          // Whatever happens to the clock below, MMG is back for this
          // subscription now: its next fee covers only the current week.
          await recordReactivation(tx, row.subscriptionId, now);
          const clock = await currentDunningClock(tx, row.subscriptionId, now);
          if (clock.id !== clockId || !clock.pausedAt) { await forget(); return 0; }
          const otherHold = clock.authorityHoldReason
            || await tx.paymentConfirmationHold.count({ where: { clockId: clock.id, status: { in: ACTIVE_CONFIRMATION_STATES } } });
          if (otherHold) { await forget(); return 0; } // its owner resumes it
          const resumed = resumeInstant(clock, now);
          const running = await tx.billingDunningClock.update({ where: { id: clock.id }, data: {
            pausedAt: null, runningSince: new Date(Math.max(resumed.getTime(), clock.dueAt.getTime())), resumedAt: resumed, version: { increment: 1 },
          } });
          await projectDunningClock(tx, running, now);
          await forget();
          return 1;
        });
      } catch (err) {
        log().error({ err, clockId }, '[PROD-PATH] MMG is on again: could not resume a billing clock the MMG-off pause held; it stays paused and is retried next tick');
      }
    }
  }
  const held = await prisma.$transaction(async (tx) => heldClocks(tx));
  if (pausedNow + resumedNow > 0) {
    log().info({ pausedNow, resumedNow, held: held.length }, '[PROD-PATH] MMG-off pause: billing clocks of MMG-rail partners paused/resumed');
  }
  return { paused: mmgDisabled(env), pausedNow, resumedNow, held: held.length };
}
