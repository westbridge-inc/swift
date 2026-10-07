import type { Prisma, PrismaClient, SubscriptionStatus } from '@prisma/client';
import { noLivePayPath } from './fee-pause';
import { log } from '../../utils/logger';
import { ACTIVE_CONFIRMATION_STATES, activeOverdueMs, currentDunningClock, projectDunningClock, resumeInstant } from './dunning-clock';

// ---------------------------------------------------------------------------
// [PROD-PATH] The fee pause of the shared dunning clock.
//
// While no partner has a live way to pay (fee-pause.ts: MMG switched off and
// no live card rail) no billing deadline may run for ANY partner, whatever
// their billing method. Every deadline the billing machine acts on — the
// 48-hour grace the operate gate enforces, the retry, the nudges and the
// churn — is a position on that subscription's BillingDunningClock
// (dunning-clock.ts), so the clock itself is PAUSED, exactly the way a payment
// confirmation pauses it: the elapsed overdue time is kept, no time accrues
// while paused, and the database's own clock rules (billing_clock_lineage)
// admit only that shape. Each tick of the MMG poll job (every 2 minutes):
//   paused: open the pause span (once, audited), then pause the running clock
//           of every subscription that is due, and remember which clocks
//           this pause holds (each audited);
//   live:   close the span: in ONE transaction record, for every subscription
//           due at that instant, that a way to pay came back (the owner's
//           current-week rule below) and remove the open span (audited);
//           then resume each clock this pause holds — unless something else
//           (a payment being confirmed, an authority hold) still holds it, in
//           which case that owner resumes it — and forget it (each audited).
// Billing waits while the span is open or the subscription's clock is still
// held (feePauseHoldsBilling), so whichever job runs first after a way to pay
// comes back, no fee is fixed before its reactivation is on record. The
// operate gate and the billing entry points also check noLivePayPath
// directly, so nothing is enforced in the moments before the first tick.
// ---------------------------------------------------------------------------

export const MMG_PAUSE_CLOCKS_KEY = 'billing.mmg_pause.clocks';
/** Present from the first tick that finds no live way to pay until the tick
 *  that has recorded every reactivation: { since } (ISO). */
export const FEE_PAUSE_OPEN_KEY = 'billing.mmg_pause.open';
/** Per subscription: the instant a way to pay came back for it (owner ruling, 5 Oct). */
export const MMG_REACTIVATED_PREFIX = 'billing.mmg_pause.reactivated:';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Include expired trials even when the conversion job is backlogged: their
 * original due date survives conversion, so they need the same pause and
 * reactivation record before billing can collect that obligation. */
const ENFORCED: SubscriptionStatus[] = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED'];
const dueWhere = (now: Date): Prisma.SubscriptionWhereInput => ({ autoRenew: true, status: { in: ENFORCED }, nextBillingDate: { lte: now } });

type Tx = Prisma.TransactionClient;
type ConfigReader = Pick<Tx, 'platformConfig'>;

// ---------------------------------------------------------------------------
// Owner ruling (5 Oct 2026), applied to every partner without a way to pay
// (6 Oct): when a way to pay comes back only the CURRENT week is billed. The
// weeks while it was missing — when Swift could not take payment — are not
// back-billed. The resume records, per subscription due at that instant, when
// it came back. The next settled weekly fee for that subscription is ONE fee
// whose period runs from the obligation's due date to the first weekly
// boundary after that instant (so it covers the off weeks and the week in
// progress). While the pause is still open (no resume recorded yet) a
// settlement that happens anyway — a real payment confirmed during the pause —
// is treated the same way, as of now. The record is consumed by the
// settlement whose period reaches past it; a period fixed before it (an
// intent reserved before the pause) pays its own week and leaves the record
// for the next fee. The obligation clock accepts exactly that shape: a paid
// period that starts at its due date and covers it (billing_obligation_proof).
// ---------------------------------------------------------------------------

function instant(value: unknown): Date | null {
  const at = typeof value === 'string' ? new Date(value) : null;
  return at && Number.isFinite(at.getTime()) ? at : null;
}

/** The period end one settled fee buys from `periodStart`: a week, or — the
 *  first fee after a way to pay came back — through the week in progress
 *  then. `reactivatedAt` is the instant used, when one applies. */
