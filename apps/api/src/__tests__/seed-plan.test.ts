import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient, type UserRole } from '@prisma/client';
import { nanoid } from 'nanoid';
import { grantSuiteCapability } from '../lib/test-target-lock';
import {
  SeedRefused, applySeedPlan, buildSeedPlan, diffDesired, planApprovalRequest, planRequestFacts, promoteBootstrapAdmin, promotionApprovalRequest, seedPlanDigest,
  type DesiredConfig, type SeedPlan,
} from '../modules/ops/seed-plan';
import { approvalRequest, parseApproverKeys, parseRequest, promotionSubject, type SignedApproval } from '../modules/ops/approver-signatures';
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
// [PROD-PATH] Approvers are PEOPLE with their own keys: three throwaway
// ed25519 keys made here exactly as an approver makes theirs, two pinned.
const KEYDIR = mkdtempSync(join(tmpdir(), 'seed-approvers-'));
const makeKey = (name: string) => {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(KEYDIR, name), '-C', name]);
  return readFileSync(join(KEYDIR, `${name}.pub`), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
};
const PUB = { alice: makeKey('alice'), bob: makeKey('bob'), mallory: makeKey('mallory') };
const PINNED = `alice ${PUB.alice}\nbob ${PUB.bob}\n`;
const APPROVE = join(process.cwd(), '../../deploy/seed-approve.sh');
/** `name` signs `request` with the private key of `keyOf` through the real deploy/seed-approve.sh. */
function sign(name: string, keyOf: string, request: string): SignedApproval {
  const out = execFileSync('bash', [APPROVE, name, join(KEYDIR, keyOf)], { input: request, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', SEED_APPROVE_YES: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  return JSON.parse(out.trim()) as SignedApproval;
}
const both = (request: string) => [sign('alice', 'alice', request), sign('bob', 'bob', request)];
let priorIdentity: { deploymentId: string; environment: string; note: string | null } | null = null;
const KEY = `r048005_${nanoid(6).toLowerCase()}`;
const userIds: string[] = [];

const setIdentity = (environment: string) => prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', deploymentId: 'dep-test', environment }, update: { deploymentId: 'dep-test', environment } });
const count = async (outcome: string) => (await seedPlanCounter.get()).values.find((v) => v.labels['outcome'] === outcome)?.value ?? 0;

/** A small desired config the suite owns outright: one platform key. */
const desiredFor = (value: number): DesiredConfig => ({ version: `test-${value}`, platformConfig: [{ key: KEY, value }], countries: [], zones: [], algoConfig: [], zoneFares: [] });
// [09-07] Ordered by (createdAt, id), not createdAt alone. `createdAt` is
// `DateTime @default(now())` — timestamp(3), millisecond resolution — and the last two
// events of a purge are written ~1 ms apart locally. On a loaded CI runner they land in
// the SAME millisecond, the tie is unresolved, and `.pop()` returned USER_DELETED instead
// of COMPLETED. That turned main red at 81da7f97. cuid ids are monotonic within a process,
// so they break the tie by insertion order. Production never reads these by order — the
// resume path filters on `event: 'USER_DELETED'` (ops/purge-plan.ts:208) — so this
// ambiguity was only ever visible to the tests, and only under load.
const auditEvents = (digest: string) => prisma.privilegedChangeAudit.findMany({ where: { planDigest: digest }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }).then((r) => r.map((a) => a.event));

beforeAll(async () => {
  await prisma.$connect();
  priorIdentity = await prisma.deploymentIdentity.findUnique({ where: { id: 'singleton' } });
  await setIdentity('test');
});
afterAll(async () => {
  rmSync(KEYDIR, { recursive: true, force: true });
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
  it('needs two approvals by two DIFFERENT pinned people; none, one, the same person twice, a name with someone else\'s key, or an unpinned person refuse before any write', async () => {
    await setIdentity('production');
    try {
      const desired = desiredFor(9);
      const plan = await buildSeedPlan(prisma, URL_, desired);
      expect(plan.target.environment).toBe('production');
      const request = planApprovalRequest(plan);
      const opts = (approvals: SignedApproval[]) => ({ approvals, approverKeys: PINNED });
      await expect(applySeedPlan(prisma, URL_, desired, plan)).rejects.toMatchObject({ code: 'APPROVALS_REQUIRED' });
      await expect(applySeedPlan(prisma, URL_, desired, plan, opts([sign('alice', 'alice', request)]))).rejects.toMatchObject({ code: 'APPROVALS_REQUIRED' });
      // One person, one key, twice (even re-signed: a fresh request, same key).
      await expect(applySeedPlan(prisma, URL_, desired, plan, opts([sign('alice', 'alice', request), sign('alice', 'alice', planApprovalRequest(plan))]))).rejects.toMatchObject({ code: 'APPROVERS_NOT_DISTINCT' });
      // One person cannot be two by choosing a name: bob's line signed with alice's key.
      await expect(applySeedPlan(prisma, URL_, desired, plan, opts([sign('alice', 'alice', request), sign('bob', 'alice', request)]))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      await expect(applySeedPlan(prisma, URL_, desired, plan, opts([sign('alice', 'alice', request), sign('mallory', 'mallory', request)]))).rejects.toMatchObject({ code: 'APPROVER_UNKNOWN' });
      // The same key pinned under two names is refused outright.
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: both(request), approverKeys: `alice ${PUB.alice}\nbob ${PUB.alice}\n` })).rejects.toMatchObject({ code: 'KEYS_MALFORMED' });
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: both(request), approverKeys: `alice ${PUB.alice}\n` })).rejects.toMatchObject({ code: 'APPROVERS_NOT_PINNED' });
      expect((await prisma.platformConfig.findUniqueOrThrow({ where: { key: KEY } })).value).toBe(8);
      const res = await applySeedPlan(prisma, URL_, desired, plan, { ...opts(both(request)), actor: 'alice' });
      expect(res.applied).toBe(1);
      const audit = await prisma.privilegedChangeAudit.findFirst({ where: { planDigest: plan.digest, event: 'APPLIED' } });
      expect((audit!.detail as { approvers: string[] }).approvers.sort()).toEqual(['alice', 'bob']);
      expect((audit!.detail as { configVersion: string }).configVersion).toBe('test-9');
    } finally {
      await setIdentity('test');
    }
  });

  it('[DS110 #17] the printed plan digest is STABLE — the re-run rebuilds the same digest, so the two signatures verify', async () => {
    await setIdentity('production');
    try {
      const desired = desiredFor(10);
      // The same plan built at two different moments: the ceremony prints the
      // request, the approvers sign it, and the re-run (a fresh `now`)
      // rebuilds the plan. Before the fix the fresh `createdAt` changed the
      // digest and every signature failed APPROVAL_INVALID — forever.
      const printed = await buildSeedPlan(prisma, URL_, desired, new Date('2026-09-23T10:00:00.000Z'));
      const rebuilt = await buildSeedPlan(prisma, URL_, desired, new Date('2026-09-23T15:45:00.000Z'));
      expect(rebuilt.createdAt).not.toBe(printed.createdAt);
      expect(rebuilt.changes).toEqual(printed.changes);
      expect(rebuilt.digest).toBe(printed.digest);
      const other = await buildSeedPlan(prisma, URL_, desiredFor(11), new Date('2026-09-23T10:00:00.000Z'));
      expect(other.digest).not.toBe(printed.digest);
      const res = await applySeedPlan(prisma, URL_, desired, rebuilt, { approvals: both(planApprovalRequest(printed)), approverKeys: PINNED, actor: 'alice' });
      expect(res).toMatchObject({ applied: 1, configVersion: 'test-10' });
      expect(await auditEvents(rebuilt.digest)).toEqual(['APPLIED']);
    } finally {
      await setIdentity('test');
    }
  });

  it('[PROD-PATH] approvals are single-use: after a rollback restores the approved precondition, the same lines are refused; fresh ones apply', async () => {
    await setIdentity('production');
    try {
      const desired = desiredFor(30);
      await prisma.platformConfig.deleteMany({ where: { key: KEY } });
      const plan = await buildSeedPlan(prisma, URL_, desired);
      const lines = both(planApprovalRequest(plan));
      expect(await applySeedPlan(prisma, URL_, desired, plan, { approvals: lines, approverKeys: PINNED })).toMatchObject({ applied: 1 });
      // Roll the data back to exactly the approved precondition: same target, same diff, same digest.
      await prisma.platformConfig.deleteMany({ where: { key: KEY } });
      const again = await buildSeedPlan(prisma, URL_, desired);
      expect(again.digest).toBe(plan.digest);
      await expect(applySeedPlan(prisma, URL_, desired, again, { approvals: lines, approverKeys: PINNED })).rejects.toMatchObject({ code: 'APPROVAL_REPLAYED' });
      expect(await prisma.platformConfig.findUnique({ where: { key: KEY } })).toBeNull();
      // Two fresh approvals (a new request, a new nonce) apply once more.
      expect(await applySeedPlan(prisma, URL_, desired, again, { approvals: both(planApprovalRequest(again)), approverKeys: PINNED })).toMatchObject({ applied: 1 });
    } finally {
      await setIdentity('test');
    }
  });

  it('[PROD-PATH] a used approval cannot come back in another form: armored, or re-signed with another hash, it is the same approval', async () => {
    await setIdentity('production');
    try {
      const desired = desiredFor(40);
      await prisma.platformConfig.deleteMany({ where: { key: KEY } });
      const plan = await buildSeedPlan(prisma, URL_, desired);
      const request = planApprovalRequest(plan);
      const bare = both(request);
      expect(await applySeedPlan(prisma, URL_, desired, plan, { approvals: bare, approverKeys: PINNED })).toMatchObject({ applied: 1 });
      await prisma.platformConfig.deleteMany({ where: { key: KEY } });
      const again = await buildSeedPlan(prisma, URL_, desired);
      // The same signatures exactly as `ssh-keygen -Y sign` prints them: armored.
      const armored = (name: string, hashAlg?: string): SignedApproval => ({
        approver: name,
        request: Buffer.from(request, 'utf8').toString('base64'),
        signature: execFileSync('ssh-keygen', ['-q', '-Y', 'sign', '-f', join(KEYDIR, name), '-n', 'swift-seed-approval', ...(hashAlg ? ['-O', `hashalg=${hashAlg}`] : [])], { input: request, encoding: 'utf8' }),
      });
      const armoredLines = [armored('alice'), armored('bob')];
      expect(armoredLines[0]!.signature).toContain('-----BEGIN SSH SIGNATURE-----');
      await expect(applySeedPlan(prisma, URL_, desired, again, { approvals: armoredLines, approverKeys: PINNED })).rejects.toMatchObject({ code: 'APPROVAL_REPLAYED' });
      // Re-signed with sha256 instead of sha512: a different valid signature, the same approval.
      await expect(applySeedPlan(prisma, URL_, desired, again, { approvals: [armored('alice', 'sha256'), armored('bob', 'sha256')], approverKeys: PINNED })).rejects.toMatchObject({ code: 'APPROVAL_REPLAYED' });
      expect(await prisma.platformConfig.findUnique({ where: { key: KEY } })).toBeNull();
    } finally {
      await setIdentity('test');
    }
  });

  it('[PROD-PATH] approvals expire, at most 72 hours ahead, and bind the plan and the database', async () => {
    await setIdentity('production');
    try {
      const desired = desiredFor(31);
      const plan = await buildSeedPlan(prisma, URL_, desired);
      const now = new Date();
      const expired = approvalRequest(planRequestFacts(plan), new Date(now.getTime() - 25 * 3600_000));
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: both(expired), approverKeys: PINNED })).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
      const tooLong = approvalRequest(planRequestFacts(plan), now, 80 * 3600_000);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: both(tooLong), approverKeys: PINNED })).rejects.toMatchObject({ code: 'APPROVAL_TOO_LONG' });
      const otherPlan = approvalRequest({ ...planRequestFacts(plan), subject: 'f'.repeat(64) }, now);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: both(otherPlan), approverKeys: PINNED })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      const otherDb = approvalRequest({ ...planRequestFacts(plan), target: 'e'.repeat(64) }, now);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: both(otherDb), approverKeys: PINNED })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      // A promotion approval is not a plan approval.
      const facts = planRequestFacts(plan);
      const promoteKind = approvalRequest({ ...facts, change: 'promote', shows: [facts.shows[0]!, 'promote: the phone ending 0000 becomes SUPER_ADMIN (its roles are set to SUPER_ADMIN and CUSTOMER)'] }, now);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: both(promoteKind), approverKeys: PINNED })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      expect(await prisma.platformConfig.findUnique({ where: { key: KEY } }).then((r) => r?.value)).not.toBe(31);
    } finally {
      await setIdentity('test');
    }
  });

  it('[PROD-PATH] the pinned-key list refuses one key under two names and malformed lines', () => {
    expect(() => parseApproverKeys(`alice ${PUB.alice}\nbob ${PUB.alice}`)).toThrow(/KEYS_MALFORMED/);
    expect(() => parseApproverKeys(`Alice ${PUB.alice}`)).toThrow(/KEYS_MALFORMED/);
    expect(() => parseApproverKeys(`alice ssh-rsa AAAA`)).toThrow(/KEYS_MALFORMED|KEY_UNSUPPORTED/);
    expect([...parseApproverKeys(`# pinned\nalice ${PUB.alice} alice@laptop\nbob ${PUB.bob}\n`).keys()]).toEqual(['alice', 'bob']);
  });
});

