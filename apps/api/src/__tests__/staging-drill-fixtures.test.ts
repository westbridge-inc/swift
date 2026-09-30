import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { scopedPrisma } from '../plugins/prisma';
import { runAsSystem, runWithTenant } from '../plugins/tenant-context';
import { drillFixturesMain, drillRunJobMain, drillEvidenceMain, type DrillIo } from '../modules/ops/drills/cli';
import { DRILL_TENANT_ID, DRILL_TENANT_NAME, drillMarker, drillSlug, drillTenantRuns, foreignDrillTenant, type DrillManifest, type DrillCleanupReport } from '../modules/ops/drills/fixtures';
import type { CrashEvidence } from '../modules/ops/drills/evidence';
import { clusterMemberIds } from '../modules/integrity/identity.service';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// [STG-DRILLS D5/D6] The staging drill fixtures, against a real database,
// built the way the app builds them — and removed through their parents:
//
//   D5     the applicant sits in the admin's identity cluster (recusal);
//   D6     a second tenant, CRAWLER-kind, with a store, a customer, an order
//          and a partner that inherit its tenant through the lineage wall.
//
// And what AX324 found, proven on the same database:
//   R1     a system login on another database refuses the whole entry; the
//          fixtures run through two live connections to one database;
//   R2     no drill path touches a non-DRILL subscription: the billing jobs are
//          refused at the entry, and eligible foreign subscriptions are
//          byte-identical after every drill entry has run;
//   R5     run ids that differ only in punctuation never share a store, and a
//          store under the slug that this run's owner did not make is refused,
//          never adopted — nor removed by the cleanup;
//   R7     the crash drill's evidence read returns the order's durable rows.
//
// Phones: fixtures use +592048xxxx (nothing else in the repository does);
// this file's admin uses +5920418xxx and its non-DRILL accounts +5920416xxx
// (grep of apps/, scripts/, packages/: unused elsewhere).
// ---------------------------------------------------------------------------

const db = scopedPrisma as unknown as PrismaClient;
const sys = <T>(fn: () => Promise<T>) => runAsSystem('staging-drills-test', fn);
const RUN = `vt-${Date.now().toString(36)}`;
const MARKER = drillMarker(RUN);
const RUN_DOT = `${RUN}.r5`;
const RUN_UNDER = `${RUN}_r5`;
const RUN_SQUAT = `${RUN}-sq`;
const RUN_R1 = `${RUN}-r1`;
const ADMIN_PHONE = `+5920418${String(Math.floor(Math.random() * 900) + 100)}`;
const OTHER_BASE = Math.floor(Math.random() * 990);
const OTHER = (n: number) => `+5920416${String(OTHER_BASE + n).padStart(3, '0')}`;
// The harness posture, with no system login or RLS binding leaked in from elsewhere.
const BASE_ENV: Record<string, string | undefined> = { ...process.env };
delete BASE_ENV['SYSTEM_DATABASE_URL'];
delete BASE_ENV['TENANT_RLS_BIND'];
const DRILL_ENV: Record<string, string | undefined> = { ...BASE_ENV, SWIFT_STAGING_DRILLS: '1' };
const DAY = 86_400_000;

let adminId = '';
let priorIdentity: { deploymentId: string; environment: string } | null = null;
let manifest: DrillManifest;
/** Non-DRILL accounts this file made: eligible subscriptions (R2) and a squatter (R5). */
const foreign = { userIds: [] as string[], vendorIds: [] as string[], subscriptionIds: [] as string[] };
let foreignBefore = '';

function captureIo(): DrillIo & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return { lines, errors, out: (l) => lines.push(l), err: (l) => errors.push(l) };
}
const appClient = { client: async () => db };

async function markerUsers(marker = MARKER) {
  return sys(() => db.user.findMany({ where: { syntheticRunId: marker }, select: { id: true, tenantId: true, isSynthetic: true, phone: true } }));
}

const GEORGETOWN = { city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8013, longitude: -58.1551 };

