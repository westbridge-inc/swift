import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { cashJournalCsv } from '../modules/billing/receipts';

// ---------------------------------------------------------------------------
// [MASTER-038] The accountant's cash-journal CSV never hands a spreadsheet a
// formula.
//
// A vendor controls its own name, and the journal wrote that name into the
// account column with an escape that only quoted delimiters: a name starting
// with = + - @ (or a tab/carriage return) reached the accountant's spreadsheet
// as a live formula. Every externally influenced text cell is now encoded by
// one export boundary: formula-leading text is prefixed with an apostrophe
// (the documented convention), then quoted per RFC 4180. Dates and validated
// amounts are written as they were.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const receiptNumbers: string[] = [];
const phoneBase = 592_009_000_000 + Math.floor(Math.random() * 8_000_000);
let seq = 0;

/** RFC 4180 reader: quoted fields, doubled quotes, CR/LF inside quotes. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  row.push(cell); rows.push(row);
  return rows;
}

async function receiptFor(name: string, channel: string, mmgRef: string) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Csv', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name, slug: `csv-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '7 Ledger Way', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 2100, billingMethod: 'CASH',
      currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000), nextBillingDate: new Date(Date.now() + 7 * 86_400_000),
    } as never,
  });
  subIds.push(sub.id);
  const event = await prisma.billingEvent.create({ data: { subscriptionId: sub.id, type: 'PREPAID_TOPUP', amount: 2100, idempotencyKey: `csv-test:${nanoid(10)}` } });
  const receiptNumber = `SWF-CSVTEST-${nanoid(10)}`;
  receiptNumbers.push(receiptNumber);
  await prisma.feeReceipt.create({ data: { receiptNumber, tenantId: 'swift-default', subscriptionId: sub.id, billingEventId: event.id, amount: 2100, channel, mmgRef } });
  return receiptNumber;
}

afterAll(async () => {
  await prisma.feeReceipt.deleteMany({ where: { receiptNumber: { in: receiptNumbers } } });
  await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

const FORMULAS = [
  '=HYPERLINK("https://example.invalid/x","Open")',
  '+SUM(1,2)',
  '-2+3',
  '@SUM(A1)',
  '\t=1+1',
  '\r=1+1',
  ' =1+1',
  '\n=1+1',
];
const ORDINARY = ['Acme, Inc.', 'The "Best" Shop', 'Café Ñandú — Kitchen', '(Brackets) Foods', "'Quoted' Store"];

let byReceipt = new Map<string, string[]>();
let header: string[] = [];

beforeAll(async () => {
  for (const name of [...FORMULAS, ...ORDINARY]) await receiptFor(name, 'AGENT', `REF-${nanoid(6)}`);
  await receiptFor('Plain Vendor', '=cmd|calc', '@ref');
  const csv = await cashJournalCsv(prisma, new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000));
  const rows = parseCsv(csv);
  header = rows[0]!;
  byReceipt = new Map(rows.slice(1).map((r) => [r[1]!, r]));
});

describe('[MASTER-038] cash-journal text cells are inert', () => {
  it('keeps the header, the column count and the receipt rows', () => {
    expect(header).toEqual(['date', 'receipt_no', 'san', 'account', 'type', 'channel', 'amount_gyd', 'mmg_ref']);
    for (const n of receiptNumbers) {
      const row = byReceipt.get(n);
      expect(row, n).toBeDefined();
      expect(row).toHaveLength(8);
      expect(row![6]).toBe('2100.00');
      expect(row![0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it.each(FORMULAS.map((f, i) => [JSON.stringify(f), i] as const))('a vendor named %s reaches the sheet as text, never a formula', (_label, i) => {
    const cell = byReceipt.get(receiptNumbers[i]!)![3]!;
    expect(cell).toBe(`'${FORMULAS[i]}`);
  });

  it.each(ORDINARY.map((n, i) => [n, i] as const))('an ordinary name (%s) round-trips unchanged', (_label, i) => {
    expect(byReceipt.get(receiptNumbers[FORMULAS.length + i]!)![3]).toBe(ORDINARY[i]);
  });

  it('other externally influenced text columns get the same protection', () => {
    const row = byReceipt.get(receiptNumbers[receiptNumbers.length - 1]!)!;
    expect(row[5]).toBe("'=cmd|calc");
    expect(row[7]).toBe("'@ref");
  });

  it('the encoder itself: formula-leading text is prefixed, delimiters are quoted, plain text is untouched', async () => {
    const { csvText } = await import('../utils/csv-export');
    expect(csvText('=1')).toBe("'=1");
    expect(csvText('a,b')).toBe('"a,b"');
    expect(csvText('-x,y')).toBe(`"'-x,y"`);
    expect(csvText('say "hi"')).toBe('"say ""hi"""');
    expect(csvText('plain')).toBe('plain');
    // a cell that merely STARTS with a tab or carriage return is neutralised too
    expect(csvText('\tplain')).toBe(`"'\tplain"`);
    expect(csvText('\rplain')).toBe(`"'\rplain"`);
    expect(csvText('')).toBe('');
  });
});
