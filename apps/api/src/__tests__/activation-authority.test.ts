import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ownedVerificationFixture } from './helpers/verification-object';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { VerificationService } from '../modules/verification/verification.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getKycProvider } from '../providers/kyc/kyc-provider';
import { loginWithOtp } from './helpers/otp';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { cleanupBillingClocks } from './helpers/billing-clock-cleanup';
import type { Prisma } from '@prisma/client';
import { lockBillingAuthority, readDunningClock } from '../modules/billing/dunning-clock';
import { restoreBillingAccess } from '../modules/billing/billing-access';

// ---------------------------------------------------------------------------
// [ACTIVATION AUTHORITY — task #2 slice 1] Document truth drives activation:
//   STRAND-1  checklist completion IS vendor activation (PENDING_APPROVAL →
//             ACTIVE in the SAME decision transaction — no second admin event);
//   EV-ACT-11 admin vendor approve is checklist-gated + CAS;
//   EV-ACT-15 admin mover verify is checklist-gated; a negative decision
//             revokes live supply atomically;
//   STRAND-3  commercial classes: BUS needs its commercial documents at the
//             live gate, and can actually SUBMIT them (the old CAR-hard-coded
//             list made road_service_licence unsubmittable).
// SUPERMARKET checklist (GY): owner_national_id, business_registration,
// tin_certificate, storefront_photo. MOTORCYCLE mover checklist: national_id,
// police_clearance, drivers_licence, vehicle_registration, vehicle_insurance.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let svc: VerificationService;
let adminToken: string;
const marker = nanoid(6).toLowerCase();
const userIds: string[] = [];
let seq = 0;

const SUPERMARKET_DOCS = ['owner_national_id', 'business_registration', 'tin_certificate', 'storefront_photo'];
const MOTORCYCLE_DOCS = ['national_id', 'police_clearance', 'drivers_licence', 'vehicle_registration', 'vehicle_insurance'];

async function makeUser(first: string) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59267${String((marker.charCodeAt(0) + seq) % 10)}${String(seq).padStart(4, '0')}`,
      firstName: first, lastName: `Act${seq}`,
      roles: ['VENDOR_OWNER', 'MOVER', 'CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true, countryCode: 'GY',
    },
  });
  userIds.push(user.id);
  return user;
}

async function approvedDoc(userId: string, docType: string, extra: Record<string, unknown> = {}) {
  return app.prisma.verificationDocument.create({
    data: {
      userId, role: 'VENDOR_OWNER' as never, docType, fileUrl: `test/${marker}/${docType}`,
      status: 'APPROVED', expiresAt: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      ...extra,
    } as never,
  });
}

async function makePendingVendor(ownerUserId: string, status: 'PENDING_APPROVAL' | 'SUSPENDED' = 'PENDING_APPROVAL') {
  seq += 1;
  const vo = await app.prisma.vendorOwner.upsert({
    where: { userId: ownerUserId },
    update: {},
    create: { userId: ownerUserId },
  });
  return app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Act Mart ${seq}`, slug: `act-mart-${marker}-${seq}`, vendorType: 'SUPERMARKET',
      phone: `+59268${String(seq).padStart(5, '0')}`, addressLine1: '1 Activation St', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status, isVerified: false, acceptingOrders: false,
    },
  });
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
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  svc = new VerificationService(app.prisma, new NotificationService(app.prisma, app.io), getKycProvider());
  const admin = await loginWithOtp(app, '+5926001000');
  adminToken = admin.json().data.tokens.accessToken;
});

