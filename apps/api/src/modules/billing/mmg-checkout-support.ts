import { Prisma, type MmgCheckoutIntent, type PrismaClient } from '@prisma/client';
import type {
  MmgCheckoutCreditedPeriod,
  MmgCheckoutSupportDetail,
  MmgCheckoutSupportMatch,
  MmgCheckoutSupportPartner,
  MmgCheckoutSupportRow,
  MmgCheckoutSupportStatus,
  MmgCheckoutTimelineEntry,
} from '@swift/types';
import { bindTenantTransaction } from '../../plugins/prisma';
import { normalizePhone } from '../../utils/phone';
import { maskPhone } from '../auth/step-up';
import { CHECKOUT_CLOCK_TOLERANCE_MS, MMG_TXN_ID, creationZoneInUse, firstReplyNaming, paymentHistoryOf, paymentTimeCheckOf, type CreationCheck } from './mmg-checkout.service';
import { getMmgCheckoutProvider, type MmgCheckoutProvider } from '../../providers/mmg/mmg-checkout';

// ---------------------------------------------------------------------------
// [MMG support lookup] Support finds an MMG weekly-fee payment by any id MMG or
// Swift gave it, or by the partner's phone (MMG-CHECKOUT-API.md section 11).
//
// EXACT match only, after normalisation: an id is its digits (pasted with
// spaces, dashes or a label, it is still that id); a phone is E.164. No
// substring, no LIKE, no partial: a query that is not a whole identifier finds
// nothing. Each identifier is an indexed equality:
//   - merchantTransactionId, mmgTransactionId: unique columns;
//   - a reply's named transactions: candidates @> {id}, a GIN index;
//   - MMG's ledger number: the LOOKUP observation's transactionReference, an
//     expression index on (body ->> 'transactionReference') WHERE source = LOOKUP;
//   - the partner's phone: users.phone (unique), then that partner's subscriptions.
// No column was added: every recorded reference is reachable by one of those.
//
// What leaves is built field by field (@swift/types mmg-checkout-support): the
// MMG page (sealed), Idempotency-Keys, tokens, MMG's reply message and HTML,
// keys and headers are never read into an answer.
// ---------------------------------------------------------------------------

export const MMG_SUPPORT_STATUSES = ['OPEN', 'CONFIRMING', 'CONFIRMED', 'NOT_PAID', 'EXPIRED', 'HELD'] as const satisfies readonly MmgCheckoutSupportStatus[];
export const MMG_SUPPORT_PAGE_DEFAULT = 20;
export const MMG_SUPPORT_PAGE_MAX = 50;
/** A checkout's own records: its replies and every lookup, a few hundred at most. */
export const MMG_SUPPORT_TIMELINE_MAX = 500;
/** One MMG payment is one checkout; a reference that points at more is bounded, never a scan. */
const MATCH_CAP = 50;
/** Subscriptions one phone can pay for (a store owner's stores, a mover's two). */
const PHONE_SUBSCRIPTION_CAP = 200;
const ID_MIN_DIGITS = 6;
const ID_MAX_DIGITS = 64;
const E164 = /^\+[1-9]\d{6,14}$/;
/** A checkout id (a cuid) as a cursor or a route carries it. */
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type SupportQueryShape = 'EMPTY' | 'ID' | 'PHONE' | 'ID_OR_PHONE' | 'UNUSABLE';

/**
 * How support's one search box is read. `digits`: the query as an id (its
 * digits, when there are enough to be one). `phones`: the query as a partner's
 * phone in E.164. A `+` number is taken as written; a 7-digit number is a
 * Guyana number (MMG is Guyana's wallet); 592 plus 7 digits gains its `+`.
 * `shape` names what was tried, never the value, for the audit row.
 */
