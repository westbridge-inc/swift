import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { runWithoutTenant } from '../plugins/tenant-context';
import { issueReceipt } from '../modules/billing/receipts';
import { COMPANY_TIN_KEY, NOT_A_VAT_INVOICE, PAID_TOWARD, VAT_REGISTRATION_KEY, feeReceiptDocument, feeReceiptsFor } from '../modules/billing/fee-receipt';
import { OPERATOR } from '../modules/legal/operator';
import { syntheticLocationOwner } from './helpers/online-mover';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';

// ---------------------------------------------------------------------------
// [OWNER LEGAL PLAN 15 Oct 2026 · R11 + R12, research T3] The weekly-fee
// receipt. While Westbridge Inc. is not VAT-registered: no VAT line anywhere
// a partner sees a fee, and every receipt says "Not a VAT invoice". Every
// receipt names Westbridge Inc. (trading as Swift), registration no. 17703,
// the registered office, the company TIN once the owner sets it (never a
// guess), the receipt number, the date, the partner, what it paid and the
// amount. A VAT line only once the "VAT registered" setting holds a number.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
// This file's own fixture block (+5920339nnn). No other file uses 5920339.
const PHONE_PREFIX = '+5920339';
let app: FastifyInstance;
let seq = 0;
const subIds: string[] = [];
const userIds: string[] = [];
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn);
const saved = new Map<string, unknown>();