describe('[R048-005] the first SUPER_ADMIN is bootstrap-only; a second is break-glass', () => {
  it('bootstraps only while no SUPER_ADMIN exists; afterwards two pinned people approve this target and phone, once', async () => {
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
    const request = await promotionApprovalRequest(prisma, URL_, phone2);
    expect(request).not.toContain(phone2);
    expect(request).toContain(promotionSubject(phone2));
    const opts = (approvals: SignedApproval[]) => ({ approvals, approverKeys: PINNED, actor: 'alice' });
    await expect(promoteBootstrapAdmin(prisma, URL_, phone2, opts([sign('alice', 'alice', request), sign('alice', 'alice', await promotionApprovalRequest(prisma, URL_, phone2))]))).rejects.toMatchObject({ code: 'APPROVERS_NOT_DISTINCT' });
    await expect(promoteBootstrapAdmin(prisma, URL_, phone2, opts([sign('alice', 'alice', request), sign('bob', 'alice', request)]))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    // A half signed for another phone is refused.
    await expect(promoteBootstrapAdmin(prisma, URL_, phone2, opts([sign('alice', 'alice', request), sign('bob', 'bob', await promotionApprovalRequest(prisma, URL_, phone))]))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    // A half signed against another database (same phone) is refused.
    const elsewhere = new URL(URL_);
    elsewhere.hostname = 'another-database.internal';
    await expect(promoteBootstrapAdmin(prisma, URL_, phone2, opts([sign('alice', 'alice', request), sign('bob', 'bob', await promotionApprovalRequest(prisma, elsewhere.toString(), phone2))]))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
    expect(await prisma.user.count({ where: { phone: phone2 } })).toBe(0);
    const lines = both(request);
    const promoted = await promoteBootstrapAdmin(prisma, URL_, phone2, opts(lines));
    userIds.push(promoted.userId);
    expect(promoted.mode).toBe('break-glass');
    const u = await prisma.user.findUniqueOrThrow({ where: { id: promoted.userId }, select: { roles: true } });
    expect(u.roles).toContain('SUPER_ADMIN');
    const audit = await prisma.privilegedChangeAudit.findFirst({ where: { action: 'PROMOTE_SUPER_ADMIN', detail: { path: ['userId'], equals: promoted.userId } } });
    expect((audit!.detail as { mode: string; approvers: string[] })).toMatchObject({ mode: 'break-glass', approvers: ['alice', 'bob'] });
    // A phone that already holds SUPER_ADMIN changes nothing (no ceremony is owed for no change).
    expect(await promoteBootstrapAdmin(prisma, URL_, phone2, { actor: 'test' })).toMatchObject({ mode: 'already', userId: promoted.userId });
    // Single use: once the role is gone again, the same two lines cannot promote it back.
    await prisma.user.update({ where: { id: promoted.userId }, data: { roles: { set: ['CUSTOMER'] }, activeRole: 'CUSTOMER' } });
    await expect(promoteBootstrapAdmin(prisma, URL_, phone2, opts(lines))).rejects.toMatchObject({ code: 'APPROVAL_REPLAYED' });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: promoted.userId }, select: { roles: true } })).roles).not.toContain('SUPER_ADMIN');
  });
});

