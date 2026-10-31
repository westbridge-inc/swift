import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { runWithoutTenant } from '../plugins/tenant-context';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { rateLimitKey } from '../utils/rate-limit-key';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { statementMonth } from '../modules/billing/chain-statement';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';

// ---------------------------------------------------------------------------
// [ENTERPRISE E3 · owner 29 Oct 2026] The chain fee statement: one owner, one
// Guyana calendar month, every branch with its weekly fee and deal, the weeks
// it paid in the month, what it owes now and the receipts issued, labelled
// "Not a VAT invoice". Read from the ledger, against the real database and the
// real vendor routes. Only the owner sees it.
// ---------------------------------------------------------------------------

const DAY = 86_400_000;
let app: FastifyInstance;
const RUN = wordFreeTag(8);
const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
const eventIds: string[] = [];

type Actor = { userId: string; token: string };
const isolated = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'chain-statement-isolation');
async function makeUser(): Promise<Actor> {
  const user = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Royal', lastName: `Head${RUN}`, email: `head-${nanoid(6).toLowerCase()}@example.test`,
    roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `stmt-${nanoid(4)}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

/** Guyana month boundaries for the month `at` falls in, as the statement reads them. */
const monthOf = (at: Date) => statementMonth(undefined, at);

async function chain() {
  const owner = await makeUser();
  const ownerRow = await app.prisma.vendorOwner.create({ data: {
    userId: owner.userId, dealWeeklyRate: 14000, dealCurrencyCode: 'GYD', dealSetAt: new Date(), dealSetBy: 'test-admin', dealReason: 'test deal' } });
  const { from } = monthOf(new Date());
  const make = async (name: string, sub: { weeklyRate: number; customRate: number | null; status: 'ACTIVE' | 'PAST_DUE'; next: Date }) => {
    const vendor = await app.prisma.vendor.create({ data: {
      ownerId: ownerRow.id, name, slug: `stmt-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: testPhone(),
      addressLine1: '1 Statement Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true } });
    vendorIds.push(vendor.id);
    const row = await app.prisma.subscription.create({ data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: sub.status, weeklyRate: sub.weeklyRate, customRate: sub.customRate, currencyCode: 'GYD',
      billingMethod: 'CASH', currentPeriodStart: new Date(sub.next.getTime() - 7 * DAY), currentPeriodEnd: sub.next, nextBillingDate: sub.next,
      prepaidBalance: { create: { balance: 0, currencyCode: 'GYD' } } } });
    subIds.push(row.id);
    return { vendorId: vendor.id, subId: row.id };
  };
  const north = await make(`A North ${RUN}`, { weeklyRate: 20000, customRate: 14000, status: 'ACTIVE', next: new Date(Date.now() + 3 * DAY) });
  const camp = await make(`B Camp ${RUN}`, { weeklyRate: 12000, customRate: null, status: 'PAST_DUE', next: new Date(Date.now() - DAY) });
  // North paid a week inside the month (and one before it, which the month's statement leaves out), and has a receipt.
  const week = (subscriptionId: string, start: Date, amount: number, status: 'CAPTURED' | 'FAILED' = 'CAPTURED') => app.prisma.subscriptionPayment.create({ data: {
    subscriptionId, amount, status, paymentMethod: 'CASH', periodStart: start, periodEnd: new Date(start.getTime() + 7 * DAY), paidAt: start } });
  await week(north.subId, new Date(from.getTime() + DAY), 14000);
  await week(north.subId, new Date(from.getTime() - 3 * DAY), 14000);
  // [REVIEW-F #2228 S3-1] North's week starting on the month's last day, paid only after the month: it is a paid week
  // STARTING this month, listed here. A week paid inside the month that starts next month is not (its receipt is).
  const { to } = monthOf(new Date());
  await app.prisma.subscriptionPayment.create({ data: {
    subscriptionId: north.subId, amount: 14000, status: 'CAPTURED', paymentMethod: 'CASH', periodStart: new Date(to.getTime() - DAY), periodEnd: new Date(to.getTime() + 6 * DAY), paidAt: new Date(to.getTime() + 2 * DAY) } });
  await app.prisma.subscriptionPayment.create({ data: {
    subscriptionId: north.subId, amount: 14000, status: 'CAPTURED', paymentMethod: 'CASH', periodStart: to, periodEnd: new Date(to.getTime() + 7 * DAY), paidAt: new Date(to.getTime() - DAY) } });
  // Camp's charge in the month failed: an unpaid week is never listed as paid (it shows as owed now).
  await week(camp.subId, new Date(from.getTime() + DAY), 12000, 'FAILED');
  const ev = await app.prisma.billingEvent.create({ data: { subscriptionId: north.subId, type: 'PREPAID_TOPUP', amount: 14000, currencyCode: 'GYD', idempotencyKey: `stmt:${nanoid(10)}` } });
  eventIds.push(ev.id);
  await app.prisma.feeReceipt.create({ data: {
    receiptNumber: `SWF-STMT-${RUN}-${nanoid(6)}`, subscriptionId: north.subId, billingEventId: ev.id, amount: 14000, channel: 'MMG_CHECKOUT', issuedAt: new Date(from.getTime() + DAY) } });
  return { ...owner, ownerId: ownerRow.id, north, camp };
}

const statementOf = (actor: Actor, vendorId: string, month?: string) => isolated(() => app.inject({
  method: 'GET', url: `/api/v1/vendor/subscription/chain-statement${month ? `?month=${month}` : ''}`,
  headers: { authorization: `Bearer ${actor.token}`, 'x-vendor-id': vendorId },
}));

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute', keyGenerator: rateLimitKey((token) => app.jwt.verify(token)) });
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
});

