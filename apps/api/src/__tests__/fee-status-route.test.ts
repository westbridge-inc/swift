import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { testPhone } from './helpers/fixture-ids';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import { beginConfirmationInTx } from '../modules/billing/dunning-clock';

// [FEE-STATUS · owner 25 Oct 2026] The store's Weekly fee screen said "Nothing due
// right now: your next bill is 13 Oct 2026" on 25 October. GET /subscription now
// carries the server's own words for the fee (billing/fee-status.ts), so no app
// works a passed date into a "next bill" again.

let app: FastifyInstance;
const userIds: string[] = [];
const vendorIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let subscriptionId = '';
const DAY = 86_400_000;
const authed = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  // The owner's case: the paid week ended 11 days ago and nothing moved the row on.
  const store = await makeStore('Fee Status Test Store', new Date(Date.now() - 11 * DAY));
  vendorToken = store.token; vendorId = store.vendorId; subscriptionId = store.subscriptionId;
});

/** A store owner with a session, a store and its weekly-fee subscription due at `due`. */
async function makeStore(name: string, due: Date) {
  const owner = await app.prisma.user.create({
    data: {
      phone: testPhone(), firstName: 'Fee', lastName: 'Status',
      roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  userIds.push(owner.id);
  const token = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: owner.id, token, refreshToken: nanoid(48),
      deviceId: 'fee-status', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name, slug: `fee-status-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: '+5920094200', addressLine1: '1 Test Street',
      city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 15_000, currencyCode: 'GYD',
      currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due, nextBillingDate: due,
    },
  });
  return { token, vendorId: vendor.id, subscriptionId: sub.id };
}

afterAll(async () => {
  const subs = (await app.prisma.subscription.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } })).map((s) => s.id);
  await cleanupBillingClocks(app.prisma, subs);
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subs } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subs } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subs } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

type Payload = { data: { feeStatus?: { state: string; headline: string; detail: string | null; date: string | null }; amountDueGyd: number } };
const read = async (token = vendorToken) => {
  const res = await app.inject({ method: 'GET', url: '/api/v1/vendor/subscription', headers: authed(token) });
  expect(res.statusCode).toBe(200);
  return (res.json() as Payload).data;
};

describe('GET /vendor/subscription feeStatus [FEE-STATUS]', () => {
  it('a week past its date with nothing received: "Payment due since <date>", never a next bill', async () => {
    const data = await read();
    expect(data.feeStatus?.state).toBe('DUE');
    expect(data.feeStatus?.headline).toMatch(/^Payment due since \d{1,2} [A-Z][a-z]{2,3} \d{4}$/);
    expect(data.feeStatus?.detail).toBe('GY$15,000 to pay.');
  });

  it('the owner\'s store: money already received pays the week, said with the week\'s own date', async () => {
    await app.prisma.prepaidBalance.create({ data: { subscriptionId, balance: 30_000, currencyCode: 'GYD' } });
    const data = await read();
    expect(data.amountDueGyd).toBe(0);
    expect(data.feeStatus?.state).toBe('COVERED');
    expect(data.feeStatus?.headline).toMatch(/^Week from .+ already paid$/);
    expect(JSON.stringify(data.feeStatus)).not.toMatch(/next bill|active until|nothing due/i);
  });

  it('a date still ahead is only the next fee\'s, until a captured payment proves the week: then "Paid until <date>"', async () => {
    const ahead = new Date(Date.now() + 3 * DAY);
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId } });
    await app.prisma.subscription.update({ where: { id: subscriptionId }, data: { nextBillingDate: ahead, currentPeriodEnd: ahead } });
    const unproven = await read();
    expect(unproven.feeStatus?.state).toBe('UPCOMING');
    expect(unproven.feeStatus?.headline).toMatch(/^Next weekly fee due on /);
    expect(JSON.stringify(unproven.feeStatus)).not.toMatch(/paid/i);
    // A waived week is booked as a captured 0: it proves nothing was paid.
    await app.prisma.subscriptionPayment.create({ data: { subscriptionId, amount: 0, status: 'CAPTURED', paymentMethod: 'CASH',
      periodStart: new Date(ahead.getTime() - 7 * DAY), periodEnd: ahead, paidAt: new Date() } });
    expect((await read()).feeStatus?.state).toBe('UPCOMING');
    await app.prisma.subscriptionPayment.create({ data: { subscriptionId, amount: 15_000, status: 'CAPTURED', paymentMethod: 'CASH',
      periodStart: new Date(ahead.getTime() - 7 * DAY), periodEnd: ahead, paidAt: new Date() } });
    const paid = await read();
    expect(paid.feeStatus?.state).toBe('PAID');
    expect(paid.feeStatus?.headline).toMatch(/^Paid until /);
  });

  it("[REVIEW-G2 S4] one partner's fee never shows another partner's payment under a check", async () => {
    const other = await makeStore('Other Fee Status Store', new Date(Date.now() - 2 * DAY));
    const began = new Date(Date.now() - 3 * DAY);
    await app.prisma.$transaction(async (tx) => {
      const payment = await tx.subscriptionPayment.create({ data: { subscriptionId: other.subscriptionId, amount: 9_876, status: 'UNKNOWN',
        paymentMethod: 'MOBILE_MONEY', periodStart: new Date(Date.now() - 2 * DAY), periodEnd: new Date(Date.now() + 5 * DAY) } });
      await beginConfirmationInTx(tx, other.subscriptionId, { paymentId: payment.id }, 'TEST_PAYMENT_UNCONFIRMED', began);
    });
    // The other store is under the check, in its own words (the fixture is real).
    expect((await read(other.token)).feeStatus?.headline).toMatch(/^Checking your payment of GY\$9,876 \(began /);
    // This store is not, and never names the other's amount or day.
    const mine = await read();
    expect(mine.feeStatus?.state).not.toBe('CHECKING');
    expect(JSON.stringify(mine.feeStatus)).not.toMatch(/9,876|Checking/);
  });
});

describe('every partner family sends feeStatus [FEE-STATUS]', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), 'src/modules', p), 'utf8');
  it.each(['vendor/vendor.routes.ts', 'rider/rider.routes.ts', 'driver/driver.routes.ts'])('%s GET /subscription spreads feeStatus from the same payInfo it sends', (file) => {
    const route = src(file).split("'/subscription'")[1]!.split('app.put(')[0]!;
    expect(route).toMatch(/const fee = await payInfo\(app\.prisma, (?:subscription|sub)\)/);
    expect(route).toMatch(/\.\.\.fee,/);
    expect(route).toMatch(/feeStatus: await feeStatusFor\(app\.prisma, (?:subscription|sub), fee/);
  });
});