export function normaliseSupportQuery(raw: string): { digits: string | null; phones: string[]; shape: SupportQueryShape } {
  const text = raw.trim();
  if (!text) return { digits: null, phones: [], shape: 'EMPTY' };
  const all = text.replace(/\D/g, '');
  const digits = all.length >= ID_MIN_DIGITS && all.length <= ID_MAX_DIGITS ? all : null;
  const phones: string[] = [];
  if (text.startsWith('+')) {
    const e164 = normalizePhone(text);
    if (E164.test(e164)) phones.push(e164);
  } else if (all.length === 7) {
    phones.push(`+592${all}`);
  } else if (all.length === 10 && all.startsWith('592')) {
    phones.push(`+${all}`);
  }
  const shape: SupportQueryShape = digits && phones.length ? 'ID_OR_PHONE' : digits ? 'ID' : phones.length ? 'PHONE' : 'UNUSABLE';
  return { digits, phones, shape };
}

/** The last row of a page, as an opaque continuation (newest first: createdAt, then id). */
export function encodeSupportCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

/** Only a cursor this list issued: anything else is null (the route answers 400). */
export function decodeSupportCursor(cursor: string): { createdAt: Date; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(cursor)) return null;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const bar = text.indexOf('|');
  if (bar < 0) return null;
  const at = text.slice(0, bar);
  const id = text.slice(bar + 1);
  if (!ISO_MS.test(at) || !ROW_ID.test(id)) return null;
  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== at) return null;
  return { createdAt, id };
}

/**
 * Condition 5 of the owner's automatic confirmation, as support reads it: the
 * SAME check judge() credits by (paymentTimeCheckOf) [Sol, DS663 · 7 Oct], on
 * MMG's history record of the transaction as it was written down: its time
 * read in the configured zone (MMG_CHECKOUT_CREATION_ZONE), bounded by the
 * first reply naming the transaction and by the checkout's window. Support
 * shows INSIDE exactly when that check would let the payment be credited. No
 * configured zone is UNREADABLE (judge holds CREATION_ZONE_UNVERIFIED).
 */
export function windowCheckOf(
  intent: Pick<MmgCheckoutIntent, 'merchantTransactionId' | 'createdAt' | 'expiresAt' | 'amount' | 'currencyCode'>, txnId: string, creation: CreationCheck,
): NonNullable<MmgCheckoutTimelineEntry['windowCheck']> {
  const result = paymentTimeCheckOf(intent, txnId, creation);
  if (result === 'REFERENCE_MISMATCH') return 'DISAGREES';
  return result === 'ZONE_UNVERIFIED' ? 'UNREADABLE' : result;
}

/** An MMG transaction id or ledger number, as MMG writes it (the service's own shape). */
const mmgIdOf = (value: unknown): string | null => (typeof value === 'string' && MMG_TXN_ID.test(value) ? value : null);
const wordOf = (value: unknown): string | null => (typeof value === 'string' && /^[A-Za-z0-9 _-]{1,40}$/.test(value) ? value : null);
const currencyOf = (value: unknown): string | null => (typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null);
const codeOf = (value: unknown): string | null => {
  if (typeof value === 'string' && /^\d{1,2}$/.test(value)) return value;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99 ? String(value) : null;
};
const amountOf = (value: unknown): string | null => {
  if (typeof value === 'string' && /^\d{1,12}(\.\d{1,2})?$/.test(value)) return value;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e12 ? String(value) : null;
};
const failureOf = (value: unknown): string | null => (typeof value === 'string' && /^[A-Z0-9_]{1,40}$/.test(value) ? value : null);
const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export interface ObservationForTimeline {
  source: string;
  detail: string | null;
  failure: string | null;
  createdAt: Date;
  body: unknown;
}

/**
 * One reply, lookup or history answer as support may see it, read from the
 * stored record by name: a reply's ResultCode and the transaction it named
 * (and whether it came by the deadline); a lookup's transactionStatus, amount,
 * currency and ledger number; MMG's history record's transactionStatus,
 * amount and currency, and where its time stands (condition 5). The lookup
 * shows no window: its creationDate is the lookup's own moment (MMG, 7 Oct).
 * Nothing else in the record (MMG's message, its HTML, the parties, any
 * redacted field) ever reaches the answer. A value not shaped like what it
 * claims to be is dropped, never shown.
 */
