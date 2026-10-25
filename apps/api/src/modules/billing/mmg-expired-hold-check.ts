import type { Prisma, PrismaClient } from '@prisma/client';
import { currentDunningClock, resolveConfirmationInTx } from './dunning-clock';
import { historyRowFrom, type MmgCheckoutLookupClient, type MmgHistoryQuery } from '../../providers/mmg/mmg-provider';
import { MMG_HISTORY_CLOCK_TOLERANCE_MS, MMG_HISTORY_MARGIN_MS, mmgHistoryQueryFor, mmgHistoryTruncated } from '../../providers/mmg/mmg-history';
import type { MmgCreationZone } from '../../providers/mmg/mmg-checkout';
import { mmgCheckoutEventsCounter, mmgCheckoutLookupsCounter } from '../../plugins/observability';
import { log } from '../../utils/logger';

// ---------------------------------------------------------------------------
// [HOLD-AUTO · owner ruling 25 Oct "Auto-close via MMG check"] An MMG
// weekly-fee checkout nobody finished (EXPIRED, NO_REPLY: MMG never sent the
// partner back and never notified us) keeps a payment-confirmation hold
// ACTIVE: the Pay button is hidden and the billing clock is frozen until two
// admins close it as NOT PAID. Local expiry is never negative evidence, so
// Swift asks MMG's own records:
//   - MMG's Transaction History for the whole window the page could have been
//     paid in (the checkout's window, plus half an hour after our deadline:
//     MMG's own page limit is unconfirmed, U8), read only once that window is
//     entirely in the past;
//   - in the same pass, a CONTROL: the tenant's own most recent confirmed
//     checkout, read the same way, must come back as exactly MMG's record of
//     its transaction naming its reference. That proves the read itself is
//     healthy (credentials, merchant, MMG's time convention, rows returned),
//     as the staging check of 25 Oct proved it by hand. MMG's lookup cannot
//     answer for such a checkout: it is asked by MMG transaction id, and a
//     NO_REPLY checkout never received one.
// ONLY when the read is healthy, covers the window, is whole (not cut at the
// row limit) and every row in it is another of OUR confirmed checkouts'
// payments (MMG's own row names that checkout's reference and the very
// transaction credited to it) is the hold closed as NOT PAID: by the system,
// audited, the same records the admin close writes, nothing credited, and the
// billing clock resumed exactly as the admin close resumes it. Any row naming
// this checkout, any row that cannot be explained, a failed or partial read,
// a missing control, a reply of any kind, a settlement, a provider payment or
// a second-admin request already raised for the hold: nothing changes, the
// admins keep it exactly as today, and MMG is asked again later on a bounded
// schedule. Every check is written down before anything is decided on it
// [I9]; other people's payments are never stored.
// A payment that still arrives after the close is caught exactly as after an
// admin close: a late reply is looked up again, and a paid record retakes the
// pause for a person (LATE_POSITIVE_REVIEW) or credits once.
// ---------------------------------------------------------------------------

