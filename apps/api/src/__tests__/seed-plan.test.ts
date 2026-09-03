import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { grantSuiteCapability } from '../lib/test-target-lock';
import {
  SeedRefused, applySeedPlan, buildSeedPlan, diffDesired, promoteBootstrapAdmin, seedPlanDigest, signPromotionApproval, signSeedApproval,
  type DesiredConfig, type SeedPlan,
} from '../modules/ops/seed-plan';
import { desiredPlatformConfig, seedPlatformSpine } from '../modules/ops/platform-config';
import { assertSafeToSeedDemo } from '../utils/seed-guard';
import { seedPlanCounter } from '../plugins/observability';

// [R048-005] this suite pins the deployment identity singleton for the whole file and restores it after
grantSuiteCapability('unscoped-mutation');

// ---------------------------------------------------------------------------
// [R048-005] Production seeding is a versioned, approved configuration change.
//
// Against the (populated) test database: the spine plans and applies; a
// replay plans ZERO changes and applies nothing; a plan whose body was edited
// under its digest is refused; a plan built for other desired data is refused;
// a plan bound to another target is refused; a production target needs two
// distinct approvals; the database changing between plan and apply is drift
// and refuses before any write; two seeders racing on the same plan apply it
// once; the first SUPER_ADMIN is bootstrap-only and a second promotion is a
// break-glass change; the demo guard refuses a database that calls itself
// production; and the platform seed holds no schema DDL.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const URL_ = process.env['DATABASE_URL'] ?? 'postgresql://swift:swift@localhost:5434/swift_test';
const SECRET = `s-${nanoid(12)}`;
let priorIdentity: { deploymentId: string; environment: string; note: string | null } | null = null;
const KEY = `r048005_${nanoid(6).toLowerCase()}`;
const userIds: string[] = [];

const setIdentity = (environment: string) => prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', deploymentId: 'dep-test', environment }, update: { deploymentId: 'dep-test', environment } });
const count = async (outcome: string) => (await seedPlanCounter.get()).values.find((v) => v.labels['outcome'] === outcome)?.value ?? 0;

/** A small desired config the suite owns outright: one platform key. */
const desiredFor = (value: number): DesiredConfig => ({ version: `test-${value}`, platformConfig: [{ key: KEY, value }], countries: [], zones: [], algoConfig: [], zoneFares: [] });
const auditEvents = (digest: string) => prisma.privilegedChangeAudit.findMany({ where: { planDigest: digest }, orderBy: { createdAt: 'asc' } }).then((r) => r.map((a) => a.event));

beforeAll(async () => {
  await prisma.$connect();
  priorIdentity = await prisma.deploymentIdentity.findUnique({ where: { id: 'singleton' } });
  await setIdentity('test');
});
afterAll(async () => {
  await prisma.platformConfig.deleteMany({ where: { key: KEY } }).catch(() => {});
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  if (priorIdentity) await prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...priorIdentity }, update: priorIdentity });
  else await prisma.deploymentIdentity.deleteMany({ where: { id: 'singleton' } }).catch(() => {});
  await prisma.$disconnect();
});

describe('[R048-005] the plan applies once; a replay changes nothing', () => {
  it('plan → apply → replay: the second plan has zero changes and the apply is a NOOP with its own audit row', async () => {
    const desired = desiredFor(1);
    const plan = await buildSeedPlan(prisma, URL_, desired);
    expect(plan.changes).toEqual([{ table: 'platformConfig', key: KEY, op: 'create', from: null, to: 1 }]);
    const res = await applySeedPlan(prisma, URL_, desired, plan, { actor: 'test' });
    expect(res).toMatchObject({ applied: 1, noop: false, configVersion: 'test-1' });
    expect(await auditEvents(plan.digest)).toEqual(['APPLIED']);
    const replay = await buildSeedPlan(prisma, URL_, desired);
    expect(replay.changes).toEqual([]);
    const before = await count('noop');
    const res2 = await applySeedPlan(prisma, URL_, desired, replay, { actor: 'test' });
    expect(res2).toMatchObject({ applied: 0, noop: true });
    expect(await auditEvents(replay.digest)).toEqual(['NOOP']);
    expect(await count('noop')).toBe(before + 1);
    // a changed desired value is a one-field update, from → to, and nothing else
    const v2 = desiredFor(2);
    const plan2 = await buildSeedPlan(prisma, URL_, v2);
    expect(plan2.changes).toEqual([{ table: 'platformConfig', key: KEY, op: 'update', from: 1, to: 2 }]);
    await applySeedPlan(prisma, URL_, v2, plan2, { actor: 'test' });
    expect((await prisma.platformConfig.findUniqueOrThrow({ where: { key: KEY } })).value).toBe(2);
  });

  it('the real platform spine plans and applies against this database, and its replay is empty', async () => {
    const first = await seedPlatformSpine(prisma, { databaseUrl: URL_, actor: 'test' });
    expect(first.configVersion).toBe(desiredPlatformConfig().version);
    const replay = await seedPlatformSpine(prisma, { databaseUrl: URL_, actor: 'test' });
    expect(replay.changes).toEqual([]);
    // and the seed carries no schema DDL — the migration ledger owns it
    for (const file of ['../../prisma/seed-platform.ts', '../modules/ops/platform-config.ts', '../modules/ops/seed-plan.ts']) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      expect(src, file).not.toMatch(/CREATE (UNIQUE )?INDEX|CREATE EXTENSION|ALTER TABLE|DROP /);
    }
  });
});

