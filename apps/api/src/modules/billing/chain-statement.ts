import type { PrismaClient, SubscriptionStatus } from '@prisma/client';
import { OPERATOR, OPERATOR_ADDRESS } from '../legal/operator';
import { AppError, NotFoundError } from '../../utils/errors';
import { guyanaDayKey } from '../../utils/guyana-day';
import { amountDueNow } from './amount-due';
import { companyTin, NOT_A_VAT_INVOICE } from './fee-receipt';
import { weeklyFeeAmount } from './subscription-fee';

// ---------------------------------------------------------------------------
// [ENTERPRISE E3 · owner 29 Oct 2026 "just do whats best"; COORD ruling 21:28Z]
// The chain fee statement: for one store owner and one calendar month (Guyana
// time), every branch, its weekly fee (and the chain deal, if it is on one),
// the weeks it paid in the month, what it owes now, and the receipts issued in
// the month. A STATEMENT of what Swift's own records say, never a demand and
// never a tax invoice: it says "Not a VAT invoice" (the VAT status of
// Westbridge Inc. is pending the accountant; each receipt carries its own VAT
// wording, fee-receipt.ts). Nothing here is computed for a client to re-add:
// every amount is a row of the ledger (subscription_payments CAPTURED, the
// fee_receipts issued) or the one amount-due rule (amount-due.ts).
// Read-only. The owner's own details only (their own statement).
// ---------------------------------------------------------------------------

/** Guyana is UTC-4 all year (no daylight saving): a calendar month starts at 04:00 UTC on its first day. */
const GUYANA_OFFSET_MS = 4 * 3_600_000;
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** The first month a statement may be asked for (before any weekly fee existed). */
export const FIRST_STATEMENT_MONTH = '2026-01';
/** Statuses that owe the fee shown as "owed now" (a churned or cancelled branch is not billed). */
const OWING: ReadonlySet<SubscriptionStatus> = new Set<SubscriptionStatus>(['PAST_DUE', 'SUSPENDED']);

export interface ChainStatementBranch {
  vendorId: string;
  branchName: string;
  address: string;
  subscriptionStatus: SubscriptionStatus | null;
  /** What the branch is charged per week now (the lower of its deal and its own fee); null when it has no fee. */
  weeklyFee: number | null;
  /** [REVIEW-F #2228 S4-2] Its fee is waived (it pays nothing while waived). */
  feeWaived: boolean;
  /** The chain deal it is on now, when it is on one. */
  dealWeeklyRate: number | null;
  /** [REVIEW-F #2228 S3-1] The paid weeks that START in the month (whenever they were paid: paidAt says when). */
  weeks: Array<{ periodStart: string; periodEnd: string; amount: number; paidAt: string | null }>;
  /** What it owes now, when its weekly fee is past due (the amount its own fee screen shows). */
  owedNow: { amount: number; dueSince: string } | null;
  /** The receipts issued in the month: money received for this branch's weekly fee. */
  receipts: Array<{ receiptNumber: string; issuedAt: string; amount: number; channel: string | null }>;
  weeksTotal: number;
  receiptsTotal: number;
}

export interface ChainStatement {
  month: string;
  from: string;
  to: string;
  issuer: { name: string; tradingAs: string; registrationNo: string; registeredOffice: string; tin: string | null };
  billedTo: { name: string; email: string | null; phone: string | null };
  currencyCode: string;
  deal: { weeklyRate: number; currencyCode: string } | null;
  branches: ChainStatementBranch[];
  totals: { weeksCharged: number; received: number; owedNow: number };
  /** Always "Not a VAT invoice": a statement is never a tax invoice. */
  vatNote: string;
  generatedAt: string;
}

/** The month asked for (YYYY-MM), or this month in Guyana; never before FIRST_STATEMENT_MONTH nor after this month. */
export function statementMonth(raw: unknown, now: Date): { month: string; from: Date; to: Date } {
  const current = guyanaDayKey(now).slice(0, 7);
  const month = raw === undefined || raw === null || raw === '' ? current : String(raw);
  const match = MONTH.exec(month);
  if (!match || month < FIRST_STATEMENT_MONTH || month > current) {
    throw new AppError(400, 'STATEMENT_MONTH_INVALID', `Ask for a month as YYYY-MM, from ${FIRST_STATEMENT_MONTH} to this month.`);
  }
  const y = Number(match[1]);
  const m = Number(match[2]);
  const from = new Date(Date.UTC(y, m - 1, 1) + GUYANA_OFFSET_MS);
  const to = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) + GUYANA_OFFSET_MS);
  return { month, from, to };
}