/** The system actor recorded on the hold and the audit row. */
export const NO_REPLY_CHECK_ACTOR = 'mmg-history-check';
/** The checkout's reason once MMG's records showed no payment for it. */
export const NO_REPLY_CLOSED_REASON = 'MMG_HISTORY_CONFIRMED_UNPAID';
/** The audit action of an automatic close. */
export const NO_REPLY_CLOSE_AUDIT = 'MMG_EXPIRED_HOLD_AUTO_CLOSED';
/** Marks this check's HISTORY observations (detail is null: no MMG transaction was ever named). */
export const NO_REPLY_CHECK_PURPOSE = 'NO_REPLY_EXPIRY_CHECK';
/** The second-admin route that closes a hold by hand; a request for it in flight leaves the hold to the admins. */
export const CONFIRMATION_RESOLVE_ACTION = 'POST /billing/confirmations/:id/resolve';
/** How long after our deadline a payment on MMG's page is still looked for. */
export const NO_REPLY_COVER_AFTER_EXPIRY_MS = 30 * 60_000;
/** The first check waits until the whole padded window is in the past. */
export const NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS = NO_REPLY_COVER_AFTER_EXPIRY_MS + MMG_HISTORY_CLOCK_TOLERANCE_MS + MMG_HISTORY_MARGIN_MS;
/** The wait before each further check (after the 1st, 2nd, ... check). */
export const NO_REPLY_CHECK_BACKOFF_MS: readonly number[] = [
  30 * 60_000, 3_600_000, 2 * 3_600_000, 4 * 3_600_000, 8 * 3_600_000, 16 * 3_600_000, 24 * 3_600_000, 24 * 3_600_000, 24 * 3_600_000,
];
/** After this many checks, the hold is the admins' alone (as today). */
export const NO_REPLY_CHECK_MAX_ATTEMPTS = NO_REPLY_CHECK_BACKOFF_MS.length + 1;
/** Checks per poll, and how many recent confirmed checkouts may serve as the control. */
const CHECK_BATCH = 20;
const SCAN = 500;
const CONTROL_CANDIDATES = 3;

export type NoReplyDecision = 'NO_PAYMENT' | 'PAYMENT_MAY_MATCH' | 'HISTORY_INCOMPLETE' | 'HISTORY_FAILED' | 'CONTROL_FAILED';
type Db = PrismaClient | Prisma.TransactionClient;

/** The checkout facts every step re-reads. */
const CHECKOUT_FIELDS = {
  id: true, tenantId: true, subscriptionId: true, merchantTransactionId: true, status: true, reason: true, candidates: true,
  replyAt: true, mmgTransactionId: true, providerPaymentId: true, confirmedAt: true, createdAt: true, expiresAt: true,
} satisfies Prisma.MmgCheckoutIntentSelect;
type CheckoutFacts = Prisma.MmgCheckoutIntentGetPayload<{ select: typeof CHECKOUT_FIELDS }>;

/** An expired checkout nobody ever answered for: never a transaction, a reply or a credit. */
const NEVER_ANSWERED = {
  status: 'EXPIRED', reason: 'NO_REPLY', candidates: { isEmpty: true }, replyAt: null,
  mmgTransactionId: null, providerPaymentId: null, confirmedAt: null,
} satisfies Prisma.MmgCheckoutIntentWhereInput;
function neverAnswered(c: CheckoutFacts): boolean {
  return c.status === 'EXPIRED' && c.reason === 'NO_REPLY' && c.candidates.length === 0 && c.replyAt === null
    && c.mmgTransactionId === null && c.providerPaymentId === null && c.confirmedAt === null;
}

/** The end of the window MMG is asked about. */
function windowEnd(c: Pick<CheckoutFacts, 'expiresAt'>): number {
  return c.expiresAt.getTime() + NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS;
}
/** MMG's history query for the whole window, never clamped: only asked once it is in the past. */
export function noReplyQueryFor(c: Pick<CheckoutFacts, 'createdAt' | 'expiresAt'>, zone: MmgCreationZone, now: Date): MmgHistoryQuery {
  return mmgHistoryQueryFor(c.createdAt, new Date(c.expiresAt.getTime() + NO_REPLY_COVER_AFTER_EXPIRY_MS), zone, now);
}
/** When the next check is due, or null once the attempts are spent. */
export function noReplyCheckDueAt(c: Pick<CheckoutFacts, 'expiresAt'>, attempts: number, lastAt: Date | null): number | null {
  if (attempts >= NO_REPLY_CHECK_MAX_ATTEMPTS) return null;
  if (attempts === 0 || !lastAt) return windowEnd(c);
  return Math.max(windowEnd(c), lastAt.getTime() + NO_REPLY_CHECK_BACKOFF_MS[attempts - 1]!);
}

