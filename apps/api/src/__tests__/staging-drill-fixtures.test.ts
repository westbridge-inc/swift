import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { Server } from 'socket.io';
import { pino } from 'pino';
import { scopedPrisma } from '../plugins/prisma';
import { runAsSystem } from '../plugins/tenant-context';
import { drillFixturesMain, type DrillIo } from '../modules/ops/drills/cli';
import { runDrillJobs } from '../modules/ops/drills/jobs';
import { assertDrillTarget } from '../modules/ops/drills/guard';
import { DRILL_TENANT_ID, drillMarker, type DrillManifest, type DrillCleanupReport } from '../modules/ops/drills/fixtures';
import { clusterMemberIds } from '../modules/integrity/identity.service';
import { AgentCashService } from '../modules/billing/agent-cash.service';
import { BillingService } from '../modules/billing/billing.service';
import { NotificationService } from '../modules/notification/notification.service';
import { getPaymentProvider } from '../providers/payment/payment-provider';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// [STG-DRILLS D2/D3/D5/D6] The staging drill fixtures, against a real
// database, built the way the app builds them — and removed through their
// parents. The premise of each skipped journey is proven here, with the REAL
// job functions the worker runs:
//
//   D2/D3  a store whose trial ended 15 days ago: the real conversion and
//          billing cycle bill it (PAST_DUE, one failed charge), and one agent
//          receipt settles it once — the replay moves nothing;
//   D5     the applicant sits in the admin's identity cluster (recusal);
//   D6     a second tenant, CRAWLER-kind, with a store, a customer, an order
//          and a partner that inherit its tenant through the lineage wall.
//
// Phones: fixtures use +592048xxxx (nothing else in the repository does);
// this file's admin uses +5920418xxx (grep of apps/, scripts/, packages/:
// unused elsewhere).
// ---------------------------------------------------------------------------

const db = scopedPrisma as unknown as PrismaClient;
const sys = <T>(fn: () => Promise<T>) => runAsSystem('staging-drills-test', fn);
const RUN = `vt-${Date.now().toString(36)}`;
const MARKER = drillMarker(RUN);
const ADMIN_PHONE = `+5920418${String(Math.floor(Math.random() * 900) + 100)}`;
const DRILL_ENV = { ...process.env, SWIFT_STAGING_DRILLS: '1' };
const DAY = 86_400_000;

let adminId = '';
let priorIdentity: { deploymentId: string; environment: string } | null = null;
let manifest: DrillManifest;

function captureIo(): DrillIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}
const appClient = { client: async () => db };

async function markerUsers() {
  return sys(() => db.user.findMany({ where: { syntheticRunId: MARKER }, select: { id: true, tenantId: true, isSynthetic: true, phone: true } }));
}

beforeAll(async () => {
  priorIdentity = await db.deploymentIdentity.findUnique({ where: { id: 'singleton' }, select: { deploymentId: true, environment: true } });
  if (!priorIdentity) {
    await db.deploymentIdentity.create({ data: { id: 'singleton', deploymentId: 'staging-drills-test', environment: 'test' } });
  }
  const admin = await sys(() => db.user.create({
    data: {
      phone: ADMIN_PHONE, firstName: 'Drill', lastName: 'Reviewer',
      roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
      admin: { create: { permissions: ['*'] } },
    },
    select: { id: true },
  }));
  adminId = admin.id;
});

afterAll(async () => {
  // A failed assertion must not strand fixtures: cleanup is idempotent.
  await drillFixturesMain(['cleanup', '--run-id', RUN], DRILL_ENV, captureIo(), appClient).catch(() => undefined);
  await sys(async () => {
    const memberships = await db.identityClusterMember.findMany({ where: { accountId: adminId }, select: { clusterId: true } });
    await db.identityKey.deleteMany({ where: { accountId: adminId } });
    await db.identityClusterMember.deleteMany({ where: { accountId: adminId } });
    for (const m of memberships) {
      const left = await db.identityClusterMember.count({ where: { clusterId: m.clusterId } });
      const merged = await db.identityCluster.count({ where: { mergedIntoId: m.clusterId } });
      if (left === 0 && merged === 0) await db.identityCluster.deleteMany({ where: { id: m.clusterId } });
    }
    await db.session.deleteMany({ where: { userId: adminId } });
    await db.user.deleteMany({ where: { id: adminId } });
  });
  if (!priorIdentity) await db.deploymentIdentity.deleteMany({ where: { id: 'singleton', deploymentId: 'staging-drills-test' } });
});

