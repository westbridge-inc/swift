import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, beginRequestTenantContext, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { NotificationService, notifyAdmins } from '../modules/notification/notification.service';
import { luhnCheckDigit } from '../modules/billing/san';
import { loginWithOtp } from './helpers/otp';
import { syntheticLocationOwner } from './helpers/online-mover';

// HTTP proof for the arbitrary-id admin path in SPS-F-0012. An administrator
// is an operator inside one tenant, not a platform-wide principal. A real id
// from another tenant must be indistinguishable from an unknown id (404), and
// a mutation attempt must leave the target unchanged.

let app: FastifyInstance;
let adminToken: string;
let tenantBAdminToken: string;
let tenantBUserId: string;
let tenantBVendorOwnerId: string;
let tenantBVendorId: string;
const queuedDiscoveryJobs: Array<{ name: string; data: unknown }> = [];
const TENANT_B = `tenant-admin-b-${nanoid(6)}`;
const DEFAULT_TENANT = 'swift-default';
const TENANT_B_ADMIN_USER_ID = `${TENANT_B}-admin-user`;
const TENANT_B_RIDER_USER_ID = `${TENANT_B}-rider-user`;
const TENANT_B_RIDER_ID = `${TENANT_B}-rider`;
const TENANT_B_DRIVER_USER_ID = `${TENANT_B}-driver-user`;
const TENANT_B_DRIVER_ID = `${TENANT_B}-driver`;
const TENANT_B_BILLING_VENDOR_ID = `${TENANT_B}-billing-vendor`;
const TENANT_B_SUBSCRIPTION_ID = `${TENANT_B}-subscription`;
const TENANT_B_SETTLEMENT_ID = `${TENANT_B}-settlement`;
const TENANT_B_ORDER_ID = `${TENANT_B}-order`;
const TENANT_B_CASH_SETTLEMENT_ID = `${TENANT_B}-cash-settlement`;
const TENANT_B_VERIFICATION_DOC_ID = `${TENANT_B}-verification-doc`;
const TENANT_B_COMPLIANCE_REVIEW_ID = `${TENANT_B}-compliance-review`;
const TENANT_B_REIMBURSEMENT_CLAIM_ID = `${TENANT_B}-reimbursement-claim`;
const TENANT_B_AUDIT_LOG_ID = `${TENANT_B}-audit-log`;
const TENANT_B_TOPUP_KEY = `${TENANT_B}-topup-replay`;
const TENANT_B_TOPUP_EVENT_KEY = `topup:${TENANT_B_SUBSCRIPTION_ID}:${TENANT_B_TOPUP_KEY}`;
const TENANT_B_BILLING_EVENT_ID = `${TENANT_B}-billing-event`;
const TENANT_B_AGENT_TOPUP_EVENT_ID = `${TENANT_B}-agent-topup-event`;
const TENANT_B_USD_EVENT_ID = `${TENANT_B}-usd-charge-event`;
const TENANT_B_SAN = `987654321${luhnCheckDigit('987654321')}`;
const TENANT_B_RECEIPT_ID = `${TENANT_B}-receipt`;
const TENANT_B_RECEIPT_NUMBER = `TENANT-B-PRIVATE-${TENANT_B.slice(-6).toUpperCase()}`;
const TENANT_B_COLLECTION_CONTACT_ID = `${TENANT_B}-collection-contact`;
const LOCAL_AGENT_PAYMENT_ID = `${TENANT_B}-local-agent-payment`;
const TENANT_B_AGENT_PAYMENT_ID = `${TENANT_B}-foreign-agent-payment`;
const FOREIGN_SAN_RECEIPT = `${TENANT_B}-manual-receipt`;
const FOREIGN_SAN_EXTERNAL_ID = `MANUAL:${FOREIGN_SAN_RECEIPT}`;
const TENANT_B_AGENT_TOPUP_EVENT_KEY =
  `topup:${TENANT_B_SUBSCRIPTION_ID}:agent:MANUAL_ADMIN:${FOREIGN_SAN_EXTERNAL_ID}`;

