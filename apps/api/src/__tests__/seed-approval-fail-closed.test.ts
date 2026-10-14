import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient, type UserRole } from '@prisma/client';
import { nanoid } from 'nanoid';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { applySeedPlan, buildSeedPlan, promoteBootstrapAdmin } from '../modules/ops/seed-plan';
import { consumeApprovals } from '../modules/ops/approver-signatures';

// ---------------------------------------------------------------------------
// [PROD-PATH] Fail closed even if the approval verifier were wrong. Here the
// verifier is replaced by one that "verifies" NOTHING (an empty list) for any
// input — a stand-in for a future bug. A break-glass SUPER_ADMIN promotion and
// a production spine apply must still refuse, inside their own transaction,
// BEFORE any account or configuration row is written: the change itself
// demands two distinct consumed approvals (consumeApprovals).
// ---------------------------------------------------------------------------

// vi.mock is hoisted above the imports, so seed-plan binds this verifier. It
// "verifies" whatever `broken.verified` holds (nothing, by default).
const broken = vi.hoisted(() => ({ verified: [] as unknown[] }));
vi.mock('../modules/ops/approver-signatures', async (importOriginal) => {
  const real = await importOriginal<typeof import('../modules/ops/approver-signatures')>();
  return { ...real, verifyApprovals: () => broken.verified };
});

grantSuiteCapability('unscoped-mutation');


const prisma = new PrismaClient();
const URL_ = process.env['DATABASE_URL'] ?? 'postgresql://swift:swift@localhost:5434/swift_test';
const KEY = `failclosed_${nanoid(6).toLowerCase()}`;
const userIds: string[] = [];
let priorIdentity: { deploymentId: string; environment: string; note: string | null } | null = null;
const setIdentity = (environment: string) => prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', deploymentId: 'dep-test', environment }, update: { deploymentId: 'dep-test', environment } });
const anyApproval = [{ approver: 'alice', request: 'cg==', signature: 'cw==' }, { approver: 'bob', request: 'cg==', signature: 'cw==' }];

beforeAll(async () => {
  await prisma.$connect();
  priorIdentity = await prisma.deploymentIdentity.findUnique({ where: { id: 'singleton' } });
  await setIdentity('test');
});
afterAll(async () => {
  await prisma.platformConfig.deleteMany({ where: { key: KEY } }).catch(() => {});
  await prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  if (priorIdentity) await prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...priorIdentity }, update: priorIdentity });
  else await prisma.deploymentIdentity.deleteMany({ where: { id: 'singleton' } }).catch(() => {});
  await prisma.$disconnect();
});

describe('[PROD-PATH] two consumed approvals, or no change — even past a broken verifier', () => {
  it('consumeApprovals refuses none, one, or two from the same key, and records nothing', async () => {
    const before = await prisma.privilegedChangeAudit.count({ where: { action: 'SEED_APPROVAL_CONSUMED' } });
    const v = (approver: string, fingerprint: string) => ({ approver, fingerprint, consumption: `approval:${nanoid(8)}`, admin: 'none', issued: new Date().toISOString(), expires: new Date(Date.now() + 3600_000).toISOString(), nonce: 'a'.repeat(32) });
    for (const list of [[], [v('alice', 'k1')], [v('alice', 'k1'), v('bob', 'k1')]]) {
      await expect(prisma.$transaction((tx) => consumeApprovals(tx, list, { action: 'TEST', target: {} }))).rejects.toMatchObject({ code: 'APPROVALS_REQUIRED' });
    }
    expect(await prisma.privilegedChangeAudit.count({ where: { action: 'SEED_APPROVAL_CONSUMED' } })).toBe(before);
  });

  it('a break-glass promotion refuses before the account is written', async () => {
    if ((await prisma.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } })) === 0) {
      const first = await promoteBootstrapAdmin(prisma, URL_, `+59260093${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`, { actor: 'test' });
      userIds.push(first.userId);
    }
    const phone = `+59260092${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
    await expect(promoteBootstrapAdmin(prisma, URL_, phone, { approvals: anyApproval, approverKeys: '' })).rejects.toMatchObject({ code: 'APPROVALS_REQUIRED' });
    expect(await prisma.user.count({ where: { phone } })).toBe(0);
  });

  it('a production spine apply refuses before any configuration row is written', async () => {
    await setIdentity('production');
    try {
      const desired = { version: 'failclosed-1', platformConfig: [{ key: KEY, value: 1 }], countries: [], zones: [], algoConfig: [], zoneFares: [] };
      const plan = await buildSeedPlan(prisma, URL_, desired);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: anyApproval, approverKeys: '' })).rejects.toMatchObject({ code: 'APPROVALS_REQUIRED' });
      expect(await prisma.platformConfig.findUnique({ where: { key: KEY } })).toBeNull();
    } finally {
      await setIdentity('test');
    }
  });

  it('[#1448 review] a production plan mints a first SUPER_ADMIN only for the phone its approvals name, even past a broken verifier', async () => {
    const supers = await prisma.user.findMany({ where: { roles: { has: 'SUPER_ADMIN' } }, select: { id: true, roles: true, activeRole: true } });
    const phone = `+59261554${String(Math.floor(Math.random() * 1e3)).padStart(3, '0')}`;
    await setIdentity('production');
    try {
      for (const u of supers) {
        const rest = u.roles.filter((r) => r !== 'SUPER_ADMIN');
        const roles: UserRole[] = rest.length > 0 ? rest : ['CUSTOMER'];
        await prisma.user.update({ where: { id: u.id }, data: { roles: { set: roles }, activeRole: roles.includes(u.activeRole) ? u.activeRole : roles[0]! } });
      }
      // Two distinct approvals that name NO first admin, "verified" by a broken verifier.
      const named = (admin: string, k: string) => ({ approver: k, fingerprint: `SHA256:${k}-${nanoid(6)}`, consumption: `approval:${nanoid(12)}`, admin, issued: new Date().toISOString(), expires: new Date(Date.now() + 3600_000).toISOString(), nonce: 'b'.repeat(32) });
      broken.verified = [named('none', 'alice'), named('none', 'bob')];
      const desired = { version: 'failclosed-2', platformConfig: [{ key: KEY, value: 2 }], countries: [], zones: [], algoConfig: [], zoneFares: [] };
      const plan = await buildSeedPlan(prisma, URL_, desired);
      const res = await applySeedPlan(prisma, URL_, desired, plan, { approvals: anyApproval, approverKeys: '', request: { adminPhone: phone } });
      expect(res.firstAdmin).toBeNull();
      expect(await prisma.user.count({ where: { phone } })).toBe(0);
      expect(await prisma.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } })).toBe(0);
    } finally {
      broken.verified = [];
      await prisma.user.updateMany({ where: { phone }, data: { roles: { set: ['CUSTOMER'] }, activeRole: 'CUSTOMER' } });
      for (const u of supers) await prisma.user.update({ where: { id: u.id }, data: { roles: { set: u.roles }, activeRole: u.activeRole } });
      await setIdentity('test');
    }
  });
});