describe('[STG-DRILLS] the drill tenant is minted the way every tenant-creating path must', () => {
  it('assertTenantWall runs before the swift-drill tenant is created or re-activated (TA-S0-003)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(process.cwd(), 'src/modules/ops/drills/fixtures.ts'), 'utf8');
    const wall = src.indexOf('assertTenantWall(attestationOf(await readRlsFacts(db)), activeAfter);');
    const mint = src.indexOf('await db.tenant.upsert(');
    expect(wall).toBeGreaterThan(-1);
    expect(mint).toBeGreaterThan(wall);
  });
});

describe('[STG-DRILLS] the fixtures refuse before they touch anything', () => {
  it('without the staging marker nothing is created and the refusal is exit 3', async () => {
    const io = captureIo();
    const code = await drillFixturesMain(['create', '--run-id', RUN, '--admin-phone', ADMIN_PHONE], { ...process.env, SWIFT_STAGING_DRILLS: undefined }, io, appClient);
    expect(code).toBe(3);
    expect(io.errors.join('\n')).toContain('MARKER_MISSING');
    expect(io.lines).toEqual([]);
    expect(await markerUsers()).toEqual([]);
  });

  it('an admin phone that could reach a subscriber is a usage error (exit 2)', async () => {
    const io = captureIo();
    expect(await drillFixturesMain(['create', '--run-id', RUN, '--admin-phone', '+5926001000'], DRILL_ENV, io, appClient)).toBe(2);
    expect(await markerUsers()).toEqual([]);
  });
});

