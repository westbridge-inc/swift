import type { PrismaClient, GuardianCheckinLevel, GuardianCheckinRecipient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { NotificationService } from '../notification/notification.service';
import { log } from '../../utils/logger';
import { guardianDeliveryCounter, guardianDeliveryGauge } from '../../plugins/observability';

/**
 * [S-06] Guardian L2/L3 state commits before notification delivery.
 *
 * Stop-ship register S-06: L2 changed the session and THEN awaited the
 * passenger's push; L3 moved to CHECKIN_PENDING and THEN sent both prompts.
 * A send that failed after the state change left a session whose status
 * suppressed any resend, while the deadline kept running — an escalation
 * nobody was asked about, or a soft check that silently stalled.
 *
 * Now every ask is a DELIVERY ROW staged in the same transaction as the
 * ladder's status change — one per (cycle, level, recipient). A leased
 * worker delivers each row once and retries with backoff on the database
 * clock; exhausted attempts FAIL the row. The ladder reads delivery state
 * before a deadline may run: SENT runs the policy; PENDING holds the deadline
 * and pages ops; FAILED is an explicit no-delivery policy. The hard deadline
 * is measured from the DELIVERY of the hard prompt, never from the ask.
 */
export function checkinDeliveryKilled(env: Record<string, string | undefined> = process.env): boolean {
  return env['GUARDIAN_CHECKIN_DELIVERY_KILL'] === '1';
}

export interface CheckinDeliveryObserver {
  /** Test seam: runs inside the worker before a claimed row is delivered. Never set in routes. */
  beforeDeliver?: (row: { sessionId: string; cycleId: string; level: GuardianCheckinLevel; recipient: GuardianCheckinRecipient; attempts: number }) => Promise<void>;
}

export type CheckinPayload = {
  title: string; body: string; data: Record<string, unknown>;
  /** [WEB-TAXI] Passenger asks only: the secret of this ask's one-time answer
   *  link (the cycle keeps only its hash). It travels ONLY in the text message
   *  — never in the push, the inbox row or a socket — and leaves the delivery
   *  row once the row is done, like the driver's nonce. */
  answerToken?: string;
};

/** The passenger's ask — one text for the ladder and the backfill. */
export function passengerAsk(session: { id: string; orderId: string }, cycleId: string, level: GuardianCheckinLevel, respondBy: Date | null, answerToken?: string): CheckinPayload {
  const ask: CheckinPayload = level === 'SOFT'
    ? { title: 'Safety check-in', body: 'Everything OK on your trip? Open Swift to respond.', data: { kind: 'guardian_checkin', level: 'SOFT', sessionId: session.id, orderId: session.orderId, cycleId } }
    : { title: 'Safety check-in — please respond', body: 'Please confirm you are OK in the app.', data: { kind: 'guardian_checkin', level: 'HARD', sessionId: session.id, orderId: session.orderId, cycleId, respondBy: respondBy?.toISOString() ?? null } };
  return answerToken ? { ...ask, answerToken } : ask;
}

/**
 * [WEB-TAXI · owner 21 Oct 2026] The passenger's ask as a TEXT MESSAGE, for a
 * passenger no push reached — a rider who booked on the website has no app to
 * push to, and a phone whose push is off or gone is in the same place. One
 * GSM-7 part: no name, no place, nothing about the trip but the link.
 *
 * The link answers the check-in without signing in (a sign-in code would eat
 * the whole deadline): `/safety-check#<session>.<secret>`, the secret after
 * the `#` so it never reaches a server log. An ask with no secret (the
 * backfill) links to the ride's own page instead.
 */
export function passengerCheckinSms(payload: CheckinPayload, level: GuardianCheckinLevel, base = process.env['APP_PUBLIC_URL'] ?? 'https://swiftgy.com'): string {
  const origin = base.replace(/\/+$/, '');
  const sessionId = String(payload.data['sessionId'] ?? '');
  const orderId = String(payload.data['orderId'] ?? '');
  const link = payload.answerToken && sessionId
    ? `${origin}/safety-check#${sessionId}.${payload.answerToken}`
    : `${origin}/orders/${encodeURIComponent(orderId)}`;
  return level === 'HARD'
    ? `Swift safety check on your ride. Please answer now: ${link} In danger? Call 911.`
    : `Swift safety check: is everything OK on your ride? Answer here: ${link} In danger? Call 911.`;
}

/** [WEB-TAXI] Neither a push nor a text reached the passenger. Retried a few
 *  times, then the row FAILS, so the ladder's explicit no-delivery policy runs
 *  on the phone's own timetable instead of waiting out the full retry budget. */
export class PassengerUnreachedError extends Error {
  constructor() { super('passenger not reached: no push accepted and no text accepted'); }
}
/** Attempts before an unreached passenger row fails: about 30 s of retries (10 s, 20 s). */
export const UNREACHED_MAX_ATTEMPTS = 3;
/** The driver's low-key prompt (§5.3) carrying the cycle's one-time nonce. */
export function driverAsk(session: { id: string; orderId: string }, cycleId: string, nonce: string, respondBy: Date): CheckinPayload {
  return { title: 'Trip status check', body: 'Please confirm your trip status in the app.', data: { kind: 'guardian_driver_confirm', sessionId: session.id, orderId: session.orderId, cycleId, nonce, respondBy: respondBy.toISOString() } };
}

/** Stage the asks of one cycle level INSIDE the caller's transaction.
 *  Idempotent on (session, cycle, level, recipient). */
export async function stageCheckinDeliveries(
  tx: Prisma.TransactionClient,
  session: { id: string; tenantId: string; passengerUserId: string | null; driverUserId: string },
  asks: Array<{ cycleId: string; level: GuardianCheckinLevel; recipient: GuardianCheckinRecipient; userId: string; payload: CheckinPayload }>,
): Promise<{ staged: number }> {
  const res = await tx.guardianCheckinDelivery.createMany({
    data: asks.map((a) => ({ tenantId: session.tenantId, sessionId: session.id, cycleId: a.cycleId, level: a.level, recipient: a.recipient, userId: a.userId, payload: a.payload as Prisma.InputJsonValue })),
    skipDuplicates: true,
  });
  if (res.count > 0) guardianDeliveryCounter.labels('staged').inc(res.count);
  return { staged: res.count };
}

type Claimed = { id: string; tenantId: string; sessionId: string; cycleId: string; level: GuardianCheckinLevel; recipient: GuardianCheckinRecipient; userId: string; attempts: number; maxAttempts: number; payload: CheckinPayload };

async function claimNext(prisma: PrismaClient, leaseMs: number, sessionIds?: string[]): Promise<Claimed | null> {
  const filter = sessionIds?.length ? Prisma.sql`AND "sessionId" IN (${Prisma.join(sessionIds)})` : Prisma.empty;
  const rows = await prisma.$queryRaw<Claimed[]>(Prisma.sql`
    WITH candidate AS (
      SELECT "id" FROM "guardian_checkin_deliveries"
      WHERE "status" = 'PENDING'
        AND ("attempts" = 0 OR "availableAt" <= CURRENT_TIMESTAMP)
        AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" < CURRENT_TIMESTAMP) ${filter}
      ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT 1)
    UPDATE "guardian_checkin_deliveries" AS d
    SET "leaseExpiresAt" = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'), "attempts" = d."attempts" + 1, "updatedAt" = CURRENT_TIMESTAMP
    FROM candidate WHERE d."id" = candidate."id"
    RETURNING d."id", d."tenantId", d."sessionId", d."cycleId", d."level", d."recipient", d."userId", d."attempts", d."maxAttempts", d."payload"`);
  return rows[0] ?? null;
}

const checkinDeadlineSeconds = () => { const n = Number(process.env['GUARDIAN_CHECKIN_DEADLINE_SECONDS'] ?? 120); return Number.isFinite(n) && n > 0 ? n : 120; };

/** Drain due rows with a lease; deliver each once; back off failures on the
 *  database clock; exhausted attempts FAIL the row. A HARD passenger prompt,
 *  once delivered, gives the passenger the full window FROM DELIVERY. */
export async function drainCheckinDeliveries(
  prisma: PrismaClient,
  notifications: NotificationService,
  options: { limit?: number; leaseMs?: number; sessionIds?: string[]; observer?: CheckinDeliveryObserver; /** the caller's clock — the ladder's injected `now`, so the delivery deadline and the deadline tick agree */ now?: Date } = {},
): Promise<{ delivered: number; skipped: number; failed: number; deadLettered: number }> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? 30_000);
  const limit = Math.max(1, options.limit ?? 100);
  let delivered = 0; let skipped = 0; let failed = 0; let deadLettered = 0;
  for (let i = 0; i < limit; i += 1) {
    const row = await claimNext(prisma, leaseMs, options.sessionIds);
    if (!row) break;
    try {
      await options.observer?.beforeDeliver?.(row);
      const session = await prisma.tripSafetySession.findUnique({ where: { id: row.sessionId }, select: { status: true, deviationState: true } });
      const cycle = (session?.deviationState as { checkinCycle?: { id: string } } | null)?.checkinCycle;
      let result: { status: 'SENT' | 'SKIPPED'; receipt: Record<string, unknown> };
      if (!session || session.status === 'CLOSED' || session.status === 'ESCALATING') {
        result = { status: 'SKIPPED', receipt: { skipped: session ? `session-${session.status.toLowerCase()}` : 'session-gone' } };
      } else if (!cycle || cycle.id !== row.cycleId) {
        // The ask belongs to a cycle that is over: the person was already
        // answered, cleared, or asked again — this prompt would only confuse.
        result = { status: 'SKIPPED', receipt: { skipped: 'cycle-over', currentCycleId: cycle?.id ?? null } };
      } else {
        if (row.recipient === 'PASSENGER') {
          result = { status: 'SENT', receipt: await reachPassenger(prisma, notifications, row) };
        } else {
          const notificationId = await notifications.send({ userId: row.userId, type: 'SAFETY', title: row.payload.title, body: row.payload.body, data: row.payload.data as never });
          if (!notificationId) throw new Error('notification not persisted');
          result = { status: 'SENT', receipt: { notificationId } };
        }
        if (row.level === 'HARD' && row.recipient === 'PASSENGER') {
          // The deadline is measured from DELIVERY: a late delivery still
          // gives the full window. Only ever moves later.
          const deadline = new Date(now.getTime() + checkinDeadlineSeconds() * 1000);
          await prisma.$executeRaw`UPDATE "TripSafetySession" SET "checkinDeadlineAt" = ${deadline}, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = ${row.sessionId} AND "status" = 'CHECKIN_PENDING' AND ("checkinDeadlineAt" IS NULL OR "checkinDeadlineAt" < ${deadline})`;
        }
      }
      // The driver's one-time nonce leaves the row once it has travelled; so
      // does the passenger's answer-link secret.
      const scrubbed = row.recipient === 'DRIVER' ? { ...row.payload, data: { ...row.payload.data, nonce: undefined } } : { ...row.payload, answerToken: undefined };
      await prisma.guardianCheckinDelivery.update({ where: { id: row.id }, data: { status: result.status, receipt: result.receipt as Prisma.InputJsonValue, deliveredAt: now, leaseExpiresAt: null, lastError: null, payload: scrubbed as Prisma.InputJsonValue } });
      if (result.status === 'SENT') { delivered += 1; guardianDeliveryCounter.labels('sent').inc(); } else { skipped += 1; guardianDeliveryCounter.labels('skipped').inc(); }
    } catch (err) {
      failed += 1;
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 2_000);
      const exhausted = row.attempts >= row.maxAttempts || (err instanceof PassengerUnreachedError && row.attempts >= UNREACHED_MAX_ATTEMPTS);
      const backoffMs = Math.min(5 * 60_000, 5_000 * 2 ** Math.min(row.attempts, 6));
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "guardian_checkin_deliveries"
        SET "leaseExpiresAt" = NULL, "lastError" = ${message}, "updatedAt" = CURRENT_TIMESTAMP,
            "availableAt" = CURRENT_TIMESTAMP + (${backoffMs} * INTERVAL '1 millisecond'),
            "status" = ${exhausted ? 'FAILED' : 'PENDING'}::"GuardianDeliveryStatus",
            "payload" = CASE WHEN ${exhausted} THEN "payload" - 'answerToken' ELSE "payload" END
        WHERE "id" = ${row.id}`).catch((e) => log().error({ err: e, id: row.id }, '[S-06] could not record the failed attempt'));
      guardianDeliveryCounter.labels(exhausted ? 'dead_letter' : 'failed').inc();
      if (exhausted) deadLettered += 1;
      log().error({ err, sessionId: row.sessionId, cycleId: row.cycleId, level: row.level, recipient: row.recipient, attempts: row.attempts, exhausted }, '[S-06] check-in delivery failed — will retry');
    }
  }
  return { delivered, skipped, failed, deadLettered };
}

/**
 * [WEB-TAXI · owner 21 Oct 2026] Reach the passenger, or say it did not.
 *
 * An inbox row is a record the person may read later, never proof they were
 * asked (AUD-L8b-008). The check-in used to count the inbox row as delivered,
 * so a rider with no app to push to — anyone who booked on the website — was
 * never asked at all, the hard deadline ran anyway, and the ladder raised an
 * automatic SOS about someone who never saw a question.
 *
 * Now: the push, and when no push was accepted for any of the person's
 * devices, a text to their VERIFIED phone carrying the one-time answer link.
 * A text is a service safety message (not marketing), sent only when the push
 * did not land, at most once per accepted ask. Neither landed: the attempt
 * fails and is retried (PassengerUnreachedError), and after a few attempts the
 * row FAILS — the ladder then runs its explicit no-delivery policy and says
 * why, exactly as for a phone that cannot be reached. The inbox row is written
 * once per ask (dedupe on the delivery row), so a retry re-texts but never
 * piles up inbox copies.
 */
async function reachPassenger(prisma: PrismaClient, notifications: NotificationService, row: Claimed): Promise<Record<string, unknown>> {
  const sent = await notifications.sendReach({ userId: row.userId, type: 'SAFETY', title: row.payload.title, body: row.payload.body, data: row.payload.data as never, dedupeKey: `guardian-ask:${row.id}` });
  if (!sent.id) throw new Error('notification not persisted');
  if (sent.pushed) return { notificationId: sent.id, channel: 'push' };
  const person = await prisma.user.findUnique({ where: { id: row.userId }, select: { phone: true, isPhoneVerified: true } });
  if (person?.phone && person.isPhoneVerified
    && await notifications.smsReach(person.phone, passengerCheckinSms(row.payload, row.level), row.tenantId)) {
    guardianDeliveryCounter.labels('sms_fallback').inc();
    return { notificationId: sent.id, channel: 'sms' };
  }
  guardianDeliveryCounter.labels('passenger_unreached').inc();
  throw new PassengerUnreachedError();
}

export type DeliveryState = 'SENT' | 'PENDING' | 'FAILED' | 'SKIPPED' | 'UNKNOWN';

/** The ladder's read: how the HARD passenger prompt of a cycle fared. */
export async function hardPromptState(prisma: PrismaClient, sessionId: string, cycleId: string): Promise<{ state: DeliveryState; deliveredAt: Date | null }> {
  const row = await prisma.guardianCheckinDelivery.findUnique({ where: { sessionId_cycleId_level_recipient: { sessionId, cycleId, level: 'HARD', recipient: 'PASSENGER' } }, select: { status: true, deliveredAt: true } });
  if (!row) return { state: 'UNKNOWN', deliveredAt: null };
  return { state: row.status, deliveredAt: row.deliveredAt };
}

export interface CheckinDeliveryScan {
  pending: number;
  failed: number;
  oldestPendingSeconds: number;
  /** CHECKIN_PENDING sessions whose HARD passenger prompt is not SENT — a deadline that must not run. */
  deadlineWithoutDelivery: Array<{ sessionId: string; tenantId: string; state: DeliveryState; ageSeconds: number }>;
  /** Sessions with an ask on the record and no delivery rows for their cycle — the backfill's population. */
  askedWithoutRows: string[];
}

/** [S-06 · operations] Deadline-without-delivery, pending/failed, and the backfill population. */
export async function scanCheckinDeliveries(prisma: PrismaClient, now = new Date()): Promise<CheckinDeliveryScan> {
  const [counts] = await prisma.$queryRaw<Array<{ pending: bigint; failed: bigint; oldest: number | null }>>`
    SELECT count(*) FILTER (WHERE "status" = 'PENDING')::bigint AS pending, count(*) FILTER (WHERE "status" = 'FAILED')::bigint AS failed,
           extract(epoch FROM (${now} - min("createdAt") FILTER (WHERE "status" = 'PENDING')))::int AS oldest
    FROM "guardian_checkin_deliveries"`;
  const pendingSessions = await prisma.tripSafetySession.findMany({ where: { status: 'CHECKIN_PENDING' }, select: { id: true, tenantId: true, deviationState: true, checkinRequestedAt: true }, take: 500 });
  const deadlineWithoutDelivery: CheckinDeliveryScan['deadlineWithoutDelivery'] = [];
  const askedWithoutRows: string[] = [];
  for (const s of pendingSessions) {
    const cycleId = (s.deviationState as { checkinCycle?: { id: string } } | null)?.checkinCycle?.id;
    const rows = cycleId ? await prisma.guardianCheckinDelivery.count({ where: { sessionId: s.id, cycleId } }) : 0;
    if (rows === 0) { askedWithoutRows.push(s.id); }
    const hard = cycleId ? await hardPromptState(prisma, s.id, cycleId) : { state: 'UNKNOWN' as DeliveryState };
    if (hard.state !== 'SENT') deadlineWithoutDelivery.push({ sessionId: s.id, tenantId: s.tenantId, state: hard.state, ageSeconds: s.checkinRequestedAt ? Math.max(0, Math.round((now.getTime() - s.checkinRequestedAt.getTime()) / 1000)) : 0 });
  }
  const softAsked = await prisma.tripSafetySession.findMany({ where: { status: 'MONITORING', checkinRequestedAt: { not: null }, checkinRespondedAt: null }, select: { id: true, deviationState: true }, take: 500 });
  for (const s of softAsked) {
    const cycleId = (s.deviationState as { checkinCycle?: { id: string } } | null)?.checkinCycle?.id;
    const rows = cycleId ? await prisma.guardianCheckinDelivery.count({ where: { sessionId: s.id, cycleId } }) : 0;
    if (rows === 0) askedWithoutRows.push(s.id);
  }
  const scan = { pending: Number(counts?.pending ?? 0), failed: Number(counts?.failed ?? 0), oldestPendingSeconds: Number(counts?.oldest ?? 0), deadlineWithoutDelivery, askedWithoutRows };
  guardianDeliveryGauge.labels('pending').set(scan.pending);
  guardianDeliveryGauge.labels('failed').set(scan.failed);
  guardianDeliveryGauge.labels('oldest_pending_seconds').set(scan.oldestPendingSeconds);
  guardianDeliveryGauge.labels('deadline_without_delivery').set(deadlineWithoutDelivery.length);
  guardianDeliveryGauge.labels('asked_without_rows').set(askedWithoutRows.length);
  return scan;
}

/** [S-06 · operations] Backfill: every session with an ask on the record and
 *  no delivery rows for its cycle gets its PASSENGER rows staged now. The
 *  driver prompt is not backfilled (its nonce hash belongs to the sweep that
 *  minted the cycle); the ladder's driver path still needs the cycle it has. */
export async function backfillCheckinDeliveries(prisma: PrismaClient): Promise<{ backfilled: string[] }> {
  const scan = await scanCheckinDeliveries(prisma);
  const backfilled: string[] = [];
  for (const id of scan.askedWithoutRows) {
    const s = await prisma.tripSafetySession.findUnique({ where: { id }, select: { id: true, tenantId: true, orderId: true, status: true, passengerUserId: true, driverUserId: true, deviationState: true, checkinDeadlineAt: true } });
    if (!s || !s.passengerUserId) continue;
    const cycleId = (s.deviationState as { checkinCycle?: { id: string } } | null)?.checkinCycle?.id;
    if (!cycleId) continue;
    const level: GuardianCheckinLevel = s.status === 'CHECKIN_PENDING' ? 'HARD' : 'SOFT';
    const res = await prisma.$transaction((tx) => stageCheckinDeliveries(tx, s, [{ cycleId, level, recipient: 'PASSENGER', userId: s.passengerUserId!, payload: passengerAsk(s, cycleId, level, s.checkinDeadlineAt) }]));
    if (res.staged > 0) { backfilled.push(id); guardianDeliveryCounter.labels('backfilled').inc(); }
  }
  if (backfilled.length > 0) log().warn({ backfilled }, '[S-06] check-in asks had no delivery rows — staged now');
  return { backfilled };
}