describe('[PROD-PATH] the real seed entry point on a production target', () => {
  it('prints the request alone on stdout and exits 2; two pinned people sign it; the re-run applies; the lines are spent', async () => {
    const spineKey = desiredPlatformConfig().platformConfig[0]!.key;
    await setIdentity('production');
    try {
      // A real change to approve: one spine key is missing.
      await prisma.platformConfig.deleteMany({ where: { key: spineKey } });
      const run = (extra: Record<string, string>) => spawnSync(join(process.cwd(), 'node_modules/.bin/tsx'), ['prisma/seed-production.ts'], {
        encoding: 'utf8',
        timeout: 90_000,
        env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test', DATABASE_URL: URL_, ...extra },
      });
      const first = run({});
      expect(first.status, first.stderr).toBe(2);
      const request = first.stdout;
      expect(request.split('\n')[0]).toBe('swift-seed-approval v2');
      expect(request).toMatch(/^kind: plan$/m);
      // What the approvers read, in words, is in the signed request.
      expect(request).toMatch(/^database: \S+ on \S+, deployment dep-test \(production\)$/m);
      expect(request).toMatch(/^config: \S+ \([0-9a-f]{16}\), 1 change, FX \d+(\.\d+)? GYD per USD$/m);
      expect(request).toMatch(new RegExp(`^change: create platformConfig ${spineKey}: null -> `, 'm'));
      expect(await prisma.platformConfig.findUnique({ where: { key: spineKey } })).toBeNull();
      const lines = both(request);
      const applied = run({ SEED_PLAN_APPROVALS: JSON.stringify(lines), SEED_APPROVER_KEYS: PINNED });
      expect(applied.status, applied.stderr).toBe(0);
      expect(await prisma.platformConfig.findUnique({ where: { key: spineKey } })).not.toBeNull();
      // Roll back to the approved precondition and replay the same two lines: refused.
      await prisma.platformConfig.deleteMany({ where: { key: spineKey } });
      const replay = run({ SEED_PLAN_APPROVALS: JSON.stringify(lines), SEED_APPROVER_KEYS: PINNED });
      expect(replay.status).toBe(1);
      expect(replay.stderr).toContain('APPROVAL_REPLAYED');
      expect(await prisma.platformConfig.findUnique({ where: { key: spineKey } })).toBeNull();
    } finally {
      await setIdentity('test');
      await seedPlatformSpine(prisma, { databaseUrl: URL_, actor: 'test' });
    }
  }, 300_000);

  it('deploy/seed-approve.sh signs only a well-formed request, only after a yes, and prints one line', () => {
    const okRequest = approvalRequest({ change: 'plan', target: 'a'.repeat(64), subject: 'b'.repeat(64), admin: 'none', shows: [
      'database: swift on postgres, deployment dep-x (production)', 'config: v1 (0123456789abcdef), 0 changes, FX 209 GYD per USD', 'admin phone: none',
    ] });
    const runApprove = (input: string, env: Record<string, string>, name = 'alice') => spawnSync('bash', [APPROVE, name, join(KEYDIR, 'alice')], { input, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...env } });
    const good = runApprove(`\n${okRequest.replace(/\n/g, '\r\n')}\n\n`, { SEED_APPROVE_YES: '1' });
    expect(good.status, good.stderr).toBe(0);
    const line = JSON.parse(good.stdout.trim()) as SignedApproval;
    expect(Buffer.from(line.request, 'base64').toString('utf8')).toBe(okRequest);
    expect(good.stdout.trim().split('\n')).toHaveLength(1);
    expect(runApprove('hello\n', { SEED_APPROVE_YES: '1' }).status).not.toBe(0);
    expect(runApprove(okRequest + 'extra: line\n', { SEED_APPROVE_YES: '1' }).status).not.toBe(0);
    expect(runApprove(okRequest, { SEED_APPROVE_YES: '1' }, 'Alice Smith').status).not.toBe(0);
    // No terminal and no explicit yes: nothing is signed.
    const unconfirmed = runApprove(okRequest, {});
    expect(unconfirmed.status).not.toBe(0);
    expect(unconfirmed.stdout).toBe('');
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

// ---------------------------------------------------------------------------
// [PROD-PATH · #1448 review S3/S4] The ceremony is bound to what people read:
// the approvers see the database, the configuration and FX rate, the first
// admin (last four digits) and every change, and the server applies only
// approvals whose words match the change it is about to make. A request is
// good for at most 72 hours from when it was ISSUED. Approvals of a plan with
// nothing to change are used up too. On production the first SUPER_ADMIN is
// minted only by the signed plan that names it.
// ---------------------------------------------------------------------------
describe('[PROD-PATH] the seed ceremony is bound to what the approvers read', () => {
  const PHONE = `+5926155${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;

  it('deploy/seed-approve.sh shows the database, the FX rate, the first admin and every change before the yes', async () => {
    await setIdentity('production');
    try {
      await prisma.platformConfig.deleteMany({ where: { key: KEY } });
      const plan = await buildSeedPlan(prisma, URL_, desiredFor(50));
      const request = planApprovalRequest(plan, { fxGydPerUsd: 212.5, adminPhone: PHONE });
      const out = spawnSync('bash', [APPROVE, 'alice', join(KEYDIR, 'alice')], { input: request, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', SEED_APPROVE_YES: '1' } });
      expect(out.status, out.stderr).toBe(0);
      // The readable summary (before the exact signed text) says it all.
      const summary = out.stderr.split('Signed exactly as')[0]!;
      expect(summary).toContain(`database: ${plan.target.database} on ${plan.target.host}, deployment dep-test (production)`);
      expect(summary).toContain('FX 212.5 GYD per USD');
      expect(summary).toContain(`admin phone: ending ${PHONE.slice(-4)} becomes the first SUPER_ADMIN`);
      expect(summary).toMatch(new RegExp(`^ {6}create platformConfig ${KEY}: null -> 50$`, 'm'));
      expect(out.stderr).not.toContain(PHONE);
    } finally {
      await setIdentity('test');
    }
  });

  it('deploy/seed-approve.sh refuses a request that hides what it approves: no database, no configuration, a hidden line, or something after the end', () => {
    const facts = { change: 'plan' as const, target: 'a'.repeat(64), subject: 'b'.repeat(64), admin: 'none',
      shows: ['database: swift on postgres, deployment dep-x (production)', 'config: v1 (0123456789abcdef), 0 changes, FX 209 GYD per USD', 'admin phone: none'] };
    const ok = approvalRequest(facts);
    const run = (input: string) => spawnSync('bash', [APPROVE, 'alice', join(KEYDIR, 'alice')], { input, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', SEED_APPROVE_YES: '1' } });
    expect(run(ok).status).toBe(0);
    expect(run(ok.split('\n').filter((l) => !l.startsWith('database: ')).join('\n')).status).not.toBe(0);
    expect(run(ok.split('\n').filter((l) => !l.startsWith('config: ')).join('\n')).status).not.toBe(0);
    expect(run(ok.replace('admin phone: none', 'admin phone: none\x1b[2K\x1b[1A')).status).not.toBe(0);
    expect(run(`${ok}change: create platformConfig x: null -> 1\n`).status).not.toBe(0);
    expect(run(ok.replace('swift-seed-approval v2', 'swift-seed-approval v1')).status).not.toBe(0);
  });

  it('the server refuses a request whose words carry a control character (C0 or C1), or that does not name the database', () => {
    const facts = { change: 'plan' as const, target: 'a'.repeat(64), subject: 'b'.repeat(64), admin: 'none',
      shows: ['database: swift on postgres, deployment dep-x (production)', 'config: v1 (0123456789abcdef), 0 changes, FX 209 GYD per USD', 'admin phone: none'] };
    expect(parseRequest(approvalRequest(facts)).shows).toEqual(facts.shows);
    for (const hidden of ['\u001b[2K', '\u009b2K', '\u007f']) {
      expect(() => parseRequest(approvalRequest({ ...facts, shows: [facts.shows[0]!, `${facts.shows[1]!}${hidden}`, facts.shows[2]!] }))).toThrow(/REQUEST_MALFORMED/);
    }
    expect(() => parseRequest(approvalRequest({ ...facts, shows: facts.shows.slice(1) }))).toThrow(/REQUEST_MALFORMED/);
  });

  it('the server refuses approvals signed over other words: another FX rate, another first admin', async () => {
    await setIdentity('production');
    try {
      await prisma.platformConfig.deleteMany({ where: { key: KEY } });
      const desired = desiredFor(51);
      const plan = await buildSeedPlan(prisma, URL_, desired);
      const opts = (request: string) => ({ approvals: both(request), approverKeys: PINNED, request: { fxGydPerUsd: 209, adminPhone: PHONE } });
      await expect(applySeedPlan(prisma, URL_, desired, plan, opts(planApprovalRequest(plan, { fxGydPerUsd: 215, adminPhone: PHONE })))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      await expect(applySeedPlan(prisma, URL_, desired, plan, opts(planApprovalRequest(plan, { fxGydPerUsd: 209, adminPhone: '+5926155000' })))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      await expect(applySeedPlan(prisma, URL_, desired, plan, opts(planApprovalRequest(plan, { fxGydPerUsd: 209 })))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      // A phone with the same last four digits reads the same, but is not the phone that was signed for.
      const twin = `+5926156${PHONE.slice(-4)}`;
      await expect(applySeedPlan(prisma, URL_, desired, plan, opts(planApprovalRequest(plan, { fxGydPerUsd: 209, adminPhone: twin })))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      // The same digests with a reworded change line are refused too: the words are signed.
      const reworded = planApprovalRequest(plan, { fxGydPerUsd: 209, adminPhone: PHONE }).replace(`create platformConfig ${KEY}: null -> 51`, `create platformConfig ${KEY}: null -> 5`);
      await expect(applySeedPlan(prisma, URL_, desired, plan, opts(reworded))).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      expect(await prisma.platformConfig.findUnique({ where: { key: KEY } })).toBeNull();
      expect(await applySeedPlan(prisma, URL_, desired, plan, opts(planApprovalRequest(plan, { fxGydPerUsd: 209, adminPhone: PHONE })))).toMatchObject({ applied: 1 });
    } finally {
      await setIdentity('test');
    }
  });

  it('a request is good for at most 72 hours from when it was issued, however late it is used; one issued in the future is refused', async () => {
    await setIdentity('production');
    try {
      await prisma.platformConfig.deleteMany({ where: { key: KEY } });
      const desired = desiredFor(52);
      const plan = await buildSeedPlan(prisma, URL_, desired);
      const now = new Date();
      // Issued 70 hours ago with an 80-hour life: it expires in 10 hours, but it was good for more than 72 from issue.
      const stale = approvalRequest(planRequestFacts(plan), new Date(now.getTime() - 70 * 3600_000), 80 * 3600_000);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: both(stale), approverKeys: PINNED })).rejects.toMatchObject({ code: 'APPROVAL_TOO_LONG' });
      const future = approvalRequest(planRequestFacts(plan), new Date(now.getTime() + 3600_000), 3600_000);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: both(future), approverKeys: PINNED })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      // Issued 70 hours ago with a 72-hour life: still good for 2 hours.
      const late = approvalRequest(planRequestFacts(plan), new Date(now.getTime() - 70 * 3600_000), 72 * 3600_000);
      expect(await applySeedPlan(prisma, URL_, desired, plan, { approvals: both(late), approverKeys: PINNED })).toMatchObject({ applied: 1 });
    } finally {
      await setIdentity('test');
    }
  });

  it('approvals of a plan with nothing to change are used up: the same lines are refused next time', async () => {
    await setIdentity('production');
    try {
      const desired = desiredFor(53);
      await prisma.platformConfig.upsert({ where: { key: KEY }, update: { value: 53 }, create: { key: KEY, value: 53 } });
      const plan = await buildSeedPlan(prisma, URL_, desired);
      expect(plan.changes).toEqual([]);
      const lines = both(planApprovalRequest(plan));
      expect(await applySeedPlan(prisma, URL_, desired, plan, { approvals: lines, approverKeys: PINNED })).toMatchObject({ applied: 0, noop: true });
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: lines, approverKeys: PINNED })).rejects.toMatchObject({ code: 'APPROVAL_REPLAYED' });
      // Consumed means recorded: each line once, as SEED_CONFIG's.
      const consumed = await prisma.privilegedChangeAudit.count({ where: { action: 'SEED_APPROVAL_CONSUMED', detail: { path: ['nonce'], equals: Buffer.from(lines[0]!.request, 'base64').toString('utf8').match(/^nonce: (\w+)$/m)![1]! } } });
      expect(consumed).toBe(2);
    } finally {
      await setIdentity('test');
    }
  });

  it('a signed NOOP seeder waiting behind a config change refuses drift before consuming approvals or minting the first admin', async () => {
    const supers = await prisma.user.findMany({ where: { roles: { has: 'SUPER_ADMIN' } }, select: { id: true, roles: true, activeRole: true } });
    const phone = '+5926155998'; // synthetic, suite-owned
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const firstLocked = new Promise<void>((resolve) => { locked = resolve; });
    let attempted!: () => void;
    const secondLock = new Promise<void>((resolve) => { attempted = resolve; });
    const secondClient = prisma.$extends({ query: { $executeRaw({ args, query }) { attempted(); return query(args); } } });
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await setIdentity('production');
    try {
      for (const u of supers) await prisma.user.update({ where: { id: u.id }, data: { roles: { set: ['CUSTOMER'] }, activeRole: 'CUSTOMER' } });
      await prisma.platformConfig.upsert({ where: { key: KEY }, create: { key: KEY, value: 72 }, update: { value: 72 } });
      const desired = desiredFor(72);
      const noop = await buildSeedPlan(prisma, URL_, desired);
      expect(noop.changes).toEqual([]);
      const request = { fxGydPerUsd: 209, adminPhone: phone };
      const approvals = both(planApprovalRequest(noop, request));
      const changing = desiredFor(73);
      const change = await buildSeedPlan(prisma, URL_, changing);
      first = applySeedPlan(prisma, URL_, changing, change, {
        approvals: both(planApprovalRequest(change)), approverKeys: PINNED,
        failpoint: async () => { locked(); await held; },
      });
      await firstLocked;
      // Another independent signed seeder still rebuilds an empty diff while
      // the first owns the lock, before that transaction writes its change.
      expect((await buildSeedPlan(prisma, URL_, desired)).changes).toEqual([]);
      second = applySeedPlan(secondClient as unknown as PrismaClient, URL_, desired, noop, { approvals, approverKeys: PINNED, request });
      const result = Promise.allSettled([first, second]);
      await secondLock;
      release();
      const [winner, loser] = await result;
      expect(winner.status).toBe('fulfilled');
      expect(loser).toMatchObject({ status: 'rejected', reason: { code: 'PLAN_DRIFT' } });
      expect((await prisma.platformConfig.findUniqueOrThrow({ where: { key: KEY } })).value).toBe(73);
      expect(await prisma.user.count({ where: { phone } })).toBe(0);
      const nonce = parseRequest(Buffer.from(approvals[0]!.request, 'base64').toString('utf8')).nonce;
      expect(await prisma.privilegedChangeAudit.count({ where: { action: 'SEED_APPROVAL_CONSUMED', detail: { path: ['nonce'], equals: nonce } } })).toBe(0);
      expect(await auditEvents(noop.digest)).toEqual(['REFUSED_DRIFT']);
    } finally {
      release();
      await Promise.allSettled([first, second]);
      const minted = await prisma.user.findUnique({ where: { phone }, select: { id: true } });
      if (minted) { userIds.push(minted.id); await prisma.user.update({ where: { id: minted.id }, data: { roles: { set: ['CUSTOMER'] }, activeRole: 'CUSTOMER' } }); }
      for (const u of supers) await prisma.user.update({ where: { id: u.id }, data: { roles: { set: u.roles }, activeRole: u.activeRole } });
      await setIdentity('test');
    }
  });

  it('on production the first SUPER_ADMIN is minted only by the signed plan that names its phone', async () => {
    // A production database with no SUPER_ADMIN yet: the suite's database has
    // some, so their role is set aside for this case and put back after.
    const supers = await prisma.user.findMany({ where: { roles: { has: 'SUPER_ADMIN' } }, select: { id: true, roles: true, activeRole: true } });
    await setIdentity('production');
    try {
      for (const u of supers) {
        const rest = u.roles.filter((r) => r !== 'SUPER_ADMIN');
        const roles: UserRole[] = rest.length > 0 ? rest : ['CUSTOMER'];
        await prisma.user.update({ where: { id: u.id }, data: { roles: { set: roles }, activeRole: roles.includes(u.activeRole) ? u.activeRole : roles[0]! } });
      }
      expect(await prisma.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } })).toBe(0);
      // No ceremony-free first admin on production.
      await expect(promoteBootstrapAdmin(prisma, URL_, PHONE, { actor: 'test' })).rejects.toMatchObject({ code: 'FIRST_ADMIN_NEEDS_PLAN' });
      expect(await prisma.user.count({ where: { phone: PHONE } })).toBe(0);
      await prisma.platformConfig.deleteMany({ where: { key: KEY } });
      const desired = desiredFor(54);
      const plan = await buildSeedPlan(prisma, URL_, desired);
      // A plan signed without naming an admin mints none.
      const unnamed = await applySeedPlan(prisma, URL_, desired, plan, { approvals: both(planApprovalRequest(plan)), approverKeys: PINNED });
      expect(unnamed.firstAdmin).toBeNull();
      expect(await prisma.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } })).toBe(0);
      // The signed plan that names the phone mints it, in the plan's own transaction, audited with the plan.
      await prisma.platformConfig.deleteMany({ where: { key: KEY } });
      const again = await buildSeedPlan(prisma, URL_, desired);
      const ctx = { fxGydPerUsd: 209, adminPhone: PHONE };
      const named = await applySeedPlan(prisma, URL_, desired, again, { approvals: both(planApprovalRequest(again, ctx)), approverKeys: PINNED, request: ctx, actor: 'alice' });
      expect(named.firstAdmin).not.toBeNull();
      userIds.push(named.firstAdmin!.userId);
      const admin = await prisma.user.findUniqueOrThrow({ where: { id: named.firstAdmin!.userId }, select: { phone: true, roles: true } });
      expect(admin).toMatchObject({ phone: PHONE });
      expect(admin.roles).toContain('SUPER_ADMIN');
      const audit = await prisma.privilegedChangeAudit.findFirst({ where: { action: 'PROMOTE_SUPER_ADMIN', detail: { path: ['userId'], equals: named.firstAdmin!.userId } } });
      expect(audit!.detail).toMatchObject({ mode: 'signed-plan', plan: again.digest });
      expect(((audit!.detail as { approvers: string[] }).approvers).sort()).toEqual(['alice', 'bob']);
    } finally {
      await prisma.user.updateMany({ where: { phone: PHONE }, data: { roles: { set: ['CUSTOMER'] }, activeRole: 'CUSTOMER' } });
      for (const u of supers) await prisma.user.update({ where: { id: u.id }, data: { roles: { set: u.roles }, activeRole: u.activeRole } });
      await setIdentity('test');
    }
  });
});