export function timelineEntryOf(
  intent: Pick<MmgCheckoutIntent, 'merchantTransactionId' | 'createdAt' | 'expiresAt' | 'amount' | 'currencyCode'>, o: ObservationForTimeline, creation: CreationCheck,
): MmgCheckoutTimelineEntry {
  const body = o.body && typeof o.body === 'object' && !Array.isArray(o.body) ? o.body as Record<string, unknown> : null;
  const at = o.createdAt.toISOString();
  const failure = failureOf(o.failure);
  if (o.source === 'LOOKUP') {
    const answer = failure === null ? body : null;
    return {
      at,
      source: 'LOOKUP',
      resultCode: null,
      transactionStatus: answer ? wordOf(answer['transactionStatus']) : null,
      mmgTransactionId: mmgIdOf(o.detail),
      mmgTransactionReference: answer ? mmgIdOf(answer['transactionReference']) : null,
      amount: answer ? amountOf(answer['amount']) : null,
      currency: answer ? currencyOf(answer['currency']) : null,
      windowCheck: null,
      failure,
    };
  }
  if (o.source === 'HISTORY') {
    const txnId = mmgIdOf(o.detail);
    const history = paymentHistoryOf(o);
    const record = history.outcome === 'rows' && history.naming.length === 1 ? history.naming[0]! : null;
    return {
      at,
      source: 'HISTORY',
      resultCode: null,
      transactionStatus: record ? wordOf(record['transactionStatus']) : null,
      mmgTransactionId: txnId,
      mmgTransactionReference: null,
      amount: record ? amountOf(record['amount']) : null,
      currency: record ? currencyOf(record['currency']) : null,
      windowCheck: txnId ? windowCheckOf(intent, txnId, { ...creation, history }) : null,
      failure,
    };
  }
  const resultCode = body ? codeOf(body['ResultCode']) : null;
  return {
    at,
    source: o.source === 'NOTIFY' ? 'NOTIFY' : 'RETURN',
    resultCode,
    transactionStatus: null,
    mmgTransactionId: body ? mmgIdOf(body['transactionId']) : null,
    mmgTransactionReference: null,
    amount: null,
    currency: null,
    // A reply counts toward confirmation only if it reached us by the deadline (successAnswerOf).
    windowCheck: resultCode === null ? null : o.createdAt.getTime() <= intent.expiresAt.getTime() + CHECKOUT_CLOCK_TOLERANCE_MS ? 'INSIDE' : 'OUTSIDE',
    failure,
  };
}

/** The intent columns an answer is built from. Never the sealed page or its key. */
const ROW_SELECT = {
  id: true, subscriptionId: true, merchantTransactionId: true, mmgTransactionId: true, providerPaymentId: true,
  amount: true, currencyCode: true, status: true, platform: true, candidates: true,
  createdAt: true, expiresAt: true, replyAt: true, confirmedAt: true, reason: true,
} as const satisfies Prisma.MmgCheckoutIntentSelect;
type IntentRow = Prisma.MmgCheckoutIntentGetPayload<{ select: typeof ROW_SELECT }>;

/** Run raw reads of the walled tables inside one transaction bound to the request's tenant. */
function inTenant<T>(db: PrismaClient, read: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return db.$transaction(async (tx) => {
    await bindTenantTransaction(tx);
    return read(tx);
  });
}

/** Checkouts whose MMG lookup returned this ledger number (the exact, indexed expression). */
async function intentsByLedgerReference(db: PrismaClient, tenantId: string, reference: string): Promise<string[]> {
  const rows = await inTenant(db, (tx) => tx.$queryRaw<Array<{ intentId: string }>>`
    SELECT DISTINCT o."intentId" FROM "mmg_checkout_observations" o
    WHERE o."source" = 'LOOKUP' AND (o."body" ->> 'transactionReference') = ${reference}
      AND jsonb_typeof(o."body" -> 'transactionReference') = 'string'
      AND o."intentId" IS NOT NULL AND o."tenantId" = ${tenantId}
    LIMIT ${MATCH_CAP}`);
  return rows.map((row) => row.intentId);
}

