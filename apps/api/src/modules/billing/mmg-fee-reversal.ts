import type { MmgCheckoutIntent, MmgFeeReversal, Prisma, PrismaClient } from '@prisma/client';
import { AppError, NotFoundError } from '../../utils/errors';
import { log } from '../../utils/logger';
import { formatMoney } from '../../utils/currency-amount';
import { getMmgReversalClient, type MmgReversalClient, type MmgTxResult } from '../../providers/mmg/mmg-provider';
import { mmgFeeReversalsCounter } from '../../plugins/observability';
import type { OnAudit } from '../../lib/audit-writer';
import { notifyAdmins, type NotificationService } from '../notification/notification.service';
import { hasConfirmationInTx, lockBillingAuthority } from './dunning-clock';
import { verifiedCheckoutCredit } from './confirmation-finance';
import type { BillingService } from './billing.service';
import { amountMinorOf, decideAfterLookup, lookupProof, REVERSAL_SENDING_STALE_MS, type ReversalProof } from './mmg-reversal-proof';
export { lookupProof, REVERSAL_PROOF_WINDOW_MS, REVERSAL_SENDING_STALE_MS } from './mmg-reversal-proof';

// ---------------------------------------------------------------------------
// [MMG REVERSAL · owner decision #11, 13 Oct 2026] RETURN A WHOLE WEEKLY-FEE
// PAYMENT TO THE PARTNER'S MMG ACCOUNT.
//
// For a duplicate, an over-the-cap or a mistaken weekly-fee payment. MMG
// reverses a transaction in FULL only, so this returns the whole payment or
// nothing. It is ONLY for Swift's own weekly fees (a checkout Swift credited
// from MMG's own lookup); order money is never Swift's and never passes here.
//
// The law, in order:
//   1. Only a payment Swift credited on MMG's proof: a CONFIRMED checkout with
//      its verified credit, its provider identities CREDITED by that checkout,
//      and no identity conflict on either MMG number. Never a held checkout,
//      never a PROVIDER_ID_CONFLICT.
//   2. Only while the wallet still holds the whole amount: money already spent
//      on a running week is not returned here (the refund procedure covers it).
//   3. A durable claim (SENDING) is written BEFORE MMG is asked, with its audit
//      row; one live reversal per payment (a database index). While it is
//      open, the payer's billing sends nothing and spends nothing.
//   4. MMG is asked ONCE. Its answer is recorded, but only MMG's LOOKUP decides:
//      the original transaction reported reversed, or the reversal MMG named
//      reported completed, for exactly the amount.
//   5. On that proof, in one transaction, exactly once: the wallet is debited,
//      a PREPAID_REVERSAL event (unique key) and the reversing ledger posting
//      are written, and the row is REVERSED. The partner is told.
//   6. MMG refusing (an answer), with its lookup showing the payment still
//      standing: FAILED, nothing changed. Anything else (no answer, an answer
//      that says "already reversed", a wallet that no longer holds the money,
//      a lookup that cannot be read) is HELD for a person, paged, and visible
//      — never a silent drop and never a guess.
// ---------------------------------------------------------------------------

/** Off until the owner's UAT run proves MMG's answers: MMG_FEE_REVERSAL=on. */
export const MMG_FEE_REVERSAL_SWITCH = 'MMG_FEE_REVERSAL';
export function feeReversalEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[MMG_FEE_REVERSAL_SWITCH] === 'on';
}

export type ReversalState = 'SENDING' | 'SENT' | 'REVERSED' | 'FAILED' | 'HELD';
export { OPEN_REVERSAL_STATES } from './dunning-clock';
/** The sweep re-reads an open reversal at most this often. */
const SWEEP_EVERY_MS = 10 * 60_000;
const SWEEP_BATCH = 20;