const canon = (id: string) => id.trim().toUpperCase();
/** Every scalar in a row, as text (bounded). */
function leaves(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || out.length > 256) return out;
  if (Array.isArray(value)) for (const v of value) leaves(v, out, depth + 1);
  else if (value && typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) leaves(v, out, depth + 1);
  else if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  return out;
}

/**
 * Something that leaves the hold to the admins, read on the same client the
 * close uses (under its locks there). A reply of any kind for this checkout,
 * or one nobody could tie to a checkout that arrived while it could have been
 * paid; a provider payment credited to it, or any MMG payment on this
 * subscription since it opened; a second-admin request for this hold that is
 * still waiting or approved and unspent.
 */
async function blockerOf(db: Db, holdId: string, c: CheckoutFacts, now: Date): Promise<string | null> {
  const replies = await db.mmgCheckoutObservation.count({ where: { OR: [
    { intentId: c.id, source: { in: ['RETURN', 'NOTIFY'] } },
    { intentId: null, source: { in: ['RETURN', 'NOTIFY'] }, failure: { in: ['NO_TOKEN', 'INVALID_RESPONSE'] },
      createdAt: { gte: new Date(c.createdAt.getTime() - MMG_HISTORY_CLOCK_TOLERANCE_MS), lte: new Date(windowEnd(c)) } },
  ] } });
  if (replies > 0) return 'REPLY_ON_RECORD';
  const money = await db.providerPayment.count({ where: { OR: [
    { creditedPaymentId: `mco:${c.id}` },
    { provider: 'MMG', subscriptionId: c.subscriptionId, createdAt: { gte: new Date(c.createdAt.getTime() - MMG_HISTORY_CLOCK_TOLERANCE_MS) } },
  ] } });
  if (money > 0) return 'PROVIDER_PAYMENT_ON_RECORD';
  const asked = await db.privilegedApproval.count({ where: {
    action: CONFIRMATION_RESOLVE_ACTION, entityId: holdId, status: { in: ['PENDING', 'APPROVED'] }, expiresAt: { gt: now },
  } });
  if (asked > 0) return 'ADMIN_REQUEST_IN_FLIGHT';
  return null;
}

type Control = { ok: true; checkoutId: string; query: MmgHistoryQuery } | { ok: false; reason: 'NO_CONTROL' } | { ok: false; reason: 'CONTROL_FAILED'; checkoutId: string | null; detail: string };

/** The read is healthy only when MMG answers, for one of this tenant's most
 *  recent confirmed checkouts, exactly its own record: one row naming its MMG
 *  transaction (as both numbers) with its reference. */
async function proveControl(db: PrismaClient, lookup: MmgCheckoutLookupClient, zone: MmgCreationZone, tenantId: string, now: Date): Promise<Control> {
  const confirmed = await db.mmgCheckoutIntent.findMany({
    where: { tenantId, status: 'CONFIRMED', mmgTransactionId: { not: null }, providerPaymentId: { not: null }, confirmedAt: { not: null } },
    orderBy: [{ confirmedAt: 'desc' }, { id: 'asc' }], take: CONTROL_CANDIDATES,
    select: { id: true, merchantTransactionId: true, mmgTransactionId: true, createdAt: true, expiresAt: true },
  });
  if (confirmed.length === 0) return { ok: false, reason: 'NO_CONTROL' };
  let detail = 'CONTROL_NOT_FOUND';
  for (const control of confirmed) {
    const query = mmgHistoryQueryFor(control.createdAt, control.expiresAt, zone, now);
    const answer = await lookup.transactionHistoryRows(query);
    mmgCheckoutLookupsCounter.labels(`history_${answer.outcome}`).inc();
    if (answer.outcome !== 'rows') return { ok: false, reason: 'CONTROL_FAILED', checkoutId: control.id, detail: 'CONTROL_READ_FAILED' };
    const txn = canon(control.mmgTransactionId!);
    const naming = answer.rows.filter((row) => leaves([row['transactionReference'], row['transactionReceipt']]).some((v) => canon(v) === txn));
    const row = naming.length === 1 ? historyRowFrom(naming[0]!) : null;
    if (!mmgHistoryTruncated(answer.rows.length, query) && row && row.externalId === control.merchantTransactionId
      && row.transactionReference !== null && canon(row.transactionReference) === txn
      && row.transactionReceipt !== null && canon(row.transactionReceipt) === txn) {
      return { ok: true, checkoutId: control.id, query };
    }
    detail = naming.length > 1 ? 'CONTROL_AMBIGUOUS' : 'CONTROL_NOT_FOUND';
  }
  return { ok: false, reason: 'CONTROL_FAILED', checkoutId: confirmed[0]!.id, detail };
}

