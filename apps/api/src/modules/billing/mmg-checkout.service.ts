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
} from '../../providers/mmg/mmg-checkout';
import { getMmgLookupProvider, type MmgLookupClient, type MmgLookupDetail } from '../../providers/mmg/mmg-provider';
import { mmgCheckoutEventsCounter, mmgCheckoutLookupsCounter } from '../../plugins/observability';
import { runAsSystem } from '../../plugins/tenant-context';
import { isDuplicateOn } from '../money/evidence';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';
import type { BillingService } from './billing.service';
import { payInfo } from './agent-cash.service';
import { checkoutAmountGyd, mmgCheckoutLive, type ClientPlatform } from './fee-pay-actions';
import { claimProviderPaymentInTx, normalizeProviderTxnId, ProviderIdentityError } from './provider-identity';

// ---------------------------------------------------------------------------
// The MMG weekly-fee checkout (MMG-CHECKOUT-API.md is the contract).
//
// A partner starts a checkout; Swift prices it [I1], persists it, then hands
// out the MMG page. MMG sends the partner back with an encrypted reply whose
// field names are still UNCONFIRMED (providers/mmg/CHECKOUT-CONTRACT.md U1-U3),
// so this service never reads a field by name:
//   - the checkout is the one whose 18-digit reference appears ANYWHERE in the
//     decrypted reply (we generated it, so we recognise it);
//   - every other id-shaped value in the reply is a CANDIDATE MMG transaction.
// MMG's own merchant lookup is the only evidence. A candidate credits only
// when the lookup reports it approved, for exactly the amount asked, in GYD,
// paid to our merchant [I2]. The reply, the redirect and the app never credit.
//
// The credit is the provider_payments compare-and-set shared with agent cash
// and admin top-ups [I3]; one open checkout per subscription is a partial
// unique index [I4]; a checkout in flight pauses charging and dunning, and a
// credit re-bills at once [I5]; a mismatch holds for a person [I6]; this table
// is invisible to the merchant-initiated poller [I7]; expiry is not failure,
// and a late confirmation still credits [I8]; every reply and lookup is
// written down before anything is decided on it [I9].
// ---------------------------------------------------------------------------

/** How long a partner has to finish on the MMG page (MMG's own limit is unconfirmed, U8). */
export const MMG_CHECKOUT_TTL_MS = 30 * 60_000;
/** A reply is checked for a day; after that a late confirmation is still looked for, for a week. */
const CONFIRM_WINDOW_MS = 24 * 3_600_000;
const LATE_WINDOW_MS = 7 * 24 * 3_600_000;
const LATE_CHECK_MS = 6 * 3_600_000;
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000] as const;
/** A transaction stamped (with a time zone) more than a day before its checkout cannot be its payment. */
const OLDER_THAN_CHECKOUT_MS = 24 * 3_600_000;
const MAX_CANDIDATES = 5;
const MAX_REPLY_PARAMS = 16;
const MAX_REPLY_PARAM_CHARS = 4096;
const POLL_BATCH = 50;
const CLIENT_KEY = /^[A-Za-z0-9_-]{8,128}$/;

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
/** Key names the MMG lookup itself uses for a transaction (the Postman collection), tried first. */
const ID_HINT = /transaction|reference|receipt|execution|(^|[^a-z])id$/i;

/** The MMG transaction ids a reply may be naming, best first. */
export function candidatesFrom(reply: unknown, own: { merchantTransactionId: string; amountGyd: number }, merchantIds: string[]): string[] {
  const seen = new Set<string>();
  const ranked: Array<{ value: string; hinted: boolean }> = [];
  for (const leaf of replyLeaves(reply)) {
    const value = leaf.value;
    if (SECRET_PATH.test(leaf.path) || seen.has(value)) continue;
    if (value === own.merchantTransactionId || value === String(own.amountGyd)) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,63}$/.test(value) || !/\d/.test(value)) continue;
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) continue; // a date, not an id
    if (merchantIds.some((merchant) => sameMsisdn(merchant, value))) continue;
    seen.add(value);
    const last = leaf.path.split('.').pop() ?? '';
    ranked.push({ value, hinted: ID_HINT.test(last) });
  }
  return [...ranked.filter((r) => r.hinted), ...ranked.filter((r) => !r.hinted)].slice(0, MAX_CANDIDATES).map((r) => r.value);
}

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