/** One owner's statement for one month (the caller is that owner: their OWNER gate ran first). */
export async function chainStatement(db: PrismaClient, input: { ownerId: string; month?: unknown; now?: Date }): Promise<ChainStatement> {
  const now = input.now ?? new Date();
  const { month, from, to } = statementMonth(input.month, now);
  const owner = await db.vendorOwner.findUnique({
    where: { id: input.ownerId },
    select: {
      dealWeeklyRate: true, dealCurrencyCode: true,
      user: { select: { firstName: true, lastName: true, email: true, phone: true } },
      vendors: {
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: { id: true, name: true, addressLine1: true, city: true, subscription: true },
      },
    },
  });
  if (!owner) throw new NotFoundError('VendorOwner', input.ownerId);
  const subIds = owner.vendors.flatMap((v) => (v.subscription ? [v.subscription.id] : []));
  const [payments, receipts, tin] = await Promise.all([
    subIds.length ? db.subscriptionPayment.findMany({
      where: { subscriptionId: { in: subIds }, status: 'CAPTURED', periodStart: { gte: from, lt: to } },
      orderBy: [{ periodStart: 'asc' }, { id: 'asc' }],
      select: { subscriptionId: true, periodStart: true, periodEnd: true, amount: true, paidAt: true },
    }) : Promise.resolve([]),
    subIds.length ? db.feeReceipt.findMany({
      where: { subscriptionId: { in: subIds }, issuedAt: { gte: from, lt: to } },
      orderBy: [{ issuedAt: 'asc' }, { receiptNumber: 'asc' }],
      select: { subscriptionId: true, receiptNumber: true, issuedAt: true, amount: true, channel: true },
    }) : Promise.resolve([]),
    companyTin(db),
  ]);
  const cents = (n: number) => Math.round(n * 100);
  const branches: ChainStatementBranch[] = [];
  for (const vendor of owner.vendors) {
    const sub = vendor.subscription;
    const weeks = sub ? payments.filter((p) => p.subscriptionId === sub.id).map((p) => ({
      periodStart: p.periodStart.toISOString(), periodEnd: p.periodEnd.toISOString(), amount: Number(p.amount), paidAt: p.paidAt?.toISOString() ?? null,
    })) : [];
    const paid = sub ? receipts.filter((r) => r.subscriptionId === sub.id).map((r) => ({
      receiptNumber: r.receiptNumber, issuedAt: r.issuedAt.toISOString(), amount: Number(r.amount), channel: r.channel,
    })) : [];
    const owed = sub && OWING.has(sub.status) && !sub.feeWaived ? await amountDueNow(db, sub) : 0;
    branches.push({
      vendorId: vendor.id, branchName: vendor.name, address: [vendor.addressLine1, vendor.city].filter(Boolean).join(', '),
      subscriptionStatus: sub?.status ?? null,
      weeklyFee: sub ? (sub.feeWaived ? 0 : weeklyFeeAmount(sub)) : null,
      feeWaived: sub?.feeWaived ?? false,
      dealWeeklyRate: sub && sub.customRate !== null && owner.dealWeeklyRate !== null && Number(sub.customRate) === Number(owner.dealWeeklyRate)
        ? Number(owner.dealWeeklyRate) : null,
      weeks,
      owedNow: sub && owed > 0 ? { amount: owed, dueSince: sub.nextBillingDate.toISOString() } : null,
      receipts: paid,
      weeksTotal: weeks.reduce((s, w) => s + cents(w.amount), 0) / 100,
      receiptsTotal: paid.reduce((s, r) => s + cents(r.amount), 0) / 100,
    });
  }
  const sum = (pick: (b: ChainStatementBranch) => number) => branches.reduce((s, b) => s + cents(pick(b)), 0) / 100;
  const currencyCode = owner.vendors.find((v) => v.subscription)?.subscription?.currencyCode ?? 'GYD';
  return {
    month, from: from.toISOString(), to: to.toISOString(),
    issuer: { name: OPERATOR.name, tradingAs: OPERATOR.tradingAs, registrationNo: OPERATOR.registrationNo, registeredOffice: OPERATOR_ADDRESS, tin },
    billedTo: { name: `${owner.user.firstName ?? ''} ${owner.user.lastName ?? ''}`.trim(), email: owner.user.email, phone: owner.user.phone },
    currencyCode,
    deal: owner.dealWeeklyRate === null ? null : { weeklyRate: Number(owner.dealWeeklyRate), currencyCode: owner.dealCurrencyCode ?? currencyCode },
    branches,
    totals: { weeksCharged: sum((b) => b.weeksTotal), received: sum((b) => b.receiptsTotal), owedNow: sum((b) => b.owedNow?.amount ?? 0) },
    vatNote: NOT_A_VAT_INVOICE,
    generatedAt: now.toISOString(),
  };
}