/** Rows that are another confirmed checkout's own payment: MMG's row names
 *  that checkout's reference, and both its numbers are the transaction
 *  credited to it. Everything else could be this checkout's money. */
async function explainedRows(db: PrismaClient, rows: readonly Record<string, unknown>[], ours: string): Promise<Set<Record<string, unknown>>> {
  const refs = [...new Set(rows.map((row) => historyRowFrom(row).externalId).filter((ref): ref is string => !!ref && ref !== ours))];
  if (refs.length === 0) return new Set();
  const others = await db.mmgCheckoutIntent.findMany({
    where: { merchantTransactionId: { in: refs }, status: 'CONFIRMED', mmgTransactionId: { not: null }, providerPaymentId: { not: null } },
    select: { merchantTransactionId: true, mmgTransactionId: true },
  });
  const credited = new Map(others.map((o) => [o.merchantTransactionId, canon(o.mmgTransactionId!)]));
  return new Set(rows.filter((row) => {
    const r = historyRowFrom(row);
    const txn = r.externalId ? credited.get(r.externalId) : undefined;
    return !!txn && r.transactionReference !== null && canon(r.transactionReference) === txn
      && r.transactionReceipt !== null && canon(r.transactionReceipt) === txn;
  }));
}

type Due = { holdId: string; checkout: CheckoutFacts; attempts: number };

/**
 * One pass, from the checkout poll (it runs as the system). Returns how many
 * holds MMG was asked about and how many were closed. Nothing is asked of MMG
 * without a configured creation zone (no MMG time can be read).
 */
export async function checkExpiredNoReplyHolds(
  db: PrismaClient,
  deps: {
    lookup: MmgCheckoutLookupClient;
    zone: MmgCreationZone | null;
    /** The checkout verifier's own redaction for what is written down (keys that may carry a secret, size). */
    redact: (value: Record<string, unknown>) => Prisma.InputJsonValue;
  },
  now: Date,
): Promise<{ checked: number; closed: number }> {
  const out = { checked: 0, closed: 0 };
  if (!deps.zone) return out;
  const zone = deps.zone;
  const holds = await db.paymentConfirmationHold.findMany({
    where: { status: 'ACTIVE', checkout: { is: { ...NEVER_ANSWERED, expiresAt: { lte: new Date(now.getTime() - NO_REPLY_FIRST_CHECK_AFTER_EXPIRY_MS) } } } },
    // Newest first: a page just abandoned is checked promptly; holds whose checks are spent sink.
    orderBy: [{ beganAt: 'desc' }, { id: 'asc' }], take: SCAN,
    select: { id: true, checkout: { select: CHECKOUT_FIELDS } },
  });
  if (holds.length === 0) return out;
  const tries = await db.mmgCheckoutObservation.groupBy({
    by: ['intentId'],
    where: { intentId: { in: holds.map((h) => h.checkout!.id) }, source: 'HISTORY', detail: null },
    _count: { _all: true }, _max: { createdAt: true },
  });
  const triesOf = new Map(tries.map((t) => [t.intentId, { attempts: t._count._all, lastAt: t._max.createdAt }]));
  const due: Due[] = [];
  for (const hold of holds) {
    const c = hold.checkout!;
    const { attempts, lastAt } = triesOf.get(c.id) ?? { attempts: 0, lastAt: null };
    const at = noReplyCheckDueAt(c, attempts, lastAt);
    if (at === null || at > now.getTime() || !neverAnswered(c)) continue;
    if (await blockerOf(db, hold.id, c, now)) continue;
    due.push({ holdId: hold.id, checkout: c, attempts });
    if (due.length >= CHECK_BATCH) break;
  }
  const controls = new Map<string, Control>();
  for (const item of due) {
    try {
      let control = controls.get(item.checkout.tenantId);
      if (!control) {
        control = await proveControl(db, deps.lookup, zone, item.checkout.tenantId, now);
        controls.set(item.checkout.tenantId, control);
      }
      // No confirmed checkout of this tenant to prove the read with: MMG is
      // not asked, nothing is written, the hold stays with the admins.
      if (!control.ok && control.reason === 'NO_CONTROL') continue;
      out.checked += 1;
      if (await checkOne(db, deps, zone, item, control, now)) out.closed += 1;
    } catch (err) {
      log().error({ err, checkoutId: item.checkout.id }, '[MMG checkout] the expired-checkout check failed; the hold is unchanged and checked again later');
    }
  }
  return out;
}