/** Every subscription the partner with this phone pays: as a rider, a driver, or a store's owner. */
async function subscriptionsOfPhones(db: PrismaClient, tenantId: string, phones: string[]): Promise<string[]> {
  const users = await db.user.findMany({ where: { tenantId, phone: { in: phones } }, select: { id: true } });
  if (users.length === 0) return [];
  const userId = { in: users.map((user) => user.id) };
  const subscriptions = await db.subscription.findMany({
    where: { OR: [{ rider: { userId } }, { driver: { userId } }, { vendor: { owner: { userId } } }] },
    select: { id: true },
    take: PHONE_SUBSCRIPTION_CAP,
  });
  return subscriptions.map((sub) => sub.id);
}

/** MMG's ledger number for each checkout, when a lookup returned one: for a
 *  confirmed checkout the lookup of the transaction it confirmed, otherwise the latest. */
async function ledgerReferencesOf(db: PrismaClient, tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await inTenant(db, (tx) => tx.$queryRaw<Array<{ intentId: string; reference: string }>>`
    SELECT DISTINCT ON (o."intentId") o."intentId", o."body" ->> 'transactionReference' AS "reference"
    FROM "mmg_checkout_observations" o JOIN "mmg_checkout_intents" i ON i."id" = o."intentId"
    WHERE o."intentId" IN (${Prisma.join(ids)}) AND o."tenantId" = ${tenantId} AND o."source" = 'LOOKUP'
      AND jsonb_typeof(o."body" -> 'transactionReference') = 'string'
    ORDER BY o."intentId", (o."detail" IS NOT DISTINCT FROM i."mmgTransactionId") DESC, o."createdAt" DESC, o."id" DESC`);
  return new Map(rows.filter((row) => MMG_TXN_ID.test(row.reference)).map((row) => [row.intentId, row.reference]));
}

/** Who pays each subscription, as support may see them: kind, name, masked phone. */
async function partnersOf(db: PrismaClient, subscriptionIds: string[]): Promise<Map<string, MmgCheckoutSupportPartner>> {
  const subs = await db.subscription.findMany({
    where: { id: { in: [...new Set(subscriptionIds)] } },
    select: {
      id: true,
      vendor: { select: { name: true, owner: { select: { user: { select: { phone: true } } } } } },
      rider: { select: { user: { select: { firstName: true, lastName: true, phone: true } } } },
      driver: { select: { user: { select: { firstName: true, lastName: true, phone: true } } } },
    },
  });
  const name = (user: { firstName: string | null; lastName: string | null }) => [user.firstName, user.lastName].filter(Boolean).join(' ') || null;
  const masked = (phone: string | null | undefined) => (phone ? maskPhone(phone) : null);
  return new Map(subs.map((sub): [string, MmgCheckoutSupportPartner] => {
    if (sub.vendor) return [sub.id, { kind: 'VENDOR', displayName: sub.vendor.name, maskedPhone: masked(sub.vendor.owner?.user.phone), subscriptionId: sub.id }];
    if (sub.rider) return [sub.id, { kind: 'RIDER', displayName: name(sub.rider.user), maskedPhone: masked(sub.rider.user.phone), subscriptionId: sub.id }];
    if (sub.driver) return [sub.id, { kind: 'DRIVER', displayName: name(sub.driver.user), maskedPhone: masked(sub.driver.user.phone), subscriptionId: sub.id }];
    return [sub.id, { kind: 'UNKNOWN', displayName: null, maskedPhone: null, subscriptionId: sub.id }];
  }));
}

type SupportRowBase = Omit<MmgCheckoutSupportRow, 'matchedBy'>;

