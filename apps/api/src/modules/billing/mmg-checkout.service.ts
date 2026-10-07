import { readFeeCollectionAuthority } from '../subscription/mover-fee-authority';
import { lockFeePaymentDecision } from './fee-payment-authority';
import { amountDueNow } from './amount-due';
import { weeklyFeeAmount } from './subscription-fee';
import { beginConfirmationInTx, lockBillingAuthority, markSettlementApplying, reopenConfirmationForReviewInTx, resolveConfirmationInTx } from './dunning-clock';
import { Prisma, type MmgCheckoutIntent, type PrismaClient, type Subscription, type SubscriptionStatus } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { formatMoney, fromMajor } from '../../utils/currency-amount';
import {
  MERCHANT_TRANSACTION_ID_SHAPE,
  describeShape,
  getMmgCheckoutProvider,
  newMerchantTransactionId,
  type MmgCheckoutProvider,
  type MmgCreationZone,
} from '../../providers/mmg/mmg-checkout';
import { getMmgLookupProvider, historyRowFrom, type MmgHistoryQuery, type MmgLookupClient, type MmgLookupDetail } from '../../providers/mmg/mmg-provider';
import { mmgCheckoutEventsCounter, mmgCheckoutLookupsCounter } from '../../plugins/observability';
import { runAsSystem } from '../../plugins/tenant-context';
import { isDuplicateOn } from '../money/evidence';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';
import type { BillingService } from './billing.service';
import { payInfo } from './agent-cash.service';
import { openCheckoutUrl, sealCheckoutUrl } from './checkout-url-seal';
import { checkoutAmountGyd, mmgCheckoutLive, type ClientPlatform } from './fee-pay-actions';
import { claimProviderPaymentInTx, ProviderIdentityError, type ProviderIdentityCode } from './provider-identity';
import { MMG_HISTORY_CLOCK_TOLERANCE_MS, mmgHistoryQueryFor, mmgHistoryTruncated } from '../../providers/mmg/mmg-history';
export { MMG_HISTORY_ROWS, MMG_HISTORY_MARGIN_MS, mmgStampOf } from '../../providers/mmg/mmg-history';
import { instantOfGuyanaWallClock } from '../../utils/guyana-day';
import { ensureProviderIdentityBackfill, providerIdentityBackfillDone } from './provider-identity-backfill';
import { partnerReceiptIds } from './mmg-checkout-receipt';

// ---------------------------------------------------------------------------
// The MMG weekly-fee checkout (MMG-CHECKOUT-API.md is the contract).
//
// A partner starts a checkout; Swift prices it [I1], persists it with its MMG
// page sealed [F6], then hands the page out. MMG sends the partner back with an
// encrypted reply with the official root-level merchantTransactionId,
// transactionId and ResultCode fields. No nested value or guessed key binds
// a reply to a checkout or supplies a transaction id.
// The reply is only a pointer. MMG's own merchant lookup is the only evidence
// [I2]. A payment confirms automatically (the owner's ruling of 1 Oct) only
// when ALL hold: (1) MMG answered ResultCode 0 for THIS checkout, naming the
// transaction, while the checkout was open; (2) MMG's lookup of that
// transaction says "successful"; (3) the money went to our merchant's
// "accountid"; (4) exactly the amount asked, in GYD; (5) MMG's Transaction
// History has exactly one record of the transaction, agreeing with it, whose
// time (modificationDate: when MMG performed it; the lookup's creationDate is
// the lookup's own moment, MMG 7 Oct) lies inside the checkout's window, read
// in the configured zone (MMG_CHECKOUT_CREATION_ZONE; unset, nothing
// confirms), and no later than the first reply naming it [DS632]; (6) neither
// the transaction nor MMG's ledger number for it was ever credited. Anything
// else is held for a person, with reminders and suspension paused [F1].
//
// The credit is the provider_payments compare-and-set every channel claims
// [I3 · F2]; one open checkout per subscription is a partial unique index
// [I4]; a checkout in flight pauses charging and dunning, and a credit
// re-bills at once [I5]; a mismatch holds for a person [I6]; this table is
// invisible to the merchant-initiated poller [I7]; expiry is not failure, and
// a late confirmation still credits [I8]; every reply and lookup is written
// down, under the checkout's own tenant [F7], before anything is decided on it
// [I9]. A key that was answered keeps its answer [F3]; an expiry never
// overwrites a newer state [F4]; only MMG's answer for THIS checkout says a
// payment failed [F5].
// ---------------------------------------------------------------------------

/** How long a partner has to finish on the MMG page (MMG's own limit is unconfirmed, U8). */
export const MMG_CHECKOUT_TTL_MS = 30 * 60_000;
/** A reply is checked for a day; after that a late confirmation is still looked for, for a week. */
const CONFIRM_WINDOW_MS = 24 * 3_600_000;
/** How long after a checkout (or its last reply) a late MMG answer is still
 *  looked for and credited. Account deletion waits for it to close. */
export const LATE_WINDOW_MS = 7 * 24 * 3_600_000;
const LATE_CHECK_MS = 6 * 3_600_000;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000] as const;
/** [owner, 1 Oct] Clock tolerance around a checkout's window: for MMG's time
 *  for the payment ([7 Oct] its history record's modificationDate), and for
 *  when MMG's success answer reached us. [DS632] Also how far MMG's time may
 *  run past the first reply naming it. */
export const CHECKOUT_CLOCK_TOLERANCE_MS = MMG_HISTORY_CLOCK_TOLERANCE_MS;
/** An MMG transaction id or ledger number as MMG writes it. */
export const MMG_TXN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CANDIDATES = 5;
const MAX_REPLY_PARAMS = 16;
const MAX_REPLY_PARAM_CHARS = 4096;
const POLL_BATCH = 50;
/** [Sol, DS659 · delta3] How far back the poll looks for a CONFIRMED
 *  checkout's unapplied payment whose operator page was never saved, and how
 *  many rows each read takes. */
export const MMG_UNAPPLIED_RECONCILE_LOOKBACK_MS = 14 * 24 * 3_600_000;
const UNAPPLIED_READ_BATCH = 200;
const UNAPPLIED_PAGE_SEARCH_SLACK_MS = 24 * 3_600_000;
const CLIENT_KEY = /^[A-Za-z0-9_-]{8,128}$/;
/** Creating a checkout re-reads after a lost race; it never spins. */
const CREATE_ATTEMPTS = 3;
/** [DS611] Unmatched observations are pruned in bounded batches, oldest first:
 *  a reply that did not even decrypt after a week, a decrypted reply that
 *  names no checkout of ours (a possible security signal) after 90 days. */
export const MMG_OBSERVATION_PRUNE_BATCH = 1000;
const UNREADABLE_RETENTION_MS = 7 * 24 * 3_600_000;
const UNMATCHED_RETENTION_MS = 90 * 24 * 3_600_000;
/** MMG's official not-paid answers: 1 agent not registered, 2 payment failed, 6 cancelled. */
const NOT_PAID_CODES: ReadonlySet<string> = new Set(['1', '2', '6']);
/** Reply observations whose answer is "not paid" (7, timed out, included). */
const NEGATIVE_ANSWERS = ['MMG_RESULT_1', 'MMG_RESULT_2', 'MMG_RESULT_6', 'MMG_RESULT_7'];
const SUCCESS_ANSWER = 'MMG_RESULT_0';

/** A quote names an obligation as well as an amount. Equal-price changes of
 * period, eligibility or future tariff still require a fresh instruction. */
function checkoutQuoteBasis(sub: Subscription) {
  return JSON.stringify([sub.type, String(sub.weeklyRate), String(sub.customRate), sub.feeWaived,
    sub.currencyCode, sub.status, sub.autoRenew, sub.nextBillingDate.toISOString(),
    sub.currentPeriodStart.toISOString(), sub.currentPeriodEnd.toISOString()]);
}

export type CheckoutStatus = 'OPEN' | 'CONFIRMING' | 'CONFIRMED' | 'NOT_PAID' | 'EXPIRED' | 'HELD';
export type ReturnState = 'CONFIRMED' | 'CONFIRMING' | 'NOT_PAID' | 'UNKNOWN';

export interface CheckoutView {
  ref: string;
  status: CheckoutStatus;
  amountGyd: number;
  currencyCode: 'GYD';
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;
  subscriptionStatus: SubscriptionStatus;
  /** [MMG support lookup] Ours, the merchantTransactionId MMG was sent. Always. */
  swiftReference: string;
  /** [MMG support lookup] MMG's transaction, only once CONFIRMED (partnerReceiptIds). */
  mmgTransactionId: string | null;
}

export interface StartedCheckout {
  ref: string;
  status: CheckoutStatus;
  /** The MMG page, only while the checkout is OPEN: never an invitation to pay twice. */
  checkoutUrl: string | null;
  amountGyd: number;
  currencyCode: 'GYD';
  expiresAt: string;
}

/** One MSISDN, spelled with or without the 592 country code. */
export function sameMsisdn(a: string, b: string): boolean {
  const x = a.replace(/\D/g, '');
  const y = b.replace(/\D/g, '');
  if (x.length < 7 || y.length < 7) return false;
  return x === y || x === `592${y}` || `592${x}` === y;
}

type Leaf = { path: string; value: string };

/** Every string (and non-negative safe integer) in a reply, with its key path. Bounded. */
function replyLeaves(value: unknown, path = '', out: Leaf[] = [], depth = 0): Leaf[] {
  if (out.length >= 64 || depth > 4) return out;
  if (typeof value === 'string') out.push({ path, value: value.trim() });
  else if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) out.push({ path, value: String(value) });
  else if (Array.isArray(value)) value.forEach((item, i) => replyLeaves(item, `${path}[${i}]`, out, depth + 1));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) replyLeaves(child, path ? `${path}.${key}` : key, out, depth + 1);
  }
  return out;
}

/** Key names that may carry a secret: never looked up, never stored. */
const SECRET_PATH = /secret|password|passwd|token|apikey|api_key|privatekey|private_key/i;
export type MmgResultCode = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7';
export interface MmgCheckoutReply {
  merchantTransactionId: string;
  transactionId: string | null;
  resultCode: MmgResultCode;
}

/** The official response fields, exactly as sent. Messages and HTML never
 *  select a checkout, a transaction, or a payment state. */
export function checkoutReplyFrom(reply: unknown): MmgCheckoutReply | null {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return null;
  const fields = reply as Record<string, unknown>;
  const ref = fields['merchantTransactionId'];
  const code = fields['ResultCode'];
  const txn = fields['transactionId'];
  if (typeof ref !== 'string' || ref.length !== 18 || !MERCHANT_TRANSACTION_ID_SHAPE.test(ref)) return null;
  if (typeof code !== 'string' || code.length !== 1 || !/^[0-7]$/.test(code)) return null;
  // Failed attempts may have no transaction. A success must name one.
  const absent = txn === undefined || txn === null || txn === '';
  if (absent && code === '0') return null;
  if (!absent && (typeof txn !== 'string' || txn.trim() !== txn || !MMG_TXN_ID.test(txn))) return null;
  return { merchantTransactionId: ref, transactionId: absent ? null : txn as string, resultCode: code as MmgResultCode };
}

const CONFIG_FAILURES: Partial<Record<MmgResultCode, string>> = {
  '3': 'MMG_RESULT_3_INVALID_SECRET_KEY',
  '4': 'MMG_RESULT_4_MERCHANT_ID_MISMATCH',
  '5': 'MMG_RESULT_5_TOKEN_DECRYPTION_FAILED',
};

