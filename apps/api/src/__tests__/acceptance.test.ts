import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { VerificationService } from '../modules/verification/verification.service';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { OrderService } from '../modules/order/order.service';
import { CashRulesService } from '../modules/cash/cash-rules.service';
import { BillingService } from '../modules/billing/billing.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';

// ---------------------------------------------------------------------------
// Spec §I — acceptance conformance baseline. One file maps the 8 given/when/then
// scenarios to the LIVE engine, so a regression in any core rule fails CI.
//
//   All 8 scenarios are now LIVE assertions against the real engine: threshold
//   gate (#1), float gate (#2, D.3), ghost/no-show guarantee (#3/#4), verification
//   eligibility + insurance hard-fail + doc-expiry (#5/#6/#8), and dunning→suspend
//   (#7). They drive real cart/order/cash/billing fixtures (step7/step10/step5
//   patterns); a regression in any core rule fails this file in CI.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONES = ['+5920009811', '+5920009812', '+5920009813', '+5920009814', '+5920009815'];
const GY_MOVER_DOCS = ['national_id', 'police_clearance', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance'];
// Heavier cart/cash/billing fixtures (#1/#3/#4/#7) get their own phone block so
// purge() can sweep them without colliding with the verification PHONES above.
const HEAVY_PREFIX = '+59200099';
const GPS = { lat: 7.2, lng: -58.6 };
let heavySeq = 0;
const nextHeavyPhone = () => `${HEAVY_PREFIX}${String(++heavySeq).padStart(2, '0')}`;

let app: FastifyInstance;
let verification: VerificationService;
let cash: CashRulesService;
let vendorId: string;

async function purge() {
  const users = await app.prisma.user.findMany({
    where: { OR: [{ phone: { in: PHONES } }, { phone: { startsWith: HEAVY_PREFIX } }] },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const riders = await app.prisma.rider.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const riderIds = riders.map((r) => r.id);
  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: ids } }, { riderId: { in: riderIds } }] },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);
  await app.prisma.reimbursementClaim.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.strike.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.earning.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  // carts (+ their items) for these customers
  const carts = await app.prisma.cart.findMany({ where: { customerId: { in: ids } }, select: { id: true } });
  const cartIds = carts.map((c) => c.id);
  await app.prisma.cartItem.deleteMany({ where: { cartId: { in: cartIds } } });
  await app.prisma.cart.deleteMany({ where: { id: { in: cartIds } } });
  // vendors owned by these users → subscriptions + catalogue first, then the vendor
  const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  const ownerIds = owners.map((o) => o.id);
  const vendors = await app.prisma.vendor.findMany({ where: { ownerId: { in: ownerIds } }, select: { id: true } });
  const ownedVendorIds = vendors.map((v) => v.id);
  const subs = await app.prisma.subscription.findMany({ where: { vendorId: { in: ownedVendorIds } }, select: { id: true } });
  const subIds = subs.map((s) => s.id);
  await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: { in: subIds } } });
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: ownedVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: ownedVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: ownedVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } });
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeCustomerUser(trustLevel: 'L1' | 'L2' | 'L3' = 'L1') {
  return app.prisma.user.create({
    data: {
      phone: nextHeavyPhone(), firstName: 'Acc', lastName: 'Cust',
      roles: ['CUSTOMER' as UserRole], activeRole: 'CUSTOMER' as UserRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), countryCode: 'GY', trustLevel,
      customer: { create: {} },
    },
  });
}

async function makeRiderUser() {
  const u = await app.prisma.user.create({
    data: {
      phone: nextHeavyPhone(), firstName: 'Acc', lastName: 'Rider',
      roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole], activeRole: 'RIDER' as UserRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), countryCode: 'GY',
    },
  });
  const rider = await app.prisma.rider.create({
    data: {
      userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
      documentsVerified: true, isOnline: true, currentLat: GPS.lat, currentLng: GPS.lng,
    },
  });
  return { userId: u.id, riderId: rider.id };
}