async function riderCredit(amount = 6000) {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({ data: {
    phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`, firstName: 'Receipt', lastName: `Rider${seq}`,
    roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true,
  } }));
  userIds.push(user.id);
  const rider = await sys(() => app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, isOnline: false, locationSessionId: syntheticLocationOwner('fee-receipt') } }));
  const due = new Date(Date.now() + 3 * DAY);
  const sub = await sys(() => app.prisma.subscription.create({ data: {
    riderId: rider.id, type: 'DELIVERY_RIDER', status: 'ACTIVE', weeklyRate: amount, billingMethod: 'CASH', autoRenew: true,
    currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
  } }));
  subIds.push(sub.id);
  const event = await sys(() => app.prisma.billingEvent.create({ data: { subscriptionId: sub.id, type: 'PREPAID_TOPUP', amount, currencyCode: 'GYD', idempotencyKey: `fee-receipt-test:${sub.id}` } }));
  const { receiptNumber } = await sys(() => issueReceipt(app.prisma, { subscriptionId: sub.id, billingEventId: event.id, amount, tenantId: 'swift-default' }));
  return { subId: sub.id, receiptNumber, user, due };
}

const setConfig = (key: string, value: unknown) => sys(() => app.prisma.platformConfig.upsert({ where: { key }, update: { value: value as never }, create: { key, value: value as never } }));
const clearConfig = (key: string) => sys(() => app.prisma.platformConfig.deleteMany({ where: { key } }));

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  // Whatever an earlier run left in the two settings is put back at the end.
  for (const key of [COMPANY_TIN_KEY, VAT_REGISTRATION_KEY]) {
    const row = await sys(() => app.prisma.platformConfig.findUnique({ where: { key } }));
    if (row) saved.set(key, row.value);
    await clearConfig(key);
  }
});

afterEach(async () => {
  await clearConfig(COMPANY_TIN_KEY);
  await clearConfig(VAT_REGISTRATION_KEY);
});

afterAll(async () => {
  for (const [key, value] of saved) await setConfig(key, value);
  await sys(async () => {
    await cleanupBillingClocks(app.prisma, subIds);
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    // Receipts stay: the numbers are gapless by law and the rows outlive their account.
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }).catch(() => {});
  await app.close();
});

describe('[R12] every weekly-fee receipt names the seller, the partner, what it paid and the amount', () => {
  it('unregistered for VAT and no TIN set: the plain receipt, ending "Not a VAT invoice"', async () => {
    const { receiptNumber, user } = await riderCredit();
    const doc = (await sys(() => feeReceiptDocument(app.prisma, receiptNumber)))!;
    expect(doc.issuer).toEqual({
      name: 'Westbridge Inc.', tradingAs: 'Swift', registrationNo: '17703',
      registeredOffice: 'Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana', tin: null,
    });
    expect(doc.lines.slice(0, 3)).toEqual([
      'Westbridge Inc. (trading as Swift)',
      'Registration no. 17703',
      'Registered office: Lot 165 New Trafalgar Building, Waterloo Street, Georgetown, Demerara, Guyana',
    ]);
    expect(doc.lines).toContain(`Receipt ${receiptNumber}`);
    expect(doc.lines.some((l) => /^Date: \d{1,2} [A-Z][a-z]+ \d{4}$/.test(l))).toBe(true);
    expect(doc.lines).toContain(`Partner: ${user.firstName} ${user.lastName}`);
    expect(doc.lines).toContain('Weekly fee: GY$6,000');
    expect(doc.lines[doc.lines.length - 1]).toBe(NOT_A_VAT_INVOICE);
    expect(doc).toMatchObject({ receiptNumber, amount: 6000, currencyCode: 'GYD', vat: null });
    expect(doc.lines.some((l) => l.startsWith('TIN'))).toBe(false);
    // The company's identity comes from the one constant, never retyped here.
    expect(doc.issuer.name).toBe(OPERATOR.name);
  });

  // [REVIEW-G #1771 S2-1] The week used to be inferred by comparing clocks
  // (the first week paid at or after the receipt). On the checkout rail the
  // week this money pays is booked at an instant taken BEFORE the receipt is
  // written, so the receipt said "the coming week", then named the week after.
  // A receipt states only what is true when it is issued.
  it('[S2-1] names no week it cannot prove: paid toward the weekly fees in the order they fall due, even when its week is booked at an earlier instant', async () => {
    const { subId, receiptNumber } = await riderCredit();
    const issuedAt = (await sys(() => app.prisma.feeReceipt.findUniqueOrThrow({ where: { receiptNumber } }))).issuedAt;
    const start = new Date('2026-10-12T04:00:00Z'); // Monday 12 Oct, midnight in Guyana
    // The checkout rail: the week's paidAt is the confirm instant, before the receipt row.
    await sys(() => app.prisma.subscriptionPayment.create({ data: {
      subscriptionId: subId, amount: 6000, status: 'CAPTURED', paymentMethod: 'CASH', externalRef: 'prepaid',
      periodStart: start, periodEnd: new Date(start.getTime() + 7 * DAY), paidAt: new Date(issuedAt.getTime() - 400),
    } }));
    // The next week, paid later from other money.
    await sys(() => app.prisma.subscriptionPayment.create({ data: {
      subscriptionId: subId, amount: 6000, status: 'CAPTURED', paymentMethod: 'CASH', externalRef: 'prepaid',
      periodStart: new Date(start.getTime() + 7 * DAY), periodEnd: new Date(start.getTime() + 14 * DAY), paidAt: new Date(issuedAt.getTime() + 7 * DAY),
    } }));
    const doc = (await sys(() => feeReceiptDocument(app.prisma, receiptNumber)))!;
    expect(doc.lines.filter((l) => /week covered|coming week/i.test(l))).toEqual([]);
    expect(doc.lines).toContain(PAID_TOWARD);
    expect('weekCovered' in doc).toBe(false);
  });

  it('the company TIN prints once the owner sets it, and never a malformed one', async () => {
    const { receiptNumber } = await riderCredit();
    await setConfig(COMPANY_TIN_KEY, 'not-a-tin');
    expect((await sys(() => feeReceiptDocument(app.prisma, receiptNumber)))!.lines.some((l) => l.startsWith('TIN'))).toBe(false);
    await setConfig(COMPANY_TIN_KEY, '010-123-456');
    const doc = (await sys(() => feeReceiptDocument(app.prisma, receiptNumber)))!;
    expect(doc.issuer.tin).toBe('010123456');
    expect(doc.lines[3]).toBe('TIN: 010123456');
  });

  it('a partner\'s weekly-fee screen lists its receipts, newest first', async () => {
    const { subId, receiptNumber } = await riderCredit();
    const list = await sys(() => feeReceiptsFor(app.prisma, subId));
    expect(list.map((d) => d.receiptNumber)).toEqual([receiptNumber]);
  });
});

describe('[R12 · security review] a receipt is read by number only inside the reader\'s own tenant', () => {
  // The admin route passes this scope (its tenant + the sibling routes'
  // subscription scope). Run with the database wall OFF, so the explicit
  // scope alone decides: another tenant's number reads as not found.
  const scope = (tenantId: string) => ({ tenantId, subscriptionWhere: { OR: [{ rider: { user: { tenantId } }, vendorId: null, driverId: null }] } });
  it('another tenant\'s receipt number reads as not found; the own tenant reads it', async () => {
    const { receiptNumber } = await riderCredit(4321);
    expect(await sys(() => feeReceiptDocument(app.prisma, receiptNumber, scope('tenant-elsewhere')))).toBeNull();
    expect((await sys(() => feeReceiptDocument(app.prisma, receiptNumber, scope('swift-default'))))?.receiptNumber).toBe(receiptNumber);
  });
});

describe('[R11] never a VAT line while Westbridge Inc. is not VAT-registered', () => {
  it('no line names VAT except "Not a VAT invoice"; a malformed or empty setting is still unregistered', async () => {
    const { receiptNumber } = await riderCredit();
    for (const value of [null, {}, { vatNumber: '' }, { vatNumber: 'pending' }, 'VAT123456']) {
      if (value === null) await clearConfig(VAT_REGISTRATION_KEY); else await setConfig(VAT_REGISTRATION_KEY, value);
      const doc = (await sys(() => feeReceiptDocument(app.prisma, receiptNumber)))!;
      expect(doc.vat, JSON.stringify(value)).toBeNull();
      expect(doc.lines.filter((l) => /\bVAT\b/.test(l)), JSON.stringify(value)).toEqual([NOT_A_VAT_INVOICE]);
    }
  });

  it('only the "VAT registered" setting with a VAT number turns the VAT line on: the number and the VAT the price includes', async () => {
    const { receiptNumber } = await riderCredit();
    await setConfig(VAT_REGISTRATION_KEY, { vatNumber: '1234 5678' });
    const doc = (await sys(() => feeReceiptDocument(app.prisma, receiptNumber)))!;
    expect(doc.vat).toEqual({ vatNumber: '12345678', rate: 0.14, included: 736.84 });
    expect(doc.lines).toContain('VAT registration number: 12345678');
    expect(doc.lines).toContain('Price includes VAT at 14%: GY$736.84');
    expect(doc.lines).not.toContain(NOT_A_VAT_INVOICE);
  });

  it('no fee screen, notice or receipt source prints VAT anywhere else', () => {
    // Every surface where a partner sees a fee amount. VAT may appear only in
    // fee-receipt.ts, behind the setting. (The admin-only VAT threshold watch
    // pages admins about registration, never a partner, and prints no tax.)
    const root = join(process.cwd(), '..');
    const billingDir = join(process.cwd(), 'src/modules/billing');
    const files = [
      ...readdirSync(billingDir).filter((f) => f.endsWith('.ts') && !['fee-receipt.ts', 'vat-tracker.ts'].includes(f)).map((f) => join(billingDir, f)),
      join(process.cwd(), 'src/modules/subscription/subscription.service.ts'),
      join(root, 'web/src/components/weekly-fee.tsx'),
      join(root, 'web/src/lib/weekly-fee.ts'),
      join(root, 'mobile/src/modules/billing/screens/WeeklyFeeScreen.tsx'),
      join(root, 'admin/src/app/mmg-payments/page.tsx'),
      join(root, 'admin/src/app/subscriptions/page.tsx'),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      // Text a person can see is in a string or JSX; comments may explain the rule.
      const visible = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/\bVAT\b|tax invoice/i.test(visible)) offenders.push(file.slice(root.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});
