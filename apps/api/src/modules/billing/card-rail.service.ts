import { lockFeePaymentDecision } from './fee-payment-authority';
import { beginConfirmationInTx, lockBillingAuthority, resolveConfirmationInTx } from './dunning-clock';
import { lockFeeCollectionAuthority, lockSubscriptionPayer } from '../subscription/mover-fee-authority';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CardObservationSource, CardObservationVerdict, CardObservedStatus, CardSession, CardSessionStatus, Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { cardRailKilled, cardRailV2Enabled } from '../../utils/card-rail';
import { toProviderMinor } from '../../utils/currency-amount';
import { log } from '../../utils/logger';
import { getTenantContext } from '../../plugins/tenant-context';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';
import { CARD_PAY_NOW_KEY_PREFIX, cardChargesInFlight, cardExpiredAt, closeUnsentCardIntents, type BillingService } from './billing.service';
import { sealVaultToken } from './card-vault';
import { observedStatus, recordCardObservation } from './card-observations';
import {
  assertNever, bindingOf, describeBinding, rawDigest, sameBinding,
  type CardRailProvider, type CardRailSource, type CardReturnObservation, type CardSessionOutcome, type CardSessionPurpose,
  type CreateCardSessionOutcome,
} from '../../providers/card/card-provider';
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
/** How long a hosted page stays usable (the provider is told the same). */
export const CARD_SESSION_TTL_MS = 15 * 60 * 1000;
/** An UNKNOWN session is asked about again at most this often. */
const UNKNOWN_RECHECK_MS = 10 * 60 * 1000;
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
  /** [C10] True on the simulator: a test page, no real card, no real money. */
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

