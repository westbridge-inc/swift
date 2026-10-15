import type { Prisma, PrismaClient } from '@prisma/client';
import { OPERATOR, OPERATOR_ADDRESS } from '../legal/operator';
import { formatMoney } from '../../utils/currency-amount';
import { formatGuyanaTime } from '../../utils/guyana-day';

// ---------------------------------------------------------------------------
// [OWNER LEGAL PLAN 15 Oct 2026 · R11 + R12, research T3] THE weekly-fee
// receipt, as a partner, support or the accountant reads it.
//
// While Westbridge Inc. is not VAT-registered it issues plain receipts with
// no VAT line (VAT Act s.28(3): no tax invoice outside s.28; s.33(1)(d): a
// non-registered person who "represents that tax is charged" can be
// assessed; s.67 "improper VAT documentation"). Every receipt carries:
// Westbridge Inc. (trading as Swift), its registration number, its
// registered office, its TIN (once the owner sets it: never guessed), the
// sequential receipt number, the date, the partner's name, the week covered,
// the amount, and the words "Not a VAT invoice".
//
// A VAT line appears ONLY when the "VAT registered" setting holds a VAT
// number (platform config `finance.vat_registration` = { vatNumber }), set
// once GRA registers the company. Then the receipt names the VAT number and
// the VAT the price includes (14%: the tax fraction 14/114, VAT Act s.16(2),
// VAT Regulations reg. 2), and "Not a VAT invoice" is dropped; the
// accountant confirms the full tax-invoice particulars (Schedule III) before
// that switch is set.
// ---------------------------------------------------------------------------

export const NOT_A_VAT_INVOICE = 'Not a VAT invoice';
/** The company's GRA taxpayer number, set by the owner in the admin config (digits). */
export const COMPANY_TIN_KEY = 'finance.company_tin';
/** Set only once GRA registers the company for VAT: { vatNumber }. */
export const VAT_REGISTRATION_KEY = 'finance.vat_registration';
export const VAT_RATE = 0.14;

type Db = Pick<PrismaClient | Prisma.TransactionClient, 'platformConfig' | 'feeReceipt' | 'billingEvent' | 'subscription' | 'subscriptionPayment'>;

const digits = (raw: unknown, min: number, max: number): string | null => {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const compact = String(raw).replace(/[\s-]+/g, '');
  return new RegExp(`^\\d{${min},${max}}$`).test(compact) ? compact : null;
};

/** The company TIN, or null until the owner sets a well-formed one. */
export async function companyTin(db: Pick<Db, 'platformConfig'>): Promise<string | null> {
  const row = await db.platformConfig.findUnique({ where: { key: COMPANY_TIN_KEY }, select: { value: true } });
  return digits(row?.value, 6, 15);
}

/** The company's VAT registration, or null: unregistered, and anything malformed counts as unregistered. */
export async function vatRegistration(db: Pick<Db, 'platformConfig'>): Promise<{ vatNumber: string } | null> {
  const row = await db.platformConfig.findUnique({ where: { key: VAT_REGISTRATION_KEY }, select: { value: true } });
  const value = row?.value;
  const vatNumber = value && typeof value === 'object' && !Array.isArray(value) ? digits((value as Record<string, unknown>)['vatNumber'], 6, 15) : null;
  return vatNumber ? { vatNumber } : null;
}

export interface FeeReceiptDocument {
  receiptNumber: string;
  issuedAt: string;
  issuer: { name: string; tradingAs: string; registrationNo: string; registeredOffice: string; tin: string | null };
  partnerName: string;
  /** The week this payment paid, once it has paid one (a fee paid ahead pays the coming week when it starts). */
  weekCovered: { from: string; to: string } | null;
  amount: number;
  currencyCode: string;
  vat: { vatNumber: string; rate: number; included: number } | null;
  /** The receipt as printed, line by line: what every screen shows. */
  lines: string[];
}

const day = (at: Date) => formatGuyanaTime(at, { day: 'numeric', month: 'long', year: 'numeric' });

/** The receipt for one receipt number, or null. A caller acting for a tenant
 *  (an admin) passes its scope: a receipt of another tenant, or of a
 *  subscription outside it, is null (not found). */