/** The return path as a short hint (success, error, …): never evidence. */
function hintFrom(outcome: unknown): string | null {
  const text = typeof outcome === 'string' ? outcome.toLowerCase() : '';
  return /^[a-z0-9_-]{1,32}$/.test(text) ? text : null;
}
const errorHint = (hint: string | null) => !!hint && /error|fail|cancel|declin/.test(hint);

function returnStateFor(status: CheckoutStatus): ReturnState {
  if (status === 'CONFIRMED') return 'CONFIRMED';
  if (status === 'NOT_PAID') return 'NOT_PAID';
  return 'CONFIRMING';
}

function minorOf(intent: Pick<MmgCheckoutIntent, 'amount' | 'currencyCode'>): number {
  return Number(fromMajor(intent.amount.toString(), intent.currencyCode).minor);
}

type Verdict =
  | { verdict: 'CONFIRM'; txnId: string }
  | { verdict: 'HOLD' | 'DECLINED'; txnId: string; reason: string; strong: boolean }
  | { verdict: 'PENDING' | 'NOT_FOUND' | 'ERROR'; txnId: string };

/** What one lookup answer means for one checkout. `strong` = MMG's own answer
 *  names our reference, so it is certainly this checkout's transaction. */
export function judge(intent: Pick<MmgCheckoutIntent, 'merchantTransactionId' | 'amount' | 'currencyCode' | 'createdAt'>, txnId: string, detail: MmgLookupDetail, merchantIds: string[]): Verdict {
  if (detail.outcome === 'not_found') return { verdict: 'NOT_FOUND', txnId };
  if (detail.outcome === 'error') return { verdict: 'ERROR', txnId };
  const strong = JSON.stringify(detail.raw).includes(intent.merchantTransactionId);
  if (detail.status === 'approved') {
    const hold = (reason: string): Verdict => ({ verdict: 'HOLD', txnId, reason, strong });
    const zoned = detail.createdAt && /(Z|[+-]\d{2}:?\d{2})$/.test(detail.createdAt) ? Date.parse(detail.createdAt) : NaN;
    if (Number.isFinite(zoned) && zoned < intent.createdAt.getTime() - OLDER_THAN_CHECKOUT_MS) return hold('OLDER_THAN_CHECKOUT');
    if (detail.amountMinor === null || detail.amountMinor !== minorOf(intent)) return hold('AMOUNT_MISMATCH');
    if (detail.currencyCode !== intent.currencyCode) return hold('CURRENCY_MISMATCH');
    if (!detail.creditParties || detail.creditParties.length === 0) return hold('MERCHANT_UNCONFIRMED');
    if (!detail.creditParties.some((party) => merchantIds.some((merchant) => sameMsisdn(merchant, party)))) return hold('MERCHANT_MISMATCH');
    return { verdict: 'CONFIRM', txnId };
  }
  if (detail.status === 'declined' || detail.status === 'expired' || detail.status === 'reversed') {
    return { verdict: 'DECLINED', txnId, reason: `MMG_${detail.status.toUpperCase()}`, strong };
  }
  return { verdict: 'PENDING', txnId };
}

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

    // The same key always gets the same answer.
    const replay = await this.prisma.mmgCheckoutIntent.findUnique({
      where: { createdByUserId_clientKey: { createdByUserId: input.userId, clientKey } },
    });
    if (replay) {
      if (replay.subscriptionId !== input.subscriptionId) {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', 'That Idempotency-Key was used for a different checkout. A new tap needs a new key.');
      }
      // An open checkout past its time is expired first: a stale MMG page is never handed out.
      if (replay.status === 'OPEN' && replay.expiresAt <= now) {
        await this.expire(replay.id, 'NO_REPLY', now);
        return { created: false, checkout: this.started(await this.prisma.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: replay.id } })) };
      }
      return { created: false, checkout: this.started(replay) };
    }

    const sub = await this.prisma.subscription.findUnique({ where: { id: input.subscriptionId } });
    if (!sub) throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', 'There is no subscription to pay.');
    if (!(await this.isLiveFor(sub, input.platform))) {
      throw new AppError(409, 'PAY_ACTION_OFF', 'Paying with MMG is not available for this account here.');
    }

    // [I4] One open checkout per subscription.
    const open = await this.prisma.mmgCheckoutIntent.findFirst({
      where: { subscriptionId: sub.id, status: { in: ['OPEN', 'CONFIRMING'] } },
    });
    if (open?.status === 'CONFIRMING') {
      throw new AppError(409, 'CHECKOUT_CONFIRMING', 'An earlier MMG payment is being confirmed. Do not pay again.', { ref: open.id });
    }
    if (open && open.expiresAt > now) return { created: false, checkout: this.started(open) };
    if (open) await this.expire(open.id, 'NO_REPLY', now);

    // [I1] Priced here, from payInfo's own amount due.
    const amountGyd = checkoutAmountGyd(await payInfo(this.prisma, sub));
    const merchantTransactionId = newMerchantTransactionId(now);
    let checkoutUrl: string;
    try {
      checkoutUrl = this.checkout().createCheckout({ amount: fromMajor(String(amountGyd), 'GYD'), merchantTransactionId, now }).checkoutUrl;
    } catch (err) {
      log().error({ err, subscriptionId: sub.id }, '[MMG checkout] the checkout could not be built');
      throw new AppError(503, 'MMG_CHECKOUT_UNAVAILABLE', 'The MMG checkout could not be started right now. Try again in a minute.');
    }

    // Persisted BEFORE the page leaves the server: a checkout nobody wrote
    // down could be paid and never found.
    try {
      const intent = await this.prisma.mmgCheckoutIntent.create({
        data: {
          subscriptionId: sub.id,
          merchantTransactionId,
          amount: amountGyd,
          currencyCode: 'GYD',
          clientKey,
          createdByUserId: input.userId,
          platform: input.platform,
          checkoutUrl,
          expiresAt: new Date(now.getTime() + MMG_CHECKOUT_TTL_MS),
        },
      });
      mmgCheckoutEventsCounter.labels('created').inc();
      return { created: true, checkout: this.started(intent) };
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
      // A concurrent request won: the same key, or another open checkout.
      const winner = await this.prisma.mmgCheckoutIntent.findUnique({
        where: { createdByUserId_clientKey: { createdByUserId: input.userId, clientKey } },
      }) ?? await this.prisma.mmgCheckoutIntent.findFirst({ where: { subscriptionId: sub.id, status: { in: ['OPEN', 'CONFIRMING'] } } });
      if (!winner) throw err;
      if (winner.status === 'CONFIRMING') {
        throw new AppError(409, 'CHECKOUT_CONFIRMING', 'An earlier MMG payment is being confirmed. Do not pay again.', { ref: winner.id });
      }
      return { created: false, checkout: this.started(winner) };
    }
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

      const intent = await this.intentNamedBy(reply);
      await this.observe({
        intentId: intent?.id ?? null,
        source: input.source,
        detail: hint,
        body: redactedObject(reply),
        shape: describeShape(reply) as Prisma.InputJsonValue,
        failure: intent ? null : 'NO_CHECKOUT',
      });
      if (!intent) {
        mmgCheckoutEventsCounter.labels('reply_unmatched').inc();
        return 'UNKNOWN';
      }
      mmgCheckoutEventsCounter.labels('reply').inc();
      if (intent.status === 'CONFIRMED') return 'CONFIRMED';

      const named = candidatesFrom(reply, { merchantTransactionId: intent.merchantTransactionId, amountGyd: Number(intent.amount) }, this.merchantIds(provider));
      await this.prisma.mmgCheckoutIntent.update({
        where: { id: intent.id },
        data: {
          candidates: [...new Set([...intent.candidates, ...named])].slice(0, MAX_CANDIDATES),
          replyAt: intent.replyAt ?? now,
          outcomeHint: intent.outcomeHint ?? hint,
          nextCheckAt: now,
        },
      });
      // The partner came back through MMG: an open checkout is now confirming.
      await this.prisma.mmgCheckoutIntent.updateMany({ where: { id: intent.id, status: 'OPEN' }, data: { status: 'CONFIRMING' } });
      return returnStateFor(await this.verify(intent.id, now));
    });
  }

  /** Every two minutes (the poll-mmg-billing job): expire the checkouts no
   *  reply ever came for, and look again at every checkout that is due. */
  async pollIntents(now: Date = new Date()): Promise<{ expired: number; checked: number }> {
    return runAsSystem('mmg-checkout-poll', async () => {
      const out = { expired: 0, checked: 0 };
      const stale = await this.prisma.mmgCheckoutIntent.findMany({
        where: { status: 'OPEN', expiresAt: { lte: now } },
        select: { id: true },
        take: POLL_BATCH,
      });
      for (const row of stale) if (await this.expire(row.id, 'NO_REPLY', now)) out.expired += 1;
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
      return out;
    });
  }

  // ---------------------------------------------------------------------------

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
    const lookup = this.lookup();
    const verdicts: Verdict[] = [];
    for (const txnId of intent.candidates.slice(0, MAX_CANDIDATES)) {
      const detail = await lookup.transactionLookupDetail(txnId);
      mmgCheckoutLookupsCounter.labels(detail.outcome).inc();
      await this.observe({
        intentId: intent.id,
        source: 'LOOKUP',
        detail: txnId,
        body: detail.outcome === 'found' ? redactedObject(detail.raw) : undefined,
        shape: detail.outcome === 'found' ? describeShape(detail.raw) as Prisma.InputJsonValue : undefined,
        failure: detail.outcome === 'not_found' ? 'LOOKUP_NOT_FOUND' : detail.outcome === 'error' ? 'LOOKUP_FAILED' : null,
      });
      verdicts.push(judge(intent, txnId, detail, merchantIds));
    }

    const confirmed = verdicts.find((v) => v.verdict === 'CONFIRM');
    if (confirmed) return this.confirm(intent, confirmed.txnId, now);
    // Late checks (EXPIRED / NOT_PAID) only ever look for a confirmation.
    if (status !== 'CONFIRMING') return this.reschedule(intent, now, intent.reason);

    const decisive = verdicts.find((v): v is Extract<Verdict, { strong: boolean }> => (v.verdict === 'HOLD' || v.verdict === 'DECLINED') && v.strong);
    if (decisive?.verdict === 'HOLD') return this.hold(intent, decisive.reason);
    if (decisive?.verdict === 'DECLINED') return this.notPaid(intent, decisive.reason, now);
    const nothingPaid = verdicts.every((v) => v.verdict === 'NOT_FOUND' || v.verdict === 'DECLINED');
    if (errorHint(intent.outcomeHint) && nothingPaid) return this.notPaid(intent, 'RETURNED_ERROR', now);

    // Nothing is certain yet. Evidence that may concern another transaction
    // waits for the window rather than holding a payment that is still arriving.
    const weak = verdicts.find((v): v is Extract<Verdict, { strong: boolean }> => v.verdict === 'HOLD')
      ?? verdicts.find((v): v is Extract<Verdict, { strong: boolean }> => v.verdict === 'DECLINED');
    return this.reschedule(intent, now, weak ? `SEEN:${weak.verdict}:${weak.reason}` : intent.reason);
  }

  private async reschedule(intent: MmgCheckoutIntent, now: Date, reason: string | null): Promise<CheckoutStatus> {
    const attempts = intent.checkAttempts + 1;
    const since = (intent.replyAt ?? intent.createdAt).getTime();
    if (intent.status === 'CONFIRMING') {
      if (now.getTime() >= since + CONFIRM_WINDOW_MS) {
        if (reason?.startsWith('SEEN:HOLD:')) return this.hold(intent, reason.slice('SEEN:HOLD:'.length));
        if (reason?.startsWith('SEEN:DECLINED:')) return this.notPaid(intent, reason.slice('SEEN:DECLINED:'.length), now);
        await this.expire(intent.id, 'LOOKUP_NEVER_CONFIRMED', now);
        return 'EXPIRED';
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

  /** [I2 · I3] The credit: one transaction, one provider identity, once. */
  private async confirm(intent: MmgCheckoutIntent, txnId: string, now: Date): Promise<CheckoutStatus> {
    const key = normalizeProviderTxnId(txnId);
    const amount = Number(intent.amount);
    let outcome: 'credited' | 'already' | 'held';
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        // Serialize every verifier of this checkout: return, notify and poll may race.
        await tx.$queryRaw`SELECT "id" FROM "mmg_checkout_intents" WHERE "id" = ${intent.id} FOR UPDATE`;
        const current = await tx.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: intent.id } });
        if (current.status === 'CONFIRMED') return 'already' as const;
        if (current.status === 'HELD') return 'held' as const;
        // The merchant-initiated rail settles its own transactions without a
        // provider identity: a transaction it already settled never credits here.
        const pushed = await tx.subscriptionPayment.findFirst({
          where: { externalRef: { equals: txnId, mode: 'insensitive' } },
          select: { id: true },
        });
        if (pushed) throw new ProviderIdentityError('PROVIDER_TXN_ALREADY_CREDITED', 'The merchant-initiated rail already settled this transaction.');
        const identity = await claimProviderPaymentInTx(tx, {
          provider: 'MMG',
          providerTxnId: key,
          amount,
          currencyCode: current.currencyCode,
          subscriptionId: current.subscriptionId,
          creditedBy: `mco:${current.id}`,
        });
        if (!identity.already) {
          await this.billing.recordTopUpInTransaction(tx, {
            subscriptionId: current.subscriptionId,
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
        return 'credited' as const;
      });
    } catch (err) {
      if (err instanceof ProviderIdentityError) {
        return this.hold(intent, err.identityCode === 'PROVIDER_TXN_AMOUNT_CONFLICT' ? 'AMOUNT_CONFLICT_ON_RECORD' : 'ALREADY_CREDITED');
      }
      if (isDuplicateOn(err, 'mmgTransactionId')) return this.hold(intent, 'ALREADY_CREDITED');
      throw err;
    }
    if (outcome === 'held') return 'HELD';
    if (outcome === 'already') return 'CONFIRMED';

    mmgCheckoutEventsCounter.labels('confirmed').inc();
    // [I5] Paying while behind re-bills at once and reinstates. It moves no
    // money and is idempotent; the billing cycle is the recovery path.
    await this.billing.afterTopUpCommitted(intent.subscriptionId, amount, { notify: false }).catch((err) => {
      log().error({ err, checkoutId: intent.id }, '[MMG checkout] credited; the re-bill will retry through billing');
    });
    await this.tellPartner(intent, 'CONFIRMED');
    return 'CONFIRMED';
  }

  /** [I6] A person must look: nothing credits, and a reversal is a two-person decision. */
  private async hold(intent: MmgCheckoutIntent, reason: string): Promise<CheckoutStatus> {
    const moved = await this.prisma.mmgCheckoutIntent.updateMany({
      where: { id: intent.id, status: { in: ['OPEN', 'CONFIRMING', 'EXPIRED', 'NOT_PAID'] } },
      data: { status: 'HELD', reason, nextCheckAt: null },
    });
    if (moved.count === 1) {
      mmgCheckoutEventsCounter.labels('held').inc();
      log().error({ checkoutId: intent.id, reason }, '[MMG checkout] held for review: the MMG records do not match this checkout');
      await notifyAdmins(this.prisma, this.notifications, {
        tenantId: null,
        title: 'MMG checkout held for review',
        body: `Checkout ${intent.id} is held (${reason}). Nothing was credited. Reconcile it against the MMG statement.`,
        data: { kind: 'billing_invariants', alert: 'mmg-checkout-held', checkoutId: intent.id, reason },
      }).catch(() => {});
      await this.tellPartner(intent, 'HELD');
    }
    const current = await this.prisma.mmgCheckoutIntent.findUnique({ where: { id: intent.id }, select: { status: true } });
    return (current?.status ?? 'HELD') as CheckoutStatus;
  }

  private async notPaid(intent: MmgCheckoutIntent, reason: string, now: Date): Promise<CheckoutStatus> {
    const since = (intent.replyAt ?? intent.createdAt).getTime();
    const moved = await this.prisma.mmgCheckoutIntent.updateMany({
      where: { id: intent.id, status: 'CONFIRMING' },
      data: {
        status: 'NOT_PAID',
        reason,
        // A later MMG confirmation still credits (I8): keep looking for a week.
        nextCheckAt: intent.candidates.length > 0 && now.getTime() < since + LATE_WINDOW_MS ? new Date(now.getTime() + LATE_CHECK_MS) : null,
      },
    });
    if (moved.count === 1) {
      mmgCheckoutEventsCounter.labels('not_paid').inc();
      await this.tellPartner(intent, 'NOT_PAID');
    }
    const current = await this.prisma.mmgCheckoutIntent.findUnique({ where: { id: intent.id }, select: { status: true } });
    return (current?.status ?? 'NOT_PAID') as CheckoutStatus;
  }

  /** [I8] Expiry is not failure: no notice, no dunning; a late confirmation still credits. */
  private async expire(intentId: string, reason: string, now: Date): Promise<boolean> {
    const intent = await this.prisma.mmgCheckoutIntent.findUnique({ where: { id: intentId }, select: { candidates: true, replyAt: true, createdAt: true } });
    if (!intent) return false;
    const since = (intent.replyAt ?? intent.createdAt).getTime();
    const moved = await this.prisma.mmgCheckoutIntent.updateMany({
      where: { id: intentId, status: { in: ['OPEN', 'CONFIRMING'] } },
      data: {
        status: 'EXPIRED',
        reason,
        nextCheckAt: intent.candidates.length > 0 && now.getTime() < since + LATE_WINDOW_MS ? new Date(now.getTime() + LATE_CHECK_MS) : null,
      },
    });
    if (moved.count === 1) mmgCheckoutEventsCounter.labels('expired').inc();
    return moved.count === 1;
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

  /** The one checkout whose reference the reply carries, anywhere in it. */
  private async intentNamedBy(reply: Record<string, unknown>): Promise<MmgCheckoutIntent | null> {
    const refs = [...new Set(replyLeaves(reply).map((leaf) => leaf.value).filter((value) => MERCHANT_TRANSACTION_ID_SHAPE.test(value)))].slice(0, 16);
    if (refs.length === 0) return null;
    const found = await this.prisma.mmgCheckoutIntent.findMany({ where: { merchantTransactionId: { in: refs } }, take: 2 });
    return found.length === 1 ? found[0]! : null;
  }

  private merchantIds(provider: MmgCheckoutProvider | null): string[] {
    return [provider?.merchantId, process.env['MMG_MERCHANT_ID']].filter((id): id is string => typeof id === 'string' && id.length > 0);
  }

  private async observe(row: { intentId?: string | null; source: 'RETURN' | 'NOTIFY' | 'LOOKUP'; detail?: string | null; body?: Prisma.InputJsonValue; shape?: Prisma.InputJsonValue; failure?: string | null }): Promise<void> {
    await this.prisma.mmgCheckoutObservation.create({
      data: {
        intentId: row.intentId ?? null,
        source: row.source,
        detail: row.detail ?? null,
        ...(row.body === undefined ? {} : { body: row.body }),
        ...(row.shape === undefined ? {} : { shape: row.shape }),
        failure: row.failure ?? null,
      },
    });
  }

  private started(intent: MmgCheckoutIntent): StartedCheckout {
    return {
      ref: intent.id,
      status: intent.status as CheckoutStatus,
      checkoutUrl: intent.status === 'OPEN' ? intent.checkoutUrl : null,
      amountGyd: Number(intent.amount),
      currencyCode: 'GYD',
      expiresAt: intent.expiresAt.toISOString(),
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
