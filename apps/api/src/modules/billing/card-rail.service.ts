import { lockFeePaymentDecision } from './fee-payment-authority';
import { beginConfirmationInTx, lockBillingAuthority, reopenConfirmationForReviewInTx, resolveConfirmationInTx } from './dunning-clock';
import { lockFeeCollectionAuthority, lockSubscriptionPayer } from '../subscription/mover-fee-authority';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CardObservationSource, CardObservationVerdict, CardObservedStatus, CardSession, CardSessionStatus, Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { cardRailKilled, cardRailV2Enabled, cardTestSubscriptions } from '../../utils/card-rail';
import { toProviderMinor } from '../../utils/currency-amount';
import { log } from '../../utils/logger';
import { getTenantContext } from '../../plugins/tenant-context';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';
import type { OnAudit } from '../../lib/audit-writer';
import { CARD_PAY_NOW_KEY_PREFIX, cardChargesInFlight, cardExpiredAt, closeUnsentCardIntents, type BillingService } from './billing.service';
import { sealVaultToken } from './card-vault';
import { observedStatus, recordCardObservation } from './card-observations';
import {
  assertNever, bindingOf, COMPLETION_CLAIM_WAIT_MS, describeBinding, rawDigest, sameBinding,
  type CardRailProvider, type CardRailSource, type CardRefundOutcome, type CardReturnObservation, type CardSessionOutcome, type CardSessionPurpose,
  type CompletionClaim, type CreateCardSessionOutcome,
} from '../../providers/card/card-provider';
import { POWERTRANZ_PROVIDER, readCompletion } from '../../providers/card/powertranz-provider';
import { SIMULATOR_PAGE, SIMULATOR_PROVIDER } from '../../providers/card/simulator-provider';

// ---------------------------------------------------------------------------
// [PT-1 · AH.10.9.2] The card rail v2 service: hosted sessions and enrolled
// cards for Swift's weekly fee. Routes arrive in PT-2; this is the authority
// they will call.
//
//   startSession   the durable intent first, then the provider's page. A
//                  Pay-now amount is the server's price, never the client's.
//   handleReturn   records what the browser brought back. It NEVER credits,
//                  never enrols: a return is an observation [C5].
//   confirm        the ONLY path to money: the provider's server-side answer
//                  enrols a card (ENROLL) or books the week ONCE through
//                  billing's applySuccessfulCharge path (PAY_NOW).
//   sweepSessions  closes what expired and keeps asking about what may have
//                  moved money.
//   remove / list  the partner's cards, as brand, last 4 and expiry only [C9].
//
// The kill switch stops new sessions; returns, confirmations and the sweep
// keep draining [C7]. The CARD_RAIL_V2 flag gates new sessions here, and the
// billing worker sweeps existing ones only while v2 is on, or under the
// explicit CARD_RAIL_V2_DRAIN=1 (card-rail-worker.ts) [AX297 F5].
// ---------------------------------------------------------------------------

/** The off-session consent the partner accepts before enrolling a card: Swift
 *  charges it for the weekly fee without the partner present. Its words live
 *  with the screen that shows them (PT-3); the version is recorded on the
 *  session and on the card. */
export const CARD_ON_FILE_CONSENT_VERSION = 'card-on-file-v1';
/** [Owner sign-off, 7 Oct 2026] The exact words of `card-on-file-v1`, shown on
 *  the Add card screen. A change of wording is a new version, never an edit
 *  of this one: every saved card records the version its partner accepted.
 *  Saving cards stays OFF (CARD_RAIL_ENROLL) until the owner's go. */
export const CARD_ON_FILE_CONSENT_TEXT = 'Swift will charge the card you add for your weekly fee each week, when it is due, until you remove it. Your bank may ask you to confirm a charge. You can remove the card here at any time.';
/** sha256 of CARD_ON_FILE_CONSENT_TEXT: a test pins it, so the words cannot drift under the same version. */
export const CARD_ON_FILE_CONSENT_SHA256 = '6384aa5c414e5686dacff1ea8503a304bca572cf2111004a17ca2268e25ce7e8';
/** How long a hosted page stays usable (the provider is told the same). */
export const CARD_SESSION_TTL_MS = 15 * 60 * 1000;
/** An UNKNOWN session is asked about again at most this often. */
const UNKNOWN_RECHECK_MS = 10 * 60 * 1000;
/** [Review S2-2] A void claimed but never answered (the claimant stopped): past this it is unconfirmed and held for a person. Well past the provider's 15 s request limit. */
export const VOID_ANSWER_WAIT_MS = 2 * 60 * 1000;
/** [Review S2-2] A finance BOOK or REFUND claim blocks the other decisions this
 *  long while its own money call may still be running (billing's booking, or
 *  the provider's refund answer, well inside it). */
export const FINANCE_CLAIM_WAIT_MS = 2 * 60 * 1000;
/** What finance may decide on a HELD Pay now (admin route, C4). */
export const CARD_RESOLVE_ACTIONS = ['BOOK', 'REFUND', 'REFUNDED_IN_PORTAL', 'NOTHING_TAKEN'] as const;
export type CardResolveAction = (typeof CARD_RESOLVE_ACTIONS)[number];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE: CardSessionStatus[] = ['OPEN', 'UNKNOWN'];
const KEY_MIN = 8;
const KEY_MAX = 128;

/** [C9] What a card looks like outside the vault: brand, last 4, expiry. */
export const INSTRUMENT_DTO_SELECT = {
  id: true, brand: true, last4: true, expMonth: true, expYear: true, status: true,
} as const satisfies Prisma.PaymentInstrumentSelect;
export type PaymentInstrumentDto = Prisma.PaymentInstrumentGetPayload<{ select: typeof INSTRUMENT_DTO_SELECT }>;

export interface CardSessionDto {
  sessionId: string;
  purpose: CardSessionPurpose;
  status: CardSessionStatus;
  hostedUrl: string | null;
  expiresAt: string;
  /** PAY_NOW only: what the server priced, in the subscription's currency. */
  amount?: number;
  currencyCode?: string;
  /** [C10] True on the simulator and on a provider's sandbox: a test, no real money. */
  testMode: boolean;
  testModeLabel?: string;
}

export type CardReturnVerdict = CardObservationVerdict | 'UNKNOWN_SESSION';

export interface CardConfirmResult {
  sessionId: string;
  purpose: CardSessionPurpose;
  status: CardSessionStatus;
  instrument?: PaymentInstrumentDto;
  settlement?: 'advanced' | 'banked';
  /** [AX318 R1] ENROLL replacing a card: a weekly charge on the replaced card
   *  was already handed to the provider; it finishes and is reconciled. */
  paymentInProgress?: boolean;
}

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** [PT-4] A provider's failure reason, as the session's failure code: a failed
 *  3-D Secure check and a page never finished are not "declined" (nothing was
 *  asked of the bank); everything else the provider calls failed is. */
export function failureCodeOf(reason: string): string {
  if (reason.startsWith('NOT_AUTHENTICATED')) return 'NOT_AUTHENTICATED';
  if (reason === 'PAGE_NOT_FINISHED') return 'EXPIRED_UNUSED';
  // [Review S4] The completion was never sent (its five minutes had passed): nothing was asked of the bank.
  if (reason === 'SPI_TOKEN_EXPIRED') return 'COMPLETION_EXPIRED';
  // [CARDS S1] The completion was never sent (its session closed first, or its claim could not be recorded).
  if (reason === 'SESSION_CLOSED_BEFORE_COMPLETION' || reason === 'COMPLETION_CLAIM_FAILED') return 'COMPLETION_NOT_SENT';
  return 'DECLINED';
}

const notHeld = () => new AppError(409, 'CARD_SESSION_NOT_HELD', 'Only a card payment held for a person can be resolved, once.');

/** [Review S2-2] Did this session's payment book the week (captured, or banked
 *  to the balance)? Read under the session lock. */
async function bookedInTx(tx: Prisma.TransactionClient, s: Pick<CardSession, 'paymentId'>): Promise<boolean> {
  if (!s.paymentId) return false;
  const payment = await tx.subscriptionPayment.findUnique({ where: { id: s.paymentId }, select: { status: true } });
  if (payment?.status === 'CAPTURED') return true;
  return (await tx.billingEvent.findUnique({ where: { idempotencyKey: `bank:${s.paymentId}` }, select: { id: true } })) !== null;
}