/** A non-DRILL store owner and store, the way an ordinary partner has them. */
async function foreignStore(n: number, slug: string, tenantId: string) {
  return runWithTenant(tenantId, async () => {
    const user = await db.user.create({
      data: { phone: OTHER(n), firstName: 'Real', lastName: `Partner ${n}`, roles: ['VENDOR_OWNER', 'CUSTOMER'], activeRole: 'VENDOR_OWNER', countryCode: 'GY', isPhoneVerified: true, customer: { create: {} }, vendorOwner: { create: {} } },
      select: { id: true, vendorOwner: { select: { id: true } } },
    });
    foreign.userIds.push(user.id);
    const vendor = await db.vendor.create({
      data: { ownerId: user.vendorOwner!.id, name: `Real partner store ${n}`, slug, vendorType: 'RESTAURANT', phone: OTHER(n), addressLine1: `${n} Real Street`, ...GEORGETOWN, status: 'ACTIVE', isVerified: true, isCurrentlyOpen: false, acceptingOrders: false },
      select: { id: true, ownerId: true, name: true, slug: true, tenantId: true },
    });
    foreign.vendorIds.push(vendor.id);
    return vendor;
  });
}

async function foreignSnapshot(): Promise<string> {
  const subs = await sys(() => db.subscription.findMany({ where: { id: { in: foreign.subscriptionIds } }, orderBy: { id: 'asc' } }));
  const events = await sys(() => db.billingEvent.count({ where: { subscriptionId: { in: foreign.subscriptionIds } } }));
  return JSON.stringify({ subs, events });
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

  // [AX324 R2] Two ordinary (non-DRILL) partners whose subscriptions the billing
  // sweeps WOULD act on: a trial that has ended (the conversion flips it) and an
  // active plan that is due (the cycle charges it).
  const now = Date.now();
  const expired = await foreignStore(1, `vt-real-${RUN}-1`, 'swift-default');
  const due = await foreignStore(2, `vt-real-${RUN}-2`, 'swift-default');
  const trial = await sys(() => db.subscription.create({ data: { vendorId: expired.id, type: 'RESTAURANT', weeklyRate: 1500, status: 'TRIAL', isTrialActive: true, trialEndDate: new Date(now - DAY), currentPeriodStart: new Date(now - 15 * DAY), currentPeriodEnd: new Date(now - DAY), nextBillingDate: new Date(now - DAY), billingMethod: 'CASH' }, select: { id: true } }));
  const active = await sys(() => db.subscription.create({ data: { vendorId: due.id, type: 'RESTAURANT', weeklyRate: 1500, status: 'ACTIVE', autoRenew: true, currentPeriodStart: new Date(now - 8 * DAY), currentPeriodEnd: new Date(now - 3_600_000), nextBillingDate: new Date(now - 3_600_000), billingMethod: 'CASH' }, select: { id: true } }));
  foreign.subscriptionIds.push(trial.id, active.id);
  foreignBefore = await foreignSnapshot();
});