/** The reply as stored: keys that may carry a secret are replaced, and size is bounded. */
function redacted(value: unknown, depth = 0): Prisma.InputJsonValue | null {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 64).map((item) => redacted(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, child]) => [key, SECRET_PATH.test(key) ? '[redacted]' : redacted(child, depth + 1)]));
  }
  if (typeof value === 'string') return value.slice(0, 512);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}
/** A redacted OBJECT, for a Json column (an object stays an object). */
const redactedObject = (value: Record<string, unknown>): Prisma.InputJsonValue => redacted(value) as Prisma.InputJsonValue;

/** The return path as a short hint (success, error, …): stored for people, never evidence of anything [F5]. */
function hintFrom(outcome: unknown): string | null {
  const text = typeof outcome === 'string' ? outcome.toLowerCase() : '';
  return /^[a-z0-9_-]{1,32}$/.test(text) ? text : null;
}

/** mmg_txn_canon: an MMG transaction id trimmed and upper-cased. */
function canonicalMmgTxn(id: string): string {
  return id.trim().toUpperCase();
}

/** [Sol, DS659 · delta3] The operators' page for one unapplied payment: per
 *  checkout and transaction, the transaction in its canonical spelling. */
function unappliedPageKey(checkoutId: string, canonicalTxn: string): string {
  return `mmg-checkout-unapplied:${checkoutId}:${canonicalTxn}`;
}

function returnStateFor(status: CheckoutStatus): ReturnState {
  if (status === 'CONFIRMED') return 'CONFIRMED';
  if (status === 'NOT_PAID') return 'NOT_PAID';
  return 'CONFIRMING';
}

function minorOf(intent: Pick<MmgCheckoutIntent, 'amount' | 'currencyCode'>): number {
  return Number(fromMajor(intent.amount.toString(), intent.currencyCode).minor);
}

/**
 * [F1] Whether MMG's own answer ties a transaction to THIS checkout: its
 * confirmed reference field(s) carry exactly our reference, whole, and nothing
 * else. Never a substring, never "appears somewhere in the answer".
 */
export type Binding = 'BOUND' | 'NOT_ECHOED' | 'MISMATCH' | 'AMBIGUOUS';
export function bindingOf(merchantTransactionId: string, echoedReferences: readonly string[]): Binding {
  const distinct = [...new Set(echoedReferences)];
  if (distinct.length === 0) return 'NOT_ECHOED';
  if (distinct.length > 1) return 'AMBIGUOUS';
  return distinct[0] === merchantTransactionId ? 'BOUND' : 'MISMATCH';
}

/**
 * [owner, 1 Oct · DS632] One of MMG's times as an instant ([7 Oct] history's
 * modificationDate; the lookup's creationDate was read so before 7 Oct), read
 * in the configured zone (MMG_CHECKOUT_CREATION_ZONE). GUYANA_WALL_CLOCK reads a stamp
 * with "Z" or no zone as Guyana wall-clock time: what MMG UAT writes (a checkout
 * opened at 15:38:19 Guyana time, 19:38:19Z, was paid with creationDate
 * "2026-10-01T15:39:36.526Z"). UTC reads "Z" as UTC and cannot read a stamp
 * with no zone. An explicit numeric offset is honoured as stated in both.
 * Anything else cannot be read: null.
 */
const MMG_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})?$/;
export function mmgCreationInstant(stamp: string | null, zone: MmgCreationZone): number | null {
  if (typeof stamp !== 'string') return null;
  const match = MMG_STAMP.exec(stamp);
  if (!match) return null;
  const [y, mo, d, h, mi, sec] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const ms = Number((match[7] ?? '').padEnd(3, '0').slice(0, 3));
  const face = new Date(Date.UTC(y, mo - 1, d, h, mi, sec, ms));
  if (face.getUTCFullYear() !== y || face.getUTCMonth() !== mo - 1 || face.getUTCDate() !== d
    || face.getUTCHours() !== h || face.getUTCMinutes() !== mi || face.getUTCSeconds() !== sec) return null;
  const offset = match[8];
  if (offset && offset !== 'Z') {
    const sign = offset.startsWith('-') ? -1 : 1;
    const offsetMs = sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * 60_000;
    return face.getTime() - offsetMs;
  }
  if (zone === 'UTC') return offset === 'Z' ? face.getTime() : null;
  if (zone === 'GUYANA_WALL_CLOCK') return instantOfGuyanaWallClock(face).getTime();
  return null;
}

/**
 * [DS632] What condition (5) needs beyond MMG's stamp: the zone it is read in
 * (null: unverified, so nothing confirms automatically), and when Swift first
 * observed a reply naming the transaction. MMG cannot have created a payment
 * after Swift heard about it: a stamp later than that (two minutes'
 * tolerance) means MMG's stamps do not match the configured zone. A
 * transaction no reply named cannot be bounded and holds the same way (the
 * service always has the time: every candidate comes from a reply written
 * down first [I9]).
 */
export interface CreationCheck {
  zone: MmgCreationZone | null;
  firstReplyAt: Date | null;
  /** [7 Oct] MMG's Transaction History for the transaction, as written down
   *  (paymentHistoryOf). Absent or null: not asked, and nothing confirms. */
  history?: PaymentHistory | null;
}
const UNVERIFIED: CreationCheck = { zone: null, firstReplyAt: null };

/** [DS632] When Swift first observed a reply, through either door, naming this transaction. */
export function firstReplyNaming(answers: ReadonlyArray<{ body: unknown; createdAt: Date }>, txnId: string): Date | null {
  let first: Date | null = null;
  for (const answer of answers) {
    const body = answer.body && typeof answer.body === 'object' && !Array.isArray(answer.body) ? answer.body as Record<string, unknown> : null;
    if (body?.['transactionId'] !== txnId) continue;
    if (!first || answer.createdAt < first) first = answer.createdAt;
  }
  return first;
}

/** [DS632 · Fable S3-1] The creation zone of the checkout provider in use:
 *  null when there is none (switched off) or it cannot be built. verify() and
 *  the support console both read it here, so they never disagree. */
