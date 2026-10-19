import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SubscriptionService } from '../modules/subscription/subscription.service';
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
// storefront_photo ([VERIFY-DOCS · ruling 7] no TIN certificate). MOTORCYCLE mover checklist [VERIFY-DOCS, 6 Oct
// 2026]: drivers_licence, vehicle_registration, vehicle_insurance (national ID and
// police clearance are optional for a licence holder).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let svc: VerificationService;
let adminToken: string;
const marker = nanoid(6).toLowerCase();
const userIds: string[] = [];
let seq = 0;

const SUPERMARKET_DOCS = ['owner_national_id', 'business_registration', 'storefront_photo'];
const MOTORCYCLE_DOCS = ['drivers_licence', 'vehicle_registration', 'vehicle_insurance'];

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
      // [owner #51, 14 Oct] A store's first go-live needs a published contact
      // phone; these stores have one so the documents alone decide here.
      publicPhone: '+5926001100',
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
      data: { userId: owner.id, role: 'VENDOR_OWNER' as never, docType: 'business_registration', fileUrl: `test/${marker}/reg2`, status: 'PENDING' },
    });
    await svc.approveDocument(again.id, 'admin-test', new Date(Date.now() + 365 * 24 * 3600 * 1000));
    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } });
    expect(fresh.isVerified).toBe(false); // purged evidence no longer counts
  });
});