export async function feeReceiptDocument(
  db: Db,
  receiptNumber: string,
  scope?: { tenantId: string; subscriptionWhere: Prisma.SubscriptionWhereInput },
): Promise<FeeReceiptDocument | null> {
  const receipt = await db.feeReceipt.findFirst({ where: { receiptNumber, ...(scope ? { tenantId: scope.tenantId } : {}) } });
  if (!receipt) return null;
  if (scope && await db.subscription.count({ where: { AND: [{ id: receipt.subscriptionId }, scope.subscriptionWhere] } }) === 0) return null;
  const [event, sub, tin, vat] = await Promise.all([
    db.billingEvent.findUnique({ where: { id: receipt.billingEventId }, select: { currencyCode: true } }),
    db.subscription.findUnique({
      where: { id: receipt.subscriptionId },
      select: { vendor: { select: { name: true } }, rider: { select: { user: { select: { firstName: true, lastName: true } } } }, driver: { select: { user: { select: { firstName: true, lastName: true } } } } },
    }),
    companyTin(db),
    vatRegistration(db),
  ]);
  // The week this money paid: the first week paid at or after it arrived (a fee
  // paid early is spent on the coming week when that week starts).
  const week = await db.subscriptionPayment.findFirst({
    where: { subscriptionId: receipt.subscriptionId, status: 'CAPTURED', paidAt: { gte: receipt.issuedAt } },
    orderBy: [{ paidAt: 'asc' }, { periodStart: 'asc' }],
    select: { periodStart: true, periodEnd: true },
  });
  const person = sub?.rider?.user ?? sub?.driver?.user;
  const partnerName = sub?.vendor?.name ?? (person ? `${person.firstName} ${person.lastName}`.trim() : 'Partner');
  const currencyCode = event?.currencyCode ?? 'GYD';
  const amount = Number(receipt.amount);
  const included = vat ? Math.round((amount * VAT_RATE / (1 + VAT_RATE)) * 100) / 100 : 0;
  const issuer = { name: OPERATOR.name, tradingAs: OPERATOR.tradingAs, registrationNo: OPERATOR.registrationNo, registeredOffice: OPERATOR_ADDRESS, tin };
  const weekCovered = week ? { from: week.periodStart.toISOString(), to: week.periodEnd.toISOString() } : null;
  const lines = [
    `${issuer.name} (trading as ${issuer.tradingAs})`,
    `Registration no. ${issuer.registrationNo}`,
    `Registered office: ${issuer.registeredOffice}`,
    ...(tin ? [`TIN: ${tin}`] : []),
    ...(vat ? [`VAT registration number: ${vat.vatNumber}`] : []),
    `Receipt ${receipt.receiptNumber}`,
    `Date: ${day(receipt.issuedAt)}`,
    `Partner: ${partnerName}`,
    weekCovered
      ? `Week covered: ${day(new Date(weekCovered.from))} to ${day(new Date(new Date(weekCovered.to).getTime() - 1))}`
      : 'Week covered: the coming week (a weekly fee paid ahead pays its week when that week starts)',
    `Weekly fee: ${formatMoney(amount, currencyCode, { whole: false })}`,
    ...(vat ? [`Price includes VAT at ${Math.round(VAT_RATE * 100)}%: ${formatMoney(included, currencyCode)}`] : [NOT_A_VAT_INVOICE]),
  ];
  return {
    receiptNumber: receipt.receiptNumber, issuedAt: receipt.issuedAt.toISOString(), issuer, partnerName, weekCovered,
    amount, currencyCode, vat: vat ? { vatNumber: vat.vatNumber, rate: VAT_RATE, included } : null, lines,
  };
}

/** A subscription's receipts, newest first: what the weekly-fee screen lists. */
export async function feeReceiptsFor(db: Db, subscriptionId: string, take = 10): Promise<FeeReceiptDocument[]> {
  const rows = await db.feeReceipt.findMany({ where: { subscriptionId }, orderBy: { issuedAt: 'desc' }, take, select: { receiptNumber: true } });
  const docs = await Promise.all(rows.map((r) => feeReceiptDocument(db, r.receiptNumber)));
  return docs.filter((d): d is FeeReceiptDocument => d !== null);
}
