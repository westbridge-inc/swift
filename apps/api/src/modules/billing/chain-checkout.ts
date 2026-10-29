import type { MmgCheckoutIntent, Prisma, PrismaClient, Subscription, SubscriptionStatus } from '@prisma/client';
import type { MmgCheckoutProvider } from '../../providers/mmg/mmg-checkout';
import { payInfo } from './agent-cash.service';
import { checkoutAmountGyd, mmgCheckoutLive, type ClientPlatform } from './fee-pay-actions';
import { readFeePaymentDecision } from './fee-payment-authority';
import { payAheadAllows } from './pay-ahead';
import { lockBillingAuthority, type ConfirmationSource } from './dunning-clock';

// ---------------------------------------------------------------------------
// [ENTERPRISE E1 · owner 29 Oct 2026 "just do whats best"; COORD ruling 21:28Z]
// "Pay all my branches": a store owner may pay every branch fee that is due in
// ONE MMG checkout. It is optional: each branch's own checkout keeps working.
//
// Money rules (GUARDRAILS s1, MMG-CHECKOUT-API.md section 12):
// - The quote is each branch's OWN Pay amount, priced exactly as that branch's
//   fee screen prices it (checkoutAmountGyd over payInfo), for every branch
//   whose own MMG Pay button is live now (nothing being confirmed, one week
//   ahead at most). The owner sees that list first and confirms it.
// - The checkout is re-priced under every branch's billing locks before the
//   MMG page exists. Any difference from what the owner confirmed refuses it
//   (409 PAYMENT_QUOTE_CHANGED): nothing is ever adjusted after a payment.
// - Each branch's clock is held by its own part while the checkout is open,
//   confirming, held or expired without an answer, so the same fee can never
//   be paid twice (its own Pay button is off; its own checkout refuses).
// - Nothing is credited until MMG's own lookup confirms the exact total (the
//   six conditions, unchanged). Then, in one transaction, the one MMG payment
//   is claimed once and each branch's share is credited to that branch's
//   weekly fee (a receipt per branch; the week it pays is recorded in
//   fee_receipt_allocations when the branch's charge spends it).
// ---------------------------------------------------------------------------

/** Statuses whose fee is "due" for the pay-all list. A branch in its free
 *  trial owes nothing yet; a churned, paused or cancelled branch is not billed
 *  (paying rejoins a churned store, branch by branch, from its own screen). */
const DUE_STATUSES: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>(['ACTIVE', 'PAST_DUE', 'SUSPENDED']);

/** Why a branch is (or is not) in the pay-all list, in the server's words. */
export type ChainBranchFeeState =
  /** Its fee is due and its own MMG Pay is live: included, at `amountGyd`. */
  | 'DUE'
  /** Free trial: nothing to pay yet. */
  | 'TRIAL'
  /** Paid up as far as Swift takes payment (one week ahead), or nothing owed. */
  | 'NOTHING_DUE'
  /** A payment for this branch is being confirmed (its own or a pay-all). */
  | 'PAYMENT_CONFIRMING'
  /** Not billed, waived, or MMG paying is off for it here. */
  | 'NOT_PAYABLE';

export interface ChainBranchFee {
  vendorId: string;
  branchName: string;
  subscriptionId: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  state: ChainBranchFeeState;
  /** What this branch's own Pay button would charge now; only for DUE. */
  amountGyd: number | null;
}

export interface ChainFeeQuote {
  /** Every branch of the owner, in name order, each with its state. */
  branches: ChainBranchFee[];
  /** The DUE branches' amounts added up: what one MMG checkout would ask for. */
  totalGyd: number;
  currencyCode: 'GYD';
  /** True when at least one branch is DUE and the owner's account may open an MMG page. */
  payable: boolean;
}

/** What a branch's fee screen would charge, and whether its own Pay is live:
 *  the same rule, the same reads (feePayActions + the confirmation authority). */