describe('[STG-DRILLS] creating the fixtures', () => {
  it('prints one manifest line and builds every fixture through the app', async () => {
    const io = captureIo();
    const code = await drillFixturesMain(['create', '--run-id', RUN, '--admin-phone', ADMIN_PHONE], DRILL_ENV, io, appClient);
    expect(code, io.errors.join('\n')).toBe(0);
    expect(io.lines).toHaveLength(1);
    manifest = JSON.parse(io.lines[0]!) as DrillManifest;
    expect(manifest).toMatchObject({ version: 1, runId: RUN, marker: MARKER, target: { environment: expect.any(String) } });

    // Recognisable: named DRILL-<run>, marked, and on never-a-subscriber phones.
    const users = await markerUsers();
    expect(users).toHaveLength(6);
    for (const u of users) expect(u.phone).toMatch(/^\+592048\d{4}$/);
    const phones = [manifest.billing.vend04, manifest.billing.money03, manifest.recusal, manifest.tenant.customer, manifest.tenant.storeOwner, manifest.tenant.partner].map((a) => a.phone);
    expect(new Set(phones).size).toBe(6);
  });

  it('the journey runner accepts the manifest exactly as the fixtures print it (the server-to-runner contract)', async () => {
    const runner = await import(pathToFileURL(join(process.cwd(), '../../scripts/livetest/drills.ts')).href);
    const parsed = runner.parseDrillManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed).toEqual(manifest);
    expect(() => runner.refuseForeignManifest(parsed, { deploymentId: manifest.target.deploymentId, environment: manifest.target.environment })).not.toThrow();
  });

  it('D2/D3: two approved stores whose trial ended 15 days ago, born through the real subscription path', async () => {
    for (const store of [manifest.billing.vend04, manifest.billing.money03]) {
      const sub = await sys(() => db.subscription.findUniqueOrThrow({ where: { id: store.subscriptionId } }));
      expect({ status: sub.status, type: sub.type, billingMethod: sub.billingMethod, vendorId: sub.vendorId }).toEqual({ status: 'TRIAL', type: 'RESTAURANT', billingMethod: 'CASH', vendorId: store.vendorId });
      expect(Number(sub.weeklyRate)).toBeGreaterThan(0);
      expect(sub.san).toMatch(/^[1-9]\d{9}$/);
      expect(store.san).toBe(sub.san);
      expect(store.bornAs).toBe('TRIAL');
      const ended = sub.trialEndDate!.getTime();
      expect(Math.abs(ended - (Date.now() - 15 * DAY))).toBeLessThan(5 * 60_000);
      expect(sub.nextBillingDate.getTime()).toBe(ended);
      const grant = await sys(() => db.trialGrant.findFirstOrThrow({ where: { accountId: store.userId, role: 'VENDOR' } }));
      expect(grant.endsAt.getTime()).toBe(ended);
      const vendor = await sys(() => db.vendor.findUniqueOrThrow({ where: { id: store.vendorId }, select: { status: true, isVerified: true, isCurrentlyOpen: true, acceptingOrders: true, tenantId: true, name: true } }));
      expect(vendor).toMatchObject({ status: 'ACTIVE', isVerified: true, isCurrentlyOpen: false, acceptingOrders: false, tenantId: 'swift-default' });
      expect(vendor.name.startsWith(MARKER)).toBe(true);
    }
  });

  it('D5: the applicant is in the admin identity cluster, through a phone edge the identity engine drew', async () => {
    expect(await clusterMemberIds(db, adminId)).toContain(manifest.recusal.userId);
    expect(manifest.recusal).toMatchObject({ adminPhone: ADMIN_PHONE, linkedBy: 'PHONE' });
    const applicant = await sys(() => db.user.findUniqueOrThrow({ where: { id: manifest.recusal.userId }, select: { tenantId: true, roles: true } }));
    expect(applicant).toEqual({ tenantId: 'swift-default', roles: ['VENDOR_OWNER', 'CUSTOMER'] });
  });

  it('D6: a CRAWLER tenant whose store, customer, order and partner all live in it — synthetic by derivation, walled by lineage', async () => {
    const t = manifest.tenant;
    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: DRILL_TENANT_ID } });
    expect({ kind: tenant.kind, isActive: tenant.isActive, purgeProtected: tenant.purgeProtected }).toEqual({ kind: 'CRAWLER', isActive: true, purgeProtected: false });
    const users = await sys(() => db.user.findMany({ where: { id: { in: [t.customer.userId, t.storeOwner.userId, t.partner.userId] } }, select: { tenantId: true, isSynthetic: true } }));
    expect(users).toHaveLength(3);
    for (const u of users) expect(u).toEqual({ tenantId: DRILL_TENANT_ID, isSynthetic: true });
    const [vendor, item, order, rider] = await sys(() => Promise.all([
      db.vendor.findUniqueOrThrow({ where: { id: t.store.vendorId }, select: { tenantId: true, isSynthetic: true, status: true } }),
      db.item.findUniqueOrThrow({ where: { id: t.store.itemId }, select: { tenantId: true } }),
      db.order.findUniqueOrThrow({ where: { id: t.order.orderId }, select: { tenantId: true, status: true, customerId: true, vendorId: true, statusHistory: { select: { status: true } } } }),
      db.rider.findUniqueOrThrow({ where: { id: t.partner.riderId }, select: { userId: true } }),
    ]));
    expect(vendor).toEqual({ tenantId: DRILL_TENANT_ID, isSynthetic: true, status: 'ACTIVE' });
    expect(item).toEqual({ tenantId: DRILL_TENANT_ID });
    expect(order).toEqual({ tenantId: DRILL_TENANT_ID, status: 'PENDING', customerId: t.customer.userId, vendorId: t.store.vendorId, statusHistory: [{ status: 'PENDING' }] });
    expect(rider.userId).toBe(t.partner.userId);
  });

  it('a re-run with the same run id returns the same fixtures and creates nothing new', async () => {
    const io = captureIo();
    expect(await drillFixturesMain(['create', '--run-id', RUN, '--admin-phone', ADMIN_PHONE], DRILL_ENV, io, appClient)).toBe(0);
    const again = JSON.parse(io.lines[0]!) as DrillManifest;
    expect({ ...again, createdAt: 'x' }).toEqual({ ...manifest, createdAt: 'x' });
    expect(await markerUsers()).toHaveLength(6);
    const orders = await sys(() => db.order.count({ where: { tenantId: DRILL_TENANT_ID, customerId: manifest.tenant.customer.userId } }));
    expect(orders).toBe(1);
  });
});