afterAll(async () => {
  await isolated(async () => {
    await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.vendorStaff.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await app.close();
});

describe('[E3] the chain fee statement', () => {
  it('names the issuer and the owner, every branch with its fee and deal, the weeks paid in the month, what is owed now, the receipts; "Not a VAT invoice"', async () => {
    const c = await chain();
    const res = await statementOf(c, c.north.vendorId);
    expect(res.statusCode, res.body).toBe(200);
    const s = res.json().data;
    expect(s.vatNote).toBe('Not a VAT invoice');
    expect(s.issuer).toMatchObject({ name: expect.any(String), tradingAs: expect.any(String), registrationNo: expect.any(String) });
    expect(s.billedTo.name).toBe(`Royal Head${RUN}`);
    expect(s.deal).toEqual({ weeklyRate: 14000, currencyCode: 'GYD' });
    const [north, camp] = s.branches;
    expect(north).toMatchObject({ branchName: `A North ${RUN}`, weeklyFee: 14000, feeWaived: false, dealWeeklyRate: 14000, owedNow: null, weeksTotal: 28000, receiptsTotal: 14000 });
    // The week starting inside the month (paid then) and the one starting on its last day (paid after it); never the
    // week paid inside the month that starts next month, nor the one that started before the month.
    expect(north.weeks).toHaveLength(2);
    expect(north.weeks.every((w: { periodStart: string }) => w.periodStart >= s.from && w.periodStart < s.to)).toBe(true);
    expect(north.receipts[0]).toMatchObject({ amount: 14000, channel: 'MMG_CHECKOUT' });
    expect(camp).toMatchObject({ branchName: `B Camp ${RUN}`, weeklyFee: 12000, dealWeeklyRate: null, weeks: [], receipts: [] });
    expect(camp.owedNow).toMatchObject({ amount: 12000 });
    expect(s.totals).toEqual({ weeksCharged: 28000, received: 14000, owedNow: 12000 });
  });

  // [REVIEW-G note on #2228] The receipts are the chosen month's only: one issued in the last millisecond before the
  // month, or at the first millisecond of the next (the bound is exclusive), is never on this month's statement; one
  // in the month's last millisecond is. Each figure is its own amount, so the total names exactly which ones counted.
  // [REVIEW-G S4 on #2239] One issued at exactly `from` (Guyana midnight on the 1st: the lower bound is INCLUSIVE) is
  // this month's, and never the previous month's.
  it('receipts are limited to the chosen month: one from the month before or the month after is left out', async () => {
    const c = await chain();
    const { from, to } = monthOf(new Date());
    const receipt = async (issuedAt: Date, amount: number) => {
      const ev = await app.prisma.billingEvent.create({ data: { subscriptionId: c.north.subId, type: 'PREPAID_TOPUP', amount, currencyCode: 'GYD', idempotencyKey: `stmt:${nanoid(10)}` } });
      eventIds.push(ev.id);
      await app.prisma.feeReceipt.create({ data: {
        receiptNumber: `SWF-STMT-${RUN}-${nanoid(6)}`, subscriptionId: c.north.subId, billingEventId: ev.id, amount, channel: 'MMG_CHECKOUT', issuedAt } });
    };
    await receipt(new Date(from.getTime() - 1), 1111); // the previous month's last millisecond
    await receipt(new Date(from.getTime() - 20 * DAY), 2222); // well inside the previous month
    await receipt(to, 3333); // the next month's first millisecond
    await receipt(new Date(to.getTime() + 20 * DAY), 4444); // well inside the next month
    await receipt(new Date(to.getTime() - 1), 5555); // this month's last millisecond: in
    await receipt(from, 6666); // this month's first millisecond (Guyana midnight on the 1st): in

    const s = (await statementOf(c, c.north.vendorId)).json().data;
    const north = s.branches.find((b: { branchName: string }) => b.branchName === `A North ${RUN}`);
    expect(north.receipts.map((r: { amount: number }) => r.amount)).toEqual([6666, 14000, 5555]);
    expect(north.receipts.every((r: { issuedAt: string }) => r.issuedAt >= s.from && r.issuedAt < s.to)).toBe(true);
    expect(north.receiptsTotal).toBe(26221);
    expect(s.totals.received).toBe(26221);

    // The previous month's statement holds the two from before this month, and nothing from this one (not 6666).
    const prev = new Date(from.getTime() - DAY);
    const prevMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
    if (prevMonth >= '2026-01') {
      const p = (await statementOf(c, c.north.vendorId, prevMonth)).json().data;
      const pn = p.branches.find((b: { branchName: string }) => b.branchName === `A North ${RUN}`);
      expect(pn.receipts.map((r: { amount: number }) => r.amount)).toEqual([2222, 1111]);
    }
  });

  it('a month asked for that is malformed, in the future or before fees existed is refused', async () => {
    const c = await chain();
    for (const bad of ['2026-13', '26-10', '2099-01', '2025-12']) {
      const res = await statementOf(c, c.north.vendorId, bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json().error.code).toBe('STATEMENT_MONTH_INVALID');
    }
  });

  it('only the owner: a manager of a branch never sees the owner statement', async () => {
    const c = await chain();
    const manager = await makeUser();
    await app.prisma.vendorStaff.create({ data: { vendorId: c.north.vendorId, userId: manager.userId, role: 'MANAGER', invitedBy: c.userId } });
    expect((await statementOf(manager, c.north.vendorId)).statusCode).toBe(403);
  });

  it('month boundaries are Guyana midnight (04:00 UTC)', () => {
    const { from, to } = statementMonth('2026-10', new Date('2026-10-29T12:00:00Z'));
    expect(from.toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(to.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    const dec = statementMonth('2026-12', new Date('2027-01-05T12:00:00Z'));
    expect(dec.to.toISOString()).toBe('2027-01-01T04:00:00.000Z');
  });
});