export type ReversalRefusal =
  | 'NOT_CONFIRMED' | 'NOT_PROVEN' | 'IDENTITY_CONFLICT' | 'AMOUNT_MISMATCH' | 'ALREADY_REVERSING'
  | 'ALREADY_REVERSED' | 'MONEY_ALREADY_USED' | 'PAYMENT_CONFIRMING';

const REFUSAL_COPY: Record<ReversalRefusal, string> = {
  NOT_CONFIRMED: 'Only a weekly-fee payment Swift confirmed with MMG can be returned this way.',
  NOT_PROVEN: "Swift's record of this payment is not bound to MMG's proof. It cannot be returned here; follow the refund procedure.",
  IDENTITY_CONFLICT: "This payment is under an MMG reference check — it can't be reversed; escalate with the MMG statement line.",
  AMOUNT_MISMATCH: 'MMG returns a payment in full only. Enter the whole amount of this payment to confirm.',
  ALREADY_REVERSING: 'A return of this payment is already in progress or waiting for a person.',
  ALREADY_REVERSED: 'This payment has already been returned to the partner.',
  MONEY_ALREADY_USED: 'This payment has already paid, in whole or in part, for a week of the partner\'s fee. It is not returned here; follow the refund procedure.',
  PAYMENT_CONFIRMING: 'Another payment for this fee is being confirmed or reviewed. Try again once it is settled.',
};

export function reversalRefusal(code: ReversalRefusal): AppError {
  return new AppError(409, code, REFUSAL_COPY[code]);
}

type Tx = Prisma.TransactionClient;

export interface ReversalDeps {
  prisma: PrismaClient;
  billing: Pick<BillingService, 'debitWalletForReversalInTx'>;
  notifications: NotificationService;
  /** Injectable for tests; the configured MMG driver otherwise. */
  client?: () => MmgReversalClient;
}


/**
 * Can this payment be returned, right now? Read under the payer's billing lock
 * and the checkout's row lock. `expectAmount` is the whole amount the admin
 * typed: MMG reverses in full only, so the request says so.
 */
