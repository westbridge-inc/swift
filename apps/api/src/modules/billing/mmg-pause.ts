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
//           of every subscription that is due FROM THE SPAN'S START, and
//           remember which clocks this pause holds (each audited). A clock
//           pause that fails is retried by every later tick, still from the
//           span's start, so no paused minute ever counts toward grace;
//   live:   the same pass first (a clock a failed tick left running is paused
//           from the span's start), then close the span: in ONE transaction
//           record, for every subscription due at that instant, that a way to
//           pay came back (the owner's current-week rule below), give each due
//           fee whose clock still could not be paused its own repair record
//           (the span's start), and remove the open span (audited); then
//           resume each clock this pause holds — unless something else (a
//           payment being confirmed, an authority hold) still holds it, in
//           which case that owner resumes it — and forget it (each audited).
//   A fee with a repair record waits ALONE: every later tick, whatever the
//   switches say, pauses its clock from the recorded start (then the resume
//   releases it like any other); one clock that cannot be paused never holds
//   any other partner's billing.
// Billing waits while the span is open, the subscription has a repair record,
// or its clock is still held (feePauseHoldsBilling), so whichever job runs
// first after a way to pay comes back, no fee is fixed before its
// reactivation is on record and its paused time is off its clock. The
// operate gate and the billing entry points also check noLivePayPath
// directly, so nothing is enforced in the moments before the first tick.
// ---------------------------------------------------------------------------

export const MMG_PAUSE_CLOCKS_KEY = 'billing.mmg_pause.clocks';
/** Present from the first tick that finds no live way to pay until the tick
 *  that has recorded every reactivation: { since } (ISO). */
export const FEE_PAUSE_OPEN_KEY = 'billing.mmg_pause.open';
/** Per subscription: the instant a way to pay came back for it (owner ruling, 5 Oct). */
export const MMG_REACTIVATED_PREFIX = 'billing.mmg_pause.reactivated:';
/** Per subscription: a fee due when a pause ended whose clock could not yet be
 *  paused from the pause's start: { since } (ISO), that start. Its billing
 *  waits until a tick pauses its clock from there (see the header). */
export const FEE_PAUSE_REPAIR_PREFIX = 'billing.mmg_pause.repair:';
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
 *   - its clock still has to be paused from a pause's start (repair record);
 *   - this subscription's clock is still held by the pause.
 * So whatever order the jobs run in after a way to pay comes back, no fee is
 * reserved or settled before its reactivation is on record, and no paused
 * minute counts toward its grace.
 */