function tenantBPhone(offset: number): string {
  const seed = [...TENANT_B].reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 1_000_000, 0);
  return `+5927${String((seed + offset) % 1_000_000).padStart(6, '0')}`;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  app.decorate('dispatchQueue', {
    add: async (name: string, data: unknown) => {
      queuedDiscoveryJobs.push({ name, data });
    },
  } as never);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  const login = await loginWithOtp(app, '+5926001000');
  expect(login.statusCode).toBe(200);
  adminToken = login.json().data.tokens.accessToken;

  await runWithoutTenant(async () => {
    await app.prisma.tenant.create({
      data: { id: TENANT_B, name: 'Admin Isolation Tenant B', slug: TENANT_B, isActive: true },
    });
    await app.prisma.user.create({
      data: {
        id: TENANT_B_ADMIN_USER_ID,
        phone: tenantBPhone(0),
        firstName: 'TenantBoundary', lastName: 'Admin',
        roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true,
        tenantId: TENANT_B,
        admin: { create: { permissions: ['*'] } },
      },
    });
    tenantBAdminToken = app.jwt.sign({ userId: TENANT_B_ADMIN_USER_ID, role: 'SUPER_ADMIN', jti: nanoid(8) });
    await app.prisma.session.create({
      data: {
        userId: TENANT_B_ADMIN_USER_ID,
        token: tenantBAdminToken,
        refreshToken: nanoid(48),
        authMethod: 'OTP',
        deviceId: 'tenant-admin-isolation',
        deviceType: 'test',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const user = await app.prisma.user.create({
      data: {
        phone: tenantBPhone(1),
        firstName: 'TenantB', lastName: 'Private',
        roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
        tenantId: TENANT_B,
      },
    });
    tenantBUserId = user.id;
    const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
    tenantBVendorOwnerId = owner.id;
    const vendor = await app.prisma.vendor.create({
      data: {
        tenantId: TENANT_B,
        ownerId: owner.id,
        name: 'Tenant B Private Store',
        slug: `tenant-b-private-${nanoid(8)}`,
        vendorType: 'STORE',
        phone: '+5926009998',
        addressLine1: 'Private tenant address',
        city: 'Georgetown',
        region: 'Demerara-Mahaica',
        latitude: 6.8,
        longitude: -58.15,
        status: 'PENDING_APPROVAL',
      },
    });
    tenantBVendorId = vendor.id;

    await app.prisma.user.create({
      data: {
        id: TENANT_B_RIDER_USER_ID,
        phone: tenantBPhone(2),
        firstName: 'TenantBoundary', lastName: 'Rider',
        roles: ['MOVER', 'CUSTOMER'], activeRole: 'MOVER', isPhoneVerified: true,
        tenantId: TENANT_B,
      },
    });
    await app.prisma.rider.create({
      data: {
        id: TENANT_B_RIDER_ID,
        userId: TENANT_B_RIDER_USER_ID,
        riderType: 'DELIVERY',
        vehicleType: 'MOTORCYCLE',
        isOnline: true,
        locationSessionId: syntheticLocationOwner('tenant-adm'),
        currentLat: 6.8123,
        currentLng: -58.1623,
      },
    });

    await app.prisma.user.create({
      data: {
        id: TENANT_B_DRIVER_USER_ID,
        phone: tenantBPhone(3),
        firstName: 'TenantBoundary', lastName: 'Driver',
        roles: ['MOVER', 'CUSTOMER'], activeRole: 'MOVER', isPhoneVerified: true,
        tenantId: TENANT_B,
      },
    });
    await app.prisma.driver.create({
      data: {
        id: TENANT_B_DRIVER_ID,
        userId: TENANT_B_DRIVER_USER_ID,
        vehicleMake: 'Toyota', vehicleModel: 'Corolla', vehicleYear: 2024,
        vehicleColor: 'Silver', licensePlate: 'TENANT-B',
        driverLicenseUrl: 'private://tenant-b/driver-license',
        vehicleInsuranceUrl: 'private://tenant-b/vehicle-insurance',
        bodyType: 'UNKNOWN',
        isOnline: true,
        locationSessionId: syntheticLocationOwner('tenant-adm'),
        currentLat: 6.8234,
        currentLng: -58.1734,
      },
    });
    await app.prisma.verificationDocument.create({
      data: {
        id: TENANT_B_VERIFICATION_DOC_ID,
        userId: TENANT_B_DRIVER_USER_ID,
        role: 'MOVER',
        docType: 'drivers_licence',
        fileUrl: 'private://tenant-b/verification-document',
        status: 'PENDING',
        consentAt: new Date('2026-08-09T09:00:00.000Z'),
        privacyNoticeVersion: 'tenant-isolation-test',
      },
    });
    await app.prisma.complianceReviewCase.create({
      data: {
        id: TENANT_B_COMPLIANCE_REVIEW_ID,
        userId: TENANT_B_DRIVER_USER_ID,
        status: 'OPEN',
        dueAt: new Date('2026-08-17T00:00:00.000Z'),
      },
    });

    await app.prisma.vendor.create({
      data: {
        id: TENANT_B_BILLING_VENDOR_ID,
        tenantId: TENANT_B,
        ownerId: tenantBVendorOwnerId,
        name: 'Tenant B Billing Store',
        slug: `tenant-b-billing-${nanoid(8)}`,
        vendorType: 'STORE',
        phone: tenantBPhone(4),
        addressLine1: 'Private billing address',
        city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.81, longitude: -58.16,
        status: 'ACTIVE',
      },
    });
    await app.prisma.subscription.create({
      data: {
        id: TENANT_B_SUBSCRIPTION_ID,
        vendorId: TENANT_B_BILLING_VENDOR_ID,
        type: 'RETAIL_STORE', status: 'PAST_DUE', weeklyRate: 24_680,
        currentPeriodStart: new Date('2026-08-03T00:00:00.000Z'),
        currentPeriodEnd: new Date('2026-08-10T00:00:00.000Z'),
        nextBillingDate: new Date('2026-08-10T00:00:00.000Z'),
        san: TENANT_B_SAN,
        sanAssignedAt: new Date('2026-08-03T00:00:00.000Z'),
      },
    });
    // A duplicate idempotency event makes a vulnerable pre-fix top-up a safe
    // replay (no credit/receipt/ledger write) while it still returns 200 and
    // writes an admin audit, so the isolation assertion deterministically reds.
    await app.prisma.billingEvent.create({
      data: {
        id: TENANT_B_BILLING_EVENT_ID,
        subscriptionId: TENANT_B_SUBSCRIPTION_ID,
        type: 'PREPAID_TOPUP', amount: 4_321, currencyCode: 'GYD',
        idempotencyKey: TENANT_B_TOPUP_EVENT_KEY,
        note: 'cross-tenant isolation sentinel',
      },
    });
    await app.prisma.billingEvent.create({
      data: {
        id: TENANT_B_AGENT_TOPUP_EVENT_ID,
        subscriptionId: TENANT_B_SUBSCRIPTION_ID,
        type: 'PREPAID_TOPUP', amount: 3_333, currencyCode: 'GYD',
        idempotencyKey: TENANT_B_AGENT_TOPUP_EVENT_KEY,
        note: 'foreign SAN ingestion replay sentinel',
      },
    });
    await app.prisma.billingEvent.create({
      data: {
        id: TENANT_B_USD_EVENT_ID,
        subscriptionId: TENANT_B_SUBSCRIPTION_ID,
        type: 'CHARGE_SUCCESS', amount: 8_765_432, amountUsd: 98_765,
        currencyCode: 'GYD',
        idempotencyKey: `foreign-usd-charge:${TENANT_B_SUBSCRIPTION_ID}`,
        note: 'foreign USD summary sentinel',
      },
    });
    await app.prisma.prepaidBalance.create({
      data: { subscriptionId: TENANT_B_SUBSCRIPTION_ID, balance: 4_321, currencyCode: 'GYD' },
    });
    await app.prisma.feeReceipt.create({
      data: {
        id: TENANT_B_RECEIPT_ID,
        receiptNumber: TENANT_B_RECEIPT_NUMBER,
        tenantId: TENANT_B,
        subscriptionId: TENANT_B_SUBSCRIPTION_ID,
        billingEventId: TENANT_B_BILLING_EVENT_ID,
        amount: 4_321,
        channel: 'TENANT_B_PRIVATE',
        issuedAt: new Date('2026-08-09T12:00:00.000Z'),
      },
    });
    await app.prisma.collectionContact.create({
      data: {
        id: TENANT_B_COLLECTION_CONTACT_ID,
        subscriptionId: TENANT_B_SUBSCRIPTION_ID,
        outcome: 'REACHED',
        note: 'foreign tenant private collection note',
        byAdminId: TENANT_B_RIDER_USER_ID,
      },
    });
    await app.prisma.mmgAgentPayment.createMany({
      data: [
        {
          id: LOCAL_AGENT_PAYMENT_ID,
          tenantId: DEFAULT_TENANT,
          channel: 'TENANT_ISOLATION_TEST',
          externalId: `${LOCAL_AGENT_PAYMENT_ID}-external`,
          sanRaw: '1111111111',
          amount: 1_111,
          currencyCode: 'GYD',
          paidAt: new Date('2026-08-09T11:00:00.000Z'),
          status: 'MATCHED',
          raw: { fixture: 'local attach sentinel' },
        },
        {
          id: TENANT_B_AGENT_PAYMENT_ID,
          tenantId: TENANT_B,
          channel: 'TENANT_B_PRIVATE',
          externalId: `${TENANT_B_AGENT_PAYMENT_ID}-external`,
          sanRaw: TENANT_B_SAN,
          sanNormalized: TENANT_B_SAN,
          subscriptionId: TENANT_B_SUBSCRIPTION_ID,
          amount: 2_222,
          currencyCode: 'GYD',
          paidAt: new Date('2026-08-09T10:00:00.000Z'),
          status: 'UNMATCHED',
          failureCode: 'SAN_UNKNOWN',
          raw: { fixture: 'foreign agent payment' },
        },
      ],
    });

    await app.prisma.settlement.create({
      data: {
        id: TENANT_B_SETTLEMENT_ID,
        vendorId: tenantBVendorId,
        periodStart: new Date('2026-08-03T00:00:00.000Z'),
        periodEnd: new Date('2026-08-10T00:00:00.000Z'),
        totalOrders: 1, totalBase: 9_876_543, totalMarkup: 123_456,
        status: 'PENDING',
      },
    });
    await app.prisma.order.create({
      data: {
        id: TENANT_B_ORDER_ID,
        tenantId: TENANT_B,
        orderNumber: `TEN-B-CASH-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY',
        customerId: tenantBUserId,
        vendorId: tenantBVendorId,
        riderId: TENANT_B_RIDER_ID,
        status: 'DELIVERED',
        deliveryAddress: 'Tenant B private settlement',
        deliveryLat: 6.8, deliveryLng: -58.15,
        // chk_orders_zero_markup: the keep-100%/flat-fee model forbids a
        // non-zero markup in production. subtotalCustomer stays distinctive
        // so the cross-tenant leak assertions keep their sentinel.
        subtotalBase: 1_000, subtotalMarkup: 0, subtotalCustomer: 1_100,
        deliveryFee: 87_654_321, totalAmount: 87_655_421,
        paymentMethod: 'MOBILE_MONEY',
      },
    });
    await app.prisma.reimbursementClaim.create({
      data: {
        id: TENANT_B_REIMBURSEMENT_CLAIM_ID,
        orderId: TENANT_B_ORDER_ID,
        riderId: TENANT_B_RIDER_ID,
        customerId: tenantBUserId,
        amount: 765_432,
        reason: 'no_show',
        gpsLat: 6.8,
        gpsLng: -58.15,
        status: 'APPROVED',
        flags: [],
      },
    });
    await app.prisma.auditLog.create({
      data: {
        id: TENANT_B_AUDIT_LOG_ID,
        userId: TENANT_B_ADMIN_USER_ID,
        action: 'TENANT_B_PRIVATE_AUDIT',
        entity: 'Subscription',
        entityId: TENANT_B_AUDIT_LOG_ID,
        changes: { amount: 999_999, note: 'tenant B private audit detail' },
      },
    });
    await app.prisma.deliveryCashSettlement.create({
      data: {
        id: TENANT_B_CASH_SETTLEMENT_ID,
        orderId: TENANT_B_ORDER_ID,
        riderId: TENANT_B_RIDER_ID,
        vendorId: tenantBVendorId,
        amount: 87_654_321,
        status: 'OWED',
      },
    });
  });
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    const entityIds = [
      tenantBUserId,
      tenantBVendorId,
      TENANT_B_RIDER_ID,
      TENANT_B_DRIVER_ID,
      TENANT_B_SUBSCRIPTION_ID,
      TENANT_B_SETTLEMENT_ID,
      TENANT_B_CASH_SETTLEMENT_ID,
      TENANT_B_VERIFICATION_DOC_ID,
      TENANT_B_COMPLIANCE_REVIEW_ID,
      TENANT_B_REIMBURSEMENT_CLAIM_ID,
    ].filter((id): id is string => Boolean(id));
    const userIds = [tenantBUserId, TENANT_B_ADMIN_USER_ID, TENANT_B_RIDER_USER_ID, TENANT_B_DRIVER_USER_ID]
      .filter((id): id is string => Boolean(id));

    await app.prisma.auditLog.deleteMany({
      where: { OR: [{ entityId: { in: entityIds } }, { userId: { in: userIds } }] },
    });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.feeReceipt.deleteMany({ where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID } });
    await app.prisma.prepaidBalance.deleteMany({ where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID } });
    await app.prisma.billingEvent.deleteMany({ where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID } });
    await app.prisma.subscriptionPayment.deleteMany({ where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID } });
    await app.prisma.collectionContact.deleteMany({ where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID } });
    await app.prisma.mmgAgentPayment.deleteMany({
      where: {
        OR: [
          { id: { in: [LOCAL_AGENT_PAYMENT_ID, TENANT_B_AGENT_PAYMENT_ID] } },
          { channel: 'MANUAL_ADMIN', externalId: FOREIGN_SAN_EXTERNAL_ID },
        ],
      },
    });
    await app.prisma.deliveryCashSettlement.deleteMany({ where: { id: TENANT_B_CASH_SETTLEMENT_ID } });
    await app.prisma.reimbursementClaim.deleteMany({ where: { id: TENANT_B_REIMBURSEMENT_CLAIM_ID } });
    await app.prisma.order.deleteMany({ where: { id: TENANT_B_ORDER_ID } });
    await app.prisma.settlement.deleteMany({ where: { id: TENANT_B_SETTLEMENT_ID } });
    await app.prisma.subscription.deleteMany({
      where: { OR: [{ id: TENANT_B_SUBSCRIPTION_ID }, { vendorId: tenantBVendorId }] },
    });
    await app.prisma.vendor.deleteMany({
      where: { id: { in: [tenantBVendorId, TENANT_B_BILLING_VENDOR_ID].filter((id): id is string => Boolean(id)) } },
    });
    await app.prisma.complianceReviewCase.deleteMany({ where: { id: TENANT_B_COMPLIANCE_REVIEW_ID } });
    await app.prisma.verificationDocument.deleteMany({ where: { id: TENANT_B_VERIFICATION_DOC_ID } });
    await app.prisma.driver.deleteMany({ where: { id: TENANT_B_DRIVER_ID } });
    await app.prisma.rider.deleteMany({ where: { id: TENANT_B_RIDER_ID } });
    if (tenantBVendorOwnerId) {
      await app.prisma.vendorOwner.deleteMany({ where: { id: tenantBVendorOwnerId } });
    }
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } });
  });
  await app.close();
});

async function adminRequest(
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
) {
  return await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    headers: {
      authorization: `Bearer ${adminToken}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
  });
}

function expectNotFound(response: LightMyRequestResponse) {
  expect(response.statusCode).toBe(404);
  expect(response.json().error.code).toBe('NOT_FOUND');
}

async function mutationEffects(entityId: string, notifyUserId: string) {
  return runWithoutTenant(async () => {
    const [auditCount, notificationCount] = await Promise.all([
      app.prisma.auditLog.count({ where: { entityId } }),
      app.prisma.notification.count({ where: { userId: notifyUserId } }),
    ]);
    return { auditCount, notificationCount };
  });
}

async function foreignBillingState() {
  return runWithoutTenant(async () => {
    const [subscription, balance, events, receipts, auditCount, notificationCount] = await Promise.all([
      app.prisma.subscription.findUniqueOrThrow({
        where: { id: TENANT_B_SUBSCRIPTION_ID },
        select: {
          status: true,
          feeWaived: true,
          feeWaivedBy: true,
          feeWaivedReason: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          nextBillingDate: true,
          updatedAt: true,
        },
      }),
      app.prisma.prepaidBalance.findUnique({
        where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID },
        select: { balance: true, currencyCode: true, updatedAt: true },
      }),
      app.prisma.billingEvent.findMany({
        where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID },
        select: { id: true, type: true, amount: true, idempotencyKey: true },
        orderBy: { id: 'asc' },
      }),
      app.prisma.feeReceipt.findMany({
        where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID },
        select: { id: true, receiptNumber: true, amount: true },
        orderBy: { id: 'asc' },
      }),
      app.prisma.auditLog.count({ where: { entityId: TENANT_B_SUBSCRIPTION_ID } }),
      app.prisma.notification.count({ where: { userId: tenantBUserId } }),
    ]);
    return {
      subscription,
      balance: balance ? { ...balance, balance: Number(balance.balance) } : null,
      events: events.map((event) => ({ ...event, amount: event.amount === null ? null : Number(event.amount) })),
      receipts: receipts.map((receipt) => ({ ...receipt, amount: Number(receipt.amount) })),
      auditCount,
      notificationCount,
    };
  });
}

describe('tenant-qualified admin access', () => {
  it('queues discovery backfill with the authenticated admin tenant', async () => {
    queuedDiscoveryJobs.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/discovery/backfill',
      headers: {
        authorization: `Bearer ${tenantBAdminToken}`,
        'content-type': 'application/json',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(queuedDiscoveryJobs).toEqual([
      { name: 'discovery-backfill', data: { tenantId: TENANT_B } },
    ]);
  });

  it('returns 404 instead of reading a user from another tenant', async () => {
    const response = await adminRequest('GET', `/api/v1/admin/users/${tenantBUserId}`);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 404 and does not suspend a user from another tenant', async () => {
    try {
      const response = await adminRequest('PUT', `/api/v1/admin/users/${tenantBUserId}/suspend`, {
        reason: 'must not cross tenant',
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');

      const untouched = await runWithoutTenant(() => app.prisma.user.findUniqueOrThrow({ where: { id: tenantBUserId } }));
      expect(untouched.status).toBe('ACTIVE');
    } finally {
      // Keep the fixture deterministic after the intentional pre-fix red run,
      // where the vulnerable route does mutate tenant B.
      await runWithoutTenant(() => app.prisma.user.updateMany({
        where: { id: tenantBUserId },
        data: { status: 'ACTIVE' },
      }));
    }
  });

  it('returns 404 instead of reading a vendor from another tenant', async () => {
    const response = await adminRequest('GET', `/api/v1/admin/vendors/${tenantBVendorId}`);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });

  it('returns 404 and does not approve or verify a vendor from another tenant', async () => {
    const response = await adminRequest('PUT', `/api/v1/admin/vendors/${tenantBVendorId}/approve`);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');

    const untouched = await runWithoutTenant(() => app.prisma.vendor.findUniqueOrThrow({ where: { id: tenantBVendorId } }));
    expect(untouched.status).toBe('PENDING_APPROVAL');
    expect(untouched.isVerified).toBe(false);
    expect(await runWithoutTenant(() => app.prisma.subscription.count({ where: { vendorId: tenantBVendorId } }))).toBe(0);
  });

  it('keeps foreign live movers and active subscriptions out of dashboard and live ops', async () => {
    const activeSubscriptionId = `${TENANT_B}-active-dashboard-subscription`;
    try {
      await runWithoutTenant(() => app.prisma.subscription.create({
        data: {
          id: activeSubscriptionId,
          vendorId: tenantBVendorId,
          type: 'RETAIL_STORE', status: 'ACTIVE', weeklyRate: 65_432,
          currentPeriodStart: new Date('2026-08-03T00:00:00.000Z'),
          currentPeriodEnd: new Date('2026-08-10T00:00:00.000Z'),
          nextBillingDate: new Date('2026-08-10T00:00:00.000Z'),
        },
      }));
      const expected = await runWithoutTenant(async () => {
        const subscriptionScope = {
          OR: [
            { vendor: { tenantId: DEFAULT_TENANT } },
            { rider: { user: { tenantId: DEFAULT_TENANT } } },
            { driver: { user: { tenantId: DEFAULT_TENANT } } },
          ],
        };
        const [activeRiders, activeDrivers, activeSubscriptions, pastDueSubscriptions] = await Promise.all([
          app.prisma.rider.count({ where: { isOnline: true, user: { tenantId: DEFAULT_TENANT } } }),
          app.prisma.driver.count({ where: { isOnline: true, user: { tenantId: DEFAULT_TENANT } } }),
          app.prisma.subscription.count({ where: { status: 'ACTIVE', ...subscriptionScope } }),
          app.prisma.subscription.count({ where: { status: 'PAST_DUE', ...subscriptionScope } }),
        ]);
        return { activeRiders, activeDrivers, activeSubscriptions, pastDueSubscriptions };
      });

      const dashboard = await adminRequest('GET', '/api/v1/admin/dashboard/overview');
      const live = await adminRequest('GET', '/api/v1/admin/ops/live');
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json().data.activeRiders).toBe(expected.activeRiders);
      expect(dashboard.json().data.activeDrivers).toBe(expected.activeDrivers);
      expect(dashboard.json().data.subscriptionBreakdown.reduce(
        (total: number, row: { count: number }) => total + row.count,
        0,
      )).toBe(expected.activeSubscriptions);
      expect(dashboard.json().data.alerts.pastDueSubs).toBe(expected.pastDueSubscriptions);
      expect(live.statusCode).toBe(200);
      const liveMoverIds = live.json().data.movers.map((mover: { id: string }) => mover.id);
      expect(liveMoverIds).not.toContain(TENANT_B_RIDER_ID);
      expect(liveMoverIds).not.toContain(TENANT_B_DRIVER_ID);
    } finally {
      await runWithoutTenant(() => app.prisma.subscription.deleteMany({ where: { id: activeSubscriptionId } }));
    }
  });

  it('excludes foreign riders, drivers, subscriptions, settlements, and cash rows from unfiltered lists and totals', async () => {
    const expected = await runWithoutTenant(async () => {
      const [riders, drivers, subscriptions, settlements, cashRows] = await Promise.all([
        app.prisma.rider.count({ where: { user: { tenantId: DEFAULT_TENANT } } }),
        app.prisma.driver.count({ where: { user: { tenantId: DEFAULT_TENANT } } }),
        app.prisma.subscription.count({
          where: {
            OR: [
              { vendor: { tenantId: DEFAULT_TENANT } },
              { rider: { user: { tenantId: DEFAULT_TENANT } } },
              { driver: { user: { tenantId: DEFAULT_TENANT } } },
            ],
          },
        }),
        app.prisma.settlement.count({ where: { vendor: { tenantId: DEFAULT_TENANT } } }),
        app.prisma.deliveryCashSettlement.findMany({
          where: { order: { tenantId: DEFAULT_TENANT } },
          select: { status: true, amount: true },
        }),
      ]);
      const cashSummary: Record<string, { total: number; count: number }> = {};
      for (const row of cashRows) {
        const current = cashSummary[row.status] ?? { total: 0, count: 0 };
        cashSummary[row.status] = {
          total: current.total + Number(row.amount),
          count: current.count + 1,
        };
      }
      return { riders, drivers, subscriptions, settlements, cashRows: cashRows.length, cashSummary };
    });

    const riders = await adminRequest('GET', '/api/v1/admin/riders?limit=50');
    const drivers = await adminRequest('GET', '/api/v1/admin/drivers?limit=50');
    const subscriptions = await adminRequest('GET', '/api/v1/admin/subscriptions?limit=50');
    const settlements = await adminRequest('GET', '/api/v1/admin/finance/settlements?limit=50');
    const cash = await adminRequest('GET', '/api/v1/admin/finance/cash-settlements?limit=50');

    for (const response of [riders, drivers, subscriptions, settlements, cash]) {
      expect(response.statusCode).toBe(200);
    }
    expect(riders.json().meta.total).toBe(expected.riders);
    expect(riders.json().data.map((row: { id: string }) => row.id)).not.toContain(TENANT_B_RIDER_ID);
    expect(drivers.json().meta.total).toBe(expected.drivers);
    expect(drivers.json().data.map((row: { id: string }) => row.id)).not.toContain(TENANT_B_DRIVER_ID);
    expect(subscriptions.json().meta.total).toBe(expected.subscriptions);
    expect(subscriptions.json().data.map((row: { id: string }) => row.id)).not.toContain(TENANT_B_SUBSCRIPTION_ID);
    expect(settlements.json().meta.total).toBe(expected.settlements);
    expect(settlements.json().data.map((row: { id: string }) => row.id)).not.toContain(TENANT_B_SETTLEMENT_ID);
    expect(cash.json().meta.total).toBe(expected.cashRows);
    expect(cash.json().data.map((row: { id: string }) => row.id)).not.toContain(TENANT_B_CASH_SETTLEMENT_ID);
    expect(cash.json().summary).toEqual(expected.cashSummary);
  });

  it('returns 404 for foreign vendor/rider filters on settlement ledgers', async () => {
    const responses = [
      await adminRequest('GET', `/api/v1/admin/finance/settlements?vendorId=${tenantBVendorId}`),
      await adminRequest('GET', `/api/v1/admin/finance/cash-settlements?vendorId=${tenantBVendorId}`),
      await adminRequest('GET', `/api/v1/admin/finance/cash-settlements?riderId=${TENANT_B_RIDER_ID}`),
    ];
    for (const response of responses) expectNotFound(response);
  });

  it('returns 404 instead of reading a rider or driver from another tenant', async () => {
    const rider = await adminRequest('GET', `/api/v1/admin/riders/${TENANT_B_RIDER_ID}`);
    const driver = await adminRequest('GET', `/api/v1/admin/drivers/${TENANT_B_DRIVER_ID}`);
    expectNotFound(rider);
    expectNotFound(driver);
  });

  it('returns 404 and does not reject, audit, or notify a rider from another tenant', async () => {
    const beforeRider = await runWithoutTenant(() => app.prisma.rider.findUniqueOrThrow({
      where: { id: TENANT_B_RIDER_ID },
      select: {
        documentsVerified: true,
        documentsVerifiedAt: true,
        documentsVerifiedBy: true,
        updatedAt: true,
      },
    }));
    const beforeEffects = await mutationEffects(TENANT_B_RIDER_ID, TENANT_B_RIDER_USER_ID);
    try {
      const response = await adminRequest('PUT', `/api/v1/admin/riders/${TENANT_B_RIDER_ID}/verify-documents`, {
        verified: false,
        rejectionReason: 'foreign tenant records are not reviewable',
      });
      const afterRider = await runWithoutTenant(() => app.prisma.rider.findUniqueOrThrow({
        where: { id: TENANT_B_RIDER_ID },
        select: {
          documentsVerified: true,
          documentsVerifiedAt: true,
          documentsVerifiedBy: true,
          updatedAt: true,
        },
      }));
      expect(afterRider).toEqual(beforeRider);
      expect(await mutationEffects(TENANT_B_RIDER_ID, TENANT_B_RIDER_USER_ID)).toEqual(beforeEffects);
      expectNotFound(response);
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.rider.updateMany({ where: { id: TENANT_B_RIDER_ID }, data: beforeRider });
        await app.prisma.auditLog.deleteMany({ where: { entityId: TENANT_B_RIDER_ID } });
        await app.prisma.notification.deleteMany({ where: { userId: TENANT_B_RIDER_USER_ID } });
      });
    }
  });

  it('returns 404 and does not reject, audit, or notify a driver from another tenant', async () => {
    const beforeDriver = await runWithoutTenant(() => app.prisma.driver.findUniqueOrThrow({
      where: { id: TENANT_B_DRIVER_ID },
      select: {
        documentsVerified: true,
        documentsVerifiedAt: true,
        documentsVerifiedBy: true,
        updatedAt: true,
      },
    }));
    const beforeEffects = await mutationEffects(TENANT_B_DRIVER_ID, TENANT_B_DRIVER_USER_ID);
    try {
      const response = await adminRequest('PUT', `/api/v1/admin/drivers/${TENANT_B_DRIVER_ID}/verify-documents`, {
        verified: false,
        rejectionReason: 'foreign tenant records are not reviewable',
      });
      const afterDriver = await runWithoutTenant(() => app.prisma.driver.findUniqueOrThrow({
        where: { id: TENANT_B_DRIVER_ID },
        select: {
          documentsVerified: true,
          documentsVerifiedAt: true,
          documentsVerifiedBy: true,
          updatedAt: true,
        },
      }));
      expect(afterDriver).toEqual(beforeDriver);
      expect(await mutationEffects(TENANT_B_DRIVER_ID, TENANT_B_DRIVER_USER_ID)).toEqual(beforeEffects);
      expectNotFound(response);
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.driver.updateMany({ where: { id: TENANT_B_DRIVER_ID }, data: beforeDriver });
        await app.prisma.auditLog.deleteMany({ where: { entityId: TENANT_B_DRIVER_ID } });
        await app.prisma.notification.deleteMany({ where: { userId: TENANT_B_DRIVER_USER_ID } });
      });
    }
  });

  it('returns 404 and does not change or audit a foreign driver ride class', async () => {
    const beforeDriver = await runWithoutTenant(() => app.prisma.driver.findUniqueOrThrow({
      where: { id: TENANT_B_DRIVER_ID },
      select: { rideClass: true, updatedAt: true },
    }));
    const beforeEffects = await mutationEffects(TENANT_B_DRIVER_ID, TENANT_B_DRIVER_USER_ID);
    try {
      const response = await adminRequest('PUT', `/api/v1/admin/drivers/${TENANT_B_DRIVER_ID}/ride-class`, {
        rideClass: 'COMFORT',
      });
      const afterDriver = await runWithoutTenant(() => app.prisma.driver.findUniqueOrThrow({
        where: { id: TENANT_B_DRIVER_ID },
        select: { rideClass: true, updatedAt: true },
      }));
      expect(afterDriver).toEqual(beforeDriver);
      expect(await mutationEffects(TENANT_B_DRIVER_ID, TENANT_B_DRIVER_USER_ID)).toEqual(beforeEffects);
      expectNotFound(response);
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.driver.updateMany({ where: { id: TENANT_B_DRIVER_ID }, data: beforeDriver });
        await app.prisma.auditLog.deleteMany({ where: { entityId: TENANT_B_DRIVER_ID } });
      });
    }
  });

  it('returns 404 instead of exposing billing events for a foreign subscription', async () => {
    const response = await adminRequest(
      'GET',
      `/api/v1/admin/subscriptions/${TENANT_B_SUBSCRIPTION_ID}/billing-events`,
    );
    expectNotFound(response);
  });

  it('returns 404 and does not waive, audit, or notify a foreign subscription', async () => {
    const before = await foreignBillingState();
    try {
      const response = await adminRequest(
        'PUT',
        `/api/v1/admin/subscriptions/${TENANT_B_SUBSCRIPTION_ID}/waive-fee`,
        { reason: 'must remain tenant-local' },
      );
      expect(await foreignBillingState()).toEqual(before);
      expectNotFound(response);
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.subscription.updateMany({
          where: { id: TENANT_B_SUBSCRIPTION_ID },
          data: {
            feeWaived: before.subscription.feeWaived,
            feeWaivedBy: before.subscription.feeWaivedBy,
            feeWaivedReason: before.subscription.feeWaivedReason,
            updatedAt: before.subscription.updatedAt,
          },
        });
        await app.prisma.auditLog.deleteMany({ where: { entityId: TENANT_B_SUBSCRIPTION_ID } });
        await app.prisma.notification.deleteMany({ where: { userId: tenantBUserId } });
      });
    }
  });

  it('returns 404 before a foreign subscription top-up can write money, audit, or notification state', async () => {
    const before = await foreignBillingState();
    try {
      const response = await adminRequest(
        'POST',
        `/api/v1/admin/subscriptions/${TENANT_B_SUBSCRIPTION_ID}/topup`,
        { amount: 4_321, reference: 'foreign-topup-must-not-run' },
        { 'idempotency-key': TENANT_B_TOPUP_KEY },
      );
      expect(await foreignBillingState()).toEqual(before);
      expectNotFound(response);
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.auditLog.deleteMany({ where: { entityId: TENANT_B_SUBSCRIPTION_ID } });
        await app.prisma.notification.deleteMany({ where: { userId: tenantBUserId } });
      });
    }
  });

  it('returns 404 and does not process, audit, or notify a settlement from another tenant', async () => {
    const beforeSettlement = await runWithoutTenant(() => app.prisma.settlement.findUniqueOrThrow({
      where: { id: TENANT_B_SETTLEMENT_ID },
      select: { status: true, paidAt: true, reference: true },
    }));
    const beforeEffects = await mutationEffects(TENANT_B_SETTLEMENT_ID, tenantBUserId);
    try {
      const response = await adminRequest(
        'PUT',
        `/api/v1/admin/finance/settlements/${TENANT_B_SETTLEMENT_ID}/process`,
        { reference: 'foreign-settlement-must-not-run' },
      );
      const afterSettlement = await runWithoutTenant(() => app.prisma.settlement.findUniqueOrThrow({
        where: { id: TENANT_B_SETTLEMENT_ID },
        select: { status: true, paidAt: true, reference: true },
      }));
      expect(afterSettlement).toEqual(beforeSettlement);
      expect(await mutationEffects(TENANT_B_SETTLEMENT_ID, tenantBUserId)).toEqual(beforeEffects);
      expectNotFound(response);
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.settlement.updateMany({
          where: { id: TENANT_B_SETTLEMENT_ID },
          data: beforeSettlement,
        });
        await app.prisma.auditLog.deleteMany({ where: { entityId: TENANT_B_SETTLEMENT_ID } });
        await app.prisma.notification.deleteMany({ where: { userId: tenantBUserId } });
      });
    }
  });

  it('does not classify a foreign driver during the vehicle-identity backfill', async () => {
    const originalDriver = await runWithoutTenant(() => app.prisma.driver.findUniqueOrThrow({
      where: { id: TENANT_B_DRIVER_ID },
      select: { bodyType: true, colorHex: true, updatedAt: true },
    }));
    const localBackfillCandidates = await runWithoutTenant(() => app.prisma.driver.findMany({
      where: { bodyType: null, user: { tenantId: DEFAULT_TENANT } },
      select: { id: true, bodyType: true, colorHex: true, updatedAt: true },
    }));
    const beforeDriver = await runWithoutTenant(() => app.prisma.driver.update({
      where: { id: TENANT_B_DRIVER_ID },
      data: { bodyType: null, colorHex: null },
      select: { bodyType: true, colorHex: true, updatedAt: true },
    }));
    try {
      const response = await adminRequest('POST', '/api/v1/admin/rides/vehicle-identity-backfill');
      expect(response.statusCode).toBe(200);
      const afterDriver = await runWithoutTenant(() => app.prisma.driver.findUniqueOrThrow({
        where: { id: TENANT_B_DRIVER_ID },
        select: { bodyType: true, colorHex: true, updatedAt: true },
      }));
      expect(afterDriver).toEqual(beforeDriver);
    } finally {
      await runWithoutTenant(async () => {
        await Promise.all([
          app.prisma.driver.updateMany({
            where: { id: TENANT_B_DRIVER_ID },
            data: originalDriver,
          }),
          ...localBackfillCandidates.map(({ id, ...data }) => app.prisma.driver.updateMany({
            where: { id },
            data,
          })),
        ]);
      });
    }
  });

  it('keeps a foreign UNKNOWN driver out of the vehicle-identity queue', async () => {
    const response = await adminRequest('GET', '/api/v1/admin/rides/vehicle-identity-queue');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.map((row: { id: string }) => row.id)).not.toContain(TENANT_B_DRIVER_ID);
  });

  it('returns 404 and does not change or audit a foreign vehicle identity', async () => {
    const beforeDriver = await runWithoutTenant(() => app.prisma.driver.findUniqueOrThrow({
      where: { id: TENANT_B_DRIVER_ID },
      select: { bodyType: true, colorHex: true, updatedAt: true },
    }));
    const beforeEffects = await mutationEffects(TENANT_B_DRIVER_ID, TENANT_B_DRIVER_USER_ID);
    try {
      const response = await adminRequest(
        'PUT',
        `/api/v1/admin/rides/drivers/${TENANT_B_DRIVER_ID}/vehicle-identity`,
        { bodyType: 'SEDAN', colorHex: '#123456' },
      );
      const afterDriver = await runWithoutTenant(() => app.prisma.driver.findUniqueOrThrow({
        where: { id: TENANT_B_DRIVER_ID },
        select: { bodyType: true, colorHex: true, updatedAt: true },
      }));
      expect(afterDriver).toEqual(beforeDriver);
      expect(await mutationEffects(TENANT_B_DRIVER_ID, TENANT_B_DRIVER_USER_ID)).toEqual(beforeEffects);
      expectNotFound(response);
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.driver.updateMany({ where: { id: TENANT_B_DRIVER_ID }, data: beforeDriver });
        await app.prisma.auditLog.deleteMany({ where: { entityId: TENANT_B_DRIVER_ID } });
      });
    }
  });

  it('keeps foreign subscriptions and child collection records out of the collections workbench', async () => {
    const expectedCount = await runWithoutTenant(() => app.prisma.subscription.count({
      where: {
        status: 'PAST_DUE',
        OR: [
          { vendor: { tenantId: DEFAULT_TENANT } },
          { rider: { user: { tenantId: DEFAULT_TENANT } } },
          { driver: { user: { tenantId: DEFAULT_TENANT } } },
        ],
      },
    }));
    const response = await adminRequest('GET', '/api/v1/admin/billing/collections?tab=pastdue');
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(expectedCount);
    expect(response.json().data.map((row: { subscriptionId: string }) => row.subscriptionId))
      .not.toContain(TENANT_B_SUBSCRIPTION_ID);
    expect(response.body).not.toContain('foreign tenant private collection note');
  });

  it('returns 404 and does not create or audit a collection contact for a foreign subscription', async () => {
    const action = 'ADMIN POST /billing/collections/:subscriptionId/contact';
    const before = await runWithoutTenant(async () => ({
      contacts: await app.prisma.collectionContact.count({ where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID } }),
      audits: await app.prisma.auditLog.count({ where: { action } }),
    }));
    try {
      const response = await adminRequest(
        'POST',
        `/api/v1/admin/billing/collections/${TENANT_B_SUBSCRIPTION_ID}/contact`,
        { outcome: 'REACHED', note: 'cross-tenant contact must not persist' },
      );
      const after = await runWithoutTenant(async () => ({
        contacts: await app.prisma.collectionContact.count({ where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID } }),
        audits: await app.prisma.auditLog.count({ where: { action } }),
      }));
      expect(after).toEqual(before);
      expectNotFound(response);
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.collectionContact.deleteMany({
          where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID, id: { not: TENANT_B_COLLECTION_CONTACT_ID } },
        });
        await app.prisma.auditLog.deleteMany({
          where: {
            action,
            changes: { path: ['params', 'subscriptionId'], equals: TENANT_B_SUBSCRIPTION_ID },
          },
        });
      });
    }
  });

  it('keeps foreign fee receipts out of the tenant cash journal', async () => {
    const response = await adminRequest(
      'GET',
      '/api/v1/admin/billing/cash-journal?from=2026-08-01T00%3A00%3A00.000Z&to=2026-08-20T00%3A00%3A00.000Z',
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(TENANT_B_RECEIPT_NUMBER);
    expect(response.body).not.toContain(TENANT_B_SUBSCRIPTION_ID);
  });

  it('keeps foreign agent-cash rows out of admin payment lists', async () => {
    const list = await adminRequest('GET', '/api/v1/admin/billing/agent-payments?limit=200');
    const unmatched = await adminRequest('GET', '/api/v1/admin/billing/agent-payments/unmatched');
    expect(list.statusCode).toBe(200);
    expect(unmatched.statusCode).toBe(200);
    expect(list.json().data.map((row: { id: string }) => row.id)).not.toContain(TENANT_B_AGENT_PAYMENT_ID);
    expect(unmatched.json().data.map((row: { id: string }) => row.id)).not.toContain(TENANT_B_AGENT_PAYMENT_ID);
  });

  it('returns 404 before a tenant-local suspense payment can attach to a foreign subscription', async () => {
    const before = await runWithoutTenant(() => app.prisma.mmgAgentPayment.findUniqueOrThrow({
      where: { id: LOCAL_AGENT_PAYMENT_ID },
    }));
    const beforeBilling = await foreignBillingState();
    const response = await adminRequest(
      'POST',
      `/api/v1/admin/billing/agent-payments/${LOCAL_AGENT_PAYMENT_ID}/attach`,
      { subscriptionId: TENANT_B_SUBSCRIPTION_ID },
    );
    const after = await runWithoutTenant(() => app.prisma.mmgAgentPayment.findUniqueOrThrow({
      where: { id: LOCAL_AGENT_PAYMENT_ID },
    }));
    expect(after).toEqual(before);
    expect(await foreignBillingState()).toEqual(beforeBilling);
    expectNotFound(response);
  });

  it('treats a real foreign SAN as unknown instead of exposing its holder', async () => {
    const response = await adminRequest('GET', `/api/v1/admin/billing/san/${TENANT_B_SAN}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ valid: false, code: 'SAN_UNKNOWN' });
    expect(response.body).not.toContain(TENANT_B_SUBSCRIPTION_ID);
    expect(response.body).not.toContain('Tenant B Billing Store');
  });

  it('keeps a foreign subscription out of the USD migration preview', async () => {
    const response = await adminRequest('GET', '/api/v1/admin/billing/usd-migration/preview');
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(Array.isArray(data.rows)).toBe(true);
    expect(data.rows.map((row: { subscriptionId?: string }) => row.subscriptionId))
      .not.toContain(TENANT_B_SUBSCRIPTION_ID);
    if (data.error) expect(data.error).toBe('NO_FX_RATE');
  });

  it('keeps foreign charge events out of the USD billing summary', async () => {
    const since = new Date(Date.now() - 365 * 86_400_000);
    const expected = await runWithoutTenant(async () => {
      const subscriptionScope = {
        OR: [
          { vendor: { tenantId: DEFAULT_TENANT } },
          { rider: { user: { tenantId: DEFAULT_TENANT } } },
          { driver: { user: { tenantId: DEFAULT_TENANT } } },
        ],
      };
      const [charges, reconcileMismatches] = await Promise.all([
        app.prisma.billingEvent.findMany({
          where: {
            type: 'CHARGE_SUCCESS',
            createdAt: { gte: since },
            subscription: subscriptionScope,
          },
          select: { amount: true, amountUsd: true },
        }),
        app.prisma.billingEvent.count({
          where: {
            type: 'REMINDER',
            idempotencyKey: { startsWith: 'mismatch:' },
            createdAt: { gte: since },
            subscription: subscriptionScope,
          },
        }),
      ]);
      return {
        localTotal: charges.reduce((total, charge) => total + Number(charge.amount ?? 0), 0),
        usdTotal: charges.reduce((total, charge) => total + Number(charge.amountUsd ?? 0), 0),
        pinnedCharges: charges.filter((charge) => charge.amountUsd !== null).length,
        legacyCharges: charges.filter((charge) => charge.amountUsd === null).length,
        reconcileMismatches,
      };
    });
    const response = await adminRequest('GET', '/api/v1/admin/billing/usd-summary?days=365');
    expect(response.statusCode).toBe(200);
    const weeks = response.json().data.weeks as Array<{
      localTotal: number;
      usdTotal: number;
      pinnedCharges: number;
      legacyCharges: number;
    }>;
    expect(weeks.reduce((total, week) => total + week.localTotal, 0)).toBe(expected.localTotal);
    expect(weeks.reduce((total, week) => total + week.usdTotal, 0)).toBe(expected.usdTotal);
    expect(weeks.reduce((total, week) => total + week.pinnedCharges, 0)).toBe(expected.pinnedCharges);
    expect(weeks.reduce((total, week) => total + week.legacyCharges, 0)).toBe(expected.legacyCharges);
    expect(response.json().data.reconcileMismatches).toBe(expected.reconcileMismatches);
  });

  it('suspenses a tenant-local payment for a foreign SAN without crediting or notifying the foreign holder', async () => {
    const beforeBilling = await foreignBillingState();
    try {
      const response = await adminRequest('POST', '/api/v1/admin/billing/agent-payments', {
        san: TENANT_B_SAN,
        amount: 3_333,
        paidAt: '2026-08-09T15:00:00.000Z',
        receiptNumber: FOREIGN_SAN_RECEIPT,
        verifiedInPortal: true,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        status: 'received_unmatched',
        failureCode: 'SAN_UNKNOWN',
      });
      const payment = await runWithoutTenant(() => app.prisma.mmgAgentPayment.findUniqueOrThrow({
        where: {
          channel_externalId: {
            channel: 'MANUAL_ADMIN',
            externalId: FOREIGN_SAN_EXTERNAL_ID,
          },
        },
      }));
      expect(payment).toMatchObject({
        tenantId: DEFAULT_TENANT,
        status: 'UNMATCHED',
        failureCode: 'SAN_UNKNOWN',
        subscriptionId: null,
      });
      expect(await foreignBillingState()).toEqual(beforeBilling);
    } finally {
      await runWithoutTenant(() => app.prisma.mmgAgentPayment.deleteMany({
        where: { channel: 'MANUAL_ADMIN', externalId: FOREIGN_SAN_EXTERNAL_ID },
      }));
    }
  });

  it('excludes foreign subscription and collection children from billing KPIs', async () => {
    const expected = await runWithoutTenant(async () => {
      const subscriptions = await app.prisma.subscription.findMany({
        where: {
          OR: [
            { vendor: { tenantId: DEFAULT_TENANT } },
            { rider: { user: { tenantId: DEFAULT_TENANT } } },
            { driver: { user: { tenantId: DEFAULT_TENANT } } },
          ],
        },
        select: { id: true, status: true },
      });
      const contacts = await app.prisma.collectionContact.count({
        where: {
          subscriptionId: { in: subscriptions.map((subscription) => subscription.id) },
          createdAt: { gte: new Date(Date.now() - 365 * 86_400_000) },
        },
      });
      const states: Record<string, number> = {};
      for (const subscription of subscriptions) {
        states[subscription.status] = (states[subscription.status] ?? 0) + 1;
      }
      return { contacts, states };
    });
    const response = await adminRequest('GET', '/api/v1/admin/billing/cash-kpis?days=365');
    expect(response.statusCode).toBe(200);
    expect(response.json().data.collections.contacts).toBe(expected.contacts);
    expect(Object.fromEntries(
      response.json().data.subscriptionStates.map((row: { status: string; count: number }) => [row.status, row.count]),
    )).toEqual(expected.states);
    expect(response.json().data.channelMix.map((row: { channel: string }) => row.channel))
      .not.toContain('TENANT_B_PRIVATE');
  });

  it('fails non-default admin top-ups closed before touching receipt counters or money rows', async () => {
    const year = new Date().getUTCFullYear();
    const state = async () => runWithoutTenant(async () => {
      const [counter, balance, events, receipts] = await Promise.all([
        app.prisma.receiptCounter.findUnique({
          where: { tenantId_year: { tenantId: DEFAULT_TENANT, year } },
          select: { seq: true },
        }),
        app.prisma.prepaidBalance.findUnique({
          where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID },
          select: { balance: true, updatedAt: true },
        }),
        app.prisma.billingEvent.count({ where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID } }),
        app.prisma.feeReceipt.count({ where: { subscriptionId: TENANT_B_SUBSCRIPTION_ID } }),
      ]);
      return { counter: counter?.seq ?? null, balance, events, receipts };
    });
    const before = await state();
    const response = await adminRequest(
      'POST',
      `/api/v1/admin/subscriptions/${TENANT_B_SUBSCRIPTION_ID}/topup`,
      { amount: 1_234, reference: 'must-not-reach-default-counter' },
      {
        authorization: `Bearer ${tenantBAdminToken}`,
        'idempotency-key': `${TENANT_B}-non-default-topup`,
      },
    );
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('TENANT_BILLING_UNAVAILABLE');
    expect(await state()).toEqual(before);
  });

  it('does not let a non-default SUPER_ADMIN cross into platform controls', async () => {
    const response = await adminRequest(
      'GET',
      '/api/v1/admin/config',
      undefined,
      { authorization: `Bearer ${tenantBAdminToken}` },
    );
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('keeps global identity, integrity KPIs, and the shared DLQ on the canonical tenant', async () => {
    const nonDefaultHeaders = { authorization: `Bearer ${tenantBAdminToken}` };
    const guardedRequests: Array<{
      method: 'GET' | 'POST' | 'DELETE';
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: 'POST', url: '/api/v1/admin/integrity/backfill' },
      { method: 'GET', url: `/api/v1/admin/integrity/identity/${TENANT_B_ADMIN_USER_ID}` },
      { method: 'GET', url: '/api/v1/admin/integrity/kpis?days=1' },
      { method: 'GET', url: '/api/v1/admin/integrity/appeals' },
      {
        method: 'POST',
        url: '/api/v1/admin/integrity/appeals/nonexistent/resolve',
        payload: { outcome: 'UPHELD', note: 'must not reach global appeal state' },
      },
      {
        method: 'POST',
        url: '/api/v1/admin/integrity/exceptions',
        payload: { clusterId: 'nonexistent', scope: 'FOUNDER_OVERRIDE', note: 'must not reach global identity state' },
      },
      { method: 'GET', url: '/api/v1/admin/dlq' },
      { method: 'POST', url: '/api/v1/admin/dlq/order/nonexistent/requeue' },
      { method: 'DELETE', url: '/api/v1/admin/dlq/order/nonexistent' },
    ];

    for (const guarded of guardedRequests) {
      const response = await adminRequest(
        guarded.method,
        guarded.url,
        guarded.payload,
        nonDefaultHeaders,
      );
      expect(response.statusCode, `${guarded.method} ${guarded.url}`).toBe(403);
      expect(response.json().error.code, `${guarded.method} ${guarded.url}`).toBe('FORBIDDEN');
    }

    // A canonical-tenant SUPER_ADMIN still reaches the platform handlers.
    const identity = await adminRequest('GET', `/api/v1/admin/integrity/identity/${TENANT_B_ADMIN_USER_ID}`);
    expect(identity.statusCode).toBe(200);

    const kpis = await adminRequest('GET', '/api/v1/admin/integrity/kpis?days=1');
    expect(kpis.statusCode).toBe(200);

    // This test host intentionally has no queues. QUEUES_OFFLINE proves the
    // default principal passed authorization and reached the DLQ handler.
    const dlq = await adminRequest('GET', '/api/v1/admin/dlq');
    expect(dlq.statusCode).toBe(503);
    expect(dlq.json().error.code).toBe('QUEUES_OFFLINE');
  });

  it('hides foreign verification documents and rejects their read or decision without side effects', async () => {
    const queue = await adminRequest('GET', '/api/v1/admin/verification/queue?status=PENDING&limit=100');
    expect(queue.statusCode).toBe(200);
    expect(queue.json().data.map((doc: { id: string }) => doc.id)).not.toContain(TENANT_B_VERIFICATION_DOC_ID);

    const beforeDocument = await runWithoutTenant(() => app.prisma.verificationDocument.findUniqueOrThrow({
      where: { id: TENANT_B_VERIFICATION_DOC_ID },
      select: { status: true, reviewedBy: true, reviewedAt: true, expiresAt: true, updatedAt: true },
    }));
    const beforeEffects = await mutationEffects(TENANT_B_VERIFICATION_DOC_ID, TENANT_B_DRIVER_USER_ID);
    expectNotFound(await adminRequest('PUT', `/api/v1/admin/verification/${TENANT_B_VERIFICATION_DOC_ID}/approve`, {}));
    expectNotFound(await adminRequest('GET', `/api/v1/admin/verification/${TENANT_B_VERIFICATION_DOC_ID}/document-url`));

    const afterDocument = await runWithoutTenant(() => app.prisma.verificationDocument.findUniqueOrThrow({
      where: { id: TENANT_B_VERIFICATION_DOC_ID },
      select: { status: true, reviewedBy: true, reviewedAt: true, expiresAt: true, updatedAt: true },
    }));
    expect(afterDocument).toEqual(beforeDocument);
    expect(await mutationEffects(TENANT_B_VERIFICATION_DOC_ID, TENANT_B_DRIVER_USER_ID)).toEqual(beforeEffects);
  });

  it('hides and refuses to pay a foreign reimbursement claim', async () => {
    const queue = await adminRequest('GET', '/api/v1/admin/cash-rules/claims?status=APPROVED&limit=100');
    expect(queue.statusCode).toBe(200);
    expect(queue.json().data.map((claim: { id: string }) => claim.id)).not.toContain(TENANT_B_REIMBURSEMENT_CLAIM_ID);

    const beforeClaim = await runWithoutTenant(() => app.prisma.reimbursementClaim.findUniqueOrThrow({
      where: { id: TENANT_B_REIMBURSEMENT_CLAIM_ID },
      select: { status: true, paidAt: true, paymentRef: true, reviewedBy: true },
    }));
    const beforeEffects = await mutationEffects(TENANT_B_REIMBURSEMENT_CLAIM_ID, TENANT_B_RIDER_USER_ID);
    const response = await adminRequest(
      'PUT',
      `/api/v1/admin/cash-rules/claims/${TENANT_B_REIMBURSEMENT_CLAIM_ID}/paid`,
      // [A-11] an amount is now required; supplied so the request reaches the
      // TENANT check rather than stopping at body validation
      { reference: 'foreign-payout-must-not-run', amount: 1 },
    );
    expectNotFound(response);
    const afterClaim = await runWithoutTenant(() => app.prisma.reimbursementClaim.findUniqueOrThrow({
      where: { id: TENANT_B_REIMBURSEMENT_CLAIM_ID },
      select: { status: true, paidAt: true, paymentRef: true, reviewedBy: true },
    }));
    expect(afterClaim).toEqual(beforeClaim);
    expect(await mutationEffects(TENANT_B_REIMBURSEMENT_CLAIM_ID, TENANT_B_RIDER_USER_ID)).toEqual(beforeEffects);
  });

  it('lists audit rows only for actors belonging to the authenticated tenant', async () => {
    const localAdmin = await runWithoutTenant(() => app.prisma.user.findUniqueOrThrow({
      where: { phone: '+5926001000' },
      select: { id: true },
    }));
    const localAuditId = `${TENANT_B}-default-audit-${nanoid(6)}`;
    await runWithoutTenant(() => app.prisma.auditLog.create({
      data: {
        id: localAuditId,
        userId: localAdmin.id,
        action: 'DEFAULT_TENANT_PRIVATE_AUDIT',
        entity: 'Subscription',
        entityId: 'default-private-entity',
        changes: { amount: 123 },
      },
    }));
    try {
      const defaultView = await adminRequest('GET', '/api/v1/admin/audit-logs?action=TENANT_B_PRIVATE_AUDIT');
      expect(defaultView.statusCode).toBe(200);
      expect(defaultView.json().data.map((row: { id: string }) => row.id)).not.toContain(TENANT_B_AUDIT_LOG_ID);
      expectNotFound(await adminRequest(
        'GET',
        `/api/v1/admin/audit-logs?userId=${encodeURIComponent(TENANT_B_ADMIN_USER_ID)}`,
      ));

      const tenantBView = await adminRequest(
        'GET',
        '/api/v1/admin/audit-logs?action=DEFAULT_TENANT_PRIVATE_AUDIT',
        undefined,
        { authorization: `Bearer ${tenantBAdminToken}` },
      );
      expect(tenantBView.statusCode).toBe(200);
      expect(tenantBView.json().data.map((row: { id: string }) => row.id)).not.toContain(localAuditId);

      const tenantBOwnView = await adminRequest(
        'GET',
        '/api/v1/admin/audit-logs?action=TENANT_B_PRIVATE_AUDIT',
        undefined,
        { authorization: `Bearer ${tenantBAdminToken}` },
      );
      expect(tenantBOwnView.statusCode).toBe(200);
      expect(tenantBOwnView.json().data.map((row: { id: string }) => row.id)).toContain(TENANT_B_AUDIT_LOG_ID);
    } finally {
      await runWithoutTenant(() => app.prisma.auditLog.deleteMany({ where: { id: localAuditId } }));
    }
  });

  it('rejects foreign compliance decisions and fails non-default audit runs closed', async () => {
    const state = async () => runWithoutTenant(async () => ({
      review: await app.prisma.complianceReviewCase.findUniqueOrThrow({
        where: { id: TENANT_B_COMPLIANCE_REVIEW_ID },
        select: { status: true, decidedBy: true, decidedAt: true, note: true },
      }),
      driver: await app.prisma.driver.findUniqueOrThrow({
        where: { id: TENANT_B_DRIVER_ID },
        select: { isOnline: true, updatedAt: true },
      }),
      notifications: await app.prisma.notification.count({ where: { userId: TENANT_B_DRIVER_USER_ID } }),
      runs: await app.prisma.complianceAuditRun.count(),
    }));
    const before = await state();
    expectNotFound(await adminRequest(
      'POST',
      `/api/v1/admin/compliance/reviews/${TENANT_B_COMPLIANCE_REVIEW_ID}/decide`,
      { pass: false, note: 'foreign review must not run' },
    ));

    const nonDefaultRun = await adminRequest(
      'POST',
      '/api/v1/admin/compliance/run',
      {},
      { authorization: `Bearer ${tenantBAdminToken}` },
    );
    expect(nonDefaultRun.statusCode).toBe(503);
    expect(nonDefaultRun.json().error.code).toBe('TENANT_COMPLIANCE_UNAVAILABLE');
    expect(await state()).toEqual(before);
  });

  it('does not include another tenant in the finance revenue aggregate', async () => {
    const beforeResponse = await adminRequest('GET', '/api/v1/admin/finance/revenue');
    expect(beforeResponse.statusCode).toBe(200);
    const before = beforeResponse.json().data;

    const orderId = `tenant-finance-${nanoid(8)}`;
    let subscriptionId: string | undefined;
    try {
      await runWithoutTenant(async () => {
        await app.prisma.order.create({
          data: {
            id: orderId,
            tenantId: TENANT_B,
            orderNumber: `TEN-B-${nanoid(8)}`,
            orderType: 'FOOD_DELIVERY',
            customerId: tenantBUserId,
            vendorId: tenantBVendorId,
            status: 'DELIVERED',
            deliveryAddress: 'Tenant B private delivery',
            deliveryLat: 6.8,
            deliveryLng: -58.15,
            subtotalBase: 123_456_789,
            subtotalMarkup: 0, // chk_orders_zero_markup — keep-100%/flat-fee
            subtotalCustomer: 222_222_221,
            deliveryFee: 88_888_888,
            totalAmount: 311_111_109,
            paymentMethod: 'CASH',
          },
        });
        const subscription = await app.prisma.subscription.create({
          data: {
            vendorId: tenantBVendorId,
            type: 'RETAIL_STORE',
            status: 'ACTIVE',
            weeklyRate: 77_777_777,
            currentPeriodStart: new Date(),
            currentPeriodEnd: new Date(Date.now() + 7 * 86_400_000),
            nextBillingDate: new Date(Date.now() + 7 * 86_400_000),
          },
        });
        subscriptionId = subscription.id;
      });

      const afterResponse = await adminRequest('GET', '/api/v1/admin/finance/revenue');
      expect(afterResponse.statusCode).toBe(200);
      expect(afterResponse.json().data).toEqual(before);
    } finally {
      await runWithoutTenant(async () => {
        if (subscriptionId) await app.prisma.subscription.deleteMany({ where: { id: subscriptionId } });
        await app.prisma.order.deleteMany({ where: { id: orderId } });
      });
    }
  });
});

describe('background engine output stays inside the tenant [REPORT-014 F-014-03]', () => {
  it('a tenant-scoped notifyAdmins pages that tenant + SUPER_ADMIN, never a foreign tenant admin', async () => {
    const suffix = nanoid(6).toLowerCase();
    const foreignTenant = `notify-b-${suffix}`;
    const ids: string[] = [];
    try {
      const [adminDefault, adminForeign, superFounder] = await runWithoutTenant(async () => {
        await app.prisma.tenant.upsert({
          where: { id: foreignTenant },
          update: {},
          create: { id: foreignTenant, name: 'Notify B', slug: foreignTenant },
        });
        const a = await app.prisma.user.create({ data: { phone: `+59277${suffix.replace(/\D/g, '9').padEnd(5, '1').slice(0, 5)}1`, firstName: 'Adm', lastName: 'Default', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, tenantId: 'swift-default' } });
        const b = await app.prisma.user.create({ data: { phone: `+59277${suffix.replace(/\D/g, '9').padEnd(5, '1').slice(0, 5)}2`, firstName: 'Adm', lastName: 'Foreign', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, tenantId: foreignTenant } });
        const f = await app.prisma.user.create({ data: { phone: `+59277${suffix.replace(/\D/g, '9').padEnd(5, '1').slice(0, 5)}3`, firstName: 'Founder', lastName: 'Eye', roles: ['SUPER_ADMIN'], activeRole: 'SUPER_ADMIN', isPhoneVerified: true, tenantId: 'swift-default' } });
        return [a, b, f];
      });
      ids.push(adminDefault.id, adminForeign.id, superFounder.id);

      // The worker shape: NO tenant ALS — exactly the F-014-03 scenario.
      const notifications = new NotificationService(app.prisma, app.io);
      await runWithoutTenant(() => notifyAdmins(app.prisma, notifications, {
        title: 'Dispatch exhausted — no mover found',
        body: `Order NOTIFY-${suffix} found no mover after all retries. Check mover supply and dispatch health.`,
        data: { kind: 'ops_dispatch_exhausted' },
        tenantId: foreignTenant,
      }));

      const rows = await runWithoutTenant(() => app.prisma.notification.findMany({
        where: { userId: { in: ids }, body: { contains: `NOTIFY-${suffix}` } },
        select: { userId: true },
      }));
      const paged = new Set(rows.map((r) => r.userId));
      expect(paged.has(adminForeign.id)).toBe(true); // the event's tenant
      expect(paged.has(superFounder.id)).toBe(true); // founder god's-eye always
      expect(paged.has(adminDefault.id)).toBe(false); // FOREIGN tenant admin never
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
        await app.prisma.alertDelivery.deleteMany({ where: { recipientId: { in: ids } } });
        await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
        await app.prisma.tenant.deleteMany({ where: { id: foreignTenant } });
      });
    }
  });
});