export async function mmgReactivationPeriodEnd(
  tx: ConfigReader, subscriptionId: string, periodStart: Date, now = new Date(),
): Promise<{ periodEnd: Date; reactivatedAt: Date | null }> {
  let periodEnd = new Date(periodStart.getTime() + WEEK_MS);
  // Keyed reads, one row each (the way every platform setting is read).
  const record = await tx.platformConfig.findUnique({ where: { key: `${MMG_REACTIVATED_PREFIX}${subscriptionId}` }, select: { value: true } });
  const recorded = instant(record?.value);
  const at = recorded ?? (await tx.platformConfig.findUnique({ where: { key: FEE_PAUSE_OPEN_KEY }, select: { value: true } }) ? now : null);
  if (!at) return { periodEnd, reactivatedAt: null };
  while (periodEnd.getTime() <= at.getTime()) periodEnd = new Date(periodEnd.getTime() + WEEK_MS);
  return { periodEnd, reactivatedAt: at };
}

/** The reactivation record is used once, by the settled fee whose period
 *  reaches past it. A period that ended before a way to pay came back (an
 *  intent fixed before the pause) is not that fee: the record stays. */
export async function consumeMmgReactivation(tx: Tx, subscriptionId: string, settledPeriodEnd: Date): Promise<void> {
  const key = `${MMG_REACTIVATED_PREFIX}${subscriptionId}`;
  const row = await tx.platformConfig.findUnique({ where: { key }, select: { value: true } });
  if (!row) return;
  const at = instant(row.value);
  if (at && settledPeriodEnd.getTime() <= at.getTime()) return;
  await tx.platformConfig.deleteMany({ where: { key } });
}

export interface MmgPauseTick { paused: boolean; pausedNow: number; resumedNow: number; reactivated: number; held: number }

async function heldClocks(tx: ConfigReader): Promise<string[]> {
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

function openSince(value: unknown): string | null {
  const since = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)['since'] : null;
  return typeof since === 'string' ? since : null;
}

/** The global pause also holds during a pending/failed resume, including
 * subscriptions whose individual clock has never been visited. */
export async function feePauseSpanOpen(db: ConfigReader, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  return noLivePayPath(env) || !!await db.platformConfig.findUnique({ where: { key: FEE_PAUSE_OPEN_KEY }, select: { value: true } });
}

/**
 * [S2] May billing for this subscription run now? Not while:
 *   - no partner has a live way to pay (fee-pause.ts);
 *   - a way to pay is back but the resume has not yet recorded the
 *     reactivations (the pause span is still open);
 *   - this subscription's clock is still held by the pause.
 * So whatever order the jobs run in after a way to pay comes back, no fee is
 * reserved or settled before its reactivation is on record.
 */
export async function feePauseHoldsBilling(
  db: Pick<Tx, 'platformConfig' | 'billingDunningClock'>,
  subscriptionId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (await feePauseSpanOpen(db, env)) return true;
  const held = (await db.platformConfig.findUnique({ where: { key: MMG_PAUSE_CLOCKS_KEY }, select: { value: true } }))?.value;
  if (!Array.isArray(held) || held.length === 0) return false;
  const clock = await db.billingDunningClock.findUnique({ where: { subscriptionId }, select: { id: true } });
  return !!clock && (held as unknown[]).includes(clock.id);
}