describe('[#1541] a store awaiting approval whose weekly fee billing holds goes live UNDER that hold', () => {
  const DAY = 86_400_000;
  const HELD_TITLE = 'Documents approved';
  /** A pending store that already holds a fee subscription in `status`, its three documents approved and,
   *  when `awaiting`, a fourth (a second storefront photo) awaiting review: approving that one is the
   *  activation edge. Without it the checklist is complete and nothing has projected it yet. */
  async function pendingStoreWithFee(status: 'SUSPENDED' | 'CHURNED' | 'ACTIVE', tag: string, awaiting = true) {
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
    for (const docType of SUPERMARKET_DOCS) await approvedDoc(owner.id, docType);
    const last = awaiting ? await app.prisma.verificationDocument.create({
      data: { userId: owner.id, role: 'VENDOR_OWNER' as never, docType: 'storefront_photo', fileUrl: `test/${marker}/fee-${tag}`, status: 'PENDING' },
    }) : null;
    return { owner, vendor, sub, last: last! };
  }
  const notices = (userId: string) => app.prisma.notification.findMany({ where: { userId }, select: { title: true, body: true, data: true } });
  /** A confirmed fee payment, as settlement runs it: payer + subscription locked, the fee in good standing, the one restore. */
  const pay = (subId: string, vendorId: string) => app.prisma.$transaction(async (tx) => {
    await lockBillingAuthority(tx, subId);
    await tx.subscription.update({ where: { id: subId }, data: { status: 'ACTIVE', suspendedAt: null } });
    return restoreBillingAccess(tx, vendorId);
  });

  it.each(['SUSPENDED', 'CHURNED'] as const)('document path: completing its documents makes it live under billing\'s hold (fee %s), tells the owner once, and the payment opens it', async (status) => {
    const { owner, vendor, sub, last } = await pendingStoreWithFee(status, `doc-${status}`);

    await svc.approveDocument(last.id, 'admin-test', new Date(Date.now() + 365 * DAY));

    // Its documents count (verified), but it is held exactly as billing holds a live store whose fee went unpaid.
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }))
      .toMatchObject({ isVerified: true, status: 'SUSPENDED', suspensionSource: 'BILLING', acceptingOrders: false });
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(status);
    const told = (await notices(owner.id)).filter((n) => n.title === HELD_TITLE);
    expect(told).toHaveLength(1);
    expect(told[0]!.body).toContain('Pay the weekly fee to open');
    expect(told[0]!.data).toEqual({ vendorId: vendor.id });

    // The daily belt re-projects it (the same per-owner projection): it stays held, and the owner is not told again.
    await svc.reprojectVendorActivation(owner.id);
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }))
      .toMatchObject({ status: 'SUSPENDED', suspensionSource: 'BILLING', acceptingOrders: false });
    expect((await notices(owner.id)).filter((n) => n.title === HELD_TITLE)).toHaveLength(1);

    // The one restore a fee payment runs lifts it like any billing hold.
    expect(await pay(sub.id, vendor.id)).toBe(true);
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }))
      .toMatchObject({ status: 'ACTIVE', suspensionSource: null, acceptingOrders: true, isVerified: true });
  });

  it.each(['SUSPENDED', 'CHURNED'] as const)('console approve: the store goes live under the unpaid %s hold, the reply says so, one notice, and approving again is refused until the fee is paid', async (status) => {
    const { owner, vendor, sub } = await pendingStoreWithFee(status, `admin-${status}`, false);
    // Every document approved, the projection not run yet: the console's button is the activation edge.
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } })).status).toBe('PENDING_APPROVAL');

    const approve = () => app.inject({
      method: 'PUT', url: `/api/v1/admin/vendors/${vendor.id}/approve`,
      headers: { 'x-swift-reason': TEST_ADMIN_REASON, authorization: `Bearer ${adminToken}` }, payload: {},
    });
    const res = await approve();
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ status: 'SUSPENDED', suspensionSource: 'BILLING', acceptingOrders: false, isVerified: true });
    expect((await app.prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe(status);
    const titles = (await notices(owner.id)).map((n) => n.title);
    expect(titles.filter((t) => t === HELD_TITLE)).toHaveLength(1);
    expect(titles).not.toContain('Vendor Approved!');

    // Billing owns it now: the console cannot reopen it over the unpaid fee.
    const again = await approve();
    expect(again.statusCode).toBe(409);
    expect(again.json().error?.code ?? again.json().code).toBe('FEE_UNPAID');

    expect(await pay(sub.id, vendor.id)).toBe(true);
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }))
      .toMatchObject({ status: 'ACTIVE', suspensionSource: null, acceptingOrders: true });
  });

  it.each(['settled', 'payer-only'] as const)('the activation waits for a settling payer before it reads the fee or writes the store (%s), and ends open', async (stage) => {
    const { owner, vendor, sub } = await pendingStoreWithFee('SUSPENDED', `lock-${stage}`, false);
    let releasePayment!: () => void;
    const release = new Promise<void>((resolve) => { releasePayment = resolve; });
    let paymentReady!: () => void;
    const ready = new Promise<void>((resolve) => { paymentReady = resolve; });
    // Settlement, holding exactly its own locks. 'payer-only' stops after the payer: an activation that took
    // a subscription before its payer would deadlock here when settlement moves on to the subscription.
    const payment = app.prisma.$transaction(async (tx) => {
      if (stage === 'payer-only') {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${owner.id} FOR UPDATE`;
        paymentReady();
        await release;
      }
      await lockBillingAuthority(tx, sub.id);
      await tx.subscription.update({ where: { id: sub.id }, data: { status: 'ACTIVE', suspendedAt: null } });
      // The store is still pending: settlement has no billing hold to lift.
      const lifted = await restoreBillingAccess(tx, vendor.id);
      if (stage === 'settled') {
        paymentReady();
        await release;
      }
      return lifted;
    }, { timeout: 20_000 });
    await ready;
    // The daily belt's own path: its projection transaction.
    const activation = svc.reprojectVendorActivation(owner.id);
    let blocked = false;
    try {
      const deadline = Date.now() + 8000;
      while (!blocked && Date.now() < deadline) {
        const rows = await app.prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE '%vendor-activation-fee-payer%' AND query NOT LIKE '%pg_stat_activity%'`;
        blocked = rows[0]!.n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      releasePayment();
    }
    const outcomes = await Promise.allSettled([payment, activation]);
    expect(outcomes.map((o) => o.status), 'settlement and activation both commit, no lock-order deadlock').toEqual(['fulfilled', 'fulfilled']);
    expect(blocked, 'the activation waited at the payer lock').toBe(true);
    expect((outcomes[0] as PromiseFulfilledResult<boolean>).value).toBe(false);
    // The activation ran after the payment committed: it saw the fee paid and opened the store itself.
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }))
      .toMatchObject({ status: 'ACTIVE', isVerified: true, suspensionSource: null, acceptingOrders: true });
    expect((await notices(owner.id)).filter((n) => n.title === HELD_TITLE)).toHaveLength(0);
  });

  it('a pending store whose fee is in good standing goes live as before, with no fee notice', async () => {
    const { owner, vendor, last } = await pendingStoreWithFee('ACTIVE', 'good');
    await svc.approveDocument(last.id, 'admin-test', new Date(Date.now() + 365 * DAY));
    expect(await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendor.id } }))
      .toMatchObject({ isVerified: true, status: 'ACTIVE', suspensionSource: null, acceptingOrders: true });
    expect((await notices(owner.id)).filter((n) => n.title === HELD_TITLE)).toHaveLength(0);
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
      // [VERIFY-DOCS · ruling 7] the TIN certificate is on no list any more; the registration still has to be current
      where: { userId: owner.id, docType: 'business_registration' },
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

  it('[Fable #1481 S4-2] a grandfathered store with no subscription clears its stale billing suspension', async () => {
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

  // [S2-29 · KYC-DECISION-ATOMIC] The trial decision must follow the reviewer-typed identity capture
  // (system login, own transaction), so the approval commits an outbox row that owes it. A failed
  // trial start never fails the committed approval; the sweep starts the trial exactly once.
  it('[S2-29] a failed trial start never fails the approval: the decision owes it, and the sweep starts it once', async () => {
    const user = await makeUser('Owed');
    const rider = await app.prisma.rider.create({
      data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: false },
    });
    for (const docType of MOTORCYCLE_DOCS.filter((d) => d !== 'drivers_licence')) await approvedDoc(user.id, docType);
    const last = await app.prisma.verificationDocument.create({
      data: { userId: user.id, role: 'VENDOR_OWNER' as never, docType: 'drivers_licence', fileUrl: `test/${marker}/licence-owed`, status: 'PENDING' },
    });
    const fault = vi.spyOn(SubscriptionService.prototype, 'startTrialForRider').mockRejectedValueOnce(new Error('synthetic fault: the trial start fails after the decision'));
    let hit = 0;
    try {
      await svc.approveDocument(last.id, 'admin-test', new Date(Date.now() + 365 * 24 * 3600 * 1000));
      hit = fault.mock.calls.length;
    } finally { fault.mockRestore(); }
    expect(hit).toBe(1);
    // The approval stands and owes its trial: decided, no subscription yet, one row still owed.
    expect((await app.prisma.verificationDocument.findUniqueOrThrow({ where: { id: last.id } })).status).toBe('APPROVED');
    expect(await app.prisma.subscription.count({ where: { riderId: rider.id } })).toBe(0);
    const owed = await app.prisma.verificationDecisionOutbox.findUniqueOrThrow({ where: { documentId_command: { documentId: last.id, command: 'APPROVAL_TAIL' } } });
    expect(owed).toMatchObject({ processedAt: null, attempts: 1, userId: user.id });
    expect(owed.lastError).toMatch(/synthetic fault/);
    // The sweep (after the backoff) finishes it once; a second pass starts nothing.
    const later = new Date(Date.now() + 2 * 3600_000);
    expect(await svc.processDecisionOutbox({ documentId: last.id, now: later })).toEqual({ processed: 1, failed: 0 });
    expect(await app.prisma.subscription.count({ where: { riderId: rider.id } })).toBe(1);
    expect(await svc.processDecisionOutbox({ documentId: last.id, now: later })).toEqual({ processed: 0, failed: 0 });
    expect(await app.prisma.subscription.count({ where: { riderId: rider.id } })).toBe(1);
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
    // [VERIFY-DOCS · ruling 8] the person's and the car's hire licences replace the single permit
    const carDocs = ['drivers_licence', 'vehicle_registration',
      'hire_car_driver_licence', 'hire_car_vehicle_licence', 'vehicle_exterior_photo', 'fitness_cert'];
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