async function rowsOf(db: PrismaClient, tenantId: string, intents: IntentRow[]): Promise<SupportRowBase[]> {
  const [partners, references] = await Promise.all([
    partnersOf(db, intents.map((row) => row.subscriptionId)),
    ledgerReferencesOf(db, tenantId, intents.map((row) => row.id)),
  ]);
  return intents.map((row) => ({
    id: row.id,
    swiftReference: row.merchantTransactionId,
    mmgTransactionId: row.mmgTransactionId,
    mmgTransactionReference: references.get(row.id) ?? null,
    amount: Number(row.amount),
    currencyCode: row.currencyCode,
    status: row.status as MmgCheckoutSupportStatus,
    platform: row.platform,
    partner: partners.get(row.subscriptionId) ?? { kind: 'UNKNOWN', displayName: null, maskedPhone: null, subscriptionId: row.subscriptionId },
    createdAt: row.createdAt.toISOString(),
    replyAt: iso(row.replyAt),
    confirmedAt: iso(row.confirmedAt),
    reason: row.reason,
  }));
}

export interface SupportSearchInput {
  tenantId: string;
  q?: string | undefined;
  status?: MmgCheckoutSupportStatus | undefined;
  cursor?: { createdAt: Date; id: string } | null | undefined;
  limit: number;
}
export interface SupportSearchResult {
  data: MmgCheckoutSupportRow[];
  nextCursor: string | null;
  /** For the audit row: which identifier(s) matched ('+'-joined), NO_MATCH, or LIST. */
  queryType: string;
  queryShape: SupportQueryShape;
}

/**
 * Search (a query) or list (none), newest first, one page at a time. `db` is
 * the admin's tenant-scoped client and `tenantId` its tenant, named again in
 * every predicate so a raw read is walled the same way.
 */