function stateMatches(state: string, stateHash: string): boolean {
  const got = Buffer.from(sha256Hex(state), 'hex');
  const want = Buffer.from(stateHash, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}

function sessionDto(s: CardSession): CardSessionDto {
  const testMode = s.provider === SIMULATOR_PROVIDER;
  return {
    sessionId: s.id,
    purpose: s.purpose,
    status: s.status,
    hostedUrl: s.hostedUrl,
    expiresAt: s.expiresAt.toISOString(),
    ...(s.purpose === 'PAY_NOW' ? { amount: Number(s.amount), currencyCode: s.currencyCode ?? undefined } : {}),
    testMode,
    ...(testMode ? { testModeLabel: SIMULATOR_PAGE.testModeLabel } : {}),
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
      // An ambiguous create response is not proof that the provider created nothing.
      await this.prisma.cardSession.updateMany({
        where: { id: session.id, status: 'OPEN' },
        data: { status: input.purpose === 'PAY_NOW' ? 'UNKNOWN' : 'CANCELLED', failureCode: 'PROVIDER_PAGE_UNAVAILABLE', confirmedAt: now },
      });
      throw new AppError(502, 'CARD_SESSION_UNAVAILABLE', 'The card page could not be opened. Please try again in a moment.');
    }
    const opened = await this.prisma.cardSession.update({
      where: { id: session.id },
      data: { providerSessionRef: created.providerSessionRef, hostedUrl: created.hostedUrl },
    });
    return this.handoffSession(opened, input.userId);
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
    const outcome = await provider.confirm({ binding: provider.binding, providerSessionRef: session.providerSessionRef, purpose: session.purpose });
    switch (outcome.status) {
      case 'succeeded':
        if (outcome.purpose !== session.purpose) return this.hold(session, outcome, 'PURPOSE_MISMATCH', now);
        return outcome.purpose === 'ENROLL' ? this.enrollCard(session, outcome, now) : this.settlePayNow(session, outcome, now);
      case 'failed':
        return this.close(session, 'FAILED', 'DECLINED', outcome, now);
      case 'requires_action':
      case 'pending':
        // Local expiry cannot prove a payable instruction will never settle.
        if (expired && session.purpose === 'PAY_NOW') return this.markUnknown(session, outcome, now);
        if (expired) return this.close(session, 'EXPIRED', outcome.status === 'pending' ? 'EXPIRED_UNUSED' : 'EXPIRED_UNAUTHENTICATED', outcome, now);
        return this.observeOnly(session, outcome);
      case 'unknown':
        if (!expired) return this.observeOnly(session, outcome);
        // A Pay now may have moved money: it stays UNKNOWN and keeps being
        // asked. An enrolment moved none: it closes, and the card is added again.
        return session.purpose === 'PAY_NOW' ? this.markUnknown(session, outcome, now) : this.close(session, 'EXPIRED', 'PROVIDER_UNKNOWN', outcome, now);
      default:
        return assertNever(outcome, 'card session outcome');
    }
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
    // The provider's figure must be the server's price, to the minor unit.
    const expectedMinor = toProviderMinor(Number(session.amount), session.currencyCode!, 'card.v2.paynow');
    if (outcome.amountMinor !== expectedMinor || outcome.currencyCode !== session.currencyCode) {
      return this.hold(session, outcome, 'AMOUNT_MISMATCH', now);
    }
    // The local money record this capture books through: ONE per session
    // (its clientKey is the session), linked in the same transaction as the evidence.
    const paymentId = await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || !LIVE.includes(fresh.status)) return null;
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
    if (!paymentId) return this.resultOf(await this.prisma.cardSession.findUniqueOrThrow({ where: { id: session.id } }));

    const settled = await this.billing.settleHostedCardPayment({
      subscriptionId: session.subscriptionId, paymentId, providerRef: outcome.providerRef, now,
    });
    if (settled.outcome === 'advanced' || settled.outcome === 'banked') {
      await this.prisma.cardSession.updateMany({ where: { id: session.id, status: { in: LIVE } }, data: { status: 'SUCCEEDED', confirmedAt: now, failureCode: null } });
      if (settled.outcome === 'banked') await this.noticeBanked(session, paymentId);
      return { sessionId: session.id, purpose: 'PAY_NOW', status: 'SUCCEEDED', settlement: settled.outcome };
    }
    // Captured, but it could not be booked (the wallet holds another currency,
    // the currency it was issued in cannot be vouched for, or the payment row
    // can no longer be claimed): a person decides.
    return this.hold(session, null, settled.outcome === 'held' ? settled.failureCode : 'NOT_SETTLED', now);
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
    if (outcome.status !== 'pending') {
      await recordCardObservation(this.prisma, this.observation(session, 'CONFIRM', outcome.rawSha256, observedStatus(outcome.status), 'ACCEPTED'));
    }
    return this.resultOf(session);
  }

  private async markUnknown(session: CardSession, outcome: CardSessionOutcome, now: Date): Promise<CardConfirmResult> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || !LIVE.includes(fresh.status)) return;
      if (fresh.purpose === 'PAY_NOW') await beginConfirmationInTx(tx, fresh.subscriptionId, { cardSessionId: fresh.id }, 'CARD_CONFIRMATION_PENDING', now);
      await recordCardObservation(tx, this.observation(session, 'CONFIRM', outcome.rawSha256, observedStatus(outcome.status), 'ACCEPTED'));
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
      if (!fresh || !LIVE.includes(fresh.status)) return;
      if (fresh.purpose === 'PAY_NOW') await beginConfirmationInTx(tx, fresh.subscriptionId, { cardSessionId: fresh.id }, 'CARD_CONFIRMATION_PENDING', now);
      if (outcome) {
        await recordCardObservation(tx, this.observation(session, 'CONFIRM', outcome.rawSha256, observedStatus(outcome.status), 'ACCEPTED'));
      }
      await tx.cardSession.updateMany({ where: { id: session.id, status: { in: LIVE } }, data: { status, failureCode, confirmedAt: now } });
      if (fresh.purpose === 'PAY_NOW' && outcome?.status === 'failed') {
        await resolveConfirmationInTx(tx, fresh.subscriptionId, { cardSessionId: fresh.id }, 'PROVEN_UNPAID', { actor: 'card-provider', reference: outcome.rawSha256 }, now);
      }
    });
    return this.resultOf(await this.prisma.cardSession.findUniqueOrThrow({ where: { id: session.id } }));
  }

  /** The provider's answer disagrees with the session (or could not be
   *  booked): nothing is granted, and a person is paged once. */
  private async hold(session: CardSession, outcome: CardSessionOutcome | null, failureCode: string, now: Date): Promise<CardConfirmResult> {
    await this.prisma.$transaction(async (tx) => {
      const fresh = await this.lockSession(tx, session.id);
      if (!fresh || !LIVE.includes(fresh.status)) return;
      if (fresh.purpose === 'PAY_NOW') await beginConfirmationInTx(tx, fresh.subscriptionId, { cardSessionId: fresh.id }, 'CARD_CONFIRMATION_PENDING', now);
      if (outcome) {
        await recordCardObservation(tx, this.observation(session, 'CONFIRM', outcome.rawSha256, observedStatus(outcome.status), 'REJECTED_MISMATCH'));
      }
      await tx.cardSession.updateMany({ where: { id: session.id, status: { in: LIVE } }, data: { status: 'HELD', failureCode, confirmedAt: now } });
    });
    log().error({ sessionId: session.id, subscriptionId: session.subscriptionId, failureCode }, '[PT-1] card session held for a person — nothing granted');
    await notifyAdmins(this.prisma, this.notifications, {
      tenantId: session.tenantId,
      title: '💳 Card session held for review',
      body: `Card session ${session.id} (${session.purpose}) for subscription ${session.subscriptionId} was held: ${failureCode}. Nothing was granted or booked. Check the provider before acting.`,
      data: { kind: 'billing_invariants', alert: 'card-session-held', subscriptionId: session.subscriptionId, sessionId: session.id, failureCode },
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
