import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { issueReceipt, cashJournalCsv } from '../modules/billing/receipts';
import { runBillingInvariants } from '../modules/billing/invariants';

// Scenario R (gapless receipts under concurrency) + the nightly invariants
// [san spec 24.2/16.3]: balance provability, the wrongful-suspension
// auto-heal, and receipt-sequence integrity — all asserted from DB rows.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });

const TENANT = `rcpt-${nanoid(6).toLowerCase()}`; // isolated counter namespace per run
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;
const phoneBase = 592_008_000_000 + Math.floor(Math.random() * 8_000_000);

async function makeVendorSub(over: Record<string, unknown> = {}) {
  seq += 1;
  const user = await prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Rcpt', lastName: `U${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(user.id);
  const owner = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: owner.id, name: `Receipt Vendor ${seq}`, slug: `rcpt-${nanoid(8).toLowerCase()}`,
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
      ...over,
    } as never,
  });
  subIds.push(sub.id);
  return { sub };
}

async function topupEvent(subscriptionId: string, amount: number) {
  return prisma.billingEvent.create({
    data: { subscriptionId, type: 'PREPAID_TOPUP', amount, idempotencyKey: `rcpt-test:${nanoid(10)}` },
  });
}

beforeAll(async () => { await prisma.$connect(); });

afterAll(async () => {
  await prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.receiptCounter.deleteMany({ where: { tenantId: TENANT } });
  await prisma.collectionContact.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe('scenario R — gapless sequential receipts', () => {
  it('50 concurrent issues → 50 consecutive numbers, zero gaps, zero duplicates', async () => {
    const { sub } = await makeVendorSub();
    const events = await Promise.all(Array.from({ length: 50 }, () => topupEvent(sub.id, 2100)));
    const results = await Promise.all(events.map((e) =>
      issueReceipt(prisma, { subscriptionId: sub.id, billingEventId: e.id, amount: 2100, channel: 'TEST', tenantId: TENANT }),
    ));
    const seqs = results
      .map((r) => Number(r.receiptNumber.split('-').pop()))
      .sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(50);
    expect(seqs[0]).toBe(1);
    expect(seqs[49]).toBe(50);
    for (let i = 0; i < 50; i += 1) expect(seqs[i]).toBe(i + 1); // consecutive — the row lock proof
    expect(results[0]!.receiptNumber).toMatch(new RegExp(`^SWF-${TENANT.toUpperCase().slice(0, 8)}-\\d{4}-\\d{6}$`));
  });

  it('the cash journal CSV carries receipt, SAN, account, amount', async () => {
    const csv = await cashJournalCsv(prisma, new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000));
    expect(csv.split('\n')[0]).toBe('date,receipt_no,san,account,type,channel,amount_gyd,mmg_ref');
    expect(csv).toContain('Receipt Vendor');
    expect(csv).toContain('2100.00');
  });
});

describe('nightly invariants', () => {
  it('proves wallet balances from the ledger and flags a seeded mismatch', async () => {
    const { sub } = await makeVendorSub();
    await topupEvent(sub.id, 5000);
    await prisma.prepaidBalance.create({ data: { subscriptionId: sub.id, balance: 4000 } }); // 1000 short — seeded corruption
    const report = await runBillingInvariants(prisma);
    const mine = report.walletMismatches.find((m) => m.subscriptionId === sub.id);
    expect(mine).toBeTruthy();
    expect(mine!.ledger).toBe(5000);
    expect(mine!.balance).toBe(4000);
    await prisma.prepaidBalance.update({ where: { subscriptionId: sub.id }, data: { balance: 5000 } }); // heal for later assertions
  });

  it('wrongful suspension (paid-through but SUSPENDED) is auto-healed with a REINSTATED row', async () => {
    const { sub } = await makeVendorSub({
      status: 'SUSPENDED', suspendedAt: new Date(), currentPeriodEnd: new Date(Date.now() + 5 * 86_400_000),
    });
    const report = await runBillingInvariants(prisma);
    expect(report.wrongfulSuspensions).toContain(sub.id);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe('ACTIVE');
    const heal = await prisma.billingEvent.findFirst({ where: { subscriptionId: sub.id, type: 'REINSTATED' } });
    expect(heal?.note).toContain('wrongful-suspension');
  });

  it('enforcement leak (ACTIVE, unpaid past grace+6h) is reported, not acted on', async () => {
    const { sub } = await makeVendorSub({ currentPeriodEnd: new Date(Date.now() - 60 * 3_600_000) });
    const report = await runBillingInvariants(prisma);
    expect(report.enforcementLeaks).toContain(sub.id);
    const untouched = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(untouched.status).toBe('ACTIVE'); // dunning owns enforcement, the detector only alerts
  });
});
