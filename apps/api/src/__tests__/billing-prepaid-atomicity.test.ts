import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';

// ---------------------------------------------------------------------------
// [PAY-1 Movement 0 · S0] MONEY AND THE WEEK IT BUYS SHARE ONE FATE.
//
// attemptCharge() used to spend a payer's prepaid balance in its own standalone
// write and then return, leaving the advance — the payment row, the period move,
// the audit event and the balanced ledger posting — to a SEPARATE transaction
// further down. Everything in that second transaction was carefully made atomic.
// The money was not in it.
//
// So any failure between the two spent a vendor's credit and granted no week:
// balance gone, period unmoved, and no ledger entry to find the money by. For a
// prepaid vendor that is indistinguishable from Swift quietly pocketing a week's
// fee, and the only way they'd know is by noticing their own balance.
//
// The fix moves the debit inside the advance transaction. This proves it: force
// a REALISTIC failure late in that transaction — a racing settler that already
// wrote the CHARGE_SUCCESS event, so the unique idempotency key rejects ours —
// and assert the balance is exactly as it started.
//
// Run this against the pre-fix code and it fails: the balance comes back short
// by one week's fee.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let billing: BillingService;
const subIds: string[] = [];
const vendorIds: string[] = [];
const ownerUserIds: string[] = [];

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();

  billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
});

afterAll(async () => {
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ownerUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ownerUserIds } } });
  await app.close();
});

let seq = 0;
async function makePrepaidVendorSub(opts: { rate: number; prepaid: number; due: Date }) {
  seq += 1;
  const owner = await app.prisma.user.create({
    data: {
      phone: `+59200943${String(seq).padStart(2, '0')}`,
      firstName: 'Atomic', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  ownerUserIds.push(owner.id);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Atomic Diner ${seq}`, slug: `atomic-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: '+5920094300', addressLine1: '1 St',
      city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status: 'ACTIVE',
      weeklyRate: opts.rate, billingMethod: 'CASH',
      currentPeriodStart: new Date(opts.due.getTime() - 7 * DAY),
      currentPeriodEnd: opts.due,
      nextBillingDate: opts.due,
      prepaidBalance: { create: { balance: opts.prepaid } },
    },
  });
  subIds.push(sub.id);
  return sub.id;
}

const balanceOf = async (subId: string) =>
  Number((await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: subId } })).balance);

describe('prepaid spend is atomic with the week it buys [PAY-1 M0 S0]', () => {
  it('a failure during the advance leaves the payer’s balance untouched', async () => {
    const due = new Date(Date.now() - 60_000); // due a minute ago, so it bills now
    const subId = await makePrepaidVendorSub({ rate: 10_000, prepaid: 25_000, due });
    expect(await balanceOf(subId)).toBe(25_000);

    // A racing settler got there first and already wrote this period's success
    // event. Our advance will hit the unique idempotencyKey and blow up — late,
    // AFTER the point where the balance used to have already been spent.
    const periodKey = due.toISOString().slice(0, 10);
    await app.prisma.billingEvent.create({
      data: {
        subscriptionId: subId, type: 'CHARGE_SUCCESS', amount: 10_000,
        currencyCode: 'GYD', idempotencyKey: `success:${subId}:${periodKey}`,
        paymentRef: 'racing-settler',
      },
    });

    const sub = await app.prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
      include: { vendor: { include: { owner: true } }, rider: true, driver: true },
    });

    await billing.billSubscription(sub as never, new Date()).catch(() => 'threw');

    // THE ASSERTION. Not one dollar moved, because the week never landed.
    expect(await balanceOf(subId)).toBe(25_000);
  });

  it('the ordinary path still spends exactly one week’s fee', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makePrepaidVendorSub({ rate: 10_000, prepaid: 25_000, due });

    const sub = await app.prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
      include: { vendor: { include: { owner: true } }, rider: true, driver: true },
    });
    const outcome = await billing.billSubscription(sub as never, new Date());

    expect(outcome).toBe('succeeded');
    // Debited once, and only once — the fix must not double-spend either.
    expect(await balanceOf(subId)).toBe(15_000);

    const fresh = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    expect(fresh.status).toBe('ACTIVE');
    expect(fresh.nextBillingDate.getTime()).toBeGreaterThan(due.getTime());
  });

  it('an insufficient balance is left alone — a partial debit is never taken', async () => {
    const due = new Date(Date.now() - 60_000);
    const subId = await makePrepaidVendorSub({ rate: 10_000, prepaid: 4_000, due });

    const sub = await app.prisma.subscription.findUniqueOrThrow({
      where: { id: subId },
      include: { vendor: { include: { owner: true } }, rider: true, driver: true },
    });
    await billing.billSubscription(sub as never, new Date()).catch(() => 'threw');

    // PINV-7's shape: money that cannot buy a whole week buys none of it, and
    // stays entirely with the payer.
    expect(await balanceOf(subId)).toBe(4_000);
  });
});