describe('[STG-DRILLS] the real jobs act on the fixtures', () => {
  const plain = new PrismaClient({ datasourceUrl: process.env['DATABASE_URL'] });
  const openContext = async () => {
    const redis = new Redis(process.env['REDIS_URL'] as string, { maxRetriesPerRequest: null });
    // Unattached, like the worker's own broadcast-only server: nothing to close.
    return { ctx: { prisma: plain, io: new Server(), redis, log: pino({ level: 'silent' }) }, close: async () => { await redis.quit(); } };
  };
  afterAll(async () => { await plain.$disconnect(); });

  it('D2/D3: the daily conversion then the hourly billing cycle bill both stores (one failed cash charge each)', async () => {
    const { runs } = await runDrillJobs(['convert-trials', 'billing-cycle'], { assertTarget: () => assertDrillTarget(plain, DRILL_ENV), openContext });
    expect(runs.map((r) => r.job)).toEqual(['convert-trials', 'billing-cycle']);
    for (const store of [manifest.billing.vend04, manifest.billing.money03]) {
      const sub = await sys(() => db.subscription.findUniqueOrThrow({ where: { id: store.subscriptionId } }));
      expect({ status: sub.status, failedAttempts: sub.failedAttempts, isTrialActive: sub.isTrialActive }).toEqual({ status: 'PAST_DUE', failedAttempts: 1, isTrialActive: false });
      const events = await sys(() => db.billingEvent.findMany({ where: { subscriptionId: store.subscriptionId }, select: { type: true }, orderBy: { createdAt: 'asc' } }));
      expect(events.map((e) => e.type)).toEqual(['CHARGE_ATTEMPT', 'CHARGE_FAILED']);
    }
  });

  it('D3: one agent receipt settles the billed week, and its replay credits nothing', async () => {
    const store = manifest.billing.money03;
    const sub = await sys(() => db.subscription.findUniqueOrThrow({ where: { id: store.subscriptionId } }));
    const billing = new BillingService(db, new NotificationService(db, new Server()), getPaymentProvider());
    const receipt = {
      externalId: `MANUAL:${MARKER}-M03`, channel: 'MANUAL_ADMIN' as const, sanRaw: store.san!, amount: Number(sub.weeklyRate),
      currencyCode: 'GYD', paidAt: new Date(), raw: { drill: MARKER }, recordedBy: adminId,
    };
    const agent = new AgentCashService(db, billing);
    expect((await sys(() => agent.ingest(receipt))).status).toBe('accepted');
    const paid = await sys(() => db.subscription.findUniqueOrThrow({ where: { id: store.subscriptionId } }));
    expect({ status: paid.status, failedAttempts: paid.failedAttempts }).toEqual({ status: 'ACTIVE', failedAttempts: 0 });
    expect(paid.nextBillingDate.getTime()).toBe(sub.nextBillingDate.getTime() + 7 * DAY);
    expect((await sys(() => agent.ingest(receipt))).status).toBe('duplicate');
    const successes = await sys(() => db.billingEvent.count({ where: { subscriptionId: store.subscriptionId, type: 'CHARGE_SUCCESS' } }));
    expect(successes).toBe(1);
  });
});

describe('[STG-DRILLS] cleanup', () => {
  it('removes every fixture through its parents, retires the SANs, keeps the evidence, and is idempotent', async () => {
    const sans = [manifest.billing.vend04.san!, manifest.billing.money03.san!];
    const receiptsBefore = await sys(() => db.feeReceipt.count({ where: { subscriptionId: manifest.billing.money03.subscriptionId } }));
    const io = captureIo();
    const code = await drillFixturesMain(['cleanup', '--run-id', RUN], DRILL_ENV, io, appClient);
    const report = JSON.parse(io.lines[0]!) as DrillCleanupReport;
    expect(code, JSON.stringify(report)).toBe(0);
    expect(report.kept).toEqual([]);
    expect(report.tenant).toBe('removed');
    expect(report.removed).toMatchObject({ users: 6, vendors: 3, subscriptions: 2, orders: 1 });

    expect(await markerUsers()).toEqual([]);
    const ids = [manifest.billing.vend04.vendorId, manifest.billing.money03.vendorId, manifest.tenant.store.vendorId];
    expect(await sys(() => db.vendor.count({ where: { id: { in: ids } } }))).toBe(0);
    expect(await sys(() => db.order.count({ where: { id: manifest.tenant.order.orderId } }))).toBe(0);
    expect(await db.tenant.findUnique({ where: { id: DRILL_TENANT_ID } })).toBeNull();
    // A SAN is never re-issued: both went to the tombstone registry.
    expect(await sys(() => db.sanTombstone.count({ where: { san: { in: sans } } }))).toBe(2);
    // Evidence stays: the fee receipt of the settled week is still on the books.
    expect(receiptsBefore).toBe(1);
    expect(await sys(() => db.feeReceipt.count({ where: { subscriptionId: manifest.billing.money03.subscriptionId } }))).toBe(1);
    // The admin keeps an identity of its own, alone again.
    expect(await clusterMemberIds(db, adminId)).toEqual([adminId]);

    const again = captureIo();
    expect(await drillFixturesMain(['cleanup', '--run-id', RUN], DRILL_ENV, again, appClient)).toBe(0);
    expect(JSON.parse(again.lines[0]!)).toMatchObject({ removed: {}, kept: [], tenant: 'absent' });
  });
});