function stateMatches(state: string, stateHash: string): boolean {
  const got = Buffer.from(sha256Hex(state), 'hex');
  const want = Buffer.from(stateHash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** [PT-4] A real provider's TEST system: test cards only, no real money. Labelled like the simulator. */
export const CARD_SANDBOX_TEST_LABEL = 'TEST — the bank\'s test system. Use a test card; no real money moves.';

/** [C10 · PT-4] What a session says about itself: a simulator page or a sandbox is a test, and says so. */
export function cardTestLabel(s: Pick<CardSession, 'provider' | 'environment'>): string | undefined {
  if (s.provider === SIMULATOR_PROVIDER) return SIMULATOR_PAGE.testModeLabel;
  if (s.environment === 'sandbox') return CARD_SANDBOX_TEST_LABEL;
  return undefined;
}

function sessionDto(s: CardSession): CardSessionDto {
  const testModeLabel = cardTestLabel(s);
  const testMode = testModeLabel !== undefined;
  return {
    sessionId: s.id,
    purpose: s.purpose,
    status: s.status,
    hostedUrl: s.hostedUrl,
    expiresAt: s.expiresAt.toISOString(),
    ...(s.purpose === 'PAY_NOW' ? { amount: Number(s.amount), currencyCode: s.currencyCode ?? undefined } : {}),
    testMode,
    ...(testModeLabel ? { testModeLabel } : {}),
  };
}

/** [PT-1 · AX297 F1] Review-only concurrency seams. Production never supplies these. */
export interface CardRailObserver {
  /** Inside a card removal's or replacement's transaction, before it takes any lock. */
  beforeCardLocks?: (subscriptionId: string, tx: Prisma.TransactionClient) => Promise<void>;
  /** Inside the same transaction, the moment payer -> subscription -> card
   *  are locked and before the change is written. */
  afterCardLocked?: (subscriptionId: string, tx: Prisma.TransactionClient) => Promise<void>;
}

/**
 * [PT-1 · AX297 F1] payer -> subscription: the locks billing's dispatch
 * authorization takes (lockPaymentOutcomeAuthority) before it locks the card
 * it is about to charge. Everything that changes WHICH card a subscription
 * charges takes the same two, in the same order, and then the card: a
 * removal or replacement that commits first is seen by the authorization,
 * and one that arrives while a charge is being authorized waits for it.
 */
async function lockCardAuthority(tx: Prisma.TransactionClient, subscriptionId: string): Promise<void> {
  await lockSubscriptionPayer(tx, subscriptionId);
}

export class CardRailService {
  private provider?: CardRailProvider;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationService,
    private readonly billing: BillingService,
    private readonly cardRail: CardRailSource,
    /** returnUrlBase: where the provider sends the browser back, the public
     *  API origin (defaults to API_PUBLIC_URL; relative when unset).
     *  observer: test-only seams (CardRailObserver). */
    private readonly opts: { returnUrlBase?: string; observer?: CardRailObserver } = {},
  ) {}

  private rail(): CardRailProvider {
    return (this.provider ??= this.cardRail());
  }

  // -------------------------------------------------------------------------
  // Open a hosted session
  // -------------------------------------------------------------------------

  async startSession(input: {
    userId: string;
    subscriptionId: string;
    purpose: CardSessionPurpose;
    /** The client's retry key: the same key answers the same session. */
    idempotencyKey?: string;
    /** ENROLL: the consent version the partner accepted on screen. */
    consentVersion?: string;
    now?: Date;
  }): Promise<CardSessionDto> {
    if (!cardRailV2Enabled()) throw new AppError(404, 'CARD_RAIL_UNAVAILABLE', 'Card payments are not available.');
    // [C7] The kill switch stops new sessions; what already exists keeps draining.
    if (cardRailKilled()) throw new AppError(503, 'CARD_RAIL_DISABLED', 'Card payments are paused right now. Please use another way to pay.');
    const now = input.now ?? new Date();
    if (input.idempotencyKey !== undefined && (input.idempotencyKey.length < KEY_MIN || input.idempotencyKey.length > KEY_MAX)) {
      throw new AppError(400, 'IDEMPOTENCY_KEY_INVALID', `The idempotency key must be ${KEY_MIN}–${KEY_MAX} characters.`);
    }
    const { sub, tenantId } = await this.ownedSubscription(input.userId, input.subscriptionId);
    if (sub.status === 'CANCELLED') throw new AppError(409, 'SUBSCRIPTION_CLOSED', 'This subscription has ended.');

    if (input.idempotencyKey) {
      const replay = await this.replayOf(input.userId, sub.id, input.purpose, input.idempotencyKey);
      if (replay) return replay;
    }

    let priced: Awaited<ReturnType<BillingService['quoteCardPayNow']>> | null = null;
    if (input.purpose === 'ENROLL') {
      if (input.consentVersion !== CARD_ON_FILE_CONSENT_VERSION) {
        throw new AppError(400, 'CARD_CONSENT_REQUIRED', 'Agree to weekly card charges before adding a card.');
      }
    } else {
      priced = await this.billing.quoteCardPayNow(sub.id, now);
    }

    const provider = this.rail();
    const state = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now.getTime() + CARD_SESSION_TTL_MS);
    let session: CardSession;
    try {
      const reserved = await this.prisma.$transaction(async (tx) => {
        const authority = await lockFeeCollectionAuthority(tx, sub.id);
        if (priced) {
          const decision = await lockFeePaymentDecision(tx, sub.id, new Date());
          if (!decision.allowed) return { kind: 'blocked' as const };
        } else if (!authority.allowed) throw new AppError(409, 'MOVER_FEE_REVIEW_REQUIRED', 'This weekly fee needs review before opening another payment page.');
        if (priced) {
          const current = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });
          // A read-only quote can project revision zero before this same
          // locked transaction records the first unchanged classification.
          const sameRevision = (authority.mover?.revision ?? null) === priced.feeBasis.authorityRevision
            || (priced.feeBasis.authorityRevision === 0 && authority.mover?.revision === 1);
          if (!sameRevision
            || (authority.mover?.feeType ?? current.type) !== priced.feeBasis.type
            || Number(current.weeklyRate) !== priced.feeBasis.weeklyRate || String(current.customRate) !== priced.feeBasis.customRate
            || current.feeWaived !== priced.feeBasis.feeWaived || current.currencyCode !== priced.currencyCode
            || current.nextBillingDate.getTime() !== priced.periodStart.getTime()) {
            throw new AppError(409, 'MOVER_FEE_PRICE_CHANGED', 'The weekly fee changed. Reload it before opening a payment page.');
          }
        }
        await lockBillingAuthority(tx, sub.id);
        const created = await tx.cardSession.create({
        data: {
          tenantId,
          subscriptionId: sub.id,
          userId: input.userId,
          purpose: input.purpose,
          provider: provider.binding.provider,
          environment: provider.binding.environment,
          providerAccount: provider.binding.account,
          stateHash: sha256Hex(state),
          expiresAt,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(priced
            ? { amount: priced.amount, currencyCode: priced.currencyCode, periodStart: priced.periodStart }
            : { consentVersion: input.consentVersion, consentAt: now }),
        },
        });
        if (created.purpose === 'PAY_NOW') await beginConfirmationInTx(tx, sub.id, { cardSessionId: created.id }, 'CARD_PAGE_PENDING', now);
        return { kind: 'reserved' as const, session: created };
      });
      if (reserved.kind === 'blocked') throw new AppError(409, 'PAYMENT_CONFIRMING', 'Weekly-fee collection is paused while payment information is confirmed.');
      session = reserved.session;
    } catch (error) {
      if ((error as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        // A concurrent retry with the same key won: answer its session. Otherwise
        // this is the one-live-session law [C6].
        const replay = input.idempotencyKey ? await this.replayOf(input.userId, sub.id, input.purpose, input.idempotencyKey) : null;
        if (replay) return replay;
        throw new AppError(409, 'CARD_SESSION_OPEN', 'A card page for this is already open. Finish it there, or wait a few minutes for it to close.');
      }
      throw error;
    }

    // The intent exists; now, and only now, the provider is asked for a page.
    const base = (this.opts.returnUrlBase ?? process.env['API_PUBLIC_URL'] ?? '').replace(/\/+$/, '');
    const returnUrl = `${base}/api/v1/billing/card/return?session=${encodeURIComponent(session.id)}&state=${encodeURIComponent(state)}`;
    let created: CreateCardSessionOutcome;
    try {
      created = await provider.createSession({
        binding: provider.binding,
        sessionRef: session.id,
        purpose: input.purpose,
        returnUrl,
        expiresAt,
        ...(priced ? { amountMinor: toProviderMinor(priced.amount, priced.currencyCode, 'card.v2.session'), currencyCode: priced.currencyCode } : {}),
      });
    } catch (err) {
      log().error({ err, sessionId: session.id }, '[PT-1] card provider could not open a hosted page');
      created = { status: 'unknown', reason: 'provider call failed', rawSha256: rawDigest({ failed: session.id }) };
    }
    if (created.status !== 'succeeded') {
      if (created.status === 'failed' || input.purpose === 'ENROLL') {
        // [PT-4] The provider answers definitively that it made no page (or this
        // is an enrolment, which moves no money): nothing can ever be paid on
        // it. It closes, and a Pay now's confirmation is resolved as having had
        // no effect, so the fee's other ways to pay reopen at once.
        await this.cancelUnopened(session, created.rawSha256, now);
      } else {
        // An ambiguous create response is not proof that the provider created nothing.
        await this.prisma.cardSession.updateMany({
          where: { id: session.id, status: 'OPEN' },
          data: { status: 'UNKNOWN', failureCode: 'PROVIDER_PAGE_UNAVAILABLE', confirmedAt: now },
        });
      }
      throw new AppError(502, 'CARD_SESSION_UNAVAILABLE', 'The card page could not be opened. Please try again in a moment.');
    }
    const opened = await this.prisma.cardSession.update({
      where: { id: session.id },
      data: { providerSessionRef: created.providerSessionRef, hostedUrl: created.hostedUrl },
    });
    return this.handoffSession(opened, input.userId);
  }

  /** [PT-4] A session whose page was never made: CANCELLED, and — for a Pay
   *  now — its confirmation resolved PROVEN_NO_EFFECT under the same locks
   *  every other resolution takes. */
  private async cancelUnopened(session: CardSession, evidence: string, now: Date): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || fresh.status !== 'OPEN') return;
      await tx.cardSession.update({ where: { id: fresh.id }, data: { status: 'CANCELLED', failureCode: 'PROVIDER_PAGE_UNAVAILABLE', confirmedAt: now } });
      if (fresh.purpose === 'PAY_NOW') {
        await resolveConfirmationInTx(tx, fresh.subscriptionId, { cardSessionId: fresh.id }, 'PROVEN_NO_EFFECT', { actor: 'card-provider', reference: evidence }, now);
      }
    });
  }

  private async replayOf(userId: string, subscriptionId: string, purpose: CardSessionPurpose, idempotencyKey: string): Promise<CardSessionDto | null> {
    const found = await this.prisma.cardSession.findUnique({
      where: { subscriptionId_purpose_idempotencyKey: { subscriptionId, purpose, idempotencyKey } },
    });
    if (!found) return null;
    if (found.userId !== userId) throw new NotFoundError('Subscription', subscriptionId);
    return this.handoffSession(found, userId);
  }

  /** Provider creation and stored-key replay share the final payable-URL
   * decision. Provider fields stay stored even when another hold wins. */
  private async handoffSession(session: CardSession, userId: string): Promise<CardSessionDto> {
    // [PT-2] A page address is handed out only while its page can still be used.
    if (session.purpose !== 'PAY_NOW') {
      return sessionDto({ ...session, hostedUrl: session.status === 'OPEN' && session.expiresAt > new Date() ? session.hostedUrl : null });
    }
    const result = await this.prisma.$transaction(async (tx) => {
      const owner = await lockBillingAuthority(tx, session.subscriptionId);
      if (owner.userId !== userId) throw new NotFoundError('Subscription', session.subscriptionId);
      const now = new Date();
      const decision = await lockFeePaymentDecision(tx, session.subscriptionId, now, { cardSessionId: session.id });
      await tx.$queryRaw`SELECT "id" FROM "card_sessions" WHERE "id" = ${session.id} FOR UPDATE`;
      const current = await tx.cardSession.findUniqueOrThrow({ where: { id: session.id } });
      const payable = current.status === 'OPEN' && current.expiresAt > now;
      return { current, payable, blocked: payable && !decision.allowed };
    });
    if (result.blocked) throw new AppError(409, 'PAYMENT_CONFIRMING', 'Weekly-fee collection is paused while payment information is confirmed.', { sessionId: result.current.id });
    return sessionDto({ ...result.current, hostedUrl: result.payable ? result.current.hostedUrl : null });
  }

  /** The subscription the caller pays for, as the caller's tenant sees it — or 404. */
  private async ownedSubscription(userId: string, subscriptionId: string) {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { owner: { select: { userId: true } } } },
      },
    });
    const payer = sub?.rider?.userId ?? sub?.driver?.userId ?? sub?.vendor?.owner.userId;
    if (!sub || payer !== userId) throw new NotFoundError('Subscription', subscriptionId);
    // The user lookup is tenant-scoped under a request: a payer in another
    // tenant is invisible, and so is their subscription.
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
    const bound = getTenantContext().tenantId;
    if (!user || (bound && bound !== user.tenantId)) throw new NotFoundError('Subscription', subscriptionId);
    return { sub, tenantId: user.tenantId };
  }

  // -------------------------------------------------------------------------
  // The browser comes back — an observation, never money
  // -------------------------------------------------------------------------

  /**
   * [C5 · C8] Record what the browser brought back, and decide whether it may
   * prompt a confirmation. It grants nothing itself: a wrong state, user,
   * tenant or purpose, an expired or closed session, or a second return of
   * the same session is recorded with its reason and ends there. The first
   * valid return is marked on the session (once) in the same transaction as
   * its evidence.
   */
  async handleReturn(input: {
    sessionId: string;
    state: string;
    /** Every query/body parameter the return carried. */
    params: Readonly<Record<string, string>>;
    /** The signed-in caller, when the return arrives in one. */
    actorUserId?: string;
    /** The purpose the return route serves, when it serves one. */
    expectedPurpose?: CardSessionPurpose;
    now?: Date;
  }): Promise<{ accepted: boolean; verdict: CardReturnVerdict; sessionId: string; purpose?: CardSessionPurpose }> {
    const now = input.now ?? new Date();
    const session = await this.prisma.cardSession.findUnique({ where: { id: input.sessionId } });
    if (!session) return { accepted: false, verdict: 'UNKNOWN_SESSION', sessionId: input.sessionId };

    const provider = this.rail();
    const bindingOk = sameBinding(bindingOf(session), provider.binding);
    // The provider parses only what it added; Swift's own session and state are not its payload.
    const providerParams = Object.fromEntries(Object.entries(input.params).filter(([k]) => k !== 'session' && k !== 'state'));
    const observed: CardReturnObservation = bindingOk
      ? provider.parseReturn(providerParams)
      : { rawSha256: rawDigest(providerParams), claimedStatus: 'invalid' };

    let verdict: CardObservationVerdict = this.returnVerdict(session, input, bindingOk, now);
    await this.prisma.$transaction(async (tx) => {
      if (verdict === 'ACCEPTED') {
        const marked = await tx.cardSession.updateMany({
          where: { id: session.id, status: 'OPEN', returnedAt: null },
          data: { returnedAt: now },
        });
        if (marked.count !== 1) verdict = 'REJECTED_REPLAY';
      }
      await recordCardObservation(tx, this.observation(session, 'RETURN', observed.rawSha256, observedStatus(observed.claimedStatus), verdict));
    });
    // [PT-4] The first valid return only: a provider that completes on the
    // browser's 3-D Secure result keeps its own decision (never money).
    if (verdict === 'ACCEPTED' && session.providerSessionRef && provider.noteReturn) {
      await provider.noteReturn({ binding: provider.binding, providerSessionRef: session.providerSessionRef, params: providerParams });
    }
    return { accepted: verdict === 'ACCEPTED', verdict, sessionId: session.id, purpose: session.purpose };
  }

  private returnVerdict(
    session: CardSession,
    input: { state: string; actorUserId?: string; expectedPurpose?: CardSessionPurpose },
    bindingOk: boolean,
    now: Date,
  ): CardObservationVerdict {
    // The state first: without it, a caller learns nothing more about the session.
    if (!stateMatches(input.state, session.stateHash)) return 'REJECTED_STATE';
    if (!bindingOk) return 'REJECTED_BINDING';
    if (input.actorUserId !== undefined && input.actorUserId !== session.userId) return 'REJECTED_USER';
    const bound = getTenantContext().tenantId;
    if (bound && bound !== session.tenantId) return 'REJECTED_TENANT';
    if (input.expectedPurpose !== undefined && input.expectedPurpose !== session.purpose) return 'REJECTED_PURPOSE';
    if (session.status !== 'OPEN') return 'REJECTED_CLOSED';
    if (now.getTime() > session.expiresAt.getTime()) return 'REJECTED_EXPIRED';
    if (session.returnedAt) return 'REJECTED_REPLAY';
    return 'ACCEPTED';
  }

  // -------------------------------------------------------------------------
  // Confirm — the only path to money
  // -------------------------------------------------------------------------

  /**
   * Ask the provider — server to server — what happened on a session, and act
   * on that answer only. ENROLL success seals the vault token and makes the
   * card the subscription's ACTIVE instrument (the previous one REPLACED, in
   * the same transaction). PAY_NOW success, when the provider's amount and
   * currency equal the server's price, books the week ONCE through billing's
   * applySuccessfulCharge path, which also reinstates a billing suspension.
   * Anything that disagrees is HELD for a person. Repeating a confirm, or
   * racing the sweep, changes nothing twice. Not stopped by the kill switch.
   */
  async confirm(sessionId: string, opts: { now?: Date; actorUserId?: string } = {}): Promise<CardConfirmResult> {
    const now = opts.now ?? new Date();
    const session = await this.prisma.cardSession.findUnique({ where: { id: sessionId } });
    if (!session || (opts.actorUserId !== undefined && opts.actorUserId !== session.userId)) throw new NotFoundError('Card session', sessionId);
    if (!LIVE.includes(session.status)) return this.resultOf(session);
    // [PT-4 · one money movement] Its week is already booked: it is SUCCEEDED,
    // whatever the provider's record now says (it is never voided, held or
    // re-asked). Booking and success commit together; this heals a session
    // booked before they did.
    const finished = await this.finishBooked(session, now);
    if (finished) return finished;
    const expired = now.getTime() > session.expiresAt.getTime();
    // [C8] An enrolment is granted inside its window, or on a return accepted
    // inside it — never on a late or absent one. (A Pay now is always asked:
    // money may have moved.)
    if (session.purpose === 'ENROLL' && expired && !session.returnedAt) return this.close(session, 'EXPIRED', 'EXPIRED_UNUSED', null, now);
    if (!session.providerSessionRef) return session.purpose === 'PAY_NOW' ? this.resultOf(session) : this.close(session, 'CANCELLED', 'PROVIDER_PAGE_UNAVAILABLE', null, now);

    const provider = this.rail();
    if (!sameBinding(bindingOf(session), provider.binding)) {
      // [C2] Asked of nobody: the session belongs to another provider setup.
      await this.alertBinding(session, provider);
      return this.resultOf(session);
    }
    await this.prisma.cardSession.updateMany({ where: { id: session.id }, data: { lastCheckedAt: now } });
    const outcome = await provider.confirm({ binding: provider.binding, providerSessionRef: session.providerSessionRef, purpose: session.purpose,
      beforeCompletion: (providerRef) => this.claimCompletion(session.id, providerRef),
    });
    switch (outcome.status) {
      case 'succeeded':
        if (outcome.purpose !== session.purpose) return this.hold(session, outcome, 'PURPOSE_MISMATCH', now, undefined, 'providerRef' in outcome ? outcome.providerRef : undefined);
        return outcome.purpose === 'ENROLL' ? this.enrollCard(session, outcome, now) : this.settlePayNow(session, outcome, now);
      case 'failed':
        return this.close(session, 'FAILED', failureCodeOf(outcome.reason), outcome, now);
      case 'requires_action':
      case 'pending':
        // Local expiry cannot prove a payable instruction will never settle.
        if (expired && session.purpose === 'PAY_NOW') return this.markUnknown(session, outcome, now);
        if (expired) return this.close(session, 'EXPIRED', outcome.status === 'pending' ? 'EXPIRED_UNUSED' : 'EXPIRED_UNAUTHENTICATED', outcome, now);
        return this.observeOnly(session, outcome);
      case 'unknown': {
        // [Review S2-2] The provider may have taken money Swift cannot book:
        // void it now, under a durable claim; hold it for a person otherwise.
        if (outcome.voidable) return this.voidUnbookable(session, outcome, outcome.voidable.providerRef, now);
        // [CARDS S1] A completion was durably claimed (so it may have been
        // sent) and the provider can no longer say what became of it: past its
        // deadline it is treated as possibly taken — voided under the recorded
        // transaction, or held for a person. Never left open for a "not paid".
        const lost = this.lostCompletionRef(session, now);
        if (lost) return this.voidUnbookable(session, outcome, lost, now);
        if (!expired) return this.observeOnly(session, outcome);
        // A Pay now may have moved money: it stays UNKNOWN and keeps being
        // asked. An enrolment moved none: it closes, and the card is added again.
        return session.purpose === 'PAY_NOW' ? this.markUnknown(session, outcome, now) : this.close(session, 'EXPIRED', 'PROVIDER_UNKNOWN', outcome, now);
      }
      default:
        return assertNever(outcome, 'card session outcome');
    }
  }

  /**
   * [CARDS S1] The durable claim on a completion, taken under the billing
   * authority and session locks immediately before the provider sends it.
   * Finance's "not paid" takes the same locks first, so the two never cross:
   * either the session closed first (the completion is never sent) or the claim
   * stands (finance refuses while it may be answering, and afterwards sends the
   * decision to the card session). A claim already recorded is never sent twice.
   */
  private claimCompletion(sessionId: string, providerRef: string): Promise<CompletionClaim> {
    return this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, sessionId);
      if (fresh?.completionClaimedAt) return 'claimed' as const;
      if (!fresh || !LIVE.includes(fresh.status)) return 'closed' as const;
      const ref = providerRef.trim().slice(0, 64);
      await tx.cardSession.update({
        where: { id: fresh.id },
        data: { completionClaimedAt: new Date(), ...(!fresh.providerTransactionRef && ref ? { providerTransactionRef: ref } : {}) },
      });
      return 'send' as const;
    });
  }

  /** [CARDS S1] The transaction of a completion claimed on this session whose
   *  answer can no longer arrive (claimed longer ago than its deadline). */
  private lostCompletionRef(session: CardSession, now: Date): string | null {
    if (session.purpose !== 'PAY_NOW' || !session.completionClaimedAt || !session.providerTransactionRef) return null;
    return now.getTime() > session.completionClaimedAt.getTime() + COMPLETION_CLAIM_WAIT_MS ? session.providerTransactionRef : null;
  }

  private async enrollCard(
    session: CardSession,
    outcome: Extract<CardSessionOutcome, { status: 'succeeded'; purpose: 'ENROLL' }>,
    now: Date,
  ): Promise<CardConfirmResult> {
    const card = outcome.card;
    const factsValid = /^[0-9]{4}$/.test(card.last4)
      && Number.isInteger(card.expMonth) && card.expMonth >= 1 && card.expMonth <= 12
      && Number.isInteger(card.expYear) && card.expYear >= 2000 && card.expYear <= 2199
      && card.brand.trim().length > 0 && card.brand.length <= 32;
    if (!factsValid) return this.hold(session, outcome, 'CARD_FACTS_INVALID', now);
    if (cardExpiredAt(card, now)) return this.close(session, 'FAILED', 'CARD_EXPIRED', outcome, now);
    const sealed = await sealVaultToken(card.vaultToken);

    const result = await this.prisma.$transaction(async (tx) => {
      await this.opts.observer?.beforeCardLocks?.(session.subscriptionId, tx);
      const authority = await lockFeeCollectionAuthority(tx, session.subscriptionId);
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || !LIVE.includes(fresh.status)) return { lost: fresh };
      if (!authority.allowed) return { lost: await tx.cardSession.update({ where: { id: fresh.id }, data: { status: 'HELD', failureCode: 'MOVER_FEE_REVIEW_REQUIRED' } }) };
      // [AX297 F1] payer -> subscription -> the card this replaces: a weekly
      // charge being authorized on that card finishes first, or sees it REPLACED.
      await lockCardAuthority(tx, fresh.subscriptionId);
      await recordCardObservation(tx, this.observation(fresh, 'CONFIRM', outcome.rawSha256, 'SUCCEEDED', 'ACCEPTED'));
      const [previous] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "payment_instruments" WHERE "subscriptionId" = ${fresh.subscriptionId} AND "status" = 'ACTIVE' FOR UPDATE
      `;
      await this.opts.observer?.afterCardLocked?.(fresh.subscriptionId, tx);
      if (previous) await tx.paymentInstrument.update({ where: { id: previous.id }, data: { status: 'REPLACED', replacedAt: now } });
      // [AX318 R1] A weekly charge on the replaced card: authorized but never
      // handed off -> closed, never sent (the attempt is billed again on the
      // new card); already handed off -> in flight, reported.
      if (previous) await closeUnsentCardIntents(tx, { instrumentId: previous.id }, 'CARD_REPLACED', now);
      const previousInFlight = previous ? await cardChargesInFlight(tx, previous.id) : 0;
      const instrument = await tx.paymentInstrument.create({
        data: {
          tenantId: fresh.tenantId,
          subscriptionId: fresh.subscriptionId,
          userId: fresh.userId,
          provider: fresh.provider,
          environment: fresh.environment,
          providerAccount: fresh.providerAccount,
          ...sealed,
          brand: card.brand.trim(),
          last4: card.last4,
          expMonth: card.expMonth,
          expYear: card.expYear,
          consentVersion: fresh.consentVersion!,
          consentAt: fresh.consentAt!,
        },
        select: INSTRUMENT_DTO_SELECT,
      });
      if (previous) await tx.paymentInstrument.update({ where: { id: previous.id }, data: { replacedById: instrument.id } });
      await tx.cardSession.update({ where: { id: fresh.id }, data: { status: 'SUCCEEDED', instrumentId: instrument.id, confirmedAt: now, failureCode: null } });
      // Enrolling a card for the weekly fee is choosing the card rail for it.
      const sub = await tx.subscription.update({ where: { id: fresh.subscriptionId }, data: { billingMethod: 'CARD' }, select: { currencyCode: true } });
      await tx.billingEvent.create({
        data: {
          subscriptionId: fresh.subscriptionId,
          type: 'TIER_CHANGE',
          currencyCode: sub.currencyCode,
          idempotencyKey: `rail:card:${instrument.id}`,
          note: `Billing rail set to CARD (${instrument.brand} ending ${instrument.last4})${previous ? `, replacing card ${previous.id}` : ''}`,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: fresh.userId,
          action: 'CARD_ENROLLED',
          entity: 'PaymentInstrument',
          entityId: instrument.id,
          changes: {
            subscriptionId: fresh.subscriptionId, sessionId: fresh.id, brand: instrument.brand, last4: instrument.last4,
            expMonth: instrument.expMonth, expYear: instrument.expYear, replaced: previous?.id ?? null, consentVersion: fresh.consentVersion,
          },
        },
      });
      return { instrument, previousInFlight };
    });
    if ('lost' in result) return this.resultOf(result.lost ?? session);
    return {
      sessionId: session.id, purpose: 'ENROLL', status: 'SUCCEEDED', instrument: result.instrument,
      ...(result.previousInFlight > 0 ? { paymentInProgress: true } : {}),
    };
  }

  private async settlePayNow(
    session: CardSession,
    outcome: Extract<CardSessionOutcome, { status: 'succeeded'; purpose: 'PAY_NOW' }>,
    now: Date,
  ): Promise<CardConfirmResult> {
    const current = await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh) throw new NotFoundError('Card session', session.id);
      if (session.provider === POWERTRANZ_PROVIDER && outcome.completionEvidence && !fresh.completionEvidence) {
        await tx.cardSession.update({ where: { id: fresh.id }, data: { completionEvidence: outcome.completionEvidence } });
      }
      return fresh;
    });
    if (!LIVE.includes(current.status)) {
      if (current.status === 'SUCCEEDED' || current.paymentId) return this.resultOf(current);
      return this.voidUnbookable(current, outcome, outcome.providerRef, now);
    }
    // [Review S2-1] A provider's TEST system (the simulator, a sandbox) moves
    // no real money: it books a week only for a listed test subscription.
    // Anything else is held for a person — never a real partner's paid week.
    if (session.environment !== 'live' && !cardTestSubscriptions().has(session.subscriptionId)) {
      return this.hold(session, outcome, 'TEST_SYSTEM_FOR_A_REAL_PARTNER', now, undefined, outcome.providerRef);
    }
    // The provider's figure must be the server's price, to the minor unit.
    const expectedMinor = toProviderMinor(Number(session.amount), session.currencyCode!, 'card.v2.paynow');
    if (outcome.amountMinor !== expectedMinor || outcome.currencyCode !== session.currencyCode) {
      return this.hold(session, outcome, 'AMOUNT_MISMATCH', now, undefined, outcome.providerRef);
    }
    // The local money record this capture books through: ONE per session
    // (its clientKey is the session), linked in the same transaction as the evidence.
    const paymentId = await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || !LIVE.includes(fresh.status)) return 'CLOSED' as const;
      // [Review S2-2 · one money movement] A void was already sent for this
      // session: its money may be on its way back. It is never also booked
      // (the database refuses it too) — a person looks.
      if (fresh.providerVoidState !== null) return 'VOID_SENT' as const;
      await recordCardObservation(tx, this.observation(fresh, 'CONFIRM', outcome.rawSha256, 'SUCCEEDED', 'ACCEPTED'));
      if (fresh.paymentId) return fresh.paymentId;
      const payment = await tx.subscriptionPayment.create({
        data: {
          subscriptionId: fresh.subscriptionId,
          amount: fresh.amount!,
          status: 'UNKNOWN',
          paymentMethod: 'CARD',
          clientKey: `${CARD_PAY_NOW_KEY_PREFIX}${fresh.id}`,
          purpose: 'CARD_PAY_NOW',
          failureRaw: { providerEffect: 'AUTHORIZED', providerRail: 'CARD', cardSessionId: fresh.id },
          periodStart: fresh.periodStart!,
          periodEnd: new Date(fresh.periodStart!.getTime() + WEEK_MS),
        },
        select: { id: true },
      });
      await tx.cardSession.update({ where: { id: fresh.id }, data: { paymentId: payment.id } });
      return payment.id;
    });
    if (paymentId === 'CLOSED') return this.voidUnbookable(session, outcome, outcome.providerRef, now);
    if (paymentId === 'VOID_SENT') {
      return this.hold(session, outcome, 'APPROVED_UNPROVEN', now, 'An approval arrived after Swift had sent a void for it. Nothing was booked. Check the provider\'s portal, then refund it or record that nothing was taken (two people).', outcome.providerRef);
    }

    // [PT-4 · one money movement] The session takes its success INSIDE the
    // booking's own transaction: the week and SUCCEEDED commit together, or
    // neither does (a session no longer open refuses, and nothing is booked).
    const settled = await this.billing.settleHostedCardPayment({
      subscriptionId: session.subscriptionId, paymentId, providerRef: outcome.providerRef, now,
      inSettlement: this.succeedInSettlement(session.id, now, 'LIVE'),
    });
    if (settled.outcome === 'advanced' || settled.outcome === 'banked') {
      // Booked here, or by a racing confirmation that marked it in its own booking.
      await this.finishBooked(await this.prisma.cardSession.findUniqueOrThrow({ where: { id: session.id } }), now);
      if (settled.outcome === 'banked') await this.noticeBanked(session, paymentId);
      return { sessionId: session.id, purpose: 'PAY_NOW', status: 'SUCCEEDED', settlement: settled.outcome };
    }
    // Captured, but it could not be booked (the wallet holds another currency,
    // the currency it was issued in cannot be vouched for, or the payment row
    // can no longer be claimed): a person decides.
    return this.hold(session, null, settled.outcome === 'held' ? settled.failureCode : 'NOT_SETTLED', now, undefined, outcome.providerRef);
  }

  // -------------------------------------------------------------------------
  // Session state helpers
  // -------------------------------------------------------------------------

  private async lockSession(tx: Prisma.TransactionClient, sessionId: string): Promise<CardSession | null> {
    const candidate = await tx.cardSession.findUnique({ where: { id: sessionId }, select: { subscriptionId: true } });
    if (!candidate) return null;
    await lockBillingAuthority(tx, candidate.subscriptionId);
    await tx.$queryRaw`SELECT "id" FROM "card_sessions" WHERE "id" = ${sessionId} FOR UPDATE`;
    return tx.cardSession.findUnique({ where: { id: sessionId } });
  }

  private observation(
    session: Pick<CardSession, 'id' | 'subscriptionId' | 'provider' | 'environment' | 'instrumentId' | 'paymentId'>,
    source: CardObservationSource,
    rawSha256: string,
    parsedStatus: CardObservedStatus,
    verdict: CardObservationVerdict,
  ) {
    return {
      source, sessionId: session.id, subscriptionId: session.subscriptionId,
      instrumentId: session.instrumentId, paymentId: session.paymentId,
      provider: session.provider, environment: session.environment,
      rawSha256, parsedStatus, verdict,
    };
  }

  /** A provider answer that changes nothing yet (the partner is still on the
   *  page). A plain "pending" is not even worth a row. */
  private async observeOnly(session: CardSession, outcome: CardSessionOutcome): Promise<CardConfirmResult> {
    if (outcome.status !== 'pending' && !(await this.sameAsLastObservation(session.id, outcome.rawSha256))) {
      await recordCardObservation(this.prisma, this.observation(session, 'CONFIRM', outcome.rawSha256, observedStatus(outcome.status), 'ACCEPTED'));
    }
    return this.resultOf(session);
  }

  /** [Review S4] The sweep asks an unanswered session again every ten
   *  minutes: an answer identical to the last one recorded adds no evidence
   *  and is not written again (the table is append-only and would grow forever). */
  private async sameAsLastObservation(sessionId: string, rawSha256: string): Promise<boolean> {
    const last = await this.prisma.cardObservation.findFirst({
      where: { sessionId, source: 'CONFIRM' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { rawSha256: true },
    });
    return last?.rawSha256 === rawSha256;
  }

  private async markUnknown(session: CardSession, outcome: CardSessionOutcome, now: Date): Promise<CardConfirmResult> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || !LIVE.includes(fresh.status)) return;
      if (fresh.purpose === 'PAY_NOW') await beginConfirmationInTx(tx, fresh.subscriptionId, { cardSessionId: fresh.id }, 'CARD_CONFIRMATION_PENDING', now);
      const last = await tx.cardObservation.findFirst({ where: { sessionId: session.id, source: 'CONFIRM' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { rawSha256: true } });
      if (last?.rawSha256 !== outcome.rawSha256) {
        await recordCardObservation(tx, this.observation(session, 'CONFIRM', outcome.rawSha256, observedStatus(outcome.status), 'ACCEPTED'));
      }
      await tx.cardSession.updateMany({ where: { id: session.id, status: 'OPEN' }, data: { status: 'UNKNOWN', failureCode: 'PROVIDER_UNKNOWN' } });
    });
    log().warn({ sessionId: session.id, subscriptionId: session.subscriptionId, at: now.toISOString() }, '[PT-1] card Pay-now session past its window with no answer — kept UNKNOWN, asked again later');
    return this.resultOf(await this.prisma.cardSession.findUniqueOrThrow({ where: { id: session.id } }));
  }

  private async close(
    session: CardSession,
    status: 'FAILED' | 'EXPIRED' | 'CANCELLED',
    failureCode: string,
    outcome: CardSessionOutcome | null,
    now: Date,
  ): Promise<CardConfirmResult> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || (!LIVE.includes(fresh.status) && !(fresh.status === 'HELD' && fresh.failureCode === 'LATE_PROVIDER_APPROVAL'))) return;
      if (fresh.purpose === 'PAY_NOW') await beginConfirmationInTx(tx, fresh.subscriptionId, { cardSessionId: fresh.id }, 'CARD_CONFIRMATION_PENDING', now);
      if (outcome) {
        await recordCardObservation(tx, this.observation(session, 'CONFIRM', outcome.rawSha256, observedStatus(outcome.status), 'ACCEPTED'));
      }
      await tx.cardSession.updateMany({ where: { id: session.id, status: fresh.status }, data: { status, failureCode, ...(fresh.confirmedAt ? {} : { confirmedAt: now }) } });
      if (fresh.purpose === 'PAY_NOW' && outcome?.status === 'failed') {
        await resolveConfirmationInTx(tx, fresh.subscriptionId, { cardSessionId: fresh.id }, 'PROVEN_UNPAID', { actor: 'card-provider', reference: outcome.rawSha256 }, now);
      }
    });
    return this.resultOf(await this.prisma.cardSession.findUniqueOrThrow({ where: { id: session.id } }));
  }

  /**
   * [Review S2-2] The provider may have taken money that Swift cannot book.
   * ONE void is sent (sec. 5.2 / 7.6 of the provider's guide: before the Sale
   * settles), under a DURABLE claim on the session (providerVoidState NULL ->
   * SENDING, trigger-guarded, never resent). The session closes FAILED only
   * once the provider confirms the void; otherwise it is HELD for a person,
   * with the provider's transaction reference, and admins are paged at once.
   */
  private async voidUnbookable(session: CardSession, outcome: CardSessionOutcome, providerRef: string, now: Date): Promise<CardConfirmResult> {
    const reason = outcome.status === 'unknown' ? outcome.reason : 'UNBOOKABLE';
    const ref = providerRef.trim().slice(0, 64) || null;
    if (!ref) return this.hold(session, outcome, 'APPROVED_UNPROVEN', now, 'The provider gave no transaction reference to void.');
    const claimed = await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || fresh.status === 'SUCCEEDED' || fresh.paymentId) return { fresh, claimed: false, late: false };
      const late = ['FAILED', 'EXPIRED', 'CANCELLED'].includes(fresh.status);
      if (!LIVE.includes(fresh.status) && !late && fresh.failureCode !== 'LATE_PROVIDER_APPROVAL') return { fresh, claimed: false, late: false };
      const last = await tx.cardObservation.findFirst({ where: { sessionId: fresh.id, source: 'CONFIRM' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { rawSha256: true } });
      if (last?.rawSha256 !== outcome.rawSha256) {
        await recordCardObservation(tx, this.observation(fresh, 'CONFIRM', outcome.rawSha256, 'UNKNOWN', 'REJECTED_MISMATCH'));
      }
      const won = await tx.cardSession.updateMany({
        // A late approval reopens only a session finance has not already decided.
        where: { id: fresh.id, providerVoidState: null, paymentId: null, ...(late ? { resolution: null } : {}) },
        data: { providerVoidState: 'SENDING', providerVoidAt: now, providerTransactionRef: ref,
          ...(late ? { status: 'HELD', failureCode: 'LATE_PROVIDER_APPROVAL' } : {}),
        },
      });
      if (late && won.count) await reopenConfirmationForReviewInTx(tx, fresh.subscriptionId, { cardSessionId: fresh.id }, 'LATE_PROVIDER_APPROVAL', now);
      return { fresh, claimed: won.count === 1, late };
    });
    if (claimed.late) await notifyAdmins(this.prisma, this.notifications, {
      tenantId: session.tenantId, title: 'Card approval arrived after closure',
      body: `Card session ${session.id} received a provider approval after it was closed. Nothing was booked. Provider transaction ${ref}. ${claimed.claimed
        ? 'A void was sent: check its outcome on the session, then refund it or record that nothing was taken (two people).'
        : 'Finance had already decided this payment: check the transaction in the provider\'s portal.'}`,
      data: { kind: 'billing_invariants', alert: 'card-session-late-approval', sessionId: session.id, providerTransactionRef: ref },
      dedupeKey: `card-session-late-approval:${session.id}`,
    }).catch(() => {});
    if (!claimed.claimed) {
      const current = claimed.fresh ?? await this.prisma.cardSession.findUniqueOrThrow({ where: { id: session.id } });
      if (!LIVE.includes(current.status)) return this.resultOf(current);
      if (current.providerVoidState === 'VOIDED') return this.closeVoided(current, outcome.rawSha256, now);
      if (current.providerVoidState === 'SENDING') {
        // The claimant is finishing it — unless it stopped (a crash between the
        // claim and the answer): past the wait the void is unconfirmed, never resent.
        const since = current.providerVoidAt?.getTime() ?? 0;
        if (now.getTime() - since < VOID_ANSWER_WAIT_MS) return this.resultOf(current);
        await this.prisma.cardSession.updateMany({ where: { id: current.id, providerVoidState: 'SENDING' }, data: { providerVoidState: 'UNKNOWN' } });
        return this.hold(current, null, 'APPROVED_UNPROVEN', now,
          `The void was sent and its answer was never recorded. Provider transaction ${current.providerTransactionRef ?? ref}. Check it in the provider's portal, then book it, refund it, or record that nothing was taken (two people).`);
      }
      return this.hold(current, null, 'APPROVED_UNPROVEN', now, current.providerVoidState
        ? `The void ended ${current.providerVoidState}.`
        : 'A payment is already linked to this session, so no void was sent.');
    }
    const provider = this.rail();
    let voided: CardRefundOutcome = { status: 'unknown', reason: 'VOID_NOT_SUPPORTED', rawSha256: rawDigest({ void: 'unsupported' }) };
    if (provider.voidPayment && sameBinding(bindingOf(session), provider.binding)) {
      voided = await provider.voidPayment({ binding: provider.binding, providerRef: ref, idempotencyKey: `void:${session.id}` })
        .catch((): CardRefundOutcome => ({ status: 'unknown', reason: 'VOID_CALL_FAILED', rawSha256: rawDigest({ void: 'threw' }) }));
    }
    const state = voided.status === 'succeeded' ? 'VOIDED' : voided.status === 'failed' ? 'FAILED' : 'UNKNOWN';
    await this.prisma.cardSession.updateMany({ where: { id: session.id, providerVoidState: 'SENDING' }, data: { providerVoidState: state } });
    const after = await this.prisma.cardSession.findUniqueOrThrow({ where: { id: session.id } });
    if (state === 'VOIDED') return this.closeVoided(after, voided.rawSha256, now);
    await recordCardObservation(this.prisma, this.observation(after, 'CONFIRM', voided.rawSha256, observedStatus(voided.status), 'REJECTED_MISMATCH'));
    log().error({ sessionId: session.id, reason, voidState: state }, '[PT-4] card payment may have been taken and could not be voided — held for a person');
    return this.hold(after, null, 'APPROVED_UNPROVEN', now,
      `The card provider's answer could not be booked (${reason}) and the void ${state === 'FAILED' ? 'was refused' : 'is unconfirmed'}. Provider transaction ${ref}. Check it in the provider's portal, then book it, refund it, or record that nothing was taken (two people).`);
  }

  /**
   * [PT-4 · one money movement] Joins billing's booking transaction (its
   * payer -> subscription locks already held, so the session row is locked
   * last, as every other path locks it): the session is marked SUCCEEDED in
   * the same commit as the week. A session that is no longer open (or, for
   * finance, no longer held and unresolved) refuses, and the booking rolls
   * back with it — a week is never booked beside a closed session.
   */
  private succeedInSettlement(sessionId: string, now: Date, from: 'LIVE' | { bookedBy: string }) {
    return async (tx: Prisma.TransactionClient): Promise<void> => {
      await tx.$queryRaw`SELECT "id" FROM "card_sessions" WHERE "id" = ${sessionId} FOR UPDATE`;
      const fresh = await tx.cardSession.findUniqueOrThrow({ where: { id: sessionId } });
      const confirmedAt = fresh.confirmedAt ? {} : { confirmedAt: now };
      if (from === 'LIVE') {
        if (!LIVE.includes(fresh.status)) throw new AppError(409, 'CARD_SESSION_NOT_OPEN', 'This card session is no longer open; nothing was booked.');
        await tx.cardSession.update({ where: { id: sessionId }, data: { status: 'SUCCEEDED', failureCode: null, ...confirmedAt } });
        return;
      }
      if (fresh.status !== 'HELD' || fresh.resolution) throw notHeld();
      await tx.cardSession.update({
        where: { id: sessionId },
        data: { status: 'SUCCEEDED', failureCode: null, ...confirmedAt, resolution: 'BOOKED', resolvedBy: from.bookedBy, resolvedAt: now },
      });
    };
  }

  /** A live Pay now whose payment is already booked is SUCCEEDED (under the
   *  lock). Null ONLY when it is still live and not booked: the caller goes on.
   *  Found closed meanwhile (a racing call finished it): its own state, and
   *  the provider is not asked again. */
  private async finishBooked(session: CardSession, now: Date): Promise<CardConfirmResult | null> {
    if (session.purpose !== 'PAY_NOW' || !session.paymentId || !LIVE.includes(session.status)) return null;
    const step = await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || !LIVE.includes(fresh.status)) return 'closed' as const;
      if (!(await bookedInTx(tx, fresh))) return 'unbooked' as const;
      await tx.cardSession.update({ where: { id: fresh.id }, data: { status: 'SUCCEEDED', failureCode: null, ...(fresh.confirmedAt ? {} : { confirmedAt: now }) } });
      return 'marked' as const;
    });
    if (step === 'unbooked') return null;
    if (step === 'marked') log().warn({ sessionId: session.id }, '[PT-4] card session found booked but still open — marked SUCCEEDED');
    return this.resultOf(await this.prisma.cardSession.findUniqueOrThrow({ where: { id: session.id } }));
  }

  /** The provider confirmed the void: nothing was taken; the session closes and its payment confirmation resolves. */
  private async closeVoided(session: CardSession, evidence: string, now: Date): Promise<CardConfirmResult> {
    return this.close(session, 'FAILED', 'VOIDED_UNPROVEN', { status: 'failed', reason: 'VOIDED', rawSha256: evidence }, now);
  }

  /** The provider's answer disagrees with the session (or could not be
   *  booked): nothing is granted, and a person is paged once. */
  private async hold(session: CardSession, outcome: CardSessionOutcome | null, failureCode: string, now: Date, detail?: string, providerRef?: string): Promise<CardConfirmResult> {
    // [Review S2-2] The provider's own transaction reference (a Pay now that
    // succeeded there but cannot be booked here): recorded once, so finance
    // can look the money up and book or refund exactly that transaction.
    const ref = providerRef?.trim().slice(0, 64) || undefined;
    let recordedRef = session.providerTransactionRef;
    await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || (!LIVE.includes(fresh.status) && !(fresh.status === 'HELD' && fresh.failureCode === 'LATE_PROVIDER_APPROVAL'))) return;
      if (fresh.purpose === 'PAY_NOW') await beginConfirmationInTx(tx, fresh.subscriptionId, { cardSessionId: fresh.id }, 'CARD_CONFIRMATION_PENDING', now);
      if (outcome) {
        await recordCardObservation(tx, this.observation(session, 'CONFIRM', outcome.rawSha256, observedStatus(outcome.status), 'REJECTED_MISMATCH'));
      }
      recordedRef = fresh.providerTransactionRef ?? (fresh.purpose === 'PAY_NOW' ? ref ?? null : null);
      await tx.cardSession.updateMany({
        where: { id: session.id, status: { in: LIVE } },
        data: { status: 'HELD', failureCode: fresh.failureCode === 'LATE_PROVIDER_APPROVAL' ? fresh.failureCode : failureCode, ...(fresh.confirmedAt ? {} : { confirmedAt: now }), ...(!fresh.providerTransactionRef && recordedRef ? { providerTransactionRef: recordedRef } : {}) },
      });
    });
    log().error({ sessionId: session.id, subscriptionId: session.subscriptionId, failureCode }, '[PT-1] card session held for a person — nothing granted');
    await notifyAdmins(this.prisma, this.notifications, {
      tenantId: session.tenantId,
      title: '💳 Card session held for review',
      body: `Card session ${session.id} (${session.purpose}) for subscription ${session.subscriptionId} was held: ${failureCode}. Nothing was granted or booked. ${detail ?? `${recordedRef ? `Provider transaction ${recordedRef}. ` : ''}Check the provider before acting.`}`,
      data: {
        kind: 'billing_invariants', alert: 'card-session-held', subscriptionId: session.subscriptionId, sessionId: session.id, failureCode,
        ...(recordedRef ? { providerTransactionRef: recordedRef } : {}),
      },
      dedupeKey: `card-session-held:${session.id}`,
    }).catch(() => {});
    return this.resultOf(await this.prisma.cardSession.findUniqueOrThrow({ where: { id: session.id } }));
  }

  private async alertBinding(session: CardSession, provider: CardRailProvider): Promise<void> {
    log().error({ sessionId: session.id, bound: describeBinding(bindingOf(session)), configured: describeBinding(provider.binding) }, '[PT-1 C2] card session belongs to another provider setup — nothing asked, nothing granted');
    await notifyAdmins(this.prisma, this.notifications, {
      tenantId: session.tenantId,
      title: '💳 Card session refused — it belongs to another provider setup',
      body: `Card session ${session.id} was opened with ${describeBinding(bindingOf(session))}, but this server is set up for ${describeBinding(provider.binding)}. Nothing was granted. Restore the configuration; the session is checked again on the next sweep.`,
      data: { kind: 'billing_invariants', alert: 'card-session-binding-mismatch', subscriptionId: session.subscriptionId, sessionId: session.id },
      dedupeKey: `card-session-binding:${session.id}:${describeBinding(provider.binding)}`,
    }).catch(() => {});
  }

  private async noticeBanked(session: CardSession, paymentId: string): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({ where: { id: session.subscriptionId }, select: { vendorId: true } });
    await this.notifications.send({
      userId: session.userId,
      type: 'SYSTEM_ANNOUNCEMENT',
      title: 'Card payment received — added to your balance',
      body: `Your card payment of $${Number(session.amount).toLocaleString()} ${session.currencyCode} was received and added to your balance. It did not change your plan; your balance pays a coming weekly fee.`,
      audience: sub?.vendorId ? 'business' : 'earner',
      data: { kind: 'billing_banked', subscriptionId: session.subscriptionId },
      dedupeKey: `card-paynow-banked:${paymentId}`,
    }).catch(() => {});
  }

  private async resultOf(session: CardSession): Promise<CardConfirmResult> {
    const instrument = session.instrumentId
      ? await this.prisma.paymentInstrument.findUnique({ where: { id: session.instrumentId }, select: INSTRUMENT_DTO_SELECT })
      : null;
    return {
      sessionId: session.id,
      purpose: session.purpose,
      status: session.status,
      ...(instrument ? { instrument } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // [Review S2-2] Finance resolves a HELD Pay now (two people: the admin route
  // is C4 dual control). Money the provider may have taken is never left
  // silent: a person checks the provider's portal, then books it, refunds it,
  // records a refund made in the portal, or records that nothing was taken.
  //
  // ONE decision, ONE money movement. Every decision is taken under the
  // session lock (billing authority -> the session row), reads what has
  // already happened, and claims durably BEFORE any money call:
  //   - BOOK only while no void or refund can have moved the money (each is
  //     either never sent or refused by the provider); it writes bookClaimedAt
  //     (once) and its payment row before booking;
  //   - REFUND, REFUNDED_IN_PORTAL and NOTHING_TAKEN never once the week is
  //     booked, nor while a BOOK may still be booking;
  //   - a REFUND is sent at most once (providerRefundState NULL -> SENDING),
  //     and BOOK / NOTHING_TAKEN wait while it may still be in flight.
  // Booking itself is billing's one idempotent path (one payment row per
  // session: its clientKey is the session, and the session is the provider's
  // one transaction).
  // -------------------------------------------------------------------------

  async resolveHeld(input: {
    sessionId: string;
    /** The admin's bound tenant: a session of another tenant does not exist here. */
    tenantId: string;
    action: CardResolveAction;
    /** The provider transaction finance checked (must match one already recorded). */
    providerReference: string;
    /** What finance saw taken, in the session's currency (BOOK: exactly the session's price). */
    amount: number;
    adminUserId: string;
    /** [ADM-002] The admin audit row, written INSIDE the decision's transaction
     *  (the claim or the closure commits with its record, or not at all). */
    onAudit?: OnAudit;
    now?: Date;
  }): Promise<{ status: CardSessionStatus; resolution: string | null; refund?: CardRefundOutcome['status'] }> {
    const now = input.now ?? new Date();
    const session = await this.prisma.cardSession.findUnique({ where: { id: input.sessionId } });
    if (!session || session.tenantId !== input.tenantId || session.purpose !== 'PAY_NOW') throw new NotFoundError('Card session', input.sessionId);
    const ref = input.providerReference.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(ref)) throw new AppError(400, 'PROVIDER_REFERENCE_INVALID', 'Enter the card provider\'s transaction reference you checked.');
    if (!Number.isFinite(input.amount) || input.amount <= 0) throw new AppError(400, 'AMOUNT_INVALID', 'State the amount the provider shows was taken.');
    if (input.action === 'BOOK') {
      // A TEST system never books a week, whoever asks.
      if (session.environment !== 'live' && !cardTestSubscriptions().has(session.subscriptionId)) {
        throw new AppError(409, 'TEST_SYSTEM_NEVER_BOOKS', 'A payment on a test card system is never booked to a partner.');
      }
      if (Math.round(input.amount * 100) !== Math.round(Number(session.amount) * 100)) {
        throw new AppError(409, 'AMOUNT_NOT_THE_PRICE', 'Only a payment of exactly this week\'s price can be booked. Refund any other amount.');
      }
    }
    const provider = input.action === 'REFUND' ? this.rail() : null;
    if (provider && !sameBinding(bindingOf(session), provider.binding)) {
      throw new AppError(409, 'CARD_PROVIDER_SETUP_CHANGED', 'This payment belongs to another card provider setup. Refund it in the provider\'s portal, then record that refund here.');
    }

    const audited = (tx: Prisma.TransactionClient) => input.onAudit?.(tx, { resolveAction: input.action, providerTransactionRef: ref, amount: input.amount });
    // The decision, under the lock: what has happened, and the durable claim.
    const decided = await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || fresh.status !== 'HELD' || fresh.resolution) throw notHeld();
      if (fresh.providerTransactionRef && fresh.providerTransactionRef.toLowerCase() !== ref.toLowerCase()) {
        throw new AppError(409, 'PROVIDER_REFERENCE_MISMATCH', 'That is not the transaction recorded for this card payment.');
      }
      const recordRef = fresh.providerTransactionRef ? {} : { providerTransactionRef: ref };
      const booked = await bookedInTx(tx, fresh);
      const booking = fresh.bookClaimedAt !== null && !booked && now.getTime() - fresh.bookClaimedAt.getTime() < FINANCE_CLAIM_WAIT_MS;
      const refunding = fresh.providerRefundState === 'SENDING' && now.getTime() - (fresh.providerRefundAt?.getTime() ?? 0) < FINANCE_CLAIM_WAIT_MS;
      if (refunding) throw new AppError(409, 'REFUND_IN_FLIGHT', 'A refund for this payment is being sent. Wait two minutes, then check it.');

      if (input.action === 'BOOK') {
        if (fresh.providerVoidState !== null && fresh.providerVoidState !== 'FAILED') {
          throw new AppError(409, 'VOID_MAY_HAVE_TAKEN_EFFECT', 'A void was sent for this payment and may have gone through: it is never booked. Check the provider\'s portal, then refund it or record that nothing was taken.');
        }
        if (fresh.providerRefundState !== null && fresh.providerRefundState !== 'FAILED') {
          throw new AppError(409, 'REFUND_SENT', 'A refund was sent for this payment: it is never booked.');
        }
        const proof = fresh.provider === POWERTRANZ_PROVIDER && fresh.providerTransactionRef
          ? readCompletion(fresh.completionEvidence, { txnId: fresh.providerTransactionRef, orderId: `SWIFT-${fresh.id}`,
            amountMinor: toProviderMinor(Number(fresh.amount), fresh.currencyCode!, 'card.finance.book'), currencyCode: fresh.currencyCode! }) : null;
        if (fresh.failureCode === 'LATE_PROVIDER_APPROVAL' || proof?.status !== 'succeeded') {
          throw new AppError(409, 'PROVIDER_COMPLETION_EVIDENCE_REQUIRED', 'Booking needs the provider’s approved completion with its own 3-D Secure proof. Refund or reconcile this payment instead.');
        }
        const paymentId = fresh.paymentId ?? (await tx.subscriptionPayment.create({
          data: {
            subscriptionId: fresh.subscriptionId, amount: fresh.amount!, status: 'UNKNOWN', paymentMethod: 'CARD',
            clientKey: `${CARD_PAY_NOW_KEY_PREFIX}${fresh.id}`, purpose: 'CARD_PAY_NOW',
            failureRaw: { providerEffect: 'AUTHORIZED', providerRail: 'CARD', cardSessionId: fresh.id, resolvedBy: input.adminUserId },
            periodStart: fresh.periodStart!, periodEnd: new Date(fresh.periodStart!.getTime() + WEEK_MS),
          },
          select: { id: true },
        })).id;
        await tx.cardSession.update({
          where: { id: fresh.id },
          data: { ...recordRef, ...(fresh.bookClaimedAt ? {} : { bookClaimedAt: now }), ...(fresh.paymentId ? {} : { paymentId }) },
        });
        await audited(tx);
        return { next: 'book' as const, paymentId };
      }

      if (booked) throw new AppError(409, 'ALREADY_BOOKED', 'This payment was booked to the partner\'s week. It cannot also be refunded or closed here.');
      if (booking) throw new AppError(409, 'BOOKING_IN_PROGRESS', 'This payment is being booked. Wait two minutes, then check it.');

      if (input.action === 'REFUND') {
        if (fresh.providerRefundState !== null) {
          throw new AppError(409, 'REFUND_ALREADY_SENT', 'A refund for this payment was already sent; its answer is recorded on the session. If the provider\'s portal shows it refunded, record that refund.');
        }
        await tx.cardSession.update({ where: { id: fresh.id }, data: { ...recordRef, providerRefundState: 'SENDING', providerRefundAt: now } });
        await audited(tx);
        return { next: 'refund' as const };
      }

      // REFUNDED_IN_PORTAL / NOTHING_TAKEN: a person's record of what the portal shows.
      if (input.action === 'NOTHING_TAKEN' && fresh.providerRefundState === 'PENDING') {
        throw new AppError(409, 'REFUND_PENDING', 'A refund of this payment is pending: money was taken. Record the refund once the provider\'s portal shows it.');
      }
      if (Object.keys(recordRef).length) await tx.cardSession.update({ where: { id: fresh.id }, data: recordRef });
      await this.closeResolvedInTx(tx, fresh, input.action === 'NOTHING_TAKEN' ? 'NOTHING_TAKEN' : 'REFUNDED_IN_PORTAL', input.adminUserId, now);
      await audited(tx);
      return { next: 'closed' as const };
    });

    if (decided.next === 'closed') return this.resolvedView(session.id);

    if (decided.next === 'book') {
      const settled = await this.billing.settleHostedCardPayment({
        subscriptionId: session.subscriptionId, paymentId: decided.paymentId, providerRef: ref, now,
        inSettlement: this.succeedInSettlement(session.id, now, { bookedBy: input.adminUserId }),
      });
      if (settled.outcome !== 'advanced' && settled.outcome !== 'banked') {
        throw new AppError(409, 'CARD_PAYMENT_NOT_BOOKABLE', `It could not be booked (${settled.outcome === 'held' ? settled.failureCode : 'not settled'}). Refund it instead (after two minutes).`);
      }
      // Booked by an earlier attempt of this decision (its booking committed,
      // its answer lost): the session is marked now, once.
      await this.prisma.$transaction(async (tx) => {
        const fresh = await this.lockSession(tx, session.id);
        if (!fresh || fresh.status !== 'HELD' || fresh.resolution || !(await bookedInTx(tx, fresh))) return;
        await tx.cardSession.update({
          where: { id: fresh.id },
          data: { status: 'SUCCEEDED', failureCode: null, ...(fresh.confirmedAt ? {} : { confirmedAt: now }), resolution: 'BOOKED', resolvedBy: input.adminUserId, resolvedAt: now },
        });
      });
      if (settled.outcome === 'banked') await this.noticeBanked(session, decided.paymentId);
      return this.resolvedView(session.id);
    }

    // REFUND: the one call this claim allows; its answer is recorded, never resent blindly.
    const currencyCode = session.currencyCode!;
    const refunded = await provider!.refund({
      binding: provider!.binding, providerRef: ref,
      amountMinor: toProviderMinor(input.amount, currencyCode, 'card.v2.refund'), currencyCode,
      idempotencyKey: `refund:${session.id}`,
    }).catch((): CardRefundOutcome => ({ status: 'unknown', reason: 'REFUND_CALL_FAILED', rawSha256: rawDigest({ refund: 'threw' }) }));
    const state = refunded.status === 'succeeded' ? 'REFUNDED' : refunded.status === 'pending' ? 'PENDING' : refunded.status === 'failed' ? 'FAILED' : 'UNKNOWN';
    await this.prisma.cardSession.updateMany({ where: { id: session.id, providerRefundState: 'SENDING' }, data: { providerRefundState: state } });
    await recordCardObservation(this.prisma, this.observation(session, 'CONFIRM', refunded.rawSha256, observedStatus(refunded.status), 'ACCEPTED'));
    if (state === 'REFUNDED') {
      await this.prisma.$transaction(async (tx) => {
        const fresh = await this.lockSession(tx, session.id);
        if (fresh && fresh.status === 'HELD' && !fresh.resolution) await this.closeResolvedInTx(tx, fresh, 'REFUNDED', input.adminUserId, now);
      });
    }
    return { ...(await this.resolvedView(session.id)), refund: refunded.status };
  }

  /** Closed by finance, under the caller's lock: FAILED (the partner was not
   *  credited), its confirmation resolved as unpaid, its unbooked payment row
   *  closed, the decision written once. */
  private async closeResolvedInTx(
    tx: Prisma.TransactionClient,
    fresh: CardSession,
    how: 'REFUNDED' | 'REFUNDED_IN_PORTAL' | 'NOTHING_TAKEN',
    adminUserId: string,
    now: Date,
  ): Promise<void> {
    const resolution = how === 'NOTHING_TAKEN' ? 'NOTHING_TAKEN' : 'REFUNDED';
    const failureCode = how === 'REFUNDED' ? 'REFUNDED_BY_FINANCE' : how;
    await tx.cardSession.update({
      where: { id: fresh.id },
      data: { status: 'FAILED', failureCode, ...(fresh.confirmedAt ? {} : { confirmedAt: now }), resolution, resolvedBy: adminUserId, resolvedAt: now },
    });
    if (fresh.paymentId) {
      const payment = await tx.subscriptionPayment.findUnique({ where: { id: fresh.paymentId }, select: { status: true, failureRaw: true } });
      if (payment && payment.status !== 'CAPTURED') {
        const raw = payment.failureRaw && typeof payment.failureRaw === 'object' && !Array.isArray(payment.failureRaw) ? payment.failureRaw : {};
        await tx.subscriptionPayment.update({
          where: { id: fresh.paymentId },
          data: { status: 'FAILED', failureCode, failureRaw: { ...raw, providerOutcome: how, cardSessionResolution: resolution, resolvedBy: adminUserId, observedAt: now.toISOString() } as Prisma.InputJsonValue },
        });
      }
    }
    await resolveConfirmationInTx(tx, fresh.subscriptionId, { cardSessionId: fresh.id }, 'PROVEN_UNPAID', { actor: `finance:${adminUserId}`, reference: `${how}:${fresh.providerTransactionRef ?? fresh.id}` }, now);
  }

  private async resolvedView(sessionId: string): Promise<{ status: CardSessionStatus; resolution: string | null }> {
    const s = await this.prisma.cardSession.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true, resolution: true } });
    return { status: s.status, resolution: s.resolution };
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * Run with every billing poll. An OPEN session past its window is closed
   * (an unused enrolment) or asked about (a Pay now, or an enrolment whose
   * return was accepted in time); an UNKNOWN session is asked again at most
   * every ten minutes, least recently asked first. One session's failure
   * never stops the sweep. Not stopped by the kill switch [C7]; the worker
   * runs it only while v2 is on or draining (card-rail-worker.ts) [AX297 F5].
   */
  async sweepSessions(now = new Date()): Promise<{ checked: number; succeeded: number; failed: number; expired: number; unknown: number; held: number; errors: number }> {
    const out = { checked: 0, succeeded: 0, failed: 0, expired: 0, unknown: 0, held: 0, errors: 0 };
    const due = await this.prisma.cardSession.findMany({
      where: {
        OR: [
          { status: 'OPEN', expiresAt: { lte: now } },
          { status: 'UNKNOWN', OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(now.getTime() - UNKNOWN_RECHECK_MS) } }] },
        ],
      },
      orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { expiresAt: 'asc' }, { id: 'asc' }],
      take: 100,
      select: { id: true },
    });
    for (const { id } of due) {
      out.checked += 1;
      try {
        const result = await this.confirm(id, { now });
        switch (result.status) {
          case 'SUCCEEDED': out.succeeded += 1; break;
          case 'FAILED': case 'CANCELLED': out.failed += 1; break;
          case 'EXPIRED': out.expired += 1; break;
          case 'HELD': out.held += 1; break;
          case 'OPEN': case 'UNKNOWN': out.unknown += 1; break;
          default: assertNever(result.status, 'card session status');
        }
      } catch (err) {
        out.errors += 1;
        log().error({ err, sessionId: id }, '[PT-1] card session sweep failed for one session — continuing');
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // The partner's cards
  // -------------------------------------------------------------------------

  /** [C9] Brand, last 4 and expiry — the token columns are never even selected. */
  async listInstruments(userId: string, subscriptionId: string): Promise<PaymentInstrumentDto[]> {
    await this.ownedSubscription(userId, subscriptionId);
    return this.prisma.paymentInstrument.findMany({
      where: { subscriptionId },
      orderBy: { createdAt: 'desc' },
      select: INSTRUMENT_DTO_SELECT,
    });
  }

  /**
   * Remove a card: REVOKED, at once, and nothing ever charges it again. There
   * is no silent fallback to another rail — the weekly fee stays due, and the
   * partner adds a card or chooses another way to pay. Not stopped by the
   * flag or the kill switch: taking a card out of service only ever lowers risk.
   *
   * [AX318 R1] A weekly charge on this card that was authorized but not yet
   * handed to the provider is closed here as NOT_SENT: it is never sent. One
   * already handed off is in flight: it finishes and is reconciled like any
   * other, and the answer says so (`paymentInProgress`), never silently.
   * `subscriptionId` scopes the card to the caller's selected subscription.
   */
  async removeInstrument(input: { userId: string; instrumentId: string; subscriptionId?: string; now?: Date }): Promise<{ card: PaymentInstrumentDto; paymentInProgress: boolean }> {
    const now = input.now ?? new Date();
    const found = await this.prisma.paymentInstrument.findUnique({ where: { id: input.instrumentId }, select: { id: true, subscriptionId: true } });
    if (!found || (input.subscriptionId !== undefined && found.subscriptionId !== input.subscriptionId)) {
      throw new NotFoundError('Card', input.instrumentId);
    }
    await this.ownedSubscription(input.userId, found.subscriptionId).catch(() => {
      throw new NotFoundError('Card', input.instrumentId);
    });
    const inFlight = await this.prisma.$transaction(async (tx) => {
      await this.opts.observer?.beforeCardLocks?.(found.subscriptionId, tx);
      // [AX297 F1] payer -> subscription -> card, the order billing's dispatch
      // authorization and handoff take: a charge being authorized or handed
      // off on this card finishes that step first, or sees the card REVOKED.
      await lockCardAuthority(tx, found.subscriptionId);
      await tx.$queryRaw`SELECT "id" FROM "payment_instruments" WHERE "id" = ${found.id} FOR UPDATE`;
      await this.opts.observer?.afterCardLocked?.(found.subscriptionId, tx);
      const revoked = await tx.paymentInstrument.updateMany({
        where: { id: found.id, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now, revokedBy: input.userId },
      });
      // [AX318 R1] Authorized, never handed off: closed, never sent. Handed off: in flight.
      const unsent = await closeUnsentCardIntents(tx, { instrumentId: found.id }, 'CARD_REMOVED', now);
      const moving = await cardChargesInFlight(tx, found.id);
      if (revoked.count !== 1) return moving; // already out of service: nothing to record twice
      const card = await tx.paymentInstrument.findUniqueOrThrow({ where: { id: found.id }, select: { brand: true, last4: true } });
      const sub = await tx.subscription.findUniqueOrThrow({ where: { id: found.subscriptionId }, select: { currencyCode: true } });
      await tx.billingEvent.create({
        data: {
          subscriptionId: found.subscriptionId,
          type: 'TIER_CHANGE',
          currencyCode: sub.currencyCode,
          idempotencyKey: `card:revoked:${found.id}`,
          note: `Card ${card.brand} ending ${card.last4} removed by the partner; no card is charged until one is added or another way to pay is chosen`,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: input.userId, action: 'CARD_REMOVED', entity: 'PaymentInstrument', entityId: found.id,
          changes: { subscriptionId: found.subscriptionId, status: 'REVOKED', unsentChargesClosed: unsent, chargesInFlight: moving },
        },
      });
      return moving;
    });
    const card = await this.prisma.paymentInstrument.findUniqueOrThrow({ where: { id: found.id }, select: INSTRUMENT_DTO_SELECT });
    return { card, paymentInProgress: inFlight > 0 };
  }
}