async function branchFee(
  db: PrismaClient, sub: Subscription, platform: ClientPlatform, checkout: () => MmgCheckoutProvider, now: Date,
): Promise<{ state: ChainBranchFeeState; amountGyd: number | null }> {
  if (sub.status === 'TRIAL') return { state: 'TRIAL', amountGyd: null };
  if (!DUE_STATUSES.has(sub.status)) return { state: 'NOT_PAYABLE', amountGyd: null };
  if (!(await mmgCheckoutLive(db, sub, platform, checkout))) return { state: 'NOT_PAYABLE', amountGyd: null };
  if (!(await readFeePaymentDecision(db, sub.id)).allowed) return { state: 'PAYMENT_CONFIRMING', amountGyd: null };
  const fee = await payInfo(db, sub);
  if (!(fee.amountDueGyd > 0)) return { state: 'NOTHING_DUE', amountGyd: null };
  const amountGyd = checkoutAmountGyd(fee);
  if (!(await payAheadAllows(db, sub.id, amountGyd, now))) return { state: 'NOTHING_DUE', amountGyd: null };
  return { state: 'DUE', amountGyd };
}

/**
 * The pay-all list for one owner: every branch (store) the owner holds, with
 * what its own Pay button would charge now. Read-only: it never maps a clock,
 * takes a hold or changes a payment. `production` is false for a store-review
 * demo owner: such an owner sees the list but can never open an MMG page.
 */
export async function chainFeeQuote(
  db: PrismaClient,
  input: { ownerId: string; platform: ClientPlatform; checkout: () => MmgCheckoutProvider; production: boolean; now?: Date },
): Promise<ChainFeeQuote> {
  const now = input.now ?? new Date();
  const vendors = await db.vendor.findMany({
    where: { ownerId: input.ownerId },
    select: { id: true, name: true, subscription: true },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  const branches: ChainBranchFee[] = [];
  for (const vendor of vendors) {
    const sub = vendor.subscription;
    const fee = sub ? await branchFee(db, sub, input.platform, input.checkout, now) : { state: 'NOT_PAYABLE' as const, amountGyd: null };
    branches.push({
      vendorId: vendor.id, branchName: vendor.name, subscriptionId: sub?.id ?? null, subscriptionStatus: sub?.status ?? null,
      state: fee.state, amountGyd: fee.amountGyd,
    });
  }
  const due = branches.filter((b) => b.state === 'DUE');
  const totalGyd = due.reduce((sum, b) => sum + (b.amountGyd ?? 0), 0);
  return { branches, totalGyd, currencyCode: 'GYD', payable: input.production && due.length > 0 };
}

/** One subscription a checkout pays, with the confirmation source that holds its clock. */
export interface CoveredFee {
  subscriptionId: string;
  /** The share of the checkout's amount this subscription is credited (the whole amount for a single checkout). */
  amount: number;
  source: Extract<ConfirmationSource, { checkoutId: string } | { checkoutPartId: string }>;
  partId: string | null;
}

type Db = PrismaClient | Prisma.TransactionClient;

/** Every subscription a checkout pays: its one subscription, or a chain
 *  checkout's branches (sorted by subscription, the lock order). */
export async function coveredFees(db: Db, intent: Pick<MmgCheckoutIntent, 'id' | 'subscriptionId' | 'amount'>): Promise<CoveredFee[]> {
  if (intent.subscriptionId) {
    return [{ subscriptionId: intent.subscriptionId, amount: Number(intent.amount), source: { checkoutId: intent.id }, partId: null }];
  }
  const parts = await db.mmgCheckoutPart.findMany({ where: { checkoutId: intent.id }, orderBy: [{ subscriptionId: 'asc' }, { id: 'asc' }] });
  if (parts.length === 0) throw new Error(`Chain checkout ${intent.id} has no parts`);
  return parts.map((part) => ({ subscriptionId: part.subscriptionId, amount: Number(part.amount), source: { checkoutPartId: part.id }, partId: part.id }));
}

/** The payer, then every subscription the checkout pays, in one order (the
 *  payer's row first, then the subscriptions sorted): every verifier, credit,
 *  hold and release of a checkout serializes here. Returns the covered fees
 *  and the payer's user and tenant. */
export async function lockCheckoutAuthority(tx: Prisma.TransactionClient, intent: Pick<MmgCheckoutIntent, 'id' | 'subscriptionId' | 'amount'>) {
  const covered = await coveredFees(tx, intent);
  let payer: { userId: string; tenantId: string } | null = null;
  for (const fee of covered) {
    const authority = await lockBillingAuthority(tx, fee.subscriptionId);
    if (payer && (payer.userId !== authority.userId || payer.tenantId !== authority.tenantId)) {
      throw new Error(`Chain checkout ${intent.id} covers branches of more than one payer`);
    }
    payer = { userId: authority.userId, tenantId: authority.tenantId };
  }
  return { covered, payer: payer! };
}
