import { Prisma, type PrismaClient } from '@prisma/client';
import { csvNumber, csvText } from '../../utils/csv-export';

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
 *  import cleanly into ERP tooling later. */
export async function cashJournalCsv(prisma: PrismaClient, from: Date, to: Date): Promise<string> {
  const receipts = await prisma.feeReceipt.findMany({
    where: { issuedAt: { gte: from, lt: to } },
    orderBy: { receiptNumber: 'asc' },
  });
  const subIds = [...new Set(receipts.map((r) => r.subscriptionId))];
  const subs = await prisma.subscription.findMany({
    where: { id: { in: subIds } },
    select: { id: true, san: true, type: true, vendor: { select: { name: true } } },
  });
  const byId = new Map(subs.map((s) => [s.id, s]));
  // [MASTER-038] Every text cell goes through the one CSV export boundary, so
  // a vendor name (or any other externally influenced text) that starts like a
  // formula reaches the accountant's spreadsheet as inert text. The date and
  // the amount are server-formatted and written as they were.
  const lines = ['date,receipt_no,san,account,type,channel,amount_gyd,mmg_ref'];
  for (const r of receipts) {
    const s = byId.get(r.subscriptionId);
    lines.push([
      r.issuedAt.toISOString().slice(0, 10),
      csvText(r.receiptNumber),
      csvText(s?.san ?? ''),
      csvText(s?.vendor?.name ?? r.subscriptionId),
      csvText(s?.type ?? ''),
      csvText(r.channel ?? ''),
      csvNumber(Number(r.amount)),
      csvText(r.mmgRef ?? ''),
    ].join(','));
  }
  return lines.join('\n');
}