afterAll(async () => {
  if (userIds.length > 0) {
    await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: userIds } } });
    // Collect the payers' subscriptions before the payers go (a removed owner leaves the row unreachable by relation).
    const subIds = (await app.prisma.subscription.findMany({ where: { OR: [{ rider: { userId: { in: userIds } } }, { driver: { userId: { in: userIds } } }, { vendor: { owner: { userId: { in: userIds } } } }] }, select: { id: true } })).map((s) => s.id);
    await cleanupBillingClocks(app.prisma, subIds);
    // A mover payer's fee authority and sources survive while the payer does: remove the payer first.
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: userIds } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('STRAND-1 — checklist completion IS vendor activation, atomically', () => {
  it('the final document approval promotes PENDING_APPROVAL → ACTIVE in the same decision', async () => {
    const owner = await makeUser('Strand');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS.slice(0, 3)) await approvedDoc(owner.id, docType);
    const last = await app.prisma.verificationDocument.create({
      data: {
        userId: owner.id, role: 'VENDOR_OWNER' as never, docType: 'storefront_photo',
        fileUrl: `test/${marker}/storefront`, status: 'PENDING',
      },
    });

    await svc.approveDocument(last.id, 'admin-test', new Date(Date.now() + 365 * 24 * 3600 * 1000));

    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    // The strand is dead: no admin /approve call, no billing event — the
    // completed, individually-reviewed checklist activated the store.
    expect(fresh.status).toBe('ACTIVE');
    expect(fresh.isVerified).toBe(true);
    expect(fresh.acceptingOrders).toBe(true);
  });

  it('promotion is PENDING_APPROVAL-only: a SUSPENDED store gains the flag, never status', async () => {
    const owner = await makeUser('Susp');
    const vendor = await makePendingVendor(owner.id, 'SUSPENDED');
    for (const docType of SUPERMARKET_DOCS.slice(0, 3)) await approvedDoc(owner.id, docType);
    const last = await app.prisma.verificationDocument.create({
      data: {
        userId: owner.id, role: 'VENDOR_OWNER' as never, docType: 'storefront_photo',
        fileUrl: `test/${marker}/storefront2`, status: 'PENDING',
      },
    });
    await svc.approveDocument(last.id, 'admin-test', new Date(Date.now() + 365 * 24 * 3600 * 1000));
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.isVerified).toBe(true);
    expect(fresh.status).toBe('SUSPENDED'); // admin/billing own that lifecycle
  });

  it('a rejected required document de-verifies the cached flag in the same decision', async () => {
    const owner = await makeUser('Deverify');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    // Verify through the projection (any decision run projects):
    const extra = await app.prisma.verificationDocument.create({
      data: { userId: owner.id, role: 'VENDOR_OWNER' as never, docType: 'owner_national_id', fileUrl: `test/${marker}/renewal`, status: 'PENDING' },
    });
    await svc.approveDocument(extra.id, 'admin-test', new Date(Date.now() + 365 * 24 * 3600 * 1000));
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).isVerified).toBe(true);

    // Now the ONLY storefront photo is administratively invalidated: simulate
    // purge (retention) then run any decision for this user — the projection
    // must follow document truth DOWN as well.
    await app.prisma.verificationDocument.updateMany({
      where: { userId: owner.id, docType: 'storefront_photo' },
      data: { purgedAt: new Date(), fileUrl: '' },
    });
    const again = await app.prisma.verificationDocument.create({
      data: { userId: owner.id, role: 'VENDOR_OWNER' as never, docType: 'tin_certificate', fileUrl: `test/${marker}/tin2`, status: 'PENDING' },
    });
    await svc.approveDocument(again.id, 'admin-test', new Date(Date.now() + 365 * 24 * 3600 * 1000));
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.isVerified).toBe(false); // purged evidence no longer counts
  });
});