export async function reversalEligibilityInTx(
  tx: Tx, intent: MmgCheckoutIntent, expectAmount: number | null, now: Date,
): Promise<{ ok: true } | { ok: false; code: ReversalRefusal }> {
  if (intent.status !== 'CONFIRMED' || !intent.providerPaymentId || !intent.mmgTransactionId || !intent.confirmedAt) {
    return { ok: false, code: 'NOT_CONFIRMED' };
  }
  const live = await tx.mmgFeeReversal.findFirst({ where: { checkoutId: intent.id, state: { not: 'FAILED' } }, select: { state: true } });
  if (live) return { ok: false, code: live.state === 'REVERSED' ? 'ALREADY_REVERSED' : 'ALREADY_REVERSING' };
  // (1) Credited on MMG's proof, bound to THIS checkout.
  const proof = await verifiedCheckoutCredit(tx, intent);
  if (!proof || proof.identity.creditedPaymentId !== `mco:${intent.id}`) return { ok: false, code: 'NOT_PROVEN' };
  // Every identity this checkout claimed is still CREDITED by it, and no
  // duplicate or conflict sits on either MMG number (the transaction or its
  // ledger number) anywhere — a conflicted payment is a person's, never ours.
  const claimed = await tx.providerPayment.findMany({ where: { creditedPaymentId: `mco:${intent.id}` }, select: { id: true, status: true, providerTxnId: true } });
  if (!claimed.some((row) => row.id === intent.providerPaymentId) || claimed.some((row) => row.status !== 'CREDITED')) {
    return { ok: false, code: 'IDENTITY_CONFLICT' };
  }
  const numbers = [...new Set([intent.mmgTransactionId, ...claimed.map((row) => row.providerTxnId)])];
  const claimedIds = claimed.map((row) => row.id);
  // [GUARDRAILS §1 · PROVIDER_ID_CONFLICT is never reversed] Any record of a
  // conflict on either MMG number (canonical spelling), anywhere: an identity
  // that is not this checkout's credit (a held duplicate, a refund), an
  // agent-cash PROVIDER_ID_CONFLICT on the number or on these identities, or
  // ANOTHER checkout naming the same number. Refused before any claim or call.
  const [conflict] = await tx.$queryRaw<Array<{ identities: bigint; agents: bigint; checkouts: bigint }>>`
    SELECT
      (SELECT count(*) FROM provider_payments p
        WHERE p.provider = 'MMG' AND p.status <> 'CREDITED'
          AND EXISTS (SELECT 1 FROM unnest(${numbers}::text[]) r WHERE mmg_txn_canon(r) = mmg_txn_canon(p."providerTxnId")))::bigint AS identities,
      (SELECT count(*) FROM mmg_agent_payments ap
        WHERE ap."failureCode" = 'PROVIDER_ID_CONFLICT'
          AND (ap."providerPaymentId" = ANY(${claimedIds}::text[])
            OR EXISTS (SELECT 1 FROM unnest(${numbers}::text[]) r WHERE mmg_txn_canon(r) = mmg_txn_canon(ap."mmgTxnId"))))::bigint AS agents,
      (SELECT count(*) FROM mmg_checkout_intents ci
        WHERE ci.id <> ${intent.id}
          AND EXISTS (SELECT 1 FROM unnest(${numbers}::text[]) r
            WHERE mmg_txn_canon(r) = mmg_txn_canon(ci."mmgTransactionId")
               OR EXISTS (SELECT 1 FROM unnest(ci.candidates) c WHERE mmg_txn_canon(c) = mmg_txn_canon(r))))::bigint AS checkouts`;
  if (!conflict || Number(conflict.identities) > 0 || Number(conflict.agents) > 0 || Number(conflict.checkouts) > 0) {
    return { ok: false, code: 'IDENTITY_CONFLICT' };
  }
  // MMG reverses in full only: the request names the whole amount.
  if (expectAmount !== null && amountMinorOf(expectAmount) !== amountMinorOf(intent.amount)) return { ok: false, code: 'AMOUNT_MISMATCH' };
  // Nothing else for this fee may be in confirmation or review beside it.
  if (await hasConfirmationInTx(tx, intent.subscriptionId, now)) return { ok: false, code: 'PAYMENT_CONFIRMING' };
  // (2) The wallet still holds the whole payment.
  const wallet = await tx.prepaidBalance.findUnique({ where: { subscriptionId: intent.subscriptionId }, select: { balance: true, currencyCode: true } });
  if (!wallet || wallet.currencyCode !== intent.currencyCode || amountMinorOf(wallet.balance) < amountMinorOf(intent.amount)) {
    return { ok: false, code: 'MONEY_ALREADY_USED' };
  }
  return { ok: true };
}