async function checkOne(
  db: PrismaClient, deps: { lookup: MmgCheckoutLookupClient; redact: (value: Record<string, unknown>) => Prisma.InputJsonValue },
  zone: MmgCreationZone, item: Due, control: Control, now: Date,
): Promise<boolean> {
  const c = item.checkout;
  const query = noReplyQueryFor(c, zone, now);
  const controlFacts = control.ok
    ? { checkoutId: control.checkoutId, query: control.query, found: true }
    : { checkoutId: control.reason === 'CONTROL_FAILED' ? control.checkoutId : null, found: false, detail: control.reason === 'CONTROL_FAILED' ? control.detail : control.reason };
  let decision: NoReplyDecision;
  let body: Record<string, unknown>;
  if (!control.ok) {
    decision = 'CONTROL_FAILED';
    body = { purpose: NO_REPLY_CHECK_PURPOSE, decision, attempt: item.attempts + 1, control: controlFacts };
  } else {
    const answer = await deps.lookup.transactionHistoryRows(query);
    mmgCheckoutLookupsCounter.labels(`history_${answer.outcome}`).inc();
    if (answer.outcome !== 'rows') {
      decision = 'HISTORY_FAILED';
      body = { purpose: NO_REPLY_CHECK_PURPOSE, decision, attempt: item.attempts + 1, query, error: answer.reason.slice(0, 200), control: controlFacts };
    } else {
      const ours = c.merchantTransactionId;
      // Only rows that name this checkout are ever written down; others' payments are counted, never stored.
      const naming = answer.rows.filter((row) => leaves(row).some((v) => v.includes(ours)));
      const others = answer.rows.filter((row) => !naming.includes(row));
      const explained = await explainedRows(db, others, ours);
      const unexplained = others.length - explained.size;
      const truncated = mmgHistoryTruncated(answer.rows.length, query);
      decision = truncated ? 'HISTORY_INCOMPLETE' : naming.length > 0 || unexplained > 0 ? 'PAYMENT_MAY_MATCH' : 'NO_PAYMENT';
      body = { purpose: NO_REPLY_CHECK_PURPOSE, decision, attempt: item.attempts + 1, query, rowsReturned: answer.rows.length,
        truncated, naming, explained: explained.size, unexplained, control: controlFacts };
    }
  }
  // [I9] Written down before anything is decided on it, at the check's own
  // time: the schedule above is read from these times.
  const observation = await db.mmgCheckoutObservation.create({ data: {
    tenantId: c.tenantId, intentId: c.id, source: 'HISTORY', detail: null, body: deps.redact(body), createdAt: now,
    failure: decision === 'NO_PAYMENT' ? 'HISTORY_NOT_FOUND' : decision === 'PAYMENT_MAY_MATCH' ? null : 'HISTORY_FAILED',
  }, select: { id: true } });
  if (decision !== 'NO_PAYMENT' || !control.ok) {
    mmgCheckoutEventsCounter.labels('expired_hold_left').inc();
    log().warn({ checkoutId: c.id, decision }, '[MMG checkout] expired checkout not closed: MMG did not confirm that nothing was paid; the admins keep it');
    return false;
  }
  const closed = await closeUnpaid(db, item.holdId, c.id, {
    observationId: observation.id, controlCheckoutId: control.checkoutId, query,
    rowsReturned: body['rowsReturned'] as number, explained: body['explained'] as number,
  }, now);
  if (closed) {
    mmgCheckoutEventsCounter.labels('expired_hold_closed').inc();
    log().info({ checkoutId: c.id }, '[MMG checkout] expired checkout closed as not paid: MMG records show no payment');
  }
  return closed;
}

