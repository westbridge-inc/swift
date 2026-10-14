import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient, type UserRole } from '@prisma/client';
import { nanoid } from 'nanoid';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { applySeedPlan, buildSeedPlan, planApprovalRequest, planRequestFacts, type DesiredConfig } from '../modules/ops/seed-plan';
import { approvalRequest, SOLO_COOLING_OFF_MS, SOLO_DEFAULT_LIFETIME_MS, SOLO_SHOW_LINE, type SignedApproval } from '../modules/ops/approver-signatures';
import { desiredPlatformConfig, spineRequestContext } from '../modules/ops/platform-config';

// This suite pins the deployment identity singleton for the whole file and restores it after.
grantSuiteCapability('unscoped-mutation');

// ---------------------------------------------------------------------------
// [SOLO SEED] Owner ruling 13 Oct (#13), coordinator ruling: the owner has no
// second admin yet, so the production seed that mints the FIRST SUPER_ADMIN
// may be approved by ONE pinned person, mirroring the in-app solo rule:
//   - only when the seed creates exactly one admin (none exists, the signed
//     plan names the phone); any other production change keeps two people;
//   - a mandatory cooling-off of at least 12 hours between the signed
//     request (its issue time is inside what is signed) and the run: an
//     early run is refused and told when it may run;
//   - the signer reads, in the request itself, that it is a one-person
//     approval; a two-person request never passes as solo, nor the reverse;
//   - single use, and the signed record (request and signature) is kept in
//     the append-only audit with the seed.
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();
const URL_ = process.env['DATABASE_URL'] ?? 'postgresql://swift:swift@localhost:5434/swift_test';
const KEYDIR = mkdtempSync(join(tmpdir(), 'seed-solo-approvers-'));
const makeKey = (name: string) => {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(KEYDIR, name), '-C', name]);
  return readFileSync(join(KEYDIR, `${name}.pub`), 'utf8').trim().split(/\s+/).slice(0, 2).join(' ');
};
const PUB = { owner: makeKey('owner'), bob: makeKey('bob') };
const OWNER_ONLY = `owner ${PUB.owner}\n`;
const TWO_PINNED = `owner ${PUB.owner}\nbob ${PUB.bob}\n`;
const APPROVE = join(process.cwd(), '../../deploy/seed-approve.sh');
const yesFor = (request: string) => ({ SEED_APPROVE_YES: /^nonce: ([0-9a-f]+)$/m.exec(request)?.[1] ?? 'missing-nonce' });
function signWith(name: string, request: string): { line: SignedApproval; shown: string } {
  const r = spawnSync('bash', [APPROVE, name, join(KEYDIR, name)], { input: request, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...yesFor(request) } });
  expect(r.status, r.stderr).toBe(0);
  return { line: JSON.parse(r.stdout.trim()) as SignedApproval, shown: r.stderr };
}
const sign = (name: string, request: string) => signWith(name, request).line;