/** What Swift keeps of MMG's words: letters, digits and plain punctuation, short. */
export function shapeProviderText(text: string | null | undefined): string | null {
  if (!text) return null;
  const shaped = text.replace(/[^A-Za-z0-9 _:.,()/-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return shaped || null;
}

export type ResolveRefusal = 'NOT_HELD' | 'MMG_SHOWS_RETURNED' | 'PAYMENT_NOT_STANDING' | 'NO_PROOF';
const RESOLVE_COPY: Record<ResolveRefusal, string> = {
  NOT_HELD: 'Only a return that is held for a person is resolved here.',
  MMG_SHOWS_RETURNED: "MMG's records show this payment returned. Use \"Check with MMG\" instead; nothing changed.",
  PAYMENT_NOT_STANDING: "MMG's records do not show this payment still standing, so it cannot be closed as not returned. Nothing changed.",
  NO_PROOF: "MMG's records do not show that return for this payment and amount. Nothing changed.",
};

export class MmgFeeReversalService {
  constructor(private readonly deps: ReversalDeps) {}

  private client(): MmgReversalClient {
    return (this.deps.client ?? (() => getMmgReversalClient()))();
  }

  /**
   * The admin action (C4, after its approval): claim, ask MMG once, then let
   * MMG's lookup decide. Returns the row as it stands.
   */
  async requestReversal(
    input: { tenantId: string; checkoutId: string; amountGyd: number; reason: string; actorId: string; approvalId: string | null },
    onAudit: OnAudit, now: Date = new Date(),
  ): Promise<MmgFeeReversal> {
    if (!feeReversalEnabled()) {
      throw new AppError(503, 'REVERSAL_OFF', 'Returning MMG fee payments is switched off on this server until MMG\'s answers are proven in UAT. Nothing changed.');
    }
    const claim = await this.deps.prisma.$transaction(async (tx) => {
      const found = await tx.mmgCheckoutIntent.findFirst({ where: { id: input.checkoutId, tenantId: input.tenantId }, select: { subscriptionId: true } });
      if (!found) throw new NotFoundError('MMG checkout', input.checkoutId);
      await lockBillingAuthority(tx, found.subscriptionId);
      await tx.$queryRaw`SELECT "id" FROM "mmg_checkout_intents" WHERE "id" = ${input.checkoutId} FOR UPDATE`;
      const intent = await tx.mmgCheckoutIntent.findUniqueOrThrow({ where: { id: input.checkoutId } });
      const eligible = await reversalEligibilityInTx(tx, intent, input.amountGyd, now);
      if (!eligible.ok) throw reversalRefusal(eligible.code);
      const row = await tx.mmgFeeReversal.create({ data: {
        tenantId: intent.tenantId, subscriptionId: intent.subscriptionId, checkoutId: intent.id,
        providerPaymentId: intent.providerPaymentId!, mmgTransactionId: intent.mmgTransactionId!,
        amount: intent.amount, currencyCode: intent.currencyCode, state: 'SENDING',
        reason: input.reason, requestedBy: input.actorId, approvalId: input.approvalId, sentAt: now,
      } });
      await onAudit(tx, { reversalId: row.id, checkoutId: intent.id, amountGyd: Number(intent.amount), mmgTransactionId: intent.mmgTransactionId! });
      return row;
    });
    mmgFeeReversalsCounter.labels('claimed').inc();

    // (4) Ask MMG ONCE. The adapter never throws; a throw here is still "no answer".
    let answer: MmgTxResult;
    try {
      answer = await this.client().reverseTransaction({ transactionId: claim.mmgTransactionId, reason: 'Weekly-fee payment returned to the partner' });
    } catch (err) {
      answer = { status: 'error', transactionId: '', reason: `MMG reversal call failed: ${(err as Error).message}` };
    }
    await this.recordAnswer(claim.id, answer, new Date());
    return this.settle(claim.id, { now: new Date(), afterAnswer: true });
  }

  /** MMG's answer, written down before anything is decided on it. */
  private async recordAnswer(id: string, answer: MmgTxResult, at: Date): Promise<void> {
    const reference = answer.transactionId && answer.transactionId.length <= 128 ? answer.transactionId : null;
    const accepted = answer.status === 'pending' || answer.status === 'reversed' || answer.status === 'approved';
    await this.deps.prisma.mmgFeeReversal.updateMany({
      where: { id, state: 'SENDING' },
      data: {
        providerStatus: answer.status,
        // [DS1112 S4] A status word or MMG's error code, never a raw provider body.
        providerReason: shapeProviderText(answer.reason),
        providerReference: accepted ? reference : null,
        answeredAt: answer.status === 'error' ? null : at,
        // An answer MMG gave moves it on; "no answer" leaves the claim for the lookup.
        ...(answer.status === 'error' ? {} : { state: 'SENT' }),
      },
    });
    mmgFeeReversalsCounter.labels(`answer_${answer.status}`).inc();
  }

  /**
   * Let MMG's lookup decide an open reversal: REVERSED on proof (the wallet
   * debited once), FAILED on MMG's refusal with the payment still standing,
   * otherwise SENT (MMG still working, inside its window) or HELD for a person.
   */
  async settle(id: string, opts: { now?: Date; afterAnswer?: boolean } = {}): Promise<MmgFeeReversal> {
    const now = opts.now ?? new Date();
    const row = await this.deps.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id } });
    if (row.state === 'REVERSED' || row.state === 'FAILED') return row;
    let proof: ReversalProof;
    try {
      proof = await lookupProof(this.client(), row);
    } catch (err) {
      log().error({ err, reversalId: id }, '[MMG reversal] MMG lookup failed; the reversal stays open');
      proof = { proven: false, standing: false, unreadable: true };
    }
    const decision = decideAfterLookup(proof, { state: row.state as 'SENDING' | 'SENT' | 'HELD', providerStatus: row.providerStatus, providerReason: row.providerReason, sentAt: row.sentAt }, { now, afterAnswer: !!opts.afterAnswer });
    switch (decision.action) {
      case 'apply':
        return this.applyProof(row.id, decision.how, now);
      case 'fail': {
        const moved = await this.deps.prisma.mmgFeeReversal.updateMany({
          where: { id, state: { in: ['SENDING', 'SENT', 'HELD'] } },
          data: { state: 'FAILED', failedAt: now, lastCheckedAt: now, lookupStatus: 'STANDING' },
        });
        if (moved.count === 1) {
          mmgFeeReversalsCounter.labels('failed').inc();
          log().warn({ reversalId: id, reason: row.providerReason }, '[MMG reversal] MMG refused; its lookup shows the payment still standing — nothing changed');
        }
        break;
      }
      case 'wait':
        await this.deps.prisma.mmgFeeReversal.updateMany({ where: { id, state: 'SENT' }, data: { lastCheckedAt: now, lookupStatus: decision.lookupStatus } });
        break;
      case 'hold':
        await this.hold(row, decision.heldReason, decision.lookupStatus, now);
        break;
      case 'leave':
        return row;
      default: {
        const unhandled: never = decision;
        return unhandled;
      }
    }
    return this.deps.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id } });
  }

  private async hold(row: MmgFeeReversal, heldReason: string, lookupStatus: string, now: Date): Promise<void> {
    const moved = await this.deps.prisma.mmgFeeReversal.updateMany({
      where: { id: row.id, state: { in: ['SENDING', 'SENT'] } },
      data: { state: 'HELD', heldReason, lastCheckedAt: now, lookupStatus },
    });
    if (moved.count === 1) {
      mmgFeeReversalsCounter.labels('held').inc();
      log().error({ reversalId: row.id, checkoutId: row.checkoutId, heldReason }, '[MMG reversal] held for a person: MMG has not proven the return');
      await notifyAdmins(this.deps.prisma, this.deps.notifications, {
        tenantId: row.tenantId,
        title: 'MMG fee return needs a person',
        body: `Returning payment ${row.checkoutId} (${formatMoney(Number(row.amount), row.currencyCode, { whole: true })}) is held: ${heldReason}. `
          + 'Nothing was deducted from what the partner has paid toward weekly fees. Check the MMG statement, then on the payment either "Check with MMG" '
          + 'or resolve it with the MMG statement line (two people).',
        data: { kind: 'billing_invariants', alert: 'mmg-fee-reversal-held', reversalId: row.id, checkoutId: row.checkoutId, reason: heldReason },
      }).catch((err) => log().error({ err, reversalId: row.id }, '[MMG reversal] the held page failed; the row is still HELD and listed'));
    } else {
      await this.deps.prisma.mmgFeeReversal.updateMany({ where: { id: row.id, state: 'HELD' }, data: { heldReason, lastCheckedAt: now, lookupStatus } });
    }
  }

  /** (5) On MMG's proof: debit the wallet exactly once, in one transaction with the row. */
  private async applyProof(id: string, how: 'ORIGINAL_REVERSED' | 'REVERSAL_COMPLETED', now: Date): Promise<MmgFeeReversal> {
    let result: { row: MmgFeeReversal; applied: boolean; short: boolean };
    try {
      result = await this.applyProofInTx(id, how, now);
    } catch (err) {
      // [DS1112 S3] MMG proved the return but Swift could not book it (a
      // currency mismatch, a ledger refusal, a conflict): never retried
      // silently — a person looks, and is paged.
      log().error({ err, reversalId: id }, '[MMG reversal] MMG proved the return; booking it failed — held for a person');
      const row = await this.deps.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id } });
      if (row.state === 'REVERSED') return row;
      const code = (err as { code?: unknown }).code;
      await this.hold(row, `APPLY_FAILED${typeof code === 'string' ? `:${code}`.slice(0, 60) : ''}`, how, now);
      return this.deps.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id } });
    }
    if (result.short) {
      // MMG returned the money and the wallet no longer holds it: a person decides.
      await this.hold(result.row, 'WALLET_NO_LONGER_HOLDS_IT', how, now);
      return this.deps.prisma.mmgFeeReversal.findUniqueOrThrow({ where: { id } });
    }
    if (result.applied) {
      mmgFeeReversalsCounter.labels('reversed').inc();
      log().warn({ reversalId: id, checkoutId: result.row.checkoutId, how }, '[MMG reversal] MMG proved the return; the fee balance was debited once');
      await this.tellPartner(result.row);
    }
    return result.row;
  }

  private async applyProofInTx(id: string, how: 'ORIGINAL_REVERSED' | 'REVERSAL_COMPLETED', now: Date): Promise<{ row: MmgFeeReversal; applied: boolean; short: boolean }> {
    return this.deps.prisma.$transaction(async (tx) => {
      const before = await tx.mmgFeeReversal.findUniqueOrThrow({ where: { id }, select: { subscriptionId: true } });
      await lockBillingAuthority(tx, before.subscriptionId);
      await tx.$queryRaw`SELECT "id" FROM "mmg_fee_reversals" WHERE "id" = ${id} FOR UPDATE`;
      const row = await tx.mmgFeeReversal.findUniqueOrThrow({ where: { id } });
      if (row.state === 'REVERSED' || row.state === 'FAILED') return { row, applied: false, short: false };
      const debit = await this.deps.billing.debitWalletForReversalInTx(tx, {
        subscriptionId: row.subscriptionId, amount: Number(row.amount), currencyCode: row.currencyCode,
        eventKey: `mmg-reversal:${row.id}`,
        note: `MMG returned payment ${row.mmgTransactionId} (checkout ${row.checkoutId}) to the partner`,
        mmgRef: row.mmgTransactionId,
      });
      if ('short' in debit) return { row, applied: false, short: true };
      const updated = await tx.mmgFeeReversal.update({ where: { id }, data: {
        state: 'REVERSED', reversedAt: now, walletDebitedAt: now, billingEventId: debit.eventId,
        lastCheckedAt: now, lookupStatus: how,
      } });
      return { row: updated, applied: true, short: false };
    });
  }

  /**
   * [DS1112 S2] A person resolves a HELD return (the C4 action: a stated
   * reason and a second person, or the owner's solo approval). Never a guess —
   * MMG's lookup is read again, now:
   *   NOT_RETURNED  only while MMG shows the payment still STANDING (exact
   *                 amount) and nothing proves a return -> FAILED, nothing
   *                 changed; billing resumes and the payment may be asked again.
   *   RETURNED      the MMG reversal reference the person read on the MMG
   *                 statement; Swift looks it up itself and books the return
   *                 ONLY on that proof, exactly as a check would.
   * The resolution, who made it and the MMG reference are written once.
   */
  async resolveHeld(
    input: { tenantId: string; reversalId: string; outcome: 'NOT_RETURNED' | 'RETURNED'; mmgReference: string; actorId: string },
    onAudit: OnAudit, now: Date = new Date(),
  ): Promise<MmgFeeReversal> {
    const row = await this.deps.prisma.mmgFeeReversal.findFirst({ where: { id: input.reversalId, tenantId: input.tenantId } });
    if (!row) throw new NotFoundError('MMG fee reversal', input.reversalId);
    if (row.state !== 'HELD') throw new AppError(409, 'NOT_HELD', RESOLVE_COPY.NOT_HELD);
    const reference = input.mmgReference.trim();
    if (input.outcome === 'NOT_RETURNED') {
      const proof = await lookupProof(this.client(), row);
      if (proof.proven) throw new AppError(409, 'MMG_SHOWS_RETURNED', RESOLVE_COPY.MMG_SHOWS_RETURNED);
      if (!proof.standing) throw new AppError(409, 'PAYMENT_NOT_STANDING', RESOLVE_COPY.PAYMENT_NOT_STANDING);
      return this.deps.prisma.$transaction(async (tx) => {
        await lockBillingAuthority(tx, row.subscriptionId);
        const moved = await tx.mmgFeeReversal.updateMany({
          where: { id: row.id, state: 'HELD', resolution: null },
          data: { state: 'FAILED', failedAt: now, lastCheckedAt: now, lookupStatus: 'STANDING', resolution: 'NOT_RETURNED', resolvedBy: input.actorId, resolutionNote: reference },
        });
        if (moved.count !== 1) throw new AppError(409, 'NOT_HELD', RESOLVE_COPY.NOT_HELD);
        await onAudit(tx, { reversalId: row.id, checkoutId: row.checkoutId, resolution: 'NOT_RETURNED', mmgReference: reference });
        mmgFeeReversalsCounter.labels('resolved_not_returned').inc();
        return tx.mmgFeeReversal.findUniqueOrThrow({ where: { id: row.id } });
      });
    }
    const proof = await lookupProof(this.client(), { ...row, providerReference: reference });
    if (!proof.proven) throw new AppError(409, 'NO_PROOF', RESOLVE_COPY.NO_PROOF);
    await this.deps.prisma.$transaction(async (tx) => {
      const marked = await tx.mmgFeeReversal.updateMany({
        where: { id: row.id, state: 'HELD', resolution: null },
        data: {
          resolution: 'RETURNED_BY_REFERENCE', resolvedBy: input.actorId, resolutionNote: reference,
          ...(row.providerReference ? {} : { providerReference: reference }),
        },
      });
      if (marked.count !== 1) throw new AppError(409, 'NOT_HELD', RESOLVE_COPY.NOT_HELD);
      await onAudit(tx, { reversalId: row.id, checkoutId: row.checkoutId, resolution: 'RETURNED_BY_REFERENCE', mmgReference: reference });
    });
    mmgFeeReversalsCounter.labels('resolved_returned').inc();
    return this.applyProof(row.id, proof.how, now);
  }

  /** "Your payment of GYD X on <date> was returned to your MMG account." */
  private async tellPartner(row: MmgFeeReversal): Promise<void> {
    try {
      const [intent, sub] = await Promise.all([
        this.deps.prisma.mmgCheckoutIntent.findUnique({ where: { id: row.checkoutId }, select: { confirmedAt: true, createdAt: true } }),
        this.deps.prisma.subscription.findUnique({
          where: { id: row.subscriptionId },
          select: {
            rider: { select: { userId: true } }, driver: { select: { userId: true } },
            vendor: { select: { id: true, owner: { select: { userId: true } } } },
          },
        }),
      ]);
      const userId = sub?.rider?.userId ?? sub?.driver?.userId ?? sub?.vendor?.owner.userId;
      if (!userId) return;
      const paidOn = (intent?.confirmedAt ?? intent?.createdAt ?? row.sentAt)
        .toLocaleDateString('en-GB', { timeZone: 'America/Guyana', day: 'numeric', month: 'short', year: 'numeric' });
      const amount = formatMoney(Number(row.amount), row.currencyCode, { whole: true });
      await this.deps.notifications.send({
        userId,
        type: 'SYSTEM_ANNOUNCEMENT',
        title: 'Weekly-fee payment returned',
        body: `Your payment of ${amount} on ${paidOn} was returned to your MMG account.`,
        audience: sub?.vendor ? 'business' : 'earner',
        data: { kind: 'billing_mmg_checkout', subscriptionId: row.subscriptionId, ref: row.checkoutId, status: 'REVERSED', ...(sub?.vendor ? { vendorId: sub.vendor.id } : {}) },
      });
    } catch (err) {
      log().warn({ err, reversalId: row.id }, '[MMG reversal] the partner notice failed; the return is recorded');
    }
  }

  /** The admin's "Check with MMG" (and the sweep): only the lookup decides. */
  async check(input: { tenantId: string; reversalId: string }, now: Date = new Date()): Promise<MmgFeeReversal> {
    const row = await this.deps.prisma.mmgFeeReversal.findFirst({ where: { id: input.reversalId, tenantId: input.tenantId } });
    if (!row) throw new NotFoundError('MMG fee reversal', input.reversalId);
    return this.settle(row.id, { now });
  }

  /** [Law 3/4] Every open reversal is read again, bounded, from the checkout poll. */
  async sweep(now: Date = new Date()): Promise<number> {
    const rows = await this.deps.prisma.mmgFeeReversal.findMany({
      where: {
        state: { in: ['SENDING', 'SENT', 'HELD'] },
        sentAt: { lte: new Date(now.getTime() - REVERSAL_SENDING_STALE_MS) },
        OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lte: new Date(now.getTime() - SWEEP_EVERY_MS) } }],
      },
      orderBy: { sentAt: 'asc' }, take: SWEEP_BATCH, select: { id: true },
    });
    let settled = 0;
    for (const { id } of rows) {
      try {
        const after = await this.settle(id, { now });
        if (after.state === 'REVERSED' || after.state === 'FAILED') settled += 1;
      } catch (err) {
        log().error({ err, reversalId: id }, '[MMG reversal] the sweep could not settle a reversal; it is read again next poll');
      }
    }
    return settled;
  }

  /** What the payment's admin page shows: can it be returned, and every attempt. */
  async view(input: { tenantId: string; checkoutId: string }, now: Date = new Date()) {
    const intent = await this.deps.prisma.mmgCheckoutIntent.findFirst({ where: { id: input.checkoutId, tenantId: input.tenantId } });
    if (!intent) throw new NotFoundError('MMG checkout', input.checkoutId);
    const eligibility = await this.deps.prisma.$transaction((tx) => reversalEligibilityInTx(tx, intent, null, now));
    const reversals = await this.deps.prisma.mmgFeeReversal.findMany({
      where: { checkoutId: intent.id, tenantId: input.tenantId }, orderBy: { createdAt: 'desc' },
      select: {
        id: true, state: true, amount: true, currencyCode: true, reason: true, requestedBy: true, providerStatus: true,
        lookupStatus: true, heldReason: true, sentAt: true, answeredAt: true, lastCheckedAt: true, reversedAt: true, failedAt: true,
        resolution: true, resolvedBy: true,
      },
    });
    return {
      checkoutId: intent.id,
      amountGyd: Number(intent.amount),
      switchedOn: feeReversalEnabled(),
      canReverse: eligibility.ok,
      ...(eligibility.ok ? {} : { refusal: { code: eligibility.code, message: REFUSAL_COPY[eligibility.code] } }),
      reversals: reversals.map((r) => ({ ...r, amount: Number(r.amount) })),
    };
  }
}