export async function feePauseHoldsBilling(
  db: Pick<Tx, 'platformConfig' | 'billingDunningClock'>,
  subscriptionId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  if (await feePauseSpanOpen(db, env)) return true;
  if (await db.platformConfig.findUnique({ where: { key: `${FEE_PAUSE_REPAIR_PREFIX}${subscriptionId}` }, select: { value: true } })) return true;
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
   *  clock pause after its read, and names the subscription; 'before-reactivate'
   *  interrupts the recording of the reactivations; 'before-resume' interrupts
   *  one clock's resume). */
  failpoint?: (boundary: string, subscriptionId?: string) => Promise<void>,
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
  // Pause, FROM THE PAUSE'S OWN START, every clock the pause must hold. The
  // persisted start is authoritative, so a tick or clock transaction that
  // failed earlier costs no grace: while a span is open, every due fee
  // (including one that fell due after the last tick) from the span's start;
  // and, whatever the switches say, every fee a closed span left for repair,
  // from the start recorded with it (the earlier start, when both apply).
  // One transaction per clock bounds the work and the failure.
  const span = await prisma.platformConfig.findUnique({ where: { key: FEE_PAUSE_OPEN_KEY }, select: { value: true } });
  const since = span ? instant(openSince(span.value)) : null;
  if (span && !since) throw new Error('Invalid fee pause start; billing remains held');
  const targets = new Map<string, { at: Date; repair: boolean }>();
  if (since) {
    for (const { id } of await prisma.subscription.findMany({ where: dueWhere(now), select: { id: true } })) targets.set(id, { at: since, repair: false });
  }
  for (const row of await prisma.platformConfig.findMany({ where: { key: { startsWith: FEE_PAUSE_REPAIR_PREFIX } }, select: { key: true, value: true } })) {
    const id = row.key.slice(FEE_PAUSE_REPAIR_PREFIX.length);
    const at = instant(openSince(row.value));
    if (at) targets.set(id, { at, repair: true });
    else log().error({ subscriptionId: id }, '[PROD-PATH] fee pause: unreadable repair record; this fee stays held until a person repairs it');
  }
  const repaired = new Set<string>();
  for (const [id, { at, repair }] of targets) {
    try {
      pausedNow += await prisma.$transaction(async (tx) => {
        await tickLock(tx);
        // Under the tick lock, the record this pause works from is still the same one.
        const key = repair ? `${FEE_PAUSE_REPAIR_PREFIX}${id}` : FEE_PAUSE_OPEN_KEY;
        const current = await tx.platformConfig.findUnique({ where: { key }, select: { value: true } });
        if (!current || openSince(current.value) !== at.toISOString()) throw new Error('Fee pause record changed; the next tick retries');
        // Canonical payer -> subscription -> clock locks, as of the pause's
        // start: a retry or a resume never consumes the paused time.
        const clock = await currentDunningClock(tx, id, at);
        await failpoint?.('after-read', id);
        let pausedOne = 0;
        if (!clock.pausedAt) { // else an existing pause (this one, or a payment being confirmed) owns it
          const overdueMs = activeOverdueMs(clock, at);
          const pausedClock = await tx.billingDunningClock.update({ where: { id: clock.id }, data: {
            elapsedMs: BigInt(overdueMs), runningSince: null, pausedAt: at, version: { increment: 1 },
          } });
          await projectDunningClock(tx, pausedClock, now);
          await writeHeld(tx, [...await heldClocks(tx), clock.id]);
          await tx.auditLog.create({ data: {
            action: 'BILLING_FEE_PAUSED', entity: 'Subscription', entityId: id,
            changes: { clockId: clock.id, reason: 'NO_LIVE_PAY_PATH', overdueMs, at: at.toISOString(), ...(repair ? { repaired: true } : {}) },
          } });
          pausedOne = 1;
        }
        if (repair) await tx.platformConfig.delete({ where: { key } });
        return pausedOne;
      });
      repaired.add(id);
    } catch (err) {
      log().error({ err, subscriptionId: id }, '[PROD-PATH] fee pause: could not pause this billing clock from the pause start; its billing stays held and the next tick retries');
    }
  }
  if (!paused) {
    let stillOpen = false;
    let awaitingRepair = 0;
    try {
      reactivated = await prisma.$transaction(async (tx) => {
        await tickLock(tx);
        const open = await tx.platformConfig.findUnique({ where: { key: FEE_PAUSE_OPEN_KEY }, select: { value: true } });
        if (!open) return 0;
        await failpoint?.('before-reactivate');
        // Only the span this tick paused from may be closed by it.
        if (!since || openSince(open.value) !== since.toISOString()) throw new Error('Fee pause span changed; the next tick retries');
        // A way to pay is back for every subscription due now: its next fee
        // covers only the week in progress. A record left by an earlier pause
        // is replaced, so the latest return is the one that counts.
        const due = await tx.subscription.findMany({ where: dueWhere(now), select: { id: true } });
        const keys = due.map(({ id }) => `${MMG_REACTIVATED_PREFIX}${id}`);
        if (keys.length > 0) {
          await tx.platformConfig.deleteMany({ where: { key: { in: keys } } });
          await tx.platformConfig.createMany({ data: keys.map((key) => ({ key, value: now.toISOString() })) });
        }
        // A due fee whose clock this tick could not pause from the span's
        // start waits ALONE, on its own repair record naming that start (an
        // earlier record keeps its earlier start): nobody else's billing
        // waits on it.
        const unrepaired = due.filter(({ id }) => !repaired.has(id));
        if (unrepaired.length > 0) {
          await tx.platformConfig.createMany({
            data: unrepaired.map(({ id }) => ({ key: `${FEE_PAUSE_REPAIR_PREFIX}${id}`, value: { since: since.toISOString() } })),
            skipDuplicates: true,
          });
        }
        awaitingRepair = unrepaired.length;
        await tx.platformConfig.delete({ where: { key: FEE_PAUSE_OPEN_KEY } });
        await tx.auditLog.create({ data: {
          action: 'BILLING_FEE_PAUSE_ENDED', entity: 'PlatformConfig', entityId: FEE_PAUSE_OPEN_KEY,
          changes: { since: openSince(open.value), until: now.toISOString(), reactivated: keys.length, awaitingRepair },
        } });
        return keys.length;
      });
      if (reactivated > 0) log().warn({ reactivated, at: now.toISOString() }, '[PROD-PATH] fee pause ENDED: a way to pay is live again; each paused partner\'s next fee covers only the week in progress');
      if (awaitingRepair > 0) log().error({ awaitingRepair }, '[PROD-PATH] fee pause ENDED with fees whose clock could not be paused yet: each waits alone (no billing for it) and every tick retries; one that stays needs a person');
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
  /** Fees whose clock could not yet be paused from a pause's start: each
   *  waits alone (no billing for it) while every tick retries. One that stays
   *  needs a person. */
  awaitingRepair: number;
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
  const [open, held, repairs] = await Promise.all([
    prisma.platformConfig.findUnique({ where: { key: FEE_PAUSE_OPEN_KEY }, select: { value: true } }),
    heldClocks(prisma),
    prisma.platformConfig.findMany({ where: { key: { startsWith: FEE_PAUSE_REPAIR_PREFIX } }, select: { key: true } }),
  ]);
  const holding = paused || !!open;
  const repairIds = repairs.map((r) => r.key.slice(FEE_PAUSE_REPAIR_PREFIX.length));
  const [pausedSubscriptions, dueNotCollected, awaitingRepair] = await Promise.all([
    held.length === 0 ? 0 : prisma.billingDunningClock.count({ where: { id: { in: held }, pausedAt: { not: null }, subscription: scope } }),
    holding ? prisma.subscription.count({ where: { AND: [dueWhere(now), scope] } }) : 0,
    repairIds.length === 0 ? 0 : prisma.subscription.count({ where: { AND: [{ id: { in: repairIds } }, scope] } }),
  ]);
  return {
    paused,
    reason: paused ? 'NO_LIVE_PAY_PATH' : null,
    since: open ? openSince(open.value) : null,
    resumePending: !paused && !!open,
    pausedSubscriptions,
    dueNotCollected,
    awaitingRepair,
  };
}