const HOUR = 60 * 60 * 1000;
const KEY = `solo_${nanoid(6).toLowerCase()}`;
const PHONE = `+5920477${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
const userIds: string[] = [];
let priorIdentity: { deploymentId: string; environment: string; note: string | null } | null = null;
let supers: Array<{ id: string; roles: UserRole[]; activeRole: UserRole }> = [];

const setIdentity = (environment: string) => prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', deploymentId: 'dep-test', environment }, update: { deploymentId: 'dep-test', environment } });
const desiredFor = (value: number): DesiredConfig => ({ version: `solo-${value}`, platformConfig: [{ key: KEY, value }], countries: [], zones: [], algoConfig: [], zoneFares: [] });
const superCount = () => prisma.user.count({ where: { roles: { has: 'SUPER_ADMIN' } } });
const keyValue = async () => (await prisma.platformConfig.findUnique({ where: { key: KEY } }))?.value ?? null;
/** The production database with NO SUPER_ADMIN: the suite's database has some, so their role is set aside. */
async function noSuperAdmin(): Promise<void> {
  for (const u of await prisma.user.findMany({ where: { roles: { has: 'SUPER_ADMIN' } }, select: { id: true, roles: true, activeRole: true } })) {
    if (!supers.some((s) => s.id === u.id)) supers.push(u);
    const rest = u.roles.filter((r) => r !== 'SUPER_ADMIN');
    const roles: UserRole[] = rest.length > 0 ? rest : ['CUSTOMER'];
    await prisma.user.update({ where: { id: u.id }, data: { roles: { set: roles }, activeRole: roles.includes(u.activeRole) ? u.activeRole : roles[0]! } });
  }
  expect(await superCount()).toBe(0);
}
async function restoreSupers(): Promise<void> {
  await prisma.user.updateMany({ where: { phone: PHONE }, data: { roles: { set: ['CUSTOMER'] }, activeRole: 'CUSTOMER' } });
  for (const u of supers) await prisma.user.update({ where: { id: u.id }, data: { roles: { set: u.roles }, activeRole: u.activeRole } });
}
/** A production plan with one real change, and a solo request for it issued `ago` before now. */
async function soloCase(value: number, ago: number, adminPhone: string | null = PHONE) {
  await prisma.platformConfig.deleteMany({ where: { key: KEY } });
  const desired = desiredFor(value);
  const plan = await buildSeedPlan(prisma, URL_, desired);
  const ctx = { fxGydPerUsd: 209, adminPhone, solo: true };
  const request = planApprovalRequest(plan, ctx, new Date(Date.now() - ago));
  return { desired, plan, ctx, request };
}

beforeAll(async () => {
  await prisma.$connect();
  priorIdentity = await prisma.deploymentIdentity.findUnique({ where: { id: 'singleton' } });
  await setIdentity('production');
});
afterAll(async () => {
  rmSync(KEYDIR, { recursive: true, force: true });
  await restoreSupers().catch(() => {});
  await prisma.platformConfig.deleteMany({ where: { key: KEY } }).catch(() => {});
  const ids = [...userIds, ...(await prisma.user.findMany({ where: { phone: PHONE }, select: { id: true } })).map((u) => u.id)];
  await prisma.session.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.admin.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.customer.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
  if (priorIdentity) await prisma.deploymentIdentity.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...priorIdentity }, update: priorIdentity });
  else await prisma.deploymentIdentity.deleteMany({ where: { id: 'singleton' } }).catch(() => {});
  await prisma.$disconnect();
});

describe('[SOLO SEED] the request says it is a one-person approval, and how long it waits', () => {
  it('a solo request carries the solo line the signer reads, and is valid for 48 hours from issue', async () => {
    const { request } = await soloCase(1, 0);
    expect(request).toContain(`\n${SOLO_SHOW_LINE}\n`);
    const issued = Date.parse(/^issued: (.+)$/m.exec(request)![1]!);
    const expires = Date.parse(/^expires: (.+)$/m.exec(request)![1]!);
    expect(expires - issued).toBe(SOLO_DEFAULT_LIFETIME_MS);
    expect(SOLO_COOLING_OFF_MS).toBeGreaterThanOrEqual(12 * HOUR);
    const { shown } = signWith('owner', request);
    expect(shown).toContain(SOLO_SHOW_LINE);
  });

  it('solo never covers a seed that mints no admin: no admin phone, no solo request', async () => {
    await prisma.platformConfig.deleteMany({ where: { key: KEY } });
    const plan = await buildSeedPlan(prisma, URL_, desiredFor(2));
    expect(() => planRequestFacts(plan, { fxGydPerUsd: 209, adminPhone: null, solo: true })).toThrow(/SOLO_NOT_ALLOWED/);
  });
});

describe('[SOLO SEED] one pinned person mints the first SUPER_ADMIN, after the cooling-off', () => {
  it('an early run is refused and told when it may run; nothing is written or used up', async () => {
    await noSuperAdmin();
    try {
      const { desired, plan, ctx, request } = await soloCase(3, SOLO_COOLING_OFF_MS - 60_000);
      const line = sign('owner', request);
      let error: unknown;
      try { await applySeedPlan(prisma, URL_, desired, plan, { approvals: [line], approverKeys: OWNER_ONLY, request: ctx, actor: 'owner' }); } catch (e) { error = e; }
      expect(error).toMatchObject({ code: 'COOLING_OFF' });
      const runsFrom = new Date(Date.parse(/^issued: (.+)$/m.exec(request)![1]!) + SOLO_COOLING_OFF_MS).toISOString();
      expect(String((error as Error).message)).toContain(runsFrom);
      expect(await keyValue()).toBeNull();
      expect(await superCount()).toBe(0);
      expect(await prisma.privilegedChangeAudit.count({ where: { action: 'SEED_APPROVAL_CONSUMED', detail: { path: ['nonce'], equals: /^nonce: (.+)$/m.exec(request)![1]! } } })).toBe(0);
    } finally {
      await restoreSupers();
    }
  });

  it('after 12 hours the one approval applies the plan and mints the named phone, once; the signed record is kept', async () => {
    await noSuperAdmin();
    try {
      const { desired, plan, ctx, request } = await soloCase(4, SOLO_COOLING_OFF_MS + 60_000);
      const line = sign('owner', request);
      const res = await applySeedPlan(prisma, URL_, desired, plan, { approvals: [line], approverKeys: OWNER_ONLY, request: ctx, actor: 'owner' });
      expect(res.applied).toBe(1);
      expect(res.firstAdmin).not.toBeNull();
      userIds.push(res.firstAdmin!.userId);
      expect(await keyValue()).toBe(4);
      const admin = await prisma.user.findUniqueOrThrow({ where: { id: res.firstAdmin!.userId }, select: { phone: true, roles: true } });
      expect(admin.phone).toBe(PHONE);
      expect(admin.roles).toContain('SUPER_ADMIN');
      const applied = await prisma.privilegedChangeAudit.findFirstOrThrow({ where: { planDigest: plan.digest, event: 'APPLIED' } });
      expect(applied.detail).toMatchObject({ approvers: ['owner'], solo: true });
      const promoted = await prisma.privilegedChangeAudit.findFirstOrThrow({ where: { action: 'PROMOTE_SUPER_ADMIN', detail: { path: ['userId'], equals: res.firstAdmin!.userId } } });
      expect(promoted.detail).toMatchObject({ mode: 'signed-plan', solo: true, approvers: ['owner'] });
      const consumed = await prisma.privilegedChangeAudit.findFirstOrThrow({ where: { action: 'SEED_APPROVAL_CONSUMED', detail: { path: ['nonce'], equals: /^nonce: (.+)$/m.exec(request)![1]! } } });
      expect(consumed.detail).toMatchObject({ mode: 'solo', approver: 'owner', request: line.request, signature: line.signature });
      // Single use: roll the data back to the approved precondition and replay the same line.
      await prisma.platformConfig.deleteMany({ where: { key: KEY } });
      await prisma.user.update({ where: { id: res.firstAdmin!.userId }, data: { roles: { set: ['CUSTOMER'] }, activeRole: 'CUSTOMER' } });
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [line], approverKeys: OWNER_ONLY, request: ctx })).rejects.toMatchObject({ code: 'APPROVAL_REPLAYED' });
      expect(await keyValue()).toBeNull();
    } finally {
      await restoreSupers();
    }
  });

  it('a SUPER_ADMIN already exists: solo is refused before any write; the two-person path stays', async () => {
    expect(await superCount()).toBeGreaterThan(0);
    const { desired, plan, ctx, request } = await soloCase(5, SOLO_COOLING_OFF_MS + 60_000);
    // Refused up front, even before an approval exists (no solo request is ever printed for it).
    await expect(applySeedPlan(prisma, URL_, desired, plan, { request: ctx })).rejects.toMatchObject({ code: 'SOLO_NOT_ALLOWED' });
    await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign('owner', request)], approverKeys: OWNER_ONLY, request: ctx })).rejects.toMatchObject({ code: 'SOLO_NOT_ALLOWED' });
    expect(await keyValue()).toBeNull();
    // The two-person ceremony still applies the same plan (without the solo words).
    const two = planApprovalRequest(plan, { fxGydPerUsd: 209, adminPhone: null });
    const res = await applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign('owner', two), sign('bob', two)], approverKeys: TWO_PINNED, request: { fxGydPerUsd: 209, adminPhone: null } });
    expect(res.applied).toBe(1);
  });

  it('an admin that appears while the solo seed runs: nothing lands and the approval is not used up', async () => {
    await noSuperAdmin();
    const racer = await prisma.user.create({ data: { phone: `+5920478${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`, firstName: 'Race', lastName: 'Admin', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', status: 'ACTIVE' }, select: { id: true } });
    userIds.push(racer.id);
    try {
      const { desired, plan, ctx, request } = await soloCase(8, SOLO_COOLING_OFF_MS + 60_000);
      const line = sign('owner', request);
      // Committed by another connection inside the seed's transaction, after its up-front check.
      const failpoint = async (boundary: string) => {
        if (boundary === 'after-drift-check') await prisma.user.update({ where: { id: racer.id }, data: { roles: { set: ['SUPER_ADMIN', 'CUSTOMER'] }, activeRole: 'SUPER_ADMIN' } });
      };
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [line], approverKeys: OWNER_ONLY, request: ctx, failpoint })).rejects.toMatchObject({ code: 'SOLO_NOT_ALLOWED' });
      expect(await keyValue()).toBeNull();
      expect(await prisma.user.count({ where: { phone: PHONE, roles: { has: 'SUPER_ADMIN' } } })).toBe(0);
      expect(await prisma.privilegedChangeAudit.count({ where: { action: 'SEED_APPROVAL_CONSUMED', detail: { path: ['nonce'], equals: /^nonce: (.+)$/m.exec(request)![1]! } } })).toBe(0);
    } finally {
      await prisma.user.update({ where: { id: racer.id }, data: { roles: { set: ['CUSTOMER'] }, activeRole: 'CUSTOMER' } });
      await restoreSupers();
    }
  });

  it('exactly one approval: two lines are refused as solo; a two-person request never passes as solo, nor a solo request as one of two', async () => {
    await noSuperAdmin();
    try {
      const { desired, plan, ctx, request } = await soloCase(6, SOLO_COOLING_OFF_MS + 60_000);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign('owner', request), sign('bob', request)], approverKeys: TWO_PINNED, request: ctx })).rejects.toMatchObject({ code: 'SOLO_ONE_APPROVAL' });
      // A request signed without the solo words (the signer read "two people"), used solo.
      const twoPerson = approvalRequest(planRequestFacts(plan, { fxGydPerUsd: 209, adminPhone: PHONE }), new Date(Date.now() - SOLO_COOLING_OFF_MS - 60_000));
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign('owner', twoPerson)], approverKeys: OWNER_ONLY, request: ctx })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      // A solo request used on the two-person path, as one of two.
      const twoCtx = { fxGydPerUsd: 209, adminPhone: PHONE };
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign('owner', request), sign('bob', request)], approverKeys: TWO_PINNED, request: twoCtx })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      // An unpinned signer, or the pinned name with another key.
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign('bob', request)], approverKeys: OWNER_ONLY, request: ctx })).rejects.toMatchObject({ code: 'APPROVER_UNKNOWN' });
      expect(await keyValue()).toBeNull();
      expect(await superCount()).toBe(0);
    } finally {
      await restoreSupers();
    }
  });

  it('a solo request is good for at most 72 hours from issue, and never one issued in the future', async () => {
    await noSuperAdmin();
    try {
      const { desired, plan, ctx } = await soloCase(7, 0);
      const facts = planRequestFacts(plan, ctx);
      const expired = approvalRequest(facts, new Date(Date.now() - 49 * HOUR), SOLO_DEFAULT_LIFETIME_MS);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign('owner', expired)], approverKeys: OWNER_ONLY, request: ctx })).rejects.toMatchObject({ code: 'APPROVAL_EXPIRED' });
      const tooLong = approvalRequest(facts, new Date(Date.now() - 13 * HOUR), 73 * HOUR);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign('owner', tooLong)], approverKeys: OWNER_ONLY, request: ctx })).rejects.toMatchObject({ code: 'APPROVAL_TOO_LONG' });
      const future = approvalRequest(facts, new Date(Date.now() + HOUR), SOLO_DEFAULT_LIFETIME_MS);
      await expect(applySeedPlan(prisma, URL_, desired, plan, { approvals: [sign('owner', future)], approverKeys: OWNER_ONLY, request: ctx })).rejects.toMatchObject({ code: 'APPROVAL_INVALID' });
      expect(await keyValue()).toBeNull();
      expect(await superCount()).toBe(0);
    } finally {
      await restoreSupers();
    }
  });
});

describe('[SOLO SEED] the real seed entry point with SEED_SOLO=1', () => {
  it('prints a solo request and exits 2; an immediate run is refused (cooling-off); a request signed 12 hours ago mints the first admin', async () => {
    const run = (extra: Record<string, string>) => spawnSync(join(process.cwd(), 'node_modules/.bin/tsx'), ['prisma/seed-production.ts'], {
      encoding: 'utf8',
      timeout: 90_000,
      env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test', DATABASE_URL: URL_, SEED_ADMIN_PHONE: PHONE, SEED_SOLO: '1', ...extra },
    });
    await noSuperAdmin();
    try {
      const first = run({});
      expect(first.status, first.stderr).toBe(2);
      expect(first.stdout).toContain(`\n${SOLO_SHOW_LINE}\n`);
      expect(first.stderr).toContain('12 hours');
      const early = run({ SEED_PLAN_APPROVALS: JSON.stringify([sign('owner', first.stdout)]), SEED_APPROVER_KEYS: OWNER_ONLY });
      expect(early.status).toBe(1);
      expect(early.stderr).toContain('COOLING_OFF');
      expect(await superCount()).toBe(0);
      // The same plan, requested 12 hours ago (the plan digest is stable for an unchanged database).
      const plan = await buildSeedPlan(prisma, URL_, desiredPlatformConfig());
      const backdated = approvalRequest(planRequestFacts(plan, spineRequestContext(PHONE, true)), new Date(Date.now() - SOLO_COOLING_OFF_MS - 60_000), SOLO_DEFAULT_LIFETIME_MS);
      const applied = run({ SEED_PLAN_APPROVALS: JSON.stringify([sign('owner', backdated)]), SEED_APPROVER_KEYS: OWNER_ONLY });
      expect(applied.status, applied.stderr).toBe(0);
      expect(applied.stderr).toContain('SUPER_ADMIN minted by the signed plan');
      const minted = await prisma.user.findUniqueOrThrow({ where: { phone: PHONE }, select: { id: true, roles: true } });
      userIds.push(minted.id);
      expect(minted.roles).toContain('SUPER_ADMIN');
    } finally {
      await restoreSupers();
    }
  }, 300_000);

  it('SEED_SOLO is exactly 1 or unset: anything else refuses before the plan', () => {
    const r = spawnSync(join(process.cwd(), 'node_modules/.bin/tsx'), ['prisma/seed-production.ts'], {
      encoding: 'utf8', timeout: 90_000,
      env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test', DATABASE_URL: URL_, SEED_ADMIN_PHONE: PHONE, SEED_SOLO: 'yes' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SEED_SOLO');
  });
});