export function creationZoneInUse(checkout: () => MmgCheckoutProvider | null): MmgCreationZone | null {
  try {
    return checkout()?.creationZone ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// [7 Oct] Condition (5) from MMG's Transaction History. MMG said (7 Oct) that
// the lookup's creationDate is the moment of the LOOKUP, and that history's
// modificationDate is when the transaction was performed. MMG UAT (7 Oct):
// a history row names the checkout's transactionId in BOTH
// transactionReference and transactionReceipt, says "completed", and writes
// its time as Guyana wall clock with a "Z", as the lookup does; the query's
// dates are read the same way, and its `offset` is a row COUNT, oldest first.
// ---------------------------------------------------------------------------

/** The one transactionStatus history writes for a finished payment (UAT, 7 Oct). Anything else holds. */
export const MMG_HISTORY_SUCCESS: readonly string[] = ['completed'];

/** The history query for one checkout: every row from two minutes and the
 *  margin before it opened, to two minutes and the margin after the first
 *  reply naming the transaction or its deadline, whichever is first, and
 *  never past now; up to MMG_HISTORY_ROWS rows. */
export function historyQueryFor(
  intent: Pick<MmgCheckoutIntent, 'createdAt' | 'expiresAt'>, firstReplyAt: Date, zone: MmgCreationZone, now: Date,
): MmgHistoryQuery {
  const bound = new Date(Math.min(intent.expiresAt.getTime(), firstReplyAt.getTime()));
  return mmgHistoryQueryFor(intent.createdAt, bound, zone, now);
}

/** The history rows that name this transaction: transactionReference or
 *  transactionReceipt IS it, a whole string. Only these are ever written
 *  down; other people's payments are not. */
export function rowsNaming(rows: readonly Record<string, unknown>[], txnId: string): Record<string, unknown>[] {
  return rows.filter((row) => row['transactionReference'] === txnId || row['transactionReceipt'] === txnId);
}

/** MMG's history for one transaction, exactly as written down [I9]: the rows
 *  naming it, and whether the answer may have been cut short at the row
 *  limit. MMG unreachable or unreadable, or a record not of this shape: error. */
export type PaymentHistory =
  | { outcome: 'rows'; naming: readonly Record<string, unknown>[]; truncated: boolean }
  | { outcome: 'error' };
/** The observation failure for a history call MMG did not answer readably. */
export const HISTORY_FAILED = 'HISTORY_FAILED';
export function paymentHistoryOf(record: { failure: string | null; body: unknown }): PaymentHistory {
  const body = record.body && typeof record.body === 'object' && !Array.isArray(record.body) ? record.body as Record<string, unknown> : null;
  const naming = body?.['naming'];
  if (record.failure === HISTORY_FAILED || !Array.isArray(naming) || typeof body?.['truncated'] !== 'boolean') return { outcome: 'error' };
  if (!naming.every((row: unknown) => !!row && typeof row === 'object' && !Array.isArray(row))) return { outcome: 'error' };
  return { outcome: 'rows', naming: naming as Record<string, unknown>[], truncated: body['truncated'] as boolean };
}

/**
 * [owner, 1 Oct · condition 5 · DS632 · 7 Oct] Where MMG's time for this
 * payment stands: the ONE check judge() credits by and the support console
 * shows [Sol, DS663 · #1422]. In order: no configured zone, nothing is
 * verified; no reply named the transaction, it cannot be bounded; MMG's
 * history could not be asked, read or seen whole (UNAVAILABLE), or has no
 * record of it (NOT_IN_HISTORY): both may resolve on a later check; more than
 * one record (AMBIGUOUS); a record that does not agree, exactly, with this
 * checkout reference (REFERENCE_MISMATCH), or its transaction numbers, status,
 * amount or currency (DISAGREES); a
 * time that cannot be read; a time more than two minutes after Swift first
 * heard of the payment (MMG's times do not match the zone, or it is not this
 * checkout's payment); outside the checkout's window (two minutes either side).
 * The lookup's creationDate plays no part: it is the lookup's own moment.
 */
export type CreationCheckResult = 'INSIDE' | 'ZONE_UNVERIFIED' | 'UNAVAILABLE' | 'NOT_IN_HISTORY' | 'AMBIGUOUS' | 'REFERENCE_MISMATCH' | 'DISAGREES' | 'UNREADABLE' | 'AFTER_REPLY' | 'OUTSIDE';
export function paymentTimeCheckOf(
  intent: Pick<MmgCheckoutIntent, 'merchantTransactionId' | 'createdAt' | 'expiresAt' | 'amount' | 'currencyCode'>, txnId: string, creation: CreationCheck,
): CreationCheckResult {
  if (creation.zone === null) return 'ZONE_UNVERIFIED';
  if (creation.firstReplyAt === null) return 'AFTER_REPLY';
  const history = creation.history;
  if (!history || history.outcome !== 'rows') return 'UNAVAILABLE';
  if (history.naming.length === 0) return history.truncated ? 'UNAVAILABLE' : 'NOT_IN_HISTORY';
  if (history.naming.length > 1) return 'AMBIGUOUS';
  if (history.truncated) return 'UNAVAILABLE';
  const row = historyRowFrom(history.naming[0]!);
  if (row.externalId === null || row.externalId !== intent.merchantTransactionId) return 'REFERENCE_MISMATCH';
  if (row.transactionReference !== txnId || row.transactionReceipt !== txnId
    || row.statusText === null || !MMG_HISTORY_SUCCESS.includes(row.statusText)
    || row.amountMinor === null || row.amountMinor !== minorOf(intent)
    || row.currencyCode !== 'GYD' || intent.currencyCode !== 'GYD') return 'DISAGREES';
  const paid = mmgCreationInstant(row.modificationDate, creation.zone);
  if (paid === null) return 'UNREADABLE';
  if (paid > creation.firstReplyAt.getTime() + CHECKOUT_CLOCK_TOLERANCE_MS) return 'AFTER_REPLY';
  if (paid < intent.createdAt.getTime() - CHECKOUT_CLOCK_TOLERANCE_MS || paid > intent.expiresAt.getTime() + CHECKOUT_CLOCK_TOLERANCE_MS) return 'OUTSIDE';
  return 'INSIDE';
}
/** The hold for each answer; `retry`: it may resolve on a later check. */
const PAYMENT_TIME_HOLDS: Record<Exclude<CreationCheckResult, 'INSIDE'>, { reason: string; retry: boolean }> = {
  ZONE_UNVERIFIED: { reason: 'CREATION_ZONE_UNVERIFIED', retry: false },
  UNAVAILABLE: { reason: 'PAYMENT_TIME_UNAVAILABLE', retry: true },
  NOT_IN_HISTORY: { reason: 'PAYMENT_TIME_NOT_IN_HISTORY', retry: true },
  AMBIGUOUS: { reason: 'PAYMENT_TIME_AMBIGUOUS', retry: false },
  REFERENCE_MISMATCH: { reason: 'HISTORY_REFERENCE_MISMATCH', retry: false },
  DISAGREES: { reason: 'PAYMENT_TIME_DISAGREES', retry: false },
  UNREADABLE: { reason: 'PAYMENT_TIME_UNREADABLE', retry: false },
  AFTER_REPLY: { reason: 'PAYMENT_TIME_AFTER_REPLY', retry: false },
  OUTSIDE: { reason: 'PAYMENT_TIME_OUTSIDE_WINDOW', retry: false },
};

/** MMG's success answer for one checkout, or why there is none. */
export type SuccessAnswer = { txnId: string } | { txnId: null; reason: string };
const NO_SUCCESS: SuccessAnswer = { txnId: null, reason: 'NO_SUCCESS_ANSWER' };

/**
 * [owner, 1 Oct · condition 1] MMG's own success answer for THIS checkout:
 * ResultCode "0" naming this checkout's merchantTransactionId and one MMG
 * transactionId, received through either door while the checkout was open
 * (by its deadline, two minutes' tolerance). A not-paid answer (1, 2, 6, 7)
 * for the same checkout, or success naming two transactions, is a
 * disagreement a person resolves. 3, 4 and 5 are configuration alerts, not
 * payment answers. `answers` are the checkout's RETURN and NOTIFY records.
 */
export function successAnswerOf(
  intent: Pick<MmgCheckoutIntent, 'merchantTransactionId' | 'expiresAt' | 'status'>,
  answers: ReadonlyArray<{ detail: string | null; body: unknown; createdAt: Date }>,
): SuccessAnswer {
  const named = (body: unknown) => (body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null);
  const success = answers.filter((answer) => answer.detail === SUCCESS_ANSWER
    && named(answer.body)?.['merchantTransactionId'] === intent.merchantTransactionId
    && typeof named(answer.body)?.['transactionId'] === 'string');
  if (success.length === 0) return NO_SUCCESS;
  if (answers.some((answer) => NEGATIVE_ANSWERS.includes(answer.detail ?? ''))) return { txnId: null, reason: 'MMG_ANSWERS_DISAGREE' };
  const txns = [...new Set(success.map((answer) => named(answer.body)!['transactionId'] as string))];
  if (txns.length !== 1) return { txnId: null, reason: 'MMG_ANSWERS_DISAGREE' };
  if (!success.some((answer) => answer.createdAt.getTime() <= intent.expiresAt.getTime() + CHECKOUT_CLOCK_TOLERANCE_MS)) {
    return { txnId: null, reason: 'SUCCESS_ANSWER_AFTER_CLOSE' };
  }
  if (intent.status !== 'CONFIRMING' && intent.status !== 'EXPIRED') return { txnId: null, reason: 'CHECKOUT_NOT_OPEN' };
  return { txnId: txns[0]! };
}

/** `decisiveWhenLate`: [7 Oct] a hold that may resolve on a later check
 *  (MMG's history not yet showing the payment, or not answering) waits out
 *  the confirmation window, but on a late check of a checkout MMG's answer
 *  ties it to, a person looks at once: money MMG holds is never dropped. */
type Hold = { verdict: 'HOLD'; txnId: string; reason: string; decisive: boolean; decisiveWhenLate?: boolean };
type Declined = { verdict: 'DECLINED'; txnId: string; reason: string; bound: boolean };
type Verdict =
  /** `ledgerReference`: MMG's ledger number for the payment, credited with it [owner condition 6]. */
  | { verdict: 'CONFIRM'; txnId: string; ledgerReference: string }
  /** `decisive`: a person must look now. A mismatch on a record that MMG's
   *  answer does not tie to this checkout may be another transaction the
   *  replies named, so it waits out the confirmation window before holding. */
  | Hold
  /** `bound`: MMG's answer ties the failure to THIS checkout; the only
   *  failure a partner is ever told about [F5]. */
  | Declined
  | { verdict: 'PENDING' | 'NOT_FOUND' | 'ERROR'; txnId: string };

/** What one lookup answer means for one checkout. `otherCheckoutRefs` are OUR
 *  other checkouts' references that the answer names (whole values): a
 *  contradiction a person must resolve [F1]. `success` is MMG's own success
 *  answer for this checkout (successAnswerOf). `creation` is how MMG's time for
 *  the payment is found, read and bounded [DS632 · 7 Oct]: the zone, the first
 *  reply naming it, and MMG's history for it; without it nothing is confirmed. */
export function judge(
  intent: Pick<MmgCheckoutIntent, 'merchantTransactionId' | 'amount' | 'currencyCode' | 'createdAt' | 'expiresAt'>,
  txnId: string,
  detail: MmgLookupDetail,
  merchantIds: string[],
  otherCheckoutRefs: readonly string[] = [],
  success: SuccessAnswer = NO_SUCCESS,
  creation: CreationCheck = UNVERIFIED,
): Verdict {
  if (detail.outcome === 'not_found') return { verdict: 'NOT_FOUND', txnId };
  if (detail.outcome === 'error') return { verdict: 'ERROR', txnId };
  const binding = bindingOf(intent.merchantTransactionId, detail.echoedReferences);
  const bound = binding === 'BOUND' && otherCheckoutRefs.length === 0;
  if (detail.status === 'approved') {
    const hold = (reason: string, decisive: boolean): Verdict => ({ verdict: 'HOLD', txnId, reason, decisive });
    // [F1] Contradictory: MMG ties this payment to another checkout, to another
    // reference, or to more than one.
    if (otherCheckoutRefs.length > 0) return hold('REFERENCE_OF_ANOTHER_CHECKOUT', true);
    if (binding === 'MISMATCH') return hold('REFERENCE_MISMATCH', true);
    if (binding === 'AMBIGUOUS') return hold('REFERENCE_AMBIGUOUS', true);
    // (1) MMG's success answer for this checkout named this transaction.
    const answered = success.txnId === txnId;
    const tied = answered || bound;
    // (2) MMG's own word, exactly.
    if (detail.statusText !== 'successful') return hold('STATUS_NOT_SUCCESSFUL', tied);
    // (4) Exactly the amount asked, in GYD.
    if (detail.amountMinor === null || detail.amountMinor !== minorOf(intent)) return hold('AMOUNT_MISMATCH', tied);
    if (detail.currencyCode !== 'GYD' || intent.currencyCode !== 'GYD') return hold('CURRENCY_MISMATCH', tied);
    // (3) Paid to this checkout's merchant: every "accountid" credit party is it.
    if (!detail.creditAccounts || detail.creditAccounts.length === 0) return hold('MERCHANT_UNCONFIRMED', tied);
    if (!detail.creditAccounts.every((account) => merchantIds.some((merchant) => sameMsisdn(merchant, account)))) return hold('MERCHANT_MISMATCH', tied);
    // (5) MMG's time for the payment fits this checkout [DS632]: its history
    // record's time, never the lookup's own clock [7 Oct]; the one check
    // support shows too (paymentTimeCheckOf).
    const time = paymentTimeCheckOf(intent, txnId, creation);
    if (time !== 'INSIDE') {
      const { reason, retry } = PAYMENT_TIME_HOLDS[time];
      return retry ? { verdict: 'HOLD', txnId, reason, decisive: false, decisiveWhenLate: tied } : hold(reason, time === 'REFERENCE_MISMATCH' || tied);
    }
    // (6) MMG's ledger number is credited with the transaction, once (confirm).
    if (!detail.ledgerReference || !MMG_TXN_ID.test(detail.ledgerReference)) return hold('LEDGER_REFERENCE_MISSING', tied);
    // Everything matches, but only MMG's success answer for THIS checkout
    // attributes the payment to it. Without it, a person attributes it.
    if (!answered) return hold(success.txnId === null ? success.reason : 'NOT_THE_ANSWERED_TRANSACTION', true);
    return { verdict: 'CONFIRM', txnId, ledgerReference: detail.ledgerReference };
  }
  if (detail.status === 'declined' || detail.status === 'expired' || detail.status === 'reversed') {
    return { verdict: 'DECLINED', txnId, reason: `MMG_${detail.status.toUpperCase()}`, bound };
  }
  return { verdict: 'PENDING', txnId };
}

/** [DS632 · 7 Oct] What operators need besides the reason code when the cause
 *  is MMG's time for the payment. */
const HOLD_GUIDANCE: Readonly<Record<string, string>> = {
  CREATION_ZONE_UNVERIFIED: ' MMG_CHECKOUT_CREATION_ZONE is not set to GUYANA_WALL_CLOCK or UTC, so the time MMG gives for the payment cannot be checked against the checkout, and no MMG payment is confirmed automatically. Set it to GUYANA_WALL_CLOCK (MMG writes Guyana time; owner ruling, 4 Oct).',
  PAYMENT_TIME_NOT_IN_HISTORY: ' MMG’s lookup says the payment succeeded, but MMG’s transaction history did not show it for the checkout’s time while Swift kept checking. If every MMG payment is held like this, check MMG_CHECKOUT_CREATION_ZONE against how MMG writes its times. Check the payment against the MMG statement before confirming it.',
  PAYMENT_TIME_UNAVAILABLE: ' MMG’s transaction history could not be read in full, so the time of this payment could not be checked. Check the payment against the MMG statement before confirming it.',
  PAYMENT_TIME_AMBIGUOUS: ' MMG’s transaction history shows more than one record of this transaction. Check the payment against the MMG statement before confirming it.',
  HISTORY_REFERENCE_MISMATCH: ' MMG’s transaction history is missing this checkout reference or names a different checkout reference. Nothing was credited. Match the checkout reference against the MMG statement before confirming it.',
  PAYMENT_TIME_DISAGREES: ' MMG’s transaction history record of this transaction does not match the checkout (its numbers, its status, the amount or the currency). Check the payment against the MMG statement before confirming it.',
  PAYMENT_TIME_UNREADABLE: ' MMG’s transaction history gives a time for this payment that cannot be read. Check the payment against the MMG statement before confirming it.',
  PAYMENT_TIME_AFTER_REPLY: ' MMG’s transaction history dates this payment after Swift had already received the MMG reply naming it: either MMG_CHECKOUT_CREATION_ZONE does not match how MMG writes times, or the payment is not this checkout’s. Check the payment against the MMG statement before confirming it.',
  PAYMENT_TIME_OUTSIDE_WINDOW: ' MMG’s transaction history dates this payment outside the time the checkout was open. Check the payment against the MMG statement before confirming it.',
  // Held before 7 Oct, when MMG's lookup creationDate was read as the payment time; kept for those rows.
  CREATION_AFTER_REPLY: ' MMG says this payment was made after Swift had already received the MMG reply naming it, so the creationDate stamps from MMG may not match the configured MMG_CHECKOUT_CREATION_ZONE. Check that setting against a real payment before trusting any automatic confirmation.',
};

const HOLD_REASON: Record<ProviderIdentityCode, string> = {
  PROVIDER_TXN_ALREADY_CREDITED: 'ALREADY_CREDITED',
  PROVIDER_TXN_AMOUNT_CONFLICT: 'AMOUNT_CONFLICT_ON_RECORD',
  PROVIDER_TXN_TENANT_CONFLICT: 'TENANT_CONFLICT_ON_RECORD',
};

export class MmgCheckoutService {
  private readonly checkout: () => MmgCheckoutProvider;
  private readonly lookup: () => MmgLookupClient;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly billing: BillingService,
    private readonly notifications: NotificationService,
    /** Injectable for tests; the defaults follow MMG_DRIVER. */
    deps: { checkout?: () => MmgCheckoutProvider; lookup?: () => MmgLookupClient } = {},
  ) {
    this.checkout = deps.checkout ?? (() => getMmgCheckoutProvider());
    this.lookup = deps.lookup ?? (() => getMmgLookupProvider());
  }

  /** THE rule (fee-pay-actions.ts), with this service's checkout provider. */
  async isLiveFor(sub: Pick<Subscription, 'status' | 'feeWaived' | 'currencyCode' | 'weeklyRate' | 'customRate'>, platform: ClientPlatform): Promise<boolean> {
    return mmgCheckoutLive(this.prisma, sub, platform, this.checkout);
  }

  /** Start a checkout, or hand back the one already open [I4]. `created`
   *  tells the route whether this call made it (201) or found it (200). */
  async createCheckout(input: { subscriptionId: string; userId: string; platform: ClientPlatform; clientKey: unknown; now?: Date }): Promise<{ created: boolean; checkout: StartedCheckout }> {
    const clientKey = typeof input.clientKey === 'string' && CLIENT_KEY.test(input.clientKey) ? input.clientKey : null;
    if (!clientKey) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Starting a checkout needs an Idempotency-Key header of 8-128 letters, digits, - or _. The same key on a retry returns the same checkout.');
    }
    const now = input.now ?? new Date();
    const who = { userId: input.userId, subscriptionId: input.subscriptionId, clientKey };

    // [F3] A key that was ever answered keeps its answer: never a new checkout.
    const replay = await this.answerForKey(who, now);
    if (replay) return replay;

    const sub = await this.prisma.subscription.findUnique({ where: { id: input.subscriptionId } });
    if (!sub) throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'There is no subscription to pay.');
    if (!(await this.isLiveFor(sub, input.platform))) {
      throw new AppError(409, 'PAY_ACTION_OFF', 'Paying with MMG is not available for this account here.');
    }

    for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
      // [I4] One open checkout per subscription, read again after any expiry or lost race.
      const open = await this.prisma.mmgCheckoutIntent.findFirst({
        where: { subscriptionId: sub.id, status: { in: ['OPEN', 'CONFIRMING'] } },
      });
      if (open?.status === 'CONFIRMING') {
        // [F3] Bound to the checkout it was refused for: once that resolves, a
        // retry of this tap still opens nothing new.
        const bound = await this.bindKey(who, open, now);
        if (bound.intentId !== open.id) return bound.answer();
        throw new AppError(409, 'CHECKOUT_CONFIRMING', 'An earlier MMG payment is being confirmed. Do not pay again.', { ref: open.id });
      }
      if (open && open.expiresAt > now) {
        return (await this.bindKey(who, open, now)).answer();
      }
      if (open) {
        // [F4] Past its time: expired only if it is STILL an unanswered OPEN
        // checkout, then read again: a reply may have made it CONFIRMING.
        await this.expireUnanswered(open.id, now);
        continue;
      }

      // [I1] Priced here, from payInfo's own amount due.
      const priced = await payInfo(this.prisma, sub);
      const amountGyd = checkoutAmountGyd(priced);
      const quoteBasis = checkoutQuoteBasis(sub);
      const quotedAuthority = await readFeeCollectionAuthority(this.prisma, sub.id);
      const merchantTransactionId = newMerchantTransactionId(now);
      let checkoutUrl: string;
      try {
        checkoutUrl = this.checkout().createCheckout({ amount: fromMajor(String(amountGyd), 'GYD'), merchantTransactionId, now }).checkoutUrl;
      } catch (err) {
        log().error({ err, subscriptionId: sub.id }, '[MMG checkout] the checkout could not be built');
        throw new AppError(503, 'MMG_CHECKOUT_UNAVAILABLE', 'The MMG checkout could not be started right now. Try again in a minute.');
      }
      // [F6] The page is sealed before it is written down; with no master key
      // there is no checkout at all.
      const sealed = await sealCheckoutUrl(checkoutUrl);

      // Persisted, with the key that asked for it, BEFORE the page leaves the
      // server: a checkout nobody wrote down could be paid and never found.
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          const authority = await lockBillingAuthority(tx, sub.id);
          if (authority.userId !== input.userId) throw new NotFoundError('Subscription', sub.id);
          const decision = await lockFeePaymentDecision(tx, sub.id, new Date());
          if (!decision.allowed) return { kind: 'blocked' as const };
          const fresh = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });
          const currentAuthority = await readFeeCollectionAuthority(tx, sub.id);
          const before = quotedAuthority.mover?.revision ?? null;
          const after = currentAuthority.mover?.revision ?? null;
          const sameRevision = before === after || (before === 0 && after === 1);
          const wallet = await tx.prepaidBalance.findUnique({ where: { subscriptionId: sub.id }, select: { balance: true } });
          const freshAmount = checkoutAmountGyd({ weeklyFeeGyd: weeklyFeeAmount(fresh), amountDueGyd: await amountDueNow(tx, fresh) });
          if (!sameRevision || (quotedAuthority.mover?.feeType ?? sub.type) !== (currentAuthority.mover?.feeType ?? fresh.type)
            || quoteBasis !== checkoutQuoteBasis(fresh) || freshAmount !== amountGyd
            || Number(wallet?.balance ?? 0) !== priced.walletBalanceGyd
            || !await mmgCheckoutLive(tx, fresh, input.platform, this.checkout)) return { kind: 'quoteChanged' as const };

          const created = await tx.mmgCheckoutIntent.create({
            data: {
              tenantId: authority.tenantId,
              subscriptionId: sub.id,
              merchantTransactionId,
              amount: amountGyd,
              currencyCode: 'GYD',
              createdByUserId: input.userId,
              platform: input.platform,
              ...sealed,
              expiresAt: new Date(now.getTime() + MMG_CHECKOUT_TTL_MS),
            },
          });
          await beginConfirmationInTx(tx, sub.id, { checkoutId: created.id }, 'MMG_CHECKOUT_PENDING', now);
          await tx.mmgCheckoutKey.create({ data: { tenantId: authority.tenantId, createdByUserId: input.userId, clientKey, intentId: created.id } });
          return { kind: 'reserved' as const, intent: created };
        });
        if (result.kind === 'blocked') {
          // [F3 · I4] The hold that blocked this tap may be a concurrent tap's
          // checkout: the same key keeps that answer, and any other tap is
          // handed the open one (the next pass binds this key to it). Anything
          // else is another payment being confirmed: nothing new is issued.
          const again = await this.answerForKey(who, now);
          if (again) return again;
          const open = await this.prisma.mmgCheckoutIntent.findFirst({
            where: { subscriptionId: sub.id, status: { in: ['OPEN', 'CONFIRMING'] } }, select: { id: true },
          });
          if (open) continue;
          throw new AppError(409, 'PAYMENT_CONFIRMING', 'Weekly-fee collection is paused while payment information is confirmed.');
        }
        if (result.kind === 'quoteChanged') throw new AppError(409, 'PAYMENT_QUOTE_CHANGED', 'The weekly fee changed. Reload it before opening a payment page.');
        mmgCheckoutEventsCounter.labels('created').inc();
        return { created: true, checkout: await this.started(result.intent, input.userId) };
      } catch (err) {
        if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        // [F3] A concurrent request won: the same key (its answer, for its own
        // subscription only), or another open checkout (read again).
        const again = await this.answerForKey(who, now);
        if (again) return again;
      }
    }
    throw new AppError(503, 'MMG_CHECKOUT_UNAVAILABLE', 'The MMG checkout could not be started right now. Try again in a minute.');
  }

  /** One checkout of this subscription, or 404 (the same answer for someone else's). */
  async getCheckout(input: { ref: string; subscriptionId: string }): Promise<CheckoutView> {
    const intent = await this.prisma.mmgCheckoutIntent.findFirst({ where: { id: input.ref, subscriptionId: input.subscriptionId } });
    if (!intent) throw new AppError(404, 'CHECKOUT_NOT_FOUND', 'There is no such checkout.');
    const sub = await this.prisma.subscription.findUnique({ where: { id: intent.subscriptionId }, select: { status: true } });
    return this.view(intent, sub?.status ?? 'CANCELLED');
  }

  /**
   * A reply from MMG — the partner's browser through the web return page
   * (RETURN), or MMG's own server (NOTIFY). Every value is tried as a token;
   * the first that decrypts is the reply. Answers only the state for the page:
   * never an amount, a name or a checkout id.
   */
  async observeReply(input: { source: 'RETURN' | 'NOTIFY'; outcome?: unknown; params: unknown }): Promise<ReturnState> {
    return runAsSystem('mmg-checkout-reply', async () => {
      const now = new Date();
      const hint = hintFrom(input.outcome);
      let provider: MmgCheckoutProvider | null = null;
      try {
        provider = this.checkout();
      } catch {
        provider = null;
      }
      let reply: Record<string, unknown> | null = null;
      if (provider && provider.driver !== 'disabled') {
        for (const value of replyParams(input.params)) {
          try {
            reply = provider.decryptCheckoutResult(value);
            break;
          } catch {
            // not a token for us; try the next value
          }
        }
      }
      if (!reply) {
        await this.observe({ source: input.source, detail: hint, failure: 'NO_TOKEN' });
        mmgCheckoutEventsCounter.labels('reply_unmatched').inc();
        return 'UNKNOWN';
      }

      const parsed = checkoutReplyFrom(reply);
      const intent = parsed ? await this.prisma.mmgCheckoutIntent.findUnique({ where: { merchantTransactionId: parsed.merchantTransactionId } }) : null;
      const resultHint = parsed ? `MMG_RESULT_${parsed.resultCode}` : null;
      await this.observe({
        // [F7] Filed under the checkout's own tenant; an unmatched reply has none.
        tenantId: intent?.tenantId ?? null,
        intentId: intent?.id ?? null,
        source: input.source,
        detail: resultHint ?? hint,
        body: redactedObject(reply),
        shape: describeShape(reply) as Prisma.InputJsonValue,
        failure: !parsed ? 'INVALID_RESPONSE' : intent ? null : 'NO_CHECKOUT',
      });
      if (!intent || !parsed) {
        mmgCheckoutEventsCounter.labels('reply_unmatched').inc();
        return 'UNKNOWN';
      }
      mmgCheckoutEventsCounter.labels('reply').inc();
      const configFailure = CONFIG_FAILURES[parsed.resultCode];
      if (configFailure) {
        // 3, 4, 5: MMG refused OUR request (secret key, merchant id, token). A
        // configuration or security fault, never a payment state: written down
        // above, operators paged once per checkout and code whatever the
        // checkout's state, and the checkout itself is never touched. Nothing
        // is looked up, held or credited.
        await this.alertRefusedRequest(intent, parsed.resultCode, configFailure, input.source);
        return 'UNKNOWN';
      }
      if (intent.status === 'CONFIRMED') {
        await this.alertUnapplied(intent, parsed, input.source);
        return 'CONFIRMED';
      }
      if (intent.status === 'HELD') return 'CONFIRMING';

      // Return, notify and poll can overlap. Merge against the locked current
      // row, preserving both candidates and the first reply's timestamp. MMG's
      // own not-paid answer for THIS checkout releases the confirmation pause
      // in the same transaction, unless a success answer was ever given for it.
      const merged = await this.prisma.$transaction(async (tx) => {
        await lockBillingAuthority(tx, intent.subscriptionId);
        await tx.$queryRaw`SELECT "id" FROM "mmg_checkout_intents" WHERE "id" = ${intent.id} FOR UPDATE`;
        const current = await tx.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: intent.id } });
        if (current.status === 'CONFIRMED') return 'CONFIRMED' as const;
        if (current.status === 'HELD') return 'UNCHANGED' as const;
        const named = parsed.transactionId ? [parsed.transactionId] : [];
        const candidates = [...new Set([...current.candidates, ...named])].slice(0, MAX_CANDIDATES);
        const replyAt = !current.replyAt || now < current.replyAt ? now : current.replyAt;
        const outcomeHint = current.outcomeHint ?? resultHint;
        if (await this.answerProvesUnpaid(tx, current, parsed)) {
          const moved = await tx.mmgCheckoutIntent.updateMany({
            where: { id: current.id, status: current.status },
            data: {
              status: 'NOT_PAID', reason: `MMG_RESULT_${parsed.resultCode}`, candidates, replyAt, outcomeHint,
              // A transaction the answer named is still looked at: a late
              // confirmation credits once, a late paid record is held [I8].
              nextCheckAt: candidates.length > 0 && now.getTime() < replyAt.getTime() + LATE_WINDOW_MS ? new Date(now.getTime() + LATE_CHECK_MS) : null,
            },
          });
          if (moved.count !== 1) throw new Error(`Locked checkout ${current.id} changed under its reply`);
          await resolveConfirmationInTx(tx, current.subscriptionId, { checkoutId: current.id }, 'PROVEN_UNPAID',
            { actor: 'mmg-checkout-reply', reference: `${current.merchantTransactionId}:MMG_RESULT_${parsed.resultCode}` }, now);
          return 'RELEASED' as const;
        }
        await tx.mmgCheckoutIntent.updateMany({
          where: { id: current.id, status: current.status },
          data: { candidates, replyAt, outcomeHint, nextCheckAt: now, ...(current.status === 'OPEN' ? { status: 'CONFIRMING' } : {}) },
        });
        return 'UNCHANGED' as const;
      });
      if (merged === 'RELEASED') {
        mmgCheckoutEventsCounter.labels('not_paid').inc();
        await this.tellPartner(intent, 'NOT_PAID');
        return 'NOT_PAID';
      }
      if (merged === 'CONFIRMED') {
        // Confirmed while this reply waited for the lock.
        await this.alertUnapplied(await this.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: intent.id } }), parsed, input.source);
        return 'CONFIRMED';
      }
      // [Sol · delta2] What verify() returns was decided on rows it read before
      // its own writes: another verifier may confirm the checkout meanwhile
      // (verify's own compare-and-set then matches nothing and it still says
      // CONFIRMING). So the committed row is read again AFTER verification,
      // however verification ends, and decides both the answer and the page:
      // a CONFIRMED checkout, credited by another transaction than this reply
      // names, pages operators once (alertUnapplied); a reply naming the
      // credited payment changes nothing.
      try {
        await this.verify(intent.id, now);
      } finally {
        const settled = await this.prisma.mmgCheckoutIntent.findUnique({ where: { id: intent.id } });
        if (settled?.status === 'CONFIRMED') await this.alertUnapplied(settled, parsed, input.source);
      }
      const committed = await this.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: intent.id }, select: { status: true } });
      return returnStateFor(committed.status as CheckoutStatus);
    });
  }

  /** Every two minutes (the poll-mmg-billing job): first make sure every
   *  earlier credit carries its provider identity [F2], then expire the
   *  checkouts no reply ever came for, and look again at every one that is due. */
  async pollIntents(now: Date = new Date()): Promise<{ expired: number; checked: number }> {
    return runAsSystem('mmg-checkout-poll', async () => {
      const out = { expired: 0, checked: 0 };
      try {
        const backfill = await ensureProviderIdentityBackfill(this.prisma);
        if (backfill && backfill.conflicts > 0) {
          await notifyAdmins(this.prisma, this.notifications, {
            tenantId: null,
            title: 'MMG payments credited more than once before',
            body: `The provider-identity backfill found ${backfill.conflicts} earlier credit(s) naming an MMG transaction already on record for another credit, account or amount. Nothing was changed. Reconcile them against the MMG statement.`,
            data: { kind: 'billing_invariants', alert: 'provider-identity-backfill-conflicts', conflicts: backfill.conflicts },
          }).catch(() => {});
        }
      } catch (err) {
        log().error({ err }, '[MMG checkout] the provider-identity backfill failed; checkout crediting stays off until it completes');
      }
      try {
        await this.pruneUnmatchedObservations(now);
      } catch (err) {
        log().error({ err }, '[MMG checkout] pruning unmatched observations failed; it is retried on the next poll');
      }
      const stale = await this.prisma.mmgCheckoutIntent.findMany({
        where: { status: 'OPEN', expiresAt: { lte: now } },
        select: { id: true },
        take: POLL_BATCH,
      });
      for (const row of stale) if (await this.expireUnanswered(row.id, now)) out.expired += 1;
      const due = await this.prisma.mmgCheckoutIntent.findMany({
        where: { status: { in: ['CONFIRMING', 'EXPIRED', 'NOT_PAID'] }, nextCheckAt: { lte: now } },
        orderBy: { nextCheckAt: 'asc' },
        select: { id: true },
        take: POLL_BATCH,
      });
      for (const row of due) {
        try {
          await this.verify(row.id, now);
          out.checked += 1;
        } catch (err) {
          log().error({ err, checkoutId: row.id }, '[MMG checkout] verification failed; it stays due and is retried');
        }
      }
      try {
        await this.reconcileUnappliedPages(now);
      } catch (err) {
        log().error({ err }, '[MMG checkout] the unapplied-payment page reconcile failed; it is retried on the next poll');
      }
      return out;
    });
  }

  /**
   * [DS611] A reply that decrypts to no checkout of ours, or not at all, is
   * written down like any other [I9], so garbage posts grow the table. Those
   * unmatched rows are pruned here in one bounded batch per call, oldest
   * first. A checkout's own replies and lookups are its evidence (audit, a
   * held payment, a late confirmation) and are never pruned.
   */
  async pruneUnmatchedObservations(now: Date = new Date(), batch = MMG_OBSERVATION_PRUNE_BATCH): Promise<number> {
    return runAsSystem('mmg-checkout-prune', async () => {
      const rows = await this.prisma.mmgCheckoutObservation.findMany({
        where: { intentId: null, OR: [
          { failure: 'NO_TOKEN', createdAt: { lt: new Date(now.getTime() - UNREADABLE_RETENTION_MS) } },
          { createdAt: { lt: new Date(now.getTime() - UNMATCHED_RETENTION_MS) } },
        ] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: batch,
        select: { id: true },
      });
      if (rows.length === 0) return 0;
      const { count } = await this.prisma.mmgCheckoutObservation.deleteMany({ where: { id: { in: rows.map((row) => row.id) }, intentId: null } });
      if (count > 0) mmgCheckoutEventsCounter.labels('observations_pruned').inc(count);
      return count;
    });
  }

  // ---------------------------------------------------------------------------

  /** MMG's own not-paid answer for THIS checkout (the reply named our
   *  reference, whole): 1 not registered, 2 failed, 6 cancelled, or 7 timed
   *  out naming no transaction when none was ever named. It releases only an
   *  unresolved checkout, and never once a success answer was given for it:
   *  then MMG's lookup decides. */
  private async answerProvesUnpaid(tx: Prisma.TransactionClient, current: MmgCheckoutIntent, reply: MmgCheckoutReply): Promise<boolean> {
    if (current.status !== 'OPEN' && current.status !== 'CONFIRMING' && current.status !== 'EXPIRED') return false;
    const timedOutEmpty = reply.resultCode === '7' && !reply.transactionId && current.candidates.length === 0;
    if (!NOT_PAID_CODES.has(reply.resultCode) && !timedOutEmpty) return false;
    const success = await tx.mmgCheckoutObservation.findFirst({
      where: { intentId: current.id, source: { in: ['RETURN', 'NOTIFY'] }, detail: SUCCESS_ANSWER }, select: { id: true },
    });
    return !success;
  }

  /** [7] "Not paid unless the lookup says paid": every transaction was named
   *  by MMG's own not-paid or timed-out answer for this checkout, none by a
   *  success answer, and MMG's lookup declines each one. Anything uncertain
   *  (pending, unknown, an error) keeps the checkout confirming. */
  private async declinedAsAnswered(intent: MmgCheckoutIntent, verdicts: Verdict[]): Promise<Declined | undefined> {
    const declined = verdicts.filter((v): v is Declined => v.verdict === 'DECLINED');
    if (declined.length === 0 || declined.length !== verdicts.length) return undefined;
    const answers = await this.prisma.mmgCheckoutObservation.findMany({
      where: { intentId: intent.id, source: { in: ['RETURN', 'NOTIFY'] }, detail: { in: [...NEGATIVE_ANSWERS, SUCCESS_ANSWER] } },
      select: { detail: true, body: true },
    });
    const namedBy = (txnId: string, details: readonly string[]) => answers.some((answer) => details.includes(answer.detail ?? '')
      && !!answer.body && typeof answer.body === 'object' && !Array.isArray(answer.body)
      && (answer.body as Record<string, unknown>)['transactionId'] === txnId);
    return declined.every((v) => namedBy(v.txnId, NEGATIVE_ANSWERS) && !namedBy(v.txnId, [SUCCESS_ANSWER])) ? declined[0] : undefined;
  }

  /** 3, 4, 5: MMG could not accept our request. Operators are paged once per
   *  checkout and code; the answer carries no provider message or HTML. */
  private async alertRefusedRequest(intent: MmgCheckoutIntent, code: MmgResultCode, reason: string, source: 'RETURN' | 'NOTIFY'): Promise<void> {
    mmgCheckoutEventsCounter.labels('reply_alert').inc();
    log().error({ checkoutId: intent.id, resultCode: code, source }, `[MMG checkout] MMG refused a checkout request (${reason}); configuration or security, nothing was credited and the checkout was not changed`);
    await notifyAdmins(this.prisma, this.notifications, {
      tenantId: intent.tenantId,
      title: 'MMG checkout: request refused by MMG',
      body: `MMG answered result code ${code} for checkout ${intent.id}. This is a configuration or security problem with the checkout request, not a payment. Nothing was credited; the checkout was not changed.`,
      data: { kind: 'billing_invariants', alert: 'mmg-checkout-reply-code', resultCode: code, reason, checkoutId: intent.id, source },
      dedupeKey: `mmg-checkout-reply-code:${intent.id}:${code}`,
    }).catch((err) => log().error({ err, checkoutId: intent.id }, '[MMG checkout] operators could not be paged about a refused request'));
  }

  /** [DS632] MMG answered success for a checkout that is already CONFIRMED,
   *  naming a transaction it did not credit (neither of MMG's two numbers for
   *  the payment it credited): money MMG may hold for the partner that was
   *  never applied. The reply is already written down [I9]. It is never
   *  looked up for credit and never credited; operators are paged once per
   *  checkout and transaction [Sol, DS659 · delta3], whichever door and however often, and whichever path made the
   *  checkout CONFIRMED (already confirmed, confirmed under the lock, or
   *  confirmed by another verifier after this reply merged) [Sol], and the
   *  verifier that credits pages for answers written down before its credit
   *  (alertUnappliedAnswers) [Sol · delta2]. */
  private async alertUnapplied(
    intent: MmgCheckoutIntent, reply: MmgCheckoutReply, source: 'RETURN' | 'NOTIFY', options: { onlyIfUnpaged?: boolean } = {},
  ): Promise<boolean> {
    if (reply.resultCode !== '0' || !reply.transactionId) return false;
    // Provider identities are stored trimmed and upper-cased (mmg_txn_canon).
    const named = canonicalMmgTxn(reply.transactionId);
    if (intent.mmgTransactionId && canonicalMmgTxn(intent.mmgTransactionId) === named) return false;
    const applied = await this.prisma.providerPayment.findFirst({
      where: { provider: 'MMG', providerTxnId: named, creditedPaymentId: `mco:${intent.id}` }, select: { id: true },
    });
    if (applied) return false;
    // [Sol, DS659 · delta3] One page per checkout AND transaction: the same
    // payment through either door collapses; a different payment pages again.
    const dedupeKey = unappliedPageKey(intent.id, named);
    if (options.onlyIfUnpaged) {
      // The reconcile pages only what no operator was ever paged about. A page
      // is only ever written once the checkout is CONFIRMED.
      // [Fable S4-4] The page's saved time comes from the database's clock, the
      // credit's from the app's: a day of slack, so clock skew never hides a
      // saved page (and the createdAt index still bounds the read).
      const since = new Date((intent.confirmedAt ?? intent.createdAt).getTime() - UNAPPLIED_PAGE_SEARCH_SLACK_MS);
      // Operators' inboxes live in their own tenants: read across them, as notifyAdmins pages across them.
      const paged = await runAsSystem('mmg-checkout-unapplied-reconcile', () => this.prisma.notification.findFirst({ where: { dedupeKey, createdAt: { gte: since } }, select: { id: true } }));
      if (paged) return false;
    }
    mmgCheckoutEventsCounter.labels('reply_unapplied').inc();
    log().error({ checkoutId: intent.id, source }, '[MMG checkout] MMG answered success for a confirmed checkout naming another transaction: money received and not applied');
    const reached = await notifyAdmins(this.prisma, this.notifications, {
      tenantId: intent.tenantId,
      title: 'MMG checkout: money received and not applied',
      body: `MMG answered success for checkout ${intent.id}, which is already paid, naming MMG transaction ${reply.transactionId}, which was not credited. Nothing was credited for it. Reconcile it against the MMG statement.`,
      data: { kind: 'billing_invariants', alert: 'mmg-checkout-unapplied', checkoutId: intent.id, transactionId: reply.transactionId, source },
      dedupeKey,
    }).catch((err) => {
      log().error({ err, checkoutId: intent.id }, '[MMG checkout] operators could not be paged about money not applied');
      return 0;
    });
    // [Fable S4-3] Sent only if an operator's inbox holds it; otherwise the
    // reconcile tries again on the next poll.
    return reached > 0;
  }

  /** [F3] The answer a key already has, if it has one: the checkout it was
   *  bound to, as it stands now, and only for the subscription it was bound for. */
  private async answerForKey(
    who: { userId: string; subscriptionId: string; clientKey: string },
    now: Date,
  ): Promise<{ created: false; checkout: StartedCheckout } | null> {
    const binding = await this.prisma.mmgCheckoutKey.findUnique({
      where: { createdByUserId_clientKey: { createdByUserId: who.userId, clientKey: who.clientKey } },
      include: { intent: true },
    });
    if (!binding) return null;
    if (binding.intent.subscriptionId !== who.subscriptionId) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'That Idempotency-Key was used for a different checkout. A new tap needs a new key.');
    }
    let intent = binding.intent;
    // An open checkout past its time is expired first: a stale MMG page is never handed out.
    if (intent.status === 'OPEN' && intent.expiresAt <= now) {
      await this.expireUnanswered(intent.id, now);
      intent = await this.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: intent.id } });
    }
    return { created: false, checkout: await this.started(intent, who.userId) };
  }

  /** [F3] Bind this key to the checkout it is being answered with. When the key
   *  is already bound (a concurrent request), its first binding wins and is the
   *  answer, checked against this subscription like any replay. */
  private async bindKey(
    who: { userId: string; subscriptionId: string; clientKey: string },
    intent: MmgCheckoutIntent,
    now: Date,
  ): Promise<{ intentId: string; answer: () => Promise<{ created: false; checkout: StartedCheckout }> }> {
    try {
      // [DS633] Filed under the checkout's own tenant, named: never whatever
      // tenant (or none) the caller's context happens to carry.
      await this.prisma.mmgCheckoutKey.create({ data: { tenantId: intent.tenantId, createdByUserId: who.userId, clientKey: who.clientKey, intentId: intent.id } });
      // Answered as it stands NOW: a reply may have moved it on since it was read,
      // and a page is only ever handed out while the checkout is still OPEN.
      return {
        intentId: intent.id,
        answer: async () => ({ created: false, checkout: await this.started(await this.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: intent.id } }), who.userId) }),
      };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      const bound = await this.answerForKey(who, now);
      if (!bound) throw err;
      return {
        intentId: bound.checkout.ref,
        answer: async () => {
          const current = await this.answerForKey(who, new Date());
          if (!current) throw new AppError(503, 'MMG_CHECKOUT_UNAVAILABLE', 'The checkout binding could not be read.');
          return current;
        },
      };
    }
  }

  /** Look up every candidate and decide. Only CONFIRM moves money. */
  private async verify(intentId: string, now: Date): Promise<CheckoutStatus> {
    const intent = await this.prisma.mmgCheckoutIntent.findUnique({ where: { id: intentId } });
    if (!intent) throw new NotFoundError('MmgCheckoutIntent', intentId);
    const status = intent.status as CheckoutStatus;
    if (status === 'CONFIRMED' || status === 'HELD' || status === 'OPEN') return status;

    let provider: MmgCheckoutProvider | null = null;
    try {
      provider = this.checkout();
    } catch {
      provider = null;
    }
    const merchantIds = this.merchantIds(provider);
    // [DS632] Condition (5) is read in the configured zone; with none, nothing confirms.
    const zone = creationZoneInUse(() => provider);
    const lookup = this.lookup();
    // [owner, 1 Oct · condition 1] MMG's own answers for this checkout, through
    // either door, and [DS632] when each transaction was first named.
    const answers = await this.prisma.mmgCheckoutObservation.findMany({
      where: { intentId: intent.id, source: { in: ['RETURN', 'NOTIFY'] } },
      select: { detail: true, body: true, createdAt: true },
    });
    const success = successAnswerOf(intent, answers);
    const verdicts: Verdict[] = [];
    for (const txnId of intent.candidates.slice(0, MAX_CANDIDATES)) {
      const detail = await lookup.transactionLookupDetail(txnId);
      mmgCheckoutLookupsCounter.labels(detail.outcome).inc();
      await this.observe({
        tenantId: intent.tenantId,
        intentId: intent.id,
        source: 'LOOKUP',
        detail: txnId,
        body: detail.outcome === 'found' ? redactedObject(detail.raw) : undefined,
        shape: detail.outcome === 'found' ? describeShape(detail.raw) as Prisma.InputJsonValue : undefined,
        failure: detail.outcome === 'not_found' ? 'LOOKUP_NOT_FOUND' : detail.outcome === 'error' ? 'LOOKUP_FAILED' : null,
      });
      const others = detail.outcome === 'found' ? await this.otherCheckoutRefsIn(detail.raw, intent) : [];
      const firstReplyAt = firstReplyNaming(answers, txnId);
      // [7 Oct] Condition (5)'s time comes from MMG's history, asked only for
      // a payment MMG's lookup calls "successful" and that can be bounded.
      const history = detail.outcome === 'found' && detail.statusText === 'successful' && zone !== null && firstReplyAt !== null
        ? await this.paymentHistory(intent, txnId, historyQueryFor(intent, firstReplyAt, zone, now), lookup)
        : null;
      verdicts.push(judge(intent, txnId, detail, merchantIds, others, success, { zone, firstReplyAt, history }));
    }

    const confirmed = verdicts.find((v): v is Extract<Verdict, { verdict: 'CONFIRM' }> => v.verdict === 'CONFIRM');
    if (confirmed) {
      // [F2] Checkout crediting stays off until every earlier credit carries
      // its provider identity; the confirmation waits, nothing is lost.
      if (!(await providerIdentityBackfillDone(this.prisma))) return this.reschedule(intent, now, 'IDENTITY_BACKFILL_PENDING');
      return this.confirm(intent, confirmed.txnId, confirmed.ledgerReference, now);
    }
    const decisive = verdicts.find((v): v is Hold => v.verdict === 'HOLD' && v.decisive);
    // Late checks (EXPIRED / NOT_PAID) look for a confirmation, and put any
    // record MMG shows as paid that cannot be tied to this checkout in front
    // of a person: money MMG may hold for the partner is never dropped. [7 Oct]
    // A payment MMG's answer ties to this checkout whose time history cannot
    // show yet is held too: a late check has no window left to wait out.
    if (status !== 'CONFIRMING') {
      const late = decisive ?? verdicts.find((v): v is Hold => v.verdict === 'HOLD' && v.decisiveWhenLate === true);
      return late ? this.hold(intent, late.reason, now) : this.reschedule(intent, now, intent.reason);
    }

    if (decisive) return this.hold(intent, decisive.reason, now);
    // [F5] A payment failed only when MMG's answer for THIS checkout says so:
    // its lookup ties the decline to this checkout, or MMG's own not-paid or
    // timed-out answer for this checkout named every transaction and MMG's
    // lookup declines them all. A redirect's error path, a transaction MMG does
    // not know, or a decline after a success answer is never "not paid": the
    // checkout keeps confirming, then expires without declaring failure.
    const failed = verdicts.find((v): v is Declined => v.verdict === 'DECLINED' && v.bound) ?? await this.declinedAsAnswered(intent, verdicts);
    if (failed) return this.notPaid(intent, failed.reason, now);

    // Nothing is certain yet. A mismatch that may concern another transaction
    // waits for the window rather than holding a payment that is still arriving.
    const weak = verdicts.find((v): v is Hold => v.verdict === 'HOLD');
    return this.reschedule(intent, now, weak ? `SEEN:HOLD:${weak.reason}` : intent.reason);
  }

  /** [7 Oct · I9] Ask MMG's history for one transaction's record and write the
   *  answer down before anything is decided on it: the query, how many rows
   *  came back, and only the rows naming this transaction (other people's
   *  payments are never stored). What is decided on is read back from exactly
   *  what was written (paymentHistoryOf), as the support console reads it. */
  private async paymentHistory(intent: MmgCheckoutIntent, txnId: string, query: MmgHistoryQuery, lookup: MmgLookupClient): Promise<PaymentHistory> {
    const answer = await lookup.transactionHistoryRows(query);
    mmgCheckoutLookupsCounter.labels(`history_${answer.outcome}`).inc();
    const naming = answer.outcome === 'rows' ? rowsNaming(answer.rows, txnId) : [];
    const record = answer.outcome === 'rows'
      ? { body: { query, rowsReturned: answer.rows.length, truncated: mmgHistoryTruncated(answer.rows.length, query), naming }, failure: naming.length === 0 ? 'HISTORY_NOT_FOUND' : null }
      : { body: { query, error: answer.reason }, failure: HISTORY_FAILED };
    const body = redactedObject(record.body);
    await this.observe({
      tenantId: intent.tenantId,
      intentId: intent.id,
      source: 'HISTORY',
      detail: txnId,
      body,
      shape: answer.outcome === 'rows' ? describeShape(answer.rows) as Prisma.InputJsonValue : undefined,
      failure: record.failure,
    });
    return paymentHistoryOf({ failure: record.failure, body });
  }

  /** [F1] Our OTHER checkouts' references that MMG's answer names, as whole values anywhere in it. */
  private async otherCheckoutRefsIn(raw: unknown, intent: MmgCheckoutIntent): Promise<string[]> {
    const refs = [...new Set(replyLeaves(raw).map((leaf) => leaf.value)
      .filter((value) => MERCHANT_TRANSACTION_ID_SHAPE.test(value) && value !== intent.merchantTransactionId))].slice(0, 16);
    if (refs.length === 0) return [];
    const found = await this.prisma.mmgCheckoutIntent.findMany({ where: { merchantTransactionId: { in: refs } }, select: { merchantTransactionId: true } });
    return found.map((row) => row.merchantTransactionId);
  }

  private async reschedule(intent: MmgCheckoutIntent, now: Date, reason: string | null): Promise<CheckoutStatus> {
    const attempts = intent.checkAttempts + 1;
    const since = (intent.replyAt ?? intent.createdAt).getTime();
    if (intent.status === 'CONFIRMING') {
      if (now.getTime() >= since + CONFIRM_WINDOW_MS) {
        if (reason?.startsWith('SEEN:HOLD:')) return this.hold(intent, reason.slice('SEEN:HOLD:'.length));
        // [F5] No authoritative answer within the window: expired, never "not paid".
        return this.expireUnconfirmed(intent, now);
      }
      const delay = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 3_600_000;
      await this.prisma.mmgCheckoutIntent.updateMany({
        where: { id: intent.id, status: 'CONFIRMING' },
        data: { checkAttempts: attempts, nextCheckAt: new Date(now.getTime() + delay), reason },
      });
      return 'CONFIRMING';
    }
    await this.prisma.mmgCheckoutIntent.updateMany({
      where: { id: intent.id, status: intent.status },
      data: { checkAttempts: attempts, nextCheckAt: now.getTime() < since + LATE_WINDOW_MS ? new Date(now.getTime() + LATE_CHECK_MS) : null },
    });
    return intent.status as CheckoutStatus;
  }

  /** [I2 · I3 · F2] The credit: one transaction, one provider identity, once.
   *  [owner, 1 Oct · condition 6] MMG's ledger number for the same payment is
   *  claimed with it, under the same one-credit constraint: a payment another
   *  channel credited by either number is never credited again. */
  private async confirm(intent: MmgCheckoutIntent, txnId: string, ledgerReference: string, now: Date): Promise<CheckoutStatus> {
    const key = txnId; // Preserve provider spelling; SQL owns identity equivalence.
    const numbers = [...new Set([key, ledgerReference])];
    const amount = Number(intent.amount);
    let outcome: 'credited' | 'already' | 'held';
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        // Serialize every verifier of this checkout: return, notify and poll may race.
        await lockBillingAuthority(tx, intent.subscriptionId);
        await tx.$queryRaw`SELECT "id" FROM "mmg_checkout_intents" WHERE "id" = ${intent.id} FOR UPDATE`;
        const current = await tx.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: intent.id } });
        if (current.status === 'CONFIRMED') return 'already' as const;
        if (current.status === 'HELD') return 'held' as const;
        // [F2] The provider identity below is THE guard. These reads are a
        // second net for a credit an earlier release wrote without claiming an
        // identity (the push rail's payments, admin top-ups): never relied on,
        // never skipped.
        const [pushed, toppedUp] = await Promise.all([
          tx.subscriptionPayment.findFirst({ where: { OR: numbers.map((n) => ({ externalRef: { equals: n, mode: 'insensitive' as const } })) }, select: { id: true } }),
          tx.topUpCommand.findFirst({ where: { OR: numbers.map((n) => ({ providerRef: { equals: n, mode: 'insensitive' as const } })) }, select: { id: true } }),
        ]);
        if (pushed || toppedUp) {
          throw new ProviderIdentityError('PROVIDER_TXN_ALREADY_CREDITED', 'Another channel already recorded this transaction.');
        }
        const identity = await claimProviderPaymentInTx(tx, {
          provider: 'MMG',
          providerTxnId: key,
          amount,
          currencyCode: current.currencyCode,
          subscriptionId: current.subscriptionId,
          // [F7] The checkout's own tenant, named: this runs as the system.
          tenantId: current.tenantId,
          creditedBy: `mco:${current.id}`,
        });
        for (const number of numbers.filter((n) => n !== key)) {
          await claimProviderPaymentInTx(tx, {
            provider: 'MMG', providerTxnId: number, amount, currencyCode: current.currencyCode,
            subscriptionId: current.subscriptionId, tenantId: current.tenantId, creditedBy: `mco:${current.id}`,
          });
        }
        if (!identity.already) {
          await this.billing.recordTopUpInTransaction(tx, {
            subscriptionId: current.subscriptionId,
            expectedTenantId: current.tenantId,
            amount,
            recordedBy: 'mmg-checkout',
            channel: 'MMG_CHECKOUT',
            reference: `MMG checkout ${current.merchantTransactionId}, MMG transaction ${key}`,
            eventKey: `mmg-checkout:pp:${identity.id}`,
          });
        }
        await tx.mmgCheckoutIntent.update({
          where: { id: current.id },
          data: { status: 'CONFIRMED', mmgTransactionId: key, providerPaymentId: identity.id, confirmedAt: now, nextCheckAt: null, reason: null },
        });
        await markSettlementApplying(tx, current.subscriptionId, { checkoutId: current.id }, now);
        return 'credited' as const;
      });
    } catch (err) {
      if (err instanceof ProviderIdentityError) return this.hold(intent, HOLD_REASON[err.identityCode]);
      if (isDuplicateOn(err, 'mmgTransactionId')) return this.hold(intent, 'ALREADY_CREDITED');
      throw err;
    }
    if (outcome === 'held') return 'HELD';
    if (outcome === 'already') {
      await this.billing.recoverConfirmationSettlements(intent.subscriptionId, now);
      return 'CONFIRMED';
    }

    mmgCheckoutEventsCounter.labels('confirmed').inc();
    // [Sol · delta2] This verifier read MMG's answers before its lookups. A
    // success answer naming another transaction may have been written down
    // since: its reply then found the checkout still CONFIRMING and had
    // nothing to page about. Of a reply merging and this credit, whichever
    // commits last pages: a reply merging after the credit sees CONFIRMED
    // and pages itself; one written down before it is seen here.
    await this.alertUnappliedAnswers(intent.id).catch((err) => {
      log().error({ err, checkoutId: intent.id }, '[MMG checkout] credited; operators could not be paged about another success answer');
    });
    // [I5] Paying while behind re-bills at once and reinstates. It moves no
    // money and is idempotent; the billing cycle is the recovery path.
    await this.billing.afterTopUpCommitted(intent.subscriptionId, amount, { notify: false }).catch((err) => {
      log().error({ err, checkoutId: intent.id }, '[MMG checkout] credited; the re-bill will retry through billing');
    });
    await this.tellPartner(intent, 'CONFIRMED');
    return 'CONFIRMED';
  }

  /** [Sol · delta2 · delta3] After a credit commits: every transaction a
   *  success answer written down for this checkout names, and it did not
   *  credit, pages operators (alertUnapplied: once per checkout and
   *  transaction, never for the credited payment). Every answer is read,
   *  however many repeat one payment. Returns how many pages were attempted. */
  private async alertUnappliedAnswers(intentId: string, options: { onlyIfUnpaged?: boolean } = {}): Promise<number> {
    const settled = await this.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: intentId } });
    if (settled.status !== 'CONFIRMED') return 0;
    let attempted = 0;
    for (const { transactionId, source } of (await this.successNamed([settled])).get(settled.id) ?? []) {
      if (await this.alertUnapplied(settled, { merchantTransactionId: settled.merchantTransactionId, transactionId, resultCode: '0' }, source, options)) attempted += 1;
    }
    return attempted;
  }

  /** Each checkout's success answers (ResultCode 0, through either door,
   *  naming that checkout), one entry per distinct transaction (canonical
   *  spelling), the first answer's door. Read in pages until exhausted. */
  private async successNamed(intents: ReadonlyArray<Pick<MmgCheckoutIntent, 'id' | 'merchantTransactionId'>>): Promise<Map<string, Array<{ transactionId: string; source: 'RETURN' | 'NOTIFY' }>>> {
    const refOf = new Map(intents.map((intent) => [intent.id, intent.merchantTransactionId]));
    const seen = new Map<string, Map<string, { transactionId: string; source: 'RETURN' | 'NOTIFY' }>>();
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.mmgCheckoutObservation.findMany({
        where: { intentId: { in: [...refOf.keys()] }, source: { in: ['RETURN', 'NOTIFY'] }, detail: SUCCESS_ANSWER },
        orderBy: { id: 'asc' }, take: UNAPPLIED_READ_BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, intentId: true, source: true, body: true },
      });
      for (const answer of page) {
        const body = answer.body && typeof answer.body === 'object' && !Array.isArray(answer.body) ? answer.body as Record<string, unknown> : null;
        const transactionId = body?.['transactionId'];
        if (!answer.intentId || typeof transactionId !== 'string' || body?.['merchantTransactionId'] !== refOf.get(answer.intentId)) continue;
        const named = seen.get(answer.intentId) ?? new Map();
        if (!named.has(canonicalMmgTxn(transactionId))) named.set(canonicalMmgTxn(transactionId), { transactionId, source: answer.source === 'NOTIFY' ? 'NOTIFY' : 'RETURN' });
        seen.set(answer.intentId, named);
      }
      if (page.length < UNAPPLIED_READ_BATCH) break;
      cursor = page[page.length - 1]!.id;
    }
    return new Map([...seen].map(([id, named]) => [id, [...named.values()]]));
  }

  /**
   * [Sol, DS659 · delta3] The durable net under every unapplied-payment page.
   * Paging is best effort where it happens (a reply, a credit), and a
   * CONFIRMED checkout leaves polling, so a page that failed to save would be
   * lost. Every poll, each checkout CONFIRMED in the lookback is read again:
   * a success answer naming a transaction it did not credit, that no operator
   * was ever paged about (its per-transaction key), is paged now. Idempotent:
   * once saved, the key is found and nothing more is sent.
   */
  async reconcileUnappliedPages(now: Date = new Date()): Promise<number> {
    return runAsSystem('mmg-checkout-unapplied-reconcile', async () => {
      const since = new Date(now.getTime() - MMG_UNAPPLIED_RECONCILE_LOOKBACK_MS);
      let paged = 0;
      let cursor: string | undefined;
      for (;;) {
        const confirmed = await this.prisma.mmgCheckoutIntent.findMany({
          where: { status: 'CONFIRMED', confirmedAt: { gte: since } },
          orderBy: { id: 'asc' }, take: UNAPPLIED_READ_BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        const named = await this.successNamed(confirmed);
        for (const intent of confirmed) {
          for (const { transactionId, source } of named.get(intent.id) ?? []) {
            if (intent.mmgTransactionId && canonicalMmgTxn(intent.mmgTransactionId) === canonicalMmgTxn(transactionId)) continue;
            if (await this.alertUnapplied(intent, { merchantTransactionId: intent.merchantTransactionId, transactionId, resultCode: '0' }, source, { onlyIfUnpaged: true })) paged += 1;
          }
        }
        if (confirmed.length < UNAPPLIED_READ_BATCH) break;
        cursor = confirmed[confirmed.length - 1]!.id;
      }
      if (paged > 0) mmgCheckoutEventsCounter.labels('unapplied_reconciled').inc(paged);
      return paged;
    });
  }

  /** [I6] A person must look: nothing credits, and a reversal is a two-person decision. */
  private async hold(intent: MmgCheckoutIntent, reason: string, now: Date = new Date()): Promise<CheckoutStatus> {
    const moved = await this.prisma.$transaction(async (tx) => {
      await lockBillingAuthority(tx, intent.subscriptionId);
      const changed = await tx.mmgCheckoutIntent.updateMany({
        where: { id: intent.id, status: { in: ['OPEN', 'CONFIRMING', 'EXPIRED', 'NOT_PAID'] } },
        data: { status: 'HELD', reason, nextCheckAt: null },
      });
      if (changed.count) {
        const confirmation = await beginConfirmationInTx(tx, intent.subscriptionId, { checkoutId: intent.id }, reason, now);
        // An MMG negative released this checkout's pause; a later paid-looking
        // record takes it again, for the same obligation only (owner decision 2).
        if (confirmation.status === 'PROVEN_UNPAID') await reopenConfirmationForReviewInTx(tx, intent.subscriptionId, { checkoutId: intent.id }, reason, now);
      }
      return changed;
    });
    if (moved.count === 1) {
      mmgCheckoutEventsCounter.labels('held').inc();
      log().error({ checkoutId: intent.id, reason }, '[MMG checkout] held for review: the MMG records cannot be matched to this checkout');
      await notifyAdmins(this.prisma, this.notifications, {
        tenantId: intent.tenantId,
        title: 'MMG checkout held for review',
        body: `Checkout ${intent.id} is held (${reason}). Nothing was credited. Reconcile it against the MMG statement.${HOLD_GUIDANCE[reason] ?? ''}`,
        data: { kind: 'billing_invariants', alert: 'mmg-checkout-held', checkoutId: intent.id, reason },
      }).catch(() => {});
      await this.tellPartner(intent, 'HELD');
    }
    const current = await this.prisma.mmgCheckoutIntent.findUnique({ where: { id: intent.id }, select: { status: true } });
    return (current?.status ?? 'HELD') as CheckoutStatus;
  }

  /** [F5] Only on MMG's own answer, tied to THIS checkout, that the payment failed. */
  private async notPaid(intent: MmgCheckoutIntent, reason: string, now: Date): Promise<CheckoutStatus> {
    const since = (intent.replyAt ?? intent.createdAt).getTime();
    const moved = await this.prisma.$transaction(async (tx) => {
      await lockBillingAuthority(tx, intent.subscriptionId);
      const moved = await tx.mmgCheckoutIntent.updateMany({
      where: { id: intent.id, status: 'CONFIRMING' },
      data: {
        status: 'NOT_PAID',
        reason,
        // A later MMG confirmation still credits (I8): keep looking for a week.
        nextCheckAt: intent.candidates.length > 0 && now.getTime() < since + LATE_WINDOW_MS ? new Date(now.getTime() + LATE_CHECK_MS) : null,
      },
    });
      if (moved.count === 1) await resolveConfirmationInTx(tx, intent.subscriptionId, { checkoutId: intent.id }, 'PROVEN_UNPAID', { actor: 'mmg-provider', reference: reason }, now);
      return moved;
    });
    if (moved.count === 1) {
      mmgCheckoutEventsCounter.labels('not_paid').inc();
      await this.tellPartner(intent, 'NOT_PAID');
    }
    const current = await this.prisma.mmgCheckoutIntent.findUnique({ where: { id: intent.id }, select: { status: true } });
    return (current?.status ?? 'NOT_PAID') as CheckoutStatus;
  }

  /** [I8 · F4] A checkout nobody finished on MMG's page expires at its
   *  deadline: compare-and-set on OPEN AND that deadline, so a reply that made
   *  it CONFIRMING a moment ago is never overwritten. No notice, no dunning. */
  private async expireUnanswered(intentId: string, now: Date): Promise<boolean> {
    const intent = await this.prisma.mmgCheckoutIntent.findUnique({ where: { id: intentId }, select: { candidates: true, replyAt: true, createdAt: true } });
    if (!intent) return false;
    const since = (intent.replyAt ?? intent.createdAt).getTime();
    const moved = await this.prisma.mmgCheckoutIntent.updateMany({
      where: { id: intentId, status: 'OPEN', expiresAt: { lte: now } },
      data: {
        status: 'EXPIRED',
        reason: 'NO_REPLY',
        nextCheckAt: intent.candidates.length > 0 && now.getTime() < since + LATE_WINDOW_MS ? new Date(now.getTime() + LATE_CHECK_MS) : null,
      },
    });
    if (moved.count === 1) mmgCheckoutEventsCounter.labels('expired').inc();
    return moved.count === 1;
  }

  /** [I8 · F4 · F5] A checkout MMG sent back but nobody could verify within the
   *  confirmation window expires: compare-and-set on CONFIRMING AND that
   *  window, never declaring failure. A late confirmation still credits. */
  private async expireUnconfirmed(intent: MmgCheckoutIntent, now: Date): Promise<CheckoutStatus> {
    const cutoff = new Date(now.getTime() - CONFIRM_WINDOW_MS);
    const since = (intent.replyAt ?? intent.createdAt).getTime();
    const moved = await this.prisma.mmgCheckoutIntent.updateMany({
      where: {
        id: intent.id,
        status: 'CONFIRMING',
        OR: [{ replyAt: { lte: cutoff } }, { replyAt: null, createdAt: { lte: cutoff } }],
      },
      data: {
        status: 'EXPIRED',
        reason: 'LOOKUP_NEVER_CONFIRMED',
        nextCheckAt: intent.candidates.length > 0 && now.getTime() < since + LATE_WINDOW_MS ? new Date(now.getTime() + LATE_CHECK_MS) : null,
      },
    });
    if (moved.count === 1) {
      mmgCheckoutEventsCounter.labels('expired').inc();
      return 'EXPIRED';
    }
    const current = await this.prisma.mmgCheckoutIntent.findUnique({ where: { id: intent.id }, select: { status: true } });
    return (current?.status ?? 'EXPIRED') as CheckoutStatus;
  }

  /** The partner hears about the three states the contract promises a push for.
   *  No pay-action promise: the notice says what happened, not what to tap. */
  private async tellPartner(intent: MmgCheckoutIntent, status: 'CONFIRMED' | 'NOT_PAID' | 'HELD'): Promise<void> {
    try {
      const sub = await this.prisma.subscription.findUnique({
        where: { id: intent.subscriptionId },
        select: {
          rider: { select: { userId: true } },
          driver: { select: { userId: true } },
          vendor: { select: { id: true, owner: { select: { userId: true } } } },
        },
      });
      const userId = sub?.rider?.userId ?? sub?.driver?.userId ?? sub?.vendor?.owner.userId;
      if (!userId) return;
      const amount = formatMoney(Number(intent.amount), 'GYD', { whole: true });
      const copy = status === 'CONFIRMED'
        ? { title: 'Weekly fee paid', body: `${amount} received with MMG. Thank you.` }
        : status === 'NOT_PAID'
          ? { title: 'MMG payment not completed', body: `MMG did not complete your ${amount} weekly-fee payment.` }
          : { title: 'We are checking your MMG payment', body: `We are checking your ${amount} MMG payment by hand. Please do not pay again. Support will contact you.` };
      await this.notifications.send({
        userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        ...copy,
        audience: sub?.vendor ? 'business' : 'earner',
        // A multi-store owner's app selects vendorId before opening the fee screen.
        data: { kind: 'billing_mmg_checkout', subscriptionId: intent.subscriptionId, ref: intent.id, status, ...(sub?.vendor ? { vendorId: sub.vendor.id } : {}) },
      });
    } catch (err) {
      log().warn({ err, checkoutId: intent.id, status }, '[MMG checkout] the partner notice failed; the app still polls the truth');
    }
  }

  /** [DS632] Condition (3): the checkout's own merchant number, the one its
   *  page paid. Never the push rail's (MMG_MERCHANT_ID): a payment to another
   *  Swift account is held for a person, not attributed to this checkout. */
  private merchantIds(provider: MmgCheckoutProvider | null): string[] {
    return provider?.merchantId ? [provider.merchantId] : [];
  }

  private async observe(row: {
    /** [F7] The matched checkout's tenant, named: replies and polls run as the system. */
    tenantId?: string | null;
    intentId?: string | null;
    source: 'RETURN' | 'NOTIFY' | 'LOOKUP' | 'HISTORY';
    detail?: string | null;
    body?: Prisma.InputJsonValue;
    shape?: Prisma.InputJsonValue;
    failure?: string | null;
  }): Promise<void> {
    await this.prisma.mmgCheckoutObservation.create({
      data: {
        ...(row.tenantId ? { tenantId: row.tenantId } : {}),
        intentId: row.intentId ?? null,
        source: row.source,
        detail: row.detail ?? null,
        ...(row.body === undefined ? {} : { body: row.body }),
        ...(row.shape === undefined ? {} : { shape: row.shape }),
        failure: row.failure ?? null,
      },
    });
  }

  private async started(intent: MmgCheckoutIntent, userId: string): Promise<StartedCheckout> {
    // Unsealing can await while another rail or authority changes. The final
    // locked decision is after that await, for both first handoff and replay.
    const opened = intent.status === 'OPEN' ? await openCheckoutUrl(intent) : null;
    const result = await this.prisma.$transaction(async (tx) => {
      const owner = await lockBillingAuthority(tx, intent.subscriptionId);
      if (owner.userId !== userId) throw new NotFoundError('Subscription', intent.subscriptionId);
      const now = new Date();
      const decision = await lockFeePaymentDecision(tx, intent.subscriptionId, now, { checkoutId: intent.id });
      await tx.$queryRaw`SELECT "id" FROM "mmg_checkout_intents" WHERE "id" = ${intent.id} FOR UPDATE`;
      let current = await tx.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: intent.id } });
      if (current.status === 'OPEN' && current.expiresAt <= now) {
        const since = (current.replyAt ?? current.createdAt).getTime();
        current = await tx.mmgCheckoutIntent.update({ where: { id: current.id }, data: {
          status: 'EXPIRED', reason: 'NO_REPLY', nextCheckAt: current.candidates.length > 0 && now.getTime() < since + LATE_WINDOW_MS
            ? new Date(now.getTime() + LATE_CHECK_MS) : null,
        } });
      }
      return { current, blocked: current.status === 'OPEN' && !decision.allowed };
    });
    if (result.blocked) throw new AppError(409, 'PAYMENT_CONFIRMING', 'Weekly-fee collection is paused while payment information is confirmed.', { ref: result.current.id });
    const current = result.current;
    return {
      ref: current.id,
      status: current.status as CheckoutStatus,
      checkoutUrl: current.status === 'OPEN' ? opened : null,
      amountGyd: Number(current.amount),
      currencyCode: 'GYD',
      expiresAt: current.expiresAt.toISOString(),
    };
  }

  private view(intent: MmgCheckoutIntent, subscriptionStatus: SubscriptionStatus): CheckoutView {
    return {
      ref: intent.id,
      status: intent.status as CheckoutStatus,
      amountGyd: Number(intent.amount),
      currencyCode: 'GYD',
      createdAt: intent.createdAt.toISOString(),
      expiresAt: intent.expiresAt.toISOString(),
      confirmedAt: intent.confirmedAt ? intent.confirmedAt.toISOString() : null,
      subscriptionStatus,
      ...partnerReceiptIds(intent),
    };
  }
}

/** The values a reply may be carried in: every string, bounded in count and size. */
function replyParams(params: unknown): string[] {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return [];
  // A key the return page saw more than once arrives as an array of its values.
  return Object.values(params as Record<string, unknown>)
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .slice(0, MAX_REPLY_PARAMS)
    .filter((value): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_REPLY_PARAM_CHARS);
}