async function makeArrivedCashOrder(customerId: string, riderId: string, amount: number) {
  return app.prisma.order.create({
    data: {
      orderNumber: `ACC-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId, vendorId, riderId, status: 'ARRIVED',
      deliveryAddress: '9 Acc Street, Georgetown', deliveryLat: 6.80451, deliveryLng: -58.15532,
      pickupLat: GPS.lat, pickupLng: GPS.lng, pickupAddress: 'Vendor corner',
      subtotalBase: amount, subtotalMarkup: 0, subtotalCustomer: amount,
      deliveryFee: 500, totalAmount: amount, paymentMethod: 'CASH',
    },
  });
}

async function makeUser(phone: string) {
  return app.prisma.user.create({
    data: {
      phone,
      firstName: 'Acc',
      lastName: 'Test',
      roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole],
      activeRole: 'RIDER' as UserRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      countryCode: 'GY',
    },
  });
}

async function approveDoc(userId: string, docType: string, extra: Record<string, unknown> = {}) {
  return app.prisma.verificationDocument.create({
    data: {
      userId,
      role: 'RIDER' as UserRole,
      docType,
      fileUrl: `key-${nanoid(8)}`,
      status: 'APPROVED',
      ...extra,
    },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();

  verification = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
  await purge();

  // Cash/checkout engine + a shared ACTIVE vendor for the heavier scenarios (#1/#3/#4).
  const orders = new OrderService(app.prisma, app.io);
  cash = new CashRulesService(app.prisma, new NotificationService(app.prisma, app.io), orders);
  const ownerUser = await app.prisma.user.create({
    data: {
      phone: nextHeavyPhone(), firstName: 'Acc', lastName: 'Owner',
      roles: ['VENDOR_OWNER' as UserRole], activeRole: 'VENDOR_OWNER' as UserRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), countryCode: 'GY',
    },
  });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Acc Corner', slug: `acc-corner-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: nextHeavyPhone(),
      addressLine1: '1 Acc Corner', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: GPS.lat, longitude: GPS.lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  await purge();
  await app.close();
});

describe('Spec §I — acceptance conformance baseline', () => {
  // 1. Threshold gate — OrderService.checkout blocks an L1 cart at/over the gate.
  it('1. an L1 customer over the ID threshold is blocked at checkout (ID_VERIFICATION_REQUIRED)', async () => {
    const category = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
    const item = await app.prisma.item.create({
      data: { vendorId, categoryId: category.id, name: 'Big Combo', basePrice: 60000 }, // well over the ~$50 (GYD) gate
    });
    const customer = await makeCustomerUser('L1');
    await app.prisma.cart.create({
      data: { customerId: customer.id, vendorId, items: { create: { itemId: item.id, quantity: 1, selectedOptions: {} } } },
    });
    const orders = new OrderService(app.prisma, app.io);
    await expect(
      orders.checkout({ userId: customer.id, paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' }, now: new Date() }),
    ).rejects.toMatchObject({ code: 'ID_VERIFICATION_REQUIRED' });
  });

  // 2. Float gate — D.3, now LIVE. A rider without enough free float to front the
  //    order's vendor-cash must not be a dispatch candidate; a funded rider must be.
  it('2. a rider whose availableFloat < the order cash is excluded from dispatch; a funded rider is included', async () => {
    const pickup = { lat: 6.8013, lng: -58.1551 };
    const mkRider = async (phone: string, floatLimit: number, committedFloat: number) => {
      const u = await makeUser(phone);
      return app.prisma.rider.create({
        data: {
          userId: u.id,
          riderType: 'BOTH',
          vehicleType: 'MOTORCYCLE',
          isOnline: true,
          isAvailable: true,
          currentLat: pickup.lat,
          currentLng: pickup.lng,
          floatLimit,
          committedFloat,
        },
      });
    };
    const low = await mkRider(PHONES[3]!, 8000, 7000); // availableFloat = 1000
    const funded = await mkRider(PHONES[4]!, 8000, 0); // availableFloat = 8000

    // findCandidates only calls maps.etaMinutes — a tiny stub suffices.
    const maps = { etaMinutes: async (_p: unknown, pts: unknown[]) => pts.map(() => 5) };
    const dispatch = new DispatchService(
      app.prisma,
      app.redis,
      app.io,
      maps as unknown as ConstructorParameters<typeof DispatchService>[3],
    );

    // CASH order needs 5000 fronted: low rider (1000 free) excluded, funded rider (8000) in.
    const candidates = await dispatch.findCandidates(`acc-${nanoid(6)}`, pickup, 10, 'RIDER', 5000);
    const ids = candidates.map((c) => c.riderId);
    expect(ids).toContain(funded.id);
    expect(ids).not.toContain(low.id);
  });

  // 3 & 4. Ghost / no-show — cashRules.handover on an ARRIVED CASH order.
  it('3. a sub-threshold no-show → guarantee auto-approves the rider + customer is struck', async () => {
    const customer = await makeCustomerUser('L1');
    const rider = await makeRiderUser();
    const order = await makeArrivedCashOrder(customer.id, rider.riderId, 3500); // under the ~$50 gate
    const result = await cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: GPS });
    expect(result.claim?.status).toBe('AUTO_APPROVED');
    const strike = await app.prisma.strike.findFirst({ where: { orderId: order.id } });
    expect(strike).not.toBeNull();
  });

  it('4. an over-threshold no-show → claim is NOT auto-covered (withheld), customer still struck', async () => {
    const customer = await makeCustomerUser('L2');
    const rider = await makeRiderUser();
    const order = await makeArrivedCashOrder(customer.id, rider.riderId, 20000); // over the gate
    const result = await cash.handover(order.id, rider.userId, { outcome: 'no_show', gps: GPS });
    expect(result.claim).toBeNull();
    const strike = await app.prisma.strike.findFirst({ where: { orderId: order.id } });
    expect(strike).not.toBeNull();
  });

  // 5. Verification eligibility — REAL
  it('5. a mover with the full approved checklist is allowed to operate', async () => {
    const u = await makeUser(PHONES[0]!);
    for (const docType of GY_MOVER_DOCS) await approveDoc(u.id, docType);
    const status = await verification.getLiveOperationStatus(u.id, { vehicleType: 'MOTORCYCLE' });
    expect(status.allowed).toBe(true);
    expect(status.reason).toBe('ok');
  });

  // 6. Insurance-class hard-fail — REAL
  it('6. a taxi driver without HIRE-class confirmed insurance is blocked with reason "insurance"', async () => {
    const u = await makeUser(PHONES[1]!);
    // legacyVerified bypasses the base checklist so we isolate the taxi insurance gate;
    // an APPROVED vehicle_insurance with no confirmed HIRE class must still hard-fail.
    await approveDoc(u.id, 'vehicle_insurance');
    const status = await verification.getLiveOperationStatus(u.id, { vehicleType: 'CAR', legacyVerified: true });
    expect(status.allowed).toBe(false);
    expect(status.reason).toBe('insurance');
  });

  // 7. Subscription lapse → delist. Three failed CASH charges (prepaid 0) suspend
  //    the vendor: status SUSPENDED + acceptingOrders false (vanishes from browse).
  it('7. a merchant failing dunning is auto-suspended and delisted', async () => {
    const ownerUser = await app.prisma.user.create({
      data: {
        phone: nextHeavyPhone(), firstName: 'Acc', lastName: 'Dun',
        roles: ['VENDOR_OWNER' as UserRole], activeRole: 'VENDOR_OWNER' as UserRole,
        isPhoneVerified: true, selfieCapturedAt: new Date(), countryCode: 'GY',
      },
    });
    const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
    const vnd = await app.prisma.vendor.create({
      data: {
        ownerId: vo.id, name: 'Dunning Diner', slug: `dun-${nanoid(6)}`,
        vendorType: 'RESTAURANT', phone: nextHeavyPhone(),
        addressLine1: '2 Due Street', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: GPS.lat, longitude: GPS.lng,
        status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      },
    });
    const due = new Date();
    const sub0 = await app.prisma.subscription.create({
      data: {
        vendorId: vnd.id, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 20000,
        billingMethod: 'CASH', autoRenew: true, autoSuspendEnabled: true,
        currentPeriodStart: new Date(due.getTime() - 7 * DAY), currentPeriodEnd: due,
        nextBillingDate: due, prepaidBalance: { create: { balance: 0 } },
      },
    });
    const billing = new BillingService(app.prisma, new NotificationService(app.prisma, app.io), getPaymentProvider());
    const withRel = (id: string) => app.prisma.subscription.findUniqueOrThrow({
      where: { id },
      include: {
        rider: { select: { userId: true } },
        driver: { select: { userId: true } },
        vendor: { select: { id: true, owner: { select: { userId: true } } } },
      },
    });

    // Three failed charges (MAX_FAILED_ATTEMPTS) — advance a day between retries.
    let now = due;
    for (let i = 0; i < 3; i++) {
      await billing.billSubscription(await withRel(sub0.id), now);
      now = new Date(now.getTime() + DAY);
    }

    const after = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vnd.id } });
    expect(after.status).toBe('SUSPENDED');
    expect(after.acceptingOrders).toBe(false);
    const sub = await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub0.id } });
    expect(sub.status).toBe('SUSPENDED');
  });

  // 8. Doc-expiry auto-suspend — REAL
  it('8. an expired approved document is auto-flipped to EXPIRED by the sweep', async () => {
    const u = await makeUser(PHONES[2]!);
    const doc = await approveDoc(u.id, 'drivers_licence', { expiresAt: new Date(Date.now() - DAY) });
    const count = await verification.expireLapsedDocuments();
    expect(count).toBeGreaterThanOrEqual(1);
    const after = await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.status).toBe('EXPIRED');
  });
});
