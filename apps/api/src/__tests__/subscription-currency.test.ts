import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { BillingService } from '../modules/billing/billing.service';
import { SubscriptionService } from '../modules/subscription/subscription.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { getMmgProvider, sandboxResetMmg } from '../providers/mmg/mmg-provider';

// ---------------------------------------------------------------------------
// G2-F1 — a partner subscription is born in the country's ISO-4217 currency
// ("GYD"), never its COUNTRY code ("GY"). The bug wrote "GY" onto the
// subscription, and every billing event, the prepaid wallet and the MMG
// merchant request inherited it. These tests drive the REAL trial/activation
// path and assert the durable rows — not just what the service returned.
// Phone prefix +5920371 is unique to this file (grep-verified; +592036 is
// taken elsewhere and +59204 is reserved for staging).
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;

let app: FastifyInstance;
let billing: BillingService;

const userIds: string[] = [];
const vendorIds: string[] = [];
const subIds: string[] = [];
let seq = 0;

const phoneFor = (offset = 0) => `+5920371${String(seq + offset).padStart(4, '0')}`;

async function makeBareVendor() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: phoneFor(),
      firstName: 'G2F1',
      lastName: `CurrencyVendor${seq}`,
      roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[],
      activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
    },
  });
  userIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `G2F1 Currency Vendor ${seq}`,
      slug: `g2f1-currency-vendor-${seq}-${nanoid(4).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: phoneFor(1000),
      addressLine1: '1 Currency Street',
      city: 'Georgetown',
      region: 'Demerara-Mahaica',
      latitude: 6.8,
      longitude: -58.15,
      status: 'PENDING_APPROVAL',
    },
  });
  vendorIds.push(vendor.id);
  return vendor.id;
}

/** A trial subscription on the MMG rail, already due — the shape the hourly
 *  billing cycle charges after the 14 days elapse. */
async function dueMmgSubscription(subId: string) {
  const due = new Date(Date.now() - HOUR);
  await app.prisma.subscription.update({
    where: { id: subId },
    data: {
      status: 'ACTIVE',
      isTrialActive: false,
      trialEndDate: due,
      nextBillingDate: due,
      billingMethod: 'MOBILE_MONEY',
      mmgPayerMsisdn: `60993${String(seq).padStart(4, '0')}`,
    },
  });
  return app.prisma.subscription.findUniqueOrThrow({
    where: { id: subId },
    include: {
      rider: { select: { userId: true } },
      driver: { select: { userId: true } },
      vendor: { select: { id: true, owner: { select: { userId: true } } } },
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['MMG_DRIVER']; // sandbox

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();

  billing = new BillingService(
    app.prisma,
    new NotificationService(app.prisma, app.io),
    getPaymentProvider(),
  );
});

afterAll(async () => {
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  sandboxResetMmg();
  await app.close();
});

describe('G2-F1 — the weekly fee is billed in the country ISO currency, not its country code', () => {
  it('activates a store through the real trial path with currencyCode GYD on the subscription row', async () => {
    const subscriptions = new SubscriptionService(app.prisma);
    const vendorId = await makeBareVendor();
    const sub = await subscriptions.startTrialForVendor(vendorId);
    subIds.push(sub.id);

    const row = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(row.currencyCode).toBe('GYD');
  });

  it('stamps the weekly CHARGE_ATTEMPT event and the MMG merchant request in GYD', async () => {
    const subscriptions = new SubscriptionService(app.prisma);
    const born = await subscriptions.startTrialForVendor(await makeBareVendor());
    subIds.push(born.id);

    const sub = await dueMmgSubscription(born.id);
    const outcome = await billing.billSubscription(sub);
    expect(outcome).toBe('pending');

    const periodKey = sub.nextBillingDate.toISOString().slice(0, 10);
    const attempt = await app.prisma.billingEvent.findUniqueOrThrow({
      where: { idempotencyKey: `charge:${sub.id}:${periodKey}:a0` },
    });
    expect(attempt.currencyCode).toBe('GYD');

    // The sandbox provider echoes back exactly the currencyCode the billing
    // service put on the merchant-initiated request body.
    const intent = await app.prisma.subscriptionPayment.findUniqueOrThrow({
      where: { clientKey: `sub:${sub.id}:${periodKey}:a0` },
    });
    const lookup = await getMmgProvider().transactionLookup({ transactionId: intent.externalRef! });
    expect(lookup.currencyCode).toBe('GYD');
  });

  it('stamps the prepaid wallet and its top-up event in GYD', async () => {
    const subscriptions = new SubscriptionService(app.prisma);
    const born = await subscriptions.startTrialForVendor(await makeBareVendor());
    subIds.push(born.id);

    await billing.recordTopUp(
      born.id,
      5000,
      'g2f1-test-admin',
      `g2f1-ref-${nanoid(8)}`,
      `g2f1-topup-key-${nanoid(20)}`,
    );

    const wallet = await app.prisma.prepaidBalance.findUniqueOrThrow({ where: { subscriptionId: born.id } });
    expect(wallet.currencyCode).toBe('GYD');

    const topupEvent = await app.prisma.billingEvent.findFirst({
      where: { subscriptionId: born.id, type: 'PREPAID_TOPUP' },
    });
    expect(topupEvent?.currencyCode).toBe('GYD');
  });
});