describe('[#1516 review S4] a store awaiting approval whose weekly fee billing holds', () => {
  const DAY = 86_400_000;
  /** A pending store that already holds a fee subscription in `status`, with
   *  three approved documents and the fourth awaiting review. */
  async function pendingStoreWithFee(status: 'SUSPENDED' | 'CHURNED' | 'ACTIVE', lastApproved = false) {
    const owner = await makeUser(`Fee${status}`);
    const vendor = await makePendingVendor(owner.id);
    const paidThrough = status === 'ACTIVE' ? new Date(Date.now() + 5 * DAY) : new Date(Date.now() - 3 * DAY);
    const sub = await app.prisma.subscription.create({
      data: {
        vendorId: vendor.id, type: 'SUPERMARKET', status, suspendedAt: status === 'ACTIVE' ? null : new Date(Date.now() - DAY),
        weeklyRate: 2100, billingMethod: 'CASH',
        currentPeriodStart: new Date(paidThrough.getTime() - 7 * DAY), currentPeriodEnd: paidThrough, nextBillingDate: paidThrough,
      },
    });
    for (const docType of SUPERMARKET_DOCS.slice(0, 3)) await approvedDoc(owner.id, docType);
    const last = await app.prisma.verificationDocument.create({
      data: { userId: owner.id, role: 'VENDOR_OWNER' as never, docType: 'storefront_photo', fileUrl: `test/${marker}/fee-${status}`, status: lastApproved ? 'APPROVED' : 'PENDING', expiresAt: new Date(Date.now() + 365 * DAY) },
    });
    return { vendor, sub, last };
  }

  it.each(['SUSPENDED', 'CHURNED'] as const)('completing its documents makes it live under that billing hold (fee %s): never open while checkout refuses it, and a payment opens it', async (status) => {
    const { vendor, sub, last } = await pendingStoreWithFee(status);

    await svc.approveDocument(last.id, 'admin-test', new Date(Date.now() + 365 * DAY));

    // The documents count (it is verified), but the store is held exactly as
    // billing holds a live store whose fee went unpaid.
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }))
      .toMatchObject({ isVerified: true, status: 'SUSPENDED', suspensionSource: 'BILLING', acceptingOrders: false });
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(status);

    // The one restore a fee payment runs lifts it like any billing hold.
    expect(await app.prisma.$transaction((tx) => restoreBillingAccess(tx, vendor.id))).toBe(true);
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }))
      .toMatchObject({ status: 'ACTIVE', suspensionSource: null, acceptingOrders: true });
  });

  it.each(['SUSPENDED', 'CHURNED'] as const)('admin approval preserves the unpaid %s hold until settlement reopens intake', async (status) => {
    const { vendor, sub, last } = await pendingStoreWithFee(status);
    await svc.approveDocument(last.id, 'admin-test', new Date(Date.now() + 365 * DAY));
    const response = await app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${vendor.id}/approve`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}` }, payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({ status: 'SUSPENDED', suspensionSource: 'BILLING', acceptingOrders: false });
    await app.prisma.$transaction(async (tx) => {
      await lockBillingAuthority(tx, sub.id);
      await tx.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', suspendedAt: null } });
      expect(await restoreBillingAccess(tx, vendor.id)).toBe(true);
    });
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }))
      .toMatchObject({ status: 'ACTIVE', suspensionSource: null, acceptingOrders: true });
  });

  it('activation waits for a settling payer before reading the fee and writing the store', async () => {
    const { vendor, sub } = await pendingStoreWithFee('SUSPENDED', true);
    const owner = await app.prisma.vendorOwner.findUniqueOrThrow({ where: { id: vendor.ownerId } });
    let releasePayment!: () => void;
    const release = new Promise<void>((resolve) => { releasePayment = resolve; });
    let paymentReady!: () => void;
    const ready = new Promise<void>((resolve) => { paymentReady = resolve; });
    // Hold exactly the payer/subscription locks used by confirmed settlement.
    // Its restore sees the still-pending store and has nothing to reopen.
    const payment = app.prisma.$transaction(async (tx) => {
      await lockBillingAuthority(tx, sub.id);
      await tx.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', suspendedAt: null } });
      expect(await restoreBillingAccess(tx, vendor.id)).toBe(false);
      paymentReady();
      await release;
    }, { timeout: 15000 });
    await ready;
    let activationDone = false;
    let activationPid = 0;
    const activation = app.prisma.$transaction(async (tx) => {
      const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      activationPid = backend!.pid;
      // This is the projection transaction used by the daily replay.
      await (svc as unknown as { projectVendorActivation(db: Prisma.TransactionClient, userId: string): Promise<void> })
        .projectVendorActivation(tx, owner.userId);
    }, { timeout: 15000 }).finally(() => { activationDone = true; });
    let blocked = false;
    try {
      const deadline = Date.now() + 4000;
      while (!activationDone && !blocked && Date.now() < deadline) {
        if (activationPid) {
          const [row] = await app.prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT cardinality(pg_blocking_pids(${activationPid}::int)) > 0 AS blocked`;
          blocked = row!.blocked;
        }
        if (!blocked && !activationDone) await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      releasePayment();
      await Promise.all([payment, activation]);
    }
    expect(await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).toMatchObject({ status: 'ACTIVE' });
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }))
      .toMatchObject({ status: 'ACTIVE', isVerified: true, suspensionSource: null, acceptingOrders: true });
    expect(blocked).toBe(true);
  });

  it('a pending store whose fee is in good standing goes live as before', async () => {
    const { vendor, last } = await pendingStoreWithFee('ACTIVE');
    await svc.approveDocument(last.id, 'admin-test', new Date(Date.now() + 365 * DAY));
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }))
      .toMatchObject({ isVerified: true, status: 'ACTIVE', suspensionSource: null, acceptingOrders: true });
  });
});

describe('STRAND-2 belt — the daily reconciler heals projection drift', () => {
  it('a stranded pre-cutover vendor (checklist complete, still PENDING_APPROVAL) is promoted by the reconciler', async () => {
    const owner = await makeUser('Heal');
    const vendor = await makePendingVendor(owner.id);
    // Complete evidence exists but NO decision transaction ever ran for it —
    // the exact shape a pre-slice-1 crash (or manual import) leaves behind.
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);

    const healed = await svc.reconcileVendorActivations();
    expect(healed).toBeGreaterThanOrEqual(1);
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.status).toBe('ACTIVE');
    expect(fresh.isVerified).toBe(true);
    expect(fresh.acceptingOrders).toBe(true);
  });

  it('a stale isVerified flag over purged evidence is revoked by the reconciler', async () => {
    const owner = await makeUser('Drift');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    await app.prisma.vendor.update({ where: { id: vendor.id }, data: { status: 'ACTIVE', isVerified: true } });
    // Evidence dies outside any decision path (retention purge).
    await app.prisma.verificationDocument.updateMany({
      where: { userId: owner.id, docType: 'business_registration' },
      data: { purgedAt: new Date(), fileUrl: '' },
    });
    await svc.reconcileVendorActivations();
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.isVerified).toBe(false); // cache follows document truth down
    expect(fresh.status).toBe('ACTIVE'); // lifecycle stays admin/billing-owned
  });
});

describe('F-012-05 — one authority generation [REPORT-012]', () => {
  it('a negative projection revokes ORDERING, not just the verified flag', async () => {
    const owner = await makeUser('Neg');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    await svc.reconcileVendorActivations();
    let fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.acceptingOrders).toBe(true);

    // Evidence dies outside any decision path (retention purge shape)…
    await app.prisma.verificationDocument.updateMany({
      where: { userId: owner.id, docType: 'business_registration' },
      data: { purgedAt: new Date(), fileUrl: '' },
    });
    await svc.reconcileVendorActivations();
    fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.isVerified).toBe(false);
    // …and ordering falls WITH the flag. Before this fix the checkout gate
    // (status/open/acceptingOrders — it never reads isVerified) kept an
    // existing cart sellable after document authority was revoked.
    expect(fresh.acceptingOrders).toBe(false);
  });

  it('document expiry closes the store in the SAME transaction — no later-sweep window', async () => {
    const owner = await makeUser('Exp');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    await svc.reconcileVendorActivations();

    await app.prisma.verificationDocument.updateMany({
      where: { userId: owner.id, docType: 'tin_certificate' },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await svc.expireLapsedDocuments();
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    // The vendor projection rode the expiry transaction itself.
    expect(fresh.isVerified).toBe(false);
    expect(fresh.acceptingOrders).toBe(false);
  });

  it('toggle-ON trusts LIVE document truth, never the cached flag — and heals a discovered stale-true', async () => {
    const owner = await makeUser('Stale');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    await svc.reconcileVendorActivations(); // → ACTIVE / verified / accepting

    // Evidence dies by a path whose projection never landed (the stale-flag
    // shape REPORT-012 exploited), while the owner had commerce paused.
    await app.prisma.vendor.update({ where: { id: vendor.id }, data: { acceptingOrders: false } });
    await app.prisma.verificationDocument.updateMany({
      where: { userId: owner.id, docType: 'storefront_photo' },
      data: { purgedAt: new Date(), fileUrl: '' },
    });
    const cached = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(cached.isVerified).toBe(true); // the lie this test kills

    await app.prisma.user.update({ where: { id: owner.id }, data: { activeRole: 'VENDOR_OWNER' as never } });
    const login = await loginWithOtp(app, owner.phone);
    const token = login.json().data.tokens.accessToken;
    const on = await app.inject({
      method: 'PUT', url: '/api/v1/vendor/vendor/toggle-orders',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(on.statusCode).toBe(403);
    expect(on.json().error.code).toBe('VERIFICATION_REQUIRED');
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.isVerified).toBe(false); // healed atomically, in the refused tx
    expect(fresh.acceptingOrders).toBe(false);
  });

  it('a PAST_DUE store whose grace lapsed cannot toggle ON — pure wall-clock, no competing writer', async () => {
    const owner = await makeUser('Grace');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    await svc.reconcileVendorActivations();
    await app.prisma.vendor.update({ where: { id: vendor.id }, data: { acceptingOrders: false } });
    // [SAFE-B] Activation starts the store's trial in the same transaction (and identity lock) as the activation
    // itself, so the store already holds its one subscription: it lapses into PAST_DUE with the grace over.
    // [#1393] The owner's grace is 48 hours of unpaused overdue time on the
    // shared clock: due 48 hours and a minute ago, it ran out a minute ago.
    const due = new Date(Date.now() - 2 * 86_400_000 - 60_000);
    const trial = await app.prisma.subscription.findUniqueOrThrow({ where: { vendorId: vendor.id } });
    const lapsed = await app.prisma.subscription.update({
      where: { id: trial.id },
      data: {
        status: 'PAST_DUE', weeklyRate: 20000,
        billingMethod: 'CASH', isInGracePeriod: true,
        gracePeriodEnd: new Date(Date.now() - 60_000),
        currentPeriodStart: new Date(due.getTime() - 7 * 86_400_000),
        currentPeriodEnd: due,
        nextBillingDate: due,
      },
    });
    await readDunningClock(app.prisma, lapsed.id);

    await app.prisma.user.update({ where: { id: owner.id }, data: { activeRole: 'VENDOR_OWNER' as never } });
    const login = await loginWithOtp(app, owner.phone);
    const token = login.json().data.tokens.accessToken;
    const on = await app.inject({
      method: 'PUT', url: '/api/v1/vendor/vendor/toggle-orders',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(on.statusCode).toBe(403);
    expect(on.json().error.code).toBe('SUBSCRIPTION_PAST_DUE');
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).acceptingOrders).toBe(false);
  });
});

describe('EV-ACT-11 — admin vendor approve is checklist-gated and exactly-once', () => {
  it('refuses to activate a store whose checklist is incomplete (409 CHECKLIST_INCOMPLETE)', async () => {
    const owner = await makeUser('Gate');
    const vendor = await makePendingVendor(owner.id);
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${vendor.id}/approve`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` }, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error?.code ?? res.json().code).toBe('CHECKLIST_INCOMPLETE');
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.status).toBe('PENDING_APPROVAL');
    expect(fresh.isVerified).toBe(false);
  });

  it('[Fable #1481 S4-2] approving a billing-suspended store clears its suspension source (no stale BILLING for a later heal)', async () => {
    const owner = await makeUser('Reinstate');
    const vendor = await makePendingVendor(owner.id, 'SUSPENDED');
    await app.prisma.vendor.update({ where: { id: vendor.id }, data: { suspensionSource: 'BILLING' } });
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    const ok = await app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${vendor.id}/approve`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` }, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).toMatchObject({ status: 'ACTIVE', suspensionSource: null });
  });

  it('activates once the checklist is complete; a double-tap has exactly one winner', async () => {
    const owner = await makeUser('Approve');
    const vendor = await makePendingVendor(owner.id);
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    const ok = await app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${vendor.id}/approve`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` }, payload: {} });
    expect(ok.statusCode).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).status).toBe('ACTIVE');

    const dup = await app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${vendor.id}/approve`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}` }, payload: {} });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().error?.code ?? dup.json().code).toBe('ALREADY_ACTIVE');
  });
});

describe('EV-ACT-15 — admin mover verify is checklist-gated; rejection revokes supply atomically', () => {
  it('cannot bless a rider with missing evidence; verifies once the checklist is current', async () => {
    const user = await makeUser('Rider');
    const rider = await app.prisma.rider.create({
      data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: false },
    });

    const refused = await app.inject({
      method: 'PUT', url: `/api/v1/admin/riders/${rider.id}/verify-documents`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error?.code ?? refused.json().code).toBe('CHECKLIST_INCOMPLETE');
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).documentsVerified).toBe(false);

    for (const docType of MOTORCYCLE_DOCS) await approvedDoc(user.id, docType);
    const ok = await app.inject({
      method: 'PUT', url: `/api/v1/admin/riders/${rider.id}/verify-documents`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { },
    });
    expect(ok.statusCode).toBe(200);
    expect((await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } })).documentsVerified).toBe(true);
  });

  it('a negative decision forces an online rider offline in the same write', async () => {
    const user = await makeUser('Revoke');
    const rider = await app.prisma.rider.create({
      data: {
        userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
        documentsVerified: true, isOnline: true, isAvailable: true, locationSessionId: `sess-${marker}`,
      },
    });
    const res = await app.inject({
      method: 'PUT', url: `/api/v1/admin/riders/${rider.id}/verify-documents`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON,  authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      payload: { verified: false, rejectionReason: 'plate mismatch' },
    });
    expect(res.statusCode).toBe(200);
    const fresh = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(fresh.documentsVerified).toBe(false);
    expect(fresh.isOnline).toBe(false); // no dispatchable window until the daily sweep
    expect(fresh.locationSessionId).toBeNull();
  });
});

describe('STRAND-3 — commercial classes carry their own checklist', () => {
  it('a BUS_9 with only the taxi-car documents is not live; adding commercial docs completes it', async () => {
    const user = await makeUser('Bus');
    await app.prisma.driver.create({
      data: { userId: user.id, vehicleType: 'BUS_9' as never, documentsVerified: false, vehicleMake: 'Toyota', vehicleModel: 'Hiace', vehicleYear: 2022, vehicleColor: 'White', licensePlate: `BUS-${marker}-1`, driverLicenseUrl: 'test/lic1', vehicleInsuranceUrl: 'test/ins1' },
    });
    // Everything a CAR taxi needs, including confirmed HIRE insurance…
    const carDocs = ['national_id', 'police_clearance', 'drivers_licence', 'vehicle_registration',
      'hire_car_permit', 'vehicle_plate_photo', 'vehicle_exterior_photo', 'fitness_cert'];
    for (const docType of carDocs) await approvedDoc(user.id, docType);
    await approvedDoc(user.id, 'vehicle_insurance', {
      insurerName: 'GY Assure', policyNumber: `P-${marker}`, coverageClass: 'HIRE',
      hireClassConfirmed: true, plateCrossChecked: true,
    });

    // …is still NOT enough for a bus: the commercial checklist binds.
    const withoutCommercial = await svc.getLiveOperationStatus(user.id, { vehicleType: 'BUS_9' as never });
    expect(withoutCommercial.allowed).toBe(false);
    expect(withoutCommercial.reason).toBe('docs');

    await approvedDoc(user.id, 'road_service_licence');
    const withCommercial = await svc.getLiveOperationStatus(user.id, { vehicleType: 'BUS_9' as never });
    expect(withCommercial.allowed).toBe(true);
  });

  it('submitDocument accepts commercial types for a commercial mover and refuses them for a motorcycle', async () => {
    const busUser = await makeUser('BusSubmit');
    await app.prisma.driver.create({ data: { userId: busUser.id, vehicleType: 'BUS_9' as never, documentsVerified: false, vehicleMake: 'Toyota', vehicleModel: 'Hiace', vehicleYear: 2022, vehicleColor: 'White', licensePlate: `BUS-${marker}-2`, driverLicenseUrl: 'test/lic2', vehicleInsuranceUrl: 'test/ins2' } });
    // The union checklist admits the type (the old CAR-only list threw
    // INVALID_DOC_TYPE and made buses impossible to onboard).
    await expect(
      svc.submitDocument(busUser.id, 'MOVER', 'road_service_licence', await ownedVerificationFixture(app.prisma, busUser.id), 'test-v1'),
    ).resolves.toBeTruthy();

    const bikeUser = await makeUser('BikeSubmit');
    await app.prisma.rider.create({ data: { userId: bikeUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: false } });
    await expect(
      svc.submitDocument(bikeUser.id, 'MOVER', 'road_service_licence', await ownedVerificationFixture(app.prisma, bikeUser.id), 'test-v1'),
    ).rejects.toMatchObject({ code: 'INVALID_DOC_TYPE' });
  });
});