// Ticks serialise on this lock (taken first, before any payer or clock lock),
// so two workers never pause or resume the same clock twice.
const tickLock = (tx: Tx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('swift:mmg-pause-clock'))`;

export async function syncMmgPauseClock(
  prisma: PrismaClient,
  now = new Date(),
  env: Record<string, string | undefined> = process.env,
  /** Test seam: a pause at a named boundary of a tick ('after-read' holds a
   *  clock pause after its read; 'before-reactivate' interrupts the recording
   *  of the reactivations; 'before-resume' interrupts one clock's resume). */
  failpoint?: (boundary: string) => Promise<void>,
): Promise<MmgPauseTick> {
  let pausedNow = 0;
  let resumedNow = 0;
  let reactivated = 0;
  const paused = noLivePayPath(env);
  if (paused) {
    const opened = await prisma.$transaction(async (tx) => {
      await tickLock(tx);
      if (await tx.platformConfig.findUnique({ where: { key: FEE_PAUSE_OPEN_KEY }, select: { id: true } })) return false;
      await tx.platformConfig.create({ data: { key: FEE_PAUSE_OPEN_KEY, value: { since: now.toISOString() } } });
      await tx.auditLog.create({ data: {
        action: 'BILLING_FEE_PAUSE_STARTED', entity: 'PlatformConfig', entityId: FEE_PAUSE_OPEN_KEY,
        changes: { since: now.toISOString(), reason: 'NO_LIVE_PAY_PATH', mmg: 'off', card: 'off' },
      } });
      return true;
    });
    if (opened) log().warn({ since: now.toISOString() }, '[PROD-PATH] fee pause STARTED: MMG is off and no card rail is live, so no partner can pay; every weekly fee is paused (no charge, no dunning, no suspension, no churn)');
  }
  // The persisted start is authoritative even if a tick/clock transaction
  // failed. Repair every due clock BEFORE closing the span, including clocks
  // that fell due after the last pause tick. Separate transactions bound the
  // work per clock; the final locked census refuses any unvisited newcomer.
  const span = await prisma.platformConfig.findUnique({ where: { key: FEE_PAUSE_OPEN_KEY }, select: { value: true } });
  const since = span ? instant(openSince(span.value)) : null;
  const repaired = new Set<string>();
  if (span && !since) throw new Error('Invalid fee pause start; billing remains held');
  if (since) {
    const due = await prisma.subscription.findMany({ where: dueWhere(now), select: { id: true } });
    for (const { id } of due) {
      try {
        pausedNow += await prisma.$transaction(async (tx) => {
          await tickLock(tx);
          const current = await tx.platformConfig.findUnique({ where: { key: FEE_PAUSE_OPEN_KEY }, select: { value: true } });
          if (!current || openSince(current.value) !== since.toISOString()) throw new Error('Fee pause span changed; retry the tick');
          // Canonical payer -> subscription -> clock locks. Use the ORIGINAL
          // pause time, never the retry/resume time, so retries consume no grace.
          const clock = await currentDunningClock(tx, id, since);
          await failpoint?.('after-read');
          if (clock.pausedAt) return 0; // an existing pause/confirmation owns it
          const overdueMs = activeOverdueMs(clock, since);
          const pausedClock = await tx.billingDunningClock.update({ where: { id: clock.id }, data: {
            elapsedMs: BigInt(overdueMs), runningSince: null, pausedAt: since, version: { increment: 1 },
          } });
          await projectDunningClock(tx, pausedClock, now);
          await writeHeld(tx, [...await heldClocks(tx), clock.id]);
          await tx.auditLog.create({ data: {
            action: 'BILLING_FEE_PAUSED', entity: 'Subscription', entityId: id,
            changes: { clockId: clock.id, reason: 'NO_LIVE_PAY_PATH', overdueMs, at: since.toISOString() },
          } });
          return 1;
        });
        repaired.add(id);
      } catch (err) {
        log().error({ err, subscriptionId: id }, '[PROD-PATH] fee pause: clock pause failed; the open span holds billing until a tick repairs it from the original pause time');
      }
    }
  }
  if (!paused) {
    let stillOpen = false;
    try {
      reactivated = await prisma.$transaction(async (tx) => {
        await tickLock(tx);
        const open = await tx.platformConfig.findUnique({ where: { key: FEE_PAUSE_OPEN_KEY }, select: { value: true } });
        if (!open) return 0;
        await failpoint?.('before-reactivate');
        // A way to pay is back for every subscription due now: its next fee
        // covers only the week in progress. A record left by an earlier pause
        // is replaced, so the latest return is the one that counts.
        const due = await tx.subscription.findMany({ where: dueWhere(now), select: { id: true } });
        if (openSince(open.value) !== since?.toISOString() || due.some(({ id }) => !repaired.has(id))) {
          throw new Error('Fee pause clocks still need repair; keep the span open');
        }
        const keys = due.map(({ id }) => `${MMG_REACTIVATED_PREFIX}${id}`);
        if (keys.length > 0) {
          await tx.platformConfig.deleteMany({ where: { key: { in: keys } } });
          await tx.platformConfig.createMany({ data: keys.map((key) => ({ key, value: now.toISOString() })) });
        }
        await tx.platformConfig.delete({ where: { key: FEE_PAUSE_OPEN_KEY } });
        await tx.auditLog.create({ data: {
          action: 'BILLING_FEE_PAUSE_ENDED', entity: 'PlatformConfig', entityId: FEE_PAUSE_OPEN_KEY,
          changes: { since: openSince(open.value), until: now.toISOString(), reactivated: keys.length },
        } });
        return keys.length;
      });
      if (reactivated > 0) log().warn({ reactivated, at: now.toISOString() }, '[PROD-PATH] fee pause ENDED: a way to pay is live again; each paused partner\'s next fee covers only the week in progress');
    } catch (err) {
      stillOpen = true;
      log().error({ err }, '[PROD-PATH] fee pause: a way to pay is back but the reactivations could not be recorded; billing keeps waiting and the next tick retries');
    }
    // Clocks resume only once every reactivation is on record.
    const held = stillOpen ? [] : await prisma.$transaction(async (tx) => heldClocks(tx));
    for (const clockId of held) {
      try {
        resumedNow += await prisma.$transaction(async (tx) => {
          await tickLock(tx);
          const row = await tx.billingDunningClock.findUnique({ where: { id: clockId }, select: { subscriptionId: true } });
          const forget = async () => writeHeld(tx, (await heldClocks(tx)).filter((c) => c !== clockId));
          if (!row) { await forget(); return 0; }
          const clock = await currentDunningClock(tx, row.subscriptionId, now);
          if (clock.id !== clockId || !clock.pausedAt) { await forget(); return 0; }
          const otherHold = clock.authorityHoldReason
            || await tx.paymentConfirmationHold.count({ where: { clockId: clock.id, status: { in: ACTIVE_CONFIRMATION_STATES } } });
          if (otherHold) { await forget(); return 0; } // its owner resumes it
          await failpoint?.('before-resume');
          const resumed = resumeInstant(clock, now);
          const running = await tx.billingDunningClock.update({ where: { id: clock.id }, data: {
            pausedAt: null, runningSince: new Date(Math.max(resumed.getTime(), clock.dueAt.getTime())), resumedAt: resumed, version: { increment: 1 },
          } });
          await projectDunningClock(tx, running, now);
          await forget();
          await tx.auditLog.create({ data: {
            action: 'BILLING_FEE_RESUMED', entity: 'Subscription', entityId: row.subscriptionId,
            changes: { clockId, at: now.toISOString() },
          } });
          return 1;
        });
      } catch (err) {
        log().error({ err, clockId }, '[PROD-PATH] fee pause: a way to pay is back but a billing clock the pause held could not be resumed; it stays paused, its billing waits, and the next tick retries');
      }
    }
  }
  const held = await prisma.$transaction(async (tx) => heldClocks(tx));
  if (pausedNow + resumedNow > 0) {
    log().info({ pausedNow, resumedNow, held: held.length }, '[PROD-PATH] fee pause: billing clocks paused/resumed');
  }
  return { paused, pausedNow, resumedNow, reactivated, held: held.length };
}

export interface FeePauseStatus {
  /** No partner has a live way to pay right now: every weekly fee is paused. */
  paused: boolean;
  reason: 'NO_LIVE_PAY_PATH' | null;
  /** When the current (or not yet closed) pause began. */
  since: string | null;
  /** A way to pay is back but the resume has not run yet: billing still waits. */
  resumePending: boolean;
  /** Fees whose clock this pause holds. */
  pausedSubscriptions: number;
  /** Fees due now that are not being collected because of the pause. */
  dueNotCollected: number;
}

/** What an admin sees about the pause. `scope` narrows the counts to the
 *  caller's tenant; the pause itself is the server's, the same for all. */
export async function feePauseStatus(
  prisma: PrismaClient,
  scope: Prisma.SubscriptionWhereInput = {},
  now = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<FeePauseStatus> {
  const paused = noLivePayPath(env);
  const [open, held] = await Promise.all([
    prisma.platformConfig.findUnique({ where: { key: FEE_PAUSE_OPEN_KEY }, select: { value: true } }),
    heldClocks(prisma),
  ]);
  const holding = paused || !!open;
  const [pausedSubscriptions, dueNotCollected] = await Promise.all([
    held.length === 0 ? 0 : prisma.billingDunningClock.count({ where: { id: { in: held }, pausedAt: { not: null }, subscription: scope } }),
    holding ? prisma.subscription.count({ where: { AND: [dueWhere(now), scope] } }) : 0,
  ]);
  return {
    paused,
    reason: paused ? 'NO_LIVE_PAY_PATH' : null,
    since: open ? openSince(open.value) : null,
    resumePending: !paused && !!open,
    pausedSubscriptions,
    dueNotCollected,
  };
}