/** The admin close's UNPAID records, written by the system: under the same
 *  locks (payer, subscriptions, clock, then the checkout), with every fact
 *  the decision rests on read again first. Nothing is credited. */
async function closeUnpaid(db: PrismaClient, holdId: string, checkoutId: string, facts: {
  observationId: string; controlCheckoutId: string; query: MmgHistoryQuery; rowsReturned: number; explained: number;
}, now: Date): Promise<boolean> {
  return db.$transaction(async (tx) => {
    const candidate = await tx.paymentConfirmationHold.findUnique({ where: { id: holdId }, select: { subscriptionId: true } });
    if (!candidate) return false;
    const clock = await currentDunningClock(tx, candidate.subscriptionId, now);
    await tx.$queryRaw`SELECT "id" FROM "mmg_checkout_intents" WHERE "id" = ${checkoutId} FOR UPDATE`;
    const hold = await tx.paymentConfirmationHold.findUniqueOrThrow({ where: { id: holdId } });
    const checkout = await tx.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: checkoutId }, select: CHECKOUT_FIELDS });
    if (hold.status !== 'ACTIVE' || hold.checkoutId !== checkoutId || hold.clockId !== clock.id
      || hold.sourceEpoch !== clock.epoch || !neverAnswered(checkout)) return false;
    if (await blockerOf(tx, hold.id, checkout, now)) return false;
    const reference = `mmg-history-none:${facts.observationId}`;
    const moved = await tx.mmgCheckoutIntent.updateMany({ where: { id: checkoutId, status: 'EXPIRED' },
      data: { status: 'NOT_PAID', nextCheckAt: null, reason: NO_REPLY_CLOSED_REASON } });
    if (moved.count !== 1) return false;
    await resolveConfirmationInTx(tx, hold.subscriptionId, { checkoutId }, 'PROVEN_UNPAID', { actor: NO_REPLY_CHECK_ACTOR, reference }, now);
    const resolved = await tx.paymentConfirmationHold.findUniqueOrThrow({ where: { id: hold.id } });
    await tx.auditLog.create({ data: { action: NO_REPLY_CLOSE_AUDIT, entity: 'PaymentConfirmationHold', entityId: hold.id, changes: {
      tenantId: hold.tenantId, confirmationId: hold.id, subscriptionId: hold.subscriptionId, sourceId: checkoutId, epoch: hold.sourceEpoch,
      decision: 'UNPAID', evidenceReference: reference, status: resolved.status, actor: NO_REPLY_CHECK_ACTOR,
      checkoutReason: NO_REPLY_CLOSED_REASON, observationId: facts.observationId, controlCheckoutId: facts.controlCheckoutId,
      fromdate: facts.query.fromdate, todate: facts.query.todate, rowsReturned: facts.rowsReturned, explainedRows: facts.explained,
    } } });
    return resolved.status === 'PROVEN_UNPAID';
  });
}