afterAll(async () => {
  // A failed assertion must not strand fixtures: cleanup is idempotent.
  for (const run of [RUN_R1, RUN_DOT, RUN_UNDER, RUN_SQUAT, RUN]) {
    await drillFixturesMain(['cleanup', '--run-id', run], DRILL_ENV, captureIo(), appClient).catch(() => undefined);
  }
  await sys(async () => {
    await db.billingEvent.deleteMany({ where: { subscriptionId: { in: foreign.subscriptionIds } } }).catch(() => undefined);
    await db.subscription.deleteMany({ where: { id: { in: foreign.subscriptionIds } } });
    await db.vendor.deleteMany({ where: { id: { in: foreign.vendorIds } } });
    await db.session.deleteMany({ where: { userId: { in: foreign.userIds } } });
    await db.user.deleteMany({ where: { id: { in: foreign.userIds } } });
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
  // The drill tenant goes once nothing of any run (or this file's squatter) lives in it.
  await drillFixturesMain(['cleanup', '--run-id', RUN], DRILL_ENV, captureIo(), appClient).catch(() => undefined);
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
    const code = await drillFixturesMain(['create', '--run-id', RUN, '--admin-phone', ADMIN_PHONE], { ...BASE_ENV, SWIFT_STAGING_DRILLS: undefined }, io, appClient);
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

  it('[AX324 R1] a system connection that answers another deployment refuses the whole entry: nothing is created', async () => {
    const io = captureIo();
    const production = { $queryRaw: async () => [{ db: new URL(process.env['DATABASE_URL'] as string).pathname.slice(1) }], deploymentIdentity: { findUnique: async () => ({ deploymentId: 'swift-prod', environment: 'production' }) } };
    const env = { ...DRILL_ENV, TENANT_RLS_BIND: '1', SYSTEM_DATABASE_URL: process.env['DATABASE_URL'] };
    const code = await drillFixturesMain(['create', '--run-id', RUN_R1, '--admin-phone', ADMIN_PHONE], env, io, { client: async () => db, systemClient: async () => production as never });
    expect(code, io.errors.join('\n')).toBe(3);
    expect(io.errors.join('\n')).toContain('PRODUCTION_MARKER');
    expect(io.lines).toEqual([]);
    expect(await markerUsers(drillMarker(RUN_R1))).toEqual([]);
  });

  it('[AX324 R1] a system connection the environment names but no client answers for is refused too', async () => {
    const io = captureIo();
    const env = { ...DRILL_ENV, TENANT_RLS_BIND: '1', SYSTEM_DATABASE_URL: process.env['DATABASE_URL'] };
    expect(await drillFixturesMain(['cleanup', '--run-id', RUN_R1], env, io, { client: async () => db, systemClient: async () => null })).toBe(3);
    expect(io.errors.join('\n')).toContain('SYSTEM_DB_UNVERIFIED');
  });
});

describe('[STG-DRILLS] creating the fixtures', () => {
  it('prints one manifest line and builds every fixture through the app — guarded through two live connections to one database', async () => {
    const io = captureIo();
    const second = new PrismaClient({ datasourceUrl: process.env['DATABASE_URL'] });
    const env = { ...DRILL_ENV, TENANT_RLS_BIND: '1', SYSTEM_DATABASE_URL: process.env['DATABASE_URL'] };
    const code = await drillFixturesMain(['create', '--run-id', RUN, '--admin-phone', ADMIN_PHONE], env, io, { client: async () => db, systemClient: async () => second });
    expect(code, io.errors.join('\n')).toBe(0);
    expect(io.lines).toHaveLength(1);
    manifest = JSON.parse(io.lines[0]!) as DrillManifest;
    expect(manifest).toMatchObject({ version: 2, runId: RUN, marker: MARKER, target: { environment: expect.any(String) } });
    expect(manifest).not.toHaveProperty('billing');

    // Recognisable: named DRILL-<run>, marked, and on never-a-subscriber phones.
    const users = await markerUsers();
    expect(users).toHaveLength(4);
    for (const u of users) expect(u.phone).toMatch(/^\+592048\d{4}$/);
    const phones = [manifest.recusal, manifest.tenant.customer, manifest.tenant.storeOwner, manifest.tenant.partner].map((a) => a.phone);
    expect(new Set(phones).size).toBe(4);
  });

  it('the journey runner accepts the manifest exactly as the fixtures print it (the server-to-runner contract)', async () => {
    const runner = await import(pathToFileURL(join(process.cwd(), '../../scripts/livetest/drills.ts')).href);
    const parsed = runner.parseDrillManifest(JSON.parse(JSON.stringify(manifest)));
    expect(parsed).toEqual(manifest);
    expect(() => runner.refuseForeignManifest(parsed, { deploymentId: manifest.target.deploymentId, environment: manifest.target.environment })).not.toThrow();
  });

  it('[AX324 R2] the fixtures create no subscription and no backdated store', async () => {
    const users = await markerUsers();
    const owners = await sys(() => db.vendorOwner.findMany({ where: { userId: { in: users.map((u) => u.id) } }, select: { id: true } }));
    const vendors = await sys(() => db.vendor.findMany({ where: { ownerId: { in: owners.map((o) => o.id) } }, select: { id: true } }));
    expect(vendors.map((v) => v.id)).toEqual([manifest.tenant.store.vendorId]);
    expect(await sys(() => db.subscription.count({ where: { vendorId: { in: vendors.map((v) => v.id) } } }))).toBe(0);
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
    // [AX370 A2] The tenant records the run that made it: the provenance its cleanup requires.
    expect(drillTenantRuns(tenant.config)).toEqual([MARKER]);
    const users = await sys(() => db.user.findMany({ where: { id: { in: [t.customer.userId, t.storeOwner.userId, t.partner.userId] } }, select: { tenantId: true, isSynthetic: true } }));
    expect(users).toHaveLength(3);
    for (const u of users) expect(u).toEqual({ tenantId: DRILL_TENANT_ID, isSynthetic: true });
    const [vendor, item, order, rider] = await sys(() => Promise.all([
      db.vendor.findUniqueOrThrow({ where: { id: t.store.vendorId }, select: { tenantId: true, isSynthetic: true, status: true, slug: true } }),
      db.item.findUniqueOrThrow({ where: { id: t.store.itemId }, select: { tenantId: true } }),
      db.order.findUniqueOrThrow({ where: { id: t.order.orderId }, select: { tenantId: true, status: true, customerId: true, vendorId: true, statusHistory: { select: { status: true } } } }),
      db.rider.findUniqueOrThrow({ where: { id: t.partner.riderId }, select: { userId: true } }),
    ]));
    expect(vendor).toEqual({ tenantId: DRILL_TENANT_ID, isSynthetic: true, status: 'ACTIVE', slug: drillSlug(RUN, 'plat01-store') });
    expect(item).toEqual({ tenantId: DRILL_TENANT_ID });
    expect(order).toEqual({ tenantId: DRILL_TENANT_ID, status: 'PENDING', customerId: t.customer.userId, vendorId: t.store.vendorId, statusHistory: [{ status: 'PENDING' }] });
    expect(rider.userId).toBe(t.partner.userId);
  });

  it('a re-run with the same run id returns the same fixtures and creates nothing new', async () => {
    const io = captureIo();
    expect(await drillFixturesMain(['create', '--run-id', RUN, '--admin-phone', ADMIN_PHONE], DRILL_ENV, io, appClient)).toBe(0);
    const again = JSON.parse(io.lines[0]!) as DrillManifest;
    expect({ ...again, createdAt: 'x' }).toEqual({ ...manifest, createdAt: 'x' });
    expect(await markerUsers()).toHaveLength(4);
    const orders = await sys(() => db.order.count({ where: { tenantId: DRILL_TENANT_ID, customerId: manifest.tenant.customer.userId } }));
    expect(orders).toBe(1);
  });
});

describe('[AX324 R5] a run adopts only what its own run made', () => {
  it('run ids that differ only in punctuation get their own stores; one run’s cleanup leaves the other’s', async () => {
    expect(drillSlug(RUN_DOT, 'plat01-store')).not.toBe(drillSlug(RUN_UNDER, 'plat01-store'));
    expect(drillSlug('A-b', 'plat01-store')).not.toBe(drillSlug('a-b', 'plat01-store'));
    const made: Record<string, DrillManifest> = {};
    for (const run of [RUN_DOT, RUN_UNDER]) {
      const io = captureIo();
      expect(await drillFixturesMain(['create', '--run-id', run, '--admin-phone', ADMIN_PHONE], DRILL_ENV, io, appClient), io.errors.join('\n')).toBe(0);
      made[run] = JSON.parse(io.lines[0]!) as DrillManifest;
    }
    const dot = made[RUN_DOT]!;
    const under = made[RUN_UNDER]!;
    expect(dot.tenant.store.vendorId).not.toBe(under.tenant.store.vendorId);
    expect(dot.tenant.order.orderId).not.toBe(under.tenant.order.orderId);
    const owners = await sys(() => db.vendor.findMany({ where: { id: { in: [dot.tenant.store.vendorId, under.tenant.store.vendorId] } }, select: { id: true, owner: { select: { userId: true } } } }));
    const ownerOf = new Map(owners.map((v) => [v.id, v.owner.userId]));
    expect(ownerOf.get(dot.tenant.store.vendorId)).toBe(dot.tenant.storeOwner.userId);
    expect(ownerOf.get(under.tenant.store.vendorId)).toBe(under.tenant.storeOwner.userId);

    const io = captureIo();
    expect(await drillFixturesMain(['cleanup', '--run-id', RUN_DOT], DRILL_ENV, io, appClient)).toBe(0);
    expect(await sys(() => db.vendor.count({ where: { id: dot.tenant.store.vendorId } }))).toBe(0);
    expect(await sys(() => db.vendor.count({ where: { id: under.tenant.store.vendorId } }))).toBe(1);
    expect(await sys(() => db.order.count({ where: { id: under.tenant.order.orderId } }))).toBe(1);
    expect(await drillFixturesMain(['cleanup', '--run-id', RUN_UNDER], DRILL_ENV, captureIo(), appClient)).toBe(0);
  });

  it('a store under this run’s slug that its DRILL owner did not make is refused, left untouched, and never removed by the cleanup', async () => {
    const squatter = await foreignStore(3, drillSlug(RUN_SQUAT, 'plat01-store'), DRILL_TENANT_ID);
    const io = captureIo();
    const code = await drillFixturesMain(['create', '--run-id', RUN_SQUAT, '--admin-phone', ADMIN_PHONE], DRILL_ENV, io, appClient);
    expect(code).toBe(1);
    expect(io.errors.join('\n')).toContain('FIXTURE_CONFLICT');
    expect(io.lines).toEqual([]);
    const after = await sys(() => db.vendor.findUniqueOrThrow({ where: { id: squatter.id }, select: { id: true, ownerId: true, name: true, slug: true, tenantId: true } }));
    expect(after).toEqual(squatter);
    const [items, orders] = await sys(() => Promise.all([db.item.count({ where: { vendorId: squatter.id } }), db.order.count({ where: { vendorId: squatter.id } })]));
    expect({ items, orders }).toEqual({ items: 0, orders: 0 });

    expect(await drillFixturesMain(['cleanup', '--run-id', RUN_SQUAT], DRILL_ENV, captureIo(), appClient)).toBe(0);
    expect(await markerUsers(drillMarker(RUN_SQUAT))).toEqual([]);
    expect(await sys(() => db.vendor.count({ where: { id: squatter.id } }))).toBe(1);
  });
});

describe('[AX324 R7] the crash drill’s evidence read', () => {
  it('returns the order’s offer publications, offer pushes, dispatch journal and status log — ids and times only', async () => {
    const orderId = manifest.tenant.order.orderId;
    const rider = manifest.tenant.partner.userId;
    const sentAt = new Date();
    await sys(async () => {
      await db.alertDelivery.createMany({ data: [
        { kind: 'MOVER_OFFER', subjectId: orderId, recipientId: rider, offerAttemptId: `ev-${RUN}-a1`, sentAt },
        { kind: 'MOVER_OFFER', subjectId: orderId, recipientId: rider, offerAttemptId: `ev-${RUN}-a2`, sentAt: new Date(sentAt.getTime() + 1_000) },
        { kind: 'VENDOR_ORDER', subjectId: orderId, recipientId: rider, sentAt },
      ] });
      await db.notification.create({ data: { userId: rider, type: 'ORDER_UPDATE', title: 'Order available nearby', body: 'b', data: { kind: 'dispatch_offer', orderId, offerAttemptId: `ev-${RUN}-a1` } } });
      await db.dispatchSearch.create({ data: { vertical: 'DELIVERY', subjectId: orderId, status: 'SEARCHING', radiusKm: 3 } });
    });
    try {
      const io = captureIo();
      expect(await drillEvidenceMain(['crash', '--order', orderId], DRILL_ENV, io, appClient), io.errors.join('\n')).toBe(0);
      expect(io.lines).toHaveLength(1);
      const e = JSON.parse(io.lines[0]!) as CrashEvidence;
      expect(e).toMatchObject({ version: 1, orderId, order: { status: 'PENDING', riderId: null } });
      expect(e.offers.map((o) => o.attemptId)).toEqual([`ev-${RUN}-a1`, `ev-${RUN}-a2`]);
      expect(e.offerPushes).toEqual([expect.objectContaining({ attemptId: `ev-${RUN}-a1`, userId: rider })]);
      expect(e.searches).toEqual([expect.objectContaining({ status: 'SEARCHING', assignedTo: null })]);
      expect(e.statusLog.map((l) => l.status)).toEqual(['PENDING']);
      expect(io.lines[0]).not.toContain('Order available nearby');

      const refused = captureIo();
      expect(await drillEvidenceMain(['crash', '--order', orderId], { ...BASE_ENV }, refused, appClient)).toBe(3);
      expect(refused.lines).toEqual([]);
    } finally {
      await sys(async () => {
        await db.alertDelivery.deleteMany({ where: { subjectId: orderId } });
        await db.dispatchSearch.deleteMany({ where: { subjectId: orderId } });
        await db.notification.deleteMany({ where: { userId: rider } });
      });
    }
  });
});

describe('[AX324 R2] no drill path touches a non-DRILL subscription', () => {
  it('the billing jobs are refused at the entry, before any connection (exit 2) — the eligible foreign subscriptions do not move', async () => {
    for (const jobs of [['convert-trials', 'billing-cycle'], ['billing-cycle'], ['convert-trials']]) {
      const io = captureIo();
      expect(await drillRunJobMain(jobs, DRILL_ENV, io), jobs.join(' ')).toBe(2);
      expect(io.errors.join('\n')).toContain('not an allowlisted drill job');
      expect(io.lines).toEqual([]);
    }
    expect(await foreignSnapshot()).toBe(foreignBefore);
  });

  it('every fixture entry run so far (creates, conflicts, cleanups, the evidence read) left them byte-identical', async () => {
    const [trial, active] = await sys(() => Promise.all(foreign.subscriptionIds.map((id) => db.subscription.findUniqueOrThrow({ where: { id }, select: { status: true } }))));
    expect([trial!.status, active!.status]).toEqual(['TRIAL', 'ACTIVE']);
    expect(await foreignSnapshot()).toBe(foreignBefore);
  });
});

describe('[STG-DRILLS] cleanup', () => {
  it('removes every fixture through its parents, keeps the evidence rules, and is idempotent', async () => {
    const io = captureIo();
    const code = await drillFixturesMain(['cleanup', '--run-id', RUN], DRILL_ENV, io, appClient);
    const report = JSON.parse(io.lines[0]!) as DrillCleanupReport;
    expect(code, JSON.stringify(report)).toBe(0);
    expect(report.kept).toEqual([]);
    expect(report.removed).toMatchObject({ users: 4, vendors: 1, orders: 1 });
    expect(report.removed).not.toHaveProperty('subscriptions');

    expect(await markerUsers()).toEqual([]);
    expect(await sys(() => db.vendor.count({ where: { id: manifest.tenant.store.vendorId } }))).toBe(0);
    expect(await sys(() => db.order.count({ where: { id: manifest.tenant.order.orderId } }))).toBe(0);
    // The admin keeps an identity of its own, alone again.
    expect(await clusterMemberIds(db, adminId)).toEqual([adminId]);
    // A non-DRILL store in the drill tenant (the R5 squatter) keeps the tenant: it is never deleted by a drill.
    expect(report.tenant).toBe('kept');
    expect(await foreignSnapshot()).toBe(foreignBefore);

    const again = captureIo();
    expect(await drillFixturesMain(['cleanup', '--run-id', RUN], DRILL_ENV, again, appClient)).toBe(0);
    expect(JSON.parse(again.lines[0]!)).toMatchObject({ removed: {}, kept: [] });
  });

  it('the drill tenant is removed once nothing of any run — nor anyone else — lives in it', async () => {
    await sys(async () => {
      await db.vendor.deleteMany({ where: { id: { in: foreign.vendorIds }, tenantId: DRILL_TENANT_ID } });
      const squatters = await db.user.findMany({ where: { id: { in: foreign.userIds }, tenantId: DRILL_TENANT_ID }, select: { id: true } });
      await db.session.deleteMany({ where: { userId: { in: squatters.map((u) => u.id) } } });
      await db.user.deleteMany({ where: { id: { in: squatters.map((u) => u.id) } } });
    });
    const io = captureIo();
    expect(await drillFixturesMain(['cleanup', '--run-id', RUN], DRILL_ENV, io, appClient)).toBe(0);
    expect(JSON.parse(io.lines[0]!)).toMatchObject({ kept: [], tenant: 'removed' });
    expect(await db.tenant.findUnique({ where: { id: DRILL_TENANT_ID } })).toBeNull();
  });
});

describe('[AX370 A2] the cleanup removes only the drill’s own tenant, and only for a run that used it', () => {
  // Runs after the drill tenant is gone: each case plants a `swift-drill` row with NO users, stores or orders.
  const RUN_OTHER = `${RUN}-ot`;
  const snapshot = async () => JSON.stringify(await sys(() => db.tenant.findUnique({ where: { id: DRILL_TENANT_ID } })));
  const plant = (data: { slug: string; name: string; purgeProtected?: boolean; config?: object }) =>
    sys(() => db.tenant.create({ data: { id: DRILL_TENANT_ID, kind: 'CRAWLER', isActive: true, ...data } }));
  const drop = () => sys(async () => {
    await db.tenant.updateMany({ where: { id: DRILL_TENANT_ID }, data: { purgeProtected: false } });
    await db.tenant.deleteMany({ where: { id: DRILL_TENANT_ID } });
  });
  const cleanup = async (run: string) => {
    const io = captureIo();
    const code = await drillFixturesMain(['cleanup', '--run-id', run], DRILL_ENV, io, appClient);
    return { code, report: JSON.parse(io.lines[0]!) as DrillCleanupReport };
  };

  it('a conflicting swift-drill tenant (another slug, another name) with no rows is refused and left byte-identical', async () => {
    for (const other of [{ slug: `vt-other-${RUN}`, name: DRILL_TENANT_NAME }, { slug: DRILL_TENANT_ID, name: 'Another operator' }]) {
      await plant(other);
      try {
        const before = await snapshot();
        const { code, report } = await cleanup(RUN);
        expect(await snapshot(), JSON.stringify(other)).toBe(before);
        expect(report.tenant).toBe('refused');
        expect(report.kept.join(' ')).toContain('not the drill');
        expect(code).toBe(1);
      } finally {
        await drop();
      }
    }
  });

  it('a purge-protected tenant is refused untouched — never deactivated because its delete was refused', async () => {
    await plant({ slug: DRILL_TENANT_ID, name: DRILL_TENANT_NAME, purgeProtected: true, config: { stagingDrill: { runs: [MARKER] } } });
    try {
      const before = await snapshot();
      const { code, report } = await cleanup(RUN);
      expect(await snapshot()).toBe(before);
      expect(report.tenant).toBe('refused');
      expect(report.kept.join(' ')).toContain('purge-protected');
      expect(code).toBe(1);
      // Creation applies the same rule: a protected tenant is never adopted.
      const io = captureIo();
      expect(await drillFixturesMain(['create', '--run-id', RUN_OTHER, '--admin-phone', ADMIN_PHONE], DRILL_ENV, io, appClient)).toBe(1);
      expect(io.errors.join('\n')).toContain('DRILL_TENANT_CONFLICT');
      expect(await snapshot()).toBe(before);
    } finally {
      await drop();
      await drillFixturesMain(['cleanup', '--run-id', RUN_OTHER], DRILL_ENV, captureIo(), appClient).catch(() => undefined);
    }
  });

  it('the drill’s own tenant is removed only by a run that used it: another run’s cleanup leaves it byte-identical', async () => {
    await plant({ slug: DRILL_TENANT_ID, name: DRILL_TENANT_NAME, config: { stagingDrill: { runs: [drillMarker(RUN_OTHER)] } } });
    try {
      const before = await snapshot();
      const { code, report } = await cleanup(RUN);
      expect(await snapshot()).toBe(before);
      expect(report.tenant).toBe('kept');
      expect(code).toBe(0);
      const own = await cleanup(RUN_OTHER);
      expect(own.report).toMatchObject({ tenant: 'removed', kept: [] });
      expect(await db.tenant.findUnique({ where: { id: DRILL_TENANT_ID } })).toBeNull();
    } finally {
      await drop();
    }
  });

  it('the one provenance rule (kind, slug, name, protection) and the run record it reads — pure', () => {
    expect(drillTenantRuns({ stagingDrill: { runs: ['DRILL-a', 7, 'DRILL-b'] } })).toEqual(['DRILL-a', 'DRILL-b']);
    expect(drillTenantRuns(null)).toEqual([]);
    expect(drillTenantRuns({ stagingDrill: 'DRILL-a' })).toEqual([]);
    expect(foreignDrillTenant({ kind: 'REVIEW', slug: DRILL_TENANT_ID, name: DRILL_TENANT_NAME, purgeProtected: false })).toContain('REVIEW');
    expect(foreignDrillTenant({ kind: 'CRAWLER', slug: 'x', name: DRILL_TENANT_NAME, purgeProtected: false })).toContain('not the drill');
    expect(foreignDrillTenant({ kind: 'CRAWLER', slug: DRILL_TENANT_ID, name: DRILL_TENANT_NAME, purgeProtected: true })).toContain('purge-protected');
    expect(foreignDrillTenant({ kind: 'CRAWLER', slug: DRILL_TENANT_ID, name: DRILL_TENANT_NAME, purgeProtected: false })).toBeNull();
  });
});