export async function searchMmgCheckouts(db: PrismaClient, input: SupportSearchInput): Promise<SupportSearchResult> {
  const query = normaliseSupportQuery(input.q ?? '');
  let refIntents = new Set<string>();
  let phoneSubscriptions = new Set<string>();
  const match: Prisma.MmgCheckoutIntentWhereInput[] = [];
  if (query.shape !== 'EMPTY') {
    if (query.digits) {
      refIntents = new Set(await intentsByLedgerReference(db, input.tenantId, query.digits));
      match.push({ merchantTransactionId: query.digits }, { mmgTransactionId: query.digits }, { candidates: { has: query.digits } });
      if (refIntents.size > 0) match.push({ id: { in: [...refIntents] } });
    }
    if (query.phones.length > 0) {
      phoneSubscriptions = new Set(await subscriptionsOfPhones(db, input.tenantId, query.phones));
      if (phoneSubscriptions.size > 0) match.push({ subscriptionId: { in: [...phoneSubscriptions] } });
    }
    if (match.length === 0) return { data: [], nextCursor: null, queryType: 'NO_MATCH', queryShape: query.shape };
  }
  const cursor = input.cursor;
  const rows = await db.mmgCheckoutIntent.findMany({
    where: {
      tenantId: input.tenantId,
      ...(input.status ? { status: input.status } : {}),
      AND: [
        ...(match.length > 0 ? [{ OR: match }] : []),
        ...(cursor ? [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] : []),
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: input.limit + 1,
    select: ROW_SELECT,
  });
  const page = rows.slice(0, input.limit);
  const matchesOf = (row: IntentRow): MmgCheckoutSupportMatch[] => {
    if (query.shape === 'EMPTY') return [];
    const found: MmgCheckoutSupportMatch[] = [];
    if (query.digits && row.merchantTransactionId === query.digits) found.push('SWIFT_REFERENCE');
    if (query.digits && row.mmgTransactionId === query.digits) found.push('MMG_TRANSACTION_ID');
    if (query.digits && row.candidates.includes(query.digits)) found.push('MMG_CANDIDATE');
    if (refIntents.has(row.id)) found.push('MMG_REFERENCE');
    if (phoneSubscriptions.has(row.subscriptionId)) found.push('PARTNER_PHONE');
    return found;
  };
  const data: MmgCheckoutSupportRow[] = (await rowsOf(db, input.tenantId, page)).map((row, i) => ({ ...row, matchedBy: matchesOf(page[i]!) }));
  const kinds = [...new Set(data.flatMap((row) => row.matchedBy))];
  return {
    data,
    nextCursor: rows.length > input.limit ? encodeSupportCursor(page[page.length - 1]!) : null,
    queryType: query.shape === 'EMPTY' ? 'LIST' : kinds.length > 0 ? kinds.join('+') : 'NO_MATCH',
    queryShape: query.shape,
  };
}

/** What a CONFIRMED checkout's credit paid: the week the settlement applied it
 *  to at once (its hold resolved PAID by the same instant's charge), or credit
 *  kept for the next bill, or still being applied; and the receipt issued. */
async function creditedPeriodOf(db: PrismaClient, row: IntentRow): Promise<MmgCheckoutCreditedPeriod> {
  const [hold, credit] = await Promise.all([
    db.paymentConfirmationHold.findUnique({ where: { checkoutId: row.id }, select: { status: true, resolvedAt: true } }),
    row.providerPaymentId
      ? db.billingEvent.findUnique({ where: { idempotencyKey: `mmg-checkout:pp:${row.providerPaymentId}` }, select: { id: true } })
      : Promise.resolve(null),
  ]);
  const receipt = credit ? await db.feeReceipt.findUnique({ where: { billingEventId: credit.id }, select: { receiptNumber: true } }) : null;
  const receiptNumber = receipt?.receiptNumber ?? null;
  if (hold?.status === 'ACTIVE' || hold?.status === 'SETTLEMENT_APPLY_PENDING') return { state: 'PENDING', periodStart: null, periodEnd: null, receiptNumber };
  const applied = hold?.status === 'PAID' && hold.resolvedAt
    ? await db.subscriptionPayment.findFirst({
      where: { subscriptionId: row.subscriptionId, status: 'CAPTURED', paidAt: hold.resolvedAt },
      select: { periodStart: true, periodEnd: true },
    })
    : null;
  return applied
    ? { state: 'APPLIED', periodStart: applied.periodStart.toISOString(), periodEnd: applied.periodEnd.toISOString(), receiptNumber }
    : { state: 'CREDIT', periodStart: null, periodEnd: null, receiptNumber };
}

/** One checkout: the row, every reply and lookup it recorded in order, and what its credit paid. Null when not this tenant's. */
export async function mmgCheckoutSupportDetail(
  db: PrismaClient, input: { tenantId: string; id: string }, deps: { checkout?: () => MmgCheckoutProvider } = {},
): Promise<MmgCheckoutSupportDetail | null> {
  if (!ROW_ID.test(input.id)) return null;
  const row = await db.mmgCheckoutIntent.findFirst({ where: { id: input.id, tenantId: input.tenantId }, select: ROW_SELECT });
  if (!row) return null;
  const [rows, observations, answers] = await Promise.all([
    rowsOf(db, input.tenantId, [row]),
    db.mmgCheckoutObservation.findMany({
      where: { intentId: row.id, tenantId: input.tenantId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MMG_SUPPORT_TIMELINE_MAX + 1,
      select: { source: true, detail: true, failure: true, createdAt: true, body: true },
    }),
    // judge()'s own input for the after-reply bound: every reply, through either door.
    db.mmgCheckoutObservation.findMany({
      where: { intentId: row.id, tenantId: input.tenantId, source: { in: ['RETURN', 'NOTIFY'] } },
      select: { body: true, createdAt: true },
    }),
  ]);
  // [Fable · S3-1] The zone of the checkout provider in use, read exactly as
  // verify() reads it: a switched-off or unbuildable provider has none, and
  // then judge() holds every payment, so support claims no window either.
  const zone = creationZoneInUse(deps.checkout ?? (() => getMmgCheckoutProvider()));
  const creationFor = (o: ObservationForTimeline): CreationCheck => ({
    zone, firstReplyAt: o.source === 'HISTORY' && o.detail ? firstReplyNaming(answers, o.detail) : null,
  });
  return {
    ...rows[0]!,
    timeline: observations.slice(0, MMG_SUPPORT_TIMELINE_MAX).map((o) => timelineEntryOf(row, o, creationFor(o))),
    timelineTruncated: observations.length > MMG_SUPPORT_TIMELINE_MAX,
    creditedPeriod: row.status === 'CONFIRMED' ? await creditedPeriodOf(db, row) : null,
  };
}
