import { Prisma, type PrismaClient } from '@prisma/client';
import { csvTextCell } from '../../utils/csv';

// Sequential receipts [san spec 20.1] — gapless per tenant per year, proven
// under concurrency by a row lock on the counter (scenario R). Every credit
// gets one; the receipt row is the GRA-facing paper trail and survives DPA
// erasure under the legal-obligation basis [20.5]. VAT renders only when
// finance.vat_rate is configured (accountant question, LAUNCH_BLOCKERS).

type Db = PrismaClient | Prisma.TransactionClient;

export async function issueReceipt(
  db: Db,
  input: {
    subscriptionId: string;
    billingEventId: string;
    amount: number;
    channel?: string;
    mmgRef?: string;
    tenantId: string;
  },
): Promise<{ receiptNumber: string }> {
  const tenantId = input.tenantId;
  if (!tenantId) throw new Error('RECEIPT_TENANT_REQUIRED');
  const year = new Date().getUTCFullYear();
  // Lock-and-increment in one statement — the RETURNING value IS the claim;
  // two concurrent issuers serialize on the row lock, so numbers are gapless
  // and unique by construction, not by hope.
  const rows = await db.$queryRaw<{ seq: number }[]>`
    INSERT INTO receipt_counters ("tenantId", year, seq) VALUES (${tenantId}, ${year}, 1)
    ON CONFLICT ("tenantId", year) DO UPDATE SET seq = receipt_counters.seq + 1
    RETURNING seq`;
  const seq = rows[0]!.seq;
  const receiptNumber = `SWF-${tenantId === 'swift-default' ? 'SWIFT' : tenantId.toUpperCase().slice(0, 8)}-${year}-${String(seq).padStart(6, '0')}`;
  await db.feeReceipt.create({
    data: {
      receiptNumber,
      tenantId,
      subscriptionId: input.subscriptionId,
      billingEventId: input.billingEventId,
      amount: input.amount,
      channel: input.channel ?? null,
      mmgRef: input.mmgRef ?? null,
    },
  });
  return { receiptNumber };
}

/** Daily cash journal [20.4] — the accountant's CSV. Columns designed to
 *  import cleanly into ERP tooling later.
 *  [owner Q-1654-BOOKS B] A weekly-fee payment MMG returned keeps its receipt
 *  (the paper trail is never rewritten): its line is marked "returned <date>",
 *  and the return itself is a negative MMG_RETURN line on the day it happened,
 *  with MMG's reference. */
export async function cashJournalCsv(prisma: PrismaClient, from: Date, to: Date): Promise<string> {
  const receipts = await prisma.feeReceipt.findMany({
    where: { issuedAt: { gte: from, lt: to } },
    orderBy: { receiptNumber: 'asc' },
  });
  const CHECKOUT_CREDIT = 'mmg-checkout:pp:';
  const returnedOn = (r: { state: string; reversedAt: Date | null; failedAt: Date | null }) => (r.state === 'REVERSED' ? r.reversedAt : r.failedAt);
  const RETURN_SELECT = {
    subscriptionId: true, providerPaymentId: true, amount: true, state: true, resolution: true,
    providerReference: true, resolutionNote: true, reversedAt: true, failedAt: true,
  } as const;
  // Returns of the payments these receipts were issued for (marks), and returns made in the period (lines).
  const credits = await prisma.billingEvent.findMany({
    where: { id: { in: receipts.map((r) => r.billingEventId) }, idempotencyKey: { startsWith: CHECKOUT_CREDIT } },
    select: { id: true, idempotencyKey: true },
  });
  const paymentOfCredit = new Map(credits.map((c) => [c.id, c.idempotencyKey.slice(CHECKOUT_CREDIT.length)]));
  const [marked, inPeriod] = await Promise.all([
    prisma.mmgFeeReversal.findMany({
      where: { providerPaymentId: { in: [...paymentOfCredit.values()] }, OR: [{ state: 'REVERSED' }, { resolution: 'RETURNED_NOT_BOOKED' }] },
      select: RETURN_SELECT,
    }),
    prisma.mmgFeeReversal.findMany({
      where: { OR: [
        { state: 'REVERSED', reversedAt: { gte: from, lt: to } },
        { resolution: 'RETURNED_NOT_BOOKED', failedAt: { gte: from, lt: to } },
      ] },
      select: RETURN_SELECT,
    }),
  ]);
  const returnOfPayment = new Map(marked.map((r) => [r.providerPaymentId, r]));
  // The original receipt of each return made in the period.
  const returnCredits = await prisma.billingEvent.findMany({
    where: { idempotencyKey: { in: inPeriod.map((r) => `${CHECKOUT_CREDIT}${r.providerPaymentId}`) } },
    select: { id: true, idempotencyKey: true },
  });
  const returnReceipts = await prisma.feeReceipt.findMany({
    where: { billingEventId: { in: returnCredits.map((c) => c.id) } },
    select: { billingEventId: true, receiptNumber: true },
  });
  const receiptOfPayment = new Map(returnReceipts.map((r) => [
    returnCredits.find((c) => c.id === r.billingEventId)!.idempotencyKey.slice(CHECKOUT_CREDIT.length), r.receiptNumber,
  ]));
  const subIds = [...new Set([...receipts.map((r) => r.subscriptionId), ...inPeriod.map((r) => r.subscriptionId)])];
  const subs = await prisma.subscription.findMany({
    where: { id: { in: subIds } },
    select: { id: true, san: true, type: true, vendor: { select: { name: true } } },
  });
  const byId = new Map(subs.map((s) => [s.id, s]));
  // [security review: csv-formula-injection] every text cell is neutralised; amounts are Swift's own numbers.
  const esc = csvTextCell;
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const lines = ['date,receipt_no,san,account,type,channel,amount_gyd,mmg_ref,status'];
  for (const r of receipts) {
    const s = byId.get(r.subscriptionId);
    const payment = paymentOfCredit.get(r.billingEventId);
    const ret = payment ? returnOfPayment.get(payment) : undefined;
    const on = ret ? returnedOn(ret) : null;
    lines.push([
      day(r.issuedAt),
      esc(r.receiptNumber),
      esc(s?.san ?? ''),
      esc(s?.vendor?.name ?? r.subscriptionId),
      esc(s?.type ?? ''),
      esc(r.channel ?? ''),
      Number(r.amount).toFixed(2),
      esc(r.mmgRef ?? ''),
      ret ? `returned${on ? ` ${day(on)}` : ''}` : '',
    ].join(','));
  }
  for (const ret of [...inPeriod].sort((a, b) => (returnedOn(a)?.getTime() ?? 0) - (returnedOn(b)?.getTime() ?? 0))) {
    const s = byId.get(ret.subscriptionId);
    const on = returnedOn(ret);
    lines.push([
      on ? day(on) : '',
      esc(receiptOfPayment.get(ret.providerPaymentId) ?? ''),
      esc(s?.san ?? ''),
      esc(s?.vendor?.name ?? ret.subscriptionId),
      esc(s?.type ?? ''),
      'MMG_RETURN',
      (-Number(ret.amount)).toFixed(2),
      esc((ret.resolution ? ret.resolutionNote : null) ?? ret.providerReference ?? ''),
      'returned',
    ].join(','));
  }
  return lines.join('\n');
}