describe('[R048-005] a plan is bound: tampering, other data, another target, drift', () => {
  it('a body edited under its carried digest is tampered; honestly re-digested it is another configuration', async () => {
    const desired = desiredFor(3);
    const plan = await buildSeedPlan(prisma, URL_, desired);
    const widened: SeedPlan = { ...plan, changes: [...plan.changes, { table: 'platformConfig', key: `${KEY}_x`, op: 'create', from: null, to: 9 }] };
    await expect(applySeedPlan(prisma, URL_, desired, widened)).rejects.toMatchObject({ code: 'PLAN_TAMPERED' });
    const redigested: SeedPlan = { ...widened, digest: seedPlanDigest((({ digest: _d, ...b }) => { void _d; return b; })(widened)) };
    // the re-digested plan does not match the desired data it claims to apply
    await expect(applySeedPlan(prisma, URL_, desiredFor(4), redigested)).rejects.toMatchObject({ code: 'CONFIG_MISMATCH' });
    expect((await prisma.platformConfig.findUniqueOrThrow({ where: { key: KEY } })).value).toBe(2);
  });

  it('another target is refused before any write; an unknown identity is refused', async () => {
    const desired = desiredFor(5);
    const plan = await buildSeedPlan(prisma, URL_, desired);
    const foreign: SeedPlan = (() => { const body = { ...plan, target: { ...plan.target, digest: 'f'.repeat(64) } }; const { digest: _d, ...b } = body; void _d; return { ...b, digest: seedPlanDigest(b) }; })();
    const before = await count('refused_target');
    await expect(applySeedPlan(prisma, URL_, desired, foreign)).rejects.toMatchObject({ code: 'TARGET_MISMATCH' });
    expect(await count('refused_target')).toBe(before + 1);
    await prisma.deploymentIdentity.delete({ where: { id: 'singleton' } });
    const unknown = await buildSeedPlan(prisma, URL_, desired);
    expect(unknown.target.environment).toBe('unknown');
    await expect(applySeedPlan(prisma, URL_, desired, unknown)).rejects.toMatchObject({ code: 'TARGET_UNKNOWN' });
    await setIdentity('test');
    expect((await prisma.platformConfig.findUniqueOrThrow({ where: { key: KEY } })).value).toBe(2);
  });

  it('drift — the database changing between plan and apply — is refused inside the transaction, before any write, and audited', async () => {
    const desired = desiredFor(6);
    const plan = await buildSeedPlan(prisma, URL_, desired);
    await prisma.platformConfig.update({ where: { key: KEY }, data: { value: 7 } });
    const before = await count('refused_drift');
    await expect(applySeedPlan(prisma, URL_, desired, plan)).rejects.toMatchObject({ code: 'PLAN_DRIFT' });
    expect(await count('refused_drift')).toBe(before + 1);
    expect(await auditEvents(plan.digest)).toEqual(['REFUSED_DRIFT']);
    expect((await prisma.platformConfig.findUniqueOrThrow({ where: { key: KEY } })).value).toBe(7);
  });

  it('two seeders racing on the same plan: exactly one applies, the other sees drift', async () => {
    const desired = desiredFor(8);
    const plan = await buildSeedPlan(prisma, URL_, desired);
    // both seeders are held INSIDE the transaction after their drift check: only the advisory lock keeps the
    // second one out until the first has committed, so that it then re-checks and sees drift
    const hold = async () => { await new Promise((r) => setTimeout(r, 400)); };
    const results = await Promise.allSettled([applySeedPlan(prisma, URL_, desired, plan, { actor: 'a', failpoint: hold }), applySeedPlan(prisma, URL_, desired, plan, { actor: 'b', failpoint: hold })]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(SeedRefused);
    expect((refused[0]!.reason as SeedRefused).code).toBe('PLAN_DRIFT');
    expect((await prisma.platformConfig.findUniqueOrThrow({ where: { key: KEY } })).value).toBe(8);
    expect(await auditEvents(plan.digest)).toEqual(expect.arrayContaining(['APPLIED', 'REFUSED_DRIFT']));
  });
});

describe('[R048-005] a production target is a ceremony', () => {
  it('needs two DISTINCT approvals signed over the plan digest; one, two of the same, or a wrong secret refuse before any write', async () => {
    await setIdentity('production');
    try {
      const desired = desiredFor(9);
      const plan = await buildSeedPlan(prisma, URL_, desired);
      expect(plan.target.environment).toBe('production');
      await expect(applySeedPlan(prisma, URL_, desired, plan)).rejects.toMatchObject({ code: 'APPROVALS_REQUIRED' });
      await expect(applySeedPlan(prisma, URL_, desired, plan, { secret: SECRET, approvals: [signSeedApproval(SECRET, 'alice', plan.digest)] })).rejects.toMatchObject({ code: 'APPROVALS_REQUIRED' });
      await expect(applySeedPlan(prisma, URL_, desired, plan, { secret: SECRET, approvals: [signSeedApproval(SECRET, 'alice', plan.digest), signSeedApproval(SECRET, 'Alice ', plan.digest)] })).rejects.toMatchObject({ code: 'APPROVERS_NOT_DISTINCT' });
      await expect(applySeedPlan(prisma, URL_, desired, plan, { secret: SECRET, approvals: [signSeedApproval(SECRET, 'alice', plan.digest), signSeedApproval('other', 'bob', plan.digest)] })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      expect((await prisma.platformConfig.findUniqueOrThrow({ where: { key: KEY } })).value).toBe(8);
      const res = await applySeedPlan(prisma, URL_, desired, plan, { secret: SECRET, approvals: [signSeedApproval(SECRET, 'alice', plan.digest), signSeedApproval(SECRET, 'bob', plan.digest)], actor: 'alice' });
      expect(res.applied).toBe(1);
      const audit = await prisma.privilegedChangeAudit.findFirst({ where: { planDigest: plan.digest, event: 'APPLIED' } });
      expect((audit!.detail as { approvers: string[] }).approvers.sort()).toEqual(['alice', 'bob']);
      expect((audit!.detail as { configVersion: string }).configVersion).toBe('test-9');
    } finally {
      await setIdentity('test');
    }
  });
});

describe('[R048-005] the first SUPER_ADMIN is bootstrap-only; a second is break-glass', () => {
  it('bootstraps only while no SUPER_ADMIN exists; afterwards two approvals over this target and phone are required', async () => {
    const existing = await prisma.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } });
    const phone = `+59260099${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
    const phone2 = `+59260098${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
    if (existing === 0) {
      const first = await promoteBootstrapAdmin(prisma, URL_, phone, { actor: 'test' });
      userIds.push(first.userId);
      expect(first.mode).toBe('bootstrap');
    }
    // a SUPER_ADMIN exists now (ours or the seed's): no ceremony, no promotion
    await expect(promoteBootstrapAdmin(prisma, URL_, phone2, { actor: 'test' })).rejects.toMatchObject({ code: 'BREAK_GLASS_REQUIRED' });
    expect(await prisma.user.count({ where: { phone: phone2 } })).toBe(0);
    const target = (await buildSeedPlan(prisma, URL_, desiredFor(0))).target;
    await expect(promoteBootstrapAdmin(prisma, URL_, phone2, { secret: SECRET, approvals: [signPromotionApproval(SECRET, 'alice', target.digest, phone2), signPromotionApproval(SECRET, 'alice', target.digest, phone2)] })).rejects.toMatchObject({ code: 'APPROVERS_NOT_DISTINCT' });
    await expect(promoteBootstrapAdmin(prisma, URL_, phone2, { secret: SECRET, approvals: [signPromotionApproval(SECRET, 'alice', target.digest, phone2), signPromotionApproval(SECRET, 'bob', target.digest, phone)] })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    const promoted = await promoteBootstrapAdmin(prisma, URL_, phone2, { secret: SECRET, approvals: [signPromotionApproval(SECRET, 'alice', target.digest, phone2), signPromotionApproval(SECRET, 'bob', target.digest, phone2)], actor: 'alice' });
    userIds.push(promoted.userId);
    expect(promoted.mode).toBe('break-glass');
    const u = await prisma.user.findUniqueOrThrow({ where: { id: promoted.userId }, select: { roles: true, activeRole: true } });
    expect(u.roles).toContain('SUPER_ADMIN');
    const audit = await prisma.privilegedChangeAudit.findFirst({ where: { action: 'PROMOTE_SUPER_ADMIN', detail: { path: ['userId'], equals: promoted.userId } } });
    expect((audit!.detail as { mode: string; approvers: string[] })).toMatchObject({ mode: 'break-glass', approvers: ['alice', 'bob'] });
  });
});

describe('[R048-005] the demo seed needs an ephemeral database', () => {
  it('a database whose identity says production refuses the demo seed before a row is inspected; a test identity passes to the row checks', async () => {
    await setIdentity('production');
    try {
      await expect(assertSafeToSeedDemo(prisma, { NODE_ENV: 'test', SEED_DEMO_CONFIRM: 'YES' })).rejects.toThrow(/deployment identity is "production"/);
    } finally {
      await setIdentity('test');
    }
    // with a test identity the guard proceeds to the existing business-row checks (this database is not empty)
    await expect(assertSafeToSeedDemo(prisma, { NODE_ENV: 'test', SEED_DEMO_CONFIRM: 'YES' })).rejects.toThrow(/refusing to add demo data|non-demo/);
  });

  it('diffDesired is read-only', async () => {
    const before = await prisma.platformConfig.count();
    await diffDesired(prisma, desiredFor(99));
    expect(await prisma.platformConfig.count()).toBe(before);
  });
});
